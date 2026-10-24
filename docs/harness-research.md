# PocketEng Harness — Literature Review & Self-Assessment

**Status:** draft v2 — for internal circulation (v1 had three hand-waves; v2 reads everything)
**Author:** PocketEng team, assisted by research across frontier-lab and practitioner writing
**Audience:** PocketEng engineers, plus anyone building a repo-level knowledge base or outer harness for coding agents
**Last updated:** 2026-04-23

---

## 1. Why this paper exists

We built `.harness/` — a structured knowledge base that sits at the top of our repo and routes both human engineers and coding agents (Claude Code, Cursor, Codex) through our protocols, playbooks, references, and bug scars. Before we finalize its shape, we wanted to stress-test it against what the rest of the field is doing.

This paper does three things:

1. **Reads the current state of the practice.** We summarise sixteen pieces of writing from Anthropic (seven), OpenAI, LangChain (three), Martin Fowler, HumanLayer, MindStudio (covering Stripe, Shopify, Airbnb), and Inngest, plus the community-curated `awesome-agent-harness` index.
2. **Finds the common vocabulary, abstractions, and patterns.** Where the field agrees, where it disagrees, and where it's still figuring things out.
3. **Self-assesses.** What PocketEng's `.harness/` already does well, where it borrows, where it deviates, and what we should change.

Every claim in §3 (literature review) is attributed. Every change proposed in §6 is tagged with where the idea came from. This is deliberate: we want future readers to know which ideas are ours, which were borrowed, and why.

Format is plain markdown. No formal citation style. Focus is on content.

---

## 2. The terminology trap — "harness" means two things

Before anything else, a term collision must be named. In the literature there are **two distinct things** being called "harness":

**2.1 Agent harness (inner harness).** Everything that wraps a raw language model to turn it into a usable agent — system prompt, tool interfaces, filesystem, sandbox, browser, subagent orchestration, hooks, context compaction. LangChain's working definition is `Agent = Model + Harness`. This is the sense used by Anthropic's Managed Agents post, the LangChain "Anatomy" post, and HumanLayer's "Skill Issue".

**2.2 Outer harness (user-built harness for the codebase).** The guides, sensors, and scaffolding *a team builds around their own codebase* to steer whatever agent they use. This is what Fowler is describing: agent-file contents, custom linters with remediation instructions, structural tests, skills, progressive-disclosure documentation, pre-commit hooks. OpenAI's "Harness Engineering" post describes the same layer from the inside — their `docs/`, `AGENTS.md`, custom linters, and "golden principles".

**Our `.harness/` folder is an outer harness, plus a team operating manual.** It is not a runtime. It doesn't execute agents. It structures knowledge so that any agent (and any human) can be dropped into the repo and work competently. This matters for the rest of the paper: much of the inner-harness literature applies to us by analogy rather than directly.

When this document says "harness" unqualified, it means the outer kind. When it means the inner kind, it says "inner harness" or "agent runtime".

---

## 3. Literature review

Ten sources. For each: what it is, the ideas worth keeping, and a one-line take on relevance to PocketEng.

### 3.1 Anthropic — "Scaling Managed Agents: Decoupling the brain from the hands" (2026)

URL: <https://www.anthropic.com/engineering/managed-agents>

An inner-harness piece. Anthropic describes why they decoupled three concerns in their Claude Managed Agents product:

- **Session** — the append-only log of events. Durable. Lives outside both brain and hands.
- **Brain** — the model + harness loop.
- **Hands** — sandboxes and tools, reached by `execute(name, input) → string`.

They frame this as a *meta-harness*: opinionated about the interfaces, not about any particular implementation behind them. Rationale: harnesses "encode assumptions that go stale as models improve"; stable interfaces let the implementations swap freely. They cite a real example — a Claude-Sonnet-4.5 "context anxiety" workaround that became dead weight on Opus-4.5.

Three abstractions worth stealing:

- **Session as a context object outside the context window.** `getEvents()` lets the brain interrogate positional slices of the event stream. The harness can reshape retrieved events before they enter the model's context.
- **Containers as cattle, not pets.** If a sandbox dies, it's a tool-call error; the brain retries.
- **Credentials never reachable from the sandbox.** Tokens sit in a vault; a proxy injects them into outbound calls so prompt injection can't exfiltrate them.

**Relevance:** direct adoption is out of scope (we are not running an agent cloud), but the *principle* — "every scaffold encodes an assumption about what the model can't do; revisit it as models improve" — is the single most important piece of advice for building any long-lived harness, inner or outer.

### 3.2 Anthropic — "Harness design for long-running application development" (2026)

URL: <https://www.anthropic.com/engineering/harness-design-long-running-apps>

An inner-harness piece, but with outer-harness lessons. Prithvi Rajasekaran describes building a **three-agent system (planner, generator, evaluator)** that produces full-stack applications autonomously over multi-hour runs. Key ideas:

- **GAN-inspired separation of creator and critic.** "Tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work."
- **Grading criteria make subjective tasks gradable.** For frontend design: *design quality, originality, craft, functionality*, each with explicit wording.
- **Sprint contracts.** Before each sprint, generator and evaluator negotiate "what 'done' looks like" in writing. Bridges the gap between loose spec and testable implementation.
- **File-based inter-agent communication.** One agent writes a file; another reads it and responds. No special RPC.
- **Playwright MCP for the evaluator.** The critic drives the live application, takes screenshots, files bugs — not just grading static output.
- **Stress-test the harness as models improve.** Sonnet-4.5 needed context resets; Opus-4.5 didn't. The author methodically removed harness components one at a time to find what was still load-bearing.

**Relevance:** we have one strong borrow here — the **planner → generator → evaluator** structure maps cleanly onto our dev cycle (plan → build → test → review). Our browser testing harness already matches the evaluator pattern (Playwright driving real UI, producing screenshot+video evidence). We should make this analogy explicit in our `.harness/protocols/development-cycle.md`.

### 3.3 Martin Fowler — "Harness engineering for coding agent users" (2026)

URL: <https://martinfowler.com/articles/harness-engineering.html>

The definitive outer-harness piece for our purposes. Fowler explicitly carves out "the harness the user builds for their own codebase" as the interesting layer, and offers a mental model that the whole field is already quietly converging on:

- **Feed-forward controls (guides).** Steer the agent *before* it acts. Examples: AGENTS.md, skills, code-mod recipes.
- **Feed-back controls (sensors).** Observe *after* action; help the agent self-correct. Examples: linters, type checkers, structural tests, LLM-as-judge.
- **Computational vs inferential.** Guides and sensors can be either deterministic (fast, cheap, reliable) or LLM-backed (rich, expensive, non-deterministic). A healthy harness uses both.

Fowler further distinguishes **three regulation categories**:

1. **Maintainability harness** — internal code quality (duplication, complexity, style, architecture drift). Well-supported by existing tooling.
2. **Architecture fitness harness** — performance, observability, reliability as first-class constraints. Like architectural fitness functions.
3. **Behaviour harness** — does the app functionally do what was asked? Hardest of the three, and the one nobody has solved well yet.

Other sharp framings:

- **Harnessability is a property of the codebase.** Strongly typed languages, clear module boundaries, and opinionated frameworks *afford* more harnessing. Legacy debt is the hardest place to harness, which is exactly where you'd want it most.
- **Keep quality left.** Distribute feed-forward and feed-back controls across the lifecycle by cost — fast things pre-commit, expensive things post-integration.
- **The steering loop is the harness work.** When an agent makes a mistake twice, the fix is to improve a guide or sensor, not the agent.

**Relevance:** this paper gives us the shared vocabulary we were missing. "Guides vs sensors", "computational vs inferential", "regulation categories" are terms our `.harness/` should adopt. We currently enumerate guides (protocols, playbooks) explicitly but have no central inventory of our sensors (pre-push hook, backend pytest, web `npm run build`, browser harness). §6 proposes fixing this.

### 3.4 HumanLayer — "Skill Issue: Harness Engineering for Coding Agents" (2026)

URL: <https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents>

Practitioner-dense. HumanLayer has shipped a lot of agent-built code in a brownfield enterprise repo, and this post reads like a post-mortem of every mistake they made on the way. Core positions:

