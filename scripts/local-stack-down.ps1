# local-stack-down.ps1 — stop the local backend + (optionally) MySQL.
#
# Default: stops backend, leaves MySQL running so the next up is fast.
# `-Full`: stops MySQL too.
# `-Wipe`: stops MySQL AND deletes the named volume (full reset).

param(
    [switch]$Full,    # also `docker compose stop`
    [switch]$Wipe     # `docker compose down -v` (drops the data volume)
)

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $root ".scripts-state"
$pidFile = Join-Path $stateDir "backend.pid"

# ─── 1. stop backend ────────────────────────────────────────────────
if (Test-Path $pidFile) {
    $backendPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($backendPid) {
        $proc = Get-Process -Id $backendPid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "stopping backend PID $backendPid..."
            Stop-Process -Id $backendPid -Force -ErrorAction SilentlyContinue
            # Also kill the cmd.exe wrapper's children (node.exe).
            Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
                $_.Parent.Id -eq $backendPid
            } | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
} else {
    Write-Host "no backend PID file — assumed already stopped" -ForegroundColor DarkGray
}

# Belt-and-braces: kill any node listening on 5000 (covers cases where
# the PID file was lost but backend is still running).
$listening = Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    foreach ($c in $listening) {
        $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match "node|cmd") {
            Write-Host "  also stopping orphaned PID $($proc.Id) ($($proc.ProcessName))"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}

# ─── 2. stop / wipe MySQL ───────────────────────────────────────────
Push-Location $root
try {
    if ($Wipe) {
        Write-Host "WIPE: docker compose down -v (drops the data volume)" -ForegroundColor Yellow
        docker compose down -v
    } elseif ($Full) {
        Write-Host "stopping MySQL container (volume preserved)..."
        docker compose stop
    } else {
        Write-Host "MySQL still running (use -Full to stop, -Wipe to reset)" -ForegroundColor DarkGray
    }
} finally {
    Pop-Location
}

Write-Host "OK local stack down" -ForegroundColor Green
