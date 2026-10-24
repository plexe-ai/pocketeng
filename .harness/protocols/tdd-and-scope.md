---
type: protocol
status: draft
last_reviewed: 2026-04-23
related:
  - protocols/development-cycle.md
  - protocols/testing-protocol.md
  - protocols/no-bypass.md
  - protocols/commit-and-pr-protocol.md
  - references/known-broken-tests.md
tags: [protocol, tdd, scope, tests]
---

# TDD and Scope

**When to read:** before starting a feature or non-trivial bugfix.
**When to update:** when the rule itself changes (human sign-off).

> Status: **draft** — proposed protocol addition. Flip to `canonical` once approved in review.

## Summary

Build features by landing the test first. Keep changes inside the thing you're developing. When the suite goes red outside your scope, stop before patching — investigate or ask.

- Tests live in `tests/`. Run the full suite; don't cherry-pick.
- Core logic lands as an exploration test first, then gets promoted to real code — when that pays off.
- Green-the-suite, not green-your-test.
- Don't patch unrelated features to pass your test. Investigate. Ask.
- These are strong defaults. Use judgment; record your reasoning in the PR.

---

## Baseline before you start

Run the full test suite before you write any code. Record which tests are already red — that is the **pre-existing baseline**, not your problem, unless you knowingly relied on them.

Known-broken tests are listed in [`../references/known-broken-tests.md`](../references/known-broken-tests.md). If your baseline run surfaces something not on that list, either fix it (if trivial and obviously unrelated to you) or note it in your plan before touching anything else.

---

## Core-first via exploration

For a non-trivial feature:

1. Open the test file for the unit you're changing (e.g. `tests/test_chat.py`).
2. Write one test that captures the **core invariant** your feature must preserve. Name it `test_exploration_<short>` or drop it in a `TestExploration...` class so it's visible.
3. Stub in the bare minimum implementation to make that test pass.
4. Then move to the real implementation.
5. Decide the fate of the exploration test:
   - **Keep it** if it documents an invariant future engineers should remember. Rename and strengthen it into a real test.
   - **Delete it** if it was pure scaffolding and the real tests now cover the same ground.

This is not dogma. For a one-line bugfix or a pure refactor, skip straight to the regression / parity test. Exploration-first pays when the feature has a non-obvious invariant that will be tempting to break later.

---

## Bugfix rule: regression test in the same commit

A bug without a regression test is an invitation for it to return. Every bugfix commit includes one test that fails without the fix and passes with it. If the bug becomes a `learnings/YYYY-MM-*.md` entry, that file links to the guarding test.

---

## Green-the-suite, not green-your-test

"Done" means the whole suite is green, or the delta from baseline is fully attributed to pre-existing failures. Running only the tests you wrote is not enough — we have shipped green-local / red-suite before and regretted it.

---

## Scope discipline — when another test goes red

| Situation | Default action |
|---|---|
| Mechanical cascade — you renamed `foo` → `bar` and three tests still import `foo` | Fix in the same commit. Call it out in the PR body. |
| Ambiguous — an unrelated test's output shifted and the cause isn't obvious | Stop. Investigate — `git bisect` is faster than you think. Ask if the root cause crosses feature boundaries. |
| Behavioral — making your test pass requires changing another feature's assertions | Stop. Do not touch the other test without explicit approval. The red test is signal, not noise. |

Bias toward asking over patching. A 30-second clarification is cheaper than a bad cross-feature patch.

---

## What you decide vs what needs approval

You decide, without asking:

- Whether to write an exploration test or go straight to the real one.
- Whether a test failure is a mechanical cascade (fix) or ambiguous (investigate).
- Whether an exploration test graduates or gets deleted after promotion.
- Which test framework idioms to use within the existing style of the suite.

Ask first (and land with draft status until approved):

- When a patch would change another feature's behavior or tests.
- When the pre-existing baseline is red in a way not covered by `known-broken-tests.md` and you're unsure whether to fix or defer.
- When you're tempted to `skip` / `xfail` a test you didn't write.
- When the "right" fix would cross the protocol boundary (e.g. changes a rule in this file or `testing-protocol.md`).

Silent exercise of authority on the second list is the rot we're guarding against. Exercising authority on the first list is what makes you effective — do that freely.

---

## Hygiene

- **Colocate:** `test_<unit>.py` tests `<unit>.py`. Don't hide tests in clever locations.
- **No silent skips:** every `skip` / `xfail` points to a linked issue, learning, or known-broken entry. The wider rule is in [`no-bypass.md`](no-bypass.md).
- **Fresh fixtures beat mocks** at the integration surface. See [`testing-protocol.md`](testing-protocol.md).
- **One concern per commit.** See [`commit-and-pr-protocol.md`](commit-and-pr-protocol.md).

---

## See also

- [`development-cycle.md`](development-cycle.md) — phase 3 + 4 sit on top of this
- [`testing-protocol.md`](testing-protocol.md) — what counts as "tested"
- [`../references/known-broken-tests.md`](../references/known-broken-tests.md) — the pre-existing baseline
- [`commit-and-pr-protocol.md`](commit-and-pr-protocol.md) — landing the work

## Referenced by

- `README.md`
- `protocols/development-cycle.md`
- `protocols/testing-protocol.md`
- `references/known-broken-tests.md`
