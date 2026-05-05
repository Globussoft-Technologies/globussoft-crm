# Per-agent prompt — template

Copy and fill in the `<placeholder>` slots. Use this for closer agents in a parallel wave; for the discovery agent or single-purpose agents, adapt the relevant sections.

---

```
<One-line task summary — what this agent will ship and what gap-id it closes>

**Repo:** c:\Users\Admin\gbs-projects\gbs-crm

**Local stack should be up:** http://127.0.0.1:5000 (PID in `.scripts-state/backend.pid`). If it's down: `.\scripts\local-stack-up.ps1`.

## Skill to use

Use the **`<skill-name>`** skill at `.claude/skills/<skill-name>/SKILL.md`. Read it before starting — it captures the standing rules + pattern selection + verification steps so you don't have to re-derive them.

<If a second skill is needed for handoff (e.g. wire-in after spec):>
After the primary work is green, use the **`<handoff-skill-name>`** skill for <what it does — typically wire-in or filing an issue>.

## Target

- **Route file:** `backend/routes/<area>.js` (read end-to-end first to understand the contract)
- **Spec to create:** `e2e/tests/<area>-api.spec.js` (or `backend/test/<area>/<module>.test.js` for vitest)
- **Pattern to clone:** `<reference-spec-path>` — see the skill's pattern-selection table for why this is the closest match
- **Engine (if cron-spec):** `backend/cron/<engine>.js` — read it to understand window math + dedup contract

## Acceptance criteria

Standard 7-criterion set (per the skill). Task-specific additions:
1. <task-specific assertion 1 — e.g. "no time-window dedup, only state-based; spec asserts the actual contract">
2. <task-specific assertion 2>

## Wire-in

<If the skill includes wire-in instructions, mention here. Otherwise:>
After spec is green, run `.claude/skills/wiring-spec-into-gate/wire-in.sh tests/<area>-api.spec.js` to add to deploy.yml + coverage.yml gate-spec lists.

## Coordinate with siblings

Sibling agents in this wave are working on these disjoint files (so don't touch them):
- Agent A: `backend/routes/<other-area-1>.js` + `e2e/tests/<other-1>-api.spec.js`
- Agent B: `backend/cron/<other-engine>.js` + `backend/test/cron/<other-engine>.test.js`
- Agent C: `e2e/global-teardown.js` (adding teardown for X)

ALL agents touch:
- `.github/workflows/deploy.yml` — gate-spec list (use wire-in.sh; rebase on collision)
- `.github/workflows/coverage.yml` — same
- `docs/E2E_GAPS.md` — status markers

If `git push` rejects with non-fast-forward, `git pull --rebase origin main` and retry. The wire-in script is idempotent.

## Progress reporting (mandatory)

The user watches `/developer` page on the live frontend (polls every 3s). Tag yourself with a stable agent id and log start / milestone(s) / commit / done events via the helper:

```bash
TAG="<your-agent-tag>"   # e.g. "agent-F-onClick-cluster", "G-12-campaign-engine"
LOG=".claude/skills/reporting-agent-progress/log.sh"

# At start (before reading files):
$LOG --agent "$TAG" --action "start" --message "<one-line task summary>"

# After each major milestone (spec green, wire-in done, etc.):
$LOG --agent "$TAG" --action "milestone" --message "<what just finished>"

# Immediately after each git commit:
$LOG --agent "$TAG" --action "commit" --commit "$(git rev-parse HEAD)" --file "<main file>" --message "<commit subject>"

# At the end (success or failure):
$LOG --agent "$TAG" --action "done" --status "green" --message "<one-line summary>"
$LOG --agent "$TAG" --action "failed" --status "red" --message "<blocker description>"
```

Read [`.claude/skills/reporting-agent-progress/SKILL.md`](.claude/skills/reporting-agent-progress/SKILL.md) for the full protocol. The script falls back to file-only logging if the backend is down — never skip.

## Authority

Full — run scripts, edit files, commit, push to origin/main. Cap iterations at 5 per failing test. Don't commit dubious workarounds; if blocked, report and stop.

## Commit hygiene (mandatory during parallel waves)

Use `git commit -o <pathspec> -F /tmp/msg.txt` (the `-o` short for `--only`), NEVER `git add <file> && git commit -m "..."`. The `-o` form atomically pins the commit to ONLY the named files even if a sibling agent races and stages something into the index between your add and commit:

```bash
# UNSAFE during waves — race window:
git add backend/routes/foo.js e2e/tests/foo.spec.js
git commit -m "fix(foo): close #N"

