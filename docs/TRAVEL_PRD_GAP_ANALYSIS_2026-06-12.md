# Travel PRD ↔ Codebase Gap Analysis — 2026-06-12

> **Source PRD:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) (master travel PRD, §4 functional requirements + §5–§9 build plan)
> **As-of:** repo state on 2026-06-12 (latest version v3.9.4, 2026-06-08)
> **Method:** fresh code-verification sweep (5 parallel exploration passes over `backend/routes/`, `backend/cron/`, `backend/lib/`, `backend/services/`, `backend/prisma/schema.prisma`, `frontend/src/pages/travel/`, seed files) cross-checked against [TRAVEL_CRM_GAP_AUDIT_2026-05-22.md](TRAVEL_CRM_GAP_AUDIT_2026-05-22.md), [TODOS.md](../TODOS.md), [CREDS_TRACKER.md](CREDS_TRACKER.md), [DECISIONS_TRACKER.md](DECISIONS_TRACKER.md), [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md), [TRAVEL_BIG_SCOPE_BACKLOG.md](TRAVEL_BIG_SCOPE_BACKLOG.md).
>
> **Status legend:** ✅ SHIPPED · 🟡 PARTIAL (core shipped, pieces missing) · 🔌 STUB (code complete in stub mode, blocked on external credentials/decision) · ❌ MISSING (no code) · ⏭️ DEFERRED (explicitly out of Phase 1 per contract)

---

## 1. Executive summary

The Phase 1 (TMC + RFU) functional surface of the travel PRD is **essentially built**. All 23 travel Prisma models, ~15 travel route files, 6 travel cron engines, the full vertical config (theme, sidebar, landing route, seed), and ~48 travel frontend pages exist — plus a substantial layer beyond the original PRD (Quote Builder, Travel Billing/GST, Supplier Master, Marketing Flyer, TMC Catalogue, Visa Sure Phase 3 pages).

**What is actually pending falls into four buckets:**

1. **Genuine code gaps** (buildable today, nothing external needed) — ~9 items, mostly small (§5.A).
2. **Cred-blocked stubs** — ~10 integrations fully wired in stub mode awaiting credential drops from Travel Stall/Yasin (Q9 Wati is the biggest: 10 consumers) (§5.B).
3. **Decision-blocked items** — counsel sign-offs, vendor picks, product calls (§5.C).
4. **Big-scope deferred builds** — Chrome flight plugin, airline check-in automation, Booking/Expedia, etc.; contractually Phase 1.5/2/3 (§5.D).

---

## 2. Status by PRD section

### §4.1 Lead intake + sales funnel

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Multi-source enquiry capture + auto source tag + UTM | ✅ | `backend/routes/travel_inbound_leads.js`; `Contact.subBrand` | 7-channel enum (voyagr, webform, whatsapp, ads, adsgpt, metaads, manual) |
| Rule-based brand assignment (lead routing × subBrand) | 🟡 | `backend/lib/leadAutoRouter.js` (wellness-only) | subBrand tagging works; travel routing-rule UI filter not wired (waiting on Yasin rule definitions) |
| 8-status pipeline + 8 lost reasons seeded | ✅ | `backend/prisma/seed-travel.js` (seedPipelineTaxonomies) | Per Q10 "accept GS defaults" |
| Diagnostic-first guard | 🟡 | `backend/routes/travel_itineraries.js` (`assertCompletedDiagnostic`) | Enforced on itinerary creation; **not confirmed on travel quote creation** — verify/extend |
| AI qualification call (Callified.ai, Eng/Hin/Urdu) | 🔌 | `backend/services/callifiedClient.js` (stub), `backend/routes/callified.js` | $100/mo cap + 90s ceiling wired; blocked on Q1 Callified creds |
| Form-vs-call comparison + mismatch flag | ✅ | `backend/routes/travel_diagnostics.js` (compare endpoint), `TravelDiagnostic.formVsCallJson` | LLM-routed; live mode needs Q11 keys |
| AI-to-advisor handover (WA + CRM alert) | 🟡 | `backend/cron/travelDiagnosticAdvisorAlerts.js` | CRM Notification shipped; WhatsApp leg stubbed (Q9) |
| Manager view (workload across brands) | 🟡 | `backend/routes/travel_dashboard.js`, `frontend/src/pages/travel/Dashboard.jsx` | Dashboard live; staff-wise pending/delayed workload aggregation not verified — confirm/extend |
| Lead source attribution through closure | ✅ | inbound leads + dashboard breakdowns | |

