---
type: playbook
status: canonical
last_reviewed: 2026-04-30
related:
  - playbooks/browser-testing.sh
  - playbooks/browser-testing.example.mjs
  - references/cursor-ide-browser.md
  - references/env-variables.md
  - protocols/testing-protocol.md
  - protocols/no-bypass.md
  - playbooks/deploy-to-test-stack.md
  - playbooks/cleanup-between-runs.md
tags: [playbook, testing, browser, playwright]
---

# Browser Testing

**When to read:** before running any UI-level validation.
**When to update:** when the harness shape or conventions change.

## Summary

We drive a real browser against a real deployed test stack. No mocks. No `curl` stand-ins for UI claims.

Default tool: **Playwright + headless Chromium.** It's open source, one command to install, and works for any engineer with any agent. The preflight script installs it for you. There is no proprietary requirement.

Every run leaves a **timestamped folder containing numbered screenshots and a session-recording video.** That folder is the evidence — you read it before declaring done, and you paste its path (or the video) into the PR so a reviewer can *see* the feature working.

---

## Why scripts + screenshots + video, not a test framework

For exploratory and pre-merge verification, we prefer **plain Node scripts** over a framework. Runners give you green/red; scripts + images + video let you *see* what actually happened — which is what you need when behavior drifts or a selector moves. Screenshots are the honest log.

When a scenario stabilizes and deserves CI regression coverage, graduate it into Playwright Test (or your framework of choice). Until then, scripts.

---

## What you need

| Thing | Source |
|---|---|
| Node 20+ | `brew install node` (see [`dev-environment-setup.md`](dev-environment-setup.md)) |
| Playwright + Chromium | Installed by `browser-testing.sh` — one command, ~60s first run |
| Local web dashboard on `:3000` | `cd web && npm run dev` |
| Deployed test stack | [`deploy-to-test-stack.md`](deploy-to-test-stack.md) |
| `web/.env.local` pointing at the test API | [`../references/env-variables.md`](../references/env-variables.md) |
| Test account creds in env | `PE_TEST_EMAIL`, `PE_TEST_PASSWORD` |
| Clean state | [`cleanup-between-runs.md`](cleanup-between-runs.md) |

Using Cursor's built-in browser MCP instead of Playwright? See [`../references/cursor-ide-browser.md`](../references/cursor-ide-browser.md) for a 1:1 mapping of these patterns onto that tool.

---

## Run the preflight

```bash
bash .harness/playbooks/browser-testing.sh
```

Idempotent. First run installs Playwright + Chromium into `~/.pocketeng/browser-harness/`; subsequent runs are near-instant. Also ensures the `test-screenshots/` output directory exists and is gitignored.

---

## The standard pattern

Every browser test is a small Node script. The template lives at [`browser-testing.example.mjs`](browser-testing.example.mjs) — copy it, adapt the scenario body. It already wires up everything below.

The script **must** do these five things (the template does them for you):

1. **Timestamped run folder.** `test-screenshots/<YYYYMMDD-HHMMSS>/` — every screenshot, the video, and all logs land there.
2. **Video recording ON.** Playwright's `recordVideo` captures the entire session. This is the trust artifact for the PR.
3. **Numbered screenshots at every step.** `01-landing.png`, `02-after-login.png`, `03-session-opened.png`, … If the test fails, you see exactly where.
4. **Always-on network + console hooks.** `page.on('response')`, `page.on('console')` (errors only), `page.on('pageerror')`. They cost nothing and catch runtime bugs that screenshots alone would miss.
5. **Print the run folder path at the end.** So you (and your reviewer) can click straight into the evidence.

These are not optional. A run without them is not a browser test.

---

## When a selector misses — add a DOM diagnostic

Don't guess. When a click or fill silently does nothing, evaluate the page and see what's actually there:

```js
const info = await page.evaluate(() => ({
  url: location.href,
  roleButtons: document.querySelectorAll('[role="button"]').length,
  cards:       document.querySelectorAll('[class*="rounded"]').length,
  forms:       document.querySelectorAll('form').length,
  visibleText: (document.body.innerText || '').slice(0, 1500),
}))
console.log(info)
```

Thirty seconds of evaluation beats an hour of selector roulette. The example script includes a `diag(page, tag)` helper you can call whenever the page surprises you.

---

## When state disagrees with your mental model — probe the system

If "this session is for user X" doesn't match what the UI shows, don't spelunk DynamoDB. Write a 20-line script that logs in, reads `localStorage`, decodes the Supabase `access_token` JWT, and prints `sub`. Faster and more truthful than reasoning about it.

