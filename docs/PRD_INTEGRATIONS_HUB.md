# PRD — Unified Integrations Hub (Central Discovery, Status, and Configuration Surface)

**Status:** NOT STARTED — PRD draft only; design call needed before any code lands
**Source:** GH #858 — [Gap][INT-001] Unified Integrations hub missing — integrations only configurable per-page
**Tier:** P3 — Operator visibility + onboarding ergonomics (no traffic-blocked workflow today, but every new tenant pays a discovery tax to figure out what the CRM connects to + where each config lives)
**Authored:** 2026-05-25 (tick #190 / Agent B, autonomous overnight cron arc)
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape), `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance), `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops; consumes integration credentials)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D11**; see §10.
**Cred dependency:** none external; pure internal aggregation + UX layer.

---

## §1 Background + source attribution

The CRM today has **no centralized surface to discover, inspect, or test the tenant's integration footprint**. Per GH issue #858 verbatim:

> Unified Integrations hub missing — integrations only configurable per-page
>
> **Gap:**
> - Channel-specific config lives on each module page (Channels.jsx, WhatsAppConfig, SmsConfig, CalendarSync.jsx, etc.).
> - No single page where an Admin can see "what integrations are configured for this tenant right now?"
> - No central place to discover what the CRM connects to.
> - API key management for sister Globussoft products (Callified.ai, AdsGPT) lives in a separate Developer surface; not unified with the rest of the integration surface.
>
> **Requirements:**
> - New `/integrations` (or `/settings/integrations`) page.
> - Card-grid of all available integrations, grouped by category.
> - Per-card status: NOT CONFIGURED / CONFIGURED / LIVE / DISABLED / ERROR (with last-test timestamp).
> - Click-through to configure — either inline modal/sheet OR deep-link to the existing config page.
> - Connection-test button per card.
> - Search + filter.
> - RBAC-aware (Admin sees keys; Manager read-only; User hidden entirely).
>
> **Impact:**
> - Onboarding a new tenant takes 30-60 minutes of "where do I click to wire up Stripe?" because the operator has to find 8 different pages.
> - Existing tenants have no audit-style view of "what's actually live right now" — caps any compliance/IT review against the CRM.
> - Discoverability suffers — operators don't know that integrations exist until they hit the relevant module page.

Today's integration footprint in the codebase (a representative — not exhaustive — slice):

