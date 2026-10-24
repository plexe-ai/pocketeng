---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - references/harness-model.md
  - protocols/testing-protocol.md
  - protocols/commit-and-pr-protocol.md
  - playbooks/browser-testing.md
  - playbooks/harness-gardening.md
tags: [reference, sensors, feedback, testing, ci]
---

# Feedback Controls — Our Sensor Inventory

**When to read:** when you're deciding where to add a new check, or when you hit a failure and want to know which sensor *should* have caught it.
**When to update:** when we add, remove, or re-categorise a sensor. Bump `last_reviewed` on every review even without changes.

## Summary

- A **sensor** is any control that observes the system *after* an action and produces a signal the agent (or a human) can act on.
- We separate computational sensors (deterministic, cheap, fast) from inferential ones (LLM-backed, expensive, judgement-dense).
- This file is the canonical map of what we run today and when it fires.
- If a sensor exists but isn't listed here, it's a gap — either list it or delete it.

Vocabulary: see [`harness-model.md`](harness-model.md).

---

## Computational sensors (deterministic)

| Sensor | Where it lives | When it fires | What it catches | Signal on failure |
|---|---|---|---|---|
| `pytest` (backend) | `backend/tests/` via `python3 -m pytest tests -q` | Phase 4 test, pre-push hook, developer at will | Backend logic regressions, session-sync invariants | stderr + non-zero exit |
| TypeScript / Next.js build | `cd web && npm run build` | Phase 4 test, Vercel preview deploy | Type errors, broken imports, SSR breaks | stderr + non-zero exit |
| ESLint / Next lint | `cd web && npm run lint` (when configured) | On demand; Vercel CI | Style + unsafe patterns in web | stderr + exit |
| Pre-push hook | `.claude/hooks/verify-before-pr.sh` | `git push` | Repeated back-pressure before a push reaches origin | Blocks push; prints summary |
| SAM validate / build | `sam build` in `backend/` | `deploy-to-test-stack.sh` preflight | Malformed templates, missing handler files | stderr + exit |
| Link & frontmatter integrity | `.harness/tools/harness-lint.py` (via `harness-gardening.sh`) | Manual weekly gardening pass | Broken relative links in `.harness/`, missing frontmatter, stale `last_reviewed`, oversized files without justification | Stdout report with file paths |
| AWS CLI probes | `references/aws-debugging.md` recipes | On demand during debugging | DynamoDB state drift, CloudWatch errors, CFN stack failures | JSON output — human reads |

### Real-browser validation (a hybrid sensor)

Our Playwright harness is primarily **inferential in use** — a human watches the video and reads the screenshots — but every step is backed by **computational** hooks:

| Layer | Kind | What it produces |
|---|---|---|
| Numbered screenshots | Computational | A series of PNGs tagged to scenario steps |
| Session video | Computational | `video.webm` for the whole session |
| `page.on('response')` + `page.on('console')` + `page.on('pageerror')` | Computational | Runtime browser errors + network traces |
| Human/agent judgement on the artefacts | Inferential | Pass / fail call on the feature |

Details: [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md).

---

## Inferential sensors (LLM / human judgement)

| Sensor | Where | When | What it catches |
|---|---|---|---|
| Agent self-review of diff | Phase 5 of the dev cycle, run by the agent | After build, before asking for human review | Leftover debug prints, commented code, obvious scope creep |
| Human PR review | GitHub | Before merge | Everything computational sensors missed — intent, tone, cross-cutting concerns |
| Browser-harness video + screenshot read | Phase 4 of the dev cycle | After every real-browser run | Visual regressions, UX regressions, "looks wrong" |
| AWS CLI probe interpretation | Ad-hoc | Incident debugging | Does the DB / logs actually say what we think? |

Inferential sensors are expensive. Don't attach them to every commit. Attach them where computational sensors would be false-positive-heavy or can't reason.

### Classifier-based approval (pattern we *don't* run today)

Anthropic's Claude Code auto mode uses a small model (Sonnet 4.6) to gate each tool call — a separate classifier sees only user messages + raw tool calls, decides "allow / block / escalate". We don't wire this in, because our operational flow is human-in-the-loop for destructive actions (`sam deploy`, `aws s3 rm`, DynamoDB batch writes).

It's listed here as an *available pattern* so we know where it would fit if ever needed:

| Hypothetical sensor | Would fit | Trigger | Would catch |
|---|---|---|---|
| Destructive-op classifier | Pre-`aws`/`sam deploy` hook | Before any shell command mutating prod | Overeager deletes, scope-escalated writes, prompt-injection-driven exfil |
| PR-merge classifier | GitHub Action pre-merge | Before `merge` on main | Scope creep, secrets in diff, changes outside ticket scope |

Both are parked. If we adopt either, the design rules Anthropic publishes are the template: reasoning-blind input, two-stage classifier (fast yes/no + CoT on flags), deny-and-continue, escalate on N consecutive denials. See [`../../docs/harness-research.md`](../../docs/harness-research.md) §3.13.

---

## Gaps we know about

Honest list.

- **No behaviour harness.** Functional correctness for subjective quality ("feels polished", "feels fast") is still a humans-only check. Field-wide open problem; see [`harness-model.md`](harness-model.md) §"Three regulation categories".
- **No automated architecture fitness test.** "No Lambda cold-start > 800ms", "No Python file > N lines", etc. are not enforced. Parked in `docs/harness-research.md` §6.5.2.
- **No LLM-as-judge inside CI.** Cost and flake not yet worth the signal.
- **No coverage floor.** pytest runs but we don't gate on coverage percentage.
- **No doc-gardening automation.** `harness-gardening.sh` is manual today. Automate when the manual cadence breaks down.

Not all gaps are worth filling. These are parked; re-evaluate quarterly.

---

## When adding a new sensor

1. Decide its type first — computational or inferential. Put it in the right table above.
2. Make the failure signal **structured** (typed error, file:line pointer, one-line reason). Raw stack traces are bad agent context.
3. Make success **silent**. Verbose success output poisons the agent's context and dilutes the signal when things fail. See `.claude/hooks/verify-before-pr.sh` for the pattern — `exit 0` silent, `exit 2` with error lines.
4. Add the row here. Bump `last_reviewed`.

## See also

- [`harness-model.md`](harness-model.md) — vocabulary and theory
- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) — our primary behaviour-ish sensor
- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md) — rules about where each sensor fits in the cycle
- [`../../docs/harness-research.md`](../../docs/harness-research.md) — why we organise this way

## Referenced by

- `README.md`
- `references/harness-model.md`
- `playbooks/harness-gardening.md`
