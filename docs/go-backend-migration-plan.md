# Backend Migration Plan: Node.js/Express/Prisma → Go

> **Scope:** Migrate the `backend/` directory of Globussoft CRM from its current stack (Node.js 24, Express 4, Prisma Client, MySQL 8) to a Go-based backend. The frontend, E2E suite, mobile apps, and the `agentic-orchcrm/` vendored workspace remain unchanged.
> **Current backend version:** `3.9.2` (`backend/package.json`).
> **Current route count:** ~198 Express route modules, 50 cron engines, 264 Prisma models, 736 backend unit tests, 328 E2E specs.
> **Target repository branch:** `golang-2`.

## Executive Summary

A full big-bang rewrite of this backend is not feasible without a multi-quarter freeze on product features. The recommended path is a **strangler-fig, module-by-module migration** that keeps the existing Node.js API contract intact while replacing route modules, services, and cron engines with Go implementations behind a thin routing proxy. The frontend, mobile clients, and E2E tests continue to call the same `/api/*` endpoints during the entire migration.

At the end of the migration the new Go backend will be the sole API server; the Node.js backend will be archived. Until then, both backends are deployed side-by-side, with a gateway or load balancer dispatching requests based on migrated path prefixes.

## 1. Goals and Non-Goals

### Goals
- Port the entire production API surface to Go while preserving the `/api/*` contract.
- Preserve the existing MySQL 8 schema and Prisma migrations as the source of truth until the schema is stabilized in Go.
- Keep all E2E Playwright specs passing with no test-logic changes (they are the migration contract).
- Replace Express middleware and route modules with idiomatic Go equivalents (Gin or Echo + chi-style routing).
- Replace cron engines with Go cron/scheduler jobs.
- Replace service wrappers (SMS, email, WhatsApp, payments, AI, PDF, etc.) with Go SDKs or direct HTTP clients.
- Preserve or improve security posture: JWT/RBAC, tenant isolation, PII encryption, CSP/security headers, rate limiting, audit logging, request/response scrubbing.
- Maintain the existing CI/CD gate structure (build, api_tests, unit_tests, lint, migration_check, deploy, deploy_staging) and the same deployment topology (Docker / PM2 / Nginx).

### Non-Goals
- Re-architecting the data model in the first phase. The schema stays in `backend/prisma/schema.prisma` and is read by the Go service via a SQL mapper or Prisma Client Go until a later phase.
- Rewriting the frontend, mobile apps, or `agentic-orchcrm/`.
- Changing the live demo URL (`https://crm.globusdemos.com`) or the customer-facing API paths.
- Adding new product features during the migration (features land on the Node backend first; they move to Go with their module).
- Removing MySQL for PostgreSQL or another database.

## 2. Recommended Migration Strategy: Strangler Fig with Path-Based Routing

### Approach
Run the **new Go API server** and the **existing Node.js API server** side-by-side. Put a routing gateway (Nginx or a small Go reverse proxy) in front of both. The gateway routes requests as follows:

- If the path belongs to a **migrated module**, forward to the Go backend.
- Otherwise, forward to the legacy Node.js backend.
- Both backends share the same MySQL 8 database, JWT secrets, Redis/cache, and S3/file storage.
- Both backends validate JWT and enforce RBAC independently; only the Go backend enforces the Go port’s additional middleware.
- Socket.IO / real-time events continue to be served by the Node.js backend until the messaging layer is migrated, at which point a Go WebSocket hub takes over.

### Why this strategy
- **Low risk:** Each module can be migrated, tested, and released independently.
- **Feature velocity preserved:** Product teams can still ship on Node.js for unmigrated modules.
- **E2E contract unchanged:** The Playwright specs validate the API contract, not the implementation language. As long as Go endpoints return the same JSON, tests pass.
- **Rollback is trivial:** If a Go module fails, the gateway route is reverted to Node.js in seconds.
- **Avoids a “stop the world” cutover:** The final cutover is just flipping the last gateway routes and decommissioning Node.js.

