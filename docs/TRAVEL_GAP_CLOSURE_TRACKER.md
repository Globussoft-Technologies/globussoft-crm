# Travel CRM Gap-Closure Tracker

> **Single source of truth** for closing every gap surfaced by the 2026-06-13 audit of 15 travel PRDs (433 sub-PRD FRs + ~95 master-PRD items).
>
> **Supersedes** [TRAVEL_BIG_SCOPE_BACKLOG.md](TRAVEL_BIG_SCOPE_BACKLOG.md) (codeable-complete for its scope) and [TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md](TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md) (master-PRD-only delta).
>
> **Markers:** ⬜ TODO · 🟡 IN-PROGRESS · ✅ DONE · 🔵 BLOCKED-CRED · 🟣 BLOCKED-DECISION · ⏭️ PHASE-1.5+
>
> **Per-push gate:** build / lint / api_tests / unit_tests / frontend_unit_tests / migration_check. Every slice must keep all 6 green.

---

## 1. Headline numbers (audited 2026-06-13 against HEAD `043b9ab3`)

| PRD | Total FRs | Shipped | Net gap | Tracker §|
|---|---:|---:|---:|---|
| [TRAVEL_CRM_PRD](TRAVEL_CRM_PRD.md) (master) | ~95 | 84 (88%) | ~16 | §6.M |
| [PRD_TRAVEL_MULTICHANNEL_LEADS](PRD_TRAVEL_MULTICHANNEL_LEADS.md) | 32 | 8 (25%) | 21 | §3.1 |
| [PRD_TRAVEL_PIPELINE_KANBAN](PRD_TRAVEL_PIPELINE_KANBAN.md) | 18 | 16 (89%) | 1 | §3.2 |
| [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md) | 31 | 22 (71%) | 8 | §3.3 |
| [PRD_TRAVEL_BILLING](PRD_TRAVEL_BILLING.md) | 30 | 19 (63%) | 11 | §3.4 |
| [PRD_TRAVEL_GST_COMPLIANCE](PRD_TRAVEL_GST_COMPLIANCE.md) | 24 | 13 (54%) | 11 | §3.5 |
| [PRD_TRAVEL_SUPPLIER_MASTER](PRD_TRAVEL_SUPPLIER_MASTER.md) | 30 | 5 (17%) | 25 | §3.6 |
| [PRD_TRAVEL_ITINERARY_UPGRADES](PRD_TRAVEL_ITINERARY_UPGRADES.md) | 39 | 19 (49%) | 20 | §3.7 |
| [PRD_TRAVEL_MARKETING_FLYER](PRD_TRAVEL_MARKETING_FLYER.md) | 37 | 12 (32%) | 25 | §3.8 |
| [PRD_TRAVEL_B2B_AGENT_PORTAL](PRD_TRAVEL_B2B_AGENT_PORTAL.md) | 34 | 0 (0%) | 34 | §5.B2B |
| [PRD_TRAVEL_SECURITY_ARCHITECTURE](PRD_TRAVEL_SECURITY_ARCHITECTURE.md) | 34 | 11 (32%) | 23 | §3.9 + §5.SEC |
| [PRD_TRAVEL_PER_SUBBRAND_BRANDING](PRD_TRAVEL_PER_SUBBRAND_BRANDING.md) | 36 | 3 (8%) | 33 | §3.10 + §4.Q22 |
| [PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md) | 28 | 25 (89%) | 3 | §3.11 |
| [PRD_TMC_CURRICULUM_MAPPING](PRD_TMC_CURRICULUM_MAPPING.md) | 10 | 9 (90%) | 1 | §3.12 |
| [PRD_RFU_GROUND_SERVICES](PRD_RFU_GROUND_SERVICES.md) | 24 | 0 (0%) | 24 | §4.RFU + §6.RFU |
| [PRD_VISA_SURE_PHASE_3](PRD_VISA_SURE_PHASE_3.md) | 26 | 18 (69%) | 8 | §3.13 |
| **TOTAL (15 sub-PRDs)** | **433** | **180 (42%)** | **249** | |

**Bucket split of the 249 gap items:**
- ~75 engineering-actionable (no external dep) → §3
- ~31 cred-blocked (code stub shipped) → §4
- ~85 decision-blocked (product call needed) → §5
- ~16 contractually deferred (Phase 1.5+) → §6

---

## 2. P0 unblocks — action list for Yasin / Globussoft leadership

Sorted by blast radius (number of gap items each unblocks).

| # | Action | Owner | Unblocks | Type |
|---|---|---|---|---|
| 1 | **Q22 brand-pack drop** (logos / palettes / fonts / PDF covers per sub-brand) | Yasin | ~33 Branding FRs + 6 Visa-Sure brand variants + ~6 Flyer brand-kit items = **~45 FRs across 4 PRDs** | cred |
| 2 | **Q9 Wati creds** (3 WABA IDs + Meta System User token) | Yasin | 10+ master-PRD consumers + Quote send + Visa advisor alerts + Flyer share + 5 reminder crons = **~15 items** | cred |
| 3 | **7 DD-5.* design calls for B2B Agent Portal** (route prefix, approval chain, policy editor, theming, RBAC) | GS + Travel Stall | Entire 34-FR B2B PRD currently at 0% | decision |
| 4 | **Q11 LLM keys** (Perplexity + Gemini + optionally Claude/GPT) | Yasin | Flips form-vs-call, talking points, visa-summary, flyer copy, itinerary-suggest, marketing-image, cost dashboard | cred |
| 5 | **Decision to start the two Phase-1-committed builds** that are at zero code (DC-1..DC-5) | GS + Travel Stall | Chrome flight plugin (P1 W3 commit) + Top-4 airline check-in (P1 W4 commit) | decision |
| 6 | **Q19 RateHawk creds + 6 RFU vendor onboardings** (Zikr, Almosafer, Tajawal, MyHoliday2, PilgrimsChoice, ReservationHouse, HHR) | Yasin + Travel Stall | RFU lowest-rate pick + 16 stubbed RFU FRs (the other 8 still need build) | cred |
| 7 | **DD-5.2 GST `TaxRateMaster` ownership decision** | GS + Travel Stall | Rates are hard-coded in `gstCalculation.js` with TODO comment; gates 4 GST FRs + future rate changes | decision |
| 8 | **DD-5.1 cookie-shape decision** (same-site + refresh-token rotation) | GS + Travel Stall | Security FR-3.1 entire (JWT→cookie flip) + B2B Portal authn shape | decision |
| 9 | **Q3 DigiLocker creds + Q2 Aadhaar consent counsel sign-off** | Travel Stall counsel | Closes TMC parent registration end-to-end | cred + counsel |
| 10 | **Q6 / R11 on-prem hosting handover (W0 call)** | Travel Stall | Deploy-target risk flagged 🔴 in [TRAVEL_CRM_RISKS.md](TRAVEL_CRM_RISKS.md) | ops |

