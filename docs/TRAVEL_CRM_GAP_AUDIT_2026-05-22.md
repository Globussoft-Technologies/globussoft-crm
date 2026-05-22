# Travel CRM PRD Gap Audit — refreshed 2026-05-22 (evening)

**HEAD at refresh:** `1c8fe54` (was `a9095ba` at prior refresh `5852dd3`; 11 commits + 6 shipped items landed since).
**Prior refresh:** commit `5852dd3` (2026-05-22 earlier today); the cron drained the menu via 5 successful feature dispatches (WebCheckinQueue.jsx UI `bfe956c`; LlmCallLog + admin spend `f5c9518`; WebCheckin seed row `cb478bb`; form-vs-call comparison endpoint `4a7c623`; TMC ops dashboard rollup `9eda0b6`) plus 1 follow-up bug fix (`8b97fd5` boolean coercion) + 3 inline gap-audit doc roll-forwards.
**Method:** PRD section-by-section verification against schema + routes + frontend + gate specs + cron engines + seed at current HEAD. Every SHIPPED claim points at file:line or commit. Stub-mode claims point at the stub marker; cred-blocked claims point at the Q-marker.

---

## Executive summary

- **Total PRD requirements counted:** **78** (unchanged denominator)
- **SHIPPED:** **65** (~83%) — up from 62 (+3: LlmCallLog/admin spend, form-vs-call compare endpoint, WebCheckin seed row)
- **PARTIAL:** **5** (~6%) — unchanged (rebalanced — WA-dispatch crons still partial; offsetting shifts)
- **GAP-AUTONOMOUS:** **3** (~4%) — was 2; new entry: `LeadDetail.jsx` + `ItineraryDetail.jsx` are now the residual single-commit frontend items the cron can pick
- **GAP-STUB-ABLE:** **5** (~6%) — was 6; one consumer (LLM router for talking-points + form-vs-call) cleared
- **GAP-CRED-BLOCKED:** **8** (~10%) — unchanged
- **GAP-PRODUCT-CALL:** **2** (~3%) — unchanged

**Queue refilled (round 3).** The prior refresh `5852dd3` left 3 top picks (WebCheckinQueue.jsx UI; LlmCallLog + admin spend; WebCheckin seed) — all 3 now shipped. The 2nd-tier "DiagnosticDetail.jsx UI" + "form-vs-call comparison" were partially picked: form-vs-call backend ships (commit `4a7c623`) but the **DiagnosticDetail UI page that renders both the talking-points brief AND the new form-vs-call panel is still autonomous-doable**. Also still autonomous: religious-guidance content delivery cron (mirror of contactGreetingsEngine), and Itinerary-route LLM consumer for bulk-text drafts.

The remaining cred-blocked gaps cluster identically: (a) Chrome flight-quote plugin + airline automation (Phase 1 W3-W4, NOT started), (b) Callified AI calling end-to-end (form-vs-call now has the compute layer ready as fixture-driven; real call-side answers still need Callified webhook), (c) per-cron WhatsApp dispatch + microsite OTP SMS cutover (Q9 cred-blocked).

### Top 3 next-best cron picks (priority order)

1. **`DiagnosticDetail.jsx` UI that renders BOTH talking-points brief AND the form-vs-call comparison panel** (PRD §4.1 + §4.2 + §7). New page under `frontend/src/pages/travel/DiagnosticDetail.jsx`; fetches `GET /api/travel/diagnostics/:id` for the bank + answers + persisted `talkingPointsJson`; renders the brief block + "Regenerate" button calling `POST /api/travel/diagnostics/:id/talking-points/regen`; renders a "Compare with call" section that POSTs to `/api/travel/diagnostics/:id/form-vs-call/compare` with a textarea for `callTranscript` and shows the `{ classification, scorePercent, perFieldDiff }` response. Mount at `/travel/diagnostics/:id` in `App.jsx`. ~½ day, pure frontend, zero cred deps. **Why next:** both backend endpoints ship (`cf876af` + `4a7c623`); advisor has no surface to consume either; closes the diagnostic interpretation loop for W2 exit gate.

