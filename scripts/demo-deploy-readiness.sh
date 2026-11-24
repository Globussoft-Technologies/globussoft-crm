#!/usr/bin/env bash
set -euo pipefail

deadline_seconds=${1:-60}
[[ "$deadline_seconds" =~ ^[1-9][0-9]*$ ]] || exit 2
deadline=$((SECONDS + deadline_seconds))
attempt=0
body=$(mktemp)
trap 'rm -f "$body"' EXIT

while (( SECONDS < deadline )); do
  attempt=$((attempt + 1))
  started=$SECONDS
  remaining=$((deadline - SECONDS))
  (( remaining > 0 )) || break
  limit=$((remaining < 5 ? remaining : 5))
  curl_rc=0
  http=$(curl -sS --connect-timeout 2 --max-time "$limit" --output "$body" \
    --write-out '%{http_code}' -H 'Authorization: Deployment-Readiness' \
    http://127.0.0.1:5099/api/health 2>/dev/null) || curl_rc=$?
  elapsed=$((SECONDS - started))
  result=http_error
  if (( curl_rc != 0 )); then
    case "$curl_rc" in
      7) result=connect_failed ;;
      28) result=timed_out ;;
      52) result=empty_reply ;;
      *) result=transport_error ;;
    esac
  elif [[ "$http" == 200 ]]; then
    result=$(node -e '
      try {
        const {status, database, tallyConnectorBinaryAvailable} =
          JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
        console.log(database !== "connected" ? "database_not_ready"
          : status !== "healthy" ? "not_healthy"
          : tallyConnectorBinaryAvailable !== true ? "tally_binary_unavailable" : "ready");
      } catch { console.log("invalid_health_json"); }
    ' "$body")
  fi
  printf '[readiness] attempt=%s curl_exit=%s http=%s elapsed=%ss result=%s\n' \
    "$attempt" "$curl_rc" "${http:-000}" "$elapsed" "$result"
  [[ "$result" != ready ]] || exit 0
  remaining=$((deadline - SECONDS))
  (( remaining > 0 )) || break
  sleep "$((remaining < 2 ? remaining : 2))"
done

echo "[readiness] backend not ready within ${deadline_seconds}s"
exit 1
