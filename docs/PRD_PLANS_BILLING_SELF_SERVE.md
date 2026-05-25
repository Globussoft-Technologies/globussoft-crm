# PRD — Plans & Billing Self-Serve

**Status:** PRD draft (no implementation work in this commit)
**Author:** Autonomous overnight cron tick #32 (2026-05-23)
**Coordinates GH issues:** #849 (P-High Gap: PB-001)
**Sibling PRDs / cred overlap:** #848 (PG-001 — Payment Gateway config UI), #896 (Stripe / Razorpay cred chase), PRD_TRAVEL_GST_COMPLIANCE (tax math)

---

## §1 Background + source attribution

Today the `/settings` page renders `Plan: professional` as **static text** — there is no upgrade flow, no plan comparison, no billing history, no invoice download, no payment-method management, no cancellation surface, no usage / overage visibility, no proration logic. Tenants who want to change plans must email Globussoft ops; every upgrade/downgrade/cancel/refund is a manual workflow. Expansion revenue is blocked by friction (no self-serve upgrade), and the per-tenant ops effort on simple plan changes scales linearly with tenant count.

The infrastructure to support a self-serve billing surface is **already partially present** — Tenant has a `plan` column, User has `subscriptionStatus` + `trialEndsAt`, Prisma has `SubscriptionPlan` + `Subscription` models, `backend/routes/subscriptions.js` exposes status/plans/order/verify/cancel endpoints, `backend/routes/billing.js` is 1033 lines of invoice CRUD + PDF generation + recurring + refund + credit-note flow. The missing layer is the **tenant-facing self-serve UI + plan-tier feature matrix + payment-method storage + usage-metering surface** — not the underlying billing primitive.

**Sources:**
- GH #849 (OPEN as of 2026-05-23) — Globussoft audit cluster
- Cross-references #848 (Payment Gateway config UI) + #896 (Stripe / Razorpay cred chase)
- Existing partial implementation surveyed below in §1.2

### §1.2 Existing infrastructure (do NOT rebuild)

| Capability | Location | Status |
|---|---|---|
| `Tenant.plan` column | `backend/prisma/schema.prisma:62` (String @default("starter")) | Exists; values `starter` \| `professional` \| `enterprise` |
| `User.subscriptionStatus` + `trialStartDate` + `trialEndsAt` | `backend/prisma/schema.prisma:367-369` | Exists; TRIAL \| ACTIVE \| EXPIRED \| CANCELLED |
| `SubscriptionPlan` model | `backend/prisma/schema.prisma:4058` | Exists; name + price + currency + billingIntervalDays + features (JSON) + isActive |
| `Subscription` model | `backend/prisma/schema.prisma:4074` | Exists; userId + planId + planName + status + amount + razorpayOrderId/PaymentId + renewalDate |
| Subscription routes | `backend/routes/subscriptions.js` (274 lines) | Exists — `/status`, `/plans`, `/create-order`, `/verify-payment`, `/:id/cancel` |
| Billing / invoice routes | `backend/routes/billing.js` (1033 lines) | Exists — CRUD + PDF + recurring + refund + credit-note + void + mark-paid |
| Pricing landing page | `frontend/src/pages/Pricing.jsx` (462 lines) | Exists — public marketing page (logged-out funnel) |
| Razorpay verify-payment crypto check | `backend/routes/subscriptions.js:134` | Exists; HMAC SHA256 signature verification |
| Stripe + Razorpay providers | per CLAUDE.md tech stack | Exists; cred-blocked end-to-end test surface per #896 |
| Tenant-facing **`/settings/plan`** self-serve page | n/a | **DOES NOT EXIST** — net new |
| Tenant-facing **`/settings/billing/history`** | n/a | **DOES NOT EXIST** — net new |
| Tenant-facing **`/settings/billing/payment-methods`** | n/a | **DOES NOT EXIST** — net new |
| `PaymentMethod` model (stored gateway-tokens, never PAN) | n/a | **DOES NOT EXIST** — net new |
| Per-plan feature matrix (gating logic) | n/a | **DOES NOT EXIST** — net new |
| Usage-metering counters per feature | n/a | **DOES NOT EXIST** — net new |
| Plan-change pro-ration + grace-period logic | n/a | **DOES NOT EXIST** — net new |
| Subscription renewal cron + failed-charge retry | n/a | **DOES NOT EXIST** — net new |
| GST-compliant invoice (India tenants) | partial via `routes/billing.js` PDF | Cross-ref PRD_TRAVEL_GST_COMPLIANCE; HSN/SAC codes + place-of-supply rules pending |