2. **Religious-guidance content delivery cron + admin-editable content library** (PRD §4.8 + §4.10). Mirror `cron/contactGreetingsEngine.js` shape: schedule daily, scan upcoming Umrah-bound `Itinerary` rows (RFU sub-brand) within T-14d window, fan out content packets (Hajj/Umrah ritual guidance, dua copy, dress-code reminder) per upcoming pilgrim. New model `ReligiousGuidancePacket { id, subBrand, dayOffset, title, contentHtml, channel }` + 3 seed packets. WA dispatch stays Q9-stub; SMS + email work today. ~½ day. **Why next:** §4.8 row reads "GAP-AUTONOMOUS" since 2026-05-20; mirrors a shipped cron pattern; library is Yasin packet (Q1 cred-blocked) but the engine + admin CRUD ship now.

3. **Itinerary draft via LLM router (consumer wiring)** (PRD §4.3 + §9.1). Add `POST /api/travel/itineraries/:id/draft/regen` (ADMIN/MANAGER) that pulls the diagnostic + cost-master rows + season + markup rules for the sub-brand and routes through `llmRouter.routeRequest({ task: "bulk-text", payload })` returning a draft summary block to render in ItineraryBuilder. Persist as `Itinerary.draftSummary` (new nullable column) so the next GET serves the cached draft. Stub-mode returns synthetic copy; Q11 keys swap to Gemini Flash. ~3-4 hrs. **Why next:** Itinerary draft is the SECOND LLM-router consumer the PRD names (after talking-points which ships and form-vs-call which ships); proves the bulk-text task taxonomy cited in `LlmCallLog.task`; pairs with the §9.1 default-model map.

### Top 3 cred-blocked items worth chasing the human on (unchanged)

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). 8 crons / endpoints stub-dispatching today.
2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. One env-var drop swaps the shipped stub to real.
3. **Q11 — LLM API keys per provider** (Anthropic / Google / Perplexity / OpenAI). 2 consumers (talking-points + form-vs-call) live; itinerary-draft consumer pending.

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
| Form-vs-call answer comparison (80/60% threshold) | SHIPPED | `POST /api/travel/diagnostics/:id/form-vs-call/compare` (`routes/travel_diagnostics.js:519-639`, commits `4a7c623` + `8b97fd5`) — routes through `llmRouter.routeRequest({ task: "form-vs-call" })`, parses `\d+%` from LLM text, applies PRD 80/60 ladder → `{ classification: match|review|mismatch|unknown, scorePercent, perFieldDiff[], summary }`. Read/compute-only; persistence is P1.5. | UI consumer missing → see DiagnosticDetail.jsx pick |
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
| LLM-generated talking points per advisor | SHIPPED | `POST /api/travel/diagnostics/:id/talking-points/regen` (`routes/travel_diagnostics.js:396`, commit `cf876af`); LLM router consumer | Stub-mode-ready; real Claude output lands when Q11 keys arrive. UI render still GAP-AUTONOMOUS |
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
| Trip / Booking record (TMC) | SHIPPED | `TmcTrip` + `routes/travel_trips.js` 17 endpoints + ops-dashboard rollup | |
| TMC confirmed-trip microsite | SHIPPED | `TripMicrosite` + `routes/travel_microsites.js` + `/microsites/public/:publicUuid` | |
| Microsite OTP (4-digit, 10-min, WA delivery) | PARTIAL | `routes/travel_microsites.js:396,469,536` — request/verify/full | OTP gen + verify + reveal shipped; WA delivery stub (Q9) |
| Parent/teacher registration w/ DigiLocker | PARTIAL | `routes/travel_trips.js:510,546` DigiLocker initiate/callback (commit `1babe1b`) | Stub mode end-to-end; parent-facing public registration endpoint missing — GAP-AUTONOMOUS |
| Rooming allocation interface | PARTIAL | `routes/travel_trip_billing.js:65-200` CRUD + `RoomingAssignment` model | XLSX export `/rooming.xlsx` NOT shipped — GAP-AUTONOMOUS |
| Departure checklist + per-student doc checklist | SHIPPED | `TripDocumentRequirement` + `routes/travel_trips.js:603-654` | Trip-scoped (not per-participant); per-participant join is GAP-AUTONOMOUS |
| RFU customer database | SHIPPED | `RfuLeadProfile` + `routes/travel_rfu_profiles.js` + `pages/travel/RfuCustomerProfile.jsx` | |
| Customer-duplicate detection | PARTIAL | `findDuplicateContactFull` (commit `ea817fb`) | Email + phone + passport keys (commit `2b2c042`); UI pop-up flow missing — GAP-AUTONOMOUS |
| Login vault (AES-256-GCM) | SHIPPED | `SupplierCredential` + access-log + `routes/travel_suppliers.js` 7 endpoints + `lib/fieldEncryption.js` | |