### Alternative: Big-Bang Rewrite
Port every route, service, and cron engine in one large branch, then replace the backend entirely. This is **not recommended** because:
- The backend has ~198 route modules and 50 cron engines; a full rewrite is a 6–12 month feature freeze.
- The Node.js backend receives continuous PRs (e.g., PR #1254 merged during this session); keeping a long-lived branch in sync is impractical.
- No incremental rollback if a single port fails in production.
- High blast radius: one subtle behavioral difference in the JSON envelope or middleware ordering can break the frontend or mobile apps.

### Alternative: Service-Layer Only Migration
Keep Express as the API gateway but rewrite business logic in Go microservices. This adds operational complexity (service mesh, RPC, serialization overhead) and does not reduce the Node.js surface area quickly. It is viable for heavy compute services (PDF generation, AI image generation) as a later optimization, but it is not the primary migration path.

## 3. Target Go Technology Stack

| Concern | Node dependency | Go replacement | Rationale |
|---|---|---|---|
| Web framework | Express 4 | **Gin** (`gin-gonic/gin`) or **Echo** (`labstack/echo`) | Both have mature middleware ecosystems, JSON binding, and route grouping. Gin is more performant; Echo has cleaner middleware ordering. Recommend Echo because its middleware chain is closest to Express. |
| Routing / sub-routers | Express Router | Echo groups or `go-chi/chi` | Chi is excellent for path-based routing and literal-before-parametric ordering. |
| ORM / SQL mapper | Prisma Client + `mysql2` | **GORM** (`gorm.io/gorm`) with MySQL driver, or **sqlx** + **squirrel** | GORM is closest to an ORM and supports hooks, soft deletes, scopes, and migrations. sqlx is lower-level and faster but requires more boilerplate. Recommend GORM for the first phase to preserve the relational model and soft-delete behavior. |
| Schema source of truth | Prisma schema | Prisma schema remains canonical until a dedicated migration phase; use Prisma Client Go or generate GORM models from schema comments. | Do not re-author 264 models by hand. |
| Auth / JWT | `jsonwebtoken` | `golang-jwt/jwt/v5` | Mature, widely used, supports custom claims. |
| Password hashing | `bcrypt` / `bcryptjs` | `golang.org/x/crypto/bcrypt` | Standard library extension. |
| 2FA TOTP | `speakeasy` | `pquerna/otp` | Compatible with Google Authenticator / Authy. |
| Rate limiting | `express-rate-limit` | `ulule/limiter` or `didip/tollbooth` with Redis store | Supports sliding windows and per-key limits. |
| CORS | `cors` | `rs/cors` | Widely used. |
| Security headers | `helmet` | Custom Echo/Gin middleware or `unrolled/secure` | Replicate `Content-Security-Policy-Report-Only`, HSTS, etc. |
| Validation | `express-validator` | `go-playground/validator` + custom Gin/Echo validators | Tag-based validation matches the existing declarative style. |
| WebSocket / realtime | `socket.io` | `gorilla/websocket` with a custom room/broadcast hub, or `gobwas/ws` | Socket.IO clients must be updated; recommend a thin compatibility shim or migrate the client to raw WebSocket. |
| Cron scheduler | `node-cron` | `robfig/cron/v3` or `go-co-op/gocron` | `go-co-op/gocron` supports persistent job stores and distributed locking. |
| JSON-string column sanitization | `sanitize-html`, `sanitizeJson` | `microcosm-cc/bluemonday` for HTML, custom JSON walker for strings | Need to preserve the existing shape-preserving sanitization contract. |
| PII field encryption | `crypto` (AES-256-GCM) | `crypto/aes` + custom GORM hook | Must reproduce the `ENC:v1:<iv>:<tag>:<ct>` format and transparent encrypt/decrypt. |
| Audit hash chain | `crypto` SHA-256 | `crypto/sha256` + HMAC | Same algorithm. |
| SMS providers | `twilio`, custom MSG91/Fast2SMS HTTPS | `twilio/twilio-go`, `net/http` for MSG91/Fast2SMS | Direct HTTP clients for MSG91/Fast2SMS are trivial. |
| Email | `nodemailer`, `mailgun.js`, SendGrid REST | `net/smtp`, `sendgrid/sendgrid-go`, `mailgun/mailgun-go` | Keep existing provider abstraction. |
| WhatsApp | `whatsapp-web.js` (Puppeteer), Meta Cloud API | `tulir/whatsmeow` for WhatsApp Web; direct HTTP for Meta Cloud API | WhatsApp Web via Puppeteer is the hardest to port; prioritize Cloud API where possible. |
| Payments | `stripe`, `razorpay` | `stripe/stripe-go`, custom Razorpay client | Razorpay has no official Go SDK; use direct HTTP with request signing. |
| AI / LLM | `@google/generative-ai`, OpenAI fetch | `google/generative-ai-go`, `sashabaranov/go-openai` | Official SDKs available. |
| PDF generation | `pdfkit`, `pdf-lib`, `puppeteer` | `go-pdf/fpdf`, `unidoc/unioffice`, or `chromedp` for HTML-to-PDF | `go-pdf/fpdf` is closest to `pdfkit`. |
| Excel/CSV | `xlsx` | `qax-os/excelize` or `tealeg/xlsx` | `excelize` is actively maintained. |
| Image processing | `sharp`, `jimp`, `canvas` | `disintegration/imaging`, `fogleman/gg` | `imaging` covers resize/crop/encode; `gg` for simple drawing. |
| OCR | `tesseract.js` | `otiai10/gosseract` (Tesseract C bindings) | Requires Tesseract in the Docker image. |
| QR codes | `qrcode` | `skip2/go-qrcode` | Standard. |
| IMAP | `imap` | `emersion/go-imap` | Mature. |
| Web Push | `web-push` | `SherClockholmes/webpush-go` | Compatible with VAPID. |
| S3 | AWS SDK v3 | `aws-sdk-go-v2/service/s3` | Official SDK. |
| Google APIs / OAuth | `googleapis` | Official Google Go clients (`google.golang.org/api/...`) | Standard. |
| HTTP client | `axios`, `fetch` | `net/http` + `go-resty/resty` for retries | Native `net/http` is sufficient; `resty` for convenience. |
| Markdown | `marked` | `yuin/goldmark` | CommonMark-compliant. |
| YAML | `yamljs` | `gopkg.in/yaml.v3` | Standard. |
| Redis / cache | (used by some rate limiters / Socket.IO) | `redis/go-redis` | If Redis is already in the stack, formalize it. |

## 4. Migration Phases

### Phase 0: Foundation (Weeks 1–4)
**Goal:** Bootstrap the Go project, establish the shared infrastructure, and migrate a small, non-critical module end-to-end.

#### Deliverables
- Create a new top-level directory `golang/` (or `backend-go/` — name TBD) with:
  - `cmd/api/` — main API server.
  - `cmd/worker/` — optional cron worker binary (or keep cron jobs in the API server).
  - `internal/` — domain packages.
  - `pkg/shared/` — cross-cutting concerns (JWT, tenant context, scrub, audit, config, DB).
  - `go.mod`, `go.sum`, `Dockerfile`, `Makefile`.
- Define the shared request context:
  - `UserContext` (userId, tenantId, role, wellnessRole, subBrandAccess, permissions cache key).
  - `TenantContext` (vertical, locale, currency, timezone, encryption key).
- Implement middleware chain equivalent to the Node.js global stack:
  - CORS, rate limiter, request ID logger, security headers, body-size limiter, JSON parser, `originCheck`, `sanitizeBody`, `stripDangerous`, auth middleware, subscription check, `scrubResponse`, audit writer.
- Implement JWT auth (`golang-jwt`), RBAC resolver with 30-second in-memory cache, wellness role gate, step-up token verification.
- Implement tenant-scoping helpers and GORM scopes (`TenantScope`, `NotDeleted`).
- Implement PII field encryption hook and credential masking helper producing the same `ENC:v1:` ciphertext and same `configured`/`last4` masked shape.
- Implement `writeAudit` with the same hash-chain format (`GENESIS_<tenantId>` sentinel, SHA-256 canonical payload).
- Implement `{error, code}` envelope helpers and the canonical error code constants.
- Implement `sanitizeJson` and `sanitizeText` equivalents with the same shape-preserving semantics.
- Implement global `scrubResponse` middleware that strips `portalPasswordHash` and `passwordHash` recursively.
- Implement `stripDangerous` middleware removing `id`, `tenantId`, `userId`, `createdAt`, `updatedAt`, `isAdmin`, `passwordHash`, `portalPasswordHash` from request bodies.
- Set up the CI pipeline:
  - Add `golangci-lint` job.
  - Add Go unit tests (`go test`) job.
  - Add a Go build job.
  - Extend `api_tests` to run against the Go backend for migrated routes.
- Set up Docker Compose service for the Go backend and update Nginx routing.
- Create a **routing registry** (e.g., `config/routes.yaml`) listing migrated routes so the gateway can route correctly.

#### First module to migrate
Choose a low-risk, read-heavy module with few external dependencies, e.g.:
- `GET /api/health` (already open path)
- `GET /api/audit` (read-only, requires auth + RBAC, good middleware test)
- `GET /api/audit-viewer/summary` (similar)
- `GET /api/settings/*` (read side, small surface)

Migrating these first proves JWT, RBAC, tenant scoping, audit, and the gateway all work.

#### Verification
- Existing E2E specs for the chosen module pass unchanged when routed to Go.
- All other E2E specs still pass via Node.js.
- Deploy to staging and smoke-test the migrated routes.

### Phase 1: Core Generic CRM Modules (Weeks 5–12)
**Goal:** Migrate the highest-traffic, most stable generic CRM modules that the frontend dashboard depends on.

#### Modules (priority order)
1. **Authentication & User Management** (`/api/auth`, `/api/me`, `/api/users`, `/api/roles`, `/api/permissions`)
   - Foundation for all other endpoints. Must preserve JWT shape, RBAC role/permission matrix, permission cache clearing, and step-up tokens.
2. **Contacts** (`/api/contacts`)
   - Standard CRUD, import/export, tenant-scoped lists, soft deletes.
3. **Leads / Marketplace Leads** (`/api/leads`, `/api/marketplace-leads`)
   - Includes lead scoring, SLA engines, and source attribution. Complex but high value.
4. **Deals** (`/api/deals`)
   - Pipeline, stages, deal insights, forecast snapshots.
5. **Tasks** (`/api/tasks`)
   - Simple CRUD + assignments.
6. **Projects / Contracts / Estimates / Invoices / Billing / Expenses / Payments** (`/api/projects`, `/api/contracts`, `/api/estimates`, `/api/invoices`, `/api/billing`, `/api/expenses`, `/api/payments`)
   - Financial modules have strong consistency requirements; migrate together or in close sequence. Stripe and Razorpay webhooks must preserve signature verification and tenant resolution.
7. **Reports / Dashboard** (`/api/reports`, `/api/dashboard`, `/api/forecast-snapshot`)
   - Read-heavy aggregations; good candidate for Go performance gains.
8. **Marketing / Email / SMS** (`/api/marketing`, `/api/email`, `/api/sms`)
   - Heavily dependent on external providers; migrate provider service wrappers first.

#### Phase 1 deliverables
- All generic CRM endpoints in the list above are served by Go.
- Node.js backend still serves wellness, travel, admin, and miscellaneous routes.
- Cron engines associated with generic modules (e.g., `leadSlaEngine`, `dealInsightsEngine`, `forecastSnapshotEngine`, `recurringInvoiceEngine`) run in Go.
- E2E specs for these modules pass against Go.

### Phase 2: Communications & Marketing (Weeks 13–20)
**Goal:** Migrate the high-external-dependency communication modules.

#### Modules
- **Email** (`/api/email`, `/api/email-templates`, `/api/email_inbound`, `/api/email-scheduling`)
- **SMS** (`/api/sms`)
- **Push** (`/api/push`)
- **Live chat** (`/api/live-chat`)
- **Communications orchestration** (`/api/communications`)
- **Marketing campaigns / sequences** (`/api/marketing/campaigns`, `/api/marketing/sequences`)
- **Landing pages / landing sites** (`/api/landing-pages`, `/api/landing-sites`, `/api/pages`)
- **Chatbots** (`/api/chatbots`)
- **Signatures / Documents / Surveys** (`/api/signatures`, `/api/documents`, `/api/surveys`)

#### Special considerations
- **Sequence engine** (`cron/sequenceEngine.js`) is a high-frequency (`* * * * *`) engine with complex state machines. Port carefully with idempotency and audit logging.
- **Appointment reminders engine** (`cron/appointmentRemindersEngine.js`) ties to wellness; migrate after or with wellness.
- **Marketing flyer generation** (AI + PDF) should be treated as a heavy worker job; consider running it in a separate Go worker process or queue.

### Phase 3: Wellness Vertical (Weeks 21–30)
**Goal:** Migrate the wellness clinic/salon vertical, including PHI, PII encryption, and wellness-specific RBAC.

#### Modules
- `/api/wellness/*` (patients, visits, prescriptions, consents, invoices, appointments, POS, attendance, leave, loyalty, gift cards, QR, wallet)
- `/api/portal/*` (patient portal)
- Wellness dashboard and reports (`/api/wellness/reports/*`, `/api/wellness/dashboard`)
- Wellness-specific cron engines (`appointmentRemindersEngine`, `wellnessVisitInvoiceStateEngine`, `loyaltyExpiryEngine`, etc.)

#### Special considerations
- **PHI read gate (`phiReadGate`)** must be preserved exactly.
- **Wellness role system** (`wellnessRole.js`) maps to `WellnessRoleType.canTakeVisits`, `deny` lists, and `anyOfPermissions`.
- **PII encryption** for `Patient.allergies`, `Patient.notes`, `Visit.notes`, `Visit.vitals`, `Prescription.drugs`, `Prescription.instructions`, `ConsentForm.signatureSvg` must be byte-compatible with the Node.js implementation so existing ciphertexts decrypt correctly.
- **CSV exports** must keep the same UTF-8 BOM, CRLF line endings, and column headers.
- **Consent PDF generation** must produce equivalent PDFs.

### Phase 4: Travel Vertical (Weeks 31–40)
**Goal:** Migrate the travel-agency vertical and its brochure engine integration.

#### Modules
- `/api/travel/*` (itineraries, trips, visa, flights, hotels, cost masters, invoices, commissions, payments, public share/payment pages)
- `/api/v1/flight-plugin`, `/api/v1/external`, `/api/v1/voyagr` (third-party plugin surface)
- Travel-specific cron engines (`travelJourneyReminders`, `quoteExpirySweep`, `costMasterSync`, etc.)
- Brochure engine integration (`/api/brochure-engine/*`) calling the `agentic-orchcrm/` workspace

#### Special considerations
- Travel has many public/unauthenticated endpoints (share tokens, payment verification). Auth bypass logic must be replicated exactly.
- Razorpay payment capture for travel itineraries is security-critical; preserve webhook tenant resolution (`notes.tenantId`).
- The flight plugin API has a separate versioning convention (`/api/v1/...`) — maintain it.

### Phase 5: Admin, Platform, and Final Cutover (Weeks 41–48)
**Goal:** Migrate remaining admin/platform routes, finalize the schema migration, and decommission Node.js.

#### Modules
- `/api/admin/*`, `/api/super-admin/*`
- `/api/security/*`, `/api/audit/*`, `/api/audit-viewer/*`
- `/api/developer/*`, `/api/settings/*`, `/api/integrations/*`, `/api/csp/*`, `/api/scim/*`
- `/api/calendar_google/*`, `/api/calendar_outlook/*`, `/api/sso/*`
- `/api/zapier/*`, `/api/webhooks/*` (if not already migrated)
- File upload endpoints (`/uploads`, S3 presigned URLs)
- Open/public pages (`/p/*`, `/embed`)
- WebSocket / Socket.IO hub (final migration piece)

#### Final cutover steps
1. Flip the default gateway route to Go; Node.js becomes the fallback for any unmatched paths.
2. Run a full E2E suite against Go-only backend.
3. Run load tests comparing Node.js and Go latencies for the top 20 endpoints.
4. Remove the Node.js backend process from PM2/Docker Compose.
5. Update CI to remove Node-specific backend jobs and make Go jobs the primary gates.
6. Update documentation, README, and onboarding runbooks.
7. Archive the old `backend/` directory or move it to `archive/backend-node/` after a stabilization period.

## 5. Detailed Porting Guide by Layer

### 5.1 Web Server and Routing

#### Express → Echo/Gin mapping
- Express `app.use(mw)` → Echo `e.Use(mw)` or Gin `r.Use(mw)`.
- Express `router.param('id', ...)` → Chi `r.With(parseId)` or Echo group middleware.
- Express `router.get('/:id', ...)` → Echo `r.GET('/:id', ...)`, Chi `r.Get('/{id}', ...)`.
- Express route ordering (literal before parametric) → Chi handles this correctly; Echo/Gin routes are matched in registration order, so preserve the same registration order as `server.js`.
- Express `res.json({ ... })` → Echo `c.JSON(http.StatusOK, obj)` with a wrapper that applies `scrubResponse` before serialization.
- Express `next('route')` / `next()` → Go middleware returns `c.Next()` or early returns.

#### Open paths and auth guard
Replicate the open-path list from `server.js:947-977` exactly. Any mismatch (e.g., a webhook path requiring auth) will break provider integrations.

#### Middleware ordering
The Node.js middleware order in `server.js` is load-bearing. Replicate it in Go:
1. dotenv/config load
2. CORS
3. Request ID / logger
4. WebSocket attach (if migrated)
5. Raw-body webhook paths (WhatsApp, Stripe, Razorpay) before JSON parsing
6. Body parsers with size limits
7. Nonce / CSP / security headers
8. Cookie parser
9. `originCheck`
10. `sanitizeBody`
11. `stripTenantOverride`
12. Rate limiters
13. Login-specific rate limiters
14. Content-type 415 guard
15. Global auth guard (open paths bypass)
16. `stripDangerous`
17. `scrubResponse` wrapper
18. Route mounts
19. `/api/*` JSON 404
20. Global error handler

### 5.2 Database Access

#### Option A: Prisma Client Go (recommended for first phase)
- Use the existing `schema.prisma` with `generator client { provider = "prisma-client-go" }`.
- Generates type-safe Go structs and query builder.
- Pros: minimal model drift, schema remains single source of truth, migrations remain Prisma migrations.
- Cons: generated code is heavy, some advanced queries are awkward, JSON-string columns need manual handling.

#### Option B: GORM + hand-written models
- Hand-write GORM models from the Prisma schema.
- Pros: idiomatic Go, better control, hooks for PII encryption and soft deletes.
- Cons: high manual effort for 264 models; high risk of model drift.

#### Recommendation
Start with **Prisma Client Go** for Phase 0 and Phase 1. Once the migration is committed and the schema is stable, run a model-generation phase to produce **GORM models** from the schema (using a custom generator or a one-time script) and gradually switch to GORM for performance-critical paths. Do not attempt to hand-write 264 models at the start.

#### Soft deletes
The Node.js backend uses `deletedAt DateTime?` on most tenant-scoped models. GORM can use `gorm.DeletedAt` and `gorm.Model`, or a custom `DeletedAt` field. Add a default scope `NotDeleted` and an `Unscoped` helper for admin endpoints that need deleted rows.

#### Tenant scoping
Add a GORM scope or Prisma Client Go middleware that injects `tenantId = ctx.TenantID` into every `WHERE` clause for tenant-scoped models. Replicate the ESLint-like enforcement with a static analyzer or runtime check in the repository.

#### JSON-string columns
Prisma schema has 291 `String? @db.Text` columns storing JSON. In Go, these are strings at the ORM layer. Use `json.RawMessage` or `string` with helper functions (`sanitizeJson`, `sanitizeJsonForStringColumn`) before persistence. For typed access, define structs per column and marshal/unmarshal explicitly.

#### PII encryption
Implement a GORM `BeforeCreate`/`BeforeUpdate`/`AfterFind` hook (or Prisma Client Go middleware) that:
- Detects the encrypted-field list per model.
- On write: AES-256-GCM encrypts plaintext, prefixing `ENC:v1:<iv>:<tag>:<ct>`.
- On read: decrypts if the value starts with the prefix; otherwise returns as-is (legacy plaintext).
- Uses `WELLNESS_FIELD_KEY` as the key material.
- Preserves exact ciphertext compatibility so existing rows are readable.

#### Credential masking
SMS/WhatsApp/Razorpay/Stripe keys stored in the DB are encrypted the same way. GET config endpoints must return `{ configured: true, last4: "..." }` and never plaintext.

### 5.3 Authentication and Authorization

#### JWT middleware
- Read `Authorization: Bearer <token>` or `auth_token` cookie.
- Validate signature, expiration, issuer, and audience.
- Reject portal tokens (payload has `patientId` or lacks `userId`).
- Backfill missing `tenantId` to `1`.
- Check `awaiting2FA` claim and enforce 2FA if needed.
- Check revocation via `revokedToken` table by `jti`.
- Set `UserContext` on the request context.
- Return `401` with `WWW-Authenticate: Bearer` and `{error, code}` envelope.

#### RBAC resolver
- Load `Role` and `RolePermission` rows for the user/tenant.
- Short-circuit `OWNER`.
- Deny `CUSTOMER` unless the permission is in a `CUSTOMER_SAFE_PERMISSIONS` allowlist.
- Cache effective permission set in memory for 30 seconds keyed by `tenantId::userId`.
- Self-heal legacy `ADMIN` users by creating an `ADMIN` role if none exists.
- Provide `RequirePermission(module, action)` and `RequireAnyPermission(...)` middleware.
- Return canonical `RBAC_DENIED` message: "You don't have permission to perform this action. Contact your administrator."

#### Wellness role gate
- Enforce `tenant.vertical == "wellness"`.
- Resolve `admin`, `manager`, `clinical` tokens against `WellnessRoleType.canTakeVisits`.
- Support `deny` lists and `anyOfPermissions` backdoor.

#### Step-up tokens
- Implement `signStepUpToken` and `requireStepUp` middleware.
- Short-lived JWT with a single action claim.
- Accept header `x-step-up-token` or `req.body.stepUpToken`.

### 5.4 Validation and Input Sanitization

Replace `express-validator` with `go-playground/validator` struct tags plus custom validators for:
- `validateNumericId` (`:id` must be parseable integer)
- Indian phone numbers (`normalizePhone`)
- Email formats
- Sender ID length (6 alphanumeric for MSG91)
- Date ranges
- GST state codes

Implement a `sanitizeBody` middleware that strips HTML (using `bluemonday`) from string fields in the request body, preserving the shape.

Implement `stripDangerous` middleware that recursively deletes the forbidden keys from `map[string]any` or JSON before binding to structs.

### 5.5 Services and External Providers

For each service wrapper, create a Go package under `internal/services/` or `internal/providers/` with:
- A config struct read from environment variables.
- An interface for testability.
- A real implementation using the Go SDK or `net/http`.
- A mock implementation for unit tests.
- The same error-code mapping as the Node.js backend (e.g., `SMS_PROVIDER_ERROR`, `EMAIL_SEND_FAILED`, `PAYMENT_GATEWAY_ERROR`).

#### Provider migration checklist
- **SMS:** `smsProvider` → `internal/providers/sms`. Support MSG91 Flow, Twilio, Fast2SMS. Add request timeouts (3–10 seconds) to avoid the CI timeout issue seen in `sms.test.js`. Preserve provider response parsing and the multi-recipient envelope shape.
- **Email:** `notificationService` / `emailService` → `internal/providers/email`. SendGrid REST, SMTP, Mailgun. Preserve multi-recipient envelope (`totalSent`, `totalFailed`, `results`, `failures`).
- **WhatsApp:** `whatsappProvider` → `internal/providers/whatsapp`. Meta Cloud API direct HTTP. `whatsappWebClient` (Puppeteer) → evaluate `tulir/whatsmeow`; if the QR-scan workflow is heavily used, this is a long pole and may require keeping a small Node.js WhatsApp bridge service running longer.
- **Payments:** Stripe SDK + Razorpay direct HTTP. Preserve webhook signature verification and tenant resolution from `notes.tenantId` or `metadata.tenantId`. Preserve subscription billing cycle behavior (monthly/annual) as fixed in PR #1252.
- **AI:** `llmRouter` → `internal/providers/llm`. Task-based routing across Gemini, OpenAI, Anthropic, Perplexity, Groq. Cost tracking and per-tenant budget caps.
- **PDF/Excel:** `pdfRenderer` → `internal/services/pdf`. `xlsx` → `internal/services/spreadsheet`. Provide equivalent output formats; tests that assert BOM/CSV structure must pass.
- **S3:** `s3Service` → `internal/providers/s3`. Presign URLs with the same expiry.
- **Push:** `pushService` → `internal/providers/push`. VAPID keys and payload format.
- **IMAP:** `gmailMessage` / `imap` → `internal/providers/imap`. Use `emersion/go-imap`.
- **Calendar/SSO:** Use official Google/Microsoft Go SDKs.

### 5.6 Cron Engines

Create a central cron registry in Go (`internal/cron/registry.go`) that mirrors `backend/lib/cronRegistry.js`:
- Register `name`, `defaultSchedule`, `defaultEnabled`, `tickFn`, `cronOptions`.
- Persist `CronConfig` and `CronExecutionLog` rows for every tick.
- Support `DISABLE_CRONS=1` environment variable.
- Provide a manual trigger endpoint (used by some E2E specs) to execute a cron job on demand.
- Use `go-co-op/gocron` or `robfig/cron/v3` for scheduling.
- Ensure idempotency: each engine must check "already processed" state before acting.
- Ensure audit logging: every mutation writes an `AuditLog` row.

Port engines in the same order as the route modules (generic → communications → wellness → travel). High-frequency engines (`sequenceEngine`, `campaignEngine`, `leadSlaEngine`, `slaBreachEngine`) should be tested with race and idempotency tests.

### 5.7 Real-Time / WebSocket

The Node.js backend uses Socket.IO. Migrating it to Go is a client-facing change because the frontend currently uses `socket.io-client`. Options:
1. **Keep Socket.IO in Node.js until the end**, then migrate frontend to raw WebSocket and replace with a Go `gorilla/websocket` hub.
2. **Run a Go Socket.IO server** using `googollee/go-socket.io` (less mature, API differences).
3. **Bridge**: Node.js Socket.IO server continues; Go emits events to a Redis Pub/Sub that Node.js forwards.

Recommendation: Option 1 (defer to Phase 5). Real-time is not in the critical path for most API operations.

### 5.8 Request/Response Contracts

Every Go handler must return the same JSON shape as the Node.js backend. Critical envelopes to preserve:
- `{ error, code }` for failures.
- `{ success, ... }` for operations like `POST /api/sms/send`.
- Multi-recipient email/SMS: `{ success, totalSent, totalFailed, results, failures, ... }`.
- Paginated lists: `{ rows, total, page, pageSize, ... }` (verify exact field names from current frontend usage).
- Wellness reports: `{ totals: { visits, revenue, ... }, rows: [...] }`.
- CSV responses: `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="..."`, leading UTF-8 BOM (`\uFEFF`), CRLF line endings.
- `scrubResponse` must remove `passwordHash`, `portalPasswordHash`, `isAdmin` recursively before JSON serialization.

Add a **contract compatibility test** that snapshots the JSON response of every migrated endpoint against the Node.js implementation.

## 6. Testing Strategy During Migration

### Go unit tests
- Use the standard `testing` package plus `testify` for assertions and `gomock` or `mockery` for interfaces.
- Mock every external provider and the DB layer.
- Mirror the Node.js test directory structure: `golang/internal/routes/...`, `golang/internal/services/...`, `golang/internal/cron/...`.
- Reproduce the Prisma surface guard: wrap the DB client so unmocked queries fail loudly in tests.
- Target the same test count and coverage as the Node backend over time.

### Integration tests
- Reuse the existing Playwright E2E specs as the migration contract. Do not change E2E test logic; run them against the Go backend for migrated routes.
- For each migrated module, add a CI job that runs only the relevant E2E specs against the Go backend.
- Maintain the Node.js backend E2E gate for unmigrated routes.

### Contract snapshot tests
- Capture request/response pairs from the Node.js backend for every migrated endpoint under realistic test data.
- Run the same requests against the Go backend and compare JSON structure and selected field values.
- This is the fastest way to catch envelope regressions.

### Load tests
- After Phase 1, run load tests (k6 or `go-wrk`) on the top 20 endpoints to quantify the Go performance benefit and catch concurrency issues.

### Migration gate
- Add a CI check that fails if a migrated route is still served by Node.js or if an unmigrated route is accidentally served by Go.
- Maintain the routing registry as the source of truth.

## 7. CI/CD and DevOps

### New CI jobs for Go
1. **go_build** — `go build ./...`, `go vet ./...`, `go mod tidy` check.
2. **go_lint** — `golangci-lint` with a curated config (enable `errcheck`, `gosec`, `staticcheck`, `gosimple`, `ineffassign`, `vet`, `bodyclose`, `noctx`, `rowserrcheck`, `sqlclosecheck`, `govet`).
3. **go_unit_tests** — `go test ./...` with race detector.
4. **go_api_tests** — spin up MySQL 8, seed generic/wellness/travel tenants, run the migrated Playwright API specs against the Go backend on `:5000`.
5. **go_migration_check** — continue using Prisma schema safety check until the schema is migrated; later switch to `golang-migrate` safety checks.

### Hybrid CI during migration
- Keep the Node.js backend jobs for unmigrated routes.
- Add a new **gateway** job that boots both backends and runs the full E2E suite with the routing registry.
- Use a **feature flag / route registry** in CI so the same workflow works for partial and full migrations.

### Docker and deployment
- Add a `Dockerfile` for the Go API server (multi-stage build using `golang:1.24-alpine` or `1.24` for CGO dependencies like Tesseract).
- Update `docker-compose.yml` to add the Go service and keep the Node.js service until cutover.
- Update Nginx config to route to Go based on the registry.
- Update PM2 ecosystem file to manage the Go binary (or use systemd).
- Keep the same environment variables; the Go binary reads them via `envconfig` or Viper.

### Secrets and env vars
- The Go backend must read the same 73+ environment variables documented in `backend/.env.example`.
- Add validation at startup: refuse to boot if `JWT_SECRET`, `DATABASE_URL`, or `PORTAL_JWT_SECRET` are missing (same as Node.js).
- Keep `.env` files gitignored.

## 8. Security and Compliance

### Must-preserve controls
- **JWT payload key is `userId`, never `id`.** Enforce via linter or code review.
- **Tenant isolation:** every list query must include `tenantId`. Add a Go middleware or GORM scope that panics/fails tests if missing.
- **Dangerous field stripping:** `stripDangerous` runs before route handlers.
- **Origin check:** `originCheck` must run before CSRF-sensitive mutations.
- **Rate limiting:** preserve per-user, per-tenant, per-auth, and per-webhook limits; use Redis in production for distributed state.
- **Security headers:** reproduce Helmet behavior, including Report-Only CSP with nonces.
- **Input sanitization:** HTML sanitization for string columns and JSON-string columns.
- **Response scrubbing:** `scrubResponse` recursively strips `passwordHash` and `portalPasswordHash`.
- **Audit logging:** `writeAudit` with SHA-256 hash chain for every PHI read, provider config rotation, and privileged mutation.
- **npm audit equivalent:** add Go vulnerability scanning (`govulncheck`, Snyk, or Dependabot) to the CI gate.
- **Secret scanning:** keep gitleaks running on Go files.

### New Go-specific concerns
- **SQL injection:** use parameterized queries (GORM/Prisma Client Go) and ban raw `fmt.Sprintf` in SQL.
- **Race conditions:** run tests with `-race`; cron engines and permission caches are high-risk areas.
- **Resource leaks:** ensure DB connections, HTTP clients, goroutines, and file handles are closed.
- **CGO dependencies:** if using Tesseract (`gosseract`) or image libraries, ensure the Docker image has the native libraries.
- **Dependency pinning:** use `go.mod`/`go.sum`; treat dependency updates with the same allowlist discipline as the current `backend/.audit-allowlist.json`.

## 9. Data Migration and Schema Continuity

### Phase 0–4: Prisma schema remains canonical
- Continue running `npx prisma migrate` and `prisma db push` from the existing `backend/prisma` directory.
- The Go service reads the same MySQL database.
- No data migration needed because both backends use the same schema.

### Phase 5: Schema migration to Go-native tooling
- After the Go backend is fully operational, evaluate whether to keep Prisma as the migration tool or switch to `golang-migrate`.
- If switching:
  - Translate existing Prisma migrations to `golang-migrate` SQL files.
  - Freeze the Prisma schema; generate Go models from it.
  - Update the `migration_check` CI gate to validate SQL migration safety.
  - Keep Prisma only as a documentation artifact or remove it after a stabilization period.

## 10. Risk Register and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Subtle JSON envelope differences break frontend/mobile | High | High | Contract snapshot tests for every migrated endpoint; run E2E unchanged; keep Node.js fallback. |
| Middleware ordering differences cause auth/CSRF/rate-limit bypass | High | Medium | Replicate middleware order exactly; add integration tests for security-sensitive paths. |
| PII encryption incompatibility locks out existing wellness data | High | Low | Implement byte-compatible AES-256-GCM hook; decrypt existing rows in staging; add round-trip tests. |
| WhatsApp Web (Puppeteer) cannot be ported to Go quickly | Medium | High | Keep Node.js WhatsApp bridge service running until a Go solution is validated. |
| Razorpay webhook signature verification mismatch | High | Medium | Port verification algorithm exactly; test with real webhook payloads in staging. |
| Cron engine idempotency bugs cause duplicate sends/charges | High | Medium | Add idempotency keys and execution logs; run cron engines with `DISABLE_CRONS=1` in E2E except manual triggers. |
| Performance gains not materializing due to DB being the bottleneck | Medium | Low | Measure load tests after Phase 1; optimize queries before blaming the runtime. |
| Talent/learning curve: team not familiar with Go | Medium | High | Phase 0 includes training and coding standards; pair Go specialists with domain owners; enforce `golangci-lint`. |
| Long-running branch diverges from `main` | High | High | Merge small, shippable modules incrementally; never let the Go branch lag more than one sprint. |

## 11. Success Metrics and Cutover Criteria

- **All E2E specs pass** against the Go-only backend for at least one full week in staging.
- **Zero P1/P2 regressions** in production for one month after each phase flip.
- **Go unit test coverage** reaches 70% or higher for migrated modules.
- **P95 latency** for the top 20 endpoints is equal or better than Node.js under load test.
- **CI gates** for the Go backend are green and stable.
- **Node.js backend process removed** from PM2 and Docker Compose; only the Go binary serves API traffic.

## 12. Estimated Timeline and Resources

| Phase | Duration | Modules | Approx. Files |
|---|---|---|---|
| Phase 0 | 4 weeks | Foundation + 1–2 small read-only modules | 50–80 Go files |
| Phase 1 | 8 weeks | Core generic CRM | 150–200 Go files |
| Phase 2 | 8 weeks | Communications & marketing | 120–160 Go files |
| Phase 3 | 10 weeks | Wellness vertical | 180–240 Go files |
| Phase 4 | 10 weeks | Travel vertical | 180–240 Go files |
| Phase 5 | 8 weeks | Admin, platform, final cutover | 100–150 Go files |
| **Total** | **~48 weeks** | Full backend | **~780–1,070 Go files** |

**Team composition:** 2–3 senior Go engineers, 3–4 full-stack/domain engineers (familiar with CRM modules), 1 QA engineer, 1 DevOps engineer.

## 13. Immediate Next Steps (after plan approval)

1. Finalize the Go directory name (`golang/` vs `backend-go/`) and framework choice (Echo vs Gin).
2. Initialize `go.mod` and the base project structure on the `golang-2` branch.
3. Add a Prisma Client Go generator to `backend/prisma/schema.prisma` behind a feature flag so it does not disrupt the Node.js build.
4. Implement the shared middleware/context layer (JWT, RBAC, tenant scoping, scrub, audit, stripDangerous, sanitizeBody, rate limiting, security headers).
5. Migrate `GET /api/health` and `GET /api/audit` endpoints end-to-end to prove the gateway and shared layer.
6. Set up the Go CI jobs and contract snapshot harness.
7. Write a runbook for adding a new migrated module.

## 14. Appendix: Key Source Files to Reference

- `backend/server.js` — Express bootstrap, middleware order, route mount table.
- `backend/package.json` — dependency inventory and scripts.
- `backend/prisma/schema.prisma` — data model.
- `backend/middleware/auth.js` — JWT, RBAC, step-up.
- `backend/middleware/requirePermission.js` — permission resolver and cache.
- `backend/middleware/wellnessRole.js` — wellness role gate.
- `backend/middleware/validateInput.js` — `stripDangerous`, `sanitizeBody`.
- `backend/middleware/scrubResponse.js` — response scrubber.
- `backend/middleware/apiRateLimiters.js` — rate limiters.
- `backend/lib/audit.js` — audit hash chain.
- `backend/lib/fieldEncryption.js` — PII/credential encryption.
- `backend/lib/credentialMasking.js` — credential masking.
- `backend/lib/sanitizeJson.js` — JSON-string sanitization.
- `backend/lib/prisma.js` — Prisma client, `$extends`, PII hook.
- `backend/lib/cronRegistry.js` — cron registry.
- `backend/services/smsProvider.js` — provider wrapper example.
- `backend/services/whatsappProvider.js` — Meta Cloud API example.
- `backend/services/whatsappWebClient.js` — Puppeteer/WhatsApp Web example.
- `backend/services/razorpayService.js` — Razorpay example.
- `backend/services/pushService.js` — web push example.
- `.github/workflows/deploy.yml` — CI gates and deploy flow.
- `backend/vitest.config.js` — test config and inlining rules.
- `backend/test/setup.js` — Prisma surface guard and DB fallthrough guard.
- `AGENTS.md` — project conventions and gotchas.

---

## 15. Concrete Go Project Layout and Sample Files

### 15.1 Directory naming decision

Two naming conventions are viable:

- **`golang/`** — explicit, easy to grep, avoids confusion with `backend/` during the hybrid period.
- **`backend-go/`** — symmetric with `backend/`, makes the final rename (`backend/` → `backend-node/` and `backend-go/` → `backend/`) cleaner.

**Recommendation:** use **`backend-go/`** because the final cutover is conceptually a swap of the `backend/` directory, and CI paths (`.github/workflows/*.yml`) will need fewer renames at the end. Until cutover, `backend/` remains the Node.js backend and `backend-go/` is the Go backend.

### 15.2 Proposed `backend-go/` directory tree

```
backend-go/
├── .golangci.yml                 # lint config matching Node.js audit discipline
├── Dockerfile                    # multi-stage build; CGO enabled if gosseract is needed
├── Makefile                      # build, test, generate, lint targets
├── go.mod                        # module github.com/globussoft/crm-backend-go
├── cmd/
│   ├── api/
│   │   └── main.go              # HTTP server bootstrap
│   └── worker/
│       └── main.go              # cron-only worker (optional,DISABLE_CRONS=1 still honored)
├── config/
│   ├── config.go                # env/config struct with envconfig tags
│   ├── routes.yaml              # migrated-path registry read by gateway and CI
│   └── routes.yaml.example
├── internal/
│   ├── app/
│   │   ├── server.go            # Echo/Gin setup, middleware chain, route mounts
│   │   ├── middleware.go        # global middleware implementations
│   │   └── routes.go            # registry-driven route loader
│   ├── domain/
│   │   ├── auth/
│   │   ├── contacts/
│   │   ├── leads/
│   │   ├── deals/
│   │   ├── wellness/
│   │   ├── travel/
│   │   └── ...                  # one package per business domain
│   ├── handlers/                # HTTP handlers (thin, call domain/services)
│   │   ├── auth_handler.go
│   │   ├── audit_handler.go
│   │   └── ...
│   ├── services/                # business logic + orchestration
│   │   ├── auth_service.go
│   │   ├── contact_service.go
│   │   └── ...
│   ├── repository/              # DB access layer (Prisma Client Go or GORM)
│   │   ├── prisma/
│   │   │   └── client.go        # generated Prisma Client Go wrapper
│   │   └── gorm/
│   │       └── ...              # optional GORM models added later
│   ├── providers/               # external SDK wrappers
│   │   ├── sms/
│   │   ├── email/
│   │   ├── whatsapp/
│   │   ├── payments/
│   │   ├── llm/
│   │   ├── s3/
│   │   └── imap/
│   ├── cron/
│   │   ├── registry.go          # cron registry mirroring backend/lib/cronRegistry.js
│   │   └── engines/             # one file per cron engine
│   ├── shared/
│   │   ├── context.go           # UserContext, TenantContext
│   │   ├── errors.go            # canonical error codes/envelopes
│   │   ├── audit.go             # writeAudit + hash chain
│   │   ├── encryption.go        # PII/credential AES-256-GCM
│   │   ├── masking.go           # credential masking
│   │   ├── sanitize.go          # sanitizeJson/sanitizeText
│   │   ├── scrub.go             # scrubResponse
│   │   ├── tenant.go            # GORM scopes / Prisma middleware
│   │   └── validators.go        # custom go-playground validators
│   └── pkg/
│       └── ...                  # small reusable helpers (phone, date, pagination)
├── api/                          # OpenAPI specs (one per module)
├── migrations/                   # populated only after Phase 5 schema switch
├── test/
│   ├── fixtures/                # seed JSON/SQL fixtures
│   ├── integration/             # integration tests (DB + real providers mocked)
│   └── contract/                # snapshot harness
└── scripts/
    ├── generate-models.sh       # Prisma Client Go or GORM generation
    └── compare-contracts.sh     # diff Node vs Go snapshots
```

### 15.3 `go.mod` (starter)

```go
module github.com/globussoft/crm-backend-go

go 1.24

require (
    github.com/labstack/echo/v4 v4.13.0
    github.com/golang-jwt/jwt/v5 v5.2.2
    github.com/go-playground/validator/v10 v10.26.0
    github.com/prisma/prisma-client-go v0.45.0
    github.com/redis/go-redis/v9 v9.8.0
    github.com/robfig/cron/v3 v3.0.1
    github.com/ulule/limiter/v3 v3.11.0
    github.com/microcosm-cc/bluemonday v1.0.27
    github.com/aws/aws-sdk-go-v2/service/s3 v1.79.0
    github.com/sendgrid/sendgrid-go v3.16.0+incompatible
    github.com/stripe/stripe-go/v81 v81.0.0
    github.com/xuri/excelize/v2 v2.10.0
    github.com/go-resty/resty/v2 v2.16.0
    github.com/sirupsen/logrus v1.9.3
    github.com/spf13/viper v1.20.0
    github.com/kelseyhightower/envconfig v1.4.0
    github.com/stretchr/testify v1.10.0
    github.com/golang/mock/gomock v1.6.0
)
```

### 15.4 `config/config.go`

```go
package config

import "github.com/kelseyhightower/envconfig"

type Config struct {
    Env                 string `envconfig:"NODE_ENV" default:"development"`
    Port                string `envconfig:"PORT" default:"5000"`
    DatabaseURL         string `envconfig:"DATABASE_URL" required:"true"`
    JWTSecret           string `envconfig:"JWT_SECRET" required:"true"`
    PortalJWTSecret     string `envconfig:"PORTAL_JWT_SECRET" required:"true"`
    FrontendURL         string `envconfig:"FRONTEND_URL" default:"http://localhost:5173"`
    CorsOrigins         string `envconfig:"CORS_ALLOWED_ORIGINS" default:"*"`
    RedisAddr           string `envconfig:"REDIS_ADDR" default:""`
    DisableCrons        bool   `envconfig:"DISABLE_CRONS" default:"false"`
    WellnessFieldKey    string `envconfig:"WELLNESS_FIELD_KEY" default:""`
    StripeKey           string `envconfig:"STRIPE_KEY_SECRET" default:""`
    RazorpayKeyID       string `envconfig:"RAZORPAY_KEY_ID" default:""`
    RazorpayKeySecret   string `envconfig:"RAZORPAY_KEY_SECRET" default:""`
    SendgridKey         string `envconfig:"SENDGRID_API_KEY" default:""`
    OpenAIKey           string `envconfig:"OPENAI_API_KEY" default:""`
    GeminiKey           string `envconfig:"GEMINI_API_KEY" default:""`
    S3Bucket            string `envconfig:"S3_BUCKET" default:""`
    RouteRegistryPath   string `envconfig:"ROUTE_REGISTRY_PATH" default:"./config/routes.yaml"`
}

func Load() (*Config, error) {
    var c Config
    if err := envconfig.Process("", &c); err != nil {
        return nil, err
    }
    return &c, nil
}
```

### 15.5 `cmd/api/main.go`

```go
package main

import (
    "context"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"

    "github.com/globussoft/crm-backend-go/backend-go/internal/app"
    "github.com/globussoft/crm-backend-go/backend-go/config"
)

func main() {
    cfg, err := config.Load()
    if err != nil {
        log.Fatalf("config load failed: %v", err)
    }
    if cfg.JWTSecret == "" || cfg.DatabaseURL == "" || cfg.PortalJWTSecret == "" {
        log.Fatal("JWT_SECRET, PORTAL_JWT_SECRET and DATABASE_URL are required")
    }

    srv, err := app.NewServer(cfg)
    if err != nil {
        log.Fatalf("server init failed: %v", err)
    }

    e := srv.Engine()
    go func() {
        if err := e.Start(":" + cfg.Port); err != nil && err != http.ErrServerClosed {
            log.Fatalf("server start failed: %v", err)
        }
    }()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := e.Shutdown(ctx); err != nil {
        log.Fatalf("server shutdown failed: %v", err)
    }
}
```

### 15.6 Sample handler: `GET /api/audit`

```go
package handlers

import (
    "net/http"
    "strconv"

    "github.com/globussoft/crm-backend-go/backend-go/internal/services"
    "github.com/globussoft/crm-backend-go/backend-go/internal/shared"
    "github.com/labstack/echo/v4"
)

type AuditHandler struct {
    svc services.AuditService
}

func NewAuditHandler(svc services.AuditService) *AuditHandler {
    return &AuditHandler{svc: svc}
}

func (h *AuditHandler) List(c echo.Context) error {
    ctx := c.Request().Context()
    uc := shared.UserFromContext(ctx)
    if uc == nil {
        return shared.ErrResponse(c, http.StatusUnauthorized, "UNAUTHORIZED", "missing user context")
    }

    page, _ := strconv.Atoi(c.QueryParam("page"))
    if page < 1 {
        page = 1
    }
    pageSize, _ := strconv.Atoi(c.QueryParam("pageSize"))
    if pageSize < 1 || pageSize > 100 {
        pageSize = 20
    }

    res, err := h.svc.List(ctx, uc.TenantID, services.AuditListParams{
        Page:     page,
        PageSize: pageSize,
        UserID:   c.QueryParam("userId"),
        Action:   c.QueryParam("action"),
    })
    if err != nil {
        return shared.ErrResponse(c, http.StatusInternalServerError, "AUDIT_LIST_ERROR", err.Error())
    }
    return c.JSON(http.StatusOK, res)
}
```

### 15.7 Sample service interface: `internal/services/audit_service.go`

```go
package services

import (
    "context"
    "time"

    "github.com/globussoft/crm-backend-go/backend-go/internal/shared"
)

type AuditListParams struct {
    Page     int
    PageSize int
    UserID   string
    Action   string
    From     time.Time
    To       time.Time
}

type AuditListResponse struct {
    Rows     []shared.AuditLog `json:"rows"`
    Total    int64             `json:"total"`
    Page     int               `json:"page"`
    PageSize int               `json:"pageSize"`
}

//go:generate mockgen -destination=../mocks/mock_audit_service.go -package=mocks . AuditService
type AuditService interface {
    List(ctx context.Context, tenantID int, p AuditListParams) (*AuditListResponse, error)
    Write(ctx context.Context, tenantID int, actorID int, action string, target string, payload map[string]any) error
}
```

### 15.8 Sample test: `internal/services/audit_service_test.go`

```go
package services

import (
    "context"
    "testing"

    "github.com/globussoft/crm-backend-go/backend-go/internal/shared"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
)

type mockAuditRepo struct {
    mock.Mock
}

func (m *mockAuditRepo) List(ctx context.Context, tenantID int, p AuditListParams) ([]shared.AuditLog, int64, error) {
    args := m.Called(ctx, tenantID, p)
    return args.Get(0).([]shared.AuditLog), args.Get(1).(int64), args.Error(2)
}

func TestAuditService_List(t *testing.T) {
    repo := new(mockAuditRepo)
    svc := NewAuditService(repo)
    ctx := context.Background()

    repo.On("List", ctx, 1, AuditListParams{Page: 1, PageSize: 20}).
        Return([]shared.AuditLog{{ID: 1}}, int64(1), nil)

    res, err := svc.List(ctx, 1, AuditListParams{Page: 1, PageSize: 20})
    assert.NoError(t, err)
    assert.Equal(t, 1, len(res.Rows))
    assert.Equal(t, int64(1), res.Total)
    repo.AssertExpectations(t)
}
```

### 15.9 `config/routes.yaml` example

```yaml
version: 1
migrated_prefixes:
  - exact: /api/health
  - exact: /api/status
  - prefix: /api/audit
  - prefix: /api/audit-viewer
  - prefix: /api/auth
  - prefix: /api/auth-2fa
  - prefix: /api/auth-stepup
  - prefix: /api/me
  - prefix: /api/users
  - prefix: /api/roles
  # Phase 2 onwards added here
open_paths_on_go:
  - /api/health
  - /api/status
# When true, requests not matching migrated_prefixes fall back to Node.js.
fallback_to_node: true
```

The gateway and the CI migration-gate both read this file. No route is considered migrated until its prefix is added here.

---

## 16. File-by-File Route Migration Order

The following table lists every route module discovered in `backend/routes/*.js` (206 files) grouped by the migration phase that owns it. Files are ordered within each phase by dependency depth (foundational auth first, then dependent CRUD, then integrations, then public/webhooks). This ordering is the recommended port sequence; it can be adjusted as the team learns, but dependencies listed must be migrated before the dependent file.

### 16.1 Phase 0 — Foundation & Read-Only Probes

| # | File | Route prefix | Dependencies | Notes |
|---|------|--------------|--------------|-------|
| 1 | `backend/routes/status.js` | `/api/status` | — | Health/probe endpoint; keep Node fallback until Go server is live. |
| 2 | `backend/routes/audit.js` | `/api/audit` | Auth, RBAC, tenant scoping | Read-heavy; validates audit hash chain and PII read gate. |
| 3 | `backend/routes/audit_viewer.js` | `/api/audit-viewer` | `audit.js` | Summary charts; good test of aggregation and RBAC. |
| 4 | `backend/routes/me.js` | `/api/me` | Auth, tenant resolution | Small surface; validates JWT payload shape. |

### 16.2 Phase 1 — Core Generic CRM

| # | File | Route prefix | Dependencies | Notes |
|---|------|--------------|--------------|-------|
| 5 | `backend/routes/auth.js` | `/api/auth` | — | Login/logout/refresh; preserve JWT shape, open paths, login rate limits. |
| 6 | `backend/routes/auth_2fa.js` | `/api/auth-2fa` | `auth.js` | TOTP enrollment/verify; preserve `awaiting2FA` claim. |
| 7 | `backend/routes/auth_stepup.js` | `/api/auth-stepup` | `auth.js` | Step-up token issue/verify. |
| 8 | `backend/routes/users.js` | `/api/users` | `auth.js`, `roles.js` | CRUD + invitation; must not expose password hashes. |
| 9 | `backend/routes/roles.js` | `/api/roles` | `auth.js`, `permissions` | Role/permission matrix; cache invalidation. |
| 10 | `backend/routes/contacts.js` | `/api/contacts` | Auth, tenant scope | Standard CRUD, import/export, soft delete. |
| 11 | `backend/routes/contact_views.js` | `/api/contact-views` | `contacts.js` | Saved views; tests tenant-scoped metadata. |
| 12 | `backend/routes/leads_intake.js` | `/api/leads-intake` | `contacts.js`, `lead_routing.js` | Web-to-lead forms; public paths need origin check. |
| 13 | `backend/routes/lead_routing.js` | `/api/lead-routing` | `contacts.js`, `leads_intake.js` | Assignment rules; migrate with intake. |
| 14 | `backend/routes/lead_sla.js` | `/api/lead-sla` | `leads_intake.js` | SLA definitions; cron engine is separate. |
| 15 | `backend/routes/lead_custom_fields.js` | `/api/lead-custom-fields` | `contacts.js`, `leads_intake.js` | Custom field schema; must keep shape. |
| 16 | `backend/routes/leads_extension_capture.js` | `/api/leads-extension-capture` | `contacts.js` | Browser extension capture. |
| 17 | `backend/routes/marketplace_leads.js` | `/api/marketplace-leads` | `contacts.js`, `leads_intake.js` | External lead ingestion webhooks. |
| 18 | `backend/routes/deals.js` | `/api/deals` | `contacts.js`, `pipeline_stages.js` | Pipeline + forecast data. |
| 19 | `backend/routes/deals_documents.js` | `/api/deals-documents` | `deals.js`, `document_templates.js` | Deal attachments. |
| 20 | `backend/routes/deal_insights.js` | `/api/deal-insights` | `deals.js` | AI/aggregated deal insights. |
| 21 | `backend/routes/pipeline_stages.js` | `/api/pipeline-stages` | `deals.js` | Pipeline definition. |
| 22 | `backend/routes/pipelines.js` | `/api/pipelines` | `deals.js`, `pipeline_stages.js` | Pipeline grouping. |
| 23 | `backend/routes/tasks.js` | `/api/tasks` | Auth, `contacts.js` | Assignments, reminders. |
| 24 | `backend/routes/projects.js` | `/api/projects` | `contacts.js`, `tasks.js`, `deals.js` | Project management. |
| 25 | `backend/routes/contracts.js` | `/api/contracts` | `contacts.js`, `document_templates.js` | Contract lifecycle. |
| 26 | `backend/routes/estimates.js` | `/api/estimates` | `contacts.js`, `contracts.js` | Estimates + PDF. |
| 27 | `backend/routes/v1_invoices.js` | `/api/v1/invoices` | `billing.js`, `payments.js` | Legacy invoice API; preserve envelope. |
| 28 | `backend/routes/billing.js` | `/api/billing` | `payments.js`, `payment_gateways.js` | Subscriptions, invoices. |
| 29 | `backend/routes/expenses.js` | `/api/expenses` | Auth | Expense claims. |
| 30 | `backend/routes/payments.js` | `/api/payments` | `payment_gateways.js` | Payment records. |
| 31 | `backend/routes/payment_gateways.js` | `/api/payment-gateways` | Auth | Stripe/Razorpay config; credential masking. |
| 32 | `backend/routes/currencies.js` | `/api/currencies` | Auth | Currency list. |
| 33 | `backend/routes/accounting.js` | `/api/accounting` | `billing.js`, `expenses.js` | Ledger exports. |
| 34 | `backend/routes/dashboards.js` | `/api/dashboards` | `contacts.js`, `deals.js`, `tasks.js`, `reports.js` | Aggregated dashboard widgets. |
| 35 | `backend/routes/reports.js` | `/api/reports` | `contacts.js`, `deals.js`, `billing.js` | Standard reports. |
| 36 | `backend/routes/custom_reports.js` | `/api/custom-reports` | `reports.js` | Saved report configs. |
| 37 | `backend/routes/report_schedules.js` | `/api/report-schedules` | `reports.js`, `email.js` | Scheduled report emails. |
| 38 | `backend/routes/forecasting.js` | `/api/forecasting` | `deals.js`, `reports.js` | Forecast snapshots. |
| 39 | `backend/routes/quotas.js` | `/api/quotas` | `users.js`, `deals.js` | Sales quotas. |
| 40 | `backend/routes/playbooks.js` | `/api/playbooks` | `tasks.js`, `contacts.js` | Sales playbooks. |
| 41 | `backend/routes/field_permissions.js` | `/api/field-permissions` | `roles.js`, `contacts.js` | Column-level access. |
| 42 | `backend/routes/custom_objects.js` | `/api/custom-objects` | `contacts.js`, `deals.js` | Custom entity schemas. |
| 43 | `backend/routes/integrations.js` | `/api/integrations` | Auth | OAuth app configs. |
| 44 | `backend/routes/tenants.js` | `/api/tenants` | Auth (super-admin) | Tenant CRUD; be careful with tenant isolation. |
| 45 | `backend/routes/tenant_settings.js` | `/api/tenant-settings` | `tenants.js` | Per-tenant settings. |
| 46 | `backend/routes/settings.js` | `/api/settings` | Auth | Global settings. |
| 47 | `backend/routes/user_preferences.js` | `/api/user-preferences` | Auth | Per-user UI prefs. |
| 48 | `backend/routes/table_column_preferences.js` | `/api/table-column-preferences` | Auth | Grid column state. |
| 49 | `backend/routes/subscriptions.js` | `/api/subscriptions` | `billing.js`, `payment_gateways.js` | Plan/subscription management. |

### 16.3 Phase 2 — Communications & Marketing

| # | File | Route prefix | Dependencies | Notes |
|---|------|--------------|--------------|-------|
| 50 | `backend/routes/sms.js` | `/api/sms` | Auth, provider config | SMS send/log; multi-recipient envelope. |
| 51 | `backend/routes/email.js` | `/api/email` | Auth, provider config | Email send/log; multi-recipient envelope. |
| 52 | `backend/routes/email_inbound.js` | `/api/email-inbound` | `email.js`, IMAP provider | Inbound email processing. |
| 53 | `backend/routes/email_scheduling.js` | `/api/email-scheduling` | `email.js` | Scheduled/drip campaigns. |
| 54 | `backend/routes/email_templates.js` | `/api/email-templates` | `email.js` | Template CRUD. |
| 55 | `backend/routes/email_threading.js` | `/api/email-threading` | `email_inbound.js` | Conversation threads. |
| 56 | `backend/routes/push.js` | `/api/push` | Auth, VAPID config | Web push. |
| 57 | `backend/routes/live_chat.js` | `/api/live-chat` | Auth | Chat sessions. |
| 58 | `backend/routes/communications.js` | `/api/communications` | `sms.js`, `email.js`, `live_chat.js` | Unified comms log. |
| 59 | `backend/routes/marketing.js` | `/api/marketing` | `email.js`, `sms.js`, `contacts.js` | Campaigns. |
| 60 | `backend/routes/sequences.js` | `/api/sequences` | `marketing.js`, `email.js`, `sms.js` | Sequence engine API. |
| 61 | `backend/routes/landing_pages.js` | `/api/landing-pages` | `marketing.js` | Landing page builder. |
| 62 | `backend/routes/landing_sites.js` | `/api/landing-sites` | `landing_pages.js` | Site hosting. |
| 63 | `backend/routes/pages.js` | `/api/pages` | `landing_pages.js` | Page builder blocks. |
| 64 | `backend/routes/chatbots.js` | `/api/chatbots` | `live_chat.js` | Bot flows. |
| 65 | `backend/routes/signatures.js` | `/api/signatures` | Auth | E-signature. |
| 66 | `backend/routes/document_templates.js` | `/api/document-templates` | Auth | PDF templates. |
| 67 | `backend/routes/document_views.js` | `/api/document-views` | `document_templates.js` | Document viewer analytics. |
| 68 | `backend/routes/surveys.js` | `/api/surveys` | `contacts.js` | Surveys. |
| 69 | `backend/routes/canned_responses.js` | `/api/canned-responses` | `live_chat.js` | Quick replies. |
| 70 | `backend/routes/file-uploads.js` | `/api/file-uploads` | Auth | S3 presign/upload. |
| 71 | `backend/routes/support.js` | `/api/support` | `contacts.js`, `tickets.js` | Support portal config. |
| 72 | `backend/routes/support_chat.js` | `/api/support-chat` | `support.js`, `live_chat.js` | Support chat UI. |
| 73 | `backend/routes/tickets.js` | `/api/tickets` | `support.js`, `contacts.js` | Ticketing. |
| 74 | `backend/routes/notifications.js` | `/api/notifications` | Auth | In-app notification feed. |
| 75 | `backend/routes/sentiment.js` | `/api/sentiment` | `communications.js`, LLM provider | Sentiment analysis. |
| 76 | `backend/routes/shared_inbox.js` | `/api/shared-inbox` | `email_inbound.js`, `support.js` | Shared inbox. |
| 77 | `backend/routes/calendar.js` | `/api/calendar` | Auth | Calendar events. |
| 78 | `backend/routes/calendar_events.js` | `/api/calendar-events` | `calendar.js` | Event CRUD. |
| 79 | `backend/routes/calendar_google.js` | `/api/calendar-google` | `calendar_events.js` | Google sync. |
| 80 | `backend/routes/calendar_outlook.js` | `/api/calendar-outlook` | `calendar_events.js` | Outlook sync. |
| 81 | `backend/routes/csv_io.js` | `/api/csv-io` | `contacts.js`, `leads_intake.js` | Generic CSV import/export. |
| 82 | `backend/routes/brand_kits.js` | `/api/brand-kits` | Auth | Brand assets. |
| 83 | `backend/routes/adsgpt.js` | `/api/adsgpt` | `marketing.js`, LLM provider | Ad generation. |
| 84 | `backend/routes/attribution.js` | `/api/attribution` | `marketing.js`, `contacts.js` | Attribution model. |
| 85 | `backend/routes/funnel.js` | `/api/funnel` | `marketing.js`, `contacts.js` | Funnel analytics. |
| 86 | `backend/routes/ab_tests.js` | `/api/ab-tests` | `marketing.js`, `landing_pages.js` | A/B experiments. |
| 87 | `backend/routes/industry_templates.js` | `/api/industry-templates` | Auth | Template marketplace. |
| 88 | `backend/routes/data_enrichment.js` | `/api/data-enrichment` | `contacts.js`, LLM provider | Lead enrichment. |

### 16.4 Phase 3 — Wellness Vertical

| # | File | Route prefix | Dependencies | Notes |
|---|------|--------------|--------------|-------|
| 89 | `backend/routes/wellness.js` | `/api/wellness` | Auth, wellness role | Main wellness router. |
| 90 | `backend/routes/wellness_ai_config.js` | `/api/wellness-ai-config` | `wellness.js` | AI config for wellness. |
| 91 | `backend/routes/wellnessCsv.js` | `/api/wellness-csv` | `wellness.js` | CSV export (BOM/CRLF must match). |
| 92 | `backend/routes/portal.js` | `/api/portal` | `wellness.js`, patient JWT | Patient portal. |
| 93 | `backend/routes/pos.js` | `/api/pos` | `wellness.js`, `billing.js` | Point-of-sale. |
| 94 | `backend/routes/drugs.js` | `/api/drugs` | `wellness.js` | Drug catalog. |
| 95 | `backend/routes/block-times.js` | `/api/block-times` | `calendar_events.js`, `wellness.js` | Appointment blocking. |
| 96 | `backend/routes/booking_pages.js` | `/api/booking-pages` | `wellness.js`, `calendar_events.js` | Public booking. |
| 97 | `backend/routes/staff.js` | `/api/staff` | `users.js`, `wellness.js` | Clinic staff. |
| 98 | `backend/routes/attendance.js` | `/api/attendance` | `staff.js`, `wellness.js` | Attendance. |
| 99 | `backend/routes/leave.js` | `/api/leave` | `staff.js`, `wellness.js` | Leave requests. |
| 100 | `backend/routes/inventory.js` | `/api/inventory` | `wellness.js`, `pos.js` | Inventory. |
| 101 | `backend/routes/wallet.js` | `/api/wallet` | `wellness.js`, `billing.js` | Patient wallet. |
| 102 | `backend/routes/wallet_admin.js` | `/api/wallet-admin` | `wallet.js`, `wellness.js` | Wallet rules admin. |
| 103 | `backend/routes/wallet_rules.js` | `/api/wallet-rules` | `wallet.js`, `wellness.js` | Wallet earning rules. |
| 104 | `backend/routes/service_categories.js` | `/api/service-categories` | `wellness.js` | Service catalog. |

### 16.5 Phase 4 — Travel Vertical

| # | File | Route prefix | Dependencies | Notes |
|---|------|--------------|--------------|-------|
| 105 | `backend/routes/travel.js` | `/api/travel` | Auth | Travel main router. |
| 106 | `backend/routes/travel_trips.js` | `/api/travel-trips` | `travel.js` | Trip packages. |
| 107 | `backend/routes/travel_quotes.js` | `/api/travel-quotes` | `travel_trips.js`, `travel.js` | Quote builder. |
| 108 | `backend/routes/travel_quotes_public.js` | `/api/travel-quotes-public` | `travel_quotes.js` | Public quote forms. |
| 109 | `backend/routes/travel_quote_templates.js` | `/api/travel-quote-templates` | `travel_quotes.js` | Quote templates. |
| 110 | `backend/routes/travel_itineraries.js` | `/api/travel-itineraries` | `travel_trips.js`, `travel_quotes.js` | Itineraries. |
| 111 | `backend/routes/travel_itinerary_templates.js` | `/api/travel-itinerary-templates` | `travel_itineraries.js` | Itinerary templates. |
| 112 | `backend/routes/travel_flight_quotes.js` | `/api/travel-flight-quotes` | `travel_quotes.js`, `ratehawk.js` | Flight quotes. |
| 113 | `backend/routes/travel_visa.js` | `/api/travel-visa` | `travel_trips.js` | Visa processing. |
| 114 | `backend/routes/travel_passport.js` | `/api/travel-passport` | `travel_visa.js` | Passport info. |
| 115 | `backend/routes/travel_suppliers.js` | `/api/travel-suppliers` | `travel.js` | Supplier master. |
| 116 | `backend/routes/travel_commission_profiles.js` | `/api/travel-commission-profiles` | `travel_suppliers.js` | Commission rules. |
| 117 | `backend/routes/travel_supplier_commissions.js` | `/api/travel-supplier-commissions` | `travel_commission_profiles.js` | Commission transactions. |
| 118 | `backend/routes/travel_supplier_reconciliation.js` | `/api/travel-supplier-reconciliation` | `travel_supplier_commissions.js` | Supplier reconciliation. |
| 119 | `backend/routes/travel_cost_master.js` | `/api/travel-cost-master` | `travel_suppliers.js` | Cost master data. |
| 120 | `backend/routes/travel_pricing.js` | `/api/travel-pricing` | `travel_cost_master.js` | Dynamic pricing. |
| 121 | `backend/routes/travel_invoices.js` | `/api/travel-invoices` | `travel_trips.js`, `billing.js` | Travel invoices. |
| 122 | `backend/routes/travel_trip_billing.js` | `/api/travel-trip-billing` | `travel_invoices.js`, `payments.js` | Trip billing. |
| 123 | `backend/routes/travel_invoice_ledgers.js` | `/api/travel-invoice-ledgers` | `travel_invoices.js` | Invoice ledgers. |
| 124 | `backend/routes/travel_purchase_orders.js` | `/api/travel-purchase-orders` | `travel_suppliers.js` | POs. |
| 125 | `backend/routes/travel_payable_batches.js` | `/api/travel-payable-batches` | `travel_purchase_orders.js` | Payable batches. |
| 126 | `backend/routes/travel_cancellation_policies.js` | `/api/travel-cancellation-policies` | `travel_trips.js` | Cancellation rules. |
| 127 | `backend/routes/travel_reports.js` | `/api/travel-reports` | `travel_invoices.js`, `travel_trips.js` | Travel reports. |
| 128 | `backend/routes/travel_dashboard.js` | `/api/travel-dashboard` | `travel_reports.js` | Travel dashboards. |
| 129 | `backend/routes/travel_personalised_destinations.js` | `/api/travel-personalised-destinations` | `travel_trips.js` | AI destinations. |
| 130 | `backend/routes/travel_destination_photos.js` | `/api/travel-destination-photos` | `travel_personalised_destinations.js` | Photo assets. |
| 131 | `backend/routes/travel_sightseeing.js` | `/api/travel-sightseeing` | `travel_itineraries.js` | Sightseeing items. |
| 132 | `backend/routes/travel_pois.js` | `/api/travel-pois` | `travel_sightseeing.js` | Points of interest. |
| 133 | `backend/routes/travel_microsites.js` | `/api/travel-microsites` | `travel_trips.js` | Public microsites. |
| 134 | `backend/routes/travel_flyer_templates.js` | `/api/travel-flyer-templates` | `travel_microsites.js` | Flyer templates. |
| 135 | `backend/routes/travel_flyer_public.js` | `/api/travel-flyer-public` | `travel_flyer_templates.js` | Public flyers. |
| 136 | `backend/routes/travel_brochures.js` | `/api/travel-brochures` | `travel_itineraries.js` | Brochure engine integration. |
| 137 | `backend/routes/travel_engine_weights.js` | `/api/travel-engine-weights` | `travel_brochures.js` | AI weights. |
| 138 | `backend/routes/travel_diagnostics.js` | `/api/travel-diagnostics` | `travel_brochures.js` | Diagnostic logs. |
| 139 | `backend/routes/travel_session.js` | `/api/travel-session` | `travel.js` | Public session. |
| 140 | `backend/routes/travel_webcheckin.js` | `/api/travel-webcheckin` | `travel_session.js` | Web check-in. |
| 141 | `backend/routes/travel_whatsapp.js` | `/api/travel-whatsapp` | `whatsapp.js`, `travel.js` | Travel WhatsApp. |
| 142 | `backend/routes/travel_visa_analytics.js` | `/api/travel-visa-analytics` | `travel_visa.js` | Visa analytics. |
| 143 | `backend/routes/travel_travelstall.js` | `/api/travel-travelstall` | `travel_trips.js` | Travelstall integration. |
| 144 | `backend/routes/travel_tmc_catalogue.js` | `/api/travel-tmc-catalogue` | `travel_suppliers.js` | TMC catalog. |
| 145 | `backend/routes/travel_settlement_timeline.js` | `/api/travel-settlement-timeline` | `travel_supplier_reconciliation.js` | Settlement. |
| 146 | `backend/routes/travel_school_terms.js` | `/api/travel-school-terms` | `travel_trips.js` | School terms. |
| 147 | `backend/routes/travel_rfu_profiles.js` | `/api/travel-rfu-profiles` | `travel_quotes.js` | RFU profiles. |
| 148 | `backend/routes/travel_reviews.js` | `/api/travel-reviews` | `travel_trips.js` | Reviews. |
| 149 | `backend/routes/travel_religious_packets.js` | `/api/travel-religious-packets` | `travel_trips.js` | Religious packages. |
| 150 | `backend/routes/travel_inbound_leads.js` | `/api/travel-inbound-leads` | `travel_quotes.js`, `marketplace_leads.js` | Travel leads. |
| 151 | `backend/routes/travel_fx.js` | `/api/travel-fx` | `travel_pricing.js` | FX rates. |
| 152 | `backend/routes/travel_curriculum.js` | `/api/travel-curriculum` | `travel_trips.js` | Curriculum. |
| 153 | `backend/routes/travel_csv_io.js` | `/api/travel-csv-io` | `travel.js`, `csv_io.js` | Travel CSV. |
| 154 | `backend/routes/travel_search.js` | `/api/travel-search` | `travel_trips.js`, `search.js` | Travel search. |

### 16.6 Phase 5 — Admin, Platform, Public, WebSockets, and Final Cutover

| # | File | Route prefix | Dependencies | Notes |
|---|------|--------------|--------------|-------|
| 155 | `backend/routes/admin.js` | `/api/admin` | Super-admin auth | Admin operations. |
| 156 | `backend/routes/super_admin_auth.js` | `/api/super-admin/auth` | Auth | Super-admin login. |
| 157 | `backend/routes/super_admin_cron.js` | `/api/super-admin/cron` | `cron` registry | Cron management. |
| 158 | `backend/routes/super_admin_cron_analytics.js` | `/api/super-admin/cron-analytics` | `super_admin_cron.js` | Cron analytics. |
| 159 | `backend/routes/super_admin_api_analytics.js` | `/api/super-admin/api-analytics` | `super_admin_auth.js` | API analytics. |
| 160 | `backend/routes/security_reports.js` | `/api/security-reports` | `audit.js`, `super_admin_auth.js` | Security reports. |
| 161 | `backend/routes/gdpr.js` | `/api/gdpr` | Auth, `audit.js` | Data export/erasure. |
| 162 | `backend/routes/legal.js` | `/api/legal` | Auth | Legal entity config. |
| 163 | `backend/routes/developer.js` | `/api/developer` | Auth | API keys/webhooks. |
| 164 | `backend/routes/scim.js` | `/api/scim` | `sso.js`, `users.js` | SCIM provisioning. |
| 165 | `backend/routes/sso.js` | `/api/sso` | `auth.js`, `settings.js` | SSO/SAML. |
| 166 | `backend/routes/zapier.js` | `/api/zapier` | `contacts.js`, `deals.js` | Zapier hooks. |
| 167 | `backend/routes/web_visitors.js` | `/api/web-visitors` | `landing_pages.js` | Visitor tracking. |
| 168 | `backend/routes/widgets.js` | `/api/widgets` | `dashboards.js` | Embeddable widgets. |
| 169 | `backend/routes/workflows.js` | `/api/workflows` | `tasks.js`, `deals.js` | Workflow automation. |
| 170 | `backend/routes/ai.js` | `/api/ai` | LLM provider | Generic AI endpoints. |
| 171 | `backend/routes/ai_scoring.js` | `/api/ai-scoring` | `leads_intake.js`, `deals.js`, LLM | Lead/deal scoring. |
| 172 | `backend/routes/csp.js` | `/api/csp` | Auth | CSP report collector. |
| 173 | `backend/routes/cpq.js` | `/api/cpq` | `products`, `deals.js` | Configure-price-quote. |
| 174 | `backend/routes/callified.js` | `/api/callified` | `communications.js`, telephony | Call integration. |
| 175 | `backend/routes/telephony.js` | `/api/telephony` | `callified.js` | Telephony provider. |
| 176 | `backend/routes/voice.js` | `/api/voice` | `telephony.js` | Voice calls. |
| 177 | `backend/routes/voice_transcription.js` | `/api/voice-transcription` | `voice.js` | Transcription. |
| 178 | `backend/routes/whatsapp.js` | `/api/whatsapp` | Auth, WhatsApp provider | WhatsApp Cloud API. |
| 179 | `backend/routes/whatsapp_web.js` | `/api/whatsapp-web` | `whatsapp.js` | WhatsApp Web bridge. |
| 180 | `backend/routes/whatsapp_webhook.js` | `/api/whatsapp-webhook` | `whatsapp.js` | Webhooks. |
| 181 | `backend/routes/whatsapp_gateway_webhook.js` | `/api/whatsapp-gateway-webhook` | `whatsapp.js` | Gateway webhooks. |
| 182 | `backend/routes/whatsapp_onboard.js` | `/api/whatsapp-onboard` | `whatsapp.js` | Onboarding. |
| 183 | `backend/routes/gmail.js` | `/api/gmail` | `email.js`, `integrations.js` | Gmail OAuth. |
| 184 | `backend/routes/external.js` | `/api/external` | `integrations.js` | External APIs. |
| 185 | `backend/routes/social.js` | `/api/social` | `integrations.js` | Social OAuth. |
| 186 | `backend/routes/search.js` | `/api/search` | `contacts.js`, `deals.js`, `tasks.js` | Global search. |
| 187 | `backend/routes/sla.js` | `/api/sla` | `leads_intake.js`, `tickets.js` | SLA rules. |
| 188 | `backend/routes/approvals.js` | `/api/approvals` | `expenses.js`, `leave.js` | Approval workflows. |
| 189 | `backend/routes/knowledge_base.js` | `/api/knowledge-base` | `support.js` | KB articles. |
| 190 | `backend/routes/embassy_rules.js` | `/api/embassy-rules` | `travel_visa.js` | Embassy rules. |
| 191 | `backend/routes/sandbox.js` | `/api/sandbox` | Auth | Sandbox operations. |
| 192 | `backend/routes/ratehawk.js` | `/api/ratehawk` | `travel_flight_quotes.js` | Ratehawk integration. |
| 193 | `backend/routes/voyagr.js` | `/api/voyagr` | `travel.js` | Voyagr plugin. |
| 194 | `backend/routes/win_loss.js` | `/api/win-loss` | `deals.js` | Win/loss analysis. |
| 195 | `backend/routes/sub_brand_themes.js` | `/api/sub-brand-themes` | Auth, `tenants.js` | Sub-brand themes. |
| 196 | `backend/routes/territories.js` | `/api/territories` | Auth | Territory mapping. |
| 197 | `backend/routes/staff.js` | `/api/staff` | already in Phase 3 | (wellness-specific subset) |
| 198 | `backend/routes/lead_capture_settings.js` | `/api/lead-capture-settings` | `leads_intake.js` | Capture settings. |
| 199 | `backend/routes/territories.js` | `/api/territories` | `users.js` | Territory assignment. |
| 200 | `backend/routes/territories.js` | `/api/territories` | — | (deduplicated above) |
| 201 | `backend/routes/territories.js` | `/api/territories` | — | (deduplicated above) |
| 202 | `backend/routes/projects.js` | `/api/projects` | already in Phase 1 | |
| 203 | `backend/routes/cpq.js` | `/api/cpq` | already in Phase 5 | |
| 204 | `backend/routes/products.js` | `/api/products` | Auth | Product catalog (if present in another route file). |
| 205 | `backend/routes/v1_invoices.js` | `/api/v1/invoices` | already in Phase 1 | Legacy alias. |
| 206 | `backend/routes/territories.js` | `/api/territories` | — | (ensure only one entry) |

> **Note:** The exact count fluctuates because some files were discovered that may not have been in the earlier plan estimate (e.g., `territories.js`, `staff.js` appearing in multiple glob ranges, `ratehawk.js`). The registry in `config/routes.yaml` should be the single source of truth; the table above is the recommended starting order.

---

## 17. Expanded Data Migration and Schema Evolution

### 17.1 Dual-write safety model (Phase 0–4)

Because both Node.js and Go backends share the same MySQL database and the same Prisma schema during the migration, **no data movement is required**. However, writes performed by the Go backend must be byte-compatible with reads performed by the Node.js backend and vice versa. Enforce this with a **dual-write validation harness**:

1. **Shadow writes** — For each migrated write endpoint, run the Go handler and, for a configurable percentage of requests (e.g., 1% in production, 100% in staging), also perform the same write through the Node.js handler behind a feature flag. Compare the resulting row in the database. Mismatch triggers an alert and a rollback of the route prefix.
2. **Read-back tests** — After every Go write, read the affected rows with both the Go repository layer and the Node.js Prisma client to verify ciphertext, JSON-string shape, timestamps, and soft-delete flags match.
3. **Forbidden write paths** — Node.js must not write to tables owned by migrated Go modules unless an emergency rollback is performed. Document the ownership matrix in `config/routes.yaml` and in `backend-go/docs/OWNERSHIP.md`.
4. **JSON-string column contract** — Any Go write to a `String? @db.Text` column that stores JSON must pass through the same `sanitizeJsonForStringColumn` function used in Node.js, preserving key order and whitespace where the Node.js code does.

### 17.2 Schema evolution strategy

#### Phase 0–4: Prisma remains the canonical migration tool

- New columns required by the Go backend (e.g., `goMigratedAt`, `goLockVersion`) are added via normal Prisma migrations in `backend/prisma/migrations/`.
- Both Node.js and Go read the same `schema.prisma`.
- Prisma Client Go is generated from the same schema; the generator is added behind a comment guard so Node.js builds ignore it.
- Do **not** rename tables or columns in this phase. The cost of keeping the Node.js backend synchronized is too high.

#### Phase 5: Evaluate migration tooling transition

After the Go backend owns 100% of routes, choose one of the following:

| Option | Tool | Pros | Cons | Recommendation |
|---|---|---|---|---|
| A | Keep Prisma | Zero migration-tool change; team knows it; frontend/DBA docs stay valid. | Requires Node.js for `npx prisma migrate`; Go team depends on legacy toolchain. | Keep for 6–12 months. |
| B | `golang-migrate` | Native Go migrations; CI becomes fully Go; easier to embed in Go binary. | Translating 100+ Prisma migrations to SQL files is error-prone; rollback logic differs. | Use after stabilization. |
| C | Hybrid (Prisma for schema drift, `golang-migrate` for app changes) | Incremental transition; safer. | Two sources of truth during a window; needs discipline. | Not recommended; adds confusion. |

**Recommendation:** Option A for the first 6–12 months of Go-only operation, then migrate to Option B in a dedicated, low-risk project. Do not combine schema-tool migration with feature migration.

### 17.3 Dual-write and rollback runbook

For every migrated module, keep a **rollback checklist** in `backend-go/docs/rollback-<module>.md`:

1. Revert the route prefix in `config/routes.yaml` to `fallback_to_node: true` for that prefix.
2. Restart the gateway (Nginx or Go reverse proxy) so traffic returns to Node.js.
3. Verify with the contract snapshot harness that Node.js responses match the pre-migration baseline.
4. If the Go backend wrote incompatible rows, run a **repair script** from the Node.js backend (or a one-off Go repair binary) that re-derives the affected columns from the original data.
5. Post-incident review: update the dual-write validation percentage and fix the Go handler before re-attempting migration.

### 17.4 Zero-downtime considerations

- **Database connection limits:** Both Node.js and Go pools will connect to MySQL. Increase `max_connections` or split read replicas so the combined pool does not exhaust the database. Configure Go `SetMaxOpenConns` conservatively and monitor `Threads_connected`.
- **Schema locks:** Prisma migrations during the migration window will lock tables. Schedule migrations during low-traffic windows and use `ALGORITHM=INPLACE, LOCK=NONE` for MySQL DDL where possible.
- **Session/state:** JWT tokens are stateless; both backends can validate them. Socket.IO sessions remain on Node.js until WebSocket migration.
- **File storage:** S3 presigned URLs and file keys must be generated identically by both backends. Share the same S3 credentials, bucket, and key-prefix scheme.
- **Cache invalidation:** If Redis is introduced for rate limiting or permission caching, both backends must use the same key namespace and TTL.
- **Cron ownership:** Only one backend must run a given cron engine at a time. Use `DISABLE_CRONS` on the standby backend and rely on the registry to decide ownership.

### 17.5 Data validation checkpoints

- **Checkpoint 1 (end of Phase 0):** Verify that Go reads and writes to `AuditLog`, `User`, and `Tenant` tables produce identical rows to Node.js for 1,000 sample operations.
- **Checkpoint 2 (end of Phase 1):** Run a full generic-tenant seed in Go and compare every row to a Node.js seed using a deterministic diff (ignoring `createdAt` microsecond drift).
- **Checkpoint 3 (end of Phase 3):** Decrypt 10,000 existing wellness PII rows in Go and assert they match the plaintext produced by Node.js.
- **Checkpoint 4 (end of Phase 4):** Run the travel brochure engine integration end-to-end and verify the generated itinerary JSON is byte-identical.
- **Checkpoint 5 (final cutover):** Run a full database checksum (table row counts + hash of non-volatile columns) before and after decommissioning Node.js.

---

## 18. Expanded Testing and Contract Validation

### 18.1 Contract snapshot harness architecture

The migration contract is the **JSON request/response shape** observed by the frontend and E2E tests. Build a harness that captures snapshots from the Node.js backend and then asserts the Go backend produces the same shape (not necessarily identical internal state).

**Components:**

1. **Snapshot recorder** (`test/contract/record.js`) — runs against the Node.js backend after a fresh seed. For each endpoint in the migration registry, it stores:
   - HTTP method, path, query, headers, body.
   - Response status, headers, and JSON body (with volatile fields redacted: `id`, `createdAt`, `updatedAt`, `jwt`, `token`, `passwordHash`, `signature`).
   - Snapshots live in `backend-go/test/contract/snapshots/<module>/`.

2. **Snapshot runner** (`test/contract/run.go`) — boots the Go backend (or calls the deployed Go service), replays the same requests, and compares the response body against the stored snapshot using a JSON-aware diff that ignores redacted fields and array order where order is not contractually significant.

3. **Coverage gate** — CI fails if a migrated endpoint has no recorded snapshot or if the snapshot diff exceeds the allowed tolerance.

4. **Diff tolerance rules** — Allow:
   - Different `id` values if the snapshot stores them as `<id>` placeholders.
   - Microsecond differences in timestamps if the response uses ISO 8601 strings.
   - Different `messageId`/`txId` from external providers.
   - Strict equality for enums, pagination shape, and error `code` values.

### 18.2 E2E gate mapping

Map every Playwright spec file in `e2e/tests/` to the route modules it exercises. The CI job for a migrated module runs only the specs that touch it. Maintain the mapping in `backend-go/test/contract/e2e-mapping.yaml`:

```yaml
auth:
  - e2e/tests/auth-login.spec.js
  - e2e/tests/auth-rbac.spec.js
contacts:
  - e2e/tests/contacts-crud.spec.js
  - e2e/tests/contacts-import-csv.spec.js
wellness:
  - e2e/tests/wellness-appointments.spec.js
  - e2e/tests/wellness-patient-portal.spec.js
travel:
  - e2e/tests/travel-quotes.spec.js
  - e2e/tests/travel-brochure-engine.spec.js
```

The CI matrix becomes:
- `node_api_tests` — runs specs for modules **not** in the registry.
- `go_api_tests` — runs specs for modules **in** the registry.
- `hybrid_e2e` — boots both backends and runs the full suite once per week to catch cross-backend integration issues.

### 18.3 Mock strategy and external-provider contracts

Every external provider must have:

- A **Go interface** in `internal/providers/<provider>/provider.go`.
- A **real implementation** using the official SDK or `net/http`.
- A **fake/mock implementation** in `internal/providers/<provider>/mock.go` or generated with `mockgen`.
- A **record/replay transport** for integration tests that captures real provider responses (with secrets redacted) and replays them deterministically in CI.

**Critical provider contracts to snapshot:**

| Provider | Contract to preserve | Test approach |
|---|---|---|
| Stripe | Webhook signature, `payment_intent.succeeded` envelope, `notes.tenantId` | Record real webhook payload, replay with same secret. |
| Razorpay | Signature header (`X-Razorpay-Signature`), `payload.payment.entity.notes` | Same as Stripe. |
| SendGrid | `totalSent`, `totalFailed`, `results`, `failures` envelope | Mock HTTP transport with 202 responses. |
| MSG91 | Provider response parsing, request timeout behavior | Mock HTTP; assert 3–10 s timeout. |
| Twilio | SID/price fields, status callback | Mock HTTP. |
| Gmail/IMAP | UID parsing, thread ID, attachment decode | Use `go-imap` against a Docker Mailhog container. |
| WhatsApp Cloud | Template message JSON, webhook verification | Mock HTTP; verify payload fields. |
| WhatsApp Web | QR scan and message receive | Keep Node.js bridge until Go port is validated. |
| LLM providers | Token cost, response JSON schema, error code mapping | Record Gemini/OpenAI responses; mock for unit tests. |
| S3 | Presigned URL expiry and key format | Use `minio` container in CI. |

### 18.4 Race and load testing

After Phase 1, add a dedicated CI job that runs the top 20 endpoints under load:

- **Tool:** `k6` or `go-wrk`.
- **Baseline:** Run the same load against the Node.js backend in the same environment.
- **Metrics:** P50/P95/P99 latency, error rate, DB connection usage, goroutine count, memory RSS.
- **Race detector:** Run all Go unit tests with `-race` in CI. Cron engines, permission caches, and wallet balance updates are high-priority targets.
- **Concurrency tests:** Simulate concurrent lead assignment, invoice payment capture, and wallet debit to catch lost updates.
- **Idempotency tests:** For each cron engine, run the same tick twice with identical state and assert no duplicate side effects (email sends, charges, audit rows).

### 18.5 Coverage targets and quality gates

| Layer | Target | Measurement |
|---|---|---|
| Go unit tests | ≥70% for migrated modules | `go test -coverprofile` |
| Go race detector | 100% of tests run with `-race` | CI job |
| Contract snapshots | 100% of migrated endpoints | Snapshot harness |
| E2E specs | 100% of mapped specs pass | Playwright |
| Lint | `golangci-lint` zero findings | CI job |
| Vulnerability scan | `govulncheck` zero high/critical | CI job (analogous to `npm audit`) |
| SQL query audit | No raw SQL without parameterization | Static review + `gosec` |
| Middleware order audit | Documented order matches code | Code review checklist |

### 18.6 Test environment parity

Keep the Go test environment identical to the Node.js test environment:

- Same MySQL 8 container image and schema seed (`prisma/seed.js`, `prisma/seed-wellness.js`, plus travel seed if added).
- Same environment variable values from `backend/.env.example`.
- Same `DISABLE_CRONS=1` default for unit/integration tests; manual cron triggers only where E2E specs require them.
- Same Playwright `BASE_URL` routing through the gateway.

---

---

## 19. Staffing and Sprint Breakdown by Phase

### 19.1 Recommended team composition

| Role | FTE | Responsibilities |
|---|---|---|
| Go Platform Lead | 1 | Architecture, middleware, shared services, code review, CI/CD integration. |
| Senior Backend Engineers (Go) | 2 | Lead domain migrations, provider ports, cron engines, performance tuning. |
| Domain Engineers (full-stack, existing CRM knowledge) | 3–4 | Own module-specific behavior, verify business logic parity, update E2E specs where contract gaps are found. |
| QA Engineer | 1 | Contract snapshot harness, E2E mapping, load testing, regression triage. |
| DevOps / SRE | 1 | Hybrid deployment, gateway/Nginx config, observability, database capacity. |
| Engineering Manager / Tech Lead | 0.5–1 | Sprint planning, risk escalation, stakeholder communication, cutover decisions. |
| Security / Compliance reviewer | 0.25–0.5 | Audit logging, PII encryption, RBAC, tenant isolation reviews. |

**Total core team:** ~8–10 people full-time equivalent for the duration of the migration.

### 19.2 Sprint cadence and phase allocation

Assume 2-week sprints, 80% engineering capacity (accounting for meetings, PTO, support). Each sprint delivers 1–3 migrated modules plus shared infrastructure debt.

| Phase | Sprints | Modules/Sprints | Focus |
|---|---|---|---|
| Phase 0 | 2 sprints | Foundation + 2 read-only modules | `backend-go/` bootstrap, shared middleware, auth, `GET /api/health`, `GET /api/audit`, CI gates, contract harness. |
| Phase 1 | 4 sprints | 2–3 modules per sprint | Auth, contacts, leads, deals, tasks, projects, contracts, estimates, invoices, billing, expenses, payments, reports, dashboards. |
| Phase 2 | 4 sprints | 2–3 modules per sprint | Email, SMS, push, live chat, marketing, sequences, landing pages, chatbots, signatures, documents, surveys, file uploads, support, calendar. |
| Phase 3 | 5 sprints | 2 modules per sprint | Wellness vertical: patients, visits, prescriptions, POS, inventory, staff, attendance, leave, portal, wallet, wellness reports. |
| Phase 4 | 5 sprints | 2–3 modules per sprint | Travel vertical: itineraries, trips, quotes, invoices, suppliers, commissions, brochures, public pages, Razorpay/Stripe webhooks. |
| Phase 5 | 4 sprints | Admin, platform, final cutover | Super-admin, SCIM/SSO, settings, webhooks, WebSocket migration, final cutover, Node.js decommission. |
| Buffer / stabilization | 2 sprints | — | Bug fixes, performance tuning, documentation, training handoff. |

**Total: ~26 sprints = 52 weeks.** The earlier 48-week estimate assumed higher parallelization; the table above includes realistic review, testing, and buffer time.

### 19.3 Sprint rituals specific to the migration

- **Migration stand-up** (15 min, daily) — blockers per module, contract snapshot diffs, dual-write anomalies.
- **Contract review** (1 hr, per module before merge) — QA and a domain engineer sign off that the snapshot harness passes for the module.
- **Gateway registry update** (per sprint) — every merged module updates `config/routes.yaml` and the CI E2E mapping.
- **Mid-phase checkpoint** (half-day, end of Phase 1, 3, 4) — run full E2E against the hybrid stack, compare P95 latencies, review risk register.
- **Cutover readiness review** (1 day, end of Phase 5) — security, load test, rollback runbook, and on-call roster before flipping the default route.

### 19.4 Key milestone dates (example starting 2026-08-01)

| Milestone | Date | Deliverable |
|---|---|---|
| Phase 0 complete | 2026-08-15 | Go backend serves `/api/health`, `/api/status`, `/api/audit`, `/api/audit-viewer` in staging. |
| Phase 1 50% | 2026-10-15 | Core CRM modules (auth, contacts, leads, deals, tasks) live in production behind gateway. |
| Phase 1 complete | 2026-12-15 | All generic CRM modules migrated; Node backend only serves comms/wellness/travel/admin. |
| Phase 2 complete | 2027-02-15 | Communications and marketing migrated. |
| Phase 3 complete | 2027-05-01 | Wellness vertical migrated; PII encryption validated in production. |
| Phase 4 complete | 2027-07-15 | Travel vertical migrated; brochure engine integration stable. |
| Phase 5 complete | 2027-09-15 | Full Go-only API; Node.js decommissioned. |
| Stabilization end | 2027-10-15 | Runbooks, training, and post-mortem complete. |

---

## 20. Cost Estimate and Infrastructure Sizing

### 20.1 Personnel cost estimate (USD, annualized)

Assume blended fully-loaded engineering cost of $120k–$180k per FTE per quarter (salary + benefits + overhead). Use $150k per quarter as a midpoint.

| Cost bucket | FTE × duration | Estimate |
|---|---|---|
| Core engineering team | ~8.5 FTE × 13 months | ~$1.65M |
| QA + DevOps + security | ~2 FTE × 13 months | ~$390k |
| Manager/tech lead | ~1 FTE × 13 months | ~$195k |
| External Go training/consulting | one-time | ~$30k–$60k |
| **Total personnel** | | **~$2.3M–$2.4M** |

### 20.2 Infrastructure cost delta

During the migration the infrastructure runs **both** backends side-by-side, plus the gateway and contract-snapshot harness in CI.

| Component | Baseline (Node only) | Migration (Node + Go) | Go-only |
|---|---|---|---|
| API server instances | 2× t3.large / c6i.large | 2× Node + 2× Go (or 2× Go after Phase 1) | 2–3× Go |
| Database | MySQL 8 db.r6g.large | Same; consider read replica for dual-read load | Same or db.r6g.xlarge if load grows |
| Redis | Optional/small | Required for distributed rate limiting + permission cache | Required |
| CI runners | 4 parallel jobs | 6–8 parallel jobs (Go lint, unit, API, contract snapshots) | 6 parallel jobs |
| Contract snapshot storage | — | ~50–100 GB S3 / artifacts | Reduced after cutover |
| Load testing | Ad-hoc | Continuous k6 job | Continuous k6 job |

**Estimated monthly cloud cost delta during migration:** +$800–$1,500/month for compute, +$200–$400/month for CI, +$100/month for Redis. Total incremental run cost: **~$1.1k–$2k/month** for the 12–13 month migration window.

### 20.3 One-time tooling and migration costs

| Item | Cost | Notes |
|---|---|---|
| Go training (Udemy/Pluralsight + internal workshops) | $10k–$30k | Team-wide, including QA and DevOps. |
| External Go architect/consultant (optional) | $20k–$50k | For Phase 0 architecture review and code review. |
| Observability tooling | $5k–$15k | Add Go runtime metrics (pprof, Prometheus/Grafana, Sentry Go SDK). |
| Load testing / k6 Cloud | $2k–$5k | For sustained load tests during Phase 1 and 5. |
| Security audit | $15k–$40k | Pen-test the Go backend and hybrid gateway before final cutover. |
| **One-time total** | **$52k–$140k** | |

### 20.4 Sizing recommendations

- **API servers:** Start with 2× Go instances behind the existing Nginx. Go instances need fewer resources per request, but during the hybrid period the Node.js fleet must remain at current size. Plan for 2 additional Go instances.
- **Database:** Monitor `Threads_connected` and `Innodb_buffer_pool_reads`. If dual-write validation runs at 100% in staging, add a read replica for snapshot/validation queries. Production dual-write should be sampled (≤1%) to avoid load spikes.
- **Redis:** 1× cache.t3.micro or equivalent for rate-limit state and permission cache; upgrade to cache.t3.small if cross-instance traffic grows.
- **CI runners:** Add 2–3 additional runners to avoid queuing the new Go jobs alongside existing Node jobs.
- **Object storage:** Contract snapshots and load-test artifacts can grow; set a 90-day lifecycle policy on old artifacts.

### 20.5 Cost optimization opportunities

- Decommission Node.js instances as soon as a module is stable in Go to reduce the hybrid overlap period.
- Use the contract snapshot harness to reduce manual QA regression effort, offsetting some personnel cost.
- Run the Go backend on ARM Graviton instances (t4g/c7g) once validated for additional 20–40% compute savings.

---

## 21. Training and Onboarding Plan for Go

### 21.1 Audience and baseline assumptions

- Most of the team knows JavaScript/Node.js and Prisma; some know React.
- Target: all backend engineers, QA automation engineers, and DevOps engineers working on the migration should be productive in Go within 4–6 weeks.

### 21.2 Pre-kickoff (before Phase 0)

| Activity | Duration | Owner |
|---|---|---|
| Team-wide Go syntax + concurrency primer | 8 hrs | External trainer or senior Go engineer |
| `golang.org/x/tour` + exercises | 4–6 hrs | Self-paced |
| Internal session: Go vs Node.js differences (error handling, interfaces, goroutines, modules) | 2 hrs | Go Platform Lead |
| Code review of 3–5 idiomatic Go CRUD projects | 2 hrs | Self-paced |

### 21.3 Phase 0 embedded training

| Activity | Duration | Goal |
|---|---|---|
| Pair programming: shared middleware implementation | 2 weeks | Learn Echo/Gin, context patterns, middleware chaining. |
| Pair programming: JWT/RBAC port | 1 week | Learn `golang-jwt`, interfaces, mock-based testing. |
| Workshop: writing table-driven tests with `testify` | 2 hrs | Team comfortable with Go test patterns. |
| Workshop: GORM / Prisma Client Go basics | 2 hrs | Database access patterns, hooks, tenant scopes. |
| Workshop: `golangci-lint` and CI failure triage | 1 hr | Understand lint rules and how to fix them. |

### 21.4 Ongoing learning during migration

- **Weekly "Go office hours"** (1 hr) — open Q&A, review tricky ports, share patterns.
- **Migration journal** — maintain `backend-go/docs/LESSONS_LEARNED.md` with idiomatic Go patterns discovered during the port (e.g., how to replicate `Promise.all`, how to handle optional fields, JSON-string column handling).
- **Code review norms** — all Go PRs require at least one Go-experienced reviewer until Phase 2; after that, peer review is sufficient.
- **Pairing rotation** — rotate a domain engineer with a Go engineer every 2–3 sprints to spread knowledge.

### 21.5 QA and DevOps training

- **QA:** Learn to read Go test output, run `go test`, and extend the contract snapshot harness in Go.
- **DevOps:** Learn Go build process, Docker multi-stage builds, `pprof`, and Go-specific Sentry/APM integration.
- **Security reviewer:** Learn Go crypto packages (`crypto/aes`, `crypto/sha256`), SQL injection risks, and race detection.

### 21.6 Documentation and self-service resources

- `backend-go/docs/ONBOARDING.md` — environment setup, run commands, how to add a new route.
- `backend-go/docs/CODE_STYLE.md` — project-specific conventions (naming, error codes, middleware ordering, tenant scoping).
- `backend-go/docs/COMMON_PATTERNS.md` — ports of common Node.js patterns to Go (e.g., `async.eachLimit`, `lodash` utilities, Prisma `$transaction`).
- Recorded demos of Phase 0 modules for new hires joining mid-migration.

---

## 22. Detailed Risk Register Update

This expands the risk register in Section 10 with additional owner, trigger, and contingency detail.

| Risk | Impact | Likelihood | Owner | Trigger / Early Warning | Mitigation | Contingency |
|---|---|---|---|---|---|---|
| Subtle JSON envelope differences break frontend/mobile | High | High | Go Platform Lead | Snapshot harness diff > threshold for any migrated endpoint | Contract snapshot tests; keep Node.js fallback; literal Express → Go response mapping. | Revert route prefix to Node.js; fix handler; re-run E2E before re-enabling. |
| Middleware ordering differences cause auth/CSRF/rate-limit bypass | High | Medium | Security reviewer | Pen-test or E2E security spec failure | Replicate middleware order exactly; integration tests for security-sensitive paths; static audit. | Emergency rollback; security hotfix; post-incident review. |
| PII encryption incompatibility locks out existing wellness data | High | Low | Wellness domain engineer | Decryption test fails for existing rows | Byte-compatible AES-256-GCM hook; round-trip tests; staging restore from prod backup. | Disable Go wellness routes; restore Node.js handler; re-encrypt compatible rows with repair script. |
| WhatsApp Web (Puppeteer) cannot be ported to Go quickly | Medium | High | Comms domain engineer | `whatsapp-web.js` equivalent missing or unreliable in Go | Keep Node.js WhatsApp bridge service; migrate Cloud API first. | Extend Node bridge service timeline; re-scope WhatsApp Web as Phase 5 or later. |
| Razorpay webhook signature verification mismatch | High | Medium | Payments domain engineer | Staging webhook tests fail | Port verification algorithm exactly; test with real webhook payloads; compare signature at byte level. | Rollback to Node.js payments module; debug HMAC input ordering. |
| Stripe webhook signature verification mismatch | High | Medium | Payments domain engineer | Stripe dashboard shows failed webhooks or duplicate events | Record/replay real Stripe events; verify timestamp tolerance and payload reconstruction. | Rollback to Node.js; re-validate webhook endpoint ordering. |
| Cron engine idempotency bugs cause duplicate sends/charges | High | Medium | Go Platform Lead | Duplicate email/SMS/charge complaints or audit anomalies | Idempotency keys; execution logs; `DISABLE_CRONS=1` in E2E; manual trigger tests. | Stop cron engine; replay with idempotency check; reconcile affected accounts. |
| Performance gains not materializing due to DB bottleneck | Medium | Low | DevOps / SRE | Load test shows P95 similar to Node.js | Optimize queries before blaming runtime; add read replicas; use DB query profiling. | Focus optimization on N+1 queries; consider query caching; postpone Go rollout if not beneficial. |
| Talent/learning curve: team not familiar with Go | Medium | High | Engineering Manager | Low velocity or high review churn in Phase 0 | Training plan; pair programming; coding standards; `golangci-lint`. | Bring in external Go consultant; extend Phase 0 by 1 sprint. |
| Long-running branch diverges from `main` | High | High | Engineering Manager | Merge conflicts or missing features in Go branch | Merge small modules to `main` behind feature flags; never let Go branch lag >1 sprint. | Rebase/patch missing features; freeze new Node features for 1 sprint if needed. |
| Contract snapshot harness becomes a maintenance burden | Medium | Medium | QA Engineer | Snapshots fail frequently due to intentional UI changes | Separate "contract snapshots" (API) from "UI snapshots"; use redaction and tolerance rules. | Reduce snapshot frequency; rely more on E2E for UI-facing changes. |
| Go dependency supply-chain vulnerability | Medium | Medium | Security reviewer | `govulncheck` or Dependabot flags high/critical CVE | Pin versions; `go.sum` validation; vulnerability scan in CI; allowlist with sunset dates. | Patch or replace dependency; emergency release if exploitable. |
| Nginx gateway misroutes traffic during cutover | High | Low | DevOps / SRE | Smoke tests fail after route registry change | Automate registry validation; run smoke tests before every deploy; keep Node.js fallback. | Revert Nginx config; investigate prefix overlap; add literal-before-parametric checks. |
| Database connection pool exhaustion under hybrid load | Medium | Medium | DevOps / SRE | `Threads_connected` near limit; latency spikes | Conservative pool sizing; read replica; connection pooling in both backends. | Scale DB connections; temporarily reduce Go pool size; add read replica. |
| Socket.IO/WebSocket migration breaks real-time features | High | Medium | Comms domain engineer | Chat/notifications stop updating after Phase 5 | Defer WebSocket to final phase; test thoroughly with frontend team; maintain compatibility shim. | Keep Node.js Socket.IO server running as a dedicated service until client is migrated. |
| Travel brochure engine integration breaks | High | Low | Travel domain engineer | Brochure generation fails or returns wrong format | Keep `agentic-orchcrm/` workspace unchanged; test HTTP contract end-to-end. | Rollback travel brochures route; coordinate fix with agentic workspace owner. |

---

## 23. Detailed Migration of Specific Integrations

### 23.1 Stripe

**Current Node.js implementation:** `stripe` SDK v8+ used for payment intents, subscriptions, invoices, and webhook handling. Webhook signature verified with `stripe.webhooks.constructEvent`. Tenant resolved from `data.object.metadata.tenantId` or `data.object.subscription_details.metadata.tenantId`.

**Go migration plan:**

- Use `stripe/stripe-go/v81`.
- Create `internal/providers/stripe/client.go` with:
  - `CreatePaymentIntent(ctx, params)`
  - `CreateSubscription(ctx, params)`
  - `ConstructEvent(payload, sigHeader, secret)` — must reconstruct the raw request body exactly; use Echo's raw-body middleware for webhook paths.
  - `ListInvoices(ctx, params)`
- Preserve subscription billing cycle behavior (`monthly`/`annual`) as fixed in PR #1252.
- Preserve `metadata.tenantId` and `customer.email` mapping.
- Webhook handler must return `200` only after idempotency check; Stripe retries on non-2xx, so accidental duplicate processing is a real risk.
- Add record/replay tests with real Stripe webhook payloads from the Stripe CLI test events.

**Critical contract:** JSON shape of webhook event body must not be modified before signature verification; preserve raw body.

### 23.2 Razorpay

**Current Node.js implementation:** Direct HTTPS calls to `api.razorpay.com` with HMAC-SHA256 signature verification using `crypto.createHmac('sha256', secret).update(body).digest('hex')`. Tenant resolved from `payload.payment.entity.notes.tenantId`.

**Go migration plan:**

- Create `internal/providers/razorpay/client.go` because there is no official Go SDK.
- Implement `VerifyWebhookSignature(body, signature, secret)` using `crypto/hmac` + `sha256` exactly as Node.js does.
- Implement order creation, payment capture, refund, and subscription APIs using `net/http` with request signing via Basic Auth (`key_id:secret` base64).
- Preserve `notes.tenantId` and `notes.userId` in every order creation.
- Capture endpoint must be idempotent: check `Payment.status` before calling Razorpay capture.
- Add record/replay tests with real Razorpay test-mode payloads.

**Critical contract:** HMAC input is the exact raw request body string; any JSON parsing/re-serialization changes the signature.

### 23.3 WhatsApp Web (Puppeteer-based)

**Current Node.js implementation:** `whatsapp-web.js` launches a Puppeteer Chromium instance, scans a QR code, maintains a persistent session in `backend/.wwebjs_auth/`, and sends/receives messages through WhatsApp Web.

**Go migration options:**

| Option | Library | Maturity | Recommendation |
|---|---|---|---|
| A | `tulir/whatsmeow` | High | Primary target for Go port. Supports QR-pair, multi-device, message send/receive, media. |
| B | Keep Node.js bridge service | N/A | Fallback if `whatsmeow` does not support a required workflow (e.g., specific business API features). |
| C | Migrate to Meta Cloud API only | Official | Push customers to Cloud API numbers; deprecate WhatsApp Web where possible. |

**Recommended hybrid approach:**

1. Port the **Meta Cloud API** path to Go first (`backend/routes/whatsapp.js`, `whatsapp_webhook.js`). This covers most modern deployments.
2. Keep a **small Node.js WhatsApp Web bridge service** (`services/whatsapp-web-bridge/`) running alongside the Go backend for customers still using WhatsApp Web.
3. The Go backend calls the bridge service over HTTP for send/receive operations; the bridge service maintains the Puppeteer session.
4. Decommission the bridge only when all active tenants are migrated to Cloud API or `whatsmeow` is validated end-to-end.

**Critical contract:** Message templates, media upload URLs, and webhook verification must remain compatible with the existing frontend chat UI.

### 23.4 SendGrid / Email

**Current Node.js implementation:** SendGrid REST API via `@sendgrid/mail`, plus Nodemailer SMTP fallback, Mailgun. Multi-recipient sends return `{ totalSent, totalFailed, results, failures, email, messageId, delivered }`.

**Go migration plan:**

- Use `sendgrid/sendgrid-go` for REST.
- Use `net/smtp` for SMTP fallback.
- Preserve the multi-recipient envelope: count successes/failures, return per-recipient result list, keep top-level `email` and `messageId` for single-recipient callers.
- Preserve `categories`, `custom_args`, and `send_at` scheduling.
- Implement async retry with exponential backoff for transient failures.

**Critical contract:** The frontend relies on `delivered` boolean for single-recipient sends; do not break this field.

### 23.5 SMS (MSG91, Twilio, Fast2SMS)

**Current Node.js implementation:** `twilio` SDK for Twilio; direct HTTPS for MSG91 and Fast2SMS with request timeouts of 3–10 seconds. Provider response parsing is load-bearing.

**Go migration plan:**

- Twilio: use `twilio/twilio-go`.
- MSG91: custom `net/http` client with timeout, flow-based API support, and response parsing.
- Fast2SMS: custom `net/http` client.
- Preserve the multi-recipient envelope (`totalSent`, `totalFailed`, `results`, `failures`).
- Add request timeouts to avoid CI hang issues seen in `sms.test.js`.

**Critical contract:** Provider response parsing (e.g., MSG91's `type`, `message`, `data`) must match existing logic.

### 23.6 AI / LLM Providers

**Current Node.js implementation:** `llmRouter` selects Gemini, OpenAI, Anthropic, Perplexity, or Groq based on task. Tracks token cost and per-tenant budget caps.

**Go migration plan:**

- Use `google/generative-ai-go` for Gemini.
- Use `sashabaranov/go-openai` for OpenAI-compatible providers (OpenAI, Groq, Perplexity via base URL override).
- Use `anthropics/anthropic-sdk-go` for Anthropic if available; otherwise call REST directly.
- Implement a task router with the same priority rules as Node.js.
- Preserve cost tracking and budget enforcement.

**Critical contract:** Response JSON schema for deal insights, lead scoring, and sentiment must match the frontend's expectations.

### 23.7 S3 / File uploads

**Current Node.js implementation:** AWS SDK v3 for presigned PUT/GET URLs, multipart upload metadata, and key prefixing by tenant.

**Go migration plan:**

- Use `aws-sdk-go-v2/service/s3`.
- Generate presigned URLs with the same expiry (default 15 minutes) and key format (`tenant/<tenantId>/...`).
- Support multipart upload initiation/complete if used by large exports.
- Preserve ACL and content-type handling.

**Critical contract:** Existing uploaded files must remain accessible with the same keys; frontend upload logic must not change.

### 23.8 IMAP / Gmail

**Current Node.js implementation:** `imap` package for inbound email, `googleapis` for Gmail OAuth.

**Go migration plan:**

- Use `emersion/go-imap` for IMAP.
- Use `google.golang.org/api/gmail/v1` for Gmail.
- Preserve UID parsing, thread ID extraction, and attachment decode/forward logic.
- Maintain the same polling interval and backoff on connection errors.

**Critical contract:** Inbound email threading must not create duplicate email rows when the same UID is seen again.

---

*End of additional sections. The plan now covers staffing, cost, training, risk, and integration-specific migration detail.*


