#!/usr/bin/env bash
# Weekly harness-gardening sweep: runs harness-lint.py and prints a report.
# Idempotent. No auto-fixes. Paired doc: harness-gardening.md
#
# Flags:
#   --strict  treat staleness / oversized warnings as errors
#   --json    machine-readable output (passes through to harness-lint.py)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LINT="${REPO_ROOT}/.harness/tools/harness-lint.py"

say()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32mok \033[0m%s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m%s\n" "$*"; }
die()  { printf "\033[1;31mxx \033[0m%s\n" "$*" >&2; exit 1; }

if ! command -v python3 >/dev/null; then
  die "python3 not found — install it; see dev-environment-setup.md"
fi

if [[ ! -f "${LINT}" ]]; then
  die "missing ${LINT} — this playbook expects the linter next to the playbook"
fi

say "harness gardening — running linter"
python3 "${LINT}" --root "${REPO_ROOT}/.harness" "$@"
rc=$?

if [[ ${rc} -eq 0 ]]; then
  ok "harness is valid"
  echo
  echo "suggested follow-up:"
  echo "  - open any file whose last_reviewed looks old, re-read it, bump the date"
  echo "  - if nothing to fix, close the loop here — silence is a pass"
  exit 0
else
  warn "harness-lint exited non-zero — read the report above, fix in a single PR"
  exit "${rc}"
fi
