# Travel PRD ↔ Codebase Gap Analysis — 2026-06-15

> **Source PRD:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) (master travel PRD, §4 functional requirements + §5–§9 build plan)
> **As-of:** repo state on 2026-06-15 at HEAD `f4643798`
> **Method:** fresh 4-pass code-verification sweep (backend routes + cron, travel frontend pages + routing, external-integration clients + Prisma schema, PRD-requirement cross-check) layered on the predecessor audit [TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md](TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md). Cross-checked against [CREDS_TRACKER.md](CREDS_TRACKER.md), [DECISIONS_TRACKER.md](DECISIONS_TRACKER.md), [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md).
>
> **Status legend:** ✅ SHIPPED · 🟡 PARTIAL (core shipped, pieces missing) · 🔌 STUB (code complete in stub mode, blocked on external credentials/decision) · ❌ MISSING (no code) · ⏭️ DEFERRED (explicitly out of Phase 1 per contract)

---

## 1. Executive summary

**The "code gaps — buildable now" bucket from the 2026-06-12 audit (A1–A9) is fully closed, and passport OCR flipped from a cred-blocked stub to a shipped, on-box engine.** Two commits on 2026-06-12 (`e720c9d3` "Added gap and ocr" + `7f500944` "Fixes", ~11.6k lines) shipped all nine A-items plus a real local passport OCR pipeline and the customer-portal traveller/passport-upload flow.

The Phase 1 (TMC + RFU) functional surface of the master travel PRD is now **essentially complete in code**. What remains pending falls into exactly three buckets — there is **no longer a meaningful "buildable today with nothing external" queue** against the master PRD §4:

1. **Cred-blocked stubs** — ~9 integrations fully wired in stub mode, awaiting credential drops (Q9 Wati is still the biggest fan-out: ~10 consumers).
2. **Decision / product-call blocked** — counsel sign-offs, vendor picks, architecture calls.
3. **Big-scope deferred builds** — Chrome flight plugin and top-4 airline check-in automation are the only two **Phase-1-committed** deliverables with no build started; everything else is contractually Phase 1.5/2/3.

> ⚠️ **Scope note:** this audit covers the **master travel PRD §4**. A wider sweep of the 15 travel sub-PRDs surfaced larger greenfield programs (B2B Agent Portal, RFU Ground Services, Travel Security Architecture, Marketing Flyer Studio FRs, per-sub-brand Branding consumers) — captured in §6 below as "beyond-master-PRD programs", but they are separate initiatives, not master-PRD §4 gaps.

---

## 2. What changed since 2026-06-12 (delta)

| Item (2026-06-12 id) | Old verdict | New verdict | Evidence |
|---|---|---|---|
| **A1** In-CRM fallback flight quote page | ❌ MISSING | ✅ SHIPPED | `frontend/src/pages/travel/FlightQuoteAgent.jsx` (route `/travel/flights/quote`, App.jsx:1485); backend `travel_flight_quotes.js:182` `POST /agent-quotes` |
| **A2** Travel-invoice Tally-XML + CA-CSV exporters | 🟡 PARTIAL | ✅ SHIPPED | `travel_invoices.js:1130,1157` → `lib/travelAccountingExport.js` |
| **A3** Document security (watermark + share expiry/revoke + audit) | 🟡 PARTIAL | ✅ SHIPPED | `travel_itineraries.js:3444` (mint+expiry), `:3574` (revoke, 410), `:3663` (per-viewer watermark), `:3672/3780` (audit rows); `lib/shareLinkPolicy.js`; schema `Itinerary.shareExpiresAt`/`shareRevokedAt` |
| **A4** Per-type retention seeding | ❌ MISSING | ✅ SHIPPED | `cron/retentionEngine.js:228-231` — passport 24m post-trip / call 12m / financial 84m / diagnostic lifetime |
| **A5** Diagnostic "request change" ticket | 🟡 PARTIAL | ✅ SHIPPED | `travel_diagnostics.js:263` `POST /diagnostics/banks/:id/request-change` (scoring stays view-only); `DiagnosticBuilder.jsx` button |
| **A6** Visa Sure complexity gate | 🟡 PARTIAL | ✅ SHIPPED | `travel_quotes.js:237-252,1950` — `complexCase` forces manual-vs-structured |
| **A7** RFU hotel preference attributes | 🟡 PARTIAL | ✅ SHIPPED | `travel_cost_master.js:45-150` — `HOTEL_ATTRIBUTES` enum (haram_facing/kaaba_facing/floorLevel/roomCategory) + `?view/?floorLevel/?roomCategory` filters + CostMaster.jsx UI |
| **A8** Lead-routing subBrand filter | 🟡 PARTIAL | ✅ SHIPPED | `LeadRoutingRule.subBrand` column + resolver in `leadAutoRouter.js`; `routes/lead_routing.js` (+54) ; `LeadRouting.jsx:124` `VALID_SUB_BRANDS` filter UI |
| **A9** Diagnostic-first guard on quotes + manager workload | 🟡 PARTIAL | ✅ SHIPPED | `travel_quotes.js:223` `assertCompletedDiagnostic`; `travel_dashboard.js:255` `GET /dashboard/workload` (MANAGER/ADMIN) → `lib/travelWorkload.js` |
| **Passport OCR** | 🔌 STUB (blocked PC-1 vendor) | ✅ SHIPPED (on-box) | `services/passportOcrClient.js` now runs `tesseract.js` + `lib/mrzParser.js` (ICAO 9303 TD3) + `lib/passportVizParser.js`; bundled `backend/eng.traineddata` (5.2 MB); `provider: "local-mrz-v1"` |
| **Customer-portal traveller + passport upload** | (not tracked) | ✅ SHIPPED | `routes/portal.js` (+273) customer-side traveller register + upload → same verification queue; `CustomerTraveller` model; `TravelCustomerPortal.jsx` UI |