### §4.6 Web check-in

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| P1A tracking + delivery (auto-schedule T-48h/T-24h, WA reminder, agent task, manual upload, dashboard) | PARTIAL | `WebCheckin` model (`schema.prisma:4387`) + `cron/webCheckinScheduler.js` + `routes/travel_webcheckin.js` 7 endpoints (commit `9898e87`) + `lib/webCheckinWindow.js` + auto-create on `POST /itineraries/:id/accept` + `WebCheckinQueue.jsx` operator UI (`bfe956c`) + sidebar link + 1 seeded WebCheckin row (`cb478bb`) | Backend + operator UI + seed all ship. **Still partial:** WA dispatch on `/deliver` is Q9-stub; WA reminder fan-out at T-window in the cron is also Q9-stub. Both swap when Q9 creds land |
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
| TMC ops dashboard per confirmed trip | SHIPPED | `pages/travel/TripDetail.jsx` + `GET /api/travel/trips/:id/ops-dashboard` rollup endpoint (`routes/travel_trips.js:235-418`, commit `9eda0b6`); parallel-fetch envelope with participants / payments / documents / rooming counts + 30/30/30/10 weighted `departureReadiness.score` | **Schema drift noted in route header:** `TripDocumentRequirement` has no `status` / `participantId` columns — `submittedCount=0` placeholder until submission tracking ships; `docsFrac` defaults to 1 to avoid penalising trips with no doc tracking. `TmcTrip.targetStudentCount` doesn't exist — `participants.target` always null. Frontend dashboard widget is P1.5 |
| LLM cost observability daily summary | SHIPPED | `GET /api/admin/llm-spend?days=N` (`routes/admin.js:172-358`, commit `f5c9518`) — ADMIN-gated, returns `{ totals, byDay, byTask, byModel }` envelope; backed by `LlmCallLog` fire-and-forget persist from `lib/llmRouter.js` | Stub-mode costs all 0; forward-compatible with real-mode per-token pricing |

### §4.10 Sub-vertical call-outs

| Item | State | Notes |
|---|---|---|
| TMC diagnostic-first + teacher OTP | SHIPPED (partial) | OTP supports `purpose=teacher-access` (`schema.prisma:4540`); no dedicated teacher access UI |
| RFU 4-tier tagging drives quotation tier | SHIPPED | `Itinerary.productTier` (commit `2612a7e`) |
| RFU Haram-facing hotel filters | PARTIAL | Schema-supported; no filter UI |
| LLM-switchable layer for quotation engine | GAP-AUTONOMOUS | `lib/llmRouter.js` shipped (`583c06b`); 2 consumers live (talking-points + form-vs-call); itinerary draft = `bulk-text` task — consumer wiring pending |
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

