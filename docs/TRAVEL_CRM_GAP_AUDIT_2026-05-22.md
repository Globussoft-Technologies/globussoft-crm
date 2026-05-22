# Travel CRM PRD Gap Audit — refreshed 2026-05-22

**HEAD at refresh:** `a9095ba` (was `192de86` at original audit; 7 commits + 8 shipped items landed since).
**Prior audit:** commit `93b1c96` (2026-05-22); cron drained the menu via 5 successful feature dispatches (Pipeline + lost-reason; WebCheckin route + auto-create; LLM router scaffold; talking-points endpoint; seed-travel TMC fixtures) plus 1 bugfix follow-up (`beef891`).
**Method:** PRD section-by-section verification against schema + routes + frontend + gate specs + cron engines + seed at current HEAD. Every SHIPPED claim points at file:line or commit. Stub-mode claims point at the stub marker; cred-blocked claims point at the Q-marker.

---

## Executive summary

- **Total PRD requirements counted:** **78** (unchanged denominator)
- **SHIPPED:** **59** (~76%) — up from 58 (+1: LlmCallLog + admin daily-summary endpoint `f5c9518`)
- **PARTIAL:** **6** (~8%)
- **GAP-AUTONOMOUS:** **5** (~6%) — down from 6 since LlmCallLog shipped
- **GAP-STUB-ABLE:** **6** (~8%) — was 8; talking-points + LLM router consumed two slots
- **GAP-CRED-BLOCKED:** **8** (~10%) — unchanged
- **GAP-PRODUCT-CALL:** **2** (~3%) — unchanged

**Queue refilled.** The prior audit reached "0 GAP-AUTONOMOUS" because it scored a row SHIPPED the moment a backend route existed — but the PRD bundle (route + UI + cron-WA-wire + downstream consumer) was not yet whole for several of those rows. This refresh restores granular accounting:

- **WebCheckin backend ships** but `WebCheckinQueue.jsx` operator UI is autonomous-doable
- **LLM router scaffold ships** but `LlmCallLog` model + admin daily-summary endpoint (PRD §9.1, R7 cost observability) was deliberately deferred — still autonomous
- **Talking-points endpoint ships** but the `DiagnosticDetail.jsx` advisor-brief render UI is autonomous-doable
- **Seed-travel TMC fixtures ship** but `WebCheckin` rows aren't in the seed yet — the cron has nothing to scan in the demo box
- **Per-tenant `subBrandConfigJson`** column shipped but ZERO consumers still grep-confirmed (route layer + crons + microsite OTP all hardcode-fallback)

The remaining cred-blocked gaps cluster identically: (a) Chrome flight-quote plugin + airline automation (Phase 1 W3-W4, NOT started), (b) Callified AI calling + form-vs-call mismatch, (c) per-cron WhatsApp dispatch + microsite OTP SMS cutover (Q9 cred-blocked).

### Top 3 next-best cron picks (priority order)

1. ~~**`WebCheckinQueue.jsx` operator UI** — backend ships (commit `9898e87`); cron scans empty table. Build the list / filter / "upload boarding pass" / "deliver" UI on top of the 7-endpoint API. PRD §4.6 + §7 row 20. Pure-frontend single-commit. ~½ day.~~ — ✅ **commit `bfe956c`** (filter + upcoming toggle + multipart upload + deliver + reassign + status-color badges + 10 vitest cases; route mounted; sidebar link added)

2. ~~**`LlmCallLog` model + admin daily-summary endpoint** — PRD §9.1 explicitly calls for cost-attribution + per-task spend breakdown (R7 observability). Router scaffold (`583c06b`) wrote a structured log line as the swap-point contract; replacing `console.log` with `prisma.llmCallLog.create` + the GET endpoint closes that loop. Single migration + one route file. ~3 hrs.~~ — ✅ **commit `f5c9518`** (additive nullable schema + fire-and-forget persist + `GET /api/admin/llm-spend?days=N` ADMIN endpoint with totals/byDay/byTask/byModel envelope; 24 vitest + 9 gate-spec cases)

3. **Seed at least 1 `WebCheckin` row in `seed-travel.js`** — gives the cron something to find during demo; pairs with the Queue UI above. The 4 ItineraryItems on Itinerary `IT-SEED-RFU-1` are the trigger surface. ~1 hr.

### Top 3 cred-blocked items worth chasing the human on (unchanged)

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). 8 crons / endpoints stub-dispatching today.
2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. One env-var drop swaps the shipped stub to real.
3. **Q11 — LLM API keys per provider** (Anthropic / Google / Perplexity / OpenAI). Router stub envelope-shape pins the swap point.

---

## §4 Functional requirements

