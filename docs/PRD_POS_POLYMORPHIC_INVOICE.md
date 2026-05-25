# PRD — POS Polymorphic Invoice spine: `invoices` + `invoice_lines` + `payments` wellness data model

**Status:** NOT STARTED — PRD draft only; design call required (DD-5.1 polymorphic `itemId` shape + DD-5.2 rename-or-discriminate the existing generic `Invoice` + DD-5.4 GST tax model + DD-5.7 partial-refund semantics determine the schema shape + downstream reporting + migration scope materially).
**Source:** GH #775 — [Zylu-Gap][POS-006] Invoice schema is generic, not polymorphic — missing invoices + invoice_lines + payments wellness spine.
**Tier:** P3 — Wellness vertical financial spine (today's CRM ships a generic `Invoice` model at [backend/prisma/schema.prisma:842-881](../backend/prisma/schema.prisma#L842-L881) — built for the generic-CRM Deal-attached billing surface (`invoiceNum` / single-`amount` / `status` ∈ `UNPAID|PAID|OVERDUE|VOIDED` / `dueDate` / `dealId` + `contactId`); it does NOT support multi-line polymorphic line items, split-tender payments, per-location invoice numbering, or per-line tax breakdown. The wellness vertical's POS MVP works around this today via the parallel `Sale` + `SaleLineItem` models at [backend/prisma/schema.prisma:3895-3958](../backend/prisma/schema.prisma#L3895-L3958) — but the relationship between Sale and Invoice is NOT first-class today, and the existing `Payment` model at [backend/prisma/schema.prisma:2365-2384](../backend/prisma/schema.prisma#L2365-L2384) only supports a single payment per invoice via a gateway-id column (no split-tender). The wellness spine #775 demands is a separate, first-class polymorphic shape with line-types that the existing generic model cannot accommodate without breaking the generic-CRM contract). Material when a clinic rings a multi-line sale with mixed line types (service + product + membership + wallet top-up in one transaction); material when split-tender payments are routine (cash + UPI + wallet on one invoice); material when per-location invoice numbering is operator-mandatory (Indian GST audit + multi-clinic chains need each location to issue its own 1-N invoice sequence); material when the reporting layer (per-location P&L, per-staff attribution, per-service-category revenue) needs to pivot off invoice-line granularity rather than a single Sale-level total.
**Authored:** 2026-05-25 (tick #197 / Agent B, autonomous overnight cron arc — Bonus PRD #11 in this batch wave on top of the official 10 P3 + 10 prior bonus).
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190, D11) · `PRD_TAG_MASTER.md` (tick #191, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192, D13) · `PRD_CUSTOMER_SEGMENTS.md` (tick #193, D14) · `PRD_STAFF_DETAIL.md` (tick #194, D15) · `PRD_WALLET_TOPUP.md` (tick #195, D16) · `PRD_POS_NEW_SALE.md` (tick #196, D17 — UI consumer of this schema).
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D18**; see §10.
**Cred dependency:** none external — pure schema + route work. Re-uses existing `Sale` / `SaleLineItem` / `Booking` / `Patient` / `Location` / `Register` / `Membership` / `Wallet` / `pdfRenderer.js` / `audit.js` / `idempotency` infra. The single cross-PRD coupling is `PRD_POS_NEW_SALE.md` (D17) which is the UI consumer of the routes this PRD defines; D17 can ship without this PRD landing first (interim: D17 reads/writes `Sale` directly; this PRD's `Invoice` row is created lazily on first PDF-receipt request OR via a one-shot backfill cron once this PRD lands), but the wellness reporting surface assumes both ship together within Phase 1.

---

## §1 Background + source attribution

The CRM today has TWO disjoint financial-data shapes that both partially address what #775 calls the "polymorphic invoice spine":

1. **Generic `Invoice` model** at [backend/prisma/schema.prisma:842-881](../backend/prisma/schema.prisma#L842-L881) — the generic-CRM Deal-attached billing surface. Single-amount (`amount Float`), no line items, status enum `UNPAID|PAID|OVERDUE|VOIDED`, `dueDate` + `dealId` + `contactId` + (recent additions) `visitId Int?` for wellness-visit linkage + `legalEntityCode String?` for the travel vertical's multi-GST-registration shape (TMC / Travel Stall / RFU each have separate legal entities). Used by the generic-CRM Billing page at `frontend/src/pages/Billing.jsx` + `frontend/src/pages/Invoices.jsx`. Has shipped routes at `backend/routes/billing.js`. Per #413, the model carries `Restrict` (not Cascade) on Tenant deletion — invoices are financial records-of-record. Per #601, a nullable FK `visitId Int?` was added to link a generic Invoice to a wellness Visit (one-way); this is the existing wellness-vertical workaround for "rolled-up revenue per visit", BUT it does NOT decompose into line items.

2. **Wellness `Sale` + `SaleLineItem` parallel shape** at [backend/prisma/schema.prisma:3895-3958](../backend/prisma/schema.prisma#L3895-L3958) — the POS MVP storage layer. `Sale` carries `invoiceNumber String` (unique-per-tenant — NOT per-location, which is a #775 gap) + single `paymentMethod String` (or `COMBINED` magic-string + `paymentBreakdownJson @db.Text` JSON-bag for split-tender — the JSON shape is operator-typed and route-validated but the wire shape is not first-class). `SaleLineItem` has polymorphic `lineType String` ∈ `{SERVICE, PRODUCT, MEMBERSHIP, GIFTCARD, PACKAGE}` + indirect `refId Int` (no FK enforcement) + denormalised `name String`. Per-line: `quantity / unitPrice / lineDiscount / lineTotal Float` (NOT cents — see #4 below). NO per-line tax breakdown. NO per-line staff assignment (the wellness reporting layer wants `staffId` per line so the same Sale can attribute a Service line to Dr Harsh + a Product line to the receptionist). NO time-slot encoded on the line (Zylu reference ships `time_slot` per line for appointment-attached service lines).

3. **Generic `Payment` model** at [backend/prisma/schema.prisma:2365-2384](../backend/prisma/schema.prisma#L2365-L2384) — Stripe / Razorpay charge ledger. `invoiceId Int?` nullable FK + `amount Float` + `currency / gateway / gatewayId / status` enum (`PENDING|SUCCESS|FAILED|REFUNDED`). ONE Payment row per gateway-charge. Does NOT model split-tender (cash ₹500 + UPI ₹500 + wallet ₹500 on one invoice = three Payment rows of different methods — today's Payment column set assumes ONE gateway-driven charge per row).

Per GH issue #775 verbatim:

> **Title:** [Zylu-Gap][POS-006] Invoice schema is generic, not polymorphic — missing invoices + invoice_lines + payments wellness spine
>
> **Source — TIC Wellness Dev Implementation List**
> **POS / NEW SALE**:
> > Implement polymorphic invoice lines: Service, Product, Package, Membership, Wallet Top-up, Gift Card.
> > Create the invoices table (uuid PK, location_id, patient_id nullable, booking_id nullable, invoice_number unique per location, status enum draft/completed/void/refunded, subtotal, discount_total, tax_total, tip, grand_total, register_id, cashier_id, send_sms, notes, created_at, completed_at).
> > Create the invoice_lines table (line_type enum service/product/package/membership/wallet_topup/giftcard, item_id polymorphic, staff_id, duration_min, time_slot, qty, unit_price, discount, tax_rate, tax_amount, line_total, resources jsonb, notes).
> > Create the payments table with split-tender support (method enum cash/upi/card/online/wallet/paylater/giftcard/cashback/other, amount, reference, collected_by, collected_at).
>
> **Zylu reference:** Zylu's invoice supports multi-line polymorphic lines, split-tender payments, status enum, and a unique invoice number scoped per location.
>
> **Observed on crm-staging.globusdemos.com:** `/invoices` is a generic CRM invoice page with only: Invoice #, Contact, Deal (optional), Amount, Due Date, Status (Unpaid). No invoice_lines, no polymorphic types, no split-tender payments, no register_id/cashier_id, no per-location uniqueness.
>
> **Acceptance criteria**
> - [ ] `invoices` table per spec.
> - [ ] `invoice_lines` table per spec.
> - [ ] `payments` table per spec with split-tender.
> - [ ] Generic `/invoices` page replaced (or hidden) for the wellness tenant in favour of the wellness invoice surface tied to POS.

### What's missing (per GH #775)

The today shape has SIX structural gaps that the polymorphic spine needs to address atomically:

1. **No first-class polymorphic line type ENUM.** `SaleLineItem.lineType String` is route-validated against a closed vocabulary (`SERVICE | PRODUCT | MEMBERSHIP | GIFTCARD | PACKAGE`) but the column is a free-text `String`, NOT a Prisma `enum`. Adding `WALLET_TOPUP` (per #775) requires only route-vocab extension today, but the route accepts arbitrary strings if validation is bypassed (e.g. via a future route-handler that forgets the vocab check). The schema-level lock is missing.

2. **No first-class `Invoice` model that the wellness POS can write to.** Today's `Sale` is the de-facto POS receipt model, but it's NOT named `Invoice`. The wellness audit / reporting / PDF stack (`renderInvoicePDF` in `pdfRenderer.js`) reads from the generic `Invoice` model. Decoupling the two means: either (a) RENAME the existing generic `Invoice` → `DealInvoice` (clean fork — see DD-5.2) and build a fresh `Invoice` for the wellness spine that points at `Sale` (or vice versa); or (b) add a `kind ∈ {GENERIC, POS}` discriminator on the existing model and extend it with the missing columns (`locationId / patientId / bookingId / registerId / cashierId / subtotalCents / discountTotalCents / taxTotalCents / tipCents / grandTotalCents / sendSms / notes / completedAt`). Either way the generic-CRM Billing surface MUST keep working (Restrict-on-Tenant-delete invariant per #413 stays; the generic `/api/billing` routes stay; the generic `frontend/src/pages/Billing.jsx` keeps reading the same shape).

3. **No `invoice_lines` table at all in the generic surface.** The generic `Invoice` has a single `amount Float` column. There's no decomposition. The wellness `SaleLineItem` is the closest analogue but it's joined to `Sale`, not `Invoice`. The spine #775 demands is `invoice_lines.invoice_id` (line→invoice), not `sale_line_item.sale_id` (line→sale).

4. **Monetary fields are Float, not cents.** Both `Invoice.amount` and `SaleLineItem.unitPrice / lineDiscount / lineTotal` are `Float`. The `WalletTransaction` model (per PRD_WALLET_TOPUP D16) uses cents (`Int`) — the recommended monetary representation per the wallet PRD's DD-5.6. The polymorphic spine SHOULD use `Int` cents throughout to match wallet + future payment-gateway integrations + avoid the well-known Float-rounding bug class. This is a schema-level decision (DD-5.6 in this PRD).

5. **No split-tender model.** Today's `Payment` model has 1-to-1 invoice↔charge cardinality (one gateway-id per Payment row). Split-tender ("cash ₹500 + UPI ₹500 + wallet ₹500 = ₹1500 invoice paid") needs M-payments-per-invoice with a `method` enum (the wellness-vertical's 9-value vocab from `Sale.paymentMethod` + the wallet PRD's `WALLET` method + Zylu's `PAYLATER` / `CASHBACK` / `OTHER` extensions). The wellness vertical's POS MVP works around this via `Sale.paymentBreakdownJson @db.Text` — a free-text JSON column that the route serializes + deserializes — but this is NOT queryable (e.g. "total wallet redemptions this month across all sales" requires a `JSON_EXTRACT` query on the `@db.Text` column).

6. **No per-location invoice number sequence.** Today's `Sale.invoiceNumber` is `@@unique([tenantId, invoiceNumber])` (per-tenant). #775 specifies per-LOCATION uniqueness: `@@unique([locationId, invoiceNumber])`. The Indian GST audit shape + Zylu reference + multi-clinic chains (Enhanced Wellness Bangalore + Mumbai + Hyderabad — each location issues its own 1-N sequence) need this. Today's per-tenant scheme breaks down for any multi-location tenant: Bangalore invoice #42 + Mumbai invoice #42 cannot coexist; the operator must coordinate across locations to avoid duplicates.

### Today's wellness POS receipt flow (the gap)

1. Operator finalizes a Sale via `POST /api/pos/sales` (per `backend/routes/pos.js:697-960`).
2. Backend creates `Sale` + N `SaleLineItem` rows + writes audit `SALE_CREATED` (or `SALE_FINALIZED` per PRD_POS_NEW_SALE D17's vocabulary update).
3. UI shows just the `invoiceNumber` (a per-tenant-unique string). No PDF receipt.
4. Wellness reporting (`/api/wellness/reports/pnl-by-service` + `/per-professional` + `/per-location`) reads from `Sale` + `SaleLineItem` directly. No `Invoice` row exists; no per-line tax breakdown.
5. Generic `/invoices` page shows ZERO of the POS sales (filter is `dealId` or `contactId` driven; POS sales have neither).

### Zylu reference pattern (prior art per #775)

Zylu's polymorphic invoice spine ships THREE tables (today's `Sale` + `SaleLineItem` + `Payment` are the closest analogues but the column-set differs materially):

- **`invoices`:** UUID PK (today's `Sale.id` is Int autoincrement — see DD-5.8); `location_id` NOT NULL (today's Sale carries it indirectly via `register.locationId`); `patient_id` NULLABLE (Guest-Checkout); `booking_id` NULLABLE (per PRD_POS_NEW_SALE D17's `Sale.bookingId Int?` addition); `invoice_number` unique per LOCATION; `status` ∈ `DRAFT | COMPLETED | VOID | REFUNDED`; cents fields: `subtotal / discount_total / tax_total / tip / grand_total`; `register_id` + `cashier_id`; `send_sms Boolean` (whether to text the receipt); `notes Text`; `created_at` + `completed_at` (NULL until status flips to COMPLETED).
- **`invoice_lines`:** `line_type` enum ∈ `service | product | package | membership | wallet_topup | giftcard` (six values — note `wallet_topup` is a NEW line type beyond today's `SaleLineItem` 5-value vocab; covers the case where the customer's invoice includes "₹500 to wallet" as a line); `item_id` polymorphic Int (FK enforced at route layer, not schema — see DD-5.1); `staff_id` FK to User (who performed the service / who sold the product); `duration_min Int?` (for service lines — how long the appointment took); `time_slot DateTime?` (when the service was rendered); `qty Int`; cents fields: `unit_price / discount / tax_amount / line_total`; `tax_rate Float` (per-line, not invoice-level — Indian GST varies per item); `resources Json?` (e.g. for service lines: `[{room: 'Room 1', equipment: 'Laser'}]`); `notes Text?`.
- **`payments`:** `invoice_id` FK; `method` enum ∈ `cash | upi | card | online | wallet | paylater | giftcard | cashback | other` (nine values — matches today's `Sale.paymentMethod` vocab plus `other`); `amount` cents; `reference String?` (gateway txn id / cheque number / receipt code); `collected_by` FK to User; `collected_at DateTime`.

### Source attribution

- GH issue #775 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/775](https://github.com/Globussoft-Technologies/globussoft-crm/issues/775)
- `backend/prisma/schema.prisma:842-881` — existing generic `Invoice` model (Deal-attached billing; preserved as `DealInvoice` per DD-5.2)
- `backend/prisma/schema.prisma:2365-2384` — existing generic `Payment` model (gateway-charge ledger; preserved alongside new wellness `InvoicePayment` per DD-5.5)
- `backend/prisma/schema.prisma:3895-3935` — existing `Sale` model (POS receipt; preserved; new `Invoice` carries `saleId Int?` FK pointing back per DD-5.3)
- `backend/prisma/schema.prisma:3937-3958` — existing `SaleLineItem` polymorphic line model (preserved; new `InvoiceLine` carries `saleLineItemId Int?` FK pointing back per DD-5.3)
- `backend/prisma/schema.prisma:2238-2263` — existing `Booking` model (per PRD_POS_NEW_SALE D17's `Sale.bookingId Int?` addition; new `Invoice.bookingId Int?` mirrors it)
- `backend/prisma/schema.prisma:3052-...` — existing `Location` model (per-location invoice numbering scope)
- `backend/prisma/schema.prisma:3817-3866` — existing `Register` + `Shift` models
- `backend/prisma/schema.prisma:3300-...` — existing `Membership` model (one of the 6 line types)
- `backend/services/pdfRenderer.js::renderInvoicePDF()` — existing generic-invoice PDF renderer (extends with `renderWellnessInvoicePDF()` per FR-3.7)
- `backend/routes/billing.js` — existing generic `/api/billing` routes (preserved against `DealInvoice` per DD-5.2)
- `backend/lib/audit.js` `writeAudit()` — existing tamper-evident chain; new `INVOICE_*` + `PAYMENT_*` event family flows through unchanged
- `backend/lib/idempotency.js` — existing idempotency key replay-cache infrastructure (re-used per FR-3.6)
- `PRD_POS_NEW_SALE.md` (D17) — UI consumer of the routes this PRD defines; both PRDs are dependent + ship in coordination
- `PRD_WALLET_TOPUP.md` (D16) — `WALLET_TOPUP` line type is the schema reflection of D16's customer-portal top-up flow

### Why this isn't a "small schema patch" — it's a financial-spine refactor + migration + downstream-reporting sweep

The today shape has THREE structural gaps that the polymorphic spine needs to address atomically:

1. **The wellness reporting layer reads from `Sale` + `SaleLineItem` directly.** Migrating that to `Invoice` + `InvoiceLine` is a code sweep across `backend/routes/wellness.js` (~50 LOC of revenue rollup queries) + `backend/routes/reports.js` + 4 frontend report pages. Done badly, this breaks the existing per-location P&L / per-professional / per-location reports. Done well, the new `InvoiceLine.staffId` + `InvoiceLine.taxAmountCents` columns ENABLE better reports (per-staff revenue + GST audit-trail).

2. **The generic-CRM Billing page reads from `Invoice` directly.** If we add columns or change vocab on the existing `Invoice` model, the generic-CRM Billing page breaks. DD-5.2 (rename `Invoice` → `DealInvoice` clean-fork vs add `kind` discriminator) is the load-bearing decision. The PRD recommends the clean fork (rename) — the generic-CRM Invoice surface is small (Billing.jsx + Invoices.jsx + ~6 routes); the rename can ship in 1 commit with backward-compat aliasing for ~30 days post-deploy.

3. **The audit-hash-chain is append-only.** Adding new event vocab (`INVOICE_DRAFTED / INVOICE_COMPLETED / INVOICE_VOIDED / INVOICE_REFUNDED / PAYMENT_RECORDED / PAYMENT_REFUNDED`) is purely additive — the `/api/audit/verify` engine accepts any new entity vocabulary without code change. BUT the existing `SALE_CREATED / SALE_FINALIZED` events stay on the chain (don't rewrite history); the new `INVOICE_*` events are emitted ALONGSIDE the existing SALE_* events during a transitional window so downstream tooling can adapt. Phase 2 sunsets the `SALE_*` events.

This PRD's slice 1 ships the schema + the routes; slice 2 ships the PDF renderer; slice 3 ships the per-location number sequence engine; slice 4 ships the migration of existing wellness Sale data into Invoice + InvoiceLine; slice 5 ships the wellness frontend Invoice page; slice 6 ships the generic-CRM Invoice rename + back-compat aliasing.

---

## §2 Use cases

1. **Multi-line wellness sale: 1× haircut service + 1× shampoo product + 1× membership purchase + ₹500 wallet top-up = single Invoice with 4 InvoiceLine rows of different `lineType`.** Operator at Enhanced Wellness Bangalore (location_id=1) rings a walk-in. Patient gets a haircut (₹350 SERVICE line, staffId=Dr Harsh, durationMin=30, timeSlot=2026-05-25T10:30Z), buys a shampoo (₹220 PRODUCT line, staffId=receptionist), buys a Gold membership (₹2500 MEMBERSHIP line), tops up wallet (₹500 WALLET_TOPUP line). Backend creates 1 `Invoice` row (status=COMPLETED, subtotalCents=357000 + 21000 + 250000 + 50000 = 678000) + 4 `InvoiceLine` rows + 1 `Payment` row (method=CARD, amountCents=678000, reference="gw_xyz123"). The WALLET_TOPUP line creates a `WalletTransaction` (per PRD_WALLET_TOPUP D16) via the same Prisma transaction. Per-location invoiceNumber = "BAN-2026-00042" (sequence is per `locationId`, formatted via DD-5.4 token template).

2. **Split-tender payment: ₹1500 invoice paid ₹500 cash + ₹500 UPI + ₹500 wallet = 3 Payment rows.** Customer pays ₹500 cash (method=CASH, reference=NULL), ₹500 UPI (method=UPI, reference="upi:9999988888"), ₹500 wallet (method=WALLET, reference="wt:88" — the `WalletTransaction.id`). Backend writes 3 `Payment` rows under one `Invoice.id`. `Invoice.grandTotalCents=150000` matches sum of `Payment.amountCents` = 50000 + 50000 + 50000 = 150000 (server-side validates sum-equals-grand-total + returns 400 on mismatch). Audit `PAYMENT_RECORDED` emitted 3 times (one per Payment row).

3. **Per-location invoice numbering: tenant has 3 locations, each gets sequential invoice_number 1...N independently.** Enhanced Wellness Bangalore (locationId=1) rings invoice #1, #2, #3. Mumbai (locationId=2) rings #1 (separately — same number string is fine because the unique constraint is `[locationId, invoiceNumber]`). Hyderabad (locationId=3) rings #1, #2. The unique index allows three rows with `invoiceNumber="1"` so long as their `locationId` differs. Format template (DD-5.4): `<LOCATION_CODE>-<YYYY>-<5-DIGIT-PADDED-SEQ>` = "BAN-2026-00001" / "MUM-2026-00001" / "HYD-2026-00001". Operator can re-seed via admin endpoint (e.g. when migrating from external POS at year-start) — see Q2.

4. **Void / refund: status enum DRAFT → COMPLETED → VOID / REFUNDED.** Operator rings a sale (status=DRAFT), payment collected (status flips to COMPLETED, completedAt populated). Customer disputes 30 min later — operator voids (status=VOID; audit `INVOICE_VOIDED` + reverse `InventoryAdjustment` if PRODUCT lines existed + reverse `WalletTransaction` if WALLET_TOPUP line existed + reverse `Payment` rows via `Payment.refundedAt` timestamp + `Payment.refundReason` text). For refunds (status=REFUNDED), a refund-`Payment` row is added (amountCents=-X, method=CASH) so the sum-of-payments still equals grandTotal (i.e. net=0 after refund). Per DD-5.7, partial refunds are supported in v1 via creating a refund-`Payment` of partial amount (the Invoice status stays COMPLETED if any net payment remains; flips to REFUNDED only when net=0).

5. **Membership benefit applied: invoice subtotal reduced by membership-savings; lineTotal reflects discounted amount.** Patient has active Gold membership (20% off all services per `Membership.benefitJson`). Operator adds a Facial SERVICE line at ₹2500 unitPrice. Backend auto-applies the membership: `InvoiceLine.discountCents=50000` (₹500), `InvoiceLine.lineTotalCents=200000` (₹2000), `InvoiceLine.appliedMembershipId=N` (FK to the patient's Membership row). The Invoice's `discountTotalCents` is the sum of all line-level discounts (`50000` here, +/- any invoice-level operator-applied discount per DD-5.6). The audit captures `INVOICE_COMPLETED { appliedMembershipId, discountFromMembershipCents: 50000, lineId: <line>, ... }`.

---

## §3 Functional requirements

### FR-3.1 NEW Prisma model `Invoice` (wellness spine — distinct from generic `DealInvoice`)

Per DD-5.2 path (a) — clean fork — the existing generic `Invoice` is renamed to `DealInvoice` (see FR-3.10) and a NEW `Invoice` model is created with the wellness-spine column set:

```prisma
model Invoice {
  id                    Int       @id @default(autoincrement())     // DD-5.8 — Int autoincrement (NOT uuid, see §5)
  tenantId              Int       @default(1)
  tenant                Tenant    @relation(fields: [tenantId], references: [id], onDelete: Restrict)  // financial record — Restrict per #413
  locationId            Int                                          // NOT NULL — per-location number scope
  location              Location  @relation(fields: [locationId], references: [id], onDelete: Restrict)
  patientId             Int?                                         // Guest-Checkout supported via NULL
  patient               Patient?  @relation(fields: [patientId], references: [id], onDelete: SetNull)
  bookingId             Int?                                         // pre-booked sales link to the Booking
  booking               Booking?  @relation(fields: [bookingId], references: [id], onDelete: SetNull)
  saleId                Int?      @unique                            // FK back to Sale (1-to-1 during transitional window per DD-5.3)
  sale                  Sale?     @relation(fields: [saleId], references: [id], onDelete: SetNull)
  registerId            Int
  register              Register  @relation(fields: [registerId], references: [id], onDelete: Restrict)
  cashierId             Int                                          // recorded but not relationally bound — preserves audit trail
  invoiceNumber         String                                       // per-location-unique; format token per DD-5.4
  status                String    @default("DRAFT")                  // DRAFT | COMPLETED | VOID | REFUNDED
  subtotalCents         Int       @default(0)
  discountTotalCents    Int       @default(0)
  taxTotalCents         Int       @default(0)
  cgstTotalCents        Int?                                         // Indian GST split — see DD-5.4 (tax model)
  sgstTotalCents        Int?                                         // null for non-India tenants
  igstTotalCents        Int?                                         // for inter-state; mutually exclusive with cgst/sgst
  tipCents              Int       @default(0)
  grandTotalCents       Int       @default(0)                        // = subtotal - discountTotal + taxTotal + tip; server-recomputed on save
  sendSms               Boolean   @default(false)                    // operator toggle: text the receipt
  notes                 String?   @db.Text
  legalEntityCode       String?                                      // mirrors DealInvoice.legalEntityCode for travel-vertical reuse
  appliedMembershipId   Int?                                         // patient's membership at sale time (Q9 — Sale-level vs per-line)
  appliedMembership     Membership? @relation(fields: [appliedMembershipId], references: [id], onDelete: SetNull)
  idempotencyKey        String?                                      // anti-replay per FR-3.6
  createdAt             DateTime  @default(now())
  completedAt           DateTime?                                    // populated when status flips DRAFT → COMPLETED
  voidedAt              DateTime?
  voidReason            String?   @db.Text

  lines                 InvoiceLine[]
  payments              InvoicePayment[]

  @@unique([locationId, invoiceNumber])                              // per-location uniqueness per #775
  @@unique([tenantId, idempotencyKey])
  @@index([tenantId, status])
  @@index([tenantId, locationId, createdAt])
  @@index([tenantId, patientId])
  @@index([tenantId, bookingId])
  @@index([tenantId, registerId])
}
```

**Auth:** all routes require `verifyToken` + tenant-scope; mutations require `cashierGate` (USER + cashier sub-role OR MANAGER/ADMIN).

### FR-3.2 NEW Prisma model `InvoiceLine` (polymorphic line items)

```prisma
model InvoiceLine {
  id                    Int       @id @default(autoincrement())
  tenantId              Int       @default(1)
  tenant                Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  invoiceId             Int
  invoice               Invoice   @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  saleLineItemId        Int?      @unique                            // FK back to SaleLineItem during transitional window
  saleLineItem          SaleLineItem? @relation(fields: [saleLineItemId], references: [id], onDelete: SetNull)
  lineType              String                                       // SERVICE | PRODUCT | PACKAGE | MEMBERSHIP | WALLET_TOPUP | GIFTCARD — vocab locked at route layer (Phase 2 promotes to Prisma enum)
  itemId                Int                                          // polymorphic — interpreted per lineType (Service.id / Product.id / etc.); FK enforced at route layer per DD-5.1
  name                  String                                       // denormalised display name frozen at sale time
  staffId               Int?                                         // who performed the service / who sold the product
  durationMin           Int?                                         // for SERVICE lines — appointment duration
  timeSlot              DateTime?                                    // when the service was rendered (e.g. 2026-05-25T10:30Z)
  qty                   Int       @default(1)
  unitPriceCents        Int       @default(0)
  discountCents         Int       @default(0)                        // per-line operator-applied discount
  taxRatePercent        Float     @default(0)                        // e.g. 18 for 18% GST
  taxAmountCents        Int       @default(0)                        // = round((qty * unitPrice - discount) * taxRate / 100)
  cgstAmountCents       Int?                                         // Indian GST split per DD-5.4
  sgstAmountCents       Int?
  igstAmountCents       Int?
  lineTotalCents        Int       @default(0)                        // = qty * unitPrice - discount + taxAmount
  appliedMembershipId   Int?                                         // per-line override if Q9 path = per-line
  resourcesJson         String?   @db.Text                           // e.g. [{room: 'Room 1', equipment: 'Laser'}]
  notes                 String?   @db.Text
  createdAt             DateTime  @default(now())

  @@index([tenantId, invoiceId])
  @@index([tenantId, lineType, itemId])
  @@index([tenantId, staffId])
}
```

### FR-3.3 NEW Prisma model `InvoicePayment` (split-tender support — distinct from generic gateway-`Payment`)

Per DD-5.5 — the existing generic `Payment` model is RETAINED for Stripe / Razorpay gateway integrations on `DealInvoice`. A NEW `InvoicePayment` model is added for the wellness POS split-tender shape:

```prisma
model InvoicePayment {
  id                    Int       @id @default(autoincrement())
  tenantId              Int       @default(1)
  tenant                Tenant    @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  invoiceId             Int
  invoice               Invoice   @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  method                String                                       // CASH | UPI | CARD | ONLINE | WALLET | PAYLATER | GIFTCARD | CASHBACK | OTHER (DD-5.6 — closed enum)
  amountCents           Int                                          // can be negative for refund rows
  reference             String?                                      // gateway txn id / cheque number / UPI ref / wallet txn id
  collectedById         Int                                          // FK to User who collected
  collectedAt           DateTime  @default(now())
  refundedAt            DateTime?                                    // populated when this Payment is refunded
  refundReason          String?   @db.Text
  walletTransactionId   Int?                                         // if method=WALLET, points at WalletTransaction; else NULL
  gatewayPaymentId      Int?                                         // if method ∈ {CARD,ONLINE,UPI}, points at generic Payment for gateway-charge audit
  gatewayPayment        Payment?  @relation(fields: [gatewayPaymentId], references: [id], onDelete: SetNull)

  @@index([tenantId, invoiceId])
  @@index([tenantId, method])
  @@index([tenantId, collectedById, collectedAt])
}
```

`walletTransactionId` ties to `WalletTransaction.id` (per PRD_WALLET_TOPUP D16) without a Prisma `@relation` to avoid the bidirectional-FK schema bloat (resolved at route-layer); `gatewayPaymentId` ties to the existing `Payment` model (which still handles Stripe / Razorpay charge audit trail).

### FR-3.4 invoiceNumber sequence: per-location atomic increment

Per DD-5.4 — the format template is configurable per location via a new `Location.invoiceNumberTemplate String?` column (default `<LOC_CODE>-<YYYY>-<5DIGIT>`); the sequence counter is per-location-per-year and maintained via a Prisma transaction's `max(invoiceNumber where locationId=X and year=Y) + 1` lookup inside the same atomic transaction that creates the Invoice. Two concurrent inserts trip the `@@unique([locationId, invoiceNumber])` constraint; one succeeds, one retries (max 5 retries per FR-3.6 atomicity).

Alternative: a dedicated `InvoiceNumberSequence { locationId, year, lastSeq Int }` model (DD-5.4 path b) — explicit sequence row per (location, year), atomically incremented via Prisma `update`. More performant under load but adds one model + one migration. Recommend path (a) for v1 (single Prisma transaction + retry loop); promote to path (b) if write throughput exceeds ~10 invoices/sec/location.

### FR-3.5 Transaction atomicity: Invoice + N lines + M payments + side-effects all in ONE Prisma transaction

The finalize flow MUST be atomic:

```
prisma.$transaction(async (tx) => {
  // 1. Insert Invoice row (with retry on invoiceNumber collision)
  const invoice = await tx.invoice.create({...});
  // 2. Insert N InvoiceLine rows
  await tx.invoiceLine.createMany({ data: lines });
  // 3. For each PRODUCT line, decrement inventory atomically
  for (const line of productLines) {
    await tx.inventoryAdjustment.create({...});
  }
  // 4. For each WALLET_TOPUP line, create WalletTransaction (per PRD_WALLET_TOPUP DD-5.3 batch walker)
  for (const line of walletTopupLines) {
    await tx.walletTransaction.create({...});
  }
  // 5. Insert M InvoicePayment rows
  await tx.invoicePayment.createMany({ data: payments });
  // 6. For any WALLET payment line, debit the patient's wallet inside the same tx (calls lib/walletRedemption.js::redeemInternal())
  for (const wp of walletPayments) {
    await redeemInternal(tx, { patientId, amountCents, ... });
  }
  // 7. Flip Booking status to COMPLETED if bookingId present (DD-5.8 from PRD_POS_NEW_SALE D17)
  if (bookingId) await tx.booking.update({ where: {id: bookingId}, data: {status: 'COMPLETED'}});
  // 8. Validate sum-of-payments equals grandTotal — throw if not
  const sum = payments.reduce((a, p) => a + p.amountCents, 0);
  if (sum !== invoice.grandTotalCents) throw new Error('PAYMENT_SUM_MISMATCH');
  return invoice;
});
// 9. AFTER tx commits — emit audit INVOICE_COMPLETED + PAYMENT_RECORDED × M (outside tx for hash-chain reasons per existing pattern)
```

If any step throws, the entire tx rolls back; no orphaned Invoice / partial wallet debit / inventory adjustment.

### FR-3.6 Backend routes

New routes under `/api/wellness-invoices` (avoids collision with existing `/api/billing` + `/api/invoices` generic surfaces):

- `GET /api/wellness-invoices` — list (filters: locationId, patientId, status, dateRange, bookingId; pagination)
- `GET /api/wellness-invoices/:id` — detail with lines + payments embedded
- `POST /api/wellness-invoices` — create DRAFT (operator can save without finalizing; cross-references PRD_POS_NEW_SALE D17 draft flow)
- `PUT /api/wellness-invoices/:id` — update DRAFT only (rejected if status != DRAFT)
- `POST /api/wellness-invoices/:id/finalize` — flip DRAFT → COMPLETED + validate payment sum + emit audit
- `POST /api/wellness-invoices/:id/void` — flip COMPLETED → VOID + reverse inventory + reverse wallet + emit audit (RBAC per DD-5.7)
- `POST /api/wellness-invoices/:id/refund` — partial-or-full refund + emit refund-Payment row + emit audit
- `GET /api/wellness-invoices/:id/pdf` — `?format=THERMAL|A4` (default A4) via `pdfRenderer.renderWellnessInvoicePDF()`
- `POST /api/wellness-invoices/:id/email` — email the PDF to `Patient.email` (re-uses `lib/notificationService.js`)
- `POST /api/wellness-invoices/:id/sms` — SMS the receipt link (re-uses `lib/sms.js` / `Tenant.smsConfig`)

**Idempotency:** all POST endpoints accept `Idempotency-Key` header per `lib/idempotency.js`; replay returns the original response (with 200 instead of 201; same body shape).

### FR-3.7 PDF receipt rendering: `pdfRenderer.renderWellnessInvoicePDF({ format: 'THERMAL' | 'A4' })`

Extends `backend/services/pdfRenderer.js` with `renderWellnessInvoicePDF(invoice, { format })`. THERMAL = 80mm-wide receipt-roll layout (small fonts, single column, no logo); A4 = standard letterhead layout (tenant logo from `Tenant.logoUrl`, line table, GST breakdown, signature block). Both formats render the same data: invoiceNumber + locationName + patientName + N line rows (name + qty + unitPrice + discount + tax + lineTotal) + subtotal + discountTotal + taxTotal (with CGST/SGST/IGST breakdown if populated per DD-5.4) + tip + grandTotal + payment-method breakdown + audit footer ("Verified by gbs-crm v3.X.Y").

### FR-3.8 Audit log: `INVOICE_*` + `PAYMENT_*` events

New event vocab (additive — `/api/audit/verify` engine accepts without code change; entity = `INVOICE` or `PAYMENT`):

- `INVOICE_DRAFTED` — emitted on POST /wellness-invoices (DRAFT created)
- `INVOICE_COMPLETED` — emitted on POST /finalize (DRAFT → COMPLETED)
- `INVOICE_VOIDED` — emitted on POST /void (COMPLETED → VOID)
- `INVOICE_REFUNDED` — emitted on POST /refund (refund-Payment row added; status MAY flip to REFUNDED if fully refunded)
- `INVOICE_LINE_ADDED` / `INVOICE_LINE_REMOVED` — for DRAFT-state edits
- `PAYMENT_RECORDED` — emitted per InvoicePayment row on finalize
- `PAYMENT_REFUNDED` — emitted per Payment row when `refundedAt` populated
- `INVOICE_PDF_DOWNLOADED` — emitted on GET /pdf for compliance audit (PHI exposure tracking)
- `INVOICE_EMAILED` / `INVOICE_SMSED` — emitted on POST /email or /sms

Existing `SALE_CREATED / SALE_FINALIZED` events stay on the chain during the transitional window; Phase 2 (after slice 4 backfill completes) sunsets the SALE_* vocab in favour of INVOICE_*.

### FR-3.9 RBAC matrix

- **USER + cashier sub-role:** can DRAFT, FINALIZE, list-own-shift, view PDF; CANNOT void or refund.
- **MANAGER:** can void / refund within an N-hour window (configurable per `Tenant.invoiceVoidWindowHours Int? @default(24)`).
- **ADMIN:** can void / refund any time; can re-seed location invoice-number sequence; can rename location codes.
- **USER + non-cashier (e.g. doctor):** can view PDF for invoices they're attributed to via `InvoiceLine.staffId`; CANNOT see other staff's invoices.

Per DD-5.7 — void / refund actor matrix is the highest-leverage RBAC decision; mirrors PRD_POS_NEW_SALE DD-5.4 (ADMIN-only by default; MANAGER-with-window optional via tenant config; cashier-direct path explicitly rejected as too risky for financial records-of-record).

### FR-3.10 Migration of existing generic Invoice + back-compat

Per DD-5.2 path (a) clean fork:

1. Schema migration: rename `Invoice` → `DealInvoice` via Prisma `@@map("DealInvoice")` table directive (one commit, additive; `migration_check` gate passes with `[allow-rename]` bless marker).
2. Code sweep: `backend/routes/billing.js` + `backend/routes/billing.js` + `frontend/src/pages/Billing.jsx` + `frontend/src/pages/Invoices.jsx` reference `prisma.dealInvoice` instead of `prisma.invoice`.
3. Back-compat: `prisma.invoice` continues to resolve to `prisma.dealInvoice` for 30 days post-deploy via a thin adapter at `backend/lib/dealInvoiceAdapter.js` (deprecation warning logged on each call). Phase 2 removes the adapter.
4. The new `Invoice` model (this PRD) is bolted onto `prisma.invoice` — fresh start. Wellness POS routes write to it directly.

Alternative DD-5.2 path (b) discriminator — keep `Invoice` name, add `kind ∈ {GENERIC, POS}`; extend with the missing columns as nullable; preserve existing generic-CRM Billing flow unchanged. Avoids the rename + sweep but introduces a less-clean schema (every wellness query carries an implicit `where: { kind: 'POS' }` filter; risk of forgotten filter → cross-mode bleed).

Recommend path (a). The generic-CRM Invoice surface is small; the rename is a one-day code sweep + 30-day back-compat alias.

### FR-3.11 Backfill of existing wellness Sale data into Invoice + InvoiceLine

Slice 4 (~1 day): one-shot backfill script `backend/scripts/backfill-wellness-invoices.js`:

```
for each Sale where tenantId IN (wellness tenants):
  create Invoice row (copy paymentBreakdownJson into InvoicePayment rows; copy lineItems into InvoiceLine rows; set saleId FK back to original Sale; status = Sale.status mapped; createdAt = Sale.createdAt)
emit audit BACKFILL_INVOICES_COMPLETED { tenantId, invoicesCreated, paymentsCreated }
```

Idempotent (re-running re-creates only missing rows; `@@unique` on `saleId` prevents double-insert). Operator-triggered via admin route `POST /api/wellness-invoices/backfill` (ADMIN-only) — see `adding-admin-trigger-endpoint` skill pattern.

---

## §4 Non-functional

- **Per-tenant + per-location scoping:** every query carries `tenantId` filter (enforced by global guard + per-route `tenantWhere()` helper); per-location queries add `locationId` filter; the unique constraint `@@unique([locationId, invoiceNumber])` enforces per-location uniqueness at the database level (not just route-layer validation).
- **All monetary fields are CENTS (Int) not Decimal/Float** — consistent with `WalletTransaction` pattern per PRD_WALLET_TOPUP D16's DD-5.6. Avoids Float-rounding bugs across the GST + discount + wallet-redemption + payment-splitter computations. Frontend formats via `formatMoney(cents / 100, currency, locale)`.
- **Audit immutability via existing audit-hash-chain** — `lib/audit.js`'s `writeAudit()` appends to the chain; `/api/audit/verify` traverses the chain; the new `INVOICE_*` + `PAYMENT_*` events flow through unchanged.
- **PDF rendering via existing pdfRenderer.js** — extends with `renderWellnessInvoicePDF()`. Both formats (THERMAL + A4) render in <1s per invoice on the demo box's hardware budget (PDFKit is fast; no remote rendering).
- **Idempotency on POST /wellness-invoices/* via `Idempotency-Key` header** — re-uses `lib/idempotency.js` cache + replay mechanism. Cache TTL = 24h (matches `lib/idempotency.js` default).
- **Idempotency on the backfill script** — re-runnable; `@@unique` on `saleId` + `idempotencyKey` prevent duplicate Invoice creation.
- **Per-tenant scoping on the backfill script** — operator must specify `tenantId` query param (or `--tenant N` CLI arg); script refuses to run cross-tenant.
- **PHI exposure on PDF** — every `GET /pdf` writes `INVOICE_PDF_DOWNLOADED` audit row with `userId + invoiceId + timestamp` for compliance.
- **Send-SMS toggle on Invoice** — `Invoice.sendSms Boolean @default(false)` controls whether the post-finalize step queues an SMS via `lib/sms.js`; respects per-patient `Patient.smsOptIn` (no SMS sent if patient opted out, regardless of operator toggle).

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (DD)

- **DD-5.1: polymorphic `itemId` shape.** Two paths:
  - **(a) Pure `Int itemId` + `lineType` string** (current proposal). Single Int column; FK enforced at route layer via per-`lineType` validation (`SERVICE → Service.findUnique({id})`, etc.). Pros: clean schema; no nullable-FK bloat; matches today's `SaleLineItem.refId` pattern. Cons: no DB-level FK; orphaned line possible if Service is deleted underneath (mitigated via `Restrict` on Service.delete + a "drop dependent invoice lines first" admin flow).
  - **(b) First-class FK per lineType.** `serviceId Int? @relation` + `productId Int? @relation` + `packageId Int? @relation` + `membershipId Int? @relation` + `walletTopupId Int? @relation` + `giftCardId Int? @relation` (6 nullable FKs). DB-level enforced; one-of-six must be non-null per route validation. Pros: orphan-proof; queryable. Cons: bloats InvoiceLine to 6 nullable FK columns; requires Prisma migration to add each new line type.
  - **Recommend (a)** for v1. Promote to (b) only if orphan-prevention becomes a real-world incident (today's `SaleLineItem.refId` has not produced any incidents in 6mo of POS MVP usage).

- **DD-5.2: existing generic `Invoice` migration shape.** Two paths:
  - **(a) Rename `Invoice` → `DealInvoice` (clean fork)** — the new `Invoice` model is fresh for the wellness spine; generic-CRM Billing surface keeps working via thin adapter at `backend/lib/dealInvoiceAdapter.js` for 30d back-compat. One code sweep across `routes/billing.js` + 2 frontend pages.
  - **(b) Keep `Invoice` name, add `kind ∈ {GENERIC, POS}` discriminator** — extend existing model with all new columns as nullable; both surfaces share one table. Avoids rename + sweep; introduces implicit-filter risk (every wellness query must `where: { kind: 'POS' }` or risk cross-mode bleed).
  - **Recommend (a)** for v1 — clean schema; generic-CRM surface is small; 30d back-compat is operator-friendly. Travel-vertical's existing `Invoice.legalEntityCode` field migrates as-is (it's now on `DealInvoice` AND mirrored on the new wellness `Invoice` per FR-3.1).

- **DD-5.3: relationship between `Invoice` and existing `Sale`.** Two paths:
  - **(a) 1-to-1 via `Invoice.saleId Int? @unique` FK** (current proposal). During transitional window, every POS sale gets BOTH a Sale row (legacy) AND an Invoice row (new). Phase 2 sunsets Sale.
  - **(b) Replace Sale entirely.** Backfill, drop Sale, all POS routes now write to Invoice only.
  - **Recommend (a)** for v1 — preserves Sale for the legacy `/api/pos/sales/*` routes; allows gradual migration of downstream consumers (the wellness reporting layer, the cron engines, etc.); minimal risk of breaking the live demo box. Phase 2 (post-3-month stability window) can sunset Sale.

- **DD-5.4: tax model.** Two paths:
  - **(a) Indian GST CGST+SGST/IGST split** (current proposal). InvoiceLine carries `cgstAmountCents / sgstAmountCents / igstAmountCents Int?` (nullable for non-India tenants). For intra-state sales (location.state == customer.state), split is CGST + SGST (each = half of total tax); for inter-state, full IGST. Tenant default tax rate stored on `Tenant.gstRate Float?`.
  - **(b) Simple total-tax only.** Just `taxAmountCents Int` per line; no split. Operator computes CGST/SGST split downstream if needed.
  - **Recommend (a)** for v1 — the India-default wellness tenants (Enhanced Wellness etc.) demand GST audit-trail at the line level; the column-bloat is bounded (3 nullable Int columns); non-India tenants set all three to NULL. The PDF receipt then renders the split if populated.

- **DD-5.5: relationship between `InvoicePayment` and existing generic `Payment`.** Two paths:
  - **(a) Separate `InvoicePayment` model** (current proposal). Wellness split-tender lives on `InvoicePayment`; generic Stripe / Razorpay charges live on `Payment` (unchanged). For CARD / UPI / ONLINE methods on wellness invoices, `InvoicePayment.gatewayPaymentId` FKs to the underlying `Payment` row (which holds the gateway txn id).
  - **(b) Extend existing `Payment` with wellness fields.** Add `method` enum + `walletTransactionId` + `collectedById` etc. to existing Payment; both surfaces share.
  - **Recommend (a)** for v1 — the generic `Payment` shape is gateway-specific (gateway / gatewayId columns are required for Stripe / Razorpay audit); the wellness `InvoicePayment` shape is method-driven (no gateway required for cash / wallet). Distinct semantics warrant distinct models.

- **DD-5.6: payment-method extensibility.** Two paths:
  - **(a) Closed enum** — `CASH | UPI | CARD | ONLINE | WALLET | PAYLATER | GIFTCARD | CASHBACK | OTHER` (9 values, matches today's `Sale.paymentMethod` vocab plus `OTHER` per #775); future methods require a schema migration to extend.
  - **(b) Free-text string** — operator can type any method; route validates against a tenant-configurable allow-list.
  - **Recommend (a)** for v1 — closed enum with `OTHER` catch-all gives 90% coverage; adding a new method (e.g. `CRYPTO`) is one-line schema change + bless marker. Free-text invites typo-driven data quality issues.

- **DD-5.7: void / refund actor matrix + partial-refund semantics.** Two paths:
  - **(a) ADMIN-only void + MANAGER-with-window refund + partial-refund-supported-in-v1** (current proposal). ADMIN can void any time; MANAGER can refund within `Tenant.invoiceVoidWindowHours Int? @default(24)`; cashier cannot. Partial refunds: add a negative-amount InvoicePayment row; Invoice status stays COMPLETED until net=0 then flips to REFUNDED.
  - **(b) Cashier-can-void-within-N-minutes + ADMIN-only refund + full-only-in-v1.**
  - **(c) Per-tenant configurable.** All paths available; tenant picks.
  - **Recommend (a)** for v1 — strictest audit shape; lowest operator-fraud surface; financial-records-of-record (per #413) warrant the higher bar. Partial-refunds-in-v1 is a customer-friendliness win (partial dissatisfaction with one of 4 lines doesn't require full invoice void).

- **DD-5.8: PK shape — Int autoincrement vs UUID.** Two paths:
  - **(a) Int autoincrement** (current proposal). Matches all existing models in `backend/prisma/schema.prisma`; standard.
  - **(b) UUID** — per #775's literal spec ("uuid PK"). Pros: globally unique; safer for cross-tenant identifier surfacing. Cons: breaks pattern; bloats indexes; mismatches sibling models.
  - **Recommend (a)** for v1 — the CRM's entire schema uses Int autoincrement; introducing UUID for one model creates a heterogeneous PK shape across the codebase. The #775 literal spec is Zylu's preference (Postgres-flavoured); the CRM's MySQL + Prisma pattern is Int. The `idempotencyKey` field provides cross-tenant uniqueness via UUID where needed.

### Cred chase

None for v1 — pure schema + route work. No third-party credentials required.

### Vendor docs

- Prisma `@@unique` composite-index docs — [https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#unique-1](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference#unique-1)
- Prisma `$transaction` interactive API — [https://www.prisma.io/docs/orm/prisma-client/queries/transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)
- PDFKit table rendering — [https://pdfkit.org/](https://pdfkit.org/) (already in use via `backend/services/pdfRenderer.js`)
- GST schema reference — Government of India E-invoice schema [https://einvoice1.gst.gov.in/Documents/EINV_schema.pdf](https://einvoice1.gst.gov.in/Documents/EINV_schema.pdf) (for the CGST/SGST/IGST split per DD-5.4 — future-compat with E-invoice integration)

---

## §6 Acceptance criteria

1. **Polymorphic line type roundtrip.** Create an Invoice with 4 InvoiceLine rows of `lineType` ∈ {SERVICE, PRODUCT, MEMBERSHIP, WALLET_TOPUP}; finalize; verify `GET /api/wellness-invoices/:id` returns all 4 lines with correct `lineType` + `itemId` + `lineTotalCents`; verify each line's `itemId` resolves correctly against the right table (Service / Product / Membership / WalletBonusRule per PRD_WALLET_TOPUP D16).

2. **Split-tender payment sum validation.** Create an Invoice with `grandTotalCents=150000`; submit 3 InvoicePayment rows ({CASH 50000, UPI 50000, WALLET 50000}); verify finalize succeeds + Invoice.status=COMPLETED. Submit a 4th invoice with mismatched payments ({CASH 50000, UPI 50000, WALLET 40000} = 140000 ≠ 150000) — verify finalize returns 400 with `error=PAYMENT_SUM_MISMATCH` + Invoice stays DRAFT.

3. **Per-location invoice number sequence.** Create 3 locations (Bangalore, Mumbai, Hyderabad); create 5 invoices at each (15 total); verify `invoiceNumber` resets to `<LOC_CODE>-<YYYY>-00001` at each location's first invoice; verify `@@unique([locationId, invoiceNumber])` allows duplicate-number-across-locations.

4. **Void / refund flow.** Create an Invoice with 1 PRODUCT line (qty=2, decrement Inventory.qty by 2) + 1 WALLET payment of ₹500. Void the invoice via ADMIN. Verify (a) Invoice.status=VOID + voidedAt populated; (b) reverse InventoryAdjustment created (+2); (c) reverse WalletTransaction created (+500 cents); (d) audit `INVOICE_VOIDED` written. Verify (a non-ADMIN, non-MANAGER cashier) CANNOT void via 403.

5. **Backfill of existing Sale → Invoice.** Seed 10 Sale rows (wellness tenant); run `POST /api/wellness-invoices/backfill`; verify 10 Invoice rows created with `saleId` FK back; verify InvoiceLine + InvoicePayment rows extracted from `SaleLineItem` + `Sale.paymentBreakdownJson`; verify re-running backfill is idempotent (no duplicate Invoice rows; `@@unique([saleId])` prevents it).

---

## §7 Out of scope

- **Multi-currency invoices.** Single-currency-per-invoice (tenant default via `Tenant.defaultCurrency`). Multi-currency (one invoice with line in USD + line in INR) is out of scope; if needed, file a separate PRD.
- **Subscription billing (recurring invoices).** Already covered by `PRD_PLANS_BILLING_SELF_SERVE.md`; recurring wellness invoices would be a Phase 3 extension (e.g. monthly Gold membership auto-billing — different mechanism).
- **Layaway / partial-payment-over-time.** Customer pays in installments over weeks/months. Out of scope; v1 requires full payment at finalize (DD-5.7 partial-refund is the only partial-payment shape supported, and it's a refund flow not an installment flow). Phase 2 candidate.
- **Cross-location invoice consolidation.** Patient receives services at Bangalore + buys product at Mumbai in same visit; combined invoice. Out of scope; v1 requires per-location invoices.
- **E-invoice government filing integration (GSTN API).** The CGST/SGST/IGST split per DD-5.4 makes the schema FUTURE-COMPAT with E-invoice filing but does NOT implement the GSTN integration. Phase 3.
- **Discount approval workflow.** Manager-approval of cashier discounts above threshold. Inherited from PRD_POS_NEW_SALE D17's Q1; if implemented there, this PRD's `Invoice.discountTotalCents` is the column the approval logic enforces against.
- **GiftCard issuance UI.** Q6 — whether `GIFTCARD` line type means SELLING a giftcard (this PRD scope, simple) or REDEEMING (Payment.method=GIFTCARD already covers it). Issuance UI / activation codes / barcode generation is Phase 2.

---

## §8 Dependencies

- **Existing `Sale` model** at [backend/prisma/schema.prisma:3895-3935](../backend/prisma/schema.prisma#L3895-L3935) — `Invoice.saleId Int?` FK back per DD-5.3; backfill script reads from it.
- **Existing `SaleLineItem` model** at [backend/prisma/schema.prisma:3937-3958](../backend/prisma/schema.prisma#L3937-L3958) — `InvoiceLine.saleLineItemId Int?` FK back per DD-5.3; backfill extracts InvoiceLine from it.
- **Existing `Booking` model** at [backend/prisma/schema.prisma:2238-2263](../backend/prisma/schema.prisma#L2238-L2263) — `Invoice.bookingId Int?` FK mirrors PRD_POS_NEW_SALE D17's `Sale.bookingId Int?` addition.
- **Existing `Patient` model** — `Invoice.patientId Int?` (nullable for Guest-Checkout); `Patient.smsOptIn` consulted before sending receipt SMS.
- **Existing `Location` model** at [backend/prisma/schema.prisma:3052-...](../backend/prisma/schema.prisma#L3052) — `Invoice.locationId Int` NOT NULL; per-location number sequence scoped to Location; new field `Location.invoiceNumberTemplate String?` added.
- **Existing `Register` + `Shift` models** at [backend/prisma/schema.prisma:3817-3893](../backend/prisma/schema.prisma#L3817-L3893) — `Invoice.registerId Int` + `Invoice.cashierId Int` captured.
- **Existing `Membership` model** at [backend/prisma/schema.prisma:3300-...](../backend/prisma/schema.prisma#L3300) — `Invoice.appliedMembershipId Int?` FK (Q9: Sale-level vs per-line; current proposal is Sale-level matching PRD_POS_NEW_SALE D17).
- **Existing generic `Invoice` model** at [backend/prisma/schema.prisma:842-881](../backend/prisma/schema.prisma#L842-L881) — RENAMED to `DealInvoice` per DD-5.2 path (a); back-compat adapter at `backend/lib/dealInvoiceAdapter.js` for 30d.
- **Existing generic `Payment` model** at [backend/prisma/schema.prisma:2365-2384](../backend/prisma/schema.prisma#L2365-L2384) — RETAINED; `InvoicePayment.gatewayPaymentId Int?` FKs to it for CARD / ONLINE / UPI methods.
- **Existing `pdfRenderer.js`** at `backend/services/pdfRenderer.js` — extends with `renderWellnessInvoicePDF()`.
- **Existing `audit.js`** at `backend/lib/audit.js` — `writeAudit()` accepts the new `INVOICE_*` + `PAYMENT_*` events; `/api/audit/verify` is event-vocabulary-agnostic.
- **Existing `idempotency.js`** at `backend/lib/idempotency.js` — `Idempotency-Key` header replay-cache.
- **Existing `notificationService.js`** — for email-receipt flow.
- **Existing `sms.js`** + tenant SMS config — for SMS-receipt flow.
- **`PRD_WALLET_TOPUP.md` (D16)** — `WALLET_TOPUP` line type integrates with `lib/walletRedemption.js` (per D16 slice 1); `InvoicePayment.method=WALLET` calls into the same redemption helper.
- **`PRD_POS_NEW_SALE.md` (D17)** — UI consumer of the routes this PRD defines; D17 + D18 ship in coordination.
- **`PRD_PURCHASE_ORDERS.md` (D8)** — adjacent procurement spine; no direct dependency but the PO module's payment-method matrix shares the closed-enum vocabulary per DD-5.6.

---

## §9 Open questions

- **Q1: Migrate-or-keep generic Invoice?** Per DD-5.2 path (a) — rename to `DealInvoice` (recommended) — vs path (b) — keep `Invoice` name + add `kind` discriminator. Affects #560 Travel-grade billing decisions (Travel-vertical also uses generic Invoice for the multi-GST legal-entity flow; the rename impacts travel's billing routes too). Confirm path.

- **Q2: Invoice number sequence reset cadence — annual (Indian GST convention) or never?** Indian GST convention: each financial year (April-March) resets to 1 with a year prefix. Recommend annual (financial-year-based; April 1 reset) with operator-configurable reset month via `Tenant.invoiceFiscalYearStartMonth Int? @default(4)`. Non-India tenants default to no-reset (continuous sequence). Confirm — or push back if calendar-year (January reset) is preferred.

- **Q3: Per-line discount granularity — % only or fixed-cents-also?** Current proposal: per-line `discountCents Int` (fixed cents). Operator can compute the percent client-side. Vs per-line `discountType ∈ {PERCENT, FIXED}` + `discountValue` (percent or cents). Recommend cents-only (simpler schema; client converts). Confirm.

- **Q4: Per-line tip allocation supported, or tip is invoice-level only?** Current proposal: tip is invoice-level (`Invoice.tipCents`). Operator can manually allocate the tip across staff via a future "tip distribution" UI (out of scope for v1). Vs per-line `tipCents Int?` on InvoiceLine. Recommend invoice-level for v1 (simpler; the per-line-tip use case is rare — wellness clinics tip the lead service-provider not per-line). Confirm.

- **Q5: Tax inclusive-of-price vs exclusive-of-price — per-line flag, or tenant default?** Current proposal: tenant default via `Tenant.taxInclusivePricing Boolean @default(false)`. Indian wellness tenants typically use exclusive (price + GST shown separately on receipt); some Indian retail uses inclusive (price includes GST). Vs per-line `taxInclusive Boolean @default(false)` for mixed pricing. Recommend tenant-default for v1 (per-line is rare). Confirm.

- **Q6: GIFTCARD line type — for SELLING giftcards (this PRD scope) or REDEEMING (Payment.method=GIFTCARD)? Both?** Current proposal: BOTH. Selling a giftcard at the POS = a GIFTCARD InvoiceLine (lineType=GIFTCARD, itemId=GiftCard.id, unitPrice=giftcard face value); redeeming a giftcard as a payment method = an InvoicePayment row (method=GIFTCARD, reference=giftcard code). These are NOT the same flow — clarify semantics. Recommend both — and require the spec to disambiguate (line is for SELLING; payment is for REDEEMING).

- **Q7: Partial-refund flow in v1 or v2-only (full void only in v1)?** Current proposal: partial-refund-in-v1 via negative-amount InvoicePayment rows. Vs v1-ships-full-void-only. Recommend partial-refund-in-v1 — common operator need (customer dissatisfied with one of 4 lines; doesn't warrant full void); the implementation cost is small (one extra route + audit event). Confirm.

- **Q8: Send-SMS vs Send-Email default — both on, both off, or operator-toggle each time?** Current proposal: both off by default (`Invoice.sendSms @default(false)`); operator toggles at finalize-time. Vs tenant-default via `Tenant.defaultSendInvoiceSms Boolean`. Recommend off-by-default for v1 + tenant-toggle in Phase 2 (operator-driven is friendlier; reduces SMS-cost surprise; respects per-patient opt-in). Confirm.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 (polymorphic `itemId` shape — pure `Int + lineType` vs first-class FK per type) + DD-5.2 (existing generic Invoice — rename vs discriminator) + DD-5.4 (tax model — GST split vs simple total) + DD-5.7 (void/refund actor + partial-refund semantics) + Q1 (migrate-or-keep generic Invoice) + Q2 (invoice number reset cadence) + Q6 (GIFTCARD line type — sell vs redeem disambiguation) before any code lands. **DD-5.2 (Invoice rename vs discriminator) is the highest-leverage decision** — it determines the migration scope + the generic-CRM Billing surface compatibility + the back-compat window length.

**Owner:** TBD per product call. Likely allocation:

- Prisma schema additions (NEW `Invoice` + `InvoiceLine` + `InvoicePayment` models + rename existing `Invoice` → `DealInvoice` + `Location.invoiceNumberTemplate` column + `Tenant.invoiceVoidWindowHours` + `Tenant.taxInclusivePricing` + `Tenant.invoiceFiscalYearStartMonth`) — backend engineer ~0.5 day
- `backend/lib/dealInvoiceAdapter.js` (30d back-compat shim for `prisma.invoice` → `prisma.dealInvoice`) — backend engineer ~0.25 day
- `backend/routes/wellness-invoices.js` (9 new endpoints — LIST + DETAIL + CREATE + UPDATE + FINALIZE + VOID + REFUND + PDF + EMAIL/SMS) — backend engineer ~2.0 days
- `backend/lib/invoiceNumberSequence.js` (per-location atomic increment helper) — backend engineer ~0.5 day
- `backend/services/pdfRenderer.js::renderWellnessInvoicePDF()` (THERMAL + A4 templates) — backend engineer ~1.0 day
- `backend/scripts/backfill-wellness-invoices.js` (one-shot backfill of Sale → Invoice) — backend engineer ~0.5 day + admin trigger endpoint `POST /api/wellness-invoices/backfill` (per `adding-admin-trigger-endpoint` skill)
- Code sweep: `backend/routes/billing.js` + `backend/routes/billing.js` references to `prisma.invoice` → `prisma.dealInvoice` (+ frontend Billing.jsx + Invoices.jsx) — backend + frontend engineer ~0.5 day
- Tests (api-spec for 9 new endpoints + RBAC matrix + idempotency replay + atomic-transaction rollback + backfill idempotency + vitest for `invoiceNumberSequence` + `dealInvoiceAdapter`) — backend engineer ~1.5 days
- Wiring into `coverage.yml` + `deploy.yml` gate-spec lists per `wiring-spec-into-gate` skill — backend engineer ~0.25 day
- Wellness frontend Invoice page extension (post-D17 — read the new Invoice surface; UI shipped under D17's `pos/NewSale.jsx` consumer) — frontend engineer ~0.5 day
- Documentation (CHANGELOG.md entry + README.md "At a glance" table refresh + CLAUDE.md schema-notes update for the new models) — backend engineer ~0.25 day

**Total estimated effort post-design: 7-10 engineering days** (schema + routes + PDF + sequence engine + back-compat adapter + backfill + sweep + tests + wiring + docs — matches the "polymorphic-spine on a mature codebase with back-compat constraints" baseline).

**Sibling PRDs in this cluster:**

- `PRD_PURCHASE_ORDERS.md` (tick #187 — operator-governance shape, cluster D8)
- `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188 — payment-side integration governance, cluster D9; DEPENDED ON for CARD / UPI / ONLINE InvoicePayment methods + idempotency model)
- `PRD_IMPORT_EXPORT_JOBS.md` (tick #189 — async bulk-data ops, cluster D10)
- `PRD_INTEGRATIONS_HUB.md` (tick #190 — unified discovery / status / governance surface, cluster D11)
- `PRD_TAG_MASTER.md` (tick #191 — controlled-vocabulary governance, cluster D12)
- `PRD_AI_CHAT_HISTORY.md` (tick #192 — unified AI audit + recall surface, cluster D13)
- `PRD_CUSTOMER_SEGMENTS.md` (tick #193 — saved-filter audience targeting, cluster D14)
- `PRD_STAFF_DETAIL.md` (tick #194 — HR profile extension, cluster D15)
- `PRD_WALLET_TOPUP.md` (tick #195 — wallet top-up + bonus + expiry, cluster D16; DEPENDED ON for the WALLET_TOPUP line type + WALLET payment method + `lib/walletRedemption.js` internal helper)
- `PRD_POS_NEW_SALE.md` (tick #196 — POS New Sale UI, cluster D17; UI CONSUMER of this PRD's routes — D17 + D18 ship in coordination)

**Blocks before implementation can start:**

- DD-5.1 (polymorphic `itemId` — pure Int + lineType vs first-class FK per type) — MUST resolve (InvoiceLine column count)
- **DD-5.2 (existing generic Invoice — rename vs discriminator) — HIGHEST LEVERAGE; determines migration scope + generic-CRM Billing surface compatibility + back-compat window length**
- DD-5.4 (tax model — GST split vs simple total) — MUST resolve (InvoiceLine column count + PDF template)
- DD-5.7 (void/refund actor + partial-refund) — MUST resolve (RBAC matrix + status state machine)
- Q1 (migrate-or-keep generic Invoice) — MUST resolve (tied to DD-5.2)
- Q2 (invoice number reset cadence) — MUST resolve (sequence engine logic)
- Q6 (GIFTCARD line type — sell vs redeem disambiguation) — MUST resolve (line type semantics)

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:**

- **Slice 1** (~1.5 days): Prisma schema additions (NEW Invoice + InvoiceLine + InvoicePayment models + Location.invoiceNumberTemplate + tenant fields) + `dealInvoiceAdapter.js` back-compat shim + `invoiceNumberSequence.js` per-location atomic helper + `routes/wellness-invoices.js` core CRUD (LIST + DETAIL + CREATE + UPDATE) + api-spec tests. Ships the data spine + back-compat layer.

- **Slice 2** (~1.5 days): `routes/wellness-invoices.js` FINALIZE endpoint with full atomic transaction (Invoice + N InvoiceLine + M InvoicePayment + InventoryAdjustment + WalletTransaction in one `$transaction`) + payment-sum validation + audit `INVOICE_COMPLETED / PAYMENT_RECORDED` + api-spec tests. Ships the atomic-finalize flow.

- **Slice 3** (~0.75 day): `routes/wellness-invoices.js` VOID + REFUND endpoints with reverse-side-effects (InventoryAdjustment reverse + WalletTransaction reverse + refund-Payment row) + audit `INVOICE_VOIDED / INVOICE_REFUNDED / PAYMENT_REFUNDED` + RBAC matrix per FR-3.9. Ships the void/refund surface.

- **Slice 4** (~1 day): `services/pdfRenderer.js::renderWellnessInvoicePDF()` (THERMAL 80mm + A4 layouts) + `GET /api/wellness-invoices/:id/pdf` endpoint + `POST /api/wellness-invoices/:id/email` + `POST /api/wellness-invoices/:id/sms` + audit `INVOICE_PDF_DOWNLOADED / EMAILED / SMSED` + api-spec test. Ships the receipt surface.

- **Slice 5** (~1 day): `scripts/backfill-wellness-invoices.js` one-shot backfill + admin trigger endpoint `POST /api/wellness-invoices/backfill` (per `adding-admin-trigger-endpoint` skill) + idempotency-by-saleId + audit `BACKFILL_INVOICES_COMPLETED` + vitest test for the backfill engine + manual operator runbook in `docs/runbook-backfill-invoices.md`. Ships the data migration path.

- **Slice 6** (~1 day): Schema rename `Invoice` → `DealInvoice` (with `[allow-rename]` bless marker) + code sweep across `routes/billing.js` + `routes/invoices.js` + frontend `Billing.jsx` + `Invoices.jsx` + back-compat alias verification (deprecation warning on `prisma.invoice` calls) + CHANGELOG.md entry + README.md "At a glance" refresh + CLAUDE.md schema-notes update. Ships the generic-CRM-side adaptation.

Slices 1 + 2 + 3 + 4 must ship in order (each depends on the prior). Slice 5 + 6 can ship in parallel after slice 4 if dispatched file-disjoint. **Coordination with PRD_POS_NEW_SALE D17:** D17's slice 1 (`Sale.bookingId Int?` FK) is independent of this PRD; D17's slice 2 (catalogue search + draft cleanup) is independent; D17's slice 5 (frontend NewSale tab UI) is the UI consumer of this PRD's slice 1-4 routes and SHOULD ship after this PRD's slice 4 lands.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work fits cluster D (the wellness operational session — wellness-vertical-first; the `DealInvoice` rename touches the generic CRM too but the bulk of the work is wellness-spine). Proposal: add a new entry **D18. POS Polymorphic Invoice spine (#775)** under cluster D — sibling to D8-D17. Cross-references to D17 (POS New Sale — UI consumer of this PRD's routes; D17 + D18 ship in coordination) + D16 (Wallet Top-up — the `WALLET_TOPUP` line type integrates with `lib/walletRedemption.js`; `InvoicePayment.method=WALLET` calls the same helper) + D9 (Payment Gateway Config — CARD / UPI / ONLINE InvoicePayment methods route through D9's payment surface; shared idempotency model per DD-5.6).

**Cross-PRD coordination check:** Before implementation starts, confirm:

- `routes/audit.js` `/verify` endpoint accepts the `INVOICE_*` + `PAYMENT_*` event family without code change (entity = `INVOICE` or `PAYMENT` per FR-3.8).
- `backend/services/pdfRenderer.js` is willing to host a new `renderWellnessInvoicePDF()` helper alongside existing `renderInvoicePDF` (which now applies to `DealInvoice`).
- `backend/lib/dealInvoiceAdapter.js` is a clean thin shim — deprecation warning logged, no behavioural divergence from `prisma.dealInvoice` direct calls.
- `backend/scripts/backfill-wellness-invoices.js` is idempotent — re-runnable without duplicate Invoice creation; `@@unique([saleId])` on Invoice enforces it.
- The `WALLET_TOPUP` line type creates a `WalletTransaction` per PRD_WALLET_TOPUP D16's slice 1 batch walker (not a direct write).
- The `Sale.bookingId Int?` FK from PRD_POS_NEW_SALE D17 lands BEFORE this PRD's slice 1 (so `Invoice.bookingId` can reuse the same FK pattern).
- The legacy `/api/pos/sales/*` routes continue to write to `Sale` + `SaleLineItem` during the transitional window; the backfill script later mirrors that data into Invoice + InvoiceLine.
- The wellness reporting layer (`backend/routes/wellness.js` rollup queries) is migrated to read from `Invoice` + `InvoiceLine` in Phase 2 (NOT Phase 1; Phase 1 keeps reading from `Sale` for stability).
- The generic `/api/billing` routes + `/api/invoices` generic surface continue to work against `DealInvoice` via the adapter for 30d post-deploy; sunset decision in Phase 2.
- Existing audit rows (`SALE_CREATED` / `SALE_FINALIZED` from before this PRD) remain on the chain; both vocab families coexist; Phase 2 sunsets `SALE_*` audit emission.
- The `Tenant.gstRate Float?` field exists OR is added in this PRD's slice 1 schema migration (today's CRM has `Tenant.taxRate` per generic-CRM pattern; verify and either reuse or add `gstRate` explicitly for the GST-split shape).
