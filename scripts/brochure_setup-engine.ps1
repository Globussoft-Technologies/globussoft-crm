# brochure_setup-engine.ps1 — one-command setup for the Brochure Engine.
#
# The Brochure Engine (Travel vertical, /travel/brochures) is powered by a
# vendored sibling workspace, `agentic-orchcrm/`, that lives OUTSIDE git tracking
# (it's ~495MB with node_modules + bundled Chromium, and carries its own secret
# `.env`). So every machine that runs the CRM backend needs the engine installed
# once. This script does the whole thing:
#
#   1. clones agentic-orchcrm next to backend/ (or pulls latest if already there)
#   2. npm install inside it (tsx + ~170MB puppeteer Chromium — ~5 min first run)
#   3. scaffolds agentic-orchcrm/.env from .env.example (never overwrites yours)
#   4. verifies the engine with a no-API-key catalog smoke test
#
# After it finishes, paste ONE provider key into agentic-orchcrm/.env and you're
# done — the engine reads .env fresh on every brochure run (no backend restart).
#
# Usage (from anywhere — paths are resolved relative to this script):
#   .\scripts\brochure_setup-engine.ps1
#   .\scripts\brochure_setup-engine.ps1 -Force     # reinstall deps even if node_modules exists
#
# macOS / Linux devs: a sibling brochure_setup-engine.sh provides the same flow.

param([switch]$Force)

$ErrorActionPreference = "Stop"

$ENGINE_REPO = "https://github.com/muralidharans-glb/Agentic_orchcrm.git"
$root = Split-Path -Parent $PSScriptRoot          # repo root (scripts/ is one level down)
$engineDir = Join-Path $root "agentic-orchcrm"

Write-Host ""
Write-Host "=== Brochure Engine setup ===" -ForegroundColor Cyan

# --- 0. prerequisites -----------------------------------------------------
foreach ($cmd in @("git", "node", "npm")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "FAIL: '$cmd' is not on your PATH. Install it and re-run." -ForegroundColor Red
        exit 1
    }
}

# --- 1. clone (or pull) the engine ---------------------------------------
if (Test-Path (Join-Path $engineDir ".git")) {
    Write-Host "[1/4] engine already cloned - pulling latest" -ForegroundColor Green
    Push-Location $engineDir
    try { git pull --ff-only } finally { Pop-Location }
} elseif (Test-Path $engineDir) {
    Write-Host "[1/4] $engineDir exists but is not a git clone - leaving it as-is" -ForegroundColor Yellow
} else {
    Write-Host "[1/4] cloning engine into agentic-orchcrm/ ..." -ForegroundColor Cyan
    git clone $ENGINE_REPO $engineDir
}

# --- 2. install deps (idempotent unless -Force) --------------------------
$nodeModules = Join-Path $engineDir "node_modules"
if ((Test-Path $nodeModules) -and (-not $Force)) {
    Write-Host "[2/4] node_modules present - skipping install (use -Force to reinstall)" -ForegroundColor Green
} else {
    Write-Host "[2/4] npm install (downloads ~170MB Chromium on first run, ~5 min) ..." -ForegroundColor Cyan
    Push-Location $engineDir
    try { npm install } finally { Pop-Location }
}

# --- 3. scaffold .env (NEVER overwrite an existing one) ------------------
$envFile = Join-Path $engineDir ".env"
$envExample = Join-Path $engineDir ".env.example"
if (Test-Path $envFile) {
    Write-Host "[3/4] .env already exists - your keys are left untouched" -ForegroundColor Green
} elseif (Test-Path $envExample) {
    Copy-Item $envExample $envFile
    Write-Host "[3/4] created agentic-orchcrm/.env from .env.example" -ForegroundColor Cyan
} else {
    Write-Host "[3/4] no .env.example found - create agentic-orchcrm/.env manually" -ForegroundColor Yellow
}

# --- 4. verify (catalog mode needs NO API key) ---------------------------
Write-Host "[4/4] verifying engine (catalog smoke test) ..." -ForegroundColor Cyan
$smoke = $null
Push-Location $engineDir
try {
    $env:BROCHURE_MODE = "catalog"
    $smoke = node node_modules/tsx/dist/cli.mjs apps/orchestrator/src/crm-bridge.ts 2>$null | Select-Object -Last 1
} finally {
    Remove-Item Env:\BROCHURE_MODE -ErrorAction SilentlyContinue
    Pop-Location
}
if ($smoke -match '"ok"\s*:\s*true') {
    Write-Host "      engine OK" -ForegroundColor Green
} else {
    Write-Host "      WARNING: catalog smoke test did not return ok:true." -ForegroundColor Yellow
    Write-Host "      Output: $smoke" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Green
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Open agentic-orchcrm/.env and paste at least ONE provider key, e.g."
Write-Host "       OPENAI_API_KEY=sk-..."
Write-Host "       GROQ_API_KEY=gsk_..."
Write-Host "     (only models from keyed providers show as available in the picker.)"
Write-Host "  2. No backend restart needed - the engine reads .env fresh on every run."
Write-Host "  3. Log in as a Travel admin -> Brochure Engine -> pick a Prompt -> Generate."
Write-Host ""