> **Note on passport OCR:** the PC-1 decision (Google DocAI vs Azure Form Recognizer) is no longer a blocker — the team shipped open-source on-box OCR (zero vendor cred). A paid-vendor swap remains *optional* for higher accuracy but TMC parent registration is end-to-end without it.

---

## 3. Status by PRD section (current)

### §4.1 Lead intake + sales funnel

| Requirement | Status | Note |
|---|---|---|
| Multi-source enquiry capture + auto source tag + UTM | ✅ | `travel_inbound_leads.js`; 7-channel enum |
| Rule-based brand assignment (lead routing × subBrand) | ✅ | **Now shipped** — `LeadRoutingRule.subBrand` + resolver + filter UI (was 🟡) |
| 8-status pipeline + 8 lost reasons seeded | ✅ | `seed-travel.js` |
| Diagnostic-first guard | ✅ | **Now on BOTH itinerary and quote creation** (`assertCompletedDiagnostic`) (was 🟡) |
| AI qualification call (Callified.ai, Eng/Hin/Urdu) | 🔌 | `callifiedClient.js` stub; Q1 creds |
| Form-vs-call comparison + mismatch flag | ✅/🔌 | compare endpoint shipped; live LLM needs Q11 |
| AI-to-advisor handover (WA + CRM alert) | 🟡/🔌 | CRM Notification ✅; WhatsApp leg stubbed (Q9) |
| Manager view (workload across brands) | ✅ | **Now shipped** — `GET /dashboard/workload` staff-wise open/overdue by sub-brand (was 🟡) |
| Lead source attribution through closure | ✅ | |

### §4.2 Diagnostic engine

| Requirement | Status | Note |
|---|---|---|
| Diagnostic builder (Q-bank per sub-brand) | ✅ | **"Request change" ticket now wired** (was 🟡) |
| Weighted scoring + 4 classification bands | ✅ | RFU/TS/VS weighted-sum; TMC deterministic 12-Q |
| Branded PDF report → WA + email on completion | ✅/🔌 | PDF ✅; WA/email send stubbed (Q9) |
| Auto CRM record creation on submit | ✅ | |
| TMC curriculum mapping | ✅ | mapping **content** awaited (Q13) |
| Visa Sure risk flagging | 🟡 | engine live (13 rules); 4 rule classes deferred (PC-1..PC-5) |
| LLM advisor talking points + multi-LLM router | ✅/🔌 | router ✅; real-mode blocked on Q11 keys |
| Public diagnostic routes (incl. `/p/tmc/readiness`) | ✅ | |
| Advisor-alert cron (30-min stall escalation) | ✅ | `travelDiagnosticAdvisorAlerts.js` |

### §4.3 Itinerary / package builder

