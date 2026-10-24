import base64
import os
import re
import shlex

from src.lib.env_vars import sanitize_env_vars
from src.lib.agents import get_agent_package, get_agent_label, needs_bridge

# Path to the preview-dispatcher script shipped alongside this module.
# Read once at import time so the heredoc in _preview_dispatcher_block
# doesn't have to re-open the file per provision. Kept in-repo and
# reviewed as a standalone .cjs so its logic is unit-testable with
# `node --test` (backend/src/lib/preview-dispatcher.test.cjs).
_PREVIEW_DISPATCHER_PATH = os.path.join(
    os.path.dirname(__file__), "preview-dispatcher.cjs"
)
with open(_PREVIEW_DISPATCHER_PATH, encoding="utf-8") as _f:
    _PREVIEW_DISPATCHER_SCRIPT = _f.read()


def _api_keys_block(anthropic_key, openai_key, home_dir, rc_file, user, group=None, cursor_key=None):
    """Write API keys to rc file and ~/.pocketeng/ key files. Only emits lines for non-empty keys."""
    group = group or user
    lines = [f"mkdir -p {home_dir}/.pocketeng"]
    if anthropic_key:
        lines.append(f"echo 'export ANTHROPIC_API_KEY={anthropic_key}' >> {rc_file}")
        lines.append(f"echo '{anthropic_key}' > {home_dir}/.pocketeng/anthropic_key")
    if openai_key:
        lines.append(f"echo 'export OPENAI_API_KEY={openai_key}' >> {rc_file}")
        lines.append(f"echo '{openai_key}' > {home_dir}/.pocketeng/openai_key")
        lines.append(f"mkdir -p {home_dir}/.codex")
        lines.append(
            f'printf \'{{\\n  "auth_mode": "apikey",\\n  "OPENAI_API_KEY": "%s"\\n}}\\n\' '
            f"'{openai_key}' > {home_dir}/.codex/auth.json"
        )
        lines.append(f"chown -R {user}:{group} {home_dir}/.codex")
    if cursor_key:
        lines.append(f"echo 'export CURSOR_API_KEY={cursor_key}' >> {rc_file}")
        lines.append(f"echo '{cursor_key}' > {home_dir}/.pocketeng/cursor_key")
    lines.append(f"chown -R {user}:{group} {home_dir}/.pocketeng")
    return "\n".join(lines)


def _sanitize_repo(repo):
    """Allow only owner/name format — strip anything else."""
    if re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", repo):
        return repo
    return None


def _git_blocks(github_token, github_username, repos):
    """Shared git credential + clone blocks for both Linux and macOS."""
    git_name = github_username if github_username else "Pocket Eng"
    git_email = f"{github_username}@users.noreply.github.com" if github_username else "dev@pocketengineer.dev"

    git_creds_block = ""
    if github_token and github_username:
        # Set GH_TOKEN in both shell rc files so the gh CLI authenticates
        # automatically in interactive AND non-interactive shells. We also
        # write it to /etc/environment-equivalent locations the autopilot
        # wrapper script reads (~/.pocketeng/anthropic_key style is for
        # ANTHROPIC_API_KEY only — gh just looks at GH_TOKEN).
        git_creds_block = f"""
echo "--- Configuring GitHub credentials ---"
su - ec2-user -c 'git config --global credential.helper store'
echo 'https://{github_username}:{github_token}@github.com' > /home/ec2-user/.git-credentials
chown ec2-user:ec2-user /home/ec2-user/.git-credentials
chmod 600 /home/ec2-user/.git-credentials
echo 'export GH_TOKEN={github_token}' >> /home/ec2-user/.bashrc
echo 'export GH_TOKEN={github_token}' >> /home/ec2-user/.profile
mkdir -p /home/ec2-user/.pocketeng
echo '{github_token}' > /home/ec2-user/.pocketeng/github_token
chown -R ec2-user:ec2-user /home/ec2-user/.pocketeng
chmod 600 /home/ec2-user/.pocketeng/github_token
"""

    clone_block = ""
    if repos:
        safe_repos = [_sanitize_repo(r) for r in repos]
        safe_repos = [r for r in safe_repos if r]
        if safe_repos:
            lines = ['echo "--- Cloning repositories ---"']
            for repo in safe_repos:
                lines.append(
                    f'su - ec2-user -c "cd /home/ec2-user/projects && git clone https://github.com/{repo}.git"'
                    f' || echo "WARN: clone {repo} failed"'
                )
            clone_block = "\n".join(lines)

    return git_name, git_email, git_creds_block, clone_block


