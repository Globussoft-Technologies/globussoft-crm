# PRD — Public Status Page: `/status` (status.globusdemos.com)

**Status:** NOT STARTED — PRD draft only; design call required (DD-5.1 URL/hosting shape — `/status` SPA path vs `status.globusdemos.com` subdomain + DD-5.2 component-list source — hardcoded seed vs DB-driven admin UI + DD-5.5 incident-authorization boundary — SUPER_ADMIN only vs ADMIN + SUPER_ADMIN + DD-5.7 subscription scope — RSS-only v1 vs email/webhook subscriptions determine schema, routing, and admin-surface size materially).

**Source:** User request following the 2026-07-09 demo backend OOM/restart-loop incident. There is no GitHub issue yet; propose filing issue `#<next>` and labeling `needs-design-call`, `multi-day-feature`, `observability`, `public-surface`. The motivation is to give customers, prospects, and internal ops a single public page that shows whether the Globussoft CRM platform and its major subsystems are healthy, just as `status.claude.ai` and `status.moonshot.cn` do for Anthropic and Moonshot AI.

**Tier:** P3 / multi-day feature — public page + new Prisma models + health-probe cron + admin incident-management surface + RSS/Atom feed.

**Authored:** 2026-07-10.

**Sibling PRDs:** None directly adjacent. Tangentially related: `PRD_TRAVEL_SECURITY_ARCHITECTURE.md` (public-path auth-exemption patterns), `PRD_WELLNESS_RBAC.md` (role-gated admin surfaces), `PRD_UNIFIED_GLOBAL_SEARCH.md` (uses the same public-vs-internal path split). No direct dependency; this PRD can ship independently.

**Cluster:** `MANUAL_CODING_BACKLOG.md` cluster D — proposing **D21**; see §10.

**Cred dependency:** none external — pure schema + routes + cron + public React page + optional admin page. Re-uses existing `/api/health` and `/api/travel/health` endpoints, existing cron infrastructure, existing audit-hash-chain, and existing frontend design tokens.

---

## §1 Background + source attribution

The CRM today has **no public status page**. After the recent demo backend memory crisis (`backend/lib/audit.js` unbounded `findMany` causing 8–12 GB RSS and PM2 restart loops), customers and internal staff had no single public URL to check whether the platform was degraded or recovering. The only health signals were:

1. **`GET /api/health`** at `backend/server.js:1757-1778` — returns `{ status, timestamp }` unauthenticated and `{ version, uptime, database }` when an `Authorization` header is present. This is a point-in-time liveness probe, not a persisted history or incident surface.

2. **`GET /api/travel/health`** — travel-module health check used internally.

3. **Developer page (`/developer`)** — auth-gated internal page showing agent activity, API keys, webhooks, and CSP violations. Not customer-facing.

4. **Super Admin → API Analytics (`/super-admin/api-analytics`)** — auth-gated internal page showing LLM/external API cost/usage. Not customer-facing.

5. **PM2 + server logs on the demo box** — operator-only; requires SSH access.

The user explicitly asked for a page like `status.claude.ai` and `status.moonshot.cn`. Both are Atlassian Statuspage-style pages with the same structural blocks:

- A large overall-status banner at the top (“All Systems Operational”, “Partial Outage”, etc.).
- A grouped component list (Website, API Service, Sign In, File Uploads, Search, Models, SaaS, Open API, etc.) each with its own status pill.
- A 30–90-day uptime-history bar chart colored by the worst status per day.
- A reverse-chronological “Past Incidents” feed with `Investigating` / `Identified` / `Monitoring` / `Resolved` updates.
- Optional RSS/Atom feeds and subscribe-by-email.

This PRD scopes a **first slice** that delivers the public page, the backend data model, automated health probes, manual incident management, and RSS/Atom feeds. Email/webhook subscriptions and synthetic browser probes are deferred to Phase 2.

### What exists today that we can reuse

