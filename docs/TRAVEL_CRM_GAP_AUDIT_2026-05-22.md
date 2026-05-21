# Travel CRM PRD Gap Audit — 2026-05-22

**HEAD on audit:** `192de86` at time of audit.
**Audit method:** PRD section-by-section verification against schema + routes + frontend + gate specs + cron engines + seed. Every "SHIPPED" claim points at a file + line. Stub-mode claims point at the stub marker; cred-blocked claims point at the Q-marker.

---

## Executive summary

- **Total PRD requirements counted:** **78** (44 in §4, 23 models in §5, 11 route bundles in §6.1, 22 frontend pages in §7, 5 vertical-config items in §8, 14 integrations in §9; some collapse — see per-section tables for the precise denominator)
- **SHIPPED:** **50** (~64%) — up from 44 baseline; +6 since: pipeline + lost-reason (`ab2f15f`), travel_webcheckin.js route (`9898e87`), LLM router scaffold (`583c06b`), talking-points endpoint + Diagnostic-interpretation cell (`cf876af`)
- **PARTIAL:** **9** (~12%) — P1A web check-in row flipped most-of-way; still partial pending WebCheckinQueue.jsx UI
- **GAP-AUTONOMOUS:** **1** (~1%) — down from 8; -7 since (last remaining autonomous in §4.10 TMC sample data seed extension)
- **GAP-STUB-ABLE:** **8** (~10%) — down 1 from 9 (diagnostic interpretation flipped to SHIPPED via the talking-points endpoint wire-in)
- **GAP-CRED-BLOCKED:** **8** (~10%)
- **GAP-PRODUCT-CALL:** **2** (~3%)

The Phase 1 contractual surface (TMC + RFU diagnostic + itinerary + microsite + supplier vault + cost master + rooming + payment plans + reports + DigiLocker scaffold) is **almost entirely shipped**. The remaining gaps cluster into three buckets: (a) the Chrome flight-quote plugin + airline web-check-in automation (Phase 1 W3-W4 scope, NOT yet started), (b) the LLM router + talking-points + form-vs-call (Phase 1 W2-W3 scope, NOT yet started), (c) the per-cron WhatsApp dispatch + microsite OTP SMS cutover (one-line edits, Q9 cred-blocked).

### Top three "biggest remaining single-commit wins" the cron should pick next

1. ~~**WebCheckin CRUD route + auto-create on Itinerary.accept** — `WebCheckin` model is shipped (`schema.prisma:4387`) and the cron `webCheckinScheduler.js` already runs; what's missing is the route that creates rows + the auto-create trigger on itinerary acceptance. The cron sweeps an empty table today. Single commit; small-to-medium. (PRD §4.6, §6.1 `travel_webcheckin.js`)~~ — ✅ **commit `9898e87`** (2026-05-22; 18 vitest + 17 gate-spec cases, 2641/2641 backend pass)
2. ~~**Seed 8-status travel pipeline + 8 lost reasons** (Q10 decision is final). `seed-travel.js` does not create a Pipeline + 8 PipelineStage rows for the travel tenant; deals can't move through the contractual funnel until they're there. Single commit; small. (PRD §4.1)~~ — ✅ **commit `ab2f15f`**
3. **Per-tenant subBrandConfigJson reader + usage in route layer** — schema column shipped (`schema.prisma:168`) but ZERO consumers grep-confirmed. Cron WhatsApp dispatch + microsite OTP can't pick the right WABA number without it. ~½ day; medium. (PRD §5.2 + §6 + §8.5 Q9)

### Top three "biggest cred-blocked items" worth chasing the human on

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). Five cron engines + microsite OTP + itinerary `/share` are all stub-dispatching today. Single delivery unblocks ~8 features. See [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md).
2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. Schema + session model + stub + route + gate spec all shipped. One env-var drop swaps stub → real. See [DIGILOCKER_INTEGRATION_SPEC.md](DIGILOCKER_INTEGRATION_SPEC.md).
3. **Q1 — Section 13 packet (Workspace admin creds + TMC school DB + brand assets pack)**. Google Drive folder auto-create is shipped as a stub against `GOOGLE_WORKSPACE_CLIENT_ID/SECRET/REFRESH_TOKEN`; Drive folders for confirmed trips would go live the moment those land.

---

## §4 Functional requirements

### §4.1 Lead intake + sales funnel

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Multi-source enquiry capture (web forms, WhatsApp, phone, email, ads) | SHIPPED (reuse) | `routes/contacts.js`, `routes/marketplace_leads.js`, `routes/lead_routing.js` | Existing CRM machinery; no travel-specific extension needed beyond `Contact.subBrand` tag (shipped `schema.prisma:439`) |
| Rule-based brand assignment | PARTIAL | `routes/lead_routing.js` (existing) + `Contact.subBrand` + `User.subBrandAccess` (`schema.prisma:357`) | Schema + column shipped; LeadRoutingRule schema not yet extended to filter on `subBrand` |
| 8-status pipeline (Q10 decision) | SHIPPED | `seed-travel.js` `seedPipelineTaxonomies()` (commit `ab2f15f`); 1 Pipeline `"Travel Default Pipeline"` + 8 PipelineStage rows + gate spec `e2e/tests/travel-seed-taxonomy-api.spec.js` | Q10 labels seeded in order: New · Diagnostic Complete · Qualifying · Quoted · Negotiating · Won · Lost · Dormant |
| 8 lost-reason taxonomy (Q10 decision) | SHIPPED | Same helper as above (commit `ab2f15f`); 8 WinLossReason rows with `type=lost` | Shipped against PRD §4.1 prose labels: Price · No response · Chose competitor · Wrong requirement · Timing issue · Budget issue · Trust issue · Duplicate enquiry. **Discrepancy flag:** the audit row above originally listed a different Q10 label set (Date Conflict / No-Show / Compliance Block / Out of Service Area / Customer Withdrew / Other). PRD §4.1 prose was the authoritative source for the seed; verify against TRAVEL_CRM_OPEN_QUESTIONS.md if Yasin wants the other set |
| Diagnostic-first guard on quotation routes | SHIPPED | `routes/travel_itineraries.js` (commit `1e7061b`); guard helper in `middleware/travelGuards.js` | POST/PUT Itinerary refuses creation for a Contact with no completed diagnostic in this sub-brand |
| AI qualification call (Eng/Hin/Urdu, Callified.ai) | GAP-CRED-BLOCKED | Sandbox mock only at `backend/scripts/sandbox/callified-mock.js`; no `travel_callified.js` route | Q11 LLM-key decision is locked; what's missing is the Callified webhook handler + per-tenant API-key handover. See Q1 |
| Form-vs-call answer comparison + mismatch flag (80/60% threshold) | GAP-AUTONOMOUS (after Callified ships) | No code grep-hits for `formVsCall` / `mismatch` | Logic can be written + tested against fixture transcripts WITHOUT real Callified — autonomous fixture-driven scaffold worth doing now |
| AI-to-advisor handover (B2C) | PARTIAL | `cron/travelDiagnosticAdvisorAlerts.js` (commit `9729f01`) — diagnostic-complete-no-outreach-in-30min escalation | Only the diagnostic side ships; AI-call → advisor handover trigger is Callified-cred-blocked |
| Manager view (pending/delayed/staff-wise) | SHIPPED (reuse) | `routes/staff.js` + existing dashboards | Existing CRM machinery serves this |
| Lead source attribution + UTM tracking | SHIPPED (reuse) | `Contact.firstTouchSource` + `Touchpoint` model already wired | No travel-specific extension required |