---

## 3. ⬜ Engineering-actionable backlog (buildable NOW, no external dep)

Each row is a coherent PR scope. Effort estimates assume one senior engineer.

### §3.1 PRD_TRAVEL_MULTICHANNEL_LEADS — 21 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G001 | Touchpoint write per inbound lead (FR-3.5.1) | `backend/routes/travel_inbound_leads.js`, `schema.prisma:Touchpoint` | 1d | ✅ DONE 2026-06-13 — `45e026e2` |
| G002 | `idempotencyKey` + `(tenantId, channel, idempotencyKey)` unique constraint + hard-block duplicates (FR-3.1.7, FR-3.2.6) | same + schema migration `[allow-unique]` | 1d | ✅ DONE 2026-06-13 — `45e026e2` |
| G003 | Cross-channel `MergePromptNotification` (FR-3.2.4) + marketplace `externalLeadId` short-circuit in envelope (FR-3.2.5) | route + schema | 1.5d | ✅ DONE 2026-06-13 — `45e026e2` |
| G004 | Channel enum expansion (`voice`, `sms`, `email`, `google_ad`, `linkedin_ad`, `referral`, `chat`) + rename `webform`→`web_form`, `metaads`→`meta_ad` (FR-3.1.2) | route + schema (string col, additive) | 0.5d | ✅ DONE 2026-06-13 — `45e026e2` |
| G005 | Touchpoint UTM fields: `utm_campaign/term/content`, `siteSlug`, `advertiserId`, `formId`, `landingPage`, `firstTouchAt` (FR-3.1.3) | schema + intake parser | 1d | ✅ DONE 2026-06-13 — `45e026e2` |
| G006 | Intake response envelope: `action: created\|merged\|touchpoint_appended\|duplicate_suppressed`, `matchedRoutingRuleId`, `touchpointId` (FR-3.1.8) | route | 0.5d | ✅ DONE 2026-06-13 — `45e026e2` |
| G007 | `LeadRoutingRule.channel`, `.subBrand`, `.rrCursor`, `.priority` columns + most-specific-rule resolver (FR-3.3.1, 3.3.2, 3.3.4) | schema (additive) + `lib/leadAutoRouter.js` | 1.5d | ✅ DONE 2026-06-13 — `c2c33d6a` |
| G008 | `User.isAvailable` + unavailability fallback in router (FR-3.3.5) | schema + router | 0.5d | ✅ DONE 2026-06-13 — `c2c33d6a` |
| G009 | `/settings/lead-capture` admin page (toggles + cooldown UI + FormRoutingMapping UI) (FR-3.7) | `frontend/src/pages/settings/LeadCapture.jsx` (NEW) + 2 routes | 2d | ✅ DONE 2026-06-13 — `e3d59b7b` |
| G010 | `/leads?view=inbox` cross-channel filter inbox + chip filter on Leads.jsx (FR-3.6.2, 3.6.3) | `frontend/src/pages/travel/Leads.jsx` | 1.5d | ✅ DONE 2026-06-13 — `e3d59b7b` |
| G011 | `TenantSettings.leadCaptureCooldowns` + cooldown enforcement (FR-3.2.3) | schema + intake | 1d | ✅ DONE 2026-06-13 — `45e026e2` |
| G012 | Referral channel + `referrerContactId` link (FR-3.4.5) | schema + intake + route | 0.5d | ✅ DONE 2026-06-13 — `45e026e2` |
| G013 | Voice channel `subStatus='callback_pending'` (FR-3.4.1) | schema + intake | 0.5d | ✅ DONE 2026-06-13 — `45e026e2` |
| G014 | Per-channel typed payload validators (FR-3.1.4) | `lib/intakePayloadValidators.js` (NEW) | 1d | ✅ DONE 2026-06-13 — `45e026e2` |
| G015 | Canonical `POST /api/leads/intake` alias with body-channel mode (FR-3.1.1) — alias only, keep current path live | route alias | 0.5d | ✅ DONE 2026-06-13 — `45e026e2` |

**§3.1 net effort: ~12 eng-days**

### §3.2 PRD_TRAVEL_PIPELINE_KANBAN — 1 gap

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G016 | FR-3.14 column totals re-compute from filtered set — verify with visual QA + add assertion in `frontend/src/__tests__/Pipeline.test.jsx` | spec only | 0.5d | ⬜ |

PRD §10 is stale (claims 11/18; actual is 16/18). Update PRD §10 in same commit.

### §3.3 PRD_TRAVEL_QUOTE_BUILDER — 8 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G017 | Sub-agent Clone-with-margin on `/quotes/:id/duplicate` (apply markup %) | `backend/routes/travel_quotes.js`, `frontend/.../QuoteBuilder.jsx` | 2d | ⬜ |
| G018 | FX-rate cron + `/api/fx` endpoint + per-line FX conversion panel (DD-5.4) | `backend/cron/fxRateEngine.js` (NEW), `lib/fxRates.js` (NEW), QuoteBuilder UI | 1.5d | ⬜ |
| G019 | Counter-offer side-by-side review UI for operator (FR-3.7.6) | `frontend/.../QuoteCounterReview.jsx` (NEW) | 1d | ⬜ |
| G020 | `TravelQuoteLine` columns: `hsnSac`, `taxPercent`, `discountPercent`, `dimension` enum (perPax/perRoomPerNight/perTrip/flatRate), `isAddOn` (FR-3.2.1-3) | schema (additive) + UI | 1.5d | ⬜ |