- `backend/server.js:1757` `/api/health` — public liveness probe for the core API + DB.
- `backend/routes/travel_*.js` — travel health endpoint (`/api/travel/health`).
- `backend/cron/` — existing cron infrastructure (e.g., `notificationRulesEngine`, `cron/*` jobs).
- `backend/lib/audit.js` — tamper-evident audit log; new `STATUS_INCIDENT_CREATED` / `_UPDATED` events flow through unchanged.
- `frontend/src/App.jsx` — React Router setup; public routes already exist outside `<Layout>` (`/p/*`, `/survey/:id`, `/knowledge-base/public/*`, etc.).
- `frontend/src/index.css` — design-token system (`--success-color`, `--warning-color`, `--danger-color`, `--surface-color`, `--text-primary`, etc.).
- `recharts` — already a frontend dependency for charts.
- `lucide-react` — already a frontend dependency for icons.

### What’s missing

1. **Persisted status history.** Today there is no table that records “CRM API was operational on 2026-07-09” or “Travel API was degraded from 14:00–15:30”. We need models for components, incidents, incident updates, and daily snapshots.

2. **Automated component health probes.** `/api/health` covers the core API and DB, but we need a scheduled probe that also checks Travel API, WebSocket presence, WhatsApp gateway, and any other critical subsystem, then writes the result into the status model.

3. **Incident management surface.** When ops wants to communicate a known degradation that probes alone cannot capture (e.g., third-party LLM provider outage, scheduled maintenance, degraded WhatsApp Business API), there must be an admin UI to create an incident and post updates.

4. **Public page at `/status`.** A no-auth React page that consumes the public status API and renders the banner, component list, uptime chart, and incident history.

5. **RSS/Atom feeds.** Standard status-page expectation; also lets us hook into external monitoring tools without building a webhook system in v1.

### Why this is multi-day, not a small page

The public page itself is small, but the feature needs:

- New Prisma schema + migration.
- A probe service that is resilient to its own failures (don’t let the probe crash the backend).
- A cron that writes daily snapshots without racing or duplicating rows.
- An admin incident surface with proper RBAC.
- RSS/Atom serialization.
- Decisions on hosting path, component source, auth boundary, and notification scope that affect the schema and routing.

---

## §2 Use cases

1. **A prospect sees a tweet about CRM slowness and checks `/status` before signing up.** They land on the public page, see the overall banner is green (“All Systems Operational”), scroll to the 90-day chart, and confirm no recent incidents. They continue with the trial instead of contacting sales.

2. **An existing customer’s WhatsApp messages stop delivering during a Wati outage.** They check `/status`, see “WhatsApp Gateway — Partial Outage” with an incident titled “Wati BSP elevated error rate” and an update: “Investigating — 14:05 IST”. They stop flooding support tickets because the issue is already acknowledged.

3. **Internal ops declares a maintenance window before the nightly DB backup.** A SUPER_ADMIN opens the admin status page, creates an incident with impact `maintenance`, status `monitoring`, and a message: “Scheduled maintenance 02:00–02:30 IST — brief API unavailability expected.” The public page shows the yellow maintenance banner immediately.

4. **After the recent OOM fix, the engineering lead wants to show stability.** They open `/status`, view the 30-day uptime chart, and point to the last 7 days of green bars for “CRM API” and “Database” as evidence that the audit backfill fix resolved the restart loop.

5. **A third-party monitoring tool polls the platform health.** Instead of scraping `/api/health`, it consumes `/api/status/feed.rss` or `/api/status/feed.atom` and surfaces incident titles in the customer’s IT channel.

---

## §3 Functional requirements

### 3.1 Public React status page at `/status`

- Route: `/status` mounted in `frontend/src/App.jsx` **outside** the auth `<Layout>` (public route, no login required).
- URL shape decision: default to `/status` path in v1. Subdomain (`status.globusdemos.com`) is Phase 2 per DD-5.1.
- Sections on the page:
  1. Overall status banner (large colored card).
  2. Component list grouped by category (Core, Travel, Integrations).
  3. 30/60/90-day uptime chart.
  4. Active incidents (if any).
  5. Past incidents reverse-chronological.
  6. Footer with RSS/Atom links and last-updated timestamp.
- Styling: standalone public page; recommend clean light theme (like `status.moonshot.cn`) rather than the app’s dark glass chrome per DD-5.6.

### 3.2 Prisma data model for status components

New model `StatusComponent`:

```prisma
model StatusComponent {
  id          Int                   @id @default(autoincrement())
  name        String                // e.g. "CRM API", "Travel API", "Database"
  group       String                // e.g. "Core", "Travel", "Integrations"
  description String?               // customer-facing one-liner
  sortOrder   Int                   @default(0)
  status      String                // operational | degraded | partial_outage | major_outage | maintenance
  isPublic    Boolean               @default(true)
  probeUrl    String?               // relative URL or custom probe key
  createdAt   DateTime              @default(now())
  updatedAt   DateTime              @updatedAt
  snapshots   StatusDailySnapshot[]
  incidents   StatusIncident[]
}
```

Components are seeded at deploy time (FR-3.2) and can be enabled/disabled by an admin in a later phase.

### 3.3 Prisma data model for incidents and updates

```prisma
model StatusIncident {
  id          Int                    @id @default(autoincrement())
  title       String
  impact      String                 // none | minor | major | critical | maintenance
  status      String                 // investigating | identified | monitoring | resolved
  components  StatusComponent[]      // affected components
  createdAt   DateTime               @default(now())
  resolvedAt  DateTime?
  updatedAt   DateTime               @updatedAt
  updates     StatusIncidentUpdate[]
}

model StatusIncidentUpdate {
  id          Int            @id @default(autoincrement())
  incidentId  Int
  incident    StatusIncident @relation(fields: [incidentId], references: [id], onDelete: Cascade)
  status      String         // investigating | identified | monitoring | resolved
  message     String
  createdAt   DateTime       @default(now())
}
```

### 3.4 Prisma data model for daily uptime snapshots

```prisma
model StatusDailySnapshot {
  id          Int             @id @default(autoincrement())
  componentId Int
  component   StatusComponent @relation(fields: [componentId], references: [id], onDelete: Cascade)
  date        DateTime        @db.Date
  uptimePct   Float           // 0.0 - 100.0
  worstStatus String          // operational | degraded | partial_outage | major_outage | maintenance | no_data
  probeCount  Int             // number of probe runs that day
  failCount   Int             // number of failed/degraded runs that day
  createdAt   DateTime        @default(now())

  @@unique([componentId, date])
  @@index([componentId, date])
}
```

### 3.5 Health probe service and cron

- New file: `backend/lib/statusProbe.js`.
- Probe targets (seed components):
  - `CRM API` → `GET /api/health` (same host, no auth).
  - `Travel API` → `GET /api/travel/health`.
  - `Database` → same `/api/health` DB check (derived from its response).
  - `WebSocket / Real-time` → optional lightweight Socket.IO handshake probe.
  - `WhatsApp Gateway` → `GET /api/whatsapp/onboard/status` or a new minimal status endpoint.
- Probe rules:
  - HTTP 200 + healthy body → `operational`.
  - HTTP 200 + degraded body or slow response (>threshold) → `degraded`.
  - HTTP non-2xx or timeout → `partial_outage` or `major_outage` based on consecutive failure count.
  - Two consecutive failures required before flipping from operational to degraded/partial to avoid flapping.
- New cron: `backend/cron/statusSnapshot.js` runs every 5 minutes:
  1. Runs probes.
  2. Updates `StatusComponent.status`.
  3. At 00:05 UTC, writes one `StatusDailySnapshot` row per component for the previous day.
- The probe must be fail-soft: a probe exception must not crash the cron or the backend.

### 3.6 Public status API

New file: `backend/routes/status.js`, mounted at `app.use("/api/status", require("./routes/status"))` in `server.js`, and added to the existing `openPaths` auth-exemption list.

