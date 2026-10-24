# PocketEng Engineering Harness

**You are starting work on this repo.** Read this file first. It is the entry point for every engineer and every coding agent.

This harness is a compact, self-improving knowledge base. Links between files are bidirectional — follow one, and the destination tells you what else is connected.

---

## Before you code (always)

Read these four files. Budget ~15 minutes. They are short by design.

1. [`protocols/development-cycle.md`](protocols/development-cycle.md) — how we work, phase by phase.
2. [`protocols/testing-protocol.md`](protocols/testing-protocol.md) — real-data, real-browser, real-deploy rules.
3. [`protocols/safety-protocol.md`](protocols/safety-protocol.md) — secrets, destructive ops, what never gets committed.
4. [`protocols/commit-and-pr-protocol.md`](protocols/commit-and-pr-protocol.md) — when to commit, what evidence to attach.

Then follow the routing below for your specific task.

---

## Routing — "I need to…"

| Goal | Go to |
|---|---|
| Build a feature or non-trivial fix (TDD + scope) | [`protocols/tdd-and-scope.md`](protocols/tdd-and-scope.md) |
| I'm blocked — what do I do without silently bypassing? | [`protocols/no-bypass.md`](protocols/no-bypass.md) |
| Set up my dev environment (installs, auth, CLIs) | [`playbooks/dev-environment-setup.md`](playbooks/dev-environment-setup.md) |
| Deploy to a test AWS stack | [`playbooks/deploy-to-test-stack.md`](playbooks/deploy-to-test-stack.md) |
| Run the real-browser test harness | [`playbooks/browser-testing.md`](playbooks/browser-testing.md) |
| Reset state between test runs | [`playbooks/cleanup-between-runs.md`](playbooks/cleanup-between-runs.md) |
| Debug backend state with the AWS CLI | [`references/aws-debugging.md`](references/aws-debugging.md) |
| Find where an env variable or secret lives | [`references/env-variables.md`](references/env-variables.md) |
| Understand the system's big-picture flows | [`references/architecture-overview.md`](references/architecture-overview.md) |
| Know which repo folder owns which concern | [`references/repo-map.md`](references/repo-map.md) |
| Understand the vocabulary of harness engineering | [`references/harness-model.md`](references/harness-model.md) |
| See the full list of sensors (what catches what) | [`references/feedback-controls.md`](references/feedback-controls.md) |
| Know the four failure modes of real-infra ops (overeager, honest mistake, injection, misaligned) | [`references/operational-threat-model.md`](references/operational-threat-model.md) |
| Do a weekly gardening pass on `.harness/` itself | [`playbooks/harness-gardening.md`](playbooks/harness-gardening.md) |
| Work on session syncing (any coding agent) | [`features/session-sync.md`](features/session-sync.md) |
| Check whether my bug has been seen before | grep [`learnings/`](learnings/) by symptom, then read the matching file |
| Read the industry-review backing this design | [`../docs/harness-research.md`](../docs/harness-research.md) |

If your goal is not in this table and you think it should be, the write-protocol explains how to add it.

---

## When you finish — push knowledge back

At the end of every task, read [`meta/write-protocol.md`](meta/write-protocol.md). It tells you:

- Which file type your new knowledge belongs in.
- How to link it into the graph (forward + backward links).
- When human sign-off is required (protocol changes).
- How to deprecate without deleting.

**Knowledge that doesn't make it back into the harness dies with the session.** Do not skip this step.

---

## How the harness itself works

Only read these if you are changing the structure, not the content.

| File | Purpose |
|---|---|
| [`meta/read-protocol.md`](meta/read-protocol.md) | Canonical task-start routine |
| [`meta/write-protocol.md`](meta/write-protocol.md) | Canonical task-end routine |
| [`meta/file-taxonomy.md`](meta/file-taxonomy.md) | The 5 file types and when to use each |
| [`meta/linking-protocol.md`](meta/linking-protocol.md) | Forward + backward link rules |
| [`meta/file-template.md`](meta/file-template.md) | Canonical template for new files |

---

## Ground rules (tl;dr of the protocols)

1. Never mock the integration surface. Capture real fixtures.
2. Never declare done without real-browser validation.
3. Never commit or print secrets.
4. Deploy to the test stack before merge. Never to prod.
5. Collect bugs in a batch, then fix in a batch.
6. Commit only when the user asks. Push with evidence.
7. Don't patch unrelated features to make your test pass. Stop, investigate, ask.
8. **When blocked, surface — don't silently bypass.** Missing config, flaky browser, hard test: name it and ask, don't invent around it. See [`protocols/no-bypass.md`](protocols/no-bypass.md).
9. **Use judgment.** These are strong defaults, not chains. Deviations belong in your PR narrative, not in silence.
10. When in doubt about architecture or protocol changes, ask.

---

## Referenced by

This is the entry point. Nothing references it — everything is reached *through* it. `CLAUDE.md` at the repo root carries one pointer back to this file.