**§3.3 net effort: ~6 eng-days** (plus Q9 Wati for FR-3.7.1 send)

### §3.4 PRD_TRAVEL_BILLING — 11 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G021 | `TravelInvoiceLine` extension: `supplierId`, `isAddon`, `lineCost`, `lineSell`, per-line `cgstAmount/sgstAmount/igstAmount` (FR-3.1.c, e, f, g) | schema (additive) + route + UI | 2d | ✅ DONE 2026-06-13 — `15613ada` |
| G022 | Supplier-payable batch run (FR-3.5.e) + invoice-line origin FK (`TravelSupplierPayable.invoiceLineId`) | schema + route | 2d | ⬜ |
| G023 | Supplier-payable dispute workflow (FR-3.5.f) | schema (`TravelSupplierPayableDispute`) + route + UI | 2d | ⬜ |
| G024 | Settlement-timeline Gantt view (FR-3.6.c) | `frontend/.../SettlementGantt.jsx` (NEW) | 2d | ⬜ |
| G025 | Anchor-relative due-date on `TravelPaymentSchedule` (bookingDate / departureDate / returnDate offset) (FR-3.2.e) | schema + scheduler | 1d | ⬜ |
| G026 | T+3/T+7/T+14 overdue escalation chain (FR-3.2.g) | extend `paymentScheduleReminderEngine.js` | 1d | ⬜ |
| G027 | Operator schedule-override audit-log tag ("deviation from template") (FR-3.2.f) | `routes/travel_invoices.js` writeAudit extension | 0.5d | ⬜ |

**§3.4 net effort: ~10.5 eng-days** (plus Q-BILL-1 for FR-3.4.b non-filer rate, Q22 for FR-3.8.d per-sub-brand PDF branding)

### §3.5 PRD_TRAVEL_GST_COMPLIANCE — 11 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G028 | Persist invoice-level `cgstAmount/sgstAmount/igstAmount/placeOfSupply` columns on `TravelInvoice` (FR-3.2.1) | schema (additive) + tax-preview → tax-persist on save | 1d | ✅ DONE 2026-06-13 — `15613ada` |
| G029 | Per-line GST shape (FR-3.2.2) — combined with G021 supplierId/per-line cols | shared with G021 | combined | ✅ DONE 2026-06-13 — `15613ada` |
| G030 | Customer-ledger endpoint `GET /api/travel/invoices/customer-ledger?gstin=&fy=` (FR-3.4.4) | `routes/travel_invoices.js` + analytics lib | 1.5d | ✅ DONE 2026-06-13 — `dd4d2472` |
| G031 | TDS register endpoint `GET /api/travel/invoices/tds-register` (FR-3.4.6) | route + analytics | 1d | ✅ DONE 2026-06-13 — `dd4d2472` |
| G032 | Commission-ledger endpoint `GET /api/travel/invoices/commission-ledger` (FR-3.4.7) | route + analytics (IATA inward, distinct from B2B sub-agent ledger) | 1d | ✅ DONE 2026-06-13 — `dd4d2472` |
| G033 | `ServiceCategory.defaultSacCode` mapping (FR-3.1.4) | schema + seed | 0.5d | ✅ DONE 2026-06-13 — `dd4d2472` |
| G034 | `Contact.billingStateCode` column distinct from residence (FR-3.5.2) | schema (additive nullable) + buyer-state-derivation | 0.5d | ✅ DONE 2026-06-13 — `15613ada` |

**§3.5 net effort: ~5.5 eng-days** (plus DD-5.2 for TaxRateMaster, Q-GST-2/3/4 for GSTIN reverse + per-sub-brand GSTINs + LUT)

### §3.6 PRD_TRAVEL_SUPPLIER_MASTER — 25 gap items

Highest-impact gap. PO/dispute/KYC/reconciliation entirely absent.

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G035 | `TravelPurchaseOrder` + `TravelPurchaseOrderLine` models + state machine (Draft→Sent→Acknowledged→Fulfilled→Cancelled) (FR-3.2.a, b, c) | schema + `routes/travel_purchase_orders.js` (NEW) + state-machine lib | 3d | ✅ DONE 2026-06-13 — `5bf44124` |
| G036 | PO PDF export via `renderSupplierPo()` (FR-3.2.d) | `services/pdfRenderer.js` extension | 1d | ✅ DONE 2026-06-13 — `5bf44124` |
| G037 | Auto-PO-on-booking-confirm trigger (FR-3.2.a) + `TravelSupplierPayable.purchaseOrderId` FK (FR-3.3.a) | hook into booking-confirm + schema | 1.5d | ✅ DONE 2026-06-13 — `5bf44124` |
| G038 | Supplier KYC + onboarding checklist (FR-3.1.h) | schema (`TravelSupplierKyc` + checklist) + route + admin UI | 2d | ✅ DONE 2026-06-13 — `6ede25d4` |
| G039 | Supplier dispute history + chargeback log (FR-3.1.g, FR-3.6.a-c) | schema (`TravelSupplierDispute`) + route + UI | 2.5d | ✅ DONE 2026-06-13 — `6ede25d4` |
| G040 | Supplier status enum (`active`/`paused`/`blocked-disputed`/`archived`) replacing `isActive` (FR-3.1.f) — additive (no `[allow-type-narrow]` needed) | schema migration + route + UI | 1d | ✅ DONE 2026-06-13 — `be6c946f` |
| G041 | Payment-terms enum (`net30`/`net45`/`prepay`/`on-departure`) (FR-3.1.d) | schema (string enum) + UI | 0.5d | ✅ DONE 2026-06-13 — `be6c946f` |
| G042 | Credit-limit hard-block guard on booking-confirm (FR-3.3.e) | hook + UI warning | 1d | ✅ DONE 2026-06-13 — `be6c946f` |
| G043 | Quote-time + booking-time advisory chip ("near credit limit") (FR-3.7.c) | QuoteBuilder + booking UI | 0.5d | ✅ DONE 2026-06-13 — `be6c946f` |
| G044 | Reconciliation: PNR-keyed line match (FR-3.4.a) + tolerance threshold (FR-3.4.b) + bulk-reconcile UI (FR-3.4.c) | new route + `frontend/.../SupplierReconciliation.jsx` (NEW) | 3d | ✅ DONE 2026-06-13 — `24b586b9` |
| G045 | Supplier-commission link (`TravelCommissionProfile.supplierId` FK) + `SupplierCommissionEntry` ledger per FY (FR-3.1.e, FR-3.5.a, FR-3.5.b) | schema + route | 2d | ✅ DONE 2026-06-13 — `dcc95c8e` |
| G046 | Supplier invoice PDF upload + match-to-payable (FR-3.3.c) | Multer + route | 1.5d | ✅ DONE 2026-06-13 — `24b586b9` |

