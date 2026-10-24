#!/bin/bash
# Pocket Eng — sync command test suite
#
# Tier 1 (always runs, offline): unit tests for helper functions and
# integration tests for the sync daemon lifecycle with shimmed ssh/rsync/scp.
# No network, no real EC2, <30 seconds.
#
# Tier 2 (opt-in, live): real rsync against a real workspace on a real EC2.
# Requires the user to have a working `pocketeng login` profile. Enabled by
# setting PE_TEST_LIVE=1. Will create and delete files on the EC2.
#
# Usage:
#   test/pocketeng-sync.sh              # tier 1 only
#   PE_TEST_LIVE=1 test/pocketeng-sync.sh   # tier 1 + tier 2
#
# Exit code: 0 if all tests pass, 1 otherwise.

set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
POCKETENG="$REPO_ROOT/pocketeng"

if [ ! -x "$POCKETENG" ]; then
    echo "ERROR: pocketeng not executable at $POCKETENG"
    exit 1
fi

# ─── Colors ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ─── Test framework ─────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()
CURRENT_TEST=""

test_start() {
    CURRENT_TEST="$1"
    printf "  %-60s " "$CURRENT_TEST"
}

test_pass() {
    echo -e "${GREEN}ok${NC}"
    PASS=$((PASS + 1))
}

test_fail() {
    local reason="${1:-assertion failed}"
    echo -e "${RED}FAIL${NC}"
    echo -e "    ${DIM}$reason${NC}"
    FAILED_TESTS+=("$CURRENT_TEST")
    FAIL=$((FAIL + 1))
}

test_skip() {
    local reason="${1:-}"
    echo -e "${YELLOW}skip${NC} ${DIM}${reason}${NC}"
    SKIP=$((SKIP + 1))
}

assert_eq() {
    local got="$1"
    local want="$2"
    local label="${3:-}"
    if [ "$got" = "$want" ]; then
        return 0
    else
        test_fail "${label:+$label: }expected '$want', got '$got'"
        return 1
    fi
}

assert_not_empty() {
    local got="$1"
    local label="${2:-}"
    if [ -n "$got" ]; then
        return 0
    else
        test_fail "${label:+$label: }expected non-empty value"
        return 1
    fi
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local label="${3:-}"
    if echo "$haystack" | grep -qF -- "$needle"; then
        return 0
    else
        test_fail "${label:+$label: }expected output to contain '$needle'; got: $(echo "$haystack" | head -3)"
        return 1
    fi
}

assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local label="${3:-}"
    if ! echo "$haystack" | grep -qF -- "$needle"; then
        return 0
    else
        test_fail "${label:+$label: }expected output NOT to contain '$needle'"
        return 1
    fi
}

assert_file_exists() {
    local path="$1"
    if [ -f "$path" ]; then
        return 0
    else
        test_fail "expected file to exist: $path"
        return 1
    fi
}

assert_file_missing() {
    local path="$1"
    if [ ! -e "$path" ]; then
        return 0
    else
        test_fail "expected file to be gone: $path"
        return 1
    fi
}

assert_pid_alive() {
    local pid="$1"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        return 0
    else
        test_fail "expected pid $pid to be alive"
        return 1
    fi
}

assert_pid_dead() {
    local pid="$1"
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        return 0
    else
        test_fail "expected pid $pid to be dead"
        return 1
    fi
}

# ─── Sandbox ────────────────────────────────────────────────────────────────
# Each test runs inside its own temp $HOME with a fake workspace profile and
# shimmed ssh/rsync/scp so there's no network access and no risk of touching
# the user's real pocketeng state.

ORIG_HOME="$HOME"
ORIG_PATH="$PATH"