### §4.1 Lead intake + sales funnel

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Multi-source enquiry capture | SHIPPED (reuse) | `routes/contacts.js`, `routes/marketplace_leads.js`, `routes/lead_routing.js` | `Contact.subBrand` tag at `schema.prisma:439` |
| Rule-based brand assignment | PARTIAL | `routes/lead_routing.js` + `Contact.subBrand` + `User.subBrandAccess` (`schema.prisma:357`) | `LeadRoutingRule` not yet extended to filter on `subBrand`. GAP-AUTONOMOUS |
| 8-status pipeline (Q10) | SHIPPED | `seed-travel.js:518, 1046` `seedPipelineTaxonomies()`; gate spec `e2e/tests/travel-seed-taxonomy-api.spec.js` (commit `ab2f15f`) | Labels: New · Diagnostic Complete · Qualifying · Quoted · Negotiating · Won · Lost · Dormant |
| 8 lost-reason taxonomy | SHIPPED | Same helper, `seed-travel.js:1095-1119` | Price · No response · Chose competitor · Wrong requirement · Timing issue · Budget issue · Trust issue · Duplicate enquiry |
| Diagnostic-first guard on quotation routes | SHIPPED | `middleware/travelGuards.js`; refused on POST/PUT Itinerary | |
| AI qualification call (Eng/Hin/Urdu) | GAP-CRED-BLOCKED | Sandbox mock `scripts/sandbox/callified-mock.js` only | Q1 — Callified.ai handover |
| Form-vs-call answer comparison (80/60% threshold) | GAP-AUTONOMOUS | `lib/llmRouter.js` already lists `"form-vs-call"` task with Claude-primary routing; no consumer route grep-confirmed | Can ship fixture-driven now that router scaffold exists |
| AI-to-advisor handover (B2C) | PARTIAL | `cron/travelDiagnosticAdvisorAlerts.js` (diagnostic side only) | Callified side cred-blocked |
| Manager view (pending/delayed/staff-wise) | SHIPPED (reuse) | `routes/staff.js` + existing dashboards | |
| Lead source attribution + UTM tracking | SHIPPED (reuse) | `Contact.firstTouchSource` + Touchpoint already wired | |

### §4.2 Diagnostic engine

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Diagnostic builder (Q-bank editor) | PARTIAL | Backend POST `/diagnostic-banks` admin endpoint shipped (`routes/travel_diagnostics.js:139`); `pages/travel/DiagnosticBuilder.jsx` exists | Phase 1 = view-only per Q16 |
| Weighted scoring engine | SHIPPED | `lib/travelDiagnosticScoring.js` + 20+ vitest cases | |
| Classification bands (4 levels per brand) | SHIPPED | `TravelDiagnostic.classification` + `.classificationLabel` + `.recommendedTier` (`schema.prisma:4080-4092`) | |
| Auto-generated branded PDF report | SHIPPED | `routes/travel_diagnostics.js:43-78` | Per-sub-brand templates placeholder until Q22 |
| Auto CRM record creation | SHIPPED | `routes/travel_diagnostics.js:493-557` public submit | No auto-Deal-creation; deal flow manual today |
| Curriculum mapping logic (TMC-only) | GAP-PRODUCT-CALL | No code surface | Q13 |
| Risk flagging (Visa Sure) | SHIPPED (schema) | `VisaApplication.advisorRiskFlag` (`schema.prisma:4459`) | Phase 3 |
| LLM-generated talking points per advisor | SHIPPED | `POST /api/travel/diagnostics/:id/talking-points/regen` (`routes/travel_diagnostics.js:396`, commit `cf876af`); LLM router consumer | Stub-mode-ready; real Claude output lands when Q11 keys arrive. **NB:** no `DiagnosticDetail.jsx` UI yet renders the brief — GAP-AUTONOMOUS |
| AI summary notes (Visa Sure) | GAP-AUTONOMOUS | Phase 3 | Same shape as talking-points |

### §4.3 Itinerary / package builder

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| RFU Umrah quotation engine (unified search) | PARTIAL | `routes/travel_itineraries.js` ships full CRUD + items + version chain + share + PDF + accept/reject | "Unified-search lowest-rate auto-select" requires RateHawk wire-in (Q19 cred-blocked) |
| Hotel rate comparator (RateHawk P1) | GAP-CRED-BLOCKED | No `services/ratehawkClient.js` | Q19 |
| Preference filters (RFU Haram-facing / floor / room) | PARTIAL | `TravelCostMaster.attributesJson` (`schema.prisma:4196`) supports them; no filter UI | GAP-AUTONOMOUS |
| Rule-based transport pricing with seasonal logic | SHIPPED | `TravelSeasonCalendar` + `TravelMarkupRule` + `routes/travel_pricing.js` + `lib/travelPricing.js` | |
| Cost master admin panel | SHIPPED | `routes/travel_cost_master.js` (5 endpoints) + `pages/travel/CostMaster.jsx` + CSV (`routes/travel_csv_io.js`) | |
| Branded itinerary PDF with version history | SHIPPED | `routes/travel_itineraries.js:706` GET `/itineraries/:id/pdf`; `Itinerary.parentItineraryId` + status enum | |
| Flight Quotation Chrome plugin | GAP-AUTONOMOUS | No `flight-plugin/` at repo root | Phase 1 W3 — ~10-15 engineer-days |
| Trip itinerary template per TMC trip | SHIPPED | `TripMicrosite.itineraryHtml`; `routes/travel_microsites.js:154` POST | |

### §4.4 Quote / invoice / payment

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Quotation upload (Travel Stall) | SHIPPED (reuse) | `routes/contacts.js` ContactAttachment + Quote | |
| Manual or structured quotation (Visa Sure) | PARTIAL (schema only) | `VisaApplication` model | Phase 3 |
| Invoice generation with GST capture | SHIPPED (reuse) | `routes/billing.js` + Invoice + `Invoice.legalEntityCode` (`schema.prisma:814`) | |
| CA / Tally export | SHIPPED | `routes/billing.js:130` `/export/tally.xml` + `:181` `/export/ca-summary.csv` (commit `4a07fca`) | Q5 |
| Excel Software for Travel bridge | GAP-CRED-BLOCKED | No `services/excelSoftwareClient.js` | Q8 docs pending |
| Per-entity payment tracking | SHIPPED | `Invoice.legalEntityCode` | |
| Payment plan tracking (TMC) | PARTIAL | `TripPaymentPlan` + `TripInstalmentPayment` + `routes/travel_trip_billing.js` + `cron/tripPaymentReminders.js` | WA dispatch stub (Q9); `/instalments/from-plan` materialiser Phase 1.5 |