# NOTE: Keep these in sync with the markdown files in skills/*.md.
# These dict values are the runtime source of truth — autopilot reads them
# directly from chat.py via `BUILT_IN_SKILLS["pr-workflow"]`. The markdown
# files in skills/ are for the user to read and edit; if you change a skill,
# update both.
BUILT_IN_SKILLS = {
    "nextjs": "# Next.js Development\nUse App Router, server components by default, Tailwind CSS, TypeScript strict.\nFile structure: app/ for routes, components/ for shared, lib/ for utilities.\nFetch data in server components. Use Server Actions for mutations.\nTest with vitest. Deploy with vercel deploy.",
    "python-api": "# Python API Development\nUse FastAPI with Pydantic models, SQLAlchemy ORM, Alembic migrations.\nType hints everywhere. Async endpoints by default. Thin route handlers, logic in services.\nTest with pytest. Use dependency injection.",
    "ios-swift": "# iOS / Swift Development\nSwiftUI for views, MVVM pattern, @Observable over Combine.\nSwift concurrency (async/await), SwiftData for persistence.\nStructured concurrency with TaskGroup. @MainActor for UI state.",
    "testing": "# Testing\nWrite tests alongside code. Test behavior not implementation.\nHappy path + edge cases + error cases. Run tests before committing.\nArrange-Act-Assert pattern. Keep tests independent.",
    "deploy-vercel": "# Vercel Deployment\nUse `vercel deploy` for previews, `vercel --prod` for production.\nAlways build first to catch errors. Share preview URLs in responses.",
    "database-supabase": "# Supabase Database\nUse Supabase CLI for migrations. Enable RLS on user-data tables.\nWrite policies restricting access to row owner. Use service role key server-side only.",
    "pr-workflow": """# PR Workflow

End every task with a single clean PR. Read every rule before starting.

## NEVER do these — these are how PRs get rejected

- **NEVER `git add .` or `git add -A`.** Stage files individually by name. Bulk-staging drags in `.pyc`, dev server logs, build caches, screenshots from other features, editor scratch files, and uncommitted work from prior sessions.
- **NEVER create summary docs.** No `IMPLEMENTATION_SUMMARY.md`, no `CHANGES.md`, no `*_NOTES.md`, no `demo-*.html`, no markdown explaining what you did. The PR body is the explanation. The diff is the proof.
- **NEVER commit generated or build files.** No `__pycache__/`, `*.pyc`, `*.log`, `tsconfig.tsbuildinfo`, `dist/`, `.next/`, `node_modules/`, `screenshots/`. If `git status` shows any of these, exclude them — do not commit them even if `.gitignore` is missing them.
- **NEVER call a function or import a name you haven't read.** Before using any helper from existing code, grep for its definition AND for another usage to see its actual signature and return shape. Guessing is how a PR ends up calling `ssh_execute()` when the real function is `ssh_exec()`.
- **NEVER commit to `main`.** Always work on a feature branch.
- **NEVER add unrelated tracked changes.** If `git status` shows files you didn't intend to modify, stop and investigate — that's someone else's in-progress work.

## WORKFLOW

### 1. Workspace hygiene (first thing, every time)

```bash
cd ~/projects/<repo>
git status                       # if dirty with files you didn't touch, STOP and ask
git checkout main && git pull
git checkout -b feat/<short-name>
```

### 2. Read before you write

For every file you intend to modify, read it first. For every function you intend to call, grep for its definition:

```bash
grep -rn "def ssh_exec" backend/src/lib/    # confirm the real signature
grep -rn "ssh_exec(" backend/src/            # see how it's called elsewhere
```

If you're adding a backend route, read the existing routes in the same file to copy their patterns (auth, error handling, return shape).

### 3. Implement

Make the changes. Keep the diff minimal and scoped to the task. Don't refactor unrelated code. Don't add features that weren't asked for.

### 4. Stage explicitly, then audit

```bash
git status                       # see everything that changed
git add path/to/file1 path/to/file2 path/to/file3
git status                       # confirm only your intended files are staged
git diff --cached                # read the actual staged diff end-to-end
```

If `git diff --cached` shows ANY of these, remove them with `git restore --staged <file>`:
- `__pycache__/`, `*.pyc`
- `*.log`
- `tsconfig.tsbuildinfo`, `.next/`
- `screenshots/`, `demo-*.html`, `*SUMMARY*.md`
- Files in directories you weren't working in

### 5. Validate it actually runs

Validation has two parts. **Both are mandatory.** Compiling is not running.

**5a. Compile / build / lint** — every project you touched:

- Web: `cd web && npm run build` (must exit 0)
- Backend Python: `python3 -m py_compile <file>` for each changed file (catches syntax) AND `pytest` if a test suite exists
- For SAM stacks: `cd backend && sam build` if `sam` is installed; if not, note "sam not available, skipping local SAM build" in the PR body and move on. Do NOT pretend it passed.

**Failure handling for 5a**: if any compile/build command fails, **STOP**. Either fix the underlying code error and re-run, or — if the failure is environmental (tool not installed, wrong working directory) — move past it and explicitly mention in the PR body which validation step you skipped and why. **Never silently ignore a non-zero exit and proceed as if it passed.** The agent that just shipped a PR after `sam build` failed twice with `command not found` was wrong.

**5b. Actually exercise the new code** — compiling is not the same as running. You must execute the new code at least once before pushing.

- **New backend endpoint?** Start the local server (`sam local start-api`, or just run it as a Python script with `python3 -c "from src.chat import handler; print(handler({'pathParameters':{...}, 'body':'...', 'headers':{...}}, None))"`), then call it with `curl` and paste the actual response into the PR body. If you can't run it locally, deploy to a sandbox and curl that. If neither is possible, write a tiny Python test that imports your function and calls it directly with mocked args, run it, and paste the output.
- **UI change under `web/` (component, layout, styling)?** This is NOT optional. Type-checks and builds pass on broken layouts all the time — you MUST visually verify.

  ```bash
  cd web && bun run dev > /tmp/dev.log 2>&1 &
  DEV_PID=$!
  # wait up to 30s for the first compile
  for i in $(seq 1 30); do curl -sf http://localhost:3000/ >/dev/null 2>&1 && break; sleep 1; done
  sleep 2   # first-paint hydration

  # Desktop (1280×800) — catches layout assumptions
  chromium --headless --no-sandbox --disable-gpu --window-size=1280,800 \\
      --screenshot=/tmp/desktop-<slug>.png http://localhost:3000/<path>

  # Mobile (iPhone 14 — 390×844). Do NOT skip this; most layout bugs only
  # show at narrow widths (header overflow, composer crowding, etc.).
  chromium --headless --no-sandbox --disable-gpu --window-size=390,844 \\
      --screenshot=/tmp/mobile-<slug>.png http://localhost:3000/<path>

  kill "$DEV_PID" 2>/dev/null
  ```

  Then **actually open each PNG with the `Read` tool and look at it.** Ask:
  is the layout what you intended? Does anything wrap badly, overlap, or
  clip at mobile width? Are there blank/error states showing? If yes →
  fix the code → re-screenshot → re-read → repeat until the output matches
  intent. Screenshots stay in `/tmp/` — never commit them.

  For interactive behavior (clicks, forms, modals) that `--screenshot` alone
  can't exercise, the workspace has Playwright MCP available if configured
  (`claude mcp add playwright -s user -- npx -y @playwright/mcp@latest`);
  otherwise a tiny `node -e` script with `puppeteer` works.
- **Library or pure function?** Run it directly: `python3 -c "from your.module import fn; print(fn(...))"` or `node -e "console.log(require('./your-module').fn(...))"`. Paste the output.

If you cannot exercise the code at all (no runtime, no deployable target, no test framework), say so explicitly in the PR body under a `## Validation gaps` section. Do not hand-wave with phrases like "tested and ready" when nothing actually ran.

**Failure handling for 5b**: if the new code throws at runtime, that's a bug — fix it and re-run before pushing. **A PR is not "ready" until the new code has executed successfully at least once.**

### 6. Push and create the PR

```bash
git push -u origin feat/<short-name>
gh pr create --title "<type>: <short imperative summary>" --body "$(cat <<'EOF'
## What changed
- bullet 1
- bullet 2

## Why
<one paragraph — what problem does this solve>

## Tests
\\`\\`\\`
<paste actual test output>
\\`\\`\\`

## Build
\\`\\`\\`
<paste actual build output>
\\`\\`\\`
EOF
)"
```

Title format: `<type>: <imperative summary>` where type is `feat`, `fix`, `chore`, `docs`, `refactor`. Examples: `feat: add directory browser with right-click cwd`, `fix: chat scroll on iOS`. Never use the branch name as the title.

### 7. Self-review the PR

```bash
gh pr diff <pr-number>           # read the entire diff in the PR
```

If you see any junk file (`.pyc`, log, summary doc, screenshots from another feature, files outside the scope of your task), **the PR is broken**. Close it (`gh pr close <num> --delete-branch`), reset, and start over.

### 8. Report

Reply with the PR URL and a one-line summary. Mention anything that needs manual review.

## Validation harness

After you push your branch and reply that you're done, the backend automatically
runs `~/.pocketeng/validate.sh` (or `<repo>/.pocketeng/validate.sh` if the repo
has its own override) on this machine. If it exits non-zero, the failure output
is fed back to you as a follow-up turn — fix the issue, commit, and push to the
**same branch** (do NOT open a new PR). You get up to 3 attempts before the
user is notified that validation failed.

You don't need to invoke validate.sh yourself; the harness handles it. But you
should still test critical changes interactively while you work — the harness
only catches what its script tests.""",
}


