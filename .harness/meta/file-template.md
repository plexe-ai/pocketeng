---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - meta/file-taxonomy.md
  - meta/linking-protocol.md
  - meta/write-protocol.md
tags: [template, meta]
---

# File Template

**When to read:** before creating any new file in `.harness/`.
**When to update:** when the canonical shape of a harness file changes.

## Summary

Every new file in `.harness/` follows the shape below. Copy the template verbatim, fill it in, trim sections you don't need.

---

## The template

```markdown
---
type: protocol | playbook | reference | learning | harness
status: canonical | draft | deprecated
last_reviewed: YYYY-MM-DD
related:
  - path/relative/to/harness/root.md
tags: [searchable, tokens]
---

# Title

**When to read:** one sentence.
**When to update:** one sentence.

## Summary

3–5 bullets covering the key points. An agent skimming should get the gist here.

## (Body sections)

Use clear h2 / h3 sections. Prefer tables for facts, bullets for lists, prose only when structure cannot carry the meaning. Code blocks with language tags.

## See also

- `path/to/related.md` — one-line reason this is relevant
- `path/to/another.md` — one-line reason

## Referenced by

- `path/to/incoming.md`
- (list is maintained by the write-protocol whenever a link is added)
```

---

## Frontmatter fields

| Field | Required | Values |
|---|---|---|
| `type` | yes | one of the 5 file types — see [`file-taxonomy.md`](file-taxonomy.md) |
| `status` | yes | `canonical` (in force), `draft` (agent-proposed, awaiting human), `deprecated` (superseded — keep file, add pointer) |
| `last_reviewed` | yes | ISO date of the most recent substantive review |
| `related` | yes | list of relative paths to closely-linked files (may be empty `[]`) |
| `tags` | yes | searchable tokens, kebab-case |

Optional:

| Field | When to use |
|---|---|
| `motivation` | one sentence stating *why* this file exists — what the model / team couldn't do without it. Lets future readers decide whether it has become dead weight (see [`write-protocol.md`](write-protocol.md) §"Dead-weight review"). |
| `oversized_justification` | when the file exceeds the size guidance in its taxonomy — explain in one sentence why splitting would hurt comprehension |
| `supersedes` | when `status: canonical` and this file replaces a deprecated one — list its path |
| `superseded_by` | when `status: deprecated` — list the path of the replacement |

---

## Size guidance (not hard limits)

See [`file-taxonomy.md`](file-taxonomy.md) for the per-type targets. When a concept genuinely requires more depth, **split into a parent-index + sub-pages** rather than bloating one file. If splitting hurts comprehension, keep it whole and note `oversized_justification` in frontmatter.

---

## Style rules

- Tables and bullets over prose.
- Short paragraphs — 1–3 sentences.
- Link to other harness files using relative paths (e.g. `../protocols/testing-protocol.md`).
- Code blocks carry language tags (`bash`, `python`, `yaml`, etc.).
- Do not repeat content that lives in another harness file — link to it.

---

## See also

- [`file-taxonomy.md`](file-taxonomy.md) — the 5 file types and when to use each
- [`linking-protocol.md`](linking-protocol.md) — how to wire forward + backward links
- [`write-protocol.md`](write-protocol.md) — the procedure that uses this template

## Referenced by

- `meta/write-protocol.md`
- `meta/file-taxonomy.md`
