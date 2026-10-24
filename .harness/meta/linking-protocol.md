---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - meta/write-protocol.md
  - meta/file-template.md
tags: [linking, graph, meta]
---

# Linking Protocol

**When to read:** whenever you add, change, or remove a link between harness files.
**When to update:** when the convention itself changes (rare).

## Summary

- Every forward link has a matching backward link.
- Backward links live in a `## Referenced by` section at the bottom of the target file.
- Links use relative paths, not absolute.
- When you break a link (rename, move, delete), you fix every backlink.

---

## Forward links

Inside the body of a file:

```markdown
See [`playbooks/browser-testing.md`](../playbooks/browser-testing.md) for the real-browser harness.
```

Rules:

- Always relative paths from the current file.
- Link text should be the destination filename or a natural phrase — not "click here".
- If you cite a file three times in one section, link it only on first mention.

Also list important destinations in the file's `related:` frontmatter (for discoverability) and in a `## See also` section (for the reader).

---

## Backward links

Every file ends with:

```markdown
## Referenced by

- `path/to/file-that-links-here.md`
- `path/to/another-file.md`
```

When you add a new forward link from A → B, you **must** add `A` to B's `Referenced by` list. This is the graph-integrity step of the write-protocol.

If a file has no incoming links yet, keep the section with the note:

```markdown
## Referenced by

- (none yet)
```

Empty sections are intentional — they signal a reachability gap the next engineer can fix.

---

## When you break a link

| Situation | What to do |
|---|---|
| Renaming a file | Update every `Referenced by` entry that points at the old name. Update every forward link you can find (grep). |
| Moving a file | Same as rename. |
| Deleting a file | Deletion is rare. Prefer `status: deprecated` and add a `superseded_by` frontmatter pointer. The file stays, so its backlinks stay valid. |

A quick grep before commit:

```bash
rg -n "<old-path>" .harness/
```

If it returns anything, the rename isn't finished.

---

## Links to files outside `.harness/`

Linking out is fine and encouraged for feature docs, code, and existing `docs/*.md`. Conventions:

- Use repo-relative paths: `../docs/session-sync-implementation.md`.
- Outside files are **not** expected to carry a `Referenced by` section. The harness does not own them.
- If you link to source code, link to a stable anchor — a file path, not a line number (line numbers drift).

---

## What not to link

- Do not link to secrets files (`.env.local`, `samconfig.test.toml`, `*.pem`). Link to the reference that describes them instead.
- Do not link to an external URL where the equivalent content lives in-repo. In-repo wins.
- Do not link to a file you just deprecated without marking the backlink as historical.

---

## See also

- [`write-protocol.md`](write-protocol.md) — the procedure that enforces linking
- [`file-template.md`](file-template.md) — where the `Referenced by` section lives

## Referenced by

- `meta/file-template.md`
- `meta/write-protocol.md`