### §4.2 Diagnostic engine (cross-cutting)

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Diagnostic builder (Q-bank editor) | PARTIAL | Backend: `routes/travel_diagnostics.js:139` POST `/diagnostic-banks` admin endpoint shipped. Frontend: `pages/travel/DiagnosticBuilder.jsx` exists | Phase 1 = view-only per Q16; Phase 1.5 edit-with-audit not started |
| Weighted scoring engine | SHIPPED | `lib/travelDiagnosticScoring.js` (commit `dd5fa42`) + 20+ vitest cases | Per-answer weights → score → band mapping all done |
| Classification bands (4 levels per brand) | SHIPPED | `TravelDiagnostic.classification` + `.classificationLabel` + `.recommendedTier` (`schema.prisma:4090-4092`) | Q13 ready — TMC + RFU Q-sets uploadable via CSV import per `travel_csv_io.js` |
| Auto-generated branded PDF report | SHIPPED | `routes/travel_diagnostics.js:43-78` `generateDiagnosticPdfBestEffort` (commit `47218e6`) | Per-sub-brand templates still placeholder until Q22 brand assets land (decision = "all ready") |
| Auto CRM record creation (Contact + Diagnostic + Lead) | SHIPPED | `routes/travel_diagnostics.js:493-557` public submit creates Contact + Diagnostic + dedup via `findDuplicateContactFull` | No `Diagnostic pending` → `Qualified` Deal-stage transition yet (deals not auto-created today) |
| Curriculum mapping logic (TMC-only) | GAP-PRODUCT-CALL | No code surface; PRD scope-ambiguous | Q13 says "scoring weights written + ready to share" but curriculum→tier mapping isn't spelled out in the PRD — likely Q-bank tagging covers it but needs confirmation |
| Risk flagging (Visa Sure) | SHIPPED (schema) | `VisaApplication.advisorRiskFlag` (`schema.prisma:4459`) | Phase 3 model; no route handlers yet — `routes/travel_visa.js` does not exist |
| LLM-generated talking points per advisor | SHIPPED | `POST /api/travel/diagnostics/:id/talking-points/regen` (commit `cf876af`) — first LLM router consumer; writes `{ text, model, generatedAt, stub }` envelope to `talkingPointsJson` | Stub-mode-ready; real Claude output lands when Q11 keys arrive |
| AI summary notes (Visa Sure) | GAP-AUTONOMOUS | Phase 3 scope — out of Phase 1 | Defer; same shape as talking-points once that lands |

### §4.3 Itinerary / package builder

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| RFU Umrah quotation engine (unified search flight+hotel+transport) | PARTIAL | `routes/travel_itineraries.js` ships full CRUD + items + version chain + share + PDF + accept/reject (commits `ec687c6` `45bef33` `c18fe62`) | Multi-product trip composition works; "unified-search lowest-rate auto-select" requires RateHawk wire-in which is cred-blocked |
| Hotel rate comparator (RateHawk P1 per Q19) | GAP-CRED-BLOCKED | No `services/ratehawkClient.js` | Q1 RateHawk API key needed; Booking/Expedia explicitly P1.5 per Q19 |
| Preference filters (RFU Haram-facing / floor / room category) | PARTIAL | `TravelCostMaster.attributesJson` (`schema.prisma:4196`) supports them; UI filters not built | Schema can carry the preferences but no filter UI / API consumer yet |
| Rule-based transport pricing with seasonal logic | SHIPPED | `TravelSeasonCalendar` + `TravelMarkupRule` models (`schema.prisma:4211, 4226`) + `routes/travel_pricing.js` (`/pricing/quote`) + `lib/travelPricing.js` (commit `7d3e87f` — 21 vitest + 14 gate) | Admin-editable via PATCH endpoints |
| Cost master admin panel | SHIPPED | `routes/travel_cost_master.js` (5 endpoints, commit `d572d56`); `pages/travel/CostMaster.jsx` | Plus CSV import/export (`routes/travel_csv_io.js`, commit `2840d46`) |
| Branded itinerary PDF with version history | SHIPPED | `routes/travel_itineraries.js:706` GET `/itineraries/:id/pdf` (commit `c18fe62`); `Itinerary.parentItineraryId` + status enum (commit `45bef33`) | Version chain server-side; PDF endpoint produces real bytes |
| Flight Quotation Chrome plugin | GAP-AUTONOMOUS | No `flight-plugin/` directory at repo root; no `quotations/flight/extract` route | Phase 1 W3 scope per PRD; ~10-15 engineer-days as a bundle (manifest v3 + content script + popup + signed-CRX update server) |
| Trip itinerary template per TMC trip | SHIPPED | `TripMicrosite.itineraryHtml` is the rendered template (`schema.prisma:4523`); `routes/travel_microsites.js:154` POST | Inline editor with rich-text + image upload shipped (commit `02c304e`) |

### §4.4 Quote / invoice / payment

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Quotation upload (Travel Stall — manual attachment) | SHIPPED (reuse) | `routes/contacts.js` ContactAttachment + existing Quote model | Reuse existing |
| Manual or structured quotation (Visa Sure) | PARTIAL (schema only) | `VisaApplication` model shipped; route handlers absent | Phase 3 |
| Invoice generation with GST capture (CGST/SGST/IGST) | SHIPPED (reuse) | `routes/billing.js` + Invoice model + `Invoice.legalEntityCode` (`schema.prisma:814`) | Existing Invoice already supports tax fields |
| CA / Tally export | SHIPPED | `routes/billing.js:130` GET `/export/tally.xml` + `:181` GET `/export/ca-summary.csv` (commit `4a07fca`); `lib/tallyXmlExport.js` + `lib/caCsvExport.js` | Q5 sample format pending counsel for parity but baseline format ships |
| Excel Software for Travel bridge (P1 import / P1.5 API) | GAP-CRED-BLOCKED | No `services/excelSoftwareClient.js` | Q8 = "Has REST API — will share docs"; pending docs handover |
| Per-entity payment tracking | SHIPPED | `Invoice.legalEntityCode` (`schema.prisma:814`) | One column carries the per-entity tag |
| Payment plan tracking (TMC instalments + reminders) | PARTIAL | `TripPaymentPlan` + `TripInstalmentPayment` models + `routes/travel_trip_billing.js` (commit `31aabe2`) + `cron/tripPaymentReminders.js` (commit `e3e2cd9`) | Crons fire but WA dispatch is stub (Q9-blocked). NB: per TODOS line 167, the cron for `TripInstalmentPayment` instalments isn't yet looking at real instalment rows — `/instalments/from-plan` materialiser is Phase 1.5 per `travel_trip_billing.js:23` |