### §4.2 Diagnostic engine

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Diagnostic builder (Q-bank per sub-brand) | 🟡 | `frontend/src/pages/travel/DiagnosticBuilder.jsx`, bank routes in `travel_diagnostics.js` | Visual + JSON editor with version-on-write immutability; **Phase-1 "request change" ticket button missing** |
| Weighted scoring + 4 classification bands | ✅ | `backend/lib/travelDiagnosticScoring.js`; TMC: `backend/lib/tmcDiagnosticEngine.js` + `tmcLeadQuality.js` | RFU/TS/VS weighted-sum; TMC deterministic 12-Q engine |
| Branded PDF report → WA + email on completion | ✅/🔌 | `backend/services/pdfRenderer.js`, `travel_diagnostics.js` | PDF generation shipped; WA/email send stubbed (Q9) |
| Auto CRM record creation on submit | ✅ | public submit in `travel_diagnostics.js` (contact dedupe + TravelDiagnostic + lead link) | |
| TMC curriculum mapping | ✅ | `buildCurriculumFit` in `travel_diagnostics.js`, `TravelCurriculumMapping` model, `CurriculumAdmin.jsx` | Real mapping **content** awaited from TMC academic coordinator (Q13) |
| Visa Sure risk flagging | 🟡 | `backend/cron/visaRiskFlagEngine.js` (13 rules R1–R13) | Engine live; 4 rule classes deferred on product calls PC-1..PC-5 (embassy catalogue, family detection, LLM narrative) |
| LLM advisor talking points + multi-LLM router | ✅/🔌 | `backend/lib/llmRouter.js` (per-task routing table), talking-points regen endpoint | Real-mode blocked on Q11 API keys |
| Public diagnostic routes (incl. `/p/tmc/readiness`) | ✅ | public submit + TMC readiness report endpoints; `server.js` openPaths | |
| Advisor-alert cron (30-min stall escalation) | ✅ | `backend/cron/travelDiagnosticAdvisorAlerts.js` | |

### §4.3 Itinerary / package builder

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| RFU unified-search quotation engine + version chain | ✅ | `travel_itineraries.js`, `Itinerary`/`ItineraryItem` (+`parentItineraryId`), `lib/travelPricing.js`, `ItineraryEditor.jsx` | WA delivery stubbed (Q9) |
| Hotel rate comparator (RateHawk P1) | 🔌 | `backend/services/ratehawkClient.js` (stub), `routes/ratehawk.js`, `lib/quoteRanker.js` | Real-mode blocked on Q19 RateHawk creds; Booking/Expedia stub exists (`bookingExpediaClient.js`) for P1.5 |
| RFU preference filters (Haram/Kaaba-facing, floor, room cat.) | 🟡 | `RfuLeadProfile` (seat/meal prefs only) | Hotel-attribute fields (view/floor) not modeled in cost master; filter UI still raw JSON |
| Transport pricing + seasonal calendar | ✅ | `TravelSeasonCalendar`, `routes/travel_pricing.js` | |
| Cost master admin | ✅ | `routes/travel_cost_master.js`, `CostMaster.jsx` | |
| Markup rules (per-airline/route/fare-bucket, agent-scoped) | ✅ | `TravelMarkupRule`, `travel_pricing.js`, `PricingRules.jsx` | |
| Branded itinerary PDF + retrievable versions | ✅ | `pdfRenderer.js`, GET `/:id/pdf` | |
| Flight Quotation Chrome plugin | 🟡/⏭️ | backend endpoint `routes/travel_flight_quotes.js` (X-API-Key auth) only | **Extension package does not exist** (no `flight-plugin/`); CRX signing/auto-update infra absent; ~10–15 eng-days, separate repo per DC-1 |
| In-CRM fallback flight quote page (`FlightQuoteAgent.jsx`) | ❌ | — | Backend quote endpoint exists; no frontend fallback page |
| TMC trip itinerary template | ✅ | `ItineraryTemplates.jsx`, microsite renders from trip | |

