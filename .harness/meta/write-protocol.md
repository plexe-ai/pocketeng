---
type: protocol
status: canonical
last_reviewed: 2026-04-23
related:
  - README.md
  - meta/read-protocol.md
  - meta/file-taxonomy.md
  - meta/file-template.md
  - meta/linking-protocol.md
tags: [protocol, write, knowledge-capture]
---

# Write Protocol

**When to read:** at the end of every non-trivial task, before you close the loop.
**When to update:** only when the end-of-task routine itself changes (human sign-off).

## Summary

1. Ask: did I learn anything this session?
2. Pick the right file type using the taxonomy.
3. Write or update the file using the template.
4. Wire in forward + backward links.
5. Bump `last_reviewed`.
6. Flag protocol / meta changes as `status: draft` for human approval.

Do not skip this. A task that ended with zero harness writes is either trivial or a missed capture.

---

## Step 1 — ask the question

At task end, ask:

- Did something surprise me (bug, gotcha, workaround)?
- Did I create or refine a reusable procedure?
- Did I discover or change a durable fact about the system?
- Did I deviate from a protocol, and why?

**Yes to any of these → write it down.** No → still bump `last_reviewed` on any file you relied on so readers know it's still trusted.

---

## Step 2 — pick the file type

Use the decision tree in [`file-taxonomy.md`](file-taxonomy.md). The most common mistakes:

| Mistake | Right answer |
|---|---|
| "I'll just add it to the feature file." | If it is a bug story, it is a **learning**. The feature file just links to it. |
| "This is a one-off script." | If it will be run twice, it is a **playbook** (add the `.sh` sibling). |
| "This is a one-line rule." | If it is a rule we always follow, it is a **protocol** — human sign-off required. |

---

## Step 3 — write or update

### Creating a new file

1. Copy the skeleton from [`file-template.md`](file-template.md).
2. Fill in frontmatter — `type`, `status`, `last_reviewed`, `related`, `tags`.
3. Put `When to read` / `When to update` directly under the title.
4. Write the body. Tables and bullets over prose.
5. Add `See also` and `Referenced by` sections.

### Updating an existing file

1. Bump `last_reviewed` to today's date.
2. Preserve `Referenced by` — don't prune unless the backlink actually went away.
3. If the change is substantive, note it in the PR description (not in the file itself — we don't want changelog cruft in every doc).

### Learnings — append-only

Learnings capture one incident. Once written, edit only to add cross-links. Never rewrite the story.

---

## Step 4 — wire the links

Follow [`linking-protocol.md`](linking-protocol.md). For every new forward link `A → B`:

- Add the link inside the body of `A`.
- Add `A` under `Referenced by` in `B`.
- If `B` is a close sibling, also add it to A's `related:` frontmatter.

Grep before you close the loop:

```bash
rg -n "<your new filename>" .harness/
```

Every reference should be intentional.

---

## Step 5 — bump `last_reviewed`

Always. Readers use this field to trust or distrust a file at a glance. A stale `last_reviewed` (>6 months with no review) is a prompt for the next reader to verify.

---

## Step 6 — protocols and meta need human sign-off

If you are creating or editing anything in `protocols/` or `meta/`:

1. Set `status: draft`.
2. In the PR description, call out the rule change in one line.
3. A human flips it to `status: canonical` on merge.

Do not silently change a protocol. Contract changes are the highest-leverage writes we do — they bind every future task.

---

## Deprecating without deleting

We almost never delete. To retire a file:

1. Write the replacement with `status: canonical` and `supersedes: [old/path.md]`.
2. Edit the old file: `status: deprecated`, add `superseded_by: [new/path.md]`, and put a one-line pointer at the top of the body.
3. Leave `Referenced by` intact — old context can still matter.

---

## Dead-weight review — strip what the model has outgrown

Every harness component exists because a model at the time of writing couldn't handle something on its own. Models improve; those assumptions go stale. A workaround written a year ago can become context-eating dead weight today.

When you write a file, record *why* it is needed. Prefer adding a one-line `motivation:` field to the frontmatter when the reason is non-obvious, e.g.:

```yaml
motivation: "agents kept assuming AWS was us-east-1 — this file corrects once and cheaply"
```

When you revise a file, ask: **is the motivating failure still reproducible?** If not, the file is a candidate for deprecation. Do not delete silently — follow the deprecation routine above so the decision is visible.

The scheduled forum for this is [`../playbooks/harness-gardening.md`](../playbooks/harness-gardening.md) — the weekly sweep that surfaces stale files, stale links, and files whose motivation looks outdated.

---

## Checklist (pin this)

```
[ ] Learned something? Picked the right type?
[ ] Wrote the file from the template? Frontmatter complete?
[ ] Forward links added? Backward links added?
[ ] last_reviewed bumped on anything I relied on?
[ ] Protocol / meta change? Marked draft + flagged in PR?
[ ] rg check: every mention of the new file is intentional?
```

---

## See also

- [`read-protocol.md`](read-protocol.md) — the matching start-of-task routine
- [`file-taxonomy.md`](file-taxonomy.md) — picking the right file type
- [`file-template.md`](file-template.md) — the canonical shape of a file
- [`linking-protocol.md`](linking-protocol.md) — forward + backward link rules

## Referenced by

- `README.md`
- `meta/read-protocol.md`
- `meta/file-taxonomy.md`
- `meta/file-template.md`
- `meta/linking-protocol.md`