**§3.6 net effort: ~20 eng-days** (DD-5.5 blocks FR-3.5.c TDS auto-deduct only — everything else buildable now)

### §3.7 PRD_TRAVEL_ITINERARY_UPGRADES — 20 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G047 | `Itinerary.clonedFromTemplateId` lineage column + UI surface (FR-3.1.e) | schema + route + UI | 1d | ✅ DONE 2026-06-13 — da5cc682 |
| G048 | Template versioning: `version`, `isLatest`, `archivedAt` on `ItineraryTemplate` (FR-3.5.a, FR-3.5.b) | schema (additive) + route | 1.5d | ✅ DONE 2026-06-13 — fea965a5 |
| G049 | Template metrics: `acceptedCount`, `avgFinalPrice`, `lastUsedAt` (FR-3.1.h) | schema + on-quote-accept hook | 1d | ✅ DONE 2026-06-13 — da5cc682 |
| G050 | "Save current itinerary as template" action (FR-3.1.f) | route + UI button | 1d | ✅ DONE 2026-06-13 — fea965a5 |
| G051 | `ItineraryItem.draftedByAi: boolean` provenance (FR-3.4.h) | schema + suggest endpoint + UI badge | 0.5d | ✅ DONE 2026-06-13 — da5cc682 |
| G052 | Bulk-day-add "extend by N days" (FR-3.3.g) | UI + route | 1d | ✅ DONE 2026-06-13 — `02e01665` |
| G053 | Conflict warnings (overlapping times, closed POIs) (FR-3.3.h) | UI + warnings lib | 1.5d | ✅ DONE 2026-06-13 — `02e01665` |
| G054 | Cost Master sightseeing 6th category — OR document decision that `TravelSightseeing` is the canonical path (FR-3.2.a) | schema decision + doc update | 0.5d | ✅ DONE 2026-06-13 — a065e2fa |
| G055 | POI deduplication ±50m on add (FR-3.2.f) | `lib/poiDedup.js` (NEW) + route | 0.5d | ✅ DONE 2026-06-13 — a065e2fa |
| G056 | Hotel + activity inline-add (FR-3.7.b) | UI + route | 1.5d | ✅ DONE 2026-06-13 — `02e01665` |
| G057 | Per-day accept/edit/reject + re-prompt-same-draft preservation (FR-3.4.e, FR-3.4.f) | route stateful suggest + UI | 2d | ✅ DONE 2026-06-13 — `02e01665` |
| G058 | Template analytics CSV export (FR-3.5.c) | route | 0.5d | ✅ DONE 2026-06-13 — fea965a5 |
| G059 | Initial ~50-template seed across sub-brands (FR-3.1.g) | `prisma/seed-travel.js` extension | 1d (content-light) | ✅ DONE 2026-06-13 — `f38ee887` |
| G060 | Live re-pricing inside ItineraryEditor (FR-3.3.f) — verify hook | UI integration verification | 0.5d | ✅ DONE 2026-06-13 — `02e01665` |
| G061 | Filter facets: budget-tier + map preview before clone (FR-3.1.c, FR-3.1.d) | UI | 1d | ✅ DONE 2026-06-13 — `8243b9e7` |
| G062 | Keyboard shortcuts on editor (FR-3.6) | UI | 0.5d | ✅ DONE 2026-06-13 — `02e01665` |

**§3.7 net effort: ~14 eng-days**

### §3.8 PRD_TRAVEL_MARKETING_FLYER — 25 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G063 | Extended block-type registry: pricing-tile / testimonial / destination-grid / kpi / badge (FR-3.1.2, FR-3.1.3) | `MarketingFlyerStudio.jsx` + render engine | 2d | ⬜ |
| G064 | Snap-to-grid + spacing visualizer (FR-3.1.4) | Studio editor | 1d | ⬜ |
| G065 | Undo/redo + autosave (FR-3.1.5) | Studio editor state | 1.5d | ⬜ |
| G066 | Multi-aspect preview toggle (FR-3.1.6) | Studio | 0.5d | ⬜ |
| G067 | Concurrent-edit lock (FR-3.1.7) | schema (`FlyerEditLock`) + route + UI | 1d | ⬜ |
| G068 | Brand-kit consumer in Studio: read `subBrandConfigJson` + block-defaults + lock-to-brand mode + apply-latest action (FR-3.3.1-4) | Studio integration | 1.5d | ⬜ |
| G069 | DRAFT watermark on preview (FR-3.4.4) | render engine | 0.5d | ⬜ |
| G070 | Output URL caching per-format (FR-3.4.5) | schema (`FlyerOutput.outputUrls`) + render engine | 1d | ⬜ |
| G071 | AI-suggested layouts task class (FR-3.6.2) | `services/marketingFlyerLayoutLLM.js` (NEW, stub-mode) | 1d | ⬜ |
| G072 | Operator-submitted moderation queue (FR-3.7.3) | route + UI | 1d | ⬜ |
| G073 | Template metadata (`category`, `usageCount`, `conversionRate`) + marketplace sort/filters (FR-3.7.2, FR-3.7.4) | schema + UI | 1d | ⬜ |
| G074 | Per-asset usage count tracker (FR-3.2.5) | combined with G075 Asset model | combined | ⬜ |
| G075 | Curated 6-10 template seed per sub-brand (FR-3.7.1) | seed extension | 1d | ⬜ |
| G076 | WhatsApp-PNG ≤5MB compression verification + `flyerRenderEngine.js` test extension (FR-3.4.3) | render + test | 0.5d | ⬜ |