The genuine scope is the eleven "DOES NOT EXIST" rows. The schema + Razorpay verification + invoice PDF rendering are reusable as-is.

---

## §2 Use cases

1. **U-2.1 View current plan + usage.** Tenant Owner opens `/settings/plan`; sees current tier (Starter / Pro / Enterprise), monthly vs annual cycle, next renewal date, next charge amount, feature matrix with own usage vs limit per feature (e.g. records: 4,200 / 10,000; users: 8 / 25).
2. **U-2.2 Upgrade plan.** Tenant Owner clicks **Upgrade**; sees plan-comparison grid with feature matrix; selects target tier; sees pro-rated charge breakdown for the current cycle remainder; confirms; charge goes through saved payment method; plan effective within 60s; audit log entry recorded.
3. **U-2.3 Downgrade plan.** Tenant Owner clicks **Downgrade**; sees per-feature impact (e.g. "Your 8 users will be reduced to 5 — choose which 3 to remove"); chooses target tier; downgrade takes effect at next cycle start (no immediate refund); confirmation email sent.
4. **U-2.4 Cancel subscription.** Tenant Owner clicks **Cancel**; sees retention prompt with reason picker; chooses cancel-at-period-end (default) OR immediate (refund per policy); confirms; tenant stays in `ACTIVE` until period end, then transitions to `CANCELLED` (read-only access).
5. **U-2.5 Add / remove payment method.** Tenant Owner opens `/settings/billing/payment-methods`; clicks Add Card → Stripe Elements (or Razorpay Checkout) opens; method tokenized + stored gateway-side; row appears with last 4 digits + brand; can set-default or remove.
6. **U-2.6 Download past invoices.** Tenant Admin opens `/settings/billing/history`; sees paginated list of last N invoices (amount, date, status, payment method); filters by date range via shared `<DateRangePicker>`; clicks per-invoice **Download** → PDF receipt.
7. **U-2.7 Recover from failed payment.** Auto-charge fails on cycle renewal; tenant emailed; banner on `/settings/plan` shows "Payment failed — update payment method or pay manually"; one-click pay or method-update path; after 3 retries (per policy) tenant moves to `PAST_DUE`; after grace window, `SUSPENDED`.

---

## §3 Functional requirements

### FR-3.1 Plan + tier model

- **(a)** Plan tiers seed: `Free` (trial-only, 14-day), `Starter`, `Pro`, `Enterprise`. Use the existing `SubscriptionPlan` table; do not introduce a parallel model.
- **(b)** Per-tier monthly + annual pricing rows (two SubscriptionPlan rows per tier; `billingIntervalDays = 30` and `365`). Annual rows carry a discount (e.g. 2 months free).
- **(c)** Per-tier `features` JSON shape: `{ users: <int>, records: <int>, apiCallsPerMonth: <int>, storageGB: <int>, customObjects: <int>, integrations: [<name>], aiCallsPerMonth: <int> }` — additive on upgrade, downgrade-cap enforced at next cycle.
- **(d)** Per-tier flag set (booleans): `wellnessVertical`, `travelVertical`, `customReports`, `whiteLabel`, `ssoSaml`, `auditExports`, `phoneSupport`. Per-feature gating piggybacks on the existing `FieldPermission` infrastructure pattern; add a `lib/planGate.js` helper.
- **(e)** Extend `Tenant.plan` → `Tenant.subscriptionTier` (rename, keep old column as alias via migration) + add `Tenant.subscriptionInterval` (`monthly` | `annual`) + `Tenant.subscriptionStatus` (mirror of User.subscriptionStatus but tenant-scoped: `TRIAL` | `ACTIVE` | `PAST_DUE` | `CANCELLED` | `SUSPENDED`).

