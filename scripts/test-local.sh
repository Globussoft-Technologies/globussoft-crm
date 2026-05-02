#!/usr/bin/env bash
# test-local.sh — fast pre-push test loop against the deployed demo.
#
# Why this exists:
#   Waiting for `deploy.yml` to spin up MySQL, seed, boot a backend, and
#   run the gate spec list takes 10-12 minutes per push. For most spec-
#   level changes (locators, asserts, fixtures) the deployed demo is a
#   perfectly good target — the code under test is already running there.
#
# Trade-off:
#   This runs specs against `https://crm.globusdemos.com`. If you've only
#   touched test files, you're good. If you've touched ROUTE code that
#   isn't deployed yet, you're testing the OLD route — push first, wait
#   for deploy, then re-run.
#
# Usage:
#   scripts/test-local.sh                          # full gate list (~5 min)
#   scripts/test-local.sh tests/billing-api.spec.js  # one spec (~30s)
#   scripts/test-local.sh --skip-unit              # skip vitest
#   BASE_URL=http://127.0.0.1:5000 scripts/test-local.sh   # local backend
#
# What it does:
#   1. cd backend && npm test (vitest unit gate, ~1.2s)
#   2. cd e2e && npx playwright test --project=chromium <specs> (BASE_URL=demo)
#   3. Exit non-zero if anything fails. Doesn't block commits.
#
# The spec list mirrors `.github/workflows/deploy.yml`'s "Run API-only specs"
# step. Update both together when adding a new gated spec.

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKIP_UNIT=0
SKIP_API=0
VERBOSE=0
SPECS=()
BASE_URL="${BASE_URL:-https://crm.globusdemos.com}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-unit) SKIP_UNIT=1; shift ;;
    --skip-api)  SKIP_API=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --base-url) BASE_URL="$2"; shift 2 ;;
    tests/*) SPECS+=("$1"); shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── 1. Backend vitest ───────────────────────────────────────────────
if [[ $SKIP_UNIT -eq 0 ]]; then
  echo ""
  echo "═══ 1. backend vitest (unit) ═══"
  pushd backend > /dev/null
  if ! npm test --silent 2>&1 | tail -5; then
    rc=$?
    echo "✘ vitest failed (exit $rc). Stopping." >&2
    popd > /dev/null
    exit $rc
  fi
  popd > /dev/null
fi

# ─── 2. Playwright API specs ─────────────────────────────────────────
if [[ $SKIP_API -eq 0 ]]; then
  echo ""
  echo "═══ 2. playwright api_tests gate ═══"
  echo "    BASE_URL = $BASE_URL"

  if [[ ${#SPECS[@]} -eq 0 ]]; then
    SPECS=(
      tests/ci-smoke.spec.js
      tests/sms-api.spec.js
      tests/marketing-api.spec.js
      tests/reports-api.spec.js
      tests/sla-breach-api.spec.js
      tests/treatment-plans-api.spec.js
      tests/sequence-engine-api.spec.js
      tests/expenses-api.spec.js
      tests/projects-api.spec.js
      tests/ai-scoring-api.spec.js
      tests/contracts-api.spec.js
      tests/custom-objects-api.spec.js
      tests/cpq-api.spec.js
      tests/tasks-api.spec.js
      tests/estimates-api.spec.js
      tests/push-api.spec.js
      tests/communications-api.spec.js
      tests/notifications-api.spec.js
      tests/contacts-api.spec.js
      tests/deals-api.spec.js
      tests/surveys-api.spec.js
      tests/external-api.spec.js
      tests/wellness-clinical-api.spec.js
      tests/social-api.spec.js
      tests/email-api.spec.js
      tests/wellness-rbac-api.spec.js
      tests/auth-security-api.spec.js
      tests/route-contracts-api.spec.js
      tests/billing-api.spec.js
      tests/lead-routing-api.spec.js
      tests/teardown-completeness.spec.js
      tests/demo-hygiene-api.spec.js
    )
  fi

  pushd e2e > /dev/null
  export BASE_URL
  # E2E_SKIP_SCRUB=1 against demo (matches e2e-full.yml). Local-backend
  # runs SHOULD scrub — only set when targeting demo.
  if [[ "$BASE_URL" == *globusdemos.com* || "$BASE_URL" == *globussoft.com* ]]; then
    export E2E_SKIP_SCRUB=1
  else
    unset E2E_SKIP_SCRUB
  fi

  REPORTER="dot"
  [[ $VERBOSE -eq 1 ]] && REPORTER="list"

  if npx playwright test --project=chromium --no-deps "--reporter=$REPORTER" "${SPECS[@]}"; then
    popd > /dev/null
  else
    rc=$?
    popd > /dev/null
    echo ""
    echo "✘ playwright failed (exit $rc)" >&2
    exit $rc
  fi
fi

echo ""
echo "✓ all checks passed"
