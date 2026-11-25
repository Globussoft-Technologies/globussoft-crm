#!/usr/bin/env bash
set -euo pipefail

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
stub=$(mktemp -d)
trap 'rm -f "$stub/curl"; rmdir "$stub"' EXIT

tee "$stub/curl" >/dev/null <<'STUB'
#!/usr/bin/env bash
while (( $# )); do
  if [[ "$1" == --output ]]; then output=$2; shift; fi
  shift
done
printf '%s' "$TEST_BODY" > "$output"
printf '%s' "$TEST_HTTP"
exit "$TEST_CURL_RC"
STUB
chmod +x "$stub/curl"
export PATH="$stub:$PATH"

check() {
  local expected=$1 marker=$2 actual=0 output
  output=$(TEST_HTTP="$3" TEST_CURL_RC="$4" TEST_BODY="$5" \
    bash "$dir/demo-deploy-readiness.sh" 1) || actual=$?
  [[ "$actual" == "$expected" && "$output" == *"result=$marker"* ]]
  [[ "$output" != *private_marker* ]]
}

healthy='{"status":"healthy","database":"connected","tallyConnectorBinaryAvailable":true}'
check 0 ready 200 0 "$healthy"
check 1 http_error 503 0 "$healthy"
check 1 connect_failed 000 7 ''
check 1 timed_out 000 28 ''
check 1 empty_reply 000 52 ''
check 1 invalid_health_json 200 0 'private_marker'
check 1 database_not_ready 200 0 '{"status":"degraded","database":"error: private_marker"}'
check 1 not_healthy 200 0 '{"status":"degraded","database":"connected","tallyConnectorBinaryAvailable":true}'
check 1 tally_binary_unavailable 200 0 '{"status":"healthy","database":"connected","tallyConnectorBinaryAvailable":false}'
echo '9 readiness cases passed'
