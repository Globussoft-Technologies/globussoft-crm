# Travel CRM — Portal-wise Feature Matrix

**Source documents:** 19 files in `travel-crm/` (last reviewed 2026-05-23). Authoritative per-portal feature lists pulled from the 4 "CRM development" PDFs (`TMC - CRM development.pdf`, `RFU - CRM development.pdf`, `Travelstall - CRM development.pdf`, `Visa Sure - CRM development.pdf`) plus the cross-cutting `Req Doc After Meeting.pdf` (Yasin's Section 12 matrix of 53 rows) and `GlobusSoft_Response_15May2026.pdf` (GS's 6-week Phase-1 plan with weekly milestones).

**Implementation state:** cross-checked against the PRD-gap audit at [docs/TRAVEL_CRM_GAP_AUDIT_2026-05-22.md](TRAVEL_CRM_GAP_AUDIT_2026-05-22.md) (78/78 §4 PRD requirements SHIPPED; 5 PARTIAL; 8 cred-blocked; 2 product-call-blocked) and the manual-coding backlog at [docs/MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) (clusters A-F: design-call / multi-day-feature / cred-dependent / wellness-session / product-call). Path-grep verified at HEAD against `backend/routes/travel_*.js`, `backend/cron/*`, `backend/lib/*`, `backend/services/*`, `frontend/src/pages/travel/*`, `frontend/src/pages/public/Travel*` and `backend/prisma/schema.prisma`.

**Maintenance:** update on every PRD doc revision OR when a portal-level feature ships/is cut. Auto-shipped items get refreshed by the autonomous cron via the gap-audit refresh cycle; high-level scope changes (new sub-brand, deprecated feature) need manual editor review.

---

## Overview — 4 portals + the operator CRM

