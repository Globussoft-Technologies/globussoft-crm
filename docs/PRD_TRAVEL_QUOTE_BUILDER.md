# Travel Quote Builder (`/quotes`) — Product Requirements

**Status:** DD-5.1 RESOLVED 2026-05-24 — `TravelQuote` Prisma model landed at commit `fdb793e`. Remaining DD-5.2..DD-5.6 pending. `/quotes` UI still resolves to `QuotesComingSoon.jsx` (BUG-T24 / #886) pending routes scaffold. Full module is tracked as cluster B2 in [docs/MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md). Estimated 10–18 engineering days; with DD-5.1 now landed, biggest remaining variable is DD-5.2 (pricing-engine UX). The existing `POST /api/travel/pricing/quote` engine + `TravelCostMaster` + `TravelSeasonCalendar` + `TravelMarkupRule` already provide most of the pricing primitives.

**Source:** GitHub #900 ([Travel Gap] P1 — Build the Quote Builder (/quotes)) + Travel Stall CRM — Implementation & Modification Roadmap (Google Doc) — Tier P1, item 5.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §5 (Sales workflow), §4 (Sub-brand routing), §6 (Pricing).

**Audience:** Backend engineering (route + Prisma model decisions), frontend engineering (3-pane builder UX), sub-brand leads (markup-rule maintenance), QA (acceptance criteria), Yasin / Rishu / RFU operator-leads (sub-brand-specific defaults).

---

## 1. Background

### 1.1 Today's surface

- **Route:** `/quotes` → `QuotesComingSoon.jsx` (a friendly "coming soon" page with CTAs pointing to `/estimates` and `/pipeline`). The sidebar's FINANCIAL → Quotes link previously rendered the SPA 404; the stub was the BUG-T24 / #886 fix (`frontend/src/App.jsx:760-768`).
- **Closest existing analogue:** `Estimates.jsx` — generic-CRM Estimate workflow with line items, Draft → Sent → Accepted → Rejected → Converted statuses, contact + deal linkage, PDF/CSV export, validity-window enforcement. The Prisma model is `Estimate` + `EstimateLineItem` (`backend/prisma/schema.prisma:1112-1143`). Lightweight: line item is just `description + quantity + unitPrice`. No category, no tax %, no currency, no per-pax pricing.
- **Travel pricing engine (already shipped):** `POST /api/travel/pricing/quote` (`backend/routes/travel_pricing.js:362-460`) composes a single-line quote from `TravelCostMaster` + `TravelSeasonCalendar` + `TravelMarkupRule`, returning `{ baseRate, season multiplier, markup amount, subtotal, grandTotal, warnings }` via `lib/travelPricing.js`. **Crucially, this is per-cost-row, not per-multi-line-quote — there is no aggregator that composes N lines into one Quote envelope today.**
- **Existing Prisma `Quote` + `QuoteLineItem`:** YES — already exist in schema (`1009-1035`). Tied to `Deal` (`dealId Int`, not nullable), no category, no currency, no tax, no validity, no PDF tracking. Used by an older flow that predates Estimates and is largely dormant; lighter than even Estimate. **DD-5.1 below resolves whether to extend this, extend Estimate, or fork.**

### 1.2 Why travel-grade quotes differ from generic Estimates

| Need | Generic Estimate today | Travel quote needs |
|------|------------------------|---------------------|
| Line items | description + qty + unitPrice | category (hotel/flight/transport/visa/insurance/activity/meal/transfer) + qty + unitPrice + currency + HSN/SAC + per-pax/per-room/per-night dimension |
| Pricing engine | manual unit-price entry | derived from `TravelCostMaster` + `TravelSeasonCalendar` + `TravelMarkupRule` per line, with manual override allowed |
| Currency | tenant default only (single currency) | per-line currency (operator may quote some lines USD, others INR), final total presentable in either |
| Tax | flat `taxRate` (single) | HSN-aware GST split (CGST+SGST vs IGST per #902 GST module) per line |
| Sub-brand context | none | line categories + templates differ per TMC / RFU / Travel Stall / Visa Sure |
| Itinerary linkage | none | optional `travelItineraryId` foreign key; line items grouped by Day or Category in UI |
| Sub-agent / B2B clone | none | sub-agent clones the rep's quote, applies own margin, presents to end customer |
| Customer accept flow | accept-link → status flips to Accepted | accept-link → status to Accepted → Invoice auto-created from line items |

### 1.3 Why a PRD for what looks like a CRUD form

#900's acceptance bullets list 12 distinct features (data model, pricing-engine reuse, line categories, 3-pane UI with day-grouping, status workflow, branded PDF, WhatsApp/Email send, convert-to-invoice, audit trail). The build-vs-extend decision (Estimate fork vs new `TravelQuote` model vs extending dormant `Quote`) is load-bearing for 10+ downstream questions (which routes mount where, which spec files own the contract, which PDF renderer template fires). Pinning that decision in §5 saves the implementation team a 1-2 day discovery cycle later.

---

## 2. Use cases

### 2.1 TMC sales rep — multi-leg school trip
Vinay builds a quote for a school's 7-day Europe trip — 50 students + 5 chaperones, 3 cities (London, Paris, Amsterdam). Line items: 4-night London hotel (12 rooms × 4 nights), 4-night Paris hotel, 4-night Amsterdam hotel, 3 inter-city Eurostar transfers (55 pax each), 2 day-tours per city. Per-pax pricing with a 50+ group discount auto-applied; sends a branded PDF to the school principal via email.

### 2.2 RFU sales rep — Umrah package
Asma builds an Umrah package quote — Makkah Hilton (3-night, Haram-facing room), Madinah Anwar Al Madinah (4-night), Zikr Cabs MAA↔JED airport transfers, Haramain HSR Makkah↔Madinah tickets, Umrah visa fee + service. Pricing engine pulls peak/ramadan-peak season multipliers from `TravelSeasonCalendar`. Customer sees the quote in their WhatsApp inbox via WABA, accepts → Deal auto-moves to "Booked" stage, Invoice created.

### 2.3 Travel Stall family-holiday agent
Priya runs the Travel Stall quiz diagnostic on a family lead (returns tier "Luxury — Mid-Range Beach"). Quote Builder auto-populates with a tier-appropriate Bali template (5-night Seminyak villa + private driver + 3 day-tours + spa add-on). Priya tweaks the activity mix and sends.

### 2.4 Visa Sure advisor — fee-only quote
Karan builds a visa-only fee quote for a UK visa: embassy fee + Visa Sure service fee + courier + photo + biometric. No accommodation/transport lines; pure fee breakdown with HSN code per line. Customer accepts → auto-invoice + checklist generation kicks off.

### 2.5 Customer-side accept/reject/counter flow
The school principal opens the emailed quote link → reviews → accepts. OR rejects with reason "budget too high, can we get 5-night version?" → operator sees feedback inline + clones the quote with 1 night dropped. OR submits a counter-offer ("can you do ₹95k per student instead of ₹105k?") → operator sees side-by-side comparison + can accept-and-update or reject the counter.

### 2.6 Sub-agent (B2B) clone-with-margin
Vinay shares his TMC quote (operator price ₹85k/student) with a sub-agent who handles a parent-school relationship. Sub-agent opens the quote in their own dashboard → "Clone with margin" → applies +15% margin → presents to the school at ₹98k/student. The original quote stays sub-agent-invisible; only the cloned envelope is what the school sees. Audit log records the relationship.

### 2.7 Save-as-template + admin template management
Vinay finishes a particularly clean "Europe-classic-7d" quote and saves it as a template. Admin opens Settings → Quote Templates → sees the new template under TMC sub-brand → edits the line-categories or pricing-engine markers → next time anyone picks "Europe-classic-7d" as a starting point, they get Vinay's structure + admin's tweaks.

---

## 3. Functional requirements

### FR-3.1 Quote header

- **FR-3.1.1** Customer (FK `Contact`), Deal (FK `Deal` — optional), sub-brand (FK on enum), currency (default = sub-brand's preferred currency), valid-until date, tax-treatment (`inclusive | exclusive`), template-id (FK `QuoteTemplate` — optional, see FR-3.5).
- **FR-3.1.2** Auto-numbered `quoteNumber` per tenant (mirror Estimate's `estimateNum @unique` pattern — e.g. `TMC-Q-0042`, `RFU-Q-0107`, `TS-Q-0019`, `VS-Q-0084`).
- **FR-3.1.3** Status workflow: `Draft → Sent → Revised → Accepted → Rejected` (mirror Itinerary's statuses per #900 spec). `Converted` substatus when an Invoice is auto-created.
- **FR-3.1.4** Optional itinerary link (`travelItineraryId` FK) for itinerary-derived quotes; the link lets the UI render the quote alongside its day-wise itinerary preview.

### FR-3.2 Line items

- **FR-3.2.1** Each line: `category` (enum: `hotel | flight | transport | visa | insurance | activity | meal | transfer | other`), `subCategory` (free-text — e.g. "Deluxe Haram-Facing"), `quantity`, `unitPrice`, `currency`, `discount %`, `tax %` (auto-set from HSN per #902, manual-override allowed), `notes`.
- **FR-3.2.2** Per-line dimension (mutually exclusive): `perPax` (qty = pax count) | `perRoomPerNight` (qty = rooms × nights) | `perTrip` (qty = 1 typically) | `flatRate`. Affects how the qty field labels itself in the UI ("# pax" vs "# room-nights" vs "# units").
- **FR-3.2.3** Optional add-ons — flagged `isAddOn: true`, NOT included in main subtotal until customer accepts the add-on at acceptance time. Rendered in a separate "Optional add-ons" section.
- **FR-3.2.4** `costMasterRowId` FK — when a line is derived from a `TravelCostMaster` row, store the FK for audit/refresh later. Manual-override of the unit price still allowed; if the operator overrides, the `manualOverrideAt + manualOverrideBy` columns get populated.
- **FR-3.2.5** Line ordering — `displayOrder Int` + drag-to-reorder in the centre pane (group by Day OR by Category — see FR-3.6).
- **FR-3.2.6** Soft-delete on lines (`deletedAt`) so removed lines preserve audit trail.

### FR-3.3 Pricing engine integration

- **FR-3.3.1** Searchable left-pane Cost Master picker filtered by sub-brand + category. Selecting a row auto-fills the line's `unitPrice`, `currency`, `costMasterRowId` via `POST /api/travel/pricing/quote` (existing engine endpoint).
- **FR-3.3.2** Pricing engine returns: `baseRate`, `seasonMultiplier`, `markupAmount`, `subtotal`, `warnings[]` (e.g. "no markup rule matched"). UI surfaces warnings as a yellow chip on the line.
- **FR-3.3.3** Re-pricing — operator clicks "Re-price all lines" → re-fires the engine for every line with a `costMasterRowId` and `tripDate` (the quote header's `validUntil` or itinerary's `departDate`). Lines without `costMasterRowId` (manual entries) skipped.
- **FR-3.3.4** Markup rules applied transparently — operator sees the markup breakdown per line on hover. Markup-rule misses (no matching rule) surface as a warning, not a hard failure.

### FR-3.4 Sub-brand & currency

- **FR-3.4.1** Sub-brand pre-fills line-category defaults (RFU defaults to hotel + flight + transport + visa; Visa Sure defaults to visa + insurance only; TMC defaults to hotel + transport + activity + meal; Travel Stall defaults to hotel + activity + transfer).
- **FR-3.4.2** Per-line currency — operator may price a hotel in USD and a transfer in INR. The Right pane shows a "Customer-currency total" panel that converts every line to the quote's customer-currency at the current FX rate.
- **FR-3.4.3** FX-rate cache — read from `currencies.js` route (already shipped) or a new `/api/fx/today` endpoint if needed. **Quote envelope locks FX at customer-accept time, NOT quote-build time** — until then the Right pane re-converts on every refresh.
- **FR-3.4.4** `subBrandAccess[]` enforcement — operator can only build quotes for sub-brands they have access to; server-side guard on `POST /api/travel/quotes` (mirror existing `requireTravelTenant` + `canAccessSubBrand` pattern from `travel_pricing.js`).

### FR-3.5 Templates

- **FR-3.5.1** New Prisma model `QuoteTemplate` — per-tenant, per-sub-brand, holds a JSON array of line-item shapes (without prices — picker re-resolves prices at quote-build time via the engine).
- **FR-3.5.2** Save-as-template from a built quote — operator clicks "Save as template" → modal asks for template name + sub-brand scope (current sub-brand only / all sub-brands) → POST `/api/travel/quote-templates`.
- **FR-3.5.3** Admin manages templates via Settings → Quote Templates page — CRUD + activate/deactivate + sort-order for the dropdown.
- **FR-3.5.4** Template picker on quote-build start — defaults to "Blank" + sub-brand-specific templates listed below.

### FR-3.6 Builder UI (3-pane)

- **FR-3.6.1** **Left pane** — searchable Cost Master picker. Filter by sub-brand (auto-set from quote header) + category multi-select + supplier multi-select + free-text search across `routeOrSku`. Drag a row to the centre pane → adds a new line. Today's pricing engine result decorates the row before drag (so the operator sees the line's subtotal preview).
- **FR-3.6.2** **Centre pane** — line items grouped by **Day** (if itinerary linked) OR by **Category** (if ad-hoc). Drag-to-reorder within group; drag-across-group moves between days/categories. Inline-edit `quantity` + `unitPrice` + `discount %`. Trash icon to delete.
- **FR-3.6.3** **Right pane** — live totals: subtotal (per category breakdown), discount, GST (CGST+SGST or IGST per HSN), service-charge, advance %, grand total. Customer-currency mirror panel below (live FX conversion). Buttons: Save Draft, Send to client, Convert to Invoice.
- **FR-3.6.4** Header bar — customer picker, sub-brand badge, valid-until date, status pill, audit-log toggle.
- **FR-3.6.5** Itinerary preview side-panel (collapsible) — renders the linked `TravelItinerary` day-wise so operator can cross-check quote vs itinerary content as they build.

### FR-3.7 Customer flow

- **FR-3.7.1** "Send to client" — generates a branded PDF (org logo + brand color per tenant — mirror `pdfRenderer.js` pattern from wellness prescription/consent), pushes through Inbox to WhatsApp/Email, attaches PDF to the contact timeline. WhatsApp delivery uses `subBrandConfig` helper (already shipped at `621aab7`) — STUB until Q9 WABA creds land per cluster B2.
- **FR-3.7.2** Secure share link — `https://crm.../q/<uuid>?token=<jwt>` — customer doesn't need to log in. JWT scoped to the quote + read-only-with-accept/reject permissions.
- **FR-3.7.3** Customer landing page — read-only view of the quote (line items, totals, valid-until countdown). Buttons: Accept, Reject with reason, Counter-offer.
- **FR-3.7.4** On Accept — Deal status auto-updates to "Booked"/"Won"; Invoice auto-created via the existing Invoice creation path with line items copied + FX locked. Customer receives confirmation email + WhatsApp.
- **FR-3.7.5** On Reject with reason — quote status flips to `Rejected`; reason captured in `Quote.rejectionReason`; operator notified via Inbox.
- **FR-3.7.6** Counter-offer — customer submits free-text reason + a proposed total. Operator sees side-by-side (original vs counter) in the builder + can accept/update/reject the counter.

### FR-3.8 Audit + history

- **FR-3.8.1** Every quote-line CRUD logs an entry in `AuditLog` with tenant + actor + quote id + before/after diff (mirror existing audit-chain pattern). Compliance-critical for B2B contracts.
- **FR-3.8.2** Quote-version snapshots — every "Send to client" call snapshots the current quote envelope into `QuoteSnapshot`. Lets us answer "what did the customer actually see when they accepted?" months later. See OQ-9.3 for whether to snapshot on every send vs only on accept.
- **FR-3.8.3** Send-history — list of (sent-at, channel, recipient, opened-at, accept-at) tuples per quote.

### FR-3.9 Convert to Invoice

- **FR-3.9.1** "Convert to Invoice" button → one-click on Accepted quotes. Creates Invoice with: same customer, same line items (copy not reference per OQ-9.4), FX locked, status "Draft" so operator can review before sending the invoice.
- **FR-3.9.2** Reverse-link — Invoice stores `sourceQuoteId` FK so the operator can navigate Invoice → Quote later.
- **FR-3.9.3** Idempotency — clicking twice doesn't create two invoices; the second click navigates to the existing one.

---

## 4. Non-functional requirements

- **Performance:** Quote with ≤50 line items renders in <2s on a 4G connection; pricing-engine re-fire across all 50 lines completes in <5s. PDF generation <3s.
- **Mobile-friendly customer accept flow:** the customer landing page must work on iOS Safari 16+ and Android Chrome 110+ — touch-friendly Accept/Reject/Counter buttons, no tiny tap targets, scrollable line-items table.
- **Per-tenant brand customization:** logo, primary color, terms-of-service text — pulled from `Tenant.brandConfigJson` (already shipped per #902 / earlier brand-config work). Sub-brand override allowed via `subBrandConfigJson`.
- **Audit:** every quote-line edit + send + status change goes through the audit chain (`writeAudit` helper). Compliance pre-req for any tenant on a B2B-contract pricing tier.
- **Security:** `subBrandAccess[]` enforced server-side; customer-side share-link JWTs scoped to a single quote with read+accept+reject scopes only (no listing other quotes / contacts).
- **A11y:** WCAG 2.1 AA on the builder + customer landing page. Keyboard navigation through Cost Master picker + drag-drop (mirror DD-5.1 of Pipeline Kanban PRD if `@dnd-kit` is adopted).

---

## 5. Design decisions needed

### DD-5.1 Fork vs extend — `TravelQuote`, `Quote`, or `Estimate`?

**Trade-off:**
| Option | Effort | Pollutes generic? | Future-proof for travel? |
|---|---|---|---|
| (a) New `TravelQuote` model + `routes/travel_quotes.js` — fork | Heaviest (+model, +routes, +Prisma migration, +e2e specs) | No | Cleanest |
| (b) Extend dormant `Quote` (line 1009) with `category`, `currency`, `subBrand`, etc. | Medium — schema migration + repurpose | Yes (`Quote` is generic) | Decent — `Quote` is barely used |
| (c) Extend `Estimate` + `isTravel` flag | Lightest (+10 columns on Estimate) | Yes — heavy pollution of a heavily-shipped model | Risky — Estimate is wellness/clinical too |

**Recommendation:** **(a) fork** — new `TravelQuote` + `TravelQuoteLineItem` + `TravelQuoteTemplate` + `TravelQuoteSnapshot` Prisma models, new `routes/travel_quotes.js`, new `pages/travel/QuoteBuilder.jsx`. Justification: travel-quote semantics (per-pax, per-room-night, multi-currency, HSN-tax-aware, sub-brand-scoped, itinerary-linked) are sufficiently distinct from generic Estimates that polluting Estimate model is a lifetime tax. The dormant `Quote` model (option b) could be deleted as cleanup if no callers remain.

**Decision required from:** backend lead + Suresh (architect). **Default if no decision:** (a) fork — matches every other travel-vertical module (`travel_itineraries`, `travel_trips`, `travel_diagnostics` are all forks of their generic siblings).

**[RESOLVED 2026-05-24]** FORK — `TravelQuote` as new Prisma model. Decided as part of the Quote/Billing/Supplier symmetric fork call (DECISIONS_TRACKER.md commit `a8f24ca`). Schema landed at commit `fdb793e` alongside sibling `TravelInvoice` and `TravelSupplier`. Tenant inverse relation threaded into the travel-vertical cluster. Companion line-item / template / snapshot models + `routes/travel_quotes.js` are follow-up commits.

### DD-5.2 Pricing-engine UX — rule-based config or formula-language?

**Trade-off:**
- (a) Rule-based config — markup rules + season calendars live in admin UI, sub-brand head edits via a CRUD form. **Already shipped** via `TravelMarkupRule` + `TravelSeasonCalendar`.
- (b) Formula-language (Excel-like expressions per line) — `=baseRate * seasonMult * (1 + markup) * qty` editable per line, sub-brand head writes formulas. More powerful, much harder UX.

**Recommendation:** (a) — keep the engine config-driven; surface markup-rule editing in admin UI; reserve formula-language for power-user escape hatch in Phase 2 if operators ask. Lower training cost.

**Decision required from:** sub-brand heads (Yasin, Rishu, RFU lead). **Default if no decision:** (a).

### DD-5.3 Tax treatment — inclusive vs exclusive default per sub-brand?

**Trade-off:** Indian B2B billing convention is `tax-exclusive` (price + GST shown separately on invoice). B2C convention is `tax-inclusive` (one all-in price shown to customer).

**Recommendation:**
- TMC (school B2B contracts) → `tax-exclusive` default
- RFU (B2C devout consumer) → `tax-inclusive` default
- Travel Stall (B2C family) → `tax-inclusive` default
- Visa Sure (B2C individual + B2B agencies) → `tax-exclusive` default + override per quote

Make it a per-sub-brand config (`subBrandConfigJson.quoteDefaults.taxTreatment`).

**Decision required from:** finance + sub-brand heads. **Default:** as above.

### DD-5.4 FX-rate source + cadence

**Options:**
- (a) RBI reference rate — official, free, daily — feed via scraping or daily cron pulling `https://www.rbi.org.in/...`. Slight lag.
- (b) Vendor (e.g. Open Exchange Rates / Fixer / XE) — paid, real-time, ~$10/mo.
- (c) Manual entry by finance — weekly. Stale risk.

**Recommendation:** (a) — RBI ref-rate is what every operator's accountant will reconcile against anyway, so locking to it removes finance-team friction. Cache locally; refresh daily 09:00 IST.

**Decision required from:** finance lead. **Default:** (a).

### DD-5.5 Counter-offer flow — in-app or email-only?

**Trade-off:** Counter-offers are non-trivial UI — customer needs to express either "price too high" + delta, or "scope too small" + add-ons, or both.

**Options:**
- (a) Simple — customer submits a number + reason; operator sees side-by-side in builder.
- (b) Rich — customer can edit line items inline + submit a modified quote; operator accepts/rejects the modified envelope.

**Recommendation:** (a) for v1 — simpler UI, faster to ship. Defer (b) until customer-side counter-offer data shows operators want richer detail (most counters in practice are "just give me 10% off" which (a) handles cleanly).

**Decision required from:** sales lead. **Default:** (a).

### DD-5.6 PDF renderer template ownership

Existing `pdfRenderer.js` (services/) handles wellness prescription + consent + branded invoice. Travel quote is a new template — render in the same module (pattern-match the consent template) or a new `services/travelPdfRenderer.js`?

**Recommendation:** extend `pdfRenderer.js` with new template functions (`renderTravelQuote()`, future `renderItinerary()` and `renderVoucher()`). Single PDF entry-point simplifies tenant brand-config injection. Add a clear function header per template per the descriptive-headers standing rule.

**Decision required from:** backend lead. **Default:** extend.

---

## 6. Acceptance criteria

- **AC-6.1** Build a 7-day Europe school trip quote: TMC sub-brand, 50 students + 5 chaperones, 4 hotel lines + 3 transport lines + 6 activity lines + group-discount adjustment. Subtotal + GST + grand-total computed correctly to the rupee.
- **AC-6.2** Apply group-size tier discount at 50+ pax (markup-rule with `minPax: 50` → -10%) — subtotal reflects discount; markup-applied chip visible on affected lines.
- **AC-6.3** Switch quote display-currency from USD to INR — Right pane Customer-currency panel reflects current RBI ref-rate FX conversion within 1s of toggle.
- **AC-6.4** Save-as-template — re-open the template from a new blank quote → all line categories + sub-brand defaults preserved; prices re-resolved live via pricing engine.
- **AC-6.5** Send via email + WhatsApp — customer receives a branded PDF (tenant logo + sub-brand color) + a tappable accept-link; PDF rendering completes within 3s.
- **AC-6.6** Customer accepts via the share link — Deal status moves to "Booked"; Invoice auto-created with the same line items + FX locked at acceptance time + `sourceQuoteId` set. Reverse-link from Invoice → Quote works.
- **AC-6.7** Sub-brand-specific markup rule (RFU peak-season +25%) auto-applies when the trip-date falls inside the Ramadan-peak season calendar window. Operator sees the markup amount in the per-line hover tooltip.
- **AC-6.8** Audit chain — every line-edit + send + accept + status-change creates an `AuditLog` row with diff; the hash-chain extends correctly per the existing audit-integrity engine.
- **AC-6.9** `subBrandAccess[]` enforcement — a user with `['travelstall']` cannot create a TMC quote via API (403 Forbidden); cannot see TMC quote templates in the picker.
- **AC-6.10** Counter-offer — customer submits "₹95k/student" as a counter; operator sees the side-by-side in the builder + can accept-and-update or reject.
- **AC-6.11** Convert-to-Invoice idempotency — clicking Convert twice doesn't create two invoices; second click navigates to the existing Invoice.
- **AC-6.12** Soft-delete on lines — deleted line preserved in `lineItems` array with `deletedAt` set, hidden from UI but visible in audit-trail diff.

---

## 7. Out of scope

- **Real-time inventory check at quote-build time** (e.g. "is this hotel actually available on these dates?") — requires supplier integration (RateHawk / direct GDS). Separate feature; tracked in cluster B6 (Saudi-side hotel scraper) + cluster F (RateHawk integration).
- **Multi-currency single invoice** — one currency per invoice. Multi-currency quote → single-currency invoice (FX locked at accept time).
- **AI-suggested upsells on quote** — "based on this Bali quote, suggest adding a spa upgrade" — separate AI feature, after the core builder is shipped.
- **Travel insurance line auto-suggest** — Phase 2.
- **Chrome flight-plugin → auto-add-line** — cluster B4 (Chrome plugin) lives in a separate repo; the quote builder will accept its POSTs (`/api/travel/flight-quotes`) but plugin code is out of scope here.
- **Sub-agent (B2B) cloning UI** — FR-3.6 spec'd but ships in v2 once B2C operator flow is solid.
- **Versioning / branching of quotes** — "this quote has 3 versions, customer is reviewing v2" — solvable via QuoteSnapshot (FR-3.8.2) but explicit version-branching UI is v2.

---

## 8. Dependencies

### Already in place
- `TravelCostMaster`, `TravelSeasonCalendar`, `TravelMarkupRule` Prisma models (`schema.prisma:4244-4297`).
- `POST /api/travel/pricing/quote` engine endpoint (`backend/routes/travel_pricing.js:362-460`) — composes a single-line quote.
- `lib/travelPricing.js` — pure pricing math helper.
- `Estimate` model + `routes/estimates.js` — reference impl for status workflow, PDF/CSV export, contact + deal linkage.
- Dormant `Quote` + `QuoteLineItem` models (`schema.prisma:1009-1035`) — candidates for deletion (DD-5.1 fork picks (a)).
- `TravelItinerary` model — link target for itinerary-derived quotes.
- `Contact` + `Deal` + `Invoice` models + their routes — Quote is a node in the existing relationship graph.
- Currency table + currency conversion helpers in `currencies.js` route.
- GST module (#902) — provides HSN/SAC → CGST/SGST/IGST split logic.
- `pdfRenderer.js` — extends with `renderTravelQuote()`.
- Email + WhatsApp delivery services (existing) — `subBrandConfig` already wires WABA per sub-brand (`621aab7`).
- `requireTravelTenant` + `canAccessSubBrand` + `assertValidSubBrand` middleware helpers in `routes/travel_pricing.js`.
- `writeAudit` + audit-chain engine.

### To verify before starting
- HSN/SAC field on `TravelCostMaster` — currently `attributesJson` may hold this; promote to first-class column if not.
- `subBrandConfigJson` shape — does it already have a `quoteDefaults` sub-key, or do we extend it?
- Existing `Quote` + `QuoteLineItem` callers — grep for any frontend or backend code referencing the dormant model; remove before re-purposing.
- Customer-facing share-link JWT pattern — does an existing pattern in `routes/public/*` or `routes/portal.js` cover the read-only-with-accept/reject scope?

### New models / routes
- `TravelQuote`, `TravelQuoteLineItem`, `TravelQuoteTemplate`, `TravelQuoteSnapshot` Prisma models (per DD-5.1 fork).
- `routes/travel_quotes.js` — CRUD + send + accept + reject + counter + convert-to-invoice.
- `routes/travel_quote_templates.js` — CRUD for admin template management.
- `routes/public/travel_quotes.js` — customer-side share-link landing (read + accept + reject + counter).
- `pages/travel/QuoteBuilder.jsx` — 3-pane builder.
- `pages/travel/QuoteList.jsx` — list view (replaces `QuotesComingSoon.jsx` at `/quotes`).
- `pages/travel/QuoteAcceptLanding.jsx` — customer-side landing page.
- `pages/Settings/QuoteTemplates.jsx` — admin template management.
- e2e specs: `travel-quotes-api.spec.js`, `travel-quote-templates-api.spec.js`, `travel-quote-accept-flow.spec.js`.
- vitest specs: `backend/test/services/travel-pdf-renderer.test.js` (extends existing pdfRenderer suite).

---

## 9. Open questions

- **OQ-9.1** Fork vs extend (DD-5.1) — backend lead's call. Forking is cleaner; extending Estimate is faster but riskier long-term.
- **OQ-9.2** Markup-rule maintenance owner — operator, sub-brand head, or admin? Different sub-brands likely have different answers (RFU centralized vs Travel Stall decentralized). Surface via per-sub-brand permission.
- **OQ-9.3** Quote-version history — snapshot every send, or only on accept? Snapshots cost storage (each ~10-50KB compressed); accept-only is cheaper but loses "what did customer see in the rejected v1?" forensics. **Recommendation: snapshot on every send + accept + on customer counter-offer; not on operator-side draft edits.**
- **OQ-9.4** Quote → Invoice line items — copy or reference? **Recommendation: copy** — invoice line items are immutable from accept onwards; quote may still be revised post-accept for audit-trail clarity. Reference would couple them and complicate invoice editability.
- **OQ-9.5** Itinerary deletion vs quote — what happens to a quote when its source `TravelItinerary` is deleted? Options: (a) cascade-delete the quote; (b) null the FK + leave quote standalone; (c) prevent itinerary deletion if a quote references it. **Recommendation: (b)** — quotes outlive itineraries; preserve quote, null the reference, surface a "source itinerary deleted" badge in the builder.
- **OQ-9.6** Multi-rep collaboration — can two reps edit the same quote simultaneously? Socket.io live-sync (mirror Pipeline Kanban's pattern) would solve it. Probably out of scope for v1 — single-rep edit is the 95% case.
- **OQ-9.7** Quote-expiry semantics — when `validUntil` passes, status flip Draft/Sent → Expired automatically (via cron) OR keep as-is + show "expired" badge? **Recommendation: cron flip to Expired** — matches Estimate's existing pattern + clarifies the workflow.
- **OQ-9.8** Customer-side translation — does the accept landing page need to be available in Hindi, Arabic, Urdu (for RFU customers)? Touch point of i18n surface that we don't currently have first-class. Filed as separate i18n PRD candidate.

---

## 10. Status snapshot

### 2026-06-09 refresh — builder + admin LIVE; PDF/convert/templates pending

**Current state:** Slices 1-8 of the Quote Builder are SHIPPED. The `/quotes` route claim from the prior snapshot ("resolves to QuotesComingSoon.jsx pending routes scaffold") is OBSOLETE — the builder + admin pages are live and mounted in `App.jsx`. `QuotesComingSoon.jsx` is no longer reachable from the live Travel sidebar.

**SHIPPED:**
- ✅ `TravelQuote` + `TravelQuoteLine` Prisma models (`backend/prisma/schema.prisma:5818+`) — DD-5.1 fork resolved at `fdb793e`
- ✅ `backend/routes/travel_quotes.js` — CRUD + analytics + by-month/quarter/year + stats + expired + line CRUD + supplier picker + "Send" stub action
- ✅ `frontend/src/pages/travel/QuoteBuilder.jsx` — 3-pane composer with markup calc (slices 2-8)
- ✅ `frontend/src/pages/travel/QuotesAdmin.jsx` — CRUD list
- ✅ `POST /api/travel/pricing/quote` engine endpoint
- ✅ `subBrandAccess[]` server-side enforcement on `travel_quotes` routes
- ✅ Supplier picker wired (slice 4)
- ✅ "Send to customer" stub action (slice 6 — real WA delivery Q9-blocked)
- ✅ `App.jsx` mounts `/travel/quotes-admin` (QuotesAdmin) + `/travel/quotes/builder/:id?` (QuoteBuilder)

**Pending (in-PRD work):**
- ⬜ PDF render (`renderTravelQuote()` not yet in `pdfRenderer.js`) — ~2d
- ⬜ Quote → Invoice convert flow (`TravelInvoice.quoteId` FK exists; no `/convert-to-invoice` route) — ~2d
- ⬜ Templates not implemented (`QuoteTemplate` / `TravelQuoteTemplate` models absent) — ~3d
- ⬜ FX-rate locking at accept-time — ~½d
- ⬜ Customer-side accept/reject/counter landing — ~3d
- ⬜ `QuoteSnapshot` version history — ~1d
- ⬜ Sub-agent clone-with-margin (FR-3.6 / UC-2.6) — ~2d
- ⬜ Cron quote-expiry sweep — ~½d

**Blocked (creds / external):**
- 🔵 WA send delivery on Q9 (WhatsApp Cloud API creds)
- 🔵 FX cron source DD-5.4 (RBI ref-rate cadence call)

**Net remaining: ~14 engineering days** + 2 cred unblocks. The schema + builder UI + admin list (the longest-tail dependencies) are off the critical path. PDF + convert + customer-accept landing are the next high-value slices.

- **Phase:** P1 — Revenue-critical builds (per Travel CRM gap-audit Tier).
- **Closes:** #900 once FR-3.1 through FR-3.9 ship + AC-6.1 through AC-6.12 pass.
- **Blocks on:** Q9 (WA creds) for end-to-end customer delivery; DD-5.4 (FX cadence) for accept-time lock.

---

## Cross-cutting findings (for the cron orchestrator)

**Finding 1 — Prompt drift:** The agent prompt claimed `/quotes` maps to `Estimates.jsx`. Reality: `/quotes` maps to `QuotesComingSoon.jsx` (commits per BUG-T24 / #886). Estimates lives at `/estimates` only. Minor drift; PRD updated to pin reality. Pattern: regression-coverage-style gap cards (and now PRD-writer prompts) drift from actual code — verifying-issue-before-pickup grep would have caught this in 30s. The standing rule on regression-coverage drift now applies to PRD-writer dispatches too.

**Finding 2 — Dormant Prisma model candidate for cleanup:** `Quote` + `QuoteLineItem` models (`schema.prisma:1009-1035`) exist but appear unused in current routes. DD-5.1 fork (recommended) leaves them orphaned; cleanup sweep would remove ~25 lines of schema + any unused frontend/backend references. Worth a separate small task ("delete dormant Quote + QuoteLineItem if no callers") once the fork lands.

**Finding 3 — Pricing engine endpoint asymmetry:** `POST /api/travel/pricing/quote` composes a SINGLE-line quote — there's no aggregator that takes an array of line specs and returns an array of priced lines. The builder UI will fire N parallel calls today; could be optimized later to a batch endpoint (`POST /api/travel/pricing/quote-batch`) with one round-trip. Not a blocker; flag for v2.