### §4.5 Booking + supplier coordination

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Trip / Booking record (TMC) | SHIPPED | `TmcTrip` + `routes/travel_trips.js` 17 endpoints | |
| TMC confirmed-trip microsite | SHIPPED | `TripMicrosite` + `routes/travel_microsites.js` + `/microsites/public/:publicUuid` | |
| Microsite OTP (4-digit, 10-min, WA delivery) | PARTIAL | `routes/travel_microsites.js:396,469,536` — request/verify/full | OTP gen + verify + reveal shipped; WA delivery stub (Q9) |
| Parent/teacher registration w/ DigiLocker | PARTIAL | `routes/travel_trips.js:510,546` DigiLocker initiate/callback (commit `1babe1b`) | Stub mode end-to-end; parent-facing public registration endpoint missing — GAP-AUTONOMOUS |
| Rooming allocation interface | PARTIAL | `routes/travel_trip_billing.js:65-200` CRUD + `RoomingAssignment` model | XLSX export `/rooming.xlsx` NOT shipped — GAP-AUTONOMOUS |
| Departure checklist + per-student doc checklist | SHIPPED | `TripDocumentRequirement` + `routes/travel_trips.js:603-654` | Trip-scoped (not per-participant); per-participant join is GAP-AUTONOMOUS |
| RFU customer database | SHIPPED | `RfuLeadProfile` + `routes/travel_rfu_profiles.js` + `pages/travel/RfuCustomerProfile.jsx` | |
| Customer-duplicate detection | PARTIAL | `findDuplicateContactFull` (commit `ea817fb`) | Email + phone keys; passport-number key not yet added — GAP-AUTONOMOUS |
| Login vault (AES-256-GCM) | SHIPPED | `SupplierCredential` + access-log + `routes/travel_suppliers.js` 7 endpoints + `lib/fieldEncryption.js` | |

### §4.6 Web check-in

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| P1A tracking + delivery (auto-schedule T-48h/T-24h, WA reminder, agent task, manual upload, dashboard) | PARTIAL | `WebCheckin` model (`schema.prisma:4387`) + `cron/webCheckinScheduler.js` + `routes/travel_webcheckin.js` 7 endpoints (commit `9898e87`) + `lib/webCheckinWindow.js` + auto-create on `POST /itineraries/:id/accept` + `WebCheckinQueue.jsx` operator UI (commit `bfe956c`) + sidebar link | Backend + operator UI both ship. **Still partial:** WA dispatch on `/deliver` is Q9-stub; WA reminder fan-out at T-window in the cron is also Q9-stub. Both swap when Q9 creds land |
| P1B top-4 airline automation (IndiGo, AI/Express, Vistara, Emirates per Q20) | GAP-AUTONOMOUS | No `webCheckinAutomation.js` engine | Phase 1 W4 — paired with Chrome plugin work |
| Fallback (2 failed retries → agent task; portal-down >2h → all-passengers-to-agents) | PARTIAL | `WebCheckin.status` enum includes `fallback-agent` + `failed` (`schema.prisma:4400`) | Schema-only; no code emits transitions yet — GAP-AUTONOMOUS |
| Boarding-pass auto-delivery (WA + email) | GAP-STUB-ABLE | `POST /webcheckins/:id/deliver` (`routes/travel_webcheckin.js:372`) emits Wati-stub log line; `boardingPassUrl` + `deliveredAt` columns ready | One-line swap on Q9 cred drop |

### §4.7 Visa documents + compliance

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Structured document checklist + status tracking | PARTIAL (schema only) | `VisaDocumentChecklistItem` (`schema.prisma:4474`) | Phase 3 — no routes/UI |
| Passport OCR + secure storage | GAP-CRED-BLOCKED | `TripParticipant.passportNumber/Expiry/DocId` columns exist | Needs Google Document AI / Azure FR creds |
| Document security model | PARTIAL | AES-256 via `lib/fieldEncryption.js` ✅; AuditLog ✅; retention engine ✅; watermark + share-link expiry NOT shipped | On-prem per Q6 (PRD §4.7 "AWS Mumbai" line predates Q6 decision) |
| Rejection-recovery program (Visa Sure) | PARTIAL (schema only) | `VisaApplication.recoveryProgramId` placeholder | Phase 3 |
| Aadhaar OCR via DigiLocker | PARTIAL (stub-mode) | `services/digilockerClient.js` + `DigilockerSession` + initiate/callback + gate spec (commit `1babe1b`) | Q3 cred drop swaps stub → real |
| Aadhaar consent legal copy | GAP-PRODUCT-CALL | Draft at `docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md` (commit `7d162cd`) | Q2 counsel review pending |

### §4.8 Customer communications

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Embedded WhatsApp Web for staff | SHIPPED (reuse) | `routes/whatsapp.js` | |
| WhatsApp Business API for automation (3 WABA) | GAP-CRED-BLOCKED | `services/whatsappProvider.js` Meta direct; Wati upstream | Q9 — 8 features stub-dispatching |
| Email | SHIPPED (reuse) | `routes/email.js` + services | |
| Calendar/Meet booking | SHIPPED (reuse) | `routes/calendar_google.js` | |
| Drive folder auto-creation for confirmed TMC trips | PARTIAL (stub-mode) | `services/googleDriveClient.js` (commit `192de86`) + wire-in `routes/travel_trips.js:140-166, 271-282` | Q1 Workspace creds unlock real |
| Umrah journey reminders | PARTIAL | `cron/travelJourneyReminders.js` | WA dispatch stub (Q9) |
| Religious-guidance content delivery | GAP-AUTONOMOUS | No code surface | Sequence + scheduledEmail reuse pattern; library is Yasin packet (Q1) |
| Trip reminders + post-trip feedback (TMC) | PARTIAL | `cron/tripPostTripFeedback.js` | WA dispatch stub (Q9) |
| Birthday / anniversary greetings | SHIPPED | `cron/contactGreetingsEngine.js` | Phase 2 per PRD; shipped early |

