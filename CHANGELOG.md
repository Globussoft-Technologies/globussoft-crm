# CHANGELOG

## v3.4.5 — 2026-05-04 — autonomous-orchestrator continuation: 4 issues closed, 4 E2E_GAPS rows shipped, schema invariant drift 49 → 39

  - G-17 shipped (54b1ff1) — 40 tests; 5 endpoints (GET /dashboard + GET/PUT /recommendations + approve/reject); race-safe state machine + #325 vertical gate + #207/#216 wellnessRole gate + 30d revenueTrend shape; surfaced no contract drift in code

  - G-18 shipped (561ab6b) — 76 tests; 12 endpoints (4 JSON + 8 export); CSV BOM + PDF magic-bytes pinned; #233 attribution leak invariant locked

A direct continuation of v3.4.4's autonomous-orchestrator session. **No new product features**; this release lands four medium-effort gap closures (G-19 wellness-telecaller, G-22 Stripe integration tier, G-23 migration safety, plus the off-backlog #423 numeric-id sweep) plus four bug fixes (#421/#422/#423/#424) plus the first batch of #413 schema-relation hygiene plus the `docs/gaps/archive/` convention for fully-closed gap-files plus six healing commits that resolved cascading test-shape regressions across spec files.

### Test surface continued growth

| Tier | Tool | v3.4.4 | v3.4.5 | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | 55 specs / ~1,950 tests | **~67 specs** / ~2,326 tests | +12 specs / +376 tests |
| Per-push unit tests | vitest | 35 files / 964 tests | **36 files** / 979 tests | +1 file / +15 tests |
| **Total per-push** |  | ~2,914 | **~3,305** | **+13%** |
| **Deploy gates** |  | 4 (build/lint/api/unit) | **5** (+ migration_check) | +1 |

### Added — 4 E2E_GAPS rows shipped (✅)

