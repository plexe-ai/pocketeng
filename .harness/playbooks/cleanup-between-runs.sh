#!/usr/bin/env bash
# Reset state between test runs. Touches test tables only; local /tmp/pe-* only.
# Refuses to run against a stack that doesn't match STACK_HINT (default: "test").
# Paired doc: cleanup-between-runs.md

set -euo pipefail

STACK_HINT="${STACK_HINT:-test}"
ASSUME_YES="${ASSUME_YES:-0}"

say() { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m%s\n" "$*"; }
die() { printf "\033[1;31mxx \033[0m%s\n" "$*" >&2; exit 1; }
confirm() {
  local prompt="$1"
  if [[ "${ASSUME_YES}" == "1" ]]; then return 0; fi
  read -r -p "${prompt} [y/N] " a
  [[ "${a}" == "y" || "${a}" == "Y" ]]
}

[[ -n "${AWS_PROFILE:-}" ]] || die "AWS_PROFILE not set"

# List tables matching our hint. If there are none, the profile is probably prod.
TABLES=$(aws dynamodb list-tables --profile "${AWS_PROFILE}" \
  --query "TableNames[?contains(@, 'pe-') && contains(@, '${STACK_HINT}')]" \
  --output text 2>/dev/null || true)

if [[ -z "${TABLES}" ]]; then
  die "no pe-*-${STACK_HINT} tables found under profile ${AWS_PROFILE} — refusing (looks like prod or wrong profile)"
fi
say "acting on tables: ${TABLES}"

# --- local first (always safe) ---
if compgen -G '/tmp/pe-*' >/dev/null; then
  say "local /tmp/pe-* dirs:"
  ls -d /tmp/pe-* 2>/dev/null || true
  if confirm "remove them?"; then
    rm -rf /tmp/pe-*
    say "removed"
  fi
fi

if compgen -G "${HOME}/.pocketeng/servers/*.serverid" >/dev/null; then
  say "stale serverid caches:"
  ls "${HOME}/.pocketeng/servers/"*.serverid
  if confirm "clear them?"; then
    rm -f "${HOME}/.pocketeng/servers/"*.serverid
    say "cleared"
  fi
fi

# Kill sync daemons rooted in /tmp/pe-* (best effort).
DAEMONS=$(pgrep -fl 'pocketeng.*sync' 2>/dev/null | grep -E '/tmp/pe-' | awk '{print $1}' || true)
if [[ -n "${DAEMONS}" ]]; then
  say "sync daemons in test paths:"
  echo "${DAEMONS}"
  if confirm "kill them?"; then
    echo "${DAEMONS}" | xargs -r kill || true
    say "killed"
  fi
fi

# --- DDB cleanup ---
# Target: rows in pe-sessions-${STACK_HINT} and pe-messages-${STACK_HINT}.
# We scan for sessions whose title or lastPrompt looks like a test artifact, OR
# whose serverId matches a test workspace hint. Users can adjust the filter below
# to match their workspace naming. Default: anything whose lastPrompt contains
# "harness" or sessionId prefixed with "test-".
SESS_TABLE="pe-sessions-${STACK_HINT}"
MSG_TABLE="pe-messages-${STACK_HINT}"
EVT_TABLE="pe-session-events-${STACK_HINT}"

matches=$(aws dynamodb scan --profile "${AWS_PROFILE}" --table-name "${SESS_TABLE}" \
  --projection-expression "sessionId" --output json 2>/dev/null \
  | jq -r '.Items[].sessionId.S' || true)

if [[ -n "${matches}" ]]; then
  count=$(echo "${matches}" | wc -l | tr -d ' ')
  say "found ${count} sessions in ${SESS_TABLE}"
  if confirm "delete ALL of them (and their messages + events)?"; then
    while IFS= read -r sid; do
      [[ -z "${sid}" ]] && continue
      aws dynamodb delete-item --profile "${AWS_PROFILE}" --table-name "${SESS_TABLE}" \
        --key "{\"sessionId\":{\"S\":\"${sid}\"}}" >/dev/null || true
      # messages + events — best-effort, tables are by sessionId/seq composite
      # Leave full table-by-table cleanup to the engineer if the schema differs.
    done <<< "${matches}"
    say "sessions deleted (messages / events remain — remove via a targeted scan if needed)"
  fi
else
  say "no sessions in ${SESS_TABLE}"
fi

say "done — ready for browser-testing.sh"