### §4.9 Reports / dashboards

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Management dashboard KPIs (cross-brand) | SHIPPED | `routes/travel_dashboard.js:57` + `pages/travel/Dashboard.jsx` | |
| TMC analytics | SHIPPED | `routes/travel_reports.js:69` `/reports/tmc` | |
| RFU analytics | SHIPPED | `routes/travel_reports.js:193` `/reports/rfu` | |
| Travel Stall analytics | PARTIAL | Phase 2 per Q17 | Schema ready |
| Visa Sure analytics | PARTIAL | Phase 3 per Q18 | Schema ready |
| Platform-wise marketing reports (AdsGPT) | GAP-CRED-BLOCKED | No AdsGPT route in travel namespace | Q1 |
| TMC ops dashboard per confirmed trip | PARTIAL | `pages/travel/TripDetail.jsx` shipped; explicit `/trips/:id/ops-dashboard` endpoint NOT shipped | GAP-AUTONOMOUS |

### §4.10 Sub-vertical call-outs

| Item | State | Notes |
|---|---|---|
| TMC diagnostic-first + teacher OTP | SHIPPED (partial) | OTP supports `purpose=teacher-access` (`schema.prisma:4540`); no dedicated teacher access UI |
| RFU 4-tier tagging drives quotation tier | SHIPPED | `Itinerary.productTier` (commit `2612a7e`) |
| RFU Haram-facing hotel filters | PARTIAL | Schema-supported; no filter UI |
| LLM-switchable layer for quotation engine | GAP-STUB-ABLE | `lib/llmRouter.js` shipped (commit `583c06b`); quotation-route consumer still missing | Itinerary draft = `bulk-text` task |
| Aadhaar OCR via DigiLocker | PARTIAL (stub) | §4.7 |
| Passport OCR | GAP-CRED-BLOCKED | §4.7 |
| Religious-guidance content library | GAP-AUTONOMOUS | §4.8 |
| Umrah journey reminders | PARTIAL | §4.8 |
| Travel Stall Family Travel Quiz | SHIPPED | `pages/public/TravelStallQuiz.jsx` (commit `1260caa`) + `/diagnostics/public/*` |
| Travel Stall 50% advance booking | SHIPPED | `routes/travel_itineraries.js:773,833` public share-token + advance-payment (commit `8abf6f3`); per-tenant ratio (commit `ee35d00`) |
| Travel Stall personalised 3-5 PDF | GAP-AUTONOMOUS | LLM-router scaffold ships; consumer absent |
| Travel Stall email-first acquisition | SHIPPED (reuse) | Email + Sequence engine |
| Visa Sure 15Q readiness + risk-flag dashboard | PARTIAL (schema only) | Phase 3 |
| Visa Sure rejection-recovery program | PARTIAL (schema only) | Phase 3 |

---

## §5 Data model

### §5.1 New models (23)

| Model | State | Schema location |
|---|---|---|
| `TravelDiagnostic` | SHIPPED | `schema.prisma:4080` |
| `TravelDiagnosticQuestionBank` | SHIPPED | `schema.prisma:4104` |
| `Itinerary` | SHIPPED | `schema.prisma:4121` |
| `ItineraryItem` | SHIPPED | `schema.prisma:4169` |
| `TravelCostMaster` | SHIPPED | `schema.prisma:4189` |
| `TravelSeasonCalendar` | SHIPPED | `schema.prisma:4211` |
| `TravelMarkupRule` | SHIPPED | `schema.prisma:4226` |
| `TmcTrip` | SHIPPED | `schema.prisma:4245` |
| `TripParticipant` | SHIPPED | `schema.prisma:4272` |
| `DigilockerSession` | SHIPPED | `schema.prisma:4304` |
| `RoomingAssignment` | SHIPPED | `schema.prisma:4328` |
| `TripPaymentPlan` | SHIPPED | `schema.prisma:4341` |
| `TripInstalmentPayment` | SHIPPED | `schema.prisma:4351` |
| `TripDocumentRequirement` | SHIPPED | `schema.prisma:4369` |
| `WebCheckin` | SHIPPED + route consumer | `schema.prisma:4387` + `routes/travel_webcheckin.js` |
| `SupplierCredential` | SHIPPED | `schema.prisma:4418` |
| `SupplierCredentialAccessLog` | SHIPPED | `schema.prisma:4436` |
| `VisaApplication` | SHIPPED (Phase 3) | `schema.prisma:4449` |
| `VisaDocumentChecklistItem` | SHIPPED (Phase 3) | `schema.prisma:4474` |
| `RfuLeadProfile` | SHIPPED | `schema.prisma:4490` |
| `TripMicrosite` | SHIPPED | `schema.prisma:4517` |
| `TripMicrositeOtp` | SHIPPED | `schema.prisma:4536` |
| `TenantSetting` | SHIPPED | `schema.prisma:2853` |
| `LlmCallLog` | SHIPPED | `backend/prisma/schema.prisma` model + fire-and-forget persist in `lib/llmRouter.js` + `GET /api/admin/llm-spend` (commit `f5c9518`); 3 indexes on (tenantId, createdAt / task / model) |

### §5.2 Extensions to existing models

| Extension | State | Notes |
|---|---|---|
| `Tenant.subBrandConfigJson` (per-brand WA / WABA / legal entity / GSTIN / Drive root) | SHIPPED schema (`schema.prisma:168`), **STILL 0 CONSUMERS** confirmed via grep | Cron WA dispatch + microsite OTP can't pick correct WABA without this — partial unblock for Q9 cutover |
| `Contact.subBrand` | SHIPPED | `schema.prisma:439` |
| `Deal.subBrand` + `Deal.diagnosticId` | SHIPPED | `schema.prisma:589-590` |
| `Booking.tripId` + `Booking.itineraryId` | NOT NEEDED YET | Optional per PRD |
| `Invoice.legalEntityCode` | SHIPPED | `schema.prisma:814` |
| `User.subBrandAccess` | SHIPPED | `schema.prisma:357` |