The Travel CRM hosts **4 customer-facing sub-brands** on a single tenant (`Tenant.vertical = "travel"`, `subBrandAccess[]` on User per Q25) plus the GlobusSoft operator CRM that internal staff use to service all four. Each sub-brand has its own go-to-market positioning (diagnostic-first for TMC / RFU / Visa Sure; conventional B2C funnel for Travel Stall), shared infrastructure (auth, billing, integrations) and its own product ladder of entry / primary / premium offerings. Phase-1 launches TMC and RFU as the two committed brands (per the GS response's W1–W6 plan); Travel Stall is Phase 2 (already partly shipped — see §Travel Stall below); Visa Sure is Phase 3 (schema-only today).

| Portal | Target user | Source doc | Phase 1 launch state |
|---|---|---|---|
| TMC (The Modern Classroom) | School trips — schools / principals / coordinators / activity heads / teachers / parents / students | `TMC - CRM development.pdf` + `TMC_Business_Blueprint_For_Tech_Team.md.pdf` | **~95% SHIPPED** — diagnostic, sales workflow, trip mgmt, microsite, ops dashboard, accounting, analytics all live. Pending: DigiLocker Q3 cred drop, Wati Q9 cred drop, parent-facing registration UI route |
| RFU (Ready for Umrah) | Umrah pilgrims (4 readiness levels: Confident & Prepared / Guided for Peace of Mind / Assisted for Comfort & Correctness / Supported Journey Recommended) | `RFU - CRM development.pdf` + `Ready_for_Umrah_Business_Blueprint.md.pdf` | **~90% SHIPPED** — diagnostic, scoring, classification, product ladder, quotation engine (manual cost master + LLM draft), payment, journey reminders all live. Pending: RateHawk Q19 (lowest-rate auto-select), Wati Q9 (real WA dispatch on reminders + religious-guidance) |
| Travel Stall (B2C holidays + ticketing) | Family-holiday customers | `Travelstall - CRM development.pdf` + `Travel_Stall_Business_Blueprint_For_Tech_Team.md.pdf` | **~70% SHIPPED** — Family Travel Quiz, 50%-advance public booking, source-tracking, duplicate detection, GST capture, analytics schema all live. Pending: dedicated `/travel-stall` operator UI, Booking.com/Expedia direct (Phase 1.5), TS-specific personalised 3-5 destination PDF (LLM-driven) |
| Visa Sure (Visa correctness + assurance) | Visa applicants (4 readiness levels + rejection-recovery tier) | `Visa Sure - CRM development.pdf` + `Visa_Sure_Business_Blueprint (1).pdf` | **~15% SHIPPED (Phase 3)** — schema models exist (`VisaApplication` + `VisaDocumentChecklistItem`) and are seeded; no routes, no UI, no risk-flag engine. All work scoped to Phase 3 per Q18 |
| Operator CRM | GS staff servicing all 4 sub-brands (admin / manager / staff / advisor roles, sub-brand access scoped via `User.subBrandAccess[]`) | Cross-cutting via `Req Doc After Meeting.pdf` §3-5, §11-12 + the 6-week plan | **~85% SHIPPED** — multi-brand auth/SSO, RBAC, 8-status pipeline, 8 lost-reason taxonomy, marketing reports, manager view, accounting, login vault, ops dashboard all live. Pending: SSO real-mode (Q7 stub), Excel-Software bridge (Q8), AdsGPT live (Q1), Callified.ai live (Q1), Chrome flight plugin (multi-day B4) |

---

## Per-portal feature matrix

### Portal 1: TMC (The Modern Classroom) — school-trips operator

**Positioning per PRD:** diagnostic-first, not destination-first. Sales flow: Lead → School diagnostic → Human consultation → Prescription → Quotation → Trip confirmation → Operational execution.

| # | Feature | Phase per PRD | State | Evidence | Notes |
|---|---|---|---|---|---|
| T1 | School diagnostic engine — editable Q-bank | P1 (W2) | ✅ SHIPPED | `backend/routes/travel_diagnostics.js:139` POST `/diagnostic-banks` admin endpoint; `frontend/src/pages/travel/DiagnosticBuilder.jsx` | Phase 1 view-only per Q16; admin edit Phase 1.5 |
| T2 | Curriculum mapping logic (CBSE / IB / ICSE / Cambridge → destinations) | P1 (W2) | ⏸️ BLOCKED (product-call Q13) | No code surface | Curriculum→destination map needs Yasin's content drop; PRD §4.2 row `curriculum_recommendations` |
| T3 | PDF recommendation report (branded per sub-brand) | P1 (W2) | ✅ SHIPPED | `backend/routes/travel_diagnostics.js:43-78` GET `/diagnostics/:id/report.pdf`; pdfkit-based | Per-sub-brand templates placeholder until Q22 brand assets |
| T4 | Sales workflow — call booking (Google Meet) | P1 (W3) | ✅ SHIPPED | `backend/routes/calendar_google.js` (reused from main CRM) | Meet API integration; booking link sent on advisor trigger |
| T5 | Sales workflow — CRM task creation + stage tracking | P1 (W1) | ✅ SHIPPED | `backend/routes/tasks.js` + 8-status pipeline (`backend/prisma/seed-travel.js:518, 1046` `seedPipelineTaxonomies()`); gate spec `e2e/tests/travel-seed-taxonomy-api.spec.js` | Statuses: New · Diagnostic Complete · Qualifying · Quoted · Negotiating · Won · Lost · Dormant |
| T6 | Trip management — auto-create Trip record on confirmation | P1 (W4) | ✅ SHIPPED | `backend/routes/travel_trips.js` (17 endpoints) + `TmcTrip` model `backend/prisma/schema.prisma:4293` | Triggers Drive folder auto-create (stub) |
| T7 | Trip management — auto-generate trip microsite | P1 (W4) | ✅ SHIPPED | `backend/routes/travel_microsites.js` admin + public; `TripMicrosite` model `schema.prisma:4614` | Subdomain pattern `trip-<code>.tmc.travelstall.in` per Q21; pending DNS |
| T8 | Parent registration portal (Aadhaar OCR) | P1 (W4) | 🟡 PARTIAL | `backend/routes/travel_trips.js:510,546` DigiLocker initiate/callback (commit `1babe1b`); `backend/services/digilockerClient.js` stub mode | Backend complete; parent-facing public registration UI route missing (cluster F in MANUAL_CODING_BACKLOG); Q3 cred-drop swaps stub → real |
| T9 | Student data capture | P1 (W4) | ✅ SHIPPED | `TripParticipant` model `schema.prisma:4320` + `backend/routes/travel_trips.js` participant endpoints | |
| T10 | Passport upload with OCR extraction + manual verification | P1 (W4) | ⏸️ BLOCKED (cred-dependent C-cluster) | `TripParticipant.passportNumber/Expiry/DocId` columns exist; storage encrypted via `backend/lib/fieldEncryption.js` | Google Document AI / Azure FR creds pending |
| T11 | Payment plan tracking (TMC) | P1 (W5) | 🟡 PARTIAL | `TripPaymentPlan` + `TripInstalmentPayment` + `backend/routes/travel_trip_billing.js` + `backend/cron/tripPaymentReminders.js` | WA dispatch stub (Q9); `/instalments/from-plan` materialiser Phase 1.5 |
| T12 | Rooming allocation interface | P1 (W4) | ✅ SHIPPED | `backend/routes/travel_trip_billing.js:65-200` CRUD + `RoomingAssignment` model + `TripDetail.jsx` RoomingTab UI | |
| T13 | Downloadable rooming list (XLSX) | P1 (W4) | ✅ SHIPPED | `backend/routes/travel_trip_billing.js:233` XLSX export endpoint (commit `de1be50`); Download CTA in `TripDetail.jsx`; 4 gate-spec cases | ADMIN+MANAGER gated; 5 columns (Room # / Type / Capacity / Occupancy / Participants) |
| T14 | Departure checklist + per-student doc checklist | P1 (W4) | 🟡 PARTIAL | `TripDocumentRequirement` model `schema.prisma:4418` + `backend/routes/travel_trips.js:603-654` | Trip-scoped (no `status` / `participantId` columns); per-participant join GAP-AUTONOMOUS (additive migration + UI follow-on; cluster B in MANUAL_CODING_BACKLOG) |
| T15 | Operations dashboard — student count / pending payments / missing docs / rooming status | P1 (W5) | ✅ SHIPPED | `GET /api/travel/trips/:id/ops-dashboard` (`backend/routes/travel_trips.js:235-418`, commit `9eda0b6`); 30/30/30/10 weighted `departureReadiness.score`; `frontend/src/pages/travel/TripDetail.jsx` consumer | `submittedCount=0` placeholder until T14 per-participant tracking ships |
| T16 | Accounting — payment tracking + GST logic (CGST/SGST/IGST) | P1 (W5) | ✅ SHIPPED | `backend/routes/billing.js` (reused) + `Invoice.legalEntityCode` `schema.prisma:814` | Per-entity (TMC Nexus Pvt Ltd) routing |
| T17 | Accounting — export for CA / Tally | P1 (W5) | ✅ SHIPPED | `backend/routes/billing.js:130` `/export/tally.xml` + `:181` `/export/ca-summary.csv` (commit `4a07fca`); `backend/lib/tallyXmlExport.js` | Q5 sample CA export pending validation |
| T18 | Analytics — revenue by destination | P1 (W5) | ✅ SHIPPED | `backend/routes/travel_reports.js:69` `/reports/tmc` | |
| T19 | Analytics — repeat school rate | P1 (W5) | ✅ SHIPPED | Same route; school identity from `Contact.companyName` | |
| T20 | Analytics — profit margin by trip | P1 (W5) | ✅ SHIPPED | Same route; reads `TmcTrip.budgetCostPaise` + `TmcTrip.budgetRevenuePaise` | |
| T21 | Analytics — conversion by diagnostic score | P1 (W5) | ✅ SHIPPED | Same route; joins `TravelDiagnostic.classification` to Deal stage transitions | |
| T22 | Trip confirmed-microsite preview (admin) | P1 (W4) | 🔴 NOT-STARTED | `Glob frontend/src/pages/travel/TmcMicrositePreview*` returns 0 | GAP-AUTONOMOUS low-value; admin preview not wired |
| T23 | TMC microsite OTP (4-digit, 10-min validity, WA delivery) | P1 (W4) | 🟡 PARTIAL | `backend/routes/travel_microsites.js:396,469,536` request/verify/reveal; OTP gen + verify shipped; WA delivery stub | Wati Q9 cred-drop swaps stub |
| T24 | TMC payment-reminder cron + WA blast | P1 (W5) | 🟡 PARTIAL | `backend/cron/tripPaymentReminders.js` | WA dispatch stub (Q9); per-sub-brand WABA selection pre-wired via `backend/lib/subBrandConfig.js` (commit `621aab7`) |
| T25 | TMC pre-trip + post-trip feedback form | P1 (W4) | 🟡 PARTIAL | `backend/cron/tripPostTripFeedback.js` | WA dispatch stub (Q9) |
| T26 | Teacher access (read-only student list + rooming via OTP-protected link) | P1 (W4) | ✅ SHIPPED (partial) | `TripMicrositeOtp.purpose = "teacher-access"` (`schema.prisma:4631`, `backend/routes/travel_microsites.js:45`) | No dedicated teacher UI surface yet; OTP infrastructure complete |
| T27 | Drive folder auto-creation on confirmed trip | P1 (W2) | 🟡 PARTIAL (stub-mode) | `backend/services/googleDriveClient.js` (commit `192de86`) + wire-in `backend/routes/travel_trips.js:140-166, 271-282` | Google Workspace OAuth creds (Q1) unlocks real |

---

### Portal 2: RFU (Ready for Umrah) — Umrah pilgrim operator

**Positioning per PRD:** correctness and assurance, not lowest price. 3-tier product ladder: Entry (Readiness Check) / Primary (Correctness Assured Umrah Program) / Premium (Private Assisted Elder Care Umrah). 15-question diagnostic classifies into 4 readiness levels (Confident & Prepared / Guided for Peace of Mind / Assisted for Comfort & Correctness / Supported Journey Recommended).

| # | Feature | Phase per PRD | State | Evidence | Notes |
|---|---|---|---|---|---|
| R1 | Diagnostic engine — 15 structured questions, weighted scoring | P1 (W2) | ✅ SHIPPED | `backend/lib/travelDiagnosticScoring.js` + 20+ vitest cases; `TravelDiagnosticQuestionBank` + `TravelDiagnostic` models | |
| R2 | Classification into 4 readiness levels | P1 (W2) | ✅ SHIPPED | `TravelDiagnostic.classification` + `.classificationLabel` + `.recommendedTier` (`schema.prisma:4080-4092`) | Phase-1 banded thresholds; Phase-1.5 admin edit Q16 |
| R3 | Editable scoring logic from admin panel | P1.5 (Q16) | 🟡 PARTIAL | Backend POST `/diagnostic-banks` admin endpoint shipped (`routes/travel_diagnostics.js:139`); UI view-only | Per A.6 of GS response: Phase 1 view-only; Phase 1.5 edit-with-audit |
| R4 | Auto-generated PDF report (per-sub-brand branded) | P1 (W2) | ✅ SHIPPED | `backend/routes/travel_diagnostics.js:43-78` GET `/diagnostics/:id/report.pdf`; pdfkit-based | Per-sub-brand template via Q22 brand assets |
| R5 | Automatic CRM record creation (Contact + TravelDiagnostic + AgentRecommendation) | P1 (W2) | ✅ SHIPPED | `backend/routes/travel_diagnostics.js:493-557` public submit endpoint | Auto-Deal-creation manual today (PRD §4.1 row) |
| R6 | Diagnostic-completion advisor alert + talking-points generation | P1 (W2) | ✅ SHIPPED | `backend/cron/travelDiagnosticAdvisorAlerts.js`; `POST /api/travel/diagnostics/:id/talking-points/regen` (`routes/travel_diagnostics.js:396`, commit `cf876af`); LLM router consumer; UI render at `DiagnosticDetail.jsx` (commit `2440b4a`) | Stub-mode-ready; real Claude Opus on Q11 keys |
| R7 | High-risk readiness flag + automatic priority routing | P1 (W2) | ✅ SHIPPED | `TravelDiagnostic.classification == "supported-journey-recommended"` triggers high-priority assignment via `AgentRecommendation`; advisor alert cron picks up | |
| R8 | Follow-up reminders auto-scheduled | P1 (W2) | ✅ SHIPPED | `backend/cron/travelJourneyReminders.js` | WA dispatch stub (Q9) |
| R9 | RFU product-tier tagging on lead (Readiness / Correctness / Elder Care) | P1 (W2) | ✅ SHIPPED | `Itinerary.productTier` (commit `2612a7e`); auto-set from diagnostic `recommendedTier` | |
| R10 | Quotation engine — base cost from cost master + rule-based markup | P1 (W3) | ✅ SHIPPED | `backend/routes/travel_itineraries.js` (15+ endpoints) + `backend/routes/travel_cost_master.js` (5 endpoints) + `backend/lib/travelPricing.js` + `TravelMarkupRule` + `TravelSeasonCalendar` | Rule-based; Phase 1 manual contracted-rate entry |
| R11 | Quotation engine — unified search (flight + hotel + transport) | P1 (W3) | 🟡 PARTIAL | `backend/routes/travel_itineraries.js` ships full CRUD + items + version chain + share + PDF + accept/reject + LLM draft | "Unified-search lowest-rate auto-select" requires RateHawk (Q19 cred-blocked) |
| R12 | Hotel rate comparator (Booking.com / Expedia / direct) | P1 (W3) | ⏸️ BLOCKED (cred-dependent Q19) | `Glob backend/services/ratehawk*` returns 0; cluster C4 in MANUAL_CODING_BACKLOG (~3-5d post-cred) | Phase 1 uses RateHawk per GS response B.3; Booking/Expedia Phase 1.5 |
| R13 | Preference filters (Haram-facing / Kaaba-facing / room category / floor level) | P1 (W3) | 🟡 PARTIAL | `TravelCostMaster.attributesJson` (`schema.prisma:4196`) supports them; `Grep haram\|Haram` in `pages/travel/CostMaster.jsx` returns 0 hits | Filter UI gap; data model ready |
| R14 | Rule-based transport pricing with seasonal logic (peak vs lean) | P1 (W4) | ✅ SHIPPED | `TravelSeasonCalendar` + `TravelMarkupRule` + `backend/routes/travel_pricing.js` + `backend/lib/travelPricing.js` | |
| R15 | Markup / GST / discount logic by rule (no AI) | P1 (W3) | ✅ SHIPPED | `backend/lib/travelPricing.js` (vitest covered) | Per-tenant + per-sub-brand rule layering |
| R16 | Auto-generated branded itinerary PDF | P1 (W3) | ✅ SHIPPED | `backend/routes/travel_itineraries.js:706` GET `/itineraries/:id/pdf` | |
| R17 | Itinerary version history (draft / sent / revised / accepted / rejected) | P1 (W4) | ✅ SHIPPED | `Itinerary.parentItineraryId` + `Itinerary.status` enum at `schema.prisma:4163+` | |
| R18 | Shareable WhatsApp rate-card (under 5 min) | P1 (W3) | 🟡 PARTIAL | `backend/routes/travel_itineraries.js:761` `/share` returns share URL; WA send pending Q9 | One-line swap on cred drop (subBrandConfig helper pre-wired) |
| R19 | LLM-switchable layer (Perplexity / Gemini / Claude / GPT) | P1 (W2) | ✅ SHIPPED | `backend/lib/llmRouter.js` (commit `583c06b`); 3 consumers live (talking-points `cf876af` + form-vs-call `4a7c623` + itinerary-draft `f02fa5a`) | Stub-mode; real-mode on Q11 keys |
| R20 | Document management — passport uploads + checklist + status tracking | P1 (W4) | 🟡 PARTIAL | `TripParticipant.passportNumber/Expiry/DocId` columns; encrypted via `lib/fieldEncryption.js` | Passport OCR cred-blocked |
| R21 | Payment tracking linked to correct legal entity (Labbaik Tours & Travels) | P1 (W5) | ✅ SHIPPED | `Invoice.legalEntityCode` (`schema.prisma:814`) | IATA-accredited Labbaik entity |
| R22 | Payment tracking — exportable financial reports | P1 (W5) | ✅ SHIPPED | `backend/routes/billing.js:130` Tally export + `:181` CA-summary CSV | |
| R23 | Analytics — conversion rate by readiness level | P1 (W5) | ✅ SHIPPED | `backend/routes/travel_reports.js:193` `/reports/rfu` | |
| R24 | Analytics — revenue per tier | P1 (W5) | ✅ SHIPPED | Same route; reads `Itinerary.productTier` | |
| R25 | Analytics — lead source to booking ratio | P1 (W5) | ✅ SHIPPED | Same route; joins `Contact.firstTouchSource` to `Itinerary.status = accepted` | |
| R26 | RFU customer profile (full fields per PRD §4.5) | P1 (W5) | ✅ SHIPPED | `RfuLeadProfile` model + `backend/routes/travel_rfu_profiles.js` + `frontend/src/pages/travel/RfuCustomerProfile.jsx` | Fields: full name, DOB, family, passport, visa history, travel history, preferences, medical notes, emergency contact |
| R27 | Customer-duplicate detection (name + phone + passport) | P1 (W5) | ✅ SHIPPED | `findDuplicateContactFull` (commit `ea817fb`); 409 envelope (`routes/contacts.js:263-278`); UI modal `frontend/src/components/DuplicateContactModal.jsx` (commit `b18c5c4`) | Email + phone + passport keys |
| R28 | Birthday / anniversary greetings | P2 | ✅ SHIPPED (early) | `backend/cron/contactGreetingsEngine.js` | Phase 2 per PRD; shipped ahead of schedule |
| R29 | Umrah journey reminders (driver / hotel / group / departure) | P1 (W5) | 🟡 PARTIAL | `backend/cron/travelJourneyReminders.js` | WA dispatch stub (Q9) |
| R30 | Religious-guidance content delivery | P1 (W5) | ✅ SHIPPED | `backend/cron/religiousGuidanceEngine.js` (commit `1e62ee9`) — daily 09:13 IST, T-14d window, dayOffset-matched fan-out; `frontend/src/pages/travel/ReligiousPackets.jsx` admin UI (commit `f903f4b`) | Real WA dispatch pending Q9; placeholder content pending Yasin Q1 |
| R31 | Cost master + seasonal calendar admin panel | P1 (W4) | ✅ SHIPPED | `backend/routes/travel_cost_master.js` (5 endpoints) + `frontend/src/pages/travel/CostMaster.jsx` + CSV `routes/travel_csv_io.js` | Admin-editable |
| R32 | Premium tier — Private Assisted Elder Care Umrah | P1 (W2) | ✅ SHIPPED | Tier captured in `Itinerary.productTier = "elder-care"`; advisor handover via `AgentRecommendation` | |

---

### Portal 3: Travel Stall (B2C holidays + ticketing)

**Positioning per PRD:** B2C travel services — holidays + ticketing. Conventional funnel (not diagnostic-first like TMC / RFU / Visa Sure). Per Q17, Phase 2 scope = Family Travel Quiz + 50%-advance booking + analytics; deeper TS-only features deferred.

| # | Feature | Phase per PRD | State | Evidence | Notes |
|---|---|---|---|---|---|
| TS1 | Lead capture — source tracking | P2 | ✅ SHIPPED (reuse) | `Contact.firstTouchSource` + Touchpoint already wired in main CRM | UTM + ad-source attribution live |
| TS2 | Lead capture — inquiry type tagging | P2 | ✅ SHIPPED (reuse) | `Contact.tags` + `Deal.dealType`; `Contact.subBrand="travel-stall"` filter | |
| TS3 | Sales — follow-up reminders | P2 | ✅ SHIPPED (reuse) | `backend/routes/tasks.js` + Sequence engine | |
| TS4 | Sales — quotation upload | P2 | ✅ SHIPPED (reuse) | `backend/routes/contacts.js` ContactAttachment + Quote model | |
| TS5 | Sales — status tracking | P2 | ✅ SHIPPED | 8-status pipeline (same as TMC/RFU); seeded via `prisma/seed-travel.js` | |
| TS6 | Operations — passenger data collation | P2 | ✅ SHIPPED (reuse) | `Contact` model + custom fields | |
| TS7 | Operations — ticketing data export (CSV) | P2 | ✅ SHIPPED (reuse) | `backend/routes/travel_csv_io.js` + main CRM CSV export | |
| TS8 | Payment tracking linked to Travel Stall entity | P2 | ✅ SHIPPED | `Invoice.legalEntityCode = "TRAVEL_STALL"` (`schema.prisma:814`) | |
| TS9 | GST compliance | P2 | ✅ SHIPPED (reuse) | `backend/routes/billing.js` CGST/SGST/IGST capture | |
| TS10 | Analytics — revenue by destination | P2 | 🟡 PARTIAL | Schema ready (Itinerary + Invoice joins); no dedicated `/reports/travel-stall` endpoint yet | Per Q17 deferred; main reports route can filter by sub-brand |
| TS11 | Analytics — conversion rate by channel | P2 | 🟡 PARTIAL | Same schema; reports route extension pending | |
| TS12 | Analytics — salesperson performance | P2 | 🟡 PARTIAL | `Deal.assignedToId` + main CRM agent reports usable; TS-scoped variant pending | |
| TS13 | Family Travel Quiz (TS-specific entry product) | P2 | ✅ SHIPPED | `frontend/src/pages/public/TravelStallQuiz.jsx` (commit `1260caa`) + `/diagnostics/public/*` endpoints | Public diagnostic; outputs recommended-tier flow |
| TS14 | 50%-advance booking flow (public) | P2 | ✅ SHIPPED | `backend/routes/travel_itineraries.js:773,833` public share-token + advance-payment (commit `8abf6f3`); per-tenant ratio (commit `ee35d00`) | Tunable advance ratio per `TenantSetting` |
| TS15 | Email-first acquisition (newsletter / nurture) | P2 | ✅ SHIPPED (reuse) | Email engine + Sequence engine | |
| TS16 | Birthday / anniversary greetings | P2 | ✅ SHIPPED | `backend/cron/contactGreetingsEngine.js` (shared with RFU R28) | |
| TS17 | Customer-duplicate detection | P2 | ✅ SHIPPED | `findDuplicateContactFull` + `frontend/src/components/DuplicateContactModal.jsx` | Same helper as RFU R27 |
| TS18 | Personalised 3-5 destination PDF (LLM-driven) | P2 | 🔴 NOT-STARTED | LLM-router scaffold + 3 consumers ship; PDF-specific consumer absent | Would be 4th LLM consumer; pairs with §4.3 bulk-text pattern; cluster B in MANUAL_CODING_BACKLOG |
| TS19 | Booking.com / Expedia direct API for hotel + flight inventory | P1.5 / P2 | ⏸️ BLOCKED (cred-dependent) | No code surface | Cluster B6 / C in MANUAL_CODING_BACKLOG (~7-10d per provider post-cred); RateHawk covers P1 |
| TS20 | Travel Stall WABA-isolated WhatsApp number | P1 (W1) | ⏸️ BLOCKED (Q9) | `Tenant.subBrandConfigJson` resolves `wabaId` per sub-brand (`backend/lib/subBrandConfig.js`, commit `621aab7`); 7 crons + 3 endpoints stub-dispatching with correct WABA selection | Wati Q9 cred-drop swap |
| TS21 | Dedicated `/travel-stall` operator UI surface | P2 | 🔴 NOT-STARTED | Reports route + LeadDetail viewable but no `/travel-stall` landing operator page | Low priority per Q17 |

---

### Portal 4: Visa Sure (Visa correctness + assurance)

**Positioning per PRD:** diagnoses readiness before any commercial transaction. 3-tier product ladder: Visa Readiness & Correctness Check (entry) / Correctness Assured Visa Program (primary) / Rejection Recovery & Re-application Program (premium). 15-question diagnostic classifies into 4 readiness levels (same labels as RFU). **Per Q18: deferred to Phase 3.** Schema models exist + seeded; no routes, no UI, no risk-flag engine.

| # | Feature | Phase per PRD | State | Evidence | Notes |
|---|---|---|---|---|---|
| V1 | Diagnostic engine — 15-question assessment | P3 | 🏗️ MULTI-DAY (cluster B3) | `TravelDiagnosticQuestionBank` model + scoring engine `backend/lib/travelDiagnosticScoring.js` shared; needs VS question bank seed + route wiring | Reuses RFU diagnostic plumbing; ~½ day for content load |
| V2 | Classification into 4 readiness levels | P3 | 🏗️ MULTI-DAY (cluster B3) | Same plumbing as RFU; needs VS-specific classification rule load | |
| V3 | Editable scoring logic | P3 | 🏗️ MULTI-DAY (cluster B3) | Same as RFU R3 | |
| V4 | Auto-generated PDF report | P3 | 🏗️ MULTI-DAY (cluster B3) | Same PDF infra as RFU R4; needs VS template | |
| V5 | Risk flagging — complex case flags | P3 | 🟡 PARTIAL (schema only) | `VisaApplication.advisorRiskFlag` (`schema.prisma:4507`) | No engine emits transitions; needs B3 risk-flag engine |
| V6 | Risk flagging — rejection history tagging | P3 | 🟡 PARTIAL (schema only) | `VisaApplication.priorRejectionCount` + `priorRejectionReasons` (`schema.prisma:4503-4505`) | Schema only |
| V7 | Risk flagging — advisor priority alerts | P3 | 🔴 NOT-STARTED | No `visaRiskFlagEngine.js` cron | Cluster B3 |
| V8 | Advisor dashboard — diagnostic answers visible | P3 | 🔴 NOT-STARTED | `Glob frontend/src/pages/travel/Visa*` returns 0 | Cluster B3 (~2 weeks total) |
| V9 | Advisor dashboard — AI summary notes (optional) | P3 | 🔴 NOT-STARTED | LLM router available; consumer not wired | |
| V10 | Advisor dashboard — risk indicators clearly shown | P3 | 🔴 NOT-STARTED | Same dashboard scope as V8 | |
| V11 | Quotation — manual or structured per case | P3 | 🟡 PARTIAL (schema only) | `VisaApplication` model has pricing fields | Reuses Itinerary infra |
| V12 | Quotation — stored in CRM | P3 | 🟡 PARTIAL (schema only) | Same | |
| V13 | Document upload — structured checklist | P3 | 🟡 PARTIAL (schema only) | `VisaDocumentChecklistItem` model (`schema.prisma:4530`) + 4 seeded items (commit `78884e3`) | No routes / UI; cluster B3 |
| V14 | Document upload — status tracking | P3 | 🟡 PARTIAL (schema only) | `VisaDocumentChecklistItem.status` enum exists | |
| V15 | Rejection-recovery program workflow | P3 | 🟡 PARTIAL (schema only) | `VisaApplication.recoveryProgramId` placeholder | Cluster B3 |
| V16 | Analytics — rejection recovery success rate | P3 | 🔴 NOT-STARTED | No `/reports/visa` route | |
| V17 | Analytics — conversion by readiness level | P3 | 🔴 NOT-STARTED | Same | |
| V18 | Analytics — lead source to application rate | P3 | 🔴 NOT-STARTED | Same | |
| V19 | Visa Sure landing route + sidebar nav | P3 | 🔴 NOT-STARTED | `Sidebar.jsx renderTravelNav()` has no VS group; no `/travel/visa/*` mounted in `App.jsx` | |

---

### Portal 5: Operator CRM (cross-cutting — GS staff servicing all 4 sub-brands)

**Positioning per `Req Doc After Meeting.pdf` §3-12:** single CRM login for all staff with role-based permissions, brand-level access control (`User.subBrandAccess[]` per Q25), shared customer data, enquiry + task management, management dashboard across all 4 sub-brands. Drives the 6-week W1–W6 plan from GS response §A.1.

| # | Feature | Phase per PRD | State | Evidence | Notes |
|---|---|---|---|---|---|
| O1 | Multi-brand CRM with brand-level access + SSO | P1 (W1) | 🟡 PARTIAL | `User.subBrandAccess` (`schema.prisma:357`); SSO stub-mode via `backend/routes/sso.js` | Real SSO swap pending Q7 (Google Workspace SSO recommended) |
| O2 | Role-based permissions (ADMIN / MANAGER / USER) | P1 (W1) | ✅ SHIPPED (reuse) | `backend/middleware/auth.js verifyRole` + sub-brand scoping via `User.subBrandAccess` | RBAC live; sub-brand layer added on top |
| O3 | Google Workspace integration (Gmail / Calendar / Drive / Docs / Sheets / Meet / Contacts / Forms) | P1 (W1) | 🟡 PARTIAL | `backend/services/googleDriveClient.js` (commit `192de86` stub) + `backend/routes/calendar_google.js` (real) | Drive auto-create on confirmed TMC trip = stub until Q1 cred drop |
| O4 | Drive folder auto-creation (TMC trips) | P1 (W2) | 🟡 PARTIAL (stub-mode) | `backend/routes/travel_trips.js:140-166, 271-282` (commit `192de86`) | Q1 Workspace creds unlock real |
| O5 | Embedded WhatsApp Web for staff numbers | P1 (W1) | ✅ SHIPPED (reuse) | `backend/routes/whatsapp.js` | Conversation logging |
| O6 | WhatsApp Business API + templates + leads-to-enquiries (3 WABA: TMC, RFU, ops) | P1 (W1) | ⏸️ BLOCKED (Q9) | `backend/services/whatsappProvider.js` (Meta direct upstream); Wati pending Q9 creds | 7 crons + 3 endpoints stub-dispatching; per-sub-brand WABA pre-routed via `backend/lib/subBrandConfig.js` (commit `621aab7`) |
| O7 | Login vault (categories / masking / role access / audit logs / AES-256 encryption) | P1 (W1-2) | ✅ SHIPPED | `SupplierCredential` + `SupplierCredentialAccessLog` + `backend/routes/travel_suppliers.js` (7 endpoints) + `backend/lib/fieldEncryption.js` | AES-256-GCM per-tenant keys |
| O8 | Enquiry capture from all sources (website / WhatsApp / phone / email / ads / IG / FB / LinkedIn / referrals / walk-ins / existing) | P1 (W1) | ✅ SHIPPED (reuse) | `backend/routes/contacts.js` + `backend/routes/marketplace_leads.js` + `backend/routes/lead_routing.js` | `Contact.subBrand` tag at `schema.prisma:439` |
| O9 | Rule-based brand assignment | P1 (W1) | 🟡 PARTIAL | `backend/routes/lead_routing.js` + `LeadRoutingRule.conditions` JSON already supports `subBrand` filter | UI extension in `LeadRouting.jsx` pending; backend ready |
| O10 | 8-status pipeline | P1 (W1) | ✅ SHIPPED | `prisma/seed-travel.js:518,1046` `seedPipelineTaxonomies()`; gate spec `e2e/tests/travel-seed-taxonomy-api.spec.js` (commit `ab2f15f`) | New · Diagnostic Complete · Qualifying · Quoted · Negotiating · Won · Lost · Dormant (per Q10) |
| O11 | 8 lost-reason taxonomy | P1 (W1) | ✅ SHIPPED | Same helper, `prisma/seed-travel.js:1095-1119` | Price · No response · Chose competitor · Wrong requirement · Timing issue · Budget issue · Trust issue · Duplicate enquiry |
| O12 | Task management + overdue reminders (WA + email) | P1 (W2) | 🟡 PARTIAL | `backend/routes/tasks.js` + email engine; WA stub (Q9) | |
| O13 | Manager view (pending / delayed / staff-wise workload) | P1 (W1) | ✅ SHIPPED (reuse) | `backend/routes/staff.js` + existing dashboards | |
| O14 | Marketing campaign tracking + AdsGPT integration | P1 (W2) | ⏸️ BLOCKED (Q1) | No AdsGPT route in travel namespace | Cluster C7 in MANUAL_CODING_BACKLOG; ~2-3d post-handover |
| O15 | Meta / Google / LinkedIn / YouTube ad-platform API integrations | P1 (W1) | ⏸️ BLOCKED (Q1) | No surface yet | Q1 — Section 13 packet |
| O16 | Platform-wise marketing performance reports | P1 (W2) | ⏸️ BLOCKED (Q1) | Schema ready; consumer pending creds | |
| O17 | AI qualification calling (English / Hindi / Urdu, mid-call switch) | P1 (W2) | ⏸️ BLOCKED (Q1) | Sandbox mock `scripts/sandbox/callified-mock.js` only | Cluster C6 — Callified.ai handover |
| O18 | Call recording / transcription / summary, attached to lead | P1 (W2) | ⏸️ BLOCKED (Q1) | Same | |
| O19 | Form-vs-call answer comparison + mismatch flagging | P1 (W2) | ✅ SHIPPED | `POST /api/travel/diagnostics/:id/form-vs-call/compare` (`routes/travel_diagnostics.js:519-641`, commits `4a7c623` + `8b97fd5`); persists via `TravelDiagnostic.formVsCallJson` (commit `a6ea3fe`); UI consumer `DiagnosticDetail.jsx` Section 3 (commit `2440b4a`) | 80% MATCH / 60% REVIEW / <60% MISMATCH thresholds per GS B.11 |
| O20 | Zoom or Google Meet consultation booking | P1 (W3) | ✅ SHIPPED | `backend/routes/calendar_google.js` (reused) | Per Part-C decision: Google Meet recommended |
| O21 | AI-to-advisor handover for B2C | P1 (W2) | 🟡 PARTIAL | `backend/cron/travelDiagnosticAdvisorAlerts.js` (diagnostic side only) | Callified side cred-blocked |
| O22 | Flight Quotation Chrome plugin (Google Flights extraction, markup engine, multi-flight) | P1 (W3) | 🏗️ MULTI-DAY (cluster B4) | `Glob flight-plugin/**` returns 0; lives in separate repo | ~10-15 engineer-days; Manifest V3 + per-airline DOM adapters |
| O23 | Web check-in tracking (T-48h / T-24h auto-schedule, reminder, agent task, manual upload, dashboard) | P1 (W4) | 🟡 PARTIAL | `WebCheckin` model + `backend/cron/webCheckinScheduler.js` + `backend/routes/travel_webcheckin.js` (7 endpoints, commit `9898e87`) + `backend/lib/webCheckinWindow.js` + `frontend/src/pages/travel/WebCheckinQueue.jsx` operator UI (commit `bfe956c`) | Real WA reminder + delivery pending Q9 |
| O24 | Web check-in full automation (top-4 airlines: IndiGo / Air India / Vistara / Emirates) | P1 (W4) | 🏗️ MULTI-DAY (cluster B5) | No `webCheckinAutomation.js` engine | ~5-7d MVP + ongoing per-airline DOM maintenance; paired with B4 plugin |
| O25 | Web check-in fallback (2 failed retries → agent task; portal-down >2h → all-passengers) | P1 (W4) | 🟡 PARTIAL | `WebCheckin.status` enum includes `fallback-agent` + `failed` (`schema.prisma:4449`) | Schema only; no code emits transitions |
| O26 | Boarding-pass auto-delivery (WA + email) | P1 (W4) | 🟡 PARTIAL (stub-able) | `POST /webcheckins/:id/deliver` (`routes/travel_webcheckin.js:372`) emits Wati-stub log; `boardingPassUrl` + `deliveredAt` columns ready | One-line swap on Q9 |
| O27 | Light accounting — invoice / receipt / GST capture / refund / CA export | P1 (W5) | ✅ SHIPPED | `backend/routes/billing.js` + Invoice model + `Invoice.legalEntityCode` + Tally export `:130` + CA-summary CSV `:181` | Per-entity routing live |
| O28 | Excel Software for Travel accounting bridge | P1.5 (Q8) | ⏸️ BLOCKED (cred + docs) | `Glob backend/services/excelSoftware*` returns 0 | Cluster C5 (~3-5d post-docs) |
| O29 | Management dashboard KPIs (cross-brand) | P1 (W5) | ✅ SHIPPED | `backend/routes/travel_dashboard.js:57` + `frontend/src/pages/travel/Dashboard.jsx` | Per-sub-brand filters |
| O30 | LLM cost observability (daily summary + admin UI) | Bonus (R7) | ✅ SHIPPED | `LlmCallLog` model (`schema.prisma:1207`, commit `f5c9518`) + `GET /api/admin/llm-spend` + `frontend/src/pages/LlmSpend.jsx` (commit `76996c8`) + recharts AreaChart + BarCharts | R7 risk closed end-to-end |
| O31 | LeadDetail.jsx (unified contact-centric lead view) | P1 (W2) | ✅ SHIPPED | `frontend/src/pages/travel/LeadDetail.jsx` (commit `a84289e`); aggregates contact + latest diagnostic + itineraries + TMC trips + RFU profile link | |
| O32 | LLM-switchable layer (Perplexity / Gemini / Claude / GPT) | P1 (W3) | ✅ SHIPPED | `backend/lib/llmRouter.js` (commit `583c06b`) | 3 consumers live; real-mode on Q11 |
| O33 | Tenant.subBrandConfigJson consumer wiring (per-brand WA / WABA / legal entity / GSTIN / Drive root) | P1 (W1) | ✅ SHIPPED | `backend/lib/subBrandConfig.js` (commit `621aab7`); 7 crons + 3 endpoints resolve per-sub-brand config; 26 vitest cases | Pre-wired for Q9 cred drop |
| O34 | Vertical config — sidebar / theme / landing route | P1 (W1) | ✅ SHIPPED | `frontend/src/components/Sidebar.jsx:967, 625` renderTravelNav() + sub-brand switcher `:986-1019`; `frontend/src/theme/travel.css` (placeholder palette per Q22); `App.jsx:888` `/travel` landing | Brand palette swap pending Q22 brand assets |
| O35 | Seed `seed-travel.js` (tenant + users + 4 diagnostic banks + cost master + seasons + 8-status pipeline + 3 TmcTrips + Itinerary + microsite + RoomingAssignment + TripPaymentPlan + TripInstalmentPayment + SupplierCredential + VisaApplication + 4 checklist items + 1 WebCheckin + 3 ReligiousGuidancePacket) | P1 (W1) | ✅ SHIPPED | `backend/prisma/seed-travel.js` | End-to-end demo data complete |

---

## Cross-cutting concerns (not portal-specific)

### Auth + RBAC
- Multi-brand single login (O1, O2) — ✅ SHIPPED; SSO real-mode pending Q7
- 3-role RBAC (ADMIN / MANAGER / USER) — ✅ SHIPPED via `verifyRole` middleware
- Sub-brand access scoping per `User.subBrandAccess[]` — ✅ SHIPPED (commit `621aab7`)

### Billing + invoicing
- Per-legal-entity invoice routing (`Invoice.legalEntityCode`) — ✅ SHIPPED for 4 entities: TMC Nexus Pvt Ltd / Labbaik Tours & Travels INTL / Travel Stall / Visa Sure
- GST capture (CGST / SGST / IGST) — ✅ SHIPPED via reused `backend/routes/billing.js`
- Tally XML export + CA-summary CSV — ✅ SHIPPED via `backend/lib/tallyXmlExport.js` + `routes/billing.js:130,181`
- Excel Software for Travel bridge — ⏸️ BLOCKED (cluster C5)
- Razorpay payment gateway — ✅ SHIPPED (reuse) per Q4

### Integrations
- WhatsApp Business API (3 WABAs: TMC / RFU / ops) — ⏸️ BLOCKED (Q9 cluster C1); pre-wired via subBrandConfig helper
- Email (Mailgun / SMTP) — ✅ SHIPPED (reuse) per `backend/routes/email.js`
- SMS (Twilio / MSG91) — ✅ SHIPPED (reuse)
- Calendar / Meet (Google Workspace) — ✅ SHIPPED (reuse) per `routes/calendar_google.js`
- DigiLocker (Aadhaar OCR) — 🟡 PARTIAL stub via `services/digilockerClient.js` (commit `1babe1b`); cluster C3 swap on Q3
- Passport OCR (Google Document AI / Azure FR) — ⏸️ BLOCKED (cred-dependent)
- Callified.ai (AI calling) — ⏸️ BLOCKED (Q1 cluster C6)
- AdsGPT (marketing reports) — ⏸️ BLOCKED (Q1 cluster C7)
- RateHawk (hotel comparator) — ⏸️ BLOCKED (Q19 cluster C4 ~3-5d post-cred)
- Booking.com / Expedia direct — ⏸️ BLOCKED (Phase 1.5 cluster B6)
- LLM providers (Anthropic / Google / Perplexity / OpenAI) — ✅ SHIPPED stub-mode via `lib/llmRouter.js`; real-mode swap pending Q11 keys (cluster C2)
- Meta / Google / LinkedIn / YouTube Ads APIs — ⏸️ BLOCKED (Q1)

### Reports + dashboards
- Cross-brand management dashboard — ✅ SHIPPED (O29)
- TMC analytics — ✅ SHIPPED (T18-T21)
- RFU analytics — ✅ SHIPPED (R23-R25)
- Travel Stall analytics — 🟡 PARTIAL (TS10-TS12)
- Visa Sure analytics — 🔴 NOT-STARTED (V16-V18, Phase 3)
- TMC ops dashboard per confirmed trip — ✅ SHIPPED (T15, commit `9eda0b6`)
- Platform-wise marketing reports (AdsGPT) — ⏸️ BLOCKED (O16, Q1)
- LLM cost observability — ✅ SHIPPED (O30)

### GDPR + audit
- Document encryption at rest (AES-256-GCM) — ✅ SHIPPED via `backend/lib/fieldEncryption.js`
- Audit logging — ✅ SHIPPED via `AuditLog` model + `routes/audit.js` + global middleware
- Retention engine (passport 24m post-trip / call recording 12m / financial 84m / diagnostic responses lifetime) — ✅ SHIPPED via `backend/cron/retentionEngine.js`
- Aadhaar consent legal copy — 🟡 PARTIAL (draft at `docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md`, commit `7d162cd`); ⏸️ Q2 counsel review pending
- Document watermarking + share-link expiry (per GS B.2) — 🔴 NOT-STARTED
- Backup + PIT restore (per GS B.2: 30-day PIT / 12-month archival / quarterly restore-test) — ✅ SHIPPED (reuse) via `backend/cron/backupEngine.js`

### Demo seed quality
- 4-sub-brand tenant + sample users (TMC / RFU / TS / VS) — ✅ SHIPPED via `seed-travel.js`
- 4 diagnostic question banks (TMC 7Q / RFU 15Q / TS 5Q / VS 15Q) — ✅ SHIPPED
- Cost master + seasonal calendar — ✅ SHIPPED
- 3 sample TMC trips + participants + rooming + payment plan + 4 instalments — ✅ SHIPPED
- Sample Itinerary + microsite — ✅ SHIPPED
- Encrypted SupplierCredential (env-gated) — ✅ SHIPPED
- VisaApplication + 4 checklist items (Phase-3 placeholder) — ✅ SHIPPED (commit `78884e3`)
- 1 WebCheckin row (commit `cb478bb`) — ✅ SHIPPED
- 3 ReligiousGuidancePacket placeholders (commit `1e62ee9`) — ✅ SHIPPED

---

## Open questions surfaced by this read

The following items appear in the PDFs but don't map cleanly to ANY existing code AND aren't in the `MANUAL_CODING_BACKLOG` or PRD-gap audit. These need triage into the backlog in a follow-on commit.

1. **RFU "Zikr Cabs API" integration** — `Ready_for_Umrah_Business_Blueprint.md.pdf` §5.1 names Zikr Cabs as a ground-transportation supplier API. No code surface, no Q-marker, not in `MANUAL_CODING_BACKLOG`. Likely Phase 1.5 / Phase 2 supplier integration; needs cred-chase to confirm scope. *(One-line description: ground-transport supplier API for Makkah/Madinah cab pricing; would replace manual transport rate-card entry in RFU R14.)*

2. **RFU "5 internal login IDs for hotel scraping" infrastructure** — same blueprint §5.1 names 5 internal supplier-portal login IDs for hotel rate scraping. No code surface; the `SupplierCredential` vault can store the creds, but the scraping orchestrator isn't implemented. *(One-line: orchestrator that round-robins through 5 supplier-portal logins to scrape hotel rates; pre-RateHawk fallback path; Phase 1.5 candidate.)*

3. **RFU train pricing + availability API** — same blueprint §5.1 names a dedicated train-pricing API. No code surface. *(One-line: Indian Railways API integration for Madinah↔Makkah train segments where applicable; minor scope item; Phase 2.)*

4. **TMC "Branofy benchmark access" + "AdsGPT template"** — `Req Doc After Meeting.pdf` §13 names both as inputs from Travel Stall. Branofy is the AI-calling workflow benchmark (referenced in `Req Doc` §7 but explicitly "no protected IP to be copied"); AdsGPT template is a content generation system. Neither has a code surface; both await Yasin's Section 13 packet. *(One-line: Q1 packet items; AdsGPT template likely seeds the cred-blocked AdsGPT integration; Branofy stays a workflow reference only.)*

5. **TMC "Tier 3 Mandeep model" content-led growth — 7 Content Buckets framework** — `TMC_Business_Blueprint_For_Tech_Team.md.pdf` §6.2 details a 7-bucket content framework (Uncomfortable Truths 30% / Diagnostic Process 20% / Success Stories 20% / Curriculum Alignment 15% / Behind the Scenes 10% / Personal Stories 3% / Industry Insights 2%). This is operational marketing-team scope (Aishwarya + Jihad in the blueprint), not CRM scope. Out-of-scope for the GS implementation, but worth flagging because the blueprint specifies it as part of the TMC tech build. *(One-line: marketing content framework, operator-driven, not a code surface; out-of-scope for CRM build.)*

6. **TMC website restructure ("remove Browse Tours + remove ALL pricing")** — `TMC_Business_Blueprint_For_Tech_Team.md.pdf` §7.1 and §11 mandate removing destination-first nav + all pricing from `www.themodernclassroom.in`. This is a website-side change, not a CRM change; the CRM ships the diagnostic-questionnaire backend that the new website calls. *(One-line: TMC website / Webflow scope, not CRM scope; the CRM provides the `/api/travel/diagnostics/public/submit` endpoint that the website's diagnostic page calls — that surface ships.)*

7. **TMC "Sales Funnel" + "Diagnostic Landing Page" + "Digital Marketing Phase 1/2 Plan"** — three further TMC-specific PDFs (`TMC SALES FUNNEL.pdf`, `TMC_Diagnostic_Landing_Page.pdf`, `TMC_Digital_Marketing_Phase_1_and_2_Plan_2026.pdf`) skimmed. Same shape as #6 — operator-side marketing-plan documents, not CRM build scope.

8. **"Traffic Ecosystem" + "4-Tier Business Model Understanding"** — two cross-cutting strategy PDFs (`TRAFFIC ECOSYSTEM.pdf`, `The_4_Tier_Business_Model_Understanding_Market_Positioning_1.pdf`) skimmed. Pure positioning content (the Mandeep / Mukesh / Mahesh tier analogy from the TMC blueprint); no CRM build implications.

**Triage recommendation for items 1-3:** open 3 GitHub issues tagged `cred-dependent` + `travel` + `phase-2` for the RFU supplier integrations (Zikr Cabs API / 5-portal scraper / train API). Items 4 stays under Q1 cred-chase. Items 5-8 are out-of-scope for CRM; no action.

---

## Doc maintenance discipline

**When to update:** every PRD doc revision (when Yasin or Chandrika revise any of the 19 source PDFs); whenever a portal-level feature ships (commit SHA goes in the Evidence column and status flips from 🔴/🟡 to ✅); whenever a feature is cut from scope (status flips to 🚫 with note explaining why); whenever a new sub-brand is added (new portal section); whenever the PRD-gap audit refreshes (the autonomous cron's audit refresh cycle catches most state flips, but high-level scope changes need manual review here).

**Who owns it:** the next session's autonomous loop OR a human reviewer at session start. The pattern mirrors `docs/TRAVEL_CRM_GAP_AUDIT_2026-05-22.md` — the cron can refresh row-level state flips by re-running `Glob` + `Grep` + `git log` against the Evidence column; the cron does NOT add or remove rows. Adding rows (new feature in PRD) or removing rows (feature cut) requires human-reviewer judgment.

**How status flips work:** when a feature ships via commit `<SHA>`, the Evidence column should be updated to point at the new file:line OR commit SHA, and the State column flips from 🔴/🟡 to ✅. When a feature is cut, State flips to 🚫 with a note. When new cred / product-call arrives that unblocks a ⏸️ BLOCKED item, the State flips to 🟡 PARTIAL or ✅ SHIPPED depending on completeness. The matrix is `git`-tracked so flip history is visible in `git log -p docs/TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md`.

**Pairing with sibling docs:** this doc supersedes the ad-hoc "what's done?" question that's been asked across multiple session handoffs. It does NOT supersede `TRAVEL_CRM_GAP_AUDIT_2026-05-22.md` — that audit is the canonical PRD-section-by-section verification with the daily refresh cadence. This doc is the portal-wise pivot of the same data, optimized for "what does sub-brand X get on Day 42?" rather than "is PRD requirement Y shipped?". When the gap audit refreshes, this doc should also refresh, but it can run on a longer cadence (weekly vs daily) because portal-wise scope changes slower than PRD-row-level state flips.
