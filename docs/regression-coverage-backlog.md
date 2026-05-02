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

## ☐ 5. New gated spec: `audit-coverage-api.spec.js`

**Closes:** #134, #167, #179, #180

**Why:** Audit log only records Deal events; compliance/PHI requires full coverage.

**File to create:** `e2e/tests/audit-coverage-api.spec.js`

**Acceptance:**
- [ ] For each mutating endpoint (Contact / Deal / Patient / Invoice / Estimate / Task / Pipeline / Notification — POST / PUT / DELETE), assert AuditLog row exists immediately after with: actor userId + tenantId + entityType + entityId + action.
- [ ] Hard DELETE on Contact/Deal/Estimate/Task emits a `*_DELETED` AuditLog row (#167).
- [ ] Once a logout/revoke endpoint exists, assert it invalidates the JWT (#180 — track but don't gate yet if endpoint not built).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. Commit: ___________

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

## ☐ 10. Extend [wellness-clinical-api.spec.js](e2e/tests/wellness-clinical-api.spec.js)

**Closes:** #114, #118, #159, #160, #170, #178, #194, #195, #197, #205, #213, #220, #224, #265, #401 (15 issues)

**Acceptance:**
- [ ] POST /api/wellness/patients rejects name length > 191 with 400 (NOT 500) — utf8mb4 VARCHAR(191) limit (#220).
- [ ] PUT /api/wellness/patients rejects DOB year < 1900 or > today (#159, #178, #205).
- [ ] POST symmetrically rejects bad email and `<img onerror=...>` payloads (#160, #213).
- [ ] POST /api/wellness/visits rejects status not in enum, dob year > 3000 (#170, #197).
- [ ] POST /api/wellness/visits enforces visit-status state machine (#197).
- [ ] POST /api/wellness/prescriptions requires drugName, dosage, frequency, duration (all non-empty) (#114).
- [ ] POST /api/wellness/consents requires `signatureBase64` non-empty (#118).
- [ ] PUT/PATCH/DELETE exist on /api/wellness/prescriptions, /api/wellness/consents, /api/wellness/recommendations (#194).
- [ ] Recommendation status transitions are constrained — rejected→approved requires audit trail (#195).
- [ ] Encrypted fields are decrypted in the GET response (no `ENC:v1:...` ciphertext leaks) (#224).
- [ ] POST /api/wellness/patients with same normalized phone as existing → 409 DUPLICATE_PHONE (#265, #401 — already shipped, lock it in).

**Estimated effort:** 1 day. Commit: ___________

---

## ☐ 11. Extend [estimates-api.spec.js](e2e/tests/estimates-api.spec.js)

**Closes:** #164, #174, #178, #199, #255, #256, #322, #333, #351

**Acceptance:**
- [ ] qty < 1 rejected (#164, #333, #351).
- [ ] line items count > 200 rejected (#174 — DoS from 5000+ items).
- [ ] validUntil year range 2026..2100 only (#178, #322).
- [ ] totalAmount in response = sum of line totals (#255).
- [ ] Currency string in response uses single symbol per field (#256 — no "$ ₹").
- [ ] Old shape `{name, items}` returns 400 with hint to migrate to `{title, lineItems}` (#199 — backwards-compat shim or hard break is fine, just no 500).

**Estimated effort:** 0.5 day. Commit: ___________

---

## ☐ 12. Extend [reports-api.spec.js](e2e/tests/reports-api.spec.js)

**Closes:** #210, #212, #232, #233, #234, #246, #247, #263, #281, #289, #321 (11 issues)

**Acceptance:**
- [ ] For a fixed date range, sum-of-visits matches across P&L / Per-Pro / Per-Location / Attribution tabs (#232, #281).
- [ ] P&L productCost > 0 when ServiceConsumption rows exist; never overflow > 1e10 (#212, #234, #321).
- [ ] Marketing Attribution shows revenue=0 for sources with 0 leads (#233).
- [ ] Owner Dashboard "today's appointments" == count(/api/wellness/visits?date=today) (#246, #247, #263, #289).
- [ ] Date range with from > to returns 400 (#210).
- [ ] Date range with year > 9999 or < 1900 returns 400 (#210).

**Estimated effort:** 1 day. Commit: ___________

---

# Priority bucket P2 — ship this quarter

## ☐ 13. New gated spec: `services-api.spec.js`

**Closes:** #115, #161, #209, #274, #364

**Acceptance:**
- [ ] POST /api/wellness/services rejects price <= 0 or > 1e7 (#115, #209).
- [ ] POST rejects durationMin <= 0 or > 1440 (24h) (#161, #209).
- [ ] PUT returns 4xx with structured error body (NOT silent 403) (#274).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 0.5 day. Commit: ___________

---

## ☐ 14. New gated spec: `public-booking-api.spec.js`

**Closes:** #208, #218, #219, #279, #283, #291, #297, #378

**Acceptance:**
- [ ] POST /api/wellness/public/book rejects phone < 10 digits (#219).
- [ ] POST rejects date < today or > today + 365 (#219 — was accepting 1900-01-01).
- [ ] POST rate-limited to 10/min per IP (#219).
- [ ] POST returns 201 only when both Patient and Visit rows are persisted (#279).
- [ ] Public service catalog rejects price > 1e8 or duration > 1440 (#218).
- [ ] GET /api/wellness/public/tenant/:slug rejects slugs with spaces/uppercase/specials (#378).
- [ ] /embed/lead-form.html returns 404 for invalid API keys at GET time (not just on submit) (#297).
- [ ] /portal route serves the patient portal, not Knowledge Base (#208).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. Commit: ___________

---

## ☐ 15. New gated spec: `sequences-authoring-api.spec.js`

**Closes:** #374, #375, #376, #394, #395, #396, #397, #398

**Acceptance:**
- [ ] POST /api/sequences with empty/whitespace name → 400 (#395, #396, #398).
- [ ] HTML/JS/SQL/emoji in name → sanitized or 400 (#398).
- [ ] POST without explicit `status: 'ACTIVE'` defaults to DRAFT (#374).
- [ ] Full canvas `{nodes, edges}` round-trips through GET /:id — drip canvas state lives server-side, not browser-only (#394).
- [ ] step.delay accepts only numeric values (#375).
- [ ] Error responses are structured JSON `{error, code, hint}` not raw "Compilation of Drip Array failed." (#395).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 0.5 day. Commit: ___________

---

## ☐ 16. New gated spec: `orchestrator-api.spec.js`

**Closes:** #261, #276, #308, #319, #321

**Why:** [cron/orchestratorEngine.js](backend/cron/orchestratorEngine.js) is in TODOS as the next gate-spec candidate.

**Acceptance:**
- [ ] One day's run produces at most one row per (tenantId, recommendationType) — no duplicates (#261, #308).
- [ ] AgentRecommendation status is exclusive — Pending OR Approved OR Rejected, never overlapping (#308).
- [ ] Reject button writes status=REJECTED and emits AuditLog (#276).
- [ ] Generated text never contains seed-pollution patterns `Lifecycle \d+`, `E2E_`, `Tenant B scoped` (#319).
- [ ] Cost arithmetic doesn't overflow — totals < 1e10 ₹ (#321).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 1 day. Commit: ___________

---

## ☐ 17. Extend [tasks-api.spec.js](e2e/tests/tasks-api.spec.js)

**Closes:** #163, #250, #313

**Acceptance:**
- [ ] dueDate year < 1990 or > 2100 → 400 (#163, #250).
- [ ] status not in enum → 400 (no silent coercion to 'Pending') (#163).
- [ ] dueDate round-trip preserves IST wall-clock — POST `2026-05-15T10:30` (IST) reads back as `2026-05-15T10:30` not `2026-05-15T05:00` (#313).

**Estimated effort:** 0.5 day. Commit: ___________

---

## ☐ 18. Extend [portal-api.spec.js](e2e/tests/portal-api.spec.js)

**Closes:** #238

**Acceptance:**
- [ ] POST /api/wellness/portal/login/verify-otp with wrong code returns 401 (NOT 200 — current spec only has 13 tests, no real OTP-verify check). The "any 4 digits in v1" footgun was the root of the takeover exploit.

**Estimated effort:** 0.25 day. Commit: ___________

---

## ☐ 19. Extend [notifications-api.spec.js](e2e/tests/notifications-api.spec.js)

**Closes:** #169, #185, #327

**Acceptance:**
- [ ] PATCH /api/notifications/:id no longer 404s — works as alias for POST /:id/read (#185).
- [ ] POST broadcast still rejects non-admin with BROADCAST_FORBIDDEN (#169 — verify existing test).
- [ ] No notification body in any tenant feed contains `INJECT TEST` or `Targeted / just user N` (#327 — overlaps with `demo-hygiene-api.spec.js`, fine to assert here too).

**Estimated effort:** 0.25 day. Commit: ___________

---

# Priority bucket P3 — backlog

## ☐ 20. New gated spec: `report-schedules-api.spec.js`

**Closes:** #127, #171

**Acceptance:**
- [ ] External recipient emails validated; arbitrary external domain → 400 with PII_EXFIL_BLOCKED code (#171).
- [ ] reportType + format only accept known enum values (#171).
- [ ] frequency not silently coerced (#171).
- [ ] Invalid email in recipient list rejected on save, not silently saved as Active (#127).

**Estimated effort:** 0.25 day. Commit: ___________

---

## ☐ 21. New gated spec: `landing-pages-api.spec.js`

**Closes:** #378

**Acceptance:**
- [ ] POST /api/landing-pages slug field accepts only `[a-z0-9-]+` (#378).
- [ ] Wired into deploy.yml + coverage.yml.

**Estimated effort:** 0.25 day. Commit: ___________

---

## ☐ 22. New unit test: `backend/test/utils/formatMoney.test.js`

**Closes:** #189, #198, #242, #243, #256, #286, #330

**Acceptance:**
- [ ] INR formatting: `formatMoney(310, 'INR', 'en-IN')` → `'₹310.00'`.
- [ ] USD formatting: `formatMoney(3.73, 'USD', 'en-US')` → `'$3.73'`.
- [ ] Sub-paise rounded to 2dp: `formatMoney(123.456789, 'INR')` → `'₹123.46'`.
- [ ] Never produces double symbols `$ ₹` or `₹ $`.
- [ ] On wellness/INR tenant, no path produces `$` (#286, #330).

**Estimated effort:** 0.25 day. Commit: ___________

---

## ☐ 23. New unit test: `backend/test/lib/datetime.test.js`

**Closes:** #244, #313, #387

**Acceptance:**
- [ ] datetime-local input `'2026-05-15T10:30'` with tenant TZ Asia/Kolkata stores as UTC `'2026-05-15T05:00:00Z'` and reads back as `'2026-05-15T10:30'` (#313).
- [ ] Visit timestamps render in tenant TZ, not UTC (#244).
- [ ] AuditLog timestamps include TZ label (#387).

**Estimated effort:** 0.25 day. Commit: ___________

---

## ☐ 24. Extend `backend/test/lib/leadJunkFilter.test.js`

**Closes:** #268

**Acceptance:**
- [ ] Source values `'test-skip'` and `'test-junk'` are filtered out of /api/attribution and /api/marketing reports (#268).

**Estimated effort:** 0.1 day. Commit: ___________

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