### §4.5 Booking + supplier coordination

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Trip / Booking record (TMC) | SHIPPED | `TmcTrip` model + `routes/travel_trips.js` 12 endpoints (commit `97d78b6`) | Auto-creates microsite + Drive folder hooks |
| TMC confirmed-trip microsite | SHIPPED | `TripMicrosite` model + `routes/travel_microsites.js` admin CRUD + `/microsites/public/:publicUuid` view (commit `9b9e193`) | Subdomain `trip-<code>` per Q21 |
| Microsite OTP (4-digit, 10-min, WA delivery) | PARTIAL | `routes/travel_microsites.js:396` request-otp + `:469` verify-otp + `/full` PII reveal (commit `aca0781`) | OTP generation + verification + gated reveal shipped; WA delivery is stub (Q9-blocked) — logs to console today |
| Parent / teacher registration portal w/ DigiLocker | PARTIAL | `routes/travel_trips.js:510, 546` `/digilocker/initiate` + `/callback` + `DigilockerSession` model (commit `1babe1b`) | Stub-mode wiring complete; real DigiLocker swap is one-line when Q3 creds land. The customer-facing "registration submit" form (passport upload + parent details all in one POST) doesn't exist as a separate endpoint — participants are created via `/trips/:id/participants` (admin path) instead of a public parent-facing path |
| Rooming allocation interface + downloadable list | PARTIAL | `routes/travel_trip_billing.js:65-200` rooming CRUD + `RoomingAssignment` model | XLSX export per PRD §6.1 (`/rooming.xlsx`) NOT yet shipped |
| Departure checklist + per-student doc checklist | SHIPPED | `TripDocumentRequirement` model + `routes/travel_trips.js:603-654` documents CRUD | Schema + CRUD; per-participant join not yet — checklist is trip-scoped not participant-scoped today |
| RFU customer database (full profile) | SHIPPED | `RfuLeadProfile` model + `routes/travel_rfu_profiles.js` 6 endpoints (commit `8a1c287`) + `pages/travel/RfuCustomerProfile.jsx` | All PRD-listed fields present in schema |
| Customer-duplicate detection (name + phone + passport) | PARTIAL | `findDuplicateContactFull` wired in `routes/travel_rfu_profiles.js` (commit `ea817fb`) and public diagnostic intake | Email + phone dedup ship; passport-number key not yet added to match keys per PRD §4.5 |
| Login vault (supplier credentials, AES-256-GCM) | SHIPPED | `SupplierCredential` + access-log model + `routes/travel_suppliers.js` 7 endpoints (commit `4b6b95e`) + AES-256-GCM via `lib/fieldEncryption.js` | `/reveal` is the only decryption path; access-log on every reveal/rotate/delete |

### §4.6 Web check-in

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| P1A tracking + delivery (auto-schedule T-48h/T-24h, WA reminder, agent task, manual upload, dashboard) | PARTIAL | `WebCheckin` model (`schema.prisma:4387`) + `cron/webCheckinScheduler.js` (commit `a6e80eb`) + `routes/travel_webcheckin.js` (commit `9898e87`) + `lib/webCheckinWindow.js` per-airline T-window helper + auto-create on `POST /itineraries/:id/accept` | Backend complete: cron + model + 7-endpoint CRUD + multer boarding-pass upload + auto-create on itinerary accept. **Still missing:** `WebCheckinQueue.jsx` operator UI; WhatsApp dispatch on `/deliver` is Q9-stub |
| P1B top-4 airline automation (IndiGo, AI/Express, Vistara, Emirates per Q20) | GAP-AUTONOMOUS | No browser-automation engine | Phase 1 W4 scope; large single-commit (per-airline adapter pattern + retry + fallback). Pairs with Chrome plugin work |
| Fallback (2 failed retries → agent task; portal-down >2h → all-passengers-to-agents) | PARTIAL | `WebCheckin.status` enum includes `fallback-agent` + `failed` (`schema.prisma:4400`) | Schema-level only; no code emits these transitions today |
| Boarding-pass auto-delivery (WA + email) | GAP-STUB-ABLE | `WebCheckin.boardingPassUrl` + `deliveredAt` columns + `POST /webcheckins/:id/deliver` endpoint (commit `9898e87`) emits Wati-stub log line | Real WA send is one-line swap in `/deliver` handler when Q9 creds land. Email path still untouched; mirror the stub pattern |

### §4.7 Visa documents + compliance

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Structured document checklist + status tracking (per visa type / per passenger) | PARTIAL (schema only) | `VisaDocumentChecklistItem` model (`schema.prisma:4474`) | Phase 3 — no route handlers, no UI |
| Passport OCR + secure storage | GAP-CRED-BLOCKED | `TripParticipant.passportNumber`/`passportExpiry`/`passportDocId` columns exist; no OCR call | Needs OCR provider creds (Google Document AI or Azure Form Recognizer). No service stub today |
| Document security model (AWS Mumbai multi-AZ, AES-256, audit log, watermark, share-link expiry, retention) | PARTIAL | AES-256 via `lib/fieldEncryption.js` ✅; AuditLog ✅; retention engine ✅ (`cron/retentionEngine.js`) | Watermark + share-link expiry NOT shipped. Hosting decision is **on-prem** per Q6 — diverges from "AWS Mumbai" line in PRD §4.7 (PRD predates Q6 decision) |
| Rejection-recovery program (Visa Sure) | PARTIAL (schema only) | `VisaApplication.recoveryProgramId` placeholder column | Phase 3 |
| Aadhaar OCR via DigiLocker (offline-KYC) | PARTIAL (stub-mode) | `services/digilockerClient.js` + `DigilockerSession` model + initiate/callback routes (commit `1babe1b`) + `e2e/tests/travel-digilocker-stub-api.spec.js` | Stub shipped end-to-end; real swap = Q3 cred drop. See [DIGILOCKER_INTEGRATION_SPEC.md](DIGILOCKER_INTEGRATION_SPEC.md) |
| Aadhaar consent legal copy | GAP-PRODUCT-CALL | Draft at [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md) (commit `7d162cd`) | Pending Travel Stall counsel review per Q2 |