def _skills_block(skills=None, custom_skills=None, home_dir="/home/ec2-user"):
    """Write skill instructions to AGENTS.md in the projects directory."""
    contents = []
    if skills:
        for skill_id in skills:
            if skill_id in BUILT_IN_SKILLS:
                contents.append(BUILT_IN_SKILLS[skill_id])
    if custom_skills:
        for cs in custom_skills:
            name = cs.get("name", "").strip()
            content = cs.get("content", "").strip()
            if content:
                contents.append(f"# {name}\n{content}" if name else content)
    if not contents:
        return ""
    # Escape for heredoc
    combined = "\n\n---\n\n".join(contents)
    return f"""
echo "--- Installing skills ---"
cat > {home_dir}/projects/AGENTS.md << 'SKILLEOF'
{combined}
SKILLEOF
chown ec2-user:ec2-user {home_dir}/projects/AGENTS.md 2>/dev/null || true
"""


def _claude_md_block(home_dir="/home/ec2-user", repos=None, env_vars=None,
                     setup_files=None, setup_instructions=None,
                     has_vercel=False, has_supabase=False, has_github=False):
    """Write CLAUDE.md to the projects directory with full workspace context.

    Gives every Claude Code session immediate knowledge of the workspace:
    which repos are cloned, what env vars are available, what tools are
    configured, and any user-provided setup instructions.
    """
    sections = []

    # ── Workspace overview
    sections.append("# Workspace\n")
    sections.append("You are running in a cloud development workspace managed by Pocket Engineer.")
    sections.append("Each session runs in an isolated git worktree on a dedicated branch.")

    # ── Repos
    if repos:
        sections.append("\n## Projects\n")
        sections.append(f"Repositories cloned to `{home_dir}/projects/`:")
        for repo in repos:
            safe = _sanitize_repo(repo)
            if safe:
                name = safe.split("/")[-1]
                sections.append(f"- **{name}** (from `{safe}`)")

    # ── Environment variables
    if env_vars:
        sections.append("\n## Environment Variables\n")
        sections.append("The following environment variables are set in your shell (`$VAR_NAME` to read):")
        for key in sorted(env_vars.keys()):
            lo = key.lower()
            if any(s in lo for s in ("key", "secret", "token", "password")):
                sections.append(f"- `{key}` — secret")
            elif any(s in lo for s in ("url", "endpoint")):
                sections.append(f"- `{key}` — URL")
            elif any(s in lo for s in ("database", "db")):
                sections.append(f"- `{key}` — database connection")
            else:
                sections.append(f"- `{key}`")

    # ── Tools
    tools = []
    if has_vercel:
        tools.append("Vercel CLI (`VERCEL_TOKEN` set)")
    if has_supabase:
        tools.append("Supabase CLI (`SUPABASE_URL` set)")
    if has_github:
        tools.append("GitHub CLI (`GH_TOKEN` set)")
    if tools:
        sections.append("\n## Available Tools\n")
        for t in tools:
            sections.append(f"- {t}")

    # ── Setup files
    if setup_files:
        sections.append("\n## Setup Files\n")
        sections.append("The following configuration files were provided during provisioning and written to the first project directory:")
        for sf in setup_files:
            sections.append(f"- `{sf.get('name', 'unknown')}`")

    # ── User instructions
    if setup_instructions:
        sections.append("\n## User Instructions\n")
        sections.append(setup_instructions)

    # ── Workflow pointers
    sections.append("\n## Workflow\n")
    sections.append("**Read `AGENTS.md` in this directory if it exists** — it contains the strict")
    sections.append("PR workflow rules (no `git add .`, no junk files, read-before-write, etc).")
    sections.append("")
    sections.append("### Validation harness")
    sections.append("")
    sections.append("After you push your branch and reply that you're done, the backend automatically")
    sections.append("runs `~/.pocketeng/validate.sh` (or `<repo>/.pocketeng/validate.sh` if the")
    sections.append("repo has its own override) on this machine. If it exits non-zero, the failure")
    sections.append("output is fed back to you as a follow-up turn — fix the issue and push again.")
    sections.append("You get up to 3 attempts before the user is notified that validation failed.")
    sections.append("")
    sections.append("You don't need to run validate.sh yourself; the harness handles it. But you")
    sections.append("should still test critical changes interactively while you work — the harness")
    sections.append("only catches what its script tests.")
    sections.append("")
    sections.append("Never leave changes uncommitted. Every task ends with a PR link.")

    content = "\n".join(sections)
    return f"""
echo "--- Writing CLAUDE.md ---"
cat > {home_dir}/projects/CLAUDE.md << 'CLAUDEEOF'
{content}
CLAUDEEOF
chown ec2-user:ec2-user {home_dir}/projects/CLAUDE.md 2>/dev/null || true

# Append workspace context to AGENTS.md so Codex also gets it
echo "--- Appending workspace context to AGENTS.md ---"
if [ -f {home_dir}/projects/AGENTS.md ]; then
  cat >> {home_dir}/projects/AGENTS.md << 'AGENTSAPPENDEOF'

---

{content}
AGENTSAPPENDEOF
else
  cat > {home_dir}/projects/AGENTS.md << 'AGENTSAPPENDEOF'
{content}
AGENTSAPPENDEOF
fi
chown ec2-user:ec2-user {home_dir}/projects/AGENTS.md 2>/dev/null || true
"""


