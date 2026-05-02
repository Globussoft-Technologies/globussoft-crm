# local-stack-up.ps1 — boot the local Docker MySQL + seed + start backend.
#
# What it does:
#   1. `docker compose up -d mysql`
#   2. Polls `mysqladmin ping` until MySQL is healthy (~10-15s)
#   3. Runs `prisma db push --accept-data-loss` against the local DB
#   4. Seeds both tenants via prisma/seed.js + seed-wellness.js
#   5. Starts the backend on 127.0.0.1:5000 in a detached process
#   6. Polls /api/health until the backend reports "healthy"
#   7. Writes the backend PID to .scripts-state/backend.pid
#
# When this finishes, you can run:
#   .\scripts\test-local.ps1 -Local
# OR hit the backend directly at http://127.0.0.1:5000.
#
# To tear down: .\scripts\local-stack-down.ps1
#
# All env vars are set as overrides — your project-root .env file is
# NOT modified.

param(
    [switch]$NoSeed,         # skip prisma + seed (faster re-runs once stack is up)
    [switch]$NoBackend,      # only boot MySQL + seed; don't start backend
    [switch]$VerboseDb       # show prisma + seed output (default: tails only)
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".scripts-state"
if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir | Out-Null }

# Local-stack credentials — match docker-compose.yml exactly. Hardcoded
# because no real environment uses these and engineers shouldn't need
# to hunt for them.
$LOCAL_DB_URL = "mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local"
$LOCAL_JWT = "local_dev_jwt_secret_not_for_real_use"

Push-Location $root
try {
    # ─── 1. boot MySQL ──────────────────────────────────────────────
    Write-Host ""
    Write-Host "=== 1. docker compose up -d mysql ===" -ForegroundColor Cyan
    docker compose up -d mysql 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FAIL: docker compose failed. Is Docker Desktop running?" -ForegroundColor Red
        exit 1
    }

    # ─── 2. wait for MySQL healthy ──────────────────────────────────
    Write-Host ""
    Write-Host "=== 2. wait for MySQL healthy ===" -ForegroundColor Cyan
    $ready = $false
    for ($i = 1; $i -le 30; $i++) {
        $health = docker inspect --format '{{.State.Health.Status}}' gbscrm-mysql-local 2>$null
        if ($health -eq "healthy") {
            Write-Host "  ready (try $i)" -ForegroundColor Green
            $ready = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) {
        Write-Host "FAIL: MySQL never reached healthy state. Try: docker compose logs mysql" -ForegroundColor Red
        exit 1
    }

    # ─── 3. prisma db push + seed ───────────────────────────────────
    if (-not $NoSeed) {
        Write-Host ""
        Write-Host "=== 3. prisma db push + seed (both tenants) ===" -ForegroundColor Cyan
        Push-Location backend
        try {
            $env:DATABASE_URL = $LOCAL_DB_URL
            if ($VerboseDb) {
                npx prisma db push --skip-generate --accept-data-loss
            } else {
                npx prisma db push --skip-generate --accept-data-loss 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
            }
            if ($LASTEXITCODE -ne 0) { throw "prisma db push failed" }

            Write-Host "  seeding generic tenant..."
            if ($VerboseDb) { node prisma/seed.js } else { node prisma/seed.js 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "    $_" } }
            if ($LASTEXITCODE -ne 0) { throw "seed.js failed" }

            Write-Host "  seeding wellness tenant..."
            if ($VerboseDb) { node prisma/seed-wellness.js } else { node prisma/seed-wellness.js 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "    $_" } }
            if ($LASTEXITCODE -ne 0) { throw "seed-wellness.js failed" }
        } finally { Pop-Location }
    } else {
        Write-Host "    (--NoSeed: skipping prisma + seed)" -ForegroundColor Yellow
    }

    # ─── 4. boot backend ────────────────────────────────────────────
    if (-not $NoBackend) {
        Write-Host ""
        Write-Host "=== 4. start backend on http://127.0.0.1:5000 ===" -ForegroundColor Cyan

        $pidFile = Join-Path $stateDir "backend.pid"
        $logFile = Join-Path $stateDir "backend.log"

        if (Test-Path $pidFile) {
            $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
            $stillRunning = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
            if ($stillRunning) {
                Write-Host "  backend already running (PID $oldPid). Stop with local-stack-down first." -ForegroundColor Yellow
                exit 1
            }
        }

        # Spawn detached so this script can exit while backend keeps running.
        # Override DATABASE_URL + JWT_SECRET via env so backend/.env isn't touched.
        $envArgs = @(
            "DATABASE_URL=$LOCAL_DB_URL",
            "JWT_SECRET=$LOCAL_JWT",
            "DISABLE_CRONS=1",
            "NODE_ENV=test",
            "PORT=5000"
        )
        # PowerShell doesn't have a clean "set env for one process" the way bash does;
        # use Start-Process with -ArgumentList and wrap the env injection in a child shell.
        $cmd = "set DATABASE_URL=$LOCAL_DB_URL && set JWT_SECRET=$LOCAL_JWT && set DISABLE_CRONS=1 && set NODE_ENV=test && set PORT=5000 && node server.js"
        $proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmd `
            -WorkingDirectory (Join-Path $root "backend") `
            -RedirectStandardOutput $logFile `
            -RedirectStandardError "$logFile.err" `
            -PassThru -WindowStyle Hidden
        Set-Content -Path $pidFile -Value $proc.Id
        Write-Host "  spawned PID $($proc.Id) (log: $logFile)"

        # ─── 5. wait for /api/health ─────────────────────────────────
        Write-Host ""
        Write-Host "=== 5. wait for backend healthy ===" -ForegroundColor Cyan
        $ready = $false
        for ($i = 1; $i -le 30; $i++) {
            try {
                $r = Invoke-WebRequest -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
                if ($r.StatusCode -eq 200 -and $r.Content -match '"healthy"') {
                    Write-Host "  ready (try $i)" -ForegroundColor Green
                    $ready = $true
                    break
                }
            } catch {
                # Not ready yet; backend still booting.
            }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            Write-Host "FAIL: backend never reached /api/health healthy. Inspect $logFile" -ForegroundColor Red
            Get-Content $logFile -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  | $_" -ForegroundColor DarkGray }
            exit 1
        }
    } else {
        Write-Host "    (--NoBackend: skipping backend startup)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "OK local stack ready" -ForegroundColor Green
    Write-Host "    MySQL:   mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local"
    if (-not $NoBackend) {
        Write-Host "    Backend: http://127.0.0.1:5000"
        Write-Host "    Logs:    $stateDir\backend.log"
    }
    Write-Host ""
    Write-Host "    Next: .\scripts\test-local.ps1 -Local  (run gate against this stack)"
    Write-Host "    Down: .\scripts\local-stack-down.ps1"
} finally {
    Pop-Location
}
