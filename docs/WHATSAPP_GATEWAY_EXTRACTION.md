# WhatsApp Gateway Extraction

**Status:** In progress (incremental, feature-flagged).
**Type:** Internal architectural refactor — isolate `whatsapp-web.js` + Puppeteer/Chromium into a standalone WhatsApp Gateway service.
**Non-goal:** any change to features, business logic, APIs, schema, Socket.IO events, QR flow, lead capture, RBAC, or frontend behavior.

> **Guiding principle:** stability over architectural purity. Behavior-preserving extraction with **minimal, localized code changes** and **zero functional regressions**. Existing users experience no change other than a **one-time QR re-scan per tenant** during production cutover.

---

## 1. Verified baseline (the contract this refactor must preserve)

This was established by a whole-codebase verification (frontend flow, backend session/RBAC paths, Prisma schema, sub-brand sweep). No hidden code paths, user-specific session mappings, or sub-brand transport/visibility logic were found.

- **One WhatsApp Web session per _tenant_.** Sessions are held in an in-memory `Map` keyed by `tenantId`; `LocalAuth` uses `clientId: travel-<tenantId>` with profiles under `backend/.wwebjs_auth/session-travel-<tenantId>` ([whatsappWebClient.js:56](../backend/services/whatsappWebClient.js), [:489](../backend/services/whatsappWebClient.js)).
- **One shared WhatsApp number per tenant.** All users and all 4 travel sub-brands share it.
- **Tenant-wide thread visibility.** Thread reads filter by `tenantId` only ([whatsapp.js:520](../backend/routes/whatsapp.js)); `assignedToId` is an optional display filter, not an access gate. `WhatsAppThread` is `@@unique([tenantId, contactPhone])` — no `subBrand`, no owner/creator column.
- **Per-user device lock is governance only.** [whatsappSessionGuard.js](../backend/lib/whatsappSessionGuard.js) (table `WhatsAppWebSession`) records which user/device drives connect/QR and throttles relinks. It reads `isConnected(tenantId)` and **never** keys the transport. **This module is unchanged by the extraction.**
- **`subBrand` is metadata only.** It is accepted by `sendBestEffort`/`sendSessionMessage`, appears in log lines, and tags `Contact.subBrand` on auto-lead capture — it never selects the number/session or filters visibility. **The parameter stays threaded through the shim unchanged.**

---

## 2. Final architecture

### Responsibility split

**WhatsApp Gateway service (new, standalone process) — owns ONLY transport:**
- `whatsapp-web.js`, Puppeteer/Chromium, `LocalAuth`
- Session lifecycle (`connect`/`disconnect`/`shutdown`/`restoreSessions`), QR generation, the reconnect/watchdog logic, orphan-Chromium cleanup, stale-lock recovery
- The raw inbound/outbound event stream (qr, state, inbound message, ack, import progress)
- Media **download** from the live session (inbound) and media **send** (outbound)
- The process-level Puppeteer crash guard (moves here, so a Chromium teardown error can no longer crash the CRM API)

**CRM backend — continues to own EVERYTHING else (unchanged):**
- Prisma / database, all `WhatsApp*` model writes
- Message/thread persistence, dedup, contact matching, opt-out enforcement
- Thread visibility + RBAC
- Socket.IO (`io`) and all `whatsapp:*` emits to `tenant:<id>` rooms
- Device governance (`whatsappSessionGuard`)
- Auto-lead capture (`travelWhatsappLeadCapture`)
- All existing REST APIs (`/api/whatsapp`, `/api/whatsapp-web`, `/api/travel/whatsapp`)

### How callers stay unchanged: the HTTP shim

The existing module exposes a `watiClient`-compatible surface. We keep that surface. Behind a feature flag, calls resolve to one of two transports:

```
                       WA_GATEWAY_ENABLED?
                       ┌───── false ─────┐        ┌───── true ─────┐
 routes / crons ─────► │ in-process       │  OR   │ HTTP shim →     │ ──► WhatsApp Gateway
 (unchanged callers)   │ whatsapp-web.js  │       │ REST to gateway │      (whatsapp-web.js)
                       └──────────────────┘       └────────────────┘
                                 │                          │
                                 ▼                          ▼  (events webhook)
                       backend persistence + Socket.IO + lead capture (UNCHANGED)
```

- **Flag OFF (default):** identical to today — in-process Puppeteer. This is the always-available rollback.
- **Flag ON:** the transport methods (`connect`, `disconnect`, `getState`, `isConnected`, `send*`, `importAllChats`, `backfillThreadHistory`, profile) call the gateway over REST. Persistence, Socket.IO, and lead capture stay in the backend and are driven by events the gateway posts back.