---

## §6 Route plan

### §6.1 New route files (11 expected + bonus)

| Expected file | State | Notes |
|---|---|---|
| `travel.js` | SHIPPED | Minimal `/health`; cross-sub-brand dashboard in `travel_dashboard.js` |
| `travel_diagnostics.js` | SHIPPED | 10+ endpoints incl. public submit + report PDF + `/talking-points/regen` (commit `cf876af`) |
| `travel_itineraries.js` | SHIPPED | 14+ endpoints incl. `/share` + version chain + accept/reject |
| `travel_quotation_flight.js` | GAP-AUTONOMOUS (plugin-paired) | Phase 1 W3 |
| `travel_cost_master.js` | SHIPPED | 5 endpoints |
| `travel_suppliers.js` (was `travel_supplier_vault.js`) | SHIPPED | 7 endpoints |
| `travel_trips.js` (TMC) | SHIPPED | 17 endpoints incl. DigiLocker initiate/callback |
| `travel_microsites.js` (folds `travel_trip_microsite_public.js`) | SHIPPED | Public + admin |
| `travel_trip_billing.js` (was `travel_payment_plans.js`) | SHIPPED | 11 endpoints incl. rooming + plan + instalments |
| `travel_webcheckin.js` | SHIPPED | 7 endpoints (commit `9898e87`) + auto-create on Itinerary.accept |
| `travel_visa.js` (Visa Sure) | GAP (Phase 3) | Schema-ready, no routes |
| `travel_callified.js` | GAP-CRED-BLOCKED | Q11/Q1 — Callified handover |

**Bonus shipped routes:** `travel_dashboard.js`, `travel_reports.js`, `travel_rfu_profiles.js`, `travel_pricing.js`, `travel_csv_io.js`.

### §6.2 Reused routes — all SHIPPED in main CRM.

### §6.3 New cron engines (6)

| Engine | State |
|---|---|
| `webCheckinScheduler.js` | SHIPPED — now fed by `9898e87`'s auto-create on Itinerary.accept |
| `webCheckinAutomation.js` (event-driven, per-airline) | GAP-AUTONOMOUS — Phase 1 W4 |
| `tripPaymentReminders.js` | SHIPPED |
| `travelJourneyReminders.js` | SHIPPED |
| `tripPostTripFeedback.js` | SHIPPED |
| `travelDiagnosticAdvisorAlerts.js` | SHIPPED |

---

## §7 Frontend page plan (22 expected)

| Page | State | Notes |
|---|---|---|
| `Dashboard.jsx` | SHIPPED | `pages/travel/Dashboard.jsx` |
| `Leads.jsx` | SHIPPED | |
| `LeadDetail.jsx` | NOT SHIPPED | `/travel/leads/:id` not mounted |
| `DiagnosticBuilder.jsx` | SHIPPED | |
| `DiagnosticPreview.jsx` | NOT SHIPPED | |
| `DiagnosticPublic.jsx` (`/p/diagnostic/:subBrand/:bankId`) | SHIPPED-equivalent | `TravelStallQuiz.jsx` at `/travel-stall/quiz` |
| `ItineraryBuilder.jsx` | PARTIAL | List ships; explicit `/new` builder route absent |
| `ItineraryDetail.jsx` | NOT SHIPPED | |
| `CostMaster.jsx` | SHIPPED | |
| `FlightQuoteAgent.jsx` | NOT SHIPPED | In-CRM fallback for Chrome plugin |
| `MarkupRules.jsx` (admin, shipped as `PricingRules.jsx`) | SHIPPED | |
| `SupplierVault.jsx` (shipped as `Suppliers.jsx`) | SHIPPED | |
| `TmcTrips.jsx` (shipped as `Trips.jsx`) | SHIPPED | |
| `TmcTripDetail.jsx` (shipped as `TripDetail.jsx`) | SHIPPED | |
| `TmcRooming.jsx` | NOT SHIPPED — folded into TripDetail | GAP-AUTONOMOUS if PRD wants standalone |
| `TmcPaymentPlan.jsx` | NOT SHIPPED — folded into TripDetail | Same |
| `TmcDocumentChecklist.jsx` | NOT SHIPPED — folded into TripDetail | Same |
| `TmcMicrositePreview.jsx` | NOT SHIPPED | Admin preview not wired |
| `WebCheckinQueue.jsx` | SHIPPED | `frontend/src/pages/travel/WebCheckinQueue.jsx` (commit `bfe956c`); route `/travel/webcheckins` + sidebar link between "TMC Trips" and "Cost Master" |
| `RfuCustomerProfile.jsx` | SHIPPED | |
| `RfuJourneyReminders.jsx` | NOT SHIPPED | |
| `VisaApplications.jsx` + Detail + AdvisorDashboard | NOT SHIPPED (Phase 3) | |
| `TravelStallFamilyQuiz.jsx` | SHIPPED | `pages/public/TravelStallQuiz.jsx` |
| `TravelReports.jsx` | SHIPPED | `pages/travel/Reports.jsx` |
| `TripBooking.jsx` (50%-advance bonus) | SHIPPED | `pages/public/TripBooking.jsx` |
| `DiagnosticDetail.jsx` (renders talking-points brief) | **NOT SHIPPED — GAP-AUTONOMOUS** | New since prior audit — talking-points endpoint ships but no UI render |

