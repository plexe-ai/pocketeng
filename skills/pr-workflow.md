# PR Workflow

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

If `git diff --cached` shows ANY of these, remove them from the index with `git restore --staged <file>`:
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
  chromium --headless --no-sandbox --disable-gpu --window-size=1280,800 \
      --screenshot=/tmp/desktop-<slug>.png http://localhost:3000/<path>

  # Mobile (iPhone 14 — 390×844). Do NOT skip this; most layout bugs only
  # show at narrow widths (header overflow, composer crowding, etc.).
  chromium --headless --no-sandbox --disable-gpu --window-size=390,844 \
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
\`\`\`
<paste actual test output>
\`\`\`

## Build
\`\`\`
<paste actual build output>
\`\`\`
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
only catches what its script tests.
