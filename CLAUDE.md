# Globussoft Enterprise CRM -- Project Context

## 🗂️ Engineering backlog — read TODOS.md on session start

The persistent backlog of multi-day / architectural work that's been deferred from cron + overnight runs lives in **[TODOS.md](TODOS.md)** at repo root. It's grouped by priority bucket (🟡 ship-this-month, 🔴 bigger investments, 🚫 don't-patch-rethink) plus the architectural cron-skipped GitHub issues, test debt, and a PRD-gap analysis. Each item has the diagnosis, recommended approach, and effort estimate.

**On session start, read TODOS.md before picking up new work** so you don't duplicate something already triaged or skip an item that's already been planned.

### Closed gap-files live under [docs/gaps/archive/](docs/gaps/archive/)

When a gap / backlog / regression-tracking file is **fully closed** (every entry shipped, zero `⬜` / `☐` / `TODO` / `open` markers remaining), it moves under `docs/gaps/archive/` rather than getting deleted — see [docs/gaps/archive/README.md](docs/gaps/archive/README.md) for the convention. Active backlogs (`TODOS.md`, `docs/E2E_GAPS.md`, `docs/regression-coverage-backlog.md`) STAY at their root locations as long as ≥1 item is open. Don't archive a file just because most items are closed — cohesion of the original file beats archive cleanliness.

## Overview

Full-stack enterprise CRM built by Globussoft Technologies. Mirrors top-100 CRM platforms with a glassmorphism UI. **Multi-tenant with vertical configurations** — a single codebase serves generic B2B CRM users AND the wellness vertical (clinics, salons, aesthetics).

- **Repo:** https://github.com/Globussoft-Technologies/globussoft-crm
- **Version:** v3.4.11 — see [CHANGELOG.md](CHANGELOG.md) for the full release history. Per-push gate is currently ~77 Playwright specs / ~2,522 tests + 42 vitest files / ~1,184 unit tests (~3,706 total) across 5 mandatory deploy gates, with 10 reusable Claude Skills under `.claude/skills/`.
- **Branch:** main (single-branch workflow)
- **Deploy:** GitHub Actions auto-deploy on push to main ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) — health-check + rollback to HEAD~1 on fail. Local `ssh_deploy_*.py` scripts are legacy.

## Verticals

Tenant.vertical ∈ `{generic, wellness}` drives:

- **Sidebar layout** — wellness gets a slim clinic-focused nav (~25 items); generic gets the full 50+ item enterprise sidebar
- **Theme** — wellness uses Dr. Haror's palette (teal `#265855`, blush `#CD9481`, cream bg) via scoped CSS under `[data-vertical="wellness"]`
- **Landing route** — wellness users land on `/wellness`, generic on `/dashboard`
- **Currency defaults** — tenant.defaultCurrency (INR/USD/EUR/etc.) + locale feed the `formatMoney()` helper everywhere

Adding a new vertical (gym, spa, clinic chain) means: add enum value, add a `render<Vertical>Nav()` function in Sidebar, add a themed CSS file, seed + new pages as needed. No forks.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite, React Router v7, React.lazy() code splitting, Lucide Icons, Recharts, ReactFlow, React Grid Layout, Socket.io-client, Vanilla CSS (glassmorphism) |
| Backend | Node.js, Express.js, Prisma ORM, MySQL, Socket.io, node-cron, express-rate-limit, express-validator, helmet, csurf, sanitize-html, Swagger UI |
| AI | Google Gemini 2.5 (@google/generative-ai) |
| Auth | JWT (bcryptjs), RBAC: ADMIN / MANAGER / USER, 2FA (speakeasy), SSO, SCIM |
| Payments | Stripe, Razorpay |
| Communications | Twilio (SMS/Voice), Mailgun, Nodemailer, IMAP, WhatsApp Cloud API, Web Push (web-push) |
| Files | Multer (uploads), PDFKit, pdf-lib, xlsx, QRCode |
| Monitoring | Sentry (@sentry/node) |
| Production | PM2, Nginx reverse proxy, Certbot SSL |
| Testing | Playwright E2E (e2e/ directory, 40 spec files) |

## Architecture

### Backend (backend/)

- **server.js** -- Express app, Socket.io, CORS allowlist, rate limiting, global auth guard, Swagger at `/api-docs`, route mounting, cron jobs
- **middleware/auth.js** -- `verifyToken` + `verifyRole` JWT middleware
- **middleware/security.js** -- Helmet, CSRF, cookie-parser security middleware
- **middleware/validateInput.js** -- express-validator input sanitization
- **middleware/fieldFilter.js** -- Field-level permission filtering
- **middleware/sendLimiter.js** -- Email/SMS send rate limiting
- **prisma/schema.prisma** -- MySQL via Prisma ORM (DATABASE_URL env var), 114 models
- **DISABLE_CRONS=1** env switch (v3.2.2) — server.js skips cron init when set; for side-by-side coverage instances
- **Graceful SIGTERM/SIGINT shutdown** (v3.2.2) — required for c8 V8 coverage data to flush before exit
- **prisma/seed.js** -- Seeds all models with demo data
- **utils/deduplication.js** -- Phone normalization + contact/lead deduplication
- All API endpoints prefixed with `/api/`
- Global auth guard protects all routes except /auth/login, /auth/signup, /auth/register, /health, /marketplace-leads/webhook
- Rate limiting: 5000 req/15min general, 1000 req/15min on auth/login

### Cron Engines (backend/cron/) -- 19 engines

