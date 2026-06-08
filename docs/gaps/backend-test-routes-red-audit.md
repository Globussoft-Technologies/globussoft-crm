# Backend `test/routes/` red audit — 2026-06-08

> Scoping audit for **PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §10 row T27**. T24 agent surfaced "31 pre-existing red files in `backend/test/routes/`" during their smoke-pass. This doc enumerates each red file with a failure-class classification + fix-cost estimate so subsequent cron sub-slices (T28+) can pick failure-class-grouped batches.
>
> **Raw vitest output captured at:** [`docs/gaps/backend-test-routes-red-raw-2026-06-08.txt`](backend-test-routes-red-raw-2026-06-08.txt) — 4032 lines, 6340 tests total, 24 failed (against 31 failed files due to file-collection failures counting as 0-test fails).

---

## Headline finding — 20 of 31 reds are a local-env artifact, not a CI red

The T24 flag "31 pre-existing red files" was captured on a local dev box (Windows, MSYS bash + Node 24). The vast majority (20 of 31) of the reds fall into a **single class** — `Cannot find module '@aws-sdk/client-s3'` — which is a local-only `npm install` lag, NOT a CI red. The `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` packages are declared in `backend/package.json` (commit `eba590b8` 2026-05-20, "Implemented the product and product categories #821"), and CI's `unit_tests` gate runs `npm ci --no-audit --no-fund` BEFORE invoking vitest, so the dep is always installed there. Recent CI runs against `main` HEAD `164305af`, `3ea648f7`, `6a034ebb` all completed successfully — proving the AWS-SDK class is green on CI.

**Real CI-red surface:** 11 files (out of the 31 originally flagged). All 11 share the same underlying pattern as T24's fix — missing Prisma mocks on cross-cutting middleware / library code paths added after the test file was first written.

---

## Summary

- **Total red files (local dev box):** 31 / 369 `backend/test/routes/*.test.js` files
- **Total CI-red files (actual T27 sweep target):** 11 / 369
- **By failure class:**

| Class | Description | Files | Est. fix cost | CI-red? |
|-------|-------------|-------|---------------|---------|
| **A** | Missing dependency — `@aws-sdk/client-s3` not in local `node_modules` | 20 | ~30s (one `npm install` in `backend/`) | NO — passes on CI |
| **B1** | Missing mock — `prisma.userRole.findMany` (requirePermission middleware) | 7 | ~20 min/file × 7 = ~2.5h | YES |
| **B2** | Missing mock — `prisma.tenant.findUnique` (vertical resolver in staff routes) | 1 | ~20 min | YES |
| **B3** | Missing mock — `prisma.webhook.findMany` (webhookDelivery via emitEvent on contact.created) | 1 | ~30 min (+1 assertion fix on dedup case) | YES |
| **B4** | Missing mock — `prisma.travelPaymentSchedule.findFirst`/`findMany` (auto-schedule on invoice issue) | 1 | ~45 min (6 cases × 5-min each, share fixture) | YES |
| **B5** | Mixed B1 + B2 — `search.test.js` exercises both surfaces | 1 | ~30 min | YES |

- **Total estimated CI sweep cost:** ~4-5 hours of focused work across the 11 CI-red files (single agent) — or 2 parallel agents finishing in ~2.5h since the classes are file-disjoint.
- **Total estimated local cleanup cost:** ~30 seconds (`cd backend && npm install`).

---

## Class A — `Cannot find module '@aws-sdk/client-s3'` (20 files, local-only)

**Root cause:** `backend/services/s3Service.js:24` does `require("@aws-sdk/client-s3")`. The package is declared in `backend/package.json` (added in commit `eba590b8` 2026-05-20) but `backend/node_modules/@aws-sdk/` does not exist on this dev box. Every test that transitively imports a route that imports `s3Service.js` fails at test-collection time with `0 test` and an import error.

**Fix:** `cd backend && npm install` once. No code changes needed.

**Why CI is green:** `.github/workflows/deploy.yml` `unit_tests` gate runs `npm ci --no-audit --no-fund` before vitest, so the dep is always present on CI runners. Confirmed against recent successful runs.

**Files affected (20):**

