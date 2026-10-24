---
type: playbook
status: canonical
last_reviewed: 2026-04-23
related:
  - playbooks/harness-gardening.sh
  - references/harness-model.md
  - references/feedback-controls.md
  - meta/write-protocol.md
  - meta/linking-protocol.md
tags: [playbook, maintenance, gardening, harness-health]
---

# Harness Gardening — Keep the Knowledge Base Honest

**When to read:** when you're doing a scheduled harness sweep (weekly is fine for now), or when `last_reviewed` on something you rely on has gone stale.
**When to update:** when the linter rules change, or the gardening cadence changes.

## Summary

- The `.harness/` folder needs the same discipline it demands of the code. Frontmatter breaks. Links rot. `last_reviewed` dates drift.
- `harness-gardening.sh` runs `tools/harness-lint.py` and reports what's slipping.
- **Nothing auto-fixes today.** You read the report and decide.
- Budget 15–30 minutes for a weekly pass.

Why it exists: borrowed from OpenAI's "doc-gardening" pattern (recurring Codex task that scans for stale/obsolete docs). We run it manually for now; automate only when the manual cadence breaks down.

---

## Running it

```bash
bash .harness/playbooks/harness-gardening.sh
```

The script runs `python3 .harness/tools/harness-lint.py` and prints a report. It exits 0 if only warnings, non-zero only on hard errors (e.g. unparseable frontmatter).

Flags:

- `--strict` — treat staleness and oversized-without-justification as errors.
- `--json` — machine-readable output (for future automation).

---

## What the linter checks

| Check | Kind | Severity |
|---|---|---|
| Every `.md` in `.harness/` has frontmatter | hard | error |
| Frontmatter has required fields: `type`, `status`, `last_reviewed`, `related`, `tags` | hard | error |
| `type` is one of the 5 canonical values (`protocol`, `playbook`, `reference`, `learning`, `harness`) | hard | error |
| `status` is `canonical` / `draft` / `deprecated` | hard | error |
| `last_reviewed` parses as a date | hard | error |
| Every relative link in the body resolves to an existing file | soft | warn |
| `last_reviewed` is within 6 months (configurable) | soft | warn |
| Files exceeding the type's soft size cap carry `oversized_justification` | soft | warn |
| Every file in `related:` actually exists | soft | warn |

Soft warnings are noise, not failures. You choose what to act on.

---

## The weekly pass (recommended routine)

1. Run `harness-gardening.sh`.
2. For each **hard error**: fix it in the same session. No merging anything else until the harness is valid.
3. For each **staleness warning**: scan the file. If it's still accurate, bump `last_reviewed` to today. If it's wrong, fix it or mark `status: deprecated`.
4. For each **broken link**: either fix the path or delete the dangling reference. Do not leave a half-link.
5. For each **oversized file**: either split (preferred — see [`../meta/file-template.md`](../meta/file-template.md) §"Size guidance") or add an `oversized_justification` to the frontmatter in one sentence.
6. Commit the pass as a single PR titled `harness-gardening: YYYY-MM-DD`.

If nothing to fix, don't open a PR. Silence is a pass.

---

## Dead-weight review

Every quarter, pick a few `protocols/` and `playbooks/` and ask: **is this still solving a real problem, or is the model it was built for gone?**

Anthropic's core lesson: harness components encode assumptions about what the model couldn't do at the time of writing. Models improve. Assumptions go stale. A workaround becomes dead weight.

Concretely:

- Look for files whose `motivation` frontmatter (if present) references a model generation.
- If the motivating failure no longer reproduces on the current model, propose `status: deprecated` in a PR and let a human sign off.
- Write a one-line note in `learnings/` when you retire a protocol — that's durable memory of why we used to do it this way.

---

## What the linter does *not* do

- It does not check **content correctness**. A protocol can have perfect frontmatter and still be wrong.
- It does not run the rest of the project's tests or lints. That's [`../references/feedback-controls.md`](../references/feedback-controls.md).
- It does not open auto-fix PRs. By design — we want a human to read each report until the volume demands automation.

---

## Seeing the full sensor picture

This playbook enforces the knowledge base on itself. For the full list of sensors we run against the *product* code, see [`../references/feedback-controls.md`](../references/feedback-controls.md).

## See also

- [`harness-gardening.sh`](harness-gardening.sh) — the runner
- [`../references/harness-model.md`](../references/harness-model.md) — why we separate guides from sensors
- [`../meta/file-template.md`](../meta/file-template.md) — required frontmatter and optional fields
- [`../meta/write-protocol.md`](../meta/write-protocol.md) — the routine that *should* keep things fresh; this playbook catches when it didn't

## Referenced by

- `README.md`
- `references/harness-model.md`
- `references/feedback-controls.md`