General principle: when two sources of "truth" disagree, a tiny probe that reads what the browser actually has in hand beats deeper investigation almost every time.

---

## Running the canonical pass

1. Start with clean state ([`cleanup-between-runs.md`](cleanup-between-runs.md)).
2. Run your scenario script — it records video + numbered screenshots into `test-screenshots/<ts>/`.
3. Script prints the run folder path when done.
4. **Read the screenshots in order, then watch the video.** This is the actual verification.
5. If anything failed, the screenshots tell you where; the video tells you how it felt; the console/network logs tell you why.
6. Collect bugs, don't fix mid-pass. See [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md).

A green script you didn't read is not a tested feature.

---

## Scenarios we cover

| Area | Scenarios | Feature file |
|---|---|---|
| Session sync | Local → UI appearance; UI follow-up; cloud-initiated mirror; post-sync daemon stability | [`../features/session-sync.md`](../features/session-sync.md) |
| Chat | Send message, receive stream, model + agent selectors | — |
| Preview proxy | Open a dev-server port in the UI; proxy direct + SSH tunnel | — |
| OAuth / login | Supabase login end-to-end on `:3000` | — |

Each area earns a dedicated scenario script over time. None of them require a framework runner yet.

---

## Attach evidence to the PR

In the PR description:

- **Run folder path** at minimum (e.g. `test-screenshots/20260423-141205/`) so anyone with the branch can re-open the full artifact set locally.
- **Video** — `video.webm` from the run folder. Upload it (drag into the description or attach) and link it; GitHub often renders attached WebM inline.
- **One to two sentences** per scenario: pass / fail, one-line repro if fail.
- **Links to any new `learnings/` files** that came out of the pass.

The point is trust. A reviewer should be able to open the video and see the feature working, without rerunning anything. This is the high-bandwidth feedback channel — use it.

### Embed screenshots in the PR body

GitHub **does not** render images from:

- Local disk paths or bare filenames (there is no host to fetch them from).
- The default `test-screenshots/` run folder alone — that tree is **gitignored**, so it never exists on the remote for `![](...)` to resolve.

Reviewers see a **broken image icon** or plain text unless you give a **publicly fetchable URL** or a **committed repo path** resolved to raw content.

Do one of the following for each key frame (landing, after action, result):

1. **Paste or drag PNGs into the PR description** (or a follow-up comment). GitHub uploads them to `https://user-images.githubusercontent.com/...`. Then use standard Markdown so they render inline:

   ```markdown
   ### Browser — session rename
   ![01 — landing](https://user-images.githubusercontent.com/…/01-landing.png)
   ![05 — menu open](https://user-images.githubusercontent.com/…/05-menu-open.png)
   ```

2. **Commit** a small set of PNGs under a tracked path (e.g. `.github/pr-screenshots/<short-slug>/`) on your PR branch, push, and embed with a **raw** URL (replace owner, repo, branch, path):

   `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/.github/pr-screenshots/<short-slug>/01-landing.png`

   Or, from the PR “Files changed” tab, open the image → “View raw” → copy that URL into `![alt](url)`.

Do **not** rely on “I attached files at the bottom of the PR” alone — those attachments are easy to miss and often do not appear as **inline** figures in the description. The description itself should contain `![alt](url)` lines (or HTML `<img>` with the same URLs) so the visuals show up in the default PR view.

---

## If the browser crashes or hangs

1. Kill the node process.
2. `rm -rf test-screenshots/<ts>` if the folder is corrupted.
3. Re-run from clean state.
4. Do **not** substitute `curl` for a UI claim. See [`../protocols/no-bypass.md`](../protocols/no-bypass.md).

---

## See also

- [`browser-testing.sh`](browser-testing.sh) — install + preflight
- [`browser-testing.example.mjs`](browser-testing.example.mjs) — copy-and-adapt template
- [`../references/cursor-ide-browser.md`](../references/cursor-ide-browser.md) — MCP alternative for Cursor users
- [`../references/env-variables.md`](../references/env-variables.md) — `PE_TEST_EMAIL`, `PE_TEST_PASSWORD`, etc.
- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md)
- [`../protocols/no-bypass.md`](../protocols/no-bypass.md)
- [`deploy-to-test-stack.md`](deploy-to-test-stack.md)
- [`cleanup-between-runs.md`](cleanup-between-runs.md)

## Referenced by

- `README.md`
- `protocols/testing-protocol.md`
- `playbooks/dev-environment-setup.md`
- `features/session-sync.md`
- `references/cursor-ide-browser.md`
- `learnings/2026-04-landing-auth-restore-must-own-viewport.md`
- `learnings/2026-04-mobile-route-guards-must-not-use-getuser.md`
