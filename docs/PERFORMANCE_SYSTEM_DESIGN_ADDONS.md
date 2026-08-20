# Performance System Design Add-ons

> Catalog of optional products/components that can be added to the CRM architecture to improve performance, scalability, and operability without replacing the existing MySQL/Prisma transactional core.
>
> This doc is complementary to [BACKEND_MEMORY_AND_STORAGE_OPTIMIZATION.md](./BACKEND_MEMORY_AND_STORAGE_OPTIMIZATION.md) (memory/disk footprint) and [ARCHITECTURE_LIGHTWEIGHT_BACKEND.md](./ARCHITECTURE_LIGHTWEIGHT_BACKEND.md) (WhatsApp gateway extraction).

---

## 1. Target architecture overview

```
                                    ┌──────────────────┐
                                    │   Cloudflare /   │
                                    │   CDN + WAF      │
                                    └────────┬─────────┘
                                             │
                                             ▼
┌──────────────┐      ┌──────────────────────────────────────────┐
│   React SPA  │◄────►│  Nginx reverse proxy / static assets     │
│  (Vite)      │      └──────────────┬───────────────────────────┘
└──────────────┘                     │
                                     ▼
                          ┌──────────────────────┐
                          │  Node.js / Express   │
                          │  Backend (PM2)       │
                          └──────────┬───────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
        ▼                            ▼                            ▼
┌──────────────┐         ┌─────────────────────┐       ┌──────────────────┐
│   Dragonfly  │         │   MySQL 8 Primary   │       │   ClickHouse     │
│   / Redis    │         │   + Read Replica(s) │       │   (OLAP/events)  │
│              │         │                     │       │                  │
│ • sessions   │         │ • transactions      │       │ • dashboards     │
│ • cache      │         │ • Prisma ORM        │       │ • audit trails   │
│ • rate-limit │         │ • foreign keys        │       │ • time-series    │
│ • queues     │         │ • row-level locking   │       │ • funnels        │
└──────┬───────┘         └─────────────────────┘       └──────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Background workers                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   BullMQ     │  │  Meilisearch │  │         MinIO / S3       │  │
│  │   workers    │  │   (search)   │  │    (files / exports)       │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component-by-component recommendations

### 2.1 DragonflyDB (or Redis) — in-memory data layer

**What it is:** A Redis-compatible, multi-threaded in-memory store.

**Add to:** Backend caching, session store, rate limiting, Socket.io pub/sub, background job queues.

**Solves in this CRM:**
- Tenant settings and feature flags are read on almost every request.
- Dashboard KPIs and report counts are recomputed repeatedly.
- Rate-limit counters need atomic increments across multiple PM2 workers.
- Socket.io real-time state is currently in-memory, preventing horizontal scaling.

**Recommended product:** [DragonflyDB](https://www.dragonflydb.io/) (self-host) or [Upstash](https://upstash.com/) / AWS ElastiCache (managed Redis) if you prefer a wider managed-provider choice.

**Integration points:**
- `express-session` with `connect-redis`.
- `express-rate-limit` with a Redis store.
- Socket.io Redis adapter (`@socket.io/redis-adapter`).
- BullMQ (`bullmq`) for background jobs.
- Custom `backend/lib/cache.js` using `ioredis` for hot-path caching.

**Pros:** Sub-ms reads; reduces MySQL load; enables horizontal scaling of backend instances.
**Cons:** Another service to secure and monitor; cache invalidation complexity.

**Priority:** **High** — lowest-effort, highest-payoff addition.

---

### 2.2 MySQL read replica + ProxySQL / MySQL Router

**What it is:** A read-only copy of the primary MySQL database, plus a proxy that routes read traffic to replicas and write traffic to the primary.

**Add to:** Database layer.

**Solves in this CRM:**
- 196+ routes all hitting a single MySQL primary.
- List endpoints and reports create heavy read load.
- Prisma connection pool can be exhausted under burst traffic.

**Recommended products:**
- **ProxySQL** — flexible query routing, connection pooling, query caching.
- **MySQL Router** — simpler, official, less configurable.

**Integration points:**
- Prisma can target read replicas using a read-replica datasource.
- Route `SELECT` traffic to replicas; mutations stay on primary.
- Use ProxySQL multiplexing to reduce connection count.

**Pros:** Immediate read scaling; no application rewrites for many endpoints.
**Cons:** Replication lag can cause stale list data; Prisma replica setup is non-trivial.

**Priority:** **High** once the CRM has measurable read pressure.

---

### 2.3 Meilisearch — search engine

**What it is:** A fast, typo-tolerant search engine with a simple REST API.

**Add to:** Lead/contact lookup, global search, filtered list views.

**Solves in this CRM:**
- `LIKE '%name%'` queries across encrypted wellness PII and multi-field filters.
- Fuzzy name/company/email/phone search.
- Faceted filters (source, status, sub-brand, assignee).
- Fast counts for pagination headers.

**Recommended product:** [Meilisearch](https://www.meilisearch.com/) (easiest to operate) or Elasticsearch if you need heavy aggregation features.

**Integration points:**
- Index `Contact` / `Lead` records on create/update via Prisma middleware or domain events.
- Replace list/search endpoints with Meilisearch queries; keep detail/edit on MySQL.
- Add tenant-scoped index names (`leads_tenant_<id>` or tenant filter).

**Pros:** Instant, relevant search; reduces expensive Prisma filters.
**Cons:** Dual write path; index synchronization logic to maintain.

**Priority:** **Medium-High** if users complain about search speed or if contact volume grows.

---

### 2.4 BullMQ — background job queue

**What it is:** Redis-backed job queue for Node.js with retries, concurrency control, and dashboards.

**Add to:** Backend workers.

**Solves in this CRM:**
- 50+ cron engines competing and running inline.
- PDF generation, CSV exports, bulk imports currently block HTTP responses.
- WhatsApp/email/SMS sends happen inline.
- No visibility into failed/retrying background work.

**Recommended product:** [BullMQ](https://bullmq.io/) (uses Redis/DragonflyDB).

**Integration points:**
- `backend/queues/` directory with processors per job type.
- Separate worker processes (or PM2 instances) from API processes.
- UI via `bull-board` or `bullmq-pro` for ops visibility.

**High-value jobs to move out of HTTP path:**
- Invoice PDF rendering.
- Bulk contact import/export.
- Callified campaign dial queue.
- Payment reconciliation batch.
- Webhook delivery retries.

**Pros:** Non-blocking API; retries; concurrency limits; observability.
**Cons:** Adds worker processes; requires Redis/DragonflyDB.

**Priority:** **High** — especially if PDFs or bulk ops are timing out.

---

### 2.5 ClickHouse — OLAP / analytics store

**What it is:** Columnar database optimized for analytical queries over large time-series datasets.

**Add to:** Reporting, dashboards, audit logs, event analytics.

**Solves in this CRM:**
- Slow aggregate queries for revenue by sub-brand, lead conversion funnels, call campaign metrics.
- Multi-month audit trails and event logs growing in MySQL.
- Charts aggregating millions of rows.

**Integration points:**
- Keep MySQL as source of truth.
- Stream immutable events (`lead_created`, `status_changed`, `payment_received`, `call_completed`) into ClickHouse.
- Build reporting endpoints that query ClickHouse instead of MySQL.

**Pros:** Very fast aggregations; heavy compression for event data.
**Cons:** Not transactional; mutations are expensive; another query language and client.

**Priority:** **Medium** — add when analytics queries become a bottleneck.

---

### 2.6 MinIO / S3 — object storage

**What it is:** S3-compatible object store for files, exports, and generated assets.

**Add to:** File handling layer.

**Solves in this CRM:**
- Generated PDFs, CSV exports, brochures, WhatsApp media, brand kits stored on local disk.
- App server disk growth (`backend/uploads/`, `agentic-orchcrm/public/generated/`).
- Serving large files through the API process.

**Recommended products:**
- **MinIO** — self-hosted, S3-compatible.
- **AWS S3** / **Cloudflare R2** — managed.

**Integration points:**
- Upload generated files to object storage, return signed or public CDN URLs.
- Add retention/ lifecycle policies for temp exports.
- Move `multer` uploads to stream directly to S3.

**Pros:** Stateless app servers; cheap long-term storage; CDN-friendly.
**Cons:** Adds network latency for first upload; needs credential management.

**Priority:** **High** — already supported by code paths, often just needs env flags enabled.

---

### 2.7 Cloudflare / Varnish — edge caching

**What it is:** Cache layer at the CDN/reverse-proxy level.

**Add to:** Nginx / CDN layer.

**Solves in this CRM:**
- Static JS/CSS bundles served repeatedly.
- Public or semi-static endpoints (landing pages, form embeds, Swagger docs).
- Global latency for static assets.

**Recommended product:** Already using Cloudflare — configure page rules and caching headers.

**Integration points:**
- Long cache headers for hashed Vite build assets.
- Edge cache rules for public form embeds and brochure previews.
- **Do not cache authenticated CRM data** without careful cache-key logic.

**Pros:** Reduced origin load; faster global load times.
**Cons:** Cache invalidation complexity for dynamic content.

**Priority:** **Medium** — quick win for static assets.

---

### 2.8 TanStack Query — frontend data cache

**What it is:** Data-fetching and caching library for React.

**Add to:** React frontend.

**Solves in this CRM:**
- Repeated identical `fetchApi` calls when users navigate between pages.
- Stale UI after mutations.
- No request deduplication across components.

**Integration points:**
- Wrap the existing `frontend/src/utils/api.js` fetch helper with TanStack Query hooks.
- Add cache TTLs and invalidation per entity type (contacts, leads, deals).

**Pros:** Big perceived-performance improvement; less backend load.
**Cons:** Frontend refactor effort; new concepts for the team.

**Priority:** **Medium** — high user-perceived impact.

---

### 2.9 APM / observability tools

**What it is:** Application performance monitoring and distributed tracing.

**Add to:** Observability stack.

**Solves in this CRM:**
- Cannot see which Prisma query, route, or cron is actually slow.
- React error boundaries and backend errors already go to Sentry, but performance traces are limited.

**Recommended products:**
- **Sentry Performance** — already integrated, minimal setup.
- **Datadog / New Relic** — full APM, distributed tracing, database query profiling.
- **Grafana + Prometheus + Loki** — open-source stack for metrics and logs.

**Integration points:**
- Auto-instrument Express with APM agent.
- Add custom spans around Prisma queries and external API calls.
- Frontend Web Vitals and route-level timing.

**Pros:** Data-driven optimization instead of guessing.
**Cons:** Cost (managed) or operational overhead (self-hosted).

**Priority:** **High** — do this before adding more infrastructure.

---

### 2.10 Kafka / NATS — event streaming (later)

**What it is:** Distributed event log / message bus for high-throughput events.

**Add to:** Ingestion paths: webhooks, call events, WhatsApp messages.

**Solves in this CRM:**
- Bursty webhook traffic (Callified, WhatsApp Cloud API) spiking DB write load.
- Need for reliable event replay and downstream consumers.

**Recommended products:**
- **Apache Kafka** — mature, high throughput.
- **NATS / NATS JetStream** — simpler, lighter ops.
- **Redis Streams** — start here if volume is moderate.

**Integration points:**
- Accept webhooks → publish to stream → consumers process at steady rate.
- Multiple consumers: audit logger, ClickHouse writer, notification sender.

**Pros:** Decouples ingestion from processing; handles bursts; replayable.
**Cons:** Operational complexity; usually overkill until volume is high.

**Priority:** **Low-Medium** — start with BullMQ; move to Kafka only if volume demands it.

---

## 3. Suggested sequencing

Do these in order. Each step is reversible and independent unless noted.

| Order | Addition | Depends on | Primary win |
|---|---|---|---|
| 1 | APM / Sentry Performance | None | Know what is actually slow |
| 2 | DragonflyDB / Redis | None | Caching, sessions, rate limits, Socket.io scaling |
| 3 | MinIO / S3 for files/exports | S3 creds | Stateless app servers, disk relief |
| 4 | BullMQ workers | DragonflyDB/Redis | Non-blocking API, retries, bulk ops |
| 5 | Cloudflare cache rules | Static asset build | Faster static delivery, less origin load |
| 6 | MySQL read replica + ProxySQL | DBA / infra time | Read scaling for list/report endpoints |
| 7 | Meilisearch | Search UX pain | Fast, fuzzy lead/contact search |
| 8 | TanStack Query | Frontend refactor time | Perceived speed, reduced duplicate API calls |
| 9 | ClickHouse | Event volume / slow analytics | Fast dashboards and audit analytics |
| 10 | Kafka / NATS | High event ingestion | Buffer bursts, replay events |

---

## 4. What NOT to add yet

- **Do not replace MySQL with ClickHouse or any OLAP store** — MySQL/Prisma remains the transactional source of truth.
- **Do not cache every Prisma query** — start with explicit hot paths and add invalidation.
- **Do not adopt Kafka before BullMQ** — for current volumes, BullMQ on Redis/Dragonfly is simpler and sufficient.
- **Do not edge-cache authenticated data** without careful cache-key design and security review.

---

## 5. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-08-20 | Document DragonflyDB as preferred Redis alternative | Multi-threaded, Redis-compatible, simpler ops for self-hosted CRM deployments. |
| 2026-08-20 | Recommend BullMQ over Temporal for first queue | Lower operational overhead; covers PDF/export/webhook use cases without workflow-state complexity. |
| 2026-08-20 | Keep MySQL primary + read replica model | Prisma ORM, foreign keys, and tenant isolation are already built around MySQL. |