**§3.8 net effort: ~13 eng-days** (Asset model G075-equivalent + WA share + email attach blocked on Q-MF-1 + Q9)

### §3.9 PRD_TRAVEL_SECURITY_ARCHITECTURE — buildable items (12 of 23)

Decision-blocked items are in §5.SEC.

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G077 | CSP enforcement flip (remove unsafe-inline-script + nonce) (FR-3.2.a) — needs full Report-Only → enforce cycle | `lib/cspNonce.js`, `middleware/security.js` + multi-day rollout | 3d | ⬜ |
| G078 | CSP style-src unsafe-inline removal + style nonce (FR-3.2.b) | same surface | 2d | ⬜ |
| G079 | CSP source-allowlist tighten (`wss:` pin, vendor pins) (FR-3.2.c) | helmet config | 0.5d | ⬜ |
| G080 | X-XSS-Protection header flip post-CSP-enforce (FR-3.2.e) | middleware | 0.5d (after G077) | ⬜ |
| G081 | Object-level ACL middleware (row-level + relation traversal) (FR-3.3.d) | `middleware/objectAcl.js` (NEW) + integration | 3d | ⬜ |
| G082 | Cron-callsite tenant-scope audit + ESLint rule extension (FR-3.4.e) | audit + lint rule | 1.5d | ⬜ |
| G083 | Per-row PII disclosure audit + bulk-export rate-limit (FR-3.5.c) — generalize wellness pattern | `lib/piiAudit.js` (NEW) + middleware | 2d | ⬜ |
| G084 | Search-endpoint summary-projection exception (FR-3.5.e) | `routes/search.js` extension | 1d | ⬜ |
| G085 | SRI on external scripts (FR-3.6.c) | `frontend/vite.config.js` + `vite-plugin-sri` | 0.5d | ⬜ |
| G086 | `fieldFilter.js` PII extension per role (FR-3.5.d) | middleware extension | 1.5d | ⬜ |
| G087 | Shadow-DOM embed widget (FR-3.6.b) | `frontend/public/embed/widget.js` rewrite | 2d | ⬜ |
| G088 | Sanitize-HTML allowlist review for operator-pasted content (FR-3.6.d) | review + test | 1d | ⬜ |

**§3.9 net effort: ~19 eng-days** (G077-G080 CSP enforcement is the critical cluster; iframe-isolate FR-3.6.a + JWT-cookie flip FR-3.1 + publicId FR-3.3.a/e are decision-blocked in §5.SEC)

### §3.10 PRD_TRAVEL_PER_SUBBRAND_BRANDING — buildable items (~16 of 33)

Most content (logos / palettes / fonts) blocked on Q22; surface wiring is buildable now.

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G089 | BrandKit schema extension: wordmark, hero, successBadge, warningBadge, heading/body/code font slots, CMYK colours, signatureTemplate, headerImage, footerText, invoiceStampUrl, missionStatement, supportEmail, supportPhone, socialLinks (FR-3.1.a-g) | schema (additive) + admin UI | 2d | ⬜ |
| G090 | Email template brand-kit consumer (FR-3.1.d, FR-3.3.d) | `lib/emailRender.js` extension | 1.5d | ⬜ |
| G091 | PDF voucher / itinerary / consent brand-kit consumers (invoice already partial) (FR-3.3.c) | `services/pdfRenderer.js` extensions | 2d | ⬜ |
| G092 | Customer portal brand-kit consumer (FR-3.3.f) | `pages/travel/TravelCustomerPortal.jsx` | 1d | ⬜ |
| G093 | Embed widget brand-kit consumer + `data-sub-brand` attr (FR-3.3.g, FR-3.4.c) | `frontend/public/embed/widget.js` | 1d | ⬜ |
| G094 | Public landing page brand-kit consumer (FR-3.3.h) | LandingPage renderer | 1d | ⬜ |
| G095 | Microsite brand-kit consumer (FR-3.3.i) | `routes/travel_microsites.js` + `PublicTripMicrosite.jsx` | 1d | ⬜ |
| G096 | Sidebar pinned-logo render (FR-3.3.a) | `components/Sidebar.jsx` | 0.5d | ⬜ |
| G097 | Email send-time sub-brand resolve (FR-3.4.d) | email service | 1d | ⬜ |
| G098 | `Tenant.defaultSubBrand` fallback column (FR-3.4.f) | schema (additive nullable) | 0.5d | ⬜ |
| G099 | BrandKit admin: Multer upload + WCAG checker + live preview + copy-from-sub-brand + version revert UI (FR-3.2.c, d, f, g, h) | `routes/brand_kits.js` + admin/BrandKits.jsx | 3d | ⬜ |
| G100 | Upload validation pipeline (size/dims/MIME/server-side scan) (FR-3.5.a-f) | Multer + validation lib | 1.5d | ⬜ |
| G101 | SMS/WhatsApp display-name interpolation per sub-brand (FR-3.3.e) | `lib/subBrandConfig.js` + SMS/WA services | 1d | ⬜ |
| G102 | CRM operator pages accent: swap consumer code from `travelSubBrand.js` color map → BrandKit (FR-3.3.b) | grep + sweep | 1.5d | ⬜ |

**§3.10 net effort: ~17.5 eng-days** (Google Fonts autocomplete blocked on DD-5.4 — small)

### §3.11 PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE — 3 gap items

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G103 | Admin surface for §3.5.5 assurance/trust standing-facts (verify EngineWeights covers + UI exposes all fields) | TmcCatalogueAdmin or EngineWeights admin | 0.5d | ⬜ |
| G104 | DD-5.7 blind-collapsed UX shape on DiagnosticDetail.jsx | `frontend/.../DiagnosticDetail.jsx` | 1d | ⬜ |
| G105 | §3.9 Calendar booking-link integration (deep-link to Calendar+Meet) | `routes/travel_diagnostics.js` extension | 1d | ⬜ |

