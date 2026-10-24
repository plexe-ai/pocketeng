---
type: protocol
status: canonical
last_reviewed: 2026-04-30
related:
  - protocols/development-cycle.md
  - protocols/safety-protocol.md
  - protocols/testing-protocol.md
tags: [protocol, git, commits, pr]
---

# Commit and PR Protocol

**When to read:** before `git commit` or `gh pr create`.
**When to update:** when the commit / PR conventions change (human sign-off).

## Summary

- **Commit only when the user asks.** No proactive commits.
- Every commit message states the **why**, not the what.
- PRs attach **evidence**: test output, screenshots or UI summary, deploy target. Visual evidence must be **embedded** in the PR body (`![alt](https://…)`), not only linked as gitignored paths — see [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md#embed-screenshots-in-the-pr-body).
- Never amend pushed commits. Never force-push to `main`.
- Pre-push hook (`.claude/hooks/verify-before-pr.sh`) is advisory — read the output, but a pre-existing unrelated failure is not a reason to disable it.
- Before pushing, run the self-check in [`no-bypass.md`](no-bypass.md). Workarounds in a PR must be labelled, not disguised.

---

## When to commit

**Only when the user explicitly asks.** The cue is usually "commit this" or "push the changes". Otherwise, leave the working tree dirty for them to review.

If you think a commit is warranted and the user hasn't asked, ask first.

---

## Commit message style

- One-line subject, imperative mood, ≤72 chars.
- Blank line.
- Body (optional): what and why, not file-level diff narration.
- No trailers like "Co-authored-by" unless the user asks.
- No emojis.

Example:

```
fix(chat): skip tail-insert once cloud-launch owns the session

The sync daemon re-parses the rollout on every pull. Once _launch_turn has
written any bridge-format rows (currentRunSeqBase > 0), those rows own the
transcript and re-parsing creates seq collisions. Gate tail-insert on
currentRunSeqBase == 0 and preserve counters otherwise.

Unit test: TestRegisterSyncedSessionTailInsertGate::test_cloud_launched_session_skips_tail_insert
Live verified: us-west-1 test stack, Codex + Cursor fresh sessions, browser follow-up.
```

---

## What belongs in a commit

- Logic change plus its unit test.
- Doc updates **only** when they are part of the same intent. Harness captures usually go in a separate commit.
- A single, coherent diff. If the diff covers two concerns, it is two commits.

Never mix:

- Unrelated refactors and behavior changes.
- Secrets scrubbing and feature work.
- Lint fixes and substantive edits (unless trivial and unambiguous).

---

## Pre-push hook

`.claude/hooks/verify-before-pr.sh` runs on `git push`. Treat its output as advisory:

- **Real failure from your change** → fix, new commit, push again.
- **Pre-existing failure unrelated to your change** → note it in the PR description, push with the hook's output recorded.
- Never bypass with `--no-verify` unless the user says so.

If the hook keeps firing on chained commands you didn't intend to push, push from a fresh shell with a single `git push origin HEAD`.

---

## Pull request body — the template

```markdown
## Summary

- <bullet: what changed>
- <bullet: why>
- <bullet: scope fence — what you deliberately did NOT do>

## Test plan

- [ ] Unit: <command or file references>
- [ ] Integration (deployed): <stack, calls exercised>
- [ ] Real browser: <scenarios covered, how session state was reset>

## Evidence

- Unit: <paste summary lines from pytest>
- Integration: <DDB row diff or API response summary>
- Browser: <1–2 sentences on UI behavior observed>
- Browser (visual): embed key screenshots **inline** using Markdown `![step — description](https://user-images.githubusercontent.com/…/file.png)` (paste/drag into the editor to upload), **or** commit PNGs under `.github/pr-screenshots/…` and use each file’s **raw** `raw.githubusercontent.com/.../branch/.../file.png` URL. Do not rely on `test-screenshots/...` paths alone — that folder is gitignored and images will not render for reviewers.

## Known scars / follow-ups

- <link to `learnings/YYYY-MM-<slug>.md` if applicable>
- <deferred items, each with a one-line justification>
```

Every box under "Test plan" is either checked or removed — no orphan checkboxes.

---

## Amend and force-push

- **Amend** is allowed only when all of:
  - The user explicitly asked, **or** the commit succeeded and a pre-commit hook auto-modified files.
  - The HEAD commit was authored in the current session.
  - The commit has not been pushed to remote.
- **Force-push** is allowed on feature branches only with explicit user ask.
- **Force-push to `main`** is never allowed. Warn the user if they ask.

---

## Do not commit

- `.env.local`, `.env.*.local`
- `backend/samconfig.toml`, `backend/samconfig.test.toml`
- `.claude/settings.local.json`
- `*.pem`
- `ExportOptions.plist`

See [`safety-protocol.md`](safety-protocol.md) for the full list.

---

## See also

- [`development-cycle.md`](development-cycle.md) — phases 5–6 ride on this
- [`testing-protocol.md`](testing-protocol.md) — what counts as evidence
- [`safety-protocol.md`](safety-protocol.md) — secrets, destructive ops

## Referenced by

- `README.md`
- `protocols/development-cycle.md`
- `protocols/safety-protocol.md`
- `protocols/no-bypass.md`
- `protocols/tdd-and-scope.md`