| Requirement | Status | Note |
|---|---|---|
| RFU unified-search quotation engine + version chain | ✅ | WA delivery stubbed (Q9) |
| Hotel rate comparator (RateHawk P1) | 🔌 | `ratehawkClient.js` stub; Q19 creds |
| RFU preference filters (Haram/Kaaba-facing, floor, room cat.) | ✅ | **Now structured** in cost master + filters (was 🟡) |
| Transport pricing + seasonal calendar | ✅ | |
| Cost master admin | ✅ | |
| Markup rules (per-airline/route/fare-bucket, agent-scoped) | ✅ | |
| Branded itinerary PDF + retrievable versions | ✅ | + per-viewer watermark on shared PDFs |
| In-CRM fallback flight quote page | ✅ | **Now shipped** — `FlightQuoteAgent.jsx` (was ❌) |
| Flight Quotation Chrome plugin | ❌/⏭️ | backend endpoint ready; extension package not started (DC-1) |
| TMC trip itinerary template | ✅ | |

### §4.4 Quote / invoice / payment

| Requirement | Status | Note |
|---|---|---|
| Quotation upload (Travel Stall) | ✅ | PRD-marked REUSE |
| Visa Sure manual-vs-structured quotation | ✅ | **Complexity gate now wired** (was 🟡) |
| Invoice with CGST/SGST/IGST + receipts + refunds | ✅ | TCS; credit-note chain |
| CA / Tally export | ✅ | **Travel-specific exporters now shipped** (was 🟡) — parity test still wants Q5 sample |
| Excel Software for Travel bridge | ❌/🔌 | no client, no stub; Q8 vendor docs |
| Per-entity payment tracking | ✅ | `legalEntityCode` |
| TMC payment plans + instalment reminders | ✅/🔌 | reminder dispatch stubbed (Q9) |

### §4.5 Booking + supplier coordination

| Requirement | Status | Note |
|---|---|---|
| TmcTrip auto-create → microsite + plan + checklist + rooming | ✅ | |
| TMC microsite (public UUID, OTP-gated, teacher OTP) | ✅/🔌 | OTP **delivery** via WA stubbed (Q9); dynamic subdomain blocked (Q21 DNS) |
| Parent/teacher registration (passport OCR, Aadhaar, consent) | 🟡/🔌 | **Passport OCR now shipped on-box** ✅; DigiLocker Aadhaar stub (Q3); consent **legal copy** awaiting counsel (Q2) |
| Customer-portal traveller register + passport upload | ✅ | **Newly shipped** — `portal.js` + `CustomerTraveller` + portal UI |
| Rooming allocation + downloadable list | ✅ | `rooming.xlsx` export |
| Departure + per-student document checklist | ✅ | |
| RFU customer database (full profile) | ✅ | |
| Duplicate detection incl. passport key | ✅ | full pop-up flow with prefs = Phase 2 |
| Login vault (AES-256-GCM + access log) | ✅ | masked-by-default, ADMIN reveal, logged |

### §4.6 Web check-in

| Requirement | Status | Note |
|---|---|---|
| P1A tracking + delivery (scheduler, reminders, boarding-pass upload, dashboard) | ✅/🔌 | WA reminder/delivery stubbed (Q9) |
| P1B top-4 airline automation (IndiGo/AI/Vistara/Emirates) | ❌/⏭️ | all 13 FRs NOT-STARTED; DC-1..5; ~5–7 eng-days; fallback-to-agent already live |

### §4.7 Visa documents + compliance / document security

| Requirement | Status | Note |
|---|---|---|
| VisaApplication + server-enforced status machine | ✅ | backend real (`travel_visa.js`) |
| Document checklist per visa type/passenger | ✅ | |
| Rejection-recovery program | 🟡 | `RecoveryProgram.jsx` page + fields; dedicated enrolment model deferred (PC-2) |
| Advisor risk dashboard + cron | ✅ | `visaRiskFlagEngine.js`, analytics route |
| **Document security model (Response B.2)** | ✅ | **Now shipped** — encryption + retention engine + dynamic per-viewer watermark + share-link expiry/revoke + view/download/share audit rows (was 🟡 with 4 sub-gaps) |
| Aadhaar via DigiLocker | 🔌 | `digilockerClient.js`; Q3 creds |

> **Visa frontend nuance:** several `visa/*.jsx` pages (Dashboard, Applications, Checklists, Reports) carry explicit "Phase 3 SHELL" comments — the **backend** (routes + analytics + risk cron) is real, but some advisor-facing UI surfaces are still placeholder shells pending Phase 3 product calls.

### §4.8 Customer communications

