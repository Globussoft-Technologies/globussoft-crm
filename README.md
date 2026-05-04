# Globussoft Enterprise CRM

> A full-stack enterprise CRM built by Globussoft Technologies. **102 API routes, 110 data models, 90+ UI pages, 16 automation engines.** Multi-tenant with vertical configurations (generic / **wellness**). Tenant-driven currency + locale. External partner API for sister products (Callified.ai, AdsGPT). Embeddable lead-capture widget. AI orchestration engine. **GitHub Actions CI/CD** with **5 mandatory deploy gates** (build / lint / api_tests / unit_tests / migration_check) + commit-message blessings (`[allow-unique]` etc.) for legitimate-but-flagged schema changes + auto-rollback on health-check fail + 30-min demo health-monitor cron. **Mobile-responsive** sidebar drawer + 6 demo-path pages. **~3,437 tests on every push** (~2,442 Playwright + 995 vitest); release-validation full chromium suite on every tag. **8 reusable Claude Skills** + **live agent-activity widget** at /developer for parallel-wave visibility. `docs/gaps/archive/` convention for fully-closed gap-files.

**Live:** [crm.globusdemos.com](https://crm.globusdemos.com) | **Version:** v3.4.6
**Wellness vertical docs:** [docs/wellness-client/](docs/wellness-client/) | **Partner API docs:** [EXTERNAL_API.md](docs/wellness-client/EXTERNAL_API.md) | **Embed widget docs:** [EMBED_WIDGET.md](docs/wellness-client/EMBED_WIDGET.md) | **API namespacing rules:** [API_NAMESPACING.md](docs/API_NAMESPACING.md) | **Cross-project monitor patterns:** [DEMO_MONITOR_PATTERN.md](docs/DEMO_MONITOR_PATTERN.md) + [LIVE_MONITOR_PATTERN.md](docs/LIVE_MONITOR_PATTERN.md)
**Engineering backlog:** [TODOS.md](TODOS.md) — read this before picking up new work. **QA prompts:** [QA_README.md](docs/QA_README.md) (wellness + generic split).

## What's new in v3.4.6 (May 4 2026 — wellness.js split complete + #425 allowlist + #413 batch 2)

A wave-18 continuation. **No new product features**; this release closes the three-way wellness.js split (G-17 + G-18 + G-19 all ✅ — the 4,050-line / 41% coverage file is now exercised by 146 dedicated tests across 3 specs), adds the G-23 commit-message allowlist (#425), and ships the second batch of #413 schema-relation hygiene.

- **G-17 wellness-dashboard-api**: 40 tests / 14.4s. 5 endpoints; full-shape pinning of dashboard payload (today/yesterday/pendingApprovals/30d revenueTrend/totals/activeTreatmentPlans); state-machine assertions on recommendations approve/reject (idempotency + cross-state 422 INVALID_RECOMMENDATION_TRANSITION); RBAC + tenant-vertical gates.
- **G-18 wellness-reports-api**: 76 tests / 20.3s. 12 endpoints (4 JSON tabs + 8 export siblings); CSV pins UTF-8 BOM + CRLF + attachment disposition; PDF pins `%PDF-` magic + Content-Length match; #233 zero-leads-zero-revenue attribution invariant locked. Route uses `.csv`/`.pdf` path suffixes (not `?format=`).
- **#425 G-23 allowlist**: commit-message markers (`[allow-unique]` / `[allow-drop]` / `[allow-not-null]` / `[allow-narrow]`) skip the corresponding migration-safety detector for THIS commit only. Cross-class isolated — `[allow-unique]` does NOT bless other classes. 16 vitest + 4 playwright tests covering the un-blessing path + isolation invariants.
- **#413 batch 2** (10 more `@relation` declarations, drift 39 → 29): Security/Auth (RevokedToken, ScimToken, SsoConfig); Integration/Sales (Pipeline, Playbook, BookingPage); RBAC/Compliance/Sandbox (FieldPermission, RetentionPolicy, ApprovalRequest, SandboxSnapshot). All use `onDelete: Cascade` explicitly. Issue stays open for batch 3 (calendar + scheduled-email cluster).

**Zero healing commits this wave** — wave 16 had 3, wave 17 had 0, wave 18 had 0. Discipline improvements that helped: discovery-first spec authoring (against actual route source, not prompt assumptions), pinning `code:` fields rather than regex on prose error messages, stash/pop concurrency etiquette across agents.

Per-push gate is now **~69 specs / ~2,442 tests + 37 vitest files / 995 unit tests = ~3,437 tests on every push** (+4% vs v3.4.5).

See [CHANGELOG.md](CHANGELOG.md#v346--2026-05-04--wellnessjs-split-complete-g-17--g-18--g-19-all---425-g-23-allowlist--413-batch-2-drift-39--29) for the full v3.4.6 entry.

## What's new in v3.4.5 (May 4 2026 — autonomous-orchestrator continuation: 4 issues closed, 4 E2E_GAPS rows shipped, schema invariant drift 49 → 39)

A direct continuation of v3.4.4. **No new product features**; this release lands four medium-effort gap closures plus four bug fixes plus the first batch of #413 schema-relation hygiene plus the `docs/gaps/archive/` convention.

- **4 E2E_GAPS rows shipped ✅**: G-19 wellness-telecaller-api (30 tests), G-22 Stripe webhook integration tier (11 tests, first **msw + supertest** test tier), G-23 migration safety check (10 tests + 5 detectors + new 5th deploy gate), plus the off-backlog non-numeric `:id` sweep spec (17 tests, 9 routers).
- **4 GitHub issues closed**: #421 leadScoringEngine (per-tenant iteration + recompute window via new `Contact.aiScoreLastComputedAt` column + `Promise.allSettled`), #422 email_threading (archive persistence + pagination + tenantId rejection), #423 non-numeric `:id` 500 sweep (`backend/middleware/validateNumericId.js` mounted via `Router` factory monkey-patch), #424 CalendarEvent.@@unique missing tenantId.
- **#413 batch 1 (10 of 49)**: Payment, AccountingSync, Forecast, Quota, Currency, DealInsight, PatientOtp, ConsentRecord, DataExportRequest, SignatureRequest gain `tenant Tenant @relation`. G-24 schema-invariant drift counter dropped 49 → 39.
- **`docs/gaps/archive/` convention** introduced for fully-closed gap-files; pointers in CLAUDE.md + TODOS.md so future sessions discover it.
- **6 healing commits resolved cascading test-shape regressions**: vitest's mock-Prisma masked a phantom-column bug in #421 (caught only when real Prisma in CI rejected `Contact.updatedAt`); 6 pre-existing specs had route-specific regex like `/invalid invoice id/i` that the generic middleware error didn't match — all migrated to pin `code: 'INVALID_ID'`.
- **#425 filed for follow-up**: G-23 migration safety check needs an allowlist mechanism for blessed UNIQUE/DROP additions. Surfaced when #424's strictly-more-permissive unique-addition tripped the `UNIQUE_ADDITION` detector. Recommend `[allow-unique]` commit-message marker (~1h fix).

Per-push gate is now **~67 specs / ~2,326 tests + 36 vitest files / 979 unit tests = ~3,305 tests on every push** (+13% vs v3.4.4) with **5 mandatory deploy gates** (added `migration_check` to the existing build/lint/api_tests/unit_tests four).

See [CHANGELOG.md](CHANGELOG.md#v345--2026-05-04--autonomous-orchestrator-continuation-4-issues-closed-4-e2e_gaps-rows-shipped-schema-invariant-drift-49--39) for the full v3.4.5 entry.

## What's new in v3.4.4 (May 3 2026 — autonomous-orchestrator session: G-20 tenant-isolation flagship + 7 reusable Skills + live agent-activity widget)

A single autonomous-orchestrator session that landed 43 commits across three parallel waves (12 + 9 + 8 resources), the first cohort of reusable Claude Skills, and end-to-end visibility into the wave system itself.

- **G-20 tenant-isolation flagship** — new `tenant-isolation-api.spec.js` covers **29 resources / 93 cross-tenant assertions** across 3 waves (deals/contacts/leads/tasks; wellness FK chain Patient→Visit→Rx→Consent→TreatmentPlan; admin surfaces audit/notifications/email-templates/scheduled-emails; rename-on-cleanup pattern for no-DELETE resources). Per-push gate now **~64 specs / ~2,237 tests** + 35 vitest files / 677 unit tests = **~2,914 tests on every push** (+18% vs v3.4.3).
- **7 reusable Claude Skills** under `.claude/skills/` — Tier 1 (`writing-api-gate-spec`, `wiring-spec-into-gate`, `writing-vitest-unit-test`) + Tier 2 (`adding-admin-trigger-endpoint`, `bumping-version-docs`, `dispatching-parallel-agent-wave`) + the visibility skill (`reporting-agent-progress`). Each captures standing rules + bundled templates so parallel agents stop re-deriving conventions every wave. `wiring-spec-into-gate/wire-in.sh` is idempotent + accepts `tests/foo.spec.js` or `foo.spec.js`.
- **Live agent-activity widget** at `/developer` — backend `GET/POST /api/developer/agent-activity` (admin-only, JSONL-backed) + 3-second polling React widget. Background agents now log start / milestone / commit / done events via `.claude/skills/reporting-agent-progress/log.sh`; user can watch waves in real time instead of waiting for the final report.
- **5 audit-followup bug fixes** closed: #412 Campaign schedules persist in DB (was in-memory global, lost on restart); #416 backup engine respects `MYSQLDUMP_BIN` strictly; #417 backup engine uses spawn pipe to observe both exit codes; #418 `routes/workflows.js` adds GET /:id; #419 `routes/custom_objects` widens to existing `String` vocabulary + adds GET/PUT/DELETE /:id; #420 wellness treatments consolidated → single `/treatment-plans` canonical path.
- **R-4 medium-route batch** — 4 new gate specs: attribution-api (POST /track + report + revenue models), document-templates-api (42 tests, full CRUD + render), email-threading-api (33 tests across 8 endpoints), booking-pages-api wired in.
- **R-5 batch 2 vitest** — 5 new unit-test files: `cron/forecastSnapshotEngine`, `cron/leadScoringEngine`, `cron/sentimentEngine`, `cron/slaBreachEngine`, plus the schema invariants suite already shipped in v3.4.3.
- **T2.1 mobile sidebar drawer** — overlay + backdrop at <900px breakpoint with focus-trap; closes one of the two T2.x mobile follow-ups.
- **3 contract-drift findings filed**: #421, #422, #423 — surfaced by the new R-4 specs, queued for separate planning passes.

See [CHANGELOG.md](CHANGELOG.md#v344--2026-05-03--autonomous-orchestrator-session-g-20-tenant-isolation-flagship--7-reusable-skills--live-agent-activity-widget) for the full v3.4.4 entry.

## What's new in v3.4.3 (May 3 2026 — eight-agent parallel wave: 6 more gate specs + 6 unit-test files + 2 engine fixes + 2 spec cleanups)

A single-day continuation of v3.4.2 where 8 parallel agents shipped 14 commits in one wave.

- **6 new gate specs**: G-12 campaign-engine, G-13 deal-insights-engine, G-15 backup-engine (with PII-safety check on dump contents), R-1 trio (ab_tests, accounting, canned_responses). Per-push gate now **50 specs / ~1,665 tests** + 30 vitest files / 803 unit tests = **~2,468 tests on every push**.
- **2 contract-drift fixes** (closes #410 + #411): `recurringInvoiceEngine` now excludes both `VOID` and `VOIDED`; `retentionEngine` writes AuditLog regardless of deletion count.
- **6 new vitest unit-test files**: `lib/prisma`, `lib/sentry`, `cron/recurringInvoiceEngine`, `cron/retentionEngine`, `cron/wellnessOpsEngine`, `cron/appointmentRemindersEngine`, plus `schema/schema-invariants` (G-24 schema-level data-leak guard with revert-and-prove verification).
- **2 spec-discipline cleanups**: B3 wellness-journeys (sessionStorage admin shadow, NOT tab drift); wellness-clinical-api Location rename (`_teardown_wc_loc_*` so demo-hygiene's regex misses).
- **Bonus infra fix**: `vitest.config.js` `cron/` `deps.inline` gap was silently blocking ALL cron-engine unit tests; now fixed.
- **Schema findings worth follow-up**: 49 models have `tenantId` without formal `@relation`; `MarketplaceLead.@@unique([provider, externalLeadId])` doesn't include `tenantId` (could prevent cross-tenant imports of same lead).

See [CHANGELOG.md](CHANGELOG.md#v343--2026-05-03--eight-agent-parallel-wave-6-more-gate-specs--6-unit-test-files--2-engine-fixes--2-spec-cleanups) for the full v3.4.3 entry.

## What's new in v3.4.2 (May 3 2026 — six more gate specs + four new admin trigger endpoints + portable monitor-pattern docs)

Continuation of the same-day v3.4.0 / v3.4.1 arc.

- **Six new gate specs**: G-7 wellness-ops, G-9 recurring-invoice, G-10 scheduled-email, G-11 retention-engine, G-14 forecast-snapshot, G-16 whatsappProvider vitest. Per-push gate now ~37 specs / ~1,525 tests + 23 vitest files / 700 unit tests = **~2,225 tests on every push**.
- **Four new admin-gated trigger endpoints** added to make the corresponding cron engines manually invocable + deterministically testable: `POST /api/forecasting/snapshot/run`, `POST /api/billing/recurring/run`, `POST /api/email/scheduled/run`, and `POST /api/gdpr/retention/run` (the GDPR one carries an additional `confirmDestructive: true` body guard + per-deletion AuditLog row).
- **Two contract-drift bugs surfaced + filed for follow-up**: #410 (`recurringInvoiceEngine` excludes `VOID` but `/void` writes `VOIDED`) and #411 (`retentionEngine` skips AuditLog on no-op runs — GDPR audit-trail incomplete).
- **Two cross-project pattern docs**: [DEMO_MONITOR_PATTERN.md](docs/DEMO_MONITOR_PATTERN.md) for demo-environment monitoring; [LIVE_MONITOR_PATTERN.md](docs/LIVE_MONITOR_PATTERN.md) for production-grade monitoring with severity tiers + PagerDuty + dry-run rollout. Hand to sister Globussoft products.
- **Demo-monitor cadence relaxed** `*/30` → `0 */2` (every 2h, 12 runs/day). Today's automation closed the bulk of the residue class.

See [CHANGELOG.md](CHANGELOG.md#v342--2026-05-03--six-more-gate-specs--four-new-admin-trigger-endpoints--portable-monitor-pattern-docs) for the full v3.4.2 entry.

## What's new in v3.4.1 (May 3 2026 — T1.2 SMS live + e2e-full long-tail closed)

Continuation of v3.4.0's same-day session.

- **Patient SMS pipeline live**: Fast2SMS API key wired on demo + local; `/api/wellness/portal/health` confirms `smsConfigured:true` end-to-end. Patient portal OTP login + T-24h/T-1h appointment reminders + telecaller follow-up SMS now actually deliver. Closes T1.2 from TODOS.md (broken-by-default since #182 in April).
- **Graceful-degrade UI** when SMS isn't configured: amber admin banner in `Layout.jsx` for staff (ADMIN/MANAGER only); patient portal replaces OTP form with "contact your clinic" notice. Both gated on `features.smsConfigured` from `/api/auth/me` (or the new public `/portal/health` for the unauth portal).
- **e2e-full long-tail fully closed**: the 13 "real product issues" from 2026-05-02 triage were 0 product bugs. The final 3 (L1 eventbus race, L2 lead-scoring UI, L3 wellness-real-user-journeys) were test races + env mismatches; commits `3dc49c2`, `35fedc7`, `fe91c36` resolved.

See [CHANGELOG.md](CHANGELOG.md#v341--2026-05-03--t12-sms-provider-live--e2e-full-long-tail-fully-closed) for the full v3.4.1 entry.

## What's new in v3.4.0 (May 3 2026 — gate-spec push, demo cleanup automation, compliance fixes)

A follow-on test-infra release. **No new product features.**

- **Gate grew to 31 specs / 1,435 tests** (was 23 / ~1,084). 8 new specs from the [docs/E2E_GAPS.md](docs/E2E_GAPS.md) priority backlog: G-1 landing-pages-api, G-2 workflows-api, G-3 integrations-api, G-4 search-api, G-5 audit-api, G-6 appointment-reminders-api (wellness PRD-critical), G-8 low-stock-api, G-25 security-headers (Helmet/CSP regression detection).
- **2 compliance bugs fixed**: `routes/audit.js` now requires `verifyRole(['ADMIN'])` (#408 — was leaking PII via the `details` JSON column to MANAGER + USER); `routes/integrations.js POST /toggle` now requires admin (#409 — was the odd one out vs. its sister `/connect` + `/disconnect`).
- **`Activity.description` → `@db.Text`** schema migration. Drops the 188-char clamp workaround in the external partner API; full notes + utm + junk-filter reasons round-trip intact.
- **e2e-full `scrub-demo` job** — every release-validation run against demo now self-cleans via a post-matrix SSH job. Solves the 605-row pollution windows that previously appeared after manual `e2e-full.yml` triggers.
- **Demo-monitor cron live** — `*/30 * * * *` against the deployed box, auto-opens a tracker GitHub issue with a stable title on failure. Catches drift within 30 min instead of waiting for QA.
- **Local 4-gate mirror** — `scripts/test-local.ps1 -Local` + bash equivalent boot a Docker MySQL stack on host port 3307 and run all 4 deploy gates locally. See CLAUDE.md for the full workflow.

See [CHANGELOG.md](CHANGELOG.md#v340--2026-05-03--gate-spec-push-demo-cleanup-automation-compliance-fixes) for the full v3.4.0 entry.

## What's new in v3.3.0 (May 1 2026 — test infrastructure overhaul + Tier 1 CI hardening)

A foundational release. **No new product features** — every change is in test infrastructure, CI/CD pipeline, or under-the-hood bug fixes the new test surface caught.

- **Test surface ~7×** per push: Playwright API specs grew 18 → 23 (673 → ~1,084 tests), and a brand-new **vitest unit-test layer** (22 files / 674 tests covering all `lib/` + `middleware/` + `services/` + `utils/`).
- **CI-1 ESLint** — flat config; project-specific rule blocks bare `req.user.id` (the JWT key is `userId`). 180 → 0 warnings cleared on 2026-05-01 afternoon.
- **CI-2 Dependabot** — weekly grouped PRs across npm-backend / npm-frontend / npm-e2e / github-actions.
- **CI-3 gitleaks secret scan** — incremental on push, full-history Mondays. (Initially shipped using a paid action, swapped to the free OSS Docker image on 2026-05-01.)
- **CI-4 npm audit gate** — fails on new high/critical CVEs; allowlist with sunsetBy dates.
- **2 real prod bugs fixed**: bare `req.user.id` was always undefined (silently broke prescriber checks, telecaller queue, audit rows); `/communications/track` openPath collision bypassed auth on `/communications/tracking/:emailId`.
- **Coverage measurement workflow** (`coverage.yml`) — workflow_dispatch, c8 against the gate specs.
- **Release-validation workflow** (`e2e-full.yml`) — full chromium project on tag push, sharded 4-way to fit the 30-min runner budget.

See [CHANGELOG.md](CHANGELOG.md#v330--2026-05-01--test-infrastructure-overhaul--tier-1-ci-hardening) for the full v3.3.0 entry.

## What's new in v3.2.5 (April 29 2026 — security hardening + fresh QA round + nested patient endpoints)

A focused round on a fresh 8-issue QA pass plus the lingering #339. All deployed via GitHub Actions in a single commit (`d778d6a`).

- **#342 [P1][SECURITY]** — Helmet response headers regression caught and fixed. Six security headers (HSTS 1y, X-Frame SAMEORIGIN, Referrer-Policy strict-origin-when-cross-origin, X-Content-Type-Options nosniff, COOP same-origin, CORP cross-origin) now present on every API response. Earlier custom CSP was interacting badly with the SPA's inline styles + the cross-origin embed widget; replaced with explicit lean config.
- **#343 [P1][SECURITY]** — JWT bearer token migrated off `localStorage` to in-memory + sessionStorage. AuthContext on cold start migrates legacy tokens once and deletes the old key. New `getAuthToken()` / `whenAuthReady()` exports. Sweep across 12 pages that called `localStorage.getItem('token')` directly. Real reduction in attack surface (no more 30-day persistent token in disk-backed origin store); full httpOnly-cookie migration is a multi-day follow-up.
- **#344, #347** — sessionStorage URL-segment sanitization + auth-race fix on fresh navigation (AuthProvider blocks render behind `loading` flag).
- **#346** — Nested patient endpoints (`GET /patients/:id/visits | /prescriptions | /consents | /treatment-plans`) added. Each verifies parent exists, reuses select shape, audit-logs the read.
- **#345** — `/api/notifications/unread-count` polling killed (was 1.5x/sec). NotificationBell now does ONE initial HTTP fetch + Socket.IO subscription to `notification_new` / `notifications_cleared`.
- **#341** — Global `*` 404 fallback route. New [NotFound.jsx](frontend/src/pages/NotFound.jsx) (~125 lines, wellness-themed) with dynamic suggestions for 8 known wrong-prefix URLs (`/loyalty` → `/wellness/loyalty`, etc.) and tenant-aware quick links.
- **#348** — API namespace inconsistency. `/wellness/staff` and `/wellness/audit` now return 410 Gone with `code: WELLNESS_NAMESPACE_INVALID` and a `canonical` field. New [API_NAMESPACING.md](docs/API_NAMESPACING.md) documents the org-vs-wellness split.

See [CHANGELOG.md](CHANGELOG.md#v325--2026-04-29--security-hardening--8-bug-new-round--nested-patient-endpoints) for the full v3.2.5 entry.

## What's new in v3.2.4 (April 29 2026 — inbox-zero + GitHub Actions + mobile responsive + reports export)

**The day the issue board went 50 → 0 → refilled by overnight QA → cleared again. ~50 issues across 3 agent rounds. New CI/CD: GitHub Actions deploy. New scope: prescription PDF, Reports CSV/PDF export, mobile-responsive 80/20, external-integrations sandbox foundation.**

- **GitHub Actions deploy pipeline** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) replaces local `ssh_deploy_*.py` scripts. Triggers on push to main + manual dispatch. Steps: backend pull → install → prisma generate → pm2 restart → health poll, with auto-rollback to `HEAD~1` on health-check fail. Frontend: vite build → sudo rsync → chown www-data + chmod (the lesson from a sudo-rsync 403 incident is baked in). Concurrency `deploy-prod` queue. Required secrets: `SSH_HOST`, `SSH_USER`, `SSH_PASSWORD`.
- **#300 [P0/SECURITY]** — `/portal/login/request-otp` was leaking the OTP in the JSON body (gated on `NODE_ENV !== 'production'`, but demo runs without that env var). Removed the bypass entirely; OTP is SMS-only.
- **#312 [P0]** — Calendar New Visit modal had an empty Patient dropdown (184 patients existed). Defensive shape read for `{patients, total}` response.
- **#313 [P0]** — Tasks deadline shifted +5:30h. Frontend now sends `new Date(value).toISOString()` so server gets a real UTC timestamp.
- **#292 / #295 / #280 / #324 / #326 / #323** — RBAC + PHI cluster: hardcoded OTP `1234` no longer works for arbitrary phones; OTP request rate-limited (3/10min/phone + 10/10min/IP); stylists only see their own column + non-clinical visits; doctors only see their own column; telecallers can no longer write prescriptions; managers no longer see Delete on /staff.
- **#227 — Reports CSV/PDF export** across all 4 tabs (P&L, Per-Pro, Per-Location, Attribution). Backend extracted shared calc helpers; CSV uses UTF-8 BOM (Excel-friendly INR + Hindi names) + appended TOTAL row; PDF uses pdfkit A4-landscape with the same letterhead style as prescriptions.
- **#228 — Mobile responsive 80/20**. Sidebar collapses behind a hamburger drawer at ≤768px. New [responsive.css](frontend/src/styles/responsive.css) covers 6 demo-path pages: OwnerDashboard, Patients, PatientDetail, Calendar, Reports, TelecallerQueue. Full mobile parity remains a multi-day follow-up.
- **#137 — External integrations sandbox foundation**. New [SANDBOX.md](docs/wellness-client/SANDBOX.md) inventories 7 inbound webhooks + 7 outbound integrations + 19 cron engines (8 with NO E2E coverage). Three runnable Express mocks at ports 5101/5102/5103.
- **#278** — Prescription detail modal + PDF download. Case History timeline now shows Instructions; Rx cards clickable; Download PDF button uses pdfkit letterhead.
- **40+ smaller P2/P3 fixes**, plus 3 cleanup scripts that ran on prod: `cleanup-p3-data-quality.js`, `merge-duplicate-patients.js` (331 → 181 patients with all 327 visits + 33 Rx + 14 consents + 42 treatment plans preserved via reattach), `cleanup-seed-pollution-2026-04-27.js`.
- **#316 [P1]** — number-input concatenation. Three agents investigated; no clear root cause in code. Shipped defensive `<NumberInput>` helper as a fallback while the real cause (likely browser/IME or Playwright `.fill()` artifact) is investigated.
- **Backend coverage 64.76% → 66.65% lines**, gate raised `60/45/60/60` → `65/50/65/65`. New [sms-api.spec.js](e2e/tests/sms-api.spec.js) (44 tests) covering `routes/sms.js`.
- **Closed by product decision** (#200 #201 #211 #241): login quick-login chips + prefilled creds intentional for demo server.
- **Stale-issue cleanup** (#141 #142 #147 #150 #152 #153): migrated from a different product 3 days idle, no repro.

See [CHANGELOG.md](CHANGELOG.md#v324--2026-04-29--inbox-zero-day-1--day-2-50-issues-across-3-agent-rounds-github-actions-deploy-mobile-responsive) for the full v3.2.4 entry.

## What's new in v3.2.3 (April 27 2026 — P1 + P2 closure pass + fetchApi rewrite + demo polish)

A focused day-long pass on user-reported QA bugs. **24 GitHub issues closed**: 8 P1 (demo-breaking), 11 P2 (functional gaps), 4 silent-failure cluster, and 1 visit overflow. P1 + P2 boards both at 0 open. No schema changes; backwards-compatible API changes only.

**Class fixes (most leverage):**
- **`fetchApi` rewrite** ([frontend/src/utils/api.js](frontend/src/utils/api.js)) — every error toast now surfaces the real server message. Root cause: `fetchApi` read `errData.message` but every backend route returns `{error, code}`, so every toast fell back to the generic literal "API Request Failed". Fix: read `errData.error || errData.message`; 403 / 404 / 5xx / network fallbacks; auto-toasts via `_globalNotify` registered by `NotifyProvider` on mount; throws Error with `.status` / `.code` / `.data`. Closes the silent-failure class behind #273-#276.
- **Stale-chunk recovery** (#249) — new `lazyWithRetry` helper wraps every `lazy()` import; on `Failed to fetch dynamically imported module` it auto-reloads once per session. New `RouteErrorBoundary` catches the residual case. Affects all 80 lazy routes.
- **Visit.amountCharged ₹50L cap** (#277) — POST + PUT `/api/wellness/visits` reject `amountCharged > 5_000_000` with `code: AMOUNT_TOO_LARGE`. Cleanup script NULLed 2 polluted ₹1e15 rows on prod.
- **Reports off-by-one date range** (#234) — `to=YYYY-MM-DD` was being parsed as midnight UTC, dropping every visit later that day. Now clamped to end-of-day. Net effect: P&L productCost went ₹0 → ₹32,000.
- **Reports tabs canonical totals** (#232) — P&L / Per-Pro / Per-Location were each silently filtering visits with different rules. New `canonicalVisitTotals()` makes totals identical across tabs; new `totals.unbucketed` exposes the join-key-missing delta.

**Demo-criteria status (PRD §14):** 4 of 6 verified live. The 2 ⚠️ are external-blocked (Callified webhook + AdsGPT back-link). See [docs/wellness-client/PRD.md §14 status table](docs/wellness-client/PRD.md#status-as-of-2026-04-27).

**Highlights of bug fixes:**
- Calendar grid now shows ALL 16 practitioners (was 3); empty-slot click opens "New visit" modal (#262, #270).
- Reports tabs reconciled (#232) — same 117 visits / ₹12.9L across P&L / Per-Pro / Per-Location.
- Patient portal OTP demo bypass via `WELLNESS_DEMO_OTP=1234` env var (#238).
- Owner Dashboard ₹20T overflow fixed (#277) — was ₹30,000.
- Consent canvas signatures visible on cream theme (#231) — `--text-primary` instead of hardcoded `#fff`.
- Inbox Play Recording wired (#253); Leads row click navigates (#260); Locations editable (#235); Calendar Unassigned column (#247).
- 17 redundant `notify.error` catches swept across 9 wellness pages; success toasts added where missing.

**Coverage:** combined forecast 64.76% → ~71-72% from 3 new e2e specs (`reports.js` 52 tests, `marketing.js` 41 tests, `voice_transcription.js` 20 tests). Re-run on server next session and bump `.c8rc.json` `60 → 70` if measurement supports.

## What's new in v3.2.2 (April 26 2026 — afternoon — form autosave, billing patch, telecaller polish, c8 coverage measured)

A focused afternoon pass closing the remaining frontend UI cluster from the morning handoff plus the first real backend coverage measurement. **8 GitHub issues closed.**

- **Form autosave** (#226) — new `useFormAutosave` hook rehydrates from sessionStorage on mount, debounced persist on every keystroke, `beforeunload` warning if dirty, "Restored from previous session" banner. Wired into New Prescription, Log Visit, and Treatment Plan forms; pattern is opt-in for the rest.
- **Billing PATCH + mark-paid endpoints** (#202) — `PATCH /api/billing/:id` and `POST /api/billing/:id/mark-paid` (idempotent, audited). State-machine codes: terminal transitions return `422 INVALID_INVOICE_TRANSITION`. Closes the long-standing "no update path" gap.
- **Telecaller queue** (#215) — all 6 dispositions now confirm consistently. Booked / Callback / Interested gain a follow-up form (date+time / notes) so the disposition captures real intent.
- **`/portal` route collision** (#208) — wellness patient portal moves to `/wellness/portal`; generic CRM customer portal stays at `/portal`.
- **`/wellness/tasks` 404** (#217) — verified the shared `/tasks` and `/inbox` routes already work under the wellness theme via the `data-vertical` cascade; sidebar prefix corrected.
- **Treatment plan Add debounced** (#225) — submitting state on PlansTab + LogVisitTab + InventoryTab disables the button between click and response.
- **Patient list table breaks on long names** (#229) — `table-layout: fixed` + ellipsis + `title` tooltip; header row no longer collapses on 60-char display names.
- **Service Worker push spam** (#206) — `[push] setupPush AbortError` demoted from `console.error` to `console.debug`.
- **Backend coverage measured for the first time: 64.76%** (21,484 / 33,170 lines) via `c8` full-suite run (1056 tests, 14.5min, side-by-side instance on :5098). **Coverage targets set as policy:** aspirational 100%, CI gate 50% (climbs each release), critical-path floor 70% (`routes/auth.js`, `routes/external.js`, `routes/billing.js`, `routes/wellness.js`, all `middleware/*`, all `lib/*`).
- **DISABLE_CRONS=1 env switch + graceful SIGTERM/SIGINT shutdown** — lets us run a side-by-side coverage instance on `:5098` without cron interference, and ensures `c8` can flush V8 coverage data on process exit.
- **13 e2e flake fixes** — admin/admin → admin@globussoft.com migration; SIDEBAR_ROUTES rebuild against v3.2.1 sidebar; theme localStorage seed pattern. Pass rate now 96%+ on the navigation/notifications/theme cluster.

## What's new in v3.2.1 (April 26 2026 — overnight QA pass)

A two-day audit + fix sprint surfaced and closed a class of latent bugs that smoke tests would never catch and only deep API exercise reveals.

**Real backend bugs found and fixed (10+):**
- **Portal login 500 on unknown email** — `findUnique({where:{email}})` against a non-`@unique` field threw and returned 500 instead of 401. Three sites fixed.
- **2FA login was unreachable** — `/auth/2fa/verify` was missing from the `openPaths` allowlist; the global guard 403'd before the tempToken could be read.
- **All form-encoded webhooks were broken** — `express.urlencoded()` was not mounted, so Twilio voice/SMS, WhatsApp, Mailgun, and Razorpay webhooks all 400'd silently on missing-field checks.
- **Accounting webhook unreachable** — `/accounting/webhook` not in `openPaths` so QuickBooks/Xero/Tally callbacks 403'd.
- **Setting a quota was impossible** — `POST /quotas` read `userId` from body, but `stripDangerous` middleware deletes `req.body.userId` (anti-injection). Now reads from query.
- **Portal OTP bypass** — legacy `POST /portal/login` accepted any 4-digit OTP without checking PatientOtp. Anyone with a phone could mint a 30-day portal JWT. Now validates against the OTP table the same way `/verify-otp` does.
- **`/sequences/debug/tick` open to any user** — implicitly protected by global guard but any USER could fire the cron loop for every tenant. Now ADMIN-only.
- **P&L productCost stuck at ₹0** — visit `findMany` select omitted `id`, so the consumption-cost lookup always missed. Single line fix; cost rollups now correct.
- **XSS sanitiser was half-done** — only stripped `<script|iframe|...|svg>`. Now also strips `<img|video|audio|source|applet|base|input|textarea>` plus inline event handlers (`onclick=`, `onerror=`, etc.) and `javascript:`/`data:` URL schemes.
- **Estimate API breaking change** — POST silently rejected the legacy `{name, items}` shape after a rename. Now accepts both `{name|title, items|lineItems}` for the deprecation window.

**Engine improvements:**
- **Workflow engine**: `deal.stage_changed`, `ticket.created`, `invoice.paid` events now emit. Trigger/action whitelists are enforced (400 with `INVALID_*_TYPE`). `isActive` is updatable via PUT.
- **Sequences**: pause / resume / unenroll endpoints added. Delay regex now matches `Days?`/`Hours?`/`Mins?` (was missing days). Synthesised drip emails now carry a deterministic `seq-<enrollmentId>` threadId so they're queryable.
- **SLA**: `responseMinutes: 0` is valid (instant SLA), `firstResponseAt` only stamps on Open → (In Progress | Pending | Replied), `/apply-all?force=true` re-applies a policy to in-flight tickets. Both `/api/tickets` and `/api/support` now share the SLA auto-apply path.
- **Approvals**: state-machine codes — terminal-status transitions return 422 `INVALID_APPROVAL_TRANSITION`, idempotent re-approve/reject return `{idempotent: true}`. New DELETE endpoint. Audit log row written on every transition.
- **Wellness**: auto-credit loyalty (10% of `amountCharged`) on POST/PUT visits when status='completed'; idempotent via `LoyaltyTransaction` lookup. P&L now joins consumptions through `visit.visitDate` (was using `consumption.createdAt`, which desynced revenue and cost windows across day boundaries).

**Test coverage:**
- 64 new e2e specs across 5 deep-flow modules (approvals, sequences, sla, workflows, wellness clinical journey) + smoke specs covering all 89 mounted route files.
- New audit script at `scripts/audit-e2e-routes.js` extracts every `/api/*` URL referenced in specs and matches against actual handlers — surfaces broken URLs and untested route files.

## What's new in v3.1 (April 2026)

- **Wellness vertical** — first vertical productization. New tenant config (`tenant.vertical = "wellness"`) flips the sidebar, theme, and routing for clinics. Built for the [Enhanced Wellness](https://drharorswellness.com) (Dr. Haror's franchise) demo.
- **External Partner API** — `/api/v1/external/*` lets sister products (Callified.ai for voice/WhatsApp, AdsGPT for ads, Globus Phone for softphone) push leads, calls, messages, and book appointments into the CRM via API key.
- **Embeddable lead-capture widget** — drop-in `<script>` for any website. Lives at `/embed/widget.js` and `/embed/lead-form.html`.
- **Tenant-driven currency** — `Tenant.country` + `defaultCurrency` + `locale` drive money formatting everywhere. Indian tenants see ₹ (with Lakh/Crore notation), US sees $, etc.
- **AI orchestration engine** — daily cron generates 1–3 prioritised "do this" cards (campaign boost, occupancy alert, lead follow-up) for the owner; approval triggers an action dispatcher (queue SMS blast, create task, flag leads).
- **Junk-lead filter** — multi-stage classifier on every inbound lead: hard rules (non-Indian mobile, dup-7d) → soft heuristics (gibberish names, disposable emails) → optional Gemini fallback. Tags `status="Junk"` with reasons.
- **Auto-router** — keyword → service category → assigns lead to the right specialist (doctor / professional / telecaller).
- **PDF generation** — branded prescriptions, signed consent forms, branded invoices via pdfkit.
- **Patient portal** at `/patient-portal` — phone+OTP login, view own visits/Rx, download PDFs.
- **Multi-location** — `Location` model + per-clinic dashboard rollup, ready for franchise expansion.
- **India-aware Pricing page** — auto-defaults to INR for Indian visitors based on timezone + locale; manual toggle persists.

---

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite, React Router v7, React.lazy() code splitting, Lucide Icons, Recharts, ReactFlow, React Grid Layout, Socket.io-client |
| Backend | Node.js, Express.js, Prisma ORM, MySQL, Socket.io, node-cron, PDFKit, pdf-lib, Nodemailer, Mailgun, express-rate-limit, express-validator, Swagger UI |
| AI | Google Gemini 2.5 (@google/generative-ai), sentiment analysis, deal insights, lead scoring, voice transcription, data enrichment |
| Auth | JWT (bcryptjs), RBAC (ADMIN / MANAGER / USER), 2FA (speakeasy), SSO, SCIM |
| Security | Helmet, CSRF (csurf), sanitize-html, field-level permissions, GDPR consent tracking, rate limiting |
| Payments | Stripe, Razorpay |
| Communications | Twilio (SMS/Voice), Mailgun, WhatsApp Cloud API, Web Push (VAPID), IMAP inbound email |
| Production | PM2, Nginx reverse proxy, Certbot SSL, Sentry error tracking |
| Testing | Playwright E2E (40 spec files) |
| Styling | Vanilla CSS with glassmorphism design, dark/light theme support |

---

## Feature Highlights

### Dashboard
Executive analytics overview with closed revenue, expected revenue, total contacts, conversion rate, pipeline chart, and recent deals. Date range filter (All Time / 7d / 30d / 90d / 365d).

![Dashboard](qa_screenshots/feature-dashboard.png)

---

### Agent Assignment on Leads
Assign sales agents to leads directly from the table. Supports individual assignment via dropdown and **bulk assignment** with multi-select checkboxes. Agents are fetched from the Staff directory.

![Agent Assignment - Leads](qa_screenshots/feature-agent-assignment-leads.png)

---

### Agent Assignment on Contacts
Same agent assignment capability on the full Contacts page. Each contact row shows an "Assigned To" dropdown to quickly assign or reassign agents.

![Agent Assignment - Contacts](qa_screenshots/feature-agent-assignment-contacts.png)

---

### Agent-wise Reports
Dedicated Agent Reports page with performance leaderboard. Tracks per-agent metrics: **revenue, deals won, win rate, tasks completed, calls made, emails sent, and contacts assigned**. Includes date range filters, CSV/PDF export, and a horizontal bar chart leaderboard. Click any agent row to see their recent deals and activity breakdown.

![Agent Reports](qa_screenshots/feature-agent-reports.png)

---

### Detailed Report Module (Charts)
Enhanced Reports & Analytics page with **8 metric types** (Revenue, Deal Count, Win Rate, Tasks, Contacts by Source/Status, Invoices, Expenses), date range filtering, and 3 chart types (Bar, Donut, Area). Includes Query Builder sidebar with aggregate totals.

![Reports - Charts](qa_screenshots/feature-reports-charts.png)

---

### Detailed Report Module (Data Tables + Download)
Switch to "Detailed Data" tab to view raw data tables for **Deals, Contacts, Tasks, Call Logs, Invoices, and Expenses**. Each table shows full record details with owner/agent attribution. Supports **CSV and PDF download** of any report.

![Reports - Detailed Data](qa_screenshots/feature-reports-detailed.png)

---

### Auto Email Reports (Scheduling)
Schedule automated email reports with configurable **frequency (Daily, Weekly, Monthly)**, **format (PDF/CSV)**, and **recipients**. Reports are generated by a cron engine and dispatched via Nodemailer. Manage active schedules with enable/disable toggle and delete.

![Auto Email Reports](qa_screenshots/feature-auto-email-schedule.png)

---

### Marketplace Leads (India Market Integration)
Auto-import leads from **IndiaMART, JustDial, and TradeIndia** -- India's largest B2B/B2C marketplaces. Supports both **real-time webhooks** and **cron-based API polling** (every 5 min). Features smart deduplication (by external lead ID, email, and normalized phone), one-click or bulk import into CRM contacts, provider-wise stats dashboard, and an admin configuration panel with webhook URL display.

---

## Wellness Vertical (v3.1 — first vertical productization)

A focused configuration of the CRM for **clinics, salons, and aesthetics businesses**. Activates automatically when `tenant.vertical = "wellness"`. Built first for Dr. Haror's Wellness Ranchi franchise.

| Module | Path | What it does |
|---|---|---|
| Owner Dashboard | `/wellness` | Today's snapshot, occupancy %, revenue, pending recommendations, 30-day trend, location switcher |
| Recommendations | `/wellness/recommendations` | AI agent's daily action cards — Approve fires the dispatcher (campaign boost / SMS blast / task / lead flag) |
| Patients | `/wellness/patients` | Search + add; click for case history timeline + 7 tabs (visits, Rx pad, consent canvas, treatment plans, photos, inventory, log visit) |
| Calendar | `/wellness/calendar` | Day-grid by doctor, hour rows 9–7, status-coloured chips |
| Service Catalog | `/wellness/services` | 106 services (Dr. Haror's full catalog); per-card edit + soft-delete; Packages tab calculator |
| Telecaller Queue | `/wellness/telecaller` | Assigned leads + SLA timer (green<5 / yellow / red>30) + 6 disposition buttons + auto-refresh |
| Reports | `/wellness/reports` | 4 tabs: P&L by Service, Per-Professional, Per-Location, Marketing Attribution |
| Locations | `/wellness/locations` | Multi-clinic CRUD (Ranchi today; ready for franchise) |
| Public Booking | `/book/:slug` | Branded 3-step booking page (service → location → details) — no auth |
| Patient Portal | `/patient-portal` | Patient-side login (phone+OTP), view own visits/Rx, download PDFs |

**New Prisma models:** `Patient`, `Visit`, `Prescription`, `ConsentForm`, `TreatmentPlan`, `Service`, `ServiceConsumption`, `AgentRecommendation`, `Location` + `Tenant.vertical/country/defaultCurrency/locale` + `User.wellnessRole`.

**Tenant-aware sidebar** — generic CRM keeps the full 50+ item layout; wellness gets a slim 25-item clinic-focused layout that hides Pipeline / Deal Insights / Tickets / CPQ / Live Chat / Chatbots / etc. Switches automatically based on `tenant.vertical`.

**Brand theme** ([frontend/src/theme/wellness.css](frontend/src/theme/wellness.css)) — deep teal `#265855`, warm blush `#CD9481`, cream background — sampled from drharorswellness.com. Scoped under `[data-vertical="wellness"]` so generic tenants render unchanged.

---

## External Partner API

`/api/v1/external/*` — sister Globussoft products push data into the CRM via API key (`X-API-Key: glbs_…`).

| Endpoint | Purpose | Used by |
|---|---|---|
| `POST /leads` | Push a new lead (junk filter + auto-router run inline) | Callified, AdsGPT, website forms |
| `GET /leads?since=…` | Poll for new leads | Callified |
| `POST /calls` | Log a call + recording URL | Callified, Globus Phone |
| `PATCH /calls/:id` | Update call after the fact (e.g. transcript landed) | Callified |
| `POST /messages` | Log WhatsApp/SMS exchange | Callified |
| `POST /appointments` | Book a slot after qualifying | Callified |
| `GET /contacts/lookup?phone=` | Identify caller on inbound | Callified, Globus Phone |
| `GET /patients/lookup?phone=` | Same, wellness tenants | Callified |
| `GET /services`, `/staff`, `/locations` | Catalog reads | Both |

Full reference + cURL quickstart: [docs/wellness-client/EXTERNAL_API.md](docs/wellness-client/EXTERNAL_API.md).

---

## Embeddable Lead-Capture Widget

Drop-in form for any external website. No backend code needed on the website side.

```html
<div data-gbs-form
     data-key="glbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
     data-title="Book a free consultation"
     data-color="#7c3aed"></div>
<script async src="https://crm.globusdemos.com/embed/widget.js"></script>
```

Three integration options: drop-in script, pure iframe, direct API POST. Full guide: [docs/wellness-client/EMBED_WIDGET.md](docs/wellness-client/EMBED_WIDGET.md).

---

## All Modules (102 Routes)

### Sales & Pipeline
- **Dashboard** -- Executive analytics (MRR, revenue, deal closures, pipeline charts)
- **Pipeline** -- Kanban drag-and-drop deal board with real-time Socket.io sync
- **Pipelines** -- Multiple pipeline management (create, rename, reorder stages)
- **Pipeline Stages** -- Stage configuration and customization
- **Deals** -- Deal CRUD with stage progression and owner assignment
- **Deal Insights** -- AI-powered deal analysis and recommendations
- **Forecasting** -- Revenue forecasting with snapshot engine
- **Quotas** -- Sales quota setting and tracking per rep/team
- **Win/Loss Analysis** -- Win/loss reason tracking and analytics
- **Playbooks** -- Sales playbook templates with progress tracking
- **Funnel** -- Visual sales funnel analytics
- **CPQ** -- Configure-Price-Quote builder with line-item schemas

### Contacts & Leads
- **Contacts** -- 360-degree B2B/B2C directory with AI scoring, phone tracking, agent assignment
- **Leads** -- Filtered contacts (status=Lead) with agent assignment, bulk assign, convert-to-customer
- **Clients** -- Filtered contacts (status=Customer)
- **Lead Scoring** -- AI-powered scoring engine running on node-cron (every 10 min)
- **Lead Routing** -- Automated lead assignment rules (round-robin, territory, capacity)
- **Territories** -- Geographic/account territory management
- **Data Enrichment** -- AI-powered contact and company data enrichment
- **Marketplace Leads** -- IndiaMART / JustDial / TradeIndia lead ingestion with dedup engine

### Marketing
- **Marketing** -- Campaign management (Email, SMS, Push)
- **Sequences** -- Visual drip campaign builder with ReactFlow (Email, SMS, WhatsApp, Push nodes)
- **A/B Tests** -- Campaign A/B testing with variant tracking
- **Attribution** -- Multi-touch marketing attribution modeling
- **Web Visitors** -- Website visitor tracking and identification
- **Chatbots** -- Chatbot builder with conversation management
- **Landing Pages** -- No-code drag-and-drop page builder with templates and analytics
- **Email Templates** -- Reusable email template library
- **Social** -- Social media post scheduling and mention monitoring

### Communication
- **Inbox** -- Omnichannel communications hub (Email, Calls, SMS, WhatsApp)
- **Email** -- Email compose and management with Mailgun delivery
- **Email Inbound** -- IMAP-based inbound email processing
- **Email Threading** -- Conversation threading for email chains
- **Email Scheduling** -- Scheduled email send with cron engine
- **SMS** -- SMS messaging via MSG91/Twilio with DLT compliance
- **WhatsApp** -- WhatsApp Cloud API with template approval workflow
- **Telephony** -- Click-to-call via MyOperator/Knowlarity with call logging
- **Voice** -- Twilio VoIP softphone integration
- **Voice Transcription** -- AI-powered call transcription
- **Live Chat** -- Real-time website chat with agent routing
- **Shared Inbox** -- Team shared inbox for collaborative email
- **Push Notifications** -- Web push (VAPID) for CRM users and website visitors
- **Channels Config** -- Unified provider configuration for all communication channels
- **Notifications** -- In-app notification system with bell icon and unread badges

### Financial
- **Billing** -- Financial overview dashboard
- **Invoices** -- Full CRUD with mark-paid, void, PDF download, recurring invoices
- **Estimates** -- Line-item estimates with convert-to-invoice
- **Expenses** -- Category tracking with approve/reject/reimburse workflow
- **Contracts** -- Contract lifecycle (Draft > Active > Expired > Terminated)
- **Payments** -- Stripe and Razorpay payment processing
- **Currencies** -- Multi-currency support with exchange rates
- **Accounting** -- Accounting sync and journal entries

### Service & Support
- **Tickets** -- Support ticketing with priority/status/assignee
- **Support** -- Customer helpdesk management
- **SLA** -- Service level agreement policies and tracking
- **Canned Responses** -- Pre-built reply templates for support agents
- **Surveys** -- Customer satisfaction surveys with response tracking
- **Knowledge Base** -- KB articles organized by category
- **Customer Portal** -- Self-service portal for customers

### Documents
- **Document Templates** -- Template library with variable substitution
- **Signatures** -- Electronic signature requests and tracking
- **Document Tracking** -- Document view analytics

### Analytics & Reports
- **Reports** -- BI dashboard with 8 metrics, date filters, charts, data tables, PDF/CSV export
- **Agent Reports** -- Per-agent performance leaderboard
- **Custom Reports** -- User-defined report builder
- **Dashboards** -- Customizable dashboard layouts (React Grid Layout)
- **Funnel** -- Visual funnel analytics
- **Auto Email Reports** -- Scheduled report delivery (daily/weekly/monthly)

### Automation
- **Workflows** -- Automation rule engine with visual flow editor
- **Sequences** -- Multi-step drip campaign automation
- **Approval Workflows** -- Multi-level approval chains

### AI Features
- **AI Drafts** -- Gemini 2.5-powered email draft generation
- **Deal Insights** -- AI deal analysis and win probability
- **Sentiment Analysis** -- Customer sentiment scoring from communications
- **Data Enrichment** -- AI-powered contact/company enrichment
- **Lead Scoring** -- Predictive lead scoring with configurable weights
- **Voice Transcription** -- Call recording transcription

### Integrations
- **Marketplace Leads** -- IndiaMART, JustDial, TradeIndia with webhooks + API sync
- **Zapier** -- Zapier integration triggers and actions
- **Google Calendar** -- Calendar sync with Google
- **Outlook Calendar** -- Calendar sync with Microsoft Outlook
- **SSO** -- SAML/OAuth single sign-on configuration
- **SCIM** -- SCIM user provisioning

### Admin & Platform
- **Staff** -- User directory with RBAC role management (ADMIN only)
- **Settings** -- Organization settings, pipeline stages, theme toggle
- **Developer Portal** -- API key provisioning and webhook configuration
- **Audit Log** -- Entity/action tracking with user attribution
- **Privacy / GDPR** -- Consent records, data export requests, retention policies
- **Field Permissions** -- Field-level access control by role
- **Sandbox** -- Snapshot-based sandbox environments for testing
- **Industry Templates** -- Pre-built CRM configurations by industry
- **Tenants** -- Multi-tenant workspace management
- **Landing Page Builder** -- No-code page builder with form submissions
- **Booking Pages** -- Online scheduling and appointment booking
- **App Builder** -- Custom Objects with dynamic schemas (EAV pattern)
- **Command Palette** -- Quick navigation (Cmd+K / Ctrl+K)
- **Softphone** -- Twilio VoIP integration
- **Real-time Presence** -- Socket.io collaborative cursors
- **CSV Import** -- Bulk contact import with preview
- **Search** -- Global search across all entities
- **Integrations** -- Third-party integration catalog

## Getting Started

```bash
# Backend
cd backend && npm install
npx prisma generate && npx prisma db push
node prisma/seed.js   # Optional: seed demo data
npm run dev            # API on http://localhost:5000, Swagger at /api-docs

# Frontend
cd frontend && npm install
npm run dev            # UI on http://localhost:5173

# E2E Tests
cd e2e && npm install
npx playwright test --project=chromium
```

## Demo Credentials

The Login page has **one-click quick-login buttons** grouped by tenant — no typing.

### Generic CRM tenant (USD)
| Role | Email | Password |
|------|-------|----------|
| Admin | admin@globussoft.com | password123 |
| Manager | manager@crm.com | password123 |
| User | user@crm.com | password123 |

### Enhanced Wellness tenant (INR, vertical=wellness)
| Role | Email | Password | Lands on |
|------|-------|----------|----------|
| Owner (Rishu) | rishu@enhancedwellness.in | password123 | `/wellness` |
| Demo Admin | admin@wellness.demo | password123 | `/wellness` |
| Demo User | user@wellness.demo | password123 | `/wellness` |
| Manager | manager@enhancedwellness.in | password123 | `/wellness` |
| Doctor | drharsh@enhancedwellness.in | password123 | `/wellness` |

Wellness tenants land on `/wellness` after login (vs `/dashboard` for generic).

## API

102 route modules, all prefixed with `/api/`, protected by JWT auth. Public landing pages served at `/p/:slug`.

The **External Partner API** (`/api/v1/external/*`) uses API-key auth instead of JWT — see [EXTERNAL_API.md](docs/wellness-client/EXTERNAL_API.md).

Rate limiting: 5000 req/15min general, 1000 req/15min on auth.

Interactive docs at `/api-docs` (Swagger UI).

## Automation Engines (15 Cron Jobs)

| Engine | Schedule | Purpose |
|--------|----------|---------|
| leadScoringEngine | Every 10 min | AI-powered lead score recalculation |
| sequenceEngine | Every 5 min | Drip sequence step execution |
| marketplaceEngine | Every 5 min | IndiaMART/JustDial/TradeIndia lead sync |
| workflowEngine | Event-driven | Automation rule evaluation via eventBus |
| campaignEngine | Every 1 min | Marketing campaign dispatch |
| reportEngine | Scheduled | Auto email report generation and delivery |
| recurringInvoiceEngine | Daily | Recurring invoice generation |
| forecastSnapshotEngine | Weekly | Revenue forecast snapshot capture |
| dealInsightsEngine | Every 6 hr | AI deal insight generation |
| sentimentEngine | Every 15 min | Customer sentiment analysis |
| scheduledEmailEngine | Every 1 min | Scheduled email dispatch |
| retentionEngine | Daily 03:00 | Data retention policy enforcement (GDPR) |
| backupEngine | Daily 02:00 | Automated mysqldump backup |
| **orchestratorEngine** | Daily 07:00 IST | **Wellness AI orchestration — generates Owner Dashboard recommendation cards** |
| **appointmentRemindersEngine** | Every 15 min | **Queue SMS reminders 24h + 1h before each booked visit (wellness)** |
| **wellnessOpsEngine** | Hourly | **NPS survey 72h post-visit + 90-day junk-lead retention purge (wellness)** |

## Security Features

- **Authentication** -- JWT with bcryptjs password hashing
- **2FA** -- TOTP-based two-factor authentication (speakeasy)
- **SSO** -- SAML/OAuth single sign-on
- **RBAC** -- Role-based access control (Admin / Manager / User)
- **Field Permissions** -- Field-level access restrictions by role
- **CSRF Protection** -- csurf middleware
- **Security Headers** -- Helmet.js
- **Input Sanitization** -- sanitize-html + express-validator
- **Rate Limiting** -- express-rate-limit on all endpoints
- **GDPR Compliance** -- Consent records, data export, retention policies
- **SCIM Provisioning** -- Automated user lifecycle management
- **Audit Logging** -- Full entity/action audit trail

## E2E Testing

**124+ tests passing on production** across 40+ spec files.

- `tests/ship-readiness.spec.js` — 74 tests: auth, 50 API endpoints, security (CORS, tenantId injection), public endpoints, UI page serving
- `tests/wellness.spec.js` — 50 tests: tenant + currency segregation, dashboard data, patient/visit/Rx/consent create flow, recommendations approval, full external API flow (lead → poll → lookup → call recording back), reports (P&L + per-pro + per-location + attribution), junk filter, auto-router, public booking, orchestrator manual run, SPA route smoke
- Plus 30+ legacy specs for individual modules

```bash
cd e2e && BASE_URL=https://crm.globusdemos.com npx playwright test --project=chromium
```

## Deployment

- **Domain:** crm.globusdemos.com
- **Architecture:** PM2 (backend) + Nginx (frontend static + reverse proxy) + Certbot SSL
- **Monitoring:** Sentry error tracking (@sentry/node)
- **Deploy flow:** git pull > npm install > prisma generate > vite build > copy dist to Nginx > pm2 restart

---

*Built by [Globussoft Technologies](https://globussoft.com)*
