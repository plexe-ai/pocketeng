# Session Sync — Integration Protocol

> **Purpose.** This is the playbook for adding session-sync support for a new coding agent (OpenCode, Aider, etc.). Follow it step by step. Every pitfall listed below was hit during the Claude / Cursor / Codex integrations — do not rediscover them the hard way.
>
> **Audience.** Engineer about to add a new agent.
>
> **Companion reading.** `docs/session-sync-implementation.md` walks through the Claude-specific implementation in detail. This protocol is the generic harness that sits on top of it.

---

## 1. Mental model — three independent flows

Before writing any code, make sure you can sketch these four flows for the new agent without hand-waving:

| # | Flow | Owner |
|---|---|---|
| 1 | Local session → EC2 workspace (push) | Sync daemon in `pocketeng` CLI |
| 2 | EC2 session → Local machine (pull) | Sync daemon in `pocketeng` CLI |
| 3 | Local-synced session → PocketEng UI (ingest) | `chat.py::_register_synced_session` on the backend |
| 4 | UI-launched session → EC2 + UI transcript | `chat.py::_launch_turn` + bridge |

If you can't name the files + DynamoDB rows involved for each flow, you are not ready to code.

---

## 2. Invariants (non-negotiable)

Every new agent integration must preserve these rules. If you find yourself about to violate one, stop and ask before proceeding.

1. **Never mint a fake `remoteSessionId`.** The DDB `remoteSessionId` must be the agent's *real* internal session id — whatever UUID ends up inside its session filename on disk. Any other value will cause the sync daemon to round-trip the file and register it as a duplicate session.
2. **Round-trip must be idempotent.** Pushing a local session to EC2 and then syncing it back must not create new records, new files, or mutate state.
3. **Merge by `remoteSessionId + userId`, not by sessionId.** Different flows (cloud-launch vs local-sync) produce different PE `sessionId`s for the same conversation. The merge key is the agent's own id.
4. **Preserve existing `status` on merge.** A `status=done` cloud session must not regress to `status=from-laptop` just because a rsync pushed the rollout back up.
5. **Never inject a synthetic preamble into the model when the agent supports native resume.** The "You are continuing an ongoing conversation…" fallback is last-resort, not default.
6. **`system/init.session_id` is our internal PE id. Never treat it as the agent's remote id.** This mistake has bitten us twice. Always prefer the agent's own session-start event (e.g. `thread.started`) when extracting the remote id.
7. **Bidirectional sync must not clobber.** `rsync --update` (mtime-based) not `--delete`. The user's local rollouts are sacred.

---

## 3. Step-by-step protocol

Work in this order. Do not skip ahead. Each step has a gate that must pass before moving on.

### Phase A — Reality check (no mocks)

1. **Install the agent locally** and run a real session (`<agent> exec …` or equivalent). Confirm you can generate a rollout file without any PocketEng involvement.
2. **Find the rollout file on disk.** Record the canonical path pattern (e.g. `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`). Write this path convention down in `backend/src/lib/session_file_parser.py`.
3. **Capture a real rollout file** (copy it into `backend/tests/fixtures/` or similar). This becomes the fixture for your parser tests. **Do not synthesize a rollout** — you will get the schema wrong.
4. **Trigger a resume locally** and observe:
    - Does resume **append to the same file**, or create a new one?
    - Does the agent **re-emit a session-start event** with the same id?
    - What is the exact CLI / SDK call that triggers resume?

Write these three facts into a comment above your new bridge runner. They drive every downstream decision.

**Gate A:** you can produce a rollout file from a real session, and you can produce a resumed rollout file from a real resume call, both on your laptop. No PocketEng code runs yet.

### Phase B — Extraction & conversion

5. **Add an agent branch to `backend/src/lib/session_file_parser.py`.** Parse the rollout `.jsonl` into PE's internal transcript event format. Unit-test against the real fixture from step 3.
6. **Add an agent branch to `backend/src/lib/transcript.py`** (`_parse_event`, `materialize_transcript`). This is what the UI ultimately renders.
7. **Run the parser tests.** Every event type (`user`, `assistant`, tool calls, tool results) must round-trip cleanly.

**Gate B:** `pytest backend/tests/agents/test_session_extraction.py -q` passes, including your new fixture-based tests.

### Phase C — Bridge integration

8. **Add an agent runner to `backend/src/lib/bridge/bridge.mjs`** (`runClaude` / `runCursor` / `runCodex` are the existing patterns). The runner must:
    - Call the agent's SDK (or spawn its CLI) with the incoming prompt.
    - Emit normalized events (`assistant.message`, `tool.started`, `tool.finished`, `run.finished`) to both stdout (for the SSH poll path) and the `uploader` (for the ingest path).
    - **Capture the agent's real session id from its session-start event** and emit a `session.remote` uploader event with `{ remoteSessionId, agent }`. This is the reconciliation hook that prevents ghost UUIDs.