- **"It's not a model problem. It's a configuration problem."** Almost every time the agent fails, the fix is in the harness, not the prompt.
- **"Harness engineering is a subset of context engineering."** Every harness choice is ultimately about what ends up in the model's context window.
- **Configuration surface: CLAUDE.md/AGENTS.md + MCP + skills + sub-agents + hooks + back-pressure.** Six concrete levers.
- **The "instruction budget".** Every tool description, every skill preamble, every system-prompt line is an instruction the agent has to pay for in context. Budget them.
- **Sub-agents as a *context firewall*, not role-players.** "Frontend engineer sub-agent / backend engineer sub-agent" doesn't work. What works is using sub-agents to encapsulate expensive research so the intermediate tool-call noise doesn't end up in the parent context. Sub-agents return condensed results + pointers.
- **Too many MCP tools is worse than none.** If a CLI exists in training data (gh, docker, kubectl), prefer the CLI — fewer tokens spent on tool descriptions, composable with grep/jq.
- **Hooks for deterministic control flow.** On stop, run type-check; swallow on success, surface errors on failure with `exit 2` to re-engage the agent.
- **Back-pressure.** Verification mechanisms that force the agent to keep working until a quality bar is met.
- **ETH Zurich study caveat.** A study of 138 agent-files found most agentfiles were useless or harmful. HumanLayer's read: the *bad* agentfiles were auto-generated, too long, too prescriptive, full of irrelevant context. Good ones are short, universally-applicable, written by a human who's been burned.

Strong negative advice: they threw away *more* hooks than they kept. "Optimize for iteration speed, not likelihood of 1-shotting on the first attempt."

**Relevance:** this is the paper that most directly applies to us. Our `.harness/` has already internalised most of their positive advice (short CLAUDE.md, progressive disclosure, sub-agent-as-context-firewall via our `Task` tool patterns, hooks via `.claude/hooks/verify-before-pr.sh`). Two things we haven't done:

- We don't name our "instruction budget" explicitly.
- We don't have a written position on MCP tools vs CLI wrappers (we currently use both, somewhat ad-hoc).

### 3.5 OpenAI — "Harness engineering: leveraging Codex in an agent-first world" (2026)

URL: <https://openai.com/index/harness-engineering/>

The most ambitious outer-harness field report we've read. A 3-7 person team shipped ~1M lines across ~1500 PRs over 5 months, with **zero manually-written lines of code**. Every line — application, tests, CI, docs, dashboards — was written by Codex. Humans steer, agents execute.

Ideas worth capturing:

- **"Humans steer, agents execute" as an operating model.** Not a slogan; a constraint the team chose to force themselves to build the right scaffolding.
- **Repository-local knowledge is the system of record.** If Slack-thread decisions or Google Doc architecture docs exist, they're invisible to the agent. "AGENTS.md is the table of contents, not the encyclopedia." Deeper content lives in a structured `docs/` (design-docs, exec-plans, references, architecture, product-specs) that the agent is taught how to navigate.
- **Mechanical enforcement of harness invariants.** Custom linters. Structural tests. CI jobs that verify the knowledge base is up-to-date, cross-linked, and structured correctly. *A recurring "doc-gardening" agent scans for stale or obsolete documentation and opens fix-up PRs.*
- **Agent legibility as the design target.** Repos are optimised first for the agent's ability to reason from the repo alone. "Boring" technologies tend to score well here — stable APIs, good training-data coverage. Sometimes it's cheaper to re-implement a tiny subset of a utility than to ship an opaque dependency.
- **Enforce invariants, don't micromanage implementations.** Layered architecture (Types → Config → Repo → Service → Runtime → UI) with mechanically-checked dependency directions. Golden principles enforced by custom lints with remediation messages inline in the failure.
- **Entropy and garbage collection.** Agents replicate local patterns, including bad ones. Solution: background Codex tasks that scan for drift, update quality grades, and open targeted refactoring PRs. Most reviewable in under a minute and auto-mergeable.
- **Throughput changes the merge philosophy.** Short-lived PRs, minimal blocking gates, test flakes addressed by re-running rather than blocking. Irresponsible at low throughput; correct at high throughput.
- **Legibility of runtime signal.** App is bootable per git worktree; Chrome DevTools Protocol wired into the agent; skills for DOM snapshots, screenshots, navigation; logs and metrics exposed via LogQL and PromQL. "Ensure service startup completes in under 800ms" becomes a tractable prompt.
- **"Our most difficult challenges now center on designing environments, feedback loops, and control systems."**

**Relevance:** this is the paper our `.harness/` is in closest structural sympathy with. Our `.harness/{protocols,playbooks,references,features,learnings,meta}` layout is essentially OpenAI's `docs/{design-docs,exec-plans,references,...}` pattern applied to our domain. But we lack two things they highlight: **mechanical enforcement of the knowledge base itself** (a linter that checks frontmatter, link integrity, staleness) and **periodic garbage collection** (active sweep for drift). §6 proposes both.

### 3.6 LangChain — "The Anatomy of an Agent Harness" (2026)

URL: <https://www.langchain.com/blog/the-anatomy-of-an-agent-harness>

Vivek Trivedy's post. Inner-harness, clearest conceptual decomposition we've seen. `Agent = Model + Harness`; the harness is derived by working backward from *what we want agents to do that the model can't do on its own*. Each capability → a harness primitive:

- Durable state across sessions → **filesystem** (also the natural collaboration surface between agents and humans)
- Autonomous problem-solving without pre-built tools → **bash + code execution**
- Safe running of agent-generated code → **sandbox + preinstalled tooling**
- Knowledge beyond training cutoff → **web search, MCP docs tools, memory files (`AGENTS.md`)**
- Avoiding performance degradation as context grows → **compaction, tool-call offloading, skills with progressive disclosure**
- Completing long tasks that span multiple context windows → **filesystem + git + ralph loops + planning + self-verification**

Companion insight: **harness-model co-evolution**. Frontier models are post-trained in specific harnesses, so swapping harnesses can change their measured ability dramatically. Example cited: Opus 4.6 scoring #33 on Terminal Bench in Claude Code but #5 in a different harness. Implication: "the best harness for a model isn't necessarily the one it was trained on".

**Relevance:** LangChain's derivation is the cleanest teaching explanation. The "work backward from what the model can't do" framing is a useful way to justify why any given harness component exists. Our `.harness/` implicitly does this but doesn't say so. A short *Why this exists* header on each file (which our template already supports via `## Summary`) is adjacent to this idea.

### 3.7 MindStudio — "What Is an AI Coding Agent Harness? How Stripe, Shopify, and Airbnb Build Reliable AI Workflows" (2026)

URL: <https://www.mindstudio.ai/blog/ai-coding-agent-harness-stripe-shopify-airbnb>

Vendor post, but the core observations about Stripe / Shopify / Airbnb are useful. Themes that repeat:

- **Narrow scope, composable agents.** Not one big agent. Specific, bounded ones (generate tests for module X, suggest type improvements, flag breaking changes) composed by an orchestrator.
- **Validation loops with structured error feedback.** Every output gets parsed / compiled / tested / schema-validated. Failures are re-fed to the model with structured error context, not raw stack traces. Retry once; on second failure, escalate to human.
- **Documentation as contract (Stripe).** Authoritative API spec injected as context before any code touching that surface is generated. Reduces hallucination.
- **Validation-first generation (Stripe).** Define what "done" looks like before generation starts.
- **Evaluation as first-class product-QA (Shopify).** Automated eval pipelines score AI output against ground truth; regression tests run on prompt changes.
- **Airbnb's JS→TS migration pipeline.** Classification → context extraction → transformation → validation (TypeScript compiler + tests) → human-review queue for failures. A canonical example of treating a codebase transformation as a batch, not an interactive session.
- **Human-in-the-loop at *defined* thresholds.** Not everywhere, not nowhere. Tripwires: confidence scores, validation-failure counts, scope boundaries.

**Relevance:** MindStudio's post reinforces what Fowler and HumanLayer are saying with concrete industrial examples, but we already have these instincts. The Airbnb pipeline is the structural template for any repo-wide transformation we do in the future (e.g. if we ever migrate parts of our Python backend to typed Python).

### 3.8 Anthropic — "Building Effective AI Agents" (Dec 2024)

URL: <https://www.anthropic.com/engineering/building-effective-agents>

The foundational piece. Establishes a clean distinction that every subsequent paper leans on:

- **Workflows** — LLMs and tools orchestrated through predefined code paths. Predictable, consistent, cheaper.
- **Agents** — LLMs that dynamically direct their own processes and tool use.

Both are "agentic systems". The choice is not ideological. "Find the simplest solution possible, and only increase complexity when needed."

Five workflow patterns that keep showing up in production:

1. **Prompt chaining** — decompose into sequenced LLM calls with programmatic gates between them.
2. **Routing** — classify input and dispatch to a specialised downstream prompt/tool.
3. **Parallelization** — sectioning (split into independent subtasks) or voting (run same task N times, aggregate).
4. **Orchestrator-workers** — a lead LLM decomposes at runtime and delegates to workers. Unlike parallelization, the subtasks aren't pre-defined.
5. **Evaluator-optimizer** — one LLM generates, another critiques, loop until the critic is satisfied. The direct ancestor of Anthropic's three-agent long-running paper.

Three operating principles for agents:

1. **Maintain simplicity.**
2. **Prioritise transparency** — expose the agent's planning steps.
3. **Carefully craft the agent-computer interface (ACI)** — treat tool docs like prompts. Appendix 2 is a self-contained essay on tool design: put yourself in the model's shoes, write tool docs like docstrings for a junior, **poka-yoke** your tools so mistakes become structurally impossible (example cited: forcing absolute file paths instead of relative, after observing the agent mis-use relative paths after `cd`-ing).

**Relevance:** directly useful. Our dev cycle already maps to "evaluator-optimizer" (Build → Test is generate-and-critique). Our browser harness is the evaluator. The ACI idea extends to us as an *agent-documentation interface*: every `.harness/` file is ACI by another name, and the same rules apply — unambiguous naming, clear inputs/outputs, examples, make mistakes hard. Worth naming this in the harness model.

### 3.9 Anthropic — "Effective harnesses for long-running agents" (Nov 2025)

URL: <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>

The practical how-to for multi-context-window work. Observation: out-of-the-box Claude Agent SDK + Opus 4.5 on a loop can't one-shot a claude.ai clone. Compaction alone is not enough. Two recurring failures:

1. The agent tries to do too much at once, blows its context mid-feature, leaves the next session to guess at what happened.
2. A later agent looks around, sees progress, declares victory prematurely.

Their answer is a **two-agent pattern** (same tools, same system prompt — "agents" here means distinct initial prompts):

