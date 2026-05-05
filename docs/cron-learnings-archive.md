# Cron-learnings archive

This is the post-review home for entries that were originally logged into `CLAUDE.md`'s "🤖 Cron learnings (auto-logged)" section, then moved here when the user reviewed them and accepted the proposed disposition.

The point of archiving (instead of deleting) is to keep a paper trail: future readers can see what observations the autonomous loop surfaced, what the user decided to do with each, and what the resolution was (already-covered / standing-rule-promoted / skill-promoted / dropped).

## Schema

Each entry retains its original timestamp + commit-sha + topic + paragraph, plus a **Disposition** line at the bottom explaining where it landed.

---

## Reviewed 2026-05-05

### 2026-05-05 ~01:00 — `e72cd5c` — IS_LOCAL_STACK pattern is generalizable

Specs that share a filesystem with the backend (disk readback, child-process invocation of an engine, filesystem fixture loading) work fine on the per-push gate (BASE_URL=127.0.0.1) but cascade-fail on `e2e-full.yml` against demo (BASE_URL=https://crm.globusdemos.com). The `backup-engine-api.spec.js` was the canonical case; `migration-safety.spec.js`, `eventbus-conditions.spec.js`, `eventbus-template.spec.js`, possibly `lead-scoring.spec.js` may all need the same `IS_LOCAL_STACK` guard. Sample `IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL)` already in `e2e/tests/backup-engine-api.spec.js`.

**Disposition:** archived — already a standing rule in `CLAUDE.md` ("Local-stack-only specs must guard on BASE_URL"). The standing rule was updated during review to also mention the sibling `probePrismaClient()` / `dbAvailable()` pattern (originally entry #6 below) so both are codified together.

### 2026-05-05 ~01:30 — `b892174` — additive-envelope is the right shape for API-contract changes

When `POST /api/communications/send-email` needed multi-recipient support (#435), the response shape changed from `{success, delivered, email, ...}` to `{success, delivered, email, ..., totalSent, totalFailed, results, failures}`. Top-level back-compat fields preserved → 50+ existing specs and the Inbox + DocumentTemplates frontends kept working unchanged; envelope additions surfaced the new info.

**Disposition:** archived — already a standing rule in `CLAUDE.md` ("API response shape change") that the entry itself authored. No further action.

### 2026-05-05 ~03:30 — `e8cce09` — two valid "spec needs local backend" guard styles, both effective

Surveying the 5 e2e specs that spawn child Node processes / touch backend filesystem (`backup-engine-api`, `migration-safety`, `recurring-invoice-api`, `retention-api`, `scheduled-email-api`, `wellness-ops-api`), I found two coexisting patterns: (a) **`IS_LOCAL_STACK` regex on `BASE_URL`** at describe-level — coarse, "is the test run cross-machine?" check (used by backup-engine-api + now migration-safety); (b) **`probePrismaClient()` / `dbAvailable()`** at spec-level — granular, "is the backend's Prisma client actually reachable?" check (used by the other 4). Both correctly cause e2e-full's runs against demo to skip these specs without false negatives. Pattern (a) is simpler when the spec is fundamentally local-only; pattern (b) is more flexible when the spec has SOME tests that work cross-machine and SOME that don't. Don't refactor (b)→(a) for consistency — they're not equivalent (a remote-but-Prisma-installed runner would be skipped by (a) but accepted by (b), which IS the right behavior for some test surfaces). Both patterns earn their keep.

**Disposition:** archived — folded into the IS_LOCAL_STACK standing rule (above) as the "both guard styles coexist" caveat.

### 2026-05-05 ~03:00 — `0a13386` — autonomous-loop design pattern: split logging from judgment

The cron originally tried to do BOTH wave-cleanup observations AND skill creation in one prompt. Skill creation is high-judgment work — agents either over-skilled (every tiny one-off becomes a skill, bloating the surface) or under-skilled (real patterns get missed). Splitting the responsibilities — autonomous loop only LOGS observations to a known section; human-triggered review walks each entry and decides skill / standing-rule / archive / drop — preserves the autonomy benefit while keeping the judgment work where it belongs. **Generalizable pattern: any "automated curator" prompt should separate evidence-gathering (high-frequency, low-judgment, cron-friendly) from synthesis (low-frequency, high-judgment, human-in-loop).**

**Disposition:** dropped — meta-observation about prompt design, not a recurring concern in this codebase. The pattern lives in the cron prompt itself (which separates logging from review) and in this archive's existence; future agents authoring autonomous loops can read the cron's source for the example.

### 2026-05-05 ~04:00 — `n/a` — Edit tool normalizes `\u`-style escapes when reading

When I tried `Edit({old_string: 'comparison\\u2026', new_string: 'comparison…'})` to fix the #430 bug, the tool reported "old_string and new_string are exactly the same" — meaning it normalized the JS escape into the unicode char on read, so the byte-precise replacement appeared as a no-op. Workaround: drop to Bash + Python's `chr(92) + 'u2026'` for the search side and `chr(0x2026)` for the replacement side, which forces byte-level handling.

**Disposition:** dropped — narrow tool quirk. The workaround is captured at the spec-level via the JSX-text standing rule (which calls out the canonical fix: use real unicode chars or HTML entities, never `\u`-escapes between JSX tags). Anyone hitting an Edit-tool normalization issue can re-derive the Python workaround in 30 seconds.

---

## Reviewed 2026-05-06

Second batch — 9 entries from the 2026-05-05 → 2026-05-06 5-agent wave + iterate-on-CI-feedback arc. **All 9 promoted (5 to skill extensions, 1 to new skill section, 1 to release-validation extension, 2 to standing rules) — none dropped.**

### 2026-05-05 ~07:00 — `1ef4ba5` — concurrent agents share the git index, not just the working tree

When 5 agents run in parallel against the same repo, each agent's `git add file` leaves staged things behind in the shared index. A parent agent's later `git commit` (without explicit pathspec) sweeps up sibling agents' WIP. Hit this once mid-wave: my `git commit` of the #413 schema fix bundled in 6 unrelated files (Agent B's e2e specs + the deduplication helper). Caught pre-push via `git status --short`, did `git reset HEAD~1 --mixed`, re-staged only my 2 files with explicit pathspec, clean push.

**Disposition:** archived — folded with entry below (`55fef9f`) into a new `dispatching-parallel-agent-wave` skill section "Concurrent-agent git hygiene" that captures problem + precise mitigation in one place.

### 2026-05-05 ~07:00 — `51e8891` — apply `verifying-issue-before-pickup` to multi-day flagships

G-21 (Frontend vitest + RTL coverage expansion) was estimated 3-5 days in TODOS for several sessions. Agent D shipped it in ~10 minutes of real work because vitest infra was ALREADY in `frontend/vite.config.js` from earlier waves, with 18 existing test files. The actual gap was just (a) wire existing tests into a CI gate, (b) fix 3 stale failing tests, (c) add 6 new test files for under-covered surfaces.

**Disposition:** archived — `verifying-issue-before-pickup` skill extended with "Apply to multi-day flagships, not just GitHub issues" section, including the pre-flight grep checklist for "set up X" / "stand up Y" / "bootstrap Z" rows.

### 2026-05-05 ~07:00 — `(no-commit)` — Agent C's "stop-before-push when CI gate would fail" discipline

Agent C completed the #413 schema work but stopped before push because `check-migration-safety.js` flagged 6 false-positive risks. The agent reported the flag, asked for direction, and waited rather than push-and-hope. This let the parent confirm the false-positive analysis and ship a one-line detector bug-fix bundled with the schema change in the same commit (`1ef4ba5`).

**Disposition:** archived — `dispatching-parallel-agent-wave` skill extended with "Stop-before-push when a local CI-equivalent gate fails" rule (mandatory in agent prompts).

### 2026-05-05 ~08:00 — `6f140bc` — agents authoring NEW specs MUST run them locally before committing

Agent A's `9abbafe` shipped a new `landing-page-upload-api.spec.js` that compiled clean (build green, eslint clean, `node --check` green) but FAILED on every per-push api_tests run — the spec read tenant-id from `j.user?.tenantId` instead of `j.tenant?.id`. Result: 4 consecutive failed deploys, demo stuck at b180c4b for ~50 min. Build/lint/syntax checks don't catch this class of bug — only running the spec does.

**Disposition:** archived — `dispatching-parallel-agent-wave` skill extended with "NEW spec authored by an agent? Run it locally before commit" section. Mandatory rule in any agent prompt that authors a NEW spec.

### 2026-05-05 ~22:30 — `36e554d` — unblocking previously-unreachable code paths surfaces latent bugs

The #445 Nginx fix enabled `POST /p/<slug>/submit` to actually reach the backend (pre-fix, the SPA shell intercepted it). The handler at `routes/landing_pages.js:438` had a latent `prisma.contact.upsert({ where: { email: contactEmail } })` bug against a Contact model whose unique constraint is `@@unique([email, tenantId])`. Bug had been there since the original landing-page module shipped; no production signal because Nginx blocked everything.

**Disposition:** archived — promoted to a new CLAUDE.md standing rule: "After infrastructure / deploy fixes, end-to-end-test the now-reachable code paths."

### 2026-05-05 ~22:30 — `47e7a1d` — e2e-full assertions on aggregate counters don't survive demo's background activity

`workflows-api.spec.js:279` asserted `afterTotal === beforeTotal` on generic's workflow-history count after a wellness fire. On per-push gate (local stack with `DISABLE_CRONS=1`), the count was always exact. On demo (e2e-full), background cron engines fire generic-tenant rules continuously; the count grew by +6 in the few hundred ms between before/after measurements. Pure noise.

**Disposition:** archived — promoted to a new CLAUDE.md standing rule: "Demo-state-aware test assertions: target tagged-data-specific rows, not aggregate counters." Distinct from the existing IS_LOCAL_STACK rule (which is about WHICH TESTS run cross-machine; this is about HOW SURVIVING TESTS' ASSERTIONS are written).

### 2026-05-05 ~23:00 — `d84b0d9` — iterate-on-CI-feedback closed the chronic-red e2e-full arc

Sequence: triggered run → categorize failures (real-bug / spec-fixture / demo-state / deploy-block) → fix the first category → push → wait for deploy → re-trigger → repeat. 4 e2e-full re-triggers across the session, each revealing a different failure class as the prior was cleared. Final result: all 4 shards green for the first time since v3.4.9.

**Disposition:** archived — `triaging-stuck-deploy-gate` skill extended with "Same shape applies to release-validation gates" section, encoding the per-push-vs-release-validation discrepancy taxonomy.

### 2026-05-06 ~00:30 — `55fef9f` — `git commit --only <files> -F msg` is the safe form during concurrent agent waves

Agent F's first commit attempt (`cfb9973`) captured 7 of Agent J's files via the index race. They soft-reset and re-committed with `git commit --only contacts.jsx inbox.jsx -F msg.txt` which atomically pins the commit to ONLY those files even if the index races mid-operation.

**Disposition:** archived — folded with the `1ef4ba5` entry above into the `dispatching-parallel-agent-wave` skill's new "Concurrent-agent git hygiene" section. That entry identified the problem; this one named the precise mitigation.

### 2026-05-06 ~00:30 — `(observation)` — GitHub auto-close trailers cap silently on multi-issue commits

Both Agent G's `a2895d8` (`Closes #462 + #463` shortform) and Agent J's `ecb4ae0` (7 separate `Closes #N` lines) had trailers that DIDN'T fire. The shortform-vs-separate-line distinction matters somewhat (`Closes #N + #M` only auto-closes the first per GitHub's grammar), but the per-commit cap is real too.

**Disposition:** archived — `dispatching-parallel-agent-wave` skill extended with "Verify each issue's auto-close after multi-issue commits" section, including the bash one-liner to verify each issue and the manual close pattern for any that didn't fire.