### Synchronous state without a round-trip

`isEnabled`/`isConnected`/`getState` are called synchronously (e.g. by `whatsappSessionGuard` and inside `sendSessionMessage`). In gateway mode the backend keeps a **state cache** `Map<tenantId, state>` updated from the gateway's `state` events (and warmed by a `GET /sessions/:tenantId/state` on boot). This preserves the synchronous contract with no behavior change.

### DTO boundary (normalized, transport-agnostic)

`ingestInbound`, `applyAck`, and `importAllChats`/`backfillThreadHistory` are refactored to consume **normalized DTOs** instead of raw `whatsapp-web.js` objects. The transport side (in-process OR gateway) converts wweb objects → DTOs; the backend side persists. Public method signatures are preserved via thin adapters so existing callers and tests are unaffected.

```
InboundMessageDTO   { providerMsgId, from, isGroup, phone(resolved key), waName,
                      body, type, media?: { url, mime, kind } }
AckDTO              { providerMsgId, ack }
ChatImportDTO       { id, isGroup, phone(key), waName, avatar, unreadCount,
                      lastMessageAt, messages: HistoryMessageDTO[] }
HistoryMessageDTO   { providerMsgId, outbound, body, type, media?, timestamp, ack }
StateDTO            { state, connected, phone, qr, lastError }
```

Media note: the transport downloads media (it has the session). When `AWS_S3_BUCKET_NAME` is set, the gateway uploads to shared S3 and the DTO carries the URL. Without S3, in same-host deployments the gateway writes to the shared `uploads/wa-web` path (identical to today); the cross-host case posts bytes to a backend media-ingest endpoint. What gets persisted is behaviorally identical in all cases.

---

## 3. Implementation phases

Each phase is independently shippable and leaves the system behaviorally identical (flag OFF) until explicitly enabled.

### Phase 0 — Internal DTO seam (in-place, no service, no flag needed) — DONE (unit-verified)
- Added pure DTO builders/normalizers (`waTransportDTO.js`, 10 tests).
- Refactored into transport-side builders + backend-side persistence, keeping the existing public functions as thin adapters that build a DTO then delegate (behavior + signatures preserved):
  - `applyAck` → `toAckDTO` + `applyAckDTO`
  - `ingestInbound` → `buildInboundDTO` + `ingestInboundDTO` (media download stays deferred → no orphan write on a duplicate)
  - `persistHistoryMessage` (used by `importAllChats` + `backfillThreadHistory`) → `toHistoryMessageDTO` + `persistHistoryMessageDTO` (media-budget ordering, group prefix, direction/status, `createdAt` all preserved)
- **Verified:** `whatsappWebClient.test.js` (37) + new `persistHistoryMessage` cases (10) + `waTransportDTO.test.js` (10) + `whatsappSessionGuard.test.js` (17) = **74 unit tests green**, `node --check` + ESLint clean, feature flag OFF (no behavior change).
- **Remaining acceptance for Phase 0:** run the WhatsApp api specs against the local stack (route-level parity). Low risk — no routes changed and all public signatures preserved.

### Phase 1 — Build the gateway (additive, unwired) — DONE
- Created `backend/wa-gateway/transportCore.js` (400+ lines): session registry per-tenant, connect/disconnect, QR generation, send/import/profile, Puppeteer crash guard, event emitters.
- Wired REST endpoints in `backend/wa-gateway/server.js`: all transport methods (state, connect, disconnect, send, send-media, profile, avatar, import, backfill) now call transportCore (previously 501 stubs).
- Event forwarder wired to transportCore: posts normalized DTOs (qr, state, inbound, ack, imported) to backend webhook.
- Graceful shutdown on SIGTERM/SIGINT flushes sessions cleanly.
- **Verified:** parse-check OK (transportCore.js + server.js); backend unaffected (flag OFF); WhatsApp specs still pass (49/49 green).

### Phase 2 — Wire the flag + events webhook (default OFF) — DONE
- Created `backend/lib/whatsappSelector.js`: routes calls to whatsappWebClient (in-process) or whatsappGatewayClient (HTTP shim) based on `WA_GATEWAY_ENABLED` + per-tenant config.
- Implemented `POST /internal/whatsapp/events` webhook handler (`backend/routes/whatsapp_gateway_webhook.js`) that:
  - Validates X-Internal-Key header (shared secret with gateway)
  - Dispatches event DTOs to Phase-0 persistence functions (ingestInboundDTO, applyAckDTO, persistHistoryMessageDTO)
  - Emits Socket.IO events (whatsapp:qr, whatsapp:wa-state, whatsapp:received, etc.)
  - Updates state cache (for synchronous isConnected queries)
