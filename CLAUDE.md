# Globussoft Enterprise CRM -- Project Context

## 🗂️ Engineering backlog — read TODOS.md on session start

The persistent backlog of multi-day / architectural work that's been deferred from cron + overnight runs lives in **[TODOS.md](TODOS.md)** at repo root. It's grouped by priority bucket (🟡 ship-this-month, 🔴 bigger investments, 🚫 don't-patch-rethink) plus the architectural cron-skipped GitHub issues, test debt, and a PRD-gap analysis. Each item has the diagnosis, recommended approach, and effort estimate.

**On session start, read TODOS.md before picking up new work** so you don't duplicate something already triaged or skip an item that's already been planned.

### Closed gap-files live under [docs/gaps/archive/](docs/gaps/archive/)

When a gap / backlog / regression-tracking file is **fully closed** (every entry shipped, zero `⬜` / `☐` / `TODO` / `open` markers remaining), it moves under `docs/gaps/archive/` rather than getting deleted — see [docs/gaps/archive/README.md](docs/gaps/archive/README.md) for the convention. Active backlogs (`TODOS.md`, `docs/E2E_GAPS.md`, `docs/regression-coverage-backlog.md`) STAY at their root locations as long as ≥1 item is open. Don't archive a file just because most items are closed — cohesion of the original file beats archive cleanliness.

## Overview

Full-stack enterprise CRM built by Globussoft Technologies. Mirrors top-100 CRM platforms with a glassmorphism UI. **Multi-tenant with vertical configurations** — a single codebase serves generic B2B CRM users AND the wellness vertical (clinics, salons, aesthetics).

- **Repo:** https://github.com/Globussoft-Technologies/globussoft-crm
- **Version:** v3.9.3 — see [CHANGELOG.md](CHANGELOG.md) for the full release history. Per-push gate runs across 6 mandatory deploy gates + a separate PR pre-merge checks workflow (vite build + ESLint). Counts (`e2e/tests/` Playwright, `backend/test/` vitest, `frontend/src/__tests__/` vitest, `.claude/skills/`) are surfaced in [README.md](README.md)'s "At a glance" table so they don't rot here.
- **Branch:** main (single-branch workflow)
- **Deploy:** GitHub Actions auto-deploy on push to main ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) — health-check + rollback to HEAD~1 on fail. Local `ssh_deploy_*.py` scripts are legacy.

## Verticals

Tenant.vertical ∈ `{generic, wellness, travel}` drives:

- **Sidebar layout** — wellness gets a slim clinic-focused nav (~25 items); travel gets a slim travel-agency nav (~15 items, Day 1 scaffolding); generic gets the full 50+ item enterprise sidebar
- **Theme** — wellness uses Dr. Haror's palette (teal `#265855`, blush `#CD9481`, cream bg) via scoped CSS under `[data-vertical="wellness"]`; travel uses placeholder navy `#122647` + warm gold `#C89A4E` on cream pending Yasin's brand handover (Q22)
- **Landing route** — wellness users land on `/wellness`, travel users on `/travel`, generic on `/dashboard`
- **Currency defaults** — tenant.defaultCurrency (INR/USD/EUR/etc.) + locale feed the `formatMoney()` helper everywhere

Adding a new vertical (gym, spa, clinic chain) means: add enum value, add a `render<Vertical>Nav()` function in Sidebar, add a themed CSS file, seed + new pages as needed. No forks. **Travel** is the third vertical (Phase 1 in flight; see [docs/TRAVEL_CRM_PRD.md](docs/TRAVEL_CRM_PRD.md), [docs/TRAVEL_CRM_OPEN_QUESTIONS.md](docs/TRAVEL_CRM_OPEN_QUESTIONS.md), [docs/TRAVEL_CRM_RISKS.md](docs/TRAVEL_CRM_RISKS.md)). It hosts 4 sub-brands (TMC school trips, RFU Umrah, Travel Stall family holidays, Visa Sure) under a single tenant with `subBrandAccess[]` per User (Q25 decision).

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
| Testing | Playwright E2E (e2e/, 234 spec files) + vitest unit tests (98 backend + 76 frontend) — see README "At a glance" for live counts |

## Architecture

### Backend (backend/)

- **server.js** -- Express app, Socket.io, CORS allowlist, rate limiting, global auth guard, Swagger at `/api-docs`, route mounting, cron jobs
- **middleware/auth.js** -- `verifyToken` + `verifyRole` JWT middleware
- **middleware/security.js** -- Helmet, CSRF, cookie-parser security middleware
- **middleware/validateInput.js** -- express-validator input sanitization
- **middleware/fieldFilter.js** -- Field-level permission filtering
- **middleware/sendLimiter.js** -- Email/SMS send rate limiting
- **prisma/schema.prisma** -- MySQL via Prisma ORM (DATABASE_URL env var), 152 models
- **DISABLE_CRONS=1** env switch (v3.2.2) — server.js skips cron init when set; for side-by-side coverage instances
- **Graceful SIGTERM/SIGINT shutdown** (v3.2.2) — required for c8 V8 coverage data to flush before exit
- **prisma/seed.js** -- Seeds all models with demo data
- **utils/deduplication.js** -- Phone normalization + contact/lead deduplication
- All API endpoints prefixed with `/api/`
- Global auth guard protects all routes except /auth/login, /auth/signup, /auth/register, /health, /marketplace-leads/webhook
- Rate limiting: 5000 req/15min general, 1000 req/15min on auth/login

### Cron Engines (backend/cron/) -- 22 engines

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
| SLA Breach | slaBreachEngine.js | Every 5 min, ticket SLA breach detection |
| Lead SLA | leadSlaEngine.js | Every 2 min, lead-response SLA breach detection |
| Low Stock | lowStockEngine.js | Daily 09:00 IST, wellness inventory low-stock alerts |
| Leave Policy | leavePolicyEngine.js | Daily 02:30, leave accrual / policy processing (wellness) |
| Demo Hygiene | demoHygieneEngine.js | Hourly, purges E2E / test-data pollution from the demo box |
| Audit Integrity | auditIntegrityEngine.js | Daily 04:00, audit hash-chain integrity sweep |


### Libraries (backend/lib/) -- 28 modules (key modules below)

- **prisma.js** -- Shared Prisma client instance
- **eventBus.js** -- In-process event bus for decoupled modules
- **notificationService.js** -- Notification creation and delivery
- **webhookDelivery.js** -- Outbound webhook dispatch with retry
- **sentry.js** -- Sentry error tracking initialization
- **leadJunkFilter.js** (v3.1) -- Multi-stage junk-lead classifier: rules + optional Gemini fallback
- **leadAutoRouter.js** (v3.1) -- Keyword → service category → assigned specialist (doctor / professional / telecaller)
- **fieldEncryption.js** (v3.1) -- AES-256-GCM helper for patient PII fields. Opt-in via `WELLNESS_FIELD_KEY` env var

### Services (backend/services/) -- 7 services

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

### Routes (backend/routes/) -- 157 route files

> The grouped list below is a representative map. ~12 newer route files (pos, memberships, attendance, leave, drugs, inventory, service_categories, csv_io, v1_invoices, subscriptions, etc.) landed across v3.4–v3.8 and are not all enumerated here — see `backend/routes/` for the authoritative set.

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