| Engine | File | Purpose |
|--------|------|---------|
| Lead Scoring | leadScoringEngine.js | AI lead score recalculation (every 10 min) |
| Sequence | sequenceEngine.js | Drip sequence step execution |
| Marketplace | marketplaceEngine.js | IndiaMART/JustDial/TradeIndia lead sync (every 5 min) |
| Workflow | workflowEngine.js | Automation rule evaluation (event-driven via eventBus) |
| Campaign | campaignEngine.js | Marketing campaign dispatch |
| Report | reportEngine.js | Scheduled report generation and email delivery |
| Recurring Invoice | recurringInvoiceEngine.js | Recurring invoice generation (daily) |
| Forecast Snapshot | forecastSnapshotEngine.js | Revenue forecast snapshots (weekly) |
| Deal Insights | dealInsightsEngine.js | AI deal insight generation (6 hr) |
| Sentiment | sentimentEngine.js | Customer sentiment analysis (15 min) |
| Scheduled Email | scheduledEmailEngine.js | Scheduled email dispatch (every 1 min) |
| Retention | retentionEngine.js | GDPR data retention enforcement (daily 03:00) |
| Backup | backupEngine.js | Automated mysqldump (daily 02:00) |
| **Orchestrator** (v3.1) | orchestratorEngine.js | Wellness AI orchestration — daily 07:00 IST, generates Owner Dashboard recommendation cards |
| **Appointment Reminders** (v3.1) | appointmentRemindersEngine.js | Every 15 min, queue SMS T-24h + T-1h before each booked wellness visit |
| **Wellness Ops** (v3.1) | wellnessOpsEngine.js | Hourly, NPS survey 72h post-visit + 90-day junk-lead retention purge |


### Libraries (backend/lib/) -- 8 modules

- **prisma.js** -- Shared Prisma client instance
- **eventBus.js** -- In-process event bus for decoupled modules
- **notificationService.js** -- Notification creation and delivery
- **webhookDelivery.js** -- Outbound webhook dispatch with retry
- **sentry.js** -- Sentry error tracking initialization
- **leadJunkFilter.js** (v3.1) -- Multi-stage junk-lead classifier: rules + optional Gemini fallback
- **leadAutoRouter.js** (v3.1) -- Keyword → service category → assigned specialist (doctor / professional / telecaller)
- **fieldEncryption.js** (v3.1) -- AES-256-GCM helper for patient PII fields. Opt-in via `WELLNESS_FIELD_KEY` env var

### Services (backend/services/) -- 6 services

- **smsProvider.js** -- SMS delivery via MSG91/Twilio
- **whatsappProvider.js** -- WhatsApp Cloud API messaging
- **telephonyProvider.js** -- Click-to-call via MyOperator/Knowlarity
- **pushService.js** -- Web push notification delivery (VAPID)
- **landingPageRenderer.js** -- Server-side landing page rendering
- **pdfRenderer.js** (v3.1) -- pdfkit-based PDFs: prescription, consent (with embedded signature), branded invoice

### External Partner API (v3.1) -- /api/v1/external

API-key authenticated (`X-API-Key: glbs_…`) endpoints consumed by sister Globussoft products (Callified.ai for voice/WhatsApp, AdsGPT for ads, Globus Phone for softphone).

- **middleware/externalAuth.js** -- Reads X-API-Key, validates against ApiKey model, aliases req.user so tenantWhere helpers keep working
- **routes/external.js** -- `/health`, `/me`, `/leads` (POST + GET poll), `/calls` (POST + PATCH for late transcripts), `/messages`, `/appointments`, `/contacts/lookup`, `/patients/lookup`, `/services`, `/staff`, `/locations`
- Docs: docs/wellness-client/EXTERNAL_API.md

### Routes (backend/routes/) -- 91 route files

**Sales & Pipeline:** deals.js, pipelines.js, pipeline_stages.js, deal_insights.js, forecasting.js, quotas.js, win_loss.js, playbooks.js, funnel.js, cpq.js

**Contacts & Leads:** contacts.js, lead_routing.js, territories.js, data_enrichment.js

**Marketing:** marketing.js, sequences.js, ab_tests.js, attribution.js, web_visitors.js, chatbots.js, landing_pages.js, email_templates.js, social.js

**Communication:** communications.js, email.js, email_inbound.js, email_threading.js, email_scheduling.js, sms.js, whatsapp.js, telephony.js, voice.js, voice_transcription.js, live_chat.js, shared_inbox.js, push.js, notifications.js

**Financial:** billing.js, estimates.js, expenses.js, contracts.js, payments.js, currencies.js, accounting.js

**Service & Support:** tickets.js, support.js, sla.js, canned_responses.js, surveys.js, knowledge_base.js, portal.js

**Documents:** document_templates.js, signatures.js, document_views.js, deals_documents.js

**Analytics:** reports.js, report_schedules.js, custom_reports.js, dashboards.js

**Automation:** workflows.js, approvals.js

**AI:** ai.js, ai_scoring.js, sentiment.js

**Integrations:** integrations.js, marketplace_leads.js, zapier.js, calendar.js, calendar_google.js, calendar_outlook.js, sso.js, scim.js

**Admin & Platform:** auth.js, auth_2fa.js, staff.js, developer.js, audit.js, audit_viewer.js, gdpr.js, field_permissions.js, sandbox.js, industry_templates.js, tenants.js, booking_pages.js, custom_objects.js, search.js, tasks.js, projects.js, settings (via server.js)

**Wellness vertical (v3.1):** wellness.js (patients, visits, prescriptions, consents, treatments, services, locations, recommendations, dashboard, reports/pnl-by-service, /per-professional, /per-location, /attribution, photos, inventory, telecaller/queue + /dispose, portal/login + /me + /visits + /prescriptions, orchestrator/run, public/tenant/:slug + public/book)