### FR-3.2 Self-serve plan actions

- **(a)** **GET** `/api/billing/plan/current` → returns `{ tier, interval, status, renewsAt, trialEndsAt, usage: { records, users, ... }, limits: { ... }, nextChargeAmount, currency }`.
- **(b)** **GET** `/api/billing/plan/options` → returns full tier matrix + monthly/annual pricing + per-tier feature list (consume from `SubscriptionPlan` table, NOT a static const).
- **(c)** **POST** `/api/billing/plan/upgrade` `{ targetPlanId, interval }` → pro-rates current cycle remainder, issues `Invoice` (existing `routes/billing.js` model) with line items for `<oldPlan> credit` + `<newPlan> charge`, attempts charge via saved payment method, returns `{ subscriptionId, invoiceId, status }`. Effective immediately on success.
- **(d)** **POST** `/api/billing/plan/downgrade` `{ targetPlanId }` → records intent; subscription downgrades at next renewal cycle (no immediate refund). Tenant retains current-tier features until period end. Cancellable from `/settings/plan` until midnight before cycle end.
- **(e)** **POST** `/api/billing/plan/cancel` `{ mode: "period_end" | "immediate", reason }` → mode controls when tenant transitions to `CANCELLED`. Immediate mode triggers refund-per-policy (deferred to DD-5.2).
- **(f)** Role gate: all four endpoints require `verifyRole(["ADMIN"])` (the Tenant Owner / Admin only). Audit-log entry on every state change.

### FR-3.3 Billing history

- **(a)** **GET** `/api/billing/history` `?from&to&page&limit` → tenant-scoped invoices from existing `Invoice` table; existing `routes/billing.js:222` lists invoices but the response shape is generic — extend with subscription-specific filtering (filter by `Invoice.relatedSubscriptionId`).
- **(b)** Schema: add `Invoice.relatedSubscriptionId Int?` + `Invoice.invoiceType String @default("standard")` (values `standard` | `subscription` | `proration` | `refund` | `credit_note`).
- **(c)** **GET** `/api/billing/history/:id/pdf` → reuse existing `routes/billing.js:665` PDF render; verify branded with tenant logo + GST fields for India tenants.
- **(d)** Frontend `/settings/billing/history` page consumes the list + uses shared `<DateRangePicker>` for filter; mobile-responsive table per CLAUDE.md ellipsis + `min-width: 0` standing rule.

### FR-3.4 Payment method management

- **(a)** New model `PaymentMethod` — fields: `id`, `tenantId`, `userId`, `provider` (`stripe` | `razorpay`), `providerCustomerId`, `providerMethodId`, `brand`, `last4`, `expMonth`, `expYear`, `isDefault`, `createdAt`. **No PAN, no CVV, no full card** — all card data stays gateway-side via tokenization.
- **(b)** **POST** `/api/billing/payment-methods` `{ provider, tokenizedMethodId }` → registers a Stripe-Elements-tokenized OR Razorpay-Checkout-tokenized method; on first method registered, auto-sets `isDefault`.
- **(c)** **GET** `/api/billing/payment-methods` → list for the current tenant; tenant Owners + Admins only.
- **(d)** **DELETE** `/api/billing/payment-methods/:id` → de-registers from gateway + soft-deletes our row. Blocked if it's the only method on an `ACTIVE` subscription (force them to add a replacement first).
- **(e)** **PATCH** `/api/billing/payment-methods/:id/set-default` → flips `isDefault`; auto-charge uses the default method.
- **(f)** Failed-charge retry policy: 3 attempts at 0h / 24h / 72h after initial fail → status `PAST_DUE` → tenant emailed + banner on `/settings/plan` → after 7-day grace, `SUSPENDED`.

### FR-3.5 Invoicing + receipts