**Travel vertical (Phase 1, in flight):** travel.js + travel_diagnostics.js + travel_itineraries.js + travel_trips.js + travel_trip_billing.js + travel_microsites.js + travel_cost_master.js + travel_pricing.js + travel_suppliers.js + travel_rfu_profiles.js + travel_tmc_catalogue.js (TMC trip catalogue with human-verify gate). Hosts 4 sub-brands under one tenant (TMC school trips / RFU Umrah / Travel Stall family holidays / Visa Sure) per Q25. See [docs/TRAVEL_CRM_PRD.md](docs/TRAVEL_CRM_PRD.md), [docs/TRAVEL_CRM_OPEN_QUESTIONS.md](docs/TRAVEL_CRM_OPEN_QUESTIONS.md), [docs/TRAVEL_CRM_RISKS.md](docs/TRAVEL_CRM_RISKS.md). Shared guards in [backend/middleware/travelGuards.js](backend/middleware/travelGuards.js); pure pricing math in [backend/lib/travelPricing.js](backend/lib/travelPricing.js); diagnostic scoring in [backend/lib/travelDiagnosticScoring.js](backend/lib/travelDiagnosticScoring.js). **TMC sub-brand has a full Diagnostic & Sales-Routing Engine** per [docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md](docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md) (v3.9.3): 12-Q public form (`/p/tmc/readiness`) → deterministic engine ([backend/lib/tmcDiagnosticEngine.js](backend/lib/tmcDiagnosticEngine.js)) + 5-rule lead-quality classifier ([backend/lib/tmcLeadQuality.js](backend/lib/tmcLeadQuality.js)) → LLM Job A readiness narrative + Job B sales brief ([backend/services/tmcDiagnosticPrompts.js](backend/services/tmcDiagnosticPrompts.js)) → 3-layer guardrail ([backend/lib/tmcReportGuard.js](backend/lib/tmcReportGuard.js)) → public report page (`/p/tmc/report/:slug`) + downloadable PDF. Schema: 23 new Prisma models (diagnostic banks + diagnostics, itineraries + items, TmcTrip + 5 children, supplier credentials vault + access log, microsite + OTP, VisaApplication + checklist, RfuLeadProfile, season calendar + markup rules, TmcTripCatalogue, EngineWeights).