### §4.4 Quote / invoice / payment

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Quotation upload (Travel Stall) | ✅ | generic ContactAttachment + Quote reuse | PRD marks this REUSE; no gated variant needed for P1 |
| Visa Sure manual-vs-structured quotation | 🟡 | `VisaApplication.complexCase` flag | Flag exists; **complexity gate on quote route not wired** |
| Invoice with CGST/SGST/IGST + receipts + refunds | ✅ | `TravelInvoice`/`TravelInvoiceLine`, `routes/travel_invoices.js`, `lib/tcsCalculation.js`, `lib/gstStateCodeResolver.js` | Credit-note refund chain; TCS; tax preview |
| CA / Tally export | 🟡 | generic `routes/accounting.js` (Tally XML, cross-vertical) | **Travel-invoice-specific Tally-XML / CA-CSV exporters missing**; sample CA export (Q5) awaited for parity test |
| Excel Software for Travel bridge | ❌/🔌 | — | No client, no stub; blocked on Q8 vendor API docs |
| Per-entity payment tracking | ✅ | `Invoice.legalEntityCode` (schema:1088), `TmcTrip.legalEntity`, `Tenant.subBrandConfigJson` | |
| TMC payment plans + instalment reminders | ✅/🔌 | `TripPaymentPlan`/`TripInstalmentPayment`, `routes/travel_trip_billing.js`, `cron/tripPaymentReminders.js` | Reminder dispatch stubbed (Q9) |

### §4.5 Booking + supplier coordination

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| TmcTrip auto-create → microsite + plan + checklist + rooming | ✅ | `routes/travel_trips.js`, `travel_microsites.js`, `travel_trip_billing.js` | |
| TMC microsite (public UUID view, OTP-gated sensitive, teacher OTP) | ✅/🔌 | `travel_microsites.js`, `PublicTripMicrosite.jsx`, `TripMicrosite`/`TripMicrositeOtp` | OTP **delivery** via WhatsApp stubbed (Q9); dynamic subdomain blocked on Q21 DNS/wildcard SSL |
| Parent/teacher registration portal (passport OCR, Aadhaar/DigiLocker, consent) | 🟡/🔌 | `routes/travel_passport.js`, `DigilockerSession` model, `services/passportOcrClient.js` (stub), `services/digilockerClient.js` (stub+real modes), `PassportVerificationQueue.jsx`, `TravelKycCallback.jsx` | Passport OCR blocked on PC-1 vendor pick + creds; DigiLocker blocked on Q3 creds; consent **legal copy** awaiting counsel (Q2) |
| Rooming allocation + downloadable list | ✅ | `RoomingAssignment`, rooming CRUD + `rooming.xlsx` export, `TripDetail.jsx` tab | |
| Departure + per-student document checklist | ✅ | `TripDocumentRequirement`, trips routes, TripDetail tab | |
| RFU customer database (full profile) | ✅ | `RfuLeadProfile`, `routes/travel_rfu_profiles.js`, `RfuCustomerProfile.jsx` | All PRD fields present |
| Duplicate detection incl. passport key | ✅ | `utils/deduplication.js` (`findDuplicateContactByPassport`), 409 DUPLICATE_PASSPORT | Full pop-up flow with preferences = Phase 2 by design |
| Login vault (AES-256-GCM + access log) | ✅ | `SupplierCredential`/`SupplierCredentialAccessLog`, `routes/travel_suppliers.js`, `lib/fieldEncryption.js`, `Suppliers.jsx` | Masked-by-default, ADMIN reveal, every access logged |

