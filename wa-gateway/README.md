# WhatsApp Gateway (standalone transport service)

Isolates `whatsapp-web.js` + Puppeteer/Chromium from the CRM backend. **Transport only** — sessions, QR, send, and the raw inbound/ack event stream. It owns **no CRM database**; it posts normalized event DTOs to the backend, which keeps all persistence, Socket.IO, RBAC, device governance, and lead capture.

Full design, phases, rollback, and cutover: [docs/WHATSAPP_GATEWAY_EXTRACTION.md](../docs/WHATSAPP_GATEWAY_EXTRACTION.md).

## Status

Phase 1 skeleton. The REST surface, shared-secret auth, `/health`, and the event-forwarder are wired in `server.js`. The transport implementation (session `Map` keyed by `tenantId`, `connect`/`wireEvents`/send/import, DTO builders — relocated from the transport half of `backend/services/whatsappWebClient.js`) is added as `transportCore.js` in Phase 1; until then the transport endpoints return `501`.

**The backend default is OFF** (`WA_GATEWAY_ENABLED` unset) — nothing routes here until explicitly enabled, so deploying this service is inert.

## Run (local, once transport core is wired)

```bash
cd wa-gateway
npm install            # installs its OWN whatsapp-web.js + puppeteer (separate from backend)
cp .env.example .env   # set WA_GATEWAY_INTERNAL_KEY + WA_BACKEND_EVENTS_URL
npm start              # listens on :5100
```

Backend side (to route a tenant here):

```
WA_GATEWAY_ENABLED=1
WA_GATEWAY_ENABLED_TENANTS=<tenantId>   # per-tenant cutover (Phase 3); omit for all
WA_GATEWAY_URL=http://127.0.0.1:5100
WA_GATEWAY_INTERNAL_KEY=<same secret as the gateway>
```

## Server (production)

Runs as its own PM2 app (e.g. `wa-gateway`), same host initially. Needs the Chromium system libs (`libnss3 libatk-bridge2.0-0 libxkbcommon0 libgtk-3-0 libgbm1 libasound2 libxshmfence1`) and write access to its `.wwebjs_auth` directory. `.wwebjs_auth`, `node_modules`, and `.env` are gitignored.

## Guarantees

- Tenant-scoped sessions (keyed by `tenantId`), identical to the pre-extraction model.
- CI-safe: honors `NODE_ENV=test` / `WHATSAPP_WEB_DISABLED` (never launches a browser).
- No CRM schema, API, or Socket.IO event changes.