- **Initializer agent** — runs once. Writes `init.sh` (how to start the dev server), `claude-progress.txt` (running log of what's been done), and a **feature list as strict JSON** — 200+ entries like `{"description": "user can open a new chat", "passes": false, "steps": [...]}`. Chosen JSON over Markdown because the model is less likely to inappropriately overwrite a structured file.
- **Coding agent** — runs every subsequent session. Prompted to pick one feature, ship it end-to-end, commit with descriptive message, update the progress file. Critically: only allowed to flip `passes: false → true`, never delete or rewrite the spec.

Every session opens with a fixed routine:

1. `pwd` (know your cwd).
2. Read `claude-progress.txt` + last 20 git log entries.
3. Read `feature_list.json`, pick highest-priority failing item.
4. Run `init.sh`.
5. Run a basic end-to-end smoke test *before* starting new work — catches silent breakage left by the previous session.

Browser automation (Puppeteer MCP here) is non-optional. "Claude mostly did well at verifying features end-to-end once explicitly prompted to use browser automation tools and do all testing as a human user would." Without this, Claude tests with `curl` or unit tests and misses whole classes of bugs.

Open problems they flag: specialized agents (testing agent, cleanup agent) vs one general-purpose agent; generalising beyond full-stack web.

**Relevance:** the initializer/coding split is inner-harness, not ours — we're not shipping a long-running runtime. But the *pattern* has a near-perfect mapping to our `.harness/`:

- `init.sh` ↔ our `playbooks/*.sh` (deterministic setup scripts).
- `claude-progress.txt` ↔ our `learnings/` + git log + feature files (progress as distributed structured knowledge rather than a single file).
- `feature_list.json` with `passes: false` ↔ our `features/<feature>.md` with "Known scars" pointing into learnings.
- Fixed session-opening routine ↔ our `meta/read-protocol.md`.
- "Run smoke test before starting new work" ↔ our Phase 4 of the dev cycle, currently *after* build. Maybe we should also run a *baseline* smoke test in Phase 1 (Read), not just in Phase 4.

That last one is actually a real gap in our dev cycle. Captured in §5.5.

### 3.10 Picrew — `awesome-agent-harness` (curated index, 2026)

URL: <https://github.com/Picrew/awesome-agent-harness>

159 entries across 9 categories. For our purposes, the taxonomy itself is the useful artefact:

1. Harness Architecture & Orchestration
2. Context & Working-State Engineering
3. Execution Substrates & Sandboxing
4. Protocols, Tool Interfaces & Agent Contracts
5. Evaluation Harnesses & Benchmarks
6. Observability & Reliability Operations
7. Guardrails, Security & Governance
8. Reference Harness Implementations
9. Essential Readings & Ecosystem Maps

Our `.harness/` maps onto (4) — protocols and contracts — and a thin slice of (2) — context engineering via our learnings and feature files. We are *not* doing (1), (3), (5), (6), (7), (8), and we shouldn't try to. The index is useful for knowing where PocketEng's outer harness *isn't* trying to compete.

Named projects worth tracking from the list:

- **`AGENTS.md` (github.com/agentsmd/agents.md)** — an emerging standard for repo-level agent instructions. Worth ensuring our CLAUDE.md / AGENTS.md pairing is compatible.
- **`everything-claude-code`** — a large open collection of Claude Code practices, if we want to cross-reference.
- **`context-space` / `Trellis` / `claude-mem`** — context / memory tooling, if we ever need session-memory beyond our learnings folder.

### 3.11 Anthropic — "Writing effective tools for AI agents — with agents" (Sep 2025)

URL: <https://www.anthropic.com/engineering/writing-tools-for-agents>

The canonical treatment of tool design. Core reframe: a tool is "a contract between a deterministic system and a non-deterministic agent" — a new kind of software, not the same as an API or a function. Design it for the agent, not for another developer.

The methodology is empirical:

1. **Prototype** the tool in a local MCP server. Test it yourself.
2. **Run an eval** with 20–50 tasks grounded in real-world use. Strong tasks require chained tool calls; weak tasks are one-shot lookups. Pair each task with a verifier (exact match or LLM judge).
3. **Run the eval programmatically** — simple while-loop agent, single task per run, collect accuracy + latency + token count + tool errors.
4. **Let Claude Code analyse its own transcripts** and propose tool refactors. "Most of the advice in this post came from repeatedly optimising our internal tool implementations with Claude Code."
5. Use a **held-out test set** so improvements are real, not over-fit.

Design principles that came out of it:

- **Choose the right tools.** Agents have limited context; memory is cheap for traditional programs, expensive for agents. A `list_contacts` tool forces the agent to brute-force read; a `search_contacts` tool respects the attention budget. Prefer consolidated tools (`get_customer_context` over `get_customer_by_id` + `list_transactions` + `list_notes`).
- **Namespace your tools** — `asana_search`, `jira_search`. Prefix or suffix matters and shifts eval scores non-trivially.
- **Return meaningful context, not low-level identifiers.** Prefer `name` over `uuid`. Resolve UUIDs to semantic labels where possible. An optional `response_format: "concise" | "detailed"` enum lets the agent ask for more when needed — most of the time "concise" is enough.
- **Token efficiency is a first-class design constraint.** Pagination, filtering, truncation, with sensible defaults (Claude Code caps tool output at 25k tokens by default). Truncated responses should steer the agent toward a better strategy ("try narrowing the search"). Error responses should be actionable, not raw tracebacks.
- **Prompt-engineer tool descriptions** like docstrings for a junior engineer. `user_id`, not `user`. State formats, edge cases, boundaries between tools. Small description edits can change eval scores dramatically.

**Relevance:** we don't build agent-facing tools, but we build agent-facing *files*, which is the same design discipline. Every `.harness/` filename is a "tool name"; every `When to read` header is a tool description; every routing table entry is a namespacing decision. The **evaluation-driven tool-improvement loop** is something we don't do for our harness files and arguably should — analogous to the harness-gardening pass, but looking at real agent sessions instead of link integrity.

### 3.12 Anthropic — "Effective context engineering for AI agents" (Sep 2025)

URL: <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>

The theory paper behind HumanLayer's "instruction budget" and Anthropic's own sub-agent and compaction patterns. Core ideas:

- **Context is a finite resource with diminishing marginal returns.** As tokens grow, transformer attention is spread over n² pairs; training-data distribution favours shorter sequences; **context rot** (Chroma's term) is a measurable effect across all frontier models.
- Context engineering is the iterative discipline of curating, at each step, "the smallest possible set of high-signal tokens that maximize the likelihood of some desired outcome."
- **System prompt altitude** — Goldilocks zone. One failure mode is brittle `if/else` hardcoding; the other is vague high-level fluff that assumes shared context. The right altitude is specific enough to steer, flexible enough to let the model think.
- **Tools should be clear and minimally overlapping.** "If a human engineer can't definitively say which tool should be used in a given situation, an AI agent can't be expected to do better."
- **Examples beat edge-case lists.** Few-shot with diverse canonical examples. Don't stuff every rule into the prompt — curate a handful that portray the behaviour.

Three strategies for long-horizon tasks (where the task exceeds a single context window):

1. **Compaction** — summarise when near the limit, re-initialise with the summary. High-fidelity distillation. "The art of compaction lies in the selection of what to keep versus what to discard." One safe, lightweight version: **tool-result clearing** — once a tool has been called and its output consumed, drop the raw result from subsequent context.
2. **Structured note-taking (agentic memory).** Agent writes to files outside the context (`NOTES.md`, `claude-progress.txt`). Brought back into context on demand. Enables multi-hour coherence — the Claude-plays-Pokémon case study shows tallies maintained across 1,234 game steps via notes alone.
3. **Sub-agent architectures.** Specialised sub-agents with clean contexts do deep work, return condensed summaries (1k–2k tokens from sessions that used tens of thousands). Separates concerns; same pattern HumanLayer calls "context firewall".

And a key shift in runtime strategy: **just-in-time context retrieval**. Instead of pre-loading embedding-based retrieval, agents maintain **lightweight references** (file paths, queries, URLs) and pull data in on demand via tools. "This approach mirrors human cognition: we generally don't memorize entire corpuses of information, but rather introduce external organization and indexing systems like file systems, inboxes, and bookmarks." Metadata in the filesystem (folder hierarchy, naming, timestamps) carries signal for free. Claude Code uses a hybrid — CLAUDE.md is dropped in up front; glob and grep give just-in-time access to everything else.

**Relevance:** our `.harness/` is a just-in-time reference store by construction. The `README.md` routing table is the lightweight-reference index; each file is pulled in only when a task needs it. This is the theoretical validation of our design: we happened to build the structure this paper argues for. Two follow-throughs for us:

- Our CLAUDE.md / AGENTS.md should stay small — they're the "dropped-in-up-front" layer.
- Filenames and folder names carry signal. We should name files like we'd name files in a codebase the agent is navigating: semantic, hierarchical, unambiguous. (We mostly do — `playbooks/deploy-to-test-stack.md` is better than `deploy.md`.)

### 3.13 Anthropic — "Claude Code auto mode: a safer way to skip permissions" (Mar 2026)

URL: <https://www.anthropic.com/engineering/claude-code-auto-mode>

The most concrete recent example of a **classifier-based sensor** inside an agent runtime. Context: 93% of permission prompts in Claude Code get approved. The rest do real work. Auto mode replaces the blanket `--dangerously-skip-permissions` escape hatch with a small model judging every tool call.

Design choices worth noting:

- **Threat model with four categories**, each handled the same way (block the action):
  1. **Overeager behavior** — agent understands the goal, takes initiative past what was authorised. Hardest to catch because it looks like normal problem-solving.
  2. **Honest mistake** — wrong blast radius (thinks a resource is test-scoped when it's shared).
  3. **Prompt injection** — hostile content in tool results hijacks the agent.
  4. **Misaligned model** — agent pursuing its own goal. Not observed in production but continuously evaluated.
- **Two-layer defence:** an *input-layer* prompt-injection probe scans tool outputs before they reach the agent; an *output-layer* transcript classifier judges each proposed action before it executes.
- **Tiered approval:** Tier 1 = safe-tool allowlist (reads, search, navigation) → auto. Tier 2 = in-project edits → auto. Tier 3 = everything else → classifier. Shell, web fetches, subagent spawns, out-of-project FS ops.
- **Two-stage classifier:** a fast yes/no first pass tuned for recall (8.5% FPR, low FNR); CoT second pass only on first-pass flags, cleaning up FPs down to 0.4%. "Almost entirely cache-hit" between stages.
- **Reasoning-blind classifier.** The classifier sees *only* user messages and raw tool calls. Assistant prose and tool outputs are stripped. This is deliberate: it denies the agent the chance to rationalise itself past the block, and it denies prompt injections a path to manipulate the classifier. "Judge what the agent did, not what the agent said."
- **Block categories:** destroy/exfiltrate, degrade security posture, cross trust boundaries, bypass review or affect others. Default allow exceptions are narrow — install declared dependencies, push to the working branch, standard credential flows.
- **Deny-and-continue.** A blocked action returns as a structured tool error with the reason; the agent tries a safer path. 3 consecutive or 20 total denials in a session escalates to a human. In headless mode, that's a process kill.
- **Subagent handoffs** get checked at *both* ends — at delegation (blocks dangerous task spawn) and at return (warns if the subagent got injected mid-run). `permissionMode` inside the subagent is ignored; parent rules rule.

Honest results table: 17% false-negative rate on *real* overeager-action cases. The 0.4% FPR / 17% FNR trade-off is presented as a substantial improvement over `--dangerously-skip-permissions` and a substantial regression from careful manual review, depending on what you were doing before.

**Relevance:** we don't run agents in a classifier-gated loop, and we don't need to. But the *pattern* — inferential sensor that classifies actions before they execute, isolated from the agent's own reasoning — is a class of control we don't currently have in our feedback-controls inventory. Worth naming in [`feedback-controls.md`](../.harness/references/feedback-controls.md) as a pattern we could adopt for our own deploy / destructive-operation path (e.g. a classifier review before any `sam deploy`, `aws s3 rm`, or DynamoDB batch-write).

Additionally, the **threat model** applies 1:1 to our operational surface (we do real DynamoDB writes, real Supabase mutations, real EC2 lifecycle). Our safety-protocol already covers this implicitly; making it explicit would help.

### 3.14 LangChain — "Improving Deep Agents with harness engineering" (Feb 2026)

URL: <https://blog.langchain.com/improving-deep-agents-with-harness-engineering/>

Vivek Trivedy's second post. Concrete, reproducible evidence that **harness work alone** moves benchmark scores: from 52.8% to 66.5% on Terminal Bench 2.0 with `gpt-5.2-codex` held fixed. Three knobs touched:

1. **System prompt.** Added an explicit problem-solving routine: Plan → Build → Verify → Fix. Most common prior failure: agent wrote code, re-read its own code, confirmed it looked OK, and stopped — without actually running tests.
2. **Tools.** Minor adjustments; most of the win came from the other two.
3. **Middleware** (their term; same abstraction Anthropic calls "hooks" and Inngest calls "steps"):
    - `PreCompletionChecklistMiddleware` — intercepts the agent before it exits, injects a reminder to run a verification pass against the task spec. A Ralph-Wiggum loop enforcing self-verification.
    - `LocalContextMiddleware` — runs at agent start, deterministically maps `cwd`, identifies tooling (`python` installations, etc.), injects it into context. Takes environment discovery — which is error-prone — off the agent's plate.
    - `LoopDetectionMiddleware` — tracks per-file edit counts, injects "consider reconsidering your approach" after N edits to the same file. "Doom loops" (10+ minor variations of the same broken approach) are a real failure mode.
    - **Time-budget warnings** — nudge the agent to wrap up when iterations are running low. Models are "famously bad at time estimation".
- **Reasoning sandwich** — `xhigh` on planning + `high` on middle-of-task execution + `xhigh` on verification. Choosing `xhigh` everywhere scored *worse* (53.9%) due to timeouts.
- **Trace Analyzer Skill** — automated error analysis on LangSmith traces. Parallel error-analysis agents synthesise findings, propose targeted harness changes. Boosting-style improvement loop.

Author's summary of the job: "The purpose of the harness engineer: prepare and deliver context so agents can autonomously complete work."

Explicit caveat: "These guardrails will almost surely dissolve over time, but to build robust agent applications today, they're useful tools to experiment with." Same dead-weight discipline Anthropic's Managed Agents paper pushes.

**Relevance:** inner-harness territory. Two ideas cross over to us:

- **Pre-completion checklist as a Ralph loop.** Our `.claude/hooks/verify-before-pr.sh` *is* exactly this pattern. Worth naming it as such in the harness-model vocabulary.
- **Trace-driven harness iteration.** Our version of traces is our session files + bug scars. We already iterate on our protocols from scars. But we don't have parallel trace-analysis — we do it in the human's head. LangChain's approach is a credible future direction if our scar volume grows.

### 3.15 LangChain — "Evaluating Deep Agents: Our Learnings" (late 2025 / early 2026)

URL: <https://www.langchain.com/blog/evaluating-deep-agents-our-learnings>

Short, practical, specifically about evaluating agents that keep state and run across many turns (the "deep agents" shape). Five patterns they ship with:

1. **Bespoke test logic per datapoint.** Traditional LLM evals test the final message. Deep-agent evals also need to test trajectory and state, and each datapoint gets its own success criteria. LangSmith's Pytest/Vitest integrations are how they do this.
2. **Single-step evals** — feed the agent one fixed sequence, assert its *next action*. "Unit tests" for agent decisions. Cheap, fast, great for regressions.
3. **Full-turn evals** — let the agent run end-to-end on a task. Evaluate trajectory (was the right tool called?), final response (open-ended tasks like coding / research), or state (artifacts — files written, JSON produced).
4. **Multi-turn evals** — simulate full user interactions with conditional logic. Hard to keep on rails without branching logic in the test.
5. **Clean, reproducible environments per test.** Temp dir for coding agents; Docker container per test for Terminal Bench. "Deep Agent evals require environments that reset per test — otherwise your evals become flaky and difficult to reproduce."

**Relevance:** we don't evaluate *an agent*, we evaluate *features* in a codebase the agent is working on. But the pattern inventory is still useful:

- Our pytest tests ≈ their single-step and full-turn evals, depending on scope.
- Our `playbooks/cleanup-between-runs.md` ≈ their clean-env principle. Reinforces that we need to take this seriously.
- **Trajectory-level evaluation** we don't do. Our "did the agent take the right path through the protocols?" is a human judgement call. There's nothing here that suggests we need to automate it — just useful to know the field has named it.

### 3.16 Inngest — "Your Agent Needs a Harness, Not a Framework" (2026)

URL: <https://www.inngest.com/blog/your-agent-needs-a-harness-not-a-framework>

The Inngest team's essay + reference implementation (Utah). Conceptual contribution: **a harness is the layer that connects, protects, and orchestrates components without doing the work itself.** Analogy runs through three senses of the word:

- Wiring harness — routes signals between engine, sensors, dashboard.
- Test harness — scaffolding that makes code repeatable and observable.
- Safety harness — catches you when you fall.

Applied to agents: the LLM is the engine, tools are peripherals, memory is storage. The harness is what connects them, handles the LLM timeout on iteration five, prevents two messages colliding, routes events. Their polemic: every agent framework is rebuilding this substrate from scratch (retries, state persistence, job queues, event routing) — and durable event-driven infrastructure already solves it.

Concrete patterns from Utah:

- **Every LLM call and tool execution is a step.** Atomic, independently retryable, persisted. If the process dies on iteration five, iterations 1–4 don't re-execute on restart.
- **Think → act → observe loop** kept minimal; orchestration decoupled from the loop.
- **Six small event-driven functions**, not one monolith: handle-message, send-reply, ack, failure-handler, heartbeat, sub-agent. Each has its own retry policy and concurrency rules.
- **Sub-agents via `step.invoke()`** — fresh context window, same toolset, own retries, own traces, returns a summary. Same pattern Anthropic and HumanLayer describe from different angles.
- **Singleton concurrency keyed per conversation** — one agent run per chat at a time. New message mid-run cancels the current run and restarts with latest context.
- **Two-tier context pruning:** soft-trim old tool results (keep head + tail), hard-clear the whole result when total context gets large; keep the last three assistant turns intact.
- **Overflow recovery** — context-too-large error mid-run force-compacts and retries.
- **Universally triggered** — same agent loop works whether the trigger is a Slack webhook, a Telegram message, a cron, or another agent.

**Relevance:** Inngest's piece is the clearest articulation of one of Fowler's axes: a harness is *the orchestration/infrastructure layer*, not a framework that embeds orchestration decisions. For us, the outer-harness equivalent is: our `.harness/` should route, structure, and observe the work, not prescribe implementation. We already behave this way — the protocols are routing + constraints, not templates. Worth naming as a design principle. The specific reliability patterns (atomic steps, singleton concurrency, overflow recovery) are inner-harness.

---

## 4. Synthesis: what the field agrees on

Across thirteen sources, a small number of ideas keep recurring. These are the load-bearing abstractions.

### 4.1 Shared vocabulary

| Term | What it means | Source it's clearest from |
|---|---|---|
| **Agent = Model + Harness** | Everything around the model that makes it useful | LangChain, HumanLayer |
| **Inner vs outer harness** | Runtime that wraps the model, vs scaffolding a team builds in their repo | Fowler |
| **Workflow vs agent** | Predefined code-path orchestration vs model-directed dynamic tool use | Anthropic *Building Effective Agents* |
| **Guide (feed-forward)** | Steering that acts before the agent does | Fowler |
| **Sensor (feed-back)** | Signal produced after the agent acts, used for self-correction | Fowler |
| **Computational vs inferential controls** | Deterministic checks (tests, lints, types) vs LLM-backed ones (judges, reviewers) | Fowler |
| **Attention budget / instruction budget** | Every token costs attention; budget deliberately | Anthropic *Context Engineering*, HumanLayer |
| **Context rot** | Measurable drop in recall as context grows, present in all frontier models | Chroma, via HumanLayer + Anthropic |
| **Just-in-time context** | Maintain lightweight references, pull data via tools on demand rather than pre-loading | Anthropic *Context Engineering* |
| **Compaction / structured note-taking** | Summarise or externalise state so long tasks fit across context windows | Anthropic *Context Engineering* |
| **Context firewall / sub-agent as encapsulation** | Isolate expensive exploration so intermediate noise doesn't pollute parent context | HumanLayer, Anthropic |
| **Session (as object)** | The durable event log, stored outside the context window, interrogable | Anthropic *Managed Agents* |
| **Repo as system of record** | If it's not in the repo, the agent can't see it | OpenAI |
| **Agent legibility** | Design choices optimised for an agent's ability to reason from in-repo state alone | OpenAI |
| **ACI (agent-computer interface)** | Tools and docs treated with the rigour of an HCI — same design effort | Anthropic *Building Effective Agents* |
| **Poka-yoke tool design** | Remove the possibility of common mistakes structurally (e.g. force absolute paths) | Anthropic *Building Effective Agents* |
| **Ralph (Wiggum) loop** | A hook that forces the agent to keep going against a completion goal | ghuntley, via multiple |
| **Pre-completion checklist / self-verify hook** | Specific Ralph-loop variant: force a verification pass against the spec before exit | LangChain *Improving Deep Agents* |
| **Progressive disclosure** | Don't dump everything; let the agent pull what it needs | OpenAI, HumanLayer, Anthropic |
| **Back-pressure** | Verification mechanisms that push back on low-quality output | HumanLayer |
| **Golden principles** | Opinionated mechanical rules; taste encoded once, enforced forever | OpenAI |
| **Garbage collection / doc gardening** | Periodic sweep for drift; agents open remediation PRs | OpenAI, Fowler |
| **Harnessability** | The degree to which a codebase affords external control | Fowler |
| **Classifier-based approval (auto mode)** | Separate model judges each action before it executes, isolated from the agent's reasoning | Anthropic *Auto Mode* |
| **Reasoning-blind review** | Deliberately strip assistant prose + tool output from the reviewer so it judges actions, not rationales | Anthropic *Auto Mode* |
| **Deny-and-continue** | Blocks return as structured tool errors; agent retries a safer path; escalate only on repeated denials | Anthropic *Auto Mode* |
| **Agent threat model (4 categories)** | Overeager / honest mistake / prompt injection / misaligned — defence is the same: block the action | Anthropic *Auto Mode* |
| **Feature list as JSON contract** | Long-horizon specs that the agent can only flip `passes: false → true`, not rewrite | Anthropic *Long-running Agents* |
| **Init script + progress file + session-start routine** | Standardised multi-session hand-off (`init.sh`, `claude-progress.txt`, fixed opener) | Anthropic *Long-running Agents* |
| **Middleware / hooks / steps** | Three names for the same abstraction: intercept the agent at well-defined points | LangChain, Anthropic, Inngest |
| **Trace as feedback signal** | Agent runs produce structured traces; future harness changes are driven by trace analysis | LangChain *Improving Deep Agents* |
| **Reasoning sandwich** | Allocate more reasoning compute to planning and verification than to middle-of-task execution | LangChain *Improving Deep Agents* |
| **Loop / doom-loop detection** | Middleware that counts repetitive actions and nudges the agent to reconsider | LangChain *Improving Deep Agents* |
| **Atomic step** | Each LLM call and tool call is an independently retryable unit of work, persisted | Inngest |
| **Decouple orchestration from loop** | Harness provides routing + retries + persistence; the think→act→observe loop stays minimal | Inngest |
| **Bespoke test logic per datapoint** | Each eval case carries its own success criteria — trajectory, response, or state | LangChain *Evaluating Deep Agents* |
| **Single-step / full-turn / multi-turn evals** | Three levels of eval granularity for stateful agents | LangChain *Evaluating Deep Agents* |

We'll adopt this vocabulary inside `.harness/` rather than inventing parallel terms. See [`../.harness/references/harness-model.md`](../.harness/references/harness-model.md).

### 4.2 Universal principles (everyone agrees)

1. **Optimise for what the model can't do on its own; question it periodically.** Every harness component encodes a model limitation. Models improve; review your harness and strip what's gone stale. (Anthropic ×3, LangChain ×2, HumanLayer, Fowler)
2. **Keep the entry document short; use it as a table of contents, not an encyclopedia.** ≤60–100 lines of CLAUDE.md / AGENTS.md. Structured `docs/` beneath for depth. (OpenAI, HumanLayer, ETH Zurich via HumanLayer, Anthropic *Context Engineering*)
3. **Pair feed-forward guides with feed-back sensors.** Neither alone is sufficient. (Fowler, reinforced by Anthropic *Auto Mode*)
4. **Validate every output. Never trust blindly.** Retry once with structured error feedback; escalate to human on second failure. (Stripe/Shopify/Airbnb via MindStudio, Anthropic *Auto Mode* "deny-and-continue", HumanLayer)
5. **Sub-agents / parallel context windows, not longer context windows.** Context rot is real; context isolation is structural. (LangChain, HumanLayer, Chroma, Anthropic *Context Engineering*)
6. **Encode taste mechanically.** Custom linters with remediation messages, structural tests, fitness functions, middleware. Run them continuously. (OpenAI, Fowler, LangChain *Improving Deep Agents*)
7. **Find the simplest thing first; grow only on observed failure.** Drop frameworks in favour of patterns; drop frameworks in favour of infrastructure; drop hooks that no longer earn their context cost. (Anthropic *Building Effective Agents*, HumanLayer, Inngest)
8. **Humans steer; systems scaffold; agents execute.** Human role moves upward toward design, review, and harness iteration as models improve. (OpenAI, Fowler)
9. **Harness improvements alone can move benchmark performance.** It is worth engineering time. LangChain's 13.7-point Terminal Bench gain is the most concrete example. (LangChain *Improving Deep Agents*, OpenAI)
10. **Know whether your goal is narrow reliability or broad autonomy.** Different harness shapes win in each. (MindStudio, Anthropic *Building Effective Agents*)
11. **Tool design is its own discipline with its own evaluation loop.** Tools are contracts between deterministic systems and non-deterministic agents; measure, optimise, and prune with held-out evals. (Anthropic *Writing Effective Tools*, reinforced by *Building Effective Agents* Appendix 2)
12. **Progressive disclosure + just-in-time retrieval over up-front dumping.** Lightweight references + navigable filesystem > giant embedding retrieval > giant context blob. (Anthropic *Context Engineering*, OpenAI, HumanLayer)
13. **Deterministic environment setup at session start beats letting the agent rediscover.** Inject `cwd`, available tooling, project layout; don't spend tokens on error-prone discovery. (LangChain *Improving Deep Agents* `LocalContextMiddleware`, Anthropic *Long-running Agents* `init.sh`)
14. **Self-verification as a first-class hook.** A Ralph-loop pre-completion check that forces the agent to run tests against the spec before exiting. Our pre-push hook is exactly this; LangChain and Anthropic's long-running paper both reach for the same pattern. (LangChain *Improving Deep Agents*, Anthropic *Long-running Agents*, us via `.claude/hooks/verify-before-pr.sh`)

### 4.3 Productive disagreements

Not everything is settled.

- **How much to invest upfront vs reactively.** HumanLayer: "start simple, add only when you hit real failures". OpenAI: "This is the kind of architecture you usually postpone until you have hundreds of engineers. With agents, it's an early prerequisite." Both can be right, depending on code velocity and throughput asymmetry.
- **One big agent or many small?** Anthropic's long-running-apps paper uses distinct planner/generator/evaluator prompts (but the *same* agent, same tools — "agents" is just a framing). LangChain's *Long-running* paper is ambivalent: "still unclear whether a single, general-purpose coding agent performs best across contexts, or if better performance can be achieved through a multi-agent architecture." HumanLayer denounces role-based sub-agents ("frontend engineer sub-agent") and uses sub-agents only for context isolation. Mature position: sub-agents for *context*, not role-play.
- **Framework vs infrastructure vs patterns.** Anthropic *Building Effective Agents*: start with LLM API directly, add patterns, drop framework abstractions if they obscure. Inngest *Harness Not Framework*: frameworks rebuild what durable event-driven infrastructure already does; the harness is the infrastructure layer. LangChain ships Deep Agents as a framework but argues the wins come from harness changes *within* it. Different points on the same spectrum — the common principle is "the harness is a layer, not a framework".
- **Where the model-harness co-evolution takes us.** LangChain's view: over time, capabilities absorb into the model and the harness matters less. Fowler's view: the space of useful harness work shifts, not shrinks. Both can be true in the long run.
- **Permission friction vs autonomy.** Anthropic *Auto Mode* trades human review for a classifier and is honest about the 17% FNR cost on real overeager actions. HumanLayer trusts hooks + back-pressure. Stripe/Shopify/Airbnb trust validation loops + human escalation at defined thresholds. Nobody trusts "no gate at all" on high-stakes work.

### 4.4 Open questions the field still has

- How do you *measure* harness coverage or quality? (Analogous to code coverage for tests; Fowler explicitly names this as missing.)
- How do you keep harnesses coherent as they grow? (Contradiction between guides and sensors is the failure mode.)
- How do you build a **behaviour harness** that gives real confidence in functional correctness? (Fowler calls this "the elephant in the room".)
- What does long-term architectural coherence look like in a fully agent-generated codebase? (OpenAI: "We don't yet know.")

We don't have answers either. Where we don't know, we say we don't know.

---

## 5. Where PocketEng's `.harness/` sits today

The tl;dr: our `.harness/` is already structurally aligned with most of the field's converging best practices for outer-harness design. Specifically, it is close to OpenAI's in-repo knowledge-base pattern, borrows Fowler's guide/sensor framing implicitly, and internalises HumanLayer's "keep it short, bias toward shipping" discipline.

What follows is a direct mapping, with attribution.

### 5.1 Features we already have (and where the idea came from, explicitly or convergently)

| Our practice | Aligned with | Convergent or borrowed |
|---|---|---|
| `.harness/README.md` as single entry point + mandatory reading list | OpenAI's "AGENTS.md as table of contents" | Convergent — we wrote it before reading the OpenAI paper; it's the obvious pattern |
| Protocols / playbooks / references / features / learnings split | OpenAI's `docs/{design-docs, exec-plans, references, ...}`; also matches Fowler's regulation categories indirectly | Convergent |
| Short entry files (CLAUDE.md 66 lines, AGENTS.md 38 lines, .harness/README.md 88 lines) | OpenAI's 100-line guidance; HumanLayer's 60-line recommendation | Convergent |
| Bidirectional links + "Referenced by" sections | Progressive-disclosure navigation | Convergent |
| Frontmatter with `type`, `status`, `last_reviewed`, `related` | Structured knowledge store (OpenAI) | Borrowed (idea), own schema |
| Learnings folder with durable bug scars + feature-file cross-links | OpenAI's "promote review feedback into docs / tooling"; Fowler's "steering loop" | Convergent |
| `protocols/no-bypass.md` — surface the block, don't route around it | HumanLayer ("fix the harness, not the symptom"); implicit in OpenAI | Own framing, convergent intent |
| `protocols/tdd-and-scope.md` — TDD + scope discipline as first-class protocol | Stripe "validation-first generation"; Airbnb validation pipeline | Convergent |
| `playbooks/browser-testing.*` — Playwright, numbered screenshots, video, network/console hooks | Exactly the pattern Anthropic's long-running-apps paper describes (Playwright MCP in the evaluator); matches OpenAI's "agent legibility of runtime signal" | Convergent, reinforced by reading both papers |
| `references/aws-debugging.md` — "AWS CLI as a debugging handle" | OpenAI's "make runtime signal legible to the agent" | Convergent |
| Companion `.sh` scripts for each playbook | "Deterministic computational guides" (Fowler) | Convergent |
| `meta/write-protocol.md` — push learnings back into the harness | Fowler's steering loop; OpenAI's "feed human taste into the system continuously" | Convergent |

Nothing in this list is ours *because* we read the papers. We got there via a different route — repeated scars on our own bug-fix / test-with-real-users / deploy-to-prod-accidentally cycle. The convergence with the literature is a confidence check, not an origin story.

### 5.2 Attribution summary (what we intentionally adopted from which source)

Even before this paper, we borrowed:

- **Skills-style progressive disclosure** — Anthropic's skills docs; now echoed throughout the field.
- **AGENTS.md format** — emerging standard from agentsmd/agents.md; we ship an AGENTS.md alongside our CLAUDE.md to be compatible.
- **Playwright + real-stack E2E, screenshots as the log** — lifted (in pattern, not in specifics) from the engineer write-up that seeded our `browser-testing.md`; the same pattern shows up verbatim in Anthropic's long-running-apps piece and OpenAI's legibility section.

### 5.3 Gaps the review surfaces

The papers made four real gaps visible. Each is addressed in §6.

1. **No named conceptual model.** We use Fowler's ideas (guides / sensors / feed-forward / feed-back / computational / inferential) implicitly. Newcomers can't orient. → new `references/harness-model.md`.
2. **No central inventory of our sensors.** We have many feedback controls (pre-push hook, pytest suite, `npm run build`, lints, Playwright E2E) but no one file enumerates them or says which are computational vs inferential. → new `references/feedback-controls.md`.
3. **No mechanical enforcement of the knowledge base itself.** Frontmatter integrity, link integrity, `last_reviewed` freshness, oversized files — all live in custom, unenforced conventions. OpenAI enforces theirs with linters and CI. → new `tools/harness-lint.py` invoked from a new `playbooks/harness-gardening.sh`.
4. **No explicit policy on stripping stale scaffolding.** Anthropic's strongest single message is that harness components go stale as models improve, and you should periodically stress-test and delete. Our write-protocol doesn't mention this. → update `meta/write-protocol.md` with a "dead-weight review" bullet; have each file's `last_reviewed` be the trigger.

### 5.5 New gaps surfaced by the deeper reading (v2)

After re-reading the field end-to-end, five additional gaps became visible that v1 missed.

1. **We don't run a baseline smoke test at the start of Phase 1 (Read).** Anthropic's *Long-running Agents* paper is blunt: before a session touches new work, it should run `init.sh` and verify the app still boots, because the previous session may have silently broken something. Our dev cycle puts validation in Phase 4 (after Build). For small fixes that's overhead; for any session that follows a long-running or multi-agent task, it's a real miss. **Proposal:** add an optional "sanity smoke test" step at the end of Phase 1 for work that touches browser-observable surfaces. Captured as proposal 6.9.
2. **No explicit "threat model" for our operational surface.** Anthropic's auto-mode paper lays out a 4-category threat model (overeager / honest mistake / prompt injection / misaligned) that directly applies to our real-AWS / real-DynamoDB / real-Supabase environment. Our `safety-protocol.md` implicitly covers it but doesn't name it. **Proposal:** add a one-page "operational threat model" reference pointed to from `safety-protocol.md`. Captured as proposal 6.10.
3. **No documentation of the "tools are ACI" principle for our knowledge base.** Our `.harness/` files are the ACI an agent uses to navigate our repo. Anthropic's *Writing Effective Tools* says: name parameters unambiguously, write descriptions like docstrings for juniors, poka-yoke inputs, return meaningful context. All of this applies to our files: semantic filenames, `When to read` headers, make-it-hard-to-pick-the-wrong-playbook. We mostly do this already; what's missing is naming it. **Proposal:** extend `harness-model.md` with an "ACI for the knowledge base" section. Captured as proposal 6.11.
4. **No "reasoning budget" hygiene.** LangChain's *Improving Deep Agents* shows concretely that choosing reasoning levels matters. Our development cycle treats planning + execution + verification as uniformly weighted. The real allocation — more care on plan + verify, less in the middle — is folklore, not doc. **Proposal:** name "reasoning sandwich" in `development-cycle.md` as a guidance note for effort allocation. Captured as proposal 6.12.
5. **No "just-in-time context" framing for how we expect agents to use the harness.** Anthropic's *Context Engineering* paper is effectively a theoretical justification for our `.harness/` design, but a newcomer reading our knowledge base doesn't see the "don't pre-load, navigate just-in-time" contract. Our read-protocol now has the instruction-budget preamble (added in v1), but the positive framing — "the harness is a navigable filesystem, treat it that way" — is missing. **Proposal:** add a short paragraph to `read-protocol.md` + `harness-model.md`. Captured as proposal 6.13.

### 5.4 Intentional deviations (we're doing it differently, on purpose)

Three places where we chose something the field doesn't universally recommend, for reasons.

- **Humans write code here.** OpenAI's "no manually-written code" experiment is striking, but it was a chosen experiment, not a recommendation. PocketEng is an augmented-engineering org, not an agent-only one. We'll keep agents as multipliers, not as the only author.
- **We don't have multi-agent orchestration.** The LangChain / Anthropic / Stripe patterns of planner + generator + evaluator roles are powerful but add operational weight we don't need yet. Our single-agent + human-in-the-loop + Playwright evaluator is the same *shape* with lower cost.
- **We invest upfront in scaffolding, not only reactively.** HumanLayer explicitly recommends not optimising upfront. OpenAI explicitly recommends upfront invariants. We're closer to OpenAI because our scars predate the harness and we've earned the investment. If we were greenfield with no bug history, we'd follow HumanLayer.

---

## 6. Proposed changes (this PR's scope)

Applied in parallel with this paper. All items are small, atomic, and reversible.

| # | Change | Motivation | Attribution |
|---|---|---|---|
| 6.1 | **New `references/harness-model.md`** — defines inner vs outer harness, guides / sensors, computational / inferential, regulation categories, instruction budget. Links from the README routing table. | Newcomers need one file to pick up the vocabulary. | Fowler (primary); LangChain, HumanLayer (supporting) |
| 6.2 | **New `references/feedback-controls.md`** — enumerates every sensor we run today (pre-push hook, pytest, `npm run build`, ESLint/TS, Playwright harness, AWS CLI probes), tags each computational/inferential, notes lifecycle stage. | We have sensors scattered across the repo; no one file maps them. | Fowler |
| 6.3 | **New `playbooks/harness-gardening.md`** + **`tools/harness-lint.py`** + **`playbooks/harness-gardening.sh`** — a checker that validates frontmatter on every `.harness/*.md`, flags broken relative links, warns on missing or stale `last_reviewed`, warns on oversized files without `oversized_justification`. | Move the knowledge base itself from convention to enforcement. | OpenAI (linter-enforced docs); Fowler (computational sensors) |
| 6.4 | **Update `meta/write-protocol.md`** — add a "dead-weight review" step. Any protocol added to work around a *model* limitation should carry a `motivation` line so a future reader (and the harness-gardening pass) can revisit it as models improve. | Anthropic's core message from Managed Agents: harness components encode assumptions that go stale. | Anthropic (Managed Agents) |
| 6.5 | **Update `meta/read-protocol.md`** — explicit instruction-budget reminder: read the README + the four protocols + the *one* playbook / feature file your task touches, not everything. Add guidance not to preload learnings up front; grep by symptom instead. | HumanLayer's "instruction budget"; OpenAI's "context is a scarce resource". | HumanLayer, OpenAI |
| 6.6 | **Update `protocols/development-cycle.md`** — name the planner / builder / evaluator analogy explicitly in the Build and Test phases; the evaluator is the browser harness. Cross-link to `harness-model.md`. | Makes our unspoken structure legible to newcomers and aligned with field vocabulary. | Anthropic (long-running apps paper) |
| 6.7 | **Update `.harness/README.md`** — add routing rows for the new reference and gardening playbook; add a pointer to this paper for anyone who wants the theoretical background. | Navigation only. | — |
| 6.8 | **Update `CLAUDE.md`** (repo root) — one-line pointer to `docs/harness-research.md` for anyone who wants the "why". | Don't force a reader to dig. | — |
| 6.9 | **Add optional baseline smoke-test step to Phase 1 of `development-cycle.md`.** For any task touching browser-observable surfaces, run the relevant playbook smoke test before starting. Catches silent breakage inherited from a previous session. | Anthropic's *Long-running Agents* session-opening routine applied to our cycle. | Anthropic (Long-running Agents) |
| 6.10 | **New `references/operational-threat-model.md`.** Enumerates the four failure modes (overeager, honest mistake, prompt injection, misaligned behaviour) for *our* surface — DynamoDB, Supabase, EC2, preview proxy. Pointed to from `safety-protocol.md`. | Borrowing Anthropic's auto-mode framing, adapted to the fact that we operate against real infrastructure. | Anthropic (Auto Mode) |
| 6.11 | **Extend `harness-model.md` with an "ACI for the knowledge base" section.** Name the principle that filenames, routing tables, and "When to read" headers are the agent's tool interface. | Anthropic's *Writing Effective Tools* applied to a markdown-first knowledge base. | Anthropic (Writing Tools, Building Effective Agents) |
| 6.12 | **Update `development-cycle.md` with a "reasoning sandwich" note.** More care on Plan (Phase 2) and Review (Phase 5); cruise through Build if the plan is clear. | LangChain's concrete evidence that reasoning allocation matters. | LangChain (Improving Deep Agents) |
| 6.13 | **Short "just-in-time navigation" contract in `read-protocol.md` + `harness-model.md`.** Explicit positive framing: the harness is a navigable filesystem; pull files on demand; don't pre-load. | Anthropic's *Context Engineering* theoretical backing for our existing design. | Anthropic (Context Engineering) |

Proposals 6.1–6.8 were applied in the v1 PR alongside the v1 draft. Proposals 6.9–6.13 are new in v2 and are being applied alongside this draft.

No changes are being made to our existing protocols' ground rules. The conceptual framing gets added in references and small extensions to existing files; the existing rules stay as-is.

### 6.5.1 Things we considered and explicitly rejected

- **Multi-agent orchestration framework** (LangGraph / AutoGen / deepagents). Overkill for a knowledge base; adds cognitive load for no current payoff.
- **Doc-gardening agent that opens PRs autonomously** (OpenAI's approach). Interesting but premature — we don't have the PR throughput to justify it. We'll run `harness-gardening.sh` manually as a weekly human task first; promote to automation only when the manual task accumulates repetition.
- **Eval harness / regression suite for the knowledge base**. Would require benchmark prompts + scoring. Not worth the build for a single-team repo.
- **Skill registries / plugin marketplaces**. HumanLayer's warning about malicious skills is well-taken; we already gatekeep at the repo level.

### 6.5.2 Ideas we'll come back to (parking lot)

- **"Golden principles" as a separate file** (OpenAI) — opinionated rules that apply everywhere. Candidate content: "parse at boundaries", "prefer typed SDKs", "prefer CLIs with good training-data coverage over MCP servers for common tools". We'll add this only when we have enough concrete examples to justify it.
- **Harness coverage metric** — Fowler's open question. Could we measure whether our protocols cover our actual failure modes? Probably via tagging each learning with a protocol-name and periodically auditing which protocols have no failures attributed — either strong (the rule works) or a blind spot (we aren't seeing violations). Worth revisiting next quarter.
- **Architecture fitness functions for PocketEng itself** — can we express "no Lambda cold-start > 800ms" or "no Python file > 500 lines in backend/src/lib/" as enforced tests? Would be a meaningful sensor. Deferred.

---

## 7. Reasonable disagreements with the field

Pinning stakes so future readers can know what was deliberate.

- **We won't adopt "no manually-written code".** OpenAI's field report is impressive but it's a forcing function for infrastructure investment, not a recommendation. Our thesis is that agents multiply engineers, not replace them. Both humans and agents contribute code here; the harness exists to make both more effective.
- **We don't treat "skills" as the primary progressive-disclosure unit.** Skills are a Claude-Code / AGENTS.md ecosystem construct. Our `.harness/` folder provides the same property (progressive disclosure of instructions and knowledge) through a plain markdown knowledge graph. We remain compatible with skills (CLAUDE.md / AGENTS.md are skill-equivalent entry points), but we don't push them as the *canonical* unit of reusable knowledge here.
- **We're stricter about "no bypass" than HumanLayer's "bias toward shipping".** We agree on shipping, but in our operational domain (real DynamoDB, real EC2, real Supabase auth, real money possibly at stake) the cost of silent bypass is higher than the cost of surfacing a block. We keep the stricter default; we add explicit agency / judgement clauses so it doesn't become a chain.
- **We currently prefer CLI wrappers over MCP for standard tools** (gh, aws, docker, supabase). HumanLayer's argument — training-data coverage + context efficiency — is the one we buy most strongly. MCP is reserved for things without a good CLI equivalent (e.g. browser automation where Playwright isn't already a standard tool in the shell; we cover this in `references/cursor-ide-browser.md`).

---

## 8. Open questions we still have

These stay open after the review. They're questions the field hasn't answered either, so we're in good company.

1. **How do we measure that our harness is working?** The proxies we have today — PRs merged without revert, test-pass rate on first submission, number of new scars per month — are weak. We need an honest quality signal.
2. **When do we consolidate learnings into protocols?** A learning is scar-level; a protocol is policy-level. Our write-protocol says "promote when the scar recurs", but we haven't defined how many times.
3. **How do we avoid the harness itself becoming a graveyard?** OpenAI's recurring-doc-gardener is one answer. We're starting with a manual weekly `harness-gardening.sh` pass, but eventually we'll want automation.
4. **Which of today's protocols will look like dead weight on a stronger model?** Several of ours are aimed at specific agent failures — `no-bypass.md` directly targets "invent config instead of asking", which might become a training-era artefact. We should revisit every protocol with `motivation` tagged as *observed-failure-on-<model>-<date>* once per model generation.
5. **Behaviour harness.** Fowler's elephant. Our session-sync bug fixes moved bytes between agents; we can verify by DynamoDB diffs + UI screenshots. But harder behaviours (an app "feels polished" or "feels fast") are still humans-only checks for us. Not clear when that changes.

---

## 9. Reading order for someone joining PocketEng

If you're new and want the theoretical background:

1. This paper — 20 minutes.
2. Martin Fowler, *Harness engineering for coding agent users* — the vocabulary.
3. HumanLayer, *Skill Issue* — the practitioner's operational reality.
4. OpenAI, *Harness engineering* — the ambitious end-state and its costs.
5. Anthropic, *Harness design for long-running application development* — the creator/evaluator pattern and the "strip dead weight" discipline.

Everything else is optional unless a specific decision forces it.

---

## 10. Full source list

All sources below were read in full for the v2 draft.

| # | Source | URL | Why it's in this review |
|---|---|---|---|
| 1 | Anthropic, *Scaling Managed Agents: Decoupling the brain from the hands* (2026) | <https://www.anthropic.com/engineering/managed-agents> | Meta-harness architecture; stable interfaces against a changing model landscape |
| 2 | Anthropic, *Harness design for long-running application development* (2026) | <https://www.anthropic.com/engineering/harness-design-long-running-apps> | Three-agent GAN-inspired architecture; Playwright-MCP evaluator; dead-weight review |
| 3 | Martin Fowler, *Harness engineering for coding agent users* (2026) | <https://martinfowler.com/articles/harness-engineering.html> | Canonical outer-harness vocabulary: guides / sensors / regulation categories |
| 4 | HumanLayer, *Skill Issue: Harness Engineering for Coding Agents* (2026) | <https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents> | Configuration surface; instruction budget; sub-agent as context firewall; ETH Zurich agentfile study |
| 5 | OpenAI (Ryan Lopopolo), *Harness engineering: leveraging Codex in an agent-first world* (2026) | <https://openai.com/index/harness-engineering/> | Structured `docs/` as system of record; mechanical enforcement; garbage collection |
| 6 | LangChain (Vivek Trivedy), *The Anatomy of an Agent Harness* (2026) | <https://www.langchain.com/blog/the-anatomy-of-an-agent-harness> | `Agent = Model + Harness`; derivation from first principles; harness-model co-evolution |
| 7 | MindStudio, *What Is an AI Coding Agent Harness? How Stripe, Shopify, and Airbnb Build Reliable AI Workflows* (2026) | <https://www.mindstudio.ai/blog/ai-coding-agent-harness-stripe-shopify-airbnb> | Industrial examples of narrow-scope agents and validation loops |
| 8 | Anthropic, *Building Effective AI Agents* (Dec 2024) | <https://www.anthropic.com/engineering/building-effective-agents> | Workflows vs agents; five workflow patterns; ACI; poka-yoke tools (v2: fully read) |
| 9 | Anthropic, *Effective harnesses for long-running agents* (Nov 2025) | <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents> | Initializer + coding agent pattern; feature list as JSON contract; `init.sh`; session-start routine (v2: fully read) |
| 10 | Picrew, *Awesome Agent Harness* (2026) | <https://github.com/Picrew/awesome-agent-harness> | Taxonomy of the wider ecosystem; reference implementations we may track |
| 11 | Anthropic, *Writing effective tools for AI agents — with agents* (Sep 2025) | <https://www.anthropic.com/engineering/writing-tools-for-agents> | Tools as deterministic↔non-deterministic contract; namespacing; token-efficient responses; descriptions as docstrings (v2: new) |
| 12 | Anthropic, *Effective context engineering for AI agents* (Sep 2025) | <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> | Attention budget; context rot; just-in-time retrieval; compaction vs notes vs sub-agents (v2: new) |
| 13 | Anthropic, *Claude Code auto mode: a safer way to skip permissions* (Mar 2026) | <https://www.anthropic.com/engineering/claude-code-auto-mode> | Classifier-based approval; reasoning-blind review; 4-category threat model; deny-and-continue (v2: new) |
| 14 | LangChain (Vivek Trivedy), *Improving Deep Agents with harness engineering* (Feb 2026) | <https://blog.langchain.com/improving-deep-agents-with-harness-engineering/> | 13.7-point Terminal Bench gain from harness-only changes; middleware catalog; reasoning sandwich (v2: new) |
| 15 | LangChain, *Evaluating Deep Agents: Our Learnings* (2026) | <https://www.langchain.com/blog/evaluating-deep-agents-our-learnings> | Bespoke per-datapoint logic; single-step / full-turn / multi-turn evals; per-test env reset (v2: new) |
| 16 | Inngest, *Your Agent Needs a Harness, Not a Framework* (2026) | <https://www.inngest.com/blog/your-agent-needs-a-harness-not-a-framework> | Harness-as-infrastructure; atomic steps; singleton concurrency; decoupled orchestration (v2: new) |

---

## 11. Changelog

- **v1 (2026-04-23)** — initial draft. Literature review of 10 sources; self-assessment and eight proposed harness changes (6.1–6.8). Open for team review.
- **v2 (2026-04-23)** — author's honest admission: v1 cited three pieces (*Building Effective Agents*, *Effective Harnesses for Long-running Agents*, and the LangChain / Anthropic / Inngest pieces now entered as full citations) as "referenced but not full-read". v2 reads them in full, plus *Writing Effective Tools*, *Effective Context Engineering*, *Claude Code auto mode*, *Improving Deep Agents*, *Evaluating Deep Agents*, and Inngest's *Harness Not Framework*. Vocabulary table doubles in size. Five additional gaps surfaced (§5.5) and proposed as changes 6.9–6.13, applied alongside this draft.
