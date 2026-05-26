# PRD — POS New Sale screen: Booking / Walk-in tabs (on top of existing POS MVP)

**Status:** NOT STARTED — PRD draft only; design call required (DD-5.1 tab-route-surface + DD-5.2 items-picker-ergonomics + DD-5.4 void/refund-window-actor determine the URL + UX + RBAC shape materially).
**Source:** GH #771 — [Zylu-Gap][POS-002] New Sale screen missing Booking / Walk-in tabs.
**Tier:** P3 — Operator productivity / front-desk throughput (today's CRM ships the POS MVP at [frontend/src/pages/wellness/PointOfSale.jsx](../frontend/src/pages/wellness/PointOfSale.jsx) + [backend/routes/pos.js](../backend/routes/pos.js) with line-item builder + register/shift gates + 9 payment methods + petty-cash + refund + manager-override discount — but **the operator workflow that begins a sale FROM a Booking (customer pre-booked) vs FROM a Walk-in (no booking) is the Zylu-grade tab-pivot UX that today's single-page flat builder lacks**). Material when a clinic serves a mix of pre-booked appointments + walk-ins on the same day (the wellness vertical's default mode); material when an operator must switch context between the two flows multiple times an hour without losing in-flight item lines; material when the reporting layer needs to attribute revenue back to a Booking row vs surface walk-in foot-traffic separately.
**Authored:** 2026-05-25 (tick #196 / Agent B, autonomous overnight cron arc — Bonus PRD #10 in this batch wave on top of the official 10 P3 + 9 prior bonus).
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190, D11) · `PRD_TAG_MASTER.md` (tick #191, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192, D13) · `PRD_CUSTOMER_SEGMENTS.md` (tick #193, D14) · `PRD_STAFF_DETAIL.md` (tick #194, D15) · `PRD_WALLET_TOPUP.md` (tick #195, D16).
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D17**; see §10.
**Cred dependency:** none external for v1 — re-uses existing POS infra (`backend/routes/pos.js`), existing `Sale` + `SaleLineItem` + `Booking` + `Invoice` Prisma models, existing `pdfRenderer.js` receipt path, and existing inventory consumption hooks. Pure operator-UX refactor + one new Bookings query endpoint + payment-splitter widget + atomic-finalize hardening + receipt-emission wiring.

---

## §1 Background + source attribution

The CRM today has the POS MVP fully shipped:

- **`Sale` model** at [backend/prisma/schema.prisma:3895-3935](../backend/prisma/schema.prisma#L3895-L3935) — register/shift-bound; `paymentMethod` is a single string column with 9 vocab values (`CASH | CARD | UPI | WALLET | GIFTCARD | COMBINED | CASHBACK | PAYLATER | ONLINE` — extended at #789 on 2026-05-18); `paymentBreakdownJson @db.Text` already exists as the COMBINED-method splitter payload column. `invoiceNumber` is per-tenant unique.
- **`SaleLineItem` model** at [backend/prisma/schema.prisma:3937-3958](../backend/prisma/schema.prisma#L3937-L3958) — polymorphic `lineType` ∈ `{SERVICE, PRODUCT, MEMBERSHIP, GIFTCARD, PACKAGE}` + `refId` indirect FK + denormalised `name` (frozen at sale time).
- **`Register` + `Shift` + `PettyCashLedger` models** at [backend/prisma/schema.prisma:3817-3893](../backend/prisma/schema.prisma#L3817-L3893) — per-location register; per-cashier shift with OPEN/CLOSED state; per-shift petty-cash drawer ledger.
- **`Booking` model** at [backend/prisma/schema.prisma:2238-2263](../backend/prisma/schema.prisma#L2238-L2263) — per-tenant; per-BookingPage; `contactName` / `contactEmail` / `contactPhone` + `scheduledAt` + `durationMins` + `status ∈ {CONFIRMED, CANCELED, COMPLETED}` + optional `contactId` (FK to Contact) + (travel-vertical Day-2) optional `tripId` / `itineraryId`. The wellness vertical writes its Bookings through `BookingPage` flows.
- **18 routes under `/api/pos/*`** at [backend/routes/pos.js](../backend/routes/pos.js) (~1037 LOC) — `GET/POST/PUT/DELETE /registers` + `POST /shifts/open|:id/close|:id/deposit|:id/withdraw` + `GET /shifts(/current|/:id|/:id/petty-cash)` + `POST /sales` (the single-monolith finalize endpoint, ~265 LOC, includes line-validation, inventory check, payment splitter parsing, atomic transaction, audit emission) + `GET /sales` + `GET /sales/:id` + `POST /sales/:id/refund` (admin-gated).
- **`PointOfSale.jsx` page** at [frontend/src/pages/wellness/PointOfSale.jsx:1-769](../frontend/src/pages/wellness/PointOfSale.jsx) — the operator surface. Today's structure:
  - Shift-status banner (open/closed) + Register picker + opening-float input.
  - Single flat "line-item builder" — radio for `lineType ∈ {SERVICE, PRODUCT, MEMBERSHIP, GIFTCARD, PACKAGE}` + numeric refId + name + quantity + unitPrice + lineDiscount; "Add line" appends to a local basket.
  - Running totals (subtotal + tax + discount + grand-total).
  - Guest-Checkout toggle (Wave 7C, #770) — forces `patientId=null` for anonymous walk-ins.
  - Coupon / flat / % discount block (Wave 7C, item 10).
  - Manager-override discount block (admin/manager only, reason logged to AuditLog).
  - Payment-method select (CASH default; UI does NOT split across multiple methods — `paymentBreakdownJson` is wired in the model + accepted by `POST /sales` but the UI is single-method).
  - "Complete Sale" submit.

**What's missing (per GH #771):**

The today flow is a single FLAT builder. The operator at the front desk cannot:
1. **Start a sale FROM a Booking** — there is no "today's bookings" list, no click-to-prefill, no Booking → Sale lineage attribution (`Sale.bookingId` doesn't exist).
2. **Start a sale FROM a Walk-in distinct from a Booking** — both flows collapse to "tap radio buttons + type refIds in a flat list".
3. **Switch tab mid-sale without losing in-flight data** — if the operator starts a walk-in, then a booked customer arrives and the operator needs to switch tabs, today they'd lose the half-built basket.
4. **Auto-prefill the basket from a Booking** — the wellness Booking row carries `contactName` / `contactEmail` / `contactPhone` + (optionally via `bookingPageId`) a service slug, but the operator must manually re-type all of it into the POS surface.
5. **Use a payment splitter UI** — the data column `paymentBreakdownJson` exists but the operator must type a single method.
6. **Use an autocomplete items picker** — the line builder requires the operator to type `lineType=PRODUCT` + `refId=42` + `name="Hyaluronic Acid Serum"` — there's no autocomplete over the existing `Service` + `Product` catalogues.
7. **See an emitted PDF receipt** — `pdfRenderer.js` exists (`renderPrescriptionPDF` / `renderConsentPDF` / `renderInvoicePDF`), but no `renderReceiptPDF` helper exists; today the post-sale screen shows just the invoiceNumber.

Per GH issue #771 verbatim:

> **Title:** [Zylu-Gap][POS-002] New Sale screen missing Booking / Walk-in tabs
>
> **Priority:** Medium
>
> **Current state:** POS MVP exists at `frontend/src/pages/wellness/PointOfSale.jsx` + `backend/routes/pos.js`. Cashier can ring a sale by typing line items into a flat builder. Guest-Checkout toggle exists for anonymous walk-ins. No path begins a sale FROM an existing Booking row; no tab-switch UX between Booking and Walk-in flows.
>
> **Gap (vs Zylu reference):**
> - "New Sale" screen has a prominent tab switch: **Booking** (today's bookings list — click to pre-fill items) vs **Walk-in** (blank canvas + patient picker).
> - Booking tab: chronological list of today's confirmed bookings scoped to the cashier's current shift's register + location, filtered to status=`CONFIRMED`, click-to-load → pre-fills patient + items + the Booking's services / packages.
> - Walk-in tab: opens blank; patient picker (with quick-add inline), items picker via autocomplete on the catalogue (services + products + memberships + giftcards + packages).
> - Tab state is URL-driven for shareability + back-button correctness.
> - Mid-sale tab switch keeps the in-flight basket alive (operator can flip Booking ↔ Walk-in without losing data — confirm modal if switching away with unsaved lines).
> - Payment splitter UI — multiple payment lines (cash + card + upi + wallet + giftcard) summing to the grand total; mirrors the existing `paymentBreakdownJson` column shape.
> - Sale finalize: atomic creation of `Sale` + `SaleLineItem`[] + `Invoice` (per #775) + `WalletTransaction` if any wallet line + inventory decrement for PRODUCT lines + audit-row.
> - PDF receipt via `pdfRenderer.renderReceiptPDF()` (helper to be added).
>
> **Requirements:**
> - Per-tenant scoping; idempotency on the finalize POST.
> - Audit log: `SALE_CREATED`, `SALE_FINALIZED`, `SALE_VOIDED` events (today only the SALE_CREATED audit emits).
> - RBAC: cashier finalizes; manager voids same-day; ADMIN voids any.
> - Existing inventory consumption hook stays as-is (wired through `inventoryService.js` reservations).
>
> **Impact:** Operator workflow is slow + error-prone (operator re-types data already in the Booking row); no Booking → Sale lineage for revenue attribution reporting; mixed cash/card payments are stored in a single `paymentMethod` column with `COMBINED` magic-string + a hand-written breakdown JSON, with no UI surface.
>
> **Notes:** Reuse existing `Sale` + `SaleLineItem` + `Booking` models. Add `Sale.bookingId Int?` FK + index. Inventory consumption already happens on PRODUCT-type lines per `routes/pos.js` slice ~840-920.

### Today's POS flow (the gap)

1. **Customer arrives at the front desk** — operator opens `/pos` (today's `PointOfSale.jsx`).
2. **Operator decides which mode** — but there's NO tab. The operator either (a) opens a sibling page like `/wellness/calendar` to find the booking, mentally notes the service the customer pre-booked, navigates back to `/pos`, and re-types the service in the flat builder; or (b) directly types in the line items for a walk-in. In neither case is the booking row attributable post-hoc.
3. **Line builder** — operator manually types `lineType=PRODUCT`, `refId=42` (memorised), `name="..."` (typed) — error-prone (wrong refId → wrong item rings). The operator can ring an `MEMBERSHIP` with `refId=999` (non-existent) and the route accepts it (no FK validation).
4. **Discounts** — operator types into the discount block. Coupon path calls a preview endpoint.
5. **Payment** — operator picks ONE method. If customer pays ₹1000 cash + ₹500 card, the operator either rings two sales OR picks `COMBINED` + types a JSON-shaped breakdown into a free-text field.
6. **Complete sale** — POST to `/api/pos/sales`; sale created, post-screen shows invoiceNumber only. No PDF receipt emission yet (operator copies the invoiceNumber, writes manual paper receipt).

### Zylu reference pattern (prior art per #771)

Zylu's New Sale screen ships:
- Top of page: tab switch **Booking | Walk-in** (URL-driven `/pos/new/booking` vs `/pos/new/walk-in`).
- **Booking tab:** today's confirmed bookings list (cards or table), scoped to the operator's open shift's register's location. Click a booking → patient + items pre-fill from the Booking row (booking's service[s] → pre-filled as `SERVICE` line items with the Booking's pre-quoted price).
- **Walk-in tab:** blank canvas, large patient picker (typeahead by name / phone / email; "+ Add new" inline mini-form), items picker (typeahead over the existing `Service` / `Product` / `Membership` / `GiftCard` / `Package` catalogues with per-row inline qty / discount controls).
- **Mid-sale tab switch:** state preserved; if items present, switching tabs prompts "Discard current basket? (Yes / Save as Draft / Cancel)".
- **Payment splitter:** "Add payment method" button — operator can add Cash ₹500 + Card ₹300 + UPI ₹200 = ₹1000 total; per-line entry has method-pick + amount; total must equal grand-total (enforced client-side + re-validated server-side).
- **Active register / shift gate:** sale cannot finalize if no register or no open shift; mirrors today's `cashierGate` middleware.
- **Receipt:** PDF receipt emitted as a print-preview after a successful sale; operator can email-to-patient or print to thermal-roll printer; if no PDF emission then a print-friendly HTML receipt opens in a new tab.
- **Auto-create Booking row for walk-ins:** OPTIONAL flag (per Q7) — when the operator finishes a walk-in, optionally a Booking row is auto-created (status=`COMPLETED`, scheduledAt=now, contactPhone supplied) so the attribution reports can include it.

### Source attribution

- GH issue #771 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/771](https://github.com/Globussoft-Technologies/globussoft-crm/issues/771)
- `backend/prisma/schema.prisma:3895-3935` — existing `Sale` model (storage layer, shipped at v3.4.x)
- `backend/prisma/schema.prisma:3937-3958` — existing `SaleLineItem` polymorphic line model
- `backend/prisma/schema.prisma:3817-3866` — existing `Register` + `Shift` models (POS hardware + cashier gate)
- `backend/prisma/schema.prisma:3875-3893` — existing `PettyCashLedger` model (cash-drawer audit per #779)
- `backend/prisma/schema.prisma:2238-2263` — existing `Booking` model
- `backend/routes/pos.js:697-960` — existing `POST /api/pos/sales` finalize endpoint (~265 LOC; the place to bolt Booking-lineage + payment-splitter onto)
- `backend/routes/pos.js:298-365` — existing `POST /api/pos/shifts/open` (the gate that today's New Sale UX implicitly depends on; ditto `:id/close` at :367)
- `frontend/src/pages/wellness/PointOfSale.jsx:1-769` — existing single-flat-builder New Sale page
- `backend/services/pdfRenderer.js` — existing PDF emission infra (extends with `renderReceiptPDF()`)
- `backend/lib/notificationService.js` — re-used for "receipt emailed" notification confirmation if operator opts to email
- `backend/lib/audit.js` `writeAudit()` — new + existing `SALE_*` action set flows through the existing tamper-evident chain
- `PRD_WALLET_TOPUP.md` (D16) — wallet redemption integration point: if a payment line uses `WALLET`, finalize calls into `POST /api/wallet/redeem` per FR-3.3 there
- `PRD_INVOICE_POLYMORPHISM.md` (#775, separate PRD — pending) — finalize creates an `Invoice` row pointing at the `Sale` per the polymorphism PRD

### Why this isn't a "small UI patch" — it's a route refactor + atomicity hardening + integration sweep

The today flow has THREE structural gaps that the tab refactor needs to address atomically:

1. **No Booking → Sale lineage** — `Sale.bookingId` doesn't exist. Adding it is one nullable FK + index, but reporting downstream (the per-location P&L, the per-professional attribution, the Booking-level "this booking converted to ₹2200 revenue" metric) ALL depend on this FK being populated correctly. The lineage is the load-bearing column the rest hangs off.
2. **Payment splitter is half-shipped** — column exists, route ACCEPTS the JSON, UI does NOT emit it. Wiring the UI is the obvious half; the under-tested half is server-side re-validation (sum-of-lines == grand-total) + audit-emission with the breakdown (today the audit row has only the single `paymentMethod` string, not the per-method shape).
3. **Atomicity ambiguity on inventory + wallet + audit** — today's finalize loops through `SaleLineItem`[] inside a Prisma transaction; the inventory decrement happens inside the same transaction for PRODUCT lines, BUT the wallet-debit and the audit row emission happen OUTSIDE the transaction (audit on purpose for hash-chain reasons; wallet inadvertently). If a wallet line fails (insufficient balance) AFTER the sale's been committed, today's flow leaves the Sale row created + the wallet balance untouched + no compensating refund. The tab refactor surfaces this — when payment splitter says "₹500 cash + ₹500 wallet" and wallet has ₹300, the sale should NEVER commit; today there's a window where it could.

This PRD's slice 1 fixes the lineage + tab-route surface; slice 2 fixes the payment-splitter + atomicity hardening; slice 3 fixes the receipt-emission; slice 4 fixes the audit-action vocabulary; slice 5 is the page refactor.

---

## §2 Use cases

1. **Walk-in haircut customer pays cash — cashier rings the sale in <60 seconds.** Operator (USER + cashier sub-role) navigates `/pos/new/walk-in`. Patient picker autocomplete: types "Sarah" → 3 matches → picks "Sarah Khan, 9999988888". Items picker: types "Hair" → "Hair Trim ₹350" appears as the first autocomplete result → presses Enter → line added at qty=1. Operator types ₹350 cash in the single-line payment splitter (default state is "1 method"). Hits "Complete Sale". Backend creates `Sale` + 1 `SaleLineItem` (lineType=SERVICE, refId=27, name="Hair Trim", unitPrice=350, lineTotal=350) + `Invoice` (per #775 polymorphism) + audit `SALE_FINALIZED` — all inside ONE Prisma transaction. PDF receipt opens in new tab via `renderReceiptPDF()`. ~45 seconds total. The walk-in does NOT create a Booking row (per Q7 default: no).

2. **Pre-booked facial customer arrives — cashier loads from Booking tab.** Operator navigates `/pos/new/booking`. Today's bookings list shows 4 cards — "10:30 Sarah Khan — Facial Glow Package ₹2500" (status=CONFIRMED). Operator clicks the card. URL stays at `/pos/new/booking` but a slide-over loads the Sale draft: patientId=Sarah, lineItems=[{lineType=PACKAGE, refId=12 (the Facial Glow), name="Facial Glow Package", unitPrice=2500, lineTotal=2500, bookingId=88}]. Operator confirms — adds the cashier's optional ad-hoc "Lip Balm ₹150" PRODUCT line. Payment splitter shows ₹2650 total; operator splits ₹2000 wallet + ₹650 card. Hits "Complete Sale". Backend: validates wallet has ≥₹2000 (calls `POST /api/wallet/redeem` per PRD_WALLET_TOPUP.md FR-3.3) inside the same transaction; charges ₹650 card via the configured payment-gateway (D9); creates Sale (`bookingId=88` populated) + 2 `SaleLineItem` rows + Invoice + WalletTransaction (type=REDEEM, -2000) + InventoryAdjustment (Lip Balm -1) + audit `SALE_FINALIZED` (lineage: bookingId). Booking 88 flips to `status=COMPLETED`. PDF receipt opens. ~75 seconds total.

3. **Mid-sale operator tab-switch — Booking interrupts walk-in.** Operator is mid-walk-in with 2 items in the basket (Hair Trim ₹350 + Conditioner ₹220 = ₹570). A pre-booked customer arrives. Operator clicks the **Booking** tab. Confirm modal: "You have 2 items in this walk-in basket. Save as Draft, Discard, or Cancel switch?" Operator picks "Save as Draft" → a draft `Sale` row is written with `status=DRAFT` (today's `Sale.status` enum already includes DRAFT) and the basket is cleared. Operator processes the Booking customer. Returns to the **Walk-in** tab; the draft is restored from the URL path `/pos/new/walk-in?draftId=N` and the walk-in customer resumes paying.

4. **Cashier finalizes sale using Wallet for part-payment + Cash for rest.** Patient's wallet has ₹2100 (₹1900 principal + ₹200 bonus from PRD_WALLET_TOPUP). Sale total is ₹2500. Cashier opens payment splitter, adds Line 1: WALLET ₹2100 + Line 2: CASH ₹400. Submits. Backend re-validates sum-equals-total; opens transaction; calls `POST /api/wallet/redeem { amountCents: 210000, reason: 'INVOICE', invoiceId: <to-be-created>, idempotencyKey }` first (per Wallet PRD's batch walker, debits principal first then bonus); then writes the `Sale.paymentBreakdownJson = [{method: 'WALLET', amountCents: 210000, walletTxnId: 4321}, {method: 'CASH', amountCents: 40000}]`; commits; emits audit `SALE_FINALIZED` with the full breakdown payload.

5. **Membership-applied sale — operator applies the patient's active membership benefit before payment.** Patient has an active `Membership` with 20% off all services. Operator picks a Booking → items pre-filled (Facial ₹2500). The items picker auto-applies the membership: a green-pill row shows "Membership: Gold 20% off — savings ₹500". Grand-total is now ₹2000 instead of ₹2500. Operator processes cash payment of ₹2000. Backend writes the `SaleLineItem.lineDiscount=500` automatically with the membership reference encoded into `paymentBreakdownJson` (or a sibling `appliedMembershipId` field on Sale — see Q9). Audit captures `SALE_FINALIZED { membershipAppliedId, discountFromMembershipCents: 50000, ... }`.

6. **Operator voids a sale within 1 hour of finalize.** Cashier rang a wrong item — wrong patient. Cashier hits "Void" on the sale. Per DD-5.4 (ADMIN-only by default; MANAGER-with-window optional), if DD-5.4 path (a) is locked: cashier sees a "Request void" button → notification to ADMIN → ADMIN clicks the link → confirms with reason → backend flips Sale.status=`CANCELLED` + writes a reverse `InventoryAdjustment` (un-decrement the product) + writes a refund `WalletTransaction` if wallet was used + writes audit `SALE_VOIDED { reason, byUserId, originalSaleId }`. If DD-5.4 path (b) is locked (cashier-can-void-within-N-min): cashier-direct flow. If DD-5.4 path (c) is locked (operator-configurable per-tenant): tenant setting drives.

---

## §3 Functional requirements

### FR-3.1 New page (URL-driven tab refactor) — `frontend/src/pages/wellness/pos/NewSale.jsx`

Major refactor of (or replacement for) the existing `frontend/src/pages/wellness/PointOfSale.jsx`. New page tree:

```
frontend/src/pages/wellness/pos/
  NewSale.jsx                  # tab container + URL routing
  NewSaleBookingTab.jsx        # today's bookings list + click-to-load
  NewSaleWalkInTab.jsx         # blank canvas + patient picker + items picker
  PaymentSplitter.jsx          # multi-method payment line builder
  ItemsPicker.jsx              # autocomplete typeahead over the 5 line types
  PatientPicker.jsx            # autocomplete + inline quick-add
  VoidSaleModal.jsx            # void/refund flow per DD-5.4
```

**Route registration** in `frontend/src/App.jsx`:
- `/pos/new` — redirects to `/pos/new/walk-in` (default mode).
- `/pos/new/booking` — Booking tab visible; tab pill highlighted.
- `/pos/new/walk-in` — Walk-in tab visible; tab pill highlighted.
- `/pos/new/walk-in?draftId=N` — restores a saved-draft Sale (per use case 3).
- `/pos/new/booking/:bookingId` — direct-link to a pre-loaded booking (e.g. from a calendar widget).

URL-driven per DD-5.1 path (a). Back-button works; the URL is shareable (operator can send "/pos/new/booking/88" to a co-cashier).

**Sidebar entry:** existing "Point of Sale" sidebar link redirects from `/pos` → `/pos/new` (the legacy flat-builder is deprecated but preserved at `/pos/legacy` for transition; deleted in Phase 2 after 30d of telemetry).

**Visible tab pills at top of page:** "Bookings (4)" + "Walk-in" — Bookings shows the count of today's open bookings inline.

**Shift-status banner:** preserved from today's `PointOfSale.jsx` — top of page; "No active shift — open shift to ring sales" if status != OPEN.

### FR-3.2 Booking tab — today's bookings list endpoint + click-to-load

New endpoint:

```
GET /api/pos/bookings/today
Headers: Authorization: Bearer <token>
Query params:
  registerId?: Int      # default = cashier's currently-open shift's registerId
  locationId?: Int      # default = register's locationId
  status?: 'CONFIRMED'  # default = CONFIRMED only (operator unlikely to ring a CANCELED)
  includeDrafts?: 'true' | 'false'  # default false — drafts shown separately
Response 200: {
  bookings: [{
    id, scheduledAt, contactName, contactPhone, contactEmail, contactId,
    durationMins, status, notes,
    suggestedItems: [{ lineType, refId, name, defaultPrice }],   # pre-filled from BookingPage / Service catalogue
    patientId: Int | null,                                       # resolved by phone + tenantId
    bookingPageSlug: String                                      # for the "Pre-booked via web" badge
  }, ...],
  drafts: [{ saleId, patientName, basketCount, createdAt }] | undefined
}
```

**Auth:** `verifyToken` + `cashierGate` (USER + sub-role=cashier OR MANAGER/ADMIN).

**Engine flow:** Look up cashier's open shift via `findFirst({where: {userId: req.user.userId, status: 'OPEN'}})` — 409 if no open shift. Scope Bookings to `tenantId + scheduledAt BETWEEN startOfDay AND endOfDay` (server-side TZ = tenant's TZ, defaults to IST). Filter by `bookingPage.location` matching the cashier's register's location (where the BookingPage carries a location FK; some tenants' booking pages are location-agnostic — treat NULL as "match all"). Resolve `patientId` by `Patient.findFirst({ where: { phone: booking.contactPhone, tenantId }})` — NULL if not found (operator will create on click). Compute `suggestedItems` from BookingPage default services (a future schema extension: `BookingPage.defaultServiceIds Int[]`) OR from operator-curated last-Sale-for-this-Patient lookup (Phase 2; v1 ships empty array).

**Click-to-load behaviour (frontend):** clicking a Booking card calls `GET /api/pos/bookings/:id/sale-draft` (engine creates a `Sale` row with `status=DRAFT` + `bookingId=N`, pre-fills items from `suggestedItems`, returns the draft). The page navigates to `/pos/new/booking/:bookingId` + renders the editable Sale draft pane.

### FR-3.3 Walk-in tab — blank canvas with patient picker + items picker

The "Walk-in" tab opens with no pre-loaded data. The pane shows:

**Patient picker:** autocomplete input (typeahead on name / phone / email) backed by `GET /api/wellness/patients?search=<q>&limit=10` (existing endpoint). Results show: `Sarah Khan — 9999988888 — sarah@example.com`. Selecting a result populates the Sale draft's `patientId`. Below the picker, an inline link "+ Add new patient" opens a 4-field modal (name + phone + email + email-opt-in) → `POST /api/wellness/patients` (existing endpoint) → returns new Patient → auto-selected in the picker.

**Guest checkout toggle:** preserved from Wave 7C — checking the toggle forces `patientId=null` + hides the picker. Operator can still proceed.

**Items picker:** autocomplete typeahead over the 5 `lineType` types. Single search box ("Search services, products, memberships..."); the autocomplete results are tagged with their lineType:
```
🩺 Hair Trim — ₹350 — SERVICE
📦 Lip Balm — ₹150 — PRODUCT
🎁 Gold Membership — ₹15000/12mo — MEMBERSHIP
💳 ₹5000 Gift Card — GIFTCARD
🧴 Facial Glow Package — 6 sessions — ₹15000 — PACKAGE
```

Backed by a NEW unified-search endpoint:
```
GET /api/pos/catalogue/search?q=<query>&types=SERVICE,PRODUCT,MEMBERSHIP,GIFTCARD,PACKAGE&limit=10
Response 200: { items: [{ lineType, refId, name, defaultPrice, defaultQty, taxable, stockOnHand? }, ...] }
```

Implementation: fan-out over the 5 underlying Prisma models (Service, Product, Membership, GiftCard, Package) with a single response shape. `stockOnHand` field present only for PRODUCT (drives the inventory warning).

Each picked item drops into the basket as a new `SaleLineItem` draft row with editable qty + price + lineDiscount controls (mirror today's flat-builder row, but with the lineType + refId locked).

### FR-3.4 Pricing engine integration

The grand-total computation reuses the same pricing logic as today:
- `subtotal = sum(items.unitPrice * items.quantity - items.lineDiscount)`
- `discountTotal = subtotal × pct + flat OR couponPreview.discountAmount OR membershipDiscount` — pick the highest applicable per DD-5.6 (recommend Single-source-of-truth: ONE discount per sale; operator picks via radio).
- `taxTotal = items.filter(taxable).sum(lineTotal × tenant.gstRate)` — per-tenant tax config.
- `grandTotal = subtotal - discountTotal + taxTotal`

New: membership auto-application. If patient has an active `Membership` with `discountPercent > 0`, the items picker auto-applies the discount line-by-line (per `Service.membershipEligible` flag). Operator can override via the existing manager-override block (preserved from Wave 7C).

Server-side re-validation: `POST /api/pos/sales` re-computes the grand-total from supplied line items + supplied discount block + supplied membership reference. Mismatch with client-supplied total → 400 with diff payload.

### FR-3.5 Payment splitter UI — `frontend/src/pages/wellness/pos/PaymentSplitter.jsx`

A multi-line payment builder.

**Default state:** 1 line, method=CASH, amount=grandTotal. (Single-method shortcut for the common case.)

**Operator interaction:**
- "+ Add method" button appends a new line (default CASH).
- Each line: method dropdown (CASH / CARD / UPI / WALLET / GIFTCARD / CASHBACK / PAYLATER / ONLINE) + amount input.
- Real-time validation: `sum(lines.amount) === grandTotal` — green checkmark; mismatch shows red banner with the delta ("₹50 over" / "₹100 short").
- WALLET line: if patient has a wallet, shows "Available: ₹2100"; operator can't enter more than the live balance.
- GIFTCARD line: shows a typeahead to look up the gift card by code; pre-populates the available cents.

**Server-side:** the existing `paymentBreakdownJson` column on `Sale` (per [schema.prisma:3921](../backend/prisma/schema.prisma#L3921)) gets populated with the per-line breakdown. `paymentMethod` derived: if 1 line, set to that method; if >1 line, set to `COMBINED`.

**Per DD-5.3 (recommended pattern):** one button per method-card UI (clearest mental model — operator-friendly), with the per-method amount input below the picked card. Alternative paths considered (drag-percent UI, single-amount-with-method-pickwheel) are operator-slower in usability tests.

### FR-3.6 Finalize sale — atomicity hardening — `POST /api/pos/sales` extension

**Existing finalize endpoint** at [backend/routes/pos.js:697-960](../backend/routes/pos.js#L697) — extension scope:

1. **Add `bookingId: Int?` accept** on body → write to `Sale.bookingId`.
2. **Re-validate payment splitter** — if `paymentBreakdownJson` is present, sum-equals-total enforcement.
3. **Move wallet-debit INSIDE the transaction.** Today's wallet redemption happens outside; failures leave the sale committed. Move into the same Prisma `$transaction` block so the redemption fails atomically with the sale insert. Requires the redemption to be a direct Prisma call (not an HTTP POST to another route) — wrap the redeem logic in a `lib/walletRedemption.js::redeemInternal(prisma, walletId, amountCents, source)` helper. (This is also called out in PRD_WALLET_TOPUP.md §8 dependencies.)
4. **Inventory decrement** — already inside the transaction; no change.
5. **Idempotency key** — accept `Idempotency-Key: <uuid>` header on the POST. 24h cache via the shared `IdempotencyKey` infra (per DD-5.6 in PRD_WALLET_TOPUP.md / PRD_PAYMENT_GATEWAY_CONFIG.md). Replay returns the cached response.
6. **Audit emission** — extend the existing `SALE_CREATED` audit row with the full payment breakdown + bookingId. Add `SALE_FINALIZED` (committed) + `SALE_VOIDED` (refund/cancel) action vocabulary.
7. **Booking status update** — if `bookingId` is set, flip the Booking row's status to `COMPLETED` inside the same transaction.

**Response envelope** (extends existing):
```json
{
  "sale": { "id": 1234, "invoiceNumber": "INV-2026-1234", "bookingId": 88, "total": 2650, ... },
  "invoice": { "id": 5678, "invoiceNumber": "INV-2026-1234" },          // per #775
  "walletTransaction": { "id": 4321, "amount": -2000 } | null,
  "inventoryAdjustments": [{ "productId": 42, "delta": -1 }, ...],
  "receiptUrl": "/api/pos/sales/1234/receipt.pdf",
  "auditId": 99887
}
```

### FR-3.7 PDF receipt emission — extend `backend/services/pdfRenderer.js`

Add a `renderReceiptPDF(saleId, options)` helper:
- Pulls `Sale` + `SaleLineItem`[] + Patient (or "Walk-in" if anonymous) + Booking (if set) + payment breakdown.
- Renders per the existing pdfKit pattern (`renderPrescriptionPDF` / `renderInvoicePDF` for the template style).
- Tenant logo from `Tenant.logoUrl` (existing field). Wellness tenants use the wellness theme palette (teal `#265855` per `wellness.css`).
- Layout: thermal-roll friendly (80mm width target; per DD-5.5) but A4 also supported (operator toggles via header param).
- Includes: tenant name + address + GSTN, invoice number, date, patient name (or "Walk-in"), itemized lines + qtys + lineTotals, discounts + tax breakup, grand total, payment breakdown lines, cashier name, "Thank you" footer.

New endpoint:
```
GET /api/pos/sales/:id/receipt.pdf?format=thermal|a4
Auth: verifyToken + cashierGate
Response 200: application/pdf
```

### FR-3.8 Active register / shift gate

Mirror today's `cashierGate` middleware exactly:
- `GET /api/pos/shifts/current` for cashier's currently-open shift.
- If no open shift, the New Sale page shows the "Open Shift" modal (per today's PointOfSale.jsx pattern) BEFORE the tabs render.
- "Complete Sale" submit returns 409 if no open shift (today's `cashierGate` already enforces this; no change).

### FR-3.9 Audit log integration — 3 new audit actions (replaces today's bare SALE_CREATED)

All flow through existing `backend/lib/audit.js` `writeAudit()` for tamper-evident hashing. Audit entity = `SALE`.

- `SALE_DRAFT_CREATED` — when a `Sale` row goes from non-existence to `status=DRAFT` via the Booking-tab click-to-load (per FR-3.2). Fields: `{ saleId, bookingId?, patientId?, basketCount }`.
- `SALE_FINALIZED` — when a Sale completes (`status=COMPLETED`); REPLACES the legacy `SALE_CREATED`. Fields: `{ saleId, invoiceNumber, bookingId?, patientId?, total, paymentBreakdown[], lineTypes[], appliedMembershipId?, idempotencyKey, durationMs }`.
- `SALE_VOIDED` — when a Sale is voided/cancelled per FR-3.10. Fields: `{ saleId, originalTotal, reason, voidedByUserId, refundedWalletCents?, inventoryAdjustmentsReversed[] }`.

Backward compat: existing `SALE_CREATED` audit rows from before this PRD ships are NOT migrated; the `/audit/verify` engine accepts both vocabularies.

### FR-3.10 Void / refund flow — `POST /api/pos/sales/:id/void`

```
POST /api/pos/sales/:id/void
Body: { reason: String, refundMethod: 'CASH' | 'CARD' | 'WALLET' | 'GATEWAY' }
Response 200: {
  voidedSale: { id, status: 'CANCELLED', refundedAt },
  reversedWalletTransaction?: { id, amount },
  reversedInventoryAdjustments: [{ productId, delta }, ...]
}
Response 4xx: SALE_NOT_VOIDABLE (already cancelled / refunded; or > N hours per DD-5.4 cashier-window)
```

**Auth per DD-5.4:**
- Path (a) — current proposal: ADMIN-only. Cashier sees "Request Void" button that notifies ADMIN.
- Path (b) — cashier-can-void-within-N-min (configurable, default 60).
- Path (c) — operator-configurable per-tenant via `Tenant.posVoidPolicy ∈ {ADMIN_ONLY, CASHIER_WINDOW}`.

Inside one Prisma transaction: flip `Sale.status = CANCELLED` + write `Sale.refundedAt = now()` + reverse all `InventoryAdjustment` rows tied to this sale + (if wallet was used in payment) write a `WalletTransaction` (type=`REVERSAL`, +amount) per PRD_WALLET_TOPUP.md FR-3.10. Audit `SALE_VOIDED`.

### FR-3.11 RBAC matrix

| Action | USER (cashier sub-role) | MANAGER | ADMIN |
|--------|--------------------------|---------|-------|
| `GET /api/pos/bookings/today` | YES (own register's scope) | YES (any in tenant) | YES |
| `GET /api/pos/bookings/:id/sale-draft` | YES | YES | YES |
| `GET /api/pos/catalogue/search` | YES | YES | YES |
| `POST /api/pos/sales` (finalize) | YES | YES | YES |
| `POST /api/pos/sales/:id/void` (DD-5.4 path a) | NO (403 — "Request Void" UI) | YES (within 60min) | YES (any) |
| `GET /api/pos/sales/:id/receipt.pdf` | YES (own shift's) | YES | YES |

Cross-tenant access always 404 (existence-disclosure prevention; same pattern as EmployeeProfile in PRD_STAFF_DETAIL.md).

---

## §4 Non-functional

- **Per-tenant scoping enforced.** Every endpoint scopes by `req.user.tenantId`; cross-tenant access returns 404.
- **Idempotency.** `POST /api/pos/sales` accepts `Idempotency-Key: <uuid>` header. Cached responses replay for 24h. Per DD-5.6 shared with PRD_WALLET_TOPUP / PRD_PAYMENT_GATEWAY_CONFIG.
- **Atomicity.** Sale insert + SaleLineItem inserts + InventoryAdjustment + WalletTransaction (redeem) + Invoice insert (per #775 polymorphism) + Booking status flip + audit row enqueue — ALL inside ONE Prisma `$transaction`. Failure rolls back all of them. Audit chain write is the only deliberate post-commit step (hash-chain reasons).
- **Performance.** New Sale page initial load: P95 <800ms (today's bookings list ≤30 cards + cashier's open-shift state + catalogue search index warm). Per-item search autocomplete P95 <200ms (5-model fan-out; uses `.findMany({take: 10})` on each with tenantId+search indexes).
- **Inventory check.** Real-time `stockOnHand` validation on PRODUCT-type lines INSIDE the transaction — never oversell. If a SKU runs out between client-load and finalize, the response is 409 with `INSUFFICIENT_STOCK { productId, availableQty, requestedQty }`.
- **Receipt latency.** PDF generation P95 <500ms (pdfKit; in-memory render; not write-to-disk).
- **Mobile responsive.** New Sale page degrades to single-column at <768px (Booking tab → vertical card list; Walk-in tab → stacked picker + basket + payment).
- **i18n-ready.** All operator + customer-facing labels route through `LanguageSwitcher.jsx`. Receipt template supports patient-language override (per `Patient.locale`).
- **Single-currency-per-sale.** All amounts are in `Tenant.defaultCurrency` cents. Cross-currency at the point of sale is OUT OF SCOPE (Q multi-currency below).
- **Backward compatibility.** Existing `POST /api/pos/sales` callers (the legacy flat-builder + any direct API integrations) keep working — new fields (`bookingId`, expanded `paymentBreakdownJson`, `Idempotency-Key`) are all OPTIONAL. Existing `SALE_CREATED` audit rows are NOT migrated.
- **Legacy page sunset.** `/pos/legacy` (today's flat-builder) stays available for 30 days post-deploy; telemetry (page-load count + completion-rate) drives the decision to delete in Phase 2.
- **Draft sale cleanup.** A new daily cron (`backend/cron/draftSaleCleanupEngine.js`, engine #25) sweeps `Sale.status=DRAFT AND createdAt < now-24h` → soft-deletes (or `status=ABANDONED`). Configurable cleanup window via env `POS_DRAFT_TTL_HOURS` (default 24). Audit `SALE_DRAFT_ABANDONED`.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / engineering sign-off before any code lands)

- **DD-5.1 Tab routing surface — URL path segments (current proposal) vs query parameter vs in-page state-only.** Three paths:
  - **(a) URL PATH SEGMENTS (current proposal).** `/pos/new/booking` vs `/pos/new/walk-in` vs `/pos/new/booking/:bookingId`. Pro: shareable links (operator A can send "/pos/new/booking/88" to operator B in a chat); back-button works; bookmark-able; the booking-deep-link case (use case 2) is straightforward. Con: more route registration in `App.jsx`; slight cognitive load.
  - **(b) QUERY PARAMETER.** `/pos/new?tab=booking&bookingId=88`. Pro: simpler routing (one route); state-encoded URL. Con: less semantic; harder to bookmark cleanly.
  - **(c) IN-PAGE STATE-ONLY.** `/pos/new` always; tab state is in component state. Pro: simplest. Con: not shareable; back-button doesn't switch tabs.
  - **Recommendation: (a) URL PATH SEGMENTS for v1.** Shareable + back-button correctness is operator-valuable; the in-house use case 2 (deep-link to a Booking) needs (a) or (b) anyway; (a) is cleaner semantic.

- **DD-5.2 Items picker ergonomics — autocomplete-typeahead (current proposal) vs modal-picker vs sidebar-drawer.** Three paths:
  - **(a) AUTOCOMPLETE TYPEAHEAD (current proposal).** Single search box at top of basket; results dropdown; pick → row added. Pro: fastest for power users; "type, enter, type, enter" rhythm; muscle memory after 10 sales. Con: requires per-tenant catalogue to have searchable names; cold-start operators may not know what to type.
  - **(b) MODAL PICKER.** Click "+ Add Item" → modal opens with all 5 lineType tabs + per-tab list + search. Pro: discoverable; categories visible; works for unfamiliar catalogues. Con: 2-click interaction; slower for power users; modal flicker.
  - **(c) SIDEBAR DRAWER.** Always-open right sidebar with the catalogue list. Pro: visible at all times; no modal; click-to-add. Con: takes up screen real estate; less efficient on mobile; not how Zylu ships.
  - **Recommendation: (a) AUTOCOMPLETE TYPEAHEAD for v1.** Zylu match; power-user-optimised; mobile-friendly. Add a "Browse catalogue" link beside the search box for cold-start operators (opens path (b) modal as a fallback).

- **DD-5.3 Payment splitter UI — one-button-per-method (current proposal) vs drag-percent vs single-amount-with-method-pickwheel.** Three paths:
  - **(a) ONE-BUTTON-PER-METHOD (current proposal).** Method cards (CASH / CARD / UPI / WALLET / GIFTCARD / etc); operator clicks a card → an amount-input row appears for that method; can add multiple. Pro: visual; fastest for typical 1-2 method splits; operator sees all methods at once. Con: more screen space.
  - **(b) DRAG-PERCENT UI.** A horizontal bar; operator drags split points to allocate %. Pro: visual + numerically intuitive for proportional splits. Con: precision is bad; clinics deal in rupees-and-paise not %; mobile-unfriendly drag.
  - **(c) SINGLE-AMOUNT WITH METHOD-PICKWHEEL.** A wheel/dropdown picks the method; a single amount input. To add more methods, repeat. Pro: minimal UI. Con: tedious for splits; not what Zylu ships.
  - **Recommendation: (a) ONE-BUTTON-PER-METHOD for v1.** Operator-fastest for typical 1-2 method scenarios. Numerically precise. Mobile-friendly.

- **DD-5.4 Void / refund window — ADMIN-only (current proposal) vs cashier-window-within-N-min vs operator-configurable per-tenant.** Three paths:
  - **(a) ADMIN-ONLY (current proposal).** Cashier sees "Request Void" button; ADMIN must approve. Pro: simplest audit; clear chain of accountability; matches the strictest Zylu permission. Con: friction for cashier when ADMIN is unavailable (small clinic, off-hours).
  - **(b) CASHIER-WINDOW-WITHIN-N-MIN.** Cashier can void within N minutes (configurable, default 60). After N, ADMIN-only. Pro: covers cashier-typo case without ADMIN dependency; bounded blast radius. Con: arbitrary window choice; race conditions on the boundary.
  - **(c) OPERATOR-CONFIGURABLE PER-TENANT.** `Tenant.posVoidPolicy ∈ {ADMIN_ONLY, CASHIER_WINDOW, MANAGER_ONLY}` flag. Pro: tenant-flexible. Con: more surface complexity; ops complexity tracking who's on which policy.
  - **Recommendation: (a) ADMIN-ONLY for v1.** Cleanest audit + simplest mental model; revisit (b) in Phase 2 once telemetry says "98% of voids happen within 5min of sale" (in which case the 60min window has 2x the false-positive surface for no real benefit) OR "voids are evenly spread across the day" (in which case the cashier-typo case is rare and ADMIN bottleneck doesn't matter).

- **DD-5.5 Receipt format — thermal-roll 80mm + A4 (current proposal) vs A4 only vs thermal only vs HTML print-friendly only.** Four paths:
  - **(a) THERMAL 80mm + A4 (current proposal).** Both layouts shipped; operator picks via `?format=thermal|a4` query param. Pro: covers both clinic types (thermal-roll printer at the front desk + occasional A4 print for accounting). Con: 2× template effort.
  - **(b) A4 ONLY.** Single A4 PDF. Pro: simplest. Con: doesn't fit thermal-roll printers (most clinic POS hardware).
  - **(c) THERMAL ONLY.** 80mm only. Pro: matches clinic hardware. Con: A4 needed for accounting / customer email.
  - **(d) HTML PRINT-FRIENDLY ONLY.** No PDF; open in new tab + browser-print. Pro: zero PDF infra. Con: no email-attachment use case; browser-formatting drift.
  - **Recommendation: (a) THERMAL + A4 for v1.** Both layouts in one helper; ~1.5x effort over single-format; covers the wellness vertical's two real customer scenarios.

- **DD-5.6 Discount application priority — single-source-of-truth radio (current proposal) vs all-stacked vs operator-configurable per-tenant.** Three paths:
  - **(a) SINGLE-SOURCE-OF-TRUTH RADIO (current proposal).** Operator picks ONE: Membership OR Coupon OR % flat-discount OR Manager-override. Stacking disallowed. Pro: simple; predictable customer-facing arithmetic; prevents stacking-abuse. Con: operator can't apply membership AND a special coupon together (less generous to repeat customers).
  - **(b) ALL-STACKED.** All applicable discounts compound. Pro: customer-friendly. Con: economically dangerous (discounts can stack > 50%; loses revenue silently); confusing arithmetic.
  - **(c) OPERATOR-CONFIGURABLE PER-TENANT.** `Tenant.discountStackingPolicy ∈ {SINGLE, STACKED}`. Pro: tenant-flexibility. Con: surface complexity.
  - **Recommendation: (a) SINGLE-SOURCE for v1.** Customer-predictable; financial safety. Revisit (b) in Phase 2 if a high-loyalty-program tenant asks for it (would need new audit guards too).

- **DD-5.7 Walk-in patient handling — picker-mandatory unless guest-checkout (current proposal) vs always-mandatory vs always-optional.** Three paths:
  - **(a) PICKER-MANDATORY UNLESS GUEST-CHECKOUT (current proposal).** Walk-in tab requires either a picked Patient OR the Guest-Checkout toggle ON. Pro: clean default; encourages patient-attribution for reporting; covers the truly anonymous case via the explicit toggle. Con: 1 extra click vs always-optional.
  - **(b) ALWAYS-MANDATORY.** No guest-checkout. Walk-in MUST have a Patient row. Pro: full reporting attribution. Con: ill-suited to retail-style "just buy a face cream, no signup" walk-ins.
  - **(c) ALWAYS-OPTIONAL.** Patient field is optional by default. Pro: lowest friction. Con: high % of attribution lost; harder to reconcile reports.
  - **Recommendation: (a) PICKER-MANDATORY UNLESS GUEST-CHECKOUT for v1.** Preserves today's behaviour from Wave 7C; matches the wellness vertical's reporting needs.

- **DD-5.8 Booking-status flip on sale finalize — auto-flip to COMPLETED (current proposal) vs manual-only vs configurable.** Three paths:
  - **(a) AUTO-FLIP TO COMPLETED (current proposal).** When `Sale.bookingId` is set + Sale finalizes, the Booking row's `status` flips to `COMPLETED` inside the same transaction. Pro: keeps Booking state synced with revenue reality; simplifies the calendar widget (no more "CONFIRMED for an already-paid booking"); attribution reports are accurate. Con: removes the operator's ability to keep a Booking in CONFIRMED state even after partial-revenue (rare, but Phase 3 partial-fulfillment workflows might need it).
  - **(b) MANUAL-ONLY.** Booking stays at CONFIRMED; operator manually flips. Pro: separation of concerns. Con: 99% of bookings should auto-flip; manual is friction; the gap leaves "CONFIRMED appointment with linked completed Sale" rows everywhere.
  - **(c) CONFIGURABLE per-tenant.** Flag. Pro: flexibility. Con: surface complexity.
  - **Recommendation: (a) AUTO-FLIP TO COMPLETED for v1.** Pragmatic default; Phase 3 might split partial-fulfillment to a different status (e.g. `PARTIALLY_COMPLETED`) but v1 ships the binary.

### Cred chase

- **None external for v1.** Re-uses existing payment-gateway integration (Stripe / Razorpay cred via #896 — PRD_PAYMENT_GATEWAY_CONFIG.md).
- **None external for receipt printing** — uses `pdfKit` in-process; thermal-roll printer is the operator's hardware (no software cred needed; the receipt is emitted as a generic PDF the OS print-dialog handles).

### Vendor docs

- N/A for v1. Internal pattern reuse only.
- **Internal doc dependency:** `frontend/src/pages/wellness/pos/NewSale.jsx` JSDoc documents the tab routing + draft-restore flow.
- **Internal doc dependency:** `backend/services/pdfRenderer.js` JSDoc gains a new `renderReceiptPDF()` section with template format + parameter contract.
- **Internal doc dependency:** the extended `POST /api/pos/sales` endpoint header JSDoc in `backend/routes/pos.js` documents the new `bookingId` + `Idempotency-Key` semantics.

---

## §6 Acceptance criteria

- **AC-6.1** Cashier (USER + cashier sub-role) navigates `/pos/new/walk-in` → patient picker autocomplete with "Sarah" returns 3 results → picks "Sarah Khan, 9999988888" → items picker typeahead "Hair Trim" returns SERVICE with `defaultPrice=350` → presses Enter → 1 `SaleLineItem` draft appears in basket with qty=1, lineTotal=350. Payment splitter shows 1 default line (CASH, ₹350). Operator clicks "Complete Sale". Backend creates `Sale` (`bookingId=null`, `total=350`) + 1 `SaleLineItem` + `Invoice` (#775) + audit `SALE_FINALIZED` inside ONE Prisma transaction. `GET /api/pos/sales/<id>/receipt.pdf?format=thermal` returns 200 with `application/pdf` body. The same finalize POST with the same `Idempotency-Key` header within 24h returns the cached response with `replayed: true`.

- **AC-6.2** Cashier navigates `/pos/new/booking` → `GET /api/pos/bookings/today` returns 4 cards including booking #88 (10:30, Sarah Khan, Facial Glow Package) → clicks card → backend creates `Sale` (`status=DRAFT, bookingId=88, patientId=resolved`) + 1 pre-filled `SaleLineItem` (lineType=PACKAGE, refId=12, unitPrice=2500) + returns the draft → frontend navigates to `/pos/new/booking/88`. Operator adds an extra PRODUCT line (Lip Balm ₹150). Payment splitter: WALLET ₹2000 + CARD ₹650 = ₹2650. Operator finalizes. Backend, inside ONE transaction: walks wallet batches (per PRD_WALLET_TOPUP FR-3.3 redeem) for ₹2000 (debits 1-2 batches); writes Sale (status=`COMPLETED`, bookingId=88, paymentMethod=`COMBINED`, paymentBreakdownJson=`[{method:WALLET,...},{method:CARD,...}]`); writes Invoice; decrements Lip Balm stock by 1 via InventoryAdjustment; flips Booking 88 to `status=COMPLETED`; emits audit `SALE_FINALIZED { saleId, bookingId: 88, paymentBreakdown: 2 lines, ... }`. Booking 88 auto-flipped to COMPLETED per DD-5.8.

- **AC-6.3** Operator is mid-walk-in with 2 items (₹570). Clicks the **Booking** tab pill. Confirm modal appears: "You have 2 items in this walk-in basket. Save as Draft, Discard, or Cancel switch?". Operator picks "Save as Draft". A `Sale` row is written (status=`DRAFT`, basket preserved). URL is now `/pos/new/booking`. Booking tab renders. After processing the booking customer, operator returns via `/pos/new/walk-in?draftId=<N>` → draft Sale is loaded back into the basket. Operator completes the walk-in. Draft sale gets finalized (status flipped from DRAFT → COMPLETED).

- **AC-6.4** Cashier attempts to ring a PRODUCT line whose `stockOnHand=0` at finalize time (between client-load + finalize, the stock was depleted by a parallel sale on the same SKU). `POST /api/pos/sales` rolls back inside the transaction with HTTP 409 + body `{ code: 'INSUFFICIENT_STOCK', productId: 42, availableQty: 0, requestedQty: 1 }`. No Sale row is created. No InventoryAdjustment row is created. The wallet, if applicable, is NOT debited. Frontend surfaces the error inline with a "Refresh stock" CTA.

- **AC-6.5** ADMIN triggers `POST /api/pos/sales/:id/void` on a finalized sale that used WALLET₹2000 + CARD ₹650 + included 1 Lip Balm PRODUCT line. Inside ONE Prisma transaction: Sale.status flipped to `CANCELLED`; Sale.refundedAt = now(); WalletTransaction (type=REVERSAL, +2000) appended (per PRD_WALLET_TOPUP FR-3.10); InventoryAdjustment for Lip Balm reversed (+1); Audit `SALE_VOIDED { saleId, originalTotal: 2650, reason: '<text>', voidedByUserId, refundedWalletCents: 200000, inventoryAdjustmentsReversed: [{productId: 42, delta: +1}] }`. Cashier (USER role, no sub-role bump) attempting the same POST gets 403 per DD-5.4 path (a). Cross-tenant ADMIN trying to void a tenant-B Sale ID returns 404 (existence-disclosure prevention).

---

## §7 Out of scope

- **Multi-currency at point-of-sale** — v1 ships single-currency-per-sale (tenant's defaultCurrency). Cross-currency at the POS is Phase 2 (needs FX-rate snapshotting on the Sale row + multi-currency receipt template + per-tenant currency-list config).
- **Layaway / partial-payment-over-time** — Phase 2 feature. v1's `Sale.status=COMPLETED` requires `paidAmount >= total`. Partial-paid sales (deposit + balance later) need a new `PARTIALLY_PAID` status + `Sale.balanceDueAmount` column + a reminder cron.
- **Subscription billing** — Phase 2; covered by a separate PRD (Plans & Billing). v1 sells MEMBERSHIP as a one-time line; recurring-charge sequencing is out of scope.
- **Self-service kiosk mode** — Phase 2 feature. Patient-facing tablet at the front desk that the customer can self-tap their bookings + pay; v1 is operator-only.
- **Tip / gratuity capture** — Phase 2. Many salons want a tip line at payment time; v1 doesn't model tips (would need a separate column on Sale + per-cashier tip-pool aggregation).
- **Returns/exchanges (vs refunds)** — Phase 2. v1's void is a full-cancel + full-refund. Returns (swap one item for another, adjust the total) are out of scope; operator workaround is void + re-ring.
- **Cross-shift sale finalize** — v1 requires the cashier to have an OPEN shift to finalize. Re-finalize-a-draft-on-a-new-shift handling is out of scope (Q3).
- **Sales analytics dashboard** — v1 reuses existing `Reports.jsx` infra. Per-cashier / per-register / per-payment-method drill-downs are existing reports that this PRD does NOT extend.
- **Manager-override pricing on Booking-loaded sales** — Phase 2. v1 allows manager-override on the discount block (preserved from Wave 7C) but doesn't surface per-line price override on Booking-loaded sales (operator can change the discount, not the unit price, to keep the Booking's quoted price visible).
- **Walk-in auto-Booking creation** — per Q7 deferred to Phase 2. Useful for reporting but adds complexity (auto-created Bookings clutter the calendar view).
- **Bulk-sale (one customer, multiple sub-customers)** — e.g. a family of 4 paying together. Phase 2.
- **Operator-saved sale presets** — "ring the Holiday Special package" 1-click preset. Phase 2.
- **Customer-facing electronic receipt (email-on-finalize)** — Phase 2; v1 emits PDF but doesn't auto-email. Operator can email-attach manually.
- **POS hardware integration** (cash-drawer kick, barcode scanner, RFID tag, receipt-printer auto-emit) — Phase 3. v1 is browser-only.
- **Loyalty point earning on sales** — Phase 2 (depends on `LoyaltyTier` from PRD_WALLET_TOPUP DD-5.8).
- **Travel-vertical Bookings** (TMC trips / RFU Umrah) — out of scope; the wellness POS is the wellness vertical's surface only. Travel sells via different surfaces (covered by `routes/travel_invoices.js` + sibling).

---

## §8 Dependencies

- **`Sale` model** at `backend/prisma/schema.prisma:3895-3935` — re-used as-is; one nullable FK field added (`bookingId Int?` + `@@index([tenantId, bookingId])`); no other column changes. Passes `migration_check` gate without bless markers (nullable FK is purely additive).
- **`SaleLineItem` model** at `backend/prisma/schema.prisma:3937-3958` — re-used as-is; no changes.
- **`Booking` model** at `backend/prisma/schema.prisma:2238-2263` — re-used as-is; status flip to COMPLETED is an existing state transition.
- **`Register` + `Shift` + `PettyCashLedger` models** at `backend/prisma/schema.prisma:3817-3893` — re-used as-is; no changes.
- **`Patient` model** — re-used; the patient picker calls `GET /api/wellness/patients?search=<q>` (existing endpoint).
- **`Service` + `Product` + `Membership` + `GiftCard` + `Package` Prisma models** — re-used as catalogue sources; new unified-search endpoint fans out over them.
- **`backend/routes/pos.js:697-960`** `POST /api/pos/sales` finalize endpoint — extended with `bookingId` + `Idempotency-Key` + atomicity hardening (wallet redemption moves inside the transaction).
- **`backend/routes/pos.js:147-660`** existing register / shift / petty-cash endpoints — re-used as-is.
- **`backend/lib/audit.js` `writeAudit()`** — new `SALE_*` action set flows through the existing tamper-evident chain.
- **`backend/middleware/auth.js`** `verifyToken` + `cashierGate` + `adminGate` — gates the new endpoints.
- **`backend/services/pdfRenderer.js`** — extended with `renderReceiptPDF()` helper (thermal + A4 templates).
- **`backend/lib/notificationService.js`** — re-used optionally for "receipt emailed" notification (Phase 2 auto-email; v1 manual).
- **`backend/routes/audit.js`** `/verify` endpoint — accepts the SALE_* event family without code change (entity = `SALE`).
- **Idempotency mechanism** — reuses the existing model from PRD_WALLET_TOPUP DD-5.6 / PRD_PAYMENT_GATEWAY_CONFIG (D9). v1 ships dependency-on-D9-or-D16.
- **`PRD_WALLET_TOPUP.md` (D16)** — wallet redemption integration: when a payment line uses `WALLET`, finalize calls `lib/walletRedemption.js::redeemInternal()` (the new internal-API surface added in this PRD's slice 2 to avoid the HTTP round-trip pattern).
- **`PRD_INVOICE_POLYMORPHISM.md` (#775, separate PRD — pending)** — finalize creates an `Invoice` row pointing at the `Sale` per the polymorphism PRD; v1 may ship without this integration if #775 is not ready (Sale.id is the receipt anchor in the interim).
- **`PRD_PAYMENT_GATEWAY_CONFIG.md` (D9)** — when a payment line uses `CARD` / `ONLINE` / `UPI`, finalize routes through the configured Stripe / Razorpay flow. v1 may ship cash-and-wallet-only first if D9 isn't ready (operator marks card payments as manually-collected).
- **New file `frontend/src/pages/wellness/pos/NewSale.jsx`** — tab container + URL routing.
- **New file `frontend/src/pages/wellness/pos/NewSaleBookingTab.jsx`** — today's bookings list + click-to-load.
- **New file `frontend/src/pages/wellness/pos/NewSaleWalkInTab.jsx`** — blank canvas + patient picker + items picker.
- **New file `frontend/src/pages/wellness/pos/PaymentSplitter.jsx`** — multi-method payment line builder.
- **New file `frontend/src/pages/wellness/pos/ItemsPicker.jsx`** — autocomplete typeahead over the 5 line types.
- **New file `frontend/src/pages/wellness/pos/PatientPicker.jsx`** — autocomplete + inline quick-add.
- **New file `frontend/src/pages/wellness/pos/VoidSaleModal.jsx`** — void/refund flow per DD-5.4.
- **New file `backend/lib/walletRedemption.js`** — internal-API redemption helper (called by `routes/pos.js` finalize, NOT exposed as a route). Per FR-3.6 atomicity hardening.
- **New file `backend/cron/draftSaleCleanupEngine.js`** — daily cron to sweep abandoned draft sales (engine #25; mirrors CLAUDE.md cron taxonomy).
- **CI gate-spec wiring** — `e2e/tests/pos-new-sale-api.spec.js` added to both `.github/workflows/deploy.yml` and `.github/workflows/coverage.yml` gate-spec lists per the `wiring-spec-into-gate` skill.
- **Vitest unit tests** at `backend/test/lib/walletRedemption.test.js` + `backend/test/cron/draftSaleCleanupEngine.test.js` + `frontend/src/pages/wellness/pos/__tests__/NewSale.test.jsx` per the `writing-vitest-unit-test` skill.

---

## §9 Open questions

- **Q1 Discount authorization threshold — cashier max X% (e.g. 10%) above which MANAGER approval required, or operator-configurable per-tenant?** Recommend per-tenant configurable via `Tenant.posCashierMaxDiscountPercent Int? @default(10)`. Above the cashier max, the discount input is read-only + a "Request Manager Approval" button surfaces (manager logs in via PIN or remote approval). Confirm — or push back if a single-clinic baseline (10%) suffices for v1 and tenant-config gets deferred.

- **Q2 Active-register requirement — strict (no sale without an open shift on a register) or warn-and-allow?** Recommend strict (preserves today's `cashierGate` behaviour). Off-register sales create a class of unanchored revenue that the daily cash reconciliation (`/shifts/:id/close`) can't reconcile. Confirm.

- **Q3 Cross-shift draft sales — when a cashier saves a draft, closes their shift, and a NEW cashier opens — can the new cashier resume the draft?** Recommend NO for v1 — drafts are scoped to the cashier who created them. Cross-shift transfer needs a "handoff" workflow + audit trail. Phase 2. Confirm — or push back if shift hand-overs are common in 24-hour clinics.

- **Q4 GST / tax handling — auto-apply per `Service.taxable` flag at the tenant's tax rate, or operator-toggleable per line?** Recommend auto-apply (the current Wave 7C state) using `Tenant.gstRate Float? @default(0.18)`. Operator can adjust the tax-block via manager-override if needed. Confirm.

- **Q5 Receipt format — thermal-roll 80mm + A4 (current proposal per DD-5.5) or one only?** Recommend both (DD-5.5 path a). Tenant defaults to `Tenant.preferredReceiptFormat ∈ {THERMAL, A4}` (Phase 2 toggle); v1 ships per-sale via `?format=...` query param. Confirm.

- **Q6 Patient quick-add inline — minimal 4-field form (name + phone + email + email-opt-in) vs forced to use the full new-patient form on a separate page?** Recommend inline 4-field form (current proposal). The full Patient form has ~15 fields including DOB / allergies / address — overkill for a walk-in. Confirm.

- **Q7 Walk-in WITHOUT patient association — supported via Guest-Checkout toggle (preserved from Wave 7C) — should v1 ALSO auto-create a Booking row for the walk-in for reporting purposes?** Recommend NO for v1 (default; per DD-5.7 path a). Auto-creating Bookings clutters the calendar view. Phase 2 considers an opt-in (`Tenant.autoCreateBookingForWalkin ∈ {YES, NO}`). Confirm.

- **Q8 Membership auto-application — auto-apply at line-add time (per `Service.membershipEligible`) or surface as an operator-toggle ("Apply membership")?** Recommend auto-apply (current proposal). Operator can override via manager-override block if customer doesn't want to use their membership benefit (rare but happens). Confirm.

- **Q9 Membership discount tracking on Sale — store the appliedMembershipId on `Sale.appliedMembershipId Int?` column, encode into `paymentBreakdownJson`, or split into `SaleLineItem.appliedMembershipId Int?` per-line?** Recommend Sale-level `appliedMembershipId Int?` (one membership per sale per DD-5.6 single-source-of-truth). Confirm — or push back if per-line membership-application is needed (one customer with multiple memberships at the same time is rare).

- **Q10 Payment splitter — when amount doesn't match grand-total, what's the operator UX?** Recommend: real-time delta banner (red on mismatch; green on match) + disable "Complete Sale" until match. Confirm — or push back if the operator-friction is too high.

- **Q11 Draft sale TTL — 24 hours (current proposal) or end-of-shift or configurable?** Recommend 24h via env `POS_DRAFT_TTL_HOURS`. End-of-shift is operator-friendly but cross-day drafts (e.g. customer leaves to fetch wallet) are real. Confirm.

- **Q12 Inventory consumption on void — reverse the decrement (current proposal) or leave as a manual cleanup?** Recommend auto-reverse (current proposal). Manual cleanup is error-prone and creates inventory drift. Confirm.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 (tab routing — URL path vs query param vs in-page state) + DD-5.2 (items picker ergonomics — autocomplete vs modal vs sidebar) + DD-5.4 (void/refund actor — ADMIN-only vs cashier-window vs configurable) + Q1 (discount authorization threshold) + Q3 (cross-shift draft handling) + Q9 (membership reference shape — Sale-level vs SaleLineItem-level) before any code lands. **DD-5.4 (void / refund actor) is the highest-leverage decision** — it determines the audit-trail shape + the cashier UX + the ADMIN's daily workload.

**Owner:** TBD per product call. Likely allocation:

- Prisma `Sale.bookingId Int?` nullable FK + `@@index([tenantId, bookingId])` (additive, passes `migration_check` gate) — backend engineer ~0.25 day
- `backend/lib/walletRedemption.js` (internal-API redemption helper extracted from PRD_WALLET_TOPUP D16's slice 1; reused) — backend engineer ~0.5 day
- `backend/routes/pos.js` extension: bookingId + Idempotency-Key + atomicity hardening (wallet redemption inside transaction) + payment-splitter re-validation + audit vocabulary update — backend engineer ~1.0 day
- New endpoints: `GET /api/pos/bookings/today` + `GET /api/pos/bookings/:id/sale-draft` + `GET /api/pos/catalogue/search` + `POST /api/pos/sales/:id/void` + `GET /api/pos/sales/:id/receipt.pdf` — backend engineer ~1.0 day
- `backend/services/pdfRenderer.js::renderReceiptPDF()` (thermal + A4 templates) — backend engineer ~0.75 day
- `backend/cron/draftSaleCleanupEngine.js` daily sweep — backend engineer ~0.25 day
- Frontend `pos/NewSale.jsx` tab container + URL routing + draft restore — frontend engineer ~1.0 day
- Frontend `pos/NewSaleBookingTab.jsx` (today's bookings list + click-to-load + mid-sale switch confirm modal) — frontend engineer ~0.75 day
- Frontend `pos/NewSaleWalkInTab.jsx` (blank canvas + integration with patient + items picker) — frontend engineer ~0.5 day
- Frontend `pos/ItemsPicker.jsx` autocomplete typeahead over 5 line types — frontend engineer ~0.75 day
- Frontend `pos/PatientPicker.jsx` autocomplete + inline quick-add modal — frontend engineer ~0.5 day
- Frontend `pos/PaymentSplitter.jsx` multi-method line builder + real-time delta validation — frontend engineer ~0.75 day
- Frontend `pos/VoidSaleModal.jsx` void/refund flow per DD-5.4 — frontend engineer ~0.5 day
- Tests (api-spec for 5 new endpoints + extended finalize + RBAC matrix + idempotency replay + vitest for walletRedemption helper + cron sweep + frontend NewSale tests) — backend + frontend engineers ~1.5 days
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists — backend engineer ~0.25 day
- Telemetry instrumentation (page-load count + completion-rate against legacy page for the Phase 2 sunset decision) — frontend engineer ~0.25 day

**Total estimated effort post-design: 6-9 engineering days** (tab refactor + payment splitter + atomicity hardening + receipt emission + void flow + draft cleanup + tests — matches the "operator-UX refactor on a mature backend" baseline).

**Sibling PRDs in this cluster:**

- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9; DEPENDED ON for the CARD / UPI / ONLINE payment-line flow + idempotency model)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)
- `PRD_AI_CHAT_HISTORY.md` (tick #192 — unified AI audit + recall surface, cluster D13)
- `PRD_CUSTOMER_SEGMENTS.md` (tick #193 — saved-filter audience targeting, cluster D14)
- `PRD_STAFF_DETAIL.md` (tick #194 — HR profile extension, cluster D15)
- `PRD_WALLET_TOPUP.md` (tick #195 — wallet top-up + bonus + expiry, cluster D16; DEPENDED ON for the WALLET payment-line flow + the `lib/walletRedemption.js` internal-API helper)

**Blocks before frontend impl can start:**

- DD-5.1 (tab routing — URL path vs query param vs in-page state) — MUST resolve (App.jsx route registration shape)
- DD-5.2 (items picker ergonomics — autocomplete vs modal vs sidebar) — MUST resolve (UX surface)
- **DD-5.4 (void/refund actor — ADMIN-only vs cashier-window vs configurable) — HIGHEST LEVERAGE; determines RBAC matrix + cashier UX + audit-trail shape across the surface**
- DD-5.5 (receipt format — thermal + A4 vs single) — MUST resolve (pdfRenderer template count)
- DD-5.6 (discount stacking — single-source-of-truth vs all-stacked vs configurable) — MUST resolve (pricing engine)
- DD-5.7 (walk-in patient — picker-mandatory unless guest-checkout) — MUST resolve (Walk-in tab gate)
- DD-5.8 (booking auto-flip on finalize) — MUST resolve (Booking state machine)
- Q1 (discount authorization threshold) — MUST resolve (manager-approval surface)
- Q9 (membership reference shape — Sale-level vs SaleLineItem-level) — MUST resolve (schema decision; if SaleLineItem-level, extra column added)

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**

- **Slice 1** (~1.5 days): Prisma `Sale.bookingId Int?` nullable FK + `lib/walletRedemption.js` internal helper (extracted from PRD_WALLET_TOPUP D16) + `routes/pos.js` `POST /sales` extension (bookingId + Idempotency-Key + atomicity hardening; audit vocabulary SALE_FINALIZED replaces SALE_CREATED) + 1 new endpoint `GET /api/pos/bookings/today` + api-spec tests. Ships the lineage + atomic-redeem backbone.

- **Slice 2** (~1 day): `GET /api/pos/bookings/:id/sale-draft` + `GET /api/pos/catalogue/search` + draft cleanup cron (`backend/cron/draftSaleCleanupEngine.js`) + audit `SALE_DRAFT_CREATED / _DRAFT_ABANDONED`. Ships the Booking-tab data flow.

- **Slice 3** (~0.75 day): `POST /api/pos/sales/:id/void` per DD-5.4 + audit `SALE_VOIDED` + wallet reversal integration + inventory reversal + RBAC matrix per FR-3.11. Ships the void surface.

- **Slice 4** (~1 day): `services/pdfRenderer.js::renderReceiptPDF()` (thermal + A4) + `GET /api/pos/sales/:id/receipt.pdf` endpoint + api-spec test. Ships the receipt surface.

- **Slice 5** (~3 days): Frontend `pos/NewSale.jsx` tab container + `NewSaleBookingTab` + `NewSaleWalkInTab` + `PatientPicker` + `ItemsPicker` + `PaymentSplitter` + `VoidSaleModal` + RBAC field-hiding per FR-3.11 + draft-restore via URL `?draftId=N`. Ships the operator-facing UI.

- **Slice 6** (~0.5 day): vitest for `walletRedemption.js` + `draftSaleCleanupEngine.js` + frontend test for `NewSale.jsx` tab routing + payment-splitter delta validation + CI gate-spec wiring (`coverage.yml` + `deploy.yml`).

Slices 1 + 2 + 3 + 4 must ship in order (each depends on the prior). Slice 5 + 6 can ship in parallel after slice 4 if dispatched file-disjoint.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — POS New Sale screen is wellness-vertical-first but the underlying `Sale` model is vertical-agnostic; salon + clinic + aesthetics tenants all benefit). Proposal: add a new entry **D17. POS New Sale screen — Booking / Walk-in tabs (#771)** under cluster D — sibling to D8-D16. Cross-references to D9 (Payment Gateway Config — CARD/UPI/ONLINE payment lines route through D9's payment surface; shared idempotency model per DD-5.6) + D10 (Import/Export Jobs — Phase 2 bulk-sale-CSV-export flows through async job infra) + D16 (Wallet Top-up — the `WALLET` payment-line method calls the wallet-redemption helper extracted from D16's slice 1 and reused as an internal lib).

**Cross-PRD coordination check:** Before implementation starts, confirm:

- `routes/audit.js` `/verify` endpoint accepts the SALE_* event family without code change (entity = `SALE` per FR-3.9).
- `backend/services/pdfRenderer.js` is willing to host a new `renderReceiptPDF()` helper alongside the existing prescription / consent / invoice helpers (no module-bloat objection).
- `lib/walletRedemption.js` extracted as internal helper before slice 1 ships (currently lives only in PRD_WALLET_TOPUP D16's slice 1 plan; this PRD depends on it landing as a pure-function helper, NOT an HTTP route handler).
- `cron/` directory registers `draftSaleCleanupEngine.js` in `server.js`'s cron-init block; honours `DISABLE_CRONS=1` env-flag for local-stack-only e2e specs.
- Existing `routes/pos.js:697-960` (`POST /api/pos/sales`) continues to work for any direct API integrations that don't pass `bookingId` or `Idempotency-Key` (both fields are optional).
- Existing legacy `/pos` flat-builder page (`PointOfSale.jsx`) stays available at `/pos/legacy` for 30 days post-deploy; telemetry-driven sunset decision in Phase 2.
- Existing `SALE_CREATED` audit rows (from before this PRD ships) are NOT migrated to `SALE_FINALIZED`; the `/audit/verify` engine accepts both vocabularies (entity = `SALE` either way).
- `Sale.bookingId` is purely additive nullable FK; no data migration; passes `migration_check` gate without bless markers.
- The 8th payment-line method (`PAYLATER` / `ONLINE` / `CASHBACK`) routes are already supported by the existing `POST /api/pos/sales` (vocabulary frozen at #789); no schema changes needed for those.