### §4.8 Customer communications

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Embedded WhatsApp Web for staff | SHIPPED (reuse) | `routes/whatsapp.js` existing | No travel-specific work needed |
| WhatsApp Business API for automation (3 WABA via Wati BSP) | GAP-CRED-BLOCKED | `services/whatsappProvider.js` already talks Meta Cloud API; Wati onboarded the numbers upstream | Q9 — needs Meta Business Manager artifacts. Five crons + microsite OTP + itinerary `/share` are dispatching to stubs today. See [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md) |
| Email (Gmail + Mailgun + Nodemailer + IMAP) | SHIPPED (reuse) | `routes/email.js` + `services/*` | Existing |
| Calendar / Meet booking (Google Workspace OAuth) | SHIPPED (reuse) | `routes/calendar_google.js` | Existing |
| Drive folder auto-creation for confirmed TMC trips | PARTIAL (stub-mode) | `services/googleDriveClient.js` (commit `192de86`) + wire-in at `routes/travel_trips.js:140-166, 271-282` | Stub shipped; real swap = Q1 Workspace admin creds (`GOOGLE_WORKSPACE_CLIENT_ID/SECRET/REFRESH_TOKEN`) |
| Umrah journey reminders (driver/hotel/group/departure) | PARTIAL | `cron/travelJourneyReminders.js` (commit `1e3c123`) | Cron fires; WA dispatch stub (Q9) |
| Religious-guidance content delivery (RFU curated library, scheduled) | GAP-AUTONOMOUS | No code surface | Sequence + scheduledEmail reuse pattern; content library is Yasin packet (Q1) |
| Trip reminders + post-trip feedback form (TMC) | PARTIAL | `cron/tripPostTripFeedback.js` (commit `893f60d`) | Cron fires; Survey reuse pattern. WA dispatch stub (Q9) |
| Birthday / anniversary greetings | SHIPPED (Phase 2) | `cron/contactGreetingsEngine.js` + WhatsAppMessage row in `pending_dispatch` | Per PRD §4.8 this is Phase 2 — confirmed shipped early |

### §4.9 Reports / dashboards

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Management dashboard KPIs (cross-brand) | SHIPPED | `routes/travel_dashboard.js:57` + `pages/travel/Dashboard.jsx` (commit `b40ef4a`) | Aggregate replaces Day-1 stub |
| TMC analytics (revenue-by-destination, repeat-school, margin, conversion-by-diagnostic-score) | SHIPPED | `routes/travel_reports.js:69` `/reports/tmc` (commit `aae1700`) | All 4 aggregates returned; conversion-by-diagnostic approximated via Deal.diagnosticId join |
| RFU analytics (revenue-by-tier, conversion-by-tier, repeat-customer) | SHIPPED | `routes/travel_reports.js:193` `/reports/rfu` | Tier dimension reads `Itinerary.productTier` |
| Travel Stall analytics | PARTIAL | Not in the current reports route; Phase 2 scope per Q17 | Schema is ready |
| Visa Sure analytics | PARTIAL | Phase 3 scope per Q18 | Schema is ready |
| Platform-wise marketing reports (AdsGPT integration) | GAP-CRED-BLOCKED | No AdsGPT route surface in travel namespace | Q1 — Travel Stall AdsGPT creds + handover |
| TMC ops dashboard per confirmed trip | PARTIAL | `pages/travel/TripDetail.jsx` shipped; explicit "/trips/:id/ops-dashboard" endpoint NOT shipped | Detail page aggregates client-side over existing endpoints |

### §4.10 Sub-vertical-specific call-outs

Most rolled up into the above tables. Net:

| Item | State | Notes |
|---|---|---|
| TMC diagnostic-first + curriculum mapping + teacher OTP access | SHIPPED (partial — teacher OTP) | OTP flow supports `purpose=teacher-access` (`schema.prisma:4540`) but no dedicated teacher access UI |
| RFU 4-tier tagging drives quotation tier | SHIPPED | `Itinerary.productTier` (commit `2612a7e`) defaults from latest diagnostic via `lib/travelLatestDiagnostic.js` |
| RFU Haram-facing hotel filters | PARTIAL | Schema-supported; no filter UI |
| LLM-switchable layer for quotation engine | GAP-STUB-ABLE | `lib/llmRouter.js` scaffold shipped (commit `583c06b`); quotation-engine consumer call site still missing | Router exposes `routeRequest({task: "bulk-text", payload, tenantId})` for itinerary draft; quotation routes need to wire it in |
| Aadhaar OCR via DigiLocker | PARTIAL (stub) | See §4.7 |
| Passport OCR | GAP-CRED-BLOCKED | See §4.7 |
| Religious-guidance content library | GAP-AUTONOMOUS | See §4.8 |
| Umrah journey reminders | PARTIAL | See §4.8 |
| Travel Stall Family Travel Quiz | SHIPPED | `pages/public/TravelStallQuiz.jsx` (commit `1260caa`) + backend endpoints `/diagnostics/public/*` |
| Travel Stall 50% advance booking | SHIPPED | `routes/travel_itineraries.js:773, 833` public share-token + advance-payment endpoint (commit `8abf6f3`); per-tenant tunable advance ratio (commit `ee35d00`) |
| Travel Stall personalised 3-5 recommendations PDF | GAP-AUTONOMOUS | Phase 2 — no current route surface | Needs LLM-router + per-sub-brand template |
| Travel Stall email-first acquisition (zero paid ads model) | SHIPPED (reuse) | Existing email machinery + Sequence engine | No travel-specific work |
| Visa Sure 15Q readiness + risk-flag dashboard | PARTIAL (schema only) | Phase 3 |
| Visa Sure rejection-recovery program | PARTIAL (schema only) | Phase 3 |

---

## §5 Data model

### §5.1 New models — 23 models