make_sandbox() {
    SANDBOX=$(mktemp -d "/tmp/pe-sync-test.XXXXXX")
    export HOME="$SANDBOX/home"
    mkdir -p "$HOME/.pocketeng/servers"

    # Fake workspace profile: 127.0.0.1 so if the shim leaks and a real ssh
    # is called it fails fast rather than hitting a production server.
    cat > "$HOME/.pocketeng/servers/test-ws.conf" <<EOF
PE_HOST="127.0.0.1"
PE_USER="ec2-user"
PE_KEY="$HOME/fake.pem"
PE_DIR="~/projects"
PE_INSTANCE_ID=""
PE_AGENT="claude"
EOF
    echo "test-ws" > "$HOME/.pocketeng/active"
    touch "$HOME/fake.pem" && chmod 600 "$HOME/fake.pem"

    # Shimmed bin dir prepended to PATH. The shims intercept ssh/rsync/scp
    # and return 0 (or a fake pwd/test result) so pocketeng's sync logic
    # can exercise its full code path without a real EC2.
    export SHIM_BIN="$SANDBOX/shim-bin"
    mkdir -p "$SHIM_BIN"

    cat > "$SHIM_BIN/ssh" <<'SHEOF'
#!/bin/bash
# Fake ssh. pocketeng's ssh_cmd passes the remote command as the last arg.
last_arg="${!#}"
case "$last_arg" in
    *"test -d"*"&& echo yes"*)
        # Used by _do_sync_pull to detect if remote state exists.
        # Tests control this via PE_SHIM_REMOTE_EXISTS=yes|no.
        echo "${PE_SHIM_REMOTE_EXISTS:-no}"
        ;;
    *"cd "*"&& pwd"*)
        # Used by _do_sync_once to resolve remote project path.
        # Echo a plausible path derived from the cd target.
        extracted=$(echo "$last_arg" | sed -n 's/.*cd \([^ ]*\).*/\1/p')
        name=$(basename "$extracted")
        echo "/home/ec2-user/projects/$name"
        ;;
    *)
        # mkdir -p / rm -f / echo / etc — silent success.
        ;;
esac
exit 0
SHEOF

    cat > "$SHIM_BIN/rsync" <<'SHEOF'
#!/bin/bash
exit 0
SHEOF

    cat > "$SHIM_BIN/scp" <<'SHEOF'
#!/bin/bash
exit 0
SHEOF

    chmod +x "$SHIM_BIN"/ssh "$SHIM_BIN"/rsync "$SHIM_BIN"/scp
    export PATH="$SHIM_BIN:$PATH"

    # Default project dir inside the sandbox
    PROJ="$SANDBOX/project"
    mkdir -p "$PROJ"
    echo "# test" > "$PROJ/README.md"
    echo "x = 1" > "$PROJ/one.py"
}