def _validation_default_block(home_dir="/home/ec2-user", chown_user="ec2-user"):
    """Install a default validate.sh at ~/.pocketeng/validate.sh.

    Users can override this in two ways:
      - Per project: commit `<repo>/.pocketeng/validate.sh` (project beats user)
      - Per server: edit `~/.pocketeng/validate.sh` directly via SSH or chat
    """
    return f"""
echo "--- Installing default validation harness ---"
mkdir -p {home_dir}/.pocketeng
cat > {home_dir}/.pocketeng/validate.sh << 'VALIDATEEOF'
#!/bin/bash
# Default Pocket Eng validation harness.
# Runs after every autopilot turn. Exit 0 = pass, non-zero = fail.
# Failure output is fed back to the agent so it can self-heal (up to 3 tries).
#
# Override per-project: commit .pocketeng/validate.sh inside your repo.
# Override globally: edit this file (~/.pocketeng/validate.sh).
#
# Env vars set by the harness:
#   PE_REPO_DIR    absolute path to the worktree
#   PE_BASE_REF    base branch ref (e.g. origin/main)
#   PE_BRANCH      current working branch
#   PE_SESSION_ID  session id for logging

set -e
cd "${{PE_REPO_DIR:-$(pwd)}}"

echo "=== Pocket Eng validation harness ==="
echo "repo:   $PE_REPO_DIR"
echo "branch: $PE_BRANCH"
echo

# ── Web build (Next.js / generic Node project) ─────────────────────────────
if [ -f web/package.json ]; then
  echo "▶ web/ build"
  (cd web && npm run build) || exit 1
elif [ -f package.json ]; then
  if grep -q '"build"' package.json; then
    echo "▶ root npm build"
    npm run build || exit 1
  fi
fi

# ── Python syntax check on changed .py files ──────────────────────────────
if command -v python3 >/dev/null 2>&1; then
  CHANGED_PY=$(git diff --name-only "${{PE_BASE_REF:-origin/main}}"...HEAD -- '*.py' 2>/dev/null || true)
  if [ -n "$CHANGED_PY" ]; then
    echo "▶ python syntax check on changed files"
    echo "$CHANGED_PY" | xargs -r python3 -m py_compile || exit 1
  fi
fi

# ── pytest if a backend/tests dir exists ──────────────────────────────────
if [ -d backend/tests ] && command -v pytest >/dev/null 2>&1; then
  echo "▶ pytest backend/tests"
  (cd backend && pytest tests/ -q --no-header 2>&1 | tail -30) || exit 1
fi

echo
echo "✓ validation passed"
exit 0
VALIDATEEOF
chmod +x {home_dir}/.pocketeng/validate.sh
chown -R {chown_user}:{chown_user} {home_dir}/.pocketeng 2>/dev/null || true
"""