### §4.6 Web check-in

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| P1A tracking + delivery (scheduler, reminders, boarding-pass upload/delivery, dashboard) | ✅/🔌 | `cron/webCheckinScheduler.js`, `routes/travel_webcheckin.js`, `WebCheckin` model, `WebCheckinQueue.jsx` | WA reminder/delivery stubbed (Q9) |
| P1B top-4 airline automation (IndiGo/AI/Vistara/Emirates) | ❌/⏭️ | [PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md](PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md): all 13 FRs 🔴 NOT-STARTED | Blocked on decisions DC-1..DC-5; ~5–7 eng-days; fallback-to-agent path already live via P1A |

### §4.7 Visa documents + compliance / document security

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| VisaApplication + server-enforced status machine | ✅ | `VisaApplication` model, `routes/travel_visa.js` (VALID_STATUSES) | Phase 3 work largely landed early |
| Document checklist per visa type/passenger | ✅ | `VisaDocumentChecklistItem`, checklist routes, `visa/Checklists.jsx` | |
| Rejection-recovery program | 🟡 | `rejectionHistoryJson`, `priorApplicationId`, risk rules R12/R13 | Dedicated program-enrolment model deferred (PC-2) |
| Advisor risk dashboard + cron | ✅ | `cron/visaRiskFlagEngine.js`, `visa/AdvisorDashboard.jsx`, `visa/Applications.jsx`, `routes/travel_visa_analytics.js` | |
| **Document security model (Response B.2)** | 🟡 | encryption ✅ (`lib/fieldEncryption.js`); retention engine ✅ (entity map); read audit partial | **Gaps: no dynamic watermark on rendered docs; no share-link expiry (`shareToken` has no `expiresAt`) or revoke; no per-document view/download/share audit rows; per-type retention (passport 24m / call 12m / financial 84m) not fully seeded** |
| Aadhaar via DigiLocker | 🔌 | `DigilockerSession` FSM, `digilockerClient.js` | Q3 creds |

### §4.8 Customer communications

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Embedded WhatsApp + conversation logging | ✅ | `routes/travel_whatsapp.js`, `WhatsAppChat.jsx`/`WhatsAppLog.jsx`/`WhatsAppTemplates.jsx` | |
| Wati BSP client, per-sub-brand WABA config | ✅/🔌 | `services/watiClient.js`, `lib/subBrandConfig.js`, `Tenant.subBrandConfigJson` | Code fully wired incl. per-sub-brand resolution; **all outbound sends in stub mode pending Q9** (3 WABA numbers + Meta token) — 10 consumers (7 crons + 3 endpoints) flip on cred drop |
| Email / Calendar / Meet | ✅ (reuse) | existing machinery + `calendar_google.js` | No travel-specific Meet consultation flow (acceptable per PRD reuse intent) |
| Drive folder auto-creation on trip confirm | 🔌 | `services/googleDriveClient.js` (stub), `TmcTrip.driveFolderId` | Q1/Q7 Workspace creds |
| Umrah journey reminders | ✅/🔌 | `cron/travelJourneyReminders.js`, `cron/travelMilestoneRemindersEngine.js`, `MilestoneTracker.jsx` | Send stubbed (Q9) |
| Religious-guidance content delivery | ✅ | `cron/religiousGuidanceEngine.js`, `ReligiousGuidancePacket` model, `ReligiousPackets.jsx` | 3 placeholder packets; real content owed by Yasin |
| Post-trip feedback survey | ✅ | `cron/tripPostTripFeedback.js` + Survey reuse | |
| Birthday / anniversary greetings | ⏭️ | — | Phase 2 by design (B7 in MANUAL_CODING_BACKLOG, 2–3d) |

### §4.9 Reports / dashboards

| Requirement | Status | Evidence | Note |
|---|---|---|---|
| Management cross-brand KPI dashboard | ✅ | `routes/travel_dashboard.js`, `Dashboard.jsx` | |
| TMC analytics | ✅ | `routes/travel_reports.js` (/tmc) | revenue-by-destination, repeat-school, margin, conversion-by-score |
| RFU analytics | ✅ | `routes/travel_reports.js` (/rfu) | revenue/conversion by tier, repeat customers |
| Visa Sure analytics | ✅ | `routes/travel_visa_analytics.js`, `visa/Reports.jsx` | landed with Phase 3 work |
| Travel Stall analytics | 🟡 | scaffolded endpoint in `travel_reports.js` | Phase 2 — business logic pending |
| Platform-wise marketing reports (AdsGPT) | 🔌 | `services/adsGptClient.js` (stub, $50/mo cap) | Q1 AdsGPT creds |
| TMC per-trip ops dashboard | ✅ | trips detail route + `TripDetail.jsx` (students/payments/docs/rooming/readiness) | |

