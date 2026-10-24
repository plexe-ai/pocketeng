---
type: protocol
status: canonical
last_reviewed: 2026-04-23
related:
  - protocols/testing-protocol.md
  - protocols/safety-protocol.md
  - protocols/commit-and-pr-protocol.md
  - features/session-sync.md
tags: [protocol, process, cycle]
---

# Development Cycle

**When to read:** at the start of every task.
**When to update:** only when the cycle itself changes (human sign-off).

## Summary

Every task moves through six phases: **Read → Plan → Build → Test → Review → Capture**. Skipping a phase is how bugs ship. The phases are the same for a typo fix and a cross-service refactor — only the time per phase changes.

The middle four phases map to the industry "**planner → generator → evaluator → reviewer**" pattern: Plan is planning, Build is generation, Test runs our sensors, Review is the inferential pass. See [`../references/harness-model.md`](../references/harness-model.md) for vocabulary.

---

## The six phases

| Phase | Role in the harness model | Output |
|---|---|---|
| 1. Read | Load context — follow guides | Protocols read, feature file skimmed, relevant learnings found |
| 2. Plan | **Planner** — decide approach | A short plan (todos or prose) with explicit test plan |
| 3. Build | **Generator** — implement | Code + unit tests |
| 4. Test | **Evaluator** — run sensors (computational + real-browser) | Unit + real-browser / real-deploy validation, bug list |
| 5. Review | **Reviewer** — inferential pass | Diff walked, lints clean, secrets check |
| 6. Capture | Feed the harness forward | Learnings / playbooks / references updated |

You may iterate inside a phase. You may not officially "finish" until phase 6.

For the full map of which sensors fire in phase 4, see [`../references/feedback-controls.md`](../references/feedback-controls.md).

**Reasoning-sandwich guidance.** LangChain's *Improving Deep Agents* post shows concretely that weighting reasoning toward Plan and Review outperforms a uniform effort budget (and substantially outperforms max-effort-everywhere, which times out). Reflect that in your own attention budget: **Plan** and **Review** deserve the sharpest thinking; **Build** can cruise when the plan is clear; **Test** is where your effort shifts from writing to reading what the sensors say. If you catch yourself bored during Plan or Review, that's a signal you're under-investing — loop back.

---

## Phase 1 — Read

Follow [`../meta/read-protocol.md`](../meta/read-protocol.md).

**Done criterion:** you can state in one sentence what the system does in the area you're touching, and you've read the relevant feature file + linked learnings.

**Baseline smoke check (recommended for browser-observable work).** If your task will touch a UI flow or an API the web app calls, run the relevant smoke test *before* you write any code. Catches silent breakage inherited from a previous session or deploy — the same failure mode Anthropic flags in *Effective harnesses for long-running agents*. For browser work: 30-second Playwright run via [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md). For backend-only: `python3 -m pytest tests -q`. If it's red before you start, pause and decide whether fixing it is your task or someone else's.

---

## Phase 2 — Plan

Write the plan before writing code. For anything non-trivial, write it in the todo list so it is visible to the user.

A plan states:

1. What you will change (files or concepts).
2. How you will test it.
3. What you will *not* do in this task (scope fence).

**Branching decision:** if the plan touches the integration surface (bridge, sync, chat, deploys), walk it past the user before coding. If it only touches isolated logic with good tests, proceed.

---

## Phase 3 — Build

Code plus **unit tests in the same change**. For anything that touches persistence, sequence numbers, or the sync graph, add tests that describe the invariant you are preserving.

For features and non-trivial fixes, follow the TDD + scope-discipline rules in [`tdd-and-scope.md`](tdd-and-scope.md). It covers: baselining the suite before you start, exploration-first when the feature has a non-obvious invariant, and what to do when an unrelated test goes red.

Prefer:

- Small commits that each pass tests.
- Feature-flagging where the change is risky and reversible (env var or explicit toggle).
- Real fixtures over mocks. See [`testing-protocol.md`](testing-protocol.md).

---

## Phase 4 — Test

Three layers, in order:

1. **Unit** — `cd backend && python3 -m pytest tests -q` (or the equivalent for the component).
2. **Integration against a deployed test stack** — deploy with [`../playbooks/deploy-to-test-stack.md`](../playbooks/deploy-to-test-stack.md), then hit the real API.
3. **Real browser** — follow [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md).

**Bugs are collected, not fixed mid-test.** Complete the run. Record every anomaly. Then, in a second pass, fix in priority order. This is the single most common place engineers shortcut and regret later.

---

## Phase 5 — Review

Before asking for human review:

- Walk the diff file by file, top to bottom.
- Check for leftover debug prints, commented-out code, temporary hacks.
- Re-read the four base protocols against your change.
- Verify no secrets (see [`safety-protocol.md`](safety-protocol.md)).
- Run lints / type checks available for the touched surface.

---

## Phase 6 — Capture

Follow [`../meta/write-protocol.md`](../meta/write-protocol.md). Ask the four questions, write what applies, wire the links, bump `last_reviewed`.

**Only after capture is the task done.**

---

## Anti-patterns

| Pattern | Why it hurts |
|---|---|
| "I'll test after I commit." | Bugs get encoded into history. |
| "I'll mock the bridge / DB / agent." | Mocks hide the integration bugs that actually ship. |
| "I'll capture the learning later." | You won't. Context decays within hours. |
| Declaring done after unit tests pass. | The last three big bugs were not caught by unit tests. |
| Fixing bugs as you spot them in the test pass. | Breaks the inventory; makes prioritization impossible. |
| Silent protocol edits. | Every future task inherits the new rule. Flag it. |
| Routing around a blocker instead of surfacing it. | See [`no-bypass.md`](no-bypass.md) — the whole class of "quietly make it fit" failures. |

---

## See also

- [`testing-protocol.md`](testing-protocol.md) — what "tested" means here
- [`safety-protocol.md`](safety-protocol.md) — the non-negotiable guards
- [`commit-and-pr-protocol.md`](commit-and-pr-protocol.md) — closing the loop
- [`../meta/read-protocol.md`](../meta/read-protocol.md) — phase 1 detail
- [`../meta/write-protocol.md`](../meta/write-protocol.md) — phase 6 detail

## Referenced by

- `README.md`
- `meta/read-protocol.md`
- `protocols/testing-protocol.md`
- `protocols/tdd-and-scope.md`
- `protocols/no-bypass.md`
- `protocols/commit-and-pr-protocol.md`