| Model | State | Schema location | Notes |
|---|---|---|---|
| `TravelDiagnostic` | SHIPPED | `schema.prisma:4080` | All PRD fields present incl. `talkingPointsJson` (unused yet) |
| `TravelDiagnosticQuestionBank` | SHIPPED | `schema.prisma:4104` | Versioned per `(tenantId, subBrand)` |
| `Itinerary` | SHIPPED | `schema.prisma:4121` | Plus Phase 2 advance-payment columns + `productTier` |
| `ItineraryItem` | SHIPPED | `schema.prisma:4169` | All PRD fields |
| `TravelCostMaster` | SHIPPED | `schema.prisma:4189` | Plus attributesJson for hotel prefs |
| `TravelSeasonCalendar` | SHIPPED | `schema.prisma:4211` | |
| `TravelMarkupRule` | SHIPPED | `schema.prisma:4226` | Agent-level via `ownerUserId` |
| `TmcTrip` | SHIPPED | `schema.prisma:4245` | + microsite/Drive folder cols |
| `TripParticipant` | SHIPPED | `schema.prisma:4272` | Aadhaar + passport cols ready |
| `RoomingAssignment` | SHIPPED | `schema.prisma:4328` | |
| `TripPaymentPlan` | SHIPPED | `schema.prisma:4341` | 1:1 with trip |
| `TripInstalmentPayment` | SHIPPED | `schema.prisma:4351` | |
| `TripDocumentRequirement` | SHIPPED | `schema.prisma:4369` | Trip-scoped (not per-participant) |
| `WebCheckin` | SHIPPED | `schema.prisma:4387` + `routes/travel_webcheckin.js` (commit `9898e87`) | Full CRUD + auto-create on Itinerary.accept |
| `SupplierCredential` | SHIPPED | `schema.prisma:4418` | AES-256 fields |
| `SupplierCredentialAccessLog` | SHIPPED | `schema.prisma:4436` | |
| `VisaApplication` | SHIPPED (Phase 3) | `schema.prisma:4449` | Schema-defined; no routes |
| `VisaDocumentChecklistItem` | SHIPPED (Phase 3) | `schema.prisma:4474` | Schema-only |
| `RfuLeadProfile` | SHIPPED | `schema.prisma:4490` | |
| `TripMicrosite` | SHIPPED | `schema.prisma:4517` | |
| `TripMicrositeOtp` | SHIPPED | `schema.prisma:4536` | |
| `DigilockerSession` | SHIPPED | `schema.prisma:4304` (commit `1babe1b`) | Stub-mode plumbed end-to-end |
| `TenantSetting` | SHIPPED | `schema.prisma:2853` (commit `ee35d00`) | Per-tenant key/value; first consumer = travel advance ratio |

### §5.2 Extensions to existing models

| Extension | State | Schema location |
|---|---|---|
| `Tenant.subBrandConfigJson` (per-brand WhatsApp/WABA/legal entity/GSTIN/Drive root) | SHIPPED schema, **NOT YET CONSUMED** anywhere | `schema.prisma:168` — zero grep-hits in `routes/` or `lib/` |
| `Contact.subBrand` | SHIPPED | `schema.prisma:439` |
| `Deal.subBrand` + `Deal.diagnosticId` | SHIPPED | `schema.prisma:589-590` |
| `Booking.tripId` + `Booking.itineraryId` (FK bridge) | NOT NEEDED YET | Booking model not bridged to TmcTrip/Itinerary; PRD says "optional" — defer until a cross-model query needs it |
| `Invoice.legalEntityCode` | SHIPPED | `schema.prisma:814` |
| `User.subBrandAccess` | SHIPPED | `schema.prisma:357` |

---

## §6 Route plan

### §6.1 New route files — 11 expected

| Expected file | State | Notes |
|---|---|---|
| `travel.js` | SHIPPED | `routes/travel.js` (`/health` only — minimal); cross-sub-brand dashboard lives in `travel_dashboard.js`; sub-brand switcher inferred client-side from `User.subBrandAccess` (no `/sub-brands/:code/switch` endpoint) |
| `travel_diagnostics.js` | SHIPPED | 10 endpoints incl. public submit + report PDF + `/talking-points/regen` (commit `cf876af`) |
| `travel_itineraries.js` | SHIPPED | 14 endpoints; `/share` shipped (commits `45bef33`, `22bb641`, `fef099b`) |
| `travel_quotation_flight.js` | GAP-AUTONOMOUS (Chrome plugin) | Does not exist; Phase 1 W3 scope |
| `travel_cost_master.js` | SHIPPED | 5 endpoints |
| `travel_supplier_vault.js` | SHIPPED (as `travel_suppliers.js`) | 7 endpoints — file naming diverges from PRD but content matches |
| `travel_trips.js` (TMC) | SHIPPED | 17 endpoints incl. participants + documents + DigiLocker |
| `travel_trip_microsite_public.js` | SHIPPED (folded into `travel_microsites.js`) | Public endpoints under `/microsites/public/:publicUuid` |
| `travel_payment_plans.js` | SHIPPED (as `travel_trip_billing.js`) | 11 endpoints incl. rooming + plan + instalments |
| `travel_webcheckin.js` | SHIPPED | commit `9898e87`; 7 endpoints (list/upcoming/get/post/patch/upload-pass/deliver) + ADMIN-only DELETE |
| `travel_visa.js` (Visa Sure) | GAP (Phase 3) | Schema-ready, no routes |
| `travel_callified.js` | GAP-CRED-BLOCKED | Q11 routing locked; needs Callified.ai handover per Q1 |

**Bonus shipped routes not in original PRD §6.1:** `travel_dashboard.js`, `travel_reports.js`, `travel_rfu_profiles.js`, `travel_microsites.js`, `travel_pricing.js`, `travel_csv_io.js`, `travel_trip_billing.js`.

### §6.2 Reused routes — all SHIPPED in main CRM, no travel-specific extension needed beyond seed templates / per-sub-brand config.

### §6.3 New cron engines — 6 expected

| Engine | State | Evidence |
|---|---|---|
| `webCheckinScheduler.js` | SHIPPED | `cron/webCheckinScheduler.js` (commit `a6e80eb`) — now fed by `9898e87`'s auto-create on Itinerary.accept |
| `webCheckinAutomation.js` (event-driven, browser-automation per airline) | GAP-AUTONOMOUS | NOT shipped; Phase 1 W4 scope |
| `tripPaymentReminders.js` | SHIPPED | `cron/tripPaymentReminders.js` (commit `e3e2cd9`) |
| `travelJourneyReminders.js` | SHIPPED | `cron/travelJourneyReminders.js` (commit `1e3c123`) |
| `tripPostTripFeedback.js` | SHIPPED | `cron/tripPostTripFeedback.js` (commit `893f60d`) |
| `travelDiagnosticAdvisorAlerts.js` | SHIPPED | `cron/travelDiagnosticAdvisorAlerts.js` (commit `9729f01`) |

---

## §7 Frontend page plan — 22 pages expected