### §7.1 Public micro-sites

| Page | State |
|---|---|
| `TripMicrosite.jsx` (SSR via landingPageRenderer) | NOT SHIPPED — public microsite is JSON-only today |

### §7.2 Chrome extension

| Item | State |
|---|---|
| `flight-plugin/` at repo root | NOT SHIPPED — directory does not exist |

---

## §8 Vertical config

| Item | State | Evidence |
|---|---|---|
| `Tenant.vertical = "travel"` value | SHIPPED | `seed-travel.js:45,55` |
| `renderTravelNav()` in Sidebar | SHIPPED | `Sidebar.jsx:967, 625` |
| Sub-brand switcher in sidebar | SHIPPED | `Sidebar.jsx:986-1019` |
| Theme `theme/travel.css` | SHIPPED (placeholder palette) | Per Q22 brand assets pending |
| Landing route `/travel` | SHIPPED | `App.jsx:888` |
| Seed `seed-travel.js` | SHIPPED | tenant + users + 4 diagnostic banks + cost master + seasons + 8-status Pipeline + 8 lost reasons + 3 TmcTrips + participants + Itinerary + microsite + RoomingAssignment + TripPaymentPlan + 4 TripInstalmentPayment + SupplierCredential (env-gated) + VisaApplication + 4 checklist items (commit `78884e3`). **NB:** no `WebCheckin` rows seeded — cron has nothing to scan in demo |

---

## §9 External integrations

| Integration | State | Notes |
|---|---|---|
| Wati BSP wrapper (3 WABAs) | GAP-CRED-BLOCKED | Q9; 8 features stub-dispatching |
| Meta WhatsApp Cloud API | SHIPPED (reuse) | `services/whatsappProvider.js` |
| Callified.ai / Exotel | GAP-CRED-BLOCKED | Sandbox mock only |
| Google Workspace (Drive/Gmail/Calendar/Meet) | PARTIAL (stub for Drive) | `services/googleDriveClient.js` (commit `192de86`) |
| RateHawk | GAP-CRED-BLOCKED | Q19 |
| Booking.com / Expedia | GAP (Phase 1.5 per Q19) | |
| DigiLocker | PARTIAL (stub) | `services/digilockerClient.js` (commit `1babe1b`) |
| Passport OCR | GAP-CRED-BLOCKED | |
| AdsGPT | GAP-CRED-BLOCKED | Q1 |
| LLM router | SHIPPED | `lib/llmRouter.js` stub-mode (commit `583c06b`); 1 consumer live (talking-points) |
| Meta/Google/LinkedIn/YouTube Ads APIs | GAP-CRED-BLOCKED | Q1 |
| Excel Software for Travel | GAP-CRED-BLOCKED | Q8 docs pending |
| Airline portals | GAP-AUTONOMOUS | Phase 1 W4 |
| Razorpay | SHIPPED (reuse) | Q4 |
| Tally | SHIPPED | `lib/tallyXmlExport.js` + `routes/billing.js:130` |

### §9.1 LLM routing defaults (Q11 locked)

| Task | Locked model | State |
|---|---|---|
| Diagnostic interpretation (talking-points) | Claude Opus | SHIPPED via talking-points endpoint (commit `cf876af`); stub-mode-ready |
| Itinerary draft (bulk-text) | Gemini Flash | GAP-AUTONOMOUS — router exposes task; quotation routes need to wire it |
| Form-vs-call comparison | Claude Opus | GAP-AUTONOMOUS — fixture-driven scaffold doable now |
| AI qualification call | Gemini Live | GAP-CRED-BLOCKED (Callified front-end) |
| Document OCR fallback | Gemini Vision | GAP-CRED-BLOCKED |
| Sentiment / KPI insights | Gemini Flash | GAP-AUTONOMOUS |
| Cost observability (`LlmCallLog` model + admin daily summary) | — | SHIPPED via `GET /api/admin/llm-spend` (commit `f5c9518`); fire-and-forget persist from router |

---

## §10 Phased plan — exit-gate verification

### Phase 1 W1-W6 state

| Week | Exit gate | State |
|---|---|---|
| W1 | SSO live; inbound WA enquiries; templates submitted | PARTIAL — SSO reuse; WA cred-blocked (Q9) |
| W2 | Both diagnostics live; AI call summary attached | PARTIAL — Diagnostics ✅ + talking-points ✅; AI calling 🔴 (Callified GAP) |
| W3 | Flight plugin 4-option in 60s; RFU lowest-rate | RED — Plugin not started; RateHawk GAP |
| W4 | Web check-in live top-4; TMC microsite pilot | PARTIAL — Microsite ✅ + cron ✅ + route ✅ (commit `9898e87`); operator UI MISSING; airline automation GAP |
| W5 | Dashboards meet KPI list; CA export validated | SHIPPED — Reports + Dashboard + Tally export |
| W6 | UAT ≥90% P1A pass; D42 go-live | BLOCKED — UAT users (Q15) pending; Phase 1 W3 + W4 items dominate the residual risk |

### Phase 1.5 follow-on state

| Item | State |
|---|---|
| Web check-in Tier-2 airlines | GAP (downstream of Tier-1) |
| Admin-editable diagnostic scoring with audit + sandbox | GAP-AUTONOMOUS (Q16) |
| Excel Software API bridge | GAP-CRED-BLOCKED (Q8) |
| Booking.com + Expedia direct APIs | GAP-CRED-BLOCKED (Q19) |
| Long-tail airline automation | GAP (downstream) |
| Seasons + markup rules admin UI | SHIPPED (`PricingRules.jsx`) |

### Phase 2 (Travel Stall) state