- **(a)** On every subscription cycle (cron-driven, daily 02:00 IST per `recurringInvoiceEngine` pattern), generate an Invoice row + charge default payment method + email receipt PDF.
- **(b)** Invoice PDF reuses `routes/billing.js:665` renderer; add subscription line items + plan-tier name + GST/HSN code for India tenants (cross-ref PRD_TRAVEL_GST_COMPLIANCE).
- **(c)** Receipt PDF auto-emailed to tenant Owner + `additionalBillingEmails[]` (extend `Tenant` model with this column) — re-downloadable from `/settings/billing/history`.
- **(d)** GST-compliant for India tenants: place-of-supply rule (intra-state CGST+SGST, inter-state IGST) per PRD_TRAVEL_GST_COMPLIANCE; HSN/SAC code 998314 for IT consulting / SaaS.

### FR-3.6 Usage metering

- **(a)** Per-feature usage counters: `records` (sum of `Contact` + `Lead` + `Deal` + `Patient` rows per tenant), `users` (count of `User` rows per tenant), `apiCallsPerMonth` (sliding-window count on `/api/*` excluding `/health` + auth), `storageGB` (sum of `Attachment.bytes` per tenant), `aiCallsPerMonth` (count from existing `LlmCallLog` model).
- **(b)** `/api/billing/plan/current` returns current usage + limit for each metered feature.
- **(c)** Alert at 80% usage on any metered feature: in-app notification + email to tenant Owner.
- **(d)** Hard cap at 100% on `users` + `records` (cannot create new) → friendly upgrade-prompt modal with one-click `/settings/plan` upgrade. `apiCallsPerMonth` + `aiCallsPerMonth` soft-cap at 100% with overage-charge per DD-5.4.

---

## §4 Non-functional requirements

- **Plan changes effective within 60s** end-to-end (UI click → backend ack → feature gates flip → next request sees new tier).
- **Invoice PDF render < 3s** for an invoice with ≤ 20 line items.
- **Payment method add: PCI-DSS-compliant** via Stripe Elements / Razorpay Checkout — **never** store PAN / CVV / track data on our servers. Audit by gitleaks + a one-time secrets-scan over our DB columns.
- **Usage metering: realtime** (no batch lag) for hard-cap features (`users`, `records`) — cache invalidates on write. Soft-cap features (`apiCallsPerMonth`, `aiCallsPerMonth`) tolerate up to 5-min lag.
- **Subscription renewal cron** runs daily at 02:00 IST; charges all subscriptions whose `renewalDate ≤ today`; idempotent by `subscriptionId + cycle` (no double-charge).
- **Failed-charge retry logic** retries at 0h / 24h / 72h; emits webhook + email + in-app notification on each transition.
- **Audit log** writes a row for every plan change, payment method add/remove, cancellation, status transition (`writeAudit` per existing pattern).
- **Multi-tenant isolation** — every endpoint scopes by `req.user.tenantId` (no body-side `tenantId` per stripDangerous middleware).
- **i18n** — all amounts formatted via existing `formatMoney()` helper with tenant.defaultCurrency + locale.

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (block product before backend impl)

- **DD-5.1 Plan tiers + per-tier feature matrix.** WHO defines `Free` / `Starter` / `Pro` / `Enterprise` boundaries? Per-tier user count + record count + API quota + which integrations are gated? Without this the `SubscriptionPlan` seed is guesswork. Owner: Globussoft product (likely Suresh + Sumit).
- **DD-5.2 Cancellation policy.** Grace-period length on `cancel-immediate`? Refund rules (pro-rated remaining? no refund? store credit?)? Different policy for monthly vs annual? Owner: Globussoft commercial / legal.
- **DD-5.3 Payment-method storage.** Stripe Customer model? Razorpay Customer model? Both (per-tenant-currency routing — INR tenants → Razorpay, others → Stripe)? Owner: Globussoft + #848 PG-001 PRD author.
- **DD-5.4 Usage metering granularity.** Which features are metered + capped vs metered + overage-charged? Per-record? Per-action? Sliding 30-day window vs calendar-month? Owner: Globussoft product.
- **DD-5.5 Multi-tenant subscription scoping.** Per-Tenant plan, or per-Organization (parent of Tenants)? Today every Tenant has its own `plan` column; if Globussoft adopts a parent-org concept, this PRD's `Tenant.subscriptionTier` migration plan needs to ascend. Owner: Globussoft architecture (Suresh).
- **DD-5.6 Failed-payment retry policy.** Number of attempts before `PAST_DUE`? Grace window before `SUSPENDED`? Read-only access during `PAST_DUE`? Owner: Globussoft commercial + ops.

