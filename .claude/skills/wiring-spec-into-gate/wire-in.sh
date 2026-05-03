#!/usr/bin/env bash
# wire-in.sh — idempotently add a Playwright API spec to both
# .github/workflows/deploy.yml and coverage.yml gate-spec lists.
#
# Inserts the line BEFORE `tests/teardown-completeness.spec.js \` so that
# spec + demo-hygiene-api.spec.js continue to run last (they're final-
# state assertion specs that should see the residue from earlier specs).
#
# Idempotent: if the spec is already wired into a file, the file is left
# unchanged. Run it after every new gate spec; safe to re-run.
#
# Usage:
#   .claude/skills/wiring-spec-into-gate/wire-in.sh tests/foo-api.spec.js
#
# The argument is the spec path AS WRITTEN IN THE WORKFLOW LIST — relative
# from the e2e/ working directory, NOT the absolute path. Examples:
#   tests/foo-api.spec.js
#   tests/wellness-clinical-api.spec.js

set -euo pipefail

SPEC=${1:-}
if [ -z "$SPEC" ]; then
  echo "usage: $0 <spec-path>" >&2
  echo "example: $0 tests/foo-api.spec.js" >&2
  exit 2
fi

# Find repo root by walking up from the script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Verify the spec file actually exists — catch typos before editing CI.
if [ ! -f "$REPO_ROOT/e2e/$SPEC" ]; then
  echo "WARNING: $REPO_ROOT/e2e/$SPEC does not exist — proceeding anyway" >&2
  echo "(Set INSIST_FILE_EXISTS=1 to fail loudly instead.)" >&2
  if [ "${INSIST_FILE_EXISTS:-0}" = "1" ]; then
    exit 3
  fi
fi

for FILE in \
  "$REPO_ROOT/.github/workflows/deploy.yml" \
  "$REPO_ROOT/.github/workflows/coverage.yml"; do

  if [ ! -f "$FILE" ]; then
    echo "SKIP $(basename "$FILE"): not found" >&2
    continue
  fi

  if grep -qF "$SPEC" "$FILE"; then
    echo "OK  $(basename "$FILE"): $SPEC already wired"
    continue
  fi

  # The marker line we insert BEFORE.
  MARKER='tests/teardown-completeness.spec.js \\'
  if ! grep -qF "tests/teardown-completeness.spec.js" "$FILE"; then
    echo "FAIL $(basename "$FILE"): no teardown-completeness anchor — manual edit required" >&2
    exit 4
  fi

  # GNU sed: insert with proper indentation. The list lines are indented
  # 12 spaces. The trailing \\ in the inserted line is a bash continuation
  # for the npx playwright test invocation. The double backslash escapes
  # for sed.
  TMP="$FILE.wireintmp.$$"
  awk -v spec="$SPEC" '
    /tests\/teardown-completeness\.spec\.js/ && !inserted {
      print "            tests/" spec " \\"
      inserted = 1
    }
    { print }
  ' "$FILE" > "$TMP"

  # Sanity check: TMP should be larger than original by exactly one line.
  ORIG_LINES=$(wc -l < "$FILE")
  NEW_LINES=$(wc -l < "$TMP")
  if [ "$NEW_LINES" -ne $((ORIG_LINES + 1)) ]; then
    echo "FAIL $(basename "$FILE"): line count delta != 1 (was $ORIG_LINES, now $NEW_LINES)" >&2
    rm -f "$TMP"
    exit 5
  fi

  mv "$TMP" "$FILE"
  echo "ADD $(basename "$FILE"): $SPEC inserted before teardown-completeness"
done

echo ""
echo "Wire-in complete. Verify with:"
echo "  grep -c 'tests/$SPEC' .github/workflows/deploy.yml .github/workflows/coverage.yml"
echo ""
echo "Then commit + push. If push rejects (sibling agent collision), 'git pull --rebase' and retry."
