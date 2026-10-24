#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-before-pr.sh — PreToolUse hook that gates `gh pr create` on tests.
#
# What it does
#   Reads the Claude Code PreToolUse hook JSON from stdin. If the agent is
#   about to run a Bash command that creates or readies a PR, figures out
#   which component(s) of the monorepo changed (web / backend / bridge /
#   mcp-server), runs the matching test suite for each, and:
#     - exits 0  → lets the tool call proceed (PR opens)
#     - exits 2  → blocks the tool call; Claude sees the stderr output and
#                  is expected to fix the failures before retrying
#
# Why it exists
#   Branch-protection on main is the authoritative gate, but by then the
#   PR is already open with a red check and a reviewer is already nudging.
#   Catching it here means the agent iterates *inside the same session*
#   while it still has the task context loaded. Saves a round-trip and
#   avoids cluttering the PR list with red CI runs.
#
# Scope of enforcement (deliberately minimal)
#   - `gh pr create` / `gh pr ready` → gated
#   - `git push origin main` / `git push --force origin main` → gated
#     (though branch protection would reject these anyway — belt and
#     suspenders in case protection is ever misconfigured)
#   - Everything else → passed through (feature-branch pushes, commits,
#     etc. — intermediate states don't need to be green)
#
# Install
#   Committed to .claude/settings.json as a PreToolUse hook. The Agent SDK
#   in bridge.mjs uses settingSources: ["user","project","local"] so this
#   file is picked up automatically by both the Claude Code CLI (local
#   dogfooding) and PocketEng cloud sessions.
#
# Bypass
#   Intentionally none. If the hook is wrong, fix the hook — don't add an
#   env-var escape hatch, because the model will learn to use it.
# ─────────────────────────────────────────────────────────────────────────────

set -u
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$PROJECT_DIR" || exit 0  # can't inspect → let the tool proceed

# ── Make tooling discoverable ────────────────────────────────────────────────
# Hook subprocesses don't source the user's shell rc file, so `bun` /
# `bunx` / `node` installed under standard user-level dirs aren't on
# PATH by default. Add the common locations unconditionally — if they
# don't exist they're harmless; if they do we find the right binary.
# This is NOT an escape hatch (we still block on failures), just a
# fix for a tool-discovery footgun.
for extra in "$HOME/.bun/bin" "$HOME/.volta/bin" "$HOME/.nvm/current/bin" "/opt/homebrew/bin" "/usr/local/bin"; do
    case ":$PATH:" in
        *":$extra:"*) ;;
        *) [ -d "$extra" ] && PATH="$extra:$PATH" ;;
    esac
done
export PATH

# ── Read hook input ──────────────────────────────────────────────────────────
# Claude Code passes PreToolUse JSON on stdin. Parse with python3 (always
# present on both managed workspaces and local macOS). Using python3 over
# jq avoids a dep we can't guarantee on BYOS boxes.
input=$(cat)

command=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print((d.get("tool_input") or {}).get("command", ""))
except Exception:
    pass
')

# Non-Bash tools (Read/Write/Edit/etc.) come through this hook too because
# we match "Bash" in settings.json — but only Bash has a .command field, so
# if command is empty we have nothing to gate.
[ -z "$command" ] && exit 0

# ── Decide whether this command warrants gating ──────────────────────────────
# Be strict about the patterns — false positives here block the agent on
# unrelated git plumbing (e.g. `git status`), which would be maddening.
is_gated=0
case "$command" in
    *"gh pr create"*)                                    is_gated=1 ;;
    *"gh pr ready"*)                                     is_gated=1 ;;
    *"git push"*"origin"*"main"*)                        is_gated=1 ;;
    *"git push"*"--force"*"main"*)                       is_gated=1 ;;
esac
[ "$is_gated" -eq 0 ] && exit 0

echo "[verify-before-pr] Gating command: $(printf '%s' "$command" | head -c 120)…" >&2

# ── Figure out the changed scope ─────────────────────────────────────────────
# Union of (uncommitted) + (committed-on-this-branch-vs-main). We want the
# full PR diff, not just what's unstaged.
changed_files=$(
    {
        git status --porcelain 2>/dev/null | awk '{print $2}'
        # If we're on a branch with upstream main, diff against the merge-base.
        # If main doesn't exist or we're on main, fall back to HEAD~1.
        base=$(git merge-base HEAD main 2>/dev/null \
            || git merge-base HEAD origin/main 2>/dev/null \
            || git rev-parse HEAD~1 2>/dev/null \
            || echo "")
        [ -n "$base" ] && git diff --name-only "$base" HEAD 2>/dev/null
    } | sort -u
)

