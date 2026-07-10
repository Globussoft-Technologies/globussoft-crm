# WhatsApp Gateway — Environment Setup Guide

## Quick Start

The WhatsApp Gateway extraction requires coordinated env vars on **two sides**:
1. Backend (controls feature flag + gateway URL)
2. Gateway service (listens on port + posts events back)

## Backend Configuration

Edit `backend/.env` to enable the gateway:

```bash
# Global on/off switch (Phase 3 production cutover)
WA_GATEWAY_ENABLED=0                          # Default: OFF (in-process mode)

# Per-tenant allowlist (when global flag is ON)
WA_GATEWAY_ENABLED_TENANTS=3,7                # Comma-separated tenant IDs (optional)

# Base URL of the gateway service
WA_GATEWAY_URL=http://127.0.0.1:5100         # Local dev | https://... in prod

# Shared secret (X-Internal-Key header)
WA_GATEWAY_INTERNAL_KEY=<random-32-hex>       # Must match gateway's key
```

### Reference in `backend/.env.example`

```
# ─── WhatsApp Gateway (Phase 1-2 extraction — OPTIONAL, default OFF) ────────────
WA_GATEWAY_ENABLED=
WA_GATEWAY_ENABLED_TENANTS=
WA_GATEWAY_URL=
WA_GATEWAY_INTERNAL_KEY=
```

---

## Gateway Service Configuration

Edit `wa-gateway/.env` (copy from `wa-gateway/.env.example`):

```bash
# Port the gateway listens on
WA_GATEWAY_PORT=5100

# Shared secret (MUST match backend's WA_GATEWAY_INTERNAL_KEY)
WA_GATEWAY_INTERNAL_KEY=<same-random-32-hex>

# Where the gateway posts transport events back to backend
WA_BACKEND_EVENTS_URL=http://127.0.0.1:5000/api

# Optional: use system Chromium instead of bundled
WHATSAPP_WEB_CHROME_PATH=

# Never launch browser (CI/test safety)
WHATSAPP_WEB_DISABLED=
```

### Reference in `wa-gateway/.env.example`

```
WA_GATEWAY_PORT=5100
WA_GATEWAY_INTERNAL_KEY=
WA_BACKEND_EVENTS_URL=http://127.0.0.1:5000/api
WHATSAPP_WEB_CHROME_PATH=
WHATSAPP_WEB_DISABLED=
```

---

## Local Development Setup

### Step 1: Generate Shared Secret

```bash
# Generate a random 32-hex string for X-Internal-Key
openssl rand -hex 32
# Output: a1b2c3d4e5f6...
```

### Step 2: Configure Backend

```bash
# backend/.env
WA_GATEWAY_ENABLED=0                    # Keep OFF for now (default)
WA_GATEWAY_ENABLED_TENANTS=
WA_GATEWAY_URL=http://127.0.0.1:5100
WA_GATEWAY_INTERNAL_KEY=a1b2c3d4e5f6...
```

### Step 3: Configure Gateway

```bash
# wa-gateway/.env
WA_GATEWAY_PORT=5100
WA_GATEWAY_INTERNAL_KEY=a1b2c3d4e5f6...  # MUST match backend's key
WA_BACKEND_EVENTS_URL=http://127.0.0.1:5000/api
```

### Step 4: Start Services

```bash
# Terminal 1: Backend
cd backend
npm run dev
# Listening on :5000

# Terminal 2: Gateway (only when testing Phase 3 cutover)
cd wa-gateway
npm install
npm start
# Listening on :5100
```

### Step 5: Enable Per-Tenant (Phase 3 Only)

When ready to test the gateway on a specific tenant:

```bash
# backend/.env
WA_GATEWAY_ENABLED=1
WA_GATEWAY_ENABLED_TENANTS=3              # Enable for tenant ID 3 only
```

Then:
1. Start the gateway (`cd wa-gateway && npm start`)
2. Login to tenant 3
3. Scan WhatsApp QR in the UI (should come from gateway, not in-process)
4. Test send/receive — should route through gateway REST → webhook

