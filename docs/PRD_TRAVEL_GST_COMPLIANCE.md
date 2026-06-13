# Travel GST & Compliance Module — Product Requirements

Status: DRAFT (written 2026-05-23, tick #19)
Source: GH #902 (P1 Travel Gap audit) + Travel Stall CRM — Implementation & Modification Roadmap, Tier P1 item 7
Mount: `/api/finance/tax/*` (backend) + `/finance/tax` (frontend, Settings → Compliance subnav)
Owner: backend = Travel CRM core; product call needed on DD-5.1 / DD-5.2 / DD-5.4 (see §5)
Phase: pre-implementation — needs DD-5.4 + Q-GST-2 BEFORE backend work begins

---

## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 24 |
| ✅ Shipped | 13 (54%) |
| 🟡 Partial | 4 |
| 🔌 Stub | 3 |
| ❌ Missing | 4 |
| **Net gap** | **11 items** (~5.5 eng-days + DD-5.2 + Q-GST-2/3/4 creds) |
| Primary blocker | `TaxRateMaster` model (DD-5.2 — rates currently hard-coded in `gstCalculation.js` with TODO comment at `routes/travel_invoices.js:6991`); customer-ledger / TDS register / commission-ledger endpoints; per-line GST persistence |

Shipped: GSTR-1 / GSTR-3B / HSN-summary / TCS-27EQ exports, GSTIN format+checksum validator wired into 5 consumers, Tally XML + CA CSV travel-invoice exporters (post-PR #1150).

**Single source of truth for all gap items:** [TRAVEL_GAP_CLOSURE_TRACKER.md §3.5 + §4 + §5.OTHER](TRAVEL_GAP_CLOSURE_TRACKER.md).

---

## 1. Background

### India GST regime (intro for non-India readers)

India's Goods & Services Tax (GST) replaced the legacy VAT/Service Tax/CST patchwork in July 2017. It's a destination-based, value-added consumption tax with four tax slabs:

- **0% / Exempt** — essential goods, education, healthcare (limited)
- **5%** — most travel services (air tickets economy, hotel rooms <₹1000/night, tour packages)
- **12%** — hotel rooms ₹1000–₹7500/night, business-class air, restaurant non-AC
- **18%** — hotel rooms ₹7500+, AC restaurants, most B2B services, visa processing fees
- **28%** — luxury goods, hotel rooms ₹7500+ in some classifications (rare for travel)

For services, the classification key is **SAC (Services Accounting Code)** — a 6-digit code maintained by CBIC. For goods it's **HSN (Harmonized System of Nomenclature)** — also CBIC-published. Travel services predominantly fall under SAC 9985 (tour operator) and SAC 9964 (passenger transport).

The tax-routing depends on **place of supply**:
- **Intra-state** (tenant state == customer state): split into CGST (Centre) + SGST (State), each half the slab rate. e.g. 18% slab → 9% CGST + 9% SGST.
- **Inter-state** (tenant state != customer state): single IGST line at the full slab rate. e.g. 18% slab → 18% IGST.
- **Export of service** (customer outside India): 0% (zero-rated) under LUT (Letter of Undertaking); refund of input tax credit available.

Returns:
- **GSTR-1** — monthly (or quarterly under QRMP for small taxpayers) outward-supplies return. Lists every B2B invoice + bucketed B2C summary.
- **GSTR-3B** — monthly summary return. Total liability + ITC + RCM + net payable.

### Travel-vertical implications

The Travel CRM serves 4 sub-brands operating primarily in India:
- **TMC** (TMC Nexus, school-trip operator) — bookings are B2B (schools) + B2C parents
- **RFU** (Labbaik Travels, Umrah operator) — bookings are B2C primarily, sometimes B2B (group leaders)
- **Travel Stall** (parent brand, family holidays) — B2C primarily
- **Visa Sure** (visa-only services) — B2C primarily

Per Q9/Q14/Q21 product decisions, each sub-brand operates under its own legal entity + its own GSTIN. A single CRM tenant can therefore issue invoices under 4 distinct GST registrations. GSTR-1/3B returns are filed PER GSTIN, not per tenant — the module must bucket invoices by `Invoice.legalEntityCode` for GSTR generation.

### Current state of CRM (verified 2026-05-23 against schema.prisma)

What's shipped:
- `Tenant.subBrandConfigJson` (line 170) — keyed by sub-brand, stores per-brand legal entity + GSTIN + Wati WABA + Drive folder + microsite domain. The slot for per-brand GSTIN already exists; awaiting hand-over docs to populate.
- `Invoice.legalEntityCode` (line 822) — nullable; routes Travel invoices to the right legal entity/GSTIN. Non-travel invoices ignore.
- `Patient.gst` (line 2574, `@db.VarChar(15)`) — 15-char GSTIN field on patients (wellness vertical, since #792). Stored canonically upper-cased.
- `ItineraryItem.gstAmount` (line 4234, `Decimal(15,2)`) — per-line GST amount on travel itinerary items.
- `Vendor.gstin` (line 3335) — supplier GSTIN.

What's missing (the gap this PRD addresses):
- No HSN/SAC code field on Product, Service, ItineraryItem, or Invoice line items
- No tax-rate master table (configurable per HSN/SAC + effective dates)
- No place-of-supply routing logic (CGST+SGST vs IGST decision)
- No `Tenant.state` field (Location.state exists but tenant-level home state for IGST routing does not)
- No `Contact.state` or billing-state field on contacts (would be needed for B2C IGST routing)
- No GSTR-1 / GSTR-3B export endpoints
- No GSTIN format validation in any route handler (gst column is stored but not checked)
- No RCM (Reverse Charge Mechanism) flag on invoices or line items
- No HSN-wise / SAC-wise summary report
- No commission / IATA-incentive ledger (per #902 acceptance criteria)
- No TCS / TDS register

---

## 2. Use cases

**UC-2.1 — TMC operator issues B2B tax invoice to a school in same state**
A school in Tamil Nadu books a TMC tour for 40 students. TMC's legal entity (TMC Nexus) is registered in Tamil Nadu. Operator creates invoice with line items: tour package (SAC 9985, 5% slab), travel insurance (SAC 9971, 18% slab). Place-of-supply matches tenant state → split into CGST 2.5% + SGST 2.5% on tour; CGST 9% + SGST 9% on insurance. Invoice PDF shows GSTIN of both buyer + seller, line-wise SAC + tax split. School's accountant uses ITC against output liability.

**UC-2.2 — RFU operator issues B2C invoice to an Umrah pilgrim in different state**
A pilgrim from Karnataka books an Umrah package. RFU's legal entity (Labbaik Travels) is registered in Telangana. Operator issues invoice; tax engine routes → 5% IGST (inter-state). Invoice PDF shows IGST line only (no CGST/SGST). Pilgrim is unregistered (B2C) → no GSTIN on buyer side; the row aggregates into GSTR-1 B2C-large bucket if invoice value > ₹2.5L, B2C-small (state-wise summary) otherwise.

**UC-2.3 — VisaSure operator issues invoice to a foreign-passport-holder applicant for visa-to-India processing**
A customer in Dubai applies for an Indian e-visa via VisaSure. Place-of-supply = location of recipient = outside India. Tax engine routes → 0% (export of service). Invoice carries the LUT reference number. Row aggregates into GSTR-1 export-of-service bucket. Refund of accumulated ITC claimable.

**UC-2.4 — Accountant generates month-end GSTR-1 for Travel Stall sub-brand**
End of month, the accountant filters Finance > Tax > GSTR-1 by sub-brand=travelstall + period=2026-05 → backend pulls all invoices where `legalEntityCode='travel_stall_parent'` AND `issuedDate` in [May 1, May 31] AND `status IN ('PAID','UNPAID')` (excluding VOIDED). Output is a govt-spec JSON (GSTR-1 v2.0 schema) sectioning B2B / B2C-large / B2C-small / export / credit-notes / nil-rated. Downloaded → uploaded to GSTN portal directly or routed through ClearTax/Masters India connector.

**UC-2.5 — Accountant generates GSTR-3B summary across all 4 sub-brands**
Each sub-brand has its own GSTIN → each files its own GSTR-3B. Accountant runs the export per GSTIN. Output is a 4-row summary (outward taxable / outward zero-rated / outward exempt / inward RCM / ITC available). Net tax payable surfaced for cash-flow planning.

**UC-2.6 — Auditor queries per-customer ledger filtered by GSTIN + FY**
Compliance officer queries Finance > Tax > Customer Ledger > GSTIN=27ABCDE1234F1Z5 + FY=2025-26 → backend joins Invoice + Payment + ContactGstin → returns a tabular ledger (date, invoice number, taxable value, CGST, SGST, IGST, total, payment date) suitable for HSN-wise reconciliation.

**UC-2.7 — Admin updates tax-rate master after govt-notified slab change**
GST Council changes tour-package SAC 9985 from 5% to 12% effective from FY-future date. Admin adds new TaxRateMaster row: `sacCode='9985', rate=12, effectiveFrom='2026-04-01'`. Existing rows have `effectiveTo='2026-03-31'`. Invoice tax-calc resolves rate via `effectiveFrom <= issuedDate AND (effectiveTo IS NULL OR effectiveTo >= issuedDate)`. Past invoices unaffected. Action audit-logged with `actor=adminId, change=rate_5_to_12`.

---

## 3. Functional requirements

### FR-3.1 Tax-rate master (`TaxRateMaster` model)

- **FR-3.1.1** New Prisma model `TaxRateMaster { id, tenantId, hsnOrSacCode, codeType (HSN|SAC), rate (Decimal), description, effectiveFrom (DateTime), effectiveTo (DateTime?), isActive, createdBy, createdAt, updatedAt }`. Composite unique on `(tenantId, hsnOrSacCode, effectiveFrom)`.
- **FR-3.1.2** Seed govt-default slab rates for top-15 travel SAC codes (9985 tour operator, 9964 passenger transport, 9971 financial services / insurance, etc.) at tenant-create time.
- **FR-3.1.3** Admin UI: list / add / edit / soft-deactivate tax-rate rows. Edit creates a new row + closes the prior with `effectiveTo`. Direct UPDATE of `rate` on an existing row is disallowed (audit immutability).
- **FR-3.1.4** Service-category-default mapping: `ServiceCategory.defaultSacCode` column added so invoice-line auto-picks SAC from the product/service category.

### FR-3.2 Invoice tax-line generation

- **FR-3.2.1** Extend Invoice with `placeOfSupply (String — state code)`, `taxableValue (Decimal)`, `cgstAmount (Decimal)`, `sgstAmount (Decimal)`, `igstAmount (Decimal)`, `cessAmount (Decimal?)`, `rcmFlag (Boolean default false)`, `isExport (Boolean default false)`, `lutReference (String?)`.
- **FR-3.2.2** New model `InvoiceLineItem { id, invoiceId, description, hsnOrSacCode, codeType (HSN|SAC), quantity, unitPrice, lineTotal, taxRate (Decimal — looked up from TaxRateMaster), cgstAmount, sgstAmount, igstAmount, rcmFlag }`. Replaces the current single-line Invoice.amount model.
- **FR-3.2.3** Tax-routing logic in `backend/lib/gstTaxRouter.js`: input = (sellerStateCode, buyerStateCode, buyerCountry, rateSlab) → output = `{ cgst, sgst, igst, isExport }`. Pure function. Unit-tested across 8 scenarios (intra/inter/export × B2B/B2C).
- **FR-3.2.4** Composite vs mixed supply: when an invoice has multiple line items at different rates, each line is taxed at its own rate; no "single dominant rate winner" logic (the alternative is operator-error-prone). Composite-supply classification stays at line-item time, not invoice time.
- **FR-3.2.5** Invoice PDF render shows per-line HSN/SAC, taxable value, rate %, CGST/SGST/IGST breakup, total. Invoice header includes buyer GSTIN + seller GSTIN + place of supply.

### FR-3.3 GSTIN validation + reverse-check

- **FR-3.3.1** Helper `backend/lib/gstinValidator.js`: validates 15-char GSTIN format (regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$`) + checksum digit per GSTN spec (algorithmic).
- **FR-3.3.2** Wire validator into all GSTIN-write sites: Contact (new column needed), Patient.gst, Vendor.gstin, Tenant.subBrandConfigJson per-brand GSTIN, Contact billing GSTIN.
- **FR-3.3.3** Optional: real-time GSTIN reverse-check via 3rd-party API (ClearTax / Masters India / GSTN direct) — looks up legal name + state + status (Active/Cancelled). Cred-dependent (Q-GST-2). When disabled, format-validation only.
- **FR-3.3.4** New column `Contact.gstin (String? @db.VarChar(15))` + `Contact.billingStateCode (String?)` for B2B contact billing.

### FR-3.4 Returns + reports

- **FR-3.4.1** `GET /api/finance/tax/gstr-1?subBrand=&period=YYYY-MM&format=json|csv` — bucketed outward supplies. Buckets: b2b (registered customers), b2cl (B2C unregistered, invoice > ₹2.5L, inter-state, sectioned by state), b2cs (B2C unregistered, intra-state OR inter-state ≤ ₹2.5L, summarised state-wise + rate-wise), exp (export of service), cdnr (credit-debit notes registered), cdnur (credit-debit notes unregistered), nil-rated, hsn (HSN-wise summary). Output schema mirrors GSTN GSTR-1 v2.0 JSON.
- **FR-3.4.2** `GET /api/finance/tax/gstr-3b?subBrand=&period=YYYY-MM` — summary: 3.1.a outward taxable supplies; 3.1.b outward zero-rated; 3.1.c outward nil-rated/exempt; 3.1.d inward RCM; 3.2 inter-state supplies to unregistered; 4 ITC available; 5 exempt/nil inward; 6.1 net payable.
- **FR-3.4.3** `GET /api/finance/tax/hsn-summary?subBrand=&period=YYYY-MM` — group-by HSN/SAC, sum taxable + CGST + SGST + IGST.
- **FR-3.4.4** `GET /api/finance/tax/customer-ledger?gstin=&fy=2025-26` — per-buyer-GSTIN ledger across the FY.
- **FR-3.4.5** `GET /api/finance/tax/tcs-register?subBrand=&period=YYYY-MM` — TCS collected (1% on outward supplies > ₹50L per buyer). Required for #902 acceptance.
- **FR-3.4.6** `GET /api/finance/tax/tds-register?subBrand=&period=YYYY-MM` — TDS deducted-by-customer. Required for #902 acceptance.
- **FR-3.4.7** `GET /api/finance/tax/commission-ledger?subBrand=&period=YYYY-MM` — commissions earned from suppliers / IATA incentives. Required for #902 acceptance.

### FR-3.5 Place-of-supply rules

- **FR-3.5.1** New `Tenant.stateCode (String?)` field — 2-char India state code (e.g. "27" for Maharashtra, "33" for Tamil Nadu). Each sub-brand can override via `subBrandConfigJson.<brand>.stateCode`.
- **FR-3.5.2** Place-of-supply derivation: for services, use buyer's state-of-residence (Contact.billingStateCode) unless dominant service rendered elsewhere (e.g. visa for a different jurisdiction). Default = buyer state.
- **FR-3.5.3** Foreign-customer detection: `Contact.country != 'IN'` → invoice flagged `isExport=true`, 0% slab, LUT reference required.

### FR-3.6 Admin + audit

- **FR-3.6.1** Tax-rate changes audit-logged via `AuditLog` model. Actor + before/after rate + effectiveFrom written. Read by Finance > Audit subnav.
- **FR-3.6.2** GSTIN changes (Contact/Tenant) audit-logged.
- **FR-3.6.3** Manual GSTR-1/3B regeneration logs the run actor + period + sub-brand for reproducibility.

---

## 4. Non-functional requirements

- **NFR-4.1** Reports must export in govt-spec format. GSTR-1 = GSTN JSON v2.0 schema. CSV alternative for offline review. Excel format only via Software handover (Q21, see DD-5.4).
- **NFR-4.2** Tax-calculation is deterministic + reproducible. Given (line items, dates, place-of-supply, rate-master state at that date), output is invariant. Re-running GSTR-1 export for a past period produces byte-identical output (modulo non-data fields like generation timestamp).
- **NFR-4.3** Tax-rate changes require ADMIN role + audit log entry. MANAGER/USER are read-only.
- **NFR-4.4** Multi-currency: GST is only computed on INR-denominated invoices. Foreign-currency invoices are treated as export-of-service (0%) regardless of buyer location, since the route-side has no FX-conversion-to-INR responsibility (operator manually re-issues in INR if needed).
- **NFR-4.5** Performance: GSTR-1 export for a tenant with 10K invoices in <30s on a 4-vCPU box. Indexes: `Invoice (tenantId, legalEntityCode, issuedDate, status)` already present; add `InvoiceLineItem (invoiceId, hsnOrSacCode)`.
- **NFR-4.6** Tax-rate master rows are append-only (logically). The Admin UI never UPDATEs a rate row; instead it closes the old + appends a new with the same code. Enforced at route layer.
- **NFR-4.7** Place-of-supply data is mandatory on Travel-vertical invoices (validation 400 if missing). Wellness invoices are exempt for backward-compat (the existing wellness PDF generator pre-dates GST module — see FR-3.6.3 backfill).
- **NFR-4.8** Foreign-customer LUT reference is validated against the tenant's stored LUT number (Tenant.lutReference); missing or expired LUT → 400 with actionable error.

---

## 5. Hand-over requirements / cred chase / design decisions

### Design decisions needed (BLOCK implementation)

- **DD-5.1** GSTN portal real-time GSTIN reverse-check vendor: ClearTax SaaS, Masters India SaaS, GSTN direct API, or none-at-launch (format-validation only)? Each vendor has different SLA + pricing + onboarding-friction. Recommend Masters India for low-volume reverse-checks (~₹2K/mo for first 5K calls).
- **DD-5.2** Tax-rate maintenance UI vs hardcoded JSON: Who maintains the rate master when GST Council updates slabs? Options: (a) operator-maintained via Admin UI (this PRD's default — needs FR-3.1.3 Admin screen); (b) hardcoded JSON in repo + redeploy (Globussoft-maintained, simpler but slower rollout); (c) externally managed via 3rd-party (ClearTax tax-engine SaaS — outsource entirely). Recommend (a) for operator agency; (b) if Globussoft staff are willing to commit to <24hr response on slab changes.
- **DD-5.3** RCM (Reverse Charge Mechanism) auto-flag policy: which service categories default to RCM? RCM is rare in travel but applies for: legal services > ₹5K, supplies from unregistered vendors > ₹5K/day. Recommend operator-toggled per-invoice (no auto-flag); audit-logged.
- **DD-5.4** GSTR-1 / GSTR-3B export delivery: direct GSTN portal upload (cred-blocked Q-GST-1), via ClearTax/Masters India connector (cred-blocked Q-GST-2), or via "Excel Software" external CA handover (Q21 already-pending product call)? Each path has different effort budget: direct GSTN = ~3 days connector dev + cred; ClearTax = ~2 days connector + ₹monthly fee; Excel handover = ~0.5 days (CSV download, CA uploads manually). Recommend Excel handover at launch (Q21 already in flight), promote to direct upload in a follow-up.
- **DD-5.5** Backward-compat for existing invoices without HSN/SAC: backfill via service-category mapping or block? Existing Invoice rows in production demo + customer tenants have no HSN/SAC. Options: (a) backfill via `ServiceCategory.defaultSacCode` (works for catalog-driven invoices); (b) leave NULL + treat as "unclassified, default 18% slab" until next operator edit; (c) hard-block GSTR generation until backfill. Recommend (a) + (b) combo: backfill where possible, default-unclassified-18% for the rest, surface a "Needs HSN review" badge on invoice list.
- **DD-5.6** GSTR-1 cadence: monthly vs QRMP (quarterly with monthly tax payment)? QRMP is opt-in for taxpayers with turnover < ₹5Cr; each sub-brand may elect separately. Module must respect per-sub-brand cadence. Default = monthly; operator toggles via Settings > Compliance.

### Cred chase

- **Q-GST-1** GSTN portal direct API access — requires business registration with GSTN as a GSP (Goods & Services Tax Suvidha Provider) or licensing via an existing GSP. Material cost + onboarding-time (~6-12 weeks). NOT recommended at launch.
- **Q-GST-2** GSTIN reverse-check API key — vendor TBD per DD-5.1. ClearTax: dev sandbox free, prod ₹2K-5K/mo. Masters India: similar pricing.
- **Q-GST-3** Per-sub-brand GSTIN values (TMC, RFU, Travel Stall, Visa Sure) — slot exists in `Tenant.subBrandConfigJson.<brand>.gstin`; awaiting hand-over from Travel Stall product team (tied to Q9/Q14 hand-over package).
- **Q-GST-4** LUT (Letter of Undertaking) reference per sub-brand — required for export-of-service zero-rating. Operator self-files annually with GSTN; ID surfaced on every export invoice.

### Vendor docs

- GSTN GSTR-1 v2.0 schema: public, [gstn.gov.in](https://gstn.gov.in) (look for "GSTR-1 JSON Schema")
- GSTN GSTR-3B schema: public, same source
- ClearTax API reference: api.cleartax.in (registration-gated)
- Masters India API reference: mastersindia.co/dev-portal (registration-gated)
- GSTIN format spec + checksum algorithm: public, CBIC notification 39/2017

---

## 6. Acceptance criteria

- **AC-6.1** B2C customer in same state as sub-brand tenant state → invoice line with 18% slab is split into 9% CGST + 9% SGST. Zero IGST.
- **AC-6.2** B2C customer in a different state from sub-brand tenant state → invoice line with 18% slab routes entirely to 18% IGST. Zero CGST/SGST.
- **AC-6.3** B2C customer in a country other than India → invoice routes to 0% (export-of-service), `isExport=true` flag set, LUT reference required.
- **AC-6.4** Invalid GSTIN (bad checksum digit or wrong format) on Contact write → 400 with `error: { code: 'INVALID_GSTIN', detail: '...' }`.
- **AC-6.5** GSTR-1 export for a month with 50 invoices across all 4 sub-brands returns a govt-spec JSON with separate top-level sections per sub-brand's GSTIN, where each section sums per-bucket (b2b / b2cl / b2cs / export / cdnr / hsn) correctly.
- **AC-6.6** A new tax-rate row with `effectiveFrom='2026-06-01'` on SAC 9985 does NOT affect any invoice issued before that date. Re-running GSTR-1 for May 2026 (period prior to slab change) reproduces the pre-change rate.
- **AC-6.7** Invoice with one RCM-flagged line item displays a "Reverse Charge: YES" marker on the PDF; the RCM line value appears in GSTR-3B section 3.1.d (inward RCM).
- **AC-6.8** Tax-rate change by Admin writes an AuditLog entry with `entityType='TaxRateMaster', action='RATE_CHANGED', actorId, beforeRate, afterRate, effectiveFrom`.
- **AC-6.9** Foreign-currency invoice (currency != INR) → GST calculation skipped, line `taxRate=null`, invoice flagged `isExport=true`.
- **AC-6.10** TCS register for a sub-brand period correctly identifies invoices to a single buyer exceeding ₹50L cumulative; flags TCS 1% on excess.

---

## 7. Out of scope

- **E-invoicing (IRN/QR generation)** — separate feature when invoice value > ₹5Cr threshold (₹100Cr in earlier phases). PR to follow as a Phase 3 item.
- **E-way bill generation** — only required for movement of goods > ₹50K; travel-services delivery rarely triggers this. Not in scope.
- **Income tax / TDS deducted-at-source (operator side)** — handled by external accounting, not this CRM. The TDS register in FR-3.4.6 only tracks TDS deducted *by customers* on payment to the tenant, not the tenant's outward TDS obligations.
- **GST audit defence / refund processing / appeals** — pure compliance workflow, not operator daily flow. Out of scope.
- **HSN classification advisory** — telling operator which SAC code to assign to a new service offering. Out of scope (operator decides; CRM stores).
- **State-specific cess** (e.g. Kerala flood cess) — not yet active for travel services; revisit if reintroduced.
- **GST registration assistance** — onboarding sub-brand legal entities is operator's CA's job; CRM only stores the resulting GSTIN.
- **Composition scheme accounting** — composition dealers pay flat-rate tax without ITC. Travel operators rarely qualify (most exceed ₹1.5Cr turnover). Out of scope.

---

## 8. Dependencies + downstream

### Upstream dependencies

- `Invoice` model (verified — line 805) — needs schema extension per FR-3.2.1
- `InvoiceLineItem` model — new (replaces single-line Invoice.amount)
- `Tenant.subBrandConfigJson` (verified — line 170) — slot for per-sub-brand GSTIN + stateCode
- `Tenant.stateCode` — new column
- `Contact.gstin` + `Contact.billingStateCode` — new columns
- `Patient.gst` (verified — line 2574) — already exists, validated by FR-3.3.2
- `ServiceCategory.defaultSacCode` — new column, used for FR-3.1.4 auto-pick
- `Vendor.gstin` (verified — line 3335) — for inward RCM tracking
- `Currency` model — used to detect INR vs foreign for NFR-4.4
- `AuditLog` (existing) — used for FR-3.6
- `gstTaxRouter.js` (new backend lib) — pure-function tax routing
- `gstinValidator.js` (new backend lib) — format + checksum

### Downstream consumers

- Invoice PDF generator (`backend/services/pdfRenderer.js` for wellness; travel branded PDF for travel) — needs HSN/SAC + GST breakup rendering
- Travel trip-billing route (`backend/routes/travel_trip_billing.js`) — needs to use the new tax router on auto-generated invoices
- ItineraryItem `gstAmount` column (verified — line 4234) — becomes computed-from-tax-router instead of hand-entered
- Settings UI > Compliance subnav — new sub-page for FR-3.1.3 + FR-3.6
- Finance > Tax dashboard — new top-level page at `/finance/tax`
- Excel Software handover (Q21) — alternative delivery path for GSTR-1 (DD-5.4)
- Customer-facing booking confirmation emails — show GSTIN + tax breakup

---

## 9. Open questions

- **OQ-9.1** Does Globussoft already use Excel Software for accounting integration? If yes, the GSTR-1 export should write directly into that pipe rather than building a parallel one. Pending product call.
- **OQ-9.2** Multi-tenant question: do TMC / RFU / Travel Stall / VisaSure file under separate GSTINs (4 returns/month) or under a single consolidated GSTIN (1 return/month)? Per Q9, the answer is separate — but confirm before backend work begins. If consolidated, the bucketing in FR-3.4.1 simplifies.
- **OQ-9.3** RCM scope: which service categories does the operator's CA expect to default-to-RCM? Operator-facing default may differ from per-CA preference. Pending Travel Stall + RFU + TMC CA consultations.
- **OQ-9.4** Composite-vs-mixed supply classification: should it be rule-driven (e.g. visa+insurance bundled defaults to dominant-service rate) or operator-decided per-invoice? Per FR-3.2.4 we default to per-line classification (no rule); confirm acceptable.
- **OQ-9.5** GSTR-1 monthly vs quarterly (QRMP) — should the module auto-detect cadence from Tenant.taxFilingCadence or require manual toggle? Recommend manual toggle + audit-log change.
- **OQ-9.6** LUT (Letter of Undertaking) auto-mark on export: when `Contact.country != 'IN'`, default to LUT-zero-rated, or require operator to explicitly tick "Export with LUT"? Auto-mark is faster; explicit tick is auditor-safer.
- **OQ-9.7** Backward-compat: see DD-5.5. Recommend backfill + 18% default + needs-review badge — but operator may prefer hard-block until backfill complete. Pending product call.
- **OQ-9.8** Wellness vertical: does wellness need GST module too (Rishu Enhanced Wellness has GSTIN per `Patient.gst` history)? If yes, scope expands. If no, gate the module on `Tenant.vertical IN ('travel')` at launch.

---

## 10. Status snapshot

- **Current**: limited shipped surface. `Tenant.subBrandConfigJson` slot for per-brand GSTIN exists (cred-blocked, Q9/Q14). `Invoice.legalEntityCode` for sub-brand routing exists (line 822). `Patient.gst` 15-char column exists (#792). `ItineraryItem.gstAmount` exists per-line. NO HSN/SAC, NO tax-rate master, NO GSTR-1/3B endpoints, NO tax-routing logic, NO GSTIN validation.
- **This PRD**: WRITTEN 2026-05-23 (tick #19, autonomous cron). Mirror of WHATSAPP_INTEGRATION_PRD.md 10-section template. ~400 lines.
- **Path to implementation**: 8-15 engineering days (depends on DD-5.4 — direct GSTN spec vs Excel Software handover). Phased rollout:
  - **Phase A (~3 days)**: schema migration (TaxRateMaster, InvoiceLineItem, Tenant.stateCode, Contact.gstin/billingStateCode, ServiceCategory.defaultSacCode), seed default rates, gstinValidator + gstTaxRouter libs + vitest.
  - **Phase B (~3 days)**: route handlers (`/api/finance/tax/*`), invoice PDF render updates, ESLint rule + Playwright API specs.
  - **Phase C (~2 days)**: Admin UI (Settings > Compliance, rate-master CRUD), Finance > Tax dashboard wireframe.
  - **Phase D (~5 days)**: GSTR-1 + GSTR-3B + HSN summary + TCS/TDS/Commission ledger export pipeline; Excel Software handover (Q21) integration OR ClearTax connector (DD-5.4).
  - **Phase E (~2 days, post-launch)**: GSTIN reverse-check (DD-5.1 + Q-GST-2), real-time validation.
- **Blocks**:
  - DD-5.4 product call required BEFORE Phase D (decides delivery path)
  - Q-GST-2 cred required for Phase E (reverse-check) — non-blocking for launch
  - Q-GST-3 + Q-GST-4 (per-sub-brand GSTIN + LUT) required for accurate GSTR-1 output
  - DD-5.1 / DD-5.2 / DD-5.5 / OQ-9.7 / OQ-9.8 product calls needed before Phase A schema work
- **Next steps**:
  1. Product call to disposition DD-5.1 through DD-5.6 + OQ-9.1 through OQ-9.8
  2. Cred chase Q-GST-3 (per-sub-brand GSTINs) via Travel Stall hand-over package
  3. Begin Phase A schema + lib work once design decisions land
  4. Q21 (Excel Software handover) — confirm Travel Stall has signed contract / spec

---

_Refs #902. Source-attribution: GH issue #902, Travel Stall CRM Roadmap Tier P1 item 7, schema.prisma verification at SHA d0a4e36._
