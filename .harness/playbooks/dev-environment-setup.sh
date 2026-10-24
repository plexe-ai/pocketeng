#!/usr/bin/env bash
# Idempotent bootstrap for a PocketEng dev machine.
# Re-run any time. Exits non-zero on the first hard failure.
#
# Paired doc: dev-environment-setup.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BRIDGE_LOCAL="${HOME}/.pocketeng/bridge"
BRIDGE_SRC="${REPO_ROOT}/backend/src/lib/bridge"

say() { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m%s\n" "$*"; }
die() { printf "\033[1;31mxx \033[0m%s\n" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "PocketEng dev bootstrap — repo root: ${REPO_ROOT}"

# --- prereqs (manual install) ---
for bin in python3 node npm jq rg aws sam gh; do
  if ! have "$bin"; then
    warn "missing: $bin — install it manually (see dev-environment-setup.md), then re-run"
    MISSING=1
  fi
done
[[ "${MISSING:-0}" == "1" ]] && die "install the missing tools above and re-run"

# --- backend python deps ---
say "installing backend Python deps into ~/.local"
python3 -m pip install --user -r "${REPO_ROOT}/backend/requirements.txt" >/dev/null
python3 -m pip install --user boto3 pytest >/dev/null
case ":${PATH}:" in
  *":${HOME}/.local/bin:"*) ;;
  *) warn "~/.local/bin not on PATH — add it to your shell rc for pytest to work" ;;
esac

# --- web deps ---
if [[ -f "${REPO_ROOT}/web/package.json" ]]; then
  say "installing web deps"
  (cd "${REPO_ROOT}/web" && npm install --silent)
else
  warn "web/package.json not found — skipping"
fi

# --- bridge local copy + codex SDK ---
say "ensuring bridge artifacts at ${BRIDGE_LOCAL}"
mkdir -p "${BRIDGE_LOCAL}"
if [[ -d "${BRIDGE_SRC}" ]]; then
  # copy any .mjs that is missing or stale
  find "${BRIDGE_SRC}" -maxdepth 1 -name '*.mjs' -print0 | \
    xargs -0 -I{} cp -u "{}" "${BRIDGE_LOCAL}/"
else
  warn "bridge source not found at ${BRIDGE_SRC} — skipping copy"
fi

if [[ -d "${BRIDGE_LOCAL}" ]]; then
  (cd "${BRIDGE_LOCAL}" && {
    [[ -f package.json ]] || npm init -y >/dev/null
    # Best-effort: install only if not present. These SDKs are public.
    node -e "require.resolve('@openai/codex-sdk')" 2>/dev/null \
      || npm install --silent --no-audit --no-fund @openai/codex-sdk || \
         warn "could not install @openai/codex-sdk — integration tests that need it will skip"
  })
fi

# --- env file reminders ---
for f in "web/.env.local" "backend/samconfig.toml"; do
  if [[ ! -f "${REPO_ROOT}/${f}" ]]; then
    warn "missing ${f} — see dev-environment-setup.md + references/env-variables.md"
  fi
done

say "done"
say "verify next:"
echo "  cd backend && python3 -m pytest tests -q --ignore=tests/agents/test_integration.py"
echo "  cd web && npm run build"
echo "  cd backend/src/lib/bridge && node --test"