needs_web=0
needs_backend=0
needs_bridge=0
needs_mcp=0

# Match order matters — bridge must test BOTH node --test AND pytest because
# backend/src/lib/bridge is exercised by both suites. Most specific first.
while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
        backend/src/lib/bridge/*)  needs_bridge=1; needs_backend=1 ;;
        backend/*)                 needs_backend=1 ;;
        web/*)                     needs_web=1 ;;
        mcp-server/*)              needs_mcp=1 ;;
    esac
done <<< "$changed_files"

if [ "$needs_web$needs_backend$needs_bridge$needs_mcp" = "0000" ]; then
    echo "[verify-before-pr] No tested component changed — allowing." >&2
    exit 0
fi

echo "[verify-before-pr] Scope: web=$needs_web backend=$needs_backend bridge=$needs_bridge mcp=$needs_mcp" >&2

# ── Run the matching checks ──────────────────────────────────────────────────
# We capture stdout+stderr per check; on failure we surface the last 80
# lines back to the agent so it can diagnose without re-running.
FAILURES=""
LOG=$(mktemp /tmp/pe-verify.XXXXXX)

run_check() {
    local label="$1" dir="$2" cmd="$3"
    echo "[verify-before-pr] → $label ($cmd)" >&2
    if ! (cd "$PROJECT_DIR/$dir" && eval "$cmd") >"$LOG" 2>&1; then
        FAILURES="${FAILURES}
── $label FAILED ────────────────────────────────────────────────
$(tail -80 "$LOG")
"
    fi
}

# Order matters for feedback speed: run the cheapest checks first so the
# agent sees failures quickly when they're most likely (typecheck, unit tests)
# instead of waiting on slower suites.
if [ "$needs_bridge" -eq 1 ]; then
    run_check "bridge unit tests" "backend/src/lib/bridge" "node --test"
fi
if [ "$needs_web" -eq 1 ]; then
    # `bunx tsc --noEmit` because the repo uses bun but TS is the compiler.
    # ~10-20s on a warm workspace. No runtime side effects.
    run_check "web typecheck" "web" "bunx tsc --noEmit"
fi
if [ "$needs_mcp" -eq 1 ]; then
    run_check "mcp-server tests" "mcp-server" "npm test --silent 2>&1"
fi
if [ "$needs_backend" -eq 1 ]; then
    # Full pytest run. ~2-3 minutes. If this becomes the bottleneck, narrow
    # with -k or split by path later.
    run_check "backend pytest" "backend" "python3 -m pytest -q --tb=short"
fi

rm -f "$LOG"

if [ -n "$FAILURES" ]; then
    cat >&2 <<EOF
[verify-before-pr] BLOCKED — the following checks failed on your local diff.
Fix them, then retry the PR/push. CI would reject this merge anyway.
$FAILURES
EOF
    exit 2
fi

# ── Visual verification gate for web/ changes ────────────────────────────────
# Compile passes don't catch layout bugs. When web/ changes, we:
#   1. Spin up `bun run dev`
#   2. Screenshot the app at desktop (1280×800) + mobile (390×844) for each
#      URL in .claude/ui-verify.txt (defaults to "/")
#   3. Exit 2 with the PNG paths and a demand that the agent Read each one
#      before proceeding — this is the whole point. `Read` on a PNG lets the
#      model actually see the screenshot.
# On the *second* attempt (after the agent has presumably opened the PNGs),
# the marker file keyed on the current commit SHA lets the PR through. Any
# new commit invalidates the marker and re-triggers the gate — because the
# UI might have changed.
if [ "$needs_web" -eq 1 ]; then
    commit_sha=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
    branch_slug=$(git rev-parse --abbrev-ref HEAD 2>/dev/null | tr '/' '_' || echo "branch")
    marker="/tmp/pe-ui-verified-${branch_slug}-${commit_sha}"

    if [ -f "$marker" ]; then
        echo "[verify-before-pr] UI already screenshot+reviewed for ${commit_sha:0:12} — proceeding." >&2
    else
        # Find a chromium binary. On managed workspaces: `chromium` (installed via
        # dnf in userdata.py). On macOS dev boxes: fall back to Google Chrome.
        CHROMIUM=""
        if command -v chromium >/dev/null 2>&1; then
            CHROMIUM=chromium
        elif command -v chromium-browser >/dev/null 2>&1; then
            CHROMIUM=chromium-browser
        elif [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
            CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        fi

        if [ -z "$CHROMIUM" ]; then
            echo "[verify-before-pr] WARN: no chromium/chrome found — skipping UI screenshot gate." >&2
            echo "[verify-before-pr]       Install with: dnf install -y chromium" >&2
            touch "$marker"  # don't block in perpetuity on boxes without a browser
        else
            # URL list: .claude/ui-verify.txt (one path per line, comments with '#').
            # Default to "/" if the file doesn't exist — agent can add routes later.
            URL_FILE="$PROJECT_DIR/.claude/ui-verify.txt"
            if [ -f "$URL_FILE" ]; then
                URLS=$(grep -v '^\s*#' "$URL_FILE" | grep -v '^\s*$' || true)
            else
                URLS="/"
            fi

            echo "[verify-before-pr] Capturing UI screenshots (web/ changed)..." >&2

            # Start dev server. Use setsid so the process group can be killed cleanly.
            DEV_LOG=$(mktemp /tmp/pe-verify-dev.XXXXXX.log)
            (cd "$PROJECT_DIR/web" && bun run dev >"$DEV_LOG" 2>&1) &
            DEV_PID=$!
            # Always clean up, even on error / interrupt
            cleanup() { kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; rm -f "$DEV_LOG"; }
            trap cleanup EXIT

            # Wait up to 60s for localhost:3000 to respond (first compile is slow)
            ready=0
            for i in $(seq 1 60); do
                if curl -sf -o /dev/null http://localhost:3000/ 2>/dev/null; then
                    ready=1; break
                fi
                sleep 1
            done

            if [ "$ready" -eq 0 ]; then
                cleanup
                trap - EXIT
                cat >&2 <<EOF
[verify-before-pr] BLOCKED — \`bun run dev\` never responded on :3000 within 60s.
Last 40 lines of dev log:
$(tail -40 "$DEV_LOG" 2>/dev/null || echo "(log empty)")
EOF
                exit 2
            fi

            # Screenshot each URL at both viewports. Filenames embed the
            # branch + short commit SHA so uploads to a shared GitHub
            # release don't collide across PRs or commits.
            #
            # Two gotchas we hit in PR #53:
            #   1. Next.js dev compiles routes lazily on first hit → the first
            #      curl sees a 200 that's actually a compile-in-progress HTML
            #      stub. Warm each URL with a blocking curl before we capture
            #      so the route is already compiled when chromium arrives.
            #   2. `chromium --screenshot URL` captures the moment navigation
            #      finishes, before React has hydrated — the PNG ends up
            #      solid-dark-background-with-loading-spinner. Adding
            #      `--virtual-time-budget=10000` tells headless Chrome to
            #      advance virtual time for up to 10s while waiting for
            #      scheduled tasks (JS, fonts, images) to finish. Combined
            #      with `--hide-scrollbars` + a small post-curl sleep it
            #      produces a painted, hydrated screenshot.
            sha8="${commit_sha:0:8}"
            PNG_PATHS=()
            PNG_META=()   # parallel: "<path>|<label>|<absfile>"
            CHROME_ARGS=(--headless --no-sandbox --disable-gpu
                         --hide-scrollbars
                         --virtual-time-budget=10000)
            while IFS= read -r path; do
                [ -z "$path" ] && continue
                case "$path" in /*) ;; *) path="/$path" ;; esac
                slug=$(printf '%s' "$path" | tr -c 'A-Za-z0-9' '_' | sed 's/__*/_/g; s/^_//; s/_$//')
                [ -z "$slug" ] && slug="root"
                desktop_png="/tmp/pe-ui-${branch_slug}-${sha8}-${slug}-desktop.png"
                mobile_png="/tmp/pe-ui-${branch_slug}-${sha8}-${slug}-mobile.png"

                # Warm the route so the subsequent chromium hit gets a
                # compiled page, not a "compiling…" placeholder.
                curl -sf --max-time 30 -o /dev/null "http://localhost:3000$path" 2>/dev/null || true
                sleep 1  # give the compile worker a beat to finalize

                "$CHROMIUM" "${CHROME_ARGS[@]}" \
                    --window-size=1280,800 --screenshot="$desktop_png" \
                    "http://localhost:3000$path" 2>/dev/null || true
                "$CHROMIUM" "${CHROME_ARGS[@]}" \
                    --window-size=390,844 --screenshot="$mobile_png" \
                    "http://localhost:3000$path" 2>/dev/null || true
                PNG_PATHS+=("$desktop_png" "$mobile_png")
                PNG_META+=("${path}|desktop|${desktop_png}" "${path}|mobile|${mobile_png}")
            done <<< "$URLS"

            cleanup
            trap - EXIT

            # ── Upload to a shared GitHub release so the PR body can embed
            #    actual images, not /tmp paths only the workspace can see.
            # We use a single pinned release tag `pr-ui-screenshots` created
            # once per repo and then --clobbered on every run. URL shape:
            #   https://github.com/<owner>/<repo>/releases/download/pr-ui-screenshots/<basename>
            RELEASE_TAG="pr-ui-screenshots"
            RELEASE_URL_BASE=""
            if command -v gh >/dev/null 2>&1; then
                repo_slug=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)
                if [ -n "$repo_slug" ]; then
                    # Idempotent release create (ignore error if it already exists)
                    gh release view "$RELEASE_TAG" --repo "$repo_slug" >/dev/null 2>&1 \
                        || gh release create "$RELEASE_TAG" --repo "$repo_slug" \
                            --title "PR UI screenshots (auto-managed)" \
                            --notes "Hook-captured screenshots for open PRs. Safe to delete after a PR merges — new PRs recreate as needed." \
                            --prerelease >/dev/null 2>&1 || true
                    # Upload every PNG we captured
                    if [ ${#PNG_PATHS[@]} -gt 0 ]; then
                        gh release upload "$RELEASE_TAG" --repo "$repo_slug" \
                            --clobber "${PNG_PATHS[@]}" >/dev/null 2>&1 || true
                    fi
                    RELEASE_URL_BASE="https://github.com/${repo_slug}/releases/download/${RELEASE_TAG}"
                fi
            fi

            # Build the rich message: for each capture, show the /tmp path
            # (for Read) AND a markdown image tag with the public URL (for
            # the PR body).
            SHOT_SECTION=""
            PR_BODY_SNIPPET=""
            current_path=""
            for entry in "${PNG_META[@]}"; do
                IFS='|' read -r mpath mlabel mfile <<< "$entry"
                if [ "$mpath" != "$current_path" ]; then
                    SHOT_SECTION="${SHOT_SECTION}
  ${mpath}"
                    PR_BODY_SNIPPET="${PR_BODY_SNIPPET}
### \`${mpath}\`
"
                    current_path="$mpath"
                fi
                if [ "$mlabel" = "desktop" ]; then
                    dims="1280×800"
                else
                    dims="390×844"
                fi
                SHOT_SECTION="${SHOT_SECTION}
    ${mlabel} (${dims}):  ${mfile}"
                if [ -n "$RELEASE_URL_BASE" ]; then
                    asset_url="${RELEASE_URL_BASE}/$(basename "$mfile")"
                    SHOT_SECTION="${SHOT_SECTION}
      → ${asset_url}"
                    PR_BODY_SNIPPET="${PR_BODY_SNIPPET}
**${mlabel} (${dims})**
![${mlabel} ${dims}](${asset_url})
"
                fi
            done

            touch "$marker"

            cat >&2 <<EOF
[verify-before-pr] BLOCKED — web/ changed. UI must be visually verified before PR.

Screenshots captured for commit ${commit_sha:0:12}:${SHOT_SECTION}

Do EACH of these before retrying \`gh pr create\`:

  1. Open every /tmp/*.png above with the Read tool. This is how the model
     actually sees the rendered UI.

  2. Look at each screenshot. If anything wraps badly, overlaps, clips at
     mobile width, or shows an unintended layout — STOP, fix the code,
     commit, and re-run. A new commit invalidates this marker and the gate
     fires again automatically.

  3. Paste the following Markdown into your \`gh pr create --body\` under
     a \`## Visual verification\` heading so reviewers see the actual
     images (not just /tmp paths on the workspace):

--- COPY-PASTE FOR PR BODY (between the lines) ---
## Visual verification
${PR_BODY_SNIPPET}
--- END COPY-PASTE ---

When all screenshots look right and the \`--body\` includes the image
markdown above, re-run the exact same \`gh pr create\` command. The
marker at ${marker} lets the second attempt through.

To cover more routes than just the landing page, add paths (one per line)
to \`.claude/ui-verify.txt\` and commit that alongside your feature.
EOF
            exit 2
        fi
    fi
fi

echo "[verify-before-pr] All checks green. Allowing $(printf '%s' "$command" | head -c 60)…" >&2
exit 0