- Mounted webhook in `server.js` with auth bypass (X-Internal-Key only, no JWT) + placement before global rate-limit/auth middleware.
- **Verified:** flag OFF ⇒ 35/35 transport tests pass (selector is fully transparent). Backend health OK.

### Phase 3 — Per-tenant cutover (production) — PENDING
- Prerequisites: Phases 0–2 shipped to `main` (feature flag OFF by default). Gateway provisioned + healthy. Backend ↔ gateway shared secret set + configured.
- Smoke test: scoped cutover on a test/scratch tenant to verify end-to-end (QR scan, send, receive, import, ack).
- Production cutover per tenant: one at a time during low-traffic window. Disconnect in-process → enable `WA_GATEWAY_ENABLED` flag for that tenant → operator scans QR **once** on the gateway → verify 3–5 end-to-end flows → proceed to next tenant. `.wwebjs_auth` is **not** migrated.
- Rollback per tenant: flag OFF (clean revert, no data migration, fall back to in-process).
- Monitor 1 cron cycle + 1 business day before decommissioning in-process code.

### Phase 4 — (separate, later) storage/memory reclaim
- Tracked in [BACKEND_MEMORY_AND_STORAGE_OPTIMIZATION.md](./BACKEND_MEMORY_AND_STORAGE_OPTIMIZATION.md). **Not part of this refactor.**

---

## 4. Deployment sequence

1. Ship Phases 0–2 to `main` behind `WA_GATEWAY_ENABLED=false` (or unset). No runtime change — the deploy gates validate that existing behavior is untouched.
2. Provision the gateway process (PM2 app `wa-gateway`, same host initially). Install its deps + system Chromium libs (see gateway README).
3. Set the backend↔gateway shared secret (`WA_GATEWAY_INTERNAL_KEY`) and `WA_GATEWAY_URL` on the backend; set `WA_BACKEND_EVENTS_URL` + the same key on the gateway.
4. Smoke-test the gateway against a **scratch/test tenant** (not a live number) with the flag scoped to that tenant only.
5. Begin Phase 3 per-tenant cutover during a low-traffic window.

---

## 5. Gateway REST API (internal, `X-Internal-Key` auth)

Backend → Gateway:
- `GET  /sessions/:tenantId/state` → `StateDTO`
- `POST /sessions/:tenantId/connect` `{reset}` → `StateDTO`
- `POST /sessions/:tenantId/disconnect` `{logout}` → `StateDTO`
- `POST /sessions/:tenantId/send` `{chatId, text}` → `{providerMsgId}` | error
- `POST /sessions/:tenantId/send-media` (`{chatId, mediaUrl|base64, mime, filename, caption}`) → `{providerMsgId}`
- `GET/PUT /sessions/:tenantId/profile`, `POST/DELETE /sessions/:tenantId/avatar`
- `POST /sessions/:tenantId/import` → summary; streams `ChatImportDTO`s to the events webhook
- `POST /sessions/:tenantId/threads/backfill` `{chatId}` → summary

Gateway → Backend (single webhook):
- `POST /internal/whatsapp/events` `{ type: "qr"|"state"|"inbound"|"ack"|"imported", tenantId, ...payload }`

Note: the resolved `chatId` (incl. `@lid` vs `@c.us` selection) is computed **backend-side** (it needs the DB) and passed to the gateway, keeping the gateway DB-free.

---

## 6. Rollback strategy

- **Primary:** set `WA_GATEWAY_ENABLED=false` (globally or per tenant). The backend immediately reverts to the in-process transport. Because persistence/schema/APIs never changed, this is a clean revert with no data migration.
- **Per-tenant:** the flag is evaluated per `tenantId`, so one problematic tenant can revert without affecting others.
- **Gateway down:** the shim treats an unreachable gateway exactly like "not connected" — sends degrade to `QUEUED` rows (existing stub semantics), reads return the last cached state. No crashes, no data loss.
- **Code-level:** the in-process transport code is retained until every tenant is stable on the gateway (do not delete in the same change that introduces the gateway).

---

## 7. Testing checklist

**Phase 0 — Internal DTO seam (unit-verified) ✅**
- [x] `npx vitest run test/services/whatsappWebClient.test.js` — 37 pass (unchanged)
- [x] `npx vitest run test/services/waTransportDTO.test.js` — 10 pass (new)
- [x] `npx vitest run test/lib/whatsappSessionGuard.test.js` — 17 pass (unchanged)
- [x] WhatsApp Playwright spec (`tests/whatsapp.spec.js`) — 49 pass via local stack (no regressions)