Endpoints:

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/status` | public | Overall status + component list + active incidents |
| GET | `/api/status/history?days=30\|60\|90` | public | Daily snapshots per component for chart |
| GET | `/api/status/incidents` | public | Past + active incidents with updates |
| GET | `/api/status/feed.rss` | public | RSS 2.0 feed of incidents |
| GET | `/api/status/feed.atom` | public | Atom 1.0 feed of incidents |
| POST | `/api/status/incidents` | SUPER_ADMIN (or ADMIN per DD-5.5) | Create incident |
| PATCH | `/api/status/incidents/:id` | SUPER_ADMIN (or ADMIN per DD-5.5) | Update incident metadata / resolve |
| POST | `/api/status/incidents/:id/updates` | SUPER_ADMIN (or ADMIN per DD-5.5) | Post update to incident |

Response envelope follows existing API conventions: `{ success: true, data: { ... } }` or `{ success: false, error: { code, message } }`.

### 3.7 Overall status derivation

Overall status is the **worst** status across all public components, ordered as:

```
maintenance < operational < degraded < partial_outage < major_outage
```

Wait — maintenance is not worse than outage; it is a planned state. The banner text/color should be:

- `major_outage` → “Major Outage” (red).
- `partial_outage` → “Partial Outage” (orange).
- `degraded` → “Degraded Performance” (yellow).
- `maintenance` → “Maintenance in Progress” (blue/purple) if no outage; otherwise outage wins.
- all `operational` → “All Systems Operational” (green).

### 3.8 Admin incident-management surface

- New page: `frontend/src/pages/admin/StatusAdmin.jsx`.
- Route: `/admin/status` inside the auth `<Layout>`, gated by `SUPER_ADMIN` (or `ADMIN` per DD-5.5).
- Features:
  - List active and resolved incidents.
  - Create incident: title, impact, affected components, initial message.
  - Post update: status transition + message.
  - Resolve incident: sets `resolvedAt` and posts a final `Resolved` update.
- Each create/update emits `writeAudit('STATUS_INCIDENT', action, incidentId, userId, tenantId, payload)`.

### 3.9 RBAC matrix

| Action | Role |
|--------|------|
| View `/status` page + public API | unauthenticated public |
| Create / update / resolve incidents | SUPER_ADMIN (default; DD-5.5 can extend to ADMIN) |
| View admin status page | SUPER_ADMIN (default; DD-5.5 can extend to ADMIN) |
| Probe writes to `StatusComponent` / `StatusDailySnapshot` | internal cron only |

### 3.10 RSS/Atom feeds

- RSS 2.0 at `/api/status/feed.rss` and Atom 1.0 at `/api/status/feed.atom`.
- Include active incidents + incidents resolved within the last 30 days.
- Each `<item>` / `<entry>` maps to an incident update or the incident itself (decision in DD-5.4). Recommendation: one entry per incident, with the latest update in the summary and a link to `/status`.

---

## §4 Non-functional requirements

### 4.1 Tenant scoping

Status is **global/instance-level**, not per-tenant. The public page describes the health of the whole CRM deployment. Therefore the new Prisma models do **not** carry `tenantId`. The admin incident surface still runs inside a tenant context for RBAC/audit purposes, but the data it writes is global.

### 4.2 Performance

- `GET /api/status` must respond in <200 ms under normal load.
- Daily snapshots are pre-aggregated; the history endpoint does not scan probe logs at request time.
- Public endpoints are read-only and should be safe to cache by a CDN for 60 seconds.

### 4.3 Security / PII

- Public responses must not include internal hostnames, IP addresses, DB connection strings, or user data.
- The admin write endpoints must be auth-gated and CSRF-safe because they use the same cookie/bearer pattern as other admin routes.
- `openPaths` exemption for `/api/status` must be prefix-based (`/api/status`) but must not accidentally exempt other routes.

### 4.4 Audit

- Incident create/update/resolve emits audit events via `backend/lib/audit.js` with category `STATUS_INCIDENT`.
- Probe-driven component status flips are **not** audited per row (too noisy); instead log one `STATUS_PROBE_DAILY` summary event per day.

### 4.5 Idempotency

- Incident updates are append-only; there is no `PUT /api/status/incidents/:id/updates/:updateId`.
- Daily snapshot writes use `@@unique([componentId, date])` and `upsert` to prevent duplicates if the cron restarts.

### 4.6 Migration plan

- One Prisma migration creates the four new tables.
- A seed script (`backend/prisma/seed-status-components.js`) inserts the default component list at deploy time.
- No backfill is required; uptime history starts empty and accumulates daily.

### 4.7 Observability of the observer

- The status probe cron must log failures to the existing backend log.
- If the probe itself fails (e.g., cannot reach the database), the public page should degrade gracefully: components show `no_data` rather than crash.

---

## §5 Hand-over reqs / design decisions / vendor docs

- **DD-5.1: Hosting / URL shape — `/status` path vs `status.globusdemos.com` subdomain.**
  - Option A: React route `/status` on the existing `crm.globusdemos.com` SPA. Simplest: one domain, one build, no DNS.
  - Option B: Separate subdomain `status.globusdemos.com` pointing at the same frontend build but rendering only the status page. More professional, isolates status from app outages, but requires DNS + Nginx + SSL config.
  - **Recommend Option A for v1** — ship `/status` first, then migrate to a subdomain in Phase 2 if traffic/brand needs justify it.

- **DD-5.2: Component list source — hardcoded seed vs DB-driven admin UI.**
  - Option A: Hardcoded array in `backend/lib/statusProbe.js` and `frontend/src/pages/StatusPage.jsx`. Fastest to build; requires a code change to add/remove components.
  - Option B: DB-driven `StatusComponent` rows with a small admin CRUD surface. More flexible, slightly more frontend work.
  - **Recommend Option B but scope the admin CRUD to SUPER_ADMIN and defer it to Phase 1.5** — seed the rows at deploy, ship the public page + incident UI first, then add component CRUD.

- **DD-5.3: Probe location — inside the backend cron vs external service.**
  - Option A: Add a cron job inside the existing Node backend. Reuses infrastructure; probes share the same process/network as the app.
  - Option B: External lightweight service (e.g., a separate PM2 process or a tiny worker). More isolated but adds deployment complexity.
  - **Recommend Option A for v1** — `backend/cron/statusSnapshot.js` mounted in the existing cron scheduler.

- **DD-5.4: Uptime aggregation — daily snapshots vs event-log recomputation.**
  - Option A: Store a probe result event per run and recompute the daily bar on request. Accurate but slower and grows storage linearly with probe frequency.
  - Option B: Store one `StatusDailySnapshot` row per component per day. Fast reads, bounded storage, but loses intra-day detail.
  - **Recommend Option B for v1**; store only the daily worst status + uptime percentage. Intra-day detail can be added later with a `StatusProbeEvent` table.

- **DD-5.5: Incident authorization — SUPER_ADMIN only vs ADMIN + SUPER_ADMIN.**
  - Option A: SUPER_ADMIN only. Keeps the incident surface small and operator-grade.
  - Option B: Any user with an `ADMIN` role in any tenant. More convenient for tenant admins but risks inconsistent messaging across tenants.
  - **Recommend Option A for v1** — gate incident management to SUPER_ADMIN. Revisit in Phase 2 if tenant-specific status pages are needed.

- **DD-5.6: Public page theme — reuse app dark glass theme vs clean light public theme.**
  - Option A: Reuse `frontend/src/index.css` dark variables. Consistent with the app but may look heavy for a public status page.
  - Option B: Dedicated light-theme status page with green/yellow/orange/red status pills, like `status.moonshot.cn`. More familiar to users of status pages.
  - **Recommend Option B** — a standalone public page should look like a status page, not a CRM dashboard.

- **DD-5.7: Subscription notifications — RSS/Atom only vs email/webhook subscriptions.**
  - Option A: RSS/Atom feeds only in v1. Simple, no storage of subscriber data, no email vendor.
  - Option B: Add email + webhook subscriptions. Requires subscriber storage, email delivery, webhook retry logic, and compliance (unsubscribe).
  - **Recommend Option A for v1**; defer email/webhook subscriptions to Phase 2.

- **No cred chase.** All external services probed already have existing status endpoints or health checks.

---

## §6 Acceptance criteria

1. **Public page renders without authentication.** Navigating to `https://crm.globusdemos.com/status` while logged out shows the overall banner, component list, uptime chart, and incident history within 3 seconds.

