# Globussoft Enterprise CRM — Project Context

## Overview

Full-stack enterprise CRM built by Globussoft Technologies. Mirrors top-100 CRM platforms with a glassmorphism UI.

- **Repo:** https://github.com/Globussoft-Technologies/globussoft-crm
- **Version:** v2.0.0
- **Branch:** main (single-branch workflow)

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite, React Router v6, Lucide Icons, Recharts, ReactFlow, Socket.io-client, Vanilla CSS (glassmorphism) |
| Backend | Node.js, Express.js, Prisma ORM, SQLite, Socket.io, node-cron, Swagger UI |
| Auth | JWT (bcryptjs), RBAC: ADMIN / MANAGER / USER |
| Production | PM2, Nginx reverse proxy, Certbot SSL |
| Testing | Playwright E2E (e2e/ directory) |

## Architecture

### Backend (backend/)

- **server.js** — Express app, Socket.io, CORS, Swagger at `/api-docs`, route mounting, weekly cron
- **middleware/auth.js** — `verifyToken` + `verifyRole` JWT middleware
- **prisma/schema.prisma** — SQLite via Prisma ORM
- **routes/** — 20 route files: auth, contacts, deals, calendar, ai_scoring, workflows, communications, deals_documents, marketing, reports, developer, billing, search, ai, tickets, integrations, custom_objects, sequences, cpq, email
- All API endpoints prefixed with `/api/`

### Frontend (frontend/src/)

- **App.jsx** — AuthContext provider, React Router, protected routes via token check
- **utils/api.js** — `fetchApi` helper with auto Bearer token and 401 redirect
- **components/** (8): Layout, Sidebar, CPQBuilder, CommandPalette, DealModal, Omnibar, Presence, Softphone
- **pages/** (22): Dashboard, Contacts, ContactsDetail, ContactDetail, Pipeline, Inbox, Marketing, Reports, Workflows, Developer, Billing, Marketplace, CustomObjects, CustomObjectView, Sequences, Settings, Signup, Login, Portal, Placeholder, Support

### Prisma Models

User, Contact, Activity, Deal, Ticket, Campaign, AutomationRule, EmailMessage, CallLog, Attachment, ApiKey, Webhook, Invoice, Integration, CustomEntity, CustomField, CustomRecord, CustomValue, Sequence, SequenceEnrollment, Product, Quote, QuoteLineItem

## Core Modules

- **Dashboard** — Executive analytics overview (MRR, revenue, deal closures)
- **Pipeline** — Kanban drag-drop deal board (lead → contacted → proposal → won/lost)
- **Contacts** — 360-degree B2B/B2C directory with AI scoring
- **Sequences & Workflows** — Visual automation via ReactFlow
- **Inbox** — Omnichannel (email/SMS)
- **Marketing** — Campaign management
- **Reports** — BI analytics with Recharts
- **Billing** — Invoices, estimates, expenses
- **Support/Tickets** — Ticketing system
- **App Builder** — Custom Objects (dynamic schemas from UI)
- **Developer Portal** — API keys & webhooks
- **CPQ** — Configure-Price-Quote builder
- **Softphone** — Twilio VoIP integration
- **Real-time Presence** — Socket.io collaborative cursors
- **Command Palette & Omnibar** — Quick navigation

### Placeholder Routes (not yet implemented)

expenses, contracts, estimates, invoices, tickets, tasks, projects, clients, leads, staff — all render a generic Placeholder component

## Demo Credentials

- **Admin:** admin@globussoft.com / password123
- **Manager:** manager@crm.com / password123
- **User:** user@crm.com / password123
- **Test bypass:** admin / admin (hardcoded in routes/auth.js)

## Deployment

- **Domain:** crm.globusdemos.com
- **Server:** 163.227.174.141 (Ubuntu, user: empcloud-development)
- **Nginx:** serves static frontend from `/var/www/crm.globusdemos.com`, proxies `/api/` to Express on port 5099
- **SSL:** Certbot (Let's Encrypt)
- **PM2 processes:** `globussoft-crm-backend` (Express), `globussoft-crm-frontend` (static serve, deprecated in favor of Nginx)
- **Deploy flow:** Build frontend locally → SSH upload dist → copy to /var/www → restart Nginx. No CI/CD pipeline yet.
- **Deployment scripts** (gitignored, local only): deploy.py, deploy_frontend.sh, setup.sh, start.sh, fix-nginx.sh, fix_ssl.sh, fix_500_403.sh, recover.sh

## Known Security Notes

1. **Hardcoded JWT secret** — falls back to `enterprise_super_secret_key_2026` when `JWT_SECRET` env var not set
2. **Auth bypass** — admin/admin login in routes/auth.js for demo/testing (intentional)
3. **CORS wide open** — `cors({ origin: "*" })` in server.js
4. **No rate limiting** on any endpoints
5. **SQLite .db committed** — prisma/globussoft.db is in the repo
6. **Deployment scripts with credentials** — removed from git tracking, added to .gitignore

## E2E Testing

Tests live in `e2e/` using Playwright. Run with:

```bash
cd e2e && npx playwright test --project=chromium
```

15 spec files covering: auth, dashboard, contacts, pipeline, navigation, inbox, marketing, reports, billing, settings, developer, sequences, custom-objects, responsive, api-health.

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
```