### §6.3 Cron engines

| PRD engine | Status | Actual file |
|---|---|---|
| webCheckinScheduler | ✅ | `backend/cron/webCheckinScheduler.js` |
| webCheckinAutomation | ❌/⏭️ | — (P1B deferral, DC-1..5) |
| tripPaymentReminders | ✅ | `backend/cron/tripPaymentReminders.js` |
| travelJourneyReminders | ✅ | `backend/cron/travelJourneyReminders.js` (+ `travelMilestoneRemindersEngine.js`, `religiousGuidanceEngine.js`) |
| tripPostTripFeedback | ✅ | `backend/cron/tripPostTripFeedback.js` |
| travelDiagnosticAdvisorAlerts | ✅ | `backend/cron/travelDiagnosticAdvisorAlerts.js` |

### §7 Frontend pages (PRD plan → actual)

Shipped (mapping to actual filenames): Dashboard, Leads, LeadDetail, DiagnosticBuilder/Diagnostics/DiagnosticDetail, DiagnosticWizard (preview + public), ItineraryEditor (builder), ItineraryDetail/Itineraries, CostMaster, PricingRules (markup rules), Suppliers + SuppliersAdmin (vault), Trips, TripDetail (ops dashboard + rooming + payment plan + doc checklist tabs), TmcMicrositePreview, PublicTripMicrosite, WebCheckinQueue, RfuCustomerProfile, MilestoneTracker (journey), Reports, visa/Applications, visa/AdvisorDashboard, visa/Checklists, visa/Dashboard, visa/Reports, visa/EmbassyRulesAdmin.

**Not present:** `FlightQuoteAgent.jsx` (in-CRM flight quote fallback — ❌), dedicated `TravelStallFamilyQuiz.jsx` (🟡 covered generically by DiagnosticWizard + seeded Travel Stall bank; dedicated quiz UX is Phase 2), dedicated `RfuJourneyReminders.jsx` (🟡 covered by MilestoneTracker).

**Beyond-PRD pages shipped:** QuoteBuilder/QuotesAdmin/QuoteTemplates, InvoicesAdmin, Payables, CommissionProfilesAdmin, CancellationPolicies, MarketingFlyerStudio/FlyerTemplates/FlyerShareAdmin, SightseeingMaster, SchoolTermCalendar, CurriculumAdmin, TmcCatalogueAdmin, InboundLeads, TravelCustomerPortal, TravelStallDashboard, PassportVerificationQueue, PoiPendingApprovalQueue, WhatsApp suite, TravelKycCallback.

### §8 Vertical config + §5.2 model extensions

All shipped: `Tenant.vertical="travel"` + `subBrandConfigJson`, `Contact.subBrand`, `Deal.subBrand`+`diagnosticId`, `Booking.tripId`+`itineraryId`, `Invoice.legalEntityCode`, `User.subBrandAccess`, `renderTravelNav()` in Sidebar, `theme/travel.css` (`[data-vertical="travel"]`), `/travel` landing redirect, `prisma/seed-travel.js` (tenant + sub-brand configs + users + Q-banks + samples). ✅ — no gaps.

### §9 External integrations

