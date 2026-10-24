#!/usr/bin/env bash
# Deploy the backend to the test SAM stack (pocketeng-backend-test, us-west-1).
# Refuses anything that smells like a real-prod deploy.
# Paired doc: deploy-to-test-stack.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
CONFIG_FILE="${BACKEND_DIR}/samconfig.test.toml"

EXPECTED_STACK="pocketeng-backend-test"
EXPECTED_REGION="us-west-1"

say()  { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m%s\n" "$*"; }
die()  { printf "\033[1;31mxx \033[0m%s\n" "$*" >&2; exit 1; }

# 0. Sanity
[[ -n "${AWS_PROFILE:-}" ]] || die "AWS_PROFILE not set — source .env.test first (set -a; source .env.test; set +a)"
[[ -f "${CONFIG_FILE}" ]]   || die "missing ${CONFIG_FILE} — ask the repo owner or see deploy-to-test-stack.md"
command -v sam >/dev/null   || die "sam CLI not installed — see dev-environment-setup.md"
command -v aws >/dev/null   || die "aws CLI not installed"

# 1. Parse + validate stack_name
STACK_NAME=$(awk -F'=' '/^[[:space:]]*stack_name[[:space:]]*=/ {gsub(/[ "]/,"",$2); print $2; exit}' "${CONFIG_FILE}" || true)
[[ -n "${STACK_NAME}" ]] || die "could not parse stack_name from ${CONFIG_FILE}"

# Whole-name prod checks (allows the literal "Stage=prod" parameter override).
if [[ "${STACK_NAME}" == *"-prod"* || "${STACK_NAME}" == *"-production"* || "${STACK_NAME}" == "pocketeng-backend-prod"* ]]; then
  die "stack_name '${STACK_NAME}' looks like a real prod stack — refusing. See deploy-to-test-stack.md."
fi
if [[ "${STACK_NAME}" != "${EXPECTED_STACK}" ]]; then
  warn "stack_name is '${STACK_NAME}', expected '${EXPECTED_STACK}'. Continuing because it's not a prod name, but double-check."
fi

# 2. Parse + validate region
REGION=$(awk -F'=' '/^[[:space:]]*region[[:space:]]*=/ {gsub(/[ "]/,"",$2); print $2; exit}' "${CONFIG_FILE}" || true)
[[ -n "${REGION}" ]] || die "could not parse region from ${CONFIG_FILE}"
if [[ "${REGION}" != "${EXPECTED_REGION}" ]]; then
  die "region '${REGION}' != expected '${EXPECTED_REGION}' — edit samconfig.test.toml or update this script with an approved reason"
fi

# 3. Caller identity
ACCT=$(aws sts get-caller-identity --profile "${AWS_PROFILE}" --query Account --output text)
say "deploying ${STACK_NAME} in ${REGION} (profile: ${AWS_PROFILE}, account: ${ACCT})"

# 4. Build + deploy
cd "${BACKEND_DIR}"
say "sam build"
sam build >/dev/null

say "sam deploy"
sam deploy --config-file "$(basename "${CONFIG_FILE}")" --no-confirm-changeset

# 5. Post-deploy — show the API URL and the reminder
API_URL=$(aws cloudformation describe-stacks \
  --profile "${AWS_PROFILE}" \
  --region "${REGION}" \
  --stack-name "${STACK_NAME}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl' || OutputKey=='HttpApiUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || echo "")

if [[ -n "${API_URL}" && "${API_URL}" != "None" ]]; then
  say "API URL: ${API_URL}"
  echo "    next → set in web/.env.local   : NEXT_PUBLIC_API_BASE_URL=${API_URL}"
  echo "    next → set in your shell       : export POCKETENG_API_BASE=${API_URL}"
  echo "    next → clear CLI caches        : rm -f ~/.pocketeng/servers/*.serverid"
  echo "    next → restart web dev server  : cd web && npm run dev"
else
  warn "could not discover API URL from stack outputs — check 'aws cloudformation describe-stacks --stack-name ${STACK_NAME}'"
fi