---

## Production Deployment

### Prerequisites

1. **Shared secret:** Generate once, store in secret manager (Vault/AWS SSM)
   ```bash
   openssl rand -hex 32
   ```

2. **Gateway machine:** Needs Chromium system libs
   ```bash
   sudo apt-get install libnss3 libatk-bridge2.0-0 libxkbcommon0 libgtk-3-0 libgbm1 libasound2 libxshmfence1
   ```

3. **Backend machine:** Configure gateway URL + key

### Deployment Checklist

- [ ] Provision `wa-gateway` as separate PM2 app on production machine
- [ ] Share `WA_GATEWAY_INTERNAL_KEY` secret to both backend + gateway
- [ ] Backend: set `WA_GATEWAY_URL` (internal host + port, or HTTPS endpoint)
- [ ] Gateway: set `WA_BACKEND_EVENTS_URL` to backend's `/api` endpoint
- [ ] Test webhook connectivity: `curl -X POST http://backend:5000/internal/whatsapp/events -H "X-Internal-Key: <key>" -H "Content-Type: application/json" -d '{"type":"state","tenantId":1}'`
- [ ] Phase 3: Enable via `WA_GATEWAY_ENABLED=1` + per-tenant allowlist
- [ ] Monitor gateway logs for "listening on :5100" + "auto-restoring sessions"
- [ ] Test on scratch tenant first (toggle back to OFF to rollback)

---

## Environment Variables Reference

### Backend Only

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `WA_GATEWAY_ENABLED` | No | `0` | Global on/off (default OFF) |
| `WA_GATEWAY_ENABLED_TENANTS` | No | `3,7,12` | Per-tenant allowlist |
| `WA_GATEWAY_URL` | When enabled | `http://127.0.0.1:5100` | Gateway base URL |
| `WA_GATEWAY_INTERNAL_KEY` | When enabled | `a1b2c3d4...` | Shared auth secret |

### Gateway Only

| Variable | Required | Example | Purpose |
|----------|----------|---------|---------|
| `WA_GATEWAY_PORT` | No | `5100` | Listen port |
| `WA_GATEWAY_INTERNAL_KEY` | Yes | `a1b2c3d4...` | Shared auth secret |
| `WA_BACKEND_EVENTS_URL` | Yes | `http://127.0.0.1:5000/api` | Backend webhook URL |
| `WHATSAPP_WEB_CHROME_PATH` | No | `/usr/bin/chromium` | System Chromium path |
| `WHATSAPP_WEB_DISABLED` | No | `1` | Disable browser (test/CI) |

### Both Services

| Variable | Purpose |
|----------|---------|
| `WA_GATEWAY_INTERNAL_KEY` | Shared secret for X-Internal-Key auth |

---

## Troubleshooting

### "WA_GATEWAY_INTERNAL_KEY not configured"
**Cause:** Gateway .env missing `WA_GATEWAY_INTERNAL_KEY`  
**Fix:** Copy from backend, paste into `wa-gateway/.env`

### Webhook 401 Unauthorized
**Cause:** Mismatched `WA_GATEWAY_INTERNAL_KEY` between backend + gateway  
**Fix:** Generate ONCE, use same value on both sides

### "Cannot connect to gateway"
**Cause:** Backend `WA_GATEWAY_URL` points to wrong host/port  
**Fix:** Verify gateway is running (`npm start` in `wa-gateway/`) and check port matches `WA_GATEWAY_PORT`

### "Gateway posts events but backend doesn't see them"
**Cause:** `WA_BACKEND_EVENTS_URL` in gateway .env points to wrong backend URL  
**Fix:** Ensure it matches backend's reachable IP/hostname + `/api` suffix

---

## See Also

- [WHATSAPP_GATEWAY_EXTRACTION.md](WHATSAPP_GATEWAY_EXTRACTION.md) — Full design + phases
- `backend/.env.example` — All backend variables
- `wa-gateway/.env.example` — All gateway variables
