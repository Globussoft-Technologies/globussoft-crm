# Globussoft Enterprise CRM

> A full-stack enterprise CRM built by Globussoft Technologies. **102 API routes, 110 data models, 90+ UI pages, 17 automation engines** (now incl. demoHygieneEngine). Multi-tenant with vertical configurations (generic / **wellness**). Tenant-driven currency + locale. External partner API for sister products (Callified.ai, AdsGPT). Embeddable lead-capture widget. AI orchestration engine. **GitHub Actions CI/CD** with **6 mandatory deploy gates** (build / lint / api_tests / unit_tests / frontend_unit_tests / migration_check) + dedicated **PR pre-merge checks workflow** (vite build + ESLint on every PR) + commit-message blessings (`[allow-unique]` etc.) for legitimate-but-flagged schema changes + auto-rollback on health-check fail + 30-min demo health-monitor cron. **Mobile-responsive** sidebar drawer + 6 demo-path pages. **~3,791 tests on every push** (~2,560 Playwright + 1,196 backend vitest + 35 frontend vitest); release-validation full chromium suite on every tag. **10 reusable Claude Skills** + **live agent-activity widget** at /developer for parallel-wave visibility. `docs/gaps/archive/` convention for fully-closed gap-files. **Email delivery via SendGrid (live on demo); CAPTCHA via Cloudflare Turnstile. Canonical `{error, code}` envelope on every JSON failure. Two-tier `/api/health` shape (auth-gated full body).**

