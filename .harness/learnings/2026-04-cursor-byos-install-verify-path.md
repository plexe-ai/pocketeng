---
type: learning
status: canonical
last_reviewed: 2026-04-28
related:
  - protocols/testing-protocol.md
  - playbooks/browser-testing.md
tags: [learning, byos, cursor, install-agent, ssh, path]
---

# Cursor BYOS Install: Verify-Step Misses Binary Because Non-Interactive SSH Has No `~/.local/bin` on PATH (2026-04)

**When to read:** before changing `_install_agent` in `backend/src/chat.py`, or anywhere we run a `which <bin>` over paramiko on a BYOS box.
**When to update:** never edit the story. Add cross-links at the bottom as new related scars appear.

## One-line

`curl -fsSL https://cursor.com/install | bash` drops `agent` at `~/.local/bin/agent`, but paramiko's `exec_command` on Ubuntu BYOS doesn't source `~/.bashrc` (it returns early on non-interactive shells), so `which agent` reported `NOT_FOUND` and the lambda returned 500 — even though the install actually succeeded.

---

## Symptom

- BYOS Ubuntu server (paramiko via lambda → `ssh ubuntu@host`).
- User clicks "Add agent" → "Cursor", pastes their key, clicks Install.
- UI shows `<p class="text-danger">Installation failed: …</p>`.
- The verbatim error body included Cursor's own next-step instructions:
  `"Next Steps 1. Add ~/.local/bin to your PATH ..."` — the installer was telling us exactly what we were missing.
- SSHing in interactively, `which agent` returned `/home/ubuntu/.local/bin/agent`. Install had succeeded.

---

## Root cause

In `backend/src/chat.py::_install_agent`:

```python
verify_stdout, _, _ = ssh_exec(
    client,
    f'which {binary_name} 2>/dev/null || echo NOT_FOUND',
    timeout=10,
)
```

paramiko's `exec_command` (used by `ssh_exec`) starts a non-interactive, non-login shell. On Ubuntu, the default `~/.bashrc` returns at the top:

```bash
case $- in
  *i*) ;;       # interactive — keep going
  *) return;;   # non-interactive — bail before any export
esac
```

So the line `~/.profile` adds (`PATH="$HOME/.local/bin:$PATH"` if `~/.local/bin` exists) is never sourced for our SSH command — `~/.local/bin` is not on `PATH`, and `which agent` fails.

The flow ran into a second latent bug as soon as the verify was fixed: BYOS provision (`backend/src/provision.py`) stores `agents: None` when it can't auto-detect any installed agent (which it never could, for the same PATH reason). After the verify fix, install-agent reached a previously-unreachable line:

```python
updated_agents = list(server.get("agents", []) if server else [])
```

`get("agents", [])` returns `None` (not the default) when the key is present and explicitly null, so `list(None)` raised `TypeError: 'NoneType' object is not iterable` and the lambda returned 500 anyway.

---

## Fix

In `backend/src/chat.py::_install_agent`:

1. Prepend `~/.local/bin` to `PATH` *inside* the verify command, mirroring what the installer wrote:

   ```python
   verify_cmd = (
       'export PATH="$HOME/.local/bin:$PATH"; '
       f'which {binary_name} 2>/dev/null || echo NOT_FOUND'
   )
   ```

2. Persist that export to `~/.bashrc` idempotently after a successful install, matching `backend/src/lib/userdata.py::_cursor_install_block` for managed instances:

   ```python
   ssh_exec(
       client,
       "grep -q '/.local/bin' ~/.bashrc 2>/dev/null || "
       'echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc',
       timeout=5,
   )
   ```

3. Tolerate `agents: None` from BYOS provision when computing the new agent list:

   ```python
   updated_agents = list((server.get("agents") if server else None) or [])
   ```

---

## Tests that now guard this

- `backend/tests/test_install_agent.py::TestVerifyCommandHasLocalBinOnPath::test_cursor_verify_prepends_local_bin_to_path`
- `…::test_claude_verify_also_prepends_local_bin_to_path`
- `…::test_returns_500_when_binary_genuinely_missing`
- `…::test_returns_200_when_binary_found_under_local_bin`
- `backend/tests/test_install_agent.py::TestPersistsLocalBinPathToBashrc::test_persists_export_to_bashrc_idempotently`
- `…::test_does_not_persist_when_install_failed`
- `backend/tests/test_install_agent.py::TestHandlesAgentsNoneOnBYOS::test_install_succeeds_when_existing_agents_is_none`

Plus the BEFORE/AFTER browser pass at `test-screenshots/install-cursor-byos.mjs` against host `203.0.113.10`.

---

## Things that bit us while reproducing

- **Sidebar `Workspaces` link races with the `/dashboard` auto-redirect.** `app/dashboard/page.tsx` redirects to the most-recently-used session unless `?manage` is on the URL. Click the sidebar and you sometimes land on a session page instead of the workspace list. **Fix:** navigate directly to `/dashboard?manage` in browser tests.
- **BYOS connect dedups by `(userId, publicIp)` in `provision.py:155-187`.** A second connect for the same IP updates the existing record instead of creating a new one — and does not apply the typed label. To make tests reproducible, delete the existing DDB record between runs:
  ```bash
  aws dynamodb delete-item --region us-west-2 --table-name pe-servers-dev \
    --key '{"serverId":{"S":"<id>"}}'
  ```
- **DOM heuristics for "did install succeed" are fragile.** A naive `text=active` matcher false-positived on a Claude Code "ACTIVE" badge that lived inside a div whose subtree also contained the word "Cursor" (in "Enter your Cursor API key"). Replaced with capturing the lambda's HTTP response status (`200` vs `500`) via `page.on('response')` — the lambda is the source of truth.
- **`text=` locators are substring-matchers.** Using `'Reply with one word: pong'` as the prompt and `text=pong` as the assertion makes the user's own bubble match — the agent never has to respond. **Fix:** pick a prompt whose answer is *not* a substring of the prompt (e.g. `"Compute eleven plus four. Reply with just the integer, nothing else."` → match `text=15`).

---

## How to catch a regression fast

After deploying any change to `_install_agent`, on a real BYOS Ubuntu box:

```bash
ssh -i <key> ubuntu@<host> 'rm -rf ~/.local/bin/agent ~/.cursor 2>/dev/null'
# then in the UI: Add agent → Cursor → install
```

Expected: HTTP 200 from `POST /servers/<id>/chat`, body `{"status":"installed","agent":"cursor","agents":["cursor"]}`.

If you see `Installation failed: ... Next Steps 1. Add ~/.local/bin to your PATH ...` in the body, the verify-PATH guard regressed.

---

## See also

- [`../protocols/testing-protocol.md`](../protocols/testing-protocol.md) — real-data, real-browser rules; this scar fired exactly because we ran a real BYOS install end-to-end
- [`../playbooks/browser-testing.md`](../playbooks/browser-testing.md) — Playwright harness used for BEFORE/AFTER capture

## Referenced by

- (none yet)