| Page | State | Path |
|---|---|---|
| `Dashboard.jsx` | SHIPPED | `pages/travel/Dashboard.jsx` |
| `Leads.jsx` | SHIPPED | `pages/travel/Leads.jsx` |
| `LeadDetail.jsx` | NOT SHIPPED | `/travel/leads/:id` route not in App.jsx |
| `DiagnosticBuilder.jsx` | SHIPPED | `pages/travel/DiagnosticBuilder.jsx` |
| `DiagnosticPreview.jsx` | NOT SHIPPED | No preview page |
| `DiagnosticPublic.jsx` (`/p/diagnostic/:subBrand/:bankId`) | SHIPPED-equivalent | `TravelStallQuiz.jsx` mounted at `/travel-stall/quiz` (path differs from PRD) |
| `ItineraryBuilder.jsx` | PARTIAL | `pages/travel/Itineraries.jsx` lists; explicit /new builder route NOT in App.jsx |
| `ItineraryDetail.jsx` | NOT SHIPPED | Detail not mounted as separate route |
| `CostMaster.jsx` | SHIPPED | `pages/travel/CostMaster.jsx` |
| `FlightQuoteAgent.jsx` | NOT SHIPPED | In-CRM fallback for Chrome plugin |
| `MarkupRules.jsx` (admin) | SHIPPED (as `PricingRules.jsx`) | `pages/travel/PricingRules.jsx` |
| `SupplierVault.jsx` | SHIPPED (as `Suppliers.jsx`) | `pages/travel/Suppliers.jsx` |
| `TmcTrips.jsx` | SHIPPED (as `Trips.jsx`) | `pages/travel/Trips.jsx` |
| `TmcTripDetail.jsx` | SHIPPED (as `TripDetail.jsx`) | `pages/travel/TripDetail.jsx` |
| `TmcRooming.jsx` | NOT SHIPPED | Folded into TripDetail today |
| `TmcPaymentPlan.jsx` | NOT SHIPPED | Folded into TripDetail today |
| `TmcDocumentChecklist.jsx` | NOT SHIPPED | Folded into TripDetail today |
| `TmcMicrositePreview.jsx` | NOT SHIPPED | Admin preview not wired |
| `WebCheckinQueue.jsx` | NOT SHIPPED | Pending §4.6 work |
| `RfuCustomerProfile.jsx` | SHIPPED | `pages/travel/RfuCustomerProfile.jsx` |
| `RfuJourneyReminders.jsx` | NOT SHIPPED | Reminder list view not yet |
| `VisaApplications.jsx` + `VisaApplicationDetail.jsx` + `VisaAdvisorDashboard.jsx` | NOT SHIPPED (Phase 3) | |
| `TravelStallFamilyQuiz.jsx` | SHIPPED | `pages/public/TravelStallQuiz.jsx` |
| `TravelReports.jsx` | SHIPPED | `pages/travel/Reports.jsx` |
| `TripBooking.jsx` (50%-advance flow, bonus) | SHIPPED | `pages/public/TripBooking.jsx` (mounted at `/trip/:shareToken`) |

### §7.1 Public micro-sites

| Page | State | Notes |
|---|---|---|
| `TripMicrosite.jsx` (SSR via landingPageRenderer) | NOT SHIPPED | Public microsite served as JSON via `/microsites/public/:publicUuid`; no SSR'd HTML page rendered through `services/landingPageRenderer.js` yet |

### §7.2 Chrome extension

| Item | State |
|---|---|
| `flight-plugin/` package at repo root | NOT SHIPPED |

---

## §8 Vertical config

| Item | State | Evidence |
|---|---|---|
| `Tenant.vertical = "travel"` value | SHIPPED | `seed-travel.js:45,55` |
| `renderTravelNav()` in Sidebar | SHIPPED | `frontend/src/components/Sidebar.jsx:967, 625` |
| Sub-brand switcher in sidebar | SHIPPED | `Sidebar.jsx:986-1019` |
| Theme `frontend/src/theme/travel.css` | SHIPPED (placeholder palette) | 74 lines; per Q22 brand assets "all ready" but not yet applied to theme |
| Landing route `/travel` | SHIPPED | `App.jsx:266-268` |
| Seed `seed-travel.js` | PARTIAL | tenant + users + diagnostic banks for tmc/rfu/travelstall/visasure + cost master + seasons + **8-status Pipeline + 8 PipelineStage rows + 8 WinLossReason rows** (commit `ab2f15f`). **Still missing:** sample TmcTrip, sample Itinerary, sample VisaApplication, sample SupplierCredential |

---

## §9 External integrations

| Integration | State | Notes |
|---|---|---|
| **Wati BSP wrapper** (3 WABAs) | GAP-CRED-BLOCKED | Q9 — `whatsappProvider.js` talks Meta Cloud direct; Wati is upstream onboarding. 8 features dispatching to stubs. See [WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md) |
| **Meta WhatsApp Cloud API** | SHIPPED (reuse) | `services/whatsappProvider.js` |
| **Callified.ai / Exotel** (AI calling Eng/Hin/Urdu) | GAP-CRED-BLOCKED | Sandbox mock at `scripts/sandbox/callified-mock.js`; no client + no travel-callified route |
| **Google Workspace** (Drive/Gmail/Calendar/Meet) | PARTIAL (stub-mode for Drive) | `services/googleDriveClient.js` stub (commit `192de86`); Gmail + Calendar already reuse existing |
| **RateHawk** (hotel B2B) | GAP-CRED-BLOCKED | Q1 RateHawk key needed |
| **Booking.com / Expedia** | GAP (Phase 1.5 per Q19) | |
| **DigiLocker** (Aadhaar XML) | PARTIAL (stub-mode) | `services/digilockerClient.js` shipped; Q3 cred drop unlocks real |
| **Passport OCR** (Google Document AI or MS Form Recognizer) | GAP-CRED-BLOCKED | No service stub |
| **AdsGPT** | GAP-CRED-BLOCKED | Q1 — no travel-specific integration |
| **LLM router** (Perplexity/Gemini/Claude/GPT, Q11 routing) | SHIPPED | `lib/llmRouter.js` scaffold (commit `583c06b`); stub-mode returns deterministic synthetic responses matching real-mode shape. Real provider call wires in when Q11 API keys land. `LlmCallLog` model + admin daily-summary endpoint deferred to first consumer |
| **Meta/Google/LinkedIn/YouTube Ads APIs** | GAP-CRED-BLOCKED | Q1 |
| **Excel Software for Travel** | GAP-CRED-BLOCKED | Q8 API docs pending |
| **Airline portals** (IndiGo/AI/AI Express/Vistara/Emirates) | GAP-AUTONOMOUS | Browser-automation; Phase 1 W4 — paired with Chrome plugin |
| **Razorpay** | SHIPPED (reuse) | `routes/payments.js` already wired per Q4 |
| **Tally** | SHIPPED | `lib/tallyXmlExport.js` + `routes/billing.js:130` |

