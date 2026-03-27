# Globussoft Enterprise CRM

> A modern, premium Customer Relationship Management system built with React, Vite, Node.js, Express, and Prisma ORM.

This application provides essential tools for managing contacts, tracking sales pipelines, executing complex AI sequences, and visualizing core metrics. The platform is engineered to mirror the capabilities of the world's top enterprise CRM suites with a relentless focus on aesthetics, rapid workflows, and scalability.

## ✨ Core Modules & Available Features

The CRM is divided into high-performance web modules. Below is a comprehensive list of all functionalities developed and actively supported:

### 💼 Field Sales & Management
- **Dashboard Analytics:** High-level executive overview of active MRR, revenue streams, and deal closures.
- **Pipeline (Kanban):** Drag-and-drop opportunity management board to track deals across Lifecycle Stages.
- **Contacts Directory:** A highly sortable, 360-degree ledger for managing individual B2B/B2C prospect profiles.
- **Sequences & Workflows:** Visual automation orchestrators for drip campaigns and conditional outbound targeting.

### 🌐 Operations & Productivity
- **Omnichannel Inbox:** Unified communications nexus integrating synced email threads and SMS data.
- **Settings & Security:** Enterprise RBAC (Role-Based Access Control) supporting `ADMIN`, `MANAGER`, and `USER` tiers.
- **Marketing Hub:** Tools for executing scalable outreach and measuring outbound campaign effectiveness.
- **Reports & Business Intelligence:** Analytical drill-downs of organizational performance (e.g., automated weekly PDF CRON summaries).
- **Billing & Transactions:** Accounts receivable oversight for estimates, invoices, and expense tracking.

### 🛠️ Advanced Engineering & Customization
- **App Builder (Custom Objects):** Define new proprietary dynamic database schemas on-the-fly directly from the user interface without touching raw SQL.
- **Developer Portal & Webhooks:** First-class API key provisioning and granular webhook endpoint configurations for developers. 
- **Real-Time Presence:** Powered by Socket.io, enabling real-time collaborative cursor tracking inside shared workspaces.
- **Unified Modular Routing:** Broad fallback structures guarantee that newly activating endpoints (e.g., `Staff`, `Tasks`, `Tickets`) elegantly render "In Development" states securely without 404 crashes.

## 🛠 Tech Stack

- **Frontend Edge:** React.js 18, React Router v6, Vite build toolchain, Lucide Web Icons, Vanilla CSS (Glassmorphism UI Engine).
- **Backend Core:** Node.js, Express.js REST API Architecture, Swagger UI.
- **Database & State:** SQLite, Prisma ORM.
- **Real-Time Delivery:** Socket.io, Node-Cron (Scheduling).
- **Production Architecture:** PM2 Runtime, Nginx Reverse Proxy, Certbot SSL.

## 🚀 Getting Started

Follow these instructions to spin up the local development servers.

### 1. Backend Setup
1. Mount the `backend` directory: `cd backend`
2. Install dependencies: `npm install`
3. Generate the Prisma database maps: `npx prisma generate` && `npx prisma db push`
4. Ignite the server: `npm run dev`
   *(API securely mounted on http://localhost:5000 | Docs at `/api-docs`)*

### 2. Frontend Setup
1. Mount the `frontend` directory: `cd frontend`
2. Install dependencies: `npm install`
3. Launch proxy server: `npm run dev`
   *(Client UI mounted on http://localhost:5173)*

## 🔒 Demo Credentials
Test out the role-based functionality using the following seed identities:
- **Admin Root:** admin@globussoft.com / `password123`
- **Manager Node:** manager@crm.com / `password123`
- **User Node:** user@crm.com / `password123`

---
*Developed and maintained by the Engineering Org at Globussoft.*
