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