def _integrations_block(vercel_token=None, supabase_url=None, supabase_service_key=None, is_macos=False):
    """Install and configure Vercel CLI and Supabase CLI if tokens provided."""
    blocks = []
    env_file = "$USER_HOME/.zprofile" if is_macos else "/home/ec2-user/.bashrc"
    install_prefix = "su - ec2-user -c" if is_macos else "su - ec2-user -c"

    if vercel_token:
        blocks.append(f"""
echo "--- Installing Vercel CLI ---"
{install_prefix} 'npm install -g vercel'
echo 'export VERCEL_TOKEN={vercel_token}' >> {env_file}
""")

    if supabase_url:
        blocks.append(f"""
echo "--- Installing Supabase CLI ---"
{install_prefix} 'npm install -g supabase'
echo 'export SUPABASE_URL={supabase_url}' >> {env_file}
""")
        if supabase_service_key:
            blocks.append(f"echo 'export SUPABASE_SERVICE_ROLE_KEY={supabase_service_key}' >> {env_file}")

    return "\n".join(blocks)


def _auto_setup_block(home_dir="/home/ec2-user", user="ec2-user", group=None,
                      env_vars=None, setup_files=None, is_macos=False):
    """Install dependencies and write config files as part of the userdata script.

    Runs after repos are cloned and env vars are set, so everything is in place.
    This replaces the old approach of sending a setup prompt from the frontend.
    """
    group = group or user
    blocks = []

    # Write setup files into the first project directory
    if setup_files:
        blocks.append('echo "--- Writing setup files ---"')
        blocks.append(f'FIRST_PROJECT=$(ls -d {home_dir}/projects/*/ 2>/dev/null | head -1)')
        blocks.append(f'FIRST_PROJECT="${{FIRST_PROJECT:-{home_dir}/projects/}}"')
        for sf in setup_files:
            name = sf.get("name", "").strip()
            content = sf.get("content", "")
            if not name:
                continue
            # Base64-encode content to safely transfer it
            b64 = base64.b64encode(content.encode()).decode()
            blocks.append(f'echo "Writing {name}"')
            blocks.append(f'echo "{b64}" | base64 -d > "$FIRST_PROJECT/{name}"')
        blocks.append(f'chown -R {user}:{group} {home_dir}/projects/ 2>/dev/null || true')

    # Write .env / .env.local files from env vars into each project
    if env_vars:
        sanitized = sanitize_env_vars(env_vars)
        if sanitized:
            blocks.append('echo "--- Writing .env files to projects ---"')
            # Build the .env content
            env_lines = []
            for key, value in sanitized.items():
                env_lines.append(f"{key}={shlex.quote(value)}")
            env_content = "\n".join(env_lines)
            b64_env = base64.b64encode(env_content.encode()).decode()
            su_prefix = f"su - {user} -c" if not is_macos else f"su - {user} -c"
            blocks.append(f"""
for projdir in {home_dir}/projects/*/; do
  [ -d "$projdir" ] || continue
  # Write .env.local (preferred by Next.js, Vite, etc.)
  echo "{b64_env}" | base64 -d > "$projdir/.env.local"
  # Also write .env for frameworks that use it (Flask, Django, etc.)
  echo "{b64_env}" | base64 -d > "$projdir/.env"
  # Ensure .env files are in .gitignore
  for envfile in .env .env.local; do
    if [ -f "$projdir/.gitignore" ]; then
      grep -qxF "$envfile" "$projdir/.gitignore" 2>/dev/null || echo "$envfile" >> "$projdir/.gitignore"
    fi
  done
done
chown -R {user}:{group} {home_dir}/projects/ 2>/dev/null || true""")

    # Install dependencies — scan repo root and one level of subdirectories
    blocks.append(f'echo "--- Installing project dependencies ---"')
    su_cmd = f"su - {user} -c"
    blocks.append(f"""
pe_install_deps() {{
  local dir="$1"
  local label="$2"
  [ -d "$dir" ] || return
  if [ -f "$dir/package.json" ]; then
    echo "Installing npm deps for $label"
    {su_cmd} "cd '$dir' && npm install" || echo "WARN: npm install failed for $label"
  fi
  if [ -f "$dir/requirements.txt" ]; then
    echo "Installing pip deps for $label"
    {su_cmd} "cd '$dir' && pip3 install -r requirements.txt" || echo "WARN: pip install failed for $label"
  fi
  if [ -f "$dir/pyproject.toml" ]; then
    echo "Installing Python project $label"
    {su_cmd} "cd '$dir' && pip3 install -e ." || echo "WARN: pip install failed for $label"
  fi
  if [ -f "$dir/Gemfile" ]; then
    echo "Installing Ruby deps for $label"
    {su_cmd} "cd '$dir' && bundle install" || echo "WARN: bundle install failed for $label"
  fi
  if [ -f "$dir/go.mod" ]; then
    echo "Installing Go deps for $label"
    {su_cmd} "cd '$dir' && go mod download" || echo "WARN: go mod download failed for $label"
  fi
}}
for projdir in {home_dir}/projects/*/; do
  [ -d "$projdir" ] || continue
  projname=$(basename "$projdir")
  # Check repo root
  pe_install_deps "$projdir" "$projname"
  # Check immediate subdirectories (monorepos, nested projects)
  for subdir in "$projdir"*/; do
    [ -d "$subdir" ] || continue
    subname="$projname/$(basename "$subdir")"
    pe_install_deps "$subdir" "$subname"
  done
done""")

    return "\n".join(blocks)


