# Test Coverage Gaps — Pickable Backlog

> **Audience:** any dev / agent who wants to grab a test gap and ship it.
> **Snapshot date:** 2026-05-02
> **Source of truth:** 160 spec files in [e2e/tests/](../e2e/tests/) + 22 vitest files in [backend/test/](../backend/test/) + 31-spec gate in [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).
> **Companions:** [TODOS.md](../TODOS.md) (already-triaged work), [regression-coverage-backlog.md](regression-coverage-backlog.md).

---

## How to pick a task

1. Scan the **Priority backlog** below and grab the first unblocked card you can complete in your time window.
2. Read the linked card — it has the spec name, files, pattern to copy, acceptance criteria.
3. Per [CLAUDE.md "Standing rules for new code"](../CLAUDE.md#standing-rules-for-new-code-do-not-skip-these): every new `*-api.spec.js` MUST be wired into BOTH `deploy.yml` AND `coverage.yml` spec lists. Every new `backend/lib|middleware|services` module needs a vitest under `backend/test/<area>/<module>.test.js`.
4. PR title format: `test(<area>): <short>` — e.g. `test(landing-pages): add CRUD + publish + duplicate api spec`.
5. Mark this card ✅ in this file (table + section header) when merged.

---

## Priority backlog (pick from top)

| ID | Title | Effort | Risk if skipped | Status |
|---|---|---|---|---|
| **G-1** | landing-pages-api spec (10 endpoints, zero coverage) | 4-6h | High — 311 lines untested in PRD-critical marketing flow | ✅ shipped (1e5bd3e — 41 tests) |
| **G-2** | workflows-api spec (9 endpoints, smoke-only) | 6-8h | High — automation engine route surface untested | ✅ shipped (21f8333 — 48 tests; flagged `/test` not a true dry-run) |
| **G-3** | integrations-api spec (6 endpoints + Callified SSO) | 4-6h | Med — admin-only but Callified.ai contract surface | ✅ shipped (47023a0 — 30 tests; flagged toggle missing admin guard) |
| **G-4** | search-api spec (1 endpoint, smoke-only) | 1-2h | Low — small route, but used by Omnibar | ✅ shipped (2f02cde — 14 tests) |
| **G-5** | audit-api spec (1 endpoint, smoke-only) | 2-3h | Med — compliance-relevant; tenant scoping must be proven | ✅ shipped (f5e9c7c — 20 tests; flagged audit.js missing role guard) |
| **G-6** | appointment-reminders-engine spec | 3-4h | High — wellness PRD-critical; SMS dispatch logic | ✅ shipped (cdbca1e — 16 tests; T-24h + T-1h windows, idempotency, cancellation exempt, RBAC) |
| **G-7** | wellness-ops-engine spec (NPS + retention) | 3-4h | High — GDPR retention path | ✅ shipped (853f41e — 13 tests; engine window `[now-14d, now-72h]`, NPS dedup via Survey row, junk retention is HARD-delete, tenant isolation, RBAC) |
| **G-8** | low-stock-engine spec | 2-3h | Med — inventory alerts | ✅ shipped (310296f — 12 tests; threshold semantics, idempotency, tenant isolation, RBAC) |
| **G-9** | recurring-invoice-engine spec | 4-6h | High — billing-critical, no trigger endpoint exists yet | ✅ shipped (902e439 — 13 tests; added `POST /api/billing/recurring/run` admin-gated trigger endpoint; surfaced #410 — engine-side `VOID` vs `VOIDED` mismatch) |
| **G-10** | scheduled-email-engine spec | 3-4h | Med — needs admin trigger endpoint | ✅ shipped (76b2416 — 12 tests; added `POST /api/email/scheduled/run`; pending → sent / pending → failed status machine) |
| **G-11** | retention-engine spec (GDPR daily 03:00) | 4-6h | High — compliance + destructive | ✅ shipped (cb96793 — 11 tests; added `POST /api/gdpr/retention/run` with `confirmDestructive:true` body guard + per-deletion AuditLog; surfaced #411 — engine misses AuditLog on no-op) |
| **G-12** | campaign-engine spec | 3-4h | Med | ✅ shipped (f681ff2 — 11 tests; added `POST /api/marketing/campaigns/run` admin-gated trigger; flagged 4 contract-drift findings, most notable: Campaign uses in-memory `global._campaignSchedules` map → backend restart wipes ALL pending schedules silently) |
| **G-13** | deal-insights-engine spec | 3-4h | Low — AI-generated content | ✅ shipped (14 tests; added `POST /api/deal-insights/run` admin-gated trigger; heuristic-only path, AI failure tolerated via existing `/generate/:dealId` try/catch around Gemini; surfaced orphan-row pollution in DealInsight — added Deal/DealInsight sweep to global-teardown.js) |
| **G-14** | forecast-snapshot-engine spec | 3-4h | Low — weekly cron | ✅ shipped (2d4372d — 18 tests; added `POST /api/forecasting/snapshot/run`; idempotent UPDATE-not-INSERT on `(tenantId, userId, period)`; tenant isolation hard-scoped at SQL layer) |
| **G-15** | backup-engine spec | 2-3h | Med — `mysqldump` exec; must verify no PII leaks in dump | ✅ shipped (14 tests; POST /api/admin/backup/run + /list + /file/:name; PII-safety assertion grades dump for plaintext PII against ENC:v1: ciphertext when WELLNESS_FIELD_KEY set; mysqldump-failure error contract; PATH + docker-exec invocation modes) |
| **G-16** | whatsappProvider vitest | 2-3h | Low — last service module without unit test | ✅ shipped (6871d8d — 23 tests, 100% coverage on whatsappProvider.js; `https.request` mock pattern from smsProvider.test.js) |
| **G-17** | wellness-dashboard-api spec (split from wellness.js) | 1-2 days | Med — wellness.js sits at 41% coverage; 4,050 lines | ✅ shipped (54b1ff1 — 40 tests; 5 endpoints (GET /dashboard + GET/PUT /recommendations + approve/reject); race-safe state machine + #325 vertical gate + #207/#216 wellnessRole gate + 30d revenueTrend shape; surfaced no contract drift in code) |
| **G-18** | wellness-reports-api spec (split from wellness.js) | 1 day | Med | ✅ shipped (561ab6b — 76 tests; 12 endpoints (4 JSON + 8 export); CSV BOM + PDF magic-bytes pinned; #233 attribution leak invariant locked) |
| **G-19** | wellness-telecaller-api spec (split from wellness.js) | 1 day | Med | ✅ shipped (09d7328 — 30 tests; queue + 6-disposition matrix; surfaced no contract drift in code; documented prompt drift (no SLA timer field, dispose route is /dispose with body contactId not /:id/dispose)) |
| **G-20** | tenant-isolation-api spec (cross-tenant data leak prevention) | 2-3 days | **Critical** — single highest-severity bug class for multi-tenant CRM | ✅ shipped (3 waves: a9154ac wave 1 / 8064fda wave 2 / f4b4ebe wave 3 — 29 resources / 93 cross-tenant assertions; new pattern: rename-on-cleanup `_teardown_<area>_<id>` for no-DELETE resources; surfaced #418 + #419 + #420 missing GET-by-id contracts; wellness FK chain Patient→Visit→Rx→Consent→TreatmentPlan covered) |
| **G-21** | Frontend vitest + RTL setup + first 5 component tests | 3-5 days | Med — 80 pages + 11 components have zero isolated tests | ⬜ open |
| **G-22** | Integration test tier (msw/nock) — Stripe webhook signing | 2 days | High — webhook forgery is a real attack | ✅ shipped (953cca5 — 11 tests; first integration tier file: msw + supertest; 7 webhook scenarios + 1 fail-closed bonus; singleton-patch pattern documented for future routes/ tests) |
| **G-23** | Migration safety check (dry-run prisma migrate in CI) | 1 day | High — NOT-NULL on populated table = prod outage | ✅ shipped (10 tests; .github/workflows/migration-check.yml + backend/scripts/check-migration-safety.js + 5 fixture pairs; 5 detectors: NOT_NULL_WITHOUT_DEFAULT / COLUMN_DROP / TYPE_NARROWING / UNIQUE_ADDITION / FK_WITHOUT_ON_DELETE; deploy.yml gains a 5th gate `migration_check`) |
| **G-24** | Schema invariants vitest (every multi-tenant model has tenantId) | 1 day | High — silent data leak risk | ✅ shipped (08b29fd — 6 tests; revert-and-prove verified; surfaced 49 models with `tenantId` but no formal `tenant Tenant @relation` + 21 `@@unique` constraints without explanatory comments + `MarketplaceLead.@@unique([provider, externalLeadId])` may prevent two tenants from importing the same provider lead) |
| **G-25** | Security headers spec against deployed demo | 4h | Low — Helmet/CSP regression detection | ✅ shipped (ef7b151 — 3 tests; snapshot-pins all 11 helmet headers, HSTS regex, x-powered-by absent, CSP-absent-by-design) |

**Recommended first parallel batch (5 disjoint, no rate-limit / external-service issues):** G-1, G-2, G-3, G-4, G-6.

> **Status update 2026-05-04 (v3.4.8):** **G-21 frontend vitest+RTL** remains the only open G-XX row. v3.4.8 added 4 more regression-guard specs outside the G-XX backlog: `wellness-read-audit-api` (T2.2 PHI read-audit, 8 tests), `auth-revocation-api` (#180 contract, 10 tests), `sequences-input-sanitization-api` (#398, 8 tests), `gdpr-dsar-export-api` (#443, 11 tests) — plus 3 owner-persona regression tests in the existing `tasks-api.spec.js` (#436) and 8 scrub-coverage invariants in `test-data-patterns.test.js` (v3.4.7 follow-up). Per-push gate is now **~75 specs / ~2,500 API tests + 39 vitest files / 1,101 unit tests = ~3,601 per-push** (+~46% since the v3.4.3 baseline below). Schema-invariants drift counter (G-24's pinned metric): 49 → 39 → 29 → 19 → **0** across batches 1+2+3+4 of #413 + the PlaybookProgress audit + the v3.4.8 cluster sweep. Issue #413 fully closed. **Next pickup**: G-21 frontend vitest+RTL is the only remaining G-row (3-5 days, multi-day project — needs library/runner-config decisions; not parallel-agent dispatchable). The long tail moves to bug-driven work via TODOS.md (#167 hard-DELETE audit is the largest remaining; T2.2 + #180 + #398 + #413 + #436 + #443 all closed in v3.4.8).
>
> **Earlier status update 2026-05-04 (v3.4.7):** Only G-21 remained open from G-1..G-25. v3.4.7 added 4 regression-guard test files (`security-token-storage`, `scrubResponse`, `sensitive-field-leak-api`, `tenant-header-ignored-api`, `test-data-patterns`) outside the G-XX backlog. Per-push gate was 71 specs / 2,460 API tests + 39 vitest / 1,093 unit = 3,553 per-push.
>
> **Earlier status update 2026-05-03 (v3.4.3):** 17 gate specs shipped — G-1..G-16 + G-24 + G-25. Per-push gate was 50 specs / ~1,665 API tests + 30 vitest files / 803 unit tests = ~2,468 per-push. Four admin-gated cron-trigger endpoints added. Six compliance items closed (#408 / #409 / #410 / #411 + new `confirmDestructive` guard). Bonus infra fix: `vitest.config.js` `cron/` `deps.inline` gap unblocked ALL cron-engine unit tests.

---

# Part 1 — Route gaps (G-1 through G-5)

Each card below targets a route with zero or smoke-only coverage. **Pattern to copy: [e2e/tests/notifications-api.spec.js](../e2e/tests/notifications-api.spec.js)** (549 lines — clean CRUD + auth gate + tenant scoping).

## ⬜ G-1 — landing-pages-api spec

**File to create:** `e2e/tests/landing-pages-api.spec.js`
**Target route:** [backend/routes/landing_pages.js](../backend/routes/landing_pages.js) (311 lines, **zero** API coverage today)

**Endpoints to cover:**
- `GET /api/landing-pages/` — list
- `GET /api/landing-pages/templates/list` — template catalog
- `GET /api/landing-pages/:id` — read
- `POST /api/landing-pages/` — create
- `PUT /api/landing-pages/:id` — update
- `DELETE /api/landing-pages/:id` — delete
- `POST /api/landing-pages/:id/publish`
- `POST /api/landing-pages/:id/unpublish`
- `POST /api/landing-pages/:id/duplicate`
- `GET /api/landing-pages/:id/analytics`

**Acceptance criteria:**
- [ ] Each endpoint: happy path + 401 (no token) + 400 (bad input where applicable) + 404 (missing id)
- [ ] Tenant isolation: tenant A cannot read/update/delete tenant B's landing page
- [ ] Publish/unpublish state-machine: cannot publish twice, cannot unpublish unpublished
- [ ] Duplicate creates a new row with `publishedAt = null` and a unique slug
- [ ] Wired into `.github/workflows/deploy.yml` AND `.github/workflows/coverage.yml` spec lists

**Pattern:** notifications-api.spec.js
**Effort:** 4-6h
**Blockers:** none

---

## ⬜ G-2 — workflows-api spec

**File to create:** `e2e/tests/workflows-api.spec.js`
**Target route:** [backend/routes/workflows.js](../backend/routes/workflows.js) (314 lines, smoke-only)
**Note:** [workflows-flow.spec.js](../e2e/tests/workflows-flow.spec.js) covers engine execution; this spec covers route CRUD which it does NOT.

**Endpoints to cover:**
- `GET /api/workflows/triggers` — static catalog
- `GET /api/workflows/actions` — static catalog
- `GET /api/workflows/history` — execution history
- `GET /api/workflows/` — list
- `POST /api/workflows/` — create
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `PUT /api/workflows/:id/toggle` — enable/disable
- `POST /api/workflows/:id/test` — dry-run

**Acceptance criteria:**
- [ ] Trigger/action catalogs return non-empty arrays with expected shape
- [ ] CRUD round-trip + tenant isolation
- [ ] Toggle flips `enabled` field idempotently
- [ ] `/test` does NOT mutate target records (dry-run contract)
- [ ] Wired into both CI workflow spec lists

**Effort:** 6-8h
**Blockers:** none

---

## ⬜ G-3 — integrations-api spec

**File to create:** `e2e/tests/integrations-api.spec.js`
**Target route:** [backend/routes/integrations.js](../backend/routes/integrations.js) (193 lines, smoke-only)

**Endpoints to cover:**
- `GET /api/integrations/` — list available
- `POST /api/integrations/connect` — ADMIN-only
- `POST /api/integrations/disconnect` — ADMIN-only
- `POST /api/integrations/toggle`
- `GET /api/integrations/callified/auth-url` — Callified.ai OAuth start
- `GET /api/integrations/callified/sso` — Callified.ai SSO callback

**Acceptance criteria:**
- [ ] RBAC: USER role gets 403 on `/connect` and `/disconnect`
- [ ] Callified auth-url returns a valid URL with required query params
- [ ] Callified SSO with bad signature returns 401/403 (do not call live OAuth — assert validation only)
- [ ] Tenant isolation on toggle
- [ ] Wired into both CI workflow spec lists

**Effort:** 4-6h
**Blockers:** none — keep external Callified calls stubbed/skipped

---

## ⬜ G-4 — search-api spec

**File to create:** `e2e/tests/search-api.spec.js`
**Target route:** [backend/routes/search.js](../backend/routes/search.js) (65 lines, smoke-only)

**Endpoints to cover:**
- `GET /api/search?q=<term>&type=<contacts|deals|leads|all>` — global search

**Acceptance criteria:**
- [ ] Empty `q` returns 400
- [ ] Returns shape `{ contacts: [], deals: [], leads: [], … }` per `type`
- [ ] Cross-tenant: tenant A searching "shared" term gets only tenant A results
- [ ] Long `q` (>500 chars) handled (truncate or reject)
- [ ] SQL-injection probe (`' OR 1=1 --`) does not leak rows
- [ ] Wired into both CI workflow spec lists

**Effort:** 1-2h
**Blockers:** none

---

## ⬜ G-5 — audit-api spec

**File to create:** `e2e/tests/audit-api.spec.js`
**Target route:** [backend/routes/audit.js](../backend/routes/audit.js) (28 lines, smoke-only)
**Note:** [audit-log.spec.js](../e2e/tests/audit-log.spec.js) is UI-driven and does not cover the API contract.

**Endpoints to cover:**
- `GET /api/audit/` — list (paginated)

**Acceptance criteria:**
- [ ] Tenant isolation: tenant A cannot see tenant B's audit rows
- [ ] RBAC: non-ADMIN gets 403 (verify against current behavior)
- [ ] Pagination params (`page`, `limit`) honored
- [ ] Filter params (action, userId, dateRange) honored
- [ ] Records have expected fields (`actorId`, `action`, `entityType`, `entityId`, `tenantId`, `createdAt`)
- [ ] Wired into both CI workflow spec lists

**Effort:** 2-3h
**Blockers:** none — but if D2 in TODOS.md (audit middleware build-out) lands first, expand scope to cover the new write paths

---

# Part 2 — Cron engine gaps (G-6 through G-15)

**Pattern to copy: [e2e/tests/sla-breach-api.spec.js](../e2e/tests/sla-breach-api.spec.js) + [sequence-engine-api.spec.js](../e2e/tests/sequence-engine-api.spec.js)** — both seed fixtures, invoke trigger endpoint, assert side effects.

## ⬜ G-6 — appointment-reminders-engine spec

**File to create:** `e2e/tests/appointment-reminders-api.spec.js`
**Target:** [backend/cron/appointmentRemindersEngine.js](../backend/cron/appointmentRemindersEngine.js)
**Trigger endpoint exists:** `POST /api/wellness/reminders/run` ([backend/routes/wellness.js:1698](../backend/routes/wellness.js#L1698))

**Acceptance criteria:**
- [ ] Seed a Visit at T-24h ± window → trigger → SMS queued for that visit
- [ ] Seed a Visit at T-1h ± window → trigger → second SMS queued
- [ ] Seed a Visit far outside window → trigger → no SMS queued
- [ ] Idempotency: trigger twice for same visit → only one SMS per window
- [ ] RBAC: USER role gets 403 (`verifyWellnessRole(['admin','manager'])`)
- [ ] Cancelled visits get no reminders
- [ ] Wired into both CI workflow spec lists

**Effort:** 3-4h
**Blockers:** none — trigger endpoint already in place

---

## ⬜ G-7 — wellness-ops-engine spec

**File to create:** `e2e/tests/wellness-ops-api.spec.js`
**Target:** [backend/cron/wellnessOpsEngine.js](../backend/cron/wellnessOpsEngine.js)
**Trigger endpoint exists:** `POST /api/wellness/ops/run` ([backend/routes/wellness.js:1713](../backend/routes/wellness.js#L1713))

**Acceptance criteria:**
- [ ] Visit completed 72h ago → NPS survey SMS queued; returns `npsSent: 1`
- [ ] Visit completed 24h ago → no NPS yet
- [ ] Junk lead aged 90 days → `purged: 1`; record gone from DB
- [ ] Junk lead aged 30 days → still present
- [ ] Idempotency: re-trigger does not double-send NPS or re-purge
- [ ] Wired into both CI workflow spec lists

**Effort:** 3-4h
**Blockers:** none

---

## ⬜ G-8 — low-stock-engine spec

**File to create:** `e2e/tests/low-stock-api.spec.js`
**Target:** [backend/cron/lowStockEngine.js](../backend/cron/lowStockEngine.js)
**Trigger endpoint exists:** `POST /api/wellness/inventory/low-stock/run` ([backend/routes/wellness.js:1728](../backend/routes/wellness.js#L1728))

**Acceptance criteria:**
- [ ] Product below threshold → notification + email queued
- [ ] Product above threshold → no notification
- [ ] Returns `{ products, notifications, emails }` shape
- [ ] Tenant isolation
- [ ] Wired into both CI workflow spec lists

**Effort:** 2-3h
**Blockers:** none

---

## ⬜ G-9 — recurring-invoice-engine spec

**File to create:** `e2e/tests/recurring-invoice-api.spec.js`
**Target:** [backend/cron/recurringInvoiceEngine.js](../backend/cron/recurringInvoiceEngine.js)
**Trigger endpoint:** **DOES NOT EXIST** — must add `POST /api/billing/recurring/run` (ADMIN-gated) before writing spec

**Acceptance criteria:**
- [ ] Recurring invoice with `nextRunAt <= now` → new Invoice row created
- [ ] Recurring invoice with `nextRunAt > now` → no new invoice
- [ ] `nextRunAt` advances by interval after run
- [ ] Idempotency: re-trigger same minute → no duplicate invoice
- [ ] Tenant isolation
- [ ] Wired into both CI workflow spec lists

**Effort:** 4-6h (includes adding trigger endpoint)
**Blockers:** sequence with adding trigger endpoint to billing.js

---

## ⬜ G-10 — scheduled-email-engine spec

**File to create:** `e2e/tests/scheduled-email-api.spec.js`
**Target:** [backend/cron/scheduledEmailEngine.js](../backend/cron/scheduledEmailEngine.js)
**Trigger endpoint:** **DOES NOT EXIST** — add `POST /api/email/scheduled/run` (ADMIN)

**Acceptance criteria:**
- [ ] ScheduledEmail with `sendAt <= now` and status `pending` → moved to `sent`, EmailMessage row created
- [ ] ScheduledEmail with `sendAt > now` → unchanged
- [ ] Failed send (mock provider 500) → status `failed` with retry count
- [ ] Tenant isolation
- [ ] Wired into both CI workflow spec lists

**Effort:** 3-4h
**Blockers:** add trigger endpoint

---

## ⬜ G-11 — retention-engine spec

**File to create:** `e2e/tests/retention-api.spec.js`
**Target:** [backend/cron/retentionEngine.js](../backend/cron/retentionEngine.js) — **GDPR-critical, destructive**
**Trigger endpoint:** **DOES NOT EXIST** — add `POST /api/gdpr/retention/run` (ADMIN-only, body must include `confirmDestructive: true`)

**Acceptance criteria:**
- [ ] Records past retention policy → soft-deleted or hard-deleted per policy
- [ ] Records inside retention window → untouched
- [ ] Audit log row written for every deletion
- [ ] RBAC: non-ADMIN gets 403
- [ ] Missing `confirmDestructive` returns 400
- [ ] Tenant isolation: tenant A run does not touch tenant B
- [ ] Wired into both CI workflow spec lists

**Effort:** 4-6h
**Blockers:** add trigger endpoint with hard guards

---

## ⬜ G-12 — campaign-engine spec

**File to create:** `e2e/tests/campaign-engine-api.spec.js`
**Target:** [backend/cron/campaignEngine.js](../backend/cron/campaignEngine.js)
**Trigger endpoint:** check for one in [routes/marketing.js](../backend/routes/marketing.js) or add `POST /api/marketing/campaigns/:id/run`

**Acceptance criteria:**
- [ ] Scheduled campaign past `sendAt` → dispatched (recipients enqueued)
- [ ] Future campaign → untouched
- [ ] Already-sent campaign → not re-sent
- [ ] Tenant isolation
- [ ] Wired into both CI workflow spec lists

**Effort:** 3-4h
**Blockers:** check/add trigger endpoint

---

## ⬜ G-13 — deal-insights-engine spec

**File to create:** `e2e/tests/deal-insights-engine-api.spec.js`
**Target:** [backend/cron/dealInsightsEngine.js](../backend/cron/dealInsightsEngine.js) (Gemini AI)
**Trigger endpoint:** check for one in [routes/deal_insights.js](../backend/routes/deal_insights.js)

**Acceptance criteria:**
- [ ] Deal lacking insights → DealInsight row created (mock Gemini response)
- [ ] Deal with recent insight (<6h) → not regenerated
- [ ] Tenant isolation
- [ ] AI failure (mock 500) → engine continues, logs error, does not crash
- [ ] Wired into both CI workflow spec lists

**Effort:** 3-4h
**Blockers:** Gemini mocking — use the pattern from `routes/ai.js` if it exists

---

## ⬜ G-14 — forecast-snapshot-engine spec

**File to create:** `e2e/tests/forecast-snapshot-api.spec.js`
**Target:** [backend/cron/forecastSnapshotEngine.js](../backend/cron/forecastSnapshotEngine.js)
**Trigger endpoint:** check/add in [routes/forecasting.js](../backend/routes/forecasting.js)

**Acceptance criteria:**
- [ ] Run creates a Forecast row with current pipeline aggregates
- [ ] Snapshot dated correctly (week start)
- [ ] Tenant isolation
- [ ] Wired into both CI workflow spec lists

**Effort:** 3-4h
**Blockers:** add trigger endpoint

---

## ⬜ G-15 — backup-engine spec

**File to create:** `e2e/tests/backup-engine-api.spec.js`
**Target:** [backend/cron/backupEngine.js](../backend/cron/backupEngine.js) — shells `mysqldump`
**Trigger endpoint:** **DOES NOT EXIST** — add `POST /api/admin/backup/run` (ADMIN)

**Acceptance criteria:**
- [ ] Run produces a `.sql.gz` file in `BACKUP_DIR`
- [ ] File size > 1KB (sanity)
- [ ] File contains expected tenant data on grep (assert *roundtrip readable*, not contents)
- [ ] RBAC: non-ADMIN gets 403
- [ ] Wired into both CI workflow spec lists
- [ ] PII safety: assert no plaintext encrypted-field columns leak (cross-check with `lib/fieldEncryption.js`)

**Effort:** 2-3h
**Blockers:** add trigger endpoint; ensure CI runner has `mysqldump` binary (it does — MySQL container)

---

# Part 3 — Vitest unit gaps (G-16)

## ⬜ G-16 — whatsappProvider vitest

**File to create:** `backend/test/services/whatsappProvider.test.js`
**Target:** [backend/services/whatsappProvider.js](../backend/services/whatsappProvider.js)
**Pattern:** [backend/test/services/smsProvider.test.js](../backend/test/services/smsProvider.test.js)

**Acceptance criteria:**
- [ ] `sendMessage()` happy path with mocked WhatsApp Cloud API fetch
- [ ] Error response → returns structured error, does not throw
- [ ] Template message vs free-form text branches
- [ ] Missing config (no `WHATSAPP_API_KEY`) → graceful no-op return
- [ ] Coverage ≥ 80% on the file

**Effort:** 2-3h
**Blockers:** none

---

# Part 4 — Wellness route split (G-17 through G-19)

[backend/routes/wellness.js](../backend/routes/wellness.js) is 4,050 lines at 41% coverage. [wellness-clinical-api.spec.js](../e2e/tests/wellness-clinical-api.spec.js) covers patient/visit/Rx/consent/service/location. The remaining surface needs three new specs.

## ⬜ G-17 — wellness-dashboard-api spec

**File to create:** `e2e/tests/wellness-dashboard-api.spec.js`
**Endpoints:** `GET /api/wellness/dashboard`, owner-dashboard recommendations CRUD, `GET /api/wellness/recommendations*`

**Effort:** 1-2 days
**Blockers:** none

## ⬜ G-18 — wellness-reports-api spec

**File to create:** `e2e/tests/wellness-reports-api.spec.js`
**Endpoints:** `GET /api/wellness/reports/pnl-by-service`, `/per-professional`, `/per-location`, `/attribution`

**Effort:** 1 day

## ⬜ G-19 — wellness-telecaller-api spec

**File to create:** `e2e/tests/wellness-telecaller-api.spec.js`
**Endpoints:** `GET /api/wellness/telecaller/queue`, `POST /api/wellness/telecaller/:id/dispose` (6 dispositions)

**Effort:** 1 day

---

# Part 5 — High-severity multi-tenant + safety gaps (G-20, G-23, G-24)

## ⬜ G-20 — tenant-isolation-api spec ⭐ **CRITICAL**

**File to create:** `e2e/tests/tenant-isolation-api.spec.js`
**Why:** Single highest-severity bug class for a multi-tenant CRM. Today only `wellness-rbac-api.spec.js` covers wellness; generic CRM has no systematic cross-tenant assertion.

**Acceptance criteria:**
- [ ] Seed two tenants A and B with overlapping resource types (Contact, Deal, Lead, Pipeline, Invoice, Workflow, Patient, Visit)
- [ ] As tenant A user, attempt READ on every tenant B resource ID — expect 404 (not 403, to avoid id enumeration)
- [ ] As tenant A user, attempt UPDATE on every tenant B resource ID — expect 404
- [ ] As tenant A user, attempt DELETE on every tenant B resource ID — expect 404
- [ ] As tenant A user, LIST endpoints return only tenant A rows (assert no tenant B id in results)
- [ ] Spec must iterate every multi-tenant route (data-driven)
- [ ] Wired into both CI workflow spec lists

**Effort:** 2-3 days
**Blockers:** none — pure additive

---

## ✅ G-23 — Migration safety check

**File to create:** `.github/workflows/migration-safety.yml` + `backend/scripts/check-migration.js`
**Why:** `prisma migrate deploy` runs in deploy.yml without dry-run validation. NOT-NULL on a populated table or a missing rollback = guaranteed prod outage.

**Acceptance criteria:**
- [ ] On PR, diff `prisma/migrations/` for new migrations
- [ ] Reject if a migration adds NOT NULL without DEFAULT to an existing table
- [ ] Reject if a migration drops a column without an explicit `// allow-drop: <reason>` comment
- [ ] Reject if a migration does `ALTER TYPE` on an enum (downstream breakage)
- [ ] Run `prisma migrate diff` against a fresh DB; assert idempotent

**Effort:** 1 day
**Blockers:** none

---

## ⬜ G-24 — Schema invariants vitest

**File to create:** `backend/test/schema/invariants.test.js`
**Why:** 114 Prisma models. No test asserts that every multi-tenant model has `tenantId`. A missing `tenantId` on one new model = silent cross-tenant data leak.

**Acceptance criteria:**
- [ ] Parse `prisma/schema.prisma` (use `@prisma/internals` or simple regex)
- [ ] For every model on the **multi-tenant allowlist** (Contact, Deal, …), assert `tenantId String` field exists
- [ ] For every model with `tenantId`, assert there's an index `@@index([tenantId])`
- [ ] For every relation, assert `onDelete` rule is set (no implicit Restrict)
- [ ] Allowlist of single-tenant / system models (Tenant, User, Currency, IndustryTemplate) explicitly named — adding a new model forces a deliberate decision

**Effort:** 1 day
**Blockers:** none

---

# Part 6 — Frontend + integration tier (G-21, G-22, G-25)

## ⬜ G-21 — Frontend vitest + RTL setup

**Files to create:** `frontend/vitest.config.js`, `frontend/test/setup.js`, first 5 component tests under `frontend/src/components/__tests__/`

**Acceptance criteria:**
- [ ] vitest + jsdom + @testing-library/react + @testing-library/user-event installed
- [ ] msw installed for API mocking
- [ ] First 5 component tests: `NotificationBell`, `Sidebar`, `Layout`, `DealModal`, `CommandPalette`
- [ ] CI gate: new `frontend_unit_tests` job in deploy.yml
- [ ] Coverage ≥ 70% on the 5 tested components

**Effort:** 3-5 days
**Blockers:** none

---

## ⬜ G-22 — Integration test tier (Stripe webhook signing)

**Files to create:** `backend/test/integration/`, `backend/test/integration/stripe-webhook.test.js`

**Acceptance criteria:**
- [ ] msw or nock set up for HTTP-level mocks
- [ ] Valid Stripe-Signature header → 200, idempotent on replay (same `Stripe-Signature` + body)
- [ ] Invalid signature → 400, no DB mutation
- [ ] Missing `Idempotency-Key` (per Stripe convention) → handled
- [ ] CI gate: new `integration_tests` job alongside `unit_tests`

**Effort:** 2 days
**Blockers:** none — first user of the new tier

---

## ⬜ G-25 — Security headers spec

**File to create:** `e2e/tests/security-headers.spec.js`

**Acceptance criteria:**
- [ ] `GET /` returns `Content-Security-Policy`, `X-Frame-Options`, `Strict-Transport-Security`, `X-Content-Type-Options`
- [ ] `GET /api/health` returns the same headers
- [ ] No `Server: Express` header leak
- [ ] Wired into both CI workflow spec lists

**Effort:** 4h
**Blockers:** none

---

# Part 7 — Test types we should adopt (longer-term backlog)

Beyond the cards above, the following test layers are missing or thin. Each is a future-quarter conversation, not a same-week pickup. Listed for visibility.

| # | Test type | Status | Why it matters | First move |
|---|---|---|---|---|
| L-1 | **Frontend RTL** | ❌ none | 80 pages + 11 components untested in isolation | G-21 |
| L-2 | **Integration (msw / nock)** | ❌ none | External-service success branches uncovered | G-22 |
| L-3 | **OpenAPI / contract tests** | ⚠️ none enforced | Swagger spec drifts from routes silently | CI-7 in TODOS.md |
| L-4 | **Accessibility (axe-core)** | ⚠️ wellness only | Generic CRM 50+ pages unaudited | Add `@axe-core/playwright` to a smoke set |
| L-5 | **Visual regression** | ❌ none | Glassmorphism + theme cascade fragile | Playwright `toHaveScreenshot` baselines |
| L-6 | **Performance / load** | ❌ none | No k6 / artillery / autocannon | Nightly k6 against demo |
| L-7 | **Lighthouse / Web Vitals** | ❌ none | Core Web Vitals untracked | CI-9 in TODOS.md |
| L-8 | **SAST (CodeQL)** | ⚠️ partial — gitleaks + npm audit only | No semantic security scan | Enable GitHub native CodeQL workflow |
| L-9 | **Mutation testing (Stryker)** | ❌ none | False-confidence on 79% line coverage | CI-11 in TODOS.md |
| L-10 | **Schema invariants** | ❌ none | Silent multi-tenant leak risk | G-24 |
| L-11 | **Property-based / fuzz** | ❌ none | Validators are great fast-check targets | Add fast-check to `utils/deduplication.js` |
| L-12 | **Smoke tests post-deploy** | ✅ partial | Only `/api/health` polled | Extend to login → dashboard → list contacts |
| L-13 | **Bundle size budgets** | ❌ none | Bundle bloat invisible | CI-6 in TODOS.md |
| L-14 | **Cross-browser** | ⚠️ chromium-only | Safari/Firefox bugs invisible | Add Firefox + WebKit projects to e2e-full |
| L-15 | **Mobile / responsive** | ❌ none | T2.1 in TODOS.md acknowledges < 900px broken | Build out `responsive.spec.js` matrix |
| L-16 | **Multi-tenant isolation** | ⚠️ wellness only | Highest-severity bug class | G-20 |
| L-17 | **Rate-limit & abuse** | ⚠️ login only | sendLimiter + general 5000/15min untested | `rate-limit-api.spec.js` |
| L-18 | **CSRF / clickjacking / headers** | ⚠️ unit-only | Deployed app headers untested | G-25 |
| L-19 | **Webhook signature verification** | ❌ none | Forgery is a real attack | G-22 (Stripe), then Razorpay + marketplace-leads |
| L-20 | **Chaos / failure injection** | ❌ none | No DB-down / 503 / SIGSTOP tests | Defer until SLO targets exist |
| L-21 | **Localization / i18n** | ❌ none | LanguageSwitcher exists, no per-locale spec | `i18n.spec.js` per locale |
| L-22 | **PII / encryption-at-rest** | ⚠️ partial | `wellness-phi-audit.spec.js` covers some | Backup-roundtrip test (G-15) |
| L-23 | **Backup restore drill** | ❌ none | Backups are written, never restored | Manual quarterly drill + runbook |
| L-24 | **DB migration safety** | ❌ none | NOT-NULL on populated table = outage | G-23 |
| L-25 | **Dependency vulnerability** | ✅ done | Dependabot weekly + npm audit gate | — |

## Top-3 to invest in this quarter (by bug-class severity)

1. **G-22 Integration tier (msw / nock)** — closes the largest correctness gap (external service success branches: Stripe/Razorpay webhooks, OAuth callbacks, Mailgun, web-push)
2. **G-20 Multi-tenant isolation suite** — single highest-severity bug class for a multi-tenant CRM (data leak between tenants)
3. **G-23 Migration safety check** — single highest-severity deploy-time bug class (NOT-NULL on populated table = prod outage)

Visual regression / Lighthouse / cross-browser are nice-to-have but won't catch correctness bugs.

---

# Maintenance

When a card ships:
1. Replace ⬜ with ✅ in both the priority backlog table AND the section header
2. Add the spec name + line count under the relevant section in [CLAUDE.md](../CLAUDE.md)
3. If you added a trigger endpoint to ship a cron-engine card, document it under Cron Engines in [CLAUDE.md](../CLAUDE.md)
4. Reflow the priority backlog if a card's effort/risk estimate proves wrong

When a new route or cron engine ships:
- Add a new card here in the same format BEFORE the route/engine merges (per CLAUDE.md "Standing rules")
