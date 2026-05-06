# Globussoft Enterprise CRM -- Project Context

## 🗂️ Engineering backlog — read TODOS.md on session start

The persistent backlog of multi-day / architectural work that's been deferred from cron + overnight runs lives in **[TODOS.md](TODOS.md)** at repo root. It's grouped by priority bucket (🟡 ship-this-month, 🔴 bigger investments, 🚫 don't-patch-rethink) plus the architectural cron-skipped GitHub issues, test debt, and a PRD-gap analysis. Each item has the diagnosis, recommended approach, and effort estimate.

**On session start, read TODOS.md before picking up new work** so you don't duplicate something already triaged or skip an item that's already been planned.

### Closed gap-files live under [docs/gaps/archive/](docs/gaps/archive/)

When a gap / backlog / regression-tracking file is **fully closed** (every entry shipped, zero `⬜` / `☐` / `TODO` / `open` markers remaining), it moves under `docs/gaps/archive/` rather than getting deleted — see [docs/gaps/archive/README.md](docs/gaps/archive/README.md) for the convention. Active backlogs (`TODOS.md`, `docs/E2E_GAPS.md`, `docs/regression-coverage-backlog.md`) STAY at their root locations as long as ≥1 item is open. Don't archive a file just because most items are closed — cohesion of the original file beats archive cleanliness.

## Overview

Full-stack enterprise CRM built by Globussoft Technologies. Mirrors top-100 CRM platforms with a glassmorphism UI. **Multi-tenant with vertical configurations** — a single codebase serves generic B2B CRM users AND the wellness vertical (clinics, salons, aesthetics).

- **Repo:** https://github.com/Globussoft-Technologies/globussoft-crm
- **Version:** v3.4.14 — see [CHANGELOG.md](CHANGELOG.md) for the full release history. Per-push gate is currently ~79 Playwright specs / ~2,560 tests + 43 backend vitest files / ~1,196 tests + 6 frontend vitest files / ~35 tests (~3,791 total) across 6 mandatory deploy gates + a separate PR pre-merge checks workflow (vite build + ESLint), with 12 reusable Claude Skills under `.claude/skills/`.
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
- **Cross-cutting shape change** (auth-status flip, response-envelope rename, DELETE-success status flip, /api/health body reshape) → run [.claude/skills/auditing-cross-cutting-spec-impact/SKILL.md](.claude/skills/auditing-cross-cutting-spec-impact/SKILL.md) BEFORE pushing. The per-push gate's spec list (~50 `*-api.spec.js`) is a strict subset of e2e-full's (~200+ specs including bare `*.spec.js` smoke tests). Cross-cutting changes that pass per-push routinely red e2e-full because the bare specs aren't in the per-push list. v3.4.14's release-validation cycle force-moved its tag three times before going green; two of those rebuilds (#537 missed 7 specs, #550 missed 3 bare specs) were preventable by the audit. Pair with [.claude/skills/executing-cross-route-shape-sweep/SKILL.md](.claude/skills/executing-cross-route-shape-sweep/SKILL.md) when the change is a multi-route sweep.
- **PR review against current main, not the PR's base** → when reviewing an open PR, `git diff main..<pr_head> -- <file>` is the load-bearing read, not the PR's own diff against its branch base. PRs branched from older commits silently revert any work landed on main since the branch was cut. PR #566 on 2026-05-07 dropped an `email_scheduling.js` diff that reverted `#524` + `#524-followup` (commits `13edd42` + `316d5a0`) because the PR was branched from before those fixes; the reverse-diff against current main exposed it instantly while the PR's own commit-diff looked clean. **Fix-when-this-happens:** selectively merge — apply the PR's intended files but `git checkout main -- <reverted-file>` to keep current-main's version, then commit + comment on the PR explaining what you held back and why. Reference: commit `b78e484` is the canonical pattern.
- **Force-moving a release tag re-drafts its GitHub Release** → when fixing a red e2e-full on the same version, the tag-move dance is `git tag -d X && git push origin :refs/tags/X && git tag X && git push origin X`. **GOTCHA:** if the tag had a published GH Release, that Release silently flips back to draft state with a `untagged-<hex>` URL. The canonical Release URL stops working until you re-publish via `gh release edit X --draft=false --latest`. External links / package consumers break silently. Verify with `gh release view X` showing `draft: false`. v3.4.14 hit this twice during the four tag-attempt cycle.
- **API response shape change** → if you must change a public response shape, prefer "additive envelope with back-compat top-level fields" over a breaking change. The #435 multi-recipient send (`b892174`) added `totalSent` / `totalFailed` / `results` / `failures` to the envelope while keeping top-level `email` / `messageId` / `delivered` populated for single-recipient invocations — the Inbox + DocumentTemplates frontends + 50+ existing specs that destructure `body.email.id` keep working. Reserve "true breaking change" for genuinely-breaking semantic shifts where back-compat would be confusing.
- **High/critical CVE** → either remediate (preferred) or add to `backend/.audit-allowlist.json` with GHSA + reason + addedOn + sunsetBy date. Never silently allowlist.
- **Real secret leaked** → rotate immediately, squash-merge a fix commit, then run `secret-scan.yml` full-history scan to confirm clean. Never allowlist a real production secret.
- **Bug surfaced by a test** → fix the bug in code (don't skip the test). The 6b1470f `req.user.id` sweep + the Rx PUT prescriber-check fix are the canonical examples.
- **Release** → push to main → wait for `deploy.yml` green → `git tag vX.Y.Z && git push origin vX.Y.Z` → `e2e-full.yml` fires automatically against demo → if green, release stands; if red, fix on main and retag.
- **JSX text content does NOT interpret JS escape sequences** → a literal `…` written between JSX tags (e.g. `<div>Loading…</div>`) renders as the six characters `\`, `u`, `2`, `0`, `2`, `6` — not as `…`. JS string escape rules only apply inside JS expression contexts (`{...}`); JSX text is treated as XML where `\u` has no special meaning. Use the actual unicode character (`…`) or an HTML entity (`&hellip;`) instead. Bit `PerLocationDashboard.jsx:79` (#430, fixed in `6d2a435`).
- **Primary CTAs use `var(--primary-color, var(--accent-color))`** → wellness theme ([frontend/src/theme/wellness.css:18-20](frontend/src/theme/wellness.css#L18-L20)) defines `--primary-color: #265855` (teal, the brand) and `--accent-color: #CD9481` (blush, the *secondary*). Generic theme ([frontend/src/index.css:9,49](frontend/src/index.css#L9)) defines only `--accent-color` (blue) — no primary. **Bare `var(--accent-color)` for primary CTAs renders salmon under wellness.** Use `var(--primary-color, var(--accent-color))` for primary CTAs and active-state surfaces (Reports.jsx:212-215 is the canonical pattern); use bare `var(--accent-color)` only for genuinely-secondary accents (decorative icons, low-priority text-only actions). Bit 12+ instances across the v3.4.12 wave (#489 #490 #491 fixed; 5 more open as #520). Hardcoded `#8b5cf6` / `#6366f1` purple is off-brand under both verticals — never ship it.
- **Ellipsis on flex/grid children needs `min-width: 0` at every nesting level** → for `text-overflow: ellipsis` to actually clip on a flex/grid child, the chain needs `min-width: 0` at: the parent grid track (via `minmax(0, ...)` not `minmax(<px>, ...)`), the cell, AND the inner inline-block holding the text. Without it the rule silently degrades to "stretch parent" and no clipping happens. Surfaced by W1-A in v3.4.12 wave.
- **Responsive grid without media queries** → prefer the single-source pattern `gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))'` + `gridColumn: '1 / -1'` for full-row spans. The `min(100%, 240px)` lets cells go below the 240px floor on truly narrow viewports, so no `@media` is needed. Reduces the surface for "page works at 1024 but breaks at 375" bugs. Worth promoting to a shared utility class in `frontend/src/styles/responsive.css`. Surfaced by W1-B in v3.4.12 wave.
- **Verify lint rule is configured before adding `eslint-disable-next-line`** → before sprinkling `// eslint-disable-next-line <rule>` directives, grep `frontend/eslint.config.js` (or `backend/eslint.config.js`) to confirm the rule actually exists. Disabling a non-installed rule trips the "Definition for rule '<rule>' was not found" error and reds the lint gate. Channels.jsx in W2-F shipped `jsx-a11y/alt-text` disable directives without the plugin in config — single-line hotfix `548da0f` to drop the directive + use `alt=""` instead.
- **Bash permission allowlist scope** → in `.claude/settings.json`, a permission rule like `Bash(.claude/skills/*)` matches commands STARTING with `.claude/skills/` (e.g. invoking a script: `bash .claude/skills/wire-in.sh`), NOT commands like `mkdir`/`ls`/`rm`/`cp`/`mv` where `.claude/skills/<path>` is an argument. Each common operation needs its own explicit `Bash(<binary> .claude/skills/*)` entry. Settings.json was extended in `ffd6d75` to cover the directory-management commands. Also: the Write tool auto-creates parent directories, so agents shouldn't run `mkdir` before `Write` anyway — a habit fix that sidesteps the allowlist gap entirely.
- **Cron `durable: true` flag is silently ignored** → `CronCreate` with `durable: true` reports `[session-only]` in `CronList` despite the flag. Tool description claims durable jobs persist to `.claude/scheduled_tasks.json`; observed behavior is in-memory only. Either the flag is broken or the description is wrong (likely the latter — disk-writes from the agent harness may not be enabled in this configuration). Implication: the 15-min cron stops firing whenever Claude restarts; recreate it manually after each session start (delete-and-recreate, same schedule + prompt). Original observation across `316ff9fb` → `0818d5ae` → `a132b772` → `1e6b3fba` → `cd2e6be0` → `d9c05432` (every cron in this arc was session-only).
- **After infrastructure / deploy fixes, end-to-end-test the now-reachable code paths** → when an Nginx config / auth-guard / firewall / port-forwarding fix unblocks a previously-unreachable route, that route's handler may have accumulated latent bugs while no real traffic could exercise it. The 2026-05-05 wave's `36e554d` was the canonical case: the #445 Nginx fix enabled `POST /p/<slug>/submit` to actually reach the backend, and the handler had a latent `prisma.contact.upsert({ where: { email } })` bug against a Contact model whose unique constraint is `@@unique([email, tenantId])` — Prisma threw a validation error → catch-all 500 → "Submission failed" for every public visitor. The bug had been in the original landing-page module since first ship; no production signal because Nginx blocked everything. **Standing rule:** every infra-unblocking fix gets a smoke test against the now-reachable path BEFORE celebrating "unblocked." `verifying-issue-before-pickup` grep does NOT catch this — you have to actually hit the route (curl, Playwright spec, or live demo click).
- **Demo-state-aware test assertions: target tagged-data-specific rows, not aggregate counters** → tests intended to run against `e2e-full.yml` (release-validation against demo) cannot use `expect(afterTotal === beforeTotal).toBe(true)` style assertions on counters that include unrelated demo background activity. The 2026-05-05 wave's `47e7a1d` was the canonical case: `workflows-api.spec.js:279` asserted exact-equality on generic's workflow-history total after a wellness fire. On per-push (local stack with `DISABLE_CRONS=1`) the count was always exact. On demo, background cron engines (workflow / sequence / sentiment / scheduled-email) fire generic-tenant rules continuously — count grew by +6 in the few hundred ms between before/after measurements. Pure noise. **Standing rule:** when authoring tenant-isolation / counter-stability tests for `e2e-full`, assert on **specific rows the test created** (search for the rule's id, the RUN_TAG, the unique payload `_marker` field), NOT on aggregate counts. Same shape as Agent B's e2e Category 1 fix in `cc1a0ca`. This is distinct from the `IS_LOCAL_STACK` standing rule above (which is about which TESTS run cross-machine; this is about how surviving tests' ASSERTIONS are written).

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

_(Last review 2026-05-06 dispositioned all 9 entries: 5 promoted to dispatching-parallel-agent-wave skill (concurrent-agent git hygiene, stop-before-push when CI gate fails, run NEW specs locally, verify auto-close after multi-issue commits), 1 to verifying-issue-before-pickup (apply pre-flight grep to flagships), 1 to triaging-stuck-deploy-gate (release-validation variant), 2 to standing rules (after-infra-fix end-to-end test, demo-state-aware assertions). Full disposition rationale in [docs/cron-learnings-archive.md](docs/cron-learnings-archive.md).)_

- **2026-05-07 wave-1 — `ba71dc1` — 404 on a route that "looks unmounted" can have TWO simultaneous causes (Nginx + backend handler).** Agent A's investigation of #542 (`/api-docs` returning SPA index.html) found a two-layer root cause: (1) Nginx site config on demo had no `location /api-docs` block, so requests fell through `location /` SPA fallback (same class as the #445 `/p/` fix); AND (2) the backend lacked an explicit `app.get('/api-docs/swagger.json')` handler, so swagger-ui-express's `setup()` catch-all served UI HTML on every sub-path including the JSON endpoint. The backend's `app.use('/api-docs', swaggerUi.serve, ...)` was correctly positioned BEFORE the SPA catch-all already, but on its own it wasn't enough. Pattern: when a route appears 404 (or wrong-content) on demo but works locally, check Nginx config AND backend handler in parallel — not sequentially. The applying-demo-ssh-config skill handles the ops half; the spec-side and backend-handler half is what's not codified yet. Worth a standing-rule one-liner ("infra route fix needs a paired backend route fix more often than you think") if a third instance lands.

- **2026-05-07 wave-1 — `f2275e5` — selective migration is the right call when a class fix has long-tail "no clean replacement" sites.** Agent C's #523 issue title said "11 brittle attribute selectors" but only 6 had a single-site target with a clean class hook. The other 8 were broad multi-site selectors (`minmax(200/220/240/260/...px)` + `display:flex + gap`) pattern-matching 13-888 separate JSX sites each. Migrating those would have been a multi-day refactor outside the issue's stated `~2-3h` scope. Agent retained them with **inline comments documenting why each is kept + the page list it targets**, turning future-implicit "this still uses brittle pattern matching" tech-debt into explicit-and-traceable scope. This is the right shape of a class-fix sweep when the long-tail isn't worth the diff cost — explicit deferral with reasons beats implicit completion. Pairs with the `executing-cross-route-shape-sweep` skill's "if you find unusual cases mid-sweep, flag them separately rather than guessing" guidance — the inline comment IS the flag. Worth checking whether the skill already covers this pattern; if not, a one-line addition.

- **2026-05-07 wave-2 — `no-commit` (#567 filed instead) — pen-test "non-determinism" framings can mask orthogonal correctness bugs.** Agent D investigated #552/#553/#554 (dashboard "varying KPIs / sometimes-zero / flicker") and confirmed ZERO non-determinism in the current demo (5 consecutive calls byte-identical; 25-call burst all-200, no rate-limit). The cluster's symptoms were a downstream effect of the #529 sidebar dep-cycle storm, fixed in `8bdecbe` — pre-fix, the storm tripped the rate-limiter, the dashboard silently swallowed the resulting errors and rendered all-zeros, and the next successful refresh returned different paginated numbers. **But under that, Agent D found a real correctness bug**: `Dashboard.jsx:14-58` computes Closed Revenue / Expected Revenue / Total Deals client-side by reducing over `/api/deals?limit=100&orderBy=createdAt:desc`. Demo has 5,381 deals with $5B in closed revenue across 375 won deals; the newest-100 window contains 1 won deal, so the dashboard renders "Closed Revenue $0" permanently — consistent now, but consistently wrong. Filed as #567. **Pattern:** when the pen-test's framing (non-determinism / flicker / varying numbers) doesn't reproduce, don't close — investigate what the framing was a *symptom* of. The bug surfaced underneath was bigger than the bug filed. Worth a one-liner standing-rule extension to `verifying-issue-before-pickup`'s pattern catalogue if a third instance lands.

- **2026-05-07 wave-2 — `83d2a88` — concurrent agents in the SAME working directory can collide via git state, even on disjoint files.** Agent E (P0 wellness-RBAC regression spec) ran a revert-and-prove cycle which created throwaway branch `throwaway-revert-prove`, modified `wellness.js` mid-cycle, then restored both. Agent D (dashboard discovery) was dispatched in parallel and inherited the dirty state mid-cycle — they correctly detected it and refused to commit anything, which is why nothing broke. **But the dispatch was fragile.** Two patterns to consider for future parallel waves: (a) require revert-and-prove agents to use `git worktree add` for isolated checkouts (Agent harness has `isolation: "worktree"` parameter); (b) explicitly warn parallel agents of "you're sharing CWD with N siblings" so each can detect+respect dirty state from a peer. The dispatching-parallel-agent-wave skill mentions disjoint-FILES invariant but not disjoint-GIT-STATE. Pattern is one instance only so far; flag for review on the next instance. **2026-05-07 wave-3 update:** verified the worktree-isolation approach works — Agent G ran auth-security regression spec with `isolation: "worktree"` while Agents F + H worked in shared CWD; zero collision, zero dirty-state inheritance. Pattern promotable to skill on the next instance.

- **2026-05-07 wave-3 — `b232110` (Agent F) — the existing `/api/deals/stats` endpoint already had the right SHAPE for the dashboard; what was missing was 5 specific aggregate FIELDS.** The #567 fix didn't need a new endpoint; it needed `wonCount`, `wonValue`, `lostCount`, `lostValue`, `expectedValue` added to the existing route. Pre-fix, the dashboard ignored `/stats` entirely and reduced over a paginated list — likely because pre-stats-shape predates the multi-aggregate dashboard. **Pattern:** when a frontend uses client-side aggregation over a paginated list, check whether a server-side stats endpoint already exists for that resource — and if it does, the fix is usually adding fields, not adding endpoints. Cheaper than rewriting either side. Worth a one-liner standing rule if a third instance lands.

- **2026-05-07 wave-3 — `no-commit` (Agent H) — close-comment language can introduce phantom carry-over work.** Agent H's #534 follow-up profile against demo found zero endpoints >0.5s — the original fb719e6 fix actually addressed all 4 endpoints the pen-test named, not just 2. The "remaining 2" framing was introduced by the close-comment author (sumitglobussoft), not by fb719e6's commit message. The phantom carry-over then propagated into TODOS.md across THREE separate sections (active backlog row 21, v3.4.15 carry-over row 103, bigger-investments row 152) — Agent H struck all three with rationale links. **Pattern:** when authoring a "fix shipped, X remaining" close-comment, audit whether the fix has a real residual or whether the framing came from the issue body's count and not the actual diff. Phantom carry-over costs >0 — Agent H spent ~25 min profiling something that was already done. Worth a one-liner standing rule if a third instance lands.

- **2026-05-07 wave-3 — `db543af` (Agent G) — `isolation: "worktree"` is leaky when the agent needs a running backend OR file-system-grep against frontend source.** Agent G's revert-and-prove cycle for the auth-security regression spec (P1) needed two things the worktree alone couldn't provide: (1) a running backend with `node_modules` (worktree only had source, no install), and (2) the file-grep tests pointing at `frontend/src/App.jsx` resolved that path through the running stack which read from main-repo not the worktree. Agent G's workaround was to edit main repo's `backend/middleware/security.js` + `routes/wellness.js` for the backend reverts AND the worktree's `frontend/src/App.jsx` for the file-grep test, then restore both before commit. **The workaround was correct and shipped clean** (see `db543af`'s revert-and-prove evidence in the commit body), but it shows worktree-isolation isn't fully isolated when the work straddles a running-process boundary. **Two follow-ups to consider:** (a) when dispatching a worktree-isolated revert-and-prove agent, also dispatch a parallel "boot a backend in the worktree" sub-task, OR (b) document this leak explicitly in the dispatching-parallel-agent-wave skill so future agents plan around it. Pattern reproduced in wave-4 by Agent I (audit-coverage spec, also worktree-isolated) — same workaround (revert against main repo's running backend, restore before commit). **Two instances now; promotion-eligible.**

- **2026-05-07 wave-4 — `fef51a6` (Agent I) — gap cards drift from reality on action-verb naming and entity-coverage scope.** The regression-coverage-backlog item #5 said "hard DELETE on Contact/Deal/Estimate/Task emits a `*_DELETED` AuditLog row (#167)". Spec implementation found the actual emissions are `SOFT_DELETE` (not `*_DELETED`) because all four use soft-delete via `deletedAt`; INVOICE PATCH emits `INVOICE_UPDATE` (not generic `UPDATE`). Spec correctly pinned to reality and documented the discrepancy. Pipeline CRUD has zero `writeAudit` calls — gap card assumed coverage that never existed. Filed as #568 + #569. **Pattern:** when implementing a spec from a gap card, treat the card's claim about action-verb shape as a hypothesis to verify, not a contract to assume. Two corollaries: (1) the spec for "asserts action verb X exists" should be derived from grepping the actual `writeAudit(...)` callsites in `backend/routes/`, not from the gap card's quoted action; (2) "no audit row exists" is a valid first-pass assertion that flips to positive once the missing emission is added — the gap-tracking pattern Agent I used. Worth a one-liner standing rule on next instance.

- **2026-05-07 wave-4 — `c1c6075` (Agent J) — regression-coverage spec writing surfaces real backend gaps that ship inline with the spec.** Agent J's #14 spec for /public/book + /public/tenant/:slug + /embed/lead-form.html exposed three real backend gaps that needed code, not just test pins: (1) `publicBookLimiter` was missing entirely — spec ships the rate limiter alongside the test; (2) `/public/tenant/:slug` had a MySQL collation issue where `ENHANCED-WELLNESS` matched the seeded `enhanced-wellness` slug (case-insensitive collation); spec adds a shape-check that rejects upper-case slugs at the route layer; (3) `/embed/lead-form.html` had no GET-time API-key validation — spec adds a server-side route that 404s for malformed/unknown keys. **Pattern:** P1+ regression-coverage agents that ship "the spec for what we wish were true" naturally drift into shipping the missing code too. This is fine and good — explicit-spec-first matches the standing rule "every fixed bug needs a regression test" — but the dispatch's effort estimate doubles. Worth considering when sizing similar items: 1d card in the backlog → 2d real if the missing code is non-trivial. The dispatching-parallel-agent-wave skill could add a "spec may surface backend gaps; size accordingly" note.

- **2026-05-07 wave-5 — `8fd3283` (Agent L) — unit tests can pin a helper's contract but cannot enforce that all callsites use the helper.** Agent L shipped 31 vitest cases for `formatMoney` covering all 5 acceptance points from regression-coverage-backlog #22. The test suite locks in the helper's CONTRACT (INR/USD/EUR formatting, sub-paise rounding, no-double-symbol invariant, locale variants). But the bugs the gap card cited (#286 / #330 — `$` showing on a wellness/INR tenant) were callsite drift: SOMEWHERE a render uses `${amount}` template literal instead of going through formatMoney. The unit test cannot detect callsites that bypass it. **Pattern:** when a unit test closes a backlog item that originated from a "wrong-symbol-rendered" / "wrong-format-shipped" production bug, ALSO file a callsite-sweep follow-up — a one-time grep audit (e.g. `grep -rn '\\$\\$\\{' backend/services/ backend/routes/ frontend/src/`) plus an ESLint custom rule (or at least a TODO comment) to prevent regression. Agent L correctly noted this scope-limit in the commit body + the backlog card; the follow-up audit is now a TODOS user-attention item below. **Confirmed by wave-6 (Agent N for datetime, regression-23, Path B): same shape — helper-port + tests pin contract, callsite-migration filed as a follow-up.** Two instances now; the helper-port-then-callsite-sweep is a stable two-wave pattern.

- **2026-05-07 wave-6 — `c6d422a` (Agent N follow-up) — vitest TZ-label assertions are NOT portable across Node ICU builds.** Agent N's first push (`663bd7c`) of the datetime regression-23 spec went red on CI's `unit_tests` gate even though it passed locally. Root cause: `date-fns-tz`'s `'zzz'` token renders differently depending on the Node binary's ICU build + tzdata version. Local-dev Node renders IANA short names (`'IST'`, `'EST'`, `'EDT'`); CI's Node renders offset forms (`'GMT+5:30'`, `'GMT-5'`, `'GMT-4'`). Both are correct ISO output — different ICU. Agent N's follow-up commit `c6d422a` made the assertions ICU-agnostic: pin the wall-clock prefix verbatim (deterministic), assert TZ-label presence via flexible regex (accepts both forms), and added a "winter label MUST differ from summer label" test that catches the DST-silently-ignored regression class without binding to label format. **Pattern:** before pinning verbatim TZ-label strings in vitest, run `node -e "console.log(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Kolkata', timeZoneName: 'short'}).format(new Date()))"` on the CI runner (e.g. via a one-line workflow_dispatch probe) to confirm what tokens it actually renders. Local-dev output is not authoritative for ICU-bound assertions. Worth a one-liner standing rule on next instance — pairs with the existing `feedback_local_test_before_push` discipline (which only catches non-ICU regressions).

- **2026-05-07 wave-6 — `437614f` (Agent M) — callsite-sweeps are deterministically scoped by a fixed grep, but the grep itself needs to span ALL render layers, not just code.** Agent M's #286/#330 sweep covered 16 callsites across 11 files: 8 backend (PDF rendering in `routes/billing.js`/`deals_documents.js`/`reports.js`/`cron/reportEngine.js`, AI-prompt strings in `routes/ai.js`/`deal_insights.js`, won-deal activity in `routes/deals.js`) and 8 frontend (CommandPalette, CPQBuilder, Omnibar, AgentReports). The non-obvious one: AI-prompt context strings ALSO drift — when the system prompt for Gemini contains `Won Revenue: $${rev}`, the model sees a literal `$` symbol regardless of tenant currency, biasing its responses for the wellness vertical. **Pattern:** callsite-sweep grep should include AI-prompt builders + email/SMS template renderers + PDF text emitters + UI strings, NOT just user-facing UI. Agent M correctly thought of this; worth codifying. The dispatching-parallel-agent-wave skill could add a "callsite-sweep target list" enumeration so future sweeps don't miss a layer.

- **2026-05-07 wave-7 — `bf7bbe1` (Agent P) — gap-card framing can be wrong about WHERE the test target lives.** Agent P's regression-23 #24 said "extend `backend/test/lib/leadJunkFilter.test.js`". On investigation: `leadJunkFilter.js` gates lead INGESTION, not report VISIBILITY. The bug surface (`#268` — test-skip / test-junk sources polluting attribution + marketing reports) lives at the report-aggregation layer, not the ingestion-filter layer. Agent P's hybrid-A path created a NEW helper `backend/lib/junkSourceFilter.js` (deliberately not extending the existing leadJunkFilter so the two stay semantically distinct), wired into `routes/attribution.js`'s 3 endpoints, with 14 vitest cases. **Pattern:** when a regression-coverage gap card names a specific test file but the bug class doesn't match that file's existing scope, the right move is "create a sibling helper + tests + wire-in at the right layer", NOT "force-fit tests into a file whose helper isn't actually responsible". Agent P explicitly committed both helper + tests + wire-in inside the gap card's commit so the card's "Closes" trailer remained accurate. Worth a one-liner standing rule.

- **2026-05-07 wave-7 — `bfb098d` (Agent O) — explicit "do NOT migrate" listings preserve product-anchored constants.** Agent O's datetime callsite-sweep was scoped to 3 classes; mid-sweep they identified callsites that LOOKED like candidates but were product-anchored. Class (a) wellness `IST_OFFSET_MS` got migrated to `parseDateTimeLocalInTZ` calls but with `Asia/Kolkata` literally pinned as `WELLNESS_TZ` const — clinics are India-only, the daily 07:00 IST orchestrator cron is a product fixture. Several other route handlers (email_scheduling/booking_pages/marketing `scheduledAt`; billing `dueDate`/`paidAt`; estimates `validUntil`) were intentionally NOT migrated because their route validation explicitly requires "must be a valid ISO date" — full-ISO inputs work correctly with native `new Date()`; running them through `parseDateTimeLocalInTZ` would actually be wrong (the helper's job is to disambiguate datetime-local form input, not full-ISO timestamps). **Pattern:** every callsite-sweep should ship a "Intentionally NOT migrated" section in the commit body with reasons. Implicit "we got everything" is wrong; explicit "we got X, intentionally skipped Y for reason Z" is right. Pairs with Agent C's #523 selective-migration learning from wave-1 (logged earlier in this section). Two instances now of "selective scope with documented holdouts" — promotion-eligible.

- **2026-05-07 wave-7 — `bf7bbe1` + `bfb098d` (Agents P + O) — concurrent agents can detect file-collision and gracefully back off.** Agent P's junkSourceFilter wire-in needed to extend into `routes/wellness.js` `computeAttribution()` (the wellness-side equivalent of `routes/attribution.js`). But Agent O was mid-flight on `routes/wellness.js` (datetime sweep). Agent P **detected the in-flight edit, reverted their wellness.js changes, filed a 5-min wire-in as a TODOS user-attention follow-up, and shipped the rest of their work clean**. Agent O finished, released wellness.js. The wire-in was then trivially completed inline (orchestrator side, ~10 LOC) once both agents were done. **Pattern:** in shared-CWD parallel waves, agents that detect a peer mid-edit should NOT block — back off, file a follow-up TODOS row with the specific file/section context, ship the rest. The orchestrator picks up the follow-up after peers release the file. This worked smoothly twice today (Wave 2 Agent D detecting Agent E's revert-and-prove dirty state; Wave 7 Agent P detecting Agent O's mid-flight datetime sweep). Promotion-eligible to dispatching-parallel-agent-wave skill on next instance.

- **2026-05-07 wave-8 — `5ebcbdb` (Agent Q) — gap-card numerical bounds can drift from actual route caps; spec authoring should send BOTH the tighter and looser bound to be robust.** Agent Q's #13 services-api spec hit a gap-card-vs-reality drift: backlog said "price > 1e7" and "duration > 1440 (24h)" but actual route caps in `routes/wellness.js` are tighter (`5_000_000` = ₹50L; `720` = 12h). The spec sends BOTH the just-over-tighter-cap values (5_000_001 / 721) AND the backlog acceptance values (1e8 / 1441), so the rejection contract holds under whichever cap is in effect today + survives a future bump. Documented in the spec header. **This is the third instance of "gap-card claim drifts from actual implementation"** in this session: Wave 4 Agent I (action-verb names: SOFT_DELETE not *_DELETED, INVOICE_UPDATE not UPDATE), Wave 6 Agent N (ICU TZ-token output: 'IST' vs 'GMT+5:30'), Wave 8 Agent Q (numerical bounds). Common thread: gap card is written from the bug report's framing, NOT from grepping the code. **Pattern is now firmly promotion-eligible** to a standing rule: "When implementing a regression-coverage spec from a gap card, treat numerical bounds / action verbs / format tokens / endpoint paths as hypotheses — verify each against the actual code via grep before pinning. The spec should pin against current code reality, with a header comment noting any drift from the gap card's framing."