| Integration | Status | Note |
|---|---|---|
| Wati BSP | 🔌 code-complete stub | Q9 — highest fan-out blocker (10 consumers) |
| Meta WA Cloud API, Email, SMS, Calendar, Razorpay/Stripe, Sentry, RBAC | ✅ reuse | unchanged |
| Callified.ai / Exotel | 🔌 stub | Q1 Callified creds |
| Google Drive client | 🔌 stub | Q1/Q7 Workspace creds |
| RateHawk | 🔌 stub (`ratehawkClient.js`) | Q19 production creds |
| Booking.com / Expedia | 🔌 stub (`bookingExpediaClient.js`) | Phase 1.5, commercial agreement pending |
| DigiLocker | 🔌 stub+real modes | Q3 creds |
| Passport OCR | 🔌 stub | PC-1 vendor decision (DocAI vs Form Recognizer) + creds |
| AdsGPT | 🔌 stub | Q1 creds |
| LLM router (Perplexity/Claude/Gemini/GPT) | ✅ code / 🔌 keys | Q11 keys |
| Excel Software for Travel | ❌ | Q8 — no docs, no stub yet |
| Tally exporter | 🟡 | generic accounting.js only; travel-specific exporter missing |
| Airline portal automation | ❌/⏭️ | P1B deferral |
| Chrome flight plugin | ❌/⏭️ | separate-repo decision; backend endpoint ready |

---

## 3. What is PENDING — consolidated

### A. Code gaps — buildable now, no external dependency