def _env_vars_block(env_vars, env_file):
    """Write user-provided environment variables to the shell profile between sentinel comments."""
    sanitized = sanitize_env_vars(env_vars)
    if not sanitized:
        return ""

    valid_pairs = list(sanitized.items())

    lines = ['echo "--- Setting custom environment variables ---"']
    # Remove any existing PE custom env block (sed -i.bak works on both Linux and macOS)
    lines.append(f"sed -i.bak '/# >>> PE_CUSTOM_ENV/,/# <<< PE_CUSTOM_ENV/d' {env_file} 2>/dev/null || true")
    lines.append(f"rm -f {env_file}.bak 2>/dev/null || true")
    lines.append(f"echo '# >>> PE_CUSTOM_ENV' >> {env_file}")
    for safe_key, value in valid_pairs:
        # shlex.quote produces valid bash quoting; base64 safely transfers the line to the file
        export_line = f"export {safe_key}={shlex.quote(value)}"
        b64 = base64.b64encode(export_line.encode()).decode()
        lines.append(f"printf '%s\\n' \"$(echo '{b64}' | base64 -d)\" >> {env_file}")
    lines.append(f"echo '# <<< PE_CUSTOM_ENV' >> {env_file}")
    return "\n".join(lines)


def _gh_wrapper_block():
    """Install /usr/local/bin/gh shim that appends a PocketEng attribution
    line to PR descriptions raised via `gh pr create`.

    PATH on Amazon Linux 2023 puts /usr/local/bin before /usr/bin, so the
    shim shadows the real `gh` binary. All non-`pr-create` invocations pass
    straight through. For `pr create`, the attribution is appended only when
    a body flag (--body / -b / --body-file / -F) is provided — calls without
    one fall through to gh's default behavior (commit-message-derived body
    or interactive editor) so we don't change semantics for human users.

    Agent-agnostic by design: every agent we ship (Claude, Codex, OpenCode,
    Cursor) shells out to `gh` to open PRs, so all four are covered.
    """
    return r'''
if [ -x /usr/bin/gh ]; then
echo "--- Installing PocketEng gh wrapper ---"
cat > /usr/local/bin/gh << 'GHWRAPEOF'
#!/bin/bash
# PocketEng gh wrapper. Appends an attribution line to PR descriptions
# raised via `gh pr create`. Other subcommands pass through unchanged.
REAL_GH=/usr/bin/gh
ATTR="Built on my iPhone using [pocketeng](https://pocketeng.ai)"

if [ "${1:-}" != "pr" ] || [ "${2:-}" != "create" ]; then
    exec "$REAL_GH" "$@"
fi

new=()
while [ $# -gt 0 ]; do
    case "$1" in
        --body|-b)
            v="$2"
            case "$v" in *"$ATTR"*) ;; *) v="$v"$'\n\n'"$ATTR" ;; esac
            new+=("--body" "$v")
            shift 2
            ;;
        --body=*)
            v="${1#--body=}"
            case "$v" in *"$ATTR"*) ;; *) v="$v"$'\n\n'"$ATTR" ;; esac
            new+=("--body" "$v")
            shift
            ;;
        --body-file|-F)
            f="$2"
            if [ "$f" = "-" ]; then v="$(cat)"; else v="$(cat "$f")"; fi
            case "$v" in *"$ATTR"*) ;; *) v="$v"$'\n\n'"$ATTR" ;; esac
            new+=("--body" "$v")
            shift 2
            ;;
        --body-file=*)
            f="${1#--body-file=}"
            if [ "$f" = "-" ]; then v="$(cat)"; else v="$(cat "$f")"; fi
            case "$v" in *"$ATTR"*) ;; *) v="$v"$'\n\n'"$ATTR" ;; esac
            new+=("--body" "$v")
            shift
            ;;
        *)
            new+=("$1")
            shift
            ;;
    esac
done

exec "$REAL_GH" "${new[@]}"
GHWRAPEOF
chmod +x /usr/local/bin/gh
else
echo "--- Skipping PocketEng gh wrapper (no /usr/bin/gh) ---"
fi
'''