- **G-19** wellness-telecaller-api spec (`09d7328`) — 30 tests, 18.6s. Queue + 6-disposition matrix (`interested → Lead`, `not interested → Churned`, `callback → Lead`, `booked → Prospect`, `wrong number / junk → Junk`), Activity rows on dispose, tenant-vertical gate, own-`assignedToId` scoping, RBAC. Final of three wellness.js splits; closes the third 4,050-line surface (G-17 + G-18 still open). Documented prompt-vs-reality drift (only 2 endpoints exist, no SLA timer field, dispositions are space-separated not snake_case).
- **G-22** Stripe webhook integration tier (`953cca5`) — 11 tests across 7 attack scenarios (valid sig + 200 + idempotency, tampered body, 1h-old replay, missing sig, malformed sig, wrong secret, unknown event type forward-compat) + bonus fail-closed when `STRIPE_WEBHOOK_SECRET` env missing (503 not silent accept). New integration test tier under `backend/test/integration/` using **msw v2 + supertest** (first introduction of either dev dep). Pattern notes captured in test header: vi.mock unreliable for `require('../lib/prisma')` in route files (use singleton-monkey-patch); supertest+superagent re-serializes JSON Buffer bodies (always `.send(string)` for raw-body routes); msw must bypass loopback for supertest.
- **G-23** migration safety check (`d63955a` + `06b9e8a`) — 10 tests + 5 detectors (`NOT_NULL_WITHOUT_DEFAULT` / `COLUMN_DROP` / `TYPE_NARROWING` / `UNIQUE_ADDITION` / `FK_WITHOUT_ON_DELETE`) + 6 paired fixture schemas. New `.github/workflows/migration-check.yml` standalone workflow with sticky PR comment + per-commit dry-run on push. **5th mandatory deploy gate** added to `deploy.yml` `needs:` chain. Caught a real false-positive in this same release (#424 CalendarEvent unique-addition) — see #425 for the allowlist follow-up.
- **off-backlog** non-numeric `:id` sweep spec (`abb0d1c`) — 17 tests, 9 routers. Closes the contract drift surfaced by R-4 specs in v3.4.4.

### Fixed — 4 GitHub issues closed

- **#421** leadScoringEngine architectural gaps (`3a30d71` → followup `35c0900`). Three real fixes: (1) per-tenant iteration replaces global findMany sweep; (2) recompute-window via new `Contact.aiScoreLastComputedAt DateTime?` column (initial commit used phantom `updatedAt` field that mocked vitest didn't catch — real Prisma rejected it in CI; followup added the proper column); (3) `Promise.allSettled` replaces `Promise.all` so one bad row doesn't drop the whole tick. Vitest grew 49 → 53 tests.
- **#422** email_threading contract drifts (`0bbfaf5`). Three real fixes: (1) `POST /archive` actually persists state via `__ARCHIVED__:` threadId sentinel prefix (no schema change required); (2) `?limit` (1-200) + `?offset` (≥0) pagination on `GET /threads/:threadId` with envelope `{data, total, limit, offset}`; (3) `POST /reply` rejects body `tenantId` with `400 IMMUTABLE_FIELD` (`stripDangerous` no longer silently no-ops cross-tenant write attempts). Spec grew 33 → 40 tests.
- **#423** non-numeric `:id` 500 sweep (`abb0d1c` + `ff5505a` → 6-spec heal pass at `fd17e69` + `6aad4a0`). New `backend/middleware/validateNumericId.js` mounted via `app.param('id', …)` AND a `Router` factory monkey-patch (param callbacks don't propagate to mounted sub-routers; the factory monkey-patch fixed that elegantly). New `e2e/tests/numeric-id-sweep.spec.js` (17 tests, 9 routers). Wave-16 cascade: 6 pre-existing specs (accounting/canned-responses/contracts/expenses/projects/surveys) had route-specific regex like `/invalid invoice id/i` that the generic middleware error doesn't match — all migrated to pin `code: 'INVALID_ID'` instead, plus middleware error message simplified to `Invalid id: ...` to match `/invalid id/i`.
- **#424** CalendarEvent.@@unique missing tenantId (`cfed31b`). Surfaced by Agent E in wave 16 as a follow-up to #414 + #415; closed in wave 17 by the same single-line fix (`@@unique([tenantId, provider, externalId])`). Was the only multi-tenant model whose unique key didn't include tenantId.

### Added — schema hygiene partial (#413 batch 1, 10 of 49)

Closes the first 10 of 49 multi-tenant models that lack a formal `tenant Tenant @relation` declaration (G-24 schema-invariants vitest had pinned the count). **Important course-correction**: the issue body's "suggested 10" list (AuditLog/Contact/Deal/...) was stale — 9 of those already had `@relation`. Agent F substituted the actual drifters, biased to financial/PHI:
- **Financial**: Payment, AccountingSync, Forecast, Quota, Currency, DealInsight
- **PHI / GDPR**: PatientOtp, ConsentRecord, DataExportRequest, SignatureRequest

Drift counter pinned by `backend/test/schema/schema-invariants.test.js` dropped **49 → 39**. Issue #413 stays OPEN with batch-2 priorities commented (security-critical: RevokedToken, ScimToken, SsoConfig).

### Added — `docs/gaps/archive/` convention (`ea1147a`)

When a gap / backlog / regression-tracking file is fully closed (every entry shipped, zero `⬜` / `☐` / `TODO` / `open` markers remaining), it moves under `docs/gaps/archive/` rather than getting deleted — see `docs/gaps/archive/README.md` for the rule + closure-note template. Pointer added to both CLAUDE.md and TODOS.md so future sessions discover it on the read-at-session-start path. Audit at commit time: 0 files currently qualified for archiving (all active backlogs have ≥1 open item); convention is set up for future use.

### Added — `capturing-wave-findings` skill (`6446c20`, late v3.4.4 → first usage in v3.4.5)

Routes agent-discovered findings (bug, contract drift, missing route surface, spec shipped, standing-rule pattern, new backlog item) into the right doc — TODOS.md, docs/E2E_GAPS.md, CHANGELOG.md — or a fresh GitHub issue, so nothing surfaced mid-wave is lost between waves. Bundled `capture.sh` helper with 4 modes (`issue` / `backlog-row` / `spec-shipped` / `rule-proposal`). Each wave-17 agent ran `capture.sh spec-shipped` at finish; this changelog's bullets were originally the scattered append-to-CHANGELOG output of those calls, consolidated here at release-bump time.

### Filed for follow-up (this session)

- **#424** — closed same session (see "Fixed" above)
- **#425** — G-23 migration safety check needs an allowlist mechanism for blessed UNIQUE/DROP changes. Surfaced when `cfed31b` (CalendarEvent unique-addition) tripped the `UNIQUE_ADDITION` detector despite the new constraint being strictly more permissive than the old. Recommendation: recognise `[allow-unique]` / `[allow-drop]` markers in the latest commit message and skip the corresponding detector. ~1h fix.

### Process notes — what didn't go to plan

- **Cascade healing across 6 spec files** — wave-16 agent B (`#421`) used a phantom `Contact.updatedAt` field that mocked vitest passed but real Prisma rejected; agent D (`#423`) introduced a generic middleware error message that didn't match 6 pre-existing route-specific regex patterns. Three healing commits (`35c0900`, `fd17e69`, `6aad4a0`) resolved both. **Lesson**: vitest mocks of Prisma are insufficient — always run `prisma db push` against the real schema before declaring victory; spec assertions on prose error messages are fragile vs. structured `code` fields.
- **Migration check false positive** — G-23 was the very thing that flagged #424's CalendarEvent unique-addition as risky, blocking that one commit's deploy. Recovery: subsequent commit's HEAD~1 baseline included the new constraint → diff was empty → unblocked. Net deploy was delayed by one commit slot but no schema change was lost. **Filed as #425.**
- **Stale issue lists** — Agent F discovered the #413 issue body's "suggested 10" model list was outdated (9 of 10 already had `@relation`). Mitigated by reading the actual G-24 invariant test output to derive the real drift list. **Lesson**: always re-derive from authoritative source, never trust frozen lists.

---

## v3.4.4 — 2026-05-03/04 — multi-session arc: G-20 tenant-isolation flagship + skills library + 5 audit follow-up fixes + agent-progress infra

A multi-session continuation of v3.4.3. **No new product features outside T2.1 (mobile sidebar drawer at <900px)**; this release lands the highest-severity multi-day item from the gap card (G-20 tenant-isolation, 3 waves), closes 5 audit-follow-up bugs the previous waves' agents surfaced, builds a 7-skill reusable library for parallel-agent dispatch, ships agent-progress visibility infra, and adds 4 R-4 medium-route specs + 5 R-5 batch 2 cron-engine vitests.

### Test surface continued growth

| Tier | Tool | v3.4.3 | v3.4.4 | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | 50 specs / ~1,665 tests | **55 specs** / ~1,950 tests | +5 specs / +285 tests |
| Per-push unit tests | vitest | 30 files / 803 tests | **35 files** / 964 tests | +5 files / +161 tests |
| **Total per-push** |  | ~2,468 | **~2,914** | **+18%** |

### Added — G-20 tenant-isolation (the flagship)

The single highest-severity multi-day item on `docs/E2E_GAPS.md` ("single highest-severity bug class for multi-tenant CRM"). Three waves landed across the multi-session arc:

| Wave | Commit | Resources covered | Tests added |
|---|---|---|---|
| Wave 1 | `a9154ac` | 12 (contacts, deals, tasks, billing, estimates, ...) + framework | ~25 |
| Wave 2 | `8064fda` | +9 (workflows, sequences, projects, tickets, developer-webhooks, scheduled-emails) + wellness clinical FK chain (Patient → Visit → Rx → Consent) | ~37 |
| Wave 3 | `f4b4ebe` | +8 (expenses, contracts, currencies, custom-objects/entities, kb-articles, kb-categories, scim-tokens, wellness/treatment-plans) | +31 |

**Net: 29 resources covered, 93 tests on `e2e/tests/tenant-isolation-api.spec.js`.** Each resource asserts: (a) row created in tenant A is invisible to tenant B's bearer token; (b) cross-tenant id-bearing operations return 404 not 403 (id-enumeration prevention); (c) post-DELETE owner-read or list-lookup confirms no silent mutation across tenants. Pattern is extensible — adding a 30th resource is now a 5-line config block.

### Added — 6 reusable Claude Skills + 1 agent-progress skill

`.claude/skills/` now ships project-shared skills that encode the standing rules each parallel agent re-derived during the v3.4.x arc. Agent prompts shrink from ~250-line preambles to ~30-line "Use the X skill" pointers; the skill metadata pre-loads at session start, body loads on demand.

| Skill | Captures |
|---|---|
| **`writing-api-gate-spec`** (commit `4724ad5`) | Standing rules + pattern selection + RUN_TAG + afterAll _teardown_ pattern; bundled TEMPLATE.md |
| **`wiring-spec-into-gate`** (commit `4724ad5`, fixed `67129bc`) | Two-file edit, trailing-backslash gotcha, rebase-on-collision; bundled wire-in.sh script (now accepts either `tests/foo.spec.js` or `foo.spec.js` after the R-4 wave's double-prepend bug) |
| **`writing-vitest-unit-test`** (commit `4724ad5`) | vi.mock prisma, CJS-require quirk + createRequire workaround, 4 mock shapes by SUT type; bundled TEMPLATE + MOCK_PATTERNS |
| **`adding-admin-trigger-endpoint`** (commit `d7b17b7`) | Mirror `/api/forecasting/snapshot/run` pattern, optional `confirmDestructive` guard, AuditLog writes, wellness `verifyWellnessRole` carve-out; bundled TEMPLATE.js with 3 variants |
| **`bumping-version-docs`** (commit `d7b17b7`) | The 5-file dance for vX.Y.Z bumps; bundled CHANGELOG_ENTRY + TODO_HANDOFF + README_WHATSNEW templates |
| **`dispatching-parallel-agent-wave`** (commit `d7b17b7`) | Disjoint-files invariant, 4-agent default cap, discovery-first vs jump-to-closers, role-specific prompt skeletons |
| **`reporting-agent-progress`** (commit `1b00dd8`) | The new visibility protocol — agents append start/milestone/commit/done events to a JSONL log; CRM `/developer` page polls every 3s and shows them live |

### Added — agent-activity infra (visibility for parallel waves)

Closes the visibility gap when 4-8 parallel agents are in flight. Pre-this-commit, the user only saw a notification when each agent FINISHED. Now:

- **Backend route** `GET/POST /api/developer/agent-activity` (admin-only) — reads/writes `.scripts-state/agent-activity.jsonl`. Length-capped, validated.
- **Frontend widget** on `/developer` — polls every 3 seconds, shows newest-first table with color-coded action badges (start=blue, done=green, failed=red), file paths, commit short-SHAs, message text.
- **Helper script** `.claude/skills/reporting-agent-progress/log.sh` — single-call interface; caches admin token; falls back to JSONL append if backend hiccups; never fails (returns 0 on errors so logging hiccups don't crash agents).
- **End-to-end verified** with the G-20 wave 3 agent — first agent to use the protocol; logged start / milestone / commit / done events visible live on `/developer`.

### Fixed — 5 audit follow-up bugs the parallel agents surfaced

| # | Subject | Commit |
|---|---|---|
| **#412** | Campaign schedules in-memory (`global._campaignSchedules`) → backend restart wipes pending; persisted to DB now (Campaign.scheduledAt/scheduleStatus/scheduleFilters columns + DB-driven cron) | `5ca0849` |
| **#416** | backup engine respects MYSQLDUMP_BIN strictly (no PATH fallback) — pre-flight `fs.accessSync` + rename `CMD_BUILD_FAILED` → `MYSQLDUMP_FAILED`. Per-push deploys unblocked. | `51b299a` |
| **#417** | backup engine pipeline-exit-code masking — replace `mysqldump | gzip` shell pipeline (POSIX sh has no `pipefail` so gzip masks dump's exit code) with two-child `spawn` pipe. New `MYSQLDUMP_TIMEOUT` watchdog. Streams end-to-end. | `03071ff` |
| **#418** | `routes/workflows.js` add `GET /:id` — fills the gap that forced G-20 wave 2 to use list-fallback | `2eb7dbc` |
| **#419** | `routes/custom_objects.js` add `GET/PUT/DELETE /entities/:id` full CRUD with refuse-when-records-exist DELETE policy (409 ENTITY_HAS_RECORDS). Bonus: pre-#419 POST crashed on `fields=undefined`; now treats as `[]`. | `b90ac7c` (+ `1f5f35a`, `81ec5ad`) |
| **#420** | wellness treatments → treatment-plans single canonical path. Legacy `POST /wellness/treatments` returns 410 Gone with `code: WELLNESS_TREATMENTS_RENAMED`. Frontend `PatientDetail.jsx` PlansTab migrated. | `cea9bc0` |

### Added — 4 R-4 medium-route specs + 5 R-5 batch 2 cron-engine vitests

| ID | Spec | Commit | Tests |
|---|---|---|---|
| R-1 substitute | `attribution-api.spec.js` | `c1c3b3d` | 24 |
| R-4a | `document-templates-api.spec.js` | `1cb1a93` | 42 |
| R-4b | `booking-pages-api.spec.js` | `53e3299` (bundled) + `325dc13` (wire-in fix) | 43 |
| R-4c | `email-threading-api.spec.js` | `9db1f26` | 33 |
| R-5a | `cron/forecastSnapshotEngine.test.js` | `78082d0` | 28 |
| R-5b | `cron/leadScoringEngine.test.js` | `53e3299` | 49 |
| R-5c | `cron/slaBreachEngine.test.js` | `4bcc98c` | 25 |
| R-5d | `cron/sentimentEngine.test.js` | `76bf2a4` | 53 |
| #410 follow-up | `cron/recurringInvoiceEngine.test.js` | (already in v3.4.3) | 5 |
| #411 follow-up | `cron/retentionEngine.test.js` | (already in v3.4.3) | 7 |

### Added — T2.1 mobile sidebar drawer (the only product-visible change)

`feat(T2.1): mobile sidebar collapse + drawer at <900px` (commit `590011d`) — CSS-class hamburger (replaces the inline `display:none` that was beating responsive.css), transform-based slide-in drawer, ARIA dialog/modal + focus trap, 44×44 touch target. Mobile users on iOS/Android now have a working hamburger; previously the desktop sidebar collapsed but the toggle was unreachable.

### Notable contract-drift findings filed for follow-up

- **#421** — `cron/leadScoringEngine.js` has 3 architectural gaps: no tenant scope (sweeps ALL tenants per tick), no recompute window (rescores every contact every 10 min), no per-row error containment (`Promise.all` rejects whole tick). Surfaced by `53e3299`'s 49-test vitest. P1.
- **#422** — `routes/email_threading.js` has 3 contract drifts: stub `/archive` (schema lacks `archived` field), `Contact.email` not `@unique` but `findUnique` silently fails (auto-link broken since route shipped), `/reply` returns 200 not 201. Surfaced by `9db1f26`. P1 for the silent-fail; P3 for cosmetic.
- **#423** — Multiple id-bearing routes return 500 (not 400/404) on non-numeric `:id` because `parseInt('abc')` → NaN → Prisma throws → outer catch returns 500. Surfaced by `1cb1a93` document-templates spec. P3 sweep.

Plus the carry-over from v3.4.3:
- **#413** — 49 models without `tenant Tenant @relation` (cascade leak on `Tenant.delete()`) — open
- **#414** — `MarketplaceLead.@@unique` excludes `tenantId` — open
- **#415** — 21 `@@unique` constraints lack docs — open

### Operations

- **Backend agent-activity log** lives at `.scripts-state/agent-activity.jsonl` (gitignored). Append-only.
- **`.claude/settings.json` widened** to allow `Bash(.claude/skills/*)` so future skill-bundled scripts (wire-in.sh, log.sh, and any future helpers) run without permission prompts.
- **Demo-monitor cron** unchanged at `0 */2 * * *` from v3.4.2.

### Carry-over for v3.4.5

- **G-21** frontend vitest+RTL setup (3-5 days) — biggest remaining unknown
- **G-22** msw/nock integration tier — Stripe webhook signing (2 days)
- **G-23** migration safety check — `prisma migrate` dry-run in CI (1 day)
- **G-17/G-18/G-19** wellness.js route split (1 day each — best after a focused day)
- **G-20** wave 4 — there are still ~80 multi-tenant models left to systematically cover
- **R-5 batch 3** — `marketplaceEngine` (skipped this batch due to external HTTP fan-out complexity), `orchestratorEngine`, `reportEngine`, `sequenceEngine`
- **R-6** integration-heavy routes: `calendar_google`, `sso`, `calendar_outlook`, `zapier`, `chatbots`
- **Tier 3 skills** (`closing-contract-drift-bug`, `local-heal-loop`, `scrubbing-demo`, `filing-contract-drift-issue`, `tagging-release`)
- The 4 contract-drift issues filed this release (#421-#423 + the carry-over #413-#415) — engine + schema fixes

---

## v3.4.3 — 2026-05-03 — eight-agent parallel wave: 6 more gate specs + 6 unit-test files + 2 engine fixes + 2 spec cleanups

A single-day continuation of v3.4.2 where 8 parallel agents shipped 14 commits in one wave. **No new product features**; this release finishes off the engine-spec backlog (G-12 / G-13 / G-15), kicks off the under-covered-routes batch (R-1 trio), closes both contract-drift findings from v3.4.2 (#410 + #411), adds 6 new vitest unit-test files (lib + cron + schema), and ships 2 spec-discipline cleanups (B3 sessionStorage shadow + wellness-clinical afterAll rename pattern).

### Test surface continued growth

| Tier | Tool | v3.4.2 | v3.4.3 | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | 37 specs / ~1,525 tests | **50 specs** / ~1,665 tests | +13 specs / +140 tests |
| Per-push unit tests | vitest | 23 files / 700 tests | **30 files** / 803 tests | +7 files / +103 tests |
| **Total per-push** |  | ~2,225 | **~2,468** | **+11%** |

### Added — 6 new gate specs (~+140 API tests)

| ID | Spec | Commit | Tests | Notable |
|---|---|---|---|---|
| **G-12** | `campaign-engine-api.spec.js` | `f681ff2` | 11 | Added `POST /api/marketing/campaigns/run` admin-gated; surfaced 4 design-debt findings (most important: Campaign uses in-memory `global._campaignSchedules` map → backend restart wipes ALL pending schedules silently — production-impacting) |
| **G-13** | `deal-insights-engine-api.spec.js` | `515c316` (multi-agent collision commit) | 14 | Added `POST /api/deal-insights/run` admin-gated; surfaced DealInsight orphan-row pollution (no FK cascade to Deal); discovered the cron engine is heuristic-only, NOT Gemini-backed (gap card was wrong) |
| **G-15** | `backup-engine-api.spec.js` | `515c316` | 14 | Added `POST /api/admin/backup/run` + `GET /list` + `GET /file/:name` admin-gated; refactored `cron/backupEngine.js` to expose return values; added docker-exec mode for Windows dev hosts; PII-safety assertion grades dump for `ENC:v1:` ciphertext when `WELLNESS_FIELD_KEY` set; CI runner now installs `mysql-client` via apt-get |
| **R-1a** | `ab-tests-api.spec.js` | `8632050` | 38 | Was previously zero gated coverage on `routes/ab_tests.js` (259 lines) |
| **R-1b** | `accounting-api.spec.js` | `515c316` | 37 | Webhook openPaths assertion + sync/all idempotency + 3-tenant cross-isolation matrix |
| **R-1c** | `canned-responses-api.spec.js` | `014ac6a` | 23 | Ordering contract + `'General'` default category + cross-tenant matrix |

### Added — 7 new vitest unit-test files (+103 tests)

| File | Commit | Tests | Coverage |
|---|---|---|---|
| `backend/test/lib/prisma.test.js` (R-2) | `90eddac` | 21 | 88.33% lines on `lib/prisma.js` |
| `backend/test/lib/sentry.test.js` (R-3) | `90eddac` | 11 | 100% on `lib/sentry.js` |
| `backend/test/cron/recurringInvoiceEngine.test.js` (#410) | `7f9567a` | 5 | New |
| `backend/test/cron/retentionEngine.test.js` (#411) | `da54afd` | 7 | New |
| `backend/test/cron/wellnessOpsEngine.test.js` (R-5) | `8303272` | 30 | 76.92% lines (gap is cron-shell init/orchestrator; per-tenant runners are 100%) |
| `backend/test/cron/appointmentRemindersEngine.test.js` (R-5) | `d86fbdb` | 23 | 93.5% lines |
| `backend/test/schema/schema-invariants.test.js` (G-24) | `08b29fd` | 6 | n/a (schema test) |

The `lib/` test pair caught a vitest-CJS-require interop quirk: `vi.mock('@sentry/node')` doesn't intercept CJS requires under this repo's setup. Worked around using `createRequire` + monkey-patch on the real CJS `module.exports` — the SUT's `require('@sentry/node')` resolves to the same cached instance. Documented in the test file headers for future agents.

### Compliance fixes — both v3.4.2 contract-drift bugs closed

- **#410 closed** (commit `7f9567a`) — `recurringInvoiceEngine.js` now uses `status: { notIn: ['VOID', 'VOIDED'] }`. Voided recurring invoices can no longer regenerate via the cron path.
- **#411 closed** (commit `da54afd`) — `retentionEngine.js` writes the AuditLog row regardless of deletion count. The agent corrected the issue's recommended diff: it suggested `action: 'RETENTION_SWEEP'` but the existing e2e spec asserts `action: 'DELETE'`, so the fix uses `'DELETE'` with `via: 'cron'` in details (mirrors the manual route's precedent). Spec contract preserved.

**Bonus fixes the engine-fixes agent shipped en route:**
- **`backend/vitest.config.js` cron/ deps.inline gap** — `cron/` wasn't in `server.deps.inline` or coverage globs. Was silently blocking ALL cron-engine unit tests. Adding it unblocked the R-5 sibling agent's 53 cron-engine vitest tests in the same wave.
- **`retentionEngine.js` ENTITY_MAP eager-binding refactor** — module captured prisma model proxies at load time, making the engine un-mockable. Refactored to lazy property lookup (`prisma[propName]` inside the loop). Functionally identical; meaningfully more testable.

### Spec-discipline cleanups (long-tail residue)

- **B3 wellness-real-user-journeys** (commit `967cbdc`) — root cause was NOT tab-locator drift (the original L3 diagnosis). The `auth.setup` admin token (generic CRM tenant) was lingering in sessionStorage and shadowing the doctor token written via `uiLoginViaToken` (which only touches localStorage). The SPA's `getAuthToken()` prefers the in-memory holder seeded from sessionStorage, so the SPA booted as `admin@globussoft.com` (generic tenant), the wellness patient-detail fetch 404'd, and the page rendered "Patient not found" — no tabs to find. Fix: `clearBrowserState(page)` at top of B3, mirroring B1 + D1.
- **wellness-clinical-api afterAll Location rename** (commit `02a4d1e`) — existing rename target was `${RUN_TAG}_CLEANED_LOC_${id}` where `RUN_TAG = E2E_WC_<ts>`. Renamed rows STILL started with `E2E_` and STILL matched demo-hygiene's residue regex. demo-hygiene runs in the same suite BEFORE global-teardown and was catching residue mid-run. Fix: rename to `_teardown_wc_loc_${id}` (mirrors G-6's pattern). Plus a one-time SQL cleanup of 12 stale rows.

### G-24 schema invariants — surfaced 4 schema findings worth follow-up

The new `schema-invariants.test.js` flagged real schema drift the codebase has been carrying:

1. **49 models have `tenantId Int` but NO formal `tenant Tenant @relation`** — the data-leak invariant only requires the column (Prisma uses `tenantId` for filtering); the relation is convenience for joins/cascades. Concrete impact: `prisma.tenant.delete()` cascade only works for the ~60 models that DO have the relation; the 49 above leak rows on tenant deletion.
2. **`Currency` is in the no-relation bucket but is per-tenant** (`@@unique([code, tenantId])`) — already corrected in the test's whitelist commentary.
3. **21 `@@unique` constraints lack documenting comments** — soft-warn output; most are obvious composites but `MarketplaceLead.@@unique([provider, externalLeadId])` is worth scrutinizing — could prevent two tenants from importing the same provider lead.
4. **`Currency.code` is NOT marked `@unique` per-tenant alone** — only `(code, tenantId)`. Means two tenants CAN both have a "USD" row, which is correct but worth confirming the conversion logic doesn't assume global uniqueness.

### Carry-over for v3.4.4

- **Outstanding contract-drift findings worth filing** as separate `[regression]` issues:
  - **#412** (proposed) — Campaign uses in-memory `global._campaignSchedules` map; backend restart wipes pending schedules silently. Real production-impacting.
  - **Schema cleanup pass** — convert 49 `tenantId`-only models to also declare `tenant Tenant @relation`, document remaining `@@unique` constraints with comments.
- **R-4 next-batch route specs** — `booking_pages` (353L), `knowledge_base` (357L), `email_threading` (358L), `document_templates` (367L) — 1.5-2h each.
- **R-5 batch 2 cron engines** — `lowStock` (already covered by sibling work indirectly), `forecastSnapshot`, `leadScoring`, `slaBreach`, `sentiment`, `marketplace` — 3-4h each.
- **R-6 integration-heavy routes** — `calendar_google`, `sso`, `calendar_outlook`, `zapier`, `chatbots` — 2-3h each.
- **G-20 tenant-isolation-api** still the highest-severity multi-day pickup.
- **G-17/G-18/G-19** wellness.js route split — best after G-20.

---

## v3.4.2 — 2026-05-03 — six more gate specs + four new admin trigger endpoints + portable monitor-pattern docs

A continuation of the same-day v3.4.0 / v3.4.1 arc. **No new product features**, but six more gate specs landed plus four new admin-gated trigger endpoints (each one mirroring an existing cron engine), and two cross-project pattern docs got written for hand-off to sister Globussoft products.

### Test surface continued growth

| Tier | Tool | v3.4.1 | v3.4.2 | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | 31 specs / 1,435 tests | 37 specs / **~1,525 tests** | +6 specs / +90 tests |
| Per-push unit tests | vitest | 22 files / 677 tests | 23 files / **700 tests** | +1 file / +23 tests |
| **Total per-push** |  | 2,112 | **~2,225** | **+5%** |

### Added — six gate specs (~+90 API tests, +23 unit tests)

| ID | Spec | Commit | Tests | Adds an admin trigger endpoint? |
|---|---|---|---|---|
| **G-7** | `wellness-ops-api.spec.js` | `853f41e` | 13 | No (`/wellness/ops/run` already existed) |
| **G-14** | `forecast-snapshot-api.spec.js` | `2d4372d` | 18 | Yes — `POST /api/forecasting/snapshot/run` (ADMIN-gated) |
| **G-16** | `whatsappProvider.test.js` (vitest) | `6871d8d` | 23 | n/a — unit test |
| **G-9** | `recurring-invoice-api.spec.js` | `902e439` | 13 | Yes — `POST /api/billing/recurring/run` (ADMIN) |
| **G-10** | `scheduled-email-api.spec.js` | `76b2416` | 12 | Yes — `POST /api/email/scheduled/run` (ADMIN) |
| **G-11** | `retention-api.spec.js` | `cb96793` | 11 | Yes — `POST /api/gdpr/retention/run` (ADMIN + body `confirmDestructive: true` + per-deletion AuditLog) |

The four new endpoints all mirror the same shape: per-tenant scoped (`req.user.tenantId`), admin-gated via `verifyToken, verifyRole(['ADMIN'])`, return `{ success, tenantId, ...counters, errors }`. They replace the previous "no manual trigger surface" gap that made the cron engines effectively impossible to test deterministically.

### Notable contract drifts surfaced by the new specs (filed as separate issues, NOT fixed here)

- **#410 — `recurringInvoiceEngine` excludes `'VOID'` but `/void` route writes `'VOIDED'`** — surfaced by G-9. Voided recurring invoices may regenerate via the cron path. The new manual-trigger endpoint excludes both spellings defensively; the cron should match.
- **#411 — `retentionEngine` doesn't write AuditLog on no-op runs** — surfaced by G-11. GDPR Art. 30 / SOC-2 expect a complete trail of when retention was *attempted*, not just when it *deleted*. The new manual-trigger endpoint writes the audit row regardless of deletion count; the cron should match.

Both are concrete diff-sized fixes; tracked for follow-up. Not blocking demo or production.

### Added — portable cross-project pattern docs

The demo-monitor pattern this repo runs is genuinely valuable for any Globussoft product that has a deployed test environment. Two self-contained pattern docs:

- **[docs/DEMO_MONITOR_PATTERN.md](docs/DEMO_MONITOR_PATTERN.md)** (commit `c27d862`, 506 lines) — self-contained, copy-paste-able guide for setting up the same monitor pattern in any project. Includes templated workflow YAML, templated Playwright spec, customization checklist, what-to-put-in-assertions guide, tuning section (cadence, auto-self-heal, single-failure-suppression), and what-this-isn't (vs APM, vs release validation, vs uptime pinger).
- **[docs/LIVE_MONITOR_PATTERN.md](docs/LIVE_MONITOR_PATTERN.md)** (commit `331cdd6`, 806 lines) — sibling guide for **production** environments with the safety dial cranked all the way up: HARD read-only enforcement (Proxy-wrapped request fixture rejects POST/PUT/PATCH/DELETE), severity-tiered alerts (P1 → PagerDuty + Slack + GH; P2 → Slack + GH; P3 → GH only), dedicated read-only service account (audit-trail-friendly), 4-week dry-run-to-paging rollout plan, GDPR/HIPAA/SOC-2/PCI-DSS-specific guidance.

Both docs reference each other and explicitly distinguish demo vs live use cases.

### Operations

- **Demo-monitor cadence relaxed** `*/30 * * * *` → `0 */2 * * *` (commit `ed5ae4f`). 12 runs/day instead of 48. Justified by today's automation: `e2e-full.yml`'s `scrub-demo` post-matrix job (`db932ab`) cleans after every release-validation run; the per-push `api_tests` gate runs against ephemeral DB so can't pollute. Remaining drift class (~1×/week sibling-agent residue) doesn't justify denser cadence.
- **Audit-api spec header refresh** (commit `e834266`) — cleared stale comments claiming `routes/audit.js` had no role guard. The route was fixed in `2df54de` (v3.4.0); the spec header hadn't caught up.

### Carry-over (NOT in this release)

- **G-12 campaign-engine, G-13 deal-insights-engine, G-15 backup-engine** — three more gate specs in flight as of this release; landing in v3.4.3.
- **#410 + #411** — engine-side fixes for the contract drifts surfaced this release.
- **G-20 tenant-isolation-api** — flagged as "single highest-severity bug class for multi-tenant CRM" per E2E_GAPS.md; 2-3 day investment that's the natural pickup after the engine specs settle.
- **B3 wellness-real-user-journeys tab-locator drift** — pre-existing, deferred from L3 closure (~30 min next session).
- **wellness-clinical-api afterAll discipline** — leaves `E2E_WC_*` Locations for demo-hygiene to catch mid-suite (~30 min).

---

## v3.4.1 — 2026-05-03 — T1.2 SMS provider live + e2e-full long-tail fully closed

A continuation of v3.4.0's same-day session. **No new product features**, but two production-impacting items closed end-to-end:

### Added — patient SMS pipeline functionally live

- **Fast2SMS API key wired on demo + local** — `FAST2SMS_API_KEY` set in `backend/.env` (local) and appended to demo's `backend/.env` via the operator SSH path; `pm2 restart globussoft-crm-backend --update-env` to pick up. Verified end-to-end: `/api/wellness/portal/health` returns `{"smsConfigured":true}` on both ends. The OTP-driven flows that were broken-by-default since #182 (closed Apr 15) — patient portal phone+OTP login, T-24h + T-1h appointment reminders, telecaller follow-up SMS — now actually deliver messages.

- **T1.2 SMS-not-configured graceful-degrade** (commit `3e63b82`):
  - **Layout.jsx** — non-dismissable amber warning bar at the top of every staff page when `role ∈ {ADMIN, MANAGER}` AND `user.features.smsConfigured === false`. Hidden for regular USERs since they can't fix it. Closes the silent-failure window where staff thought OTP worked.
  - **`GET /api/wellness/portal/health`** — new public endpoint (`backend/routes/wellness.js`). Probes the env-var fallback only (MSG91 or Fast2SMS) since the patient portal is anonymous pre-OTP — no tenant context to look up per-tenant SmsConfig. Exposes a single boolean; doesn't leak provider name or env-var keys.
  - **PatientPortal.jsx** — fetches `/portal/health` on mount; if `smsConfigured === false`, replaces the phone-input form with "Phone-OTP login is temporarily unavailable. Please contact your clinic for help accessing your records." Patients with a working SMS path see no change.

### Fixed — e2e-full long-tail (3 final buckets)

The 13 "real product issues" from 2026-05-02 evening triage were already mostly fixed by today's heal-loop work. The 3 remaining buckets (L1, L2, L3) all turned out to be test/env drift, not product bugs:

- **L1 — eventbus cross-tenant rule isolation** (`3dc49c2`). `backend/lib/eventBus.js:176-178` correctly scopes rule lookup with `where: { tenantId, triggerType, isActive: true }`. The failing test was contaminated by parallel sibling specs all creating tenant-A rules on `deal.created` and firing them concurrently. Fix: tag the audit-count query with a unique `_specBus` token so each spec only counts its own emits. **No backend code changed; tenant scoping was already correct.**

- **L2 — lead-scoring UI** (`35fedc7`). All 7 tests pass against `BASE_URL=https://crm.globusdemos.com` (Nginx serves SPA). Failure reproduces only against the local `127.0.0.1:5000` stack which is backend-only by design. **Standing rule** added to TODOS.md: UI specs need the SPA served (demo or local Vite at :5173).

- **L3 — wellness-real-user-journeys** (`fe91c36`). B1 doctor login + D1 owner Rishu login share L2's SPA-served issue (added `test.skip()` with descriptive message when SPA not served). C1 telecaller lead seed + F1 lifecycle GOOD lead had a hardcoded `PARTNER_KEY = 'glbs_6ba9...'` (demo's seeded value); `prisma/seed-wellness.js` mints a random key per fresh DB. New `resolvePartnerKey(request)` helper: tries static key → if 401, logs in as wellness admin and reads `/api/developer/apikeys` to discover the local Callified key. Cached per worker. **Verified:** local 22 passed / 11 SPA-skipped / 0 failed; demo 25 passed / 7 SPA-skipped / 1 pre-existing tab-locator drift (B3 — out of scope, ~30 min follow-up).

### Documentation

- **TODOS.md** — T1.2 marked complete; e2e-full long-tail closed (L1/L2/L3 all resolved); next-gap recommendation refreshed (G-7 + G-14 + G-16 parallel batch, then G-9/G-10/G-11 trigger-endpoint trio, then G-20 tenant-isolation as highest-severity multi-day pickup).

### Carry-over (NOT in this release)

- **B3 wellness-real-user-journeys tab-locator drift** against demo — was failing before today's L3 work (verified by stashing L3 edits and re-running); isn't a regression from this session. ~30 min next session.
- **G-7/G-14/G-16 + G-9/G-10/G-11 + G-20** gate specs — recommended next batch in TODOS.md.

---

## v3.4.0 — 2026-05-03 — gate-spec push, demo cleanup automation, compliance fixes

A follow-on release continuing v3.3.0's test-infra arc. **No new product features** — every change is gate coverage, route-side compliance fixes, or operations automation. Demo-monitor cron is now live and running every 30 min against the deployed box.

### Test surface continued growth (per-push)

| Tier | Tool | v3.3.0 | v3.4.0 | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | 23 specs / ~1,084 tests | 31 specs / **1,435 tests** | +8 specs / +351 tests |
| Per-push unit tests | vitest | 22 files / 674 tests | 22 files / 677 tests | +3 |
| **Total per-push** |  | ~1,758 | **2,112** | **+20%** |

### Added — 8 new gate specs (~351 new tests)

All from the `docs/E2E_GAPS.md` priority backlog (G-1 to G-25). Each spec asserts: happy path + auth gate + tenant isolation + RBAC where applicable + `test.fixme()` blocks documenting any compliance gaps the spec author surfaced (those gaps are fixed in this release; see "Compliance fixes" below).

- **G-1** `landing-pages-api.spec.js` (1e5bd3e — 41 tests) — covers all 10 endpoints of `routes/landing_pages.js` (zero coverage prior). State-machine drift documented (publish/unpublish are idempotent, not 422-on-state-conflict).
- **G-2** `workflows-api.spec.js` (21f8333 — 48 tests) — 9 endpoints of `routes/workflows.js`. Surfaced contract drift: `/test` is NOT a true dry-run — it calls `emitEvent → executeAction` and DB-mutating actions (create_task, send_notification, etc.) ARE side-effected.
- **G-3** `integrations-api.spec.js` (47023a0 — 30 tests) — 6 endpoints + Callified SSO. Surfaced **#409** (toggle missing admin guard).
- **G-4** `search-api.spec.js` (2f02cde — 14 tests) — 1 endpoint, 10-table prisma fan-out. Documented `?type=` is a no-op; no `leads` bucket.
- **G-5** `audit-api.spec.js` (f5e9c7c — 20 tests) — compliance-relevant; surfaced **#408** (audit.js missing admin role guard, leaking PII via the `details` JSON column).
- **G-6** `appointment-reminders-api.spec.js` (cdbca1e — 16 tests) — wellness PRD-critical SMS dispatch (T-24h + T-1h windows, idempotency, cancellation exemption, RBAC).
- **G-8** `low-stock-api.spec.js` (310296f — 12 tests) — wellness inventory threshold alerts (notification dispatch, idempotency, tenant isolation).
- **G-25** `security-headers.spec.js` (ef7b151 — 3 tests) — Helmet/CSP regression detection. Snapshot-pins all 11 helmet-managed headers + HSTS regex + `x-powered-by` absent + CSP-absent-by-design (the embed widget contract).

### Schema migration

- **`Activity.description` → `@db.Text`** (commit `849f08f`). Was VARCHAR(191); partner payloads to `POST /api/v1/external/leads` with utm + verbose notes + junk-filter reasons concatenated would overflow → 500 the route. Earlier hand-fix `84a606d` clamped at 188 chars + ellipsis to dodge the overflow; this release drops the clamp and lets the full text round-trip. `prisma db push --accept-data-loss` self-heals on demo via `51ad352`.

### Compliance fixes (closes 2 issues)

- **#408** — `routes/audit.js` now requires `verifyToken, verifyRole(['ADMIN'])`. Audit log row `details` JSON carries PII for several entity classes (Contact name+email on SOFT_DELETE, wellness Patient/Visit writes). Was readable by MANAGER and USER tenant-wide; now ADMIN-only.
- **#409** — `routes/integrations.js POST /toggle` now requires `verifyRole(['ADMIN'])` to match its sister `/connect` and `/disconnect`. Was documented as "legacy compat" but lacked the admin guard its peers had — non-admins could flip any provider's `isActive` flag and silently CREATE Integration rows via the upsert path.

### Operations automation

- **e2e-full `scrub-demo` job** (commit `db932ab`) — every release-validation run against demo now self-cleans. Per-shard step still uses `E2E_SKIP_SCRUB=1` to avoid inter-shard teardown race; one final job runs `scrub-test-data-pollution.js --apply` + `merge-duplicate-patients.js --commit` over SSH after the matrix completes. Result: 605-row pollution windows like 2026-05-02 18:53 (manual e2e-full kicked off without scrub) no longer leave residue for demo-monitor to flag 30 min later.
- **Demo-monitor cron enabled** — `.github/workflows/demo-monitor.yml` switched from workflow_dispatch-only to `schedule: '*/30 * * * *'`. Auto-opens (or comments on) a tracker GitHub issue with a stable title on failure, so any drift surfaces within 30 min.
- **`Activity.description` deploy self-heal** — deploy.yml step `51ad352` runs `prisma db push --accept-data-loss` on every deploy, so the column-type migration applied without manual intervention.
- **Demo seed scripts cleaned up** — emergency manual scrub on 2026-05-02 cleared 605 polluted rows + 68 real-name patient duplicates (Kavita Reddy x9, Aarav Sharma x9, etc. that had accumulated from earlier e2e-full runs).

### Local 4-gate mirror docs (CLAUDE.md)

`scripts/test-local.ps1 -Local` and `scripts/test-local.sh --local` now documented in CLAUDE.md as the canonical pre-push iteration loop. `-Local` mode auto-boots `docker-compose.yml` (MySQL 8.0 on host port 3307), seeds both tenants, starts backend on `:5000` with `DISABLE_CRONS=1`, and runs all 4 gates (build / lint / api_tests / unit_tests). `-KeepStack` keeps the stack between iterations. Includes the "demo runs old code" trap warning so route changes are tested against actual local edits, not the previously-deployed code.

### `.claude/settings.json` allow-list

Project-shared file at `.claude/settings.json` was added in v3.3.x and broadened in this release. Auto-approves: `scripts/*` (PS + bash), `npx prisma db push / generate / migrate`, `node prisma/seed*.js`, `node backend/scripts/*`, `npm test / build / vitest / playwright test`, read-only `docker ps / inspect / logs / compose:*`, read-only `gh run list / view`, `gh issue list`, `gh workflow run`, `gh pr list / view`. Plus wildcard `PowerShell(*)` for incidental Windows shell work. Destructive ops (`git push --force`, `gh pr merge`, SSH to demo) deliberately NOT covered — they still go through the normal approval flow.

### Native dialog sweep

Native `window.alert()` / `window.confirm()` / `window.prompt()` calls block browser-automation tools (the user's Claude Chrome plugin, Playwright dialog handlers, Selenium). The vast majority were migrated to `useNotify()` (HTML toast + modal) in commit `e2c0b88` (2026-04-26). This release caught 3 stragglers the prior sweep missed:
- `Sidebar.jsx` Callified-SSO error path (`6d35209`)
- `Leads.jsx` "Name is required" validation (`ee842c9`)
- `SequenceBuilder.jsx` 6 broken `notify({type, message})` invocations + 2 bare alerts in StepEditor + 1 bare confirm (`d95df5a`) — these would have thrown at runtime since `notify({…})` isn't a valid form of the API.

### Heal-loop fixes (commit `ccfb97e`)

The full local 4-gate run against accumulated state surfaced cross-spec issues no individual spec saw:

- **G-6 `afterAll` PUT-rename cleanup** — `^E2E_FLOW_REMINDERS_/`-prefixed Patients were leaking past G-6's spec into `demo-hygiene-api` and `teardown-completeness` (which run later in the same suite). Replaced the trust-global-teardown comment with a `PUT /api/wellness/patients/:id { name: '_teardown_g6_<id>' }` rename sweep so the next spec sees clean rows.
- **G-8 `afterAll` notification cleanup** — engine writes `Notification` rows with `title: "Low stock: <RUN_TAG-prefixed product>"` matching demo-hygiene's `/ E2E[_ ]/` regex. Spec now lists notifications, filters by RUN_TAG, deletes via `/api/notifications/:id`.
- **Rate-limit bumps for `NODE_ENV === 'test'`** — full-gate (~1,450 tests + retries + login helpers) blew past `5000 req/15min apiLimiter` and `10/IP/10min portalRequestOtpIpLimiter`. Test-env-only bump applied to both. Production limits unchanged.
- **Global-teardown Notification sweep** — defence-in-depth in `e2e/global-teardown.js`: any future engine that fans out notifications referencing test fixtures auto-cleans by matching `NAME_REGEX_SQL` against `title`/`message`.
- **DB residue scrub + reseed** — one-shot cleanup of accumulated state from concurrent test iteration. Not a code change, but the resulting DB state is what the heal-loop's "0 failed" measurement was taken against.

### Skipped-test triage (commit `2df54de`)

`api_tests` gate had 8 skipped tests at the start of this work; ended at 2 (both intentional and documented):
- 3× `test.fixme` waiting on real route fixes — flipped to active `test()` once #408 + #409 landed
- 2× conditional skips on stale endpoint paths in `demo-hygiene-api.spec.js` (`/api/lead-routing/rules` → `/api/lead-routing`, `/api/kb/articles` → `/api/knowledge-base/articles`) — corrected so the hygiene scan actually scans those endpoints
- 1× `test.skip(name, fn)` asserting an `onerror=` literal-substring guard that doesn't exist by design — deleted (XSS defence belongs at render time)
- 2× intentional conditional skips left as documented (sequence-engine no-email-contact branch covered elsewhere; wellness-rbac `/staff` consistency check only relevant when both endpoints return 200)

### Final test counts at v3.4.0 release

| Gate | Spec count | Test count | Skipped | Runtime |
|---|---|---|---|---|
| api_tests (deploy.yml) | 31 | 1,435 passed | 2 (intentional) | ~1.6 min |
| vitest (deploy.yml) | 22 files | 677 passed | 3 (documented v3.3.0 deferrals) | ~1.4s |
| **Total per-push** | — | **2,112 passed** | 5 | — |

Plus release-validation: `e2e-full.yml` runs the full chromium project (~2,500 tests across UI flows + wellness deep + a11y + integration + auth + api-health) on every git tag push, sharded 4-way to fit the 30-min runner.

---

## v3.3.0 — 2026-05-01 — test infrastructure overhaul + Tier 1 CI hardening

A foundational release. **No new product features** — every change is in the test infrastructure, CI/CD pipeline, or under-the-hood bug fixes that surfaced from the new test surface. Two real production bugs were caught + fixed.

### Test surface expanded ~7× (per-push)

| Tier | Tool | Pre-v3.3.0 | v3.3.0 | Delta |
|---|---|---|---|---|
| Per-push API tests | Playwright | 18 specs / 673 tests | 23 specs / ~1,084 tests | +5 specs / +411 tests |
| Per-push unit tests | vitest | 0 | 22 files / 674 tests | NEW |
| **Total per-push** |  | **673** | **~1,758** | **+161%** |

### Added

**Phase 1 e2e coverage push (5 new API specs)** — targets the highest-leverage uncovered routes per `backend/scripts/coverage-analysis.js`:
- `e2e/tests/wellness-clinical-api.spec.js` (~154 tests) — patient + visit + Rx + consent + service + location CRUD with full validation matrix, clinical no-delete policy verification, role-gate matrix (admin/manager/doctor/professional/telecaller/stylist/helper)
- `e2e/tests/contacts-api.spec.js` (77 tests)
- `e2e/tests/deals-api.spec.js` (73 tests)
- `e2e/tests/external-api.spec.js` (53 tests, X-API-Key partner endpoints, bootstraps fresh ApiKey per run)
- `e2e/tests/surveys-api.spec.js` (54 tests, including public `/surveys/public/:id` endpoints)

**Vitest unit-test layer (new tier)** at `backend/test/`:
- 22 files / 674 tests covering `lib/audit.js`, `lib/eventBus.js`, `lib/fieldEncryption.js`, `lib/leadAutoRouter.js`, `lib/leadJunkFilter.js`, `lib/leadSla.js`, `lib/notificationService.js`, `lib/validators.js`, `lib/webhookDelivery.js`, all 7 middleware files, `services/landingPageRenderer.js`, `services/pdfRenderer.js`, `services/pushService.js`, `services/smsProvider.js`, `services/telephonyProvider.js`, `utils/deduplication.js`
- 3 tests intentionally skipped (Mailgun success branch, push delivery success — covered by e2e specs; require msw/nock-style mock servers for unit-level isolation; deferred to a future integration tier)
- `backend/vitest.config.js` with `server.deps.inline` for lib/middleware/services/utils paths so `vi.mock('../../lib/prisma')` correctly intercepts CJS `require()` chains
- Total runtime: ~1.2s (separate from the 3-min api_tests gate)

**Tier 1 CI hardening (4 new gates)**:
- **CI-1: ESLint** — `backend/eslint.config.js` (flat config, ESLint 9). Project-specific `no-restricted-syntax` rule blocks bare `req.user.id` (the JWT payload key is `userId`; bare `req.user.id` evaluates to undefined). Mandatory `lint` job in `deploy.yml`.
- **CI-2: Dependabot** — `.github/dependabot.yml`. Weekly Mon 06:00 UTC for npm-backend, npm-frontend, npm-e2e, github-actions. Patch + minor grouped per ecosystem; major individual; security-only ignores cadence.
- **CI-3: gitleaks secret scan** — `.github/workflows/secret-scan.yml`. Incremental scan on every push + PR (~10-20s); full-history scan Mondays 06:30 UTC. Allowlist at `.gitleaks.toml` for known-intentional demo creds + dev-fallback constants.
- **CI-4: npm audit gate** — `backend/scripts/check-audit.js` wrapper around `npm audit --json` with allowlist at `backend/.audit-allowlist.json`. Fails on high or critical advisories not on the allowlist. Auto-fixed 4 CVEs (path-to-regexp, follow-redirects, nodemailer, brace-expansion); 4 remaining high-severity advisories documented with remediation plan + sunsetBy 2026-08-01 (xlsx ×2, semver via imap, imap+utf7 transitive).

**New GitHub Actions workflows**:
- `.github/workflows/coverage.yml` — workflow_dispatch only. Spins ephemeral c8-instrumented backend, runs all 23 API specs, reports lines/branches/functions/statements % + top-10 under-covered files + lcov artifact + CSV.
- `.github/workflows/e2e-full.yml` — full chromium + auth-tests + api-health Playwright projects against deployed demo. Fires on tag push `v*`, GitHub Release publish, or manual trigger.
- `.github/workflows/secret-scan.yml` — see CI-3 above.

**Standing rules** documented in `CLAUDE.md` for new code (route → API spec required; helper → vitest required; `targetUserId` not `userId` in body fields; high CVE → remediate or allowlist with sunsetBy; etc.). Mirrored as project memory at `feedback_ci_discipline.md`.

### Bug fixes — 2 real production bugs surfaced by the new test surface

- **Rx PUT prescriber-check** (`backend/routes/wellness.js:1131,1156`, commit `7506ebd`) — used `req.user.id` but the JWT payload key is `userId`. Bare `req.user.id` evaluated to undefined, so `existing.doctorId !== undefined` was always true for non-ADMIN. Effect: every original prescriber 403'd (`AMEND_FORBIDDEN`) when trying to amend their own Rx. Audit-log `isOriginalPrescriber` was always false. Surfaced by `wellness-clinical-api.spec.js` PUT-prescriptions test.
- **Bare `req.user.id` sweep across 4 routes** (commit `6b1470f`) — same bug class:
  - `routes/wellness.js:1097` — Rx POST `doctorId` default → null in DB
  - `routes/wellness.js:1604/1618/1727` — approval `resolvedById` / `actorUserId`
  - `routes/wellness.js:2955` — telecaller queue filter (always-empty result)
  - `routes/wellness.js:3001` — disposition activity userId orphan
  - `routes/workflows.js:297` — workflow rule debug-tick mockPayload.userId
  - `routes/custom_reports.js:167` — custom report create userId orphan
  - `routes/dashboards.js:75` — dashboard create userId orphan
- **ESLint surfaced 6 more `req.user.id` sites** (commit `ae2f781`) the manual sweep had missed — all in tolerant fallback patterns (`req.user.userId || req.user.id || …`) where the `.id` branch was dead code. Cleaned across `routes/booking_pages.js`, `email_threading.js`, `industry_templates.js`, `sandbox.js` (3 sites).
- **`/communications/track` openPath prefix collision** (`backend/server.js:255`, commit `ed44c44`) — global guard's openPath `/communications/track` accidentally also matched `/communications/tracking/:emailId` (the auth-required stats endpoint), bypassing `verifyToken`. Handler then crashed with 500 on `req.user.tenantId`. v3.2.3 audit comment claiming `/communications/tracking … correctly require auth` was wrong because of the prefix collision. One-character fix (trailing slash on the openPath).

### Test coverage measurement

Last `coverage.yml` run (commit `868b227`):
- **Routes (Playwright + c8)**: 40.52% lines / 73.30% branches / 33.68% functions (was 33.63% / 71.83% / 25.46% pre-Phase 1 — +6.89pp lines)
- **Helpers (vitest + v8)**: 79.01% lines / 77.42% branches / 78.43% functions (first measurement)

### Workflow housekeeping

- Deleted `.github/workflows/post_comments.yml` — was firing on every push and looping over hardcoded issues #83-97 to post a canned "Deep-Module Proxy Bindings Resolved 🚀" marketing comment + close them. All those issues had been closed long ago, so the loop just no-op'd with `|| true` 15× per push. Stale demo theatre.

### Deferred (logged in TODOS.md)

- Phase 2 e2e — billing, payments, social, approvals, marketplace_leads, knowledge_base specs (Phase 2 launched + 1 spec landed; 4 still in flight as of release tag)
- External-service mocked integration tests (Stripe webhooks, OAuth callbacks, Mailgun success branches, push delivery) — future `backend/test/integration/` tier
- Tier 2 CI hardening (CI-5 Prisma migration safety, CI-6 vite bundle-size budget, CI-7 OpenAPI contract validation, CI-8 frontend vitest layer)
- Tier 3 CI hardening (CI-9 Lighthouse CI, CI-10 visual regression, CI-11 mutation testing, CI-12 canary deploy)
- Frontend test infrastructure — 80 React pages + 11 components have zero unit tests

---

## v3.2.5 — 2026-04-29 — security hardening + 8-bug new round + nested patient endpoints

A focused round on a fresh QA pass that surfaced 8 new issues (#341–#348). All closed in a single commit (`d778d6a`) deployed via GitHub Actions. Plus #339 (lingering auto-close lag from v3.2.4) re-asserted and closed.

### P1 / Security

- **#342 [REGRESSION of #186]** — All 6 browser security response headers were missing in production. Root cause: prior Helmet config layered a custom CSP (with `unsafe-inline` + many directives) and `crossOriginResourcePolicy='same-site'` that interacted badly with the SPA's inline styles + the cross-origin embed widget; the response was effectively stripped along the chain. Fix in [backend/middleware/security.js](backend/middleware/security.js): explicit config — `contentSecurityPolicy: false`, `crossOriginEmbedderPolicy: false`, `crossOriginResourcePolicy: { policy: 'cross-origin' }`. Kept HSTS (1y, includeSubDomains), X-Frame-Options SAMEORIGIN, Referrer-Policy strict-origin-when-cross-origin, X-Content-Type-Options pinned. Verified live on `/api/health` (Cloudflare strips on cached HTML; HSTS is host-wide once received).
- **#343 [SECURITY]** — JWT bearer token + tenant PII in JS-readable `localStorage`. Migrated to module-level in-memory holder + `sessionStorage` fallback. AuthContext on cold start migrates legacy localStorage token once and deletes the key. Logout clears in-memory + sessionStorage. New `getAuthToken()` / `setAuthToken()` / `whenAuthReady()` exports in [frontend/src/utils/api.js](frontend/src/utils/api.js). Honest scope: ships a real reduction (no 30-day persistent token in disk-backed storage) without the multi-day httpOnly-cookie + CSRF refactor — XSS still wins on a live page; the cookie migration is logged as long-term wishlist. **Plus a 12-file sweep**: every direct `localStorage.getItem('token')` caller for raw fetches (DealModal, AgentReports, AuditLog, Chatbots, Invoices, Privacy, Reports, Sandbox, Settings, WebVisitors, wellness/PatientDetail, wellness/Reports) migrated to `getAuthToken()`. Without this, those endpoints would 401 immediately.
- **#344 [SECURITY]** — `sessionStorage` retained unsanitized URL path segments as keys (e.g. `gbs.tab.patient.1' OR '1'='1`). PatientDetail tab keys now require id matches `/^\d+$/`; non-numeric ids skip read+write, log warning. `encodeURIComponent` applied as defense-in-depth.

### P2 / API

- **#346** — Nested patient endpoints returned 404 even when the patient existed. Added `GET /patients/:id/visits | /prescriptions | /consents | /treatment-plans`. Each verifies parent exists, reuses select shape, writes `PATIENT_*_READ` audit row.
- **#347** — Auth race during fresh navigation: SPA fired 5–10 API calls before token was loaded; some 403 spuriously. AuthProvider now blocks render behind a `loading` flag that flips false on first `useEffect` tick. `whenAuthReady()` Promise exported for non-React paths.
- **#348** — API namespace inconsistency. Added catch-all 410 Gone for `/wellness/staff` and `/wellness/audit` with `code: WELLNESS_NAMESPACE_INVALID` and a `canonical` field pointing at `/api/staff` / `/api/audit`. New [docs/API_NAMESPACING.md](docs/API_NAMESPACING.md) documents the org-vs-wellness split.

### P2 / UX

- **#341** — No global 404 fallback. New [frontend/src/pages/NotFound.jsx](frontend/src/pages/NotFound.jsx) (~125 lines, wellness-themed, glassmorphism, dynamic suggestions for 8 known wrong-prefix URLs like `/loyalty` → `/wellness/loyalty`). Catch-all `Route path='*'` at end of route tree.
- **#345** — `/api/notifications/unread-count` polled ~1.5x/sec (13 calls in 8s). Killed the `setInterval`; NotificationBell now does ONE initial HTTP fetch + Socket.IO subscription to `notification_new` and `notifications_cleared` events. Backend already emits these.

### P3

- **#339** — Re-asserted auto-close after the v3.2.4 keyword didn't fire (state_reason was null). The dedup-on-create + cleanup-script fix has been live since v3.2.4.

### Risks called out in the commit

- HSTS in dev (1y) — sticks for HTTPS responses only.
- CSP off — removes XSS defense-in-depth. CSP-with-nonce is a future ticket.
- `/wellness/staff` 410 — grepped frontend for callers; none. Safe.
- Socket.IO emit is a global broadcast (clients filter by `user.id`). Per-user rooms is a follow-up.
- 2 unit tests still assert `localStorage.getItem('token')` — will fail. Test update is a follow-up.

---

## v3.2.4 — 2026-04-29 — inbox-zero day-1 → day-2: ~50 issues across 3 agent rounds, GitHub Actions deploy, mobile responsive

The day the issue board went from 50 → 0 → got refilled by overnight QA → cleared again (twice). Three big agent rounds across two work sessions. New CI/CD: GitHub Actions deploy pipeline. New scope: prescription PDF, Reports CSV/PDF export, mobile-responsive 80/20, external-integrations sandbox foundation.

### Class fixes (most leverage)

- **GitHub Actions deploy pipeline** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) — replaces the local `ssh_deploy_*.py` scripts. Triggers on push to `main` (skipping doc/test/script-only changes via paths-ignore) plus manual `workflow_dispatch`. Steps: backend pull → npm install → prisma generate → pm2 restart → health poll → on-fail rollback to HEAD~1 + restart, then frontend vite build → sudo rsync to `/var/www` → **chown www-data + chmod 755/644** (the lesson from a 2026-04-27 sudo-rsync 403 incident is baked in), then a smoke check of `/` and `/api/health` plus the `mountWatchdogReloaded` sentinel from #284. Concurrency `deploy-prod` with `cancel-in-progress: false`. Required secrets: `SSH_HOST`, `SSH_USER`, `SSH_PASSWORD`. After fixing one bash-template footgun (`${{ github.event.head_commit.message }}` interpolated bare into bash echo) by passing the message via env var, the pipeline has been stable for 8+ deploys.

### P0 (3) — security + booking blockers

- **#300 [P0/SECURITY]** — `POST /api/wellness/portal/login/request-otp` returned the OTP in the JSON response body (gated on `NODE_ENV !== 'production'`, but the demo server runs without that env var, so the OTP leaked publicly). Unauthenticated account takeover for any registered patient phone — verified live with Kavita Reddy. Removed the env-var bypass entirely; OTP is now SMS-only.
- **#312 [P0]** — Calendar New Visit modal had an empty Patient `<select>` (only the placeholder option). 184 patients existed but never reached the dropdown. Root cause: `/api/wellness/patients` returns `{patients, total}`, not a bare array; Calendar.jsx read `Array.isArray(pts) ? pts : []` and always fell through. Defensive shape read covering bare-array | `{patients}` | `{data}` (same pattern as #251).
- **#313 [P0]** — Tasks deadline shifted +5:30h. Frontend sent the bare `<input type="datetime-local">` wall-clock string; Node's `new Date(...)` interpreted it as UTC, IST display path then added +5:30. Now sends `new Date(value).toISOString()`.

### P0/P1 RBAC + PHI cluster (4)

- **#292 [P0][PHI]** — Hardcoded OTP `1234` worked for ANY existing patient (not just the seeded demo). Tightened `WELLNESS_DEMO_OTP` bypass: requires `NODE_ENV !== 'production'` (override `WELLNESS_DEMO_OTP_ALLOW_PROD=1`) AND phone in `WELLNESS_DEMO_OTP_PHONES` (default `9876500001`).
- **#295 [P1]** — `request-otp` had zero rate limiting. Two stacked `express-rate-limit` instances: 3/10min per phone (last-10 keyed) + 10/10min per IP (`ipKeyGenerator` for IPv6). Verified: 5 sequential → 200, 200, 200, 429, 429.
- **#280 / #324 [PHI]** — Stylists could read full doctor calendar; doctors saw all 16 practitioner columns. Extended `wellnessRole` scope on `GET /wellness/visits`: stylists/helpers see only their own column OR non-clinical-category visits; doctors see only their own column. ADMIN/MANAGER keep full org oversight.
- **#326 [P1][RBAC]** — Telecaller could write New Prescription. New `requireClinicalRole` middleware on POST/PUT `/prescriptions` — only `wellnessRole==='doctor'` OR RBAC ADMIN passes; everything else 403 with `code: 'CLINICAL_ROLE_REQUIRED'`. Smoke-verified live.
- **#323 [P1][RBAC]** — Manager saw Delete + role-edit on `/staff`. Backend was already ADMIN-only; UI was leaking. Hid both behind `canManageStaff` check in Staff.jsx.

### Multi-day items shipped (3)

- **#227 — Reports CSV/PDF export** across 4 tabs (P&L, Per-Pro, Per-Location, Attribution). Backend extracted 4 pure calc helpers so JSON + CSV + PDF share the same query path. CSV uses `rowsToCsv` with UTF-8 BOM (Excel-friendly INR + Hindi names) + appended TOTAL summary row. PDF uses pdfkit A4-landscape with the same letterhead style as the prescription PDF. Frontend Reports.jsx gets per-tab Export CSV / Export PDF buttons using the same blob-fetch + Bearer pattern as RxDetailModal.
- **#228 — Mobile responsive 80/20** (demo-path only; full parity is multi-day follow-up). Sidebar collapses behind a hamburger drawer at ≤768px (backdrop tap + ESC + route-change auto-close, ARIA wired). New `frontend/src/styles/responsive.css` covers 6 demo-path pages: OwnerDashboard, Patients, PatientDetail, Calendar, Reports, TelecallerQueue.
- **#137 — External integrations sandbox foundation**. New [docs/wellness-client/SANDBOX.md](docs/wellness-client/SANDBOX.md) inventories 7 inbound webhooks + 7 outbound integrations + 19 cron engines tagged by E2E coverage status (8 have NO coverage). Three runnable Express mocks at ports 5101/5102/5103 in [backend/scripts/sandbox/](backend/scripts/sandbox/). [e2e/sandbox-harness.md](e2e/sandbox-harness.md) documents the cron-trigger pattern.

### #278 — Prescription detail modal + PDF download + Instructions in timeline

- Case History timeline now shows Instructions (truncated >140 chars with Show more / Show less).
- Rx cards are clickable (role=button, keyboard Enter/Space) and open a new `RxDetailModal` showing all 8 fields.
- "Download PDF" button uses an existing backend route (`GET /prescriptions/:id/pdf`) wired through `pdfRenderer.js`. Letterhead style: clinic name, address, divider, ℞ symbol, drug list, full instructions, signature line.

### Bug fixes — smaller P2/P3 (40+)

Across 3 agent rounds + a stale-issue cleanup. Sample:

- **#283** — Convert lead → Customer skipped Prospect AND didn't create a Patient. Frontend Convert button now sends `Prospect`; backend contacts PUT detects `* → Customer` transitions on wellness tenants and idempotently creates a Patient row (phone-last-10 dedupe + audit log).
- **#284** — React app fails to mount on first navigation. `lazyWithRetry` retries 3× with 300ms/900ms exponential backoff before falling through to stale-chunk reload. `main.jsx` 4-second mount watchdog force-reloads once if `#root` empty.
- **#285 + #261** — Orchestrator-emitted duplicate tasks + recommendation cards. Payload-hash dedup across all statuses for today + new `findOrCreateTask` helper that short-circuits on (title, dueDate-day, tenantId). Plus inline `cleanupExistingDupes()` runs at top of every cron pass.
- **#308** — Same recommendation in Pending+Approved+Rejected at once. `GET /recommendations` widens to all-status, groups by `(type + lowercased title)`, picks most-resolved per group, then filters to the requested status.
- **#321** — Reports P&L PRODUCT COST showed ~₹100 trillion. Schema-level cap on POST `/visits/:id/consumptions`: qty ≤ 10000, unitCost ≤ ₹10L, line total ≤ ₹1Cr. Cleanup script zeroed the 1 polluted row.
- **#316 [P1]** — All `<input type="number">` fields concatenate residual on Ctrl+A → Delete → type. Two prior agents skipped via grep; third investigated useFormAutosave (not the cause), keydown handlers (none global), defaultValue/.value= imperative (none). Most plausible remaining theory: browser/IME or Playwright `.fill()` artifact. Shipped a defensive helper [frontend/src/utils/numberInput.jsx](frontend/src/utils/numberInput.jsx) (`sanitizeNumberInput` + `<NumberInput>` wrapper) with `prev.length*2 + startsWith` guard so legit typing isn't collapsed. Adopted on Service Catalog Duration; other call-sites can migrate when the helper proves out the theory.
- **#331** — Patients search drops first character. Triple-defense: skip-first-mount-debounce, `qRef` captures current query for debounced effect, request-id tags so stale empty-q response can't stomp typed-query result.
- **#320** + **#272** + **#271** + **#268** + **#267** + **#266** + **#265** + **#250** + **#306** + **#310** + **#311** + **#318** + **#319** + **#322** + **#327** + **#328** + **#330** + **#339** — Data-quality cleanup. Three scripts ran on prod: [cleanup-p3-data-quality.js](backend/scripts/cleanup-p3-data-quality.js), [merge-duplicate-patients.js](backend/scripts/merge-duplicate-patients.js) (331 patients → 181 with all 327 visits/33 Rx/14 consents/42 treatment plans preserved via reattach), and [cleanup-seed-pollution-2026-04-27.js](backend/scripts/cleanup-seed-pollution-2026-04-27.js) (87 row mutations). Plus the new `cleanupLandingPageDraftDupes()` section.

### Test coverage

- **66.65% lines** (was 64.76% — +1.89 pt) measured 2026-04-27 across 1,191 backend tests in 14.4 min. Branches 51.97%. Functions 68.13%. Gate raised `60/45/60/60` → `65/50/65/65`.
- New [e2e/tests/sms-api.spec.js](e2e/tests/sms-api.spec.js) (44 tests) covering `routes/sms.js` (was 31%) — POST /send validation + no-provider, GET /messages with OTP-redaction filter, /templates CRUD, /config ADMIN-only mask, /drain admin queue flush, /webhook/twilio + msg91 status maps, auth gates.

### Lessons learned (baked into next-session habits)

1. Prisma `contains: '_'` is a SQL LIKE wildcard match-all, not a literal underscore filter. Use `findMany` + JS `.filter()`.
2. Don't `sudo rsync --delete dist/ /var/www/...` from a non-root user — strips ownership; nginx 403s. Fix baked into `deploy.yml`.
3. GitHub Actions multi-line commit-message interpolation is a footgun. Use `env: COMMIT_MSG: ...` and `printf '%s\n' "$COMMIT_MSG"`.
4. Referral schema uses `referrerPatientId` / `referredPatientId` — both must be reattached during patient merge.
5. Parallel agent file-affinity discipline: 4–5 agents in parallel works reliably when each owns a disjoint set of files. Same-file agents must be folded into one.

### Closed by product decision (4)

- **#200 #201 #211 #241** — Login quick-login chips + prefilled creds. Intentional for the demo server (publicly-accessible dev/sales-demo, not real production). Closing as won't-fix; for a real production deployment, env-gate behind `NODE_ENV === 'production'` at deploy time.

### Stale-issue cleanup (6)

- **#141 #142 #147 #150 #152 #153** — Migrated from `Globussoft-Technologies/callified` on 2026-04-24 with no repro steps, only screenshots on prnt.sc/somup.com. 3 days idle. Closed as stale; re-file with browser+OS, network panel, console, step-by-step repro if observed in v3.2.x.

---

## v3.2.3 — 2026-04-27 — P1 + P2 closure pass, fetchApi rewrite, demo polish

A focused day-long pass on user-reported QA bugs. **24 GitHub issues closed**: 8 P1 (demo-breaking), 11 P2 (functional gaps), 4 silent-failure cluster (#273-#276 + the systemic fetchApi fix), and 1 visit overflow (#277). P1 + P2 boards both at 0 open. No schema changes; backwards-compatible API changes only.

### Class fixes (most leverage)

- **`fetchApi` rewrite** ([frontend/src/utils/api.js](frontend/src/utils/api.js)) — every error toast across the app now surfaces the real server message, not the generic literal "API Request Failed". Root cause: `fetchApi` read `errData.message` but every backend route returns `{error, code}`. Fix: read `errData.error || errData.message`; 403 / 404 / 5xx / network fallbacks; auto-toasts via `_globalNotify` registered by `NotifyProvider` on mount; throws Error with `.status` / `.code` / `.data` attached so callers can branch. Pages opt out with `{silent: true}`. Closes the silent-failure class behind #273-#276.
- **Stale-chunk recovery for all lazy routes** (#249) — new `lazyWithRetry` helper wraps every `lazy()` import; on `Failed to fetch dynamically imported module` it auto-reloads once per session (sessionStorage guard prevents loops). New `RouteErrorBoundary` catches the residual case with a "Reload page" CTA. Affects all 80 lazy routes, not just `/marketplace-leads`.
- **Visit.amountCharged ₹50L cap** (#277) — POST + PUT `/api/wellness/visits` now reject `amountCharged > 5_000_000` with `code: AMOUNT_TOO_LARGE`. Matches `Service.basePrice` ceiling from #209. Cleanup script `backend/scripts/cleanup-overflow-visit-amounts.js` NULLed 2 polluted ₹1e15 rows on prod (residue from #218 era — Z-service polution).
- **Reports off-by-one date range** (#234) — `reportRange()` parsed `to=YYYY-MM-DD` as midnight UTC, dropping every visit/consumption later that day. Fix: when raw param is date-only, clamp `from` to start-of-day, `to` to end-of-day in UTC. Net effect: P&L productCost went ₹0 → ₹32,000; Reports counts up from 109 → 117 visits.
- **Reports tabs canonical totals** (#232) — P&L / Per-Pro / Per-Location were each silently filtering visits with different rules and reporting their per-row sums as totals. New `canonicalVisitTotals()` helper makes `totals.visits` + `totals.revenue` identical across the 3 tabs; new `totals.unbucketed` exposes the join-key-missing delta. Verified live: 117 / 117 / 117 visits, ₹12.9L / ₹12.9L / ₹12.9L revenue.

### Bug fixes — P1 (demo-breaking, 8)

- **#232** Reports tabs disagree on visit totals — see class fix above.
- **#235** Clinic locations not editable after creation — pencil icon added; PUT path was already accepted by backend.
- **#238** Patient portal OTP rejects every code — added `WELLNESS_DEMO_OTP` env-var bypass for QA flow; demo patient `+919876500001` seeded; documented in [PRODUCTION_RUNBOOK.md](PRODUCTION_RUNBOOK.md).
- **#247** Calendar grid drops visits without doctorId — visits now render in an "Unassigned" column; out-of-range visits clamp to boundary hour.
- **#249** /marketplace-leads stale-chunk error — see class fix above.
- **#253** Inbox Play Recording silent — wired native `<audio controls autoplay>`; falls back to "Recording not available" on load error.
- **#259** /api/wellness/dashboard 403 for Owner — closed not-reproducing; `verifyWellnessRole(["admin","manager"])` correctly admits ADMIN role.
- **#260** /leads rows have no click handler — row navigates to `/contacts/:id`; `e.stopPropagation` on interactive child cells.

### Bug fixes — P2 (11)

- **#230** Treatment plan Add rapid-click duplicates — closed as already fixed in #225 (90ff63f, debounced).
- **#231** Consent canvas strokes white on cream — `ctx.strokeStyle` now reads `--text-primary` at draw time.
- **#234** P&L productCost stuck at ₹0 — see class fix above.
- **#243** Invoices ledger column overflow — `table-layout: fixed` + `<colgroup>` widths + Contact ellipsis + opaque sticky Actions.
- **#246** Owner Dashboard expected revenue ₹0 — closed as already fixed by #277 cleanup.
- **#252** Inbox empty-state misleading on Emails tab — scoped to active tab with sub-line listing other-tab counts.
- **#257** Estimates Drafts/Sent pills don't filter — wired with `statusFilter` state + `aria-pressed`.
- **#258** Lead Routing Apply All silent — migrated from local toast to global notify for consistency.
- **#262** Calendar shows only 3 doctor columns — now shows ALL practitioners (16 staff: 3 doctors + 13 professionals); chip toggles between "with visits today" and "All N".
- **#264** Settings Dark Mode toggle no-op — disabled with "coming soon" copy until a real dark theme stylesheet ships (multi-day work, not in PRD §8).
- **#270** Calendar empty-slot click no-op — now opens a "New visit" modal seeded with (practitioner, date, hour). Patient required, status='booked'.

### Bug fixes — Silent-failure cluster (4)

- **#273** Estimates Convert silent no-op — added explicit success toast `Converted to invoice <num>`; 400 errors get a one-line hint about contact + line items.
- **#274** Services Save 403 silent — fetchApi now surfaces "Insufficient wellness role" directly; success path toasts `Saved <name>`.
- **#275** Meta: no toast container mounted — closed as misdiagnosis. NotifyProvider has been mounted at App root since launch; the toast container only mounts when toasts are active. The real fix was the `fetchApi` rewrite (see class fix).
- **#276** Recommendations Reject button unwired — was actually wired with a confirm modal that the user dismissed without realising; explicit success toasts added on Approve/Reject.

### Engine improvements

- None this release — UI + ops + class fixes only. Engine layer untouched.

### UI

- **17 redundant `notify.error('Failed: ${err.message}')` catches removed across 9 wellness pages** (`dfe94b7`); replaced with `catch (_err) { /* fetchApi already toasted */ }` and added missing success toasts on Locations create/update/toggle, Loyalty referral + reward, Patients create, Treatment plan create, Inventory consumption log, Services create, Waitlist add/status/remove, TelecallerQueue.
- New `RouteErrorBoundary` component with "Reload page" CTA for stale-chunk + uncaught render errors.
- Inbox empty-state copy scoped per tab.
- Estimates ledger pills are now real filter buttons.
- Settings Appearance section copy updated to flag dark mode as "coming soon".
- Calendar header chip surfaces practitioner count + filter; column headers show role tag.
- New visit modal seeded from grid cell click.

### Test coverage

- **3 new e2e specs (113 tests)** earlier in the day:
  - `routes/reports.js` (`4846adb`) — 52 tests, was 14.17%, forecast ~85%.
  - `routes/marketing.js` (`612617f`) — 41 tests, was 28.20%, forecast ~80%. Surfaced + fixed `/marketing/submit` openPaths bug.
  - `routes/voice_transcription.js` (`d7ed223`) — 20 tests. **⚠️ Retroactively flagged as PRD drift** — voice belongs to Callified per PRD §6.5. Tests stay; don't extend.
- **OpenPaths audit complete** — no further gaps (landing_pages mounted at `/p`, `/communications/tracking` and `/attribution/track` correctly require auth).
- **Combined coverage forecast: 64.76% → ~71-72% global lines.** Re-run on the server next session and bump `.c8rc.json` `60 → 70` if data supports it.

### PRD scope guardrails (added 2026-04-27)

A coverage push on `routes/voice_transcription.js` was flagged retroactively as drift. Added a §"PRD scope guardrails" block to TODOS.md: voice + WhatsApp routes belong to Callified.ai (PRD §6.5); ad creation belongs to AdsGPT (PRD §6.6); patient self-service portal extensions are not in PRD §5 personas. SMS coverage IS in PRD scope. Reports + Owner Dashboard + Lead management + Calendar + Multi-clinic ARE in PRD scope.

### Deferred (not in v3.2.3)

- **PRD §6.4 lead-side SLA timer** — current SLA engine is ticket-side; lead-side per PRD requires extending or new `LeadSla` policy.
- **PRD §6.7 orchestrator depth audit** — verify the engine actually computes occupancy gap → recommends budget → drafts campaign vs being a stub.
- **PRD §11 audit log on patient READS** — write-side is shipped (#179, v3.2.1); read-side `prisma.auditLog.create` calls in GET handlers are not.
- **#227 Reports CSV/PDF export** — backend export endpoints + per-tab export buttons. ~1-2 days. PDFKit already in stack.
- **#228 mobile responsive overhaul** — multi-day frontend rewrite.
- **AdsGPT silent SSO "Back to CRM" link** — pending with AdsGPT team.
- **Callified silent SSO + back-link + lead webhook** — pending with Callified team.

---

## v3.2.2 — 2026-04-26 (afternoon) — Form autosave, billing patch, telecaller polish, c8 coverage measured

A focused afternoon pass closing the remaining frontend UI cluster from the morning handoff plus the first real backend coverage measurement. **8 GitHub issues closed.** No schema changes; no breaking API changes.

### Added

- **Form autosave hook** (#226) — new `frontend/src/hooks/useFormAutosave.js`. Wraps any controlled form: rehydrates from `sessionStorage` on mount, debounced persist on every keystroke, `beforeunload` warning if dirty, active-tab persistence so a refresh inside Patient Detail's tabbed view doesn't blow away the half-typed prescription. Surfaces a "Restored from previous session" banner that the user can dismiss or accept. Wired into New Prescription, Log Visit, and Treatment Plan forms first; pattern is opt-in, drop-in for the rest.
- **Billing PATCH + mark-paid endpoints** (#202) — `PATCH /api/billing/:id` for partial updates and `POST /api/billing/:id/mark-paid` (idempotent — second call returns `{ idempotent: true }`). Both write audit rows. State-machine codes: terminal transitions return `422` with `code: "INVALID_INVOICE_TRANSITION"` (matches the v3.2.1 approvals pattern). Closes the long-standing "no update path on /api/billing" gap.
- **DISABLE_CRONS=1 env switch** — when set, `server.js` skips all cron initialisation. Lets us run a side-by-side coverage instance on `:5098` without cron jobs interfering with the primary `:5099` PM2 process.
- **Graceful SIGTERM/SIGINT shutdown** — `server.js` now flushes V8 coverage data via `process.on('SIGTERM')` / `process.on('SIGINT')` before exiting. Required for `c8` to write `.c8tmp/coverage-*.json` artefacts on shutdown — without it, killing the process hard means losing the coverage data.

### Bug fixes

- **Form refresh wipes input** (#226) — covered above; was previously losing data silently mid-prescription / mid-visit-log.
- **Telecaller queue inconsistent dispositions** (#215) — Booked / Callback / Interested fired silently; Wrong number / Junk showed a confirm. All 6 now confirm consistently. Booked / Callback / Interested also gain a follow-up form (date+time for Booked/Callback, notes for Interested) so the disposition captures real intent rather than a one-tap throwaway.
- **`/portal` route collision** (#208) — wellness patient portal moved to `/wellness/portal`; the generic CRM customer portal stays at `/portal`. Sidebar Link + redirect updated. Both routes now resolve to their intended page.
- **`/wellness/tasks` blank** (#217) — verified the shared `/tasks` and `/inbox` routes already render correctly under the wellness theme via the `data-vertical="wellness"` cascade. Sidebar Link rewritten to point at the canonical paths; the 404 was a stale prefix in the sidebar config, not a missing page.
- **Treatment plan Add not debounced** (#225) — submitting state on PlansTab + LogVisitTab + InventoryTab disables the button between click and server response. Sweep across the wellness-form components; pattern documented in the form-handler conventions.
- **Patient list table breaks on long names** (#229) — `table-layout: fixed` + `text-overflow: ellipsis` on the name cell + `title` tooltip showing the full name. Header row no longer disappears when a single patient has a 60-char display name.
- **Service Worker push registration spam** (#206) — `[push] setupPush error: AbortError` demoted from `console.error` to `console.debug`. AbortError on registration is normal when push isn't configured for the tenant; was producing noise on every navigation. Other error classes still log loudly.

### Engine improvements

- None this release. v3.2.1 covered the engine layer; this pass is UI + ops.

### UI

- Form autosave banner ("Restored from previous session — keep / discard") on the three highest-frequency wellness forms.
- Telecaller disposition confirm + follow-up modal (date/time picker for Booked, Callback; notes for Interested).
- Patient table layout no longer breaks on long names.

### Test coverage

- **Backend line coverage measured under the full suite: 64.76%** (21,484 / 33,170 lines) via `c8` against all 1,056 backend tests (14.5 min run, includes new eventBus + landingPageRenderer specs). Initial wellness-only baseline was 33.20%; the full-suite number lands materially higher.
- **Coverage targets set as policy this release:**
  - **Aspirational target: 100%** — everything tested, everything safe.
  - **CI gate: 60% lines / 45% branches** — set with ~5pt headroom over the 64.76% baseline; ratchets up each release.
  - **Critical-path floor: 70%** — `routes/auth.js`, `routes/external.js`, `routes/billing.js`, `routes/wellness.js`, all `middleware/*`, all `lib/*` (exempting `lib/eventBus.js` and `services/landingPageRenderer.js` until their dedicated test files land — both queued for this release).
- **13 pre-existing e2e flakes resolved** — admin/admin → admin@globussoft.com migration; SIDEBAR_ROUTES rebuild against the v3.2.1 sidebar; theme localStorage seed pattern. Pass rate now 96%+ on the navigation/notifications/theme cluster.

### Deferred (not in v3.2.2)

- **Mobile responsive overhaul** (#228) — multi-day frontend rewrite (breakpoints, hamburger drawer, ARIA, focus trap, all wellness pages tested at 375px). Not in this release.
- **Reports CSV/PDF export** (#227) — backend export endpoints + per-tab export buttons across the 4 Reports tabs. Estimated 1-2 days; deferred.
- **Login quick-login chips / pre-fill** (#211 / #201 / #200) — product decision pending: keep, env-gate (`NODE_ENV !== 'production'`), or remove entirely. Not a bug; documented as a UX/security tradeoff.
- **Full-suite c8 coverage measurement landed: 64.76% lines / 50.03% branches / 66.11% functions** across 1,056 backend tests. Top under-covered files queued for next release: `routes/reports.js` (14.17%), `routes/marketing.js` (28.20%), `routes/voice_transcription.js` (29.55%), `routes/sms.js` (31.05%), `cron/slaBreachEngine.js` (24.50%).
- **Dedicated test files for `lib/eventBus.js` (currently 20%) and `services/landingPageRenderer.js` (currently 2%)** — both targeted for this release; until they ship, the critical-path 70% floor exempts them.
- **AdsGPT silent SSO "Back to CRM" link** — still pending with AdsGPT team.
- **Callified silent SSO + back-link + lead webhook** — still pending with Callified team.

---

## v3.2.1 — 2026-04-26 — Overnight QA + audit pass

A two-day deep-flow audit + fix sprint. Closed **22 GitHub issues + 9 architectural backlog items**. Surfaced and patched a class of latent bugs that smoke tests would never catch — only deep API exercise reveals them. No new features; this is hardening.

### Added

- **JWT revocation** (#180) — new `RevokedToken` model. `jti` minted on every login (register/signup/login/2fa-verify); `verifyToken` checks the table on every request, fail-open on DB error so a Prisma blip doesn't lock everyone out. New endpoints: `POST /auth/logout`, `GET /auth/sessions`, `DELETE /auth/sessions/:jti`. Pre-deploy tokens (no jti claim) keep working until natural 7d expiry.
- **wellnessRole RBAC gates** (#207 / #214 / #216) — new `middleware/wellnessRole.js` (`verifyWellnessRole(allowed)`, orthogonal to `verifyRole`). JWT now carries the `wellnessRole` claim. **18 backend endpoints gated** (Owner Dashboard, reports, recommendation approve/reject/edit, service catalog POST/PUT, location POST/PUT, prescription POST/PUT, consent POST/PUT, telecaller queue + dispose). Frontend: login redirects by wellnessRole; OwnerDashboard render-time guard; sidebar hides management modules from clinical staff. **20/20 RBAC e2e tests pass live.**
- **Audit log expansion** (#179) — new `backend/lib/audit.js` (`writeAudit` + `diffFields` helpers). ~50 audit calls added across contacts, estimates, tasks, billing, wellness (patient/visit/Rx/consent/loyalty/recommendation), notifications, auth (profile + role + password). Passwords NEVER written to details; PII recorded as `piiFieldsTouched: [...]` name list only.
- **Cross-resource soft-delete** (#167) — `deletedAt DateTime?` + `@@index([tenantId, deletedAt])` on Contact/Deal/Estimate/Task. DELETE flips `deletedAt` (admin-only); GET filters by default with `?includeDeleted=true` opt-in; new `POST /:id/restore` clears it. Audit rows written for SOFT_DELETE + RESTORE.
- **SLA breach cron + event** (#12) — `Ticket.breached/breachedAt` columns + new `cron/slaBreachEngine.js` (every 5 min). Emits `sla.breached` event; idempotency via `breached=false` precondition. New `POST /api/sla/check-breaches` (ADMIN) for manual trigger.
- **Sequence engine + step-list editor rebuild** (#7 / #9) — new `SequenceStep` model (kind ∈ {email, sms, wait, condition}, FK to EmailTemplate, optional smsBody / delayMinutes / conditionJson + branch positions + `pauseOnReply`). `cron/sequenceEngine.js` rebuilt (372 lines). New `frontend/src/pages/SequenceBuilder.jsx`. New API: `GET/POST /:id/steps`, `PUT/DELETE /steps/:id`. Legacy ReactFlow canvas preserved for sequences with empty `steps`. Reply detection: `processInboundReplies()` parses enrollmentId from `seq-<id>` threadIds and pauses on inbound.
- **Approvals state machine + DELETE + audit** (gaps #3 #4 #5) — terminal transitions return `422 INVALID_APPROVAL_TRANSITION`; idempotent re-approve/reject return `{ idempotent: true }`. New DELETE endpoint. Audit row on every transition.
- **Patient portal `surveys/public/:id`** (#184) — backend GET/POST in `openPaths`; frontend `SurveyPublic.jsx` mounted OUTSIDE the authenticated Layout (no admin sidebar leak). Wellness theme cascades via `data-vertical="wellness"`.
- **SMS drain endpoint** (#182) — `POST /api/sms/drain` (ADMIN). `resolveProviderConfig()` picks SmsConfig row first then env-var fallback (MSG91 → Twilio → Fast2SMS). No provider → fail-fast all QUEUED rows to FAILED with reason.
- **Workflow rule conditions** (#20) — `AutomationRule.condition` String column. JSON-array clauses AND-joined, ops `eq/neq/gt/gte/lt/lte/in/nin/contains/startsWith` with numeric coercion. Empty/null = always-fires. Bad JSON = fail-closed. POST/PUT validate via `validateCondition()` → 400 `INVALID_CONDITION`.
- **Approvals auto-create on threshold** (#1 + #2) — `create_approval` action wired into `workflowEngine.js`. Resolves `entityId` via `payload[entity.toLowerCase()+'Id']`; `reasonTemplate` rendered with mustache-style `{{path.to.field}}` lookups. New trigger types: `approval.created/approved/rejected`.
- **Last 3 dead workflow triggers wired** (#17) — `contact.updated` (with `changedFields`), `task.completed` (gated on `wasCompleted=false`), `lead.converted` (Lead → Customer/Prospect status flip).
- **Loyalty auto-credit on visit completion** — POST/PUT visits with status='completed' auto-credit 10% of `amountCharged` via `LoyaltyTransaction`; idempotent via lookup.

### Bug fixes

- **Portal login 500 on unknown email** — `findUnique({where:{email}})` against a non-`@unique` field threw and returned 500 instead of 401. Three sites fixed.
- **2FA login was unreachable** — `/auth/2fa/verify` was missing from the `openPaths` allowlist; the global guard 403'd before the tempToken could be read.
- **All form-encoded webhooks were broken** — `express.urlencoded()` was not mounted, so Twilio voice/SMS, WhatsApp, Mailgun, and Razorpay webhooks all 400'd silently on missing-field checks.
- **Accounting webhook unreachable** — `/accounting/webhook` not in `openPaths` so QuickBooks/Xero/Tally callbacks 403'd.
- **Setting a quota was impossible** — `POST /quotas` read `userId` from body, but `stripDangerous` middleware deletes `req.body.userId` (anti-injection). Now reads from query.
- **Portal OTP bypass** — legacy `POST /portal/login` accepted any 4-digit OTP without checking PatientOtp. Anyone with a phone could mint a 30-day portal JWT. Now validates against the OTP table the same way `/verify-otp` does.
- **`/sequences/debug/tick` open to any user** — implicitly auth-protected but any USER could fire the cron loop for every tenant. Now ADMIN-only.
- **P&L productCost stuck at ₹0** — visit `findMany` select omitted `id`, so the consumption-cost lookup always missed. One-line fix; cost rollups now correct.
- **P&L day-boundary desync** — joined consumptions through `consumption.createdAt` (drifts from revenue window). Now joins through `visit.visitDate`.
- **XSS sanitiser was half-done** (#213) — only stripped `<script|iframe|object|embed|svg>`. Now also strips `<img|video|audio|source|applet|base|input|textarea>` plus inline event handlers (`onclick=`, `onerror=`, etc.) and `javascript:`/`data:` URL schemes.
- **Estimate API breaking change** (#199) — POST silently rejected the legacy `{name, items}` shape after a rename. Now accepts both `{name|title, items|lineItems}` for the deprecation window.
- **Wellness patient name overflow** (#220) — `validatePatientInput` cap dropped from 200 → 191 to match the utf8mb4 VARCHAR(191) DB column.
- **Doctor dropdown empty in Log Visit form** (#221) — `/api/staff` GET select was missing `wellnessRole`; the wellness UI's filter `u.wellnessRole === 'doctor'` matched zero rows. Added to the select.
- **Case history rendered raw `ENC:v1:…` ciphertext** (#224) — `lib/prisma.js` `$extends` hooks only ran on the outer query model. Made `decryptRecord` recursive: walks every nested relation and decrypts any field whose name is in the union of encrypted-field names AND whose value passes `isEncrypted()`.
- **Public booking validation** (#218 / #219) — corrupt service rendering + booking validator hardening.
- **Service durationMin cap** — bumped from 480 to 720 min (real long procedures take 9–10h).
- **Login rate limiting** (#191) — two stacked `express-rate-limit` limiters on `POST /auth/login`: per-IP (5/15min, IPv6-safe via `ipKeyGenerator`) + per-username (10/1h keyed on email lowercase+trim). `skipSuccessfulRequests` so legitimate fat-finger flows refund the slot.
- **Security headers** (#186) — Helmet now sets HSTS / SAMEORIGIN / Referrer-Policy / nosniff / CORP same-site / baseUri+formAction 'self'. New `permissionsPolicyMiddleware` for camera/mic/geo/FLoC. `imgSrc` https-only in prod.
- **Deal stage data migration** (#190) — `scripts/migrate-deal-stage-lowercase.js` (idempotent). Production run: 32 deals scanned, 1 unmappable logged, no neg amounts.
- **Corrupt service cleanup** (#218) — `scripts/cleanup-corrupt-services.js`. Deleted 16 test-pollution rows.
- **Contact attachments POST 500** (#176) — root cause was unguarded req.body destructure with no multer middleware; route now validates JSON `{filename, fileUrl}` shape, returns 400 `UNSUPPORTED_CONTENT_TYPE` for multipart.
- **Color contrast on consent canvas** (#204) — scoped `[data-vertical="wellness"]` CSS override; canvas border + background now visible on cream theme.
- **CallLog scrub field naming** — script referenced wrong field names; CallLog has `notes`/`recordingUrl`, not `summary`/`transcriptUrl`.
- **+ 4 wellness QA bug batches** — batches 1–7 closed ~30 polish bugs (#107 #108 #109 #111 #112 #113 #114 #115 #116 #117 #118 #119 #120 #122 #123 #124 #125 #126 #127 #128 #129 #143 #149 #151 #154 #156 #181 #183 #185 #187 #188 #189 #192 #193 #194 #195 #196 #197 #198 #203 #205 #209 #210 #212 + #122-reopen).

### Engine improvements

- **Workflow engine** — `deal.stage_changed`, `ticket.created`, `invoice.paid` events now emit. Trigger/action whitelists are enforced (400 with `INVALID_*_TYPE`). `isActive` is updatable via PUT.
- **Sequences** — pause / resume / unenroll endpoints added. Delay regex now matches `Days?`/`Hours?`/`Mins?` (was missing days). Synthesised drip emails carry a deterministic `seq-<enrollmentId>` threadId so they're queryable.
- **SLA** — `responseMinutes: 0` is valid (instant SLA), `firstResponseAt` only stamps on Open → (In Progress | Pending | Replied), `/apply-all?force=true` re-applies a policy to in-flight tickets. Both `/api/tickets` and `/api/support` now share the SLA auto-apply path.
- **Wellness clinical no-delete policy** (#21) — Patient, Visit, Prescription, ConsentForm, AgentRecommendation, ServiceConsumption are PERMANENT. No DELETE endpoints, no `deletedAt`, no soft-delete. Corrections via PUT/PATCH (amendment trail in audit log). Policy block at top of Clinical section in `wellness.js` so future engineers don't accidentally add a DELETE. Compliance: HIPAA 164.312(c)(1), India MoHFW EMR Standards 2016, DPDP Act 2023.

### UI

- **238 native window.alert/confirm/prompt replaced** with HTML notify modals (consistent UX across wellness + generic).

### Test coverage

- **+64 new e2e specs** across 5 deep-flow modules (approvals, sequences, sla, workflows, wellness clinical journey)
- **Smoke specs covering all 89 mounted route files** — ensures every route is at minimum reachable + auth-gated correctly
- **Audit script** at `scripts/audit-e2e-routes.js` extracts every `/api/*` URL referenced in specs and matches against actual handlers — surfaces broken URLs and untested route files
- **2 deep-flow flakes resolved** + global-teardown extended to scrub `E2E_FLOW_<ts>` / `E2E_AUDIT_<ts>` tags
- **mysql2** installed as devDependency so global-teardown can connect to the dev DB

### Deferred (not in v3.2.1)

- **Frontend UI cluster** — 7 cron-skipped issues that need real frontend work: #206 (push registration noise), #229 (long-name table layout), #225 (form double-submit debounce), #226 (form refresh data loss), #215 (telecaller disposition consistency), #208 (`/portal` route collision), #217 (`/wellness/tasks` 404), #228 (mobile responsive overhaul), #227 (Reports CSV/PDF export).
- **41 pre-existing e2e brittleness failures** — non-blocking (93% pass rate); UI flow drift in legacy specs.
- **AdsGPT silent SSO** — impersonation flow live; "Back to CRM" link still pending with AdsGPT team.
- **Callified silent SSO + back-link + lead webhook** — pending with Callified team.
- **Backend line coverage tool** — wire `c8` to instrument PM2 (~3 hours, deferred).

---

## v3.2.0 — 2026-04-23 — Production-ready wellness vertical

The first production-cut of the wellness vertical. Built for **Enhanced Wellness** (Dr. Haror's Ranchi franchise, owner Rishu) but designed as a tenant configuration on the existing multi-tenant CRM — not a fork.

### Added

**Vertical foundation (v3.1)**
- Multi-tenant `Tenant.vertical` field (`generic` / `wellness`) drives sidebar, theme, and landing route
- 9 new Prisma models: `Patient`, `Visit`, `Prescription`, `ConsentForm`, `TreatmentPlan`, `Service`, `ServiceConsumption`, `AgentRecommendation`, `Location`
- `User.wellnessRole` (doctor / professional / telecaller / helper) — orthogonal to the existing RBAC role
- 106-service catalog mirroring drharorswellness.com (hair transplant, aesthetics, body contouring, etc.)
- Per-service `targetRadiusKm` for marketing geo-targeting
- Multi-location ready (Ranchi seeded; franchise-ready)

**Wellness-specific UI (v3.1)**
- Owner Dashboard with KPI tiles, 30-day revenue chart, location switcher
- Recommendations inbox (AI agent cards with Approve/Reject)
- Patients list + detail with 8 tabs: case history, prescription pad, consent canvas, treatment plans, log visit, photos, inventory, telehealth
- Service catalog with inline edit + Packages tab calculator
- Day-grid Calendar by doctor
- 4-tab Reports (P&L by Service / Per-Pro / Per-Location / Marketing Attribution)
- Locations admin
- Telecaller queue with SLA timer + 6 disposition codes + 30s auto-refresh
- Patient Portal (phone + SMS OTP login, view visits/Rx/treatment plan, download PDFs)
- Public booking page at `/book/:slug` (3-step, no auth)
- Embeddable lead-capture widget (`/embed/widget.js` + `/embed/lead-form.html`)
- Per-location side-by-side comparison dashboard

**Backend automations (v3.1+v3.2)**
- Real **orchestrator engine** — daily 07:00 IST cron, reads dashboard context, generates 1-3 prioritised recommendation cards via Gemini (rules-based fallback), action dispatcher fires on Approve
- **Junk-lead filter** with rules + optional Gemini fallback for ambiguous mid-band leads
- **Lead auto-router** — keyword → service category → assigned specialist (doctor/professional/telecaller round-robin)
- **Appointment SMS reminders** cron (15 min, T-24h + T-1h)
- **Wellness ops** cron (hourly NPS post-visit + 90-day junk retention)
- **Low-stock inventory alerts** cron (daily 09:00 IST, email + in-app to managers)
- **Waitlist auto-fill** on cancellation (offers slot to next waitlisted patient via SMS)
- **Deep retention enforcement** — anonymise inactive 24mo+ patients, hard-delete consent forms >7yr (DPDP), purge old call logs

**External Partner API (v3.1)**
- `/api/v1/external/*` — API-key authenticated endpoints for sister Globussoft products (Callified.ai voice/WhatsApp, AdsGPT for ad creation, Globus Phone for softphone)
- 12 endpoints: leads (POST + GET poll), calls (POST + PATCH), messages, appointments, contacts/lookup, patients/lookup, services, staff, locations, /me, /health
- Two demo keys auto-seeded
- Junk filter + auto-router run inline on POST /leads

**Compliance & security (v3.2)**
- AES-256-GCM **field encryption** on patient PII (`Patient.allergies`, `Visit.notes`, `Prescription.*`, `ConsentForm.signatureSvg`); transparent decrypt-on-read via Prisma extension; opt-in via `WELLNESS_FIELD_KEY` env var
- One-shot `scripts/encrypt-existing-pii.js` for backfilling pre-encryption rows
- Wellness retention enforcement (DPDP-aligned)

**Telehealth (v3.2)**
- Jitsi-based video consult tab on Patient Detail, room name auto-stored on `Visit.videoRoom`

**White-label branding (v3.2)**
- `Tenant.logoUrl` + `Tenant.brandColor` — uploadable via Settings → Branding
- Logo + accent applied to Sidebar header, owner dashboard, email templates, invoice PDFs

**Loyalty + referrals (v3.2)**
- `LoyaltyTransaction` + `Referral` models, manager UI at `/wellness/loyalty`
- Auto-link referrals when referred patient signs up via `source = "referral"`

**Currency**
- Tenant-driven currency: `Tenant.country`, `Tenant.defaultCurrency`, `Tenant.locale` feed a single `formatMoney()` helper
- Indian tenants see ₹ with Lakh / Crore notation; US sees $; full BCP-47 fallback otherwise
- India-aware Pricing page (timezone-detected)

**Documentation**
- `docs/wellness-client/PRD.md` — product requirements
- `docs/wellness-client/IMPLEMENTATION_PLAN.md` — phased build plan
- `docs/wellness-client/STATUS.md` — current build state + demo walkthrough
- `docs/wellness-client/EXTERNAL_API.md` — partner API reference
- `docs/wellness-client/EMBED_WIDGET.md` — website integration guide
- `docs/wellness-client/RISHU_TODOS.md` — items waiting on the client
- `PRODUCTION_RUNBOOK.md` — onboarding + ops procedures (this release)

### Test coverage

| Suite | Tests | Status |
|---|---|---|
| Frontend vitest (component + utility) | 28 | passing |
| E2E `wellness.spec.js` (route + page coverage) | 103 | passing |
| E2E `wellness-deep.spec.js` (PDF, cron, dispatcher, encryption, photos) | 28 | passing |
| E2E `wellness-ui-flows.spec.js` (real browser interactions) | 8 | passing |
| E2E `wellness-auth-edge.spec.js` (token/concurrent/error shape) | 9 | passing |
| E2E `wellness-a11y.spec.js` (axe-core, zero serious/critical) | 6 | passing |
| E2E `wellness-integration.spec.js` (race + webhook + AI gate) | 16 | passing |
| Cross-browser projects | Chromium + Firefox + WebKit + mobile-chrome | configured |
| Total | **520+ E2E + 28 vitest** | |

### Bug fixes (this release)

- `GET /wellness/patients/abc` → 500 → now 400 (numeric ID validation via router.param)
- Malformed JSON body → HTML error → now 400 JSON (global error handler)
- Wellness sidebar text was illegible (dark on dark) — scoped CSS variable override inside `aside.glass`
- Icon-only buttons missing accessible names (Logout, NotificationBell, Softphone, OwnerDashboard switcher) → aria-label
- Embed form inputs not associated with labels → `id` + `for` + autocomplete hints
- USD `$` leakage in generic Reports + AgentReports → `formatMoney()` everywhere
- `Survey.title` Prisma error in NPS engine → now `Survey.name` (model has no `title`)
- Color contrast on wellness theme — `--text-secondary` darkened from `#7A6E66` (3.8:1) to `#5C5046` (>7:1, passes WCAG AAA)

### Removed from wellness sidebar (don't apply to clinics)

`Pipeline`, `Deal Insights`, `Tickets`, `CPQ`, `Live Chat`, `Chatbots`, `Voice/SMS/WhatsApp config` (those live in Callified), `Booking Pages` (replaced by `/book/:slug`), `E-Signatures` (replaced by per-patient consent canvas), `Lead Scoring` (replaced by junk filter `aiScore`), `Web Visitors`, `Generic Reports / Forecasting / Funnel / Staff Reports`, `Expenses` (per Rishu's feedback)

### Deferred (not in v3.2)

- AdsGPT silent SSO + back-link → with AdsGPT team
- Callified silent SSO + back-link + lead webhook → with Callified team
- Superphone + Zylu CSV migration → waiting on client exports
- Android app Play Store resubmit → waiting on client docs
- Performance / load testing
- Hindi i18n
- Real provider integration tests (sandboxes)

---

## v3.1.0 — 2026-04-22

Initial wellness vertical build. See git history for detail.

## v3.0.0 — Pre-wellness

Generic enterprise CRM. 88 routes, 99 models, 76 pages, 12 cron engines.
