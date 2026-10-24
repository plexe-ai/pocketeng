---
type: reference
status: canonical
last_reviewed: 2026-04-23
related:
  - README.md
  - references/feedback-controls.md
  - references/operational-threat-model.md
  - protocols/development-cycle.md
  - meta/file-taxonomy.md
tags: [reference, harness, vocabulary, theory]
---

# Harness Model — Vocabulary and Concepts

**When to read:** when you want to understand *why* our `.harness/` is shaped the way it is, or when a PR/review uses field-of-practice terms (guides, sensors, back-pressure, context firewall) and you want to know what's being said.
**When to update:** when we intentionally adopt or reject a concept from the wider field.

## Summary

- Our `.harness/` folder is an **outer harness** — scaffolding we build for our codebase — *plus* a team operating manual.
- It is *not* an agent runtime. The agent (Cursor, Claude Code, Codex) brings its own inner harness; we configure it from outside.
- The conceptual spine we use is Martin Fowler's: **guides** (steer before) and **sensors** (observe after), each either **computational** (deterministic) or **inferential** (LLM-backed).
- Every harness component encodes an assumption about what the model can't do on its own. Those assumptions go stale. Revisit periodically.

For the full reasoning and literature review, see [`docs/harness-research.md`](../../docs/harness-research.md) at the repo root.

---

## Term map

| Term | Our meaning | Where it came from |
|---|---|---|
| **Agent = Model + Harness** | The agent is the model plus everything around it | LangChain, HumanLayer |
| **Inner harness** | The agent runtime: Claude Code / Cursor / Codex's own system prompt, tools, sandbox, orchestration | LangChain |
| **Outer harness** | What we build around a codebase to steer agents — our `.harness/`, AGENTS.md, custom lints, CI | Martin Fowler |
| **Workflow vs agent** | Predefined orchestration vs model-directed tool use. Both are "agentic"; pick the simpler one that works. | Anthropic *Building Effective Agents* |
| **Guide (feed-forward)** | Steers the agent *before* it acts — protocols, playbooks, skills, AGENTS.md | Fowler |
| **Sensor (feed-back)** | Observes *after* action — tests, linters, type checks, LLM-as-judge, browser harness | Fowler |
| **Computational control** | Deterministic, fast, reliable (lint, pytest, TypeScript) | Fowler |
| **Inferential control** | LLM-backed, rich, non-deterministic (AI code review, LLM judge, classifier-based approval) | Fowler, Anthropic *Auto Mode* |
| **Attention / instruction budget** | Every token costs attention; budget deliberately. Context rot is a real, measurable effect. | Anthropic *Context Engineering*, HumanLayer |
| **Just-in-time context** | Maintain lightweight references (filenames, routing tables); pull detail on demand rather than pre-loading. Our `.harness/` is shaped this way by design. | Anthropic *Context Engineering* |
| **Progressive disclosure** | Don't pre-load everything; let the reader (or agent) pull what it needs | OpenAI, HumanLayer, Anthropic |
| **Context firewall** | Use a sub-agent or task scope to keep intermediate noise out of the parent's context | HumanLayer, Anthropic |
| **Compaction / structured note-taking** | Two strategies for long tasks: summarise on the fly, or write notes to files that get re-read | Anthropic *Context Engineering* |
| **Repo as system of record** | If the agent can't see it in the repo, it doesn't exist | OpenAI |
| **ACI — agent-computer interface** | Tool and file design deserves the same rigour as human-computer interface design. For us: filenames, routing tables, and "When to read" headers are the ACI. | Anthropic *Building Effective Agents* / *Writing Effective Tools* |
| **Poka-yoke** | Remove whole classes of mistakes structurally (e.g. forcing absolute paths, requiring explicit flags, refusing ambiguous input in a script) | Anthropic *Building Effective Agents* |
| **Back-pressure** | Verification mechanisms that push back on low-quality output | HumanLayer |
| **Ralph (Wiggum) loop** | A hook that keeps an agent iterating against a completion goal | ghuntley |
| **Pre-completion checklist / self-verify hook** | The specific Ralph-loop we use — `.claude/hooks/verify-before-pr.sh` forces a check before exit | LangChain *Improving Deep Agents*; us |
| **Reasoning sandwich** | Spend more reasoning on plan + verify, less in the middle. Reflected in our dev cycle emphasis. | LangChain *Improving Deep Agents* |
| **Classifier-based approval** | Separate model judges each action before it executes, isolated from agent's own reasoning. We don't run this yet; tracked as a pattern we might grow into. | Anthropic *Auto Mode* |
| **Reasoning-blind review** | Deliberately strip the actor's prose from the reviewer's inputs so it judges *actions*, not rationales. | Anthropic *Auto Mode* |
| **Deny-and-continue** | Blocks return as structured errors; agent retries a safer path; escalate on repeat. Our hooks already behave this way. | Anthropic *Auto Mode* |
| **Agent threat model (4-cat)** | Overeager / honest mistake / prompt injection / misaligned model. Defence is the same: block the action. Applies to our ops surface. | Anthropic *Auto Mode* |
| **Middleware / hooks / steps** | Three names for the same abstraction: intercept the agent at well-defined points (pre-call, post-call, pre-completion). | LangChain, Anthropic, Inngest |
| **Atomic step** | Each LLM call and tool call is an independently retryable, persisted unit of work. | Inngest |
| **Dead-weight harness component** | A guide or sensor that was added to paper over a model limitation that has since gone away | Anthropic |
| **Harnessability** | How much a codebase *affords* external control (typed lang, clear boundaries, opinionated framework) | Fowler |
| **Behaviour harness** | The hard, unsolved problem: how to verify functional correctness, not just style or types | Fowler |

