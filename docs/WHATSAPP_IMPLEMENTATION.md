# WhatsApp Implementation — Backend & Frontend

> Companion to [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md). This document is the as-built reference: what exists in code, where, and how the pieces fit together. The PRD owns the *why*; this owns the *what* and *where*.

---

## 1. Architecture Overview

The CRM is a multi-tenant Meta Cloud API integration with three independent surfaces:

| Surface | Purpose | Primary Actors |
|---|---|---|
| **Outbound** | Tenant agents send templates / session messages | Agent UI → `/send` → `WaOutboundJob` → cron → Meta |
| **Inbound** | Meta delivers customer messages + status events | Meta → `/webhook` → `WebhookEvent` → dispatch → Socket.IO → UI |
| **Lifecycle** | Onboarding, token refresh, template sync, health | Admin UI → `/onboard/*` → encrypted `WhatsAppConfig`; daily crons keep it healthy |

Key design decisions:

- **Async dispatch.** Routes return `202 QUEUED` immediately; `whatsappOutboundEngine` cron does the actual Meta call. No request blocks on Meta latency.
- **Pessimistic locking** on jobs (`lockedAt`/`lockedBy`) so multiple workers can run safely on `WHATSAPP_QUEUE_DRIVER=db`.
- **Webhook routing by `phone_number_id`**, not tenantId. Meta has no concept of our tenant; we lookup `WhatsAppConfig.phoneNumberId` to derive `tenantId` on every inbound event.
- **Encrypted credentials at rest.** `WhatsAppConfig.accessToken` is AES-256-GCM encrypted via `lib/credentialMasking`; decrypted only inside cron/service code.
- **Idempotent webhook ingress.** `WebhookEvent (source, metaEventId)` unique index — Meta retries become 200 no-ops.

---

## 2. Backend

Root: [backend/](../backend/)

### 2.1 Routes

#### 2.1.1 [routes/whatsapp.js](../backend/routes/whatsapp.js) — Messaging, Threads, Templates, Config

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/whatsapp/send` | `verifyToken` | Send session text or template. Gated by opt-out + 24h re-engagement window. Returns `202 {success, messageId, status: "QUEUED", threadId}`. |
| GET | `/api/whatsapp/messages` | `verifyToken` | Paginated message log filtered by `direction, contactId, status`. |
| GET | `/api/whatsapp/threads` | `verifyToken` | Thread list with `assignedToId, status, unread, q` filters. Auto-wakes SNOOZED threads whose `snoozedUntil` has passed. PII-masked for low-trust viewers (#681). |
| GET | `/api/whatsapp/threads/:id` | `verifyToken` | Thread detail + last 50 messages, `optedOut` flag included. |
| POST | `/api/whatsapp/threads/:id/assign` | `verifyToken` | Self-assign open to all; cross-assign requires ADMIN/MANAGER. Body uses `targetUserId` (not `userId` — `stripDangerous` middleware strips that). |
| POST | `/api/whatsapp/threads/:id/close` | `verifyToken` | Mark thread `CLOSED`. |
| POST | `/api/whatsapp/threads/:id/snooze` | `verifyToken` | Snooze until ISO datetime (must be future). |
| POST | `/api/whatsapp/threads/:id/mark-read` | `verifyToken` | Zero `unreadCount`. |
| POST | `/api/whatsapp/threads/:id/rename-contact` | `verifyToken` | Create/update Contact name, link to thread. |
| POST | `/api/whatsapp/opt-outs` | `verifyToken` + ADMIN/MANAGER | Manual opt-out (DPDP §11). |
| GET | `/api/whatsapp/opt-outs` | `verifyToken` | List opt-outs filterable by phone. |
| DELETE | `/api/whatsapp/opt-outs/:id` | `verifyToken` + ADMIN | Re-opt-in. Requires `reason ≥10 chars`. Audit `WHATSAPP_OPT_IN_RESET`. |
| GET | `/api/whatsapp/templates` | `verifyToken` | List all templates. |
| POST | `/api/whatsapp/templates` | `verifyToken` | Create + submit to Meta (returns `PENDING`). |
| PUT | `/api/whatsapp/templates/:id` | `verifyToken` | Update body. |
| DELETE | `/api/whatsapp/templates/:id` | `verifyToken` | Delete local row (does not unsubmit from Meta). |
| POST | `/api/whatsapp/templates/:id/sync` | `verifyToken` | Pull approval status from Meta. |
| POST | `/api/whatsapp/templates/sync` | `verifyToken` + ADMIN/MANAGER | Bulk re-sync all templates. |
| GET | `/api/whatsapp/config` | `verifyToken` + ADMIN | Masked provider configs (#651). |
| PUT | `/api/whatsapp/config/:provider` | `verifyToken` + ADMIN | Upsert provider config; stamps `lastRotatedAt` + audit. |

**Sender gates (enforced in `/send` before queueing):**

1. **Opt-out gate** — lookup `WhatsAppOptOut` by E.164-normalized phone. Match → `422 CONTACT_OPTED_OUT`.
2. **24h re-engagement window** — if no `templateName`, require inbound message within last 24h (`WhatsAppThread.lastInboundAt`). Otherwise `422 OUTSIDE_24H_WINDOW`. Templates bypass.

#### 2.1.2 [routes/whatsapp_webhook.js](../backend/routes/whatsapp_webhook.js) — Inbound from Meta

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/whatsapp/webhook` | Verify challenge. Token resolution order: `META_VERIFY_TOKEN` env → per-tenant `WhatsAppConfig.webhookVerifyToken` (decrypted) → legacy `WHATSAPP_VERIFY_TOKEN`. Echo `hub.challenge` or 403. |
| POST | `/api/whatsapp/webhook` | Event ingress. Async pipeline (see §2.4). |