**External Partner API (v3.1):** external.js (/api/v1/external/* — health, me, leads, calls, messages, appointments, contacts/lookup, patients/lookup, services, staff, locations)

### Frontend (frontend/src/)

- **App.jsx** -- AuthContext provider, React Router, Suspense + React.lazy() for 80 page components (code-split)
- **utils/api.js** -- `fetchApi` helper with auto Bearer token and 401 redirect

### Frontend Components (frontend/src/components/) -- 11 components

CPQBuilder, CommandPalette, DealModal, EmailSignatureEditor, LanguageSwitcher, Layout, NotificationBell, Omnibar, Presence, Sidebar, Softphone

### Frontend Pages (frontend/src/pages/) -- 80 pages

**Sales:** Dashboard, Pipeline, Pipelines, Forecasting, Quotas, WinLoss, Playbooks, Funnel, DealInsights, CPQ

**Contacts:** Contacts, ContactDetail, ContactsDetail, Leads, Clients, LeadScoring, LeadRouting, Territories

**Marketing:** Marketing, MarketplaceLeads, Sequences, AbTests, Social, Chatbots, LandingPages, LandingPageBuilder, WebVisitors

**Communication:** Inbox, SharedInbox, LiveChat, Channels

**Financial:** Billing, Invoices, Estimates, Expenses, Contracts, Payments, Currencies

**Service:** Tickets, Support, Surveys, KnowledgeBase, SLA

**Documents:** DocumentTemplates, DocumentTracking, Signatures

**Analytics:** Reports, AgentReports, CustomReports, Dashboards

**Automation:** Workflows, Sequences, Approvals

**AI:** DealInsights, LeadScoring

**Admin:** Staff, Settings, Developer, AuditLog, Privacy, FieldPermissions, Sandbox, IndustryTemplates, Profile, Profile2FA

**Platform:** CustomObjects, CustomObjectView, BookingPages, Marketplace, Zapier, CalendarSync, Landing, Pricing, Portal

**Auth:** Login (with quick-login buttons grouped by tenant), Signup, Placeholder

**Wellness vertical (v3.1, frontend/src/pages/wellness/):** OwnerDashboard, Recommendations, Patients, PatientDetail (7 tabs: history, Rx, consent canvas, treatment plans, log visit, photos, inventory), Services (catalog + packages builder + inline edit), Calendar (day-grid by doctor), Reports (4 tabs: P&L, Per-Pro, Per-Location, Attribution), Locations, TelecallerQueue (SLA timer + 6 disposition buttons), PatientPortal (public, phone+OTP), PublicBooking (`/book/:slug`, no auth)

**Embed widget (v3.1, frontend/public/embed/):** widget.js (drop-in script), lead-form.html (iframe target)

**Wellness theme (v3.1):** theme/wellness.css — scoped under `[data-vertical="wellness"]`. Activated in App.jsx by setting `data-vertical` on body based on tenant.vertical.

### Prisma Models (114 total)

Generic (99): AbTest, AccountingSync, Activity, ApiKey, ApprovalRequest, Attachment, AuditLog, AutomationRule, Booking, BookingPage, CalendarEvent, CalendarIntegration, CallLog, Campaign, CannedResponse, Chatbot, ChatbotConversation, ConsentRecord, Contact, ContactAttachment, Contract, Currency, CustomEntity, CustomField, CustomRecord, CustomReport, CustomValue, Dashboard, DataExportRequest, Deal, DealInsight, DocumentTemplate, DocumentView, EmailMessage, EmailTemplate, EmailTracking, Estimate, EstimateLineItem, Expense, FieldPermission, Forecast, IndustryTemplate, Integration, Invoice, KbArticle, KbCategory, LandingPage, LandingPageAnalytics, LeadRoutingRule, LiveChatMessage, LiveChatSession, MarketplaceConfig, MarketplaceLead, Notification, Payment, Pipeline, PipelineStage, Playbook, PlaybookProgress, Product, Project, PushNotification, PushSubscription, PushTemplate, Quota, Quote, QuoteLineItem, ReportSchedule, RetentionPolicy, SandboxSnapshot, ScheduledEmail, ScimToken, Sequence, SequenceEnrollment, SharedInbox, SignatureRequest, SlaPolicy, SmsConfig, SmsMessage, SmsTemplate, SocialMention, SocialPost, SsoConfig, Survey, SurveyResponse, Task, TelephonyConfig, Tenant, Territory, Ticket, Touchpoint, User, VoiceSession, WebVisitor, Webhook, WhatsAppConfig, WhatsAppMessage, WhatsAppTemplate, WinLossReason

Wellness vertical (9 new, v3.1): **Patient, Visit, Prescription, ConsentForm, TreatmentPlan, Service, ServiceConsumption, AgentRecommendation, Location**

Extended fields (v3.1):
- `Tenant.vertical` (generic | wellness), `Tenant.country` (IN/US/…), `Tenant.defaultCurrency` (INR/USD/…), `Tenant.locale` (en-IN/en-US/…)
- `User.wellnessRole` (doctor | professional | telecaller | helper) — orthogonal to the RBAC role
- `Patient.locationId`, `Visit.locationId` — multi-clinic support

## Demo Credentials

Login page has one-click quick-login buttons grouped by tenant — no typing required.

### Generic CRM tenant (USD, `vertical=generic`)
- **Admin:** admin@globussoft.com / password123
- **Manager:** manager@crm.com / password123
- **User:** user@crm.com / password123

### Enhanced Wellness tenant (INR, `vertical=wellness`) — lands on `/wellness`
- **Owner (Rishu):** rishu@enhancedwellness.in / password123
- **Demo Admin:** admin@wellness.demo / password123
- **Demo User:** user@wellness.demo / password123
- **Manager:** manager@enhancedwellness.in / password123
- **Doctor:** drharsh@enhancedwellness.in / password123

Plus 12 professionals, 2 helpers, 1 telecaller (see `prisma/seed-wellness.js`).

### External Partner API (v3.1)
- **Callified.ai demo key:** printed by `node prisma/seed-wellness.js`
- **Globus Phone demo key:** same
- Scoped to the Enhanced Wellness tenant. POSTs via `X-API-Key: glbs_…`.

**Note:** the old `admin/admin` bypass was removed for security hardening. All test credentials now use real bcrypt-hashed passwords.

## Deployment

- **Domain:** crm.globusdemos.com
- **Server:** 163.227.174.141 (Ubuntu, user: empcloud-development)
- **Database:** MySQL on localhost:3306, database `gbscrm`
- **Nginx:** serves static frontend from `/var/www/crm.globusdemos.com`, proxies `/api/` to Express on port 5099
- **SSL:** Certbot (Let's Encrypt)
- **PM2:** `globussoft-crm-backend` only (frontend served by Nginx directly)
- **Monitoring:** Sentry (@sentry/node) for error tracking
- **Deploy flow (canonical):** GitHub Actions workflow `.github/workflows/deploy.yml` — fires on push to `main` (skipping doc/test/script-only changes via `paths-ignore`) plus manual `workflow_dispatch`. Four mandatory parallel gates → deploy:
  1. **build** — `npm ci` + `prisma generate` + `node --check` parse-check on every backend `.js` + frontend `vite build`
  2. **lint** — ESLint flat config (`backend/eslint.config.js`) + `npm audit` gate via `backend/scripts/check-audit.js` (allowlist at `backend/.audit-allowlist.json`). Project-specific rule blocks bare `req.user.id` (the JWT key is `userId`)
  3. **api_tests** — MySQL 8 container + seed both tenants + boot backend on :5000 + 23 Playwright API specs / ~1,084 tests (the gate spec list lives in `deploy.yml`'s "Run API-only specs" step)
  4. **unit_tests** — vitest over 22 backend test files / 674 tests covering `lib/`, `middleware/`, `services/`, `utils/`. ~1.2s test runtime
  Deploy runs only if all four pass. Steps: SSH pull → npm install → prisma generate → pm2 restart → poll `/api/health` (auto-rollback to `HEAD~1` if unhealthy) → vite build → sudo rsync to `/var/www` → chown www-data → smoke check `/` + `/api/health`. Hotfix bypass via `workflow_dispatch.skip_tests=true` (manual UI only — a regular push can never bypass).
- **Release validation:** GitHub Actions workflow `.github/workflows/e2e-full.yml` — runs the full Playwright chromium + auth-tests + api-health suites (UI flows, wellness deep, a11y, integration) against the deployed demo on git tag push (`v*`), GitHub Release publish, or manual trigger. Per-commit pipeline stays fast; the heavy suite is opt-in by tagging a green main commit.
- **Coverage measurement:** GitHub Actions workflow `.github/workflows/coverage.yml` — workflow_dispatch only. Spins an ephemeral backend with c8 instrumentation, runs the 23 gated API specs, reports lines/branches/functions/statements % + top-10 under-covered files. Replaces the old SSH cheat-sheet for the gate-spec methodology. Last measurement (commit `868b227`): 40.52% lines / 73.30% branches / 33.68% functions for routes; 79.01% lines for backend helpers (vitest c8).
- **Secret scanning:** GitHub Actions workflow `.github/workflows/secret-scan.yml` — gitleaks runs on every push + PR (incremental diff, ~10-20s) + scheduled full-history scan Mondays at 06:30 UTC. Allowlist for known intentional demo creds + dev-fallback constants in `.gitleaks.toml` at repo root.
- **Dependency updates:** Dependabot (`.github/dependabot.yml`) opens grouped PRs weekly Mondays 06:00 UTC for npm-backend, npm-frontend, npm-e2e, github-actions. Patch + minor grouped; major individual; security-only ignores cadence.
- **Local deploy scripts (legacy, gitignored, do NOT use):** deploy.py, deploy_backend.py, deploy_frontend.py, setup.sh, ssh_deploy_*.py — kept for emergency-only manual deploys; the GitHub Actions flow above is the only supported path.

### Standing rules for new code (do NOT skip these)

- **New route handler** → add an API spec at `e2e/tests/<route>-api.spec.js`, wire into BOTH `deploy.yml` and `coverage.yml` spec lists. Pattern: clone `e2e/tests/notifications-api.spec.js`. Cover happy path + validation + auth gate at minimum.
- **New `backend/lib/`, `middleware/`, or `services/` module** → add a vitest unit test under `backend/test/<area>/<module>.test.js`. Mock prisma + external SDKs.
- **New body field** → remember the global `stripDangerous` middleware deletes `id`, `createdAt`, `updatedAt`, `tenantId`, `userId` from every request body. Use `targetUserId` (or similar non-stripped name) when targeting a user.
- **JWT user reference** → always `req.user.userId`, never `req.user.id`. ESLint rule blocks the latter.
- **Sanitization layering** → there are TWO sanitization layers; specs and helpers must consider BOTH. The global `sanitizeBody` middleware ([server.js:93](backend/server.js#L93), [security.js:75](backend/middleware/security.js#L75)) strips dangerous TAGS (`script|iframe|object|embed|style|link|meta|form|svg|img|video|audio|source|applet|base|input|textarea`) but PRESERVES inner text content — so `<script>x</script>` becomes `'x'` BEFORE route-level `sanitizeText`/`sanitizeHtml` runs. For "purely-HTML payload yields empty after sanitization" probes, choose a tag from DANGEROUS_TAG_RE with NO inner text (e.g. `<img src=x onerror=alert(1)>`) — `<script>x</script>` will NOT yield empty.
- **JSON-string columns** → if a Prisma column is `String? @db.Text` storing JSON (e.g. `SequenceStep.conditionJson`, `LeadRoutingRule.conditions`, `AbTest.variantA/B`, `Campaign.scheduleFilters`, `ReportSchedule.metrics/recipients`, any `*Json` field), the **call site** stringifies before storing — the helper itself stays shape-preserving so other callers can use it for true JSON columns. Canonical helper: [backend/lib/sanitizeJson.js](backend/lib/sanitizeJson.js) (`sanitizeText` + `sanitizeJson` + `sanitizeJsonForStringColumn`). 5 routes adopted: `routes/sequences.js`, `routes/lead_routing.js`, `routes/ab_tests.js`, `routes/marketing.js`, `routes/report_schedules.js`. The 940b4f0 wave reverted an earlier always-stringify change after it broke 16 unit tests pinning the helper's shape-preservation contract; the v3.4.11 sweep (097ef5a/6a9e450/a916f59) promoted the helper from routes/sequences.js to lib/ for cross-route reuse. Helper has 16 vitest cases at `backend/test/utils/sanitize-json.test.js` pinning the contract; per-route adoption has spec extensions in each route's `*-api.spec.js`.
- **Stuck deploy gate** → if `deploy.yml` api_tests is red on 2+ consecutive pushes, drop everything and run [.claude/skills/triaging-stuck-deploy-gate/SKILL.md](.claude/skills/triaging-stuck-deploy-gate/SKILL.md). A red gate silently blocks demo deploys; testers reporting bugs against `crm.globusdemos.com` while the gate is red are inspecting stale code. Bundle all root-cause fixes into ONE commit.
- **CI env-block parity** → specs that exercise a code path gated on a runtime env-var (e.g. `WELLNESS_DEMO_OTP` for the demo-OTP bypass) MUST verify the env-var is set in `.github/workflows/deploy.yml`'s `api_tests` env block. Demo + local dev set these vars via `.env`; CI does not unless explicitly listed. Symptom of the gap: spec passes locally, fails on CI with the route's "missing config" error path. Fix is one line in deploy.yml. Surfaced in the 940b4f0 wave for `wellness-portal-dsar-api.spec.js` (verify-otp 401).
- **/api/health version is hardcoded** → the `version` field in the `/api/health` response is a **literal string** in `backend/server.js:435+443` (currently `"3.2.0"`), NOT read from `package.json`. Do NOT use it as a demo-divergence indicator — a successful deploy will leave the field reading the same hardcoded value. Use `uptime` (drops to <300s after a fresh restart) or grep `git rev-parse HEAD` on the demo box via SSH for the real divergence signal. **Closed:** `44747b4` made the field read from `package.json` and `d8a00b4` bumped to v3.4.11.
- **Local-stack-only specs must guard on BASE_URL** → specs that need to share a filesystem with the backend (disk readback, file-existence, child-process invocation of an engine) work fine in the per-push gate (api_tests, BASE_URL=127.0.0.1) but cascade-fail in `e2e-full.yml` against demo (BASE_URL=https://crm.globusdemos.com — different machine). **Two coexisting guard patterns, both correct, don't refactor between them:** (a) `const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);` + `test.skip(!IS_LOCAL_STACK, '<reason>')` at describe-level — coarse, "is the run cross-machine?" check, used by `backup-engine-api.spec.js` + `migration-safety.spec.js`. (b) `probePrismaClient()` / `dbAvailable()` at spec-level — granular, "is the backend's Prisma client actually reachable?" check, used by `recurring-invoice-api`, `retention-api`, `scheduled-email-api`, `wellness-ops-api`. Pattern (a) is simpler when the spec is fundamentally local-only; (b) is more flexible when SOME tests work cross-machine and SOME don't. They aren't equivalent (a remote-but-Prisma-installed runner is skipped by (a) but accepted by (b)), so pick based on what the spec actually needs. The route-shape contract assertions stay green cross-machine; only the disk-touching / Prisma-touching parts need the guard. Surfaced by `backup-engine-api.spec.js` (e72cd5c — was the chronic e2e-full hard-fail across v3.4.9 → v3.4.11) + `migration-safety.spec.js` (e8cce09).
- **Demo SSH ops** → for fixes that are operator-shaped, not code-shaped (Nginx config, /etc files, /var/www fixups), use [.claude/skills/applying-demo-ssh-config/SKILL.md](.claude/skills/applying-demo-ssh-config/SKILL.md). Encodes the paramiko + SFTP + sudo + `nginx -t` + auto-rollback pattern that landed #445 cleanly. SSH ops bypass CI; the safety net is mandatory.
- **API response shape change** → if you must change a public response shape, prefer "additive envelope with back-compat top-level fields" over a breaking change. The #435 multi-recipient send (`b892174`) added `totalSent` / `totalFailed` / `results` / `failures` to the envelope while keeping top-level `email` / `messageId` / `delivered` populated for single-recipient invocations — the Inbox + DocumentTemplates frontends + 50+ existing specs that destructure `body.email.id` keep working. Reserve "true breaking change" for genuinely-breaking semantic shifts where back-compat would be confusing.
- **High/critical CVE** → either remediate (preferred) or add to `backend/.audit-allowlist.json` with GHSA + reason + addedOn + sunsetBy date. Never silently allowlist.
- **Real secret leaked** → rotate immediately, squash-merge a fix commit, then run `secret-scan.yml` full-history scan to confirm clean. Never allowlist a real production secret.
- **Bug surfaced by a test** → fix the bug in code (don't skip the test). The 6b1470f `req.user.id` sweep + the Rx PUT prescriber-check fix are the canonical examples.
- **Release** → push to main → wait for `deploy.yml` green → `git tag vX.Y.Z && git push origin vX.Y.Z` → `e2e-full.yml` fires automatically against demo → if green, release stands; if red, fix on main and retag.
- **JSX text content does NOT interpret JS escape sequences** → a literal `…` written between JSX tags (e.g. `<div>Loading…</div>`) renders as the six characters `\`, `u`, `2`, `0`, `2`, `6` — not as `…`. JS string escape rules only apply inside JS expression contexts (`{...}`); JSX text is treated as XML where `\u` has no special meaning. Use the actual unicode character (`…`) or an HTML entity (`&hellip;`) instead. Bit `PerLocationDashboard.jsx:79` (#430, fixed in `6d2a435`).
- **Bash permission allowlist scope** → in `.claude/settings.json`, a permission rule like `Bash(.claude/skills/*)` matches commands STARTING with `.claude/skills/` (e.g. invoking a script: `bash .claude/skills/wire-in.sh`), NOT commands like `mkdir`/`ls`/`rm`/`cp`/`mv` where `.claude/skills/<path>` is an argument. Each common operation needs its own explicit `Bash(<binary> .claude/skills/*)` entry. Settings.json was extended in `ffd6d75` to cover the directory-management commands. Also: the Write tool auto-creates parent directories, so agents shouldn't run `mkdir` before `Write` anyway — a habit fix that sidesteps the allowlist gap entirely.
- **Cron `durable: true` flag is silently ignored** → `CronCreate` with `durable: true` reports `[session-only]` in `CronList` despite the flag. Tool description claims durable jobs persist to `.claude/scheduled_tasks.json`; observed behavior is in-memory only. Either the flag is broken or the description is wrong (likely the latter — disk-writes from the agent harness may not be enabled in this configuration). Implication: the 15-min cron stops firing whenever Claude restarts; recreate it manually after each session start (delete-and-recreate, same schedule + prompt). Original observation across `316ff9fb` → `0818d5ae` → `a132b772` → `1e6b3fba` → `cd2e6be0` → `d9c05432` (every cron in this arc was session-only).

## Known Security Notes

1. **Hardcoded JWT secret** -- falls back to `enterprise_super_secret_key_2026` when `JWT_SECRET` env var not set
2. **Auth bypass** -- admin/admin login in routes/auth.js for demo/testing (intentional)
3. **CORS allowlist** -- restricted to crm.globusdemos.com, localhost:5173, localhost:5000
4. **Rate limiting** -- express-rate-limit on all API endpoints
5. **Deployment scripts with credentials** -- removed from git tracking, added to .gitignore
6. **Credentials in git history** -- SSH and MySQL passwords in old commits, should rotate

## Local 4/4 deploy-gate mirror

Every CI gate runs locally before pushing — same containerised MySQL, same backend, same spec list. Avoids the ~10-min round-trip of waiting for GitHub Actions.

```powershell
# Windows
.\scripts\test-local.ps1 -Local              # boot stack + run all 4 gates
.\scripts\test-local.ps1 -Local -KeepStack   # leave stack up between iterations
.\scripts\test-local.ps1 -Local -SkipBuild   # only lint + api_tests + unit_tests
```

```bash
# macOS / Linux / git-bash
./scripts/test-local.sh --local              # same flags, --keep-stack, --skip-build, etc.
```

`-Local` mode auto-boots [docker-compose.yml](docker-compose.yml) (MySQL 8.0 on host port `3307` to avoid colliding with a system MySQL on `3306`), pushes the Prisma schema, seeds both tenants, then starts the backend on `:5000` with `DISABLE_CRONS=1` so cron engines don't pollute test data. PID is tracked in [.scripts-state/backend.pid](.scripts-state/) (gitignored).

**Manual stack management (if you want to iterate without re-running all 4 gates):**

```powershell
.\scripts\local-stack-up.ps1                 # boot mysql + seed + backend
.\scripts\local-stack-up.ps1 -NoSeed         # faster re-boot if seed unchanged
.\scripts\local-stack-up.ps1 -NoBackend      # only mysql + seed (debug-attach the backend yourself)
.\scripts\local-stack-down.ps1               # stop backend, leave mysql for fast next-up
.\scripts\local-stack-down.ps1 -Full         # stop mysql too (volume preserved)
.\scripts\local-stack-down.ps1 -Wipe         # nuke the volume (full reset)
```

### Why local stack instead of demo

Don't iterate route changes against `https://crm.globusdemos.com`. The demo runs **already-deployed** code — your local edits aren't there until the next deploy. Running tests against demo to "validate" a local change tests last commit's behaviour, not yours. This trap caused multiple confused debugging cycles before the local stack landed.

Local stack mirrors the deploy.yml `api_tests` gate exactly (same Prisma schema, same seed, same `BASE_URL=http://127.0.0.1:5000`). When the local gate goes green, the CI gate will go green for the same reason.

The narrow exception: when you specifically want to verify a deployed change against demo's accumulated real seed data, point at demo explicitly with `BASE_URL=https://crm.globusdemos.com`. The release-validation `e2e-full.yml` workflow does this on tag push and self-cleans afterwards via the `scrub-demo` job (commit db932ab).

### `.claude/settings.json` allow-list

Project-shared at [.claude/settings.json](.claude/settings.json) — auto-approves the inner-loop commands (scripts/, prisma db push / generate / migrate, npm test / build, npx vitest / playwright test, read-only docker + read-only gh CLI) so engineers don't get prompted on every iteration. Anything not on the allow list still goes through the normal approval flow. Personal overrides go in [.claude/settings.local.json](.claude/) (gitignored).

## E2E Testing

Tests live in `e2e/` using Playwright. Run with:

```bash
cd e2e && BASE_URL=https://crm.globusdemos.com npx playwright test --project=chromium
```

- `tests/ship-readiness.spec.js` — 74 tests covering auth, 50 API endpoints, security, public endpoints, UI page serving
- `tests/wellness.spec.js` — 50+ wellness-specific tests: tenant + currency, dashboard, patients/visits/Rx/consent flow, recommendations, full external API flow, reports, junk filter, auto-router, public booking, orchestrator, SPA route smoke
- `tests/demo-health.spec.js` + `tests/demo-hygiene-api.spec.js` + `tests/teardown-completeness.spec.js` — closed-loop demo cleanliness assertions backed by [demo-monitor.yml](.github/workflows/demo-monitor.yml) cron (every 30 min, opens a tracker issue on failure)
- Plus ~150 module-level api specs (each `routes/*.js` has a `tests/<route>-api.spec.js` partner). Latest additions: `landing-pages-api`, `workflows-api`, `integrations-api`, `audit-api`, `search-api`, `email-api`.

**~1,665 API tests on every push** (deploy.yml api_tests gate, **50 specs**) **+ 803 vitest unit tests** (deploy.yml unit_tests gate, **30 files**) = **~2,468 total per-push**. Plus ~2,500 broader UI/wellness/a11y tests on every release tag (e2e-full.yml). Demo-monitor cron polls the deployed box every 2 hours; auto-issue on failure (filed against a stable-title issue so re-runs comment instead of spamming).

## GitHub

- **Issue tracking:** GitHub Issues with automated QA bug evidence screenshots
- **QA screenshots:** `qa_screenshots/` and `e2e_screenshots/` directories
- **GitHub Actions:** `.github/workflows/post_comments.yml` -- auto-posts comments on issues

## Development Setup

```bash
# Backend
cd backend && npm install && npx prisma generate && npx prisma db push && npm run dev
# API on http://localhost:5000, Swagger at /api-docs

# Frontend
cd frontend && npm install && npm run dev
# UI on http://localhost:5173

# Seed database
cd backend && node prisma/seed.js

# Run E2E tests
cd e2e && npm install && npx playwright test --project=chromium
```

## 🤖 Cron learnings (auto-logged — pending manual review)

The 15-min recurring cron appends short observations here at the end of every wave: patterns, drift findings, non-obvious-things-learned that **aren't yet codified into a skill or standing rule**. The cron does NOT create skills itself — that's high-judgment work and belongs to a human-in-the-loop.

**The user triggers the review manually whenever they want** (could be daily, every couple of days, weekly — whatever cadence fits). Typical phrasing: "review the cron learnings" or "let's go through the cron-logged stuff." When invoked, walk through each entry and propose: (a) **skill-worthy** → new skill or extension to existing; (b) **standing-rule worthy** → one-liner in "Standing rules for new code"; (c) **already covered** → archive to `docs/cron-learnings-archive.md` and remove from this section; (d) **not actionable** → drop with rationale. **Wait for the user's `yes` per entry before making any changes** — over-creating skills bloats the surface.

**Format:** one bullet per learning, prefixed with `<YYYY-MM-DD HH:MM> — <commit-sha or "no-commit">` + a short topic + a one-paragraph observation. Keep it tight; if it doesn't fit in a paragraph, the learning is too big and should go straight into a TODOS.md user-attention item instead.

**Why this lives in CLAUDE.md (not a separate file):** the autonomous loop needs to find this section by name to append into, and the manual review needs the section visible in every session's context. CLAUDE.md is loaded by default, so both reads are reliable. After review, accepted entries move to their permanent home (skill / standing rule) and the bullet is removed; archived ones go to `docs/cron-learnings-archive.md`.

**Don't manually add to this section unless you're the cron** — use TODOS.md handoff blocks for everything else.

### 2026-05-05 evening — observations from the 5-agent parallel wave

- **2026-05-05 ~07:00 — `1ef4ba5` — concurrent agents share the git index, not just the working tree.** When 5 agents run in parallel against the same repo, each agent's `git add file` leaves staged things behind in the shared index. A parent agent's later `git commit` (without explicit pathspec) sweeps up sibling agents' WIP. Hit this once mid-wave: my `git commit` of the #413 schema fix bundled in 6 unrelated files (Agent B's e2e specs + the deduplication helper). Caught pre-push via `git status --short`, did `git reset HEAD~1 --mixed`, re-staged only my 2 files with explicit pathspec, clean push. **Mitigation pattern:** always `git add <explicit-files>` followed by `git commit` (which only commits staged things) OR `git commit <explicit-files>` directly (which only commits the named files). Never `git commit -a` when sibling agents are running. The dispatching-parallel-agent-wave skill should call this out — currently it warns about file-overlap collisions but not index-sharing.
- **2026-05-05 ~07:00 — `51e8891` — apply `verifying-issue-before-pickup` to multi-day flagships, not just issues.** G-21 (Frontend vitest + RTL coverage expansion) was estimated 3-5 days in TODOS for several sessions. Agent D shipped it in ~10 minutes of real work because vitest infra was ALREADY in `frontend/vite.config.js` from earlier waves (commits `f752c85` Mar 2026 + `6e66845` Apr 2026), with 18 existing test files. The actual gap was just (a) wire the existing tests into a CI gate (didn't exist on per-push), (b) fix 3 stale failing tests pinned to pre-#343 contracts, (c) add 6 new test files for under-covered surfaces. The 3-5 day estimate was based on assuming greenfield setup. **Pattern:** when a TODO row says "set up X" or "stand up Y" or "bootstrap Z", grep first for existing X/Y/Z signals (`grep -r "vitest" frontend/`, `find . -name "*.test.*"`) before estimating from zero. Same logic as Pattern A drift on issues, applied to flagships.
- **2026-05-05 ~07:00 — `(no-commit)` — Agent C's "stop-before-push when CI gate would fail" discipline is a load-bearing pattern.** Agent C completed the #413 schema work but stopped before push because `check-migration-safety.js` flagged 6 false-positive risks. The agent reported the flag, asked for direction, and waited rather than push-and-hope. This let the parent (a) confirm the false-positive analysis, (b) ship a one-line detector bug-fix bundled with the schema change in the same commit (`1ef4ba5`). Had the agent pushed anyway, the migration-check.yml gate would have gone red on `main` and blocked all subsequent schema work until manually cleared. **Pattern worth elevating:** "If a local CI-equivalent gate (eslint, vitest, migration-safety, etc.) flags an issue you can't trivially resolve, STOP and report — don't push and hope the gate's wrong." The dispatching-parallel-agent-wave skill's "5-iteration heal cap" is similar but framed for test failures; this is the same shape for non-test gates.
- **2026-05-05 ~08:00 — `6f140bc` — agents authoring NEW specs MUST run them locally before committing.** Agent A's `9abbafe` shipped a new `landing-page-upload-api.spec.js` that compiled clean (`npm run build` green, eslint clean, `node --check` green) but FAILED on every per-push api_tests run — the spec read tenant-id from `j.user?.tenantId` instead of `j.tenant?.id` (login response shape: `{ token, user: {...}, tenant: { id, ... } }`). Result: 4 consecutive failed deploys (9abbafe → 51e8891 → 1ef4ba5 → cc1a0ca), demo stuck at b180c4b for ~50 min, AND e2e-full's "upload" + adjacent specs all 404'd because the route never deployed. Build/lint/syntax checks don't catch this class of bug — only running the spec does. **Mitigation:** dispatching-parallel-agent-wave skill should require agents that author NEW specs (not just edit existing ones) to run `cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test --project=chromium tests/<new-spec>.spec.js` against the local stack BEFORE committing. The agent prompts for Agent A and B explicitly listed verification commands; Agent A's verification list included build + lint + node --check but skipped running the new spec. Add "if the agent authored a NEW spec, running it locally is mandatory" to the skill's verification section.
- **2026-05-05 ~22:30 — `36e554d` — unblocking previously-unreachable code paths surfaces latent bugs.** The #445 Nginx fix that landed earlier this session enabled `POST /p/<slug>/submit` to actually reach the backend (pre-fix, the SPA shell intercepted it). The handler at `routes/landing_pages.js:438` had a latent bug — `prisma.contact.upsert({ where: { email: contactEmail }, ... })` against a Contact model whose unique constraint is `@@unique([email, tenantId])`. Prisma's upsert requires the where clause to match a unique constraint exactly; single-field email isn't unique, so the call threw a Prisma validation error → catch-all 500 → "Submission failed". The bug had been there since the original landing-page module shipped, but no real traffic ever hit it (Nginx blocked everything) so no production signal. **Pattern:** when an infrastructure fix unblocks a previously-unreachable code path, ALSO end-to-end-test the now-reachable path. Easy to celebrate "unblocked!" without realizing the path itself accumulated latent bugs while it was dark. Verifying-issue-before-pickup grep would not catch this — you have to actually hit the route.
- **2026-05-05 ~22:30 — `47e7a1d` — e2e-full assertions on aggregate counters don't survive demo's background activity.** `workflows-api.spec.js:279` asserted `afterTotal === beforeTotal` on generic's workflow-history count after a wellness fire. On the per-push gate (local stack with `DISABLE_CRONS=1`), the count was always exact. On demo (e2e-full), background cron engines (workflow, sequence, sentiment, scheduled-email) fire generic-tenant rules continuously; the count grew by +6 in the few hundred ms between before/after measurements. Pure noise, no real leak. **Pattern:** when authoring tenant-isolation / cross-tenant-leak / counter-stability tests intended to run against demo (e2e-full), assert on **specific rows the test created** (search for the rule's id, the tag, the unique payload field), NOT on aggregate counts that include unrelated background activity. Same shape as Agent B's e2e Category 1 fix (replace snapshot-diff with per-fire `_marker` payload field).
- **2026-05-05 ~23:00 — `d84b0d9` — iterate-on-CI-feedback closed the chronic-red e2e-full arc that had been stuck since v3.4.9.** Sequence: triggered run → categorize failures (real-bug / spec-fixture / demo-state / deploy-block) → fix the first category → push → wait for deploy → re-trigger → repeat. 4 e2e-full re-triggers across this session, each revealing a different failure class as the prior was cleared: (a) backup-engine + migration-safety needed `IS_LOCAL_STACK` guards (e72cd5c, e8cce09); (b) Agent A's new upload spec had a `j.user.tenantId` capture bug blocking the deploy gate (6f140bc); (c) workflows-api count-based assertion was demo-noise-flaky (47e7a1d); (d) Contact upsert had a latent composite-unique bug exposed by the #445 Nginx fix (36e554d) + 5MB upload returns Nginx 413 not multer 400; (e) email_scheduling 502 path returned HTML not JSON; workflows-flow polling too short + leak detection too broad (d84b0d9). Final result: all 4 shards green for the first time since v3.4.9. **Pattern:** when CI is chronically red, treat it like a stuck-deploy-gate triage — categorize, fix, retrigger, observe, repeat. ~1.5 hours of fix-and-iterate beats weeks of "we'll fix it next session." Same workflow shape as the `triaging-stuck-deploy-gate` skill but applied to release-validation instead of per-push.
- **2026-05-06 ~00:30 — `55fef9f` — `git commit --only <files> -F msg` is the safe form during concurrent agent waves.** When 5 parallel agents work in the shared repo, the global git index is a shared mutex — a parent's `git add X Y && git commit` (no pathspec on the commit) can race with a sibling agent's `git add` and accidentally sweep up the sibling's WIP. Agent F's first commit attempt (`cfb9973`) captured 7 of Agent J's files this way; they soft-reset and re-committed with `git commit --only contacts.jsx inbox.jsx -F msg.txt` which atomically pins the commit to ONLY those files even if the index races mid-operation. **Mitigation pattern:** in any parallel-agent wave, agents should use `git commit --only <pathspec> -F msg.txt` instead of `git add <pathspec> && git commit`. Add to dispatching-parallel-agent-wave skill's "Standing rules" preamble. Builds on the prior cron-learning about index-sharing — that learning identified the problem; this one names the precise tool flag to fix it.
- **2026-05-06 ~00:30 — `(observation)` — GitHub auto-close trailers cap silently when a single commit lists 5+ "Closes #N" trailers.** Both Agent G's `a2895d8` (`Closes #462 + #463` shortform) and Agent J's `ecb4ae0` (7 separate `Closes #N` lines) had trailers that DIDN'T fire — `#463` and `#476` (and on a separate verify, `#473` and `#465`) stayed OPEN despite explicit trailers in well-formed commit-message body. The shortform-vs-separate-line distinction matters somewhat (`Closes #N + #M` only auto-closes the first per GitHub's grammar), but the per-commit cap is real too. **Mitigation:** after pushing a multi-issue-closing commit, ALWAYS run `for n in <issues>; do gh issue view $n --json state --jq '.state'; done` to verify each closed; manually `gh issue close <N> --reason completed --comment "Fixed in <SHA> — auto-close didn't fire (cap)"` for any that didn't. The dispatching-parallel-agent-wave skill's `bumping-version-docs` companion should encode this verify-then-close-manual step.