### §9.1 LLM routing defaults (Q11 locked)

| Task | Locked model | Implementation state |
|---|---|---|
| Diagnostic interpretation | Perplexity | SHIPPED via talking-points endpoint (commit `cf876af`) routing through Claude; stub-mode-ready until Q11 keys land |
| Itinerary draft | Gemini 2.5 | GAP-AUTONOMOUS |
| AI qualification call | Gemini Live | GAP-CRED-BLOCKED (Callified front-end) |
| Document OCR fallback | Gemini Vision | GAP-CRED-BLOCKED (passport OCR needs provider creds first) |
| Sentiment / KPI insights | Gemini 2.5 | GAP-AUTONOMOUS (reuse existing Gemini wrapper) |

---

## §10 Phased plan — exit-gate verification

### Phase 1 W1-W6 exit-gate state

| Week | Contractual exit gate | Current state |
|---|---|---|
| W1 | SSO live; inbound WhatsApp creates enquiries; templates submitted | PARTIAL — SSO reuse (Workspace existing); WA enquiries cred-blocked (Q9); templates not in code |
| W2 | Both diagnostics live; AI calling with summary attached | PARTIAL — Diagnostics ✅; AI calling 🔴 (Callified GAP) |
| W3 | Flight plugin: 4-option quote in 60s; RFU quotation returns lowest rate | RED — Flight plugin not started; RFU returns multi-product itinerary but no rate auto-pick (RateHawk GAP) |
| W4 | Web check-in live for top-4 airlines; TMC microsite pilot | PARTIAL — Microsite ✅ + cron ✅; airline automation GAP; WebCheckin route GAP |
| W5 | Dashboards meet KPI list; CA export validated | SHIPPED — Reports + Dashboard + Tally export all ship |
| W6 | UAT ≥90% P1A pass; go-live D42 | BLOCKED — UAT users (Q15) pending |

### Phase 1.5 follow-on state

| Item | State |
|---|---|
| Web check-in Tier-2 airlines | GAP (downstream of Tier-1 GAP) |
| Admin-editable diagnostic scoring with audit + sandbox | GAP-AUTONOMOUS (Q16 view-only confirmed for P1; edit-with-audit for P1.5 not started) |
| Excel Software API bridge | GAP-CRED-BLOCKED (Q8) |
| Booking.com + Expedia direct APIs | GAP-CRED-BLOCKED (Q19) |
| Long-tail airline automation (captcha-aware) | GAP (downstream) |
| Seasons + markup rules admin UI | SHIPPED (`PricingRules.jsx`) |

### Phase 2 (Travel Stall) state

Per Q17 confirmed Phase 2. Already shipped: Family Travel Quiz, 50%-advance booking pattern, tunable per-tenant advance ratio, public diagnostic endpoints. GAPS: personalised 3-5 destination recommendation PDF (LLM-driven), customer-duplicate full pop-up flow, birthday/anniversary greetings (✅ shipped early), Booking.com+Expedia direct APIs.

### Phase 3 (Visa Sure) state

Per Q18 confirmed Phase 3. Schema-only state — `VisaApplication` + `VisaDocumentChecklistItem` models shipped; no route file (`routes/travel_visa.js` does not exist); no UI pages.

---

## §12 Open questions cross-reference

All 25 questions decided 2026-05-20. Per-question implementation status:

| # | Tier | Question | Decision | Code state |
|---|---|---|---|---|
| Q1 | CRITICAL | Section 13 packet | 🟢 Most ready | RESOLVED-pending-handover (Drive folder stub-ready) |
| Q2 | HIGH | Aadhaar consent legal copy | 🟢 GS drafts → counsel | DRAFT (commit `7d162cd`); counsel review pending |
| Q3 | CRITICAL | DigiLocker creds | 🟢 Travel Stall has them | RESOLVED-pending-handover; stub end-to-end ready |
| Q4 | MEDIUM | Payment gateway | 🟢 Razorpay | RESOLVED (already wired) |
| Q5 | MEDIUM | CA export sample | 🟢 Tally | RESOLVED-pending-sample; Tally exporter shipped |
| Q6 | MEDIUM | Data residency | 🟢 On-prem (R11 added) | RESOLVED; R11 ops work pending |
| Q7 | CRITICAL | SSO provider | 🟢 Google Workspace | RESOLVED (reuse) |
| Q8 | MEDIUM | Excel SW integration | 🟢 REST API | RESOLVED-pending-docs |
| Q9 | CRITICAL | WhatsApp numbers | 🟢 3 procured | RESOLVED-pending-handover; stubs in place. 8-feature unblock |
| Q10 | CRITICAL | Pipeline labels | 🟢 GS defaults | DECIDED + SEEDED (commit `ab2f15f`) — both 8-stage Pipeline + 8 lost-reason rows live |
| Q11 | HIGH | LLM defaults | 🟢 Routing locked | DECIDED + router scaffold shipped (commit `583c06b`); real API-key wire-in pending Q11 cred drop into `SupplierCredential` category `"llm-key"` |
| Q12 | HIGH | KPI periods | 🟢 D/W/M | RESOLVED (reports support all 3) |
| Q13 | CRITICAL | Diagnostic length | 🟢 Both ready | RESOLVED-pending-content (CSV import ready) |
| Q14 | CRITICAL | Retention durations | 🟢 GS defaults | RESOLVED (retention engine ✅) |
| Q15 | MEDIUM | UAT users | 🟢 All identified | RESOLVED-pending-handover |
| Q16 | CONFLICT | RFU editable scoring | 🟢 View-only P1 | RESOLVED (Phase 1.5 work; Q-bank POST endpoint exists but admin UI gates) |
| Q17 | CONFLICT | Travel Stall scope | 🟢 Phase 2 | RESOLVED |
| Q18 | CONFLICT | Visa Sure scope | 🟢 Phase 3 | RESOLVED |
| Q19 | HIGH | Hotel comparator | 🟢 RateHawk P1 | RESOLVED-pending-creds |
| Q20 | HIGH | Top-N airlines | 🟢 4 in P1 | RESOLVED-pending-code (Chrome plugin + automation engine GAP) |
| Q21 | HIGH | Subdomain | 🟢 tmc.travelstall.in | RESOLVED-pending-DNS |
| Q22 | CRITICAL | Brand assets | 🟢 All ready | RESOLVED-pending-handover (theme placeholder palette in `travel.css`) |
| Q23 | MEDIUM | Premium support | 🟢 Premium 90-day | RESOLVED (process) |
| Q24 | HIGH | Decimal precision | 🟢 Decimal(15,2) | RESOLVED (schema uses `Decimal(15,2)` per `schema.prisma:4144` etc.) |
| Q25 | HIGH | Tenancy | 🟢 Single tenant + tags | RESOLVED |

