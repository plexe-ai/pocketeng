---
type: protocol
status: canonical
last_reviewed: 2026-04-23
related:
  - README.md
  - meta/write-protocol.md
  - protocols/development-cycle.md
tags: [protocol, read, onboarding]
---

# Read Protocol

**When to read:** at the start of every task.
**When to update:** only when the start-of-task routine itself changes (human sign-off).

## Summary

1. Read the repo-root `.harness/README.md`.
2. Read the four base protocols.
3. Follow the routing table for your specific task.
4. Skim `features/<feature>.md` if your task touches a known feature.
5. Check recent `learnings/` for related scars.

Total: ~15–20 minutes for most tasks.

---

## Instruction budget — read this first

Every line of context you pre-load costs attention downstream. Our harness is designed for **progressive disclosure**: the `README.md` routes you, and you pull the specific files you need. Do not read everything "just in case" — that's context rot, and it hurts the agent (and the human) by the time you're ready to act.

Rule of thumb:

- Read the four base protocols *once* per session (not per sub-task).
- Read a feature / reference / learning *only* if the routing table points to it, or your task actually touches that area.
- If you catch yourself 30 minutes in without an edit, stop and re-plan — you're over-reading.

See [`../references/harness-model.md`](../references/harness-model.md) §"Instruction budget" for the underlying principle.

### The `.harness/` is a just-in-time reference store — treat it like a filesystem

Anthropic's *Effective Context Engineering* paper (Sep 2025) says this plainly: "agents built with the 'just in time' approach maintain lightweight identifiers (file paths, stored queries, web links, etc.) and use these references to dynamically load data into context at runtime using tools." That is exactly the contract our `.harness/` offers:

- The `README.md` routing table is the **lightweight reference index**. Read it. Then pick one path.
- Folder names and filenames carry signal on their own. `playbooks/deploy-to-test-stack.md` tells you more about when to read it than any description would.
- You have `rg`, `grep`, and `ls`. Use them. The harness is a filesystem you can navigate, not a book you read cover to cover.

Positive framing of the same rule: **the quickest way to be wrong is to read more than you need**. Pull files when your task demands them, not before.

---

## Step-by-step

### 1. Entry

Start at [`README.md`](../README.md). It is the only file you are guaranteed to have been pointed at.

### 2. Base protocols

Read in this order:

1. [`protocols/development-cycle.md`](../protocols/development-cycle.md)
2. [`protocols/testing-protocol.md`](../protocols/testing-protocol.md)
3. [`protocols/safety-protocol.md`](../protocols/safety-protocol.md)
4. [`protocols/commit-and-pr-protocol.md`](../protocols/commit-and-pr-protocol.md)

Default: read all four. Skip only if the task is genuinely trivial (typo, comment tweak) — and in that case, still keep `safety-protocol.md` in mind. Most of our scars came from tasks that felt small.

### 3. Route to task-specific files

Use the routing table in `README.md`. Follow one path. Do not try to read everything.

### 4. Feature files

If your task touches a known feature (e.g. session-sync, preview proxy, OAuth), read [`features/<feature>.md`](../features/). It carries a "Known scars" table — each row is a one-line pointer into `learnings/`.

### 5. Learnings

Before writing new code in an area:

```bash
rg -li "<symptom or keyword>" .harness/learnings/
```

If something matches, read that file before you start. Learnings are short on purpose — 5 minutes each.

---

## How long you should spend

| Task size | Target read time |
|---|---|
| Typo / comment fix | 0–2 min (just the protocol tl;dr in README) |
| Small bugfix | 10 min (base protocols + relevant feature file) |
| Feature change | 20 min (base protocols + feature + related learnings + relevant playbook) |
| Architecture change | 30+ min (base protocols + architecture-overview + all relevant features and learnings) |

If you are spending more than 30 minutes reading without touching code, something is wrong. Either the harness is missing a file, or you are over-preparing — ask a human.

---

## See also

- [`write-protocol.md`](write-protocol.md) — the matching end-of-task routine
- [`../protocols/development-cycle.md`](../protocols/development-cycle.md) — the cycle this read feeds into

## Referenced by

- `README.md`
- `meta/write-protocol.md`
