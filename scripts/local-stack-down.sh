#!/usr/bin/env bash
# local-stack-down.sh - stop the local backend + (optionally) MySQL.
#
# Default: stops backend, leaves MySQL running so the next up is fast.
# `--full`: stops MySQL too.
# `--wipe`: stops MySQL AND deletes the named volume (full reset).

set -e

FULL=0
WIPE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) FULL=1; shift ;;
    --wipe) WIPE=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.scripts-state"
PID_FILE="$STATE_DIR/backend.pid"

# --- 1. stop backend ------------------------------------------------
if [[ -f "$PID_FILE" ]]; then
  BACKEND_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "stopping backend PID $BACKEND_PID..."
    kill "$BACKEND_PID" 2>/dev/null || true
    # Wait briefly for graceful shutdown, then force.
    for i in 1 2 3; do
      if ! kill -0 "$BACKEND_PID" 2>/dev/null; then break; fi
      sleep 1
    done
    kill -9 "$BACKEND_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
else
  echo "no backend PID file - assumed already stopped"
fi

# Belt-and-braces: kill anything listening on 5000 (in case the PID
# file was lost but the process kept running).
if command -v lsof >/dev/null; then
  pids=$(lsof -ti :5000 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      echo "  also stopping orphaned PID $pid on :5000"
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
fi

# --- 2. stop / wipe MySQL -------------------------------------------
cd "$ROOT"
if [[ $WIPE -eq 1 ]]; then
  echo "WIPE: docker compose down -v (drops the data volume)"
  docker compose down -v
elif [[ $FULL -eq 1 ]]; then
  echo "stopping MySQL container (volume preserved)..."
  docker compose stop
else
  echo "MySQL still running (use --full to stop, --wipe to reset)"
fi

echo "OK local stack down"
