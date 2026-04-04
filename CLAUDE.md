# Globussoft Enterprise CRM — Project Context

## Overview

Full-stack enterprise CRM built by Globussoft Technologies. Mirrors top-100 CRM platforms with a glassmorphism UI.

- **Repo:** https://github.com/Globussoft-Technologies/globussoft-crm
- **Version:** v2.0.0
- **Branch:** main (single-branch workflow)

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite, React Router v6, React.lazy() code splitting, Lucide Icons, Recharts, ReactFlow, Socket.io-client, Vanilla CSS (glassmorphism) |
| Backend | Node.js, Express.js, Prisma ORM, MySQL, Socket.io, node-cron, express-rate-limit, Swagger UI |
| Auth | JWT (bcryptjs), RBAC: ADMIN / MANAGER / USER |
| Production | PM2, Nginx reverse proxy, Certbot SSL |
| Testing | Playwright E2E (e2e/ directory, 26 spec files) |

## Architecture

### Backend (backend/)

- **server.js** — Express app, Socket.io, CORS allowlist, rate limiting, global auth guard, Swagger at `/api-docs`, route mounting, cron jobs
- **middleware/auth.js** — `verifyToken` + `verifyRole` JWT middleware
- **prisma/schema.prisma** — MySQL via Prisma ORM (DATABASE_URL env var)
- **prisma/seed.js** — Seeds all models with demo data
- **cron/leadScoringEngine.js** — AI lead scoring engine (every 10 min)
- **cron/sequenceEngine.js** — Automated sequence execution
- **cron/marketplaceEngine.js** — Indian marketplace lead sync (every 5 min)
- **utils/deduplication.js** — Phone normalization + contact/lead deduplication
- **routes/** — 27 route files: auth, contacts, deals, calendar, ai_scoring, workflows, communications, deals_documents, marketing, marketplace_leads, reports, developer, billing, search, ai, tickets, integrations, custom_objects, sequences, cpq, email, tasks, staff, expenses, contracts, estimates, projects
- All API endpoints prefixed with `/api/`
- Global auth guard protects all routes except /auth/login, /auth/signup, /auth/register, /health, /marketplace-leads/webhook
- Rate limiting: 5000 req/15min general, 1000 req/15min on auth/login

### Frontend (frontend/src/)

- **App.jsx** — AuthContext provider, React Router, Suspense + React.lazy() for 27 page components (code-split)
- **utils/api.js** — `fetchApi` helper with auto Bearer token and 401 redirect
- **components/** (8): Layout, Sidebar, CPQBuilder, CommandPalette, DealModal, Omnibar, Presence, Softphone
- **pages/** (34): Dashboard, Contacts, ContactDetail, Pipeline, Inbox, Marketing, MarketplaceLeads, Reports, Workflows, Developer, Billing, Marketplace, CustomObjects, CustomObjectView, Sequences, Tasks, LeadScoring, Settings, Signup, Login, Portal, Support, Leads, Clients, Invoices, Tickets, Staff, Expenses, Contracts, Estimates, Projects, ContactsDetail, Placeholder (unused)

### Prisma Models (21+)

User, Contact, Activity, Deal, Ticket, Campaign, AutomationRule, EmailMessage, CallLog, Attachment, ApiKey, Webhook, Invoice, Integration, CustomEntity, CustomField, CustomRecord, CustomValue, Sequence, SequenceEnrollment, Product, Quote, QuoteLineItem, Task, Expense, Contract, Estimate, EstimateLineItem, Project, Notification, AuditLog, PipelineStage, EmailTemplate, ReportSchedule, MarketplaceLead, MarketplaceConfig

## Core Modules

- **Dashboard** — Executive analytics overview (MRR, revenue, deal closures)
- **Pipeline** — Kanban drag-drop deal board (lead → contacted → proposal → won/lost)
- **Contacts** — 360-degree B2B/B2C directory with AI scoring
- **Leads** — Filtered contact view (status=Lead) with convert-to-customer
- **Clients** — Filtered contact view (status=Customer)
- **Sequences & Workflows** — Visual automation via ReactFlow
- **Inbox** — Omnichannel (email/SMS)
- **Marketing** — Campaign management
- **Reports** — BI analytics with Recharts
- **Billing** — Overview of invoices, estimates, expenses
- **Invoices** — Full invoice CRUD with mark-paid and void
- **Estimates** — Line-item estimates with convert-to-invoice
- **Expenses** — Category tracking with approve/reject/reimburse workflow
- **Contracts** — Contract lifecycle (Draft → Active → Expired → Terminated)
- **Projects** — Project management with budget and task association
- **Task Queue** — Task management with priority/status
- **Lead Scoring** — AI-powered scoring engine with cron
- **Support/Tickets** — Ticketing with priority/status/assignee
- **App Builder** — Custom Objects (dynamic schemas from UI)
- **Developer Portal** — API keys & webhooks
- **CPQ** — Configure-Price-Quote builder
- **Staff** — User directory with RBAC role management (ADMIN only)
- **Softphone** — Twilio VoIP integration
- **Real-time Presence** — Socket.io collaborative cursors
- **Command Palette & Omnibar** — Quick navigation
- **Marketplace Leads** — Indian marketplace integration (IndiaMART, JustDial, TradeIndia) with auto-import, deduplication, webhooks, and cron-based sync

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
- **Deploy flow:** `python deploy.py` — SSH pull, npm install, prisma generate/push, pm2 restart, vite build, copy dist, restart nginx
- **Deployment scripts** (gitignored, local only): deploy.py, deploy_backend.py, deploy_frontend.py, setup.sh, etc.

## Known Security Notes

1. **Hardcoded JWT secret** — falls back to `enterprise_super_secret_key_2026` when `JWT_SECRET` env var not set
2. **Auth bypass** — admin/admin login in routes/auth.js for demo/testing (intentional)
3. **CORS allowlist** — restricted to crm.globusdemos.com, localhost:5173, localhost:5000
4. **Rate limiting** — express-rate-limit on all API endpoints
5. **Deployment scripts with credentials** — removed from git tracking, added to .gitignore
6. **Credentials in git history** — SSH and MySQL passwords in old commits, should rotate

## E2E Testing

Tests live in `e2e/` using Playwright. Run with:

```bash
cd e2e && npx playwright test --project=chromium
```

26 spec files covering: auth, dashboard, contacts, pipeline, navigation, inbox, marketing, reports, billing, settings, developer, sequences, custom-objects, responsive, api-health, tasks, lead-scoring, leads, clients, invoices, tickets, staff, expenses, contracts, estimates, projects.

## GitHub

- **Issue tracking:** GitHub Issues with automated QA bug evidence screenshots
- **QA screenshots:** `qa_screenshots/` and `e2e_screenshots/` directories
- **GitHub Actions:** `.github/workflows/post_comments.yml` — auto-posts comments on issues

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
