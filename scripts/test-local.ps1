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
#   .\scripts\test-local.ps1                       # full gate vs demo (~5 min)
#   .\scripts\test-local.ps1 tests/billing-api.spec.js   # one spec (~30s)
#   .\scripts\test-local.ps1 -Local                # full gate vs LOCAL Docker stack
#   .\scripts\test-local.ps1 -Local -KeepStack     # don't tear down after
#   .\scripts\test-local.ps1 -SkipUnit             # skip vitest
#   .\scripts\test-local.ps1 -BaseUrl http://...   # custom URL
#
# Modes:
#   default (no flag) — runs against https://crm.globusdemos.com.
#       Fast for SPEC-LEVEL iteration. WARNING: tests the deployed code,
#       not your local working tree. If you've changed routes locally,
#       results are misleading until you push.
#
#   -Local            — runs against http://127.0.0.1:5000 backed by
#       the docker-compose MySQL stack. Tests YOUR local code. The
#       canonical "did I break anything before push" check.
#       Auto-boots the stack via local-stack-up.ps1 if it isn't running;
#       tears down via local-stack-down.ps1 unless -KeepStack is set.
#
# The spec list mirrors `.github/workflows/deploy.yml`'s "Run API-only specs"
# step. Update both together when adding a new gated spec.

param(
    [string[]]$Specs = @(),
    [string]$BaseUrl = "",
    [switch]$Local,           # use Docker Compose stack at http://127.0.0.1:5000
    [switch]$KeepStack,       # leave the local stack running after tests (faster re-runs)
    [switch]$SkipUnit,
    [switch]$SkipApi,
    [switch]$Verbose
)

# Resolve BaseUrl based on mode. -Local overrides -BaseUrl.
if ($Local) {
    $BaseUrl = "http://127.0.0.1:5000"
} elseif (-not $BaseUrl) {
    $BaseUrl = "https://crm.globusdemos.com"
}

# Safeguard: warn if running against demo with backend code modified locally.
# Catches the trap where a route fix appears to "still fail" because demo is
# running the old (deployed) code, not your local edits.
if (-not $Local -and ($BaseUrl -match "globusdemos\.com|globussoft\.com")) {
    $dirtyBackend = git diff --name-only HEAD 2>$null | Where-Object { $_ -match "^backend/" }
    $stagedBackend = git diff --name-only --cached 2>$null | Where-Object { $_ -match "^backend/" }
    if ($dirtyBackend -or $stagedBackend) {
        Write-Host ""
        Write-Host "WARNING: backend/ files have uncommitted changes:" -ForegroundColor Yellow
        @($dirtyBackend) + @($stagedBackend) | Where-Object { $_ } | Sort-Object -Unique | ForEach-Object {
            Write-Host "  $_" -ForegroundColor Yellow
        }
        Write-Host "You're testing against demo, which runs the deployed (old) code." -ForegroundColor Yellow
        Write-Host "For route changes, use -Local instead OR push first then re-run." -ForegroundColor Yellow
        Write-Host ""
    }
}

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

# ─── 0. (-Local only) auto-boot the Docker stack if it isn't up ──────
$stackBootedByThisRun = $false
if ($Local -and -not $SkipApi) {
    # Probe /api/health — already running?
    $alreadyUp = $false
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200 -and $r.Content -match '"healthy"') { $alreadyUp = $true }
    } catch { }
    if ($alreadyUp) {
        Write-Host "    (local stack already running — reusing)" -ForegroundColor DarkGray
    } else {
        Write-Host ""
        Write-Host "=== 0. boot local Docker stack ===" -ForegroundColor Cyan
        & (Join-Path $PSScriptRoot "local-stack-up.ps1")
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAIL: local-stack-up failed (exit $LASTEXITCODE)" -ForegroundColor Red
            Pop-Location
            exit $LASTEXITCODE
        }
        $stackBootedByThisRun = $true
    }
}

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

# ─── (-Local only) auto-teardown unless -KeepStack ───────────────────
if ($stackBootedByThisRun -and -not $KeepStack) {
    Write-Host ""
    Write-Host "=== teardown local stack ===" -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "local-stack-down.ps1")
}
if ($Local -and $KeepStack) {
    Write-Host "    (-KeepStack: local stack still running for re-runs)" -ForegroundColor DarkGray
}

Pop-Location