| # | Item | Size | Where |
|---|---|---|---|
| A1 | In-CRM fallback flight quote page (`FlightQuoteAgent.jsx` at `/travel/flights/quote`) | ~1–2d | frontend; backend endpoint already exists (`travel_flight_quotes.js`) |
| A2 | Travel-invoice Tally-XML + CA-CSV exporters | ~1–2d | extend `routes/travel_invoices.js`; parity test needs Q5 sample |
| A3 | Document-security hardening: dynamic watermark on rendered docs; `shareToken` expiry (default 7d/max 30) + revoke; per-document view/download/share audit rows | ~2–3d | pdfRenderer + itinerary/visa doc routes + schema migration (`expiresAt`) |
| A4 | Per-type retention seeding (passport 24m post-trip, call 12m, financial 84m, diagnostic lifetime) | ~0.5d | retention engine policies (Q14 defaults accepted) |
| A5 | Diagnostic builder Phase-1 "request change" ticket button | ~0.5d | DiagnosticBuilder.jsx + ticket route |
| A6 | Visa Sure complexity gate on quotation route (manual vs structured by `complexCase`) | ~0.5d | quote/visa routes |
| A7 | RFU hotel preference attributes (Haram/Kaaba-facing, floor, room category) in cost-master schema + filter UI polish (currently raw JSON) | ~1–2d | `TravelCostMaster.attributesJson` conventions + ItineraryEditor UI |
| A8 | Lead-routing rule UI filter on `subBrand` | ~0.5d | LeadRouting page + rule schema (content needs Yasin's rules) |
| A9 | Verify/extend: diagnostic-first guard on travel **quote** creation (itineraries guarded); manager staff-workload aggregation on travel dashboard | ~0.5–1d | `travel_quotes*.js`, `travel_dashboard.js` |

### B. Cred-blocked — code shipped in stub mode, flips on credential drop (owner: Yasin / Travel Stall unless noted)

| Q-marker | Credential | Unblocks | Swap effort |
|---|---|---|---|
| **Q9** Wati WhatsApp | 3 WABA IDs + Meta System User token | **10 consumers** — 7 crons + 3 endpoints (diagnostic PDF send, OTP, reminders, boarding pass, journey/religious/payment reminders) | 1–2d |
| **Q11** LLM keys | Perplexity/Gemini(/Claude/GPT) | talking points, form-vs-call, call summaries, cost dashboard | 1d |
| **Q22** Brand assets | logos/palettes/fonts/PDF covers per sub-brand | 4 PRDs at once (branding, flyers, billing PDFs, theme) — highest fan-out | varies |
| **Q3** DigiLocker | client ID/secret | real Aadhaar KYC in TMC parent registration | 1d |
| **Q19** RateHawk | production API key/ID | RFU lowest-rate auto-pick | ~1d (stub client exists) |
| **Q1** Section-13 packet | Callified + AdsGPT + Workspace admin et al. | AI calling, marketing reports, Drive folders | 1–2d each |
| **PC-1** Passport OCR vendor | DocAI vs Form Recognizer pick + creds | passport auto-extract | 1–2d |
| **Q8** Excel Software | vendor REST/CSV docs | accounting bridge (**client not yet written**) | 3–5d post-docs |
| **Q21** DNS + wildcard SSL | `*.tmc.travelstall.in` | microsite dynamic subdomains | ops |
| **Q6** On-prem hosting access | SSH/DNS/infra handover | Phase-1 deploy target (see risk R11) | ops, W0 call |

### C. Decision / product-call blocked

- **Q2** Aadhaar consent legal copy — GS draft done ([TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md)); awaiting Travel Stall counsel sign-off (~15 min swap after).
- **Q13** TMC curriculum mapping content — table source awaited from TMC academic coordinator (engine + admin UI ready).
- **PC-1..PC-5** Visa risk-rule product calls — embassy rejection-rate catalogue, family/dependents detection, LLM narrative.
- **DC-1..DC-5** airline check-in automation architecture calls (gates P1B build).
- Security design calls A1–A4 in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) (JWT→HttpOnly cookies #914/#915, CSP nonce #917, sequential→opaque IDs #918, IDOR middleware #919–#921) — travel-security cluster, design call first.

### D. Big-scope deferred builds (contractual Phase 1.5 / 2 / 3)

| Item | Phase | Est. |
|---|---|---|
| Chrome flight-quote plugin (Manifest V3, signed CRX, auto-update, separate repo) | P1 W3 commitment, **not started** | 10–15d |
| Airline web check-in automation P1B (top-4) + Tier-2 airlines | P1 W4 commitment / P1.5 | 5–7d + 1–2d/airline |
| Booking.com / Expedia direct APIs | P1.5 (commercial agreement pending) | 7–10d per provider |
| Excel Software API bridge | P1.5 (post Q8) | 3–5d |
| Admin-editable diagnostic scoring (edit-with-audit + sandbox) | P1.5 (Q16) | 2d |
| Travel Stall: dedicated Family-Quiz UX + recommendations PDF + booking flow + analytics logic | Phase 2 | multi-day |
| Customer-duplicate full pop-up flow with preferences | Phase 2 | small |
| Birthday / anniversary greetings | Phase 2 | 2–3d |
| Visa Sure rejection-recovery enrolment model + residual rules | Phase 3 (most of Phase 3 already landed) | small–medium |

> ⚠️ **Contract note:** the Chrome flight plugin (W3 exit gate) and top-4 airline check-in automation (W4 exit gate) are the only two **Phase-1-committed** deliverables with no build started. Everything else pending is either cred/decision-blocked or contractually later-phase.

---

## 4. Top blockers by blast radius (action list for Yasin / GS)

1. **Q22 brand assets** — unblocks 4 PRDs simultaneously.
2. **Q9 Wati** — flips 10 stubbed consumers to live messaging.
3. **Q11 LLM keys** — flips all AI surfaces to real mode.
4. **Q3 DigiLocker + Q2 consent sign-off** — completes TMC parent registration end-to-end.
5. **Q19 RateHawk** — completes the RFU quotation engine's lowest-rate pick.
6. **Decision to start the Chrome plugin + airline automation builds** — the two Phase-1 contract items not yet started (DC-1..DC-5).
7. **Q6/R11 on-prem infra handover call** — deploy-target risk flagged 🔴 in [TRAVEL_CRM_RISKS.md](TRAVEL_CRM_RISKS.md).

---

## 5. Open risks (from [TRAVEL_CRM_RISKS.md](TRAVEL_CRM_RISKS.md), unchanged by this audit)

- 🔴 R2 — 6-week timeline (~87 eng-days, zero slack) — largely mitigated by the build state above, but the two unstarted contract items (plugin + automation) carry it.
- 🔴 R3 — Chrome extension auto-update outside Web Store.
- 🔴 R11 — on-prem hosting operational complexity (NEW; W0 handover call pending).
- 🟡 R1 (Section-13 packet), R7 (LLM cost observability), R8 (Aadhaar legal).

---

*Generated 2026-06-12 from a fresh 5-pass code-verification sweep. Predecessor audit: [TRAVEL_CRM_GAP_AUDIT_2026-05-22.md](TRAVEL_CRM_GAP_AUDIT_2026-05-22.md).*
