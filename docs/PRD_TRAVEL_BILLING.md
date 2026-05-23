# PRD — Travel-Grade Billing & Invoicing

**Status:** DD-5.1 RESOLVED 2026-05-24 — `TravelInvoice` Prisma model landed at commit `fdb793e`; remaining DD-5.2..DD-5.7 pending • **Owner:** Travel vertical squad • **Filed:** 2026-05-23 (tick #20) • **Updated:** 2026-05-24 (tick #95)
**Refs:** GH #901 (P1 Travel Gap — Modify Invoices into Travel-Grade Billing) • Travel Stall CRM Roadmap Tier P1 item 6
**Siblings:** [PRD_TRAVEL_GST_COMPLIANCE.md](PRD_TRAVEL_GST_COMPLIANCE.md) (tax computation), [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) (quote → invoice path), [PRD_TRAVEL_SUPPLIER_MASTER.md](PRD_TRAVEL_SUPPLIER_MASTER.md) (supplier-payable side, this tick)

---

## §1 Background + source attribution

### Current state (shipped)
- Generic `Invoice` model — single `amount Float`, single `dueDate`, status enum `UNPAID|PAID|OVERDUE|VOIDED`, optional `dealId`/`visitId`, no line-items at all (see `backend/prisma/schema.prisma:805`).
- `Payment` model — single-row, single-currency, gateway-tagged (`stripe|razorpay`). One Payment per gateway hit; no concept of "milestone 1 of 3" (see `backend/prisma/schema.prisma:2328`).
- `routes/v1_invoices.js` (247 LOC) — recent shipped surface for v1 customer-facing invoice endpoints; no HSN/SAC/CGST/SGST/IGST awareness today (grep returns zero).
- `routes/billing.js` (1033 LOC), `routes/payments.js` (484 LOC) — generic single-amount billing flow plus Stripe/Razorpay payment intent + recurring invoices via `recurringInvoiceEngine`.
- `legalEntityCode` already on Invoice (Day 2 migration) — single string column (e.g. `"tmc_nexus"`, `"labbaik_travels"`, `"travel_stall_parent"`) per-sub-brand GST registration. Numbering still flat-global, NOT per-sub-brand per-FY.
- `webhookDelivery.js` — `invoice.created` webhook live since tick #18; hard-coded HSN/SAC has NOT shipped (the prior cron-tick log was speculative).
- `travel.advanceRatio.<subBrand>` tenant-setting key exists (`schema.prisma:316,2891-2904`) — used by Quote Builder + Itinerary modules; NOT yet consumed by Invoice.

### Travel-vertical gaps (the why)
- **Per-pax breakdown** — Travel Stall school trip invoices want "50 students × $1200/student" exploded, not a single $60,000 line. Today's `Invoice.amount` is one float.
- **Multi-currency on the same invoice** — Forex regs around Umrah packages let pilgrims pay 50% in INR + 50% in USD (RBI LRS routing). Same invoice, two currencies. `Payment.currency` is per-payment, but the invoice itself has no concept of "expected split".
- **Supplier-payable side** — The CRM tracks customer A/R but NOT operator A/P. Travel agencies live on margin between customer-receivable and supplier-payable; without the payable side the books are half-blind.
- **Settlement timelines** — Travel cashflow is staged: 25% booking advance → 50% pre-departure → 25% on-return. Today Invoice has one `dueDate`. There is no milestone schedule, no T-7/T-3/T-1 reminders, no advance-receipt PDF auto-generation.
- **TCS (Section 206C)** — Tax Collected at Source @ 5% applies to overseas tour packages above ₹7L per FY per customer (20% if the customer is a non-filer). No TCS line type, no threshold detection, no 27EQ filing report.
- **Travel-specific line categories** — transport / accommodation / activity / visa / insurance. Each line carries a PNR / supplier-confirmation / service-date.
- **Doc-type taxonomy** — Today: Invoice only. Travel needs Tax Invoice, Proforma Invoice, Credit Note, Debit Note, Travel Voucher (Hotel / Transfer / Activity subtypes).
- **Numbering** — Single global `invoiceNum @unique`. Travel sub-brands each want their own gap-less per-FY counter: `TS/26-27/0001`, `RFU/26-27/0001`, `TMC/26-27/0001`.

### Source attribution
GH issue #901 (filed by @nilimeshnayak-max as P1 Travel Gap audit) + Travel Stall CRM Implementation & Modification Roadmap (Google Doc) Tier P1 item 6 + ongoing operator interviews surfacing TCS + multi-currency pain.

---

## §2 Use cases (7)

- **UC-2.1 Umrah package with staged settlement (RFU)** — Operator issues an invoice for an Umrah package: customer pays 25% advance now in INR, 50% pre-departure in INR (T-21 days), 25% on-return in INR (T+7 days). Three milestones tracked; reminders fire at T-7/T-3/T-1 of each.
- **UC-2.2 B2B school-trip invoice with per-pax breakdown (TMC)** — Corporate client books 30-pax conference travel: invoice shows per-pax line × 30, GST line, NET-30 payment terms, single milestone (full due on departure).
- **UC-2.3 Supplier payable workflow** — Operator records: "We owe Air India ₹45L for 50 PNRs on PO-2026-0123, due T+30 after ticketing". Payable status: pending → scheduled → paid. Matched to supplier's emailed PDF invoice.
- **UC-2.4 Partial-payment receipt + reminder cascade** — Customer pays 25% advance via UPI; ReceiptPDF (CR-NOTE shape, but-not-a-refund) auto-issued; next-milestone reminder cron picks up the schedule and emails the customer 7 / 3 / 1 day before pre-departure milestone.
- **UC-2.5 Aged Receivable + Aged Payable month-end close** — Accountant runs month-end report: receivables bucketed (0-30, 31-60, 61-90, 90+) per customer + per-sub-brand; payables bucketed per supplier + per-due-bucket.
- **UC-2.6 TCS auto-detection on overseas package** — Operator issues a ₹9L Bali package invoice for a customer who already crossed ₹7L FY threshold. TCS line auto-added @ 5% on ₹2L excess (₹10,000). If customer is flagged non-filer, rate flips to 20%.
- **UC-2.7 Cancellation + refund flow** — Customer cancels Umrah package post 30% advance; cancellation-policy table says "30% retained as cancellation charge if cancelled <60 days out". CR-NOTE issued for $0 (full retention) with policy reference; or partial-CR if outside the 60-day window. Customer ledger shows the reversal.

---

## §3 Functional requirements

### FR-3.1 Invoice shape extensions (line-items first)
- **FR-3.1.a** New `InvoiceLine` model — per-line `lineType` (`per_pax|per_room|per_night|per_trip|tax|fee|addon|tcs|tds`), `quantity`, `unitPrice`, `currency`, `lineTotal`, `description`.
- **FR-3.1.b** Per-line PNR / booking-reference field (free-form string; carries from Quote → Invoice).
- **FR-3.1.c** Per-line supplier link (FK to `Supplier` model from sibling PRD #903; nullable so non-travel rows skip).
- **FR-3.1.d** Per-line service-date(s) — `serviceStartDate`, `serviceEndDate` (separate from invoice's `issuedDate`, drives accrual-period reporting).
- **FR-3.1.e** Optional add-ons section — operator marks a line as `isAddon` (paid separately or rolled-in display toggle).
- **FR-3.1.f** Per-line cost-vs-sell margin — `lineCost` (what we owe supplier) + `lineSell` (what customer pays) tracked side-by-side; powers per-trip margin reporting + agent commission compute.
- **FR-3.1.g** Per-line tax breakdown — `taxableValue`, `cgstPercent`, `sgstPercent`, `igstPercent`, `taxAmount` (sums; computed by GST PRD's place-of-supply rules).
- **FR-3.1.h** Display order — `displayOrder Int` for operator-controlled line sequencing on the PDF (group transport together / accommodation together / etc.).

### FR-3.2 Multi-stage settlement
- **FR-3.2.a** `PaymentSchedule` model — child of Invoice; rows are `(milestoneOrder, dueDate, expectedAmount, expectedCurrency, status)`. Status: `pending|partial|paid|overdue|waived`.
- **FR-3.2.b** Per-sub-brand + per-package-type schedule templates — operator picks "Standard Umrah 25/50/25" at invoice creation; template expands to 3 milestone rows. Templates live in `Setting` (key `travel.paymentScheduleTemplate.<subBrand>.<packageType>`).
- **FR-3.2.c** Cron-driven reminder fire at T-7 / T-3 / T-1 of each milestone (channel per DD-5.5). Reuses existing `scheduledEmailEngine` / `notificationService` plumbing; new cron `paymentScheduleReminderEngine.js` runs every 15 min.
- **FR-3.2.d** Receipt PDF auto-generated on each milestone settlement; numbered separately (`RCT/<SUB>/<FY>/<n>`).
- **FR-3.2.e** Milestone-due-date pegging to event-relative dates — operator picks anchor (`bookingDate|departureDate|returnDate`) + offset days (`-30`, `0`, `+7`); system computes absolute `dueDate` at invoice issue.
- **FR-3.2.f** Operator-override per milestone — at issue-time operator can deviate from template (e.g. customer asks "split 50/50 instead of 25/50/25") with audit-log entry.
- **FR-3.2.g** Overdue milestone escalation — after T+1 day past due, escalation chain: T+3 customer reminder, T+7 sales-rep alert, T+14 admin alert.

### FR-3.3 Multi-currency single invoice
- **FR-3.3.a** Invoice carries `displayCurrency` (operator's reporting), but lines + milestones each carry their own `currency`.
- **FR-3.3.b** Customer chooses split at advance-time — milestone 1 INR, milestone 2 USD is supported.
- **FR-3.3.c** FX rate locked per Payment (not per Invoice) — operator's reporting-currency total recomputes from each Payment's locked rate.
- **FR-3.3.d** Reporting view: both displayCurrency-total and per-payment original-currency shown.

### FR-3.4 TCS handling (Section 206C)
- **FR-3.4.a** Auto-detection: when invoice's `legalEntityCode` is for an Indian sub-brand AND any line has `lineType in {transport|accommodation|activity}` with `serviceCountry != "IN"` AND the customer's running FY total (sum of invoices for this customer this FY) crosses ₹7L, mark the invoice as TCS-eligible.
- **FR-3.4.b** Compute 5% TCS on the excess-over-₹7L portion; 20% if `Contact.tcsTaxFilerStatus = "NON_FILER"`.
- **FR-3.4.c** TCS line auto-inserted as a system-managed line (lineType=`tcs`); operator can adjust but the system flags non-default values.
- **FR-3.4.d** Quarterly Form 27EQ-filing-ready report endpoint (`GET /api/travel/tcs/27eq?fy=26-27&q=2`).

### FR-3.5 Supplier-payable side
- **FR-3.5.a** `SupplierPayable` model — created when an Invoice line ties to a supplier. Carries `payableAmount`, `currency`, `dueDate`, `status` (`pending|scheduled|paid|disputed`), `internalPONumber`, `supplierInvoiceRef` (the PDF they send us).
- **FR-3.5.b** Workflow: pending → scheduled (treasury runs cycles) → paid. Per-supplier payment terms live on `Supplier.paymentTermsDays` (per #903 PRD).
- **FR-3.5.c** Match: operator uploads supplier's emailed invoice PDF → attached to SupplierPayable record; reconciliation flag if amounts mismatch.
- **FR-3.5.d** Pre-payment vs post-payment toggle — some suppliers (airlines) need pre-pay before ticketing; others (hotels) bill post-checkout. Per-supplier default + per-PO override.
- **FR-3.5.e** Payment-batch run — treasury operator selects multiple payables → generates a single bank-transfer file (NEFT/RTGS/SWIFT) + marks all as `scheduled`. Atomic batch operation.
- **FR-3.5.f** Dispute workflow — operator flags `disputed` with reason; held out of payment batches; resolution path (`resolved_paid|resolved_reduced|resolved_voided`).

### FR-3.6 Receivable + payable reporting
- **FR-3.6.a** Aged Receivable: bucketed by 0-30 / 31-60 / 61-90 / 90+ days past due; filter by customer / sub-brand / FY.
- **FR-3.6.b** Aged Payable: same shape, per-supplier / sub-brand / FY.
- **FR-3.6.c** Settlement timeline view (Gantt-like) — operator sees upcoming milestone due-dates across all open invoices.

### FR-3.7 Refund + cancellation flow
- **FR-3.7.a** `CancellationPolicy` model — per-tenant or per-sub-brand (DD-5.6 decides) policy table: `(daysBeforeService, retentionPercent)` rows.
- **FR-3.7.b** Cancellation action: operator picks the cancellation date → system computes retention from the policy table → CR-NOTE issued for the refundable portion.
- **FR-3.7.c** CR-NOTE links back to the original Invoice; reversal entry on customer ledger; numbering `CRN/<SUB>/<FY>/<n>`.

### FR-3.8 Document templates + numbering
- **FR-3.8.a** New `doc_type` enum on Invoice: `tax_invoice|proforma|credit_note|debit_note|travel_voucher`.
- **FR-3.8.b** Travel Voucher sub-types: `hotel_voucher|transfer_voucher|activity_voucher` — each carries supplier confirmation number, check-in date, traveller list.
- **FR-3.8.c** Per-sub-brand + per-FY gap-less counter — `InvoiceNumberSeries` table with row per `(subBrand, fy, docType)` and atomic increment. Format: `<SUB>/<FY>/<NNNN>`.
- **FR-3.8.d** Per-sub-brand PDF template (logo, footer, GSTIN, T&C block) — branding via DD-5 product call with Yasin (per Q22 carry-over).

---

## §4 Non-functional requirements

- **NFR-4.1 PDF render** — Invoice PDF (≤50 lines) renders in <3s p95. Receipt PDF (≤5 lines) in <1s.
- **NFR-4.2 Numbering integrity** — Per-sub-brand counter MUST be gap-less; transactional `SELECT ... FOR UPDATE` on the InvoiceNumberSeries row before increment.
- **NFR-4.3 Audit trail** — Every settlement-state transition (milestone settled, CR-NOTE issued, payable paid) writes a row to existing `AuditLog` with `entityType=Invoice|PaymentSchedule|SupplierPayable`.
- **NFR-4.4 Race-safety on milestone updates** — Concurrent partial payments on the same milestone must not double-credit. Optimistic-lock via `PaymentSchedule.version` increment.
- **NFR-4.5 Backward compatibility** — Existing single-amount Invoice rows must continue rendering; LineItem-less invoices fall back to a single synthetic display line.
- **NFR-4.6 Webhook fan-out** — Each milestone settlement fires `invoice.milestone.settled` webhook (extending existing `invoice.created` machinery from tick #18).

---

## §5 Hand-over / design decisions / cred chase / vendor docs

### Design decisions (need user call before implementation)
- **DD-5.1 Fork Invoice or extend in-place?** — Same trade-off as Quote Builder. Recommend FORK to a sibling `TravelInvoice` model so generic-CRM customers don't pay schema-bloat tax for per-pax lines + payment schedules + supplier payables. Cross-ref: `PRD_TRAVEL_QUOTE_BUILDER.md` DD-5.1. **[RESOLVED 2026-05-24]** FORK — `TravelInvoice` as new Prisma model. Decided as part of the Quote/Billing/Supplier symmetric fork call (DECISIONS_TRACKER.md commit `a8f24ca`). Schema landed at commit `fdb793e` alongside sibling `TravelQuote` and `TravelSupplier`. Tenant inverse relation threaded into the travel-vertical cluster. Companion `InvoiceLine` / `PaymentSchedule` / `SupplierPayable` / `InvoiceNumberSeries` models + `routes/travel_invoices.js` are follow-up commits.
- **DD-5.2 Schedule template ownership** — Operator-configured per-invoice (free-form) vs admin-curated templates (pick from list)? Recommend admin-curated with operator-override-per-invoice. Reduces support load.
- **DD-5.3 Reporting currency** — Operator's preferred currency (`User.preferredCurrency`), sub-brand's home currency (`SubBrand.defaultCurrency`), or tenant-global (`Tenant.defaultCurrency`)? Recommend sub-brand-home with operator-override per Aged-X report.
- **DD-5.4 TCS verification source** — Who maintains the customer's tax-filer status (`Contact.tcsTaxFilerStatus`)? Manual operator-toggle vs govt portal/TRACES login vs CSV bulk-import? Recommend manual with import-CSV path for bulk-onboarding.
- **DD-5.5 Reminder cadence + channel** — Default cadence (T-7/T-3/T-1) hard-coded vs operator-configurable per sub-brand? Email vs SMS vs WhatsApp vs all? Recommend hard-coded cadence, all-channels-on with operator opt-out toggle per channel.
- **DD-5.6 Cancellation-policy editor UI scope** — Admin-only / per-sub-brand-head / per-operator? Recommend admin-only (policies are legal contract terms; operator-edit creates audit risk).
- **DD-5.7 Per-sub-brand PDF branding** — Yasin's brand handover (Q22 carry-over) blocks the visual template; can we ship FR-3.8.d with placeholder branding now and swap later?

### Cred chase
- **Q-BILL-1** — TCS tax-filer verification source: which govt portal/API exposes "is this PAN a tax filer?" lookup? (TRACES has it but is login-walled.) Workaround: manual flag with annual operator-review reminder.

### Vendor docs
- N/A — feature is internal-CRM; no third-party vendor SDK gated.

---

## §6 Acceptance criteria

- **AC-6.1** Issue Umrah package invoice with 25/50/25 schedule → 3 milestones rendered on PDF + 3 rows in `PaymentSchedule` table + reminder cron registers fire-dates.
- **AC-6.2** Customer pays 25% advance via UPI → Receipt PDF auto-issued with separate `RCT/<SUB>/<FY>/<n>` number + balance updated on Invoice + next milestone in `pending` (not yet `partial`).
- **AC-6.3** Customer pays 60% in INR + 40% in USD on the same milestone → split recorded on 2 Payment rows + invoice's displayCurrency total recomputes from each Payment's locked FX.
- **AC-6.4** Invoice for school trip with `serviceCountry="ID"` and customer FY-total crossing ₹7L → TCS line auto-added @ 5% on the excess; if `tcsTaxFilerStatus="NON_FILER"`, rate flips to 20%.
- **AC-6.5** Issue invoice with airline line + hotel line → 2 `SupplierPayable` rows created (one per supplier) with correct `payableAmount` and `dueDate = invoice.issuedDate + supplier.paymentTermsDays`.
- **AC-6.6** Customer cancels post-advance, 45 days before service-date, policy says "60-30 days = 50% retention" → CR-NOTE issued for 50% of paid-advance + customer ledger reversal posts.
- **AC-6.7** Month-end Aged Receivable report shows open invoices bucketed correctly by `dueDate - now` deltas; Aged Payable report mirrors for supplier-payables.
- **AC-6.8** Invoice numbering: issue 3 invoices for sub-brand TS in FY26-27 → numbers `TS/26-27/0001`, `TS/26-27/0002`, `TS/26-27/0003`. Concurrent issuance from 2 operator sessions does not skip or duplicate.
- **AC-6.9** Travel Voucher of subtype `hotel_voucher` issued with supplier confirmation code + check-in date + 4 traveller names → PDF renders all 4 fields.
- **AC-6.10** Backward-compat: existing single-amount `Invoice` row (no `InvoiceLine`) still renders PDF + displays in list views without errors.
- **AC-6.11** `invoice.milestone.settled` webhook fires on each milestone settlement with payload including `milestoneOrder`, `paidAmount`, `paidCurrency`, `remainingBalance`.
- **AC-6.12** Quarterly Form 27EQ-filing report (`GET /api/travel/tcs/27eq`) returns all TCS lines for the period with PAN + amount + rate.

---

## §7 Out of scope

- Multi-tax-jurisdiction beyond Indian TCS (US sales tax / EU VAT — future).
- Bank reconciliation (Finance-ops module, separate area).
- Foreign exchange forward contracts / hedging (treasury, not CRM).
- E-invoicing IRN/QR code generation — cross-ref `PRD_TRAVEL_GST_COMPLIANCE.md` §7.
- B2B aggregated/consolidated invoicing across multiple trips (Phase 2).
- Customer self-serve payment portal (exists in part — Phase 2 will deepen).
- Direct general-ledger posting (operator exports CSV to QuickBooks/Tally — accounting sync model already covers this).

---

## §8 Dependencies

- **PRD_TRAVEL_GST_COMPLIANCE.md** — GST line shapes + CGST/SGST/IGST split + place-of-supply rules. Billing PRD assumes those line shapes are already wired.
- **PRD_TRAVEL_QUOTE_BUILDER.md** — Quote → Invoice conversion path; per-pax/per-room line types carry from quote.
- **PRD_TRAVEL_SUPPLIER_MASTER.md** (this tick) — Supplier model + paymentTermsDays. Required for FR-3.5 supplier-payable workflow.
- **Currency table** — already exists (`Currency` model with FX rates).
- **Payment model** — extend (NOT fork) — add `paymentScheduleId` FK + lock `fxRate` per Payment.
- **AuditLog** — existing; extend `entityType` enum coverage.
- **Notifications service** — existing; extend templates for milestone reminders + cancellation acks.
- **AccountingSync model** — already maps `Invoice → external ID`; extend coverage to `CreditNote` + `SupplierPayable`.

---

## §9 Open questions

- **OQ-9.1** Should we surface an "approaching TCS threshold" warning to operator BEFORE invoice issue (e.g. "this customer is at ₹6.8L FY, this invoice will trigger TCS")? Helps operator give the customer accurate quote-time pricing.
- **OQ-9.2** Refund-after-cancellation display: gross-refund minus retention (₹100 − ₹30 = ₹70 refund) vs net-of-retention (₹70 owed-back-to-customer)? Customer-facing display impact.
- **OQ-9.3** Should supplier-payable workflow trigger off PO creation (when we book / pre-pay) or invoice creation (when customer pays)? Cashflow-timing implications differ.
- **OQ-9.4** Multi-currency single invoice UX: 2 currency fields per line (declare-upfront-split) vs split-on-pay (customer chooses at milestone-time)? Recommend split-on-pay (matches operator practice).
- **OQ-9.5** Cancellation-policy table: per-tenant template (one policy) or per-sub-brand (separate policies per Travel Stall / RFU / TMC)? Recommend per-sub-brand.
- **OQ-9.6** Settlement timeline UI in customer portal: full Gantt-style with future milestones surfaced, OR only-show-current-milestone? Privacy + manipulability trade-off.
- **OQ-9.7** Numbering scheme — what happens at FY rollover with mid-year-issued invoices? Hard cut on Apr-1 (Indian FY)?
- **OQ-9.8** Should TCS line be visible on customer-facing PDF or operator-only? Indian compliance requires customer visibility; confirm with tax advisor.

---

## §10 Status snapshot

### 2026-05-24 update #2 — Routes + admin UI

**Backend routes shipped:** `backend/routes/travel_invoices.js` at commit `b2a9dcb`. CRUD scaffold (GET list/detail, POST create with auto-generated TINV-YYYY-NNNN serial, PUT with forward-only status-transition matrix, DELETE on Draft only). 10/10 vitest pass.

**Admin UI shipped (or in-flight):** `frontend/src/pages/travel/InvoicesAdmin.jsx` shipping this tick by sibling agent — mirrors the SuppliersAdmin / QuotesAdmin pattern. Mounted at `/travel/invoices-admin`. Status badges colored Draft/Issued/Partial/Paid/Voided; delete enabled only on Draft per backend constraint.

**Invoice numbering decision (post-resolution architectural finding):** TINV-YYYY-NNNN serial reset annually, race-safe via `prisma.$transaction` + `@@unique([tenantId, invoiceNum])` schema backstop. Mirror this pattern when future PRDs need tenant-scoped human-readable IDs (e.g. supplier-payable receipts, expense reports).

**Status transition matrix (committed in backend):** Draft → {Issued, Voided}; Issued → {Partial, Paid, Voided}; Partial → {Paid, Voided}; Paid → {Voided}; Voided → ∅. Forward-only with universal Voided escape; backward transitions rejected with 422 INVALID_INVOICE_TRANSITION.

**Still pending (per the existing 2026-05-24 entry):**
- DD-5.2 through DD-5.7 — PRD-internal details (cancellation policy, reminder cadence specifics, per-sub-brand PDF templates DD-5.7 gates on Yasin Q22).
- Multi-stage settlement schedules (PRD §3.2)
- Supplier-payable ledger reconciliation (PRD §3.3 cross-PRD with Supplier Master)
- TCS Sec 206C (PRD §3.5)
- Payment-collection webhook (depends on #896 Stripe/Razorpay activation, cred-blocked)
- Reminder cadence (DD-5.5 RESOLVED: hard-coded T-7/T-3/T-1)

**Path to next implementation slice:** Real TravelInvoice fields per §3 spec — line items + tax breakdown (cross-PRD with GST) + supplier-payable detail. ~2-3 days for the line-items expansion alone.

### 2026-05-24 update

**DD-5.1 RESOLVED:** FORK — `TravelInvoice` shipped at commit `fdb793e` (~85 LOC across the 3 trio models with `TravelQuote` + `TravelSupplier`). Tenant inverse relation threaded into the travel-vertical cluster. `prisma validate` clean.

**What's now possible:**
- Backend routes can be scaffolded against the new model — `routes/travel_invoices.js` (CRUD + milestone-pay + cancel + Aged-Receivable + Form 27EQ) follows in subsequent commits.
- Frontend can wire an invoice-builder + milestone-view + aged-report UI to the new model once routes exist.
- Sub-brand isolation enforced at the schema level (`subBrand` indexed; `@@index([tenantId, subBrand])`).
- Per-sub-brand gap-less numbering (FR-3.8.c) can ship against the new model without polluting generic `Invoice.invoiceNum @unique`.

**Still pending (PRD-internal DD-5.2 through DD-5.7):**
- **DD-5.2** — Schedule template ownership (admin-curated with operator-override recommended).
- **DD-5.3** — Reporting currency precedence (sub-brand-home with operator-override recommended).
- **DD-5.4** — TCS verification source (manual flag + import-CSV path; Q-BILL-1 cred chase still open).
- **DD-5.5** — Reminder cadence + channel (hard-coded T-7/T-3/T-1, all-channels-on with operator opt-out).
- **DD-5.6** — Cancellation-policy editor UI scope (admin-only recommended — policies are legal contract terms).
- **DD-5.7** — Per-sub-brand PDF branding (blocked on Yasin's Q22 brand handover; can ship placeholder).
- Per-PRD field expansion: real §3 fields (TCS, multi-stage settlement, supplier-payable, multi-currency split, per-sub-brand numbering, doc-type taxonomy) land across the existing Phase 1–5 plan in §10 (12-20 days post DD-5.1 land).

**Path to implementation:** Phase 1 (line-items + per-sub-brand numbering + doc-type enum) = 5d. Phase 2 (settlement schedule + reminders + receipt PDFs) = 4d. Phase 3 (TCS + multi-currency) = 3d. Phase 4 (supplier-payable + Aged reports — depends on `TravelSupplier` routes from sibling PRD) = 4d. Phase 5 (cancellation + CR-NOTE) = 2d. **Payment-collection wiring depends on the cross-cutting per-tenant cap pattern (commit `d8119a1`) + Stripe/Razorpay activation per #896 (cred-blocked).**

- **Current (pre-fdb793e baseline, retained for history):** Generic `Invoice` + `Payment` models shipped; tick #18 added `invoice.created` webhook; `legalEntityCode` exists but numbering is flat-global; per-pax + multi-currency + TCS + supplier-payable + settlement-schedule + doc-type enum + per-sub-brand numbering ALL missing.
- **This PRD:** WRITTEN 2026-05-23 (tick #20 / Agent 1).
- **Path to implementation:** **12–20 engineering days** (heavier if DD-5.1 picks FORK — adds ~5d for new `TravelInvoice` model + parallel routes + frontend conditional rendering by `tenant.vertical`).
- **Sibling PRDs:** PRD_TRAVEL_GST_COMPLIANCE.md (tax math; tick #19), PRD_TRAVEL_QUOTE_BUILDER.md (quote → invoice path; tick #19), PRD_TRAVEL_SUPPLIER_MASTER.md (supplier-payable side; this tick).
- **Blocks:**
  - DD-5.1 (fork vs extend) BEFORE backend impl — schema decision is the longest-tail dependency.
  - DD-5.7 (Yasin's branding handover, Q22) BEFORE PDF template work — can ship placeholder.
  - Q-BILL-1 (TCS tax-filer source) BEFORE FR-3.4.b's 20% non-filer rate path — manual flag as workaround.
- **Implementation phasing recommendation:**
  - **Phase 1 (5d):** Line-items + per-sub-brand numbering + doc-type enum (FR-3.1, FR-3.8). Lowest-risk, unblocks Quote → Invoice handoff.
  - **Phase 2 (4d):** Settlement schedule + reminders + receipt PDFs (FR-3.2). Highest customer-value.
  - **Phase 3 (3d):** TCS + multi-currency (FR-3.3, FR-3.4). Compliance-driven.
  - **Phase 4 (4d):** Supplier-payable + Aged reports (FR-3.5, FR-3.6). Requires #903 supplier model first.
  - **Phase 5 (2d):** Cancellation + CR-NOTE flow (FR-3.7). Smallest scope.

---

## §11 Implementation notes (advisory — design call still needed)

### Schema-sketch (note: DD-5.1 RESOLVED to FORK on 2026-05-24 — `TravelInvoice` landed at `fdb793e`; the sketch below was authored pre-fork and needs to be re-anchored to `TravelInvoice` + companion child models in the routes-scaffold phase)

```prisma
// New model — child of Invoice
model InvoiceLine {
  id             Int      @id @default(autoincrement())
  invoiceId      Int
  invoice        Invoice  @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  lineType       String   // per_pax|per_room|per_night|per_trip|tax|fee|addon|tcs|tds
  description    String
  quantity       Decimal  @db.Decimal(12, 2)
  unitPrice      Decimal  @db.Decimal(14, 2)
  currency       String   @default("INR")
  lineTotal      Decimal  @db.Decimal(14, 2)
  // Travel-specific
  pnrRef         String?
  supplierId     Int?
  supplier       Supplier? @relation(fields: [supplierId], references: [id], onDelete: SetNull)
  serviceStartDate DateTime?
  serviceEndDate   DateTime?
  isAddon        Boolean  @default(false)
  // Margin tracking
  lineCost       Decimal? @db.Decimal(14, 2)
  // GST breakdown (filled by GST PRD's place-of-supply rules)
  taxableValue   Decimal? @db.Decimal(14, 2)
  cgstPercent    Decimal? @db.Decimal(5, 2)
  sgstPercent    Decimal? @db.Decimal(5, 2)
  igstPercent    Decimal? @db.Decimal(5, 2)
  taxAmount      Decimal? @db.Decimal(14, 2)
  hsnSac         String?
  displayOrder   Int      @default(0)
  @@index([invoiceId, displayOrder])
}

// New model — child of Invoice
model PaymentSchedule {
  id               Int       @id @default(autoincrement())
  invoiceId        Int
  invoice          Invoice   @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  milestoneOrder   Int       // 1, 2, 3...
  dueDate          DateTime
  expectedAmount   Decimal   @db.Decimal(14, 2)
  expectedCurrency String    @default("INR")
  status           String    @default("pending") // pending|partial|paid|overdue|waived
  paidAmount       Decimal   @db.Decimal(14, 2) @default(0)
  paidAt           DateTime?
  // Anchor-relative due-date (FR-3.2.e)
  anchorType       String?   // bookingDate|departureDate|returnDate|fixed
  anchorOffsetDays Int?
  // Optimistic lock (NFR-4.4)
  version          Int       @default(0)
  @@index([invoiceId, milestoneOrder])
  @@index([status, dueDate]) // for reminder cron
}

// New model — supplier A/P side
model SupplierPayable {
  id                  Int       @id @default(autoincrement())
  invoiceLineId       Int       // origin (FR-3.5.a)
  invoiceLine         InvoiceLine @relation(fields: [invoiceLineId], references: [id], onDelete: Cascade)
  supplierId          Int
  supplier            Supplier  @relation(fields: [supplierId], references: [id], onDelete: Restrict)
  payableAmount       Decimal   @db.Decimal(14, 2)
  currency            String    @default("INR")
  dueDate             DateTime
  status              String    @default("pending") // pending|scheduled|paid|disputed
  internalPONumber    String?
  supplierInvoiceRef  String?   // their reference number
  supplierInvoicePdf  String?   // uploaded attachment ID
  prePayment          Boolean   @default(false) // FR-3.5.d
  disputeReason       String?
  resolution          String?   // resolved_paid|resolved_reduced|resolved_voided
  paidAt              DateTime?
  tenantId            Int       @default(1)
  tenant              Tenant    @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  @@index([tenantId, status, dueDate])
  @@index([supplierId, status])
}

// New model — gap-less per-sub-brand numbering
model InvoiceNumberSeries {
  id              Int    @id @default(autoincrement())
  tenantId        Int
  subBrandCode    String // TS, RFU, TMC, VS
  fy              String // 26-27
  docType         String // tax_invoice|proforma|credit_note|debit_note|hotel_voucher|...
  lastNumber      Int    @default(0)
  @@unique([tenantId, subBrandCode, fy, docType])
}

// Extend Invoice
model Invoice {
  // ... existing fields ...
  docType         String  @default("tax_invoice") // FR-3.8.a
  displayCurrency String  @default("INR")
  subBrandCode   String?  // TS|RFU|TMC|VS
  fyCode          String? // 26-27
  // Existing legalEntityCode stays
  lines           InvoiceLine[]
  schedules       PaymentSchedule[]
}

// Extend Payment
model Payment {
  // ... existing fields ...
  paymentScheduleId Int?
  paymentSchedule   PaymentSchedule? @relation(fields: [paymentScheduleId], references: [id], onDelete: SetNull)
  fxRate            Decimal? @db.Decimal(12, 6) // locked rate at payment-time vs displayCurrency
  fxRateToCurrency  String?  // operator's reporting currency at lock-time
}

// Extend Contact
model Contact {
  // ... existing fields ...
  tcsTaxFilerStatus String? // FILER|NON_FILER|UNKNOWN (default UNKNOWN)
  panNumber         String? // for TCS reporting
}
```

### Cron engines (new)
- `paymentScheduleReminderEngine.js` — every 15 min; T-7/T-3/T-1 milestone reminders.
- `overdueMilestoneEngine.js` — every 60 min; flips `pending` → `overdue` past `dueDate`; fires escalation chain.
- Extend `recurringInvoiceEngine.js` — recurring invoices to honour new schedule templates.

### Routes (new + extended)
- `POST /api/travel/invoices` — create with lines + schedule template.
- `POST /api/travel/invoices/:id/milestones/:n/pay` — record payment against milestone, lock FX, increment schedule.version.
- `POST /api/travel/invoices/:id/cancel` — apply cancellation policy → issue CR-NOTE.
- `GET /api/travel/reports/aged-receivable` — bucketed by sub-brand / customer / age.
- `GET /api/travel/reports/aged-payable` — bucketed by sub-brand / supplier / age.
- `GET /api/travel/tcs/27eq?fy=&q=` — Form 27EQ-ready TCS report.

### Test surface (target)
- ~30 unit tests under `backend/test/lib/` (number generator, TCS computer, FX locker, cancellation calculator, schedule expander).
- ~15 Playwright API specs under `e2e/tests/travel-invoice-*.spec.js` covering each AC.
- ~3 frontend vitest specs for invoice-builder + milestone-view + aged-report UI.