| Requirement | Status | Note |
|---|---|---|
| Embedded WhatsApp + conversation logging | ✅ | `travel_whatsapp.js`, chat suite (incl. delivery-status reconciliation) |
| Wati BSP client, per-sub-brand WABA config | ✅/🔌 | code fully wired; **all outbound sends stub-mode pending Q9** — ~10 consumers |
| Email / Calendar / Meet | ✅ (reuse) | |
| Drive folder auto-creation on trip confirm | 🔌 | `googleDriveClient.js` stub; Q1/Q7 Workspace creds |
| Umrah journey reminders | ✅/🔌 | send stubbed (Q9) |
| Religious-guidance content delivery | ✅ | 3 placeholder packets; real content owed (Yasin) |
| Post-trip feedback survey | ✅ | |
| Birthday / anniversary greetings | ⏭️ | Phase 2 by design |

### §4.9 Reports / dashboards

| Requirement | Status | Note |
|---|---|---|
| Management cross-brand KPI dashboard | ✅ | + manager workload widget |
| TMC analytics | ✅ | |
| RFU analytics | ✅ | |
| Visa Sure analytics | ✅/🟡 | backend real; some UI shells Phase 3 |
| Travel Stall analytics | 🟡 | scaffolded; Phase 2 business logic pending |
| Platform-wise marketing reports (AdsGPT) | 🔌 | `adsGptClient.js` stub; Q1 creds |
| TMC per-trip ops dashboard | ✅ | TripDetail tabs |

### §6.3 Cron engines · §7 frontend · §8 vertical config · §9 integrations

- **Cron (§6.3):** all 6 PRD travel engines present (`webCheckinScheduler`, `tripPaymentReminders`, `travelJourneyReminders` + `travelMilestoneRemindersEngine` + `religiousGuidanceEngine`, `tripPostTripFeedback`, `travelDiagnosticAdvisorAlerts`, `visaRiskFlagEngine`) + retention windows. `webCheckinAutomation` (P1B) ❌/⏭️.
- **Frontend (§7):** 54 `pages/travel/*.jsx` + 7 `pages/travel/visa/*.jsx`, all routed in App.jsx and (where nav-level) in `renderTravelNav`. `FlightQuoteAgent.jsx` now present (was the lone ❌). Phase-2 SHELL pages: `TravelStallDashboard.jsx`, `MarketingFlyerStudio.jsx`. Phase-3 SHELL pages: `visa/{Dashboard,Applications,Checklists,Reports}.jsx`.
- **Vertical config (§8):** all shipped — no gaps.
- **Integrations (§9):** unchanged except **Passport OCR now ✅ on-box** (was 🔌). All others stub-mode pending creds (table in §4 / §5.B).

---

## 4. What is PENDING — consolidated

### A. Code gaps — buildable now, no external dependency

**Empty against master PRD §4.** All nine 2026-06-12 A-items shipped (see §2). Remaining "buildable-now" work lives in the beyond-master-PRD programs (§6), not in master-PRD §4.

### B. Cred-blocked — code shipped in stub mode, flips on credential drop

| Q-marker | Credential | Unblocks | Swap effort |
|---|---|---|---|
| **Q9** Wati WhatsApp | 3 WABA IDs + Meta System User token | **~10 consumers** — diagnostic PDF send, OTP, reminders, boarding pass, journey/religious/payment reminders | 1–2d |
| **Q11** LLM keys | Perplexity/Gemini(/Claude/GPT) | talking points, form-vs-call, call summaries, cost dashboard | 1d |
| **Q22** Brand assets | logos/palettes/fonts/PDF covers per sub-brand | 4 PRDs at once (branding, flyers, billing PDFs, theme) — highest fan-out | varies |
| **Q3** DigiLocker | client ID/secret | real Aadhaar KYC in TMC parent registration | 1d |
| **Q19** RateHawk | production API key/ID | RFU lowest-rate auto-pick | ~1d (stub exists) |
| **Q1** Section-13 packet | Callified + AdsGPT + Workspace admin | AI calling, marketing reports, Drive folders | 1–2d each |
| **Q8** Excel Software | vendor REST/CSV docs | accounting bridge (**client not yet written**) | 3–5d post-docs |
| **Q21** DNS + wildcard SSL | `*.tmc.travelstall.in` | microsite dynamic subdomains | ops |
| **Q6** On-prem hosting access | SSH/DNS/infra handover | Phase-1 deploy target (risk R11) | ops, W0 call |

> **Removed from this bucket vs 2026-06-12:** PC-1 Passport OCR (shipped on-box).

### C. Decision / product-call blocked

