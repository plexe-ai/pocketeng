---
type: protocol
status: canonical
last_reviewed: 2026-04-30
related:
  - protocols/development-cycle.md
  - playbooks/browser-testing.md
  - playbooks/deploy-to-test-stack.md
  - playbooks/cleanup-between-runs.md
  - features/session-sync.md
tags: [protocol, testing]
---

# Testing Protocol

**When to read:** before writing tests or validating a change.
**When to update:** when what "tested" means here changes (human sign-off).

## Summary

- Unit tests must exist for new logic. They are the floor, not the ceiling.
- Integration surfaces are validated against a **deployed test stack**, not mocks.
- Real-browser tests are mandatory for anything a user interacts with.
- Bugs are **collected in a batch** during a test run, then fixed in a second pass.
- Never claim "done" based on unit tests alone.
- When building a feature or non-trivial fix, follow [`tdd-and-scope.md`](tdd-and-scope.md) for the TDD flow and the scope-discipline rules.

---

## The three layers

| Layer | When | Command / playbook |
|---|---|---|
| Unit | Every logic change | `cd backend && python3 -m pytest tests -q` — or the equivalent for the touched component |
| Integration (deployed) | Every change to chat / sync / bridge / preview / OAuth | [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md) |
| Real browser | Every user-visible change | [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) |

You climb the ladder. Skipping rungs is how the last three major bugs shipped.

---

## Real fixtures, not mocks

When you test a bridge / sync / agent behavior:

- Capture a **real `.jsonl`** from a real agent session and commit it as a fixture.
- Run parsers against the committed fixture, not a hand-written stub.
- If you need mocks, mock only at the AWS SDK boundary (`boto3` clients) — never at the protocol boundary between PocketEng and an agent.

Rationale: every hand-written stub we have shipped with missed a real format quirk. Codex's `developer` messages, Cursor's trailing-newline inconsistency, Claude's nested `tool_use` — all were missed by stubs and caught by real fixtures.

---

## Collect bugs, then fix

During a validation pass (browser or deployed integration), follow this rule:

1. Start the pass with a fresh, clean state ([`../playbooks/cleanup-between-runs.md`](../playbooks/cleanup-between-runs.md)).
2. Execute the full test plan. **Do not fix bugs mid-pass.** Write them down.
3. After the pass, triage the bug list. Fix in priority order, in separate commits.
4. Re-run the whole pass after a batch of fixes.

Breaking this rule costs us repeatedly — mid-pass fixes corrupt the state, make other bugs invisible, and lead to "it worked on my machine" reports.

---

## Real-browser tests — the standard

- Default driver is **Playwright + headless Chromium**. Open source, one command to install — anyone on any agent can run it. See [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md).
- A real-browser run must cover the feature's user-visible flow end-to-end: new session, list refresh, message render, follow-up turn, cross-device mirror (if applicable).
- **Evidence is a run folder** — numbered screenshots plus a session-recording video. Put the run folder path in the PR **and** **embed** the important frames in the description with `![alt](https://…)` (uploaded image URLs or `raw.githubusercontent.com/...` for committed PNGs). Paths under gitignored `test-screenshots/` alone do not render on GitHub. A reviewer should be able to *see* and *watch* the feature without rerunning anything.
- Also record a DynamoDB row diff before / after where applicable.
- If the browser crashes mid-test, restart from clean state. Never substitute `curl` for a UI claim.

---

## What "passes" means

| Level | Passes when |
|---|---|
| Unit | Relevant `pytest` + `node --test` paths green, no new `xfail`. |
| Integration | Every listed API call returns expected shape on the test stack, DynamoDB rows match expected. |
| Browser | The UI behaves as a human would expect across the full scenario list. No console errors. |

Edge cases worth calling out explicitly:

- **Cloud → local sync** is "passing" only when a change made in the UI appears on the laptop within the daemon's pull cycle.
- **Resume semantics** are "passing" only when a follow-up does not inject a synthetic preamble and does not clobber any earlier message.
- **Counters (`nextSeq`, `currentRunOffset`)** are "passing" only when a follow-up never overwrites a prior seq.

---

## When it's okay to ship a known bug

Rarely. If you must:

1. Capture it as a learning (`learnings/YYYY-MM-<slug>.md`) with a "known scar" status.
2. Link it from the relevant feature file.
3. Call it out in the PR description.

No silent deferrals. The broader rule against silent bypasses lives in [`no-bypass.md`](no-bypass.md).

---

## See also

- [`development-cycle.md`](development-cycle.md) — phase 4 (Test) sits inside the cycle
- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) — the real-browser harness
- [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md) — deploying for integration
- [`../playbooks/cleanup-between-runs.md`](../playbooks/cleanup-between-runs.md) — fresh state between passes

## Referenced by

- `README.md`
- `protocols/development-cycle.md`
- `protocols/tdd-and-scope.md`
- `protocols/no-bypass.md`
- `playbooks/browser-testing.md`
- `playbooks/deploy-to-test-stack.md`
- `playbooks/cleanup-between-runs.md`
- `features/session-sync.md`
- `references/known-broken-tests.md`
