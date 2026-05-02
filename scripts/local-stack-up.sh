#!/usr/bin/env bash
# local-stack-up.sh - boot the local Docker MySQL + seed + start backend.
# Bash equivalent of local-stack-up.ps1. See that file for the full
# rationale; this is a near line-for-line port for Linux/Mac/git-bash.
#
# Usage:
#   scripts/local-stack-up.sh                # boot, seed, start backend
#   scripts/local-stack-up.sh --no-seed      # skip prisma + seed (faster re-runs)
#   scripts/local-stack-up.sh --no-backend   # only MySQL + seed
#   scripts/local-stack-up.sh --verbose-db   # show prisma + seed output

set -e

NO_SEED=0
NO_BACKEND=0
VERBOSE_DB=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-seed)    NO_SEED=1; shift ;;
    --no-backend) NO_BACKEND=1; shift ;;
    --verbose-db) VERBOSE_DB=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT/.scripts-state"
mkdir -p "$STATE_DIR"

LOCAL_DB_URL="mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local"
LOCAL_JWT="local_dev_jwt_secret_not_for_real_use"

cd "$ROOT"

# --- 1. boot MySQL --------------------------------------------------
echo ""
echo "=== 1. docker compose up -d mysql ==="
if ! docker compose up -d mysql; then
  echo "FAIL: docker compose failed. Is Docker Desktop running?" >&2
  exit 1
fi

# --- 2. wait for MySQL healthy --------------------------------------
echo ""
echo "=== 2. wait for MySQL healthy ==="
ready=0
for i in $(seq 1 30); do
  health=$(docker inspect --format '{{.State.Health.Status}}' gbscrm-mysql-local 2>/dev/null || echo "")
  if [[ "$health" == "healthy" ]]; then
    echo "  ready (try $i)"
    ready=1
    break
  fi
  sleep 2
done
if [[ $ready -eq 0 ]]; then
  echo "FAIL: MySQL never reached healthy state. Try: docker compose logs mysql" >&2
  exit 1
fi

# --- 3. prisma db push + seed ---------------------------------------
if [[ $NO_SEED -eq 0 ]]; then
  echo ""
  echo "=== 3. prisma db push + seed (both tenants) ==="
  pushd backend > /dev/null
  export DATABASE_URL="$LOCAL_DB_URL"

  if [[ $VERBOSE_DB -eq 1 ]]; then
    npx prisma db push --skip-generate --accept-data-loss
  else
    npx prisma db push --skip-generate --accept-data-loss 2>&1 | tail -3 | sed 's/^/  /'
  fi

  echo "  seeding generic tenant..."
  if [[ $VERBOSE_DB -eq 1 ]]; then node prisma/seed.js; else node prisma/seed.js 2>&1 | tail -2 | sed 's/^/    /'; fi
  echo "  seeding wellness tenant..."
  if [[ $VERBOSE_DB -eq 1 ]]; then node prisma/seed-wellness.js; else node prisma/seed-wellness.js 2>&1 | tail -2 | sed 's/^/    /'; fi

  popd > /dev/null
else
  echo "    (--no-seed: skipping prisma + seed)"
fi

# --- 4. boot backend ------------------------------------------------
if [[ $NO_BACKEND -eq 0 ]]; then
  echo ""
  echo "=== 4. start backend on http://127.0.0.1:5000 ==="

  PID_FILE="$STATE_DIR/backend.pid"
  LOG_FILE="$STATE_DIR/backend.log"

  if [[ -f "$PID_FILE" ]]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "  backend already running (PID $OLD_PID). Stop with local-stack-down first." >&2
      exit 1
    fi
  fi

  pushd backend > /dev/null
  DATABASE_URL="$LOCAL_DB_URL" \
    JWT_SECRET="$LOCAL_JWT" \
    DISABLE_CRONS=1 \
    NODE_ENV=test \
    PORT=5000 \
    nohup node server.js > "$LOG_FILE" 2>&1 &
  BACKEND_PID=$!
  popd > /dev/null
  echo "$BACKEND_PID" > "$PID_FILE"
  echo "  spawned PID $BACKEND_PID (log: $LOG_FILE)"

  # --- 5. wait for /api/health --------------------------------------
  echo ""
  echo "=== 5. wait for backend healthy ==="
  ready=0
  for i in $(seq 1 30); do
    if curl -s --max-time 2 http://127.0.0.1:5000/api/health 2>/dev/null | grep -q '"healthy"'; then
      echo "  ready (try $i)"
      ready=1
      break
    fi
    sleep 1
  done
  if [[ $ready -eq 0 ]]; then
    echo "FAIL: backend never reached /api/health healthy. Inspect $LOG_FILE" >&2
    tail -30 "$LOG_FILE" | sed 's/^/  | /'
    exit 1
  fi
else
  echo "    (--no-backend: skipping backend startup)"
fi

echo ""
echo "OK local stack ready"
echo "    MySQL:   mysql://root:local_dev_pw@127.0.0.1:3307/gbscrm_local"
if [[ $NO_BACKEND -eq 0 ]]; then
  echo "    Backend: http://127.0.0.1:5000"
  echo "    Logs:    $STATE_DIR/backend.log"
fi
echo ""
echo "    Next: scripts/test-local.sh -Local  (run gate against this stack)"
echo "    Down: scripts/local-stack-down.sh"