- **Q2** Aadhaar consent legal copy — GS draft done; awaiting counsel sign-off (~15 min code swap after).
- **Q13** TMC curriculum mapping content — table source awaited (engine + admin UI ready).
- **PC-1..PC-5** Visa risk-rule product calls — embassy catalogue, family/dependents detection, LLM narrative.
- **DC-1..DC-5** airline check-in automation architecture calls (gates P1B build).
- **Q16** RFU admin-editable diagnostic scoring (edit-with-audit + sandbox) — Phase 1.5 product call.
- Security design calls (JWT→HttpOnly cookies, CSP nonce, sequential→opaque IDs, IDOR middleware) — travel-security cluster, design call first (see [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md)).

### D. Big-scope deferred builds (contractual Phase 1.5 / 2 / 3)

| Item | Phase | Est. | Status |
|---|---|---|---|
| Chrome flight-quote plugin (Manifest V3, signed CRX, auto-update, separate repo) | **P1 W3 commitment** | 10–15d | **NOT STARTED** (DC-1); in-CRM fallback now live |
| Airline web check-in automation P1B (top-4) + Tier-2 | **P1 W4 commitment** / P1.5 | 5–7d + 1–2d/airline | **NOT STARTED** (DC-1..5); P1A fallback live |
| Booking.com / Expedia direct APIs | P1.5 | 7–10d/provider | stub client exists; commercial agreement pending |
| Excel Software API bridge | P1.5 (post Q8) | 3–5d | no client yet |
| Admin-editable diagnostic scoring (edit-with-audit + sandbox) | P1.5 (Q16) | 2d | |
| Travel Stall: dedicated Family-Quiz UX + recommendations PDF + booking + analytics | Phase 2 | multi-day | dashboard is a SHELL |
| Customer-duplicate full pop-up flow with preferences | Phase 2 | small | |
| Birthday / anniversary greetings | Phase 2 | 2–3d | |
| Visa Sure rejection-recovery enrolment model + residual rules | Phase 3 | small–medium | most of Phase 3 backend landed |

> ⚠️ **Contract note:** the Chrome flight plugin (W3 exit gate) and top-4 airline check-in automation (W4 exit gate) remain the only two **Phase-1-committed** deliverables with no build started. Everything else pending is cred/decision-blocked or contractually later-phase.

---

## 5. Top blockers by blast radius (action list for Yasin / GS)

1. **Q22 brand assets** — unblocks 4 PRDs simultaneously.
2. **Q9 Wati** — flips ~10 stubbed consumers to live messaging.
3. **Q11 LLM keys** — flips all AI surfaces to real mode.
4. **Q3 DigiLocker + Q2 consent sign-off** — completes TMC parent registration end-to-end (passport OCR already done).
5. **Q19 RateHawk** — completes the RFU quotation engine's lowest-rate pick.
6. **Decision to start the Chrome plugin + airline automation builds** (DC-1..DC-5) — the two Phase-1 contract items not yet started.
7. **Q6/R11 on-prem infra handover call** — deploy-target risk 🔴.

---

## 6. Beyond-master-PRD programs (separate initiatives, not §4 gaps)

A wider sub-PRD sweep surfaced larger greenfield programs tracked in their own PRDs. Flagged here so they aren't mistaken for closed §4 scope:

| Program | State | Gate |
|---|---|---|
| B2B Agent Portal (34 FRs) | ~0% | 7 design calls (DD-5.x: cookie shape, sub-agent commission ledger, …) |
| RFU Ground Services (Zikr Cabs + 5 hotel portals + Haramain HSR) | ~0% | Q-RFU-1..7 creds; ~8–10d post-creds |
| Travel Security Architecture (~23 FRs) | partial | design calls first; ~19d engineering-actionable |
| Marketing Flyer Studio (FR set) | SHELL | multichannel block types, snap-to-grid, undo/redo, brand-kit consumer |
| Per-sub-brand Branding consumers (BrandKit schema + render consumers) | in progress | gated/accelerated by Q22 brand pack |

---

## 7. Open risks (from [TRAVEL_CRM_RISKS.md](TRAVEL_CRM_RISKS.md))

- 🔴 R2 — 6-week timeline; largely mitigated by the build state, but the two unstarted contract items (plugin + airline automation) carry it.
- 🔴 R3 — Chrome extension auto-update outside Web Store.
- 🔴 R11 — on-prem hosting operational complexity (W0 handover call pending).
- 🟡 R1 (Section-13 packet), R7 (LLM cost observability), R8 (Aadhaar legal).

---

*Generated 2026-06-15 from a fresh 4-pass code-verification sweep at HEAD `f4643798`. Predecessor: [TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md](TRAVEL_PRD_GAP_ANALYSIS_2026-06-12.md). Headline change: 2026-06-12 code-gap bucket (A1–A9) fully closed + passport OCR shipped on-box.*