2. **Public API latency.** `GET /api/status` returns a 200 in <200 ms when the database and backend are healthy.

3. **Automated probe flip.** If the Travel API health endpoint returns 5xx on two consecutive 5-minute cron ticks, the `Travel API` component on `/status` changes from “Operational” to “Partial Outage” without manual intervention.

4. **Incident lifecycle is visible.** A SUPER_ADMIN creates an incident titled “Database maintenance window”, posts an “Investigating” update, then a “Resolved” update. Within 60 seconds the public `/status` page shows the incident under “Past Incidents” with both updates and a green “Resolved” badge.

5. **RSS feed is consumable.** `curl https://crm.globusdemos.com/api/status/feed.rss` returns valid RSS 2.0 XML containing at least the active incidents and incidents resolved in the last 30 days.

---

## §7 Out of scope

1. **Separate subdomain hosting (`status.globusdemos.com`)** — deferred to Phase 2 pending DD-5.1 decision.
2. **Email, SMS, Slack, or webhook subscriptions** — deferred to Phase 2 pending DD-5.7 decision.
3. **Synthetic browser/E2E probes** (e.g., Playwright running against the login flow) — Phase 3.
4. **Mobile app push notifications** — not applicable until a mobile app exists.
5. **SLA/SLO contractual reporting or uptime SLAs** — Phase 2; v1 is informational only.
6. **Per-tenant status pages** — global status only; tenant-scoped status is a separate future feature.
7. **Automatic incident creation from probes** — probes update component status; ops manually converts component status into incidents if customer communication is needed.