### §5.1 New models (24)

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
| `TripDocumentRequirement` | SHIPPED | `schema.prisma:4369` (no `status` / `participantId` columns yet — see §4.9 ops-dashboard note) |
| `WebCheckin` | SHIPPED + route consumer + seed | `schema.prisma:4387` + `routes/travel_webcheckin.js` + 1 seeded row (`cb478bb`) |
| `SupplierCredential` | SHIPPED | `schema.prisma:4418` |
| `SupplierCredentialAccessLog` | SHIPPED | `schema.prisma:4436` |
| `VisaApplication` | SHIPPED (Phase 3) | `schema.prisma:4449` |
| `VisaDocumentChecklistItem` | SHIPPED (Phase 3) | `schema.prisma:4474` |
| `RfuLeadProfile` | SHIPPED | `schema.prisma:4490` |
| `TripMicrosite` | SHIPPED | `schema.prisma:4517` |
| `TripMicrositeOtp` | SHIPPED | `schema.prisma:4536` |
| `TenantSetting` | SHIPPED | `schema.prisma:2853` |
| `LlmCallLog` | SHIPPED | `schema.prisma:1206-1230` (commit `f5c9518`); 3 indexes (tenantId+createdAt, tenantId+task, tenantId+model); fire-and-forget persist from `lib/llmRouter.js` |

### §5.2 Extensions to existing models

| Extension | State | Notes |
|---|---|---|
| `Tenant.subBrandConfigJson` (per-brand WA / WABA / legal entity / GSTIN / Drive root) | SHIPPED schema (`schema.prisma:168`), **STILL 0 CONSUMERS** confirmed via grep | Cron WA dispatch + microsite OTP can't pick correct WABA without this — partial unblock for Q9 cutover |
| `Contact.subBrand` | SHIPPED | `schema.prisma:439` |
| `Deal.subBrand` + `Deal.diagnosticId` | SHIPPED | `schema.prisma:589-590` |
| `Booking.tripId` + `Booking.itineraryId` | NOT NEEDED YET | Optional per PRD |
| `Invoice.legalEntityCode` | SHIPPED | `schema.prisma:814` |
| `User.subBrandAccess` | SHIPPED | `schema.prisma:357` |
| `TravelDiagnostic.talkingPointsJson` (LLM brief cache) | SHIPPED | persisted by talking-points/regen route (commit `cf876af`); read by next GET |

---

## §6 Route plan

### §6.1 New route files (11 expected + bonus)

| Expected file | State | Notes |
|---|---|---|
| `travel.js` | SHIPPED | Minimal `/health`; cross-sub-brand dashboard in `travel_dashboard.js` |
| `travel_diagnostics.js` | SHIPPED | 11+ endpoints incl. public submit + report PDF + `/talking-points/regen` (`cf876af`) + `/form-vs-call/compare` (`4a7c623` + `8b97fd5`) |
| `travel_itineraries.js` | SHIPPED | 14+ endpoints incl. `/share` + version chain + accept/reject + auto-WebCheckin on accept |
| `travel_quotation_flight.js` | GAP-AUTONOMOUS (plugin-paired) | Phase 1 W3 |
| `travel_cost_master.js` | SHIPPED | 5 endpoints |
| `travel_suppliers.js` (was `travel_supplier_vault.js`) | SHIPPED | 7 endpoints |
| `travel_trips.js` (TMC) | SHIPPED | 17 endpoints incl. DigiLocker initiate/callback + ops-dashboard (`9eda0b6`) |
| `travel_microsites.js` (folds `travel_trip_microsite_public.js`) | SHIPPED | Public + admin |
| `travel_trip_billing.js` (was `travel_payment_plans.js`) | SHIPPED | 11 endpoints incl. rooming + plan + instalments |
| `travel_webcheckin.js` | SHIPPED | 7 endpoints (commit `9898e87`) + auto-create on Itinerary.accept |
| `travel_visa.js` (Visa Sure) | GAP (Phase 3) | Schema-ready, no routes |
| `travel_callified.js` | GAP-CRED-BLOCKED | Q11/Q1 — Callified handover |

