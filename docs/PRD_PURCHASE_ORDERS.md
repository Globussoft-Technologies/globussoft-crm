# PRD — Purchase Orders Module (Inventory + Travel Supplier POs)

**Status:** NOT STARTED — PRD draft only; design call needed before any code lands
**Source:** GH #847 — [Gap][PO-001] Purchase Orders module missing — no supplier PO workflow or approvals
**Tier:** P2 — Operational control (procurement governance + financial commitments)
**Authored:** 2026-05-25 (tick #187 / Agent B, autonomous overnight cron arc)
**Sibling PRDs:** `PRD_TRAVEL_SUPPLIER_MASTER.md` (travel-side supplier first-class entity; PO is the natural commitment edge), `PRD_TRAVEL_BILLING.md` (customer-receivable mirror — PO is the supplier-payable counterpart), `PRD_TRAVEL_GST_COMPLIANCE.md` (TDS auto-deduction on supplier commission)
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness-vertical session) + cluster B (multi-day feature builds) — split work across both verticals; see §10 for cluster proposal.

---

## §1 Background + source attribution

The CRM today has **no end-to-end procurement workflow**. Per GH issue #847 verbatim:

> Inventory has only `Receipts` and `Adjustments`. There is no Purchase Order (PO) module in the CRM.
>
> Gap — No end-to-end procurement workflow:
> - Cannot draft a PO to a vendor/supplier.
> - No PO approval workflow (draft → submitted → approved → received → closed).
> - No link between PO → Receipt → Inventory stock update.
> - No PO status tracking, partial receipts, or PO history.

Today's procurement footprint in the codebase:

- **`Vendor` model** at [backend/prisma/schema.prisma:3392](../backend/prisma/schema.prisma#L3392) — wellness-shaped: `name`, `contactPerson`, `phone`, `email`, `gstin`, `addressLine`, `isActive`. No credit limit, no payment terms, no commission model, no PO linkage. Inverse relation: `receipts InventoryReceipt[]`.
- **`InventoryReceipt` model** at [backend/prisma/schema.prisma:3411](../backend/prisma/schema.prisma#L3411) — receives goods against a `vendorId` FK but with **no PO linkage** — `purchaseOrderId` / `purchaseOrderLineId` columns absent. Each receipt is a free-standing "we got this stock from this vendor on this date for this cost" record; there is no upstream commitment that the receipt is fulfilling.
- **`InventoryAdjustment` model** at [backend/prisma/schema.prisma:3438](../backend/prisma/schema.prisma#L3438) — signed deltas for shrinkage / damage / expiry / recount / transfers. Adjustments are NOT a procurement surface; they're a stock-reconciliation surface.
- **`TravelSupplier` model** at [backend/prisma/schema.prisma:4806](../backend/prisma/schema.prisma#L4806) — travel-vertical supplier master shipped 2026-05-24 (commit `fdb793e`). Currently carries `name`, `gstin`, `supplierCategory`, `subBrand`. Per `PRD_TRAVEL_SUPPLIER_MASTER.md` §3.2 ("PO workflow"), the auto-PO-on-booking-confirm hook is **explicitly out of scope of the supplier-master PRD** and was deferred to this PRD.
- **`ApprovalRequest` model** at [backend/prisma/schema.prisma:1987](../backend/prisma/schema.prisma#L1987) — generic approval surface (`entity` + `entityId` + `status` PENDING/APPROVED/REJECTED + `requestedBy` / `approvedBy` / `comment`). Already used for `Deal`, `Quote`, `Discount`. **Designed for re-use** — POs become a new `entity` value: `"PurchaseOrder"`. No engine extension needed for the core flow.
- **`routes/approvals.js`** — handles the generic PENDING/APPROVED/REJECTED ledger; consumers (Deal / Quote) implement their own pre-submit + post-approve hooks via the event bus.

### Two distinct PO surfaces (wellness vs travel)

This PRD covers BOTH PO surfaces because they share the same state machine, approval flow, audit shape, PDF dispatch shape, and Vendor/Supplier integration pattern — but the consumers differ structurally:

- **Wellness inventory PO** (GH #847 primary scope): PO to a `Vendor` for `Product` line items (drugs / consumables / equipment). On receipt, auto-creates `InventoryReceipt` rows and increments `Product.stockOnHand`. Lifecycle ends at "PO received + stock updated + invoice paid". Volume: a wellness clinic processes ~5-20 POs/month per location.
- **Travel supplier PO** (deferred from `PRD_TRAVEL_SUPPLIER_MASTER.md` §3.2): PO to a `TravelSupplier` for booked services (hotel nights / flight seats / ground transport / activities). Lifecycle ends at "service delivered + supplier invoice reconciled + supplier paid". Volume: a high-throughput TMC/RFU agency may process 50-200 POs/month per sub-brand. Auto-PO-on-booking-confirm is the canonical creation path; manual PO is an escape hatch for off-system bookings.

The two surfaces share enough structure that **one model + one route set + one approval flow + one PDF template + one audit pattern** can serve both — with a `purpose: 'INVENTORY' | 'TRAVEL'` discriminator + a polymorphic `subjectType` / `subjectId` pair for the linked entity (Trip / Itinerary / Booking on the travel side; ProductBatch / re-order context on the wellness side). DD-5.1 (§5) calls this design decision out explicitly; the alternative is fork to `WellnessPurchaseOrder` + `TravelPurchaseOrder` and accept the duplication.

### Why this is a P2, not a P1

Procurement runs informally today: operators email vendors directly, vendors email back invoices, operators forward invoices to finance, finance pays out-of-band, stock arrives, operator adds an `InventoryReceipt` row by hand. It works at small volume but breaks audit-ability — no formal record of "who authorized this purchase at what threshold?" and no commitment ledger for finance to compute aged-payables-by-vendor against. The risk class is "unauthorized purchases + manual reconciliation overhead + supplier-performance opacity" per the issue body's Impact section — material but not a hot fire today.

### Source attribution

- GH issue #847 — [gh issue view 847](https://github.com/Globussoft-Technologies/globussoft-crm/issues/847)
- Related: GH #834 ([INV-001] Inventory back-office empty shell on staging — `routes/inventory.js` does exist with receipts + adjustments + low-stock surface, but no PO surface)
- Cross-reference: `PRD_TRAVEL_SUPPLIER_MASTER.md` §3.2 (deferred PO workflow), DD-5.1 (FORK decision for TravelSupplier landed `fdb793e`)
- Cross-reference: `PRD_TRAVEL_BILLING.md` (supplier-payable side is the structural mirror of customer-receivable)
- Cross-reference: `PRD_TRAVEL_GST_COMPLIANCE.md` (supplier TDS on commission accruals → triggers from PO settlement)

---

## §2 Use cases

1. **Wellness clinic re-stock workflow.** Receptionist sees `Patient` waiting-room queue includes 3 patients with prescribed treatments requiring `Hyaluronic Acid Filler` (10 vials), but `Product.stockOnHand = 4`. Receptionist drafts a PO to vendor "Aesthetic Supplies Co" with line items: 20 vials of Filler-A @ ₹4,500/vial + 10 vials of Lidocaine @ ₹350/vial. Total ₹93,500. Operator submits → approval flow fires (₹93.5K exceeds the wellness tenant's per-PO auto-approve threshold of ₹25K) → clinic manager (MANAGER role) approves → PO moves to APPROVED → operator emails the PO PDF to vendor → vendor acknowledges with expected delivery 5 days out → state transitions to ACKNOWLEDGED. Five days later, stock arrives → operator marks receipt → `InventoryReceipt` rows auto-created → `Product.stockOnHand` increments → vendor sends invoice referencing PO-2026-0042 → finance posts payment → PO state CLOSED.

2. **Travel advance commitment for group rates.** TMC ops books a 40-student school trip to Goa for Dec 2026. Hotel "Resort Rio" offers ₹4,200/night/room for advance booking (vs ₹6,500 rack rate) but requires 30% deposit by Aug 31 and final pax count locked by Nov 30. Ops drafts PO with line items: 20 rooms × 5 nights × ₹4,200 = ₹420,000 base + ₹126,000 deposit obligation now. **PO REVISION FLOW:** When pax count revises Oct 15 (40 → 36 students, 18 rooms not 20), operator creates PO v2 with revised line items. Approval flow on v2 only if delta >threshold. v1 retained in audit chain; v2 becomes the operative version. Final pax + actual delivery at trip-start triggers v3 (true-up) if needed.

3. **Approval gate on high-value PO.** Travel agency books a 250-passenger Umrah package with consolidator "Saudi Air Tours" — net cost ₹3.2 Cr. Operator drafts PO; per tenant config, anything over ₹50L requires OWNER (admin) role approval (single-step), and >₹2 Cr requires OWNER + a second co-signer (two-step). Both approvers receive notifications + email; PO blocked from SENT state until both APPROVE. Audit chain captures both approver `userId`s + `at` timestamps + free-text `reason` per approver.

4. **Multi-vendor PO consolidation dashboard.** Family-holiday Trip #TRP-2026-1043 references 6 distinct suppliers across the booking lifecycle: 1 airline (round-trip), 2 hotels (Goa + Dubai), 1 ground-transport vendor, 1 activities aggregator, 1 visa-processing vendor. Trip-detail page shows a "Purchase Orders" tab listing 6 POs across all suppliers — each row carries `PO number / Supplier / State / Total / Aged-days / Action button`. Operator can click into each PO; consolidated view shows total trip commitment + total invoiced + total paid + outstanding. Per-trip rollup feeds the trip-margin computation.

5. **Audit trail for procurement governance.** Finance audit: "Show me every PO sent to vendor X in FY2026-27 with value >₹1L, who approved them, and how long from APPROVED → CLOSED." Audit log integration must support this query without scanning entire app-state.

6. **Partial-receipt flow (wellness inventory).** PO for 100 vials of Botox @ ₹15,000/vial sent to vendor; vendor ships 60 vials Mar 1, 40 vials Mar 8 (back-order). Operator marks 60 vials received Mar 1 → state transitions PO to PARTIALLY_RECEIVED → 60 `InventoryReceipt` rows auto-created → `Product.stockOnHand += 60`. Mar 8, remaining 40 received → state DELIVERED → final 40 receipts created → stock fully updated. PO awaits invoice + payment; on PAID transition, state CLOSED.

7. **Cancellation flow + supplier obligation.** PO sent to vendor; 2 days later, customer cancels the trip (or wellness inventory is no longer needed). Operator opens PO → clicks "Cancel" → state moves to CANCELLED. **CANCELLATION POLICY CAPTURE (§9 OQ-9.6):** if PO was already ACKNOWLEDGED, does cancellation incur a vendor fee per pre-recorded `cancellationPolicy` field? If yes, auto-create a Payable obligation of the cancel fee; otherwise zero-cost cancellation. Out-of-the-box default: cancel-fee field as nullable text + nullable amount; operator captures from the PO confirmation email.

---

## §3 Functional requirements

### FR-3.1 PO creation flow

- **FR-3.1.a Draft PO from scratch.** Operator picks vendor/supplier (typeahead against `Vendor` for INVENTORY purpose; against `TravelSupplier` for TRAVEL purpose; the `subjectType` discriminator determines which picker fires). Adds line items: `productId` (INVENTORY) or `serviceDescription` + `unitOfMeasure` free-text (TRAVEL) + `quantity` + `unitCost` + `taxRatePct` + `lineTotal` (computed). Operator sets `paymentTerms` (default = supplier/vendor's stored terms; override allowed), `expectedDeliveryDate`, `notes`, and 0+ attachments.
- **FR-3.1.b Draft PO from a Trip (TRAVEL).** When created from `/travel/trips/:id`, line items auto-pre-populate from the trip's itinerary items (one PO per distinct supplier in the trip; operator can edit/remove lines).
- **FR-3.1.c Draft PO from low-stock alert (INVENTORY).** When created from `/wellness/inventory/low-stock`, line items auto-pre-populate with the low-stock products at their default re-order quantities. Operator picks the vendor (or uses the product's default-vendor if set).
- **FR-3.1.d PO numbering.** Tenant-scoped, sequential, prefixed: `PO-{YYYY}-{####}` where YYYY = creation year, #### = 4-digit zero-padded sequence per-tenant per-year. Sub-brand discriminator NOT in the PO number (operators copy PO numbers into vendor emails; sub-brand visible separately). OQ-9.4 covers per-sub-brand variants.
- **FR-3.1.e Currency.** Single-currency per PO (DD-5.4 confirms). Defaults to vendor/supplier's primary currency; override allowed. Converted to tenant base currency at PO-creation time using current daily FX snapshot (stored on the PO row alongside the original-currency total so historical reports remain stable under rate volatility).

### FR-3.2 PO state machine

States and transitions:

```
DRAFT
  ↓ submit-for-approval (operator clicks "Submit")
PENDING_APPROVAL
  ↓ approve (approver clicks "Approve" + optional reason)
APPROVED
  ↓ send-to-supplier (operator clicks "Send"; PDF emailed/WhatsApp'd to supplier)
SENT
  ↓ supplier-ack (operator marks acknowledged when supplier confirms; manual)
ACKNOWLEDGED
  ↓ receipt-of-goods (INVENTORY) or service-delivered (TRAVEL)
PARTIALLY_RECEIVED  ←→  DELIVERED
  ↓ invoice-received (supplier sends invoice; uploaded + matched to PO)
INVOICED
  ↓ payment-posted (operator marks paid with reference)
PAID
  ↓ close (operator marks closed; default: auto-close on PAID transition)
CLOSED

CANCELLED ← any non-CLOSED state can transition to CANCELLED
REJECTED ← PENDING_APPROVAL only (approver clicks "Reject" + mandatory reason)
```

Transitions are role-gated:

- DRAFT → PENDING_APPROVAL: requestor (USER role+)
- PENDING_APPROVAL → APPROVED / REJECTED: per tenant's approval policy (see FR-3.3)
- APPROVED → SENT: requestor or MANAGER+
- SENT → ACKNOWLEDGED: any USER+ (informational)
- ACKNOWLEDGED → PARTIALLY_RECEIVED / DELIVERED: any USER+ (informational; the goods-receipt operation is the gated action, not the state)
- DELIVERED → INVOICED: any USER+ + an uploaded supplier invoice
- INVOICED → PAID: finance role (specific role TBD per DD-5.7) + payment reference
- Any → CANCELLED: MANAGER+ (with mandatory `reason`)
- PARTIALLY_RECEIVED → CANCELLED is allowed but generates a partial-cancel obligation; goods already received are NOT reversed (those are real inventory)

State changes write to the audit chain (see FR-3.7).

### FR-3.3 Approval workflow

- **FR-3.3.a Per-tenant approval threshold.** A `Tenant.poApprovalConfigJson` blob (or first-class fields if the team prefers — DD-5.6 covers placement) stores the threshold ladder: `[{ minAmount: 0, autoApprove: true }, { minAmount: 25000, requireRole: 'MANAGER' }, { minAmount: 500000, requireRole: 'ADMIN' }, { minAmount: 20000000, requireRole: 'ADMIN', requireCoSigner: true }]`. PO submission evaluates the ladder; auto-approve fires for sub-threshold POs; above the threshold, an `ApprovalRequest` row is created (with `entity = 'PurchaseOrder'`).
- **FR-3.3.b Per-supplier override.** A `TravelSupplier.requireApprovalAnyAmount: boolean` or `Vendor.requireApprovalAnyAmount` opt-in flag forces approval regardless of threshold (used for first-time vendors, disputed vendors, or restricted-spend categories). DD-5.7 covers the flag placement.
- **FR-3.3.c Approval notification.** On PENDING_APPROVAL transition, system notifies all users matching `requireRole` (DB notification + email; WhatsApp escalation T+24h if no action). The Notifications module + EmailDispatch already supports this shape.
- **FR-3.3.d Multi-step approval (two-co-signer).** When `requireCoSigner = true`, BOTH approvers must approve before APPROVED transition fires. If first approver rejects, PO moves to REJECTED immediately (one rejection is fatal). The generic `ApprovalRequest` row needs extension for the two-approver shape (DD-5.2 covers schema-level extension vs PO-side wrapper).
- **FR-3.3.e Approval expiry.** If PENDING_APPROVAL sits >7 days without action, auto-notify next-tier role (MANAGER → ADMIN escalation). After 14 days, auto-cancel + flag in tenant admin dashboard. Configurable per tenant.

### FR-3.4 Revision tracking

- **FR-3.4.a PO revisions are first-class.** When operator clicks "Revise" on an APPROVED+ PO, a new revision row is created (PO-2026-0042-v2) linked to the parent PO-2026-0042-v1 via `parentPoId` FK. v1 retained in audit chain immutable; v2 becomes the operative version.
- **FR-3.4.b Diff view.** PO detail page exposes a "Revision history" tab; each revision shows side-by-side diff vs the prior version (line-item additions / removals / qty changes / unit-cost changes / total delta). UI mirrors the audit-log diff pattern.
- **FR-3.4.c Revision approval re-trigger.** Revisions that increase the total by >threshold (configurable; default 5%) re-trigger the approval flow against the NEW total. Revisions that DECREASE the total or that adjust line items below threshold flow through without re-approval but DO write to the audit chain.
- **FR-3.4.d Retention.** All revisions retained in DB indefinitely (audit-grade). OQ-9.7 covers retention policy in case of large-volume tenant — purge >10-revisions or >7-years out is the candidate alternative.

### FR-3.5 Linkage to existing models

- **FR-3.5.a `Vendor` FK (INVENTORY purpose).** `PurchaseOrder.vendorId` (nullable Int FK); set when `purpose = 'INVENTORY'`. NOT extending `Vendor` schema in this PRD; per DD-5.5, vendor-side credit-limit / payment-terms / commission live on Vendor in a follow-up PRD.
- **FR-3.5.b `TravelSupplier` FK (TRAVEL purpose).** `PurchaseOrder.travelSupplierId` (nullable Int FK); set when `purpose = 'TRAVEL'`.
- **FR-3.5.c Polymorphic subject linkage.** `PurchaseOrder.subjectType` (enum: `'TRIP'`, `'ITINERARY'`, `'BOOKING'`, `'INVENTORY_REORDER'`, `'STANDALONE'`) + `PurchaseOrder.subjectId` (Int, nullable; null when `STANDALONE`). When subjectType=TRIP, links to TmcTrip / future travel-trip models; when ITINERARY, links to `TravelItinerary`; when BOOKING, links to `Booking`. Polymorphic linkage handled at app layer, not Prisma — Prisma can't enforce; the route layer validates `subjectType` is consistent with linked entity.
- **FR-3.5.d `InventoryReceipt` reverse-linkage (INVENTORY purpose).** `InventoryReceipt.purchaseOrderLineId` (new nullable Int FK to `PurchaseOrderLine`). On goods-receipt, the operator marks per-line receipt quantity; system creates an InventoryReceipt row with the FK set + auto-increments `Product.stockOnHand`. This is the "PO → Receipt → Stock" linkage the issue explicitly calls out.
- **FR-3.5.e Invoice matching (TRAVEL purpose).** Inbound supplier invoices uploaded via `routes/travel_supplier_invoices.js` (NEW; out-of-scope of this PRD's narrow shipping slice but a near-term follow-up) — match by PO number + amount + supplier identity within tolerance (₹100 / 0.5%; mirrors `PRD_TRAVEL_SUPPLIER_MASTER.md` FR-3.4). Wellness inventory has no parallel invoice-matching surface today; for v1, finance posts payments manually with reference text.

### FR-3.6 PO PDF + dispatch

- **FR-3.6.a PDF template.** New `generatePurchaseOrderPdf(po)` function in `backend/services/pdfRenderer.js` (sibling to existing `generateTravelQuotePdf` at line 1438 + `renderTravelStallPersonalisedPdf` at line 1115). Shape: tenant logo + tenant address + tenant GSTIN at top; vendor/supplier address block + GSTIN at right; PO number + date + expected delivery + terms at top-right; line items table with cols `# / Description / HSN/SAC / Qty / Unit / Unit-Cost / Tax-% / Line-Total`; subtotal + tax-by-rate breakdown + grand total below; payment terms + notes + cancellation policy at bottom; tenant signatory block at bottom-right.
- **FR-3.6.b Email dispatch.** "Send to vendor" button POSTs to `/api/purchase-orders/:id/send` → marks SENT → emails the PO PDF to the vendor's primary email; CC's the requestor; logs the dispatch event in the audit chain. Tenant outbound-email config (Mailgun / Nodemailer) drives the actual send; no new infra needed.
- **FR-3.6.c WhatsApp dispatch (optional).** Tenants with WhatsApp Cloud API configured (`WhatsAppConfig` model) can dispatch the PDF via WhatsApp instead of (or in addition to) email — operator picks dispatch channel at "Send" time. Reuses existing `routes/whatsapp.js` send-document path.
- **FR-3.6.d Vendor portal acknowledgment (Phase 2).** Out of scope for v1; flagged in §7 as Phase 2 — let vendors click a one-time signed link in the PDF email to acknowledge receipt without needing CRM login.

### FR-3.7 Audit log integration

Audit chain entries (via `backend/lib/audit.js` `writeAudit(entity, action, entityId, userId, tenantId, details)`):

- `PURCHASE_ORDER` + `CREATED` — on PO creation; details = `{ purpose, total, currency, vendorId|travelSupplierId, subjectType, subjectId, lineCount }`
- `PURCHASE_ORDER` + `SUBMITTED` — on DRAFT → PENDING_APPROVAL
- `PURCHASE_ORDER` + `APPROVED` — on APPROVED transition; details = `{ approvedBy, atTotal, reason }`
- `PURCHASE_ORDER` + `REJECTED` — on REJECTED transition; details = `{ rejectedBy, reason }`
- `PURCHASE_ORDER` + `SENT` — on SENT transition; details = `{ dispatchChannel, recipientEmail|phone, pdfBytes }`
- `PURCHASE_ORDER` + `ACKNOWLEDGED` — on ACK transition
- `PURCHASE_ORDER` + `PARTIALLY_RECEIVED` — on partial-receipt; details = `{ lineQuantitiesReceived: { lineId: qty, ... } }`
- `PURCHASE_ORDER` + `DELIVERED` — on full-delivery; details = `{ totalReceived }`
- `PURCHASE_ORDER` + `INVOICED` — on invoice-upload + match; details = `{ supplierInvoiceRef, matchedAmount }`
- `PURCHASE_ORDER` + `PAID` — on payment-posted; details = `{ paymentMethod, paymentRef, amountPaid, paidBy }`
- `PURCHASE_ORDER` + `CANCELLED` — on cancellation; details = `{ reason, cancellationFee, cancelledBy }`
- `PURCHASE_ORDER` + `REVISED` — on revision creation; details = `{ parentVersion, newVersion, deltaTotal, lineDeltas }`
- `PURCHASE_ORDER` + `CLOSED` — on CLOSED transition

The chain inherits the existing hash-chain immutability (sibling to wellness-clinical PHI audit). The /verify endpoint at `routes/audit.js` works against PO entries with zero code changes.

---

## §4 Non-functional

- **Per-tenant scoping.** Every PO row carries `tenantId` (default 1, FK to `Tenant`). Every route handler scopes by `req.user.tenantId`. Cross-tenant access impossible (mirrors all other routes' tenantWhere pattern).
- **Audit immutability.** Per CRM convention, PO state changes write to the existing tamper-evident audit chain in `routes/audit.js` + `lib/audit.js`. Hash-chain integrity preserved across PO entries.
- **PDF rendering performance.** <2s for a 30-line PO via pdfkit/pdf-lib (mirrors `generateTravelQuotePdf` shape — tick #173). Test pinned at `e2e/tests/purchase-orders-pdf.spec.js` (Phase 2 follow-up).
- **PO list page performance.** Tenant with up to 5,000 historical POs paginates to first-page-load <1s with default 25-row pagination. Filters (status / vendor / supplier / date-range / total-range) execute against database indexes; full-text search on PO notes is NOT in v1 scope.
- **Approval-notification latency.** On PENDING_APPROVAL transition, approver notification dispatched within 60s (existing notification dispatcher's polling cadence).
- **Email/WhatsApp dispatch reliability.** Failed sends retry per `backend/lib/webhookDelivery.js` retry pattern (3 attempts, exponential backoff). Failure surfaces in PO detail page as "Send failed; retry" with operator override.
- **Multi-currency.** Original-currency total + FX-rate-snapshot + tenant-base-currency total all stored at PO row. Historical reports compute against original-currency totals (stable); aggregate dashboards optionally convert to tenant base.
- **Audit retention.** PO + line-item rows + revision rows + audit chain entries retained 7 years per Indian GST/IT statutory retention (mirrors `PRD_TRAVEL_SUPPLIER_MASTER.md` §4 retention rule). After 7 years, optionally purge to cold storage; no auto-purge in v1.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (require product / finance-team sign-off before backend impl can start)

- **DD-5.1 Single PO model with `purpose` discriminator vs fork to `WellnessPurchaseOrder` + `TravelPurchaseOrder`?** Single model with `purpose: 'INVENTORY' | 'TRAVEL'` + polymorphic `subjectType` / `subjectId` is recommended (less duplication; shared approval + audit + PDF + email infrastructure; matches the issue's framing of "Purchase Orders module"). The alternative (fork) avoids polymorphic linkage but doubles route surface and test surface. **Recommendation: SINGLE MODEL.** Cross-reference: `PRD_TRAVEL_SUPPLIER_MASTER.md` DD-5.1 FORKED to a new model (TravelSupplier) because the supplier shapes were structurally divergent (sub-brand visibility, commission, payment terms); PO shapes converge — vendor/supplier are different entities but PO line items + state + approval + dispatch + audit are identical.
- **DD-5.2 Approval workflow — extend `ApprovalRequest` for multi-approver or PO-side wrapper?** `ApprovalRequest` today is single-approver (`approvedBy: Int?`). Multi-approver requires either: (a) extend `ApprovalRequest` with `approvers: Json` + `requiredCount: Int`; or (b) wrap with a new `PurchaseOrderApproval` row that holds the approver tally + delegates to per-approver `ApprovalRequest` rows; or (c) skip multi-approver in v1, ship single-approver and add the two-co-signer flow in v2. **Recommendation: (c) — skip multi-approver in v1.** Two-co-signer is a Phase 2 follow-up; v1 ships single-approver with role-tier escalation (USER → MANAGER → ADMIN). 95% of PO volume by amount lives below the threshold that would trigger two-co-signer; the v1 ROI on the second-signer flow is low.
- **DD-5.3 KYC / vendor-onboarding checklist on Vendor (INVENTORY)?** `PRD_TRAVEL_SUPPLIER_MASTER.md` §3.1.h defines KYC for travel suppliers (GSTIN cert, PAN, cancelled cheque). Wellness inventory vendors today have no KYC checklist. Should this PRD bring KYC to wellness Vendor as well? **Recommendation: scope OUT of this PRD; track as a follow-up wellness-side compliance PRD.** Wellness vendor risk profile is different (regulated drug suppliers carry their own license + DCGI registration that finance verifies out-of-band today).
- **DD-5.4 Single-currency-per-PO vs multi-currency-per-PO line items?** Travel POs occasionally mix supplier rates in different currencies (e.g. air ticket priced in USD, hotel night priced in SAR for an outbound Saudi package). Two approaches: (a) lock PO to single currency, force operators to split into multiple POs by currency; (b) allow per-line currency with PO-level reporting in tenant-base. **Recommendation: SINGLE-CURRENCY-PER-PO for v1.** Lower complexity; operators can issue one PO per supplier-currency combination. Multi-currency at line level is a Phase 2 enhancement.
- **DD-5.5 Vendor-side fields (credit-limit, payment-terms, commission) — extend Vendor schema in this PRD or defer?** `Vendor` today lacks credit-limit / payment-terms / commission-rate fields. Adding them is in-scope of a Vendor-side hardening PRD that doesn't exist yet. **Recommendation: DEFER.** This PRD's PO flow reads payment-terms + credit-limit if present (defaults to NET-30 + no-limit if absent), and ships the PO schema + flow without requiring Vendor schema changes. A follow-up "Vendor Master Hardening" PRD picks up Vendor enrichment; on its merge, the PO flow gets richer at zero refactor cost (defensive null-handling already in place).
- **DD-5.6 Tenant-level approval-threshold config — Tenant.poApprovalConfigJson blob vs new TenantPoApprovalConfig table?** A JSON blob is faster to ship; a normalized table is easier to query historically. **Recommendation: BLOB for v1.** Single field on Tenant; schema-stable; admin UI edits as JSON. Migrate to normalized table only when the second consumer needs to query historic threshold ladders (unlikely in 2026).
- **DD-5.7 Which role transitions INVOICED → PAID?** Finance role distinction from MANAGER role is absent from current RBAC. Options: (a) MANAGER+ can transition; (b) add a new `FINANCE` role; (c) Tenant-configurable role mapping (string field). **Recommendation: (a) MANAGER+ for v1.** Most wellness tenants run with 1 manager + 1 admin; carving out a dedicated finance role is over-engineered for the volume. Travel agencies with separate finance + ops staff get the option per tenant in Phase 2.
- **DD-5.8 Auto-receipt vs manual-receipt on goods-arrival (INVENTORY)?** When a PO transitions to DELIVERED, should `InventoryReceipt` rows auto-create from the PO lines (and operator just confirms qty)? Or should operator manually create each receipt (slower but more deliberate)? **Recommendation: AUTO-CREATE with operator confirmation per line.** UI shows pre-filled receipt-quantity boxes (defaulting to PO quantity); operator adjusts if partial; saves to commit. Saves operator time; preserves the under-deliver / over-deliver capture step.

### Cred chase

- **None external.** Pure internal feature. No third-party API. No new SaaS dependency.
- For production rollout: tenant Mailgun/SMTP config (existing), tenant WhatsApp Cloud API config (existing for WhatsApp dispatch). No new credentials required.

### Vendor docs

- N/A. No vendor integration. Email dispatch via existing tenant outbound infra.

---

## §6 Acceptance criteria

- **AC-6.1** Operator creates a PO (INVENTORY purpose) from `/wellness/inventory/low-stock` → picks vendor → adjusts line items → submits → if total ≤₹25K threshold, auto-APPROVED; if >₹25K, PENDING_APPROVAL with notification dispatched to MANAGER role.
- **AC-6.2** Approver clicks "Approve" → state transitions to APPROVED → audit-chain row written with `approvedBy / at / reason` populated → requestor notified.
- **AC-6.3** Operator clicks "Send" → PO PDF rendered → emailed to vendor's primary email → state transitions SENT → audit row written with dispatch-channel + recipient.
- **AC-6.4** Vendor delivers goods → operator marks per-line receipt quantities → state transitions PARTIALLY_RECEIVED (if any line under-delivered) or DELIVERED (if all full) → `InventoryReceipt` rows auto-created per line → `Product.stockOnHand` incremented atomically.
- **AC-6.5** PO transitions to INVOICED on supplier invoice upload + match (TRAVEL) or finance-marks-invoiced (INVENTORY) → PAID on payment-posted with reference → CLOSED auto-fires on PAID transition (default config) → all audit chain entries integrity-verified via `/api/audit/verify`.
- **AC-6.6** Operator opens "Revise" on APPROVED PO → modifies line items → PO v2 created → if delta total >5% increase, re-triggers approval flow → audit chain shows v1 + v2 + diff metadata.
- **AC-6.7** Operator clicks "Cancel" on a SENT PO with mandatory reason → state transitions to CANCELLED → audit row written → if PO was ACKNOWLEDGED with stored cancel-fee, auto-creates a Payable row for the fee (TRAVEL) or notes the obligation (INVENTORY).
- **AC-6.8** Travel-side: operator opens `/travel/trips/:id` → "Purchase Orders" tab lists all POs linked to the trip → drill-in to per-PO detail → consolidated trip-level total-committed + total-invoiced + total-paid + outstanding visible.
- **AC-6.9** Tenant admin opens `/settings/purchase-orders` → configures approval threshold ladder (JSON editor or guided form) → saves → new POs evaluate against the new ladder.

---

## §7 Out of scope

- **3-way matching (PO ↔ inbound invoice ↔ goods receipt).** Auto-detect that all three agree on quantity + amount before posting payment. This is enterprise-grade procurement; v1 ships 2-way (PO ↔ receipt OR PO ↔ invoice manually). 3-way is a follow-up PRD.
- **ERP-style accrual accounting.** Track committed-but-not-paid as a liability accrual on a P&L. v1 keeps PO simple — cash basis (recognize expense on PAID transition; no commitment liability tracking). ERP-integration is `PRD_EXCEL_SOFTWARE_ACCOUNTING.md` scope.
- **Vendor portal (self-serve PO acknowledgment).** Phase 2 — vendors get a one-time signed link to acknowledge / dispute / upload invoice without CRM login. Out of scope for v1.
- **Multi-step approval (two-co-signer).** Per DD-5.2 recommendation — single-approver in v1; two-co-signer added in v2 when a real-world tenant requests it.
- **PO templates per supplier category.** Hotel POs vs flight POs vs visa POs might want different layouts. v1 ships one canonical template; per-category templates are a UI enhancement in Phase 2.
- **AI-driven supplier-quality scoring.** Auto-rate vendors based on on-time delivery rate / dispute rate / response time aggregate. Cross-reference `PRD_TRAVEL_SUPPLIER_MASTER.md` OQ-9.5 — same answer there: out of v1.
- **Bulk PO operations.** Create 20 POs from a CSV upload, mass-approve, mass-cancel. Out of v1; operator clicks through one at a time.
- **PO budget enforcement.** Block PO creation if it would exceed a per-cost-center budget. No cost-center / budget model exists today; out of v1.
- **Inter-supplier netting.** Some agencies offset what Hotel-A owes us against what we owe Hotel-A. Cross-reference `PRD_TRAVEL_SUPPLIER_MASTER.md` §7 — Phase 3 there; same here.
- **Goods-receipt → automatic supplier-rating feedback loop.** Out of v1; flag for future.

---

## §8 Dependencies

- **`Vendor` model** ([backend/prisma/schema.prisma:3392](../backend/prisma/schema.prisma#L3392)) — INVENTORY purpose linkage. No schema changes required for v1 (DD-5.5 defers vendor-side enrichment).
- **`TravelSupplier` model** ([backend/prisma/schema.prisma:4806](../backend/prisma/schema.prisma#L4806)) — TRAVEL purpose linkage. Existing schema sufficient for v1.
- **`InventoryReceipt` model** ([backend/prisma/schema.prisma:3411](../backend/prisma/schema.prisma#L3411)) — Reverse-linkage via new nullable `purchaseOrderLineId` column. ADDITIVE schema migration (no bless marker needed; nullable Int FK is back-compat).
- **`ApprovalRequest` model** ([backend/prisma/schema.prisma:1987](../backend/prisma/schema.prisma#L1987)) — Used directly with `entity = 'PurchaseOrder'`. No model changes for v1 (DD-5.2 defers multi-approver).
- **`Product` model** — `stockOnHand` auto-increment on receipt-create. Existing model; no changes.
- **`Tenant` model** — new `poApprovalConfigJson` field added (DD-5.6). ADDITIVE schema migration.
- **`backend/lib/audit.js` `writeAudit()`** ([backend/lib/audit.js:99](../backend/lib/audit.js#L99)) — Audit-chain integration. No changes; new entity values written transparently.
- **`backend/services/pdfRenderer.js`** ([backend/services/pdfRenderer.js](../backend/services/pdfRenderer.js)) — New `generatePurchaseOrderPdf(po)` function (sibling to `generateTravelQuotePdf` at line 1438 + `renderTravelStallPersonalisedPdf` at line 1115). Mirrors travel-quote PDF shape.
- **`backend/routes/approvals.js`** — Generic approval ledger. Used as-is; PO is just a new `entity` value.
- **Email infrastructure** (`backend/lib/email.js` + Mailgun/Nodemailer routes) — Existing; PO dispatch reuses.
- **WhatsApp infrastructure** (`backend/routes/whatsapp.js` send-document path) — Existing; PO dispatch optionally uses.
- **`Notification` model + dispatcher** — Existing; approval notifications dispatched here.
- **Frontend page `Inventory.jsx`** + new sub-route `/inventory/purchase-orders` — UI surface for INVENTORY POs.
- **Frontend per-trip page `TripDetail.jsx`** — New "Purchase Orders" tab for TRAVEL POs.

---

## §9 Open questions

- **OQ-9.1 Approval threshold default — what's the per-tenant default ladder?** Suggest: `[{ minAmount: 0, autoApprove: true }, { minAmount: 25000, requireRole: 'MANAGER' }, { minAmount: 500000, requireRole: 'ADMIN' }]` for wellness; `[{ minAmount: 0, autoApprove: true }, { minAmount: 100000, requireRole: 'MANAGER' }, { minAmount: 2000000, requireRole: 'ADMIN' }]` for travel (higher unit-economics). User confirms thresholds + tier counts during product call.
- **OQ-9.2 Multi-step approval — should v1 ship single-approver only and defer two-co-signer to Phase 2?** Per DD-5.2 recommendation. **GATES IMPLEMENTATION START.**
- **OQ-9.3 Single-supplier-per-PO or multi-supplier-per-PO?** Travel mostly is one-supplier-per-PO. Some bundling cases (consolidator selling flight + hotel as a packaged inventory line) could combine 2 suppliers in one PO. **Recommendation: SINGLE SUPPLIER for v1**; bundled cases handled by creating separate POs per supplier-of-record. **GATES IMPLEMENTATION START.**
- **OQ-9.4 PO numbering format — `PO-{YYYY}-{####}` vs per-sub-brand prefixed (`TMC-PO-{YYYY}-{####}`)?** Sub-brand visible separately on the PO row already; including in the number adds clarity for ops emailing vendors but adds tenant config burden. Suggest: tenant-configurable boolean `usesSubBrandPoPrefix` (default false). Decided during product call.
- **OQ-9.5 Currency — single PO must be single-currency, or multi-line multi-currency allowed?** Per DD-5.4 recommendation, single-currency-per-PO for v1. Multi-line multi-currency is Phase 2.
- **OQ-9.6 Cancellation policy capture — free-form text or structured (cancel-fee% + cancel-by-date)?** Structured fields enable auto-Payable creation on late cancellation. Free-form text is faster to ship but blocks the auto-fee surface. **Recommendation: structured fields `cancellationFeePct: Float?` + `cancellationDeadlineDate: DateTime?` + `cancellationNotes: String?` on PurchaseOrder.** Decided during product call.
- **OQ-9.7 Revision retention — keep all versions in DB, or only latest + audit-log diff?** All versions retained today per FR-3.4.d. At scale (10+ revisions per PO over multiple years), DB-row count grows. Alternative: keep only latest in `PurchaseOrder` table + write each revision delta to audit-chain only. Trade-off: query speed vs storage. Decided per tenant volume after first year of production data.
- **OQ-9.8 PO templates per supplier category (hotel vs flight vs visa)?** Out of v1 per §7. Re-evaluate after Phase 1 ship + 6 months of operator feedback.
- **OQ-9.9 Approval expiry policy — auto-cancel at 14 days, or auto-escalate forever?** Per FR-3.3.e — escalate at 7 days, auto-cancel at 14. Decided per tenant ops cadence.
- **OQ-9.10 Should this PRD include receipts auto-link (FR-3.5.d) in v1, or defer to Phase 2?** Auto-linking on goods-receipt is the "PO → Receipt → Stock Update" linkage the issue explicitly calls out. Recommend SHIP IN V1 to deliver the issue's core ask; the linkage is small (one new FK column + one auto-create call). Decided during product call.

---

## §10 Status snapshot

**Status:** NOT STARTED — PRD draft only; design call required to lock DD-5.1 through DD-5.8 and OQ-9.2 + OQ-9.3 + OQ-9.10 before any code lands.

**Owner:** TBD per product call. Likely allocation:
- Schema migration (additive: new `PurchaseOrder` + `PurchaseOrderLine` + Tenant.poApprovalConfigJson + InventoryReceipt.purchaseOrderLineId) — backend engineer ~0.5 day
- Routes (CRUD + state transitions + approval hooks) — backend engineer ~1.5 days
- Auto-create-receipt-on-delivery flow — backend engineer ~0.5 day
- PDF template (`generatePurchaseOrderPdf` in `pdfRenderer.js`) — backend engineer ~0.5 day
- Email/WhatsApp dispatch glue — backend engineer ~0.5 day
- Frontend INVENTORY PO surface (`/wellness/inventory/purchase-orders` list + detail + create form) — frontend engineer ~1 day
- Frontend TRAVEL PO surface (per-Trip tab + standalone list) — frontend engineer ~1 day
- Tests (api-spec + vitest + receipt-auto-create integration test) — backend engineer ~0.5 day
- Tenant admin UI for threshold config — frontend engineer ~0.5 day

**Total estimated effort post-design: 5-8 engineering days** across backend + frontend.

**Sibling PRDs in this cluster:**
- `PRD_TRAVEL_SUPPLIER_MASTER.md` (deferred PO workflow to this PRD; supplier-master scope finalized 2026-05-24)
- `PRD_TRAVEL_BILLING.md` (customer-receivable structural mirror)
- `PRD_TRAVEL_GST_COMPLIANCE.md` (TDS on supplier commission, cross-references PO settlement)
- `PRD_EXCEL_SOFTWARE_ACCOUNTING.md` (ERP-integration consumer of PO → payable bridge)

**Blocks before backend impl can start:**
- DD-5.1 (single model vs fork) — MUST resolve
- DD-5.2 (multi-approver scope) — MUST resolve
- DD-5.5 (Vendor schema enrichment scope) — MUST resolve to know whether Vendor model needs additive migration in this PR
- DD-5.6 (Tenant.poApprovalConfigJson blob vs table) — MUST resolve
- OQ-9.1 (default threshold ladder per vertical) — MUST resolve
- OQ-9.10 (receipts auto-link in v1 vs Phase 2) — MUST resolve to lock v1 scope

**Other DDs / OQs can iterate during implementation.**

**First implementation slice recommendation:** Schema + INVENTORY purpose only first (deliver the issue's primary ask — wellness inventory POs with vendor + approval + receipt auto-link). Travel-purpose extension in slice 2 (mostly a routes + UI extension; reuses 90% of slice-1 infrastructure). Estimated: slice 1 = 3-4 days; slice 2 = 2-3 days.

**Cluster placement in `MANUAL_CODING_BACKLOG.md`:** This work spans wellness (cluster D) and travel (cluster B), so neither cluster is exclusively right. Proposal: add a new entry **D8. Purchase Orders module** under cluster D (since the issue is filed against inventory which is wellness-flavored today + the issue is GH #847 with `wellness-session` tonality + the urgent ROI is wellness-side procurement governance). Cross-reference from cluster B's existing travel-supplier work (B2 / B3) is recommended. The travel-side PO extension lands in slice 2 after slice-1 INVENTORY ships and structurally proves the design.

**Cross-PRD coordination check:** Before implementation starts, confirm:
- `PRD_TRAVEL_SUPPLIER_MASTER.md` §3.2 ("PO workflow") is now formally delegated to THIS PRD — supplier-master PRD's status block updates to reflect that PO is no longer in its scope.
- `PRD_TRAVEL_GST_COMPLIANCE.md` TDS auto-deduction on supplier commission references THIS PRD's PO PAID transition as the trigger event (DD-5.5 of the GST PRD).
- `PRD_TRAVEL_BILLING.md` invoice creation references THIS PRD's PO numbers in line metadata for downstream reconciliation.
