#!/usr/bin/env bash
# capture.sh — route an agent-discovered finding into the right doc
# (TODOS.md, docs/E2E_GAPS.md, CHANGELOG.md) and/or a new GitHub
# issue, so nothing surfaced mid-wave is lost between waves.
#
# Modes:
#   issue           — file a GitHub issue + one-liner in TODOS "Long tail"
#   backlog-row     — add a new G-XX row in docs/E2E_GAPS.md priority backlog
#   spec-shipped    — mark E2E_GAPS row ✅ + add CHANGELOG bullet
#   rule-proposal   — append a proposal to TODOS.md (NOT CLAUDE.md — human reviews first)
#
# Usage examples:
#   capture.sh issue --type bug --title "engine X writes wrong status" --area cron --severity P2 --body-file /tmp/f.md
#   capture.sh backlog-row --id G-26 --title "non-numeric :id sweep" --effort 1d --risk Med --body-file /tmp/f.md
#   capture.sh spec-shipped --gap-id G-26 --commit a1b2c3d --tests 42 --note "rename-on-cleanup pattern; surfaced #428"
#   capture.sh rule-proposal --rule "every new spec MUST afterAll-cleanup" --reason "two waves tripped on residue" --evidence "02a4d1e + 967cbdc"
#
# Designed to be idempotent in the cheap cases (see SKILL.md).
# Never crashes the orchestrator on partial failure — exit 0 unless
# explicitly malformed input.

set -e

MODE="$1"
shift || true

if [ -z "$MODE" ]; then
  echo "capture.sh: mode required (issue|backlog-row|spec-shipped|rule-proposal)" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TODOS_FILE="$REPO_ROOT/TODOS.md"
GAPS_FILE="$REPO_ROOT/docs/E2E_GAPS.md"
CHANGELOG_FILE="$REPO_ROOT/CHANGELOG.md"

# ---------- helpers ----------

now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || python -c "import datetime; print(datetime.datetime.utcnow().isoformat() + 'Z')"; }

# Append a one-liner under the "Long tail still open" section of the
# current (most recent) TODOS handoff block. If the section doesn't
# exist, append a stub.
append_longtail() {
  local LINE="$1"
  if grep -q "^### Long tail still open" "$TODOS_FILE" 2>/dev/null; then
    # Insert after the FIRST "### Long tail still open" header
    awk -v line="$LINE" '
      BEGIN { inserted = 0 }
      /^### Long tail still open/ && !inserted {
        print
        getline next_line
        print next_line
        print line
        inserted = 1
        next
      }
      { print }
    ' "$TODOS_FILE" > "$TODOS_FILE.tmp" && mv "$TODOS_FILE.tmp" "$TODOS_FILE"
  else
    echo "" >> "$TODOS_FILE"
    echo "### Long tail still open" >> "$TODOS_FILE"
    echo "" >> "$TODOS_FILE"
    echo "$LINE" >> "$TODOS_FILE"
  fi
}

# ---------- mode: issue ----------

mode_issue() {
  local TYPE="" TITLE="" AREA="" SEVERITY="P2" BODY_FILE="" WAVE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --type)      TYPE="$2"; shift 2 ;;
      --title)     TITLE="$2"; shift 2 ;;
      --area)      AREA="$2"; shift 2 ;;
      --severity)  SEVERITY="$2"; shift 2 ;;
      --body-file) BODY_FILE="$2"; shift 2 ;;
      --wave)      WAVE="$2"; shift 2 ;;
      *) echo "issue: unknown arg $1" >&2; shift ;;
    esac
  done
  if [ -z "$TYPE" ] || [ -z "$TITLE" ]; then
    echo "issue: --type and --title required" >&2
    exit 1
  fi

  local LABELS="type:$TYPE,severity:$SEVERITY"
  [ -n "$AREA" ]  && LABELS="$LABELS,area:$AREA"
  [ -n "$WAVE" ]  && LABELS="$LABELS,surfaced-by:wave-$WAVE"

  local URL=""
  if command -v gh >/dev/null 2>&1; then
    if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
      URL=$(gh issue create --title "$TITLE" --body-file "$BODY_FILE" --label "$LABELS" 2>/dev/null || true)
    else
      URL=$(gh issue create --title "$TITLE" --body "Surfaced by wave-$WAVE finding capture." --label "$LABELS" 2>/dev/null || true)
    fi
  fi

  local LINE
  if [ -n "$URL" ]; then
    LINE="- $URL — $TITLE ($SEVERITY)"
  else
    LINE="- (gh-create-failed) — $TITLE ($SEVERITY) — $(now_iso)"
  fi
  append_longtail "$LINE"

  echo "${URL:-(no URL — gh failed; line still appended to TODOS)}"
}