# SAFE — equivalent to --only, atomic, no index race:
cat > /tmp/msg.txt <<'EOF'
fix(foo): close #N

<body>
EOF
git commit -o backend/routes/foo.js -o e2e/tests/foo.spec.js -F /tmp/msg.txt
```

The 2026-05-05 5-agent wave hit two index-race incidents (Agent F's `cfb9973` captured 7 of Agent J's files; the #413 commit bundled 6 unrelated). The v3.4.12 closure wave switched to `-o` from the start and shipped 27 issues across 5 agents with **zero collisions**. See [SKILL.md "Concurrent-agent git hygiene"](SKILL.md) for the full pattern.

## DO NOT

- Include "Co-Authored-By: Claude" in commit messages (global rule)
- Use `req.user.id` (the JWT key is `userId` — ESLint blocks the wrong form)
- Touch sibling agents' files (per Coordinate section above)
- Push to a branch other than `main`
- Skip tests that should pass; if a test is genuinely irrelevant document with `test.fixme()` + a TODO

## Final report

Send back:
1. **Spec path + test count** (e.g. `e2e/tests/foo-api.spec.js — 27 tests`)
2. **Runtime green-state** (e.g. `~5.3s on local stack`)
3. **Commit hash** pushed to origin/main
4. **Wire-in confirmation** (`deploy.yml` + `coverage.yml` updated; line count delta = +1 each)
5. **Contract-drift findings** flagged for separate `[regression]` issues — list each with: surfacing test name, suspected root cause, recommended fix sketch. DO NOT fix in this PR.
6. **Any sibling-collision recovery** you had to do (rebase count, etc.) — useful telemetry for tuning future wave sizes.
```

---

## Adaptations by agent role

### For a discovery agent (read-only, no commits)

Replace "Authority: full" with:

```
**Authority:** READ-ONLY. Don't edit, don't commit, don't push.

**Final report:** structured list of gap candidates. For each:
- ID (R-N or G-N or self-assigned)
- Title (1 line)
- Bucket (Quick win / Medium / Multi-day)
- Why it matters (1 sentence)
- Files to create/edit
- Effort estimate
- Blockers (if any)

End with **3-5 picks for the next parallel batch** — disjoint files, all unblocked. Keep it tight, under 500 words.
```

### For an engine-fix agent (closes a contract-drift issue)

Add after "Skill to use":

```
## Issue to close

GitHub issue **#NNN** — <one-line summary>. Body has the recommended diff.

**Critical:** verify the recommended diff against the existing spec contract before applying. The #411 lesson: the issue suggested `action: 'RETENTION_SWEEP'` but the spec asserted `action: 'DELETE'`; the agent correctly used `'DELETE'` with `via: 'cron'` in details instead. Spec contract wins over issue diff.

## Add a unit test

Add `backend/test/cron/<engine>.test.js` (or whichever module the fix is in) with at MINIMUM:
1. Anti-regression test against the OLD broken form (e.g. assert `notIn: ['VOID', 'VOIDED']` not `not: 'VOID'` — would fail if someone reverts)
2. Happy-path test of the new behavior
3. Edge case (e.g. for retention: assert audit row written even when `deleted=0`)

Use the `writing-vitest-unit-test` skill for the mock-setup pattern.
```

### For a heal-loop agent (post-wave verification)

Replace "Acceptance criteria" with:

```
## Mission

Run the full local 4-gate (build + lint + api_tests + unit_tests) and ensure it goes green. If anything fails:
1. Diagnose by category — stale fixture, test bug, route bug, schema drift
2. Fix it (test or route, depending on category)
3. Re-run the failing spec
4. When green, re-run the full gate to confirm no regressions

Cap at 5 fix iterations per spec. Don't commit dubious workarounds.

## Hard-block escalations (don't fix; report to user)

- Schema migrations
- New routes / endpoints
- Removing tests or `test.skip`-ing them
- Changes to `lib/leadJunkFilter.js`, `lib/fieldEncryption.js`, `middleware/auth.js`, `middleware/security.js`

## Authority

Full — same as closer agents. Push only when green.
```
