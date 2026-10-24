---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - meta/file-template.md
  - meta/write-protocol.md
tags: [taxonomy, meta]
---

# File Taxonomy

**When to read:** before creating a new file, to pick the right type.
**When to update:** only when introducing a new file type (rare — requires human sign-off).

## Summary

Five types. Each has a different purpose, lifecycle, and update rule. Choosing the wrong type is the most common mistake — it makes files hard to find later.

---

## The 5 types

| Type | What it is | Lifecycle | Size target |
|---|---|---|---|
| **protocol** | A rule we always follow. The musts. | Edits require human sign-off. Rarely changes. | ~200 lines |
| **playbook** | A step-by-step procedure for doing X. | Agents edit in place when reality shifts. Bump `last_reviewed`. | ~250 lines |
| **reference** | Durable facts about the system. | Update when the system changes. | ~300 lines |
| **learning** | A bug story. One incident, one file. | Append-only. Never edit the story. | ~150 lines |
| **harness** | A reusable env/tool setup. | Update when the tooling changes. | ~200 lines |

Size is guidance, not a hard limit. If splitting hurts comprehension, keep the file whole and record `oversized_justification` in the frontmatter. See [`file-template.md`](file-template.md).

---

## Decision tree — "what type is my new file?"

```
Is it a rule we always follow?
├── yes → protocol
└── no
    ├── Is it a step-by-step procedure?
    │   ├── yes → playbook (add a .sh sibling if it is scriptable)
    │   └── no
    │       ├── Is it a story about something that broke?
    │       │   ├── yes → learning
    │       │   └── no
    │       │       ├── Is it env/tool setup that multiple playbooks share?
    │       │       │   ├── yes → harness
    │       │       │   └── no → reference
```

If you land on **protocol**, pause. Protocol additions require human sign-off. Write the file with `status: draft` and flag it in your PR. The write-protocol covers this.

---

## Where each type lives

| Type | Folder |
|---|---|
| protocol | `protocols/` |
| playbook | `playbooks/` (scripts live alongside: `<name>.sh`) |
| reference | `references/` |
| learning | `learnings/` (filename pattern: `YYYY-MM-<slug>.md`) |
| harness | `playbooks/` (harnesses are reusable playbooks — same folder) |
| feature index | `features/` (a thin file that routes into `docs/` + related harness files) |
| meta (rules about the base) | `meta/` |

---

## Update authority

| Type | Who may edit | PR review scope |
|---|---|---|
| protocol | human-approved | treat as contract change |
| playbook | agent or human | normal review |
| reference | agent or human | normal review |
| learning | append-only by agent or human | normal review |
| harness | agent or human | normal review |
| meta | human-approved | treat as contract change |

Agents may always *propose* changes to protocols / meta by creating a file (or editing existing) with `status: draft`. Humans flip to `canonical`.

---

## See also

- [`file-template.md`](file-template.md) — the canonical shape of a file
- [`write-protocol.md`](write-protocol.md) — how to add / edit / deprecate files
- [`linking-protocol.md`](linking-protocol.md) — how files connect to each other

## Referenced by

- `README.md`
- `meta/write-protocol.md`
- `meta/file-template.md`