9. **Add a resume branch in the runner.** If the agent supports native resume, accept `--<agent>-resume <id>` and use the agent's resume call. Otherwise skip — the synthetic preamble fallback in `chat.py` will handle it.
10. **Verify `node --check backend/src/lib/bridge/bridge.mjs`** is clean.

**Gate C:** `node --check` passes. Unit tests for `ALLOWED_KINDS` in `session_events_ingest.py` still pass.

### Phase D — Backend plumbing

11. **Register the agent in `backend/src/lib/agents.py`.** Set `command`, `install_command`, `api_key_env`, `api_key_file`, `supports_model_flag`, `needs_bridge`.
12. **Add flag forwarding in `backend/src/lib/script_builder.py::build_agent_command`** — when `can_resume=True` append `--<agent>-resume <rsid>` (if the agent supports it).
13. **Add the `can_resume` probe in `backend/src/chat.py::_launch_turn`.** Copy the existing Codex branch verbatim and change the `find` path to match your agent's rollout directory. The probe must:
    - Only flip `can_resume=True` when the rollout file actually exists on EC2.
    - Fall back cleanly to a fresh session id when it doesn't.
14. **Update `session_events_ingest.py` if needed.** Usually no-op — `session.remote` is already generic.

**Gate D:** Full backend test suite passes: `cd backend && python3 -m pytest tests --ignore=tests/agents/test_integration.py -q`. Integration tests typically stay ignored — they require agent SDK binaries that aren't available locally.

### Phase E — Deploy + manual validation

15. **Deploy to the test stack** (`AWS_PROFILE=prod sam deploy --config-file samconfig.test.toml`). Never test against prod.
16. **Verify the bridge auto-deployed to EC2** on the next session launch: SSH in and `grep -c <your-new-flag> ~/.pocketeng/bridge/bridge.mjs`. The hash-based deploy in `bridge_deploy.py` should pick it up automatically; if it didn't, something is broken.
17. **Run the browser test harness** (see section 4). This is non-negotiable. Do not skip.

**Gate E:** all four browser checks (section 4) pass visually + on-disk.

---

## 4. The browser test harness — why it matters

### Why unit tests + API tests are not enough

- **Unit tests** can't catch: duplicate sidebar cards, wrong session labels, preamble text leaking into user-visible bubbles, stale "running" indicators, broken transcript rendering.
- **API tests** (e.g. curl to `POST /chat`) exercise the right backend code paths but can't see: what the UI actually rendered, what the user actually experienced.
- **Only a real browser session tells you** whether the fix actually landed the way a human perceives it.

**Two real bugs we shipped that only browser testing caught:**

- Claude integration initially looked green on unit tests, but the UI showed two session cards side-by-side on every follow-up turn. Invisible to API testing.
- Codex duplicate-session bug was only reproducible when clicking the UI Send button — because the synthetic preamble text only rendered into a new sidebar card after the sync daemon round-tripped the rollout, which required real time passing with a real sync daemon running.

### The harness (use this verbatim for every agent)

**Setup:**

```bash
# 1. Refresh Supabase JWT (expires every hour)
SB_URL=$(grep NEXT_PUBLIC_SUPABASE_URL web/.env.local | cut -d= -f2)
SB_KEY=$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY web/.env.local | cut -d= -f2)
curl -s "${SB_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${SB_KEY}" -H "Content-Type: application/json" \
  -d '{"email":"<test-user>","password":"<test-pass>"}' \
  | jq -r .access_token > ~/.pocketeng/token

# 2. Point the CLI at the test backend
export POCKETENG_API_BASE=https://<test-api-id>.execute-api.<region>.amazonaws.com/prod

# 3. Stop any lingering sync daemons + clear cached server ids
./pocketeng sync stop
rm -f ~/.pocketeng/servers/*.serverid

# 4. Confirm web/.env.local points NEXT_PUBLIC_API_BASE_URL at the same test API
grep NEXT_PUBLIC_API_BASE_URL web/.env.local
```

**The four scenarios that must pass in a real browser:**

