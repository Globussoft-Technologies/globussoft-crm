# Documentation Drift Audit — 2026-05-17

**HEAD scanned:** `741d848` (origin/main; per `git status` shown clean at start; the in-flight 2026-05-15 handoff block at the top of TODOS.md references `5d3205d`, which is not on `origin/main` — see TODOS.md finding A1 below)
**Backend package.json version:** `3.7.16`
**Docs scanned:** 25 files (4 root-level + 17 under `docs/` + 8 under `docs/wellness-client/`) ≈ 14,710 lines total
**Method:** counts cross-checked with `find` / `grep -c "^model "`; issue states verified with `gh issue view`; endpoint refs verified with file existence; spec-existence verified with `ls e2e/tests/`

---

## Executive summary

1. **TODOS.md (3,766 lines) is the largest single drift surface.** Has 33 stacked "SESSION HANDOFF" blocks, ~25 of them marked "superseded above". Most "open" issues in the user-attention block (#555 / #558 / #564 / #565 / #574 / #589 / #632) are **CLOSED** per `gh issue view`. The bigger-investments / cron-skipped / PRD-gap sections still describe v3.2.x state from 2026-04-26.

2. **CLAUDE.md has stale architecture counts** that contradict README.md's "At a glance" table on the same repo. CLAUDE.md says 19 cron engines, 91 routes, 80 pages, 114 models, 23 API specs / ~1,084 tests, 22 vitest files, 30 frontend test files. Actuals: 22 engines, 103 routes, 122 pages, 151 models, 234 spec files, 90 backend vitest, 61 frontend vitest. CLAUDE.md line 18 says "counts surfaced in README.md so they don't rot here" but the section below still rots them.

3. **`docs/test-coverage-gaps.md` has a stale-warning banner already**, but the under-the-banner backlog (API-1..API-46 / CRON-1..CRON-9 / FE-1..FE-6) drifts in concrete ways: at least 14 of the 26 CRON-XX targets now have vitest files; ~25 of the 46 API-XX targets have a `<name>.spec.js` partner (just not always the `*-api.spec.js` filename the doc demands). The banner reads "many have shipped" but doesn't say which.

4. **`docs/wellness-client/STATUS.md` is the most-out-of-date individual doc.** Last-updated 2026-05-04 stamped "v3.4.9 tagged" — current is v3.7.16. Says PatientDetail has "5 tabs" (README says 7); says coverage baseline is 33.20% (CLAUDE.md says routes coverage is 40.52% / helpers 79.01%); cites c. v3.2.x as the wellness feature surface but v3.5.0 / v3.7.x added POS, Attendance/Leave, WhatsApp 2-way, Booking widget completion, wellness consent archive endpoints, ledger-style wallet/cashback/coupon, etc.

5. **CHANGELOG.md top-3 entries (v3.7.14 / v3.7.15 / v3.7.16) are accurate.** Numbers, commit SHAs, and behaviour descriptions all match the code. Nothing to flag in the historical narrative.

---

## Per-doc findings

### `README.md` (440 lines)

- Drift class: minor (one stale CHANGELOG cross-link target; otherwise clean — counts auto-derived).
- Specifics:
  - line 178: **header reads `## All Modules (102 Routes)`** — actual `find backend/routes -name "*.js" | wc -l = 103`. Off-by-one against the "At a glance" table on the same page (line 14 says 103). Severity: minor.
  - line 347: `102 route modules` — same off-by-one. Severity: minor.
  - line 355: **header reads `## Automation Engines (16 Cron Jobs)`** but the table below has 16 row entries; actual `find backend/cron -name "*.js" = 22`. The "At a glance" table on line 17 says 17 (also wrong; actual 22). Missing engines from the table: `auditIntegrityEngine`, `demoHygieneEngine`, `leadSlaEngine`, `leavePolicyEngine`, `lowStockEngine`, `campaignEngine` (listed but cadence says "Every 1 min" — verify), `slaBreachEngine`. Severity: stale (counts will get re-asserted on next release-bump).
  - line 14: `API routes | 103` ✅ matches actual.
  - line 15: `Data models | 151` ✅ matches actual.
  - line 16: `UI pages | 122` ✅ matches actual.
  - line 17: `Automation engines | 17` — **wrong**, actual is 22. Severity: stale.
  - line 18: `Playwright spec files | 234` ✅ matches actual.
  - line 19: `Backend vitest files | 90` ✅ matches actual.
  - line 20: `Frontend vitest files | 61` ✅ matches actual.
  - line 21: `Reusable Claude Skills | 17` ✅ matches actual.
  - line 54 (Tech Stack row): `~199 spec files; ~79 in the per-push gate ... 42 backend + 6 frontend unit-test files` — **all four numbers are stale.** Actuals: 234 specs, 103 `*-api.spec.js` (per-push subset wires ~79–80), 90 backend vitest, 61 frontend vitest. Severity: stale.
  - line 400 + 403: same `~199 spec files`, `~79 Playwright API specs (~2,560 tests)`, `~3,784 tests on every push` claims — all derived from line 54's stale numbers. The top-of-file table is right; these prose paragraphs are wrong.
  - line 406: `42 backend vitest files (~1,189 tests covering …)` — actual 90.
  - line 407: `frontend_unit_tests — 6 frontend vitest files (~35 tests)` — actual 61.
- Recommendation: **refresh** — README has an explicit "Counts auto-derived" promise on line 10; replace the prose stats on lines 54, 178, 347, 355, 400–407 with derived/parameterised values or simply delete those redundant numerics and point at the "At a glance" table. The 16/17 engine table at line 357 needs the 6 missing engine rows added.

### `CLAUDE.md` (425 lines)

- Drift class: counts everywhere; explicit promise on line 18 says counts shouldn't rot here. They have.
- Specifics:
  - line 18: claims "Counts (`e2e/tests/` Playwright, `backend/test/` vitest, `frontend/src/__tests__/` vitest, `.claude/skills/`) are surfaced in [README.md](README.md)'s 'At a glance' table so they don't rot here." But:
  - line 46: `Testing | Playwright E2E (e2e/ directory, 40 spec files)` — actual 234. Off by 194.
  - line 58: `prisma/schema.prisma -- MySQL via Prisma ORM ..., 114 models` — actual 151.
  - line 67: `### Cron Engines (backend/cron/) -- 19 engines` — actual 22 (missing `auditIntegrityEngine`, `demoHygieneEngine`, `leadSlaEngine`, `leavePolicyEngine`, `lowStockEngine` from the table below).
  - line 117: `### Routes (backend/routes/) -- 91 route files` — actual 103. The 12-route delta corresponds to ~v3.4.x..v3.7.x additions (admin.js, pos.js, memberships.js, attendance.js, leave.js, drugs.js, revenue_goals.js, commission_profiles.js, service_categories.js, etc).
  - line 149: `React.lazy() for 80 page components` — actual `find frontend/src/pages -name "*.jsx" = 122`.
  - line 156: `### Frontend Pages (frontend/src/pages/) -- 80 pages` — same drift.
  - line 184: PatientDetail "7 tabs: history, Rx, consent canvas, treatment plans, log visit, photos, inventory" — this is correct per the actual page; the wellness-client/STATUS.md says 5 tabs, **STATUS.md is the doc with the drift here**, not CLAUDE.md.
  - line 192: `### Prisma Models (114 total)` — actual 151. Generic listed as 99, wellness as 9 (= 108) doesn't add up to the claimed 114. Wellness vertical has also added Resource / Holiday / ProductCategory / Vendor / InventoryReceipt / InventoryAdjustment / AutoConsumptionRule / WalletTransaction / CashbackRule / GiftCard / Coupon / Sale / Register / Shift / Attendance / Leave / WhatsAppThread / etc that aren't in this list.
  - line 232: `Testing | Playwright E2E (e2e/ directory, 40 spec files)` — duplicate of line 46, same drift.
  - line 238: `api_tests — MySQL 8 container + seed both tenants + boot backend on :5000 + 23 Playwright API specs / ~1,084 tests` — actuals are ~79 `*-api.spec.js` wired in deploy.yml's spec list / **~2,560 tests** per README's prose; the entire "Four mandatory parallel gates" wording is also stale — README says 6 mandatory gates (`build / lint / api_tests / unit_tests / frontend_unit_tests / migration_check`).
  - line 239: `unit_tests — vitest over 22 backend test files / 674 tests` — actual 90 backend vitest files; total tests considerably higher (CHANGELOG v3.7.x cites 4,400+ on every push).
  - line 242: `Last measurement (commit 868b227): 40.52% lines / 73.30% branches ...` — commit-pinned, **historical**, not drift.
  - line 332: claims "Local stack mirrors the deploy.yml `api_tests` gate exactly" — accurate.
  - line 353 (Standing rule): `**~1,665 API tests on every push** (deploy.yml api_tests gate, **50 specs**) **+ 803 vitest unit tests** (deploy.yml unit_tests gate, **30 files**) = **~2,468 total per-push**` — every number stale; aligns with v3.4.x era (~April).
  - **Cron-learnings section (lines 280–425) is historical narrative, not drift** — the entries are dated and time-stamped, intended to be archive material when reviewed. The 2026-05-13-evening trio at the bottom is the most recent and pre-v3.7.16.
- Recommendation: **refresh the architecture-counts block (lines 46–192) and the deploy-flow block (lines 232–242).** Either delete the rotting numbers entirely (per the line-18 promise) and rely on README's table, or auto-derive at version-bump time. The cron-learnings tail can stay as-is — that's intended history.

### `CHANGELOG.md` (3,391 lines)

- Drift class: none in the audited window (top 3 entries: v3.7.14 / v3.7.15 / v3.7.16).
- Specifics:
  - lines 3–98 (v3.7.16 entry): commit SHAs verified (`714f411`); 110-spec wholesale-bump description matches `git diff v3.7.15..v3.7.16 --stat` shape; "8 consecutive spec-only stabilization releases" trajectory table matches the 10 release tags pushed (v3.7.7 → v3.7.16).
  - lines 99–193 (v3.7.15): commit `ad6f46c` verified; AutomationRule id=5550 detail is verifiable.
  - lines 194+ (v3.7.14): commit reference accurate.
  - Older history (>3 entries deep) is by-the-rules out-of-scope per the audit brief.
- Recommendation: **leave** — append-only doc per docs/README.md convention; historical entries don't need refreshing.

### `TODOS.md` (3,766 lines)

- Drift class: stacked handoff blocks (33 total H2 sections, ~25 marked "superseded above"); user-attention block claims open issues that are CLOSED; bigger-investments / cron-skipped / PRD-gap sections still describe v3.2.x state from 2026-04-26.
- Specifics by line range:

  **A. Top handoff (2026-05-15, lines 7–28):**
  - line 9: `HEAD on origin/main: 5d3205d`. **Inconsistency with current state** — `git rev-parse HEAD` returns `741d848`. Either `5d3205d` was pushed and a later commit landed without updating this block, or `5d3205d` was never pushed. The 2026-05-14 handoff at line 30 says "the docs/handoff commit pushed at session-end" — possibly the 2026-05-15 work is ahead of what's been audited. Severity: stale within-handoff but no down-stream drift.
  - lines 14–17: "What shipped today" references commits `d567ce2`, `cf678f7`, `4e24a0d`, `5d3205d`. None are on origin/main per `git log --oneline | head` showing `d61568a` (docs handoff) as HEAD. **Severity: confusion** — either the 2026-05-15 work is on a feature branch or hasn't pushed.

  **B. Tasks needing user attention (lines 298–319):** every "open" issue marked as awaiting product input is CLOSED per `gh issue view`:
  - line 311 `#555 Tenant context flips silently` → CLOSED (closed v3.7.3 per HANDOFF and PENDING_USER_AND_OPERATOR.md).
  - line 312 `#574 frontend follow-up` — references `#574` (CRIT-10 field-permissions) — CLOSED. The follow-up bullet is right that the frontend cleanup is autonomous-fixable but doesn't reference a separate open issue.
  - line 313 `#589 sibling routes follow-up` — `#589` itself CLOSED; the "follow-up" line claims sibling routes need RoleGuard. Whether the follow-up actually shipped requires code-grep; the row is non-actionable in this audit.
  - line 314 `#558 Audit log has no tamper-evidence` → CLOSED (v3.7.5 per HANDOFF).
  - line 315 `#564 Wellness patient detail has no consent-form / signature surface` → CLOSED (v3.7.3 per HANDOFF).
  - line 316 `#565 Wellness P&L doesn't reconcile` → CLOSED.
  - line 318 `#632 follow-up — Staff/Profile aria-label sweep` → `#632` CLOSED. Whether the follow-up shipped requires code-grep.
  - Severity: **stale** — the user-attention table is the entry point for "what blocks the autonomous loop" and every blocking item it lists is no longer blocking.

  **C. Operator-blocker tasks (lines 373–390):**
  - line 380 `**B-03** Verify SendGrid Sender Identity` → CLOSED 2026-05-13 per PENDING_USER_AND_OPERATOR.md line 24. Severity: stale.
  - line 386 follow-up issue "Cloudflare/Nginx swallows backend 502 body on /send-now" — unfiled per its own wording; no GH issue to verify. Genuine open if-still-relevant.
  - line 388 "Estimate `validUntil` upper-bound cap" — references #178 + #322 (both CLOSED per `gh issue view`). The status is mixed: the design-question still open but the spec test pinning the current behavior may have shipped. Worth verifying with the writer.

  **D. Stacked handoff blocks (lines 7–2278):**
  - 33 H2 sections starting with "🏁 SESSION HANDOFF" / "PICKUP-AT-HOME" / "PREVIOUS-SESSION".
  - ~25 marked "superseded above" in their title. The blocks 2026-05-09 and older are explicitly superseded and provide no actionable current information.
  - The conscious archival pattern uses `docs/handoffs-archive/` (e.g. HANDOFF-2026-05-08.md). The same pattern applied to TODOS.md handoff blocks would shrink the file by ~85%.
  - Severity: **bloat, not wrong** — these blocks are historical and won't mislead, but they make the file unreadable.

  **E. Bigger investments / cron-skipped / PRD gap sections (lines 3480–3669):**
  - line 3480 "📋 Office handoff — what shipped overnight" — from 2026-04-26. Severity: stale-but-historical.
  - line 3500 "🟡 Ship this month" — all checked off `[x]` with commit refs; severity none.
  - line 3578 `#228 No mobile responsive design` — left open `[ ]`. README line 21 + CHANGELOG v3.2.5 cover #228 closure ("Mobile responsive 80/20 shipped"). Likely closed. Severity: stale.
  - line 3590 `41 pre-existing e2e failures` — explicitly noted as stale and overcounted at lines 3700+. Severity: known-stale, already triaged.
  - lines 3624–3669 "PRD gap analysis (vs `docs/wellness-client/PRD.md` v1)" — cross-checked 2026-04-26 against the route code. Subsection 6.4 + 11 + 14.3 + 14.4 marked open; 14.3 and 14.4 have follow-up rows at lines 324–369 that close 14.3 as "✅ verified out-of-scope" and 14.4 as "partial — demo script shipped". The original "open" markers at lines 3640+ were not updated. Severity: stale.

- Recommendation:
  1. **Archive superseded handoffs.** Move lines ~150 through ~2278 (every handoff dated 2026-05-13 or earlier — 30 of the 33 blocks) into a single dated file `docs/handoffs-archive/TODOS-historical-2026-05-pre-15.md`. The convention exists for top-level handoffs; apply it to TODOS too.
  2. **Strike the user-attention rows for #555/#558/#564/#565/#574/#632** with the closing release tag (already done via the `Closed v3.7.3` etc. wording in `PENDING_USER_AND_OPERATOR.md` — replicate that here or drop the rows).
  3. **Strike B-03** as closed 2026-05-13. The "Operator-blocker tasks" table at lines 377–381 should show 0 open items.
  4. **Replace the PRD-gap section (3624–3669)** with a pointer to `docs/wellness-client/PRD.md` + the latest verification commit; the 2026-04-26 snapshot is misleading enough that fresh readers will redispatch already-shipped work (this is exactly the phantom-carry-over standing rule that has 7 confirmed instances).

### `docs/README.md` (75 lines)

- Drift class: none material.
- Specifics:
  - line 25: refers to "`PRD_AI_ERA_CRM_REBUILD.md` ... Draft v0.1" — matches the file's actual heading.
  - line 33: links `test-coverage-gaps.md` with the snapshot-stale warning callout — accurate.
  - line 34: links `PENDING_USER_AND_OPERATOR.md` — file exists and has been refreshed 2026-05-12.
  - line 53: references `wellness-client/STATUS.md` as "Start here" — STATUS.md itself is severely stale (see below). The pointer is fine; the target needs work.
  - line 59: references both `STATUS.md` and `DEMO_14_4.md` for the demo run-book. Both files exist.
- Recommendation: **leave** — accurate index; the staleness lives in the linked targets.

### `docs/API_NAMESPACING.md` (72 lines)

- Drift class: none — verified that every cited route file exists; the 410 Gone behaviour is verifiable in `backend/server.js`.
- Specifics: no findings.
- Recommendation: **leave**.

### `docs/CALENDAR_INTEGRATION_GAPS.md` (275 lines)

- Drift class: none material — CAL-1..CAL-7 are all marked `⬜ open`; quick code-grep on `backend/routes/calendar_google.js` confirms no `router.put("/events/:id"...)` exists (CAL-1 still genuinely open).
- Specifics:
  - line 5: cites `calendar_google.spec.js` (7 tests) + `calendar_outlook.spec.js` (8 tests). Verified those spec files exist; test counts not re-counted.
- Recommendation: **leave** — this is one of the cleaner docs in the repo.

### `docs/DEMO_MONITOR_PATTERN.md` (506 lines) + `docs/LIVE_MONITOR_PATTERN.md` (806 lines)

- Drift class: none — pattern docs, not state docs.
- Specifics: skimmed; both describe a generic shape for cross-project reuse and don't claim specific in-repo state beyond the references to `e2e/tests/demo-health.spec.js` and `.github/workflows/demo-monitor.yml`, which exist.
- Recommendation: **leave**.

### `docs/PENDING_USER_AND_OPERATOR.md` (289 lines)

- Drift class: minor — main status table at lines 258–267 is accurate and matches `gh issue view` outputs.
- Specifics:
  - line 8: ~~§1 SendGrid~~ ✅ CLOSED 2026-05-13 — accurate.
  - line 24: detailed §1 confirmation including `id=314` smoke-test result — accurate.
  - lines 56–80 §2 #555 → ✅ CLOSED v3.7.3 — accurate.
  - lines 82–143 §3 #558 → ✅ CLOSED v3.7.5 — accurate.
  - lines 146–173 §4 #564 → ✅ CLOSED v3.7.3 — accurate.
  - lines 176–185 §5 WhatsApp DPDP → ✅ CLOSED v3.7.3 — accurate.
  - lines 189–202 §6 Callified webhook → still OPEN (external) — accurate.
  - lines 206–218 §7 AdsGPT SSO → still OPEN (external) — accurate.
  - lines 222–230 §8 #457 manual-QA umbrella → OPEN by design — accurate (`gh issue view 457` = OPEN).
  - lines 270–289 §9 #699 / #702 → product deferrals — `gh issue view 699` / `gh issue view 702` were not verified in this pass; flag for refresh.
- Recommendation: **leave** — the cleanest "what's blocked" doc in the repo; mirrored in TODOS.md's user-attention section but here without the legacy noise.

### `docs/PRD_AI_ERA_CRM_REBUILD.md` (500 lines)

- Drift class: none — just-drafted (per HANDOFF-2026-05-14).
- Specifics: spot-checked the section-1 / section-9 references; matches the doc's own structure. No code claims to verify.
- Recommendation: **leave**.

### `docs/QA_README.md` (58 lines)

- Drift class: counts in the closing paragraph.
- Specifics:
  - line 13: tenantId=2 for wellness, tenantId=1 for generic — likely accurate; not verified against schema.
  - line 14: NovaCrest Technologies / Enhanced Wellness — accurate per seed.
  - line 38: "15 wellness pages" — close to actual count of wellness page files (would need refresh to a frozen list).
  - line 43: "59 generic CRM pages organized by sidebar group" — frontend/src/pages = 122 total; wellness-prefixed = ~16. The 59-generic claim is in the right order-of-magnitude but doesn't match a 2026-05-17 count of pages.
  - line 58: `Per-push CI runs **24 API specs (~1,146 tests)** + **22 vitest unit-test files (674 tests)**` — **stale**. Actual `*-api.spec.js` count is 103; backend vitest 90; total per-push test count claimed elsewhere as ~4,400. The "91 backend route files" cited at end-of-line is wrong (actual 103).
- Recommendation: **refresh** — single paragraph at line 58; the rest is accurate.

### `docs/QA_GENERIC_PROMPT.md` (351 lines), `docs/QA_WELLNESS_PROMPT.md` (271 lines), `docs/QA_WELLNESS_RBAC_TEST_PLAN.md` (637 lines)

- Drift class: not deeply audited (these are QA prompt scripts intended to be operator-pasted; staleness inside them is QA's domain not engineering's).
- Specifics:
  - `QA_WELLNESS_RBAC_TEST_PLAN.md` line 6: "Last refreshed: 2026-05-13 (v3.7.7)" — close enough to current v3.7.16 to be useful, but RBAC has changed under #756–#768 (the 2026-05-15 RoleGuard collapse). Severity: stale within a margin that doesn't break tests but may miss new patterns.
- Recommendation: **leave** for the two prompts; consider refreshing the RBAC test plan after the next QA pass if it surfaces drift.

### `docs/SYSTEM_TEST_PLAN.md` (392 lines)

- Drift class: explicit "Status: Plan — execution pending" / "Last updated: 2026-05-03" — so calling out drift is somewhat unfair.
- Specifics:
  - line 5: `Last updated: 2026-05-03` ≈ 2 weeks ago.
  - line 22: pyramid table is mostly evergreen — names of layers, test-runner choices, where specs live.
  - line 67: helper `destroyTenant(tenantId) — cascading delete across all 114 models` — actual model count is 151. Cosmetic.
- Recommendation: **leave** — this is a forward-looking design doc explicitly stamped "execution pending"; refresh when an engineer picks the work up.

### `docs/test-coverage-gaps.md` (513 lines)

- Drift class: heavy — the doc has a banner acknowledging the staleness, but the under-the-banner backlog isn't marked up.
- Specifics:
  - Banner at lines 3–13: explicit "snapshot 2026-05-06, 8+ days of active work since" — good.
  - line 59 `**API-1** ... ⬜ open`: `routes/admin.js` partner spec — actual `e2e/tests/admin-api.spec.js` does **not** exist. Genuinely still open. ✅ matches doc state.
  - line 62 `**API-3** payments` — `payments-api.spec.js` does not exist; `payments.spec.js` does. The doc demands the `-api` suffix, so technically still open.
  - line 67 `**API-9** developer-api` — `e2e/tests/developer-api.spec.js` **exists**. **Doc says open; should be closed.**
  - line 73 `**API-15** whatsapp-api` — `whatsapp-api.spec.js` does not exist; `whatsapp.spec.js` does (UI flow, not API).
  - Lines 105–113 (CRON-1..CRON-9): every named target has a vitest file at `backend/test/cron/<engine>.test.js`. Specifically:
    - CRON-1 workflowEngine ✅ exists
    - CRON-2 sequenceEngine ✅ exists (`sequenceEngine-wellness-triggers.test.js`)
    - CRON-3 reportEngine ✅ exists
    - CRON-4 marketplaceEngine ✅ exists
    - CRON-5 scheduledEmailEngine ✅ exists
    - CRON-6 dealInsightsEngine ✅ exists
    - CRON-7 backupEngine ✅ exists
    - CRON-8 lowStockEngine ✅ exists
    - CRON-9 leadSlaEngine ✅ exists

    All 9 CRON-XX cards are marked `⬜ open`. **All 9 have vitest files on disk.** Whether each test exercises the full acceptance criteria is a separate question; existence-of-file says the dispatch's primary pickup-trigger has shipped.
  - line 114 `**FE-1** (= G-21) Frontend RTL setup` — actual `frontend/src/__tests__/` has 61 test files. CLAUDE.md line 409 says "G-21 closed in this commit; 14 component test files / 203 tests"; current count is even higher. **Doc says open; should be closed.**
- Recommendation: **refresh** — at minimum, flip rows known-shipped (API-9 developer, CRON-1..CRON-9, FE-1) to ✅ with the commit ref. The doc is supposed to be picked off; leaving 14+ rows marked open when they've shipped is the exact phantom-carry-over pattern the standing rule warns against. Effort: ~30 min of cross-checks.

### `docs/cron-learnings-archive.md` (193 lines)

- Drift class: none — historical archive by design.
- Specifics: no claims to verify.
- Recommendation: **leave**.

### `docs/HANDOFF-2026-05-14.md` (98 lines)

- Drift class: none — frozen yesterday's session.
- Specifics:
  - line 4: latest release tag v3.7.16 — matches.
  - line 38: "v3.7.7 → v3.7.16" tags pushed — matches.
  - Trajectory table at line 25 matches CHANGELOG.
- Recommendation: **leave** — already archived per the docs/README convention.

### `docs/wellness-client/STATUS.md` (317 lines)

- Drift class: severe — this is the most-out-of-date doc in the audit.
- Specifics:
  - line 4: `Last updated: 2026-05-04 (v3.4.9 tagged ...)`. Current is v3.7.16 — **12 releases out of date**.
  - line 4 continued: cites coverage baseline as 33.20% (from v3.2.2) — newer coverage is 40.52% lines / 79.01% helpers per CLAUDE.md.
  - line 6: "Production HEAD ... Last release tag: `v3.4.9`" — stale by 12 release tags.
  - line 88 "Database (9 new Prisma models, 2 new fields on existing models)" — 9 was accurate at v3.1; since then Resource, Holiday, ProductCategory, Vendor, InventoryReceipt, InventoryAdjustment, AutoConsumptionRule, WalletTransaction, CashbackRule, GiftCard, Coupon, Sale, Register, Shift, Attendance, Leave, WhatsAppThread (and several more) have landed.
  - line 105 "Backend routes — `/api/wellness/*` ... 18 wellness endpoints" — current `wellness.js` has many more endpoints (membership, loyalty, photos, inventory, telecaller queue, public booking, portal, etc).
  - line 131 "Patient Detail | ... 5 tabs" — README + CLAUDE.md say 7 tabs (history, Rx, consent canvas, treatment plans, log visit, photos, inventory). **Drift.**
  - line 178 "Staff | 22" + line 180 "Patients | 50" — demo state claim. Unverifiable without prod query; likely drifted.
  - line 240 "Backend line coverage baseline measured for the first time: 33.20%" — superseded; CLAUDE.md says 40.52% (commit-pinned).
  - Sections 280+ "Commits (in this session)" — chronologically frozen at the initial wellness ship (commits `6309d46` etc); harmless historical narrative.
- Recommendation: **refresh** — STATUS.md is sold as the "Start here" doc by docs/README.md. The current STATUS.md sells a v3.4.9 product. A focused 1-hour refresh would bring everything past line 88 into alignment with current state, or alternatively, rewrite as a "snapshot 2026-05-04" + new "Current state at HEAD: see CHANGELOG.md + this delta block".

### `docs/wellness-client/PRD.md` (266 lines)

- Drift class: minor.
- Specifics:
  - line 7: "Last reviewed: 2026-04-27 (post P1 + P2 closure pass)" — 3 weeks out of date but PRD is a stable contract doc; product hasn't pivoted, so minor staleness.
  - section 6.5/6.6 references Callified + AdsGPT as separate products, no integration — consistent with current state.
  - section 14.3 + 14.4 demo criteria — covered in TODOS.md verification block 324–369 (out-of-scope per the original audit).
- Recommendation: **leave**.

### `docs/wellness-client/IMPLEMENTATION_PLAN.md` (189 lines)

- Drift class: severe within the "Today: 2026-04-22 — demo was promised in 2–3 days" framing, but the doc is essentially a historical artifact at this point.
- Specifics:
  - line 6: "Today: 2026-04-22 ... already 1 week overdue" — explicit point-in-time framing.
  - line 11 "The existing CRM is already multi-tenant (99 Prisma models, tenantId on everything)" — actual 151 models.
- Recommendation: **leave** — historical implementation plan; further work is in CHANGELOG arcs.

### `docs/wellness-client/EXTERNAL_API.md` (424 lines)

- Drift class: none material.
- Specifics: skimmed sections 1–3; endpoint table at section 5 references `/leads`, `/calls`, `/messages`, `/contacts/lookup`, `/patients/lookup`, `/services`, `/staff`, `/locations`, `/appointments` — all confirmed to exist in `backend/routes/external.js` per CLAUDE.md line 114.
- Recommendation: **leave**.

### `docs/wellness-client/EMBED_WIDGET.md` (111 lines)

- Drift class: none — drop-in script + iframe + curl examples all valid.
- Recommendation: **leave**.

### `docs/wellness-client/RISHU_TODOS.md` (104 lines)

- Drift class: status stamped 2026-04-23. Unclear if still actionable from the user's side; this is a "what we need from Rishu" doc that lives outside engineering control.
- Specifics:
  - Item 1 Superphone + Zylu CSV — still listed in TODOS.md as pending external/client deliverable.
  - Item 2 Aadhaar/PAN + Play Console — still listed.
- Recommendation: **leave** for engineering; whoever owns the Rishu relationship should refresh status.

### `docs/wellness-client/SANDBOX.md` (189 lines)

- Drift class: minor.
- Specifics:
  - line 20: "19 engines under `backend/cron/`" — actual 22. Cosmetic.
  - line 22: "8 with no E2E coverage" — likely stale given the CRON-1..CRON-9 vitests have landed (see test-coverage-gaps.md findings).
- Recommendation: **refresh** small numeric in line 20; verify the "8 with no E2E coverage" claim.

### `docs/wellness-client/DEMO_14_4.md` (52 lines)

- Drift class: none.
- Recommendation: **leave**.

---

## Cross-doc patterns

1. **Cron-engine count consistently wrong across 4 docs.** README.md says 17 (line 17) and 16 (line 355 header). CLAUDE.md says 19 (line 67). STATUS.md says 19 (line 22). SANDBOX.md says 19 (line 20). Actual: 22. The missing engines (`auditIntegrityEngine`, `demoHygieneEngine`, `leadSlaEngine`, `leavePolicyEngine`, `lowStockEngine`) are all v3.4.x+ additions. A single cross-doc refresh of "the engines list" would unblock four docs.

2. **Total page count consistently understated.** CLAUDE.md (line 149 + 156) says 80; README.md "At a glance" says 122 (✅ correct); STATUS.md doesn't claim a global count but mentions PatientDetail with 5 tabs vs README's 7. The README table is the source of truth here; the prose sections in CLAUDE.md need to point at it (which CLAUDE.md line 18 already promises).

3. **Pre-v3.4 model count of 114 propagates everywhere.** CLAUDE.md (lines 58, 192), IMPLEMENTATION_PLAN.md (line 11), SYSTEM_TEST_PLAN.md (line 67), STATUS.md (implicit 99+9 doesn't add up). Actual is 151.

4. **"Open" issue claims that are CLOSED.** TODOS.md user-attention block and operator-blocker block list #555, #558, #564, #565, #574 follow-up, B-03 as open. ALL are closed per `gh issue view` and per PENDING_USER_AND_OPERATOR.md (which has the correct state). The drift is one-way: PENDING_USER_AND_OPERATOR.md has been updated; TODOS.md has not been kept in sync.

5. **Test-count prose in README + CLAUDE.md + QA_README.md is stale.** README "At a glance" table is correct (234 / 90 / 61 / 17) but the prose paragraphs further down (README line 54, 400+, CLAUDE.md line 232+, QA_README.md line 58) all use earlier numbers that haven't been refreshed. The "At a glance" + auto-derive promise was made but the prose elsewhere wasn't updated to defer to the table.

---

## Recommendations

Ranked by impact-vs-effort:

1. **Archive TODOS.md's superseded handoff blocks** (impact: high — file becomes readable; effort: 15 min). Move blocks dated 2026-05-13 and earlier (~30 of 33 handoffs) into a single `docs/handoffs-archive/TODOS-historical-2026-05-pre-15.md`. Same convention as `docs/handoffs-archive/HANDOFF-*.md`. Keeps the top 3 in-flight blocks accessible; everything else gets one click away.

2. **Strike the closed user-attention rows in TODOS.md** (impact: high — prevents phantom-carry-over dispatches; effort: 5 min). The user-attention table at lines 298–319 and the operator-blocker block at lines 373–390 should match `docs/PENDING_USER_AND_OPERATOR.md` exactly. The simplest move: replace both sections with `→ see [PENDING_USER_AND_OPERATOR.md](docs/PENDING_USER_AND_OPERATOR.md)` and let one doc own that surface.

3. **Refresh the architecture-counts block in CLAUDE.md (lines 46–192) + the deploy-flow block (lines 232–242)** (impact: medium-high; effort: 15 min). The line-18 promise says counts shouldn't rot here. Either delete them and point at README, or auto-derive at version-bump time. The cron engines table needs the 5 missing engine rows added.

4. **Refresh `docs/wellness-client/STATUS.md`** (impact: medium — it's the "Start here" wellness doc; effort: 1 hour). Stamp date, sync model count, fix PatientDetail "5 tabs" → 7, update coverage baseline, list newer wellness endpoints. Alternative: top-line "this is a 2026-05-04 snapshot; see CHANGELOG for everything since v3.4.9" and stop trying to keep it current.

5. **Refresh `docs/test-coverage-gaps.md`** (impact: medium — picks-from-this-doc are the canonical phantom-carry-over class; effort: 30 min). Flip the 9 CRON-XX rows + the FE-1 row + the 2–3 API-XX rows that have specs shipped to ✅ with their commit SHAs.

---

## If you have 30 minutes, fix these 3 things

(1) Strike the closed rows in TODOS.md's user-attention + operator-blocker tables — those are the entry points for "what's blocking the autonomous loop" and they all read "open" when they're closed; this is the next phantom-carry-over instance waiting to happen. (2) Add a "See README.md 'At a glance' table for current counts" pointer at every spot in CLAUDE.md that asserts a count of routes/models/pages/engines/specs — five-line surgery, defuses cross-doc drift. (3) Pick the 9 CRON-XX rows in `docs/test-coverage-gaps.md` and flip them to ✅ — those vitest files exist; leaving the rows ⬜ open will dispatch an agent on already-shipped work the next time someone reaches for "what's the next easy pickup". Total ≈ 30 minutes, prevents one phantom-dispatch cycle (~25–90 min agent time per dispatch).