**§3.11 net effort: ~2.5 eng-days**

### §3.12 PRD_TMC_CURRICULUM_MAPPING — 1 gap item

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G106 | E2E gate spec verification (FR-10) — confirm `travel-curriculum-api.spec.js` present + wired into deploy.yml | spec audit + add if missing | 0.5d | ⬜ |

PC-1 / Q13 (TMC academic-team data drop) is product-blocked, not engineering.

### §3.13 PRD_VISA_SURE_PHASE_3 — buildable items (1 of 8)

| ID | Slice | Files | Effort | Status |
|---|---|---|---|---|
| G107 | `RejectionRecoveryProgram` model + endpoint + UI (`VisaApplication.recoveryProgramId` already exists as forward-ref Int) (FR-7) | schema + route + `visa/RecoveryProgram.jsx` (NEW) | 2d | ⬜ |

Brand variants (G108-G110) Q22-blocked; visa-summary LLM Q11-blocked; WA advisor alert Q9-blocked → §4.

---

## 4. 🔵 Cred-blocked items (code stub shipped; flips on cred drop)

| Q-marker | Cred owner | Items it unblocks | Swap effort |
|---|---|---|---|
| **Q9 Wati** (3 WABA IDs + Meta System User token) | Yasin | Master PRD: 10 stubbed consumers (7 crons + 3 endpoints — OTP/reminders/boarding/journey/religious/payment). Multichannel FR-3.4.3 webhook sig. Quote FR-3.7.1 send. Visa FR-3.3 advisor alert dispatch. Flyer FR-3.5.1 WA share | 1-2d swap |
| **Q11 LLM keys** (Perplexity, Gemini, optionally Claude+GPT) | Yasin | Master PRD: talking-points, form-vs-call, call-summaries, cost dashboard. Visa visa-summary task. Flyer copy real mode. Itinerary-suggest real mode. Layout suggestion (G071) | 1d swap |
| **Q22 brand pack** (logos / palettes / fonts / PDF covers per sub-brand) | Yasin | Branding FR-3.1.a/b/c/f content. Visa Sure brand variants on PDFs (FR-1.3/2/5.3/8.3). Flyer brand-kit consumers (FR-3.3). Billing per-sub-brand PDF (FR-3.8.d). 4 PRDs concurrently | varies |
| **Q3 DigiLocker** (client ID/secret) | Travel Stall | Real Aadhaar KYC in TMC parent registration. Pairs with Q2 consent counsel | 1d swap |
| **Q19 RateHawk** (production API key/ID) | Travel Stall | RFU lowest-rate auto-pick — stub client `services/ratehawkClient.js` exists | 1d swap |
| **Q-MF-1 storage** (S3 vs Cloudinary cred) | Yasin | Flyer Asset model + Multer pipeline + tag search (FR-3.2.1-3, FR-3.2.5) | 2d build after cred |
| **Q-MF-2 AI image** (`OPENAI_API_KEY` or `STABILITY_API_KEY`) | Yasin | Flyer real-mode image gen — stub `services/marketingFlyerImageLLM.js` exists | 1d swap |
| **Q-GST-2** GSTIN reverse-check vendor cred | Travel Stall | GST FR-3.3.3 reverse-check (format-only today) | 1d swap |
| **Q-GST-3** per-sub-brand GSTINs | Travel Stall | GST FR-3.5 LUT + sub-brand GST resolution | 0.5d swap |
| **Q-GST-4** LUT references per sub-brand | Travel Stall | GST FR-3.5 LUT field | 0.5d swap |
| **Q-BILL-1** TCS non-filer flag source | Travel Stall | Billing FR-3.4.b 20% non-filer rate path (`Contact.tcsTaxFilerStatus`) | 1d build |
| **Q1 Callified.ai** | Travel Stall | AI qualification call real mode — stub `services/callifiedClient.js` exists | 1d swap |
| **Q1 AdsGPT** | Yasin | Marketing reports real mode | 1d swap |
| **Q1 Google Workspace** | Travel Stall | Drive folder auto-create on trip confirm — stub `services/googleDriveClient.js` exists | 1d swap |
| **Q8 Excel Software for Travel** vendor docs | Travel Stall | Accounting bridge — **stub NOT YET WRITTEN**; ~3-5d build post-docs | 3-5d post-docs |
| **PC-1 Passport OCR** | Travel Stall + GS | Largely shipped via tesseract.js + MRZ parser in PR #1150; cred-decision residual only | done |
| **Q21 DNS + wildcard SSL** (`*.tmc.travelstall.in`) | Travel Stall | TMC microsite dynamic subdomains | ops |
| **Q-RFU-1 Zikr Cabs** | Travel Stall + Yasin | RFU §3.1 8 FRs — stub `services/zikrCabsClient.js` exists. Still need `TravelGroundTransfer` model | 1d swap + 2d model |
| **Q-RFU-2..6 Almosafer/Tajawal/MyHoliday2/PilgrimsChoice/ReservationHouse** | Travel Stall + Yasin | RFU §3.2 5-portal hotel-scraper. **No code today** — `saudiHotelOrchestrator.js` + adapters all need to be built | 8-10d build |
| **Q-RFU-7 HHR Haramain** | Travel Stall + Yasin | RFU §3.3 8 FRs — stub `services/haramainRailClient.js` exists. Still need `TravelHsrBooking` model | 1d swap + 2d model |
| **Q6 / R11 on-prem infra handover** | Travel Stall | Phase-1 deploy target risk — flagged 🔴 in RISKS | W0 ops call |

---

## 5. 🟣 Decision-blocked items (product call needed)

### §5.B2B — entire B2B Agent Portal PRD (34 FRs gated on 7 DDs)

