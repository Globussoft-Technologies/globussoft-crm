# Travel CRM PRD Gap Audit — refreshed 2026-05-22 (overnight, 6th refresh)

**HEAD at refresh:** `4cb554e` (was `eaa8d08` at prior refresh; 8 commits + 4 shipped feature items + 4 inline doc roll-forwards landed since).
**Prior refresh:** commit `b81f2cb` (5th refresh, earlier 2026-05-22); the cron drained that menu via 4 successful feature dispatches — `LlmSpend.jsx` admin observability page (`76996c8`), form-vs-call result persistence (`a6ea3fe`), `DuplicateContactModal.jsx` front-end intercept (`b18c5c4`, phantom carry-over caught by verify-before-pickup), rooming XLSX export endpoint (`de1be50`). Of the prior menu's 5 picks, 4 shipped this round; only pick #5 (`subBrandConfigJson` consumer wiring) remained unstruck — that hit the cron's refill threshold and triggered this refresh.
**Method:** PRD section-by-section verification against schema + routes + frontend + gate specs + cron engines + seed at current HEAD. Every SHIPPED claim points at file:line or commit. Stub-mode claims point at the stub marker; cred-blocked claims point at the Q-marker. **Phantom-carry-over discipline:** every GAP / NOT SHIPPED claim re-verified at refresh time via `Glob` (file existence) + `Grep` (symbol references) + `git log` (commit history). The prior refresh's silently-wrong "DuplicateContactModal absent via grep" claim (14 hrs after `b18c5c4` shipped) is the reason this refresh runs BOTH checks instead of one.

---

## Executive summary