def _cursor_install_block(agents, is_macos=False):
    """Return shell snippet to install Cursor CLI.

    Installed unconditionally (even if 'cursor' isn't in the user's agent
    list) so the subscription login flow (agent_login.py) can run
    `cursor-agent login` on any workspace regardless of the provisioned
    agent selection. Keeps the onboarding UX symmetric — any of the three
    Connect cards works on any workspace."""
    label = get_agent_label("cursor")
    if is_macos:
        return f"""
echo "--- Installing {label} ---"
su - ec2-user -c 'curl -fsSL https://cursor.com/install | bash'
su - ec2-user -c 'echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.zprofile'
"""
    return f"""
echo "--- Installing {label} ---"
su - ec2-user -c 'curl -fsSL https://cursor.com/install | bash'
su - ec2-user -c 'echo '"'"'export PATH="$HOME/.local/bin:$PATH"'"'"' >> ~/.bashrc'
"""


def _agent_binary_name(agent_id):
    """Return the CLI binary name used for verification."""
    if agent_id == "cursor":
        return "agent"
    return agent_id


def _preview_dispatcher_block():
    """Install the preview-port dispatcher + its systemd unit.

    Why it exists
    -------------
    The per-workspace Cloudflare Tunnel forwards every request for
    `w-<wsId>.pocketeng.co` to a single local origin — this dispatcher,
    on 127.0.0.1:8844. The preview Worker at `preview.pocketeng.co`
    sets `X-Preview-Port: <N>` on outbound fetches; the dispatcher
    reads it, strips it, and proxies to `http://127.0.0.1:<N>`.

    This means the tunnel never needs per-port ingress rule churn (we
    got bitten by that the old way — every port click mutated tunnel
    config). One ingress rule per tunnel, forever.

    Safe to re-run: the heredoc overwrites the script and `systemctl
    enable --now` is idempotent. If this userdata executes on a box
    that already has the dispatcher, the old version is replaced and
    the service restarts.
    """
    # Heredoc delimiter is quoted ('PE_PREVIEW_DISPATCHER_EOF') so bash
    # does NOT expand $vars or backticks in the JS body. Essential —
    # our script contains template literals with ${port}.
    return f"""
echo "--- Installing preview-port dispatcher (127.0.0.1:8844) ---"
mkdir -p /opt/pe-preview-dispatcher
cat > /opt/pe-preview-dispatcher/preview-dispatcher.cjs <<'PE_PREVIEW_DISPATCHER_EOF'
{_PREVIEW_DISPATCHER_SCRIPT}
PE_PREVIEW_DISPATCHER_EOF

cat > /etc/systemd/system/pe-preview-dispatcher.service <<'PE_PREVIEW_DISPATCHER_UNIT_EOF'
[Unit]
Description=PocketEngineer preview-port dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Resolve `node` at runtime via env so a future PATH change (e.g.
# nodejs20-npm is the first package to arrive) keeps working without
# unit edits. `which` in the exec line would require a login shell;
# /usr/bin/env handles it.
ExecStart=/usr/bin/env node /opt/pe-preview-dispatcher/preview-dispatcher.cjs
Restart=on-failure
RestartSec=2
# The dispatcher binds to loopback and takes no filesystem writes, so
# tight sandboxing costs us nothing.
ProtectSystem=strict
ProtectHome=true
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
PE_PREVIEW_DISPATCHER_UNIT_EOF

systemctl daemon-reload
systemctl enable --now pe-preview-dispatcher.service || echo "WARN: pe-preview-dispatcher enable failed"
"""


def _cloudflared_block(tunnel_token):
    """Install cloudflared + register it as a systemd service bound to
    `tunnel_token`. Empty token -> return an empty string so older
    provisions (or test stacks that don't have Cloudflare configured)
    boot exactly as before.

    AL2023 ships cloudflared as a first-class rpm. We install the GA
    release (not latest) because GA is what Cloudflare supports and
    `service install` is stable there. The service-install invocation
    is idempotent so re-running the userdata on an existing box (e.g.
    via SSH for testing) won't double-register.
    """
    if not tunnel_token:
        return ""
    safe_token = shlex.quote(tunnel_token)
    return f"""
echo "--- Installing cloudflared (Cloudflare Tunnel) ---"
# AL2023 has the package in the distro repo via cloudflare-main; we go
# direct-download instead to pin to the official GA asset (same bits
# the cloudflared install.sh would fetch). rpm -i is idempotent — a
# pre-existing install is upgraded in place.
curl -fsSL -o /tmp/cloudflared.rpm \\
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm \\
    && (rpm -i --force /tmp/cloudflared.rpm || dnf install -y /tmp/cloudflared.rpm) \\
    || echo "WARN: cloudflared install failed"

echo "--- Registering cloudflared systemd service ---"
# `cloudflared service install <token>` writes the token into
# /etc/cloudflared/ and enables+starts the cloudflared systemd unit.
# If this userdata is ever re-run we uninstall the old unit first so
# the token is fresh.
systemctl stop cloudflared 2>/dev/null || true
cloudflared service uninstall 2>/dev/null || true
cloudflared service install {safe_token} || echo "WARN: cloudflared service install failed"
systemctl enable --now cloudflared 2>/dev/null || true
"""


