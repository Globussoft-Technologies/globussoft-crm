# Globussoft Enterprise CRM

> A full-stack enterprise CRM built by Globussoft Technologies with glassmorphism UI, AI-powered lead scoring, dark/light theme, and 25+ fully functional modules.

**Live:** [crm.globusdemos.com](https://crm.globusdemos.com) | **Version:** v2.0.0

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Vite, React Router v6, React.lazy() code splitting, Lucide Icons, Recharts, ReactFlow, Socket.io-client |
| Backend | Node.js, Express.js, Prisma ORM, MySQL, Socket.io, node-cron, express-rate-limit, Swagger UI |
| Auth | JWT (bcryptjs), RBAC: ADMIN / MANAGER / USER |
| Production | PM2, Nginx reverse proxy, Certbot SSL |
| Testing | Playwright E2E (30 spec files, 270+ tests) |
| Styling | Vanilla CSS with glassmorphism design, dark/light theme support |

## Modules

### Sales & Pipeline
- **Dashboard** - Executive analytics (MRR, revenue, deal closures, pipeline charts)
- **Pipeline** - Kanban drag-and-drop deal board with real-time Socket.io sync
- **Contacts** - 360-degree B2B/B2C directory with AI scoring
- **Leads** - Filtered contacts (status=Lead) with convert-to-customer
- **Clients** - Filtered contacts (status=Customer) with search
- **Lead Scoring** - AI-powered scoring engine running on node-cron

### Automation & Communication
- **Sequences** - Visual drip campaign builder with ReactFlow
- **Workflows** - Automation rule engine with visual flow editor
- **Inbox** - Omnichannel communications (email/SMS)
- **Marketing** - Campaign management with metrics

### Financial
- **Billing** - Invoice overview and management
- **Invoices** - Full CRUD with mark-paid, void, status badges
- **Estimates** - Line-item estimates with convert-to-invoice
- **Expenses** - Category tracking with approve/reject/reimburse workflow
- **Contracts** - Contract lifecycle (Draft > Active > Expired > Terminated)
- **CPQ** - Configure-Price-Quote builder with deal selection and line-item schemas

### Project & Task Management
- **Projects** - Project management with budget, status, and task association
- **Task Queue** - Priority-based task management with status tracking

### Support
- **Tickets** - Support ticketing with priority/status/assignee
- **Support** - Customer helpdesk management

### Platform & Developer
- **App Builder** - Custom Objects with dynamic schemas from UI (EAV pattern)
- **Developer Portal** - API key provisioning and webhook configuration
- **Staff** - User directory with RBAC role management (ADMIN only)
- **Marketplace** - Integration catalog
- **Settings** - Organization settings, user management, dark/light theme toggle
- **Command Palette** - Quick navigation (Cmd+K / Ctrl+K)
- **Softphone** - Twilio VoIP integration
- **Real-time Presence** - Socket.io collaborative cursors

### Dark / Light Theme
Full theme support across all pages. Toggle from Settings > Appearance. Persists across sessions via localStorage. Uses CSS custom properties with `[data-theme="light"]` overrides.

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

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@globussoft.com | password123 |
| Manager | manager@crm.com | password123 |
| User | user@crm.com | password123 |
| Test bypass | admin | admin |

## API

28 route modules, all prefixed with `/api/`, protected by JWT auth.

Rate limiting: 5000 req/15min general, 1000 req/15min on auth.

Interactive docs at `/api-docs` (Swagger UI).

## E2E Testing

30 Playwright spec files with 270+ tests covering all modules, API health, responsive design, theme toggle, and navigation flows.

```bash
cd e2e && npx playwright test --project=chromium
```

## Deployment

- **Domain:** crm.globusdemos.com
- **Architecture:** PM2 (backend) + Nginx (frontend static + reverse proxy) + Certbot SSL
- **Deploy flow:** git pull > npm install > prisma generate > vite build > copy dist to Nginx > pm2 restart

---

*Built by [Globussoft Technologies](https://globussoft.com)*