Subscribed Meta fields:

- `messages` — inbound messages + delivery status updates
- `message_template_status_update` — APPROVED / REJECTED / PAUSED / FLAGGED
- `message_template_quality_update` — HIGH / MEDIUM / LOW
- `phone_number_quality_update` — GREEN / YELLOW / RED
- `account_update` — restriction / ban / restore
- `business_capability_update` — messaging tier (`TIER_50` … `UNLIMITED`)
- `phone_number_name_update` — audit-only

#### 2.1.3 [routes/whatsapp_onboard.js](../backend/routes/whatsapp_onboard.js) — Embedded Signup

All routes gated by `WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true` (else `503 EMBEDDED_SIGNUP_NOT_APPROVED`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/whatsapp/onboard/exchange` | ADMIN | Step 1: code → token. Returns `202 {handoffId, tokenExpiresAt, scopes, neverExpires}`. Handoff stored in-memory, 10-min TTL. |
| POST | `/api/whatsapp/onboard/finalize` | ADMIN | Step 2: subscribeApp + registerPhone + encrypt+persist + trigger template sync. Returns `201 {success, configId, phoneNumberId, wabaId, tokenExpiresAt}`. |
| POST | `/api/whatsapp/onboard/disconnect` | ADMIN | Soft-disconnect: sets `disconnectedAt`, `isActive=false`, `webhookVerified=false`. Optionally unsubscribes from Meta. History preserved. |
| GET | `/api/whatsapp/onboard/status` | any role | Returns health state from `computeStatus()`. |
| GET | `/api/whatsapp/onboard/numbers` | ADMIN | Live Graph API call: list phone numbers on a WABA. |
| GET | `/api/whatsapp/onboard/config` | ADMIN | Masked `WhatsAppConfig` row. |
| POST | `/api/whatsapp/onboard/debug` | any role | Frontend → terminal log bridge (redacted). |

### 2.2 Service Layer — [services/whatsappProvider.js](../backend/services/whatsappProvider.js)

Thin wrapper over Meta Graph API (`v22.0` default, override with `META_GRAPH_VERSION`). All functions return `{success, providerMsgId?, error?}` or `{ok, data?, error?, code?}` shapes. `waLog()` is conditional on `WHATSAPP_DEBUG_LOG=true`; `waRedact()` strips `access_token`, `client_secret`, `pin`, `code` before any log.

**Messaging:** `sendTemplate`, `sendText`, `sendImage`, `sendDocument`, `sendInteractive`

**Media:** `downloadMediaUrl` (resolve Meta media ID → short-lived URL), `downloadMediaBytes` (follow 302, return Buffer)

**OAuth / token:** `exchangeCode`, `extendToken` (short → 60-day long-lived), `debugToken` (validate + get expiry + scopes)

**Webhook / config:** `subscribeApp`, `unsubscribeApp`, `registerPhone` (with 6-digit PIN), `listPhoneNumbers`, `listTemplates`, `submitTemplateToMeta`

Error classification: 4xx → parsed `error.message` / `error.error_user_msg`; 5xx → `HTTP {statusCode}`; network → `{success: false, error: <message>}`.

### 2.3 Lib Modules

| File | Purpose |
|---|---|
| [lib/whatsappQueue.js](../backend/lib/whatsappQueue.js) | Driver abstraction. Singleton selected by `WHATSAPP_QUEUE_DRIVER` (`"db"` default; `"bullmq"` falls back to db with warning). Interface: `enqueueSend`, `enqueueMedia`, `retryJob`, `killJob`, `stats`. Re-evaluates env per call so tests can rebind. |
| [lib/whatsappQueue.db.js](../backend/lib/whatsappQueue.db.js) | MySQL driver. Inserts `WaOutboundJob` / `WaMediaJob` with `PENDING`. `retryJob` resets `FAILED/DEAD → PENDING` and clears locks. `killJob` marks `DEAD` (preserves audit trail). |
| [lib/whatsappOnboardingService.js](../backend/lib/whatsappOnboardingService.js) | Embedded Signup orchestrator. `exchangeAndDebug()` runs code → token → extend → debug → scope check. `finalize()` runs subscribeApp → registerPhone (optional PIN) → encrypt → persist → sync templates in a single transaction. Failure codes: `META_CREDS_MISSING`, `META_AUTH_FAILED`, `TOKEN_DEBUG_FAILED`, `TOKEN_INVALID`, `SCOPE_MISSING`, `WEBHOOK_SUBSCRIBE_FAILED`, `PHONE_REGISTER_FAILED`, `PERSIST_FAILED`. Required scopes: `whatsapp_business_management`, `whatsapp_business_messaging`. |
| [lib/whatsappHealth.js](../backend/lib/whatsappHealth.js) | Pure `computeStatus(cfg)` function. Returns one of 9 states with `{status, label, severity, reason?, tokenExpiresAt?, daysUntilExpiry?}`. Precedence (most severe first): `NOT_CONNECTED` → `DISCONNECTED` → `TOKEN_EXPIRED` → `BUSINESS_RESTRICTED` → `QUALITY_RED` → `WEBHOOK_FAILED` → `EXPIRING_SOON` → `QUALITY_YELLOW` → `CONNECTED`. |

### 2.4 Webhook Pipeline — [middleware/metaWebhook.js](../backend/middleware/metaWebhook.js)

POST `/api/whatsapp/webhook` runs a strict 6-stage pipeline before the handler:

1. **`captureRawBody`** — `express.raw({type: 'application/json', limit: WEBHOOK_RAW_BODY_LIMIT || '2mb'})`. Must be raw bytes for HMAC.
2. **`verifySignature`** — HMAC-SHA-256 over raw bytes; `X-Hub-Signature-256: sha256=<hex>` header; constant-time compare. Production without `META_APP_SECRET` is FATAL (`503 META_APP_SECRET_MISSING`); dev logs warning and skips.
3. **`parseBody`** — `JSON.parse(Buffer)`. 400 on bad JSON.
4. **`routeToTenant`** — for each `entry[].changes[]`, lookup `WhatsAppConfig.phoneNumberId` to derive `tenantId`. Unknown phone → `WebhookEvent.status=IGNORED, tenantId=null` for audit.
5. **`ensureIdempotency`** — INSERT `WebhookEvent (source, metaEventId)`. On P2002 (unique violation): return 200 with `status=DUPLICATE`. `metaEventId` is `phoneNumberId + ':' + (msg.id | status.id)`.
6. **`respondImmediately`** — 200 `{received: true}` flushed before async processing.

**Inbound message processing** (async, after 200):

- Create `WhatsAppMessage (direction=INBOUND, status=RECEIVED)`
- Upsert `WhatsAppThread (tenantId, contactPhone)` — auto-reopens if `CLOSED`, bumps `lastMessageAt` + `lastInboundAt`, increments `unreadCount` if no assignee
- If media present → enqueue `WaMediaJob`
- STOP-keyword auto-detect → upsert `WhatsAppOptOut` + send confirmation reply
- Socket.IO broadcast `whatsapp:received` to `tenant:{tenantId}` room

**Status updates:** map `sent|delivered|read|failed` → uppercase; UPDATE `WhatsAppMessage.status` (looked up by `providerMsgId`); broadcast `whatsapp:status`.

### 2.5 Cron Engines

| File | Frequency | Purpose |
|---|---|---|
| [cron/whatsappOutboundEngine.js](../backend/cron/whatsappOutboundEngine.js) | every 30s | Reclaim stale `IN_FLIGHT` locks (>60s) → pick up to 100 `PENDING` jobs with `runAt ≤ now` → claim pessimistically → send via `sendText`/`sendTemplate` → update `WhatsAppMessage.status` + `WaOutboundJob.status` atomically. Retry: 5xx/429/network → backoff 1m/5m/15m/1h/6h then `DEAD`; 4xx (190) → `FAILED` (no retry). Per-phone tier throttle: `TIER_50→5`, `TIER_250→10`, `TIER_1K→25`, `TIER_10K→50`, `TIER_100K→100`, `UNLIMITED→100` per tick. |
| [cron/whatsappMediaEngine.js](../backend/cron/whatsappMediaEngine.js) | every 60s | Pick `PENDING WaMediaJob` (attempts < 3) → resolve Meta media ID → download bytes → upload to S3 (`whatsapp/{tenantId}/media/{jobId}.{ext}`) → update `WhatsAppMessage.mediaUrl`. Retry backoff 1m/5m/15m, then `FAILED`. Skips if `AWS_S3_BUCKET_NAME` unset. |
| [cron/whatsappTemplateSyncEngine.js](../backend/cron/whatsappTemplateSyncEngine.js) | daily 03:30 | Safety net for missed webhooks. Per active config: GET `/{wabaId}/message_templates?limit=200`, upsert `WhatsAppTemplate` rows (parse HEADER/BODY/FOOTER/BUTTONS components, set `qualityScore`, bump `lastSyncedAt`). Also exposed manually via `POST /api/whatsapp/templates/sync`. |
| [cron/whatsappTokenRefreshEngine.js](../backend/cron/whatsappTokenRefreshEngine.js) | daily 04:30 | Per active config with `tokenExpiresAt`: if expired → soft-disconnect + audit + notify; if ≤7 days → `fb_exchange_token` extend; else → no-op (bump `lastHealthCheckAt`). `tokenExpiresAt=null` (system user) → skip. Audit actions: `WHATSAPP_TOKEN_EXTENDED`, `WHATSAPP_TOKEN_EXPIRED`. |

### 2.6 Database Schema — [backend/prisma/schema.prisma](../backend/prisma/schema.prisma)

#### `WhatsAppMessage`
`id, to, from?, body?, mediaUrl?, mediaType?, direction (OUTBOUND), status (QUEUED), providerMsgId?, templateName?, errorMessage?, read, metaType?, interactiveJson? @db.Text, createdAt, tenantId, contactId? FK, userId? FK, threadId? FK`
Indexes: `(tenantId, createdAt)`, `(threadId, createdAt)`, `(providerMsgId)`, `(tenantId, status, createdAt)`

#### `WhatsAppThread`
`id, contactPhone, status (OPEN), lastMessageAt, lastInboundAt?, snoozedUntil?, unreadCount, labels?, tenantId, contactId? FK, patientId? FK, assignedToId? FK`
Unique: `(tenantId, contactPhone)` · Indexes: `(tenantId, status, lastMessageAt)`, `(assignedToId, status)`
Status: `OPEN | PENDING_AGENT | SNOOZED | CLOSED`

#### `WhatsAppOptOut`
`id, contactPhone, reason (USER_REQUESTED), capturedAt, notes? @db.Text, tenantId`
Unique: `(tenantId, contactPhone)`
Reasons: `USER_REQUESTED | STOP_KEYWORD | COMPLAINT | UNSUBSCRIBE_LINK`

#### `WhatsAppTemplate`
`id, name, language (en), category (MARKETING), headerType?, headerContent?, body @db.Text, footer?, buttons? @db.Text, status (PENDING), metaTemplateId?, qualityScore?, lastSyncedAt?, tenantId`
Unique: `(tenantId, name)`
Status: `PENDING | APPROVED | REJECTED | PAUSED | FLAGGED`

#### `WhatsAppConfig`
`id, provider, phoneNumberId? @unique, businessAccountId?, accessToken? @db.Text (AES-256-GCM), webhookVerifyToken?, isActive (false), settings? @db.Text, lastRotatedAt?, tokenExpiresAt?, qualityRating?, messagingLimitTier?, businessRestricted (false), webhookVerified (false), disconnectedAt?, onboardedAt?, lastHealthCheckAt?, tenantId`
Unique: `(tenantId, provider)` · Index: `(businessAccountId)`

#### `WaOutboundJob`
`id, messageId @unique FK, tenantId, status (PENDING), attempts (0), lastError? @db.Text, runAt, lockedAt?, lockedBy?`
Indexes: `(status, runAt)`, `(tenantId, status)`
Status: `PENDING → IN_FLIGHT → DONE | FAILED | DEAD`

#### `WaMediaJob`
`id, messageId @unique FK, tenantId, metaMediaId, mimeType?, status (PENDING), attempts (0), s3Url? @db.Text, lastError? @db.Text, processedAt?`
Indexes: `(status, createdAt)`, `(tenantId, status)`
Status: `PENDING → DONE | FAILED`

#### `WebhookEvent`
`id, source, metaEventId? @db.VarChar(200), tenantId?, rawPayload @db.LongText, signatureOk, status (RECEIVED), errorMessage?, receivedAt, processedAt?`
Unique: `(source, metaEventId)` — **idempotency gate**
Indexes: `(tenantId, receivedAt)`, `(status, receivedAt)`
Status: `RECEIVED | PROCESSED | FAILED | IGNORED | DUPLICATE`

### 2.7 Environment Variables

| Var | Consumer(s) | Default | Notes |
|---|---|---|---|
| `META_APP_ID` | `whatsappOnboardingService`, `whatsappTokenRefreshEngine` | unset | Required for P2 onboarding |
| `META_APP_SECRET` | `middleware/metaWebhook`, `whatsappOnboardingService`, `whatsappTokenRefreshEngine` | unset | **FATAL in production**; dev skips HMAC with warning |
| `META_VERIFY_TOKEN` | `whatsapp_webhook` | unset | Platform-wide; falls back to per-tenant token then legacy `WHATSAPP_VERIFY_TOKEN` |
| `META_GRAPH_VERSION` | `whatsappProvider` | `v22.0` | Bump every 6–12 months |
| `WEBHOOK_BASE_URL` | informational | — | HTTPS in production; ngrok in dev |
| `WEBHOOK_RAW_BODY_LIMIT` | `metaWebhook` | `2mb` | Raw body size cap for HMAC |
| `META_ES_CONFIG_ID` | informational (backend); also `VITE_META_ES_CONFIG_ID` (frontend) | — | Embedded Signup config |
| `META_SYSTEM_USER_TOKEN` | reserved | unset | Cross-tenant ops (future) |
| `WHATSAPP_EMBEDDED_SIGNUP_ENABLED` | `whatsapp_onboard`, `whatsappOnboardingService` | `false` | Set `true` after Meta App Review |
| `WHATSAPP_QUEUE_DRIVER` | `whatsappQueue` | `db` | `db` \| `bullmq` (stub) |
| `WHATSAPP_DEBUG_LOG` | provider, webhook, onboard, middleware | `false` | Verbose logs |
| `AWS_S3_BUCKET_NAME` | `whatsappMediaEngine` | unset | Media engine skips jobs if unset |

### 2.8 Tests

| File | Coverage |
|---|---|
| [test/routes/whatsapp.test.js](../backend/test/routes/whatsapp.test.js) | `/send` (opt-out + 24h window gates), threads (pagination, unread filter, snooze wake), assign RBAC, snooze future-check, opt-outs (reason validation), templates (name validation, Meta submission), config (ADMIN gate, masking), webhook (verify token, idempotency) |
| [test/services/whatsappProvider.test.js](../backend/test/services/whatsappProvider.test.js) | `sendTemplate`, `sendText`, `exchangeCode`, `extendToken`, `debugToken`, `subscribeApp`, `registerPhone`, `listTemplates`, `submitTemplateToMeta`, HMAC redaction, error classification |
| [test/lib/whatsappQueue.test.js](../backend/test/lib/whatsappQueue.test.js) | `enqueueSend`, `enqueueMedia`, `retryJob`, `killJob`, `stats`, driver fallback |
| [test/lib/whatsappOnboardingService.test.js](../backend/test/lib/whatsappOnboardingService.test.js) | `exchangeAndDebug` (scope validation), `finalize` (atomicity), `disconnect`, feature-flag gate |
| [test/lib/whatsappHealth.test.js](../backend/test/lib/whatsappHealth.test.js) | All 9 health states with precedence |
| [test/cron/whatsappOutboundEngine.test.js](../backend/test/cron/whatsappOutboundEngine.test.js) | Pessimistic locking, stale reclaim, retry classification, tier budgets |
| [test/cron/whatsappTokenRefreshEngine.test.js](../backend/test/cron/whatsappTokenRefreshEngine.test.js) | Never-expires skip, expired, expiring-soon extend, extend failure + debug probe |
| [test/cron/whatsappTemplateSyncEngine.test.js](../backend/test/cron/whatsappTemplateSyncEngine.test.js) | Graph call, upsert, component parsing, `qualityScore`, `lastSyncedAt` |

---

## 3. Frontend

Root: [frontend/src/](../frontend/src/)

### 3.1 Pages

#### 3.1.1 [pages/wellness/WhatsAppThreads.jsx](../frontend/src/pages/wellness/WhatsAppThreads.jsx) — Agent Inbox

The primary 2-way messaging surface. Mounted at `/wellness/whatsapp`. Open to ADMIN (full edit) and MANAGER/below (read-only status).

**Layout:** left rail thread list with search + status filter + unread checkbox; right pane thread header (contact name with inline rename, phone, assign dropdown, snooze/close/opt-out controls) + message history with delivery ticks + reply composer.

**API calls:**
- `GET /api/whatsapp/threads?limit=50[&status][&unread][&q]`
- `GET /api/whatsapp/threads/{id}` (returns thread + last 50 messages + `optedOut`)
- `POST /api/whatsapp/threads/{id}/mark-read` (auto-fired on open when `unreadCount > 0`)
- `POST /api/whatsapp/threads/{id}/assign` — body `{targetUserId}` (NOT `userId` — stripped by middleware)
- `POST /api/whatsapp/threads/{id}/rename-contact` — body `{name}`
- `POST /api/whatsapp/threads/{id}/close`
- `POST /api/whatsapp/threads/{id}/snooze` — body `{until: ISO}`
- `POST /api/whatsapp/send` (reply or new outbound)
- `POST /api/whatsapp/opt-outs`
- `GET /api/whatsapp/templates` (APPROVED only for picker)
- `GET /api/staff`, `GET /api/contacts?limit=200`, `GET /api/wellness/patients?limit=200` (pickers)

**State:** `threads`, `statusFilter`, `unreadOnly`, `q`, `selectedId`, `detail`, `reply`, `sending`, `showNewModal`, `newPhone`, `newBody`, `staff`, `templates`, `useTemplate`, `selectedTemplateName`, `templateParams`, `contactOptions`, `renaming`, `renameValue`. Refs: `lastSelectedMessageAtRef` (detect new inbound on open thread), `selectedIdRef` (stale-closure guard for socket handlers).

**Realtime** (lines ~325–435):
- `socket = io({withCredentials: true, transports: ['websocket', 'polling']})`
- Joins room `tenant:{tenantId}` on connect; re-joins on reconnect
- `whatsapp:received` → refresh list; if open thread matches, refresh detail; in-app toast + browser desktop notification (grouped by threadId)
- `whatsapp:status` → refresh detail if status update is for open thread
- 30-second polling fallback for socket drops

**Delivery ticks:** clock (QUEUED) → grey single check (SENT) → grey double check (DELIVERED) → blue double check (READ) → triangle (FAILED)

**Status pills:** OPEN (green) · PENDING_AGENT (amber) · SNOOZED (indigo) · CLOSED (grey)

#### 3.1.2 [pages/wellness/WhatsAppTemplates.jsx](../frontend/src/pages/wellness/WhatsAppTemplates.jsx) — Template Management

Mounted at `/wellness/whatsapp/templates`. ADMIN-only. Lists templates with status badge + category + language; create modal submits to Meta and tracks approval; manual "Sync from Meta" button.

**API:**
- `GET /api/whatsapp/templates`
- `POST /api/whatsapp/templates` — body `{name, language, category, body, header?, footer?}`. Name auto-formats to `lowercase_with_underscores`.
- `POST /api/whatsapp/templates/sync` (bulk)
- `DELETE /api/whatsapp/templates/{id}` (local only; does NOT unsubmit from Meta)

#### 3.1.3 [pages/Channels.jsx](../frontend/src/pages/Channels.jsx) — Settings → Channels → WhatsApp tab

ADMIN-only. Primary entry point for **Embedded Signup**. Embeds `<WhatsAppEmbeddedSignup compact={false} />` at the top of the WhatsApp tab.

**API:** `GET /api/whatsapp/config`, `GET/POST /api/whatsapp/templates`, `POST /api/whatsapp/send` (test message).

#### 3.1.4 [pages/Inbox.jsx](../frontend/src/pages/Inbox.jsx) — Unified Inbox (partial)

WhatsApp tab in the multi-channel inbox. "Compose WhatsApp" button opens a modal that POSTs to `/api/whatsapp/send`. Lists messages via `GET /api/whatsapp/messages` (raw log, not threads).

#### 3.1.5 [pages/wellness/BlockedNumbers.jsx](../frontend/src/pages/wellness/BlockedNumbers.jsx) — DPDP Opt-out Manager

ADMIN (unblock) + MANAGER+ (view). Manages opt-out list:
- `GET /api/whatsapp/opt-outs?limit=100[&phone]`
- `POST /api/whatsapp/opt-outs`
- `DELETE /api/whatsapp/opt-outs/{id}` — requires `reason ≥10 chars`

### 3.2 Components — [components/WhatsAppEmbeddedSignup.jsx](../frontend/src/components/WhatsAppEmbeddedSignup.jsx)

The sole shared component for the Meta OAuth flow + connection-status display. Used by `Channels.jsx` (full panel) and `WhatsAppThreads.jsx` (compact bar).

**Props:** `compact: boolean` (default `false`). Compact mode renders a slim status bar that auto-expands on errors and collapses when `CONNECTED`.

**Renders:**
- Status badge with severity colors (OK/INFO/WARN/ERROR)
- Configuration grid (when connected): Phone Number ID, WABA ID, quality rating, messaging tier, token expiry
- Primary CTA: "Connect WhatsApp Business" (ADMIN-only; disabled if `VITE_META_APP_ID` or `VITE_META_ES_CONFIG_ID` unset)
- Secondary CTAs: "Reconnect" (if expired / webhook failed), "Disconnect" (ADMIN, with confirmation)
- "Setup incomplete" warning when env vars missing, pointing to `docs/whatsapp-saas/SETUP.md`

**Globals consumed:**
- `window.FB` — Meta JS SDK, lazy-loaded from `https://connect.facebook.net/en_US/sdk.js` on first "Connect" click
- `window.Notification` — desktop notification permission requested on mount
- `window.addEventListener('message')` — listens for postMessage from facebook.com carrying `waba_id` + `phone_number_id`

**Flow:**
1. User clicks Connect → SDK loads → `FB.login(callback, {config_id, response_type: 'code', override_default_response_type: true, extras: {sessionInfoVersion: '3', ...}})`
2. postMessage from FB carries `{waba_id, phone_number_id}`; callback carries `{authResponse: {code}}`
3. POST `/api/whatsapp/onboard/exchange` with `{code, wabaId, phoneNumberId}` → `{handoffId, tokenExpiresAt, scopes, neverExpires}`
4. Optional PIN prompt for phone registration
5. POST `/api/whatsapp/onboard/finalize` with `{handoffId, registerPin?}` → `{success, configId, phoneNumberId, wabaId, tokenExpiresAt}`
6. Refresh status

**Safety:**
- Authorization `code` redacted in all logs (console + `/api/whatsapp/onboard/debug`)
- Validates `sessionInfoVersion: '3'` in extras
- Detaches postMessage listener on unmount via `messageListenerRef`

### 3.3 API Client

There is **no shared WhatsApp service layer**. All `/api/whatsapp/*` calls are inline in component `useEffect` hooks or event handlers, using the generic helper [utils/api.js → `fetchApi(url, options)`](../frontend/src/utils/api.js). `fetchApi` injects `Authorization` + `X-Active-Tenant` headers and auto-toasts errors unless `{silent: true}` is passed.

### 3.4 Routing — [App.jsx](../frontend/src/App.jsx)

```jsx
const WellnessWhatsAppThreads   = lazy(() => import("./pages/wellness/WhatsAppThreads"));
const WellnessWhatsAppTemplates = lazy(() => import("./pages/wellness/WhatsAppTemplates"));

<Route path="wellness/whatsapp"           element={<WellnessOnly><WellnessWhatsAppThreads /></WellnessOnly>} />
<Route path="wellness/whatsapp/templates" element={<WellnessOnly><WellnessWhatsAppTemplates /></WellnessOnly>} />
```

Nav entry points:
- WhatsAppThreads header → "Templates" link (ADMIN)
- WhatsAppThreads header → "+ New" outbound compose
- Channels tab strip → "WhatsApp" tab
- Inbox compose actions → "Compose WhatsApp"

### 3.5 Tests — [__tests__/WhatsAppThreads.test.jsx](../frontend/src/__tests__/WhatsAppThreads.test.jsx)

Vitest suite (~702 lines) pinning thread list render · All/Unread/Blocked tabs · search · detail open · reply send · assign-to-me · close/snooze · opt-out reply gate · 24-hour window banner · template picker · delivery ticks. Mocks `/api/whatsapp/*` and verifies query strings + body shapes (e.g., `targetUserId` not `userId` for assign).

### 3.6 i18n

**No WhatsApp i18n keys** — all UI text is hardcoded English in JSX. `en.json`, `es.json`, `hi.json` have no `whatsapp.*` keys. Localization is an open item.

### 3.7 Frontend Environment Variables

Defined in [components/WhatsAppEmbeddedSignup.jsx:30-32](../frontend/src/components/WhatsAppEmbeddedSignup.jsx#L30-L32):

| Var | Default | Purpose |
|---|---|---|
| `VITE_META_APP_ID` | — | Meta App ID for OAuth (safe to bundle) |
| `VITE_META_ES_CONFIG_ID` | — | Embedded Signup config ID from Meta (safe to bundle) |
| `VITE_META_GRAPH_VERSION` | `v22.0` | Graph API version |

Missing vars → "Setup incomplete" banner and Connect button disabled.

---

## 4. End-to-End Flows

### 4.1 Outbound (Agent Sends a Template)

```
Agent UI (WhatsAppThreads.jsx "+ New")
  → POST /api/whatsapp/send {to, templateName, parameters}
    → opt-out gate (WhatsAppOptOut lookup)
    → 24h window gate (templates bypass)
    → WhatsAppMessage.create(status=QUEUED)
    → WaOutboundJob.create(status=PENDING)
    ← 202 {messageId, status: "QUEUED", threadId}

[every 30s] whatsappOutboundEngine cron
  → reclaim stale IN_FLIGHT locks
  → claim up to 100 PENDING jobs (pessimistic UPDATE)
  → decrypt accessToken from WhatsAppConfig
  → check tier budget per phoneNumberId
  → provider.sendTemplate({to, templateName, language, parameters, phoneNumberId, accessToken})
    → POST graph.facebook.com/v22.0/{phoneNumberId}/messages
  → on success: WhatsAppMessage.status=SENT, WaOutboundJob.status=DONE
  → on 5xx/429: backoff (1m/5m/15m/1h/6h), then DEAD
  → on 190 (auth): FAILED + tokenRefresh picks up

[later] Meta delivery webhook
  → POST /api/whatsapp/webhook (statuses[])
  → verify HMAC, idempotency
  → UPDATE WhatsAppMessage.status (SENT → DELIVERED → READ)
  → Socket.IO whatsapp:status → tenant:{tenantId} room
  → Agent UI updates delivery tick in real-time
```

### 4.2 Inbound (Customer Replies)

```
Customer sends WhatsApp message
  → Meta POST /api/whatsapp/webhook
  → captureRawBody → verifySignature (HMAC SHA-256)
  → parseBody → routeToTenant (lookup phoneNumberId → tenantId)
  → ensureIdempotency (INSERT WebhookEvent; P2002 → 200 DUPLICATE)
  → respondImmediately (200 {received: true})

[async] processEvent
  → for each value.messages[]:
    → WhatsAppMessage.create(direction=INBOUND, status=RECEIVED)
    → WhatsAppThread.upsert(tenantId_contactPhone)
      → auto-reopen if CLOSED
      → bump lastMessageAt + lastInboundAt
      → increment unreadCount if no assignee
    → if media: WaMediaJob.create(metaMediaId, mimeType)
    → if STOP keyword: WhatsAppOptOut.create + send confirmation
    → Socket.IO whatsapp:received → tenant:{tenantId} room

[every 60s] whatsappMediaEngine cron
  → pick PENDING WaMediaJob
  → resolve metaMediaId → short-lived URL via Graph API
  → download bytes (follow 302)
  → upload to S3: whatsapp/{tenantId}/media/{jobId}.{ext}
  → UPDATE WhatsAppMessage.mediaUrl + WaMediaJob.status=DONE

[Agent UI] WhatsAppThreads.jsx
  → whatsapp:received → refresh list + detail
  → in-app toast + desktop notification (if page hidden)
  → 30s polling fallback if socket drops
```

### 4.3 Onboarding (Tenant Admin Connects Meta)

```
Admin opens Settings → Channels → WhatsApp tab
  → WhatsAppEmbeddedSignup mounts
  → GET /api/whatsapp/onboard/status → "NOT_CONNECTED"

Admin clicks "Connect WhatsApp Business"
  → lazy-load FB SDK (https://connect.facebook.net/en_US/sdk.js)
  → FB.init({appId: VITE_META_APP_ID, version: 'v22.0'})
  → FB.login(cb, {config_id: VITE_META_ES_CONFIG_ID, response_type: 'code', ...})
  → Meta popup → user selects WABA + phone number
  → postMessage from facebook.com → {waba_id, phone_number_id}
  → cb({authResponse: {code}})

POST /api/whatsapp/onboard/exchange {code, wabaId, phoneNumberId}
  → exchangeCode(code) → short-lived token
  → extendToken(token) → 60-day long-lived
  → debugToken(token) → {is_valid, expires_at, scopes, user_id}
  → verify scopes: whatsapp_business_management, whatsapp_business_messaging
  → store in-memory handoffStore[handoffId] (10-min TTL)
  ← 202 {handoffId, tokenExpiresAt, scopes, neverExpires}

[optional] Admin enters phone registration PIN

POST /api/whatsapp/onboard/finalize {handoffId, registerPin?}
  → subscribeApp(wabaId, token) (tolerate "already subscribed")
  → registerPhone(phoneNumberId, token, pin) (if PIN; tolerate "already registered")
  → encrypt token (AES-256-GCM)
  → upsert WhatsAppConfig (isActive=true, onboardedAt=now, webhookVerified=true)
  → deactivate sibling providers
  → trigger template sync (best-effort)
  → audit: WHATSAPP_CONNECT
  ← 201 {success, configId, phoneNumberId, wabaId, tokenExpiresAt}

GET /api/whatsapp/onboard/status → "CONNECTED"
  → UI updates status badge + shows config grid
```

### 4.4 Lifecycle (Daily Maintenance)

```
[daily 03:30] whatsappTemplateSyncEngine
  → per active WhatsAppConfig:
    → listTemplates(wabaId, accessToken, limit=200)
    → upsert WhatsAppTemplate by (tenantId, name)
    → set status, qualityScore, lastSyncedAt

[daily 04:30] whatsappTokenRefreshEngine
  → per active WhatsAppConfig with tokenExpiresAt:
    → if expiresAt ≤ now: soft-disconnect + audit + Notification
    → if ≤ now + 7d: extendToken → debugToken → update tokenExpiresAt + lastRotatedAt
    → else: bump lastHealthCheckAt
```

---

## 5. Cross-Cutting Concerns

**Multi-tenancy.** Tenant scope is the composite key on everything: `(tenantId, contactPhone)`, `(tenantId, provider)`, `(tenantId, name)`. Webhook routing flips this — Meta has no tenant concept, so `WhatsAppConfig.phoneNumberId` is globally unique and used as the lookup key to derive `tenantId` for every inbound event.

**Credential management** (#651). All sensitive fields encrypted at rest via `lib/credentialMasking` (AES-256-GCM). Routes return masked shapes (`{configured: true, last4: "****"}`). Decryption happens only inside cron/service code. `PUT /config` stamps `lastRotatedAt` + emits audit row.

**PII masking** (#681). Thread list / detail responses mask `contactPhone`, `Contact.name`, `Contact.email` for low-trust viewers (USER, wellness telecaller). Every unmasked disclosure to ADMIN/MANAGER emits an audit row.

**Compliance** (DPDP §11, TRAI):
- Opt-out gate before every send (`422 CONTACT_OPTED_OUT`)
- STOP-keyword auto-detect on inbound + auto-opt-out
- Re-opt-in requires written reason ≥10 chars (audit trail)
- 24h re-engagement window enforced (`422 OUTSIDE_24H_WINDOW`)

**Webhook idempotency.** `WebhookEvent (source, metaEventId)` unique index. Meta retries become 200 no-ops with `status=DUPLICATE`. Forensic record preserved (raw payload stored).

**Async-first delivery.** All sends return `202 QUEUED`; cron does the Meta call. Socket.IO + 30s polling fallback keep UI fresh. No request blocks on Meta latency.

**Health monitoring.** Daily token refresh probe auto-disconnects expired tokens. Phone quality (GREEN/YELLOW/RED) and business restriction state tracked via webhooks; surfaced in `computeStatus()` → frontend status badge.

---

## 6. Open Items

- **Frontend i18n.** WhatsApp UI strings are hardcoded English; no `whatsapp.*` keys in `en.json/es.json/hi.json`.
- **Shared API helper.** All `/api/whatsapp/*` calls inline in components; no centralized service module.
- **BullMQ driver.** `WHATSAPP_QUEUE_DRIVER=bullmq` is a stub that falls back to `db` with a warning.
- **System User token.** `META_SYSTEM_USER_TOKEN` reserved for cross-tenant ops; not yet wired.
- **Manual token-paste fallback.** Available behind `EMBEDDED_SIGNUP_NOT_APPROVED` when Meta App Review pending.
