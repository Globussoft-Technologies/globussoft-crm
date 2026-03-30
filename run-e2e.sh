#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run-e2e.sh  --  Install dependencies and execute the Playwright E2E suite
# Usage:
#   ./run-e2e.sh                     Run all tests (headless)
#   ./run-e2e.sh --headed            Run with browser visible
#   ./run-e2e.sh --debug             Run with Playwright inspector
#   ./run-e2e.sh --ui                Run Playwright UI mode
#   ./run-e2e.sh auth                Run only auth tests
#   ./run-e2e.sh dashboard           Run only dashboard tests
#   ./run-e2e.sh contacts            Run only contacts tests
#   ./run-e2e.sh pipeline            Run only pipeline tests
#   ./run-e2e.sh navigation          Run only navigation tests
#   ./run-e2e.sh api                 Run only API health tests
#   ./run-e2e.sh report              Open the HTML report
# ---------------------------------------------------------------------------

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$SCRIPT_DIR/e2e"

# Resolve BASE_URL — default to production demo site
export BASE_URL="${BASE_URL:-https://crm.globusdemos.com}"

echo ""
echo "========================================="
echo "  Globussoft CRM E2E Test Runner"
echo "  Target: $BASE_URL"
echo "========================================="
echo ""

# Install dependencies if node_modules is missing
if [ ! -d "$E2E_DIR/node_modules" ]; then
  echo "[setup] Installing Playwright dependencies..."
  cd "$E2E_DIR"
  npm install
  npx playwright install chromium firefox
  cd "$SCRIPT_DIR"
fi

cd "$E2E_DIR"

# Parse arguments
case "${1:-}" in
  "--headed")
    echo "[run] Running all tests in headed mode..."
    npx playwright test --headed
    ;;

  "--debug")
    echo "[run] Running in debug mode with Playwright inspector..."
    npx playwright test --debug
    ;;

  "--ui")
    echo "[run] Launching Playwright UI mode..."
    npx playwright test --ui
    ;;

  "report")
    echo "[run] Opening HTML report..."
    npx playwright show-report
    ;;

  "auth")
    echo "[run] Running auth tests only..."
    npx playwright test tests/auth.spec.js --project=auth-tests
    ;;

  "dashboard")
    echo "[run] Running dashboard tests only..."
    npx playwright test tests/dashboard.spec.js
    ;;

  "contacts")
    echo "[run] Running contacts tests only..."
    npx playwright test tests/contacts.spec.js
    ;;

  "pipeline")
    echo "[run] Running pipeline tests only..."
    npx playwright test tests/pipeline.spec.js
    ;;

  "navigation")
    echo "[run] Running navigation tests only..."
    npx playwright test tests/navigation.spec.js
    ;;

  "api")
    echo "[run] Running API health tests only..."
    npx playwright test tests/api-health.spec.js --project=api-health
    ;;

  "ci")
    echo "[run] Running full CI suite with JUnit output..."
    npx playwright test --reporter=html,junit
    ;;

  *)
    echo "[run] Running full E2E test suite..."
    npx playwright test
    ;;
esac

EXIT_CODE=$?

echo ""
echo "========================================="
echo "  Test run complete. Exit code: $EXIT_CODE"
echo "  Report: $E2E_DIR/playwright-report/index.html"
echo "========================================="
echo ""

exit $EXIT_CODE