**Bonus shipped routes:** `travel_dashboard.js`, `travel_reports.js`, `travel_rfu_profiles.js`, `travel_pricing.js`, `travel_csv_io.js`.
**Bonus admin route:** `routes/admin.js` extended with `/llm-spend` (commit `f5c9518`).

### §6.2 Reused routes — all SHIPPED in main CRM.

### §6.3 New cron engines (6)

| Engine | State |
|---|---|
| `webCheckinScheduler.js` | SHIPPED — fed by Itinerary.accept auto-create + 1 seeded row |
| `webCheckinAutomation.js` (event-driven, per-airline) | GAP-AUTONOMOUS — Phase 1 W4 |
| `tripPaymentReminders.js` | SHIPPED |
| `travelJourneyReminders.js` | SHIPPED |
| `tripPostTripFeedback.js` | SHIPPED |
| `travelDiagnosticAdvisorAlerts.js` | SHIPPED |

---

## §7 Frontend page plan (23 expected; 1 new since prior refresh)

| Page | State | Notes |
|---|---|---|
| `Dashboard.jsx` | SHIPPED | `pages/travel/Dashboard.jsx` |
| `Leads.jsx` | SHIPPED | |
| `LeadDetail.jsx` | NOT SHIPPED — GAP-AUTONOMOUS | `/travel/leads/:id` not mounted |
| `DiagnosticBuilder.jsx` | SHIPPED | |
| `DiagnosticPreview.jsx` | NOT SHIPPED | |
| `DiagnosticPublic.jsx` (`/p/diagnostic/:subBrand/:bankId`) | SHIPPED-equivalent | `TravelStallQuiz.jsx` at `/travel-stall/quiz` |
| `DiagnosticDetail.jsx` (renders talking-points brief + form-vs-call panel) | **NOT SHIPPED — GAP-AUTONOMOUS** | New since 2026-05-22 morning — TWO backend endpoints (talking-points + form-vs-call/compare) ship but no UI consumer |
| `ItineraryBuilder.jsx` | PARTIAL | List ships (`Itineraries.jsx`); explicit `/new` builder route absent |
| `ItineraryDetail.jsx` | NOT SHIPPED — GAP-AUTONOMOUS | Pairs with ItineraryBuilder pick when itinerary-draft LLM consumer wires |
| `CostMaster.jsx` | SHIPPED | |
| `FlightQuoteAgent.jsx` | NOT SHIPPED | In-CRM fallback for Chrome plugin |
| `MarkupRules.jsx` (admin, shipped as `PricingRules.jsx`) | SHIPPED | |
| `SupplierVault.jsx` (shipped as `Suppliers.jsx`) | SHIPPED | |
| `TmcTrips.jsx` (shipped as `Trips.jsx`) | SHIPPED | |
| `TmcTripDetail.jsx` (shipped as `TripDetail.jsx`) | SHIPPED | Ops-dashboard widget render P1.5 |
| `TmcRooming.jsx` | NOT SHIPPED — folded into TripDetail | GAP-AUTONOMOUS if PRD wants standalone |
| `TmcPaymentPlan.jsx` | NOT SHIPPED — folded into TripDetail | Same |
| `TmcDocumentChecklist.jsx` | NOT SHIPPED — folded into TripDetail | Same |
| `TmcMicrositePreview.jsx` | NOT SHIPPED | Admin preview not wired |
| `WebCheckinQueue.jsx` | SHIPPED | `frontend/src/pages/travel/WebCheckinQueue.jsx` (commit `bfe956c`); route `/travel/webcheckins` + sidebar link |
| `RfuCustomerProfile.jsx` | SHIPPED | |
| `RfuJourneyReminders.jsx` | NOT SHIPPED | |
| `VisaApplications.jsx` + Detail + AdvisorDashboard | NOT SHIPPED (Phase 3) | |
| `TravelStallFamilyQuiz.jsx` | SHIPPED | `pages/public/TravelStallQuiz.jsx` |
| `TravelReports.jsx` | SHIPPED | `pages/travel/Reports.jsx` |
| `TripBooking.jsx` (50%-advance bonus) | SHIPPED | `pages/public/TripBooking.jsx` |
| `LlmSpendDashboard.jsx` (admin observability surface for `/api/admin/llm-spend`) | NOT SHIPPED — GAP-AUTONOMOUS | Single-page admin chart consuming the daily summary; pairs nicely with R7 observability |

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
| Seed `seed-travel.js` | SHIPPED | tenant + users + 4 diagnostic banks + cost master + seasons + 8-status Pipeline + 8 lost reasons + 3 TmcTrips + participants + Itinerary + microsite + RoomingAssignment + TripPaymentPlan + 4 TripInstalmentPayment + SupplierCredential (env-gated) + VisaApplication + 4 checklist items (`78884e3`) + 1 WebCheckin row (EK-571 BLR→DXB for the RFU pilgrim, `cb478bb`). End-to-end demo data complete |

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
| LLM router | SHIPPED | `lib/llmRouter.js` stub-mode (commit `583c06b`); 2 consumers live (talking-points `cf876af` + form-vs-call `4a7c623`); persist sink `LlmCallLog` (`f5c9518`) |
| Meta/Google/LinkedIn/YouTube Ads APIs | GAP-CRED-BLOCKED | Q1 |
| Excel Software for Travel | GAP-CRED-BLOCKED | Q8 docs pending |
| Airline portals | GAP-AUTONOMOUS | Phase 1 W4 |
| Razorpay | SHIPPED (reuse) | Q4 |
| Tally | SHIPPED | `lib/tallyXmlExport.js` + `routes/billing.js:130` |