---

## §8 Dependencies

- `backend/prisma/schema.prisma` — adds four new models.
- `backend/server.js` — mounts `/api/status` route and adds `/api/status` to `openPaths`.
- `backend/routes/status.js` — new route file.
- `backend/lib/statusProbe.js` — new probe service.
- `backend/cron/statusSnapshot.js` — new cron job.
- `backend/lib/audit.js` — reused for incident audit events.
- `frontend/src/App.jsx` — adds `/status` public route.
- `frontend/src/pages/StatusPage.jsx` — new public page.
- `frontend/src/pages/admin/StatusAdmin.jsx` — new admin page.
- `frontend/src/index.css` — small additions for status-page-specific light theme classes (or a new `frontend/src/theme/status-page.css`).
- Existing endpoints reused by probes:
  - `GET /api/health`
  - `GET /api/travel/health`
  - `GET /api/whatsapp/onboard/status` (or a new minimal endpoint if this one is too heavy)
- Existing dependencies: `react`, `react-router-dom`, `recharts`, `lucide-react`.

---

## §9 Open questions

- **Q1: URL / hosting — do we ship `/status` on the main domain first, or do we want `status.globusdemos.com` from day one?** (Affects DNS/Nginx work and frontend build routing.)

- **Q2: Incident auth boundary — should tenant-level `ADMIN` users be allowed to create incidents, or strictly `SUPER_ADMIN`?** (Affects RBAC, admin route placement, and audit tenant context.)

- **Q3: Component list — do we hardcode the initial component list and add an admin CRUD later, or do we build the admin CRUD in v1?** (Affects frontend scope and deploy-time seeding.)

- **Q4: Probe-driven component failures — should the system auto-create an incident when a probe detects a major outage, or only update component status and let a human declare the incident?** (Affects incident noise and automation trust.)

- **Q5: Uptime history window — 30, 60, or 90 days?** (Affects chart width, snapshot storage, and default API behavior.)

- **Q6: Maintenance windows — do we need a scheduled maintenance model now, or is treating maintenance as an incident type sufficient for v1?** (Affects schema and whether the banner can show “Maintenance planned for Jul 20” before it starts.)

- **Q7: Public page theme — clean light status-page theme, or reuse the existing app dark glass theme?** (Affects CSS work and brand perception.)

---

## §10 Status snapshot

```markdown
- Status: NOT STARTED (PRD draft only)
- Owner: TBD per product call
- Estimated effort post-design: 4–6 engineering days
  - Schema + migration + seed: 0.5 day
  - Probe service + daily snapshot cron: 1 day
  - Public API routes + RSS/Atom: 1 day
  - Public `/status` React page: 1 day
  - Admin incident-management page: 1 day
  - Tests + deploy wiring + docs: 0.5–1 day
- Cluster: MANUAL_CODING_BACKLOG.md cluster D — propose **D21**
- Blocks before implementation can start:
  - DD-5.1 — URL/hosting shape (`/status` vs subdomain)
  - DD-5.2 — component-list source (hardcoded seed vs DB-driven admin CRUD)
  - DD-5.5 — incident authorization boundary (SUPER_ADMIN only or ADMIN too)
  - OQ-9.5 — uptime history window length
  - OQ-9.7 — public page theme choice
- Sibling PRDs: none directly.
```