# ---------- mode: backlog-row ----------

mode_backlog_row() {
  local ID="" TITLE="" EFFORT="" RISK="" BODY_FILE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --id)        ID="$2"; shift 2 ;;
      --title)     TITLE="$2"; shift 2 ;;
      --effort)    EFFORT="$2"; shift 2 ;;
      --risk)      RISK="$2"; shift 2 ;;
      --body-file) BODY_FILE="$2"; shift 2 ;;
      *) echo "backlog-row: unknown arg $1" >&2; shift ;;
    esac
  done
  if [ -z "$ID" ] || [ -z "$TITLE" ]; then
    echo "backlog-row: --id and --title required" >&2
    exit 1
  fi

  # Idempotency check — refuse on collision
  if grep -q "^| \*\*$ID\*\* |" "$GAPS_FILE" 2>/dev/null; then
    echo "backlog-row: $ID already exists in $GAPS_FILE — refusing to overwrite" >&2
    exit 1
  fi

  local NEW_ROW="| **$ID** | $TITLE | ${EFFORT:-?} | ${RISK:-?} | ⬜ open |"
  # Insert before the **Recommended first parallel batch** footer line if it exists,
  # otherwise just append at end of the priority-backlog table.
  if grep -q "^\*\*Recommended first parallel batch" "$GAPS_FILE" 2>/dev/null; then
    awk -v row="$NEW_ROW" '
      /^\*\*Recommended first parallel batch/ && !inserted { print row; print ""; inserted = 1 }
      { print }
    ' "$GAPS_FILE" > "$GAPS_FILE.tmp" && mv "$GAPS_FILE.tmp" "$GAPS_FILE"
  else
    echo "$NEW_ROW" >> "$GAPS_FILE"
  fi

  # File the umbrella issue
  local URL=""
  if command -v gh >/dev/null 2>&1; then
    if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
      URL=$(gh issue create --title "[$ID] $TITLE" --body-file "$BODY_FILE" --label "type:backlog-item,severity:${RISK:-Med}" 2>/dev/null || true)
    fi
  fi

  if [ -n "$URL" ]; then
    append_longtail "- $URL — $ID $TITLE (${EFFORT:-?})"
  fi

  echo "Added $ID to $GAPS_FILE${URL:+ (issue: $URL)}"
}

# ---------- mode: spec-shipped ----------

mode_spec_shipped() {
  local GAP_ID="" COMMIT="" TESTS="" NOTE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --gap-id)  GAP_ID="$2"; shift 2 ;;
      --commit)  COMMIT="$2"; shift 2 ;;
      --tests)   TESTS="$2"; shift 2 ;;
      --note)    NOTE="$2"; shift 2 ;;
      *) echo "spec-shipped: unknown arg $1" >&2; shift ;;
    esac
  done
  if [ -z "$GAP_ID" ]; then
    echo "spec-shipped: --gap-id required (use 'off-backlog' if no E2E_GAPS row)" >&2
    exit 1
  fi

  if [ "$GAP_ID" != "off-backlog" ]; then
    # Idempotency — refuse if already ✅
    if grep -q "^| \*\*$GAP_ID\*\* | .* | ✅ shipped" "$GAPS_FILE" 2>/dev/null; then
      echo "spec-shipped: $GAP_ID already marked ✅ — skipping E2E_GAPS edit" >&2
    elif ! grep -q "^| \*\*$GAP_ID\*\* |" "$GAPS_FILE" 2>/dev/null; then
      echo "spec-shipped: $GAP_ID not found in $GAPS_FILE" >&2
      exit 1
    else
      # Replace the trailing "⬜ open |" with the shipped marker
      local SHIPPED="✅ shipped (${COMMIT:-?} — ${TESTS:-?} tests${NOTE:+; $NOTE})"
      python - "$GAPS_FILE" "$GAP_ID" "$SHIPPED" <<'PY'
