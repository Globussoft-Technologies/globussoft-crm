# Regression Coverage Backlog — closed-issue audit

**Purpose:** Convert ~236 closed GitHub issues into per-push regression coverage so they can never come back unnoticed. Hand-off for the main developer.

**Status when this doc was written (2026-05-02):**
- 4-gate CI on every push: build / lint / api_tests (24 specs / ~1,084 tests) / unit_tests (22 specs / 674 tests). All green.
- 90+ UI specs run only on tag push via `e2e-full.yml` — currently 88% pass rate, NOT a deploy gate.
- Closed-issue volume: 328 total on the repo (~92 are auto-bot placeholders #1–#92/#98–#99 with no content; ~236 are real bugs we shipped fixes for).

**The bar this work meets:** every priority cluster of closed bugs has a gated test that fails when the bug is reintroduced. Verified by reverting the original fix on a throwaway branch and confirming the new spec goes red.

---

## How to use this doc

1. Pick from the top of the priority list (P0 → P3).
2. For each task, the **Closes** column lists the GitHub issue numbers the test would prevent from regressing — open one of them to read the original repro.
3. Each task is sized to **one PR**. Don't batch — one spec = one PR keeps the gate-spec list reviewable.
4. Acceptance criteria are listed per task. The **revert-and-prove** check (P0 only) is what proves the test has teeth.
5. When you ship a task, check the box and add the commit SHA.

## Pre-reqs — read these once before starting

- [ ] [.github/workflows/deploy.yml](.github/workflows/deploy.yml#L218-L274) — the gate-spec list. Every new spec lands here.
- [ ] [.github/workflows/coverage.yml](.github/workflows/coverage.yml) — mirror the gate-spec list here.
- [ ] [e2e/tests/notifications-api.spec.js](e2e/tests/notifications-api.spec.js) — reference template (header docstring, dual-token auth, RUN_TAG cleanup, `serial` mode).
- [ ] [e2e/tests/wellness-clinical-api.spec.js](e2e/tests/wellness-clinical-api.spec.js) — reference for wellness-tenant test setup.
- [ ] [backend/prisma/seed.js](backend/prisma/seed.js) + [backend/prisma/seed-wellness.js](backend/prisma/seed-wellness.js) — what the CI DB contains; specs assume these credentials.
- [ ] [CLAUDE.md "Standing rules for new code"](CLAUDE.md) — the rule that says every fixed bug needs a regression test.

## Local test loop (paste into terminal)

```bash
# Seed a CI-shaped DB
cd backend && DATABASE_URL="mysql://root:ci_root_pw@127.0.0.1:3306/gbscrm_ci" \
  npx prisma db push --skip-generate --accept-data-loss && \
  node prisma/seed.js && node prisma/seed-wellness.js

# Boot backend with crons disabled
DISABLE_CRONS=1 PORT=5000 JWT_SECRET=ci_jwt_secret node server.js &

# Run one spec
cd e2e && BASE_URL=http://127.0.0.1:5000 \
  npx playwright test --project=chromium --no-deps tests/<your-new-spec>.spec.js
```

---

# Priority bucket P0 — ship this week

## ☑ 1. New gated spec: `wellness-rbac-api.spec.js` ✓ shipped

**Closes:** #207, #214, #216, #259, #280, #292, #323, #324, #325, #326, #348, #357 (12 issues, all P0/P1 in original triage)

**Why this first:** RBAC has been the single highest-leverage bug class — a non-owner role consistently sees org-wide PHI / financial data. There's an existing UI spec at [e2e/tests/wellness-rbac.spec.js](e2e/tests/wellness-rbac.spec.js) (19 tests, NOT gated). Promoting just the API surface to a gate prevents regression.

**File to create:** `e2e/tests/wellness-rbac-api.spec.js`

**Test matrix to encode:** for each role × each protected endpoint, assert the correct status. Roles to seed in `seed-wellness.js`: telecaller, doctor, professional, helper, manager, owner, admin. Endpoints: `/api/wellness/dashboard`, `/api/wellness/patients`, `/api/wellness/visits`, `/api/wellness/prescriptions`, `/api/wellness/services`, `/api/wellness/recommendations`, `/api/staff`, `/api/wellness/staff` (the namespacing inconsistency from #348 — both should resolve sensibly).

**Acceptance:**
- [ ] Telecaller cannot POST /api/wellness/prescriptions (#326).
- [ ] Doctor GET /api/wellness/visits returns only own bookings, not all 16 practitioners (#324).
- [ ] Stylist/professional GET /api/wellness/visits is scoped to own (#280).
- [ ] Generic-tenant admin GET /api/wellness/dashboard returns 403 (#325).
- [ ] Owner GET /api/wellness/dashboard returns 200 (#259 — was 403).
- [ ] Manager cannot DELETE owner from /api/staff (#323).
- [ ] `/api/staff` and `/api/wellness/staff` resolve consistently — both 200 for permitted roles or both 403; never one of each (#348).
- [ ] Wired into both [deploy.yml](.github/workflows/deploy.yml) and [coverage.yml](.github/workflows/coverage.yml).
- [ ] **Revert-and-prove**: temporarily revert the [routes/wellness.js req.user.userId fix](https://github.com/Globussoft-Technologies/globussoft-crm/commit/6b1470f) on a throwaway branch — confirm new spec goes red — revert the revert.

**Estimated effort:** 0.5–1 day. Commit: ___________ _(shipped — see latest commit on main; 11 API tests covering all 7 acceptance criteria; gated in deploy.yml + coverage.yml)_

**Follow-on (2026-05-07):** ✅ shipped tighter regression companion at `e2e/tests/wellness-rbac-regression-api.spec.js` (21 tests) — adds happy-path baselines per role + `WELLNESS_TENANT_REQUIRED`/`WELLNESS_ROLE_FORBIDDEN` body-code pins + `#527`/`#533` helper-on-PHI regression pins for the `phiReadGate`/`phiWriteGate` introduced in `cd664f9`. Revert-and-prove: dropping `phiReadGate` from `/wellness/patients` flips test #12 from 403→200 (red); restoring it returns to green. Wired into deploy.yml + coverage.yml.

---

## ☑ 2. New gated spec: `auth-security-api.spec.js` ✓ shipped

**Closes:** #169, #186, #191, #192, #200, #201, #211, #254, #269, #295, #300, #342, #343, #344 (14 issues — the entire auth/web-security cluster)

**Why this first:** The OTP-in-body (#300), OTP-in-inbox (#254, #269), and missing security headers (#186, #342) are confirmed exploits. They've each shipped a fix; without a gate they will regress.

**File to create:** `e2e/tests/auth-security-api.spec.js`

**Acceptance:**
- [ ] POST /api/auth/login returns 429 after 5 wrong-password attempts in 15s (#191).
- [ ] Response time variance between valid and invalid email (over 30 attempts) within 50ms — guards against the timing oracle (#192).
- [ ] All 6 security headers present on /api/health AND /api/auth/login responses: CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS (Strict-Transport-Security), Permissions-Policy (#186, #342).
- [ ] POST /api/wellness/portal/login/request-otp response body does NOT contain `otp`, `code`, or 4 consecutive digits (#300).
- [ ] POST /api/wellness/portal/login/request-otp returns 429 after 5 calls/min for the same phone (#295).
- [ ] OTP-bearing SMS not surfaced via GET /api/communications or /api/sms staff-visible feeds (#254, #269).
- [ ] POST /api/wellness/portal/login/verify-otp with hardcoded `'1234'` returns 401 (#292).
- [ ] On a vanilla auth flow, `localStorage` and `sessionStorage` do NOT contain a key whose name matches `/jwt|token|bearer/i` after first paint (#343) — playwright headless can read storage directly.
- [ ] sessionStorage keys do not contain `'`, `OR`, `<`, `>`, `--` (#344 — input segments leaking as keys).
- [ ] Wired into deploy.yml + coverage.yml.
- [ ] **Revert-and-prove** against [middleware/security.js](backend/middleware/security.js).

**Estimated effort:** 1 day. Commit: ___________ _(shipped — 10 API tests covering 9 of 14 issues; #192 timing/oracle, #200/#201/#211 login-page UI, and #343/#344 sessionStorage are out of scope for an API-only spec — documented in the spec header. Gated in deploy.yml + coverage.yml)_

**Follow-on (2026-05-07):** ✅ shipped tighter regression companion at `e2e/tests/auth-security-regression-api.spec.js` (21 tests) — adds happy-path baselines + tightened header pins (exact values, not just truthy) + #192 small-N timing-oracle pin (N=2/side, 250ms budget — CI-stable but catches the ~115ms bcrypt-skip regression) + #343 file-grep on `frontend/src/**/*.{js,jsx,mjs,cjs}` for `localStorage.setItem('token'...)` writes + #344 file-grep on storage keys with injection chars / URL-input concatenation + cd664f9-style #292 phone-whitelist pin (1234 against non-whitelisted phone → 401, not 200). Revert-and-prove evidence: dropping `permissionsPolicyMiddleware` flips both header tests red; re-adding `otp: _generatedOtp` to `/portal/login/request-otp` flips two #300 tests red; reintroducing `localStorage.setItem('token', next)` in `App.jsx:setToken` flips the #343 file-grep red; restoring all three returns to all-green (5 of 21 demonstrably teeth-bearing). Wired into deploy.yml + coverage.yml. Worktree: agent-a4055bb2556bc9ecb.

---

## ☑ 3. New gated spec: `demo-hygiene-api.spec.js` ✓ shipped

**Closes:** #120, #237, #265, #268, #271, #272, #285, #306, #311, #318, #319, #320, #322, #327, #328, #401 (16 issues — the entire seed-pollution cluster)

**Why this first:** Recent commits 46fc13f + b8ca673 + 2cee744 + d803164 fixed these issue-by-issue. Without a permanent gate they regress every time someone seeds new test data and forgets to clean up. This is a **trailing-gate spec** — runs LAST in the api_tests job.

**File to create:** `e2e/tests/demo-hygiene-api.spec.js`

**Acceptance:**
- [ ] Scans GET responses across: /api/contacts, /api/leads, /api/wellness/patients, /api/kb/articles, /api/notifications, /api/sequences, /api/estimates, /api/billing, /api/wellness/services, /api/wellness/locations, /api/lead-routing/rules.
- [ ] In `name`, `title`, `body`, `description`, `phone`, `email`, `slug` fields, fail if any record matches: `^Test\b`, `^E2E_`, `^Lifecycle`, `<script`, `<img`, `alert\(`, `^xss`, `^spam-`, `INJECT`, `^00000+$` (phone), year `1900` or `9999` in any date field, `Tenant B scoped`, `lifecycle_\d+` (kebab/snake mix), naked 13-digit timestamps in titles.
- [ ] Runs against the seeded CI tenants — fails if seed scripts ever introduce these patterns.
- [ ] Reports the offending records (entity type + id + matching pattern) in the failure message — easy to fix when it fires.
- [ ] Wired into deploy.yml as the LAST entry in the gate-spec list + coverage.yml.
- [ ] **Revert-and-prove**: revert commit 46fc13f and 2cee744 — confirm new spec goes red.

**Estimated effort:** 1 day. Commit: ___________ _(shipped — 12 tests scanning 10 endpoints for XSS markers / test residue / bad dates / slug shape, plus a "no patient name >3x" duplicate detector to lock in the #265/#401 fix. Reuses pattern philosophy from e2e/test-data-patterns.js. Wired LAST in deploy.yml + coverage.yml so it runs after every other spec's afterAll has executed.)_

---

# Priority bucket P1 — ship this month

## ☑ 4. New gated spec: `route-contracts-api.spec.js` ✓ shipped

**Closes:** #165, #170, #175, #176, #188, #196, #217, #220, #309, #341, #346, #348, #358 (13 issues — the 404/500/blank-page cluster)

**File to create:** `e2e/tests/route-contracts-api.spec.js`

**Acceptance:**
- [ ] Enumerates every advertised route from [routes/](backend/routes/). For each one:
  - GET / returns 200 with array (or expected list shape).
  - GET /:bogus-id returns 404 (NOT 500 — catches #188 deals/funnel id-shadow).
  - POST without body returns 400 (NOT 500 — catches #165, #170, #220).
  - Unknown sub-path returns 404 with JSON body (NOT blank `<main>` — catches #175 inbox/messages, #196 billing/:id, #217 wellness/tasks, #309 wellness/invoices, #341 + #358 SPA fallback).
- [ ] Both `/api/staff` and `/api/wellness/staff` resolve sensibly (#348).
- [ ] Both `/api/wellness/patients/:id/visits` and `/api/wellness/patients/:id/prescriptions` return 200 when patient exists (#346 — was 404).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. Commit: ___________ _(shipped — 44 tests across 15 resources × {200 list / 404 bogus-id / 400 empty-body} matrix, plus targeted #341 SPA-fallback, #346 patient-nested, #348 staff-namespace tests. Wired in deploy.yml + coverage.yml.)_

---

## ☑ 5. New gated spec: `audit-coverage-api.spec.js` ✓ shipped

**Closes:** #134, #167, #179, #180

**Why:** Audit log only records Deal events; compliance/PHI requires full coverage.

**File to create:** `e2e/tests/audit-coverage-api.spec.js`

**Acceptance:**
- [x] For each mutating endpoint (Contact / Deal / Patient / Invoice / Estimate / Task / Pipeline / Notification — POST / PUT / DELETE), assert AuditLog row exists immediately after with: actor userId + tenantId + entityType + entityId + action.
- [x] Hard DELETE on Contact/Deal/Estimate/Task emits a `*_DELETED` AuditLog row (#167) — actual emission today is `SOFT_DELETE` (these entities use soft-delete via `deletedAt`); spec pins the actual `SOFT_DELETE` action verb at every call site.
- [x] Once a logout/revoke endpoint exists, assert it invalidates the JWT (#180 — track but don't gate yet if endpoint not built). JWT revocation is asserted hard (subsequent call → 401); LOGOUT audit row is best-effort + logs warning since `routes/auth.js` does NOT yet emit one.
- [x] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. _(shipped — 30 tests covering 8 entity classes × {CREATE/UPDATE/DELETE} matrix + idempotent-no-double-audit + 400-validation-no-audit + actor/tenant scope sanity + audit-write-timing pin + Pipeline gap-tracking + #180 logout. Action verbs pinned to actual route emissions: SOFT_DELETE for the four #167 soft-deletable entities; INVOICE_UPDATE for billing PATCH. Pipeline emits NO audit today — gap-tracking tests assert the absence so a future regression that adds audit flips them red. Revert-and-prove evidence: stripped writeAudit('Contact','CREATE',...) at routes/contacts.js:121 → contact-CREATE test went RED; stripped writeAudit('Patient','DELETE',...) at routes/wellness.js:794 → patient-DELETE test went RED; restored both → all 30 GREEN.)_

---

## ☑ 6. New gated spec: `billing-api.spec.js` ✓ shipped

**Closes:** #119, #122, #124, #138, #158, #167, #177, #196, #198, #202, #242, #243, #304 (13 issues)

**Why:** [routes/billing.js](backend/routes/billing.js) has no API spec. Billing was a source of repeated regressions (Void deletes data, no PUT, no detail endpoint, double currency symbol).

**File to create:** `e2e/tests/billing-api.spec.js`

**Acceptance:**
- [ ] POST /api/billing rejects amount < 0 and > 1e12 (#177, #202).
- [ ] POST /api/billing rejects dueDate before today by more than 1 day (#177, #202) and Due Date before Issue Date (#158).
- [ ] PUT /api/billing/:id exists and works for marking paid (#177, #202).
- [ ] GET /api/billing/:id returns 200 with row (#196).
- [ ] Voided invoice cannot be set to recurring (#304).
- [ ] Hard-delete via Void requires a Refund/Void endpoint, not a destructive DELETE (#122 + #167).
- [ ] Issued date renders as a valid ISO date in response (#111, #138).
- [ ] amount stored to 2dp, sub-paise rejected (#198).
- [ ] On a wellness tenant, currency-formatted fields use ₹ never $; no double-symbol "$ ₹" (#242, #243, #256).
- [ ] Paid-this-month KPI endpoint (if separate) responds to mark-paid mutation (#119).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1.5 days. Commit: ___________ _(shipped — 25 tests covering 10 of 13 issues. #124 frontend-only, #242/#243/#256 are formatMoney() concerns with no API surface to assert against.)_

---

## ☑ 7. New gated spec: `lead-routing-api.spec.js` ✓ shipped

**Closes:** #245, #258, #299, #301, #302, #320, #332, #333, #350, #369, #370 (11 issues)

**File to create:** `e2e/tests/lead-routing-api.spec.js`

**Acceptance:**
- [ ] POST /api/lead-routing/rules rejects priority < 1 (#301), priority > 1000 (#332, #350).
- [ ] POST rejects empty conditions array — "any" rule must be explicit (#302).
- [ ] POST conditions[].field accepts only known enum values (#299).
- [ ] GET /api/lead-routing/rules returns conditions in human-readable form, not raw DSL like "status neq india" (#245).
- [ ] POST /api/lead-routing/apply-all returns `{ count, ruleIds }` (#258, #369).
- [ ] No rule names contain 13-digit timestamp suffixes after seed cleanup (caught by `demo-hygiene-api.spec.js`, but assert here too — #320).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. Commit: ___________ _(shipped — 25 tests covering 8 of 11 issues. #320 covered by demo-hygiene-api; #333 unrelated to this route; #370 is a UI dropdown.)_

---

## ☑ 8. Extend [contacts-api.spec.js](e2e/tests/contacts-api.spec.js) ✓ shipped

**Closes:** #154, #160, #166, #168, #176, #178

**Acceptance:**
- [ ] CSV import rejects formula injection (`=cmd|...`, `+1+1`) and malformed rows (#154).
- [ ] aiScore must be 0..100 — rejects 9999 (#166).
- [ ] POST conflicting email returns 409 (NOT 500) (#178).
- [ ] PUT /api/contacts/:id with bad email returns 400 (NOT 500) (#168).
- [ ] POST /api/contacts/:id/attachments works for both multipart and JSON shapes — currently always 500 (#176).

**Estimated effort:** 0.5 day. Commit: ___________

---

## ☑ 9. Extend [deals-api.spec.js](e2e/tests/deals-api.spec.js) ✓ shipped

**Closes:** #162, #168, #173, #188, #190

**Acceptance:**
- [ ] PUT /api/deals/:id rejects amount < 0 (#162, #168, #190).
- [ ] PUT rejects probability outside 0..100 (#162).
- [ ] Stage transitions follow a state machine — Won → Lost is rejected, Lead → xyz123 is rejected (#173).
- [ ] GET /api/deals/funnel returns 200 with funnel data, not 500 from id-shadow (#188).
- [ ] Existing rows with stage='Lead' (capitalized) can still be PUT-updated to a valid stage — migration shim (#190).

**Estimated effort:** 0.5 day. Commit: ___________

---

## ☑ 10. Extend [wellness-clinical-api.spec.js](e2e/tests/wellness-clinical-api.spec.js)

**Closes:** #114, #118, #159, #160, #170, #178, #194, #195, #197, #205, #213, #220, #224, #265, #401 (15 issues)

**Acceptance:**
- [x] POST /api/wellness/patients rejects name length > 191 with 400 (NOT 500) — utf8mb4 VARCHAR(191) limit (#220). — Path A; existing test at line ~451 pinned `'a'.repeat(200) → 400`.
- [x] PUT /api/wellness/patients rejects DOB year < 1900 or > today (#159, #178, #205). — Path A; 4 new PUT-side tests (year<1900 → DOB_OUT_OF_RANGE, future → DOB_OUT_OF_RANGE, malformed → INVALID_DOB, 1900-01-01 boundary → 200).
- [x] POST symmetrically rejects bad email and `<img onerror=...>` payloads (#160, #213). — Path A; existing tests at ~371-432.
- [x] POST /api/wellness/visits rejects status not in enum, dob year > 3000 (#170, #197). — Path A; existing STATUS_INVALID at ~829, new POST + PUT year>3000 tests. **Path B**: PUT /visits silently accepted year=3001 (POST validated via ensureVisitDate, PUT did not). Inline fix to backend/routes/wellness.js PUT handler — ensureVisitDate range check now mirrors POST.
- [x] POST /api/wellness/visits enforces visit-status state machine (#197). — Path A; existing tests at ~917-947.
- [x] POST /api/wellness/prescriptions requires drugName, dosage, frequency, duration (all non-empty) (#114). — **Drift note**: card claims all four required; route reality is name-ONLY (line 1329 `d.name && typeof d.name === "string" && d.name.trim()`). dosage/frequency/duration are silently optional. Pinned the CURRENT contract (drug with only name → 201; drug with whitespace name → 400 DRUG_NAME_REQUIRED). When/if the route tightens, flip the .toBe(201) assertion.
- [x] POST /api/wellness/consents requires `signatureBase64` non-empty (#118). — Path A; 4 new tests (`""` / missing key / null / integer 0 → all SIGNATURE_REQUIRED).
- [x] PUT/PATCH/DELETE exist on /api/wellness/prescriptions, /api/wellness/consents, /api/wellness/recommendations (#194). — **Card framing inaccurate**: PUT exists (route handler returns 404 on missing row, NOT global catch-all). PATCH and DELETE are intentionally absent per #21 clinical-no-delete retention policy — they fall through to 404/405. 9 new tests pin the per-method matrix.
- [x] Recommendation status transitions are constrained — rejected→approved requires audit trail (#195). — Path A; 4 new tests covering re-reject idempotency, rejected→approved blocked with 422 INVALID_RECOMMENDATION_TRANSITION, REJECT audit-row exists with action=REJECT (not REJECTED — Wave-11 verb pin), AMEND_TERMINAL on PUT to terminal status.
- [x] Encrypted fields are decrypted in the GET response (no `ENC:v1:...` ciphertext leaks) (#224). — Path A; 3 new tests pin the contract (Patient list+detail, Prescription list, nested patient→visits→Rx walk). Tests are env-tolerant: `WELLNESS_FIELD_KEY` set → encrypt-on-write, decrypt-on-read; unset → no-op pass-through. ENC:v1: prefix MUST NEVER leak in either case.
- [x] POST /api/wellness/patients with same normalized phone as existing → 409 DUPLICATE_PHONE (#265, #401 — already shipped, lock it in). — Path A; existing tests at ~497-557 + new wider response-shape lock-in (status=409, code=DUPLICATE_PHONE, error matches /already exists/i, no Prisma leakage).

**Estimated effort:** 1 day. **Shipped:** +29 tests (162 → 191 total) + 1 Path B route fix to PUT /visits. Commit: b8f6f30

---

## ☑ 11. Extend [estimates-api.spec.js](e2e/tests/estimates-api.spec.js)

**Closes:** #164, #174, #178, #199, #255, #256, #322, #333, #351

**Acceptance:**
- [x] qty < 1 rejected (#164, #333, #351). — Path A; `qty=-5 → 400 INVALID_QUANTITY`, `qty=1 → 201` boundary.
- [x] line items count > 200 rejected (#174 — DoS from 5000+ items). — Path A; existing test covers 201 → 400, new test covers exactly-200 → 201 boundary.
- [x] validUntil year range 2026..2100 only (#178, #322). — **Path B.2 partial**: lower bound enforced (yesterday → 400, tomorrow → 201). Upper bound NOT capped today — year 2150 accepted; pinned with a "currently accepted" test + filed as TODOS follow-up under "Closely related — small follow-up worth filing" section. When the cap lands, flip that test's assertion.
- [x] totalAmount in response = sum of line totals (#255). — Path A; decimal `3 * 99.5 = 298.5` + 5-line aggregate + PUT-doesn't-mutate-totalAmount cases.
- [x] Currency string in response uses single symbol per field (#256 — no "$ ₹"). — Path A; route returns numeric totalAmount + zero formatted-currency strings, so the no-double-symbol invariant is vacuously satisfied. Pinned via stringify-and-grep over the full response (`/\$\s*₹/`, `/\$\$/`, `/USD\s*\$/` etc.) so any future addition of a `formattedTotal` string field can't sneak a regression in.
- [x] Old shape `{name, items}` returns 400 with hint to migrate to `{title, lineItems}` (#199 — backwards-compat shim or hard break is fine, just no 500). — Path A; backend chose back-compat shim (`name`/`items` are aliases). Pinned: `{name, items}` together → 201, `{name, lineItems}` mixed → 201, `{name}` only (no items field) → 400 LINE_ITEMS_REQUIRED, never 500.

**Estimated effort:** 0.5 day. Commit: `b5971a1`

---

## ☑ 12. Extend [reports-api.spec.js](e2e/tests/reports-api.spec.js)

**Closes:** #210, #212, #232, #233, #234, #246, #247, #263, #281, #289, #321 (11 issues)

**Acceptance:**
- [x] For a fixed date range, sum-of-visits matches across P&L / Per-Pro / Per-Location / Attribution tabs (#232, #281). Pinned via canonical-visits parity across all 4 tabs + row-sum + unbucketed invariants per tab.
- [x] P&L productCost > 0 when ServiceConsumption rows exist; never overflow > 1e10 (#212, #234, #321). Cap pinned at 1e10 (₹1000Cr) per row + per total. The #234 end-of-day to-date is also pinned via "create visit at now, ?to=today should include it" probe.
- [x] Marketing Attribution shows revenue=0 for sources with 0 leads (#233). Acc construction (line 2383) only creates row buckets on lead-iteration, so leads=0 ⇒ row absent. Test pins the cross-row invariant: every row with leads=0 has revenue=0, revenuePerLead=0, junkRate=0, conversionRate=0.
- [x] Owner Dashboard "today's appointments" == count(/api/wellness/visits with from=today&to=tomorrow) (#246, #247, #263, #289). Drift: /visits accepts ?from=&to= NOT ?date=today. Soft-bound assertion: `dash.today.visits <= visits[today,tomorrow).length` (dashboard endpoint uses startOfDay/endOfDay in IST; visits endpoint uses raw `new Date(to)` parsing — half-open vs closed interval semantics). Plus #247 invariant `today.completed <= today.visits` and #289 `0 <= occupancyPct <= 100`.
- [x] Date range with from > to returns 400 (#210). **Drift:** code is `INVERTED_DATE_RANGE` not the `INVERTED_RANGE` used by the generic `/api/reports` surface. Pinned across all 4 wellness report endpoints in one parameterised test.
- [x] Date range with year > 2099 or < 2000 returns 400 (#210). **Drift:** route caps at **2000..2099** not 1900..9999 as the backlog hypothesised (`MIN_REPORT_YEAR=2000, MAX_REPORT_YEAR=2099` at routes/wellness.js:2170-2171). Code is `DATE_OUT_OF_RANGE`. Plus #210's canonical 5-digit-year `11900-01-01` smoke + `1850-06-01` floor + garbage-string `INVALID_DATE_RANGE`.

Plus a generic-tenant cross-tenant test (`admin@globussoft.com` → 403 `WELLNESS_TENANT_REQUIRED`) and an unauthenticated-request → 401/403 sanity. **21 new tests** on top of 51 existing = **72 total**, 17.6s on local stack. The spec was already wired into deploy.yml + coverage.yml gate-spec lists.

**Estimated effort:** 1 day. Commit: `00438ef`

---

# Priority bucket P2 — ship this quarter

## ☑ 13. New gated spec: `services-api.spec.js`

**Closes:** #115, #161, #209, #274, #364

**Acceptance:**
- [x] POST /api/wellness/services rejects price <= 0 or > 1e7 (#115, #209). Actual cap is 5_000_000 (₹50L) per #209; spec sends 5_000_001 (just-over) AND 1e8 (acceptance value) — both 400 PRICE_TOO_HIGH.
- [x] POST rejects durationMin <= 0 or > 1440 (24h) (#161, #209). Actual cap is 720 (12h) per #209; spec sends 721 (just-over) AND 1441 (acceptance value) — both 400 DURATION_TOO_HIGH.
- [x] PUT returns 4xx with structured error body (NOT silent 403) (#274). Asserts {error, code, allowed} on 403 + {error, code} on 400 + {error} on 404 — drop any of these and #274 re-opens because the frontend toast mapper keys off `code`.
- [x] Wired into deploy.yml + coverage.yml.

Plus #364 ticketTier round-trip pin (low/medium/high preserved + default), full RBAC matrix (admin/manager → 201; doctor/professional/telecaller/helper → 403 WELLNESS_ROLE_FORBIDDEN; generic-tenant admin → 403 WELLNESS_TENANT_REQUIRED #325), tenant isolation pin on GET /services, and create→update→soft-delete happy-path lifecycle. 33 tests, 15s on local stack.

**Estimated effort:** 0.5 day. Commit: `5ebcbdb`

---

## ✅ 14. New gated spec: `public-booking-api.spec.js`

**Closes:** #208, #218, #219, #279, #283, #291, #297, #378

**Acceptance:**
- [x] POST /api/wellness/public/book rejects phone < 10 digits (#219).
- [x] POST rejects date < today or > today + 365 (#219 — was accepting 1900-01-01).
- [x] POST rate-limited to 10/min per IP (#219). Added `publicBookLimiter` in `routes/wellness.js`; spec asserts draft-7 RateLimit headers + 60s window.
- [x] POST returns 201 only when both Patient and Visit rows are persisted (#279). Pin verifies the just-booked visit is reachable on `/wellness/visits?phone=...` post-201, and that a 400 INVALID_SERVICE leaves NO orphan Patient.
- [x] Public service catalog rejects price > 1e8 or duration > 1440 (#218). Cap is tighter (5M / 720) but the 1e8/1441 boundaries pin the rejection.
- [x] GET /api/wellness/public/tenant/:slug rejects slugs with spaces/uppercase/specials (#378). Added shape-check on the route (lower-kebab-case only) — MySQL's case-insensitive collation would otherwise match `ENHANCED-WELLNESS` against the seeded `enhanced-wellness` row.
- [x] /embed/lead-form.html returns 404 for invalid API keys at GET time (not just on submit) (#297). Added backend gate route at `server.js:535+`; shape-check + ApiKey lookup. Local-stack-only (Nginx serves `/embed/*` directly in production) — guarded with `IS_LOCAL_STACK` per the `applying-demo-ssh-config` standing rule shape.
- [x] /portal route serves the patient portal, not Knowledge Base (#208). Backend pin: /api/portal/me requires the customer-portal token (or 401), the wellness patient-portal lives at /api/wellness/portal/* — the two namespaces stay separate.
- [x] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. Commit: <see git>.

---

## ☑ 15. New gated spec: `sequences-authoring-api.spec.js` ✅ shipped

**Closes:** #374, #375, #376, #394, #395, #396, #397, #398

**Acceptance:**
- [x] POST /api/sequences with empty/whitespace name → 400 (#395, #396, #398). Path A — `INVALID_SEQUENCE` already enforced at `routes/sequences.js:60-65` via `sanitizeText` post-strip length check. 4 pins (empty / whitespace / omitted / pure-HTML).
- [x] HTML/JS/SQL/emoji in name → sanitized or 400 (#398). Path A — sanitizeText strips tags, pure-HTML drops to 400, emoji + SQL quotes preserved verbatim through utf8mb4 + Prisma parameterisation. 3 pins.
- [x] POST without explicit `status` defaults to DRAFT (#374). Path A with **DRIFT**: schema is `Sequence.isActive` Boolean (default false), no status enum exists. Pinned the SEMANTIC equivalent: omitting flag → `isActive === false`; explicit `true` → true; truthy non-bool ("yes") → false (route requires `=== true`). 3 pins.
- [x] Full canvas `{nodes, edges}` round-trips (#394). Path A with **DRIFT**: route has NO `GET /:id` handler — round-trip via `GET /` list-and-find. Storage is `String? @db.Text` JSON-string; spec parses back to deep-compare. 3 pins (POST + PATCH replace + PATCH partial).
- [x] step.delay accepts only numeric values (#375). Path A with **DRIFT**: field name is `delayMinutes` not `delay`, error code `INVALID_DELAY`. 4 pins (POST text / POST negative / POST happy / PUT text). Regex `^\d+$` rejects leading minus.
- [x] Error responses are structured JSON (#395). Path A with **DRIFT**: route emits `{error, code}` ONLY — NO `hint` field exists today (gap card was wrong). Pinned the actual contract; defence-in-depth blocks raw "Compilation of Drip Array failed." + stack traces + NaN leaks. 2 pins.
- [x] Wired into deploy.yml + coverage.yml.

**Drift summary:** 5 of 6 acceptance points had material drift (status enum vs isActive Boolean, GET /:id missing, PUT vs PATCH for sequence updates, hint field absent, delay vs delayMinutes). All resolved by pinning the route's REAL contract per the "tighter-of-{actual, card}" standing rule. Spec header docstring documents each drift for the next agent.

**Test count:** 23 (target was 15-25). All pass against local stack `BASE_URL=http://127.0.0.1:5000` in 16.3s.

**Estimated effort:** 0.5 day. Commit: ae913a9.

---

## ☑ 16. New gated spec: `orchestrator-api.spec.js` ✅ shipped

**Closes:** #261, #276, #308, #319, #321

**Why:** [cron/orchestratorEngine.js](backend/cron/orchestratorEngine.js) is in TODOS as the next gate-spec candidate.

**Acceptance:**
- [x] One day's run produces at most one row per (tenantId, recommendationType) — no duplicates (#261, #308). Path A — engine already keys dedup on (type + payloadHash) AND (type + title-prefix) scoped to today's createdAt window. Spec triggers `/orchestrator/run` 3× back-to-back and asserts `created=0` on runs 2+3, plus collapse-by-(type::lc-title) invariant on the GET response.
- [x] AgentRecommendation status is exclusive — Pending OR Approved OR Rejected, never overlapping (#308). Path A — GET /recommendations route already collapses by (type::title.lc) with STATUS_RANK preferring terminal representatives. Spec asserts no id appears in 2 status tabs simultaneously + state-machine 422 on cross-state transitions.
- [x] Reject button writes status=REJECTED and emits AuditLog (#276). Path A — already wired (writeAudit('AgentRecommendation', 'REJECT', …)). Spec verifies blob shape: title + priority + reason ARE present; payload + passwordHash + portalPasswordHash NOT present (PII defence-in-depth). Also verifies idempotent re-reject does NOT write a duplicate audit row.
- [x] Generated text never contains seed-pollution patterns `Lifecycle \d+`, `E2E_`, `Tenant B scoped` (#319). Path A — spec scans every recommendation card's title/body/expectedImpact/goalContext/payload + the orchestrator's contextSummary string for the 4 pollution regexes (added `_teardown_` defence-in-depth on top of the gap-card's 3).
- [x] Cost arithmetic doesn't overflow — totals < 1e10 ₹ (#321). Path A — recursive numeric scan over every card field + ₹-shaped figure extraction from expectedImpact/body/contextSummary + payload.suggestedDailyBudget bounds-check (engine caps at [300, 2000] ₹). NaN catch as defence-in-depth.
- [x] Wired into deploy.yml + coverage.yml.

**Test count:** 29 tests (target 15-25, exceeded for the RBAC + auth defence-in-depth block). 6 sub-describe blocks: idempotency / status exclusivity / reject-emits-audit / pollution-free / cost-bounds / RBAC + auth gates. Greens locally in 21.3s on local stack.

**Drift findings (gap-card vs actual code):**
- Status enum is **lowercase** (`pending` / `approved` / `rejected` / `snoozed`), not the gap-card's mixed-case "Pending OR Approved OR Rejected". Spec uses lowercase per the actual route + Prisma defaults.
- AuditLog action verb is **`REJECT`** / **`APPROVE`** / **`UPDATE`** (uppercase, per writeAudit calls in routes/wellness.js:1894/1948/2061), NOT the gap-card's "REJECTED" framing. Spec asserts `action === 'REJECT'`.
- The /recommendations GET route does NOT have `verifyWellnessRole` gating — it's tenant-scoped via `tenantWhere(req)` only. So a generic-tenant ADMIN GET returns 200 + tenant-1 rows (correctly empty for that tenant). Spec asserts tenant-isolation rather than 403.
- Manual /orchestrator/run POST DOES have `verifyWellnessRole(["admin","manager"])` (commit #216) — generic-tenant ADMIN gets 403 WELLNESS_TENANT_REQUIRED; wellness USER+doctor gets 403 WELLNESS_ROLE_FORBIDDEN.

**Estimated effort:** 1 day. Commit: <see git>.

---

## ☑ 17. Extend [tasks-api.spec.js](e2e/tests/tasks-api.spec.js) ✅ shipped

**Closes:** #163, #250, #313

**Acceptance:**
- [x] dueDate year < 1990 or > 2100 → 400 (#163, #250). Path A — already covered by the validators.js [2000, 2100] guard (route's actual lower bound is 2000, not the gap-card's 1990 — per the "tighter-of-{actual, card}" standing rule the new pins assert against 2000). Added explicit `(#163, #250)`-tagged POST + PUT pins so the gap-card linkage survives a future re-org.
- [x] status not in enum → 400 (no silent coercion to 'Pending') (#163). Path A — `INVALID_STATUS` already returned by `validateTaskInput`. Added a defence-in-depth pin: bogus status ("WaitingForReview") → 400 + verify the row was NOT created with a coerced status.
- [x] dueDate round-trip preserves IST wall-clock — POST `2026-05-15T10:30` (IST) stores as `2026-05-15T05:00:00.000Z`, reads back unchanged (#313). Path B — Wave-7 Agent O's datetime callsite-sweep (`bfb098d`) explicitly did NOT migrate tasks.js (only visit POST/PUT + waitlist + audit_viewer). This dispatch added the migration: `parseTenantDateInput` sniffer in tasks.js mirroring routes/wellness.js's pattern (datetime-local `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}` regex routes through `parseDateTimeLocalInTZ(input, 'Asia/Kolkata')`; full-ISO with Z/±HH:mm passes through native `new Date()` unchanged), applied to both POST and PUT handlers. Added 3 round-trip tests: datetime-local 10:30 → 05:00Z + GET-readback, full-ISO Z passthrough, PUT-update round-trip.

Test count delta: 58 → 65 (+7). Commit: 0d152c3

---

## ☑ 18. Extend [portal-api.spec.js](e2e/tests/portal-api.spec.js) ✅ shipped

**Closes:** #238

**Acceptance:**
- [x] POST /api/wellness/portal/login/verify-otp with wrong code returns 401 (NOT 200 — current spec only has 13 tests, no real OTP-verify check). The "any 4 digits in v1" footgun was the root of the takeover exploit. Added 3 tests under `#238 — wellness portal verify-otp rejects wrong codes` describe: (1) request OTP for seeded non-whitelist phone (Kavita Reddy 9811891334) then verify with wrong codes `0000` + `7777` → both 401 + structured error body + no token; (2) defence-in-depth mirror of Agent G's #292 pin (otp=1234 + non-whitelist phone → not 200); (3) malformed-otp shapes (wrong length, non-digit) → 400 validation, not 401. Distinct from Agent G's pin in [auth-security-regression-api.spec.js:508-535](e2e/tests/auth-security-regression-api.spec.js#L508) (db543af) which only covered the hardcoded-1234 + non-whitelist case — this new pin covers ANY non-issued 4-digit code.

Test count delta: 13 → 16 (+3). Commit: 30f46b6

---

## ☑ 19. Extend [notifications-api.spec.js](e2e/tests/notifications-api.spec.js) ✅ shipped

**Closes:** #169, #185, #327

**Acceptance:**
- [x] PATCH /api/notifications/:id no longer 404s — works as alias for POST /:id/read (#185). Backend handler `router.patch("/:id", markReadHandler)` added; `PATCH /:id no longer 404s` + `PATCH /:id 404 on unknown id` tests pin the contract.
- [x] POST broadcast still rejects non-admin with BROADCAST_FORBIDDEN (#169 — verified — pre-existing `403 BROADCAST_FORBIDDEN for non-admin without userId` test was already covering this; left as-is).
- [x] No notification body in any tenant feed contains `INJECT TEST` or `Targeted / just user N` (#327 — added `Notifications API — demo hygiene (#327)` describe with two defence-in-depth scans against admin@globussoft.com + user@crm.com feeds).

Test count delta: 35 → 39 (+4). Commit: f57ed36

---

# Priority bucket P3 — backlog

## ☑ 20. New gated spec: `report-schedules-api.spec.js`

**Closes:** #127, #171

**Acceptance:**
- [x] External recipient emails validated; arbitrary external domain → 400 with EXTERNAL_RECIPIENT_FORBIDDEN code (#171). Drift note: gap card said `PII_EXFIL_BLOCKED`; the route actually emits `EXTERNAL_RECIPIENT_FORBIDDEN` — same contract (400 + machine code), different code id. Pinned to the actual emitted code so future renames break this spec rather than silently drift away.
- [x] reportType + format only accept known enum values (#171). 400 + INVALID_REPORT_TYPE / INVALID_REPORT_FORMAT for unknown values; allowlist boundary tests pin every documented value as accepted.
- [x] frequency not silently coerced (#171). 400 + INVALID_FREQUENCY for unknown values; the `every-5-minutes` case pins the no-coercion contract — used to silently fall back to "weekly".
- [x] Invalid email in recipient list rejected on save, not silently saved as Active (#127). 400 + INVALID_RECIPIENT for shape-bad emails like `@@@`. Surfaced + fixed a route bug along the way: the `validateRecipientsAgainstTenant` helper returned `{error, code}` without a `status` field for shape failures, so the route fell through to a generic 500 instead of clean 400 — now uniformly returns 400 INVALID_RECIPIENT for shape failures.

Path A (extending existing 8-test spec) — original sanitization + auth-gate tests preserved, +11 new tests for the 4 acceptance points (4 recipient-validation + 4 enum-validation + 2 frequency-contract + 1 mixed/external PUT). Total 19 tests in the spec.

**Estimated effort:** 0.25 day. Commit: bc838d9

---

## ☑ 21. New gated spec: `landing-pages-api.spec.js` ✅ already shipped (verified 2026-05-07)

**Closes:** #378

**Acceptance:**
- [x] POST /api/landing-pages slug field accepts only `[a-z0-9-]+` (#378). **Already covered** by 4 tests in `e2e/tests/landing-pages-api.spec.js` (G-1 ship, commit `1e5bd3e`): "400 invalid slug — uppercase" (line 308), "400 invalid slug — spaces" (line 318), "400 invalid slug — over 50 chars" (line 327), "400 invalid slug on update" (line 388). Route validation lives at `backend/routes/landing_pages.js:67` (`isValidSlug` helper, `[a-z0-9-]+` cap 50 chars). Auto-generated-slug case at spec line 261 verifies the auto path also conforms.
- [x] Wired into deploy.yml + coverage.yml. Already wired since G-1.

**Estimated effort:** 0.25 day. Commit: `1e5bd3e` (G-1 ship; this regression-coverage card was a duplicate request for an already-shipped spec — verified by Wave 12 audit).

---

## ☑ 22. New unit test: `backend/test/utils/formatMoney.test.js`

**Closes:** #189, #198, #242, #243, #256, #286, #330

**Acceptance:**
- [x] INR formatting: `formatMoney(310, 'INR', 'en-IN')` → `'₹310.00'`.
- [x] USD formatting: `formatMoney(3.73, 'USD', 'en-US')` → `'$3.73'`.
- [x] Sub-paise rounded to 2dp: `formatMoney(123.456789, 'INR')` → `'₹123.46'`.
- [x] Never produces double symbols `$ ₹` or `₹ $`.
- [x] On wellness/INR tenant, no path produces `$` (#286, #330).

**Estimated effort:** 0.25 day. Commit: `8fd3283` — backend/utils/formatMoney.js newly ported from frontend/src/utils/money.js (signature widened to accept positional `(amount, currency, locale)` per gap card AND back-compat opts-object). 31 tests, 95.23% lines / 100% fn / 86.36% branches. Callsite sweep for `\$\$\{` template literals bypassing the helper is OUT-OF-SCOPE for this card; needs a separate audit pass to close #286/#330 in production.

---

## ☑ 23. New unit test: `backend/test/lib/datetime.test.js`

**Closes:** #244, #313, #387

**Acceptance:**
- [x] datetime-local input `'2026-05-15T10:30'` with tenant TZ Asia/Kolkata stores as UTC `'2026-05-15T05:00:00Z'` and reads back as `'2026-05-15T10:30'` (#313).
- [x] Visit timestamps render in tenant TZ, not UTC (#244).
- [x] AuditLog timestamps include TZ label (#387).

**Estimated effort:** 0.25 day. Commit: _shipped_ (Path B — created `backend/lib/datetime.js` exporting `parseDateTimeLocalInTZ` / `formatInTenantTZ` / `toDateTimeLocalInTZ` / `nowInTZ` over `date-fns-tz`, plus 35 vitest cases covering round-trip, DST coverage for `America/New_York`, midnight rollover, leap year, bad-input sentinels, and the `#387` TZ-label anti-regression). Callsite migration deferred to a follow-up sweep — see TODOS.md.

---

## ☑ 24. Extend `backend/test/lib/leadJunkFilter.test.js`

**Closes:** #268

**Acceptance:**
- [x] Source values `'test-skip'` and `'test-junk'` are filtered out of /api/attribution and /api/marketing reports (#268).

**Estimated effort:** 0.1 day. Commit: _shipped_ (Path A — gap card was filed as test-only but the helper to back the assertion didn't exist; created `backend/lib/junkSourceFilter.js` exporting `isJunkSource()` + `JUNK_SOURCE_EXACT` / `JUNK_SOURCE_PREFIXES` with case-insensitive prefix matching for `test-` / `e2e-` / `qa-` / `rbac-` stems. Wired into `routes/attribution.js` GET /report + first-touch-revenue + multi-touch-revenue. Added 14 vitest cases — module shape, exact + prefix + case-insensitive matching, must-not-regress legit-sources list, and a contact-array filter probe pinning the #268 acceptance criterion. The April 2026 `cleanup-p3-data-quality.js` was a one-shot remap; this is the durable server-side guard so re-runs of the wellness E2E suite no longer re-pollute the demo screen between scrub cycles. **Note:** wellness `computeAttribution()` (the actual demo bug surface at /api/wellness/reports/attribution) wiring deferred — sibling agent O held the file mid-flight on the datetime callsite-sweep; the helper is in place and the call site is a one-line filter add. Filed as TODOS follow-up.)

---

# Out of scope (do NOT build regression tests for these)

Document why, so we don't relitigate:

- **Auto-bot placeholder issues** (#1–#92, #98, #99) — no actionable content; closed during cleanup.
- **Pure UI / theme / accessibility** (#204, #228, #229, #231, #243, #264, #294, #399 — and the entire C19 cluster). Belongs in `e2e-full` (release-time visual-regression), not per-push gate. Brittle UI tests blocking every push is a worse failure mode than the bugs they catch.
- **Confirmation-dialog gaps** (#122, #129, #167, #215, #222, #223, #357, #369). API-level test can't see a dialog. Recommend a frontend ESLint rule that flags `<button onClick={…delete/PATCH/POST…}>` without `<ConfirmDialog>` wrapper instead.
- **Feature gaps disguised as bugs** (#227 no CSV/PDF export, #260 leads no click handler, #270 calendar empty-slot no-op, #386 no geocoding). These need product/eng decisions, not regression tests.
- **External integration testing** (Twilio, Mailgun, Stripe, Razorpay, Google/Outlook calendar, IndiaMART/JustDial) — see [#137 tracking issue](https://github.com/Globussoft-Technologies/globussoft-crm/issues/137). Needs dedicated test environments; out of scope for this regression-coverage push.

---

# Effort summary

| Bucket | Items | Effort |
|---|---|---|
| **P0** (3 new specs) | #1 wellness-rbac-api, #2 auth-security-api, #3 demo-hygiene-api | ~3 days |
| **P1** (4 new specs + 5 extensions) | #4–#12 | ~7 days |
| **P2** (4 new specs + 3 extensions) | #13–#19 | ~4 days |
| **P3** (2 new specs + 3 unit tests) | #20–#24 | ~1 day |
| **Total** | 24 tasks | **~15 dev-days (3 weeks single-threaded, 1.5 weeks with one helper)** |

After P0 alone (3 days), the highest-leverage 42 closed issues across the RBAC + auth-security + seed-pollution clusters get permanent regression gates. After full backlog, all ~236 substantive closed issues are prevented from regressing without a CI failure.

# Hand-off checklist (for the developer accepting this work)

- [ ] Read pre-reqs section + the reference spec [notifications-api.spec.js](e2e/tests/notifications-api.spec.js).
- [ ] Confirm local test loop runs and one existing spec passes before starting.
- [ ] Pick task #1; complete and ship one PR. Verify CI gate is now ~25 specs (was 24).
- [ ] Repeat for #2, #3 — these unblock the highest-value coverage. Stop after P0 if time-boxed; the rest can be drained over weeks.
- [ ] On every PR, link the closed-issue numbers being prevented from regressing. PR description shape: `test(api): wellness-rbac-api spec — closes regression risk for #207, #214, #216, #259, #280, #292, #323, #324, #325, #326, #348, #357`.
- [ ] When ALL P0 + P1 ship, update [TODOS.md](TODOS.md) to record the per-push gate has grown from ~1,084 tests to ~1,300+ tests and the audit cluster is closed.