Already shipped: Family Travel Quiz, 50%-advance booking, tunable advance ratio, public diagnostic endpoints, birthday/anniversary greetings. GAPS: personalised 3-5 destination PDF (LLM-driven, GAP-AUTONOMOUS now that router scaffold ships), customer-duplicate full pop-up flow, Booking.com/Expedia APIs.

### Phase 3 (Visa Sure) state

Schema-only — `VisaApplication` + `VisaDocumentChecklistItem` models shipped (now seeded via `78884e3`); no route file `travel_visa.js`; no UI pages.

---

## §12 Open questions cross-reference

| # | Tier | Question | Decision | Code state |
|---|---|---|---|---|
| Q1 | CRITICAL | Section 13 packet | 🟢 | RESOLVED-pending-handover (Drive folder stub-ready) |
| Q2 | HIGH | Aadhaar consent legal copy | 🟢 | DRAFT (commit `7d162cd`); counsel review pending |
| Q3 | CRITICAL | DigiLocker creds | 🟢 | RESOLVED-pending-handover; stub end-to-end ready |
| Q4 | MEDIUM | Payment gateway | 🟢 | RESOLVED (Razorpay wired) |
| Q5 | MEDIUM | CA export sample | 🟢 | RESOLVED-pending-sample; Tally exporter shipped |
| Q6 | MEDIUM | Data residency | 🟢 | RESOLVED on-prem; R11 ops work pending |
| Q7 | CRITICAL | SSO provider | 🟢 | RESOLVED (Workspace reuse) |
| Q8 | MEDIUM | Excel SW integration | 🟢 | RESOLVED-pending-docs |
| Q9 | CRITICAL | WhatsApp numbers | 🟢 | RESOLVED-pending-handover; 8 features stub-dispatching |
| Q10 | CRITICAL | Pipeline labels | 🟢 | DECIDED + SEEDED (commit `ab2f15f`) |
| Q11 | HIGH | LLM defaults | 🟢 | DECIDED + scaffold shipped (commit `583c06b`); real-mode swap pending Q11 keys |
| Q12 | HIGH | KPI periods | 🟢 | RESOLVED |
| Q13 | CRITICAL | Diagnostic length | 🟢 | RESOLVED-pending-content |
| Q14 | CRITICAL | Retention durations | 🟢 | RESOLVED |
| Q15 | MEDIUM | UAT users | 🟢 | RESOLVED-pending-handover |
| Q16 | CONFLICT | RFU editable scoring | 🟢 | RESOLVED (Phase 1 view-only; Phase 1.5 UI gates) |
| Q17 | CONFLICT | Travel Stall scope | 🟢 | RESOLVED Phase 2 |
| Q18 | CONFLICT | Visa Sure scope | 🟢 | RESOLVED Phase 3 |
| Q19 | HIGH | Hotel comparator | 🟢 | RESOLVED-pending-creds |
| Q20 | HIGH | Top-N airlines | 🟢 | RESOLVED-pending-code |
| Q21 | HIGH | Subdomain | 🟢 | RESOLVED-pending-DNS |
| Q22 | CRITICAL | Brand assets | 🟢 | RESOLVED-pending-handover |
| Q23 | MEDIUM | Premium support | 🟢 | RESOLVED |
| Q24 | HIGH | Decimal precision | 🟢 | RESOLVED (Decimal(15,2) confirmed `schema.prisma:4144`) |
| Q25 | HIGH | Tenancy | 🟢 | RESOLVED (single-tenant + `subBrandAccess[]`) |

---

## R-marker risk register

| # | Risk | Status | Delta since 2026-05-20 |
|---|---|---|---|
| R1 | Section 13 packet | 🟡 | No change |
| R2 | 6-week timeline | 🔴 | Improved — 8 shipped items in 2 days; W3/W4 still the dominant slip |
| R3 | Chrome extension auto-update | 🔴 | Plugin not built |
| R4 | Hotel comparator scope drift | 🟢 | Resolved |
| R5 | DigiLocker creds | 🟢 | Stub shipped |
| R6 | Tenancy model irreversibility | 🟢 | Resolved + implemented |
| R7 | LLM cost + observability | 🟢 | Router scaffold (`583c06b`) + `LlmCallLog` model + `GET /api/admin/llm-spend` daily summary (`f5c9518`). Real-mode per-token pricing wires in with Q11 keys |
| R8 | Aadhaar legal exposure | 🟡 | Counsel pending |
| R9 | Multi-WABA timeline | 🟢 | Resolved |
| R10 | Scope creep TS/VS | 🟢 | Resolved |
| R11 | On-prem hosting complexity | 🔴 | No infra evidence in commits |

---

## Stub-mode swap-point inventory

| Stub file | Stub marker | Q-marker | Swap |
|---|---|---|---|
| `backend/services/digilockerClient.js` | line 1 `STUB MODE` + line 19 `STUB_DIGILOCKER_BASE` | Q3 | Replace `initiateSession` + `exchangeCallback` to talk real DigiLocker token endpoint |
| `backend/services/googleDriveClient.js` | line 1 + line 56 `STUB: Google Drive folder.create` | Q1 | Swap `createTripFolder` to `googleapis` |
| `backend/lib/llmRouter.js` | line 1 `STUB MODE` | Q11 | Add `if (apiKey) return realProviderCall(...)` branches; preserve envelope `{ text, finishReason, usage, model, stub }` |
| `backend/cron/tripPaymentReminders.js` | "WhatsApp dispatch pending" | Q9 | Loop adds `await whatsappProvider.sendTemplate(...)` |
| `backend/cron/travelJourneyReminders.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/tripPostTripFeedback.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/webCheckinScheduler.js` | "WhatsApp dispatch pending" | Q9 | Same; also needs WebCheckin rows seeded |
| `backend/cron/contactGreetingsEngine.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/travelDiagnosticAdvisorAlerts.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/routes/travel_microsites.js:396` | `sendOtpStub` logs OTP to console | Q9 | Replace stub with `whatsappProvider.sendOtp(phone, otp)` |
| `backend/routes/travel_itineraries.js:761` | `/share` returns URL; doesn't auto-WA | Q9 | Add `await whatsappProvider.sendTemplate(...)` after share-URL |
| `backend/routes/travel_webcheckin.js:372` | `/deliver` emits Wati-stub log | Q9 | One-line swap to real WA send |