import re, sys
path, gap_id, shipped = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r', encoding='utf-8') as f:
    s = f.read()
pat = re.compile(r'^\| \*\*' + re.escape(gap_id) + r'\*\* \|(.*?)\| ⬜ open \|', re.M)
new = pat.sub(lambda m: f"| **{gap_id}** |{m.group(1)}| {shipped} |", s, count=1)
with open(path, 'w', encoding='utf-8') as f:
    f.write(new)
PY
    fi
  fi

  # Append CHANGELOG bullet — under [Unreleased] if present, else
  # under the topmost dated entry (the in-progress release entry).
  local BULLET="- ${GAP_ID} shipped${COMMIT:+ ($COMMIT)}${TESTS:+ — $TESTS tests}${NOTE:+; $NOTE}"
  if grep -q "^## \[Unreleased\]" "$CHANGELOG_FILE" 2>/dev/null; then
    awk -v line="$BULLET" '
      /^## \[Unreleased\]/ && !inserted { print; print ""; print line; inserted = 1; next }
      { print }
    ' "$CHANGELOG_FILE" > "$CHANGELOG_FILE.tmp" && mv "$CHANGELOG_FILE.tmp" "$CHANGELOG_FILE"
  else
    # Insert just after the FIRST "## v" header (the in-progress entry)
    awk -v line="$BULLET" '
      /^## v/ && !inserted { print; print ""; print "  " line; inserted = 1; next }
      { print }
    ' "$CHANGELOG_FILE" > "$CHANGELOG_FILE.tmp" && mv "$CHANGELOG_FILE.tmp" "$CHANGELOG_FILE"
  fi

  echo "Captured $GAP_ID — E2E_GAPS marked ✅, CHANGELOG bullet appended"
}

# ---------- mode: rule-proposal ----------

mode_rule_proposal() {
  local RULE="" REASON="" EVIDENCE=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --rule)     RULE="$2"; shift 2 ;;
      --reason)   REASON="$2"; shift 2 ;;
      --evidence) EVIDENCE="$2"; shift 2 ;;
      *) echo "rule-proposal: unknown arg $1" >&2; shift ;;
    esac
  done
  if [ -z "$RULE" ] || [ -z "$REASON" ]; then
    echo "rule-proposal: --rule and --reason required" >&2
    exit 1
  fi

  local SECTION="## 🟡 Proposed standing-rule additions (review before next session)"
  if ! grep -q "^$SECTION" "$TODOS_FILE" 2>/dev/null; then
    echo "" >> "$TODOS_FILE"
    echo "$SECTION" >> "$TODOS_FILE"
    echo "" >> "$TODOS_FILE"
    echo "Appended by capturing-wave-findings — orchestrator/user promotes to CLAUDE.md \"Standing rules for new code\" only after review." >> "$TODOS_FILE"
    echo "" >> "$TODOS_FILE"
  fi

  cat >> "$TODOS_FILE" <<EOF
- **Proposed rule**: $RULE
  - **Why**: $REASON
  - **Evidence**: ${EVIDENCE:-(none)}
  - **Captured**: $(now_iso)
EOF

  echo "Rule proposal appended to $TODOS_FILE"
}

# ---------- dispatch ----------

case "$MODE" in
  issue)         mode_issue "$@" ;;
  backlog-row)   mode_backlog_row "$@" ;;
  spec-shipped)  mode_spec_shipped "$@" ;;
  rule-proposal) mode_rule_proposal "$@" ;;
  *) echo "capture.sh: unknown mode $MODE (issue|backlog-row|spec-shipped|rule-proposal)" >&2; exit 1 ;;
esac