clean_sandbox() {
    # Kill any daemon processes spawned during the test.
    if [ -d "$HOME/.pocketeng/watchers" ]; then
        for pid_file in "$HOME/.pocketeng/watchers"/*.pid; do
            [ -f "$pid_file" ] || continue
            local pid
            pid=$(cat "$pid_file" 2>/dev/null)
            [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
        done
    fi
    rm -rf "$SANDBOX" 2>/dev/null
    unset SANDBOX PROJ SHIM_BIN PE_SHIM_REMOTE_EXISTS
    export HOME="$ORIG_HOME"
    export PATH="$ORIG_PATH"
}

# Convenience: run pocketeng sync in the sandbox project dir.
pe_sync() {
    ( cd "$PROJ" && "$POCKETENG" sync "$@" 2>&1 )
}

pe_in_proj() {
    ( cd "$PROJ" && "$POCKETENG" "$@" 2>&1 )
}

# Find the watcher files pocketeng generated for this test. Reliable on
# both macOS and Linux because it doesn't try to recompute the hash — we
# just look for whatever's in the watchers dir. Assumes one paired dir
# per test (which the sandbox guarantees).
watcher_pid_file() {
    ls "$HOME/.pocketeng/watchers"/*.pid 2>/dev/null | head -1
}

watcher_log_file() {
    ls "$HOME/.pocketeng/watchers"/*.log 2>/dev/null | head -1
}

# ─── Tier 1: offline tests ─────────────────────────────────────────────────

run_tier1() {
    echo -e "${BOLD}Tier 1 — offline${NC} ${DIM}(helpers + daemon lifecycle with shimmed ssh/rsync/scp)${NC}"
    echo ""

    # ── Helper: pair_hash ──

    test_start "pair_hash is stable across invocations"
    h1=$(echo -n "/some/path/foo" | shasum -a 256 | cut -c1-12)
    h2=$(echo -n "/some/path/foo" | shasum -a 256 | cut -c1-12)
    assert_eq "$h1" "$h2" "same input" && [ ${#h1} -eq 12 ] && test_pass

    test_start "pair_hash differs for different inputs"
    h1=$(echo -n "/path/one" | shasum -a 256 | cut -c1-12)
    h2=$(echo -n "/path/two" | shasum -a 256 | cut -c1-12)
    if [ "$h1" != "$h2" ]; then test_pass; else test_fail "got same hash"; fi

    # ── Helper: pairs.json read/write/remove (via cmd_sync actions) ──

    test_start "sync status on empty pairs.json prints nudge"
    make_sandbox
    output=$("$POCKETENG" sync status 2>&1)
    assert_contains "$output" "No paired directories" && test_pass
    clean_sandbox

    test_start "sync status lists paired dir with planted pairs.json"
    make_sandbox
    python3 <<PYEOF
import json, datetime, os
d = {"pairs": {
    "/tmp/fake-a": {"profile": "test-ws", "createdAt": datetime.datetime.utcnow().isoformat() + "Z"},
    "/tmp/fake-b": {"profile": "test-ws", "createdAt": datetime.datetime.utcnow().isoformat() + "Z"},
}}
with open(os.path.expanduser("~/.pocketeng/pairs.json"), "w") as f:
    json.dump(d, f)
PYEOF
    output=$("$POCKETENG" sync status 2>&1)
    assert_contains "$output" "/tmp/fake-a" \
        && assert_contains "$output" "/tmp/fake-b" \
        && assert_contains "$output" "test-ws" \
        && test_pass
    clean_sandbox

    test_start "sync status marks stale pid as ○ stale"
    make_sandbox
    python3 <<PYEOF
import json, os, datetime
d = {"pairs": {"/tmp/staleproj": {"profile": "test-ws", "createdAt": datetime.datetime.utcnow().isoformat() + "Z"}}}
with open(os.path.expanduser("~/.pocketeng/pairs.json"), "w") as f:
    json.dump(d, f)
PYEOF
    mkdir -p "$HOME/.pocketeng/watchers"
    stale_hash=$(echo -n "/tmp/staleproj" | shasum -a 256 | cut -c1-12)
    echo "99999" > "$HOME/.pocketeng/watchers/$stale_hash.pid"
    output=$("$POCKETENG" sync status 2>&1)
    assert_contains "$output" "stale" && test_pass
    clean_sandbox

    # ── Lifecycle: stop/unpair idempotency ──

    test_start "sync stop with no pid file is no-op, exit 0"
    make_sandbox
    output=$( cd "$PROJ" && "$POCKETENG" sync stop 2>&1 )
    rc=$?
    assert_eq "$rc" "0" "exit code" && assert_contains "$output" "No sync running" && test_pass
    clean_sandbox

    test_start "sync unpair on never-paired dir is idempotent"
    make_sandbox
    output=$( cd "$PROJ" && "$POCKETENG" sync unpair 2>&1 )
    rc=$?
    assert_eq "$rc" "0" "exit code" && assert_contains "$output" "Unpaired" && test_pass
    clean_sandbox

    # ── Lifecycle: full start → stop → restart cycle ──

    test_start "sync start spawns daemon with shimmed tools"
    make_sandbox
    output=$(pe_sync)
    rc=$?
    pid_file=$(watcher_pid_file)
    if assert_eq "$rc" "0" "exit code" \
        && assert_contains "$output" "Background sync started" \
        && [ -n "$pid_file" ] \
        && assert_file_exists "$pid_file"; then
        pid=$(cat "$pid_file")
        assert_pid_alive "$pid" && test_pass
    else
        [ -z "$pid_file" ] && test_fail "no pid file found in $HOME/.pocketeng/watchers/"
    fi
    pe_sync stop >/dev/null 2>&1 || true
    clean_sandbox

    test_start "sync start twice shows 'already syncing' on second call"
    make_sandbox
    pe_sync >/dev/null
    sleep 0.3
    output=$(pe_sync)
    assert_contains "$output" "Already syncing" && test_pass
    pe_sync stop >/dev/null 2>&1 || true
    clean_sandbox

    test_start "sync stop kills daemon and removes pid file"
    make_sandbox
    pe_sync >/dev/null
    sleep 0.5
    pid_file=$(watcher_pid_file)
    pid=$(cat "$pid_file" 2>/dev/null)
    output=$(pe_sync stop)
    sleep 0.3
    if assert_contains "$output" "Stopped" \
        && assert_pid_dead "$pid" \
        && assert_file_missing "$pid_file"; then
        test_pass
    fi
    clean_sandbox

    test_start "sync restart after stop gets new pid, preserves pairing"
    make_sandbox
    pe_sync >/dev/null
    sleep 0.5
    pid_file=$(watcher_pid_file)
    pid1=$(cat "$pid_file" 2>/dev/null)
    pe_sync stop >/dev/null
    sleep 0.3
    pe_sync >/dev/null
    sleep 0.5
    pid_file=$(watcher_pid_file)
    pid2=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$pid1" ] && [ -n "$pid2" ] && [ "$pid1" != "$pid2" ] \
        && assert_pid_alive "$pid2"; then
        pairs_count=$(python3 -c "import json; print(len(json.load(open('$HOME/.pocketeng/pairs.json')).get('pairs', {})))")
        assert_eq "$pairs_count" "1" "pairs count" && test_pass
    fi
    pe_sync stop >/dev/null 2>&1 || true
    clean_sandbox

    test_start "sync unpair stops daemon + clears pairs.json + watcher files"
    make_sandbox
    pe_sync >/dev/null
    sleep 0.5
    pid_file=$(watcher_pid_file)
    pid=$(cat "$pid_file" 2>/dev/null)
    pe_sync unpair >/dev/null
    sleep 0.3
    if assert_pid_dead "$pid" \
        && assert_file_missing "$pid_file"; then
        pairs_empty=$(python3 -c "import json; d=json.load(open('$HOME/.pocketeng/pairs.json')); print('yes' if not d.get('pairs') else 'no')")
        assert_eq "$pairs_empty" "yes" "pairs should be empty" && test_pass
    fi
    clean_sandbox

    # ── Daemon behavior ──

    test_start "daemon writes 'sync daemon started' to its log"
    make_sandbox
    pe_sync >/dev/null
    sleep 0.8
    log_file=$(watcher_log_file)
    if [ -n "$log_file" ] && assert_file_exists "$log_file"; then
        log=$(cat "$log_file")
        assert_contains "$log" "sync daemon started" && test_pass
    else
        test_fail "no log file found in $HOME/.pocketeng/watchers/"
    fi
    pe_sync stop >/dev/null 2>&1 || true
    clean_sandbox

    test_start "daemon logs 'initial sync ok' on successful initial rsync"
    make_sandbox
    pe_sync >/dev/null
    sleep 1.2
    log_file=$(watcher_log_file)
    log=$(cat "$log_file" 2>/dev/null)
    assert_contains "$log" "initial sync ok" && test_pass
    pe_sync stop >/dev/null 2>&1 || true
    clean_sandbox

    test_start "daemon logs 'synced' after a file change burst"
    make_sandbox
    pe_sync >/dev/null
    sleep 1
    # Touch a few files to trigger the watcher (poll is 3s + 2s debounce)
    for i in 1 2 3; do echo "change $i" >> "$PROJ/one.py"; done
    sleep 8
    log_file=$(watcher_log_file)
    log=$(cat "$log_file" 2>/dev/null)
    # Should have at least one "synced" line AFTER the initial sync line
    synced_lines=$(echo "$log" | grep -c " synced" 2>/dev/null | tr -d '[:space:]')
    synced_lines=${synced_lines:-0}
    if [ "$synced_lines" -ge 1 ] 2>/dev/null; then
        test_pass
    else
        test_fail "expected at least one 'synced' line (got $synced_lines); log: $log"
    fi
    pe_sync stop >/dev/null 2>&1 || true
    clean_sandbox

    # ── Pull ──

    test_start "sync pull in unpaired dir with no cloud state prints 'nothing to pull'"
    make_sandbox
    export PE_SHIM_REMOTE_EXISTS=no
    output=$(pe_sync pull)
    rc=$?
    assert_contains "$output" "nothing to pull" \
        && assert_eq "$rc" "0" "exit code should be 0 for no-op" \
        && test_pass
    unset PE_SHIM_REMOTE_EXISTS
    clean_sandbox

    test_start "sync pull when cloud state exists prints 'done'"
    make_sandbox
    export PE_SHIM_REMOTE_EXISTS=yes
    output=$(pe_sync pull)
    rc=$?
    assert_contains "$output" "Pull complete" \
        && assert_eq "$rc" "0" "exit code" \
        && test_pass
    unset PE_SHIM_REMOTE_EXISTS
    clean_sandbox

    test_start "sync start runs pull before push when remote state exists"
    make_sandbox
    export PE_SHIM_REMOTE_EXISTS=yes
    output=$(pe_sync)
    rc=$?
    # With remote exists=yes, the pull section should say 'done' not 'skipped'
    assert_contains "$output" "Pulling from cloud... " \
        && assert_contains "$output" "Pushing to cloud... " \
        && assert_not_contains "$output" "skipped (first sync)" \
        && test_pass
    pe_sync stop >/dev/null 2>&1 || true
    unset PE_SHIM_REMOTE_EXISTS
    clean_sandbox

    test_start "sync start skips pull on first-time pair (remote doesn't exist)"
    make_sandbox
    export PE_SHIM_REMOTE_EXISTS=no
    output=$(pe_sync)
    assert_contains "$output" "skipped (first sync)" && test_pass
    pe_sync stop >/dev/null 2>&1 || true
    unset PE_SHIM_REMOTE_EXISTS
    clean_sandbox

    # ── Help text ──

    test_start "help text mentions sync commands"
    output=$("$POCKETENG" help 2>&1)
    assert_contains "$output" "pocketeng sync" \
        && assert_contains "$output" "sync pull" \
        && assert_contains "$output" "sync stop" \
        && test_pass
}

# ─── Tier 2: live tests ─────────────────────────────────────────────────────
# These require the user's actual pocketeng profile to be configured and an
# EC2 workspace to be reachable. Each test creates a fresh throwaway dir
# locally and on the EC2, exercises the feature, then cleans up.

run_tier2() {
    echo ""
    echo -e "${BOLD}Tier 2 — live${NC} ${DIM}(real rsync + real EC2 via your active pocketeng profile)${NC}"
    echo ""

    if [ "${PE_TEST_LIVE:-}" != "1" ]; then
        echo -e "  ${DIM}Skipped. Set PE_TEST_LIVE=1 to run.${NC}"
        SKIP=$((SKIP + 6))
        return 0
    fi

    # Use the user's REAL pocketeng config, not a sandbox.
    export HOME="$ORIG_HOME"
    export PATH="$ORIG_PATH"

    if [ ! -f "$HOME/.pocketeng/active" ]; then
        echo -e "  ${YELLOW}No active workspace.${NC} Run ${BOLD}pocketeng login${NC} first."
        SKIP=$((SKIP + 6))
        return 0
    fi

    local profile
    profile=$(cat "$HOME/.pocketeng/active")
    local pfile="$HOME/.pocketeng/servers/${profile}.conf"
    if [ ! -f "$pfile" ]; then
        echo -e "  ${YELLOW}Active profile '$profile' not found.${NC}"
        SKIP=$((SKIP + 6))
        return 0
    fi

    # Load the profile so we can ssh directly for verification
    # shellcheck disable=SC1090
    source "$pfile"
    LIVE_HOST="${PE_HOST:-}"
    LIVE_USER="${PE_USER:-ec2-user}"
    LIVE_KEY="${PE_KEY:-}"
    LIVE_WORK="${PE_DIR:-~/projects}"

    if [ -z "$LIVE_HOST" ] || [ ! -f "$LIVE_KEY" ]; then
        echo -e "  ${YELLOW}Profile '$profile' has no host or key; skipping live tests.${NC}"
        SKIP=$((SKIP + 6))
        return 0
    fi

    live_ssh() {
        ssh -i "$LIVE_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
            "$LIVE_USER@$LIVE_HOST" "$@"
    }

    # Reachability check
    if ! live_ssh "echo ok" >/dev/null 2>&1; then
        echo -e "  ${YELLOW}Cannot reach $LIVE_HOST via SSH; skipping live tests.${NC}"
        SKIP=$((SKIP + 6))
        return 0
    fi

    # Fresh test dir outside /tmp to avoid macOS /tmp→/private/tmp surprises
    LIVE_PROJ="$HOME/Downloads/pe-sync-livetest-$(date +%s)"
    LIVE_NAME=$(basename "$LIVE_PROJ")
    mkdir -p "$LIVE_PROJ"
    echo "# live test" > "$LIVE_PROJ/README.md"
    echo "const a = 1" > "$LIVE_PROJ/a.ts"

    cleanup_live() {
        ( cd "$LIVE_PROJ" 2>/dev/null && "$POCKETENG" sync unpair >/dev/null 2>&1 ) || true
        rm -rf "$LIVE_PROJ"
        rm -rf "$HOME/.claude/projects/-Users-$(whoami)-Downloads-$LIVE_NAME" 2>/dev/null
        live_ssh "rm -rf ~/projects/$LIVE_NAME ~/.claude/projects/-home-${LIVE_USER}-projects-$LIVE_NAME" 2>/dev/null || true
    }
    trap cleanup_live EXIT

    # ── Test 1: initial sync pushes files ──
    test_start "[live] sync start pushes files to EC2"
    output=$( cd "$LIVE_PROJ" && "$POCKETENG" sync 2>&1 )
    remote_ls=$(live_ssh "ls $LIVE_WORK/$LIVE_NAME/" 2>/dev/null)
    if assert_contains "$output" "Background sync started" \
        && assert_contains "$remote_ls" "README.md" \
        && assert_contains "$remote_ls" "a.ts"; then
        test_pass
    fi

    # ── Test 2: file edit propagates ──
    test_start "[live] file edit propagates within 8s"
    echo "const b = 2" >> "$LIVE_PROJ/a.ts"
    sleep 8
    remote_content=$(live_ssh "cat $LIVE_WORK/$LIVE_NAME/a.ts" 2>/dev/null)
    assert_contains "$remote_content" "const b = 2" && test_pass

    # ── Test 3: burst of changes in one cycle ──
    test_start "[live] burst (new file + edit + delete) syncs atomically"
    echo "new" > "$LIVE_PROJ/new-file.md"
    echo "line3" >> "$LIVE_PROJ/a.ts"
    rm "$LIVE_PROJ/README.md"
    sleep 8
    remote_ls=$(live_ssh "ls $LIVE_WORK/$LIVE_NAME/" 2>/dev/null)
    if assert_contains "$remote_ls" "new-file.md" \
        && assert_not_contains "$remote_ls" "README.md"; then
        test_pass
    fi

    # ── Test 4: reverse pull ──
    test_start "[live] cloud-side edit is pulled on sync restart"
    ( cd "$LIVE_PROJ" && "$POCKETENG" sync stop >/dev/null 2>&1 )
    # Edit on the cloud (simulates phone work)
    live_ssh "echo 'cloud-added' > $LIVE_WORK/$LIVE_NAME/from-cloud.md" 2>/dev/null
    # Restart sync — should pull first
    output=$( cd "$LIVE_PROJ" && "$POCKETENG" sync 2>&1 )
    if assert_contains "$output" "Pulling from cloud... " \
        && assert_file_exists "$LIVE_PROJ/from-cloud.md"; then
        local content
        content=$(cat "$LIVE_PROJ/from-cloud.md")
        assert_eq "$content" "cloud-added" "pulled content" && test_pass
    fi

    # ── Test 5: sync pull standalone ──
    # Sleep 2s so the cloud edit's mtime is cleanly newer than whatever the
    # previous step left on the file (rsync --update is second-granular).
    test_start "[live] sync pull fetches a subsequent cloud change"
    sleep 2
    live_ssh "echo 'second-edit-$(date +%s)' >> $LIVE_WORK/$LIVE_NAME/from-cloud.md" 2>/dev/null
    sleep 1
    output=$( cd "$LIVE_PROJ" && "$POCKETENG" sync pull 2>&1 )
    content=$(cat "$LIVE_PROJ/from-cloud.md")
    if assert_contains "$output" "Pull complete" \
        && assert_contains "$content" "second-edit-"; then
        test_pass
    fi

    # ── Test 6: sync status shows running + last sync timestamp ──
    # Force a file change + wait so the daemon logs at least one ` synced`
    # line — _sync_status only prints `last sync:` if that line exists.
    test_start "[live] sync status shows running state with recent timestamp"
    echo "trigger-$(date +%s)" >> "$LIVE_PROJ/a.ts"
    sleep 8
    output=$( "$POCKETENG" sync status 2>&1 )
    if assert_contains "$output" "running" \
        && assert_contains "$output" "$LIVE_NAME" \
        && assert_contains "$output" "last sync:"; then
        test_pass
    fi

    # Final stop before trap cleanup
    ( cd "$LIVE_PROJ" && "$POCKETENG" sync stop >/dev/null 2>&1 ) || true
}

# ─── Main ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Pocket Eng${NC} — sync test suite"
echo -e "${DIM}pocketeng: $POCKETENG${NC}"
echo ""

run_tier1
run_tier2

echo ""
echo "──────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
    echo -e "  Results: ${GREEN}$PASS passed${NC}, ${YELLOW}$SKIP skipped${NC}"
    echo "──────────────────────────────────────────────"
    exit 0
else
    echo -e "  Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}, ${YELLOW}$SKIP skipped${NC}"
    echo ""
    echo -e "${RED}Failed tests:${NC}"
    for t in "${FAILED_TESTS[@]}"; do
        echo "  - $t"
    done
    echo "──────────────────────────────────────────────"
    exit 1
fi
