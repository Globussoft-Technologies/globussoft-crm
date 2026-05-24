Autonomous overnight TEST-WRITING cron — Globussoft CRM. Fires every 15 min OFFSET from the programming cron (at :00/:15/:30/:45 to the programming cron's :08/:23/:38/:53). **Three parallel test-writing agents per tick.** Drives code coverage toward **100%** by writing tests for EXISTING source files, never modifying source code. **Every test this cron ships MUST run in the Deploy gate** — that's the whole point. Bug discoveries route to GitHub issues, NOT inline fixes — programming cron picks those up separately. Cron auto-expires in 7 days.

## Coverage target = 100%, measured by the Deploy gate

Every test file this cron ships **must** be picked up by the existing 6-gate Deploy pipeline (`.github/workflows/deploy.yml`). Concretely:

| Test file type | Deploy gate job | Wire-in required? |
|---|---|---|
| `backend/test/**/*.test.js` (vitest unit) | **`unit_tests`** gate | NO — vitest's glob auto-discovers; just commit the file |
| `frontend/src/__tests__/**/*.test.{js,jsx}` (vitest + RTL) | **`frontend_unit_tests`** gate | NO — vitest's glob auto-discovers |
| `e2e/tests/**/*-api.spec.js` (NEW gate spec) | **`api_tests`** gate | **YES** — must add to `deploy.yml`'s "Run API-only specs" step AND `coverage.yml`'s mirror; use `.claude/skills/wiring-spec-into-gate/SKILL.md` |
| `e2e/tests/**/*-api.spec.js` (extending existing spec) | **`api_tests`** gate | NO if file is already in the gate list; just add `it(...)` blocks |

**Coverage measurement loop**: every 8th tick (≈ 2 hours of cron time), the parent agent triggers `gh workflow run coverage.yml` and surfaces the lines/branches/functions/statements % deltas in the next tick output. This validates that the test cron's commits are actually moving the dial.

## CRITICAL — file-disjointness with the programming cron

This cron MUST NOT collide with the programming cron's work. Hard rule for every agent:

- **ALLOWED files**: `backend/test/**/*.test.js`, `frontend/src/__tests__/**/*.test.{js,jsx}`, `e2e/tests/**/*.spec.js` (NEW gate specs allowed but require the wire-in step to `deploy.yml` + `coverage.yml`; the cron parent does the wire-in commit, NOT the agent)
- **ALLOWED for cron parent only**: `.github/workflows/deploy.yml` + `.github/workflows/coverage.yml` (the wire-in lines — one commit per tick if any new e2e spec landed)
- **STRICTLY FORBIDDEN** (agents AND parent): any source file under `backend/{routes,services,lib,middleware,cron,prisma,utils}/`, any source file under `frontend/src/{pages,components,utils,hooks}/`, `docs/**`, `CLAUDE.md`, `TODOS.md`, `README.md`, `CHANGELOG.md`
- If a test reveals a real source-code bug, the agent **MUST** route the finding to a new GH issue (template below) AND mark the failing test `it.skip(...)` with a TODO comment referencing the issue number. NEVER fix source code.

The programming cron writes test files when it ships new source code. This cron writes ADDITIONAL test cases for under-covered EXISTING code. Collision only happens if both crons pick the same test file in the same tick — mitigated by the "files not modified in last 24h" picker rule below.

## Step 0 — Sync + gate state (NEVER skip)

```
git pull --ff-only origin main 2>&1 | tail -5
gh run list --branch main --workflow "Deploy to demo server (crm.globusdemos.com)" --limit 3 --json conclusion,status,headSha
```

If Deploy is RED on the latest CODE commit → SKIP this tick (let programming cron triage). Test-writing cron NEVER triages source bugs.

## Step 1 — Pick 3 file-disjoint under-covered targets

**Picker heuristic — ordered priority**:

**Priority T1 — Source files with NO sibling test file**
Run:
```
# Backend libs without unit tests
comm -23 \
  <(ls backend/lib/*.js | xargs -n1 basename -s .js | sort) \
  <(ls backend/test/lib/*.test.js 2>/dev/null | xargs -n1 basename -s .test.js | sort)

# Backend services without unit tests
comm -23 \
  <(ls backend/services/*.js | xargs -n1 basename -s .js | sort) \
  <(ls backend/test/services/*.test.js 2>/dev/null | xargs -n1 basename -s .test.js | sort)

# Backend middleware without unit tests
comm -23 \
  <(ls backend/middleware/*.js | xargs -n1 basename -s .js | sort) \
  <(ls backend/test/middleware/*.test.js 2>/dev/null | xargs -n1 basename -s .test.js | sort)

# Backend cron engines without unit tests
comm -23 \
  <(ls backend/cron/*.js | xargs -n1 basename -s .js | sort) \
  <(ls backend/test/cron/*.test.js 2>/dev/null | xargs -n1 basename -s .test.js | sort)

# Frontend pages without component tests
comm -23 \
  <(ls frontend/src/pages/*.jsx frontend/src/pages/**/*.jsx 2>/dev/null | xargs -n1 basename -s .jsx | sort -u) \
  <(ls frontend/src/__tests__/*.test.jsx frontend/src/__tests__/**/*.test.jsx 2>/dev/null | xargs -n1 basename -s .test.jsx | sort -u)
```

Each output is a candidate. Filter further by Step-2 staleness check.

**Priority T2 — Source files modified in the last 30 days that have <50% test coverage**
This is approximate — without running coverage every tick (heavy), heuristic: source files >100 LOC whose sibling test file is <30 LOC are likely under-covered.

```bash
# Find recently-modified source files with thin sibling tests
git log --since="30 days ago" --name-only --pretty=format: -- backend/ frontend/src/ \
  | grep -E "\.(js|jsx)$" | sort -u | grep -v test | grep -v __tests__ \
  | while read f; do
      sibling=$(echo "$f" | sed -E 's|^backend/(lib\|services\|middleware\|cron)/|backend/test/\1/|; s|\.js$|.test.js|')
      if [ -f "$sibling" ]; then
        src_lines=$(wc -l < "$f")
        test_lines=$(wc -l < "$sibling")
        if [ "$src_lines" -gt 100 ] && [ "$test_lines" -lt $((src_lines / 3)) ]; then
          echo "$f (src=$src_lines, test=$test_lines)"
        fi
      fi
    done | head -10
```

**Priority T3 — Existing test files with TODO / `.skip()` markers**
```bash
grep -rEn "it\.skip\(|describe\.skip\(|TODO.*test|FIXME.*test" backend/test/ frontend/src/__tests__/ | head -10
```

Each is a known coverage hole — a previous agent left a skip that should now be implemented (or the underlying bug fixed and the skip removed).

### Pick discipline

1. Run the T1 / T2 / T3 greps. Pool the candidates.
2. For each candidate, run `git log --since="24 hours ago" --oneline -- <source-file>`. If non-empty, SKIP this candidate (programming cron may be actively working on it).
3. Pick 3 candidates with NO 24h activity AND in different subsystems (e.g. one backend/lib, one backend/services, one frontend/src/__tests__/). This guarantees file-disjointness across the 3 parallel agents.

If fewer than 3 disjoint candidates → ship 1-2 agents. If 0 candidates → log "queue empty" and end tick (count as empty tick).

## Step 2 — Dispatch up to 3 agents IN PARALLEL

Critical: all 3 `Agent` tool calls in a SINGLE message block.

For each agent's prompt:

### Required preamble (every agent gets this verbatim)

```
You are a TEST-WRITING agent in the autonomous test-writing cron. Your scope is HARD-LIMITED:

ALLOWED files (NEW or MODIFY): exactly ONE test file at `<allowed path>`
FORBIDDEN files: ANY source file under backend/{routes,services,lib,middleware,cron,prisma,utils}/, frontend/src/{pages,components,utils,hooks}/, docs/, schema.prisma, CLAUDE.md, TODOS.md. ZERO exceptions.

If your test reveals a source-code bug:
1. DO NOT FIX THE SOURCE FILE.
2. Mark the failing test `it.skip(...)` with a TODO comment.
3. File a new GitHub issue using `gh issue create` with:
   - Title: "[Test-cron] Bug exposed by new test for <module>: <one-line>"
   - Body: include the failing test code, the actual-vs-expected behavior, and the line:column in the source file.
4. Reference the issue number in the test's TODO comment so the programming cron can pick it up later.

Commit format: `git commit --only <test-file> -F .tmp-test-agent-<id>-msg.txt` then delete the message file.
NO Co-Authored-By: Claude trailer.
```

### Agent's task body

Target a SINGLE source file. Either:
- (a) **T1**: source has NO sibling test → create `backend/test/<area>/<module>.test.js` (or `frontend/src/__tests__/<Page>.test.jsx`) and write ≥10 cases covering happy path + edge cases + error paths
- (b) **T2**: source has thin sibling test → add ≥5 new cases for paths the existing test misses (read source + existing test side-by-side; identify uncovered branches)
- (c) **T3**: existing `.skip()` test → implement it OR file an issue if the underlying source bug is real

Per-agent scope:
- One test file per agent (smaller commit blast radius)
- ≥5 new test cases
- All cases must pass green locally before commit (use `.skip()` only for genuine source-bug findings, never to dodge)

### File path discipline

For source `backend/lib/<module>.js` → test `backend/test/lib/<module>.test.js`
For source `backend/services/<module>.js` → test `backend/test/services/<module>.test.js`
For source `backend/middleware/<module>.js` → test `backend/test/middleware/<module>.test.js`
For source `backend/cron/<module>.js` → test `backend/test/cron/<module>.test.js`
For source `backend/routes/<route>.js` → test `backend/test/routes/<route>-<aspect>.test.js` (suffixed by aspect — e.g. `wellness-patients-xlsx.test.js`)
For source `frontend/src/pages/<Page>.jsx` → test `frontend/src/__tests__/<Page>.test.jsx`
For source `frontend/src/pages/<dir>/<Page>.jsx` → test `frontend/src/__tests__/<dir>/<Page>.test.jsx`

### Test discipline (encoded in agent's preamble)

- **Backend**: vitest with prisma mock (mirror existing `backend/test/services/bookingCom.test.js` or `backend/test/lib/eventBus.test.js` for the seam pattern). Cover happy path + RBAC gates + validation errors + tenant scoping.
- **Frontend**: vitest + RTL. Stable mock object refs for hooks (per CLAUDE.md "RTL: stable mock object references" rule). `findByText` over `getByText` for async content.
- **CJS self-mocking seam**: if the source module uses `module.exports.fn(...)` indirection, add a regression-pin test (`vi.spyOn(client, 'fn').mockResolvedValue(...)` proving the seam works).
- **Test naming**: `describe('<module>', ...)` + `it('<verb-phrase>', ...)`. Each `it` block tests ONE thing.
- **No e2e dependencies**: vitest unit tests must run without a running backend (mock prisma + external SDKs).

### Bug-finding routing — the canonical pattern

When a test reveals a source-code bug, the agent files an issue like this:

```bash
gh issue create \
  --title "[Test-cron] Bug exposed by new test for <module>: <one-line>" \
  --label "bug,test-cron" \
  --body "$(cat <<'EOF'
**Discovered by test-cron tick <YYYY-MM-DD HH:MM UTC>**.

While extending `<test-file-path>`, the following test case revealed a bug:

\`\`\`js
it('<the assertion that fails>', () => {
  // <test setup>
  expect(<actual>).toBe(<expected>);   // ACTUAL: <actual-value>, EXPECTED: <expected-value>
});
\`\`\`

**Source location**: `<file>:<line>` (`<function-or-method-name>`)

**Repro**:
1. <step 1>
2. <step 2>
3. <observed behavior>

**Expected behavior**: <what should happen>

**Hypothesis**: <one-line root cause guess — operator can ignore>

The test has been added with `.skip()` and a `TODO: #<this-issue-number>` reference; remove the skip + fix the source once this issue is resolved.
EOF
)"
```

The programming cron's "Phase 1.5 — Phase 1.5 single-commit slices" priority will pick these up (they appear as `bug` + `test-cron` labeled issues).

## Step 3 — Process the returns + push + wire new e2e specs into the gate

1. `git log --oneline -5` confirm commits landed.

2. **If any agent created a NEW `e2e/tests/<name>-api.spec.js`** (not just extended an existing one), the cron parent does a follow-up wire-in commit:
   - Read `.claude/skills/wiring-spec-into-gate/SKILL.md` for the exact pattern.
   - Add the spec line to `.github/workflows/deploy.yml`'s `api_tests` job's "Run API-only specs" step BEFORE `tests/teardown-completeness.spec.js`, with the trailing backslash (the c8a8ad4 missing-backslash incident is the canonical lesson — one absent backslash silently drops later specs).
   - Add the same spec line to `.github/workflows/coverage.yml`'s mirror list.
   - Commit BOTH workflow files in one commit: `git commit --only .github/workflows/deploy.yml .github/workflows/coverage.yml -m "ci(gate): wire <spec-name> into api_tests + coverage gates"`. NO `Co-Authored-By: Claude` trailer.
   - This is the ONLY situation where the test-writing cron touches a `.github/workflows/` file.

3. `git push origin main`.

4. Verify gate state after push. If RED on the latest commit and the failure is in the NEW test you just wired, file a follow-up GH issue with the failure details (don't auto-revert; the programming cron can triage source bugs).

5. If any agent filed a GH issue, note the issue number in the tick output.

6. **Every 8th tick** (track via tick counter): trigger the coverage workflow to measure progress:
   ```bash
   gh workflow run coverage.yml --ref main
   # Wait for completion in next tick — don't block this tick on it.
   ```
   In the NEXT tick's Step 0, fetch the latest coverage run's output and surface the % deltas:
   ```bash
   gh run list --workflow coverage.yml --limit 1 --json conclusion,headSha,databaseId
   # If completed, view its summary (the workflow prints lines/branches/functions/statements % for backend routes + helpers)
   ```
   Tick output should include the coverage % alongside the picks/SHAs.

## Step 4 — Stop conditions

- Deploy gate RED on the test-writing cron's HEAD AND the failure is in test code (not source) → SKIP next tick on the affected directory; the cron parent triages OR the programming cron picks up the source bug via filed issue
- All 3 agents REJECT or find no candidate → log + end tick (counts as empty)
- **3 consecutive empty ticks** → log "test queue empty — coverage may be near plateau" and surface to user (don't auto-delete the cron)
- **All candidates exhausted** (T1+T2+T3 grep returns < 3 candidates for 5 consecutive ticks) → surface to user
- **Coverage target reached** — latest `coverage.yml` run shows **≥95% lines AND ≥95% branches AND ≥90% functions AND ≥95% statements** for the backend `routes/` + `lib/` + `services/` + `middleware/` + `cron/` subsystems → graceful end with a verdict summary. (100% is aspirational; ≥95% is the practical "fully covered" threshold given unreachable edge paths.)
- Per-subsystem milestone: when a single subsystem hits ≥95% lines, log "subsystem `<X>` reached coverage target" and de-prioritize T1/T2 candidates from that subsystem; rotate to others.

## Hard constraints (carry forward)

- NEVER touch source files — only test files
- NEVER fix bugs — only file issues
- File-disjoint discipline with parallel agents in same tick (different test files)
- File-disjoint discipline with programming cron (skip files modified in last 24h)
- `git commit --only` per file (no bare `git commit -F` sweeping the index)
- NO `Co-Authored-By: Claude` trailer
- Test files only run vitest (no live backend, no demo SSH, no playwright unless extending an existing spec)
- All committed tests must pass green locally — `.skip()` is reserved for real source bugs with a filed issue

## Output (per tick, 6-10 lines)

- **Tick:** ISO timestamp + HEAD before + tick counter (for the every-8th-tick coverage trigger)
- **Picks:** 3 test targets + priority bucket (T1/T2/T3) + file paths (proves disjoint, proves no-24h-activity)
- **Dispatched:** 3 agent IDs OR fewer
- **Returned:** SHAs that landed + any REJECTED reasons + any GH issues filed
- **Bugs surfaced:** issue numbers filed this tick (with one-line summary each)
- **Gate wire-in:** SHA of the `.github/workflows/*.yml` wire-in commit if any NEW e2e spec landed this tick; "none" otherwise
- **Gate state:** latest deploy gate result (the cron's HEAD + previous 2 commits)
- **Empty-tick counter:** N consecutive
- **Coverage status:** (every 8th tick) lines % / branches % / functions % / statements % from the latest `coverage.yml` run, broken down by subsystem (`routes/`, `lib/`, `services/`, `middleware/`, `cron/`); intermediate ticks just report "next coverage run at tick #<N>"

The user is asleep when this is firing; the goal is to wake up to substantially-better code coverage AND a queue of bug-issues the programming cron can drain. Every test this cron ships must land in the Deploy gate — that's the success criterion, not just "test file exists." Be efficient with agent budget. Cron auto-expires in 7 days.
