# test-local.ps1 — fast pre-push test loop against the deployed demo.
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
#   .\scripts\test-local.ps1                    # full gate list (~5 min)
#   .\scripts\test-local.ps1 tests/billing-api.spec.js   # one spec (~30s)
#   .\scripts\test-local.ps1 -SkipUnit          # skip vitest
#   .\scripts\test-local.ps1 -BaseUrl http://127.0.0.1:5000  # local backend
#
# What it does:
#   1. cd backend && npm test (vitest unit gate, ~1.2s)
#   2. cd e2e && npx playwright test --project=chromium <specs> (BASE_URL=demo)
#   3. Exit non-zero if anything fails. Doesn't block commits — you decide.
#
# The spec list mirrors `.github/workflows/deploy.yml`'s "Run API-only specs"
# step. Update both together when adding a new gated spec.

param(
    [string[]]$Specs = @(),
    [string]$BaseUrl = "https://crm.globusdemos.com",
    [switch]$SkipUnit,
    [switch]$SkipApi,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

# ─── 1. Backend vitest (fast) ────────────────────────────────────────
if (-not $SkipUnit) {
    Write-Host ""
    Write-Host "=== 1. backend vitest (unit) ===" -ForegroundColor Cyan
    Push-Location backend
    try {
        npm test --silent 2>&1 | Tee-Object -Variable vitestOut | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host $vitestOut -ForegroundColor Red
            Write-Host "FAIL vitest failed (exit $LASTEXITCODE). Stopping." -ForegroundColor Red
            Pop-Location; Pop-Location
            exit $LASTEXITCODE
        }
        # Pull just the summary line
        ($vitestOut | Select-String "Test Files|Tests" | Select-Object -Last 2) | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
    } finally { Pop-Location }
}

# ─── 2. Playwright API specs ─────────────────────────────────────────
if (-not $SkipApi) {
    Write-Host ""
    Write-Host "=== 2. playwright api_tests gate ===" -ForegroundColor Cyan
    Write-Host "    BASE_URL = $BaseUrl"

    # Default to the canonical gate list from deploy.yml. Update both
    # when adding a new gated spec.
    if ($Specs.Count -eq 0) {
        $Specs = @(
            "tests/ci-smoke.spec.js",
            "tests/sms-api.spec.js",
            "tests/marketing-api.spec.js",
            "tests/reports-api.spec.js",
            "tests/sla-breach-api.spec.js",
            "tests/treatment-plans-api.spec.js",
            "tests/sequence-engine-api.spec.js",
            "tests/expenses-api.spec.js",
            "tests/projects-api.spec.js",
            "tests/ai-scoring-api.spec.js",
            "tests/contracts-api.spec.js",
            "tests/custom-objects-api.spec.js",
            "tests/cpq-api.spec.js",
            "tests/tasks-api.spec.js",
            "tests/estimates-api.spec.js",
            "tests/push-api.spec.js",
            "tests/communications-api.spec.js",
            "tests/notifications-api.spec.js",
            "tests/contacts-api.spec.js",
            "tests/deals-api.spec.js",
            "tests/surveys-api.spec.js",
            "tests/external-api.spec.js",
            "tests/wellness-clinical-api.spec.js",
            "tests/social-api.spec.js",
            "tests/email-api.spec.js",
            "tests/wellness-rbac-api.spec.js",
            "tests/auth-security-api.spec.js",
            "tests/route-contracts-api.spec.js",
            "tests/billing-api.spec.js",
            "tests/lead-routing-api.spec.js",
            "tests/teardown-completeness.spec.js",
            "tests/demo-hygiene-api.spec.js"
        )
    }

    Push-Location e2e
    try {
        $env:BASE_URL = $BaseUrl
        # E2E_SKIP_SCRUB=1 against demo: don't run global-teardown
        # (matches what e2e-full.yml does). Local-backend runs SHOULD
        # scrub — only set this when targeting demo.
        if ($BaseUrl -match "globusdemos\.com|globussoft\.com") {
            $env:E2E_SKIP_SCRUB = "1"
        } else {
            Remove-Item Env:E2E_SKIP_SCRUB -ErrorAction SilentlyContinue
        }

        $reporter = if ($Verbose) { "list" } else { "dot" }
        $args = @("playwright", "test", "--project=chromium", "--no-deps", "--reporter=$reporter") + $Specs
        npx @args
        $exitCode = $LASTEXITCODE
    } finally { Pop-Location }

    if ($exitCode -ne 0) {
        Write-Host ""
        Write-Host "FAIL playwright failed (exit $exitCode)" -ForegroundColor Red
        Pop-Location
        exit $exitCode
    }
}

Write-Host ""
Write-Host "OK all checks passed" -ForegroundColor Green
Pop-Location
