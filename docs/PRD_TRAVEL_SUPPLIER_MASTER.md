# PRD — Travel Supplier Master + Supplier Payments

**Status:** DD-5.1 RESOLVED 2026-05-24 — `TravelSupplier` Prisma model landed at commit `fdb793e`; `routes/travel_suppliers.js` (routes scaffold) shipping in-flight this tick by sibling agent; remaining DD-5.2..DD-5.5 pending. Originally WRITTEN 2026-05-23 (tick #20 / Agent 2)
**Source:** GH #903 — [Travel Gap] P1 — Build Supplier Master + Supplier Payments
**Tier:** P1 — Revenue-critical (Travel Stall CRM Roadmap)
**Owner sub-brands:** TMC (school trips), RFU (Umrah), Travel Stall (family holidays), Visa Sure
**Sibling PRDs:** `PRD_TRAVEL_BILLING.md` (customer-receivable mirror — this tick), `PRD_TRAVEL_GST_COMPLIANCE.md` (tick #19), `PRD_TRAVEL_QUOTE_BUILDER.md` (tick #19)

---


## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 30 |
| ✅ Shipped | 5 (17%) |
| 🟡 Partial | 6 |
| 🔌 Stub | 2 |
| ❌ Missing | 16 |
| ⏭️ Deferred | 1 (FR-3.5.c TDS auto-deduct, DD-5.5) |
| **Net gap** | **25 items** (~20 eng-days; the highest-impact engineering-actionable cluster) |
| Primary blocker | PO workflow (FR-3.2 entire), dispute history + chargeback log (FR-3.6), KYC + onboarding checklist (FR-3.1.h), reconciliation (FR-3.4 entire) all absent. Vault (FR-3.x credentials) and basic supplier CRUD shipped. |

**Single source of truth for all gap items + Wave 2 execution plan:** [TRAVEL_GAP_CLOSURE_TRACKER.md §3.6 + §7 Wave 2](TRAVEL_GAP_CLOSURE_TRACKER.md).

---

## §1 Background + source attribution

A travel agency's day-to-day operations span multiple suppliers per single customer transaction. A single Umrah package booking might involve a visa fee collector, an outbound airline, two hotels (Makkah + Madinah), a ground-transport vendor (e.g. Zikr Cabs), and the Haramain HSR (high-speed rail). Each of these is a distinct supplier with its own payment terms, billing cycle, dispute-resolution process, GST status, and commission/markup model. School-trip and family-holiday packages stack similarly — flights, hotels, ground transport, activities, insurance.

The CRM today exposes a `Vendor` model ([backend/prisma/schema.prisma:3327](../backend/prisma/schema.prisma#L3327)) intended for the wellness inventory side (used by `InventoryReceipt` for product receipts from medical vendors). It has the bare minimum — name, contact, GSTIN, address, isActive — and no travel-specific shape: no per-supplier credit limit, no PNR-tied PO line shape, no commission rate, no payment terms, no dispute history. The existing `/api/travel/supplier-credentials` surface ([backend/routes/travel_suppliers.js](../backend/routes/travel_suppliers.js)) is **credentials-only** — a vault for airline / GDS / visa-portal logins, not a supplier master. Issue #903 explicitly calls out that this credentials surface should be renamed to "Supplier Portal Logins" and moved under the new Supplier Master as a sub-tab.

The supplier-payable side is the structural mirror of the customer-receivable side covered by `PRD_TRAVEL_BILLING.md`. Together they form the two halves of the travel agency's ledger: every customer invoice line implies one or more supplier-PO lines; every customer payment received implies an eventual supplier payment owed. Without a first-class supplier-master + PO + payable surface, finance teams reconcile by hand from supplier-emailed PDF invoices, exposure tracking is impossible, and per-supplier commission accruals are lost.

**Source attribution:**
- GH issue #903 ([gh issue view 903](https://github.com/Globussoft-Technologies/globussoft-crm/issues/903))
- Travel Stall CRM Implementation & Modification Roadmap — Tier P1, item 8
- Sibling PRD: PRD_TRAVEL_BILLING (customer-receivable side)
- Cross-reference: PRD_TRAVEL_GST_COMPLIANCE (supplier-side TDS + GSTIN validation)

---

## §2 Use cases

1. **New supplier onboarding.** Travel agency adds "Air India Vacations" as a new Hotel-Booking-Aggregator supplier. Sets payment terms NET-30, credit limit ₹50L, commission 12% on booked value, sub-brand visibility to TMC + Travel Stall. KYC docs (GSTIN cert, cancelled cheque, PAN) uploaded. Supplier appears in supplier index and is bookable from quote builder.

2. **Automatic PO creation on booking.** Operations team confirms a TMC school-trip booking with PNR `AI-XYZ123`. CRM auto-creates a PO against the airline supplier with PNR-tied line shape (PNR + class + supplier-cost + customer-quoted-amount → visible margin). PO state transitions: draft → approved → confirmed (after supplier returns booking ref) → settled.

3. **Supplier invoice reconciliation.** Finance team receives a supplier invoice PDF emailed by "Makkah Hilton". Uploads to CRM; auto-match attempts by PNR / booking-ref + amount (within ₹100 or 0.5% tolerance). Matched line marks the PO line "ready-to-settle"; mismatches surface in a review queue.

4. **Scheduled payable + credit-limit guard.** Per supplier's NET-30 terms, CRM schedules supplier payment at PO-confirm + 30 days. T-7 reminder fires. When operations attempts a new booking against a supplier whose current owed-amount + new-PO would exceed credit limit, the booking-confirm step is blocked with a manager-approval prompt; quote-stage still permitted (advisory warning only).

5. **Dispute + chargeback flow.** Supplier disputes our payment claiming we paid less than billed (supplier-side dispute). Operations opens a Dispute record on the PO; status tracked through resolution. Alternatively: customer disputes the service (e.g. hotel was unhygienic); we open an our-side dispute, hold payment, potentially issue customer refund via chargeback flow which auto-reverses the supplier obligation if applicable.

6. **Per-supplier commission summary.** Sub-brand head pulls "RFU October commissions" report. Shows per-supplier accruals (computed at booking) + settlements (recognized at PO settlement). TDS auto-deducted on commissions crossing ₹5K threshold.

7. **Quote-time supplier health warning.** Quote builder shows: "Supplier 'Madinah Movenpick' is currently flagged DISPUTED — pending issue from booking #PO-2026-0451; confirm with finance before quoting." Operator can override or pick alternative supplier.

---

## §3 Functional requirements

### FR-3.1 Supplier master (8 fields)

- **FR-3.1.a Core profile.** Name, supplier type (airline | hotel | transport | visa-collector | sub-agent | other), GSTIN (Indian 15-char, validated; nullable for non-GST), PAN, address, primary-contact (name + phone + email + role), bank details (account number + IFSC + beneficiary name — encrypted at-rest), primary currency (INR / USD / EUR / SAR / AED / others).
- **FR-3.1.b Sub-brand visibility.** Multi-select: which sub-brands can transact with this supplier (`subBrandAccess[]`-style — TMC, RFU, Travel Stall, Visa Sure). Drives quote-builder supplier picker filtering.
- **FR-3.1.c Per-supplier credit limit.** Decimal (₹). The maximum we can owe this supplier before booking-confirm is blocked. `null` = no limit.
- **FR-3.1.d Per-supplier payment terms.** Enum: `prepay` | `NET-15` | `NET-30` | `NET-45` | `on-departure` | `on-return` | `custom`. Custom terms get a free-text description + an `effectiveNetDays` numeric override for the payable due-date calc.
- **FR-3.1.e Per-supplier commission/markup model.** Either a flat percentage (commission rate %) OR a markup-on-cost (% over base rate) OR fixed-fee-per-booking. Stored as `commissionModelJson` for flexibility.
- **FR-3.1.f Per-supplier status.** Enum: `active` | `paused` | `blocked-disputed` | `archived`. `paused` suppresses from quote picker but keeps existing POs alive; `blocked-disputed` flags every new quote with a warning; `archived` hides except in historical reports.
- **FR-3.1.g Per-supplier dispute history + chargeback log.** Append-only audit of every dispute opened, its resolution timeline, and chargeback amounts. Surfaced as a tab on the supplier detail page.
- **FR-3.1.h Per-supplier KYC + onboarding checklist.** Document slots (GSTIN cert, PAN card, cancelled cheque, agreement PDF). Status per slot: missing | uploaded | verified. Hard-block: cannot transact with supplier unless GSTIN + PAN + cancelled-cheque are at minimum `uploaded` (verified is best-practice but not blocking).

### FR-3.2 PO workflow (4 items)

- **FR-3.2.a Auto-PO on booking-confirm.** When a quote → booking transition fires, CRM creates one PO per distinct supplier referenced in the quote lines. Each PO carries PNR / booking-reference / unique reference key.
- **FR-3.2.b PO line shape.** Each PO line mirrors its corresponding customer-invoice line (PNR-tied or booking-ref-tied) with supplier-cost + customer-quoted-amount visible side-by-side for live margin tracking.
- **FR-3.2.c PO state machine.** `draft` → `approved` (operations sign-off) → `confirmed` (supplier returns booking ref / signed PO) → `settled` (after supplier payment + reconciliation). State transitions audit-logged. Reversal-from-settled requires manager role.
- **FR-3.2.d PO PDF export.** Per-supplier-brand PDF (sub-brand logo + GSTIN + supplier address + line items + total). Emailable from CRM with one click.

### FR-3.3 Payable workflow (5 items)

- **FR-3.3.a PO → Payable Record.** On PO-confirm, CRM creates a Payable Record with due date = PO-confirm-date + supplier's NET days (per FR-3.1.d).
- **FR-3.3.b Payable state machine.** `pending` → `scheduled` (operator sets payment date + method) → `paid` (payment posted with reference: cheque no / UPI ref / bank ref / wire ref). Posts to audit chain.
- **FR-3.3.c Supplier invoice PDF upload + match-to-payable.** Supplier emails a PDF invoice; finance uploads it; CRM auto-matches by PNR + amount + supplier identity. Manual override path always available.
- **FR-3.3.d Per-supplier aged payable bucket.** 0-30 / 31-60 / 61-90 / >90 day aging, exposed on supplier dashboard and tenant-level finance dashboard.
- **FR-3.3.e Credit-limit hard-block + manager-approval override.** Booking-confirm blocked if `(current owed-amount + new PO total) > supplier.creditLimit`. Manager-role override prompt records `userId` + `reason` + `at` in the audit chain.

### FR-3.4 Reconciliation (3 items)

- **FR-3.4.a PNR-keyed line match.** Match supplier invoice lines to PO lines by PNR + amount (and date if multiple POs per PNR — rare, e.g. amendments). Auto-match when within tolerance.
- **FR-3.4.b Tolerance threshold.** Default `min(₹100, 0.5%)` for auto-match. Configurable per tenant (advisory: can be configurable per supplier per FR-3.1 if DD-5.3 lands that way). Mismatches → manual-review queue.
- **FR-3.4.c Bulk-reconcile UI for high-volume suppliers.** Consolidator airline-ticket suppliers ship dozens of PNRs in a single invoice; reconciliation interface must support bulk-match (CSV upload of PNR + amount pairs) and bulk-confirm.

### FR-3.5 Commission tracking (3 items)

- **FR-3.5.a Per-supplier commission accrual.** At PO-confirm, commission accrued per FR-3.1.e model. Stored as a separate `SupplierCommissionEntry` row (PO ref + amount + status: accrued | recognized | reversed).
- **FR-3.5.b Per-supplier commission ledger per FY.** Indian FY (Apr 1 – Mar 31) default; configurable per tenant. Exportable as XLSX + PDF for finance tax filings.
- **FR-3.5.c TDS auto-deduction on commission >₹5K.** When cumulative-per-supplier-FY commission crosses ₹5K (or applicable Section 194H threshold), TDS auto-deducted at 5% (or current rate). Generates compliance entries that pair with PRD_TRAVEL_GST_COMPLIANCE for filing. DD-5.5 disambiguates owner.

### FR-3.6 Disputes + chargebacks (3 items)

- **FR-3.6.a Dispute record per PO.** Fields: status (open | investigating | resolved | escalated), amount-in-dispute, opened-by, opened-at, resolution-summary, resolved-by, resolved-at.
- **FR-3.6.b Two dispute directions.** `supplier-side` = supplier disputes our payment (e.g. they billed more than we paid, FX rate disagreement); `our-side` = we dispute supplier's service (no-show, downgrade, refused service).
- **FR-3.6.c Chargeback flow.** If customer disputes the service and we refund the customer via PRD_TRAVEL_BILLING's chargeback path, this PRD's chargeback step auto-opens an `our-side` supplier dispute + auto-holds the supplier payable until resolution.

### FR-3.7 Visibility surface (3 items)

- **FR-3.7.a Per-supplier dashboard.** Live obligations (sum of pending + scheduled payables), recent POs, commission earned this FY, open disputes, dispute history snippet, credit utilization gauge.
- **FR-3.7.b Per-tenant suppliers index.** Sortable by exposure / current balance / recency / status. Filter by sub-brand / supplier-type / status. Quick-action: pause, archive, open-dispute.
- **FR-3.7.c Quote-time advisory + booking-time hard stop.** Quote builder displays a non-blocking warning chip on disputed-or-paused suppliers; booking-confirm is hard-blocked on `blocked-disputed` status + credit-limit excess.

---

## §4 Non-functional

- **Supplier index performance.** Tenant with up to 500 suppliers loads in <1s on demo box.
- **PO PDF render.** <2s for a 20-line PO via pdfkit/pdf-lib (sibling to existing wellness PDF renderer at `backend/services/pdfRenderer.js`).
- **Audit chain.** Every payment-state change, dispute change, and credit-limit override writes to the existing tamper-evident audit chain (sibling to current `routes/audit.js` writeAudit calls).
- **Credit-limit check semantics.** Non-blocking (advisory chip) at quote-stage; blocking (hard stop + manager-approval override) at booking-confirm. Distinction matters for UX — operators draft quotes against speculative supplier capacity before confirming.
- **Multi-currency.** Per FR-3.1.a, supplier carries primary currency. PO + payable + commission all stored in supplier-primary currency; converted to tenant base currency for tenant-level aggregate reports using daily FX snapshots.
- **Audit log retention.** Dispute history + chargeback log retained for 7 years per Indian GST/IT statutory retention.

---

## §5 Hand-over reqs / cred chase / design decisions

### Design decisions (require product / finance-team sign-off)

- **DD-5.1 Extend existing `Vendor` model or fork to `TravelSupplier`?** Current `Vendor` ([schema.prisma:3327](../backend/prisma/schema.prisma#L3327)) is shaped for wellness inventory receipts. Travel needs PNR-tied PO lines, credit limits, sub-brand visibility, commission models, dispute history. **Recommendation: FORK to a new `TravelSupplier` model.** Vendor stays for wellness; TravelSupplier becomes the travel-side first-class entity. Reduces back-compat churn; lets travel iterate freely. Cross-reference: PRD_TRAVEL_BILLING DD-5.1 should mirror this decision symmetrically. Existing `SupplierCredential` model ([schema.prisma:4473](../backend/prisma/schema.prisma#L4473)) is the creds-vault and stays unchanged; relationship: each `SupplierCredential` may link to a `TravelSupplier` via optional FK so the "Supplier Portal Logins" sub-tab can be scoped per-supplier. **[RESOLVED 2026-05-24]** FORK — `TravelSupplier` as new Prisma model. Decided as part of the Quote/Billing/Supplier symmetric fork call (DECISIONS_TRACKER.md commit `a8f24ca`). Schema landed at commit `fdb793e` alongside sibling `TravelQuote` and `TravelInvoice`. Tenant inverse relation threaded into the travel-vertical cluster. Sibling agent is shipping `routes/travel_suppliers.js` (routes scaffold) THIS TICK — in-flight, not landed. Existing `Vendor` stays for wellness inventory; `SupplierCredential` will get an optional FK to `TravelSupplier` in a follow-up commit per AC-6.8.
- **DD-5.2 KYC document storage.** S3-style object store (existing CRM uploads pattern) vs DigiLocker integration vs simple Prisma `String?` paths into `/var/uploads/`? Decision impacts FR-3.1.h.
- **DD-5.3 Reconciliation tolerance scoping.** Hard-coded global default (₹100 / 0.5%) vs per-tenant config vs per-supplier config? Per-supplier is most flexible but more UI to build. Suggest: per-tenant first, per-supplier in Phase 2.
- **DD-5.4 Dispute resolution flow.** In-app workflow with state transitions only, or escalation hooks (auto-email supplier on dispute open, auto-create ticket in tickets module)? Suggest: in-app first, hooks in Phase 2.
- **DD-5.5 TDS auto-deduction ownership.** Who triggers downstream compliance reporting? Does this PRD's commission engine push to PRD_TRAVEL_GST_COMPLIANCE's tax-deduction surface, or does GST PRD pull from this PRD's commission ledger? Must align with PRD_TRAVEL_GST_COMPLIANCE DD-5.x to avoid double-counting.

### Cred chase

- **None external** for core spec. All implementation work uses existing models + adds new ones; no third-party API or new SaaS dependency at PRD level.
- For production rollout: tenant's bank reconciliation tool integration (if any) is out of scope per §7.

---

## §6 Acceptance criteria

- **AC-6.1** Add new supplier "Air India Vacations" → GSTIN validated → appears in tenant supplier index sorted by recency → bookable from quote builder for whitelisted sub-brands.
- **AC-6.2** Book a TMC trip referencing PNR `AI-XYZ123` against Air India → PO auto-created with `state=draft`, PNR linked, supplier-cost + customer-quoted populated, margin visible.
- **AC-6.3** Upload supplier invoice PDF → auto-match against the corresponding PO by PNR + amount within tolerance → PO line transitions to `ready-to-settle`.
- **AC-6.4** Payable scheduled at PO-confirm + 30 days (NET-30 supplier) → T-7 reminder fires → operator marks paid with UPI ref → payable transitions to `paid` → audit chain entry written.
- **AC-6.5** Attempt booking that would push owed-to-supplier over credit limit → booking-confirm blocked → manager-approval prompt → manager overrides → audit entry includes `userId`, `reason`, `at`.
- **AC-6.6** Per-supplier commission ledger for FY2026-27 shows accrued commissions per PO + recognized at settlement + TDS deductions for cumulative >₹5K.
- **AC-6.7** Open dispute on PO-2026-0451 → status changes to `open` → supplier dashboard shows dispute → quote-builder warning chip appears on next quote against this supplier.
- **AC-6.8** Rename `/travel/suppliers` UI surface to "Supplier Portal Logins" → move under Supplier Master detail page as a sub-tab → existing credentials remain functional; cred reveal still ADMIN-gated.

---

## §7 Out of scope

- **Bank reconciliation engine.** Tracking bank statement → payable matching is a separate finance area; this PRD ends at "payable marked paid with reference".
- **Supplier-side customer portal.** Letting suppliers log in to the CRM to see their own POs / upload invoices / mark disputes resolved — Phase 2.
- **Inter-supplier netting.** Some agencies offset what Hotel-A owes us against what we owe Hotel-A — Phase 3.
- **AI-driven supplier-quality scoring.** Auto-rate suppliers based on on-time fulfillment / dispute rate / response time — Phase 3.
- **Multi-leg booking choreography.** PRD_TRAVEL_QUOTE_BUILDER owns the booking choreography; this PRD only consumes the resulting PO trigger.
- **Supplier discovery / marketplace.** Letting CRM operators search a directory of "available suppliers in city X" — out of scope; suppliers added manually by tenant admin.

---

## §8 Dependencies

- **PRD_TRAVEL_BILLING** (sibling, tick #20) — supplier-payable side is the structural mirror of customer-receivable side; PO line shapes mirror invoice line shapes.
- **PRD_TRAVEL_GST_COMPLIANCE** (tick #19) — supplier TDS computation + GSTIN validation API + supplier-side GST input-credit tracking.
- **PRD_TRAVEL_QUOTE_BUILDER** (tick #19) — quote → booking transition triggers PO auto-creation; quote builder consumes supplier list for picker UI.
- **Existing `Vendor` model** ([schema.prisma:3327](../backend/prisma/schema.prisma#L3327)) — DD-5.1 decision determines extend-vs-fork.
- **Existing `SupplierCredential` model** ([schema.prisma:4473](../backend/prisma/schema.prisma#L4473)) — relationship via optional FK; rename UI surface per AC-6.8.
- **Existing `TravelCostMaster` model** ([schema.prisma:4244](../backend/prisma/schema.prisma#L4244)) — already carries `supplierId` (nullable); migrate to FK against new `TravelSupplier` once DD-5.1 lands.
- **Existing `ItineraryItem` model** ([schema.prisma:4224](../backend/prisma/schema.prisma#L4224)) — already carries `supplierId`; same migration.
- **Currency table** — multi-currency PO support; existing `Currency` model.
- **PRD_RFU_GROUND_SERVICES** (future PRD) — RFU's per-portal hotel orchestrator will auto-register multiple Makkah/Madinah hotel suppliers; this PRD's supplier-master must accept programmatic supplier creation from RFU side.
- **Audit chain infrastructure** (`routes/audit.js`, `lib/auditChain.js`) — payable + dispute state changes write here.
- **PDF renderer** (`backend/services/pdfRenderer.js`) — PO PDF export.

---

## §9 Open questions

- **OQ-9.1 PO granularity vs roll-up.** Per-PNR booking is granular but high-volume — a consolidator selling 50 tickets per week generates 50 POs per supplier. Should we auto-roll-up POs by booking-batch + supplier-week for cleaner ledger UX? (Trade-off: granularity for reconciliation vs noise reduction for ledger view.)
- **OQ-9.2 Sub-agent suppliers.** B2B sub-agents who SELL our packages (not buy from us) are technically customers, but B2B sub-agents who BUY through us at wholesale and resell — different shape? Or same TravelSupplier model with a `subAgentMode: boolean` flag? PRD_TRAVEL_BILLING should align.
- **OQ-9.3 Cross-tenant supplier sharing.** Globussoft serves multiple travel-agency tenants; should there be a curated "global supplier directory" (e.g. "Hilton Makkah" used by 8 tenants) vs per-tenant private supplier lists? Sharing saves onboarding effort but introduces cross-tenant data leakage risk.
- **OQ-9.4 Per-supplier currency vs per-PO currency.** Some suppliers bill mixed-currency (USD for base rate, EUR for VAT-stage hotels in transit). Per-PO override field or strict per-supplier-currency lock?
- **OQ-9.5 Supplier rating + quality score.** Operator-curated (manual 1-5 stars) vs auto-derived (on-time / dispute-rate / response-time aggregate)? Out of scope for v1 per §7 but flag now so v1 schema doesn't paint itself into a corner.
- **OQ-9.6 Dispute escalation SLAs.** Should disputed supplier payments auto-escalate after N days (e.g. >14d unresolved → notify finance head)? Pairs with DD-5.4.
- **OQ-9.7 FX-rate snapshot timing.** Convert supplier-currency to tenant base currency at PO-confirm, at payment, or at end-of-month reporting? Each gives different P&L behavior under volatile rates.

---

## §10 Status snapshot

### 2026-05-24 update #2 — Routes + admin UI

**Backend routes shipped:** `backend/routes/travel_suppliers.js` at commit `192b8c1`. CRUD scaffold including soft-delete (preserves referential integrity for any future TravelInvoice references). 11/11 vitest pass. Supplier credential vault (orthogonal SupplierCredential model) lives in the same file as a sibling block.

**Admin UI shipped:** `frontend/src/pages/travel/SuppliersAdmin.jsx` at commit `08ebe5e` (mounted at `/travel/suppliers-admin`, distinct from `/travel/suppliers` which hosts the credential vault UI). Sidebar entry "Suppliers" (master) + "Supplier credentials" (vault) clarify the distinction.

**Soft-delete decision:** isActive=false flip rather than hard-delete — preserves referential integrity if a TravelInvoice ever references a supplier. Operator-facing UI hides inactive by default; admin filter exposes them.

**Still pending (per the existing 2026-05-24 entry):**
- DD-5.2 through DD-5.7 — PRD-internal details (per-supplier reconciliation, dispute escalation hooks, etc.)
- Supplier-payable ledger (PRD §3.3)
- Commission tracking (PRD §3.4)
- TDS auto-deduction ownership boundary with GST PRD (DD-5.5 flagged as biggest remaining gap per tick #95 surfacing)

**Path to next implementation slice:** Real supplier-payable ledger model + per-supplier reconciliation flow. ~3-4 days for the ledger model + UI; gates partly on the GST DD-5.5 TDS boundary decision.

### 2026-05-24 update

**DD-5.1 RESOLVED:** FORK — `TravelSupplier` shipped at commit `fdb793e` (~85 LOC across the 3 trio models with `TravelQuote` + `TravelInvoice`). Tenant inverse relation threaded into the travel-vertical cluster. `prisma validate` clean.

**What's now possible:**
- Backend routes scaffold is **IN-FLIGHT THIS TICK** — sibling agent shipping `backend/routes/travel_suppliers.js` against the new model (supplier-master CRUD + sub-brand visibility filters). Companion PO / payable / commission / dispute routes are follow-up commits.
- Frontend supplier dashboard + tenant supplier index can wire to the new model once routes land.
- The orphan `ItineraryItem.supplierId` and `TravelCostMaster.supplierId` nullable-Int FK columns can be promoted to first-class relations against `TravelSupplier` in a follow-up migration (DEPENDENCIES §8 calls this out explicitly).
- Sub-brand isolation enforced at the schema level (`subBrand` indexed; `@@index([tenantId, subBrand])`).

**Still pending (PRD-internal DD-5.2 through DD-5.5):**
- **DD-5.2** — KYC document storage (S3-style object store vs DigiLocker vs simple Prisma path).
- **DD-5.3** — Reconciliation tolerance scoping (per-tenant first, per-supplier in Phase 2).
- **DD-5.4** — Dispute resolution flow (in-app workflow first, hooks in Phase 2).
- **DD-5.5** — TDS auto-deduction ownership boundary with `PRD_TRAVEL_GST_COMPLIANCE` (avoid double-counting between supplier-commission engine and GST tax-deduction surface).
- Per-PRD field expansion: real §3 fields (KYC checklist, PO workflow auto-creation, payable state machine, commission ledger per FY, dispute + chargeback workflow) land in follow-up commits — see the existing 10-18 engineering-day breakdown below.

**Path to implementation:** Routes scaffold (supplier-master CRUD) = in-flight this tick. PO workflow + auto-creation hook from quote-to-booking = +2-3d. Payable workflow + scheduled-payment + credit-limit guard = +2-3d. Reconciliation UI (auto-match + manual review queue) = +1-2d. Commission ledger + TDS auto-deduction (depends on DD-5.5 boundary) = +1-2d. Dispute workflow = +1d. Frontend supplier dashboard + tenant index = +1d. PO PDF export = +1d. AC-6.8 rename + relocate "Supplier Portal Logins" sub-tab = +0.5d. **Net remaining: 9-15 engineering days** post DD-5.1 land and routes-scaffold tick.

- **Current state in repo (2026-05-23 pre-fdb793e baseline, retained for history):**
  - `Vendor` model exists ([schema.prisma:3327](../backend/prisma/schema.prisma#L3327)) — wellness-shaped, not travel-shaped.
  - `SupplierCredential` model exists ([schema.prisma:4473](../backend/prisma/schema.prisma#L4473)) — credentials vault only.
  - `/api/travel/supplier-credentials/*` routes exist ([backend/routes/travel_suppliers.js](../backend/routes/travel_suppliers.js)) — creds CRUD + reveal + access log; metadata-only listing.
  - `ItineraryItem.supplierId` ([schema.prisma:4231](../backend/prisma/schema.prisma#L4231)) and `TravelCostMaster.supplierId` ([schema.prisma:4249](../backend/prisma/schema.prisma#L4249)) exist as nullable `Int?` FKs with no target relationship defined — orphan columns waiting for the supplier master to land.
  - No PO workflow. No payable workflow. No commission ledger. No dispute log.
- **This PRD:** WRITTEN 2026-05-23 (tick #20 / Agent 2).
- **Path to implementation:** **10-18 engineering days** broken down as:
  - 2 days: schema (new `TravelSupplier` + `TravelPurchaseOrder` + `TravelPurchaseOrderLine` + `TravelPayable` + `TravelSupplierDispute` + `SupplierCommissionEntry` models; DD-5.1 fork decision).
  - 2-3 days: supplier master CRUD routes + KYC upload + tests.
  - 2-3 days: PO workflow + auto-creation hook from quote-to-booking transition.
  - 2-3 days: payable workflow + scheduled-payment + credit-limit guard + tests.
  - 1-2 days: reconciliation UI (auto-match + manual review queue).
  - 1-2 days: commission ledger + TDS auto-deduction.
  - 1 day: dispute workflow.
  - 1 day: frontend supplier dashboard + tenant index.
  - 1 day: PO PDF export.
  - 0.5 day: AC-6.8 rename + relocate "Supplier Portal Logins" sub-tab.
- **Sibling PRDs in cluster:**
  - `PRD_TRAVEL_BILLING.md` (receivable side — tick #20)
  - `PRD_TRAVEL_GST_COMPLIANCE.md` (tax/compliance — tick #19)
  - `PRD_TRAVEL_QUOTE_BUILDER.md` (booking choreography — tick #19)
  - `PRD_TRAVEL_PIPELINE_KANBAN.md` (sales pipeline — tick #19)
- **Blocks before backend impl can start:** DD-5.1 (fork vs extend Vendor) MUST land; DD-5.5 (TDS ownership boundary with GST PRD) MUST land. Other DDs can iterate during implementation.
- **First implementation slice recommendation:** ship supplier master + manual PO creation + manual payable + dispute log FIRST (covers ~60% of finance-team needs); auto-PO hook + auto-match + commission ledger + TDS in slice 2.
