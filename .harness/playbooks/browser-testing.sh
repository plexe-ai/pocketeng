#!/usr/bin/env bash
# Install + preflight for Playwright-based browser testing.
# Idempotent. Paired doc: browser-testing.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/test-screenshots"
ENV_FILE="${REPO_ROOT}/web/.env.local"
HARNESS_DIR="${HOME}/.pocketeng/browser-harness"

say()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32mok \033[0m%s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m%s\n" "$*"; }
die()  { printf "\033[1;31mxx \033[0m%s\n" "$*" >&2; exit 1; }

say "browser-testing preflight + install"

command -v node >/dev/null || die "node not found — see dev-environment-setup.md"

# 1. Playwright (shared install so all repos reuse it)
mkdir -p "${HARNESS_DIR}"
(
  cd "${HARNESS_DIR}"
  if [[ ! -f package.json ]]; then
    npm init -y >/dev/null
  fi
  if ! node -e "require.resolve('playwright')" 2>/dev/null; then
    say "installing playwright (first run — ~60s)"
    npm install --silent --no-audit --no-fund playwright >/dev/null
    npx --yes playwright install chromium --with-deps >/dev/null 2>&1 \
      || npx --yes playwright install chromium >/dev/null
  fi
)
ok "playwright ready at ${HARNESS_DIR}"

# 2. Run output folder
mkdir -p "${OUT_DIR}"
GI="${REPO_ROOT}/.gitignore"
if [[ -f "${GI}" ]] && ! grep -qE '^test-screenshots/?$' "${GI}"; then
  warn "'test-screenshots/' is not in .gitignore yet — add it; browser runs produce large local artifacts"
fi
ok "run outputs will land under ${OUT_DIR}/<ts>/"

# 3. Web dev server reachable
if curl -sSf -m 2 -o /dev/null http://localhost:3000/; then
  ok "web dev server responding on :3000"
else
  warn "web dev server not reachable on :3000 — start it with: cd web && npm run dev"
fi

# 4. Env file + API base sanity
#
# Note: our only non-prod stack today uses API Gateway stage "prod" literally,
# so we can't reject purely on substring. Instead: require the URL to be present,
# and print it loudly so the operator confirms it's the test stack. If/when a
# real-prod stack exists, add its exact hostname to the refuse list below.
if [[ ! -f "${ENV_FILE}" ]]; then
  die "missing ${ENV_FILE} — see dev-environment-setup.md"
fi
API_BASE=$(grep -E '^NEXT_PUBLIC_API_BASE_URL=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"')
if [[ -z "${API_BASE}" ]]; then
  die "NEXT_PUBLIC_API_BASE_URL not set in ${ENV_FILE} — see references/env-variables.md"
fi
# Hard refuse list — hostnames that are known-prod. Add to this list when a real prod stack lands.
KNOWN_PROD_HOSTS=(
  # "api.pocketeng.ai"
)
for h in "${KNOWN_PROD_HOSTS[@]}"; do
  if [[ "${API_BASE}" == *"${h}"* ]]; then
    die "API base '${API_BASE}' matches known-prod host '${h}' — refusing to browser-test against prod"
  fi
done
ok "API base: ${API_BASE}"
warn "confirm this is the TEST stack (us-west-1) before you continue — see deploy-to-test-stack.md"

# 5. Test creds hint — do NOT print values
for v in PE_TEST_EMAIL PE_TEST_PASSWORD; do
  if [[ -z "${!v:-}" ]]; then
    warn "env ${v} not set — the example script needs it"
  fi
done

# 6. /tmp/pe-* leftovers
if [[ -n "$(find /tmp -maxdepth 1 -name 'pe-*' -print -quit 2>/dev/null)" ]]; then
  warn "/tmp/pe-* leftovers exist — consider cleanup-between-runs.sh"
fi

say "ready — copy the template, adapt it, run:"
echo "  NODE_PATH=${HARNESS_DIR}/node_modules node .harness/playbooks/browser-testing.example.mjs"
echo "  (it will print the run-folder path when done — open the screenshots and video there)"