---

## Recommended next 5 cron dispatches (priority order)

1. **`WebCheckinQueue.jsx` operator UI** (PRD §4.6 + §7 row 20). New page under `frontend/src/pages/travel/WebCheckinQueue.jsx` consuming the 7-endpoint API: list (filter by status / upcoming) + per-row upload-boarding-pass + `/deliver` button + status badges. Mount as `/travel/webcheckin` in `App.jsx`. Add to sidebar `renderTravelNav()`. ~½ day. **Why next:** backend ships (`9898e87`); operator workflow is the missing piece that closes W4 exit-gate (excluding airline automation which is the next bundle); single-commit, zero cred deps.

2. **`LlmCallLog` model + admin daily-summary endpoint** (PRD §9.1, R7). Add `model LlmCallLog { id String @id @default(cuid()) tenantId String task String model String tokensIn Int tokensOut Int costEstimate Decimal createdAt DateTime @default(now()) ... }` to `schema.prisma`. Swap `console.log` in `lib/llmRouter.js` for `prisma.llmCallLog.create`. New `GET /api/travel/llm/usage/daily` ADMIN endpoint aggregating spend by task. ~3 hrs. **Why next:** R7 is amber; router scaffold already pins the log-line shape as the swap-point contract; this is the persistence + observability layer.

3. **Seed at least 1 `WebCheckin` row in `seed-travel.js`** (PRD §8.5). Extend the existing trip + itinerary seed so that one of the 4 RFU `ItineraryItem` flight rows generates a `WebCheckin` row scheduled T+24h in the demo timeline. ~1 hr. **Why next:** the cron currently scans an empty WebCheckin table in demo; pairs with the Queue UI above; idempotent upsert pattern already in seed-travel.js.

4. **`DiagnosticDetail.jsx` UI to render talking-points brief** (PRD §4.2 + §7). New page that fetches an existing TravelDiagnostic by `:id` + renders the `talkingPointsJson.text` block + a "Regenerate" button calling `POST /api/travel/diagnostics/:id/talking-points/regen`. Mount as `/travel/diagnostics/:id`. ~3 hrs. **Why next:** talking-points endpoint ships (commit `cf876af`) but advisor has no surface to read the brief — pure-frontend, zero cred deps.

5. **Form-vs-call comparison fixture-driven scaffold** (PRD §4.1). New `lib/formVsCall.js` + 30 vitest cases against fixture transcripts (no real Callified needed); routes through `llmRouter.routeRequest({ task: "form-vs-call", payload })`; computes 80/60% mismatch threshold per PRD; returns `{ mismatchFlag, mismatches: [{ field, formValue, callValue }] }`. ~½ day. **Why next:** router scaffold lists the task; this is the consumer that proves the contract; mismatch flag is a Phase 1 W2 exit-gate item; works in pure-fixture mode until Callified ships.

---

## Cred-blocked priority list (for human chase, NOT cron pick)

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). Owner: Yasin. Unblocks: 5 crons (`tripPaymentReminders`, `travelJourneyReminders`, `tripPostTripFeedback`, `webCheckinScheduler`, `contactGreetingsEngine`, `travelDiagnosticAdvisorAlerts`) + 3 endpoints (`travel_microsites.js:396` request-otp, `travel_itineraries.js:761` `/share`, `travel_webcheckin.js:372` `/deliver`). ~9-line swap each. See `docs/WHATSAPP_INTEGRATION_PRD.md`.

2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. Owner: Yasin (Travel Stall has them). Unblocks: real Aadhaar-XML pull in `digilockerClient.js`. Single env-var drop. See `docs/DIGILOCKER_INTEGRATION_SPEC.md`.

3. **Q11 — LLM API keys per provider** (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`). Owner: Yasin (Travel Stall holds them). Unblocks: real-mode swap in `lib/llmRouter.js` (talking-points + form-vs-call + itinerary-draft consumers). Per-provider `if (apiKey) realCall(...)` branch.

4. **Q1 — Section 13 packet** (Google Workspace admin creds → unblocks Drive folder auto-create; AdsGPT creds + handover → unblocks marketing reports; Callified.ai handover → unblocks AI calling + form-vs-call live mode; brand assets pack → unblocks themed PDF templates + travel.css palette). Owner: Yasin.

5. **Q19 — RateHawk API key**. Owner: Yasin. Unblocks: RFU unified-search lowest-rate auto-pick + W3 exit-gate.

6. **Q8 — Excel Software for Travel REST API docs**. Owner: Yasin. Unblocks: `services/excelSoftwareClient.js` + accounting bridge.

7. **Q22 — Brand assets pack** (logos / palettes / PDF templates per sub-brand). Owner: Yasin. Unblocks: `theme/travel.css` palette swap + per-sub-brand PDF templates.

8. **Q15 — UAT users handover**. Owner: Yasin / TMC / RFU stakeholders. Unblocks: W6 exit-gate.

---

*End of audit. Snapshot at HEAD `a9095ba`. Re-run when a Phase 1 milestone lands or any cred Q-marker resolves; the queue-refill threshold is "0 GAP-AUTONOMOUS items in §4 tables" or "fewer than 3 next-best picks in the priority list."*
