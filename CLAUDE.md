# Globussoft Enterprise CRM -- Project Context

## Overview

Full-stack enterprise CRM built by Globussoft Technologies. Mirrors top-100 CRM platforms with a glassmorphism UI.

- **Repo:** https://github.com/Globussoft-Technologies/globussoft-crm
- **Version:** v3.0.0
- **Branch:** main (single-branch workflow)

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
- **prisma/schema.prisma** -- MySQL via Prisma ORM (DATABASE_URL env var), 99 models
- **prisma/seed.js** -- Seeds all models with demo data
- **utils/deduplication.js** -- Phone normalization + contact/lead deduplication
- All API endpoints prefixed with `/api/`
- Global auth guard protects all routes except /auth/login, /auth/signup, /auth/register, /health, /marketplace-leads/webhook
- Rate limiting: 5000 req/15min general, 1000 req/15min on auth/login

### Cron Engines (backend/cron/) -- 12 engines

| Engine | File | Purpose |
|--------|------|---------|
| Lead Scoring | leadScoringEngine.js | AI lead score recalculation (every 10 min) |
| Sequence | sequenceEngine.js | Drip sequence step execution |
| Marketplace | marketplaceEngine.js | IndiaMART/JustDial/TradeIndia lead sync (every 5 min) |
| Workflow | workflowEngine.js | Automation rule evaluation |
| Campaign | campaignEngine.js | Marketing campaign dispatch |
| Report | reportEngine.js | Scheduled report generation and email delivery |
| Recurring Invoice | recurringInvoiceEngine.js | Recurring invoice generation (daily) |
| Forecast Snapshot | forecastSnapshotEngine.js | Revenue forecast snapshots (daily) |
| Deal Insights | dealInsightsEngine.js | AI deal insight generation |
| Sentiment | sentimentEngine.js | Customer sentiment analysis |
| Scheduled Email | scheduledEmailEngine.js | Scheduled email dispatch |
| Retention | retentionEngine.js | GDPR data retention enforcement |

### Services (backend/services/) -- 5 services

- **smsProvider.js** -- SMS delivery via MSG91/Twilio
- **whatsappProvider.js** -- WhatsApp Cloud API messaging
- **telephonyProvider.js** -- Click-to-call via MyOperator/Knowlarity
- **pushService.js** -- Web push notification delivery (VAPID)
- **landingPageRenderer.js** -- Server-side landing page rendering

### Libraries (backend/lib/) -- 5 modules

- **prisma.js** -- Shared Prisma client instance
- **eventBus.js** -- In-process event bus for decoupled modules
- **notificationService.js** -- Notification creation and delivery
- **webhookDelivery.js** -- Outbound webhook dispatch with retry
- **sentry.js** -- Sentry error tracking initialization

### Routes (backend/routes/) -- 88 route files

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

### Frontend (frontend/src/)

- **App.jsx** -- AuthContext provider, React Router, Suspense + React.lazy() for 76 page components (code-split)
- **utils/api.js** -- `fetchApi` helper with auto Bearer token and 401 redirect

### Frontend Components (frontend/src/components/) -- 11 components

CPQBuilder, CommandPalette, DealModal, EmailSignatureEditor, LanguageSwitcher, Layout, NotificationBell, Omnibar, Presence, Sidebar, Softphone

### Frontend Pages (frontend/src/pages/) -- 76 pages

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

**Auth:** Login, Signup, Placeholder

### Prisma Models (99)

AbTest, AccountingSync, Activity, ApiKey, ApprovalRequest, Attachment, AuditLog, AutomationRule, Booking, BookingPage, CalendarEvent, CalendarIntegration, CallLog, Campaign, CannedResponse, Chatbot, ChatbotConversation, ConsentRecord, Contact, ContactAttachment, Contract, Currency, CustomEntity, CustomField, CustomRecord, CustomReport, CustomValue, Dashboard, DataExportRequest, Deal, DealInsight, DocumentTemplate, DocumentView, EmailMessage, EmailTemplate, EmailTracking, Estimate, EstimateLineItem, Expense, FieldPermission, Forecast, IndustryTemplate, Integration, Invoice, KbArticle, KbCategory, LandingPage, LandingPageAnalytics, LeadRoutingRule, LiveChatMessage, LiveChatSession, MarketplaceConfig, MarketplaceLead, Notification, Payment, Pipeline, PipelineStage, Playbook, PlaybookProgress, Product, Project, PushNotification, PushSubscription, PushTemplate, Quota, Quote, QuoteLineItem, ReportSchedule, RetentionPolicy, SandboxSnapshot, ScheduledEmail, ScimToken, Sequence, SequenceEnrollment, SharedInbox, SignatureRequest, SlaPolicy, SmsConfig, SmsMessage, SmsTemplate, SocialMention, SocialPost, SsoConfig, Survey, SurveyResponse, Task, TelephonyConfig, Tenant, Territory, Ticket, Touchpoint, User, VoiceSession, WebVisitor, Webhook, WhatsAppConfig, WhatsAppMessage, WhatsAppTemplate, WinLossReason

## Demo Credentials

- **Admin:** admin@globussoft.com / password123
- **Manager:** manager@crm.com / password123
- **User:** user@crm.com / password123
- **Test bypass:** admin / admin (hardcoded in routes/auth.js)

## Deployment

- **Domain:** crm.globusdemos.com
- **Server:** 163.227.174.141 (Ubuntu, user: empcloud-development)
- **Database:** MySQL on localhost:3306, database `gbscrm`
- **Nginx:** serves static frontend from `/var/www/crm.globusdemos.com`, proxies `/api/` to Express on port 5099
- **SSL:** Certbot (Let's Encrypt)
- **PM2:** `globussoft-crm-backend` only (frontend served by Nginx directly)
- **Monitoring:** Sentry (@sentry/node) for error tracking
- **Deploy flow:** `python deploy.py` -- SSH pull, npm install, prisma generate/push, pm2 restart, vite build, copy dist, restart nginx
- **Deployment scripts** (gitignored, local only): deploy.py, deploy_backend.py, deploy_frontend.py, setup.sh, etc.

## Known Security Notes

1. **Hardcoded JWT secret** -- falls back to `enterprise_super_secret_key_2026` when `JWT_SECRET` env var not set
2. **Auth bypass** -- admin/admin login in routes/auth.js for demo/testing (intentional)
3. **CORS allowlist** -- restricted to crm.globusdemos.com, localhost:5173, localhost:5000
4. **Rate limiting** -- express-rate-limit on all API endpoints
5. **Deployment scripts with credentials** -- removed from git tracking, added to .gitignore
6. **Credentials in git history** -- SSH and MySQL passwords in old commits, should rotate

## E2E Testing

Tests live in `e2e/` using Playwright. Run with:

```bash
cd e2e && npx playwright test --project=chromium
```

40 spec files covering: auth, dashboard, contacts, pipeline, navigation, inbox, marketing, reports, billing, settings, developer, sequences, custom-objects, responsive, api-health, tasks, lead-scoring, leads, clients, invoices, tickets, staff, expenses, contracts, estimates, projects, and more.

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
