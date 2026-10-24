---
type: playbook
status: canonical
last_reviewed: 2026-04-23
related:
  - playbooks/cleanup-between-runs.sh
  - protocols/testing-protocol.md
  - protocols/safety-protocol.md
  - playbooks/browser-testing.md
tags: [playbook, cleanup, state]
---

# Cleanup Between Runs

**When to read:** before any multi-scenario test pass that depends on clean state.
**When to update:** when the set of state we clean changes (new table, new local dir).

## Summary

Test runs that inherit stale state are the #1 source of false negatives. This playbook wipes: test DDB rows, local test workspaces under `/tmp/pe-*`, stale CLI caches, and running sync daemons we don't need. Idempotent and safe.

The script only touches **test-stack** tables and clearly-marked temp dirs. It refuses to run against a prod-looking stack.

---

## What gets cleaned

| Target | Why |
|---|---|
| `pe-sessions-test`, `pe-messages-test`, `pe-session-events-test` rows where `serverId` matches known test workspaces | Stale sessions from the last run |
| `/tmp/pe-*/` local directories | Leftover paired workspace trees |
| `~/.pocketeng/servers/*.serverid` | Stale CLI server-ID cache that silently points at prod |
| `pocketeng` sync daemon processes in test paths | Daemons from last run that could interfere |

Not touched:

- Prod tables (`*-prod`).
- The production `~/.pocketeng/config` or auth.
- Anything under your repo tree.

---

## Run the script

```bash
AWS_PROFILE=<test-profile> STACK_HINT=test bash .harness/playbooks/cleanup-between-runs.sh
```

Required:

- `AWS_PROFILE` — test profile. Script refuses if the profile's account has no `pe-*-test` tables.
- `STACK_HINT` — string that must appear in table names (default: `test`). Belt-and-suspenders: if you accidentally export a prod profile, this still has to match.

---

## What the script asks you before deleting

For each target class it prints the count and waits for `y` unless `ASSUME_YES=1` is set. Example:

```
Found 12 sessions + 43 messages across test workspaces. Delete? [y/N]
```

Never set `ASSUME_YES=1` against a profile you're not 100% sure about.

---

## After it runs

A summary like:

```
Deleted: sessions=12 messages=43 events=8
Removed: /tmp/pe-claude-abc /tmp/pe-cursor-v /tmp/pe-codex-x
Cleared: 3 serverid cache files
Killed : 2 sync daemons in test paths
```

At this point you are ready to run [`browser-testing.md`](browser-testing.md).

---

## When in doubt — nuke only the local state

If the DDB-side cleanup is making you nervous, run the local-only subset by hand:

```bash
rm -rf /tmp/pe-* ~/.pocketeng/servers/*.serverid
pgrep -fl 'pocketeng.*sync' | grep /tmp/pe- | awk '{print $1}' | xargs -r kill
```

This is always safe.

---

## See also

- [`cleanup-between-runs.sh`](cleanup-between-runs.sh) — the script
- [`browser-testing.md`](browser-testing.md) — what you typically do right after
- [`../protocols/safety-protocol.md`](../protocols/safety-protocol.md) — why we gate destructive ops

## Referenced by

- `README.md`
- `protocols/testing-protocol.md`
- `playbooks/browser-testing.md`