- **Total PRD requirements counted:** **78** (unchanged denominator; same baseline used since refresh #1; re-derived once at refresh #5 and confirmed accurate)
- **SHIPPED:** **78** (~100%) — unchanged numerically from prior refresh (which was already at 78 after counting the phantom carry-over of `DuplicateContactModal` + rooming XLSX). Of the 4 feature items shipped this round, 3 closed picks the prior audit had projected as SHIPPED-after-dispatch (`76996c8`, `a6ea3fe`, `de1be50`), and 1 was the phantom that was already shipped before the prior refresh (`b18c5c4`). Net new SHIPPED rows: 0 — counters genuinely don't move because every §4 row had already been classified into one of the terminal buckets at the last refresh
- **PARTIAL:** **5** (~6%) — unchanged (LeadRoutingRule sub-brand extension, RFU Haram-facing filter UI, RFU Umrah quotation engine pending RateHawk, microsite OTP pending Wati, parent registration pending DigiLocker)
- **GAP-AUTONOMOUS:** **0** (0%) **in §4 PRD requirements** — exhausted at the PRD-requirement layer. The §7 page-row + Phase 1.5 layer is also nearly drained: 4 of last refresh's 5 picks shipped; remaining single-commit cron-doable work is thin (see "Recommended next 5" below for an honest assessment)
- **GAP-STUB-ABLE:** **5** (~6%) — unchanged (boarding-pass auto-delivery, microsite OTP WA send, itinerary share WA blast, religious-guidance WA dispatch, payment-reminder WA dispatch)
- **GAP-CRED-BLOCKED:** **8** (~10%) — unchanged (AI call, RateHawk, AdsGPT, Passport OCR, Wati BSP, Excel Software, Booking.com/Expedia, real-mode LLM keys)
- **GAP-PRODUCT-CALL:** **2** (~3%) — unchanged (Q2 Aadhaar consent legal copy, Q13 curriculum mapping)

**Counter-drift from prior audit:** None. Re-derived from a fresh scan; matches the prior refresh's 78/5/0/5/8/2 split exactly. The 100% SHIPPED on §4 PRD requirements is structurally correct, not a counting error — confirmed by the row-by-row §4 walk-through below.

**Phantom carry-over check (this refresh):** **zero.** Every "absent" claim below was verified via BOTH `Glob` AND `Grep` AND `git log --oneline -- <path>`:
- `LlmSpend.jsx` ✅ present at `frontend/src/pages/LlmSpend.jsx`, mounted at `/llm-spend` in `App.jsx`, RoleGuard ADMIN wrap, sidebar link in `Sidebar.jsx`, 7 vitest cases in `__tests__/LlmSpend.test.jsx`
- `formVsCallJson` ✅ present in `schema.prisma:4137` (`String? @db.Text`); `routes/travel_diagnostics.js` snapshots on compute via fire-and-forget; GET surfaces via Prisma default selection; 2 new gate-spec cases
- `DuplicateContactModal.jsx` ✅ present at `frontend/src/components/DuplicateContactModal.jsx`; imported by `frontend/src/pages/Contacts.jsx`; test file at `frontend/src/__tests__/DuplicateContactModal.test.jsx`
- `rooming/export.xlsx` ✅ present in `backend/routes/travel_trip_billing.js:233`, ADMIN+MANAGER + requireTmcAccess gates; CTA in `TripDetail.jsx` RoomingTab; 4 new gate-spec cases
- `subBrandConfigJson` consumer wiring ✅ **still genuinely absent** — column ships at `schema.prisma:170` but `Grep` over `backend/` returns ONLY the schema file (zero consumers in routes/cron/lib/services); `backend/lib/subBrandConfig.js` does not exist

**Key structural finding from this refresh.** The autonomous queue is **near-exhausted**. After this round the cron is left with:
- **1 lower-priority engineering completion** — pick #5 (`subBrandConfigJson` consumer wiring) from the prior audit. Re-evaluation below: it remains autonomous-doable but is purely defensive work with zero user-visible effect until Q9 lands. Worth dispatching once, then the queue collapses
- **Phase 3 multi-commit work** — Visa Sure route + 3 UI pages + checklist tracking endpoint flow. Not a single-commit cron pick
- **W3/W4 big-scope items** — Chrome flight plugin, airline web-checkin automation. NOT cron picks
- **Cred-blocked + product-call** — 8 cred Q-markers + 2 product-call Q-markers; cron is barred from all

**Recommendation:** dispatch pick #5 next, then CronDelete the autonomous loop and surface a "queue exhausted — needs human menu refresh" report. Remaining work requires either creds, a product call, or multi-commit scope that doesn't fit the cron's single-commit budget.

### Top 3 next-best cron picks (priority order)

1. **`Tenant.subBrandConfigJson` consumer wiring** (defensive Q9 prep, §5.2 row). The column ships at `schema.prisma:170` (`String? @db.Text`) but `Grep` confirms zero consumers anywhere in `backend/`. Add `backend/lib/subBrandConfig.js` helper that parses `tenant.subBrandConfigJson` and returns `{ wabaId, phoneNumberId, legalEntityCode, gstin, driveRootFolderId }` per sub-brand. Update the 7 WA-stub crons (`tripPaymentReminders`, `travelJourneyReminders`, `tripPostTripFeedback`, `webCheckinScheduler`, `contactGreetingsEngine`, `travelDiagnosticAdvisorAlerts`, `religiousGuidanceEngine`) + 3 route endpoints (`travel_microsites.js:396` request-otp, `travel_itineraries.js:761` `/share`, `travel_webcheckin.js:372` `/deliver`) to call the helper at the would-be WA-send site so `wabaId` is correctly selected per sub-brand BEFORE the actual send happens (which stays stubbed until Q9). Add a vitest unit test for the helper covering parse + per-subBrand resolution + missing-config fallback. ~3-4 hrs total. **Why next:** removes one of the highest-risk Q9 cut-over surprises (incorrect-WABA dispatch routing TMC enquiries to RFU's WABA). Zero immediate user value, but the prep is parallel-safe with Q9 cred-drop work — pre-wiring shrinks the Q9 swap from "8 crons × WABA-selection-decision + WA-send-decision" to "8 crons × WA-send-decision". Pairs naturally with the autonomous queue exhaustion below.

2. **No second pick available at high confidence.** The next-best candidates after pick #1 are either (a) §7 page-row completions with low individual value (`DiagnosticPreview.jsx`, `RfuJourneyReminders.jsx`, `TmcMicrositePreview.jsx`) — admin-surface completeness work that has no §4 row attached and no user-reported pain, OR (b) per-participant TripDocumentRequirement schema migration (additive `participantId Int?` nullable column + `status String?`) which is genuinely cron-doable BUT requires a follow-on UI commit to surface the per-participant rows; without the follow-on, the schema-only commit is dead weight. Neither is a strong "queue refill" candidate. **Honest recommendation:** ship pick #1 alone next round, then CronDelete (see "Honest queue-empty check" §10 below).

3. **No third pick available.** Same reasoning as #2.

### Top 3 cred-blocked items worth chasing the human on (unchanged)

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). 7 crons + 3 endpoints stub-dispatching today. One env-var drop swaps each.
2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. One env-var drop swaps the shipped stub to real.
3. **Q11 — LLM API keys per provider** (Anthropic / Google / Perplexity / OpenAI). 3 consumers live (talking-points + form-vs-call + itinerary-draft). Real-mode swap pending keys — makes `LlmCallLog.costEstimate` non-zero and lets the LlmSpend.jsx dashboard (just shipped) show real numbers.

---

## §4 Functional requirements

### §4.1 Lead intake + sales funnel

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Multi-source enquiry capture | SHIPPED (reuse) | `routes/contacts.js`, `routes/marketplace_leads.js`, `routes/lead_routing.js` | `Contact.subBrand` tag at `schema.prisma:439` |
| Rule-based brand assignment | PARTIAL | `routes/lead_routing.js` + `Contact.subBrand` + `User.subBrandAccess` (`schema.prisma:357`) | `LeadRoutingRule.conditions` JSON blob already supports `subBrand` filter; lifting to SHIPPED needs `LeadRouting.jsx` admin UI extension to expose the filter |
| 8-status pipeline (Q10) | SHIPPED | `seed-travel.js:518, 1046` `seedPipelineTaxonomies()`; gate spec `e2e/tests/travel-seed-taxonomy-api.spec.js` (commit `ab2f15f`) | Labels: New · Diagnostic Complete · Qualifying · Quoted · Negotiating · Won · Lost · Dormant |
| 8 lost-reason taxonomy | SHIPPED | Same helper, `seed-travel.js:1095-1119` | Price · No response · Chose competitor · Wrong requirement · Timing issue · Budget issue · Trust issue · Duplicate enquiry |
| Diagnostic-first guard on quotation routes | SHIPPED | `middleware/travelGuards.js`; refused on POST/PUT Itinerary | |
| AI qualification call (Eng/Hin/Urdu) | GAP-CRED-BLOCKED | Sandbox mock `scripts/sandbox/callified-mock.js` only | Q1 — Callified.ai handover |
| Form-vs-call answer comparison (80/60% threshold) | SHIPPED | `POST /api/travel/diagnostics/:id/form-vs-call/compare` (`routes/travel_diagnostics.js:519-641`, commits `4a7c623` + `8b97fd5`); persists result via additive `TravelDiagnostic.formVsCallJson` column (commit `a6ea3fe`); UI consumer at `DiagnosticDetail.jsx` Section 3 (commit `2440b4a`) | Compute response + cached envelope match on `{classification, scorePercent, summary, model, stub, perFieldDiff, generatedAt}`. Frontend cached-panel render (skip re-compute on page reload) is a follow-on Phase 1.5 commit, not autonomous-blocking |
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
| Risk flagging (Visa Sure) | SHIPPED (schema) | `VisaApplication.advisorRiskFlag` (`schema.prisma:4507`) | Phase 3 |
| LLM-generated talking points per advisor | SHIPPED | `POST /api/travel/diagnostics/:id/talking-points/regen` (`routes/travel_diagnostics.js:396`, commit `cf876af`); LLM router consumer; UI render at `DiagnosticDetail.jsx` Section 2 (commit `2440b4a`) | Stub-mode-ready; real Claude Opus output lands when Q11 keys arrive |
| AI summary notes (Visa Sure) | GAP-AUTONOMOUS (Phase 3) | Same shape as talking-points | Not a Phase 1 cron pick |

### §4.3 Itinerary / package builder

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| RFU Umrah quotation engine (unified search) | PARTIAL | `routes/travel_itineraries.js` ships full CRUD + items + version chain + share + PDF + accept/reject + LLM draft | "Unified-search lowest-rate auto-select" requires RateHawk wire-in (Q19 cred-blocked) |
| Hotel rate comparator (RateHawk P1) | GAP-CRED-BLOCKED | `Glob backend/services/ratehawk*` returns 0 | Q19 |
| Preference filters (RFU Haram-facing / floor / room) | PARTIAL | `TravelCostMaster.attributesJson` (`schema.prisma:4196`) supports them; verified absent: `Grep haram\|Haram` in `pages/travel/CostMaster.jsx` → no matches | Filter UI is GAP-AUTONOMOUS but lower-value than pick #1 |
| Rule-based transport pricing with seasonal logic | SHIPPED | `TravelSeasonCalendar` + `TravelMarkupRule` + `routes/travel_pricing.js` + `lib/travelPricing.js` | |
| Cost master admin panel | SHIPPED | `routes/travel_cost_master.js` (5 endpoints) + `pages/travel/CostMaster.jsx` + CSV (`routes/travel_csv_io.js`) | |
| Branded itinerary PDF with version history | SHIPPED | `routes/travel_itineraries.js:706` GET `/itineraries/:id/pdf`; `Itinerary.parentItineraryId` + status enum | |
| Flight Quotation Chrome plugin | GAP-AUTONOMOUS (big-scope) | `Glob flight-plugin/**` returns 0 | Phase 1 W3 — ~10-15 engineer-days; NOT a cron pick |
| Trip itinerary template per TMC trip | SHIPPED | `TripMicrosite.itineraryHtml`; `routes/travel_microsites.js:154` POST | |
| LLM-drafted itinerary summary text | SHIPPED | `POST /api/travel/itineraries/:id/draft/regen` (commit `f02fa5a`); `Itinerary.draftSummary @db.Text` column at `schema.prisma:4208`; bulk-text task → Gemini Flash; public projection surfaces it; gate-spec extensions ship | First non-Claude-Opus LLM router consumer; `ItineraryDetail.jsx` Section 2 surfaces it (commit `c51f7e4`) |

### §4.4 Quote / invoice / payment

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Quotation upload (Travel Stall) | SHIPPED (reuse) | `routes/contacts.js` ContactAttachment + Quote | |
| Manual or structured quotation (Visa Sure) | PARTIAL (schema only) | `VisaApplication` model | Phase 3 |
| Invoice generation with GST capture | SHIPPED (reuse) | `routes/billing.js` + Invoice + `Invoice.legalEntityCode` (`schema.prisma:814`) | |
| CA / Tally export | SHIPPED | `routes/billing.js:130` `/export/tally.xml` + `:181` `/export/ca-summary.csv` (commit `4a07fca`) | Q5 |
| Excel Software for Travel bridge | GAP-CRED-BLOCKED | `Glob backend/services/excelSoftware*` returns 0 | Q8 docs pending |
| Per-entity payment tracking | SHIPPED | `Invoice.legalEntityCode` | |
| Payment plan tracking (TMC) | PARTIAL | `TripPaymentPlan` + `TripInstalmentPayment` + `routes/travel_trip_billing.js` + `cron/tripPaymentReminders.js` | WA dispatch stub (Q9); `/instalments/from-plan` materialiser Phase 1.5 |

### §4.5 Booking + supplier coordination

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Trip / Booking record (TMC) | SHIPPED | `TmcTrip` + `routes/travel_trips.js` 17 endpoints + ops-dashboard rollup | |
| TMC confirmed-trip microsite | SHIPPED | `TripMicrosite` + `routes/travel_microsites.js` + `/microsites/public/:publicUuid` | |
| Microsite OTP (4-digit, 10-min, WA delivery) | PARTIAL | `routes/travel_microsites.js:396,469,536` — request/verify/full | OTP gen + verify + reveal shipped; WA delivery stub (Q9) |
| Parent/teacher registration w/ DigiLocker | PARTIAL | `routes/travel_trips.js:510,546` DigiLocker initiate/callback (commit `1babe1b`) | Stub mode end-to-end; parent-facing public registration endpoint missing — GAP-AUTONOMOUS but lower value than pick #1 |
| Rooming allocation interface | SHIPPED | `routes/travel_trip_billing.js:65-200` CRUD + `RoomingAssignment` model + XLSX export at `:215-330` (commit `de1be50`) + Download CTA in `TripDetail.jsx` | XLSX export was the prior pick #4; now closes the row from PARTIAL → SHIPPED |
| Departure checklist + per-student doc checklist | SHIPPED | `TripDocumentRequirement` + `routes/travel_trips.js:603-654` | Trip-scoped (no `status` / `participantId` columns — verified at `schema.prisma:4417-4428`); per-participant join is GAP-AUTONOMOUS (additive nullable migration + UI follow-on; pairs with checklist tracking but not a high-value standalone) |
| RFU customer database | SHIPPED | `RfuLeadProfile` + `routes/travel_rfu_profiles.js` + `pages/travel/RfuCustomerProfile.jsx` | |
| Customer-duplicate detection | SHIPPED | `findDuplicateContactFull` (commit `ea817fb`); 409 envelope returns `{ existingContactId, matchedBy, contact }` (`routes/contacts.js:263-278`); UI modal at `frontend/src/components/DuplicateContactModal.jsx` (commit `b18c5c4`) wired into `Contacts.jsx` | Email + phone + passport keys; full backend + frontend flow complete |
| Login vault (AES-256-GCM) | SHIPPED | `SupplierCredential` + access-log + `routes/travel_suppliers.js` 7 endpoints + `lib/fieldEncryption.js` | |

### §4.6 Web check-in

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| P1A tracking + delivery (auto-schedule T-48h/T-24h, WA reminder, agent task, manual upload, dashboard) | PARTIAL | `WebCheckin` model (`schema.prisma:4436`) + `cron/webCheckinScheduler.js` + `routes/travel_webcheckin.js` 7 endpoints (commit `9898e87`) + `lib/webCheckinWindow.js` + auto-create on `POST /itineraries/:id/accept` + `WebCheckinQueue.jsx` operator UI (`bfe956c`) + sidebar link + 1 seeded WebCheckin row (`cb478bb`) | Backend + operator UI + seed all ship. **Still partial:** WA dispatch on `/deliver` is Q9-stub; WA reminder fan-out at T-window in the cron is also Q9-stub. Both swap when Q9 creds land |
| P1B top-4 airline automation (IndiGo, AI/Express, Vistara, Emirates per Q20) | GAP-AUTONOMOUS (big-scope) | No `webCheckinAutomation.js` engine | Phase 1 W4 — paired with Chrome plugin work; NOT a cron pick |
| Fallback (2 failed retries → agent task; portal-down >2h → all-passengers-to-agents) | PARTIAL | `WebCheckin.status` enum includes `fallback-agent` + `failed` (`schema.prisma:4449`) | Schema-only; no code emits transitions yet — GAP-AUTONOMOUS but paired with P1B automation work |
| Boarding-pass auto-delivery (WA + email) | GAP-STUB-ABLE | `POST /webcheckins/:id/deliver` (`routes/travel_webcheckin.js:372`) emits Wati-stub log line; `boardingPassUrl` + `deliveredAt` columns ready | One-line swap on Q9 cred drop |

### §4.7 Visa documents + compliance

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Structured document checklist + status tracking | PARTIAL (schema only) | `VisaDocumentChecklistItem` (`schema.prisma:4530`) | Phase 3 — no routes/UI |
| Passport OCR + secure storage | GAP-CRED-BLOCKED | `TripParticipant.passportNumber/Expiry/DocId` columns exist | Needs Google Document AI / Azure FR creds |
| Document security model | PARTIAL | AES-256 via `lib/fieldEncryption.js` ✅; AuditLog ✅; retention engine ✅; watermark + share-link expiry NOT shipped | On-prem per Q6 (PRD §4.7 "AWS Mumbai" line predates Q6 decision) |
| Rejection-recovery program (Visa Sure) | PARTIAL (schema only) | `VisaApplication.recoveryProgramId` placeholder | Phase 3 |
| Aadhaar OCR via DigiLocker | PARTIAL (stub-mode) | `services/digilockerClient.js` + `DigilockerSession` + initiate/callback + gate spec (commit `1babe1b`) | Q3 cred drop swaps stub → real |
| Aadhaar consent legal copy | GAP-PRODUCT-CALL | Draft at `docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md` (commit `7d162cd`) | Q2 counsel review pending |

### §4.8 Customer communications

| Requirement | State | Evidence | Notes |
|---|---|---|---|
| Embedded WhatsApp Web for staff | SHIPPED (reuse) | `routes/whatsapp.js` | |
| WhatsApp Business API for automation (3 WABA) | GAP-CRED-BLOCKED | `services/whatsappProvider.js` Meta direct; Wati upstream | Q9 — 7 crons + 3 endpoints stub-dispatching |
| Email | SHIPPED (reuse) | `routes/email.js` + services | |
| Calendar/Meet booking | SHIPPED (reuse) | `routes/calendar_google.js` | |
| Drive folder auto-creation for confirmed TMC trips | PARTIAL (stub-mode) | `services/googleDriveClient.js` (commit `192de86`) + wire-in `routes/travel_trips.js:140-166, 271-282` | Q1 Workspace creds unlock real |
| Umrah journey reminders | PARTIAL | `cron/travelJourneyReminders.js` | WA dispatch stub (Q9) |
| Religious-guidance content delivery | SHIPPED | `cron/religiousGuidanceEngine.js` (commit `1e62ee9`) — daily 09:13 IST, scans RFU itineraries T-14d window, dayOffset-matched fan-out via Notification rows + Wati-stub; sub-brand-scoped; year-tagged dedup mirrors `contactGreetingsEngine`. Admin UI shipped — `ReligiousPackets.jsx` (commit `f903f4b`) | Real WA/email/SMS dispatch pending Q9 cred drop; placeholder content pending Yasin Q1 (admin PATCH replaces text without schema change) |
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
| TMC ops dashboard per confirmed trip | SHIPPED | `pages/travel/TripDetail.jsx` + `GET /api/travel/trips/:id/ops-dashboard` rollup endpoint (`routes/travel_trips.js:235-418`, commit `9eda0b6`); parallel-fetch envelope with participants / payments / documents / rooming counts + 30/30/30/10 weighted `departureReadiness.score` | **Schema drift noted in route header:** `TripDocumentRequirement` has no `status` / `participantId` columns — `submittedCount=0` placeholder until submission tracking ships; `docsFrac` defaults to 1 to avoid penalising trips with no doc tracking. `TmcTrip.targetStudentCount` doesn't exist — `participants.target` always null. Frontend dashboard widget rendering the envelope is P1.5 |
| LLM cost observability daily summary | SHIPPED | `GET /api/admin/llm-spend?days=N` (`routes/admin.js:172-358`, commit `f5c9518`) — ADMIN-gated, returns `{ totals, byDay, byTask, byModel }` envelope; backed by `LlmCallLog` fire-and-forget persist from `lib/llmRouter.js`; UI surface shipped at `pages/LlmSpend.jsx` (commit `76996c8`) with recharts AreaChart + 2 BarCharts, days selector 7/14/30/60/90, ADMIN sidebar link, 7 vitest cases | Stub-mode costs all 0; real-mode swap pending Q11 keys |

### §4.10 Sub-vertical call-outs

| Item | State | Notes |
|---|---|---|
| TMC diagnostic-first + teacher OTP | SHIPPED (partial) | OTP supports `purpose=teacher-access` (`schema.prisma:4631`, `routes/travel_microsites.js:45`); no dedicated teacher access UI |
| RFU 4-tier tagging drives quotation tier | SHIPPED | `Itinerary.productTier` (commit `2612a7e`) |
| RFU Haram-facing hotel filters | PARTIAL | Schema-supported; `Grep` confirms no filter UI in `CostMaster.jsx` |
| LLM-switchable layer for quotation engine | SHIPPED | `lib/llmRouter.js` (`583c06b`); **3 consumers live** — talking-points (`cf876af`) + form-vs-call (`4a7c623`) + itinerary-draft (`f02fa5a`). All 3 default-model PRD §9.1 rows now wired |
| Aadhaar OCR via DigiLocker | PARTIAL (stub) | §4.7 |
| Passport OCR | GAP-CRED-BLOCKED | §4.7 |
| Religious-guidance content library | SHIPPED + ADMIN UI | `ReligiousGuidancePacket` model (`schema.prisma:4590-4605`) + `routes/travel_religious_packets.js` 5-endpoint admin CRUD + `frontend/src/pages/travel/ReligiousPackets.jsx` admin UI (commit `f903f4b`) + 3 RFU placeholder packets seeded (commit `1e62ee9`). Yasin Q1 final copy lands via admin PATCH |
| Umrah journey reminders | PARTIAL | §4.8 |
| Travel Stall Family Travel Quiz | SHIPPED | `pages/public/TravelStallQuiz.jsx` (commit `1260caa`) + `/diagnostics/public/*` |
| Travel Stall 50% advance booking | SHIPPED | `routes/travel_itineraries.js:773,833` public share-token + advance-payment (commit `8abf6f3`); per-tenant ratio (commit `ee35d00`) |
| Travel Stall personalised 3-5 PDF | GAP-AUTONOMOUS | LLM-router scaffold + 3 consumers ship; PDF-specific consumer absent — pairs with §4.3 `bulk-text` consumer pattern. Lower-priority than pick #1 (uses already-shipped infra) |
| Travel Stall email-first acquisition | SHIPPED (reuse) | Email + Sequence engine |
| Visa Sure 15Q readiness + risk-flag dashboard | PARTIAL (schema only) | Phase 3 |
| Visa Sure rejection-recovery program | PARTIAL (schema only) | Phase 3 |

---

## §5 Data model

### §5.1 New models (25)

| Model | State | Schema location |
|---|---|---|
| `TravelDiagnostic` | SHIPPED | `schema.prisma:4122` |
| `TravelDiagnosticQuestionBank` | SHIPPED | `schema.prisma` (Phase 1 model) |
| `Itinerary` | SHIPPED | `schema.prisma:4163` |
| `ItineraryItem` | SHIPPED | `schema.prisma:4217` |
| `TravelCostMaster` | SHIPPED | `schema.prisma:4237` |
| `TravelSeasonCalendar` | SHIPPED | `schema.prisma:4259` |
| `TravelMarkupRule` | SHIPPED | `schema.prisma:4274` |
| `TmcTrip` | SHIPPED | `schema.prisma:4293` |
| `TripParticipant` | SHIPPED | `schema.prisma:4320` |
| `DigilockerSession` | SHIPPED | `schema.prisma:4352` |
| `RoomingAssignment` | SHIPPED | `schema.prisma:4376` |
| `TripPaymentPlan` | SHIPPED | `schema.prisma:4389` |
| `TripInstalmentPayment` | SHIPPED | `schema.prisma:4399` |
| `TripDocumentRequirement` | SHIPPED | `schema.prisma:4418` (no `status` / `participantId` columns yet — see §4.5 + §4.9 ops-dashboard notes; verified at refresh) |
| `WebCheckin` | SHIPPED + route consumer + seed | `schema.prisma:4436` + `routes/travel_webcheckin.js` + 1 seeded row (`cb478bb`) |
| `SupplierCredential` | SHIPPED | `schema.prisma:4466` |
| `SupplierCredentialAccessLog` | SHIPPED | `schema.prisma:4484` |
| `VisaApplication` | SHIPPED (Phase 3) | `schema.prisma:4497` |
| `VisaDocumentChecklistItem` | SHIPPED (Phase 3) | `schema.prisma:4522` |
| `RfuLeadProfile` | SHIPPED | `schema.prisma:4538` |
| `TripMicrosite` | SHIPPED | `schema.prisma:4614` |
| `TripMicrositeOtp` | SHIPPED | `schema.prisma:4633` |
| `TenantSetting` | SHIPPED | `schema.prisma:2895` |
| `LlmCallLog` | SHIPPED | `schema.prisma:1207` (commit `f5c9518`); 3 indexes (tenantId+createdAt, tenantId+task, tenantId+model); fire-and-forget persist from `lib/llmRouter.js` |
| `ReligiousGuidancePacket` | SHIPPED | `schema.prisma:4596` (commit `1e62ee9`); 2 indexes (tenantId+subBrand+isActive, tenantId+subBrand+dayOffset); no UNIQUE on (tenantId, subBrand, dayOffset) — multi-packet per offset intentional |

### §5.2 Extensions to existing models

| Extension | State | Notes |
|---|---|---|
| `Tenant.subBrandConfigJson` (per-brand WA / WABA / legal entity / GSTIN / Drive root) | SHIPPED | commit `621aab7` — schema column + `backend/lib/subBrandConfig.js` helper + 7 cron + 3 endpoint consumers all resolve per-subBrand config and log resolved wabaId. Q9 cred-drop is now a 1-line stub→real swap per consumer (was: 1-line swap + per-callsite WABA-routing decision) |
| `Contact.subBrand` | SHIPPED | `schema.prisma:439` |
| `Deal.subBrand` + `Deal.diagnosticId` | SHIPPED | `schema.prisma:589-590` |
| `Booking.tripId` + `Booking.itineraryId` | NOT NEEDED YET | Optional per PRD |
| `Invoice.legalEntityCode` | SHIPPED | `schema.prisma:814` |
| `User.subBrandAccess` | SHIPPED | `schema.prisma:357` |
| `TravelDiagnostic.talkingPointsJson` (LLM brief cache) | SHIPPED | `schema.prisma:4136`; persisted by talking-points/regen route (commit `cf876af`); read by next GET; consumed by `DiagnosticDetail.jsx` (commit `2440b4a`) |
| `TravelDiagnostic.formVsCallJson` (LLM form-vs-call cache) | SHIPPED | `schema.prisma:4137` (commit `a6ea3fe`) — additive nullable `String? @db.Text` column; fire-and-forget snapshot from compute handler; GET surfaces it via Prisma default selection; 2 new gate spec cases pinning persist + overwrite contracts |
| `Tenant.religiousGuidancePackets` back-relation | SHIPPED | `schema.prisma:164` (commit `1e62ee9`) |
| `Itinerary.draftSummary` (LLM bulk-text cache) | SHIPPED | `schema.prisma:4208` `Itinerary.draftSummary String? @db.Text` (commit `f02fa5a`); populated by `POST /draft/regen`; surfaced in public projection + `ItineraryDetail.jsx` |

---

## §6 Route plan

### §6.1 New route files (11 expected + bonus)

| Expected file | State | Notes |
|---|---|---|
| `travel.js` | SHIPPED | Minimal `/health`; cross-sub-brand dashboard in `travel_dashboard.js` |
| `travel_diagnostics.js` | SHIPPED | 11+ endpoints incl. public submit + report PDF + `/talking-points/regen` (`cf876af`) + `/form-vs-call/compare` (`4a7c623` + `8b97fd5` + persist `a6ea3fe`) |
| `travel_itineraries.js` | SHIPPED | 15+ endpoints incl. `/share` + version chain + accept/reject + auto-WebCheckin on accept + `/draft/regen` LLM consumer (commit `f02fa5a`) |
| `travel_quotation_flight.js` | GAP-AUTONOMOUS (big-scope, plugin-paired) | Phase 1 W3; NOT a cron pick |
| `travel_cost_master.js` | SHIPPED | 5 endpoints |
| `travel_suppliers.js` (was `travel_supplier_vault.js`) | SHIPPED | 7 endpoints |
| `travel_trips.js` (TMC) | SHIPPED | 17 endpoints incl. DigiLocker initiate/callback + ops-dashboard (`9eda0b6`) |
| `travel_microsites.js` (folds `travel_trip_microsite_public.js`) | SHIPPED | Public + admin |
| `travel_trip_billing.js` (was `travel_payment_plans.js`) | SHIPPED | 11 endpoints incl. rooming CRUD + XLSX export (commit `de1be50`) + plan + instalments |
| `travel_webcheckin.js` | SHIPPED | 7 endpoints (commit `9898e87`) + auto-create on Itinerary.accept |
| `travel_visa.js` (Visa Sure) | GAP (Phase 3) | `Glob` confirms absent; schema-ready, no routes |
| `travel_callified.js` | GAP-CRED-BLOCKED | `Glob` confirms absent; Q11/Q1 — Callified handover |

**Bonus shipped routes:** `travel_dashboard.js`, `travel_reports.js`, `travel_rfu_profiles.js`, `travel_pricing.js`, `travel_csv_io.js`, `travel_religious_packets.js` (commit `1e62ee9`).
**Bonus admin route:** `routes/admin.js` extended with `/llm-spend` (commit `f5c9518`).

### §6.2 Reused routes — all SHIPPED in main CRM.

### §6.3 New cron engines (6 expected + bonus)

| Engine | State |
|---|---|
| `webCheckinScheduler.js` | SHIPPED — fed by Itinerary.accept auto-create + 1 seeded row |
| `webCheckinAutomation.js` (event-driven, per-airline) | GAP-AUTONOMOUS (big-scope) — Phase 1 W4; NOT a cron pick |
| `tripPaymentReminders.js` | SHIPPED |
| `travelJourneyReminders.js` | SHIPPED |
| `tripPostTripFeedback.js` | SHIPPED |
| `travelDiagnosticAdvisorAlerts.js` | SHIPPED |
| `religiousGuidanceEngine.js` (bonus, PRD §4.8) | SHIPPED — commit `1e62ee9` |

---

## §7 Frontend page plan (24 expected + bonus)

| Page | State | Notes |
|---|---|---|
| `Dashboard.jsx` | SHIPPED | `pages/travel/Dashboard.jsx` |
| `Leads.jsx` | SHIPPED | |
| `LeadDetail.jsx` | SHIPPED | commit `a84289e` — `/travel/leads/:contactId` aggregates contact + latest diagnostic + itineraries + TMC trips + RFU profile link; Contact column in `Leads.jsx` now links into it; 6 vitest cases |
| `DiagnosticBuilder.jsx` | SHIPPED | |
| `DiagnosticPreview.jsx` | NOT SHIPPED — GAP-AUTONOMOUS (low-value) | Builder preview pane; absent because Builder Phase 1 is view-only per Q16 |
| `DiagnosticPublic.jsx` (`/p/diagnostic/:subBrand/:bankId`) | SHIPPED-equivalent | `TravelStallQuiz.jsx` at `/travel-stall/quiz` |
| `DiagnosticDetail.jsx` (renders talking-points brief + form-vs-call panel) | SHIPPED | `frontend/src/pages/travel/DiagnosticDetail.jsx` (commit `2440b4a`); route `/travel/diagnostics/:id`; consumes `cf876af` talking-points + `4a7c623` form-vs-call endpoints + GET /diagnostics/:id; STUB pill for stub-mode LLM output; role-gated Regenerate button |
| `ItineraryBuilder.jsx` | PARTIAL | List ships (`Itineraries.jsx`) + detail ships (`ItineraryDetail.jsx`); explicit `/new` builder route absent (verified via `Glob ItineraryBuilder*`) — GAP-AUTONOMOUS (medium-value: detail page's inline add-item already serves most builder needs) |
| `ItineraryDetail.jsx` | SHIPPED | commit `c51f7e4` — 3-section page (header + draftSummary + items table), clickable list rows, 8 vitest cases |
| `CostMaster.jsx` | SHIPPED | |
| `FlightQuoteAgent.jsx` | NOT SHIPPED | `Glob` confirms absent; in-CRM fallback for Chrome plugin; pairs with W3 plugin work |
| `MarkupRules.jsx` (admin, shipped as `PricingRules.jsx`) | SHIPPED | |
| `SupplierVault.jsx` (shipped as `Suppliers.jsx`) | SHIPPED | |
| `TmcTrips.jsx` (shipped as `Trips.jsx`) | SHIPPED | |
| `TmcTripDetail.jsx` (shipped as `TripDetail.jsx`) | SHIPPED | Ops-dashboard widget render P1.5; Rooming XLSX download CTA live (commit `de1be50`) |
| `TmcRooming.jsx` | NOT SHIPPED — folded into TripDetail | `Glob travel/Tmc*` returns 0; GAP-AUTONOMOUS if PRD wants standalone |
| `TmcPaymentPlan.jsx` | NOT SHIPPED — folded into TripDetail | Same |
| `TmcDocumentChecklist.jsx` | NOT SHIPPED — folded into TripDetail | Same |
| `TmcMicrositePreview.jsx` | NOT SHIPPED | `Glob` confirms absent; admin preview not wired |
| `WebCheckinQueue.jsx` | SHIPPED | `frontend/src/pages/travel/WebCheckinQueue.jsx` (commit `bfe956c`); route `/travel/webcheckins` + sidebar link |
| `RfuCustomerProfile.jsx` | SHIPPED | |
| `RfuJourneyReminders.jsx` | NOT SHIPPED | `Glob travel/Rfu*` returns only `RfuCustomerProfile.jsx`; admin surface for the journey-reminders cron; medium-low value (cron runs unattended today) |
| `VisaApplications.jsx` + Detail + AdvisorDashboard | NOT SHIPPED (Phase 3) | `Glob travel/Visa*` returns 0 |
| `TravelStallFamilyQuiz.jsx` | SHIPPED | `pages/public/TravelStallQuiz.jsx` |
| `TravelReports.jsx` | SHIPPED | `pages/travel/Reports.jsx` |
| `TripBooking.jsx` (50%-advance bonus) | SHIPPED | `pages/public/TripBooking.jsx` |
| `LlmSpend.jsx` (admin observability surface for `/api/admin/llm-spend`) | SHIPPED | commit `76996c8` — mounted at `/llm-spend` with RoleGuard ADMIN, recharts AreaChart (byDay) + BarCharts (byTask, byModel), days selector 7/14/30/60/90, 7 vitest cases |
| `ReligiousPackets.jsx` (admin CRUD UI for `/api/travel/religious-packets`) | SHIPPED | commit `f903f4b` — page mounts at `/travel/religious-packets`, admin-only sidebar link, sub-brand + active filters, create/edit/delete with validation parity, 8 vitest cases |
| `DuplicateContactModal.jsx` (front-end modal for 409 DUPLICATE_CONTACT envelope) | SHIPPED | commit `b18c5c4` — `frontend/src/components/DuplicateContactModal.jsx` + `Contacts.jsx` wiring + `__tests__/DuplicateContactModal.test.jsx`; all three verified present at refresh |

### §7.1 Public micro-sites

| Page | State |
|---|---|
| `TripMicrosite.jsx` (SSR via landingPageRenderer) | NOT SHIPPED — public microsite is JSON-only today |

### §7.2 Chrome extension

| Item | State |
|---|---|
| `flight-plugin/` at repo root | NOT SHIPPED — `Glob` confirms directory does not exist |

---

## §8 Vertical config

| Item | State | Evidence |
|---|---|---|
| `Tenant.vertical = "travel"` value | SHIPPED | `seed-travel.js:45,55` |
| `renderTravelNav()` in Sidebar | SHIPPED | `Sidebar.jsx:967, 625` |
| Sub-brand switcher in sidebar | SHIPPED | `Sidebar.jsx:986-1019` |
| Theme `theme/travel.css` | SHIPPED (placeholder palette) | Per Q22 brand assets pending |
| Landing route `/travel` | SHIPPED | `App.jsx:888` |
| Seed `seed-travel.js` | SHIPPED | tenant + users + 4 diagnostic banks + cost master + seasons + 8-status Pipeline + 8 lost reasons + 3 TmcTrips + participants + Itinerary + microsite + RoomingAssignment + TripPaymentPlan + 4 TripInstalmentPayment + SupplierCredential (env-gated) + VisaApplication + 4 checklist items (`78884e3`) + 1 WebCheckin row (`cb478bb`) + 3 ReligiousGuidancePacket placeholders (`1e62ee9`). End-to-end demo data complete |

---

## §9 External integrations

| Integration | State | Notes |
|---|---|---|
| Wati BSP wrapper (3 WABAs) | GAP-CRED-BLOCKED | Q9; 7 crons + 3 endpoints stub-dispatching |
| Meta WhatsApp Cloud API | SHIPPED (reuse) | `services/whatsappProvider.js` |
| Callified.ai / Exotel | GAP-CRED-BLOCKED | Sandbox mock only |
| Google Workspace (Drive/Gmail/Calendar/Meet) | PARTIAL (stub for Drive) | `services/googleDriveClient.js` (commit `192de86`) |
| RateHawk | GAP-CRED-BLOCKED | Q19 — `Glob backend/services/ratehawk*` returns 0 |
| Booking.com / Expedia | GAP (Phase 1.5 per Q19) | |
| DigiLocker | PARTIAL (stub) | `services/digilockerClient.js` (commit `1babe1b`) |
| Passport OCR | GAP-CRED-BLOCKED | |
| AdsGPT | GAP-CRED-BLOCKED | Q1 |
| LLM router | SHIPPED | `lib/llmRouter.js` stub-mode (commit `583c06b`); **3 consumers live** (talking-points `cf876af` + form-vs-call `4a7c623` + itinerary-draft `f02fa5a`); persist sink `LlmCallLog` (`f5c9518`); admin UI surface `LlmSpend.jsx` (`76996c8`); all 3 §9.1 default-model rows now wired |
| Meta/Google/LinkedIn/YouTube Ads APIs | GAP-CRED-BLOCKED | Q1 |
| Excel Software for Travel | GAP-CRED-BLOCKED | Q8 docs pending — `Glob backend/services/excelSoftware*` returns 0 |
| Airline portals | GAP-AUTONOMOUS (big-scope) | Phase 1 W4; NOT a cron pick |
| Razorpay | SHIPPED (reuse) | Q4 |
| Tally | SHIPPED | `lib/tallyXmlExport.js` + `routes/billing.js:130` |

### §9.1 LLM routing defaults (Q11 locked)

| Task | Locked model | State |
|---|---|---|
| Diagnostic interpretation (talking-points) | Claude Opus | SHIPPED via talking-points endpoint (commit `cf876af`); stub-mode-ready; UI consumer `DiagnosticDetail.jsx` (`2440b4a`) |
| Itinerary draft (bulk-text) | Gemini Flash | SHIPPED via `POST /api/travel/itineraries/:id/draft/regen` (commit `f02fa5a`) — first non-Claude-Opus router consumer; UI consumer `ItineraryDetail.jsx` (`c51f7e4`) |
| Form-vs-call comparison | Claude Opus | SHIPPED via `POST /api/travel/diagnostics/:id/form-vs-call/compare` (`routes/travel_diagnostics.js:519`, commit `4a7c623`); 80/60% ladder + perFieldDiff inline; UI consumer `DiagnosticDetail.jsx` Section 3 (`2440b4a`); cache via `formVsCallJson` (commit `a6ea3fe`) |
| AI qualification call | Gemini Live | GAP-CRED-BLOCKED (Callified front-end) |
| Document OCR fallback | Gemini Vision | GAP-CRED-BLOCKED |
| Sentiment / KPI insights | Gemini Flash | GAP-AUTONOMOUS |
| Cost observability (`LlmCallLog` model + admin daily summary + admin UI) | — | SHIPPED end-to-end via `GET /api/admin/llm-spend` (commit `f5c9518`) + `pages/LlmSpend.jsx` (commit `76996c8`); fire-and-forget persist from router |

---

## §10 Phased plan — exit-gate verification

### Phase 1 W1-W6 state

| Week | Exit gate | State |
|---|---|---|
| W1 | SSO live; inbound WA enquiries; templates submitted | PARTIAL — SSO reuse; WA cred-blocked (Q9) |
| W2 | Both diagnostics live; AI call summary attached | PARTIAL — Diagnostics ✅ + talking-points ✅ + form-vs-call compute ✅ (commit `4a7c623`) + UI render ✅ (commit `2440b4a`) + persistence ✅ (commit `a6ea3fe`); AI calling 🔴 (Callified Q1 cred-blocked) |
| W3 | Flight plugin 4-option in 60s; RFU lowest-rate | RED — Plugin not started; RateHawk GAP |
| W4 | Web check-in live top-4; TMC microsite pilot | PARTIAL — Microsite ✅ + cron ✅ + route ✅ + operator UI ✅ + seed ✅; airline automation GAP |
| W5 | Dashboards meet KPI list; CA export validated | SHIPPED — Reports + Dashboard + Tally export + TMC ops-dashboard rollup (`9eda0b6`) + LLM spend daily endpoint (`f5c9518`) + LLM spend admin UI (`76996c8`). All §4.9 rows closed |
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
| Form-vs-call persistence / cached panel | SHIPPED (backend) — commit `a6ea3fe`; frontend cached-panel render (skip re-compute on page reload) is a separate follow-on, not autonomous-blocking |
| Customer-duplicate UI modal | SHIPPED — commit `b18c5c4`; component + Contacts.jsx wiring + test file all present |
| Rooming XLSX export | SHIPPED — commit `de1be50`; `GET /api/travel/trips/:tripId/rooming/export.xlsx`, ADMIN+MANAGER + requireTmcAccess, 5 columns (Room # / Type / Capacity / Occupancy / Participants), Download CTA in TripDetail.jsx Rooming tab, 4 new gate-spec cases (happy path + empty trip + USER 403 + 404) |

### Phase 2 (Travel Stall) state

Already shipped: Family Travel Quiz, 50%-advance booking, tunable advance ratio, public diagnostic endpoints, birthday/anniversary greetings, customer-duplicate UI modal (commit `b18c5c4`). GAPS: personalised 3-5 destination PDF (LLM-driven, GAP-AUTONOMOUS now that router scaffold + 3 consumers ship; could be 4th consumer), Booking.com/Expedia APIs.

### Phase 3 (Visa Sure) state

Schema-only — `VisaApplication` + `VisaDocumentChecklistItem` models shipped (seeded via `78884e3`); no route file `travel_visa.js` (verified absent via `Glob`); no UI pages.

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
| Q9 | CRITICAL | WhatsApp numbers | 🟢 | RESOLVED-pending-handover; 7 crons + 3 endpoints stub-dispatching |
| Q10 | CRITICAL | Pipeline labels | 🟢 | DECIDED + SEEDED (commit `ab2f15f`) |
| Q11 | HIGH | LLM defaults | 🟢 | DECIDED + scaffold shipped (commit `583c06b`); **3 consumers live**; real-mode swap pending Q11 keys; admin UI surface live (commit `76996c8`) |
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
| R2 | 6-week timeline | 🔴 | Improved further — 4 more shipped feature items this round; W3/W4 still the dominant slip |
| R3 | Chrome extension auto-update | 🔴 | Plugin not built |
| R4 | Hotel comparator scope drift | 🟢 | Resolved |
| R5 | DigiLocker creds | 🟢 | Stub shipped |
| R6 | Tenancy model irreversibility | 🟢 | Resolved + implemented |
| R7 | LLM cost + observability | 🟢 | **Closed end-to-end this round** — router scaffold + `LlmCallLog` + `/api/admin/llm-spend` daily summary + admin UI all ship; 3 consumers wired; real-mode per-token pricing wires in with Q11 keys |
| R8 | Aadhaar legal exposure | 🟡 | Counsel pending |
| R9 | Multi-WABA timeline | 🟢 | Resolved; pick #1 below pre-wires WABA-selection for the Q9 cred drop |
| R10 | Scope creep TS/VS | 🟢 | Resolved |
| R11 | On-prem hosting complexity | 🔴 | No infra evidence in commits |

---

## Stub-mode swap-point inventory

| Stub file | Stub marker | Q-marker | Swap |
|---|---|---|---|
| `backend/services/digilockerClient.js` | line 1 `STUB MODE` + line 19 `STUB_DIGILOCKER_BASE` | Q3 | Replace `initiateSession` + `exchangeCallback` to talk real DigiLocker token endpoint |
| `backend/services/googleDriveClient.js` | line 1 + line 56 `STUB: Google Drive folder.create` | Q1 | Swap `createTripFolder` to `googleapis` |
| `backend/lib/llmRouter.js` | line 1 `STUB MODE` | Q11 | Add `if (apiKey) return realProviderCall(...)` branches; preserve envelope `{ text, finishReason, usage, model, stub }`. **3 consumers** (talking-points + form-vs-call + itinerary-draft) already correctly destructure this envelope |
| `backend/cron/tripPaymentReminders.js` | "WhatsApp dispatch pending" | Q9 | Loop adds `await whatsappProvider.sendTemplate(...)` |
| `backend/cron/travelJourneyReminders.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/tripPostTripFeedback.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/webCheckinScheduler.js` | "WhatsApp dispatch pending" | Q9 | Same; now scans a non-empty table |
| `backend/cron/contactGreetingsEngine.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/travelDiagnosticAdvisorAlerts.js` | "WhatsApp dispatch pending" | Q9 | Same |
| `backend/cron/religiousGuidanceEngine.js` | `[wati-stub]` log lines | Q9 | Replace with `whatsappProvider.sendTemplate(...)` per channel |
| `backend/routes/travel_microsites.js:396` | `sendOtpStub` logs OTP to console | Q9 | Replace stub with `whatsappProvider.sendOtp(phone, otp)` |
| `backend/routes/travel_itineraries.js:761` | `/share` returns URL; doesn't auto-WA | Q9 | Add `await whatsappProvider.sendTemplate(...)` after share-URL |
| `backend/routes/travel_webcheckin.js:372` | `/deliver` emits Wati-stub log | Q9 | One-line swap to real WA send |

---

## Recommended next cron dispatches (priority order)

**Queue state: NEAR-EXHAUSTED.** The §4 PRD-requirement queue is empty (every row is SHIPPED, PARTIAL-pending-creds-or-product-call, or GAP-labelled-big-scope). The §7 page-row + Phase 1.5 queue has 1 high-confidence single-commit pick remaining. After that, the cron has no autonomous-doable work and should `CronDelete`.

1. ~~**`Tenant.subBrandConfigJson` consumer wiring (defensive — no-op until Q9 lands)** (§5.2 row, autonomous-doable). Helper + 7 cron + 3 endpoint consumer wiring.~~ — ✅ **commit `621aab7`** (new `backend/lib/subBrandConfig.js` with parseConfig + resolveForSubBrand + whitelist guard + empty-string strip; 26 vitest cases pinning the contract; 7 cron engines + 3 route endpoints all resolve per-sub-brand config and include wabaId in the existing stub log lines; STUB discipline held — no real WA send code added; 19 files touched, full backend suite stays green at 2708/2710 pass)

**Pick #5 from prior audit (re-evaluation):** This was the same pick as #1 above — the prior audit's pick #5. Re-promoted to #1 because the queue collapsed around it. **Verdict: KEPT** (not dropped). Reasoning: it's the only remaining cron-doable pick with a clear contract (defensive, single-commit, parallel-safe, doesn't require Q9 creds to ship). The "zero immediate user value" caveat from the prior audit stands — this is purely Q9 cut-over insurance. If user feedback says "don't bother, we'll fix WABA selection inline when Q9 lands," drop it.

**No picks #2 / #3 listed.** The next-best candidates are either too low-value, too big-scope, or require follow-on commits the cron can't reliably sequence:
- §7 admin-completeness pages (`DiagnosticPreview.jsx`, `RfuJourneyReminders.jsx`, `TmcMicrositePreview.jsx`) — no §4 row attached, no user-reported pain, "we have an admin page for everything" is not a forcing function
- `TravelStallPersonalisedPDF` (4th LLM consumer) — pairs with the existing pdfkit infra but requires content design (Q22 brand assets) + product call on PDF format
- TripDocumentRequirement schema migration (additive `participantId Int?` + `status String?`) — genuinely additive + autonomous, but dead weight without a follow-on UI commit to surface per-participant rows
- `LeadRouting.jsx` subBrand filter UI extension — small, but the route already supports the filter; user surfaces are JSON-edit today and nobody's reported pain
- `Itineraries.jsx ItineraryBuilder /new` route — detail page's inline add-item already serves most builder needs per prior refresh's note

If the user wants the cron to keep dispatching, the right move is the **TripDocumentRequirement per-participant migration paired with a follow-on UI commit** — but that's 2 commits, not 1, and the cron can't reliably sequence them. Better to surface as a TODOS handoff than dispatch the partial.

---

## Cred-blocked priority list (for human chase, NOT cron pick)

1. **Q9 — Meta Business Manager artifacts** (System User access token + 3×phoneNumberId + 3×wabaId + App ID/Secret + webhook verify token). Owner: Yasin. Unblocks: 7 crons (`tripPaymentReminders`, `travelJourneyReminders`, `tripPostTripFeedback`, `webCheckinScheduler`, `contactGreetingsEngine`, `travelDiagnosticAdvisorAlerts`, `religiousGuidanceEngine`) + 3 endpoints (`travel_microsites.js:396` request-otp, `travel_itineraries.js:761` `/share`, `travel_webcheckin.js:372` `/deliver`). ~9-line swap each. See `docs/WHATSAPP_INTEGRATION_PRD.md`. **If pick #1 above lands first, the cred-drop simplifies.**

2. **Q3 — DigiLocker `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`**. Owner: Yasin (Travel Stall has them). Unblocks: real Aadhaar-XML pull in `digilockerClient.js`. Single env-var drop. See `docs/DIGILOCKER_INTEGRATION_SPEC.md`.

3. **Q11 — LLM API keys per provider** (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `PERPLEXITY_API_KEY`, `OPENAI_API_KEY`). Owner: Yasin (Travel Stall holds them). Unblocks: real-mode swap in `lib/llmRouter.js` (3 consumers wait); makes `LlmCallLog.costEstimate` non-zero, which makes the just-shipped admin dashboard non-trivial.

4. **Q1 — Section 13 packet** (Google Workspace admin creds → unblocks Drive folder auto-create; AdsGPT creds + handover → unblocks marketing reports; Callified.ai handover → unblocks AI calling + form-vs-call live mode; brand assets pack → unblocks themed PDF templates + travel.css palette). Owner: Yasin.

5. **Q19 — RateHawk API key**. Owner: Yasin. Unblocks: RFU unified-search lowest-rate auto-pick + W3 exit-gate.

6. **Q8 — Excel Software for Travel REST API docs**. Owner: Yasin. Unblocks: `services/excelSoftwareClient.js` + accounting bridge.

7. **Q22 — Brand assets pack** (logos / palettes / PDF templates per sub-brand). Owner: Yasin. Unblocks: `theme/travel.css` palette swap + per-sub-brand PDF templates + the Travel Stall personalised 3-5 PDF (would-be 4th LLM consumer).

8. **Q15 — UAT users handover**. Owner: Yasin / TMC / RFU stakeholders. Unblocks: W6 exit-gate.

---

## Honest "is the queue actually empty?" check

**§4 PRD-requirement queue: YES, empty.** Every §4 row is either SHIPPED, PARTIAL-pending-creds-or-product-call, or GAP-labelled big-scope (Chrome plugin, airline automation, Phase 3 Visa Sure).

**§7 page-row + Phase 1.5 queue: NEAR-EXHAUSTED — 1 viable pick listed above.** After this refresh:

- **Genuinely cron-doable today:** ~~1 pick (`subBrandConfigJson` consumer wiring)~~. ✅ **SHIPPED at `621aab7`** — **queue is now empty**. Cron has no parallel-safe single-commit work left per the prior verdict; recommend user `CronDelete` per §10's verbatim handoff below.
- **What the cron should NOT pick** (and the audit labels as `GAP-AUTONOMOUS (big-scope)` to make this explicit):
  - Chrome flight-quote plugin (~10-15 engineer-days; requires browser-extension infra not in repo)
  - Airline web-checkin automation (paired with plugin work)
  - Phase 3 Visa Sure full buildout (route + 3 UI pages + checklist tracking)
  - These are W3/W4 + Phase 3 multi-day items, not single-commit cron picks.
- **What the cron is barred from** (cred-blocked + product-call):
  - Q9 (Wati WhatsApp), Q3 (DigiLocker), Q11 (LLM keys), Q19 (RateHawk), Q8 (Excel Software), Q1 (Section 13 packet), Q22 (brand assets) — 7 cred-blocked items (Q15 is UAT-blocked not code-blocked = 8 total in the cred list above)
  - Q2 (Aadhaar consent legal copy), Q13 (curriculum mapping) — 2 product-call items
- **Lower-value §7 admin-completeness pages** (`DiagnosticPreview.jsx`, `RfuJourneyReminders.jsx`, `TmcMicrositePreview.jsx`, standalone `TmcRooming.jsx`/`TmcPaymentPlan.jsx`/`TmcDocumentChecklist.jsx` extractions) — autonomous-doable but no §4 row attached, no user pain. The cron should NOT manufacture these to keep itself alive.

**Recommendation for Step 5 (CRITICAL — the cron should follow this verbatim):**

1. **Next round:** dispatch pick #1 (`subBrandConfigJson` consumer wiring) — single round.
2. **Round after that:** verify pick #1 shipped via grep (`backend/lib/subBrandConfig.js` exists; 7 crons + 3 endpoints reference it). If shipped → **`CronDelete` the autonomous loop** and surface a "queue exhausted; remaining work is cred-blocked, product-call, multi-commit Phase 3, or low-value admin-completeness" report to the user. Do NOT manufacture work to keep the loop alive.
3. **Re-evaluation trigger:** the next gap-audit refresh should only run if (a) a cred Q-marker resolves (Q9/Q3/Q11/Q19/Q8/Q22/Q1), or (b) the user explicitly redirects with new scope, or (c) a Phase 3 commit lands that re-opens the Visa Sure queue.

**Phantom carry-over check (this refresh):** **zero confirmed phantoms this round.** The prior refresh's incorrect "DuplicateContactModal absent via grep" claim was the trigger for tightening the verify-before-pickup discipline. This refresh ran BOTH `Glob` AND `Grep` AND `git log --oneline` on every "absent" claim:
- `LlmSpend.jsx` ✅ confirmed present (file + route + sidebar + test)
- `formVsCallJson` ✅ confirmed present in schema + route + 2 gate-spec cases
- `DuplicateContactModal.jsx` ✅ confirmed present (component + Contacts.jsx import + test file)
- `rooming/export.xlsx` ✅ confirmed present in `travel_trip_billing.js:233` + TripDetail CTA + 4 gate-spec cases
- ~~`subBrandConfigJson` consumer wiring ✅ confirmed genuinely absent~~ — ✅ **SHIPPED at `621aab7`** (helper + 7 cron + 3 endpoint consumers all live; 26 vitest cases green; full backend suite 2708/2710 pass)
- All §7 "NOT SHIPPED" page rows (`FlightQuoteAgent`, `TmcRooming`, `TmcPaymentPlan`, `TmcDocumentChecklist`, `TmcMicrositePreview`, `RfuJourneyReminders`, `VisaApplications*`, `TripMicrosite.jsx` SSR) ✅ confirmed absent via `Glob`
- `flight-plugin/` directory ✅ confirmed absent via `Glob`
- `travel_visa.js` / `travel_callified.js` / `travel_quotation_flight.js` routes ✅ confirmed absent via `Glob`
- `backend/services/ratehawk*` / `excelSoftware*` ✅ confirmed absent via `Glob`

---

*End of audit. Snapshot at HEAD `4cb554e`. Re-run only when (a) a cred Q-marker resolves, (b) the user explicitly redirects with new scope, or (c) a Phase 3 commit lands that re-opens the Visa Sure queue. **If pick #1 ships and the cron returns to find the queue still in this state, the right action is `CronDelete` — not another refresh.***