| # | File | Notes |
|---|---|---|
| 1 | `backend/test/routes/auth-cookie-set.test.js` | Imports `routes/auth.js` → `services/s3Service.js` |
| 2 | `backend/test/routes/auth-profile-picture.test.js` | Imports `services/s3Service.js` directly |
| 3 | `backend/test/routes/auth.test.js` | Imports `routes/auth.js` → `services/s3Service.js` |
| 4 | `backend/test/routes/consent-templates.test.js` | Transitive via wellness route stack |
| 5 | `backend/test/routes/inventory-stats.test.js` | Transitive via wellness route stack |
| 6 | `backend/test/routes/inventory.test.js` | Transitive via wellness route stack |
| 7 | `backend/test/routes/wave6a-event-emissions.test.js` | Transitive via wellness route stack |
| 8 | `backend/test/routes/wellness-branding-logo.test.js` | Transitive via wellness route stack |
| 9 | `backend/test/routes/wellness-locations-delete.test.js` | Transitive via wellness route stack |
| 10 | `backend/test/routes/wellness-loyalty-rules.test.js` | Transitive via wellness route stack |
| 11 | `backend/test/routes/wellness-patient-anniversary-gst.test.js` | Transitive via wellness route stack |
| 12 | `backend/test/routes/wellness-patient-timeline-csv.test.js` | Transitive via wellness route stack |
| 13 | `backend/test/routes/wellness-patient-timeline.test.js` | Transitive via wellness route stack |
| 14 | `backend/test/routes/wellness-patients-bulk-tags.test.js` | Transitive via wellness route stack |
| 15 | `backend/test/routes/wellness-patients-filters.test.js` | Transitive via wellness route stack |
| 16 | `backend/test/routes/wellness-patients-import-template.test.js` | Transitive via wellness route stack |
| 17 | `backend/test/routes/wellness-patients-import.test.js` | Transitive via wellness route stack |
| 18 | `backend/test/routes/wellness-patients-xlsx.test.js` | Transitive via wellness route stack |
| 19 | `backend/test/routes/wellness-pnl-canonical.test.js` | Transitive via wellness route stack |
| 20 | `backend/test/routes/wellness-portal-customer-jwt.test.js` | Transitive via wellness route stack |

---

## Class B — Missing-mock failures (11 files, CI-red)

All 11 files share the same pattern as T24's fix shipped at commit `8a4fe00b`: the route was extended to call a new Prisma surface, but the test's mock object never grew to cover it. Vitest's `vi.mock('../../lib/prisma', ...)` returns a partial mock; the unmocked call falls through to the real Prisma client which tries to connect to the demo MySQL at `163.227.174.141:3306` and hangs until the 5s testTimeout fires. Same shape as T24, same fix recipe — add the missing surface to the prisma mock + a `mockReset().mockResolvedValue([])` (or similar) in `beforeEach`.

### Class B1 — `prisma.userRole.findMany` (requirePermission middleware) — 7 files

**Root cause:** `backend/middleware/requirePermission.js:178` queries `userRole.findMany` to resolve the caller's effective roles for permission checks. The middleware was added (or extended) after the POS + drug + pos-sale test files were written; the prisma mock surface in those tests doesn't list `userRole.findMany`.

**Fix recipe per file:**
1. Add BOTH `userRole: { findMany: vi.fn() }` AND `user: { findUnique: vi.fn() }` to the prisma mock surface (in the `vi.mock('../../lib/prisma', ...)` block).
2. In `beforeEach`:
   ```js
   prisma.userRole.findMany.mockReset().mockResolvedValue([]);
   prisma.user.findUnique.mockReset().mockResolvedValue(null);
   ```
3. If any specific test asserts on a granted-permission path, configure that test's `mockResolvedValueOnce` with the appropriate role-name shape.

⚠️ **Self-heal trap:** the prior version of this recipe said "empty `userRole` → falls back to legacy `req.user.role` enum check" — that's **WRONG**. Empty `userRole.findMany` triggers `requirePermission.js`'s `maybeSelfHealAdminPermissions` path which queries `prisma.user.findUnique`. If that's unmocked, the test falls through Prisma singleton to demo MySQL (`163.227.174.141:3306`) → 5s timeout. The fix is the PAIR (`userRole` + `user` both stubbed); the `user.findUnique → null` path exits the self-heal cleanly, then the legacy `req.user.role` enum check applies. Discovered by T29 agent (commit `cc7a6dfb`) during the POS+drugs 7-file batch.