When you write a new file, use these terms instead of inventing parallels.

---

## ACI for the knowledge base

Anthropic's *Writing Effective Tools* treats tool design as its own discipline — tools are "contracts between a deterministic system and a non-deterministic agent". The same discipline applies to our markdown knowledge base:

- **Semantic filenames**, not generic ones. `playbooks/deploy-to-test-stack.md` > `playbooks/deploy.md`.
- **Routing tables over prose.** The agent finds a file from the README in one hop; it should not have to infer.
- **`When to read` + `When to update` headers** are the file's docstring. Write them like you'd write a docstring for a junior — specific, unambiguous.
- **Poka-yoke the scripts.** `browser-testing.sh` refusing to run against an unknown host is the pattern — remove the foot-gun, don't document it.
- **Return meaningful context, not low-level identifiers.** A learning named `dynamodb-incremental-history-sort-key.md` beats one named `2026-04-01-incident.md`.

This is the principle. The concrete rules live in [`../meta/file-template.md`](../meta/file-template.md) and [`../meta/file-taxonomy.md`](../meta/file-taxonomy.md).

---

## Where each harness file fits

| File type in `.harness/` | Role in the model |
|---|---|
| `protocols/*.md` | Guides (feed-forward). High-leverage, stable, human-signed. |
| `playbooks/*.md` + `*.sh` | Guides + deterministic computational sensors bundled together (preflight + checks + do-the-thing). |
| `references/*.md` | Static knowledge — the "boring but must-be-correct" context the agent pulls in on demand. |
| `features/*.md` | Feature indexes with "Known scars" — route into learnings. |
| `learnings/*.md` | Durable bug scars, one incident each. Our institutional memory. |
| `meta/*.md` | Rules about the harness itself — taxonomy, templates, read / write routines. |
| `tools/*.py` | Computational sensors that check the harness *itself* (frontmatter, links, staleness). |

## Our feedback controls

`.harness/` says a lot about guides. It says less about sensors. The inventory lives in [`feedback-controls.md`](feedback-controls.md).

---

## Three regulation categories (Fowler)

Useful when you're thinking about what a harness control is *for*:

1. **Maintainability** — code quality, lint, duplication, architecture drift. Well-tooled. Most of what our playbooks and pre-push hook cover today.
2. **Architecture fitness** — performance, observability, reliability as first-class constraints. We do some of this ad-hoc; not formalised.
3. **Behaviour** — does the feature actually work for users? Our Playwright harness is the only sensor we have here; it works for what the agent itself can verify by clicking, not for "feels polished" or "feels fast". Open problem in the field.

---

## Principles worth carrying around

1. **Optimise for what the model can't do on its own; question it periodically.** Every scaffold encodes a limitation. Models improve. Revisit and strip.
2. **Keep entry files short.** AGENTS.md / CLAUDE.md is a *table of contents*, not an encyclopedia. Target < 100 lines.
3. **Pair guides with sensors.** Feed-forward only → the agent makes the same mistake. Feed-back only → the agent keeps hitting a wall it could have avoided.
4. **Just-in-time over pre-loading.** Readers (human or agent) should pull files on demand. The routing table is the lightweight reference; the files behind it are the deep content. Don't optimise for "read everything first".
5. **ACI discipline.** Treat every filename, header, and routing-table entry the way you would treat a tool name or docstring. Semantic, unambiguous, poka-yoke'd.
6. **Encode taste mechanically where you can.** Custom lints with remediation in the error message beat prose rules.
7. **Validate every output; retry once with structured feedback; escalate on second failure.** Non-negotiable for anything integration-facing.
8. **Prefer a single-binary CLI to an MCP server when training data covers it** (gh, aws, docker, supabase). Better context economics.
9. **Sub-agents for context control, not role-play.** Spawn them to isolate expensive research, not to pretend to be a "backend engineer".
10. **Reasoning sandwich.** Put more care into planning and review than into the middle. Our dev cycle reflects this; budget your attention the same way.
11. **Find the simplest thing first.** Grow only on observed failure. Most of what we throw away first was added speculatively.

---

## What this model deliberately doesn't cover

- Inner-harness design — we don't ship agent runtimes.
- Sandbox substrate, cloud orchestration, billing — different domain.
- Evaluation-as-a-service benchmarks — we do evals via real-browser tests and DB probes; formal eval-harness work (SWE-bench-style) is out of scope here.

## See also

- [`feedback-controls.md`](feedback-controls.md) — the sensor inventory this model describes
- [`../playbooks/harness-gardening.md`](../playbooks/harness-gardening.md) — how we enforce the model on the knowledge base itself
- [`../protocols/development-cycle.md`](../protocols/development-cycle.md) — the cycle where guides and sensors get used
- [`../../docs/harness-research.md`](../../docs/harness-research.md) — the 16-source literature review this reference distils
- [`operational-threat-model.md`](operational-threat-model.md) — four-category threat model applied to our real-infra surface

## Referenced by

- `README.md`
- `references/feedback-controls.md`
- `playbooks/harness-gardening.md`
- `protocols/development-cycle.md`