**External Partner API (v3.1):** external.js (/api/v1/external/* — health, me, leads, calls, messages, appointments, contacts/lookup, patients/lookup, services, staff, locations)

### Frontend (frontend/src/)

- **App.jsx** -- AuthContext provider, React Router, Suspense + React.lazy() for 124 page components (code-split)
- **utils/api.js** -- `fetchApi` helper with auto Bearer token and 401 redirect

### Frontend Components (frontend/src/components/) -- 16 components (key components below)

CPQBuilder, CommandPalette, DealModal, EmailSignatureEditor, LanguageSwitcher, Layout, NotificationBell, Omnibar, Presence, Sidebar, Softphone

### Frontend Pages (frontend/src/pages/) -- 124 pages

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

### Prisma Models (211 total)

> The enumeration below is the v3.1-era baseline (108 models). ~44 more landed across v3.4–v3.8 — POS (Register, Shift, Sale, PettyCashLedger), Attendance/Leave, Wallet/Cashback/GiftCard/Coupon, Resource/Holiday, inventory (ProductCategory, Vendor, InventoryReceipt, InventoryAdjustment), WhatsAppThread, and more. See [prisma/schema.prisma](backend/prisma/schema.prisma) for the authoritative list.

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
- **Deploy flow (canonical):** GitHub Actions workflow `.github/workflows/deploy.yml` — fires on push to `main` (skipping doc/test/script-only changes via `paths-ignore`) plus manual `workflow_dispatch`. Six mandatory parallel gates → deploy:
  1. **build** — `npm ci` + `prisma generate` + `node --check` parse-check on every backend `.js` + frontend `vite build`
  2. **lint** — ESLint flat config (`backend/eslint.config.js`) + `npm audit` gate via `backend/scripts/check-audit.js` (allowlist at `backend/.audit-allowlist.json`). Project-specific rule blocks bare `req.user.id` (the JWT key is `userId`)
  3. **api_tests** — MySQL 8 container + seed both tenants + boot backend on :5000 + the gated Playwright API specs (the gate spec list lives in `deploy.yml`'s "Run API-only specs" step — see README "At a glance" for current spec/test counts)
  4. **unit_tests** — vitest over the `backend/test/` suite covering `lib/`, `middleware/`, `services/`, `utils/`, `cron/`
  5. **frontend_unit_tests** — vitest + jsdom over the `frontend/src/__tests__/` component suite
  6. **migration_check** — Prisma schema-safety detector (UNIQUE / NOT NULL / column-drop / type-narrow) with commit-message bless markers (`[allow-unique]` etc.)
  Deploy runs only if all six pass. Steps: SSH pull → npm install → prisma generate → pm2 restart → poll `/api/health` (auto-rollback to `HEAD~1` if unhealthy) → vite build → sudo rsync to `/var/www` → chown www-data → smoke check `/` + `/api/health`. Hotfix bypass via `workflow_dispatch.skip_tests=true` (manual UI only — a regular push can never bypass).
- **Release validation:** GitHub Actions workflow `.github/workflows/e2e-full.yml` — runs the full Playwright chromium + auth-tests + api-health suites (UI flows, wellness deep, a11y, integration) against the deployed demo on git tag push (`v*`), GitHub Release publish, or manual trigger. Per-commit pipeline stays fast; the heavy suite is opt-in by tagging a green main commit.
- **Coverage measurement:** GitHub Actions workflow `.github/workflows/coverage.yml` — workflow_dispatch only. Spins an ephemeral backend with c8 instrumentation, runs the 23 gated API specs, reports lines/branches/functions/statements % + top-10 under-covered files. Replaces the old SSH cheat-sheet for the gate-spec methodology. Last measurement (commit `868b227`): 40.52% lines / 73.30% branches / 33.68% functions for routes; 79.01% lines for backend helpers (vitest c8).
- **Secret scanning:** GitHub Actions workflow `.github/workflows/secret-scan.yml` — gitleaks runs on every push + PR (incremental diff, ~10-20s) + scheduled full-history scan Mondays at 06:30 UTC. Allowlist for known intentional demo creds + dev-fallback constants in `.gitleaks.toml` at repo root.
- **Dependency updates:** Dependabot (`.github/dependabot.yml`) opens grouped PRs weekly Mondays 06:00 UTC for npm-backend, npm-frontend, npm-e2e, github-actions. Patch + minor grouped; major individual; security-only ignores cadence.
- **Local deploy scripts (legacy, gitignored, do NOT use):** deploy.py, deploy_backend.py, deploy_frontend.py, setup.sh, ssh_deploy_*.py — kept for emergency-only manual deploys; the GitHub Actions flow above is the only supported path.

### Standing rules for new code (do NOT skip these)

- **New route handler** → add an API spec at `e2e/tests/<route>-api.spec.js`, wire into BOTH `deploy.yml` and `coverage.yml` spec lists. Pattern: clone `e2e/tests/notifications-api.spec.js`. Cover happy path + validation + auth gate at minimum.
- **New `backend/lib/`, `middleware/`, or `services/` module** → add a vitest unit test under `backend/test/<area>/<module>.test.js`. Mock prisma + external SDKs.
- **New body field** → remember the global `stripDangerous` middleware deletes `id`, `createdAt`, `updatedAt`, `tenantId`, `userId` from every request body. Use `targetUserId` (or similar non-stripped name) when targeting a user; use `siteTenantId` / `previewTenantId` when scoping to a body-supplied tenant. **Backed by an ESLint rule** ([backend/eslint.config.js](backend/eslint.config.js) — `no-restricted-syntax` errors on `req.body.{id,userId,tenantId,createdAt,updatedAt}` reads in `routes/**/*.js`). On the rare legitimate workaround (e.g. [routes/quotas.js](backend/routes/quotas.js#L74) reads `req.body.userId` as a defensive fallback to a query-string read), suppress with `// eslint-disable-next-line no-restricted-syntax` directly above the line + a comment explaining why. Issue [#646](https://github.com/Globussoft-Technologies/globussoft-crm/issues/646) is the canonical history — four routes (web_visitors, live_chat, chatbots, telephony) had silent cross-tenant fallbacks BEFORE the ESLint rule existed; the gate-spec [`cross-tenant-stripdangerous-api.spec.js`](e2e/tests/cross-tenant-stripdangerous-api.spec.js) pins the post-fix shape.
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
- **Client-side aggregation over a paginated endpoint is a structural correctness bug** (3 instances confirmed 2026-05-06/07: #567 Dashboard.jsx reducing over `/api/deals?limit=100` missed $5B aggregate; #568 audit-coverage gap-tracking; #572 Deal Insights joining via `/api/deals?limit=100` missed older deals). When you see a frontend `reduce()` / `filter()` over a list endpoint that's bounded by `?limit=N`, the result is structurally wrong — the page's KPIs / aggregates / cross-references reflect only the newest-N window, not the full population. **Two fixes, in order of preference:** (1) use a server-side `/stats` or aggregate endpoint that returns the full-population summary (often already exists — e.g. `/api/deals/stats` did, just needed 5 new fields per Wave-3 Agent F's #567 fix); (2) if no stats endpoint exists, build one rather than client-side-paginating + reducing. The grep audit: `grep -rEn '\\.reduce\\(|\\.filter\\(.*\\.length' frontend/src/pages/ | grep -i "fetch\\|api"` then check each hit for whether the source list came from a `?limit=` paginated endpoint.
- **`isolation: "worktree"` is leaky when the agent needs a running backend or file-grep against frontend source** (2 instances on 2026-05-07: Agent G auth-security regression spec, Agent I audit-coverage spec). Worktree provides isolated source files but the running stack (backend + frontend dev server) typically lives in the main repo with `node_modules` installed. Agents that need to revert-and-prove against a running backend OR run file-grep tests that resolve paths through the running stack will read main repo state, not the worktree. **Workaround:** edit main repo's files for the revert, restore before commit; document the workaround in the commit body. **Or:** dispatch a parallel "boot a backend in the worktree" sub-task before the revert-and-prove agent runs (heavier setup, truly isolated). Both Agent G and Agent I shipped clean using the workaround.
- **Regression-coverage gap cards drift from actual code** (overwhelming pattern — 19 instances confirmed 2026-05-07 across 14 dispatched waves). Action verbs, numerical bounds, error-code identifiers, field names, endpoint shapes, and format tokens all routinely differ from what the gap card claims. Before authoring a regression spec from any gap card, run [.claude/skills/verifying-gap-card-claims/SKILL.md](.claude/skills/verifying-gap-card-claims/SKILL.md) — a fixed grep audit against actual code per claim type. Pin the SPEC to code reality, document drift in the spec header, leave the card alone (the next regression spec author benefits from seeing both). Estimated cost saved per dispatch: ~25-90 min of agent bisect time.
- **Sizing a regression-coverage dispatch: read the route's commit history first** → run [.claude/skills/sizing-regression-coverage-dispatch/SKILL.md](.claude/skills/sizing-regression-coverage-dispatch/SKILL.md). 30-second `git log --oneline -- backend/routes/<file>` probe predicts whether the dispatch stays Path A (pin existing contract — card's effort is accurate) or drifts into Path B (ship missing backend code inline — budget +50-100% on top). 2026-05-07's session split cleanly: ground-up engines (orchestrator v3.1, sequences v3.4.x) shed Path B work entirely; patch-fixed routes accumulate 1-3 inline gaps each. 6 of 8 patch-fixed dispatches today shipped Path B inline (default outcome). Pre-dispatch sizing prevents agents from over-running silently mid-flight.
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
- **RTL: stable mock object references for hooks used in `useCallback` dependencies** → when mocking `useNotify` / `useApi` / any hook whose return value lands in a `useCallback` or `useMemo` dependency array, return ONE stable object reference for the entire test run, NOT `{ error: vi.fn(), info: vi.fn(), ... }` re-created per call. Fresh objects per call cause infinite re-render loops because each render sees a new dependency identity → triggers the callback → setState → re-render → new mock object → repeat. Canonical pattern (2 confirmed instances — Wave 11 Agent B `cfb5789` Approvals.test + Wave 12 `f59e91d` across all 4 pages):
  ```jsx
  const notifyObj = { error: vi.fn(), info: vi.fn(), success: vi.fn(), confirm: vi.fn() };
  vi.mock('../hooks/useNotify', () => ({ useNotify: () => notifyObj }));
  ```
  Symptom of the broken form: test hangs with no output until vitest's per-test timeout (typically 5s) fires; or, on machines with looser timers, eventually OOMs.
- **RTL: prefer `getAllByText` for labels that appear as both filter chrome AND row badges** → when a status / type label appears as a `<option>` in a filter dropdown AND a `<span>` badge in row cells (e.g. `Unpaid` / `Sent` / `Pending`), `getByText` throws on the duplicate; `getAllByText(label).length >= 2` is the contract. Also applies when a chart's recharts `Bar dataKey` matches a KPI tile label (Wave 11 Agent B's Forecasting case). 2 confirmed instances (Wave 11 + Wave 12); promote pattern.
- **Phantom carry-over: every dispatch row gets a 30-second pre-flight verification** (4th instance confirmed 2026-05-10 Wave 8 — promoted from cron-learning to standing rule). Before dispatching ANY agent on a TODOS.md row, PRD Gap doc item, or close-comment "remaining work" line, run a 30-second `gh issue view <N>` + `git log --oneline -- <route>` + grep on the named feature to verify it's not already shipped. Four confirmed instances — 2026-05-07 #534 follow-up phantom (Agent H, 25 min wasted profiling already-fixed endpoints); 2026-05-09 #227 Reports CSV phantom (Agent MM, 25 min); 2026-05-10 regression-23 #24 mis-targeted (Agent P recovered by creating sibling helper); 2026-05-10 Wave 8 phantom (4 agents each given 17 PRD Gap items, ALL already shipped in Wave 11 — Agents A self-exited, B/C/D stopped mid-flight after 3-5 min apiece). The cost compounds with parallel-wave dispatches: a 4-agent wave on phantom scope wastes 4× the time of a single-agent verify. **Apply pattern:** for any "list of N items to close" handoff (TODOS row, PRD doc reconciliation, regression-coverage backlog, gap-card list), the parent runs `verifying-issue-before-pickup` grep on EACH item BEFORE writing agent prompts. Documented in `.claude/skills/verifying-issue-before-pickup/SKILL.md`. Cost: ~30s per item × N items ≪ 25 min per phantom dispatch × N agents.

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

