#!/usr/bin/env bash
# log.sh — POST an agent-activity entry to the running CRM backend so
# the Developer page (/developer) shows live progress. Falls back to
# direct file append if the backend isn't reachable.
#
# Usage:
#   log.sh --agent <tag> --action <event> [--message "..."] [--file path] [--commit sha] [--status string]
#
# Example:
#   .claude/skills/reporting-agent-progress/log.sh \
#     --agent "R-4-booking-pages" \
#     --action "start" \
#     --message "writing booking-pages-api.spec.js, cloning landing-pages pattern"
#
# Logs to:
#   1. Backend POST /api/developer/agent-activity (preferred; visible on /developer)
#   2. Direct append to .scripts-state/agent-activity.jsonl (fallback)
#
# Never fails (returns 0 even on error) so agents don't hard-fail on logging.

set +e  # never let logging crash the agent

AGENT=""
ACTION=""
MESSAGE=""
FILE=""
COMMIT=""
STATUS=""
BASE_URL="${BASE_URL:-http://127.0.0.1:5000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@globussoft.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-password123}"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent)   AGENT="$2"; shift 2 ;;
    --action)  ACTION="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --file)    FILE="$2"; shift 2 ;;
    --commit)  COMMIT="$2"; shift 2 ;;
    --status)  STATUS="$2"; shift 2 ;;
    *) echo "log.sh: unknown arg $1" >&2; shift ;;
  esac
done

if [ -z "$AGENT" ] || [ -z "$ACTION" ]; then
  echo "log.sh: --agent and --action required" >&2
  exit 0
fi

# Locate repo root via this script's location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LOG_FILE="$REPO_ROOT/.scripts-state/agent-activity.jsonl"

# Build the JSON entry. We emit a fully-formed entry (with ts) so the
# fallback file-append path matches the same shape the backend route
# would write.
ESC_AGENT=$(printf '%s' "$AGENT" | sed 's/[\\"]/\\&/g')
ESC_ACTION=$(printf '%s' "$ACTION" | sed 's/[\\"]/\\&/g')
ESC_MESSAGE=$(printf '%s' "$MESSAGE" | sed 's/[\\"]/\\&/g')
ESC_FILE=$(printf '%s' "$FILE" | sed 's/[\\"]/\\&/g')
ESC_COMMIT=$(printf '%s' "$COMMIT" | sed 's/[\\"]/\\&/g')
ESC_STATUS=$(printf '%s' "$STATUS" | sed 's/[\\"]/\\&/g')
TS=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || python -c "import datetime; print(datetime.datetime.utcnow().isoformat() + 'Z')")

JSON_BODY=$(cat <<EOF
{"agent":"$ESC_AGENT","action":"$ESC_ACTION","message":"$ESC_MESSAGE","file":"$ESC_FILE","commit":"$ESC_COMMIT","status":"$ESC_STATUS"}
EOF
)
JSON_ENTRY=$(cat <<EOF
{"ts":"$TS","agent":"$ESC_AGENT","action":"$ESC_ACTION","message":"$ESC_MESSAGE","file":"$ESC_FILE","commit":"$ESC_COMMIT","status":"$ESC_STATUS","by":"log.sh"}
EOF
)

# Try backend POST first (preferred — bumps the running backend's
# in-memory state immediately).
TOKEN_FILE="$REPO_ROOT/.scripts-state/.agent-log-token"
if [ ! -f "$TOKEN_FILE" ] || [ "$(find "$TOKEN_FILE" -mmin -30 2>/dev/null | wc -l)" -eq 0 ]; then
  # Token missing or older than 30 min — refresh
  mkdir -p "$REPO_ROOT/.scripts-state"
  curl -s --max-time 5 -X POST "$BASE_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null \
    | python -c "import json,sys; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null \
    > "$TOKEN_FILE"
fi
TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)

POST_OK=0
if [ -n "$TOKEN" ]; then
  HTTP_CODE=$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' \
    -X POST "$BASE_URL/api/developer/agent-activity" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$JSON_BODY" 2>/dev/null)
  if [ "$HTTP_CODE" = "201" ]; then
    POST_OK=1
  fi
fi

# Always also append to the file (idempotent — backend route appends
# the same shape). Belt-and-braces: if the POST succeeded, this is a
# duplicate; the Developer page tolerates dupes via the timestamp.
# If the POST failed, this is the only persistence.
if [ "$POST_OK" -eq 0 ]; then
  mkdir -p "$REPO_ROOT/.scripts-state"
  echo "$JSON_ENTRY" >> "$LOG_FILE"
fi

# Return 0 always — never fail an agent on logging
exit 0
