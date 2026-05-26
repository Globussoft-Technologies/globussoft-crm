# PRD — Payment Gateway Configuration (Per-Tenant, Self-Serve)

**Status:** NOT STARTED — PRD draft only; design call needed before any code lands
**Source:** GH #848 — [Gap][PG-001] Payment Gateway configuration UI missing — Stripe/Razorpay keys only via env vars
**Tier:** P2 — Operator self-serve (currently blocks new-tenant onboarding without a backend redeploy)
**Authored:** 2026-05-25 (tick #188 / Agent B, autonomous overnight cron arc)
**Sibling PRDs:** `PRD_PLANS_BILLING_SELF_SERVE.md` (consumer of per-tenant gateway routing — DD-5.3 there explicitly defers gateway-config scope to THIS PRD), `PRD_TRAVEL_BILLING.md` (customer-receivable invoices → Pay Now button consumes the configured gateway), `PRD_PURCHASE_ORDERS.md` (supplier payouts on PO settlement; out-of-band today, gateway-routed in Phase 2)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D8/D9 (cluster D for procurement/billing operational features); see §10 for cluster proposal.
**Cred dependency:** GH #896 — P0 Activate Stripe + Razorpay (real keys onboarded). #896 covers the cred-side; THIS PRD covers the UI/data-model side. Both can land in parallel; the UI ships with masked / disabled state until #896 closes.

---

## §1 Background + source attribution

The CRM today **cannot self-serve gateway configuration**. Per GH issue #848 verbatim:

> The Payments dashboard shows a banner: "Stripe / Razorpay not configured. Payment-gateway keys are configured server-side as environment variables (not via this UI). Ask your administrator to set the variables below and restart the backend." There is no dedicated gateway configuration page in Settings or Channels.
>
> **Gap** — Tenants cannot self-serve gateway configuration:
> - No UI to enter/rotate Stripe or Razorpay credentials.
> - No way to enable/disable gateways per location/tenant from the app.
> - Requires backend restart — a developer/devops task, not a tenant action.
>
> **Impact** — Blocks self-serve onboarding for new tenants; manual ops work for every gateway change; no way to differentiate gateway settings per location/brand.

Today's gateway-config footprint in the codebase:

- **`routes/payments.js`** at [backend/routes/payments.js:14-41](../backend/routes/payments.js#L14-L41) — Lazy SDK loaders for Stripe + Razorpay read `process.env.STRIPE_SECRET_KEY` / `process.env.RAZORPAY_KEY_ID` / `process.env.RAZORPAY_KEY_SECRET` at first-use. Keys are process-global; ALL tenants share the SAME Stripe account + SAME Razorpay account. Multi-tenant isolation breaks at the gateway boundary today.
- **Webhook handlers** at [backend/routes/payments.js:110](../backend/routes/payments.js#L110) (`/webhook/stripe`) + [backend/routes/payments.js:163](../backend/routes/payments.js#L163) (`/webhook/razorpay`) — Both verify against a single env-var `STRIPE_WEBHOOK_SECRET` / `RAZORPAY_WEBHOOK_SECRET`. A multi-tenant gateway-config model needs per-tenant webhook-secret lookup keyed off the incoming event's `account` / `merchant` identifier.
- **`Integration` model** at [backend/prisma/schema.prisma:883](../backend/prisma/schema.prisma#L883) — Already lists `stripe` and `razorpay` in [backend/routes/integrations.js:20-31](../backend/routes/integrations.js#L20-L31) as `AVAILABLE_INTEGRATIONS`. The model carries one `token` String + one `settings` JSON-string field per (tenant, provider) — sufficient for OAuth-style integrations like Slack but **not shaped for the dual test-key + live-key + webhook-secret + currency-routing fields** the gateway-config requires. DD-5.4 (§5) covers the schema decision: extend `Integration` with discriminated payload OR fork to a new `PaymentGatewayConfig` model.
- **`backend/lib/credentialMasking.js`** at [backend/lib/credentialMasking.js:1-136](../backend/lib/credentialMasking.js) — Canonical masking helper for any sensitive credential. Returns `{ configured, last4 }` shape on GET; emits `****<tail>` sentinel; PUT path treats the sentinel as "user didn't retype this field" and skips. **THIS PRD reuses this helper verbatim — same shape, same sentinel, same skip-on-masked behavior.**
- **`backend/lib/fieldEncryption.js`** at [backend/lib/fieldEncryption.js:1-78](../backend/lib/fieldEncryption.js) — AES-256-GCM encryption helper. Opt-in via `WELLNESS_FIELD_KEY` env var. Encryption wraps values with `ENC:v1:<iv>:<tag>:<ct>` prefix; decryption is a no-op on legacy plaintext rows. **THIS PRD makes encryption MANDATORY for gateway-config (payment secrets are PCI-class; plaintext-at-rest is unacceptable). The PRD's first migration step seeds `WELLNESS_FIELD_KEY` if absent — see FR-3.7.**
- **`Tenant.defaultCurrency`** at [backend/prisma/schema.prisma:67](../backend/prisma/schema.prisma#L67) — single string (`USD` / `INR` / `EUR` / …). Per-tenant currency routing requires reading this PLUS a per-tenant gateway-currency-mapping (e.g. Indian tenant → Razorpay handles INR; same tenant's USD sales → Stripe). DD-5.6 (§5) covers placement of the routing-rule data.
- **`Tenant.country`** at [backend/prisma/schema.prisma:66](../backend/prisma/schema.prisma#L66) — drives default gateway pick: country=IN → suggest Razorpay; country=US/UK/EU → suggest Stripe. Used as a SUGGESTION default in the admin UI; operator overrides.

### Why this is a P2, not a P0

Today's workaround works: operators with backend access set env vars, restart PM2, and the gateway lights up. The workaround is operationally OK for a 2-tenant deployment (current state — generic + wellness) but breaks the moment Globussoft adds the third tenant (e.g. Travel Stall + RFU as separate sub-brands with their own Razorpay merchant accounts, or a Dubai-based wellness clinic with its own Stripe account). Every new tenant becomes a deploy-day for ops. The risk class is "self-serve blocked + manual ops creep per new tenant + ALL tenants share one merchant identity (audit-trail confusion + KYC pollution risk)" — material as Globussoft scales tenants, not a hot fire today.

### The dual-axis problem

Two orthogonal axes must be modeled together:

1. **Per-tenant axis.** Each tenant has its own Stripe account + Razorpay account + own KYC + own settlement bank. Tenant T1's keys must not be reachable by Tenant T2's webhook handler.
2. **Per-mode axis (test vs live).** Every gateway has TEST keys (for sandbox iteration on staging or in operator-training mode) + LIVE keys (for real money). The toggle is per-gateway-per-tenant; switching modes affects which keys load at API call time.

The cross-product is `(tenant) × (gateway) × (mode)` configurations — a tenant with both Stripe + Razorpay configured in both test + live modes has 4 distinct credential bundles, each of which carries (publishable_key, secret_key, webhook_secret). Currency-routing rules sit ABOVE this: "tenant T1's INR sales route to gateway=razorpay, mode=live" is a routing rule that picks one of the 4 bundles at runtime.

### Source attribution

- GH issue #848 — [gh issue view 848](https://github.com/Globussoft-Technologies/globussoft-crm/issues/848)
- GH issue #896 (cred-side dep) — Activate Stripe + Razorpay; P0 cred chase
- Related: GH #775 ([POS-006] Invoice schema generic, not polymorphic) — invoices reference a single `gateway` field today; multi-gateway tenants need per-invoice gateway-resolution at Pay-Now time (FR-3.6.c covers).
- Cross-reference: `PRD_PLANS_BILLING_SELF_SERVE.md` DD-5.3 — "Stripe Customer model? Razorpay Customer model? Both (per-tenant-currency routing — INR tenants → Razorpay, others → Stripe)? Owner: Globussoft + #848 PG-001 PRD author." THIS PRD is the authoritative source for that decision.
- Cross-reference: `PRD_TRAVEL_BILLING.md` — invoice line items reference gateway IDs in metadata for reconciliation; consumer of this PRD's per-tenant gateway resolution.
- Cross-reference: `PRD_PURCHASE_ORDERS.md` §7 ("Out of scope: supplier payouts via gateway") — Phase 2 consumer of THIS PRD's gateway-config + a new payout-direction flag.

---

## §2 Use cases

1. **New-tenant gateway onboarding (no developer involvement).** Globussoft onboards a new clinic chain (Aesthetic Clinics Pvt Ltd, vertical=wellness, country=IN, defaultCurrency=INR). After tenant provisioning, the Owner logs in → navigates to `/settings/payment-gateways` → sees two cards (Stripe + Razorpay) with "Not configured" badges. Owner clicks "Configure Razorpay" → form opens with fields: Mode toggle (Test/Live, default Test), Publishable Key (`rzp_test_xxx`), Secret Key (write-only, masked on save), Webhook Secret (provided by Razorpay dashboard), Enabled toggle. Owner pastes test keys → clicks "Test Connection" → backend pings Razorpay API → success badge → Owner clicks Save → state persists encrypted. Webhook URL `https://<host>/api/payments/webhook/razorpay?tenant=<token>` displayed for Owner to copy into Razorpay dashboard. Two weeks of test-mode use later, Owner flips Mode toggle to Live → re-enters live keys → Test Connection → Save. NO backend restart, NO devops ticket.

2. **Key rotation after a security incident.** Owner of an existing tenant suspects a leaked Razorpay secret key (employee turnover, GitHub-secret-scan alert, etc.). Owner opens `/settings/payment-gateways/razorpay` → form pre-filled with `{ configured: true, last4: '****abc1' }` masking → Owner clicks "Rotate Secret" → enters new full secret in the now-empty field → clicks Save → backend overwrites with the new value encrypted at rest. Audit log records `PAYMENT_GATEWAY_KEY_ROTATED` event with `{ gateway: 'razorpay', mode: 'live', rotatedBy: <userId>, rotatedAt }` (key value NEVER logged). The OLD key continues to verify webhooks for a configurable grace window (default 24h, FR-3.5.d) so in-flight payments don't drop.

3. **Multi-currency tenant (cross-axis routing).** Globussoft hosts a tenant "GlobalWellness" with locations in Mumbai (INR), Singapore (SGD), and London (GBP). Owner configures Razorpay (for INR) + Stripe (for SGD and GBP). On the routing-rules UI, Owner sets: `INR → razorpay-live`, `SGD → stripe-live`, `GBP → stripe-live`, `* → stripe-live` (fallback). When a Mumbai location creates an invoice with currency=INR, the Pay Now button generates a Razorpay order. The Singapore invoice generates a Stripe checkout. Operators don't pick the gateway — the routing engine resolves per-currency automatically.

4. **Test-mode operator training.** Trainer Sumit at Globussoft onboards Owner Rishu to the new POS module. Rishu wants to click through a full purchase flow without spending real money. Rishu's tenant is in TEST mode for Razorpay → all Pay Now buttons hit the Razorpay sandbox → test card succeeds → invoice marks PAID → receipt fires → workflow rules run. Zero real-money exposure during training. Trainer flips the toggle to LIVE on a real customer transaction.

5. **Audit trail for compliance.** PCI-DSS auditor asks: "Show every key rotation event for tenant T5 in the last 12 months — who, when, which gateway, which mode." Audit log query against `entity = 'PaymentGatewayConfig'` AND `action = 'KEY_ROTATED'` AND tenantId=5 returns the timeline. Cross-references the audit hash chain via `routes/audit.js` `/verify` endpoint (tamper-evident).

6. **Adding a new gateway provider (extensibility).** A future tenant needs PayPal (e.g. a North-American wellness clinic). The provider-extension hook (FR-3.2) lets a backend engineer add `provider: 'paypal'` to the `SUPPORTED_PROVIDERS` map + ship a `paypalGateway.js` adapter that conforms to the gateway-adapter interface. UI auto-renders the new provider card. **No UI code change required** to add new providers — the provider-list is data-driven.

7. **Disable a gateway temporarily.** Tenant's Razorpay merchant account is under KYC review by Razorpay — settlements are paused but credentials are still valid. Owner toggles Razorpay → "Enabled: OFF". Pay Now buttons for INR invoices now show "Payment temporarily unavailable; contact admin" until Owner re-enables. NO key rotation needed; the data persists.

---

## §3 Functional requirements

### FR-3.1 Per-tenant gateway config CRUD

- **FR-3.1.a List endpoint.** `GET /api/payment-gateways` → returns array of gateway-config rows scoped to `req.user.tenantId`. Each row carries `{ id, provider, mode, enabled, publishableKey, secretKey: { configured, last4 }, webhookSecret: { configured, last4 }, webhookUrl, lastTestAt, lastTestStatus, lastRotatedAt, createdAt, updatedAt }`. Secret + webhook-secret values NEVER leave the backend in plaintext (use `describeCredential()` from `credentialMasking.js`).
- **FR-3.1.b Detail endpoint.** `GET /api/payment-gateways/:id` → returns single row (same shape).
- **FR-3.1.c Create endpoint.** `POST /api/payment-gateways` body `{ provider, mode, publishableKey, secretKey, webhookSecret, enabled }`. ADMIN role only. `provider` must match `SUPPORTED_PROVIDERS`. Server encrypts `secretKey` + `webhookSecret` via `encryptCredential()` before persisting.
- **FR-3.1.d Update endpoint.** `PUT /api/payment-gateways/:id` body same shape. ADMIN role only. Fields ending in the masked-sentinel pattern (`****<tail>`) are SKIPPED per `looksLikeMaskedSentinel()` — preserves existing values when operator leaves a field blank. Publishable key + enabled + mode are non-sensitive and update directly.
- **FR-3.1.e Delete endpoint.** `DELETE /api/payment-gateways/:id` → soft-delete (set `deletedAt`). ADMIN role only. Hard-delete blocked because: (a) audit chain references; (b) historic invoices reference the gatewayConfig's webhook secret for past reconciliation. A soft-deleted row's secrets remain decryptable for the chain but the row is hidden from the UI list endpoint + excluded from routing-rule resolution.
- **FR-3.1.f Tenant-scoping invariant.** Every handler scopes by `req.user.tenantId`. Cross-tenant FK access impossible. Mirrors all other CRM routes' tenantWhere pattern. ESLint `req.body.tenantId` rule applies — gateway-config never accepts a body-supplied tenantId.

### FR-3.2 Provider extensibility hook

- **FR-3.2.a `SUPPORTED_PROVIDERS` map.** `backend/lib/paymentGatewayRegistry.js` (new) exports a const map: `{ stripe: { adapter: require('./stripeGateway'), displayName: 'Stripe', countries: ['US','GB','EU','AU','SG','...'], currencies: ['USD','GBP','EUR','...'] }, razorpay: { adapter: require('./razorpayGateway'), displayName: 'Razorpay', countries: ['IN'], currencies: ['INR'] } }`.
- **FR-3.2.b Gateway adapter interface.** Each adapter exports `{ testConnection(config), createPaymentIntent(config, amount, currency, metadata), verifyWebhookSignature(config, body, signature), reconcilePayment(config, gatewayPaymentId) }`. Stripe + Razorpay adapters implement this interface; the adapter is the only file that imports the gateway SDK (lazy-loaded for cold-start performance).
- **FR-3.2.c Phase 2 providers.** PayPal, Paystack (Africa), Mollie (EU), MercadoPago (Latin America), Flutterwave (Africa). Adding each is "implement adapter + register in `SUPPORTED_PROVIDERS`"; no UI change. Out-of-scope of v1; v1 ships Stripe + Razorpay only.

### FR-3.3 Test vs Live mode

- **FR-3.3.a `mode` column.** Enum: `TEST` | `LIVE`. Default on first create: `TEST`. Toggle visible on every gateway-config card.
- **FR-3.3.b One row per (tenant, provider, mode).** Unique constraint `@@unique([tenantId, provider, mode, deletedAt])` allows BOTH test + live configs to coexist per provider per tenant. The active row per (tenant, provider) is whichever mode the tenant's routing rules select at runtime.
- **FR-3.3.c Mode-switch UX.** When Owner flips an `enabled: TEST` row to `LIVE`, the form clears the secret fields (forces re-entry) — test secrets are NOT valid live secrets. The publishableKey field stays editable (some operators paste the test publishable for double-check).
- **FR-3.3.d Pay-time mode resolution.** When a Pay Now button fires for an invoice, the routing engine looks up the tenant's currency → resolves to provider → picks the (tenant, provider, mode=LIVE if enabled, else TEST). If no LIVE row exists for the currency, the button shows "Payment not configured" (NOT a silent test-mode fallback — would lose real revenue).

### FR-3.4 Field masking + sentinel detection

- **FR-3.4.a Reuse `credentialMasking.js`.** Every secret-field read goes through `describeCredential()` → returns `{ configured, last4 }`. Every secret-field write filters through `looksLikeMaskedSentinel()` → if sentinel, SKIP; if plaintext, encrypt + persist.
- **FR-3.4.b Audit-log payload masking.** When `writeAudit(...)` records a gateway-config write, the `details` object passes through `maskConfigRow(details, ['secretKey', 'webhookSecret'])` — audit log never contains plaintext credentials. Mirrors the existing wellness-clinical PHI audit-payload pattern.
- **FR-3.4.c Test-connection responses.** When operator clicks "Test Connection", the response carries `{ ok, message }` only — NO echo of the credential that was tested. If Stripe rejects with "Invalid API Key: sk_test_xxx", the response strips the key tail and returns `{ ok: false, message: 'Invalid API Key (test mode)' }`. Prevents an over-permissive XSS surface from echoing back the secret.

### FR-3.5 Webhook secret + endpoint URL management

- **FR-3.5.a Per-tenant webhook URL.** Each gateway-config row carries a derived `webhookUrl` (computed at GET-time, not stored): `https://<APP_HOST>/api/payments/webhook/<provider>?tenant=<webhookToken>`. The `webhookToken` is a row-scoped opaque random token (16-byte hex, stored as `webhookToken` column, NOT settled-secret). Webhook handler resolves the (tenant, provider, mode) row by `webhookToken`; loads its `webhookSecret` for HMAC verification.
- **FR-3.5.b Webhook handler refactor.** `routes/payments.js:110` (`/webhook/stripe`) + `:163` (`/webhook/razorpay`) currently read a single `process.env.STRIPE_WEBHOOK_SECRET`. The refactor reads the `tenant` query-param (or for Stripe, the `account` field on the event payload), looks up the matching gateway-config row, and verifies HMAC with that row's `webhookSecret`. Cross-tenant webhook spoofing impossible because the row's webhookToken is unique + the secret is per-row.
- **FR-3.5.c Webhook URL copy-to-clipboard.** UI displays the `webhookUrl` with a copy button. The first time a tenant configures a gateway, the form shows step-by-step "Paste this URL in Razorpay Dashboard → Settings → Webhooks → Add Webhook → Active Events: payment.captured, payment.failed, refund.processed". A markdown-rendered help block per provider, sourced from `paymentGatewayRegistry.js`.
- **FR-3.5.d Webhook-secret rotation grace window.** When operator rotates `webhookSecret`, the OLD secret is retained in a `previousWebhookSecret` column for a configurable grace window (default 24h via `Tenant.gatewayWebhookGraceHours` or constant). During the window, the webhook handler tries the new secret first, then the old as fallback. After window expiry, the previousWebhookSecret column is cleared via a cron sweep (new `gatewayCredentialCleanupEngine.js` daily at 03:30 UTC). Prevents in-flight payments from dropping during rotation.

### FR-3.6 Currency-routing rules

- **FR-3.6.a Routing-rule data.** Per-tenant routing rules live in a new `PaymentRoutingRule` model: `{ id, tenantId, currency, gatewayConfigId, priority, enabled, createdAt }`. Composite uniqueness `@@unique([tenantId, currency, priority])` allows multiple rules per currency (fallback chain).
- **FR-3.6.b Default routing on first gateway-config save.** When operator saves a gateway-config with `enabled: true` AND no routing rules yet exist for the tenant, system auto-creates rules `{ currency: <provider's primary>, gatewayConfigId: <new row>, priority: 1 }` — Razorpay → INR, Stripe → tenant.defaultCurrency. Operator can edit later.
- **FR-3.6.c Pay-time resolution.** Pay Now button on invoice with currency=X calls `resolveGatewayForCurrency(tenantId, currency)` → returns the highest-priority enabled `PaymentRoutingRule` row's `gatewayConfigId` → loads that row → uses its credentials. If no rule matches AND no fallback `*` rule exists, the Pay Now button is disabled with "Payment not configured for currency X".
- **FR-3.6.d Fallback `*` rule.** Operator can configure a wildcard rule `{ currency: '*', gatewayConfigId: <row>, priority: 99 }` — used when no currency-specific rule matches. Common pattern: tenant configures Razorpay for INR + Stripe as fallback for everything else.
- **FR-3.6.e Routing-rules UI.** `/settings/payment-gateways/routing` page shows a table: Currency → Gateway → Priority → Enabled. Operator drag-reorders priority; toggles enabled; saves. Inline guidance ("Currently 3 currencies use Razorpay-Live; 1 currency falls through to Stripe-Live as the wildcard").

### FR-3.7 Encryption at rest (MANDATORY)

- **FR-3.7.a Migration step.** First deploy of this PRD's schema runs a migration that:
  1. Adds `PaymentGatewayConfig` + `PaymentRoutingRule` models.
  2. Adds `Tenant.gatewayWebhookGraceHours: Int @default(24)`.
  3. Checks `process.env.WELLNESS_FIELD_KEY` is set; if not, the migration EXITS with error "Encryption key required for PaymentGatewayConfig migration — set WELLNESS_FIELD_KEY before applying". Forces operator to provision encryption before the schema lands.
- **FR-3.7.b Encryption on every secret write.** `secretKey` + `webhookSecret` + `previousWebhookSecret` are wrapped in `encryptCredential()` from `credentialMasking.js` before INSERT/UPDATE. Reads decrypt via `decryptCredential()` only inside the adapter's send-path (never in the route handler — minimizes plaintext-in-memory surface).
- **FR-3.7.c Key derivation alternative (defer).** A future PRD may migrate from `WELLNESS_FIELD_KEY` shared-secret to a per-tenant DEK (Data Encryption Key) wrapped by a KEK (Key Encryption Key) held in a vault. DD-5.5 (§5) covers; v1 uses the existing shared-key helper for shipping speed.
- **FR-3.7.d Backup-friendly.** Encrypted values are version-prefixed (`ENC:v1:<iv>:<tag>:<ct>`) so future key rotations can re-encrypt in place via a backfill cron. No plaintext-only backup path.

### FR-3.8 Audit log integration

Audit chain entries (via `backend/lib/audit.js` `writeAudit(entity, action, entityId, userId, tenantId, details)`):

- `PAYMENT_GATEWAY_CONFIG` + `CREATED` — on new gateway-config row; details = `{ provider, mode, enabled, publishableKeyLast4 }` (secrets masked).
- `PAYMENT_GATEWAY_CONFIG` + `UPDATED` — on PUT; details = `{ provider, mode, fieldsChanged: ['publishableKey','enabled', ...] }` (which non-secret fields changed; secrets only enumerated by name, never by value).
- `PAYMENT_GATEWAY_CONFIG` + `KEY_ROTATED` — on secret-key rotation; details = `{ provider, mode, rotatedField: 'secretKey'|'webhookSecret', rotatedBy: <userId> }`. NO plaintext anywhere.
- `PAYMENT_GATEWAY_CONFIG` + `TEST_INVOKED` — on Test Connection call; details = `{ provider, mode, ok, durationMs }`.
- `PAYMENT_GATEWAY_CONFIG` + `ENABLED_TOGGLED` — on enable/disable; details = `{ provider, mode, enabled: true|false }`.
- `PAYMENT_GATEWAY_CONFIG` + `DELETED` — on soft-delete; details = `{ provider, mode, reason: req.body.reason }`.
- `PAYMENT_ROUTING_RULE` + `CREATED` / `UPDATED` / `DELETED` — on routing-rule changes; details = `{ currency, gatewayConfigId, priority, enabled }`.

Chain inherits the existing hash-chain immutability. The `/api/audit/verify` endpoint at `routes/audit.js` works against these entries with zero code changes.

### FR-3.9 RBAC

- **FR-3.9.a ADMIN-only writes.** POST / PUT / DELETE on `/api/payment-gateways` and `/api/payment-routing-rules` require `verifyRole(['ADMIN'])`. Reads (GET) allow MANAGER + ADMIN (operations team can audit settings without granting write).
- **FR-3.9.b USER role blocked entirely.** Even reads. The masked `last4` is informational about which key is configured; a low-trust USER role doesn't need it.
- **FR-3.9.c Self-tenant-only.** No super-admin cross-tenant view in v1 (the demo box's `admin@globussoft.com` is generic-tenant scoped, not super-admin). A future "Globussoft platform admin" role for cross-tenant ops is a separate scope.

### FR-3.10 Test Connection endpoint

- **FR-3.10.a Endpoint.** `POST /api/payment-gateways/:id/test` → loads the gateway-config row, decrypts the secret, calls `adapter.testConnection(config)` from `paymentGatewayRegistry.js`. Stripe adapter calls `stripe.balance.retrieve()` (lightweight); Razorpay adapter calls `razorpay.orders.all({ count: 1 })` (lightweight). Returns `{ ok, message, durationMs }`.
- **FR-3.10.b Rate limit.** Express-rate-limit middleware: 20 calls per 15 minutes per tenant per gateway-config (prevent gateway ToS violations from accidental test-loop firings). Mirrors `/auth/login` rate-limit pattern in [backend/server.js](../backend/server.js).
- **FR-3.10.c Stored last-test-result.** On every test invocation, persist `lastTestAt: DateTime` + `lastTestStatus: String` ("ok" | "fail: <message>") on the gateway-config row. UI shows "Last verified: 2026-05-25 10:30 ago" badge.
- **FR-3.10.d Block save-until-test option (OQ-9.5).** If tenant config enables `Tenant.requireTestBeforeSaveGateway: boolean`, the PUT endpoint rejects with 409 "Test connection required before save". Default OFF — most operators want to save mid-config + test later.

---

## §4 Non-functional

- **Per-tenant scoping.** Every row carries `tenantId` FK to Tenant. Every handler scopes by `req.user.tenantId`. Cross-tenant access impossible. Mirrors all other CRM route patterns.
- **Encryption at rest.** Secret key + webhook secret + previousWebhookSecret stored as AES-256-GCM ciphertext via `fieldEncryption.js`. Plaintext never persisted. Migration enforces `WELLNESS_FIELD_KEY` presence before schema lands.
- **Audit immutability.** All state changes write to the tamper-evident audit chain via `lib/audit.js`. Hash-chain integrity preserved.
- **Rate limit on /test endpoint.** 20 calls / 15 min / tenant / config. Prevents ToS violations.
- **Mask in logs.** Audit payloads never carry plaintext credentials. Console logs scrub via existing log-redactor where possible (Q22 follow-up for systematic log redaction is a separate PRD).
- **Test Connection latency.** Stripe `balance.retrieve()` typically <500ms; Razorpay `orders.all({count:1})` typically <800ms. p95 timeout set to 5s; failure returns `{ ok: false, message: 'timed out' }`.
- **Webhook handler tolerance.** Webhook handler tolerates up to 50ms per webhook to look up the (tenant, provider) row → verify signature. Adds an index on `webhookToken` for O(1) lookup.
- **Migration backward-compat.** Existing env-var-only flow continues to work during rollout: if no `PaymentGatewayConfig` row exists for a (tenant, provider, mode), the payment-intent code path falls back to env-var creds (logged as a deprecation warning per call). Tenants migrate at their own pace; after a configurable grace period (e.g. 90 days post-PRD-ship), the env-var fallback is removed.
- **Multi-region.** No regional concerns in v1 (single-region MySQL). Gateway SDKs handle their own regional endpoints.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / security-team sign-off before backend impl can start)

- **DD-5.1 One Stripe account per tenant (own key) vs Globussoft Connect Stripe with tenant subaccounts?** Two business models:
  - **(a) BYOK ("Bring Your Own Key"):** Each tenant onboards its own Stripe account directly with Stripe; settlements go to the tenant's bank; KYC done by Stripe with the tenant; Globussoft has no settlement responsibility.
  - **(b) Stripe Connect platform mode:** Globussoft is the Stripe platform; tenants are connected accounts; settlements flow through Globussoft's master account; Globussoft handles KYC + reporting; Globussoft can take a % fee per transaction.
  Trade-offs: (a) is faster to ship + zero Globussoft KYC overhead + matches current single-key reality + zero platform-fee revenue. (b) is the SaaS-PaaS standard (Shopify / Lightspeed / WooCommerce all use Connect) + enables platform-fee revenue + Globussoft holds the merchant relationship → smaller-tenant churn risk vs gain. **Recommendation: (a) BYOK for v1 because it's the structurally-simpler shape AND it matches today's env-var-keyed reality (just per-tenant instead of per-process).** (b) is a Phase 2 enhancement that requires a separate Stripe Connect onboarding flow + accounting changes + per-tenant fee splits — substantial scope. The PRD explicitly defers (b).
- **DD-5.2 Razorpay equivalent — direct keys (BYOK) or Razorpay Route?** Razorpay Route is the equivalent of Stripe Connect (Globussoft as marketplace; sub-merchants under it). Same analysis as DD-5.1 applies. **Recommendation: BYOK for Razorpay in v1; Razorpay Route is Phase 2.**
- **DD-5.3 Test-mode key auto-rotation policy.** Should test-mode keys auto-rotate every 90 days for security hygiene? Test keys can't move real money but they CAN reveal the SDK shape + endpoint catalog to a leaker. Auto-rotation requires the operator to handle the rotation event — non-trivial UX. **Recommendation: NO auto-rotation in v1.** Operator-initiated rotation only. Test-key leak risk is low; the UX cost of forced rotation outweighs.
- **DD-5.4 Schema choice — extend `Integration` model vs new `PaymentGatewayConfig` model?** Two paths:
  - **(a) Extend Integration:** Stuff (mode, publishableKey, secretKey, webhookSecret, webhookToken, lastTestAt, lastTestStatus, lastRotatedAt) into `settings` JSON. Pro: one model fewer; matches existing OAuth-style integrations (Slack, Google). Con: complex JSON queries; no Prisma type safety; routing-rule FK targets a JSON blob row.
  - **(b) New PaymentGatewayConfig model:** First-class fields; clean FK targets; per-tenant unique constraint; Prisma type safety; future provider-specific columns (Stripe `accountId`, Razorpay `merchantId`) are real columns. Con: one more model + one more route file.
  **Recommendation: (b) NEW MODEL.** Payment gateway is structurally distinct from Slack/Google OAuth — test/live mode bifurcation + routing rules + webhook tokens + grace-period field don't belong in a generic `settings` JSON. The Integration model stays for OAuth-style integrations; PaymentGatewayConfig handles its own domain.
- **DD-5.5 Encryption — fieldEncryption.js (existing AES-GCM helper) vs external KMS (AWS KMS / GCP KMS / HashiCorp Vault)?** **Recommendation: EXISTING fieldEncryption.js for v1.** It's AES-256-GCM with versioned ciphertext; sufficient for tenant-isolation through encryption. External KMS migration is a separate PRD when Globussoft's compliance posture requires it (e.g. PCI-DSS Level 1 vs Level 4 — current footprint is Level 4-ish).
- **DD-5.6 Routing rules — in PaymentGatewayConfig row OR in a separate PaymentRoutingRule table OR in Tenant.paymentRouterJson blob?** Three options:
  - **(a) Inside PaymentGatewayConfig:** Each config row has `currencies: Json` listing the currencies it handles. Resolver scans all enabled rows + picks one matching currency. Pro: one fewer model. Con: priority/fallback semantics awkward in JSON.
  - **(b) Separate PaymentRoutingRule table:** First-class rows with priority + currency + gatewayConfigId. Resolver does a single indexed query. Pro: clean priority semantics; easy admin UI. Con: one more model.
  - **(c) Tenant.paymentRouterJson:** Single JSON blob on Tenant carrying the routing table. Pro: zero migrations + simple. Con: large JSON updates + no FK integrity (gatewayConfigId could dangle).
  **Recommendation: (b) NEW TABLE.** Routing is a first-class operator concern + needs admin UI + the priority/fallback resolution is too complex for JSON. Mirrors the `LeadRoutingRule` shape that already exists in the codebase for lead-routing.
- **DD-5.7 Wellness-style PHI-class "writer/reader" gate split for the keys themselves?** Should the operator who CAN see "configured: true" be different from the operator who CAN edit? Probably no — both should require ADMIN. The "reader" role would be MANAGER (audit settings without write). **Recommendation: ADMIN-write + MANAGER+ADMIN-read per FR-3.9.** USER blocked entirely.
- **DD-5.8 Audit-log retention for key rotation events — match GDPR DSAR window (7 years) or longer (10 years for SOC2 / PCI-DSS)?** Currently audit-chain has no retention policy (retained indefinitely). **Recommendation: KEEP INDEFINITE for v1.** Audit-chain volume is tiny relative to overall DB (a few key rotations per tenant per year). Implement retention sweep in a separate audit-management PRD when DB size becomes a concern.

### Cred chase

- **GH #896 — Activate Stripe + Razorpay (P0).** Cred-side dependency. Globussoft + Rishu's wellness tenant + Travel Stall tenant each need real Stripe + Razorpay accounts onboarded. THIS PRD's UI ships in a "config-empty" state where the form works but submitting saves a row in `mode: TEST` with no real keys (operator-friendly empty state). When #896 closes, operators paste real keys; THIS PRD's flow accepts them transparently.
- **WELLNESS_FIELD_KEY env var.** Must be set on demo + production before the v1 migration applies. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` generates a fresh 32-byte hex. Add to `.env` and PM2 restart. Migration script checks for presence on apply.
- **No external SDK upgrade required.** Stripe + Razorpay SDKs already in `package.json`.

### Vendor docs

- **Stripe Connect docs** (for DD-5.1 Phase 2 evaluation): https://stripe.com/docs/connect
- **Stripe webhook verification docs:** https://stripe.com/docs/webhooks/signatures
- **Razorpay Routes docs** (for DD-5.2 Phase 2 evaluation): https://razorpay.com/docs/payments/route/
- **Razorpay webhook signature verification:** https://razorpay.com/docs/webhooks/validate-test/

---

## §6 Acceptance criteria

- **AC-6.1** Owner with ADMIN role logs in → navigates to `/settings/payment-gateways` → sees a list of Stripe + Razorpay cards. Cards show "Not configured" badge initially. Clicking a card opens the config form. POST `/api/payment-gateways` with valid keys → row created + audit-chain entry written + form returns to list view showing "Configured" badge with `last4` tail.
- **AC-6.2** Owner clicks "Rotate Secret" on an existing config → form's secretKey field is empty (NOT pre-filled with the masked sentinel) → Owner pastes new key → Save → backend overwrites encrypted at rest → audit log records `KEY_ROTATED` with no plaintext → UI returns to list showing updated `lastRotatedAt`.
- **AC-6.3** Owner toggles Mode from TEST to LIVE on a Stripe config → form clears the secretKey field → Owner pastes live key → Test Connection succeeds → Save. New (tenant=T, provider=stripe, mode=LIVE) row created; the TEST row preserved (unique constraint on `(tenantId, provider, mode, deletedAt)` allows both). Routing-rule UI shows the new LIVE row available for routing-rule selection.
- **AC-6.4** Operator creates a routing rule `{ currency: 'INR', gatewayConfigId: <razorpay-live-row>, priority: 1 }`. Owner creates an invoice with currency=INR → Pay Now button generates a Razorpay order. Resolver picks the priority-1 rule. If razorpay-live row is disabled, resolver falls through to the wildcard rule (if any) or shows "Payment not configured for currency INR".
- **AC-6.5** Owner clicks "Test Connection" → backend calls `adapter.testConnection(decryptedConfig)` → returns `{ ok: true, message: 'Authenticated', durationMs: 423 }`. Audit log records `TEST_INVOKED`. Rate-limit on the endpoint: 21st call within 15 min returns 429.
- **AC-6.6** Webhook handler receives a Razorpay event → reads the `tenant` query-param → looks up the (tenant, razorpay, mode=LIVE) row → loads its `webhookSecret` (decrypted) → verifies HMAC → processes the event. Webhooks for tenants whose row has been soft-deleted return 410 Gone.
- **AC-6.7** Owner rotates a webhook secret → the old secret persists in `previousWebhookSecret` for 24h (configurable). During the window, incoming webhooks verify against EITHER secret. After 24h, a cleanup cron clears `previousWebhookSecret`. Audit log records both the rotation and the cleanup.
- **AC-6.8** USER role hits `GET /api/payment-gateways` → 403 Forbidden (RBAC). MANAGER role → 200 OK with masked rows. ADMIN role → 200 OK with masked rows + write endpoints accessible.
- **AC-6.9** Owner soft-deletes a gateway-config row → row no longer appears in list endpoint → routing rules referencing the row are auto-disabled (with operator-facing notice in the routing-rules UI) → audit log records `DELETED`.
- **AC-6.10** Cross-tenant attack: User in tenant T1 sends `PUT /api/payment-gateways/<T2-row-id>` → 404 Not Found (tenantWhere clause). Audit chain has zero T2-row entries written by T1.

---

## §7 Out of scope

- **Stripe Connect / Razorpay Route platform mode** (per DD-5.1 + DD-5.2 Recommendation: BYOK only for v1). Phase 2 — separate PRD.
- **Subscription billing flows.** Covered by `PRD_PLANS_BILLING_SELF_SERVE.md`. THIS PRD provides the gateway-config foundation; subscription flows USE this PRD's resolver but they are not authored here.
- **Refund-recommendation engine.** AI-driven "should this dispute be refunded" suggestions. Phase 2; separate PRD.
- **Auto-rotation cron for test keys.** Per DD-5.3 — out of v1.
- **PayPal / Paystack / Mollie adapters.** Phase 2; the extensibility hook FR-3.2 makes adding them straightforward, but v1 ships Stripe + Razorpay only.
- **External KMS migration** (AWS KMS / HashiCorp Vault). Per DD-5.5 — out of v1.
- **Cross-tenant Globussoft super-admin view** of gateway settings. Future "Globussoft platform admin" role is a separate scope.
- **Bulk-import gateway configs from CSV.** Single tenant at a time via UI in v1.
- **Per-location gateway override.** A tenant with locations in Mumbai (INR via Razorpay) + Dubai (AED via Stripe) needs per-location routing. Issue #848 mentions this in passing ("no way to differentiate gateway settings per location/brand"). **Recommendation: defer to Phase 1.5** — adds a `locationId` FK to PaymentRoutingRule; small extension but adds UX surface. Validate the per-location demand with at least 2 real tenants before extending.
- **Webhook event-log replay UI.** When a webhook fails, operator can see the failure but can't replay. Out of v1; gateway dashboards have their own replay UI.
- **Settlement reporting / payout reconciliation.** Out of v1; covered separately by `PRD_TRAVEL_BILLING.md` reconciliation layer.

---

## §8 Dependencies

- **`Integration` model** ([backend/prisma/schema.prisma:883](../backend/prisma/schema.prisma#L883)) — Existing. PaymentGatewayConfig is a SIBLING (not extension); per DD-5.4 recommendation.
- **`Tenant` model** ([backend/prisma/schema.prisma:58](../backend/prisma/schema.prisma#L58)) — Existing. New additive field `gatewayWebhookGraceHours: Int @default(24)`. Optional: `requireTestBeforeSaveGateway: Boolean @default(false)` per OQ-9.5.
- **`Tenant.defaultCurrency`** ([backend/prisma/schema.prisma:67](../backend/prisma/schema.prisma#L67)) — Existing. Read by routing-resolver as the fallback when no rule matches.
- **`Tenant.country`** ([backend/prisma/schema.prisma:66](../backend/prisma/schema.prisma#L66)) — Existing. Read by admin UI to suggest default gateway (IN → Razorpay; else Stripe).
- **`backend/lib/fieldEncryption.js`** ([backend/lib/fieldEncryption.js:1](../backend/lib/fieldEncryption.js)) — AES-256-GCM helper. Existing. Used directly via `encryptCredential()` / `decryptCredential()`.
- **`backend/lib/credentialMasking.js`** ([backend/lib/credentialMasking.js:1](../backend/lib/credentialMasking.js)) — Existing. Reused verbatim for `describeCredential()` + `looksLikeMaskedSentinel()` + `maskConfigRow()`.
- **`backend/lib/audit.js`** ([backend/lib/audit.js:99](../backend/lib/audit.js#L99)) — `writeAudit(entity, action, entityId, userId, tenantId, details)`. Existing. New entity values `'PaymentGatewayConfig'` + `'PaymentRoutingRule'` written transparently; hash chain inherits.
- **`backend/routes/payments.js`** ([backend/routes/payments.js:1](../backend/routes/payments.js)) — Refactor: webhook handlers (`/webhook/stripe` :110 + `/webhook/razorpay` :163) lookup per-tenant config by `webhookToken` query-param + verify HMAC against the row's encrypted webhookSecret. Lazy SDK loaders (`getStripe()` :16 + `getRazorpay()` :28) refactor to per-tenant lookups.
- **`backend/routes/integrations.js`** ([backend/routes/integrations.js:20](../backend/routes/integrations.js#L20)) — `AVAILABLE_INTEGRATIONS` array's `stripe` + `razorpay` entries get a deprecation notice (Phase 1.5) — they remain as discoverability hints in the integrations UI but the actual config UI shifts to `/settings/payment-gateways`. After 90-day grace, remove from `AVAILABLE_INTEGRATIONS`.
- **New file `backend/lib/paymentGatewayRegistry.js`** — SUPPORTED_PROVIDERS map; adapter interface contract.
- **New file `backend/lib/stripeGateway.js`** — Stripe adapter implementing the gateway-adapter interface.
- **New file `backend/lib/razorpayGateway.js`** — Razorpay adapter.
- **New cron `backend/cron/gatewayCredentialCleanupEngine.js`** — Daily 03:30 UTC; clears `previousWebhookSecret` fields past the grace window.
- **New route file `backend/routes/payment_gateways.js`** — CRUD + test endpoint.
- **New route file `backend/routes/payment_routing_rules.js`** — CRUD for routing rules.
- **New frontend page `frontend/src/pages/PaymentGatewaysSettings.jsx`** — Admin UI surface.
- **New frontend page `frontend/src/pages/PaymentRoutingRulesSettings.jsx`** — Routing rules admin UI.
- **GH #896 cred dep** — Real Stripe + Razorpay credentials onboarded for at least one tenant before "Done" can be declared.

---

## §9 Open questions

- **OQ-9.1 BYOK vs Connect/Route — confirm v1 scope is BYOK?** Per DD-5.1 + DD-5.2 recommendations. The decision affects every downstream architectural choice. **GATES IMPLEMENTATION START.**
- **OQ-9.2 Schema choice — confirm new `PaymentGatewayConfig` model vs extending `Integration`?** Per DD-5.4 recommendation. **GATES IMPLEMENTATION START.**
- **OQ-9.3 Routing rules — confirm new `PaymentRoutingRule` table?** Per DD-5.6 recommendation. **GATES IMPLEMENTATION START.**
- **OQ-9.4 Multi-currency routing rules — operator-defined per-currency OR auto by `Tenant.country` + currency code?** Two options: (a) Operator manually configures all rules; (b) On first gateway-config save, system auto-creates a "country-default" rule based on Tenant.country + gateway primary currency. **Recommendation: (b) AUTO-CREATE on first save; OPERATOR-EDITABLE thereafter.** Reduces zero-config friction for new tenants. Decided during product call.
- **OQ-9.5 Block save-until-test option?** Should the PUT endpoint reject if Test Connection hasn't succeeded in the last N minutes? Pro: catches "operator pasted typo'd key + saved + a customer attempted payment a week later + failure". Con: adds friction for legitimate "I'll test it later" flows. **Recommendation: tenant-configurable opt-in flag `Tenant.requireTestBeforeSaveGateway: Boolean @default(false)`.** Off by default; on by operator choice. Decided during product call.
- **OQ-9.6 Audit-log retention for key rotation events — indefinite (DD-5.8) or finite (e.g. 7 years for GDPR DSAR window)?** Per DD-5.8 recommendation: INDEFINITE for v1. Decided during product call.
- **OQ-9.7 Wellness-style writer/reader gate?** Should the operator who CAN see "configured: true" be different from the operator who CAN edit? Per DD-5.7 recommendation: ADMIN-write + MANAGER+ADMIN-read.
- **OQ-9.8 Per-location gateway override — v1 or Phase 1.5?** Issue #848 mentions per-location explicitly. **Recommendation: defer to Phase 1.5 follow-up after v1 ships + a real tenant requests it.** Decided during product call.
- **OQ-9.9 Webhook URL format — query-param `?tenant=<token>` vs path-segment `/api/payments/webhook/stripe/<token>`?** Both work. Path-segment is cleaner; query-param is easier for some webhook providers' constrained URL formats. **Recommendation: query-param** (matches Razorpay's documented URL format hints + works around Stripe's webhook URL rewriting).
- **OQ-9.10 Test-mode test-card support.** Should the admin UI expose Stripe's test-card numbers + Razorpay's test card numbers as a help block ("Use 4242 4242 4242 4242 to simulate a successful payment")? **Recommendation: YES** — embedded in the provider's docs panel in the admin UI. Sourced from `paymentGatewayRegistry.js` per-provider help map.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 / DD-5.2 / DD-5.4 / DD-5.6 + OQ-9.1 / OQ-9.2 / OQ-9.3 + cred chase #896 before any code lands.

**Owner:** TBD per product call. Likely allocation:
- Schema migration (additive: new `PaymentGatewayConfig` + `PaymentRoutingRule` + `Tenant.gatewayWebhookGraceHours`) — backend engineer ~0.5 day
- New route files (`payment_gateways.js` + `payment_routing_rules.js`) CRUD — backend engineer ~1 day
- New gateway registry + adapter interface + Stripe adapter + Razorpay adapter — backend engineer ~1 day
- Webhook handler refactor (per-tenant lookup + HMAC) — backend engineer ~0.5 day
- Test-connection endpoint + rate limit + audit hooks — backend engineer ~0.5 day
- Webhook-secret grace window + cleanup cron — backend engineer ~0.25 day
- Frontend admin UI: PaymentGatewaysSettings (per-provider card form) + PaymentRoutingRulesSettings — frontend engineer ~1.5 days
- Backward-compat fallback to env-var creds (with deprecation warning) — backend engineer ~0.25 day
- Tests (api-spec + vitest for masking + routing-resolver + webhook-handler-multi-tenant + adapter unit tests) — backend engineer ~1 day
- Operator docs page + Stripe/Razorpay webhook-URL copy block — content + frontend ~0.5 day

**Total estimated effort post-design: 4-6 engineering days** across backend + frontend. (Plus PRD_PLANS_BILLING_SELF_SERVE consumer-side adoption — separate PRD's scope.)

**Sibling PRDs in this cluster:**
- `PRD_PLANS_BILLING_SELF_SERVE.md` (subscription-side consumer of this PRD's gateway resolution; DD-5.3 there cites THIS PRD as the authoritative gateway-config source)
- `PRD_TRAVEL_BILLING.md` (per-invoice Pay Now button consumes this PRD's resolver)
- `PRD_PURCHASE_ORDERS.md` (Phase 2 supplier payouts via gateway-config)
- `PRD_EXCEL_SOFTWARE_ACCOUNTING.md` (ERP-side payment reconciliation references gateway-config metadata)

**Blocks before backend impl can start:**
- DD-5.1 (BYOK vs Stripe Connect for Stripe) — MUST resolve
- DD-5.2 (BYOK vs Razorpay Route for Razorpay) — MUST resolve
- DD-5.4 (new model vs extend Integration) — MUST resolve
- DD-5.6 (routing-rule placement — table vs blob) — MUST resolve
- OQ-9.1 (confirm BYOK scope) — MUST resolve
- OQ-9.4 (auto-create routing rules on first save?) — MUST resolve
- OQ-9.5 (block-save-until-test default?) — MUST resolve
- #896 cred chase (real Stripe + Razorpay accounts onboarded for at least 1 tenant) — MUST close before "Done" declaration

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**
- **Slice 1** (~2 days): Schema + routes + Stripe adapter + admin UI for Stripe-only (BYOK; mode=TEST initially). Ships the core flow against Stripe's test sandbox. Pilots with the Globussoft generic tenant.
- **Slice 2** (~1.5 days): Razorpay adapter + Razorpay admin UI extensions. Pilots with the Enhanced Wellness tenant (Rishu's INR-flavored production tenant).
- **Slice 3** (~1.5 days): Routing rules table + per-currency resolution + webhook handler refactor for per-tenant lookup. Closes the multi-currency / multi-tenant story.
- **Slice 4** (~1 day): Grace-window logic + cleanup cron + UI polish + operator docs page.

Slices are sequential because each builds on the prior; no parallel-agent dispatch.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness-procurement-operational cluster, since the most-pressing tenant for this is Rishu's Enhanced Wellness INR Razorpay integration via #896 + plans/billing self-serve). Proposal: add a new entry **D9. Payment Gateway Configuration UI (#848)** under cluster D — sibling to D8 (Purchase Orders) which is the same procurement-operational shape. Cross-reference from cluster B (travel) is recommended because TravelStall + RFU will be the second wave of users once Phase 1 lands.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_PLANS_BILLING_SELF_SERVE.md` DD-5.3 references THIS PRD's resolver as the gateway-routing source.
- `PRD_TRAVEL_BILLING.md` line-item gateway metadata references the new `PaymentGatewayConfig.id` (replaces the current "string gateway field").
- `PRD_PURCHASE_ORDERS.md` §7 Phase 2 supplier payouts hook into the resolver via a new "payout direction" flag on PaymentGatewayConfig.
- GH #775 (Invoice schema polymorphic refactor) is sequenced AFTER this PRD ships (Invoice references PaymentGatewayConfig.id in metadata, not in a typed FK — keeps Invoice schema-stable).