---

## R-marker risk register cross-reference

| # | Risk | Status | Code-side delta since 2026-05-20 |
|---|---|---|---|
| R1 | Section 13 packet | 🟡 | No change — depends on Yasin's deliverables |
| R2 | 6-week timeline | 🔴 | Calendar slip — large W3/W4 items (Chrome plugin + airline automation + Callified + LLM router) not yet started |
| R3 | Chrome extension auto-update | 🔴 | Plugin not built; risk dormant until code exists |
| R4 | Hotel comparator scope drift | 🟢 | Resolved |
| R5 | DigiLocker creds | 🟢 | Stub shipped; awaits cred handover |
| R6 | Tenancy model irreversibility | 🟢 | Resolved + implemented (single-tenant + `subBrandAccess[]`) |
| R7 | LLM cost + observability | 🟡 | Router NOT built; cost dashboard NOT built |
| R8 | Aadhaar legal exposure | 🟡 | Consent draft shipped; counsel review pending |
| R9 | Multi-WABA timeline | 🟢 | Resolved |
| R10 | Scope creep TS/VS | 🟢 | Resolved; Phase 2 Travel Stall has already shipped 50%-advance + public quiz |
| R11 | On-prem hosting complexity | 🔴 | No infra-handover call evidence in commits |

---

## Stub-mode swap-point inventory

For each shipped stub, the file + line where the `// STUB:` marker lives, the Q-marker that unlocks the swap, and what the swap entails.

| Stub file | Stub marker | Q-marker | Single-file swap |
|---|---|---|---|
| `backend/services/digilockerClient.js` | line 1 (`STUB MODE`) + line 19 (`STUB_DIGILOCKER_BASE`) | Q3 (DIGILOCKER_CLIENT_ID + DIGILOCKER_CLIENT_SECRET) | Replace `initiateSession` to sign the state with the client secret; replace `exchangeCallback` to POST to DigiLocker token endpoint + parse signed Aadhaar XML. Callers unchanged |
| `backend/services/googleDriveClient.js` | line 1 + line 56 (`STUB: Google Drive folder.create`) | Q1 (GOOGLE_WORKSPACE_CLIENT_ID/SECRET/REFRESH_TOKEN) | Swap `createTripFolder` body to call `googleapis` library; preserve return shape |
| `backend/cron/tripPaymentReminders.js` | "WhatsApp dispatch pending" log line | Q9 | Loop adds `await whatsappProvider.sendTemplate(...)` per row |
| `backend/cron/travelJourneyReminders.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/tripPostTripFeedback.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/webCheckinScheduler.js` | "WhatsApp dispatch pending" | Q9 | Same (also needs WebCheckin rows to actually exist — see autonomous gap above) |
| `backend/cron/contactGreetingsEngine.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/travelDiagnosticAdvisorAlerts.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/routes/travel_microsites.js:396` | `sendOtpStub` logs OTP to console | Q9 | Replace stub call with `whatsappProvider.sendOtp(phone, otp)` |
| `backend/routes/travel_itineraries.js:654` | `/share` returns URL; doesn't auto-WA | Q9 | Add `await whatsappProvider.sendTemplate(...)` after share-URL creation |

---

## Recommended next 5 cron dispatches (priority order)

1. ~~**Seed travel 8-status Pipeline + 8 lost reasons** (PRD §4.1; Q10 decision locked). Scope: extend `prisma/seed-travel.js` with a single Pipeline + 8 PipelineStage rows + 8 WinLossReason rows scoped to the travel tenant. Effort: small (~2 hrs). Why next: every Deal on the travel tenant lacks a place to flow today; pipeline integrity is a Phase 1 deliverable; commit is fully autonomous + zero cred dependency.~~ — ✅ **commit `ab2f15f`** (2026-05-22, gate-verified 7/7 spec cases)

2. **Build WebCheckin CRUD route + auto-create on Itinerary.accept** (PRD §4.6, §6.1 row `travel_webcheckin.js`). Scope: new `routes/travel_webcheckin.js` with `GET /upcoming`, `POST /` (admin), `POST /:id/upload-boarding-pass`, `POST /:id/deliver`; auto-create row on `POST /itineraries/:id/accept` for each flight `ItineraryItem`. Effort: medium (~½ day). Why next: cron is already running over an empty table; this gives it something to scan AND unblocks W4 exit gate without needing browser automation.

3. ~~**LLM router scaffold (`lib/llmRouter.js`)** with Q11 task→model routing + cost dashboard tile (PRD §9.1, R7). Scope: `lib/llmRouter.js` with `routeRequest({task, payload})` returning a normalized response; per-task provider selection (Perplexity for diagnostic interpretation, Gemini 2.5 for itinerary draft + sentiment, Gemini Vision for OCR fallback); cost-attribution log row per call; admin daily summary endpoint. Effort: medium (~1 day). Why next: prerequisite for talking-points + personalised recommendations + form-vs-call comparison; pure-code; locked routing means zero ambiguity.~~ — ✅ **commit `583c06b`** (stub-mode scaffold, 20 vitest cases; `LlmCallLog` model + admin daily-summary endpoint deferred to first real-mode consumer)

4. ~~**Diagnostic talking-points endpoint** (PRD §4.2; §6.1 row `/api/travel/diagnostics/:id/talking-points/regen`). Scope: new route + `lib/llmRouter` call + write to existing `TravelDiagnostic.talkingPointsJson` column. Effort: small (~3 hrs). Why next: column is shipped + unused; advisor needs context for the first call; depends on item 3 (LLM router) being green.~~ — ✅ **commit `cf876af`** (first LLM router consumer; ADMIN/MANAGER-only; PII-safe; stub-mode-ready)

5. **TMC sub-brand seed sample data** (PRD §8.5). Scope: extend `seed-travel.js` with 1 sample `TmcTrip` + 2 `TripParticipant` + 1 `RoomingAssignment` + 1 `TripPaymentPlan` + 4 `TripInstalmentPayment` + 1 `Itinerary` + 1 `SupplierCredential` (encrypted) + 1 `VisaApplication`. Effort: small (~3 hrs). Why next: every existing travel page renders empty against the demo seed because the demo data stops at diagnostic banks + cost master. UAT can't validate end-to-end flows until this lands. Idempotent upserts so demo re-seeds don't double-up.

---

*End of audit. Document is a snapshot at HEAD `192de86`; re-run when a Phase 1 milestone lands or when any cred Q-marker resolves.*