| Scenario | Steps | What you're verifying |
|---|---|---|
| **S1 — Cloud-to-UI** | In the UI: New session → send prompt → wait for reply. | Session appears in sidebar, transcript renders, DDB `remoteSessionId` matches the real rollout UUID on EC2. |
| **S2 — UI follow-up (no duplicate)** | Continue the S1 session: type follow-up in composer → Send. | Sidebar count does **not** increase. Thread stays continuous. The text "You are continuing an ongoing conversation" **does not appear** anywhere. |
| **S3 — Native context** | Send a third turn that references turn 2's output without naming it (e.g. `"subtract 100"` or `"also tell me the size"`). | Agent's reply must be correct. This is only possible if native resume is working — transcript replay via preamble is suspicious. Use math or file-size chains, not greetings. |
| **S4 — Local-to-UI** | On your laptop: run the agent locally → let sync daemon push the rollout → refresh UI. | New session card appears with the conversation. Send a follow-up from the UI → verify it lands in the *same* rollout file on EC2, not a new one. |

**Evidence to capture on every scenario:**

- EC2 rollout file line count BEFORE and AFTER each turn (`ssh … wc -l <file>`).
- EC2 rollout file mtime — same file must be the one that changed.
- `grep -c "You are continuing" <rollout>` — must be **0** for every turn.
- DDB session count for the server (`aws dynamodb scan --select COUNT`) BEFORE and AFTER the follow-up — must not grow.
- DDB `remoteSessionId` — must match the rollout filename's UUID.
- UI screenshot at each step.

**If you can't produce all six pieces of evidence, the scenario has not been tested.**

### Using math/arithmetic as a context probe (strongly recommended)

A follow-up like `"say hello again"` tells you nothing — the agent might be reading the synthetic preamble. A follow-up like `"multiply that by 2"` **only works** if the agent natively remembers the previous turn. Use chains like:

1. `what is 17 * 23?` → expect `391`
2. `now multiply that by 2` → expect `782`
3. `subtract 100` → expect `682`

If the agent fails step 3, your resume probe is broken and you silently fell through to the preamble fallback. Unit tests will not catch this.

### If the browser MCP channel breaks mid-test

It has happened. Recovery path:

1. `browser_tabs action=list` → close all but one tab with `browser_tabs action=close viewId=…`.
2. `browser_snapshot` on the remaining tab to rebind refs.
3. Resume from the last completed step.
4. If still broken, start a fresh browser subagent. **Do not resort to curl to complete the test** — API parity is not UI parity.

---

## 5. Pitfalls we hit (read this list carefully)

Every item below was a real bug in our integration work. If you don't explicitly test for each, you will ship at least one of them.

### 5.1 Identity pitfalls