**Thousands of tests run on every push** across the 6 deploy gates (api_tests + unit_tests + frontend_unit_tests) — see README's "At a glance" table for current spec / file counts. Plus the broader UI / wellness / a11y suite on every release tag (e2e-full.yml). Demo-monitor cron polls the deployed box every 30 min; auto-issue on failure (filed against a stable-title issue so re-runs comment instead of spamming).

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

_(Last review 2026-05-07 dispositioned 14 of the day's 23 entries (commit `c3f84e2`): 2 new skills authored (verifying-gap-card-claims, sizing-regression-coverage-dispatch — covers the 12-instance gap-card drift + the Path A/B sizing pattern), 2 skill extensions (executing-cross-route-shape-sweep gained the helper-port + callsite-sweep two-wave + AI-prompt render-layer notes; dispatching-parallel-agent-wave gained the 3 graceful-concurrent-recovery sub-patterns), 4 standing rules (client-side aggregation over paginated endpoint, isolation:"worktree" leakage, gap-card drift link, regression-coverage sizing link). 9 entries below are single-instance observations retained for "third instance triggers promotion" — do NOT re-promote without a third datapoint. Full disposition rationale in [docs/cron-learnings-archive.md](docs/cron-learnings-archive.md). Earlier review 2026-05-06 dispositioned the prior 9 entries (5 to dispatching-parallel-agent-wave, 1 to verifying-issue-before-pickup, 1 to triaging-stuck-deploy-gate, 2 to standing rules).)_

- **2026-05-07 wave-1 — `ba71dc1` — 404 on a route that "looks unmounted" can have TWO simultaneous causes (Nginx + backend handler).** Agent A's investigation of #542 (`/api-docs` returning SPA index.html) found a two-layer root cause: (1) Nginx site config on demo had no `location /api-docs` block, so requests fell through `location /` SPA fallback (same class as the #445 `/p/` fix); AND (2) the backend lacked an explicit `app.get('/api-docs/swagger.json')` handler, so swagger-ui-express's `setup()` catch-all served UI HTML on every sub-path including the JSON endpoint. The backend's `app.use('/api-docs', swaggerUi.serve, ...)` was correctly positioned BEFORE the SPA catch-all already, but on its own it wasn't enough. Pattern: when a route appears 404 (or wrong-content) on demo but works locally, check Nginx config AND backend handler in parallel — not sequentially. The applying-demo-ssh-config skill handles the ops half; the spec-side and backend-handler half is what's not codified yet. Worth a standing-rule one-liner ("infra route fix needs a paired backend route fix more often than you think") if a third instance lands.

- **2026-05-07 wave-2 — `no-commit` (#567 filed instead) — pen-test "non-determinism" framings can mask orthogonal correctness bugs.** Agent D investigated #552/#553/#554 (dashboard "varying KPIs / sometimes-zero / flicker") and confirmed ZERO non-determinism in the current demo (5 consecutive calls byte-identical; 25-call burst all-200, no rate-limit). The cluster's symptoms were a downstream effect of the #529 sidebar dep-cycle storm, fixed in `8bdecbe` — pre-fix, the storm tripped the rate-limiter, the dashboard silently swallowed the resulting errors and rendered all-zeros, and the next successful refresh returned different paginated numbers. **But under that, Agent D found a real correctness bug**: `Dashboard.jsx:14-58` computes Closed Revenue / Expected Revenue / Total Deals client-side by reducing over `/api/deals?limit=100&orderBy=createdAt:desc`. Demo has 5,381 deals with $5B in closed revenue across 375 won deals; the newest-100 window contains 1 won deal, so the dashboard renders "Closed Revenue $0" permanently — consistent now, but consistently wrong. Filed as #567. **Pattern:** when the pen-test's framing (non-determinism / flicker / varying numbers) doesn't reproduce, don't close — investigate what the framing was a *symptom* of. The bug surfaced underneath was bigger than the bug filed. Worth a one-liner standing-rule extension to `verifying-issue-before-pickup`'s pattern catalogue if a third instance lands.

- **2026-05-07 wave-3 — `b232110` (Agent F) — the existing `/api/deals/stats` endpoint already had the right SHAPE for the dashboard; what was missing was 5 specific aggregate FIELDS.** The #567 fix didn't need a new endpoint; it needed `wonCount`, `wonValue`, `lostCount`, `lostValue`, `expectedValue` added to the existing route. Pre-fix, the dashboard ignored `/stats` entirely and reduced over a paginated list — likely because pre-stats-shape predates the multi-aggregate dashboard. **Pattern:** when a frontend uses client-side aggregation over a paginated list, check whether a server-side stats endpoint already exists for that resource — and if it does, the fix is usually adding fields, not adding endpoints. Cheaper than rewriting either side. Worth a one-liner standing rule if a third instance lands.

- **2026-05-07 wave-3 — `no-commit` (Agent H) — close-comment language can introduce phantom carry-over work.** Agent H's #534 follow-up profile against demo found zero endpoints >0.5s — the original fb719e6 fix actually addressed all 4 endpoints the pen-test named, not just 2. The "remaining 2" framing was introduced by the close-comment author (sumitglobussoft), not by fb719e6's commit message. The phantom carry-over then propagated into TODOS.md across THREE separate sections (active backlog row 21, v3.4.15 carry-over row 103, bigger-investments row 152) — Agent H struck all three with rationale links. **Pattern:** when authoring a "fix shipped, X remaining" close-comment, audit whether the fix has a real residual or whether the framing came from the issue body's count and not the actual diff. Phantom carry-over costs >0 — Agent H spent ~25 min profiling something that was already done. Worth a one-liner standing rule if a third instance lands.

- **2026-05-07 wave-6 — `c6d422a` (Agent N follow-up) — vitest TZ-label assertions are NOT portable across Node ICU builds.** Agent N's first push (`663bd7c`) of the datetime regression-23 spec went red on CI's `unit_tests` gate even though it passed locally. Root cause: `date-fns-tz`'s `'zzz'` token renders differently depending on the Node binary's ICU build + tzdata version. Local-dev Node renders IANA short names (`'IST'`, `'EST'`, `'EDT'`); CI's Node renders offset forms (`'GMT+5:30'`, `'GMT-5'`, `'GMT-4'`). Both are correct ISO output — different ICU. Agent N's follow-up commit `c6d422a` made the assertions ICU-agnostic: pin the wall-clock prefix verbatim (deterministic), assert TZ-label presence via flexible regex (accepts both forms), and added a "winter label MUST differ from summer label" test that catches the DST-silently-ignored regression class without binding to label format. **Pattern:** before pinning verbatim TZ-label strings in vitest, run `node -e "console.log(new Intl.DateTimeFormat('en-US', {timeZone: 'Asia/Kolkata', timeZoneName: 'short'}).format(new Date()))"` on the CI runner (e.g. via a one-line workflow_dispatch probe) to confirm what tokens it actually renders. Local-dev output is not authoritative for ICU-bound assertions. Worth a one-liner standing rule on next instance — pairs with the existing `feedback_local_test_before_push` discipline (which only catches non-ICU regressions).

- **2026-05-07 wave-7 — `bf7bbe1` (Agent P) — gap-card framing can be wrong about WHERE the test target lives.** Agent P's regression-23 #24 said "extend `backend/test/lib/leadJunkFilter.test.js`". On investigation: `leadJunkFilter.js` gates lead INGESTION, not report VISIBILITY. The bug surface (`#268` — test-skip / test-junk sources polluting attribution + marketing reports) lives at the report-aggregation layer, not the ingestion-filter layer. Agent P's hybrid-A path created a NEW helper `backend/lib/junkSourceFilter.js` (deliberately not extending the existing leadJunkFilter so the two stay semantically distinct), wired into `routes/attribution.js`'s 3 endpoints, with 14 vitest cases. **Pattern:** when a regression-coverage gap card names a specific test file but the bug class doesn't match that file's existing scope, the right move is "create a sibling helper + tests + wire-in at the right layer", NOT "force-fit tests into a file whose helper isn't actually responsible". Agent P explicitly committed both helper + tests + wire-in inside the gap card's commit so the card's "Closes" trailer remained accurate. Worth a one-liner standing rule.

- **2026-05-07 wave-9 — `b5971a1` (Agent S) — date-boundary tests should use "tomorrow" not "today" to avoid TZ-window flakes.** Agent S's estimates-api spec for the `validUntil >= today` boundary initially used `setHours(0,0,0,0)` against the local timezone, then constructed a date string. Failed mid-flight: when the test runs in the local-vs-UTC midnight overlap window (00:00–05:30 IST is yesterday-UTC), the date string parsed back as "yesterday" relative to the route's UTC interpretation. Rewrote to use a "tomorrow" date instead — unambiguously future in any TZ. **Pattern:** when a test asserts a "must be future" or "must be ≥ today" date validation, use `tomorrow = new Date(Date.now() + 86_400_000)` rather than `today.setHours(0,0,0,0)`. Eliminates the flake class. Pairs with the wave-6 ICU-build cron-learning — both are "the test environment renders dates differently than the author assumed." Worth a one-liner standing rule on next instance ("date-boundary assertions should be unambiguously-future dates, not midnight-of-today").

- **2026-05-07 wave-12 — `b8f6f30` + `00438ef` — MILESTONE: regression-coverage-backlog 100% complete; pattern observations from a full session.** Agent Y closed wellness-clinical extension #10 (162 → 191 tests, +29; 1 backend fix inline — PUT /visits was skipping `ensureVisitDate` range check). Agent Z closed reports-api extension #12 (51 → 72 tests, +21; 100% Path A — zero backend changes needed). Plus the Wave-12 audit confirmed #21 (landing-pages-api) was already shipped via G-1 (`1e5bd3e`) — duplicate gap card. **All 24 regression-coverage-backlog items are now closed in a single session.** Drift count today: **19 instances across 8 waves** (Wave 12 added 7 more — Y: 2 from #114 drugName-only and #194 PUT-only; Z: 5 from `INVERTED_DATE_RANGE` not `INVERTED_RANGE`, year cap `2000..2099` not `1900..9999`, `DATE_OUT_OF_RANGE` code, `?from&to` not `?date=today`, half-open vs closed window semantics). **Cumulative session observations after 12 waves:** (a) gap-card drift is the rule, not the exception — verifying claims via grep before pinning is mandatory; (b) backend-fix-inline ratio is ~50% across the session, with strong inverse correlation to engine maturity (ground-up engines stay Path A, patch-fixed routes accumulate gaps); (c) concurrent agent recovery patterns work — 4 instances confirmed (back-off, stash/pop, file-collision detection); (d) worktree isolation is leaky for revert-and-prove or running-process work; (e) date-boundary tests should use unambiguous-future dates; (f) callsite-sweep grep should span ALL render layers (PDFs/email/SMS/AI-prompts/UI). The auto-loop cron has been a force multiplier this session — none of the 12 waves needed user interruption to pick the next-best thing; the autonomous prioritization between user-attention vs autonomous-fixable vs already-shipped-needs-close-out worked cleanly across 24 issues + 17 backlog items + 6 inline backend fixes + 0 user redirects.

- **2026-05-07 wave-13 — `a2ed361 ... pending` — autonomous queue is now exhausted; the cron has run out of high-value parallel-safe work to dispatch.** After Wave 12's milestone closed all 24 regression-coverage-backlog items, Wave 13 surveyed the remaining queues: docs/E2E_GAPS.md G-1..G-25 (G-21 marked stale as ⬜ in the priority table — actually shipped long ago, 14 component test files in `frontend/src/__tests__/`, 203 tests, `frontend_unit_tests` is a deploy.yml mandatory gate; closed in this commit), TODOS bigger-investments (all shipped this and prior sessions), TODOS user-attention block (6 items — all need user input: #555 tenant-switcher UX, #558 audit-tamper-evidence design, #564 consent surface product call, #565 P&L canonical-figure decision, #534-followup phantom (already closed), validUntil upper-bound design call from Wave 9). **The honest move is to stop dispatching agents and let the cron continue at its idle cadence.** Spinning agents on rabbit-hole work (e.g. micro-extending already-comprehensive specs) violates the cron prompt's "high-value parallel-safe" criterion. The cron-prompt's intended behaviour at queue-exhaustion is: log this state + return to idle until the user redirects. **Recommendation for the next cron review pass:** when this entry is seen, the cron-prompt itself could be enriched with a "queue-exhausted protocol" section that explicitly says "log + idle, do NOT find work to fill time." Pattern is one instance only so far; flag for review.

- **2026-05-09 wave-2 — `97b157f` `9c74d46` `3f0b68c` `e37369a` — `git commit --only <file>` does NOT isolate at the hunk level when siblings have uncommitted hunks in the same file.** Agent LL's finding from Wave 2: `prisma/schema.prisma` was being concurrently edited by 4 agents (II/JJ/KK/LL) all adding their own model blocks. When KK ran `git commit --only schema.prisma`, the entire current file state was committed — silently sweeping up LL's + JJ's + II's mid-flight model additions into KK's commit. Net effect on this wave was *lucky* (the merged file validated cleanly, and the swept-up models matched what the absent agents intended to commit anyway), but the pattern is fragile — one misaligned WIP from an agent that decided to revert later would land broken schema on `main`. Two recovery patterns worked: (a) Agent II used a one-shot Node patch script (`.tmp-apply-schema.js`) that finds insertion points by scoping model brace-depth + applies its addition then immediately commits — so the addition lands atomically; (b) `git apply --cached <patch>` with hunk-filter for the rare case where you need TRUE hunk-level isolation. **Pattern:** when 2+ agents must concurrently append to the same Prisma/JSON/YAML file, use a patcher script (not the Edit tool + git add) so each agent's contribution is atomic. The dispatching-parallel-agent-wave skill should encode this. Worth a skill extension if a third instance lands.

- **2026-05-09 wave-2 — `3f0b68c` (Agent JJ) — `/tmp/` paths fail on Windows git on this development box.** Standing rule template says `git commit --only <files> -F /tmp/agent-XX-msg.txt`. JJ's prompt followed that verbatim and the commit failed because Windows git doesn't treat `/tmp/` as a writable path under PowerShell's environment. JJ's workaround: project-local `.tmp-agent-jj-msg.txt` (added to .gitignore, deleted after commit). **Pattern:** the dispatching-parallel-agent-wave skill's `git commit --only ... -F /tmp/...` template needs an explicit Windows variant: `git commit --only ... -F .tmp-agent-XX-msg.txt`. This is a one-line skill update — not waiting for a third instance because the failure mode is deterministic (every Windows agent will hit it). Promote on next review.

- **2026-05-09 wave-3c — `75d0094` (Agent OO) — vitest test-file headers can lie about what's reachable, costing meaningful coverage left on the table.** OO inherited `backend/test/lib/eventBus.test.js` whose header documented "vi.mock can't intercept the SUT's CJS `require('./prisma')`, so `executeAction` and `emitEvent`'s async tail are unreachable" — and prior authors had marked those code paths as untested per that claim. OO probed by trying the singleton-patch pattern (already in use by `slaBreachEngine.test.js` for the same kind of CJS module) and it worked fine — vitest's `inline: [/backend\/lib\//]` config means the SUT and test share the same `prisma` instance. Net result: eventBus.js coverage jumped 38% → 83% lines (+45pp) just by exercising what was wrongly believed unreachable. **Pattern:** when picking up a test file that has a "this module can't be tested because X" comment, don't trust it — verify with a 5-line probe before scoping the work. The dispatching-parallel-agent-wave skill notes "verify gap card claims" for ROUTE coverage; the same discipline applies to test-file headers about TESTABILITY. Worth a one-liner standing rule on next instance.

- **2026-05-09 wave-3a — `718af41` (Agent MM) — phantom carry-over hits SECOND instance — TODOS row open for 9 days while feature was already shipped.** Wave 3A targeted #227 Reports CSV/PDF export per a TODOS.md row at line 3255. Agent MM ran `verifying-issue-before-pickup` first and found the feature shipped 2026-04-30 in `ed23f5d` — 8 endpoints, 36 tests, frontend Export buttons, `verifyWellnessRole` gates. GH issue #227 closed same day. The TODOS row was never struck. Agent MM shipped a 1-line docs correction at `718af41` and reported "verifying-issue-before-pickup should run as 30-second pre-check on every dispatched ticket." This is the **second instance** of the phantom-carry-over pattern — first was 2026-05-07 wave-3 (#534 follow-up phantom). The first instance was logged as "worth a one-liner standing rule on third instance"; this is now two. **Recommendation:** promote to a standing-rule one-liner ahead of the third datapoint, since each instance costs ~30 min of agent dispatch time on already-shipped work. Pattern: every TODOS.md row gets a 30-second `gh issue view <N>` + commit-grep verification before dispatch, full stop. Promote on next review.

- **2026-05-09 wave-3d — `3380d71` (Agent PP) — failure-count metrics in TODOS get carried verbatim across waves without verification, and can be wrong from inception.** Agent PP audited the "41 pre-existing e2e failures" carry-over from 2026-04-26 (TODOS.md:3267, repeated in CHANGELOG.md:1407). Reality on the most recent e2e-full run (`25526512408` against demo, 2026-05-07 22:54Z): **9 unique failing tests, of which 7 were already absorbed by Wave 10 commit `0ad13a8` 2026-05-08, 1 already-shipped scrub coverage, and 1 substantive open item (gdpr.spec.js:85 timing flake).** Agent PP's findings: (a) the "41" was wrong from inception — the 9 cited spec files have only 48 `test()` declarations total, so 41 failing would mean ~85% red and CI would have been hard-blocked, contradicting the "93% pass rate" the same TODOS row claimed; likely conflated retries × 3 or counted other specs; (b) Wave 10 absorbed 7 of the 9 during a parallel investigation but didn't link back to the TODOS row, so the next session-pickup author saw "41 failures" and dispatched on stale state. **Pattern:** every failure-count claim in TODOS.md needs an inline `gh run id` citation OR `e2e/tests/<spec>.spec.js:<line>` reference that the next reader can verify in 30 seconds. Numbers without provenance rot fast. Worth a one-liner standing rule: "every regression-count claim cites either a workflow-run id or specific test:line refs."

- **2026-05-13 evening — v3.7.8 → v3.7.10 e2e-full arc — spec rot from intentional backend hardening is now the DOMINANT e2e-full failure mode**, not state races. v3.7.8 e2e-full had 9 hard failures; root-cause categorization showed **5 of 9 were spec-rot from PRIOR shipped commits** that added validators / hardened shapes / refactored credentials / added SSRF guards — and the cross-cutting bare specs (`wellness-sms`, `eventbus-emit`, `channels-credentials`, `notifications-api`) were never updated alongside. Examples: PR #710 reshaped `NotificationPreference.channels` from booleans to `{enabled}` objects but `notifications-api.spec.js:520` still asserted `body.channels.db === true`; PR #713 added SSRF defense but `eventbus-emit.spec.js:322` was still passing `http://127.0.0.1:1/`; `routes/sms.js:481` added msg91 6-char `senderId` validator but `channels-credentials-api.spec.js:237` was still sending 20-char `RUN_TAG-newSender`; `credentialMasking.js` reshaped `apiKey` to `{configured, last4}` but `wellness-sms.spec.js:35` was still doing `apiKey.toMatch()`. The cross-cutting-shape-change skill caught some but not all — it's heuristic, not exhaustive. **Pattern:** for any backend hardening that changes a public response shape OR adds an input validator, grep `e2e/tests/` for the field name AND the endpoint path AND update every spec that touches it, not just the route's primary `*-api.spec.js`. Would have prevented all 5 spec-rot failures this wave. Worth promoting from heuristic to mandatory step in the cross-cutting audit skill.

- **2026-05-13 evening — `fdc9075` — `test.describe.configure({ mode: 'serial', timeout: 120_000 })` is the right primitive for "tests that beat themselves up on a shared backend resource under concurrent-shard load."** v3.7.9 e2e-full had 2 hard failures in the audit-api `/verify hash-chain` describe — both 60s timeouts triggered by `apiRequestContext.post: Request context disposed` during `POST /api/contacts` seed calls. Demo backend was saturated by the other 3 shards' concurrent activity → seed POSTs took 10-30s each → playwright's 60s test timeout fired. Fix was the describe-level `mode: 'serial'` (forces tests in that describe to run sequentially within their shard — doesn't affect other describes / other shards) plus a 120s timeout headroom. Single-commit, single-file fix dropped hard failures from 2 to 1 (v3.7.9 → v3.7.10). **Pattern:** for any spec describe block where tests SHARE a backend resource (audit chain, sequential ID generators, single-row state, the same tenant's same entity), default to `mode: 'serial'` at the describe level. Trade a few seconds of test wall-clock for ~2× stability under shard load. Useful across audit-api, anything touching `/api/audit/backfill`, the hash-chain verifier, sequential-numbering routes, and ledger-style state machines. Worth a one-liner standing rule on next instance.

- **2026-05-13 evening — `25828398754` (audit-api:533) — demo-state convergence helpers need to ACT every iteration, not just observe.** v3.7.10's 1 remaining hard failure was `audit-api.spec.js:533 (a fresh seed extends the chain by ≥1)`. Demo returned `integrityVerified: false, unhashedRows: 6, brokenAt: 154516, reason: null hash — row was never chained (run backfill)`. The chain was structurally healthy — but 6 rows were "in flight" from background-cron `writeAudit` (orchestrator/workflow/sentiment/scheduled-email/sequences) writing FASTER than the test's single backfill could process them. The existing `verifyEventually()` helper polled `/verify` 6×700ms but **only fired backfill once on initial null-hash observation** — under sustained write pressure, new unhashed rows appeared faster than the static poll could catch up. **Pattern:** convergence helpers like `verifyEventually` must re-fire the convergence-action (backfill / refresh / reconcile) on EVERY iteration where the convergence condition isn't met, not just on the first false reading. The general rule: under a demo with continuous background-cron writes, polling-without-acting loses; polling-and-re-acting wins. Worth a one-liner standing rule on next instance.

- **2026-05-22 ~05:00 UTC — no-commit — Travel PRD-drive autonomous loop: queue exhausted post-refresh; recommend user CronDelete.** Final autonomous-doable pick shipped this tick (`621aab7` subBrandConfigJson consumer wiring + 7 cron + 3 endpoint integrations + 26 vitest cases). Per re-audit `e8cc0ac` §10 verbatim: "Round after that: verify pick #1 shipped via grep... If shipped → CronDelete the autonomous loop." Verified shipped. **Queue state:** §4 PRD-requirement layer is 74/78 SHIPPED (~95%) with the residual 4 PARTIAL stuck on creds; §7 page-row + Phase 1.5 layer is empty; remaining work is all cred-blocked (Q9 / Q3 / Q11 / Q19 / Q8 / Q1 / Q22), product-call (Q2 / Q13 / Q16), big-scope (Chrome plugin / airline automation / Phase 3 Visa Sure), or low-value admin-completeness (intentionally NOT promoted per §10's anti-busywork guidance). **Strict Step-5 condition (zero GAP-AUTONOMOUS AND zero GAP-STUB-ABLE) not literally met** — GAP-STUB-ABLE stays at 5, but those are cred-blocked items whose stubs are already in place (10 swap points inventoried); re-stubbing would be churn. Followed audit's spirit not prompt's strict letter. **Recommend user run CronDelete on the PRD-drive cron.** Re-evaluation triggers: cred Q-marker resolution (Q9 unlocks 7 WA crons + 3 endpoints to swap stub→real call), user redirect, or Phase 3 Visa Sure commit landing. **Session run history:** ~9 ticks; ~10 feature commits shipped (LeadDetail, ItineraryDetail, ReligiousPackets, LlmSpend, formVsCallJson persist, rooming XLSX, subBrandConfig wiring, etc.); SHIPPED count climbed 70 → 78 (~91% → ~100% of original denominator); 1 phantom-carry-over caught (DuplicateContactModal `b18c5c4` mis-listed as gap by re-audit `b81f2cb`); 2 re-audit refreshes performed.

- **2026-05-23 ~05:55 UTC — `d0a4e36` → recovered `afdc61b` + `5d9a95e` — `git commit -F <file>` (without `--only`) commits everything STAGED in the index, NOT just newly-added files.** QA-cluster cron `00d468d5` tick #2 — 3 parallel agents on disjoint files (#894 Invoices.jsx, #895 Payments.jsx, #863+#864 travel.css). Dark-mode agent's `git stash pop` brought sibling Payments-agent's WIP back into their working tree (because the sibling had run `git add` before the dark-mode agent's stash captured state); dark-mode agent then `git add travel.css` + `git commit -F msg.txt` swept up the Payments staged files into commit `d0a4e36` along with the intended CSS. Recovered via soft-reset + unstage + recommit `afdc61b` (force-push); Payments agent then recommitted standalone as `5d9a95e`. **THIRD instance** of this hazard (prior: 2026-05-09 Wave 2 `prisma/schema.prisma` concurrent edits; 2026-05-09 Wave 2 `/tmp/` Windows path failure). **Promoting to a standing rule:** all parallel-agent dispatches MUST use `git commit --only <files>` (explicit path arg overrides the index) instead of `git commit` after `git add`. The `--only` flag scopes the commit to the listed paths regardless of what else is staged in the index — exactly the isolation parallel agents need. The `dispatching-parallel-agent-wave` skill already documents this template; promoting it from "recommended" to "hard requirement" because we now have 3 confirmed recovery cycles costing ~10-15 min each. Future cron prompts should explicitly include `git commit --only <files>` (not bare `git commit`) in the agent's commit-step template.

- **2026-05-23 ~17:00 UTC — `62a4e5a` (initial) → `86a01fa` (full fix) — e2e test helpers allocating shared-DB resources need per-WORKER uniqueness, not just per-call.** Overnight-cron arc spanning ticks #63 → #72 had 2 deploy gate reds (commits `6b4ef38` + `962d82a`) both caused by `nextVisitDate()` in `e2e/tests/wellness-clinical-api.spec.js` colliding on the `(doctorId, UTC-hour)` booking-gate guard. Iterations: v1 was `Math.random()*720h` (birthday-paradox collisions with 100+ tests on the same drHarsh doctor); v2 (tick #64 `62a4e5a`) was a process-monotonic counter that fixed within-process collisions but every Playwright WORKER starts with `_visitDateOffset=0` so 4 workers all created visit-1 at hourOffset=720h → second-onwards POSTs returned 409 DOCTOR_DOUBLE_BOOKED; v3 (tick #72 `86a01fa`) PID-buckets the hour offset (`process.pid % 40 * 200 + counter % 200` = 8000 unique (worker, hour) combos within the [now+720h, now+8720h] window). **Pattern:** any e2e helper allocating a SHARED-DB resource (visit slot, sequence number, unique-name row, IDOR-target ID) needs a worker-discriminator built in — `process.pid` modulo K, `test.info().workerIndex`, or an env var. Pure process-monotonic looks correct in single-worker dev runs but cascade-fails the moment Playwright spawns >1 worker against a shared backend. SECOND instance of this multi-version triage class in this session (first was tick #64's random→monotonic; this was monotonic→pid-bucketed). Worth promoting to a one-liner standing rule on next instance — "e2e shared-DB helpers must include a per-worker discriminator (process.pid, workerIndex, or env)."

- **2026-05-23 ~21:00 UTC — no-commit — 81-tick overnight cron arc exhausted; Step 4 trigger fired (3 consecutive 0-commit ticks #79 + #80 + #81).** Continuous cron arc from tick #16 (resumed from compacted prior session) through tick #81. Session deliverables: 154 commits / 44 GH closures / 2 follow-up issues filed (#932 + #933) / 1 cron-learning entry (entry above) / tri-doc tracker coverage of every remaining blocker — DECISIONS_TRACKER.md (192 design decisions across 33 PRDs, refreshed tick #65) + CREDS_TRACKER.md (47 credential/asset chases across 6 categories, authored tick #74) + MANUAL_CODING_BACKLOG.md cluster→PRD cross-refs (13 wired tick #77). Multi-slice CSV gap (#816) drained 4/5 across ticks #69-#73 — Products residual split to #933. 6 phantom-shipped audits (~3 agent-hours saved). 2 deploy gate triages cleanly absorbed (`62a4e5a` tick #64 + `86a01fa` tick #72 — both `nextVisitDate()` iterations per the entry above). **Termination signal:** Step 4 phase-transition threshold crossed at tick #75 (open issues 50 → 49) + cron-prompt's "Be efficient with agent budget" + the 3-consecutive-0-commit-ticks rule fired this tick. Remaining 49 issues fall in 4 buckets, none lean-tick-shape: 9 architectural Travel-Security/Gap (PRD-covered multi-day waves), 8 cred-blocked (CREDS_TRACKER tracks), 10 new-page/module (half-day-to-multi-day), 22 misc multi-day. **Recommend user CronDelete + redirect to:** (a) directed product-call session against DECISIONS_TRACKER + CREDS_TRACKER, (b) focused implementation wave on a specific architectural item (PRD-covered), or (c) cred-drop cycle (Q22 Yasin brand pack unblocks 4 PRDs simultaneously per CREDS_TRACKER tick #74 finding).

- **2026-05-24 ~11:30 UTC — tick #106→#140 autonomous test-coverage drain arc — GENUINELY EXHAUSTED across every layer.** 34 consecutive ticks shipping 2 commits each (68+ test files + a handful of triage fixes + one cron-learning entry). Final inventory audit confirms: every `frontend/src/pages/**` file has a sibling test, every `frontend/src/utils/*.{js,jsx}` has a sibling test, every `backend/lib/*.js` has a sibling test, every `backend/services/*.js` has a sibling test, every `backend/middleware/*.js` has a sibling test, every `backend/cron/*.js` has a sibling test, every `frontend/src/components/*.jsx` has coverage via `ui-primitives.test.jsx` or `CapBanners.test.jsx`. Cap-consumer + travel-vertical + wellness-vertical + visa-Phase-3 page-level test classes ALL fully drained. **6 phantom-carry-overs caught + recovered** during the arc (tick #118 `LeadDetail`, plus 5 prior session instances). **3 deploy-infra 504s + 2 CI-only race flakes** triaged cleanly (tick #108 Patients + tick #126 Calendar findByText fixes; transient deploy 504s on `23c9656`/`0a94c42d`/`4fb87b9d`/`28f10c6c` were infra not code). **Net delta**: −259 LOC from CapBanners rule-of-3 retrofit + ~200+ vitest cases added. **NEXT-SESSION TRIGGER**: when the autonomous-overnight-cron fires and the "Step 4 stop conditions" all read complete (PRD-writer exhausted, GitHub open-issue count below 50, 22/22 cron engines covered, every layer audited shows zero untested files), the correct response is "log + idle, do NOT find work to fill time" per the 2026-05-07 wave-13 exhaustion entry. **DO NOT** revive the test-coverage drain stream; if user re-fires, surface explicit "queue exhausted — recommend CronDelete + redirect to (a) directed product-call session against DECISIONS_TRACKER, (b) focused architectural wave on a multi-day PRD-covered item, or (c) cred-drop cycle (Q22 Yasin brand pack unblocks 4 PRDs simultaneously)."

- **2026-05-24 ~06:00 UTC — tick #118 Agent A — 6th phantom-carry-over instance: dispatcher-side test-file existence check absent.** Dispatched Agent A to author `TravelLeadDetail.test.jsx`, premising "currently has zero frontend test coverage." Agent A ran verifying-issue-before-pickup, found existing `frontend/src/__tests__/LeadDetail.test.jsx` (commit `a84289e`) with 6 cases covering the same SUT contracts; self-exited cleanly. **6th instance in this session arc** (prior 5 documented). Pattern persists: the dispatcher's prompt-premise verification gap recurs every 2-4 ticks under the test-coverage drain pattern. Tick #119 dispatcher-side fix: run `ls frontend/src/__tests__/ | sort` as a pre-flight grep BEFORE writing test-coverage prompts; cross-reference every candidate page against the existing test inventory; only dispatch where genuinely uncovered. Result: tick #119 picks (CostMaster + DiagnosticBuilder) verified-untested before dispatch — both shipped cleanly with no phantom returns. **The dispatcher-side fix is the actual standing-rule promotion needed**, not just "agent self-exits cleanly." The 2026-05-24 ~03:00 UTC entry below documented this gap for `git checkout HEAD --` premises specifically — now confirmed it generalises to ALL test-coverage prompts. Worth promoting to a standing rule: "test-coverage drain prompts run `ls __tests__/` first to enumerate existing coverage; only candidates absent from that list get dispatched." Cost saved per future correctly-pre-flighted tick: 30-180s of agent-budget per avoided phantom.

- **2026-05-24 ~03:00 UTC — tick #106 init — `git checkout HEAD -- <file>` restores HEAD's clean content; conflict-marker artifact in the working tree does NOT imply the file was deleted from HEAD.** Tick #106 init found `backend/test/cron/visaRiskFlagEngine.test.js` with literal `<<<<<<< Updated upstream ... >>>>>>> Stashed changes` markers in the working tree (leftover from a prior tick's incomplete stash-pop). I ran `git checkout HEAD -- <file>` to clean it, then dispatched Agent C with a prompt premise that "the file was lost during conflict cleanup." **Wrong premise.** `git checkout HEAD -- <file>` REPLACES the working-tree version with HEAD's clean version (not "discards the file") — so the file was never lost; it was just temporarily ugly in the working tree. Agent C correctly ran `verifying-issue-before-pickup` first (per the standing rule from 2026-05-10 promotion), confirmed the file present at 733 lines / 34 tests, returned phantom-carry-over. **No-commit return saved ~30 min of fabricated-churn agent budget.** Pattern: when reasoning about "did this destructive-looking operation lose data?" — `git checkout HEAD -- <file>` is data-restoring (HEAD content wins over working tree), NOT data-destroying. Only `git rm` / `git checkout <other-branch> -- <file>` / `git reset --hard` are data-destroying for files. The init-time check should have been `git show HEAD:<file> | wc -l` BEFORE writing the agent prompt premise. **5th instance of phantom-carry-over** (prior 4: 2026-05-07 wave-3 #534, 2026-05-09 wave-3a #227, 2026-05-10 Wave 8 PRD Gap, 2026-05-22 `b18c5c4` re-audit). The verifying-issue-before-pickup standing rule fired correctly inside Agent C; the gap is that the DISPATCHER (me) didn't run the same check on my own init premise. Worth a one-liner extension to the standing rule: "the dispatcher runs verifying-issue-before-pickup on every prompt-premise too, not just the agent."

- **2026-05-24 ~01:43 UTC — `safeEmitEvent` (tick #47, `eventBus.js`) → `adsGptClient` (tick #96, `9f35040`) → `ratehawkClient` (tick #97, `2852b82`) → `callifiedClient` (tick #98, `9ec52df`) — CJS self-mocking seam: inter-function calls within a CJS module MUST go through `module.exports.fn(...)` not the local closure binding, or `vi.spyOn(client, 'fn')` cannot intercept them.** Rule-of-3 trigger fired this session — 4 confirmed instances. Pattern: when module M exports both `f` and `g`, and `f` internally calls `g`, the test `vi.spyOn(M, 'g').mockResolvedValue(...)` does NOT intercept M's internal call because the local-binding closure references the original function directly, not the `module.exports.g` indirection. Fix: rewrite the call site in M as `module.exports.g(...)` so the spy on the exports surface catches it. The 3 service clients (adsGpt / ratehawk / callified) all wrote `module.exports.computeMonthlySpendCents(tenantId)` inside `checkBudgetCap` for exactly this reason; callifiedClient took it further with 4 inter-function calls all using module.exports indirection (`initiateCall` → `module.exports.{isEnabledForTenant, checkBudgetCap, resolveSubBrandPersona}`, plus `checkBudgetCap` → `module.exports.computeMonthlySpendCents`). **Promotion candidate:** encode into the `writing-vitest-unit-test` skill OR add a new "CJS self-mocking seam" subsection in `.claude/skills/dispatching-parallel-agent-wave/SKILL.md` (since most new vitest agents will hit this pattern when they add pre-call gates on a CJS module that ships testable side-effects). Cost saved per future agent that doesn't have to rediscover this: ~10-15 min of test-failure → spy-not-firing → why-not investigation.
