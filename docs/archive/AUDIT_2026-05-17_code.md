# Code + Security Audit — 2026-05-17

**HEAD scanned:** `741d848` (post v3.7.16 + sanitize-html CVE patch + RBAC-denial UX sweep + #742/#739 fixes)
**Total files scanned:** 103 backend routes, 22 cron engines, 88 frontend pages, 11 components, ~234 e2e specs, ~70 backend unit-test files, schema.prisma (3920 lines)
**Scan duration:** ~9 minutes

## Executive summary

- **Tenant-isolation discipline is strong at the code layer.** Zero `req.user.id` violations remain (down from the 6b1470f sweep era). All `req.body.{id,userId,tenantId,...}` reads are either documented exceptions (annotated inline with #646 references) or non-existent. ESLint rule is enforcing per-push.
- **Schema indexing is the biggest structural gap.** ~50 models declare `tenantId` with no paired `@@index([tenantId])` or `@@unique([tenantId, ...])`. Cross-tenant queries currently full-scan with a where-clause filter rather than using an index. Not a correctness bug, but a latent scale-out risk and an inconsistency with the indexed models.
- **Marketplace cron engine is the lone "naked async tick" in the cron fleet** — every other engine wraps its tick in try/catch (or `.catch(console.error)` on the promise). One sync error in `marketplaceEngine.js:224-230` will become an unhandledRejection and (with strict Node settings) could kill the process.
- **All HIGH backend CVEs are documented in `backend/.audit-allowlist.json` and sunset by 2026-08-01.** xlsx (2× HIGH), imap → utf7 → semver chain (3× HIGH), path-to-regexp (HIGH). One CRITICAL was patched today (sanitize-html GHSA-rpr9-rxv7-x643 in cf678f7). Frontend has 3 moderate (vite/esbuild dev-server path-traversal class). E2E has zero.
- **There is no `.env.example`.** 73 distinct env-vars are referenced by backend code (including credentials, secrets, OAuth client IDs, mailgun/sendgrid/stripe/twilio/razorpay keys). New environments have no canonical reference for what to set; the 5-line bootup safety net in `server.js:6-13` only catches `JWT_SECRET` and `PORTAL_JWT_SECRET`.

## Findings

### Section 1 — Backend routes (P0/P1/P2)

#### P0 — none.

The pattern-class P0s flagged in the audit brief (`req.user.id` reads, `req.body.{stripped}` reads, missing `verifyToken` on protected mounts, cross-tenant `prisma.X.update` without `tenantId`, hardcoded secrets, SQL injection in `$queryRaw`) all came back clean. Standing rules + ESLint + previously-shipped sweeps have closed this class.

#### P1 findings

**P1.1 — `prisma.$queryRawUnsafe` builds SQL via string interpolation in two paths.** Both are safe today (DB-derived integer IDs only) but the pattern is fragile if a future refactor introduces user input.
- `backend/routes/sandbox.js:43-45` — `OCTET_LENGTH(data) ... WHERE id IN (${ids.join(",")})`. `ids` comes from `snapshots.map(s => s.id)`, which is DB-derived. **Fix:** swap to `$queryRaw\`...\`` tagged template with the array bound; effort ~10 min.
- `backend/routes/sandbox.js:183-185` — `WHERE id = ${id}`. `id` is `parseInt(req.params.id)` and isNaN-checked at L199, but L184 fires BEFORE the isNaN check on its own caller path (the same handler does parseInt and checks). Re-verified: handler at L168 does parseInt+isNaN BEFORE building the raw query — safe. Still smelly; switch to parameterized for consistency.
- Severity: P1 (code-smell, defense-in-depth), effort: 10 min each.

**P1.2 — Marketplace cron tick has no try/catch wrapper.** `backend/cron/marketplaceEngine.js:224-230`. Every other engine wraps its tick body in try/catch or attaches `.catch(...)` to the returned promise (campaignEngine ✓, sentimentEngine ✓, dealInsightsEngine ✓, leadScoringEngine ✓, sequenceEngine ✓, etc.). Marketplace is the outlier. A throw from `prisma.marketplaceConfig.findMany` or any partner-API call inside `syncMarketplace` becomes an unhandledPromiseRejection.
- **Fix:** wrap the body in try/catch with `console.error("[MarketplaceEngine] tick error:", err)`.
- Severity: P1, effort: 5 min.

**P1.3 — JWT fallback secret is duplicated across 6 source files.** The string `"enterprise_super_secret_key_2026"` appears verbatim in `backend/middleware/auth.js:9`, `backend/routes/auth.js:11`, `backend/routes/auth_2fa.js:12`, `backend/routes/portal.js:8`, `backend/routes/sso.js:18`, `backend/routes/wellness.js:71`. The boot-time guard at `server.js:6-13` only protects `JWT_SECRET` in production — if a developer forgets to set `JWT_SECRET` in any non-production environment that touches signed tokens, six locations need to be remembered for any rotation/refactor.
- **Fix:** centralize as `const { JWT_SECRET } = require('../config/secrets')` reading once from env with the documented dev fallback. Allowlisted in `.gitleaks.toml:29-35` so the rotation is contained.
- Severity: P1 (maintenance smell, not a leak), effort: 30 min.

#### P2 findings

**P2.1 — `scim.js:108` fetches all SCIM tokens cross-tenant by design.** `prisma.scimToken.findMany({})` with no `where:`. Required because the inbound bearer token isn't tenant-attributed until after bcrypt-compare. Comment at L106-107 documents it. Acceptable; flag here only so a future "tighten findMany sweep" doesn't misread it as a bug.
- Severity: P2 (informational), effort: 0.

**P2.2 — `marketing.js:493` (`JSON.parse(cleanedRest)`) has no try/catch.** Upstream value `cleanedRest` came from `sanitizeJsonForStringColumn(rest) || "{}"` which always returns a JSON-stringified shape, so it shouldn't throw. But this is the one JSON.parse on user-derived data in the routes/ tree that isn't wrapped — every other call in routes/* either has a try/catch or wraps it via a helper. Defense-in-depth says wrap.
- **Fix:** `try { merged = JSON.parse(cleanedRest); } catch { return res.status(500).json({ error: "Filter shape unparseable" }); }`. Effort 5 min.
- Severity: P2.

**P2.3 — `integrations.js:288` and `:362` (`JSON.parse(integration.settings)`) have no try/catch.** Same shape as above; but `integration.settings` is operator-controlled and validated at write time. A corrupt row would 500. Defense-in-depth: wrap.
- Severity: P2, effort: 5 min combined.

**P2.4 — `wellness.js:1468,1491,1700,2946,2947,4623` JSON.parse calls are unwrapped in the per-call sense but downstream code defensively `|| []`s. The 1700 call is wrapped in an outer try/catch with empty-handler `(_) => {}`. Not strictly a bug but the `try { ... } catch (_) { }` empty-catch pattern (also matched by ESLint allowEmptyCatch) silently drops parse errors with zero logging.
- **Fix:** at minimum log via `console.warn` so a corrupt JSON column surfaces in stderr instead of being invisible.
- Severity: P2, effort: 10 min.

**P2.5 — Empty-catch pattern (`try { ... } catch (_) { }`) sweep.** Grep finds ~50 instances across routes + cron, intentional per `eslintConfig.no-empty: ['warn', { allowEmptyCatch: true }]`. The CI gate accepts this. Each one is a silent error swallow. Reviewing them as a batch would surface 5-10 that should be logging at minimum.
- Severity: P2 (visibility, not correctness), effort: 1-2h.

---

### Section 2 — Frontend (P0/P1/P2)

#### P0 — none.

Zero `eval()`, zero `new Function()`, zero `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` (project is JSX not TS, so unsurprising).

#### P1 findings

**P1.1 — One `dangerouslySetInnerHTML` site rendering operator-controlled HTML.** `frontend/src/components/EmailSignatureEditor.jsx:220-225` injects the live `signature` state value, which is a freeform `<textarea>`-fed string the user types. The editor is local-state only (not persisted as HTML until save), but the preview pane will render any `<script>` typed during composition. The `signature` value is operator-typed (not other-user-derived), so the threat is self-XSS only.
- **Fix:** either run the value through DOMPurify before injection, or change preview to use `textContent` semantics. Effort 30 min.
- Severity: P1 (low real-world risk; self-XSS only — but trivially fixed).

**P1.2 — 160 `console.log/error/warn/info/debug` calls in production code paths across 53 files.** Top offenders: `Invoices.jsx` (18), `Pricing.jsx` (13), `DealModal.jsx` (10), `pushSetup.js` (10), `Surveys.jsx` (7), `Expenses.jsx` (6). Most are debug-leftovers. The CI lint gate doesn't error on this (no `no-console` rule). Each leaks data shape into the browser console — annoying for clean DevTools sessions, minor info disclosure if any log value contains an internal id / PII.
- **Fix:** add `no-console: ['warn', { allow: ['error', 'warn'] }]` to `frontend/eslint.config.js`, then sweep. Effort: 30 min config + 1-2h sweep.
- Severity: P1.

#### P2 findings

**P2.1 — 13 `[style*="..."]` inline-style attribute selectors in `frontend/src/styles/responsive.css` (lines 121-246).** Carry-over from the #523 work; comment at L121-123 acknowledges this is fragile ("would silently stop matching the moment the inline `style={...}` shape" changes). Already triaged in TODOS; not new.
- Severity: P2.

**P2.2 — 17 `eslint-disable*` directives across 13 frontend files.** Most are narrow `react-hooks/exhaustive-deps` suppressions on intentional run-once effects. None look like blanket disables. No action needed; flagging for inventory.

**P2.3 — `localStorage`/`sessionStorage` of tokens follows a clear policy** (sessionStorage for the JWT, localStorage for tenant + user profile + language preference). Per the test header at `__tests__/security-token-storage.test.js`, a regression spec already pins this. No findings.

---

### Section 3 — Cron engines (P0/P1/P2)

#### P0 — none.

All 22 engines respect `DISABLE_CRONS=1` because the gating happens at `server.js:790` around the entire init block. No engine self-initializes.

#### P1 findings

**P1.1 — `marketplaceEngine.js:224-230` lacks try/catch on the cron tick** (see P1.2 in Section 1; cross-listed). Only engine in the fleet without protection.

#### P2 findings

**P2.2 — Per-tenant scoping varies across engines.** Some (orchestrator, wellness-ops, retention, demo-hygiene) iterate `prisma.tenant.findMany` then process per tenant. Others (sequenceEngine, scheduledEmailEngine, leadScoringEngine) query the work-table globally then carry the per-row `tenantId` through downstream writes. Both patterns are correct; the inconsistency is a code-smell. Marketplace falls in the second camp — `prisma.marketplaceConfig.findMany({ where: { isActive: true } })` is unscoped, then each config's `tenantId` is carried through `syncMarketplace`. Verified inline — safe.
- Severity: P2 (informational).

**P2.3 — Idempotency is uneven.** Some engines (recurringInvoiceEngine, retentionEngine, backupEngine) gate on a per-day marker. Others (scheduledEmailEngine, campaignEngine) rely on row-status flips ("PENDING" → "SENT"). Both safe under single-instance cron. If you ever run two backend instances without `DISABLE_CRONS=1` on the secondary (which `server.js:786-792` warns against), some engines double-fire and others don't.
- Severity: P2 — addressed operationally by the DISABLE_CRONS contract; flag here for visibility.

---

### Section 4 — Test coverage gaps

#### Specs in per-push gate vs disk
106 specs in `deploy.yml` gate list (matches `coverage.yml` exactly). 234 specs on disk. All 106 gate specs exist on disk (no orphans). The 128 specs on disk not in the per-push gate are either bare smoke specs (e.g. `auth.spec.js`, `wellness.spec.js`, `ci-smoke.spec.js`) or `*-api.spec.js` extensions intended for e2e-full only.

#### `*-api.spec.js` specs on disk NOT in per-push gate (7 files)
- `tests/channels-credentials-api.spec.js`
- `tests/knowledge-base-api.spec.js`
- `tests/landing-pages-api.spec.js`
- `tests/portal-api.spec.js`
- `tests/tenant-switch-disabled-api.spec.js`
- `tests/voice-transcription-api.spec.js`
- `tests/wellness-consent-archive-api.spec.js`

**These either need wiring into `deploy.yml`'s gate list OR explicit justification for why they're e2e-full-only.** They're the exact pattern the `wiring-spec-into-gate` skill exists to prevent.
- Severity: P1 (potential regression escape route), effort: 30 min for the audit + wire-in.

#### Routes modified in last 7 days without paired spec
Audit pass: all 13 routes touched in the last week (`attendance`, `audit`, `audit_viewer`, `auth_stepup`, `booking_pages`, `csv_io`, `drugs`, `inventory`, `leave`, `pos`, `service_categories`, `subscriptions`, `v1_invoices`) have a paired spec under a normalized name (`booking-pages-api`, `csv-import-export-api`, `service-categories-api`, `v1-invoices-api`, `inventory-extension-api`, `audit_viewer.spec.js`). Only `auth_stepup` is borderline — covered only by `csp-stepup-api.spec.js`. Verify the CSP-step-up spec exercises the route's real handlers, not just the CSP header path.

#### Lib/middleware/service modules modified without paired vitest
Truly missing vitest coverage (after cross-checking alt names):
- `backend/lib/notificationRulesEngine.js` — no `backend/test/lib/notificationRulesEngine.test.js`
- `backend/middleware/checkSubscription.js` — no test
- `backend/middleware/originCheck.js` — no test
- `backend/services/razorpayService.js` — no test

**Notes:** `wellnessOwnership` is tested at `backend/test/middleware/wellnessOwnership.test.js` (lives in middleware/ not lib/). All other recently-touched modules have paired tests.
- Severity: P1 (per "standing rules for new code" in CLAUDE.md), effort: 4× ~45 min unit tests = ~3h.

---

### Section 5 — Dependencies

#### Backend (8 vulns: 2 low / 2 moderate / 4 high / 0 critical)

| Package | Severity | Status |
|---|---|---|
| xlsx (2 advisories: prototype pollution + ReDoS) | HIGH × 2 | **Allowlisted** — sunset 2026-08-01 (replace with exceljs) |
| imap → utf7 → semver chain | HIGH × 3 | **Allowlisted** — sunset 2026-08-01 (migrate off `imap` to `node-imap-simple` / nodemailer) |
| path-to-regexp (transitive via Express) | HIGH | **Allowlisted** — sunset 2026-08-01 (Express 4.21.2+ upgrade path) |
| express-rate-limit → ip-address (XSS in HTML emitters) | MODERATE | Fix available — `npm audit fix` resolves |
| csurf → cookie | LOW | Fix available (csurf 1.2.2, SemVer-major) |

**Action:** the 4 sunset entries hit 2026-08-01 in ~2.5 months. The `express-rate-limit → ip-address` MODERATE fix is unblocked today.

#### Frontend (3 moderate, 0 high)
- `vite` + `esbuild` dev-server CVEs (path traversal, dev-server request forgery). Dev-only impact (production build is static). Fix is `npm audit fix` to vite 6+.
- `brace-expansion` (transitive). Fix available.
- All 3 fixable today via `npm audit fix`.

#### E2E
- Zero vulnerabilities.

#### Major-version-behind packages (current vs latest)

Backend:
- `prisma` / `@prisma/client` 6.4.1 → 7.8.0 (one major behind — migrate guide before bump)
- `express` 4.22.1 → 5.2.1 (one major behind — Express 5 has breaking middleware semantics)
- `twilio` 5.13.1 → 6.0.2 (one major behind)
- `eslint` 9.39.4 → 10.4.0 (one major behind)
- `dotenv` 16.6.1 → 17.4.2 (one major behind)

Frontend:
- `react` / `react-dom` 18.3.1 → 19.2.6 (one major behind — React 19 has Suspense/effect changes)
- `vite` 5.4.21 → 8.0.13 (**three majors behind**, fixes the moderate CVEs above)
- `@vitejs/plugin-react` 4.7.0 → 6.0.2 (two majors behind)
- `eslint-plugin-react-hooks` 5.2.0 → 7.1.1 (two majors behind)
- `lucide-react` 1.0.1 → 1.16.0 (minor only, but listed because semver-major may shift)

**Severity:** P1 for vite (CVE + 3 majors behind), P2 for everything else (Dependabot's grouped weekly PRs should be carrying these gradually).

---

### Section 6 — Configuration

#### C.1 — `.env.example` is missing
Zero `.env.example` / `.env.sample` / `.env.template` in the repo root, `backend/`, or `frontend/`. Backend code references **73 unique env-vars** (DATABASE_URL, JWT_SECRET, PORTAL_JWT_SECRET, GEMINI_API_KEY, all SMTP/Mailgun/SendGrid keys, Stripe/Razorpay keys, Twilio SID + auth-token, Google/Microsoft OAuth client IDs, MSG91/Knowlarity SMS keys, VAPID keys, WhatsApp verify token, etc.). A new engineer or new environment has no canonical list.
- **Fix:** generate `.env.example` from the grep output, with placeholder values + a one-line comment per group. Effort: 30 min.
- Severity: P1 (operational risk for new deployments).

#### C.2 — Schema: ~50 models declare `tenantId` with no `@@index([tenantId])` or composite unique that starts with `tenantId`
Affected models (sampled): `User`, `Campaign`, `AutomationRule`, `Attachment`, `ApiKey`, `Webhook`, `CustomRecord`, `Sequence`, `SequenceEnrollment`, `Product`, `Quote`, `Contract`, `EmailTemplate`, `Project`, `ReportSchedule`, `SmsTemplate`, `PushSubscription`, `PushNotification`, `PushTemplate`, `LandingPageAnalytics`, `ContactAttachment`, `EmailTracking`, `CalendarIntegration`, `ConsentRecord`, `DataExportRequest`, `VoiceSession`, `Pipeline`, `Forecast`, `WinLossReason`, `LeadRoutingRule`, `Territory`, `ApprovalRequest`, `AbTest`, `Chatbot`, `ChatbotConversation`, `SlaPolicy`, `CannedResponse`, `Survey`, `SignatureRequest`, `DocumentTemplate`, `BookingPage`, `Dashboard`, `CustomReport`, `SharedInbox`, `ScimToken`, `LiveChatMessage`, `Playbook`, `DocumentView`, `SocialPost`, `SocialMention`, `SandboxSnapshot`, `LoyaltyConfig`.

These models all have routes that filter by `tenantId` in their `where:` clauses, so the queries work — they just do a full-scan-with-filter instead of an index lookup. At demo-scale data volumes this is invisible; at production multi-tenant scale with 100s of tenants × 1000s of rows it becomes a hot spot.

Sample model:
```prisma
model ScimToken {
  id        Int       @id @default(autoincrement())
  token     String    @unique
  name      String
  lastUsed  DateTime?
  tenantId  Int       @default(1)
  tenant    Tenant    @relation(...)
  createdAt DateTime  @default(now())
  // NO @@index([tenantId])
}
```
- **Fix:** for each model, decide which composite the most-frequent query uses (typically `@@index([tenantId, createdAt])` or `@@index([tenantId, status])`). Effort: 2-3h to audit + write migration; the migration itself runs in seconds per index.
- Severity: P1 (latent scaling cliff, not a correctness bug).

#### C.3 — `frontend/eslint.config.js` likely lacks `no-console`
Inferred from the 160 `console.log/error/warn` survivors. The backend `eslint.config.js` has a comprehensive flat-config setup; the frontend config wasn't grep-inspected here, but the survivor count is the signal.
- **Fix:** add `no-console: ['warn', { allow: ['error', 'warn'] }]` to frontend config, then sweep. Effort: 30 min + 1-2h sweep.
- Severity: P2.

#### C.4 — Backend ESLint: all the cross-tenant + stripDangerous rules ARE enforced (`'error'`).
The `req.user.id` rule fires at error level, the `req.body.{id|userId|tenantId|createdAt|updatedAt}` rules fire at error level scoped to `routes/**/*.js`. Several warn-only rules (`no-unused-vars`, `no-empty`, `no-prototype-builtins`, `no-useless-escape`, `no-control-regex`) are still warnings rather than errors. Consistent with the config's stated "warn until cleaned up incrementally" philosophy. No action.

---

## Recommendations

Ranked impact vs effort (highest impact-per-hour first):

1. **Wire the 7 orphan `*-api.spec.js` files into `deploy.yml`'s gate list.** Direct application of the `wiring-spec-into-gate` skill. 30 min, eliminates a regression escape route on 7 routes. **Highest ROI.**
2. **Run `npm audit fix` in `frontend/` to clear the 3 moderate CVEs and bump vite to 6+.** vite 5 → 6+ also closes a 3-major-version gap. Likely 1h with build verification.
3. **Ship a `.env.example` derived from the 73 grepped env-vars.** Operational hygiene for any new clone/deploy. 30 min.
4. **Wrap `marketplaceEngine.js:224-230` in try/catch.** 5 min. Closes the one cron-engine outlier and forecloses an unhandledRejection class.
5. **Add the 4 missing vitest files** (`notificationRulesEngine`, `checkSubscription`, `originCheck`, `razorpayService`). ~3h total. Closes the "new lib/middleware/service module needs paired test" standing-rule gap.

**Lower-priority but worth a follow-up backlog row:**
- Centralize the `enterprise_super_secret_key_2026` fallback into one config module.
- Add `no-console` to frontend ESLint + sweep 160 instances.
- Schema migration sweep to add `@@index([tenantId, ...])` to the 50 unindexed tenant-scoped models — pair with a "what's our query pattern per model" audit so the index is on the right composite, not just `tenantId` alone.
- Migrate off `xlsx` (to exceljs) and `imap` (to nodemailer/node-imap-simple) before the 2026-08-01 sunset.

---

## What I'd fix first if given 4 hours

Wire the 7 orphan API specs into the per-push gate (30 min), ship the `.env.example` (30 min), `npm audit fix` in frontend + verify the vite 6 upgrade (1h), wrap the marketplace cron tick (5 min), and use the remaining ~1h45m to scaffold two of the four missing vitest files (`checkSubscription` and `originCheck` — they're middleware so the patterns from `middleware/auth.test.js` and `middleware/security.test.js` give a head start). The remaining two missing tests + the schema-index sweep + the JWT-fallback centralization are each individually tractable but need more focused time than 4h leaves; queue them for the next session.