### Cred chase

- **Q-PB-1** Stripe Customer + Subscription API access (overlaps #896 cred chase). Needed: secret key + restricted-scope key for Subscription / Customer / PaymentMethod APIs.
- **Q-PB-2** Razorpay subscription module access — `rzp_live_*` key with Subscriptions module enabled on the Razorpay dashboard. Today our test key may only have orders + payments; subscriptions is a separate module.
- **Q-PB-3** GST registration number for the Globussoft entity issuing invoices (India-side); company PAN; HSN/SAC code confirmation; place-of-supply rules per PRD_TRAVEL_GST_COMPLIANCE.

### Vendor documentation references

- Stripe Billing: <https://stripe.com/docs/billing>
- Stripe Elements (PCI-safe tokenization): <https://stripe.com/docs/payments/elements>
- Razorpay Subscriptions: <https://razorpay.com/docs/payments/subscriptions/>
- Razorpay Checkout (tokenization): <https://razorpay.com/docs/payments/payment-gateway/web-integration/>

---

## §6 Acceptance criteria

- **AC-6.1** Tenant Owner sees current plan + renewal date + next charge + usage-vs-limit per metered feature on `/settings/plan` within 60s of login.
- **AC-6.2** Upgrade flow: select target tier → see pro-rated charge breakdown → confirm → plan updated within 60s → pro-rated invoice issued + emailed.
- **AC-6.3** Add payment method via Stripe Elements (Stripe tenants) or Razorpay Checkout (Razorpay tenants) → method saved gateway-side + tokenized row appears in `/settings/billing/payment-methods` → auto-charged on next cycle renewal.
- **AC-6.4** Download last 12 months of invoices as PDFs from `/settings/billing/history`; filtered by `<DateRangePicker>` from / to.
- **AC-6.5** Cancel flow: choose `cancel-at-period-end` → confirmation → tenant remains `ACTIVE` until `renewalDate` → transitions to `CANCELLED` on cycle end → read-only access enforced via `planGate.js`.
- **AC-6.6** Usage at 80% of any metered feature triggers in-app notification + email to tenant Owner within 5 minutes.
- **AC-6.7** Failed-payment retry: 3 attempts at 0h / 24h / 72h → tenant emailed on each → after 3rd fail, `PAST_DUE` banner on `/settings/plan` → manually-payable button → after 7-day grace, `SUSPENDED`.
- **AC-6.8** No PAN / CVV / track data anywhere in our database — verified by post-impl gitleaks scan + column-level audit.
- **AC-6.9** Audit log entry created for every plan upgrade / downgrade / cancel / payment-method add / payment-method remove / status transition.

---

## §7 Out of scope

- Multi-currency tenant billing (e.g. one Tenant paying USD-now-then-INR-later). Complicates accounting; defer to Phase 2.
- Tax handling — cross-ref PRD_TRAVEL_GST_COMPLIANCE (GST math + place-of-supply rules); this PRD assumes that PRD ships first or in parallel.
- Custom-pricing negotiation (Enterprise tier sales-mediated handshake — handled by ops + sales, not self-serve).
- Referral / affiliate flows (Phase 2 — separate PRD when commercial team prioritizes).
- White-label-reseller-tier billing (resellers billing their own end-customers using our infra — separate PRD; Tenant.plan is for direct Globussoft customers only).
- Mid-cycle currency change on an existing subscription — covered by OQ-9.1; defer.

---

## §8 Dependencies

- **Existing schema:** `Tenant.plan`, `SubscriptionPlan`, `Subscription`, `Invoice`, `Payment`, `User.subscriptionStatus` (all present per §1.2).
- **Existing routes:** `backend/routes/subscriptions.js` (extend with `/plan/current`, `/plan/options`, `/plan/upgrade`, `/plan/downgrade`, `/plan/cancel`); `backend/routes/billing.js` (extend list endpoint with `relatedSubscriptionId` filter + invoice-type field).
- **New routes:** `backend/routes/payment_methods.js` (POST / GET / DELETE / PATCH per FR-3.4).
- **New lib:** `backend/lib/planGate.js` (per-feature gating + usage-cap enforcement) — mirrors `FieldPermission` middleware pattern.
- **New cron:** `backend/cron/subscriptionRenewalEngine.js` (daily 02:00 IST) — mirrors `recurringInvoiceEngine.js` pattern.
- **Stripe + Razorpay providers** — cred-blocked per Q-PB-1 + Q-PB-2.
- **Shared frontend `<DateRangePicker>`** — exists; reuse for invoice history filter.
- **PRD_TRAVEL_GST_COMPLIANCE** — tax math + HSN/SAC codes + place-of-supply rules.
- **PR #710 NotificationPreference reshape** — usage-alert emails consume notification-preference channels (already in `{enabled}` object shape post-#710).
- **Existing `writeAudit` + `auditLog.js` + audit hash-chain** — every state change goes through it.

---

## §9 Open questions

- **OQ-9.1** Can tenants change plan currency mid-subscription (e.g. INR tenant switches to USD billing on a relocation)? If yes, how does pro-ration math reconcile across two currencies?
- **OQ-9.2** Pause vs cancel — different UX flows (`PAUSED` is a third subscriptionStatus, retains data, no billing)? Or is "cancel + re-subscribe" enough?
- **OQ-9.3** Enterprise tier: self-serve allowed (one-click upgrade to Enterprise)? OR sales-mediated only (CTA shows "Contact sales" instead of "Upgrade")?
- **OQ-9.4** Per-feature à-la-carte add-ons (e.g. "add 5 more users to Pro for $X/month") OR fixed plans only?
- **OQ-9.5** Trial extension self-serve (tenant clicks "Extend trial 7 days") OR ops-mediated only?
- **OQ-9.6** Dunning emails — fully automated OR ops-reviewed before send (avoid mass-email-to-customer regrettable events)?
- **OQ-9.7** Wellness + Travel verticals — are plan tiers vertical-specific (separate `Tenant.vertical=wellness` SKUs) OR same tier list applies across all verticals with feature-flag overrides?

---

## §10 Status snapshot

- **Current state:** static `Plan: professional` text in Settings; `routes/subscriptions.js` (274 lines) + `routes/billing.js` (1033 lines) + `Pricing.jsx` (462 lines) exist; `Tenant.plan` + `Subscription` + `SubscriptionPlan` schema present.
- **This PRD:** WRITTEN 2026-05-23 (tick #32). No implementation work in this commit.
- **Implementation path:** 12-22 engineering days (assumes DD-5.1 + DD-5.3 design calls land first + Q-PB-1 / Q-PB-2 cred chase clears).
- **Phasing:**
  - **Phase A (~3-5 days):** Plan tier seed + `planGate.js` + `/settings/plan` read-only view + usage-metering counters. UNBLOCKED by current state (no DD-5.x needed for read-only).
  - **Phase B (~4-7 days):** Upgrade / downgrade / cancel flows + audit-log integration + pro-ration math. **BLOCKED on DD-5.1 + DD-5.2.**
  - **Phase C (~3-5 days):** Payment-method management UI + tokenized storage + Stripe Elements / Razorpay Checkout integration. **BLOCKED on DD-5.3 + Q-PB-1 + Q-PB-2.**
  - **Phase D (~2-5 days):** Subscription renewal cron + failed-payment retry + dunning emails + invoicing pipeline. **BLOCKED on DD-5.6.**
- **Sibling PRDs:** PRD_TRAVEL_GST_COMPLIANCE (tax math — Phase D dependency); #848 PG-001 Payment Gateway config UI (operator-side config; this PRD is its tenant-self-serve mirror); #896 cred-chase (Stripe + Razorpay subscriptions module).
- **Blocks downstream:** Globussoft expansion-revenue self-serve, ops-overhead reduction, GST-compliant invoicing surface for India tenants.
- **Anti-busywork note:** do NOT pre-build Phase B / C / D before DD-5.1 / DD-5.2 / DD-5.3 + Q-PB cred chase lands. Phase A (read-only view + planGate stub) is the only safely-pre-buildable slice; everything past it is design-call-blocked.

---

**End of PRD.** Refs #849.