| DD | Decision needed |
|---|---|
| DD-5.1 | New app vs route prefix `/api/portal/b2b/*` (frontend topology) |
| DD-5.2 | Sub-agent commission ledger schema shape |
| DD-5.3 | Sub-agent markup policy editor UX |
| DD-5.4 | Corporate policy editor surface |
| DD-5.5 | Corporate approval-chain shape (single vs multi-approver) |
| DD-5.6 | Per-sub-brand portal theming strategy (reuse BrandKit vs portal-specific) |
| DD-5.7 | RBAC extension: SUB_AGENT and CORPORATE_USER actor types in audit log |

**Once DDs resolved, scope splits into 7 build clusters (~25-30 eng-days):**
- G108: SubAgent foundation (model + phone+OTP auth + verifySubAgentToken + reset)
- G109: Commission ledger + accrual + settlement + monthly cron + TDS + dispute
- G110: Sub-agent markup policy + clone-with-margin + non-resellable + audit
- G111: CorporateAccount + multi-user + email-OTP + verifyCorporateToken + traveler-profile cache
- G112: CorporatePolicy table + editor + validator + approval workflow
- G113: Expense reports per-employee/cost-center/FY + CSV/JSON/PDF exports
- G114: Per-portal audit log + per-sub-brand theming + frontend scaffold

### §5.SEC — Security items gated on decisions

| ID | Slice | Gated on |
|---|---|---|
| G115 | JWT → httpOnly cookie flip (verifyToken reads cookie; CSRF double-submit; `/api/auth/me` cold-start; feature-flag dual-mode) | **DD-5.1** cookie shape (same-site; refresh-token rotation policy) |
| G116 | publicId opaque-id migration on 14+ models | **DD-5.2** id-migration shape (nanoid vs UUIDv7 vs hashids; column name; index strategy) |
| G117 | Iframe-isolate sensitive panels (`crm-secure.globusdemos.com` subdomain split) | Product + ops decision |

### §5.OTHER — Other decision-blocked items

| ID | Slice | Gated on |
|---|---|---|
| G118 | FR-3.5(a) summary-as-default cross-cutting flip | **DD-5.4** per-endpoint hand-curated vs global middleware |
| G119 | Visa-risk PC-1..PC-5 product calls | Embassy rejection-rate catalogue, family detection, LLM narrative |
| G120 | DC-1..DC-5 airline check-in automation architecture | Top-4 airline portal-deep dive |
| G121 | Admin-editable diagnostic scoring (edit-with-audit + sandbox) (TMC PRD §16) | **Q16** product call |
| G122 | DD-5.5 supplier-commission TDS auto-deduct path | **DD-5.5** TDS owner-on-deduct policy |
| G123 | DD-5.7 PDF branding (per-sub-brand vs tenant default) | **DD-5.7** branding strategy |

---

## 6. ⏭️ Contractually deferred (Phase 1.5 / 2 / 3)

### §6.M — Master PRD residual (1 partial + 4 Phase commits)

| ID | Item | Phase | Effort | Trigger |
|---|---|---|---|---|
| G124 | A3 residual — per-document view/download/share audit-log rows | P1 W3 | ~1d | Engineering-actionable; pick anytime |
| G125 | Chrome flight-quote plugin (Manifest V3, signed CRX, auto-update, separate repo) | P1 W3 commitment | 10-15d | DC-1 (decision to start) |
| G126 | Airline web check-in automation P1B (top-4: IndiGo/AI/Vistara/Emirates) | P1 W4 commitment | 5-7d | DC-1..5 (architecture call) |
| G127 | Booking.com / Expedia direct APIs | P1.5 | 7-10d per provider | Commercial agreement |
| G128 | Excel Software for Travel API bridge | P1.5 | 3-5d post-Q8 | Q8 vendor docs |

### §6.RFU — RFU Phase 1.5 expansion

Once stubs flip (§4 Q-RFU-1..7), this lights up:

| ID | Item | Effort |
|---|---|---|
| G129 | Unified Umrah quote orchestration (§2.1 PRD_RFU) | 3d |
| G130 | Cancellation reconciliation across ground/hotel/HSR (§2.4 PRD_RFU) | 2d |

### §6.OTHER — Phase 2/3 items

| ID | Item | Phase | Effort |
|---|---|---|---|
| G131 | Travel Stall dedicated Family-Quiz UX + recommendations PDF + booking flow + analytics | Phase 2 | multi-day |
| G132 | Customer-duplicate full pop-up flow with preferences | Phase 2 | small |
| G133 | Birthday / anniversary greetings | Phase 2 | 2-3d |

---

## 7. Suggested execution waves

Recommended order of work; each wave should be one PR cluster.

### Wave 1 — Stop-the-bleed product debt (start immediately, no creds needed)

Fastest wins; each PR ≤2d; clears items rotting in TODOs:

1. **W1.A — Multichannel intake hardening** (G001, G002, G005, G006, G014) — Touchpoint + idempotency + UTM + response envelope + payload validators (~5d, 1 PR)
2. **W1.B — Pipeline stale PRD update** (G016) — 0.5d, doc-only
3. **W1.C — Itinerary template lineage + provenance** (G047, G049, G050, G051) — clonedFromTemplateId + metrics + save-as-template + draftedByAi (~3.5d, 1 PR)
4. **W1.D — Quote line schema extension** (G020) — HSN/SAC + tax% + discount% + dimension + isAddOn (~1.5d)
5. **W1.E — TravelInvoiceLine extension + GST persistence** (G021, G028, G029, G034) — supplierId + per-line cgst/sgst/igst + invoice-level GST + billingStateCode (~3d, 1 PR)
6. **W1.F — GST ledger endpoints** (G030, G031, G032, G033) — customer/TDS/commission ledgers + SAC seed (~4d, 1 PR)

**Wave 1 total: ~17.5 eng-days across 6 PRs.** Closes ~30 gap items.

### Wave 2 — Supplier workflow (highest-impact engineering-actionable cluster)

Biggest single gap (25 items). Suggest 3 PRs:

1. **W2.A — PO foundation** (G035, G036, G037) — model + state machine + PDF + auto-PO on booking-confirm (~5.5d)
2. **W2.B — Supplier governance** (G038, G039, G040, G041, G042, G043, G045) — KYC + dispute + status enum + payment-terms enum + credit-limit guard + commission link/ledger (~9.5d)
3. **W2.C — Reconciliation** (G044, G046) — PNR-keyed match + tolerance + bulk-reconcile UI + invoice PDF upload (~4.5d)

**Wave 2 total: ~19.5 eng-days across 3 PRs.** Closes 20 items.

### Wave 3 — Itinerary editor polish + Flyer studio expansion (in parallel)

Frontend-heavy; can run concurrently with Wave 2:

1. **W3.A — Itinerary editor** (G048, G052, G053, G055, G056, G057, G058, G060, G061, G062, G059) — versioning + bulk-day + conflicts + dedup + inline-add + per-day flow + analytics + UX polish + seed (~12d across 3 PRs)
2. **W3.B — Flyer studio** (G063, G064, G065, G066, G067, G068, G069, G070, G071, G072, G073, G075, G076) — block types + grid + undo/redo + preview toggle + lock + brand-kit + watermark + caching + AI layout + moderation + metadata + seed + WA-size (~13d across 4 PRs)

**Wave 3 total: ~25 eng-days across 7 PRs.** Closes ~30 items.

### Wave 4 — Branding consumers (Q22 cred-blocked → start NOW with stub content)

The branding wiring (consumer side) is buildable now with placeholder assets; flip to real assets when Q22 drops:

1. **W4.A — BrandKit schema + admin surface** (G089, G099, G100) — schema extension + Multer upload + WCAG + live preview + revert (~6.5d)
2. **W4.B — Render consumers** (G090, G091, G092, G093, G094, G095, G101, G102) — email + PDF + portal + embed + landing + microsite + WA display-name + operator-page sweep (~10d across 3 PRs)
3. **W4.C — Sidebar + email-send + Tenant.defaultSubBrand** (G096, G097, G098) — 2d

**Wave 4 total: ~18.5 eng-days across 5 PRs.** Closes ~16 items. Q22 drop flips all to real-content live.

### Wave 5 — Security hardening (CSP enforcement cluster)

High-stakes; needs careful staging:

1. **W5.A — CSP nonce → enforce** (G077, G078, G079, G080) — Report-Only → enforce script + style + source allowlist + X-XSS flip (~6d, careful rollout)
2. **W5.B — ACL + audit + PII** (G081, G083, G086) — object ACL + per-row PII audit + fieldFilter PII extension (~6.5d)
3. **W5.C — Tenant-scope sweep** (G082, G084) — cron-callsite audit + search projection exception (~2.5d)
4. **W5.D — Embed + SRI + sanitize sweep** (G085, G087, G088) — SRI + Shadow-DOM widget + sanitize allowlist review (~3.5d)

**Wave 5 total: ~18.5 eng-days across 4 PRs.** Closes 12 items.

### Wave 6 — Visa Sure recovery + small TMC items

1. **W6.A — RejectionRecoveryProgram** (G107) — 2d
2. **W6.B — TMC polish** (G103, G104, G105, G106) — assurance config + DD-5.7 UX + calendar booking + curriculum spec verify (~3d)

**Wave 6 total: ~5 eng-days across 2 PRs.** Closes 5 items.

### Waves 7+ — Decision-unblocked clusters

These wait on §2 P0 unblocks to fire:

- **Wave 7 — B2B Portal foundation** (G108-G114) — fires when 7 DD-5.* calls resolve; ~25-30 eng-days
- **Wave 8 — Security JWT-cookie + publicId migration** (G115, G116) — fires when DD-5.1 + DD-5.2 resolve; ~10-12 eng-days
- **Wave 9 — Chrome flight plugin** (G125) — fires when DC-1 (decision to start) resolves; 10-15 eng-days
- **Wave 10 — Airline check-in automation** (G126) — fires when DC-1..5 architecture call resolves; 5-7 eng-days
- **Wave 11 — RFU stub-flip + Saudi hotel-scraper build** (G101-G105 + G129/G130) — fires when Q-RFU-1..7 + RateHawk creds drop; ~15 eng-days (stubs flip fast; hotel-scraper build is the long pole)

---

## 8. Operating procedure

1. **Single source of truth:** this doc. PRDs are reference; all per-PRD status now reads from §1 + §3-§6.
2. **No parallel docs:** [TRAVEL_BIG_SCOPE_BACKLOG.md](TRAVEL_BIG_SCOPE_BACKLOG.md) is closed out (its arc is done; cron stopped). [TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md](TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md) is superseded.
3. **Workflow per slice (G-row):**
   - Pick the next ⬜ row in dependency order (Waves §7 sequence).
   - Implement against the Files column.
   - Land with all 6 deploy gates green.
   - Flip Status to ✅ with commit SHA on the same row in the SAME commit, e.g. `✅ DONE 2026-06-NN — abc1234`.
4. **Cred drop workflow (🔵 items):** when a Q-marker resolves, find every row in §4 referencing it, dispatch the swap-effort PRs in parallel where files are disjoint.
5. **Decision drop workflow (🟣 items):** when a DD resolves, the gated rows in §5 become ⬜ — move them into the next Wave and queue.
6. **Gap-discovery exception:** if implementation reveals a NEW gap not in this tracker, append a new G-row at the bottom of the relevant §3 section in a dedicated commit. Don't flip existing markers from a discovery commit.
7. **PR scope:** one Wave-cluster (W*.X) per PR. Don't cross clusters. Cross-cutting shape changes (response envelope, audit row shape) require an audit per the standing rule in CLAUDE.md.
8. **Status header updates:** when ≥10 items in a PRD flip ✅, update that PRD's Implementation Status header to reflect the new count.

---

## 9. Change log

- **2026-06-13** — Initial tracker authored. 6 parallel audit agents over 15 sub-PRDs + master PRD delta-check; 433 sub-PRD FRs + 95 master-PRD items measured; 249 net gap items grouped into ~130 G-rows across 11 waves. Supersedes the cron-driven big-scope backlog and the master-PRD-only gap analysis from 2026-06-12.