### §9.1 LLM routing defaults (Q11 locked)

| Task | Locked model | State |
|---|---|---|
| Diagnostic interpretation (talking-points) | Claude Opus | SHIPPED via talking-points endpoint (commit `cf876af`); stub-mode-ready |
| Itinerary draft (bulk-text) | Gemini Flash | GAP-AUTONOMOUS — router exposes task; quotation routes need to wire it (see top-3 pick #3) |
| Form-vs-call comparison | Claude Opus | SHIPPED via `POST /api/travel/diagnostics/:id/form-vs-call/compare` (`routes/travel_diagnostics.js:519`, commit `4a7c623`); 80/60% ladder + perFieldDiff inline |
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
| W2 | Both diagnostics live; AI call summary attached | PARTIAL — Diagnostics ✅ + talking-points ✅ + form-vs-call compute ✅ (commit `4a7c623`); AI calling 🔴 (Callified GAP); UI render 🔴 (DiagnosticDetail.jsx) |
| W3 | Flight plugin 4-option in 60s; RFU lowest-rate | RED — Plugin not started; RateHawk GAP |
| W4 | Web check-in live top-4; TMC microsite pilot | PARTIAL — Microsite ✅ + cron ✅ + route ✅ + operator UI ✅ + seed ✅; airline automation GAP |
| W5 | Dashboards meet KPI list; CA export validated | SHIPPED — Reports + Dashboard + Tally export + TMC ops-dashboard rollup (`9eda0b6`) + LLM spend daily (`f5c9518`) |
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
| Form-vs-call persistence / cached panel | GAP-AUTONOMOUS — extend the compute endpoint to snapshot result onto `TravelDiagnostic.formVsCallJson` |

### Phase 2 (Travel Stall) state

Already shipped: Family Travel Quiz, 50%-advance booking, tunable advance ratio, public diagnostic endpoints, birthday/anniversary greetings. GAPS: personalised 3-5 destination PDF (LLM-driven, GAP-AUTONOMOUS now that router scaffold + 2 consumers ship), customer-duplicate full pop-up flow (backend ships, frontend modal pending), Booking.com/Expedia APIs.

### Phase 3 (Visa Sure) state

Schema-only — `VisaApplication` + `VisaDocumentChecklistItem` models shipped (seeded via `78884e3`); no route file `travel_visa.js`; no UI pages.

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
| Q11 | HIGH | LLM defaults | 🟢 | DECIDED + scaffold shipped (commit `583c06b`); 2 consumers live; real-mode swap pending Q11 keys |
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

| # | Risk | Status | Delta since prior refresh |
|---|---|---|---|
| R1 | Section 13 packet | 🟡 | No change |
| R2 | 6-week timeline | 🔴 | Improved — 6 more shipped items today; W3/W4 still the dominant slip |
| R3 | Chrome extension auto-update | 🔴 | Plugin not built |
| R4 | Hotel comparator scope drift | 🟢 | Resolved |
| R5 | DigiLocker creds | 🟢 | Stub shipped |
| R6 | Tenancy model irreversibility | 🟢 | Resolved + implemented |
| R7 | LLM cost + observability | 🟢 | Router scaffold + `LlmCallLog` + `/api/admin/llm-spend` daily summary all ship. Real-mode per-token pricing wires in with Q11 keys |
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
| `backend/lib/llmRouter.js` | line 1 `STUB MODE` | Q11 | Add `if (apiKey) return realProviderCall(...)` branches; preserve envelope `{ text, finishReason, usage, model, stub }`. 2 consumers (talking-points + form-vs-call) already correctly destructure this envelope |
| `backend/cron/tripPaymentReminders.js` | "WhatsApp dispatch pending" | Q9 | Loop adds `await whatsappProvider.sendTemplate(...)` |
| `backend/cron/travelJourneyReminders.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/tripPostTripFeedback.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/webCheckinScheduler.js` | "WhatsApp dispatch pending" | Q9 | Same; now scans a non-empty table |
| `backend/cron/contactGreetingsEngine.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/travelDiagnosticAdvisorAlerts.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/routes/travel_microsites.js:396` | `sendOtpStub` logs OTP to console | Q9 | Replace stub with `whatsappProvider.sendOtp(phone, otp)` |
| `backend/routes/travel_itineraries.js:761` | `/share` returns URL; doesn't auto-WA | Q9 | Add `await whatsappProvider.sendTemplate(...)` after share-URL |
| `backend/routes/travel_webcheckin.js:372` | `/deliver` emits Wati-stub log | Q9 | One-line swap to real WA send |

---

## Recommended next 5 cron dispatches (priority order)

1. **`DiagnosticDetail.jsx` UI rendering BOTH talking-points brief AND form-vs-call comparison panel** (PRD §4.1 + §4.2 + §7). New page; mount at `/travel/diagnostics/:id`. Sidebar link from existing `Diagnostics.jsx` list. Renders cached `talkingPointsJson` + "Regenerate" button + a "Compare with call" section that posts to `/form-vs-call/compare`. ~½ day, pure frontend, zero cred deps. **Why next:** both backend endpoints ship; advisor has no UI surface; closes W2 exit-gate UI side.

2. **Religious-guidance content delivery cron + admin-editable packet library** (PRD §4.8 + §4.10). New `cron/religiousGuidanceEngine.js` mirroring `contactGreetingsEngine.js`; new model `ReligiousGuidancePacket { id, subBrand, dayOffset, title, contentHtml, channel }`; 3 seed packets (Day-3 dua, Day-7 ritual, T-1 dress code); admin POST/PUT/DELETE for the library. WA dispatch stays Q9-stub. ~½ day. **Why next:** §4.8 row reads "GAP-AUTONOMOUS" since 2026-05-20; mirrors shipped cron pattern; pairs with the journey reminders work.

3. **Itinerary draft LLM consumer** (PRD §4.3 + §9.1). New `POST /api/travel/itineraries/:id/draft/regen` (ADMIN/MANAGER) routing through `llmRouter.routeRequest({ task: "bulk-text", payload })`; persists `Itinerary.draftSummary` (new nullable column); ItineraryBuilder UI will render the cached draft on next GET. ~3-4 hrs. **Why next:** itinerary draft is the THIRD LLM-router consumer the PRD names; proves the `bulk-text` task taxonomy; pairs with §9.1 default-model map.

4. **`ItineraryDetail.jsx` UI page** (PRD §7 row). New page under `frontend/src/pages/travel/ItineraryDetail.jsx`; fetches itinerary + items + version chain + `draftSummary`; renders items grid + version-history drawer + accept/reject actions + (if pick #3 lands) draft-summary block with "Regenerate" button. Mount at `/travel/itineraries/:id`. ~½ day, pure frontend. **Why next:** finishes the itinerary surface in tandem with pick #3.

5. **`LeadDetail.jsx` UI page** (PRD §7 row). New page under `frontend/src/pages/travel/LeadDetail.jsx`; fetches contact + diagnostic + linked itineraries + linked trips for the unified lead view. Mount at `/travel/leads/:id`. Reuses generic `Contacts/ContactDetail.jsx` for shape. ~3-4 hrs. **Why next:** lowest-cost UI fill-in; the `Leads.jsx` list ships but row-click is dead today.

---

## Cred-blocked priority list (for human chase, NOT cron pick)

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). Owner: Yasin. Unblocks: 6 crons (`tripPaymentReminders`, `travelJourneyReminders`, `tripPostTripFeedback`, `webCheckinScheduler`, `contactGreetingsEngine`, `travelDiagnosticAdvisorAlerts`) + 3 endpoints (`travel_microsites.js:396` request-otp, `travel_itineraries.js:761` `/share`, `travel_webcheckin.js:372` `/deliver`). ~9-line swap each. See `docs/WHATSAPP_INTEGRATION_PRD.md`.

2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. Owner: Yasin (Travel Stall has them). Unblocks: real Aadhaar-XML pull in `digilockerClient.js`. Single env-var drop. See `docs/DIGILOCKER_INTEGRATION_SPEC.md`.

3. **Q11 — LLM API keys per provider** (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`). Owner: Yasin (Travel Stall holds them). Unblocks: real-mode swap in `lib/llmRouter.js` (talking-points + form-vs-call + itinerary-draft consumers); makes `LlmCallLog.costEstimate` non-zero. Per-provider `if (apiKey) realCall(...)` branch.

4. **Q1 — Section 13 packet** (Google Workspace admin creds → unblocks Drive folder auto-create; AdsGPT creds + handover → unblocks marketing reports; Callified.ai handover → unblocks AI calling + form-vs-call live mode; brand assets pack → unblocks themed PDF templates + travel.css palette). Owner: Yasin.

5. **Q19 — RateHawk API key**. Owner: Yasin. Unblocks: RFU unified-search lowest-rate auto-pick + W3 exit-gate.

6. **Q8 — Excel Software for Travel REST API docs**. Owner: Yasin. Unblocks: `services/excelSoftwareClient.js` + accounting bridge.

7. **Q22 — Brand assets pack** (logos / palettes / PDF templates per sub-brand). Owner: Yasin. Unblocks: `theme/travel.css` palette swap + per-sub-brand PDF templates.

8. **Q15 — UAT users handover**. Owner: Yasin / TMC / RFU stakeholders. Unblocks: W6 exit-gate.

---

*End of audit. Snapshot at HEAD `1c8fe54`. Re-run when a Phase 1 milestone lands or any cred Q-marker resolves; the queue-refill threshold is "0 GAP-AUTONOMOUS items in §4 tables" or "fewer than 3 next-best picks in the priority list."*