def build_userdata(anthropic_key, agents=None, github_token=None, github_username=None, repos=None,
                   vercel_token=None, supabase_url=None, supabase_service_key=None, skills=None, env_vars=None,
                   custom_skills=None, openai_key=None, setup_files=None, setup_instructions=None,
                   cursor_key=None, tunnel_token=None):
    if not agents:
        agents = ["claude"]
    # Always install all four coding agents regardless of which the user
    # picked in the provision form. Why: subscription login (agent_login.py)
    # runs `claude auth login` / `codex login` / `cursor-agent login` /
    # `opencode` on
    # this box, and the user can connect any agent they want post-provision
    # even if their workspace's primary `agents` list didn't include it.
    # Install cost is marginal — four npm globals + one curl installer.
    install_agents = sorted(set(list(agents) + ["claude", "codex", "cursor", "opencode"]))
    agent_installs = "\n".join(
        f'echo "--- Installing {get_agent_label(a)} ---"\nnpm install -g {get_agent_package(a)}'
        for a in install_agents if get_agent_package(a)
    )
    # Bridge code ships from the backend via SFTP at session launch — we
    # only need the SDK deps globally so the bridge's imports resolve.
    # Installed unconditionally now that claude (the default agent) also
    # uses the bridge.
    bridge_install = """
echo "--- Installing agent bridge SDK deps ---"
npm install -g @anthropic-ai/claude-agent-sdk @openai/codex-sdk @opencode-ai/sdk @cursor/sdk || true
"""
    git_name, git_email, git_creds_block, clone_block = _git_blocks(github_token, github_username, repos)
    integrations = _integrations_block(vercel_token, supabase_url, supabase_service_key, is_macos=False)
    skills_block = _skills_block(skills, custom_skills=custom_skills, home_dir="/home/ec2-user")
    claude_md_block = _claude_md_block(
        home_dir="/home/ec2-user", repos=repos, env_vars=env_vars,
        setup_files=setup_files, setup_instructions=setup_instructions,
        has_vercel=bool(vercel_token), has_supabase=bool(supabase_url),
        has_github=bool(github_token),
    )
    auto_setup_block = _auto_setup_block(
        home_dir="/home/ec2-user", user="ec2-user",
        env_vars=env_vars, setup_files=setup_files,
    )
    validation_block = _validation_default_block(home_dir="/home/ec2-user", chown_user="ec2-user")
    env_vars_block = _env_vars_block(env_vars or {}, "/home/ec2-user/.bashrc")
    api_keys_block = _api_keys_block(anthropic_key, openai_key, "/home/ec2-user", "/home/ec2-user/.bashrc", "ec2-user",
                                     cursor_key=cursor_key)
    cursor_install = _cursor_install_block(agents)
    gh_wrapper = _gh_wrapper_block()
    cloudflared_block = _cloudflared_block(tunnel_token)
    preview_dispatcher_block = _preview_dispatcher_block()

    return f"""#!/bin/bash
exec > /var/log/pocketeng-setup.log 2>&1
echo "=== Pocket Eng managed server setup started ==="

# Base packages
echo "--- Installing base packages ---"
dnf install -y git tmux python3 python3-pip jq tar gzip unzip which rsync
dnf install -y nodejs20-npm 2>/dev/null || dnf install -y nodejs20 npm 2>/dev/null || dnf install -y nodejs npm
node -v && npm -v

{agent_installs}
{cursor_install}
{bridge_install}
echo "--- Installing Python packages ---"
pip3 install flask requests boto3 || true

echo "--- Installing headless Chrome (for UI screenshots) ---"
dnf install -y chromium || yum install -y chromium || echo "WARN: chromium install failed"

echo "--- Installing GitHub CLI ---"
dnf install -y 'dnf-command(config-manager)' || true
dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || true
dnf install -y gh || echo "WARN: gh cli install failed"
{gh_wrapper}

echo "--- Installing AWS CLI ---"
curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip
unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscli.zip || echo "WARN: awscli install failed"
{preview_dispatcher_block}
{cloudflared_block}

echo "--- Configuring environment ---"
{api_keys_block}
mkdir -p /home/ec2-user/projects && chown -R ec2-user:ec2-user /home/ec2-user/projects
su - ec2-user -c 'git config --global user.name "{git_name}"'
su - ec2-user -c 'git config --global user.email "{git_email}"'
{git_creds_block}
{clone_block}
{integrations}
{skills_block}
{claude_md_block}
{validation_block}
{env_vars_block}
{auto_setup_block}

cat > /home/ec2-user/.tmux.conf << 'TMUXEOF'
set -g mouse on
set -g history-limit 50000
set -g status-style 'bg=#1e1e2e fg=#cdd6f4'
TMUXEOF
chown ec2-user:ec2-user /home/ec2-user/.tmux.conf

echo "=== Verifying installations ==="
echo "node: $(node --version 2>/dev/null || echo MISSING)"
echo "npm: $(npm --version 2>/dev/null || echo MISSING)"
{"".join(f'echo "{a}: $(which {_agent_binary_name(a)} 2>/dev/null || echo MISSING)"{chr(10)}' for a in agents)}
echo "git: $(git --version 2>/dev/null || echo MISSING)"
echo "python3: $(python3 --version 2>/dev/null || echo MISSING)"
command -v aws &>/dev/null && echo "aws: $(aws --version 2>/dev/null)" || true

echo "=== Setup complete ==="
touch /home/ec2-user/.pocketeng-ready
"""