**Live:** [crm.globusdemos.com](https://crm.globusdemos.com) | **Version:** v3.4.14
**Wellness vertical docs:** [docs/wellness-client/](docs/wellness-client/) | **Partner API docs:** [EXTERNAL_API.md](docs/wellness-client/EXTERNAL_API.md) | **Embed widget docs:** [EMBED_WIDGET.md](docs/wellness-client/EMBED_WIDGET.md) | **API namespacing rules:** [API_NAMESPACING.md](docs/API_NAMESPACING.md) | **Cross-project monitor patterns:** [DEMO_MONITOR_PATTERN.md](docs/DEMO_MONITOR_PATTERN.md) + [LIVE_MONITOR_PATTERN.md](docs/LIVE_MONITOR_PATTERN.md)
**Engineering backlog:** [TODOS.md](TODOS.md) — read this before picking up new work. **QA prompts:** [QA_README.md](docs/QA_README.md) (wellness + generic split).

## Release notes & current work

- **What's changed across releases** → [CHANGELOG.md](CHANGELOG.md) is the canonical version history.
- **What's currently in flight / queued** → [TODOS.md](TODOS.md) is the engineering backlog.

This README documents the product as it stands today. It does not narrate per-version arcs — those live in CHANGELOG.md.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite, React Router v7, React.lazy() code splitting, Lucide Icons, Recharts, ReactFlow, React Grid Layout, Socket.io-client |
| Backend | Node.js, Express.js, Prisma ORM, MySQL, Socket.io, node-cron, PDFKit, pdf-lib, express-rate-limit, express-validator, Swagger UI |
| AI | Google Gemini 2.5 (@google/generative-ai), sentiment analysis, deal insights, lead scoring, voice transcription, data enrichment |
| Auth | JWT (bcryptjs), RBAC (ADMIN / MANAGER / USER), 2FA (speakeasy), SSO, SCIM |
| Security | Helmet, CSRF (csurf), sanitize-html, field-level permissions, GDPR consent tracking, rate limiting, **Cloudflare Turnstile CAPTCHA on landing-page forms** |
| Payments | Stripe, Razorpay |
| Communications | **SendGrid (transactional email — live on demo)**, Twilio (SMS/Voice), Fast2SMS / MSG91 (Indian SMS providers — DLT-aware), WhatsApp Cloud API, Web Push (VAPID), IMAP inbound email |
| Production | PM2, Nginx reverse proxy, Certbot SSL, Sentry error tracking |
| Testing | Playwright E2E (~199 spec files; ~79 in the per-push gate, the rest in `e2e-full.yml` release-validation), vitest (42 backend + 6 frontend unit-test files) |
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

**Always-visible integration status chip row** above the leads table — each provider shows configured / active state, last-sync timestamp, 30-day lead count, and a per-provider Sync-now button. **3-state empty UX** distinguishes "no integrations configured" / "configured but stale (no sync >24h)" / "all quiet (recent sync, no leads in window)". Backed by `GET /api/integrations/marketplace/status` (non-admin readable).

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
- **Inbox** -- Omnichannel communications hub (Email, Calls, SMS, WhatsApp). Single unified row-detail modal handles all 4 channels.
- **Email** -- Email compose + management via **SendGrid** (live on demo). Multi-recipient send via comma-separated `to:` returns an additive `{totalSent, totalFailed, results, failures}` envelope (back-compat single-recipient `email`/`messageId` fields preserved).
- **Email Inbound** -- IMAP-based inbound email processing
- **Email Threading** -- Conversation threading for email chains
- **Email Scheduling** -- Scheduled email send with cron engine
- **SMS** -- SMS messaging via Fast2SMS / MSG91 / Twilio with DLT compliance. **Bulk send via `POST /api/sms/send-bulk`** returns `{totalSent, totalFailed, results, failures}` envelope; pre-flight phone validation surfaces invalid recipients before any provider call.
- **WhatsApp** -- WhatsApp Cloud API with template approval workflow. Canonical send shape `{to, templateName, parameters}` per Meta Cloud spec; session-text fallback for messages within 24h re-engagement window.
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

## Automation Engines (16 Cron Jobs)

| Engine | Schedule | Purpose |
|--------|----------|---------|
| leadScoringEngine | Every 10 min | AI-powered lead score recalculation (per-tenant iteration; recompute window via `Contact.aiScoreLastComputedAt`) |
| sequenceEngine | Every 5 min | Drip sequence step execution |
| marketplaceEngine | Every 5 min | IndiaMART/JustDial/TradeIndia lead sync |
| workflowEngine | Event-driven | Automation rule evaluation via eventBus |
| campaignEngine | Every 1 min | Marketing campaign dispatch (DB-persisted schedules) |
| reportEngine | Scheduled | Auto email report generation and delivery |
| recurringInvoiceEngine | Daily | Recurring invoice generation (excludes `VOID` and `VOIDED`) |
| forecastSnapshotEngine | Weekly | Revenue forecast snapshot capture |
| dealInsightsEngine | Every 6 hr | AI deal insight generation |
| sentimentEngine | Every 15 min | Customer sentiment analysis |
| scheduledEmailEngine | Every 1 min | Scheduled email dispatch via SendGrid |
| retentionEngine | Daily 03:00 | GDPR data retention enforcement (writes AuditLog on every run, including no-op) |
| backupEngine | Daily 02:00 | Automated mysqldump backup |
| **orchestratorEngine** | Daily 07:00 IST | **Wellness AI orchestration — generates Owner Dashboard recommendation cards** |
| **appointmentRemindersEngine** | Every 15 min | **Queue SMS reminders 24h + 1h before each booked visit (wellness)** |
| **wellnessOpsEngine** | Hourly | **NPS survey 72h post-visit + 90-day junk-lead retention purge (wellness)** |

Each engine has an admin-gated manual trigger at `POST /api/<area>/run` (forecasting, billing/recurring, email/scheduled, gdpr/retention) for deterministic testing + ops. The `DISABLE_CRONS=1` env switch skips cron init at boot — used by side-by-side coverage instances.

## Security Features

- **Authentication** -- JWT with bcryptjs password hashing; in-memory + sessionStorage token (migrated off `localStorage` per #343 hardening)
- **2FA** -- TOTP-based two-factor authentication (speakeasy)
- **SSO** -- SAML/OAuth single sign-on
- **RBAC** -- Role-based access control (Admin / Manager / User) + field-level permissions middleware (`fieldFilter` wired into 6 sensitive handlers)
- **CSRF Protection** -- csurf middleware
- **Security Headers** -- Helmet (HSTS 1y, X-Frame SAMEORIGIN, Referrer-Policy strict-origin-when-cross-origin, X-Content-Type-Options nosniff, COOP same-origin, CORP cross-origin)
- **Input Sanitization** -- `sanitize-html` + express-validator; canonical `backend/lib/sanitizeJson.js` helper for JSON-string columns (covers 5 routes: sequences, lead_routing, ab_tests, marketing, report_schedules)
- **Cross-tenant scoping** -- every route filters on `req.user.tenantId`; `tenant-isolation-api.spec.js` pins 29 resources / 93 cross-tenant assertions
- **Rate Limiting** -- express-rate-limit (5000 req/15min general, 1000 req/15min on auth, OTP 3/10min/phone + 10/10min/IP)
- **CAPTCHA** -- Cloudflare Turnstile on landing-page forms; per-form opt-in via `props.enableCaptcha: true`
- **GDPR / DPDP Compliance** -- Consent records, `/export/me` (DSAR self-export), `/export/contact/:id` (admin), retention policies + audit log
- **Patient self-DSAR** -- `POST /api/wellness/portal/export` (wellness vertical) — patient-token-authenticated walk of `Patient → Visit / Prescription / ConsentForm / TreatmentPlan / LoyaltyTransaction / Referral`
- **SCIM Provisioning** -- Automated user lifecycle management
- **Audit Logging** -- Full entity/action audit trail; `writeAudit()` covers PHI reads (visits, prescriptions, consents, treatment plans, photos, inventory) for staff, NOT patient self-reads
- **Output filtering** -- Global `scrubResponse` middleware strips `portalPasswordHash` / `passwordHash` / `isAdmin` from every `res.json` payload, including nested `include: { contact: true }` shapes
- **Secret scanning** -- gitleaks on every push (incremental ~10-20s) + scheduled full-history scan Mondays
- **`npm audit` gate** -- fails CI on new high/critical CVEs; allowlist with `sunsetBy` dates

## E2E Testing

**~3,784 tests on every push** across 6 mandatory deploy gates; ~199 spec files in `e2e/tests/` total. The per-push gate runs ~79 Playwright API specs (~2,560 tests) against a CI-local MySQL stack. The full `e2e-full.yml` chromium suite runs sharded 4-way against the live demo on every `git tag` push (release validation).

**Per-push gate composition:**
- `api_tests` — ~79 Playwright API specs against CI-local MySQL (~2,560 tests, ~10 min)
- `unit_tests` — 42 backend vitest files (~1,189 tests covering `lib/` + `middleware/` + `services/` + `utils/` + `cron/`)
- `frontend_unit_tests` — 6 frontend vitest files (~35 tests on critical components)
- `build` — vite build + `node --check` parse-check on every backend `.js`
- `lint` — ESLint flat config + `npm audit` allowlist gate
- `migration_check` — Prisma schema-safety detector with commit-message bless markers (`[allow-unique]`, `[allow-drop]`, `[allow-not-null]`, `[allow-narrow]`)

**Release validation (`e2e-full.yml` on tag push):** full chromium project + auth-tests + api-health, sharded 4-way against `https://crm.globusdemos.com`, with `scrub-demo` post-test cleanup + merged HTML report. Typical runtime ~15-20 min.

**PR pre-merge checks (`pr-checks.yml` on every PR):** vite build + ESLint. Catches the PR #453-class regressions (conflict markers, JSX errors, `req.user.id` anti-pattern) BEFORE merge to main rather than after — the per-push gate caught those for the first 6 months but only after the bad commit was already on main.

**Highlight specs:**
- `tests/ship-readiness.spec.js` — auth, 50 API endpoints, security (CORS, tenantId injection), public endpoints
- `tests/wellness.spec.js` — tenant + currency segregation, dashboard data, patient/visit/Rx/consent create flow, recommendations approval, full external API flow, reports, junk filter, auto-router, public booking, orchestrator manual run
- `tests/tenant-isolation-api.spec.js` — 29 resources / 93 cross-tenant assertions (every multi-tenant Prisma model)
- `tests/migration-safety.spec.js` — 4 schema-class detectors (UNIQUE addition, NOT NULL addition, column drop, type narrowing)

```bash
# Per-push gate locally (mirrors deploy.yml exactly):
.\scripts\test-local.ps1 -Local              # Windows
./scripts/test-local.sh --local              # macOS / Linux / git-bash

# Or just one suite against demo:
cd e2e && BASE_URL=https://crm.globusdemos.com npx playwright test --project=chromium
```

## Deployment

- **Domain:** [crm.globusdemos.com](https://crm.globusdemos.com)
- **Architecture:** PM2 (backend) + Nginx (frontend static + reverse proxy) + Certbot SSL
- **Monitoring:** Sentry error tracking (@sentry/node) + 30-min demo-monitor cron (auto-files a tracker GitHub issue on `/api/health` 5xx)
- **Deploy flow** (`.github/workflows/deploy.yml`): on push to `main`, runs the 6-gate matrix in parallel; on all green → SSH pull → `npm install` → `prisma generate` → PM2 restart with `--update-env` → poll `/api/health` (auto-rollback to `HEAD~1` if unhealthy) → `vite build` → sudo rsync to `/var/www` → smoke check `/` + `/api/health`. Hotfix bypass via `workflow_dispatch.skip_tests=true` (manual UI only — a regular push can never bypass the gates).
- **Release tag** (`v*`): `git tag -a vX.Y.Z && git push origin vX.Y.Z` fires `e2e-full.yml` against the live demo. If green, the release stands; if red, fix on main and retag.
- **Provider plumbing on demo:** `SENDGRID_API_KEY` (transactional email), `TURNSTILE_SECRET_KEY` (landing-page form CAPTCHA — per-form opt-in via `props.enableCaptcha: true`), `WELLNESS_DEMO_OTP=1234` (patient portal OTP bypass for QA).

---

*Built by [Globussoft Technologies](https://globussoft.com)*
