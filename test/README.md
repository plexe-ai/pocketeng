# Pocket Eng test suite

Tests for the top-level `pocketeng` bash CLI. Regression protection for
features that don't fit inside the Python backend test suite (which lives
in `backend/tests/`).

## Running

```bash
# Tier 1 only — offline, safe, ~25s
./test/pocketeng-sync.sh

# Tier 1 + Tier 2 — hits your real EC2 via your active pocketeng profile
PE_TEST_LIVE=1 ./test/pocketeng-sync.sh
```

Exit code is 0 if everything passes, 1 if anything fails.

## What's tested

### `pocketeng-sync.sh` — `pocketeng sync` commands

**Tier 1** (20 tests, no network, no real EC2):

Runs each test inside a throwaway `$HOME` with a fake workspace profile and
shimmed `ssh`/`rsync`/`scp` binaries on `PATH`. The shims return success
and fake the handful of commands pocketeng actually uses (`mkdir -p`,
`test -d`, `cd && pwd`), so the full sync code path exercises without
touching a real EC2.

- **Helper functions**: `pair_hash` stability, `pairs.json` read/write/get/remove
- **`sync status`**: empty pairs, populated pairs, stale pid detection
- **Lifecycle**: start → stop → restart preserves pairing, unpair clears everything
- **Idempotency**: `sync stop` on never-started is no-op, double `sync start` says "already syncing"
- **Daemon behavior**: writes pid file, logs `sync daemon started`, logs `initial sync ok`, logs `synced` after a file-change burst
- **Reverse pull**: `sync pull` with and without cloud state, `sync start` skips pull on first-time pair but runs pull on return visit
- **Help text**: mentions `sync`, `sync pull`, `sync stop`

Tests are hermetic — each one creates a fresh sandbox, kills any daemon it
spawned, and tears down its `$HOME` before the next test runs. A failing
test never contaminates subsequent tests.

**Tier 2** (6 tests, opt-in via `PE_TEST_LIVE=1`):

Uses your real `~/.pocketeng` config and your active workspace profile.
Creates a fresh throwaway project at `~/Downloads/pe-sync-livetest-<timestamp>`,
pushes it to the real EC2, exercises the feature end-to-end, then cleans up
both locally and on the EC2.

- **Push**: `sync start` actually pushes files to the EC2 via real rsync
- **Incremental sync**: a local file edit propagates to the EC2 within ~8s
- **Burst handling**: new file + edit + delete in one debounced cycle
- **Reverse pull**: cloud-side edit is pulled into local on `sync` restart
- **`sync pull` standalone**: a subsequent cloud edit is pulled on demand
- **Status**: `sync status` shows `running` with a `last sync:` timestamp

The live tests require:
- `pocketeng login` to have been run (active profile in `~/.pocketeng/active`)
- SSH connectivity to that profile's EC2
- The EC2 to be running

If any of these aren't met, tier 2 tests skip with a clear message.

## Adding a new test

1. Write a new `test_start "<name>"` block inside `run_tier1` or `run_tier2`
2. Set up state with `make_sandbox` (tier 1) or use `$LIVE_PROJ` (tier 2)
3. Run `pe_sync` (tier 1) or `"$POCKETENG"` directly against the real profile (tier 2)
4. Use `assert_eq`, `assert_contains`, `assert_file_exists`, `assert_pid_alive`, etc.
5. Call `test_pass` when the asserts all pass, `test_fail "reason"` otherwise
6. Tier 1: always end with `clean_sandbox` (even on failure)
7. Tier 2: the `trap cleanup_live EXIT` handles teardown automatically

## Known shim limitations

The tier 1 shims don't actually transfer files — they just return success.
Tests that need to verify byte-level transfer (e.g., "the cloud has the
exact content I pushed") belong in tier 2 against a real EC2.

If you add a new code path that calls `ssh_cmd` with a command the shim
doesn't recognize, the shim falls through to "return 0" which might hide
a real bug. Check the `ssh` shim in `make_sandbox` and add any new command
patterns you need.