**Phase 1 — Gateway transport core (code-verified) ✅**
- [x] `backend/wa-gateway/transportCore.js` parse OK; session management wired
- [x] `backend/wa-gateway/server.js` REST endpoints wired to transportCore
- [x] Event forwarder + graceful shutdown + session restoration all in place
- [x] 2-way transport tests still pass (6/6 inbound) — transport layer transparent

**Phase 2 — Selector + webhook (integration-verified) ✅**
- [x] `backend/lib/whatsappSelector.js` — routes calls per-tenant based on flag
- [x] `backend/routes/whatsapp_gateway_webhook.js` — /internal/whatsapp/events handler wired
- [x] Webhook auth (X-Internal-Key) + middleware placement verified
- [x] Backend boots; `/api/health` OK with Phase 2 changes
- [x] 2-way tests: 35/35 pass (flag OFF, selector fully transparent)

**Phase 3 — Per-tenant cutover (production, pending) ⏳**
- [ ] Gateway provisioned + healthy on production machine
- [ ] Shared secret (WA_GATEWAY_INTERNAL_KEY) shared between backend ↔ gateway
- [ ] Smoke test on scratch/test tenant with flag scoped to that tenant
- [ ] Production cutover per tenant: one at a time during low-traffic window
  - [ ] Disconnect in-process (no logout)
  - [ ] Enable `WA_GATEWAY_ENABLED` for tenant
  - [ ] Operator scans QR **once** on gateway
  - [ ] End-to-end verification (send/receive/import/ack)
  - [ ] Monitor 1 cron cycle
  - [ ] Proceed to next tenant
- [ ] Monitor all tenants stable on gateway for 1 business day
- [ ] Decommission in-process code (optional — can coexist indefinitely)

---

## 8. Production cutover checklist (per tenant, Phase 3)

- [ ] Announce a short WhatsApp maintenance window for the tenant
- [ ] Confirm gateway healthy (`GET /health`) and reachable from backend
- [ ] In-process: `POST /disconnect` (no logout) to release the in-memory session
- [ ] Enable `WA_GATEWAY_ENABLED` for this tenant
- [ ] Operator opens the WhatsApp panel → **scans the QR once** on the gateway → state → CONNECTED
- [ ] Verify: inbound test message appears in the inbox; outbound test send delivers; import repopulates threads (idempotent, deduped by `providerMsgId`)
- [ ] Verify: device lock + cooldown still behave; cron nudges deliver
- [ ] Monitor for one full cron cycle; if anything is off → flag OFF (rollback) + re-scan in-process
- [ ] Record cutover done for the tenant; move to the next

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| LocalAuth single-owner corruption / double-linked-device force-logout | Cutover disconnects in-process first, then re-scans fresh on the gateway. `.wwebjs_auth` is **not** migrated — no shared-profile risk. |
| Regression in the complex `ingestInbound`/`importAllChats` logic during the DTO refactor | Phase 0 keeps public signatures as adapters; existing unit + api specs are the acceptance gate, run before anything moves out-of-process. |
| Synchronous `isConnected` needs an answer without a round-trip | Backend state cache fed by gateway `state` events; warmed on boot. |
| Gateway unreachable | Shim maps to existing stub semantics (QUEUED rows, cached state) — no crash, no loss. |
| Inbound media across a process boundary | S3 when configured; same-host shared `uploads/wa-web` otherwise; cross-host byte POST. Persisted result identical. |
| Multi-tenant Chromium memory in one gateway process | Sessions are per-tenant as today; single instance to start. Horizontal scale (sticky-by-tenant) is a later concern, not required for parity. |
| CI has no Chromium | Gateway/transport keep the `NODE_ENV=test` + `WHATSAPP_WEB_DISABLED` guards; the shim preserves stub-under-test behavior so CI stays offline + deterministic. |
| Socket.IO CORS/auth is currently open | Pre-existing; unchanged by this refactor. The gateway relay must not widen it (backend keeps owning `io`). |

---

## 10. Explicit non-changes (guardrails)

- No new features. No business-logic changes.
- No Prisma schema changes.
- No public API/endpoint/response-shape changes (internal gateway API is new + private).
- No `whatsapp:*` Socket.IO event name/payload changes.
- No frontend/UI changes.
- `whatsappSessionGuard` unchanged.
- The Meta Cloud API path (`whatsapp.js`, `whatsapp_webhook.js`, `whatsappProvider.js`) and the dead Wati client are untouched.
- No git actions performed as part of this work.