Estimated cost per file: ~20 min (mock add + verify the 1-3 failing tests go green + smoke the file's still-passing tests). Total: ~2.5h.

| # | File | Failing tests | Notes |
|---|---|---|---|
| 1 | `backend/test/routes/drugs.test.js` | 1 — "403 WELLNESS_ROLE_FORBIDDEN when doctor attempts write" | Other 22 tests pass — fall-through trips ONLY on tests that don't otherwise short-circuit before requirePermission |
| 2 | `backend/test/routes/pos-cashLedger.test.js` | 1 — "non-admin caller (helper) returns 403 WELLNESS_ROLE_FORBIDDEN" | Other 24 tests pass |
| 3 | `backend/test/routes/pos-sale-context.test.js` | 1 — "role=USER + wellnessRole=null → 403 WELLNESS_ROLE_FORBIDDEN" | Other 10 tests pass |
| 4 | `backend/test/routes/pos-sale-finalize.test.js` | 1 — "POST /api/pos/sales/finalize — T2 USER → 403" | Other 13 tests pass |
| 5 | `backend/test/routes/pos-sales-by-month.test.js` | 1 — "403 WELLNESS_ROLE_FORBIDDEN when caller is USER" | Other 14 tests pass |
| 6 | `backend/test/routes/pos-sales-stats.test.js` | 1 — "403 WELLNESS_ROLE_FORBIDDEN when caller is USER" | Other 12 tests pass |
| 7 | `backend/test/routes/pos-void-refund.test.js` | 3 — V_403_USER + V_403_MGR + R_403_USER (all 403 assertions) | Other 16 tests pass; one assertion also touches `auditLog.findMany` |

### Class B2 — `prisma.tenant.findUnique` (vertical resolver) — 1 file

**Root cause:** `backend/routes/staff.js:49` calls `prisma.tenant.findUnique` inside a `resolveVertical(req)` helper that runs as part of the `PUT /:id` wellnessRole validation. The mock surface lacks `tenant.findUnique`.

**Fix recipe:**
1. Add `tenant: { findUnique: vi.fn() }` to the prisma mock surface.
2. Add `prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: 'wellness' })` in `beforeEach` for the wellnessRole-enum-validation describe block.

Estimated cost: ~20 min.

| # | File | Failing tests | Notes |
|---|---|---|---|
| 1 | `backend/test/routes/staff.test.js` | 2 — `accepts "cashier" as a valid wellnessRole` + `rejects garbage wellnessRole with 400` | Other 22 tests pass |

### Class B3 — `prisma.webhook.findMany` (webhookDelivery via emitEvent) — 1 file

**Root cause:** Successful `POST /api/contacts` emits a `contact.created` event via `eventBus.emit`. The event listener chain ends in `backend/lib/webhookDelivery.js:52` calling `prisma.webhook.findMany` to find subscribed webhooks. The test's prisma mock lacks `webhook.findMany`.

This file ALSO has a secondary failure mode — the `dedup hit → 409` test has an assertion `expect(vi.fn()).not.toHaveBeenCalled()` on the audit-emit spy, which is fired once. Either the route was changed to write an audit even on dedup-rejected creates (real route change → update test), OR the test's mock setup leaks the emit-spy from a sibling case (state leak → reset hygiene).

**Fix recipe:**
1. Add `webhook: { findMany: vi.fn() }` to the prisma mock surface.
2. Add `prisma.webhook.findMany.mockResolvedValue([])` in `beforeEach` (no subscribed webhooks → no delivery attempts → test stays synchronous).
3. Triage the dedup-409 assertion-mismatch separately — read the current `routes/contacts.js` dedup branch to decide whether the audit-emit is correct-new-behavior (test must update) or a regression (route must update). Likely the former since the dedup branch is normally NOT a state-changing operation but recent audit-coverage waves may have added a "blocked-create" audit row.

Estimated cost: ~30 min (mock + assertion triage).

| # | File | Failing tests | Notes |
|---|---|---|---|
| 1 | `backend/test/routes/contacts.test.js` | 4 — happy create / dedup hit (assertion mismatch) / happy update / ADMIN delete | The dedup-hit case is a non-timeout failure; the other 3 are 5s-timeouts on missing webhook mock |

### Class B4 — `prisma.travelPaymentSchedule.findFirst`/`findMany` (auto-schedule on invoice issue) — 1 file

**Root cause:** `backend/routes/travel_invoices.js:3908` runs an "auto-create payment schedule if not present" block during the issue flow. The block calls `prisma.travelPaymentSchedule.findFirst` (then `findMany` and `create` in the success branch). The test's prisma mock has none of these.

**Fix recipe:**
1. Add `travelPaymentSchedule: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() }` to the prisma mock surface.
2. In `beforeEach`, set `prisma.travelPaymentSchedule.findFirst.mockResolvedValue({ id: 1 })` so the auto-create block sees an existing schedule and short-circuits (matches all 6 failing tests' intent — they assert on invoice-num formatting, not schedule creation).

Estimated cost: ~45 min (6 tests share one fixture).

| # | File | Failing tests | Notes |
|---|---|---|---|
| 1 | `backend/test/routes/travel-invoice-issue.test.js` | 6 — happy TMC / happy RFU / happy travel_stall / sequential 0001→0002 / audit row carry / cross-sub-brand independence | Other 6 tests pass; failures all upstream of the FY-counter logic that the tests are meant to pin |

### Class B5 — Mixed B1 + B2 — 1 file

| # | File | Failing tests | Notes |
|---|---|---|---|
| 1 | `backend/test/routes/search.test.js` | 3 — happy path + tenant-scoped + handler error | `GET /api/search` runs requirePermission AND a tenant-vertical fan-out across multiple Prisma models. Needs the FULL B1 pair (`userRole.findMany` + `user.findUnique` — see Self-heal trap note in B1) AND B2 (`tenant.findUnique`) mock surfaces. ~30 min. |

---

## Recommended sub-slice grouping for the cron

The cron prompt asks each slice to be a **single-agent parallel-safe commit**. The classes are mostly file-disjoint so they parallelise cleanly. The recommendation below buckets fixes into ≤2-hour chunks (one cron tick window), but several batches CAN run concurrently if the cron is willing to fan out:

| Slice | What it ships | Files | Est. cost | Parallel-safe with |
|-------|---------------|-------|-----------|--------------------|
| **T28** | Class A — local-env note + verify CI green; commit a one-liner to `TODOS.md` or a `README.md` note for fresh-clone devs ("run `npm install` in `backend/` after pulling — `@aws-sdk/client-s3` was added 2026-05-20"). No code change needed. | (docs only) | ~10 min | All B-slices |
| **T29** | Class B1 batch — fix the 7 POS + drug tests by adding `userRole.findMany` mock to each file's prisma surface | `drugs.test.js` + 6 `pos-*.test.js` files | ~2.5h | T30 + T31 + T32 + T33 (file-disjoint) |
| **T30** | Class B2 — fix `staff.test.js` by adding `tenant.findUnique` mock | `staff.test.js` | ~20 min | T29 + T31 + T32 + T33 |
| **T31** | Class B3 — fix `contacts.test.js`: add `webhook.findMany` mock + triage the dedup-409 assertion-mismatch separately | `contacts.test.js` | ~30 min | T29 + T30 + T32 + T33 |
| **T32** | Class B4 — fix `travel-invoice-issue.test.js` by adding `travelPaymentSchedule.findFirst/findMany/create` mock | `travel-invoice-issue.test.js` | ~45 min | T29 + T30 + T31 + T33 |
| **T33** | Class B5 — fix `search.test.js` (mixed B1+B2) | `search.test.js` | ~30 min | T29 + T30 + T31 + T32 |
| **T34** | After T28..T33 land — re-run `npx vitest run test/routes/` from a clean `npm install`'d backend; confirm 0 red files; close T27 | (verification only) | ~5 min | (final) |

**If the cron fans out 5 agents in parallel:** T29+T30+T31+T32+T33 finish concurrently in ~2.5h (bottlenecked by T29's 7-file batch).
**If sequential single-agent:** ~5h end-to-end.

---

## Out of scope for this audit

- Frontend test failures (different test suite — `frontend/src/__tests__/`)
- E2E `e2e/tests/` Playwright failures (different runner; tracked via `e2e-full.yml` on release tag)
- Coverage gaps for currently-green files (not red, just thin — captured under `docs/regression-coverage-backlog.md`)
- Backend `test/lib/`, `test/middleware/`, `test/services/`, `test/cron/`, `test/prisma/` red files (this audit covers `test/routes/` ONLY per T27's scope; if other dirs have reds they need a sibling audit)
- Real route regressions buried under the mock-fall-through timeouts. **Caveat:** the audit cannot rule out hidden regressions until the mocks are added. If, after a B-class fix lands, a previously-timing-out test FAILS on assertion (not timeout), that's the route-side bug surfacing and gets escalated to a per-file slice for code-side investigation.

---

## Methodology notes

- **Vitest invocation:** `cd backend && npx vitest run test/routes/ --reporter=default --bail=0`
- **Wall-clock:** 62.33s (transform 28.84s, import 515.58s aggregated across workers, tests 248.29s)
- **Workers:** default (1 fork per available core, vitest 4.x)
- **JWT_SECRET note:** All routes emit a `[secrets] JWT_SECRET environment variable is NOT set — falling back to the insecure dev secret` warning. Not a red signal — vitest doesn't set it; routes are exercised against the dev fallback. Identical behavior on CI's `unit_tests` step.
- **Demo-MySQL exposure:** Unmocked Prisma calls fall through to the real `163.227.174.141:3306` demo MySQL (configured via `DATABASE_URL` in `backend/.env`). Tests should mock all Prisma surfaces they exercise — falling through to a real DB is a test-hygiene smell even when it returns success-shaped data. Worth a separate cron-learning entry if it recurs.