- **Generic Integration model** at [backend/routes/integrations.js](../backend/routes/integrations.js) ([routes/integrations.js:7-80](../backend/routes/integrations.js#L7-L80)) — defines `AVAILABLE_INTEGRATIONS` static registry (12 providers across communication / productivity / payments / marketing / accounting / automation / marketplace categories) + REST surface at `/api/integrations` (GET list, POST /connect, POST /disconnect, POST /toggle, GET /marketplace/status).
- **Channels config page** at [frontend/src/pages/Channels.jsx](../frontend/src/pages/Channels.jsx) (1175 lines) — third-party credential UI for SMS (Twilio / MSG91), WhatsApp Cloud API, telephony (MyOperator / Knowlarity). Credential masking via `credentialMasking.js`. Each provider sub-tab lives here, NOT in the integrations hub.
- **Calendar sync** at [frontend/src/pages/CalendarSync.jsx](../frontend/src/pages/CalendarSync.jsx) (1302 lines) — Google Calendar + Outlook OAuth flows + sync settings. Self-contained; the integrations hub does not surface it today.
- **Marketplace leads config** at `backend/routes/marketplace_leads.js` — IndiaMART / JustDial / TradeIndia credential mgmt + sync settings. Per-marketplace UI lives on `MarketplaceLeads.jsx`.
- **SSO** at `backend/routes/sso.js` + `frontend/src/pages/SsoSetup.jsx` (or similar) — SAML / OIDC IdP wiring; ADMIN-gated; self-contained.
- **SCIM** at `backend/routes/scim.js` + token management UI — Okta / Azure AD user-provisioning tokens; separate from SSO.
- **Webhook delivery** at `backend/lib/webhookDelivery.js` + `backend/routes/<route_with_webhooks>` — outbound webhook subscriptions per-event.
- **Stripe / Razorpay** payment gateway config — surfaced via `PRD_PAYMENT_GATEWAY_CONFIG.md`'s upcoming `/settings/payment-gateways` page (sibling tick #188); NOT in the integrations hub today.
- **Zapier** integration at `backend/routes/zapier.js` + `frontend/src/pages/Zapier.jsx` — token management for the Zapier triggers/actions.
- **Mailgun / SendGrid / Nodemailer** email provider config — surfaced via `backend/routes/email.js` + the inbox / email-template pages; no central toggle.
- **Sister Globussoft product API keys** at [backend/routes/external.js](../backend/routes/external.js) (558 lines) — `/api/v1/external/*` endpoints for Callified.ai (voice/WhatsApp) and AdsGPT (ads). `ApiKey` rows scoped per tenant with `X-API-Key: glbs_…` auth via `backend/middleware/externalAuth.js`. UI lives on the `Developer.jsx` page (or similar); NOT in the integrations hub.
- **Chatbots** at `backend/routes/chatbots.js` + the bot-builder UI — embeddable widget + LLM-backed bots; one chatbot per provider configuration.

### What's missing structurally

The integrations themselves are well-built — each module's config page is functional, RBAC-gated, credential-masked, and audit-logged. What's **missing is the unified discovery + status + governance layer on top**.

Today's experience for an ADMIN onboarding a new tenant looks like:

1. Operator logs in → lands on `/dashboard`.
2. Operator wants to wire up payments → has to know to navigate to `/settings/payment-gateways` (or wherever Stripe lives).
3. Operator wants to wire up WhatsApp → has to navigate to `/channels` → click the WhatsApp sub-tab → paste credentials.
4. Operator wants to wire up calendar sync → has to navigate to `/calendar-sync` → OAuth dance with Google.
5. Operator wants to wire up SMS → back to `/channels` → SMS sub-tab.
6. Repeat for SSO, SCIM, marketplace leads, Zapier, sister-product API keys, …

There is **no single page where the operator can see "today this tenant has Stripe LIVE, WhatsApp CONFIGURED but NOT LIVE, SMS NOT CONFIGURED, Google Calendar LIVE, …"**. There is no marketplace-style discovery — the operator only knows about an integration if they happen to navigate to the right page.

The downstream cost compounds:

1. **Onboarding tax.** A new tenant takes 30-60 minutes of "where do I click to wire up X?" because the operator has to know all 8+ pages exist + find them via the sidebar.
2. **Audit gap.** Compliance/IT auditor asks "list all integrations LIVE for tenant T today, with credentials masked + last-tested timestamps". Today: requires database introspection (one query per Integration / SmsConfig / WhatsAppConfig / TelephonyConfig / CalendarIntegration / MarketplaceConfig / Chatbot / SsoConfig / ScimToken / ApiKey table). No operator-facing report.
3. **Tenant migration.** Tenant moves from sandbox to production. Today: operator has to manually re-wire each integration on the production tenant + check each one works. No "export integration config (with placeholder keys); re-import on prod" surface.
4. **Discoverability.** Operators don't realize the CRM supports (say) WhatsApp Cloud API or marketplace-lead ingestion until they happen to land on the relevant module page. No catalog → no discovery → integrations underused → less product value perceived.
5. **Health monitoring.** Per-integration health (last-sync timestamp, last-error, current rate-limit headroom) is scattered across module pages. No central "anything broken?" sweep view.

### Prior art

- **HubSpot Marketplace** ([https://ecosystem.hubspot.com/marketplace/apps](https://ecosystem.hubspot.com/marketplace/apps)) — catalog of 1,500+ integrations + per-app install flow + post-install management view ("Connected Apps"). Two distinct surfaces — "Discover" (catalog) + "Manage" (installed).
- **Salesforce AppExchange + Connected Apps** — same two-surface split. Connected Apps shows OAuth tokens + last-use + revoke.
- **Zoho CRM Integrations** ([https://www.zoho.com/crm/help/integrations.html](https://www.zoho.com/crm/help/integrations.html)) — single page with grouped categories (Comms / Payments / Email / Storage / ...) + per-card connect/disconnect/test buttons. Closest match to what THIS PRD targets.
- **Slack App Directory + Workspace Apps page** — discovery + management split; per-app status + permissions surface.
- **Globussoft sister product** Callified.ai has a "Connected Services" page that aggregates voice provider + WhatsApp provider + CRM API status — the shape's been validated in-house.

### Why this is a P3, not a P1

The integrations work today; operators just have to know where to find each config page. The cost is operator-discovery time + onboarding-call length, not a blocked workflow. Production tenants who've already onboarded successfully don't feel the pain. New tenants who happen to have a guided demo from a Globussoft sales engineer don't feel it either.

**The risk class is "discovery + audit + governance, not capability".** Material as the integration count grows (CRM now has 15+ integration points; will be 20+ within 2 releases as `PRD_PAYMENT_GATEWAY_CONFIG.md` + per-vertical channels ship); the central-hub paradigm becomes worthwhile at scale.

### Source attribution

- GH issue #858 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/858](https://github.com/Globussoft-Technologies/globussoft-crm/issues/858)
- Related: GH #437 — Marketplace status chips on `/marketplace-leads` page (already shipped per [routes/integrations.js:169-200](../backend/routes/integrations.js#L169-L200) `/marketplace/status` endpoint). THIS PRD generalizes that per-marketplace status concept to a per-integration status concept.
- Related: GH #651 — Credential-masking contract for Channels. THIS PRD's hub MUST inherit the same `{ configured, last4, lastRotatedAt }` shape on every credential surface (see [backend/lib/credentialMasking.js](../backend/lib/credentialMasking.js)).
- Cross-reference: `PRD_PAYMENT_GATEWAY_CONFIG.md` — payment-gateway config page is sibling integration surface; the hub's "Payments" category deep-links to it rather than re-implementing.
- Cross-reference: `PRD_IMPORT_EXPORT_JOBS.md` — consumes integration credentials (Mailgun for email-on-completion notifications, etc.); the hub surface helps operators verify those creds are LIVE before triggering large jobs.
- Cross-reference: `routes/audit.js` — every hub action (view, test, deep-link) writes to the tamper-evident audit chain.

---

## §2 Use cases

1. **ADMIN onboarding a new tenant — single page to wire up Stripe + WhatsApp + Mailgun + Google Calendar in one sitting.** New wellness tenant Rishu signs up his sister clinic chain. The first 90 minutes of setup are integration-wiring — Stripe for online invoice payments, WhatsApp Cloud API for appointment reminders, Mailgun for transactional email, Google Calendar for clinician calendars. Today: navigate to 4 different pages (Payments / Channels / Email / CalendarSync). With the hub: navigate ONCE to `/integrations` → see the catalog → click each card → either an inline credential modal opens OR a deep-link takes the operator to the existing config page → operator returns to the hub → all four cards show LIVE status. Onboarding-call length drops from 60 minutes to 25 minutes.

2. **ADMIN audit — "what integrations are LIVE for tenant X right now?"** Compliance auditor for a US-based wellness tenant requests a snapshot of every integration LIVE today: provider name, configured-by user, configured-at timestamp, last-tested timestamp, credentials masked. ADMIN navigates to `/integrations` → clicks "Export Status Snapshot" → downloads CSV with columns `category, provider, status, configuredBy, configuredAt, lastTestedAt, last4`. Auditor satisfied without database introspection or a developer ticket.

3. **DEVELOPER managing API keys for sister Globussoft products (Callified, AdsGPT) — one page for X-API-Key management.** Globussoft platform team adds a new product (e.g. "Globus Insights" analytics) consuming the External Partner API at `/api/v1/external/*`. They need to issue a fresh API key for the wellness tenant. Today: navigate to `Developer.jsx` (the existing API key surface) → create key → copy key → manually rotate keys for the existing 3 consumer products. With the hub: navigate to `/integrations` → "Sister Products" section → click "+ Issue New API Key" → modal with consumer-name + scopes + expires-at → key generated + shown once + masked thereafter. Per-product rotation surfaced inline. Single canonical surface for partner-API governance.

4. **USER discovering "what does this CRM connect to?"** New clinician (USER role) wants to know "does this thing send WhatsApp messages? Can I sync my Google Calendar?" Today: no answer — the user role's sidebar hides admin pages; the clinician has no way to discover capabilities. With the hub: USER role gets a READ-ONLY catalog view (hub is mounted as `/integrations` for ADMIN; under-the-hood the same page renders for USER in browse-only mode — categories + cards visible; no status badges, no test buttons, no configure links). Clinician sees "yes, the CRM does send WhatsApp messages" + can ask their ADMIN to wire it up. No "I didn't know this existed" surprises 3 months in.

5. **Tenant migration — exporting integration config from sandbox to prod.** Globussoft engineer is migrating a wellness tenant from a staging instance to production. Today: manually re-wire each integration on the production tenant + manually test each one. With the hub: navigate to `/integrations` on staging → click "Export Configuration" → downloads `integrations-export.json` with all integration configs + structure (provider, scopes, settings) + PLACEHOLDER credentials (real creds stripped at export). Engineer navigates to `/integrations` on production → "Import Configuration" → uploads JSON → modal walks through each integration asking for real credentials → integrations re-created in seconds rather than hours. Audit chain logs the import event.

6. **Health-status dashboard surfaced to ADMIN sidebar.** Every morning at 09:00, an ADMIN's first sidebar click is "Integrations" → hub shows 3 cards in ERROR state (Stripe webhook signature mismatch since 02:00; WhatsApp template rejected by Meta yesterday; calendar sync paused due to expired refresh token). ADMIN clicks each card → deep-link to the existing config page → fix → "Test" button in the hub confirms LIVE. Eliminates the "discover broken integration via customer complaint" failure mode.

---

## §3 Functional requirements

### FR-3.1 New page: `frontend/src/pages/Integrations.jsx` mounted at `/integrations`

- **Route registration** in `frontend/src/App.jsx`. ADMIN-default mount; MANAGER + USER also access but with read-only/browse-only mode per FR-3.7.
- **Sidebar entry** under "Settings" (generic vertical) / "Administration" (wellness vertical). Icon: `lucide-react` `Plug` or `Zap`.
- **Page header.** "Integrations" + sub-header "X of Y configured" + "All systems operational" / "N integrations need attention" status pill.
- **Search box.** Top-right; filters cards by name + description (client-side; the catalog has ≤30 entries so client-side is plenty).
- **Category filter chips.** Default ALL; click a chip to filter (Communications / Payments / Calendar / SSO / Marketing / AI / Storage / Accounting / Sister Products / Marketplace / Automation).
- **Status filter chips.** Default ALL; filter by NOT CONFIGURED / CONFIGURED / LIVE / DISABLED / ERROR.
- **Card grid.** Responsive `repeat(auto-fit, minmax(min(100%, 320px), 1fr))` per the [CLAUDE.md](../CLAUDE.md) responsive-grid standing rule. Each card is ~320px wide with provider logo, name, category badge, status badge, last-tested timestamp, and 2 actions (Configure + Test).
- **Empty state.** "No integrations match your filters" with a "Clear filters" CTA.

### FR-3.2 Integration catalog — STATIC curated registry

A new module `backend/lib/integrationsRegistry.js` (new) exports the canonical catalog:

```js
module.exports = [
  // === Communications ===
  {
    id: 'sms-twilio',
    category: 'communications',
    provider: 'twilio',
    name: 'Twilio SMS',
    description: 'Send transactional SMS via Twilio',
    logoUrl: '/logos/twilio.svg',
    statusProvider: 'sms-config',          // resolves to the SmsConfig model
    configRoute: '/channels?tab=sms',      // deep-link to existing config page
    testEndpoint: '/api/sms/test',         // optional; absent for catalog-only entries
    requiresRoles: ['ADMIN'],
    sisterProduct: false,
  },
  {
    id: 'whatsapp-cloud',
    category: 'communications',
    provider: 'whatsapp',
    name: 'WhatsApp Cloud API',
    description: 'Send WhatsApp messages via Meta Cloud API',
    logoUrl: '/logos/whatsapp.svg',
    statusProvider: 'whatsapp-config',
    configRoute: '/channels?tab=whatsapp',
    testEndpoint: '/api/whatsapp/test',
    requiresRoles: ['ADMIN'],
    sisterProduct: false,
  },
  // ... ~25-30 entries total covering Comms / Payments / Calendar / SSO / Marketing / Storage / Accounting / Sister Products / Marketplace / Automation
];
```

**Why static (DD-5.1 below):** auto-deriving the catalog from existing models trades cleaner UX for autogen surprises (e.g. a new Integration provider appears in the hub before its config page is built; or a model field gets renamed silently and the hub renders the old name). Static curated registry means a developer adding a new integration MUST add a registry entry alongside their code — a documented seam, not magic.

### FR-3.3 Per-card status resolution — cached + on-demand refresh

- **FR-3.3.a Status providers.** A `statusProvider` is a string id (`'sms-config'`, `'whatsapp-config'`, `'integration:stripe'`, `'apikey'`, `'sso-config'`, `'scim-token'`, `'calendar-integration:google'`, `'marketplace-config:indiamart'`, `'webhook'`, `'chatbot'`). Each resolves to a backend handler in `backend/lib/integrationStatus.js` (new) returning `{ status, configuredAt, lastTestedAt, last4, lastError, healthHint }` for the given tenant.
- **FR-3.3.b Status enum.**
  - `NOT_CONFIGURED` — no config row exists in the underlying model.
  - `CONFIGURED` — config row exists with credentials filled, but `isActive=false` OR never tested.
  - `LIVE` — config row exists with `isActive=true` AND `lastTestedAt` within freshness window OR observed traffic in audit log within 24h.
  - `DISABLED` — config row exists but operator-toggled-off.
  - `ERROR` — last connection test failed OR last attempt to use the integration in the last 24h returned a 4xx/5xx (from the audit log).
- **FR-3.3.c Cached.** `GET /api/integrations/hub` returns the full catalog with current status for all cards. Status is cached server-side for 60 seconds per tenant (resolved on first call after expiry; in-memory cache). Operator can click "Refresh All" to force a re-fetch.
- **FR-3.3.d Per-card test.** "Test" button hits `POST /api/integrations/hub/:id/test` which routes to the registry's `testEndpoint`. Returns within 5s with `{ ok: bool, latencyMs, message }`. Updates `lastTestedAt` + `lastError` on the underlying config row. Audit log captures the test event.

### FR-3.4 Click-through to configure — deep-link OR inline

**Default: deep-link to existing config page** (cheaper; preserves the per-integration UX investment that's already there). Hub passes a `?source=hub` query param so the destination page can render a "← Back to Integrations" link.

**Inline for cheap configs.** For integrations with ≤3 fields that can fit in a sheet/modal (e.g. an API key + a webhook URL + an enable toggle), the hub can render the form inline. Decision per-integration in the registry via `inlineConfig: { fields: [...] }`. Initial v1 ships deep-link for ALL integrations; inline shifts in v2 for the simplest ones.

### FR-3.5 Connection test mechanism

- **FR-3.5.a Test endpoint contract.** `POST /api/integrations/hub/:id/test` with body `{}`. Backend resolves the registry entry → calls the registry's `testEndpoint` internally → captures `{ ok, latencyMs, message, errorCode? }` → persists to the underlying config row's `lastTestedAt + lastError` → writes audit entry `INTEGRATION_TESTED` with details `{ provider, ok, latencyMs }` → returns the result to the hub UI.
- **FR-3.5.b Per-integration test logic.** Each integration's existing health/test endpoint is reused. Examples:
  - SMS: `POST /api/sms/test` sends a no-op SMS to a configured admin number or returns the provider's account-info on success.
  - WhatsApp: `POST /api/whatsapp/test` fetches the WABA business profile from Meta Cloud API.
  - Stripe: `POST /api/payments/test` fetches the Stripe account name + capability flags.
  - Calendar: `POST /api/calendar-google/test` refreshes the access token + lists 1 upcoming event.
  - Webhook: `POST /api/webhooks/:id/test` re-fires the most recent event payload.
  - Sister Products: `GET /api/v1/external/health` with the test key.
  - SSO: `POST /api/sso/test` returns IdP metadata.
- **FR-3.5.c No test endpoint case.** Some catalog entries have no testable surface (e.g. "Custom Webhook" — needs the operator to fire from the consumer side). Card has no Test button; status badge stays at CONFIGURED.
- **FR-3.5.d Async-test option (Phase 2).** Long-running tests (e.g. OAuth re-authorize flows) return `202 Accepted` with a `pollUrl`; hub UI polls every 2s until COMPLETED. v1 ships sync-only with a 5s timeout.

### FR-3.6 Search + filter

- **FR-3.6.a Search.** Client-side substring match on `name + description + category`. Debounced 150ms.
- **FR-3.6.b Category filter.** Multi-select chips. Default ALL.
- **FR-3.6.c Status filter.** Multi-select chips. Default ALL.
- **FR-3.6.d Sister-product filter.** Toggle "Show only Globussoft products" (Callified / AdsGPT / Globus Phone / future Globus Insights).
- **FR-3.6.e URL state.** Filters persist in URL query params (`?category=communications,payments&status=ERROR`) so operators can bookmark a filtered view (e.g. "show only ERROR cards" for daily morning health check).

### FR-3.7 Audit log integration

Audit chain entries (via `backend/lib/audit.js` `writeAudit(entity, action, entityId, userId, tenantId, details)`):

- `INTEGRATION_HUB` + `VIEWED` — on `GET /api/integrations/hub`; details = `{ filterParams }`. Throttled per-user-per-tenant to once per 5 minutes (the entire hub render fires this; don't spam the audit log on every page refresh).
- `INTEGRATION_HUB` + `TESTED` — on per-card test; details = `{ provider, ok, latencyMs }`.
- `INTEGRATION_HUB` + `CONFIG_EXPORTED` — on export-config CSV/JSON download; details = `{ format, integrationCount }`.
- `INTEGRATION_HUB` + `CONFIG_IMPORTED` — on import-config upload; details = `{ format, integrationCount, succeeded, failed }`.
- `INTEGRATION_HUB` + `STATUS_REFRESHED` — on operator "Refresh All" click; details = `{ refreshedCount }`. Throttled to once per minute.

Each existing per-integration config page already writes its own per-provider audit entries (e.g. `WHATSAPP_CONFIG` + `UPDATED`). The hub does NOT duplicate those; it only writes hub-specific events.

### FR-3.8 RBAC

- **FR-3.8.a USER role.** Sees the catalog in BROWSE-ONLY mode — provider name + description + category badge visible; no status, no last-tested timestamp, no credentials, no Configure/Test buttons. The "what does this CRM connect to?" discovery use case.
- **FR-3.8.b MANAGER role.** Sees full catalog + status badges + last-tested timestamps + masked credentials (`****1234`) + Test button. CANNOT click Configure (no write). CANNOT export config. CANNOT import config.
- **FR-3.8.c ADMIN role.** Full hub access — view + test + configure (deep-link or inline) + export + import + per-card revoke + per-card disable/enable toggle.
- **FR-3.8.d Resource-type sub-permissions.** Some integrations require additional gating beyond ADMIN. Sister-product API keys require `verifyRole(['ADMIN']) + verifyPlatformAdmin` (the latter is a future addition for Globussoft-side platform admins managing partner keys). v1 stays ADMIN-only.
- **FR-3.8.e Audit-trail visibility.** All MANAGER + ADMIN can see the audit history of integration changes via the existing `/audit` page (entity=`INTEGRATION_HUB`). USERs see nothing audit-related.

### FR-3.9 API endpoints (new `backend/routes/integrations_hub.js` mounted at `/api/integrations/hub`)

JWT-guarded; RBAC per FR-3.8.

- **FR-3.9.a `GET /api/integrations/hub`** — Returns the full catalog with current status. Query: `category?`, `status?`, `sisterOnly?`, `forceRefresh?` (bypasses the 60s cache). Response: `[{ id, category, provider, name, description, logoUrl, status, configuredAt, lastTestedAt, last4, lastError, healthHint, configRoute, sisterProduct }, ...]`.
- **FR-3.9.b `POST /api/integrations/hub/:id/test`** — Per-card connection test. Returns `{ ok, latencyMs, message, errorCode? }`. Audit + persist to the underlying config's lastTestedAt + lastError.
- **FR-3.9.c `POST /api/integrations/hub/:id/toggle`** — Per-card enable/disable toggle. Body: `{ enabled: boolean }`. Routes to the underlying config's existing toggle endpoint. ADMIN-only.
- **FR-3.9.d `GET /api/integrations/hub/export`** — Export config snapshot. Query: `format=json|csv` (default json). Returns the per-tenant catalog with status + ALL credential fields STRIPPED (or replaced with `'<PLACEHOLDER>'`). Audit log captures the export.
- **FR-3.9.e `POST /api/integrations/hub/import`** — Import config from JSON. Body: multipart with `file` field. Walks each integration in the JSON → prompts operator for real credential entry via a modal (the API call only kicks off the import wizard; the modal handles per-integration cred entry). ADMIN-only. Audit log captures.
- **FR-3.9.f `GET /api/integrations/hub/health`** — One-shot aggregate health: `{ total, configured, live, disabled, errors, lastRefreshAt }`. Used by the page header pill + (in Phase 2) by a future sidebar badge that surfaces "N integrations need attention".

### FR-3.10 Sister-product API key management surface

- **FR-3.10.a Sister Products section.** Top of the catalog (above other categories) when `sisterOnly=true` filter or as a dedicated category at left.
- **FR-3.10.b Per-product cards.** Card per consuming product (Callified.ai, AdsGPT, Globus Phone, future Globus Insights). Status: number of issued keys + last-used-at + per-key actions (Revoke / Rotate / View Usage).
- **FR-3.10.c New-key flow.** "+ Issue New API Key" button → modal with `name` + `consumerProduct` + `scopes` (multi-select from the External Partner API surface — `leads:write`, `calls:read`, `messages:write`, etc.) + `expiresAt` (90d / 1y / never). On submit: key generated server-side + shown ONCE in plaintext + thereafter masked.
- **FR-3.10.d Revocation.** Per-key Revoke → sets `revokedAt` on the ApiKey row → next request with that key returns 401.

### FR-3.11 Status badges + healthHint semantics

Color cue per status (mirrors the existing `/marketplace/status` healthHint pattern at [routes/integrations.js:185-195](../backend/routes/integrations.js#L185-L195)):

- `LIVE` — green badge "Live" + last-test timestamp inline (`"Tested 5m ago"`).
- `CONFIGURED` — gray badge "Configured" + "Never tested" or last-test timestamp.
- `NOT_CONFIGURED` — gray badge "Not connected" + CTA "Configure now".
- `DISABLED` — gray badge "Disabled" + tooltip "Operator-disabled at <timestamp>".
- `ERROR` — red badge "Error" + last-error message inline (truncated to 60 chars; full message on hover).

Sort order in the catalog: `ERROR > LIVE > CONFIGURED > DISABLED > NOT_CONFIGURED` (errors surface first; "needs attention" gets eyeballs).

---

## §4 Non-functional

- **Per-tenant scoping.** Every status read + test + toggle scopes by `req.user.tenantId`. Cross-tenant access impossible. Mirrors every other CRM route's tenantWhere pattern. ESLint rule blocks `req.body.tenantId` reads.
- **Credentials masked end-to-end.** Hub UI NEVER receives plaintext credentials. Per-card detail view shows only `last4: '****1234'` + `lastRotatedAt: <ISO>` per the [backend/lib/credentialMasking.js](../backend/lib/credentialMasking.js) pattern (closes #651). Cache layer caches MASKED data, never plaintext.
- **No backend schema change.** Pure aggregation over existing Prisma models (Integration, ApiKey, Webhook, SmsConfig, TelephonyConfig, WhatsAppConfig, Chatbot, SsoConfig, ScimToken, MarketplaceConfig, CalendarIntegration). The catalog + status logic + cache are pure server code; no migration required. v1 ships with zero `prisma db push` cost.
- **Cache freshness.** 60s server-side cache per tenant per integration; operator-triggered "Refresh All" busts the cache.
- **Performance — list endpoint.** Per-tenant `/api/integrations/hub` returns within 500ms (P95) for the ~25-30 card catalog (10 underlying tables, each queried once; cache reduces to <50ms after first call).
- **Performance — test endpoint.** Per-card test returns within 5s (P95). Tests that exceed 5s time out + status flips to ERROR + lastError = `"Test exceeded 5s timeout"`.
- **Audit log.** All hub mutations write to the tamper-evident audit chain. Read events throttled.
- **Browser bundle.** New page `Integrations.jsx` lazy-loaded via `React.lazy()` per the [CLAUDE.md](../CLAUDE.md) code-splitting standing rule. ~15KB gzipped (catalog + card components + filter chips + status logic).
- **Mobile responsive.** Card grid uses the `repeat(auto-fit, minmax(min(100%, 320px), 1fr))` pattern from the [CLAUDE.md](../CLAUDE.md) standing rule — works at 375px portrait through 4K desktop without media queries.
- **i18n-ready.** Card titles + descriptions + status labels routed through the existing `LanguageSwitcher.jsx` i18n surface. Catalog provider names stay as proper nouns (Stripe stays "Stripe" in every locale).

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / UX sign-off before frontend impl can start)

- **DD-5.1 Catalog content — auto-derived from existing models OR statically curated card list?** Two paths:
  - **(a) STATIC curated registry.** Developer maintains `backend/lib/integrationsRegistry.js` by hand; one entry per integration; per-entry config (deep-link route, test endpoint, RBAC, sister-product flag). Pro: cleaner UX (every card has hand-curated copy + logo + ordering); no autogen surprises; explicit seam when adding a new integration. Con: developer discipline required — a new integration that ships without a registry entry is invisible.
  - **(b) AUTO-DERIVED from models.** Backend scans the Integration / SmsConfig / WhatsAppConfig / etc. tables + extracts provider lists dynamically. Pro: zero maintenance — new providers automatically appear. Con: copy/logo/ordering becomes "best effort"; new providers leak into the hub before their config UX is built; ordering depends on insertion order which is meaningless.
  - **(c) HYBRID.** Static catalog of base entries; auto-derived discovery of "additional providers in your tenant data that aren't in the catalog yet" surfaced as a separate "Unmanaged" section. Pro: best of both. Con: 2x the code surface.
  **Recommendation: (a) STATIC.** The integration list grows slowly (~1-2 per quarter); the curation cost is low; the UX wins are large. Promote to (c) hybrid IF auto-discovery is requested in v2. Mirrors the [backend/routes/integrations.js:7-80](../backend/routes/integrations.js#L7-L80) `AVAILABLE_INTEGRATIONS` static-registry pattern already in use.
- **DD-5.2 Deep-link to existing config pages OR centralize all config in the hub?** Two paths:
  - **(a) DEEP-LINK ONLY.** Hub's Configure button always navigates to the existing config page (e.g. `/channels?tab=whatsapp`). Pro: zero rebuild of existing config surfaces; preserves the per-integration UX investment; cheaper to ship v1. Con: hub becomes a "discovery + status" layer only — config still scattered.
  - **(b) CENTRALIZE ALL IN THE HUB.** Every integration's config form gets re-implemented inline within the hub. Pro: single canonical config surface; eliminates "where do I click?" entirely. Con: massive duplication of existing pages; the per-integration UX investment (Channels.jsx is 1175 lines; CalendarSync.jsx is 1302 lines) gets thrown away or re-engineered.
  - **(c) HYBRID — simple inline, complex deep-link.** Integrations with ≤3 fields get inline modal; complex integrations (OAuth flows, multi-step wizards) deep-link to existing page. Pro: hub handles the easy 70% of configs inline; complex stuff stays where it lives.
  **Recommendation: (a) DEEP-LINK ONLY in v1; (c) hybrid in v2.** v1 ships hub as discovery + status + test layer; v2 migrates simple integrations to inline configs as ROI justifies. Avoids the migration cliff.
- **DD-5.3 Status badge — live-polled OR cached?** Two paths:
  - **(a) LIVE-POLLED.** Every hub render fires N (~25) status queries against the underlying tables. Pro: always-fresh data. Con: bounded N (~10 underlying tables; each tenant has 1-2 rows per table → manageable) but still adds load; cache invalidation between operators is automatic.
  - **(b) CACHED with manual refresh.** Status cached server-side for 60s per tenant; operator clicks "Refresh All" to bust the cache. Pro: fast page render; cheaper backend load; auditable refresh actions. Con: occasionally stale data (60s window where a config change isn't reflected); requires operator to know to click Refresh.
  - **(c) HYBRID — cached on initial load, live-polled in background every 30s.** Pro: fast initial render + auto-fresh data. Con: background polling cost; battery drain on mobile.
  **Recommendation: (b) CACHED with manual refresh.** 60s freshness is acceptable; "Refresh All" is one click; matches the [routes/integrations.js:169-200](../backend/routes/integrations.js#L169-L200) `/marketplace/status` pattern already in production. Promote to (c) hybrid IF operators complain about staleness.
- **DD-5.4 Sister-product API key management — same hub OR separate "Developer" surface?** Two paths:
  - **(a) SAME HUB.** Sister Products is a category in the hub catalog. Per-product cards with key-issuance flow inline. Pro: unified discovery + management; new sister products surface alongside everything else. Con: API key management is a developer-shaped concern; mixes UX paradigms (consumer-facing integrations vs technical API key issuance).
  - **(b) SEPARATE DEVELOPER SURFACE.** Keep current `Developer.jsx` page for API keys; hub mentions sister products in a "Read more" link only. Pro: clean separation of operator-facing vs developer-facing surfaces. Con: re-introduces the discoverability problem.
  - **(c) SAME HUB + LINK-OUT.** Sister Products category in hub → click → deep-link to the Developer page's API Keys tab. Pro: discovery in hub; management in Developer page. Con: same deep-link tradeoff as DD-5.2.
  **Recommendation: (a) SAME HUB.** The discovery use case is the dominant one; an operator who finds "Callified.ai" in the hub catalog should be able to issue a test key from there. Power-users still have the Developer page for advanced workflows. Mirrors the canonical Stripe Dashboard pattern (API Keys live alongside Apps + Webhooks + everything).
- **DD-5.5 Per-tenant catalog visibility — some integrations hidden for some tenants?** Two paths:
  - **(a) ALL INTEGRATIONS VISIBLE TO ALL TENANTS.** Static catalog rendered identically per tenant regardless of vertical. Pro: simpler; new integrations are auto-discoverable for everyone. Con: irrelevant integrations clutter the catalog (e.g. wellness tenants don't need IndiaMART; travel tenants don't need WhatsApp templates for clinic appointment reminders).
  - **(b) PER-VERTICAL FILTERING.** Catalog entries have an optional `verticals: ['generic', 'wellness', 'travel']` field; defaults to all-visible. Pro: cleaner per-vertical experience. Con: every new integration MUST be vertical-classified at registry-add time.
  - **(c) PER-TENANT-OPT-IN.** Catalog visible by default; tenant-admin can hide cards they don't care about. Pro: maximally flexible. Con: requires per-tenant config storage + UX for hide/show.
  **Recommendation: (a) ALL VISIBLE in v1.** Catalog is small; clutter is mild. Promote to (b) per-vertical IF tenant feedback requests filtering. Skip (c) — over-engineering for v1.
- **DD-5.6 Test button — synchronous (block UI) OR async (notify on completion)?** Two paths:
  - **(a) SYNCHRONOUS.** Test button shows spinner; UI blocks until result (max 5s timeout). Pro: simple; immediate feedback. Con: tab-tied to the request; tab-close mid-test abandons.
  - **(b) ASYNC.** Test button kicks off background job; status badge flips to TESTING; in-app notification on completion. Pro: tab-close safe; multi-card-test parallelism possible. Con: heavier backend infra; matches the import/export job system shape (DD-5.2 of `PRD_IMPORT_EXPORT_JOBS.md`).
  - **(c) HYBRID — sync with 5s timeout; if timeout, transition to async.** Pro: best of both. Con: 2x code paths.
  **Recommendation: (a) SYNCHRONOUS in v1.** Test endpoints already return fast (most are <1s; the 5s timeout catches the long tail). Promote to (b) async IF specific integrations consistently exceed 5s. Mirrors the `PRD_PAYMENT_GATEWAY_CONFIG.md` per-card test pattern.
- **DD-5.7 Categorization — by FUNCTION (Comms/Payments/Calendar/...) OR by VENDOR (Stripe/Twilio/Google/...)?** Two paths:
  - **(a) BY FUNCTION.** Categories: Communications / Payments / Calendar / SSO / Marketing / AI / Storage / Accounting / Sister Products / Marketplace / Automation. Pro: operator thinks in terms of "what do I want to do" not "which vendor"; matches the existing [routes/integrations.js:7-80](../backend/routes/integrations.js#L7-L80) category taxonomy already in place.
  - **(b) BY VENDOR.** Categories: Google / Microsoft / Meta / Twilio / Stripe / Razorpay / ... Pro: matches how SSO / API key issuance feels at scale. Con: a vendor like Google spans multiple functions (Calendar / Drive / Workspace / Analytics) — categorization gets messy.
  - **(c) TAG-BASED — both function AND vendor as filters.** Pro: maximally flexible; operator can filter by either dimension. Con: 2x filter UX.
  **Recommendation: (a) BY FUNCTION.** Matches existing category taxonomy; matches Zoho/HubSpot prior art; operator mental model is function-first. Promote to (c) tag-based IF the catalog grows past 50 entries.

### Cred chase

- **None external.** Pure internal aggregation + UX layer. No third-party API. No new SaaS dependency for v1.
- **Provider logos.** Static SVGs under `frontend/public/logos/` — most vendors publish brand kits. ~25 SVGs to gather (Twilio / WhatsApp / Stripe / Razorpay / Google / Outlook / Meta / Mailgun / SendGrid / Slack / Zapier / Mailchimp / QuickBooks / Xero / Tally / IndiaMART / JustDial / TradeIndia / Okta / Azure AD / Callified / AdsGPT / Globus Phone / generic Webhook / generic Chatbot). One-time fetch + commit. No ongoing maintenance.

### Vendor docs

- N/A. No new vendor integration in v1 — the hub is a UX layer on top of existing integrations whose vendor docs already live in each module's documentation.
- **Internal docs:** the registry shape (`backend/lib/integrationsRegistry.js`) will need a brief internal README at `docs/integration-registry-guide.md` explaining "how to add a new integration to the hub" — coverage decision for the v1 ship.

---

## §6 Acceptance criteria

- **AC-6.1** ADMIN navigates to `/integrations` → page loads within 1s (P95) → catalog shows all ~25-30 integrations grouped by category with correct status badges per tenant (NOT CONFIGURED / CONFIGURED / LIVE / DISABLED / ERROR) and last-tested timestamps. Audit chain logs the `INTEGRATION_HUB / VIEWED` event (throttled to 1-per-5-min per user).
- **AC-6.2** ADMIN clicks "Configure" on the WhatsApp card → deep-links to `/channels?tab=whatsapp&source=hub` → operator updates credentials → returns to hub → status badge has flipped to CONFIGURED (or LIVE if the existing config save triggers a test). No data loss; deep-link returns operator to hub cleanly.
- **AC-6.3** ADMIN clicks "Test" on a configured Stripe card → backend fires test against Stripe API → returns within 5s with `{ ok: true, latencyMs: 240, message: "Account active" }` → status badge flips to LIVE + lastTestedAt updated → audit chain logs `INTEGRATION_HUB / TESTED` with `{ provider: 'stripe', ok: true, latencyMs: 240 }`. Test on a misconfigured Stripe card returns `{ ok: false, errorCode: 'AUTHENTICATION_REQUIRED', message: 'Invalid API key' }` → status flips to ERROR.
- **AC-6.4** MANAGER navigates to `/integrations` → sees full catalog with status badges + last-tested timestamps + masked credentials. Clicks Configure → button is disabled with tooltip "Admin permission required". Clicks Test → succeeds (Test is read-only against the provider).
- **AC-6.5** USER navigates to `/integrations` → sees the browse-only catalog (provider names + categories + descriptions ONLY; no status badges; no credentials; no Configure/Test buttons). Sister Products section hidden entirely.
- **AC-6.6** ADMIN clicks "Export Configuration" → downloads `integrations-export.json` containing all configured integrations with credentials REPLACED by `'<PLACEHOLDER>'`. Audit chain logs `INTEGRATION_HUB / CONFIG_EXPORTED` with `{ format: 'json', integrationCount: 8 }`. Import flow on a fresh tenant accepts the file + walks operator through credential entry per integration.
- **AC-6.7** ADMIN issues a new API key for Callified.ai via the Sister Products card → modal with `name + scopes + expiresAt` → key generated server-side starting with `glbs_` prefix + shown ONCE in plaintext → on modal close, key masked thereafter. ApiKey row written to DB with `tenantId, consumerProduct: 'callified', scopes: [...], expiresAt`. Audit chain logs.
- **AC-6.8** Operator filters catalog: `?category=communications,payments&status=ERROR` → URL updates + only ERROR cards in Communications/Payments shown. Bookmark-friendly URL persists filter state.
- **AC-6.9** Catalog status response cached for 60s per tenant; second hub render within 60s serves from cache (response includes `X-Cache: HIT` header). Operator clicks "Refresh All" → cache busted + all status providers re-queried + audit chain logs `INTEGRATION_HUB / STATUS_REFRESHED`.
- **AC-6.10** Cross-tenant access blocked: ADMIN of tenant A receives 404 on `GET /api/integrations/hub/<id>` if `<id>` resolves to a config row belonging to tenant B. Per-card test against tenant B's integration ID returns 404. Audit-chain entries scoped by tenant. ESLint rule prevents `req.body.tenantId` reads.

---

## §7 Out of scope

- **Marketplace install flow for 3rd-party plugins** (Zapier-like installable Apps from external developers). Phase 3 — requires plugin sandboxing + permission gating + revenue-share infra. THIS PRD covers first-party + sister-product integrations only.
- **OAuth-flow consolidation.** Each integration's OAuth flow (Google Calendar, Outlook, Meta WABA, Stripe Connect) lives in its own page. The hub deep-links to those flows but does not re-implement them. Consolidation is a Phase 2 effort (per DD-5.2).
- **Custom integration builder UI** (Zapier-style — operator wires up triggers + actions visually). Out of v1; the existing `routes/workflows.js` automation engine handles this for tenant-defined logic. Phase 3.
- **Per-integration billing / metering.** Tenants on a paid SaaS plan would meter usage per integration (e.g. "Stripe charges + WhatsApp messages count against your monthly cap"). Out of v1; metering infra is a parallel multi-tenant-pricing concern.
- **Integration-level webhook subscription UI.** Per-integration outbound webhooks (e.g. "send to my Slack when a Stripe webhook fires") are a Phase 2 enhancement on top of the existing `Webhook` model.
- **Multi-region credential vaulting** (Vault, AWS Secrets Manager, GCP Secret Manager). v1 stores credentials in the existing DB columns with optional AES-256-GCM encryption per `fieldEncryption.js` + `WELLNESS_FIELD_KEY` env var. Vault integration is Phase 2.
- **Test-history persistence.** v1 stores only `lastTestedAt` + `lastError` per integration. A full test-history table (timestamp + result + latency for every test) is Phase 2.
- **Bulk operations on integrations** ("disable all marketing integrations for this tenant in one click"). Out of v1; per-card operations only.
- **Per-vertical catalog filtering** (DD-5.5). v1 ships all-visible; per-vertical opt-in is v2.
- **Async test flow** (DD-5.6). v1 ships sync-only.
- **In-hub inline config forms** (DD-5.2). v1 ships deep-link-only; inline forms are v2.

---

## §8 Dependencies

- **Existing Prisma models (no migration in v1):** `Integration`, `ApiKey`, `Webhook`, `Chatbot`, `SsoConfig`, `ScimToken`, `MarketplaceConfig`, `SmsConfig`, `WhatsAppConfig`, `TelephonyConfig`, `CalendarIntegration` — all aggregated by the hub's status providers.
- **[backend/lib/credentialMasking.js](../backend/lib/credentialMasking.js)** — Credential masking + sentinel detection. THIS PRD's hub status responses MUST inherit the `{ configured, last4, lastRotatedAt }` shape on every credential field (closes #651).
- **[backend/routes/integrations.js](../backend/routes/integrations.js)** — Existing generic Integration REST surface + `AVAILABLE_INTEGRATIONS` static registry. THIS PRD's hub builds on the same pattern + extends to cover all the per-channel models.
- **[backend/routes/external.js](../backend/routes/external.js)** — External Partner API surface (`/api/v1/external/*`). THIS PRD's Sister Products section surfaces the ApiKey management for the same surface.
- **`backend/middleware/externalAuth.js`** — Existing X-API-Key auth middleware. THIS PRD's key-rotation flow integrates with the same model.
- **`backend/lib/audit.js`** `writeAudit()` — Audit chain integration. New entity `'INTEGRATION_HUB'` written transparently; hash chain inherits.
- **`backend/lib/eventBus.js`** — In-process event bus. v2 could subscribe to per-integration events (e.g. `STRIPE_WEBHOOK_FAILED` → flip status to ERROR) for real-time status. v1 stays pull-based.
- **`backend/lib/webhookDelivery.js`** — Outbound webhook dispatch with retry. Status provider for the Webhooks card aggregates per-webhook last-success/last-failure.
- **New file `backend/lib/integrationsRegistry.js`** — STATIC curated catalog (per DD-5.1).
- **New file `backend/lib/integrationStatus.js`** — Per-status-provider resolution logic.
- **New file `backend/routes/integrations_hub.js`** — 6 REST endpoints mounted at `/api/integrations/hub`.
- **New file `frontend/src/pages/Integrations.jsx`** — The hub page.
- **New static assets `frontend/public/logos/<provider>.svg`** — ~25 provider logos (one-time gather).
- **Sidebar entry** in `frontend/src/components/Sidebar.jsx` under Settings/Administration.
- **Lucide icons** (already in dependencies) — `Plug`, `Zap`, `CheckCircle`, `XCircle`, `AlertTriangle`, `Pause`, `Search`, `Filter`, `RefreshCw`, `Download`, `Upload`.
- **`React.lazy()` code-splitting** per existing App.jsx pattern.

---

## §9 Open questions

- **Q1 Categorize by FUNCTION (Comms/Payments/...) or by VENDOR (Stripe/Twilio/...)?** Per DD-5.7 — BY FUNCTION in v1. Confirm.
- **Q2 Sister-product integrations (Callified/AdsGPT) in the same hub or a separate "Globussoft Suite" section?** Per DD-5.4 — SAME HUB with a dedicated category. Confirm. Edge case: future Globussoft platform-admin role might want a separate cross-tenant "Sister Product Admin" view that's distinct from the per-tenant hub.
- **Q3 Catalog auto-update when a new integration ships, or developer manually updates the registry per release?** Per DD-5.1 — STATIC registry, manual updates. Confirm. Process question: should the deploy gate fail if a new `routes/<integration>.js` ships without a matching registry entry? Suggests a lint rule or test assertion.
- **Q4 Test button — synchronous (block UI) or async (notify on completion)?** Per DD-5.6 — SYNC in v1 with 5s timeout. Confirm. Edge case: OAuth re-auth flows that require operator interaction can't be synchronous; those integrations don't get a Test button in v1 (per FR-3.5.c) OR get a "Refresh OAuth" button that opens the OAuth flow in a new tab.
- **Q5 Per-tenant catalog (some integrations hidden for some tenants)?** Per DD-5.5 — ALL VISIBLE in v1. Confirm. Future: vertical-aware filtering (wellness tenants hide IndiaMART by default).
- **Q6 External Partner API key management — same hub or a sub-page?** Per DD-5.4 — SAME HUB. Confirm. Sub-question: who can issue/rotate sister-product keys — ADMIN only, or a future PLATFORM_ADMIN role for Globussoft engineers managing keys across tenants?
- **Q7 Health-status reporting in card — gauge / progress / simple traffic-light?** Per FR-3.11 — simple traffic-light (LIVE green / CONFIGURED gray / ERROR red). Confirm. Edge case: integrations with partial health (e.g. WhatsApp sending works but receiving is broken) would need multi-segment status, not single traffic-light. Defer to Phase 2.
- **Q8 Catalog ordering — alphabetical, popularity-based, custom-curated?** Not yet decided. Recommend custom-curated within each category (most-commonly-configured first); fallback to alphabetical within category. Edge case: a tenant that's already configured all integrations might want to see ERROR cards first regardless of category — FR-3.11 sort order handles this when ERROR filter is active.
- **Q9 Cache TTL — 60s in v1; configurable per tenant?** Per FR-3.3.c — 60s server-side. Confirm. Edge case: tenants on a paid SaaS tier might want sub-second freshness for status; defer to Phase 2 as a per-plan feature.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.3 / DD-5.4 / DD-5.6 + Q1 / Q4 before any code lands.

**Owner:** TBD per product call. Likely allocation:
- Static registry `backend/lib/integrationsRegistry.js` (25-30 entries with per-entry config) — backend engineer ~0.5 day
- Status provider `backend/lib/integrationStatus.js` (10 providers, each a Prisma query) — backend engineer ~1 day
- API routes `backend/routes/integrations_hub.js` (6 endpoints) — backend engineer ~0.5 day
- Caching layer (server-side 60s per-tenant) — backend engineer ~0.25 day
- Frontend page `frontend/src/pages/Integrations.jsx` (catalog grid + filters + cards + status badges) — frontend engineer ~1.5 days
- Test endpoint integration (per-card "Test" button + 5s-timeout + error surfacing) — full-stack ~0.5 day
- Sister-product API key management (new-key modal + revocation flow) — full-stack ~0.5 day
- Export/Import config flow (JSON download/upload + per-integration credential walk) — full-stack ~0.5 day
- RBAC enforcement + tests — backend engineer ~0.25 day
- Audit log integration — backend engineer ~0.25 day
- Provider logos gathering + SVG optimization — designer or engineer ~0.25 day
- Tests (api-spec for all 6 endpoints + vitest for registry + status providers + RBAC) — backend engineer ~0.5 day
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day

**Total estimated effort post-design: 4-6 engineering days** across backend + frontend (single page + status-aggregator backend + ~25-card registry; no schema migration; no new cron engine).

**Sibling PRDs in this cluster:**
- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance; deep-linked from hub)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops; consumes integration credentials)

**Blocks before frontend impl can start:**
- DD-5.1 (static vs auto-derived) — MUST resolve
- DD-5.2 (deep-link vs centralize) — MUST resolve
- DD-5.3 (live-polled vs cached) — MUST resolve
- DD-5.4 (sister-product placement) — MUST resolve
- DD-5.6 (sync vs async test) — MUST resolve
- Q1 (categorization scheme) — MUST resolve
- Q4 (test latency UX) — MUST resolve

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**
- **Slice 1** (~2 days): Static registry (25 entries) + status provider for 5 most-common integrations (Integration generic + SmsConfig + WhatsAppConfig + CalendarIntegration + Stripe via Integration) + 3 core API endpoints (`GET /hub`, `POST /hub/:id/test`, `POST /hub/:id/toggle`) + admin page with catalog + status badges + filters. Ships the discovery + status + test loop against the 5 most-common integrations.
- **Slice 2** (~1.5 days): Remaining 5+ status providers (ApiKey + Webhook + Chatbot + SsoConfig + ScimToken + MarketplaceConfig) + Sister Products section with API key management + audit log integration + RBAC enforcement.
- **Slice 3** (~1 day): Export/Import config flow + provider logos + caching layer + URL-state for filters.
- **Slice 4** (~0.5-1 day): Tests + wiring into CI gate-spec lists + brief internal `docs/integration-registry-guide.md` for "how to add a new integration to the hub".

Slices are mostly sequential; slice 2's status providers can parallelize across providers if each is dispatched to a separate agent (the providers are file-disjoint in `integrationStatus.js` via function-per-provider).

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — though the hub is vertical-agnostic and helps every tenant). Proposal: add a new entry **D11. Unified Integrations Hub (#858)** under cluster D — sibling to D8 (Purchase Orders), D9 (Payment Gateway Config), D10 (Import/Export Job History) which are the same operator-governance shape from the same PRD-batch wave. Cross-references to D9 (deep-link target for payment cards) + D10 (consumes integration credentials for notifications) recommended.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_PAYMENT_GATEWAY_CONFIG.md` ships the `/settings/payment-gateways` page that THIS PRD deep-links to from the Payments category.
- `PRD_IMPORT_EXPORT_JOBS.md` integration with Mailgun credentials surface — operators can verify Mailgun is LIVE via hub before triggering jobs with email-on-completion notifications.
- `routes/audit.js` `/verify` endpoint inherits INTEGRATION_HUB entries cleanly (no code change required).
- Sister-product key management overlaps with existing `Developer.jsx` page — coordinate whether Developer.jsx deprecates its API Keys tab in favor of the hub OR keeps it as a power-user surface (per DD-5.4 (c) hybrid option).