- **Ghost UUID.** Assigning a self-generated UUID as `remoteSessionId` when the agent assigns its own. The on-disk file has the agent's UUID; DDB has ours; sync round-trips the file and registers it as new. **Mitigation:** capture the agent's real id from its session-start event in the bridge and emit `session.remote` to reconcile DDB.
- **`system/init.session_id` confusion.** Our internal PE `sessionId` appears in a `system/init` event. It is NOT the agent's remote id. Always prefer the agent's native start event (e.g. Codex's `thread.started.thread_id`). See `chat.py::_persist_agent_output`.
- **Merge by sessionId.** Different flows (UI-launch vs local-sync) produce different PE `sessionId`s for the same conversation. Merge key must be `(remoteSessionId, userId)`, not sessionId.

### 5.2 Rendering / UX pitfalls

- **Synthetic preamble leaking to sidebar.** When `not can_resume` fires, `chat.py` prepends `"You are continuing an ongoing conversation…"` to the prompt. The agent writes that text into its rollout as the user message; the rollout rsyncs back; the sync daemon sees it and creates a sidebar card titled `"You are continuing…"`. **Mitigation:** make sure native resume works so the fallback rarely fires, AND when it does, verify the preamble text doesn't cascade into a sidebar card.
- **Status regression.** Merging a synced rollout into a `status=done` cloud session and unconditionally setting `status=from-laptop`. UI shows the session as "running from laptop" forever. **Mitigation:** only set `from-laptop` when the existing row was itself laptop-synced.
- **Stale "running" indicators.** Some agents emit tool-call-start events but not tool-call-end for long-running operations. The UI's tool-call chip stays in "running" state indefinitely. Known cosmetic issue — mention in the PR, don't block on it.

### 5.3 Infrastructure pitfalls

- **Bridge deploy hash mismatch.** `bridge_deploy.py` hashes the bridge files and re-SFTPs on hash change. If you edit a bridge file but the hash doesn't move (rare), the EC2 keeps the old version. **Mitigation:** after deploy, `ssh … grep -c <your-new-flag> ~/.pocketeng/bridge/bridge.mjs` must be non-zero before the first test turn.
- **JWT expires during long test sessions.** Supabase JWTs last 1h. Refresh before starting the harness. Watch for `HTTP/2 401 {"error": "Signature has expired"}`.
- **CLI pointing at prod.** `pocketeng` defaults to the prod API. Export `POCKETENG_API_BASE` AND clear `~/.pocketeng/servers/*.serverid` — stale server-id cache is registered against the prod backend.
- **AWS region collision.** The test stack must not share a region with prod or with another engineer's test stack. Change the region in `samconfig.test.toml` if in doubt and redeploy.
- **Trusted-directory check (Codex).** Codex CLI refuses to run outside a git repo. `git init` your test dir.
- **Non-interactive SSH + nvm.** BYOS servers often install Node via nvm, which `.bashrc` skips for non-interactive sessions. The bridge launch wrapper already sources `nvm.sh` — don't regress this.
- **macOS vs Linux EC2.** The repo supports both. `nohup`, `tail --pid`, and `bash -l` behave differently. See `CLAUDE.md` § "macOS vs Linux Differences".

### 5.4 Testing pitfalls

- **Mocking the agent.** Don't. The whole point of session-sync work is parsing real output. Mocks hide schema drift. Capture real rollouts, check them into `tests/fixtures/`.
- **Integration tests silently skipped.** `tests/agents/test_integration.py` requires agent SDK npm packages that aren't pre-installed. They fail with "Cannot find package '@anthropic-ai/claude-agent-sdk'". **This is expected** — those 30 tests are marked to be run in a separate env. Do not make them depend on your changes.
- **Leftover DDB rows from prior runs.** Old `synced…` rows with bad `remoteSessionId`s can poison merge logic in later tests. Before each round, scan the DDB sessions for your test server and either purge or note the baseline count.
- **Running the full test suite in parallel with a browser test.** `pytest` and the sync daemon contend over `~/.pocketeng/` caches. Run them serially.

---

## 6. Pre-merge checklist

Do not merge the PR until every item is checked. Paste this checklist into the PR description.

- [ ] Rollout file path convention documented in `session_file_parser.py`
- [ ] Real fixture captured into `tests/fixtures/` — no synthesized `.jsonl`
- [ ] Parser round-trips every event type in the fixture
- [ ] `session.remote` event emitted from the bridge with the agent's real id
- [ ] `can_resume` probe added to `_launch_turn`, mirroring existing Claude/Cursor/Codex branches
- [ ] Resume-flag plumbing in `build_agent_command` (if agent supports native resume)
- [ ] Full backend test suite passes (`pytest tests --ignore=tests/agents/test_integration.py -q`)
- [ ] `node --check backend/src/lib/bridge/bridge.mjs` clean
- [ ] Deployed to a test stack (not prod, not shared region)
- [ ] On EC2: `grep -c <new-flag> ~/.pocketeng/bridge/bridge.mjs` > 0 after first session launch
- [ ] Browser test S1 — cloud-to-UI: PASS, evidence captured
- [ ] Browser test S2 — UI follow-up no duplicate: PASS, sidebar count stable, zero "You are continuing"
- [ ] Browser test S3 — native context (math chain): PASS
- [ ] Browser test S4 — local-to-UI: PASS, rollout file stays singular
- [ ] DDB `remoteSessionId` matches rollout UUID on disk for every test session
- [ ] Screenshots attached to PR

---

## 7. When in doubt

- **"Should I add a branch here?"** — Compare the three existing branches (Claude, Cursor, Codex) in the same function. If your agent fits one of their patterns, copy it. If it doesn't, stop and ask — your agent might need an architectural discussion before you write code.
- **"Is this mock okay?"** — No.
- **"Should I skip the browser test for this small fix?"** — No. The Codex duplicate-session bug was hidden behind a "small fix" PR that passed every unit test.
- **"Should I merge even though one scenario fails?"** — No. File a follow-up issue if the failure is out-of-scope, fix it if it's in-scope. Never ship a partial green.

---

## 8. Reference implementations

| Agent | PR | Key files to study |
|---|---|---|
| Claude Code | `feat/session-sync-claude` (merged) | `session_file_parser.py`, `bridge.mjs::runClaude` |
| Cursor | same branch | `bridge.mjs::runCursor` (spawns CLI, reuses Claude event mapper) |
| Codex | `feat/session-sync-codex` | `bridge.mjs::runCodex`, `session_events_ingest.py` reconciliation, `chat.py::_register_synced_session` merge-by-rsid, the `thread.started` preference in `_persist_agent_output` |

Study the Codex PR especially — it includes all three types of fix (bridge event emission, backend reconciliation, native resume wiring) and has the most complete browser test evidence.
