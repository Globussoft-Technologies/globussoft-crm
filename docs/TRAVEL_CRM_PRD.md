# Travel CRM — Product Requirements & Implementation Plan

> Source: 19 documents under `travel-crm/` (18 PDFs + 1 docx), client = Travel Stall (Yasin Sharieff), engagement = long-term partnership with phased rollout. This PRD covers all four sub-verticals but recommends a phased ship matching the GlobusSoft response committed on 15-May-2026 (TMC + RFU in Phase 1; Travel Stall + Visa Sure later).

---

## 1. Executive summary

The travel vertical adds a third `Tenant.vertical` value (`travel`) to the existing multi-tenant CRM, scoped to four sub-verticals operated by Travel Stall as separate legal entities under a shared CRM tenant: **TMC** (The Modern Classroom — B2B educational school trips, `TMC Nexus Pvt Ltd`), **RFU** (Ready for Umrah — B2C pilgrimage travel, `Labbaik Tours and Travels (INTL)`, IATA-accredited), **Travel Stall** (B2C family holidays + ticketing, Tier‑3 personalised), and **Visa Sure** (visa correctness & assurance). All four share the same "diagnostic-first" positioning — a structured questionnaire classifies the lead into a readiness/tier band BEFORE any commercial transaction, replacing destination/product-first selling. The codebase reuses the existing Contact / Deal / Pipeline / Quote / Invoice / Sequence / WhatsApp / Email / Calendar / Survey / Booking machinery and adds travel‑specific Prisma models (`TravelDiagnostic`, `Itinerary`, `TripMicrosite`, `VisaApplication`, `WebCheckin`, `CostMaster`, `RfuLeadProfile`, `TripParticipant`) plus a `[data-vertical="travel"]` themed CSS layer, a slim travel-focused sidebar, and a landing route at `/travel`. Phase 1 (6-week / 42-day commitment per `GlobusSoft_Response_15May2026.pdf` §B.14) ships TMC + RFU; Travel Stall and Visa Sure are explicitly out of Phase 1 (`Req Doc After Meeting.pdf` §1 — "Out of scope: Visa Sure, Travel Stall and any other brand") and follow in Phase 2.

---

## 2. Sub-vertical map

| Sub-vertical | Customer | Core entities | Key flows |
|---|---|---|---|
| **TMC** (Modern Classroom) | B2B — schools, trustees, principals, activity heads, teachers (Bangalore for first 12 months) | School Diagnostic, Trip, TripMicrosite, TripParticipant (student), PaymentPlan, RoomingAssignment, DocumentChecklist | Lead → school diagnostic → human consultation → prescription → quotation → trip confirmation → microsite generation → parent/student registration → operational execution → post-trip feedback (`TMC - CRM development.pdf` p1; `Req Doc After Meeting.pdf` §7 TMC B2B) |
| **RFU** (Ready for Umrah) | B2C — Muslim pilgrims (entry / standard / premium tiers) | RfuLeadProfile (12-question Readiness diagnostic, 4 levels), Itinerary (flight+hotel+transport+visa+insurance), CostMaster, JourneyReminder, PassportDocument | Ad/landing → readiness diagnostic → AI qualification call → advisor + tier-aware talking points → unified-search quotation engine → branded itinerary PDF → booking → Umrah journey reminders (driver/hotel/group/departure) (`RFU - CRM development.pdf`; `Ready_for_Umrah_Business_Blueprint.md (1).pdf` §3-§5) |
| **Travel Stall** | B2C — mid-range Indian families (₹3L–10L budget, "Tier-3 Mandeep model") | Family Travel Quiz, PersonalisedRecommendation, Itinerary (multi-destination), PassengerData, Ticketing | Family quiz → 3-5 AI-generated personalised recommendations → human consultation → quotation → 50% advance booking → execution → testimonial/referral. Leverages existing TMC/RFU/Visa customer database (500-1000 families) for email-first, zero-paid-ads acquisition (`Travel_Stall_Business_Blueprint_For_Tech_Team.md.pdf` §1-§3; `Travelstall - CRM development.pdf`) |
| **Visa Sure** | B2C / B2B mixed — visa applicants worried about rejection | VisaApplication, ReadinessDiagnostic (15Q, 4 levels), DocumentChecklist, RejectionHistory, AdvisorRiskFlag | 15-question readiness diagnostic → classification into 4 readiness levels → advisor with risk flags + diagnostic visibility → quotation (manual or structured by case complexity) → document upload checklist → application tracking → rejection-recovery program if applicable (`Visa Sure - CRM development.pdf`; `Visa_Sure_Business_Blueprint (1).pdf`) |

All four share the **"diagnostic-first, never destination-first"** principle and a **3-tier product ladder** (entry diagnostic free/low-fee → primary "Correctness Assured" mid-tier → premium "Private/Elder-Care/HNI" high-tier).

---

## 3. Source documents (sorted by implementation relevance)

**Tier A — implementation-critical (read end-to-end):**
- `Req Doc After Meeting.pdf` (23 pp) — the master feature brief; Section 12 is a row-by-row response matrix, Section 13 lists client deliverables, Section 14 lists GS deliverables. Authoritative scope source.
- `GlobusSoft_Response_15May2026.pdf` (12 pp) — Globussoft's signed-off response: 6-week plan, week-by-week exit gates, per-row effort estimates, commercials (₹2,50,000 + GST), Wati cost model, all 16 of Yasin's clarifications answered. The contract.
- `Understanding and clarifications - Yasin.pdf` (3 pp) — Yasin's 13-May email: 8 deliverable items + 16 clarification asks + 6 client-side decisions. Driver for the response doc.
- `TMC - CRM development.pdf` (2 pp) — TMC short-form requirements: school diagnostic, sales workflow, trip management, ops dashboard, accounting, analytics.
- `RFU - CRM development.pdf` (1 p) — RFU short-form: 15Q diagnostic, workflow automation, quotation engine, document mgmt, payment tracking, analytics.

**Tier B — sub-vertical business context (read to understand intent, not for line items):**
- `Ready_for_Umrah_Business_Blueprint.md (1).pdf` (11 pp) — RFU philosophy, 3-tier product ladder, Umrah Readiness Review (12 Qs across 5 sections), 4 named Readiness Levels (Confident & Prepared / Guided for Peace of Mind / Assisted for Comfort & Correctness / Premium / Elder-Care). Team split: marketing (Jihad) vs ops/CRM (tech).
- `TMC_Business_Blueprint_For_Tech_Team.md (1).pdf` (28 pp) — TMC philosophy, 3-tier ladder, School Readiness Diagnostic, deal sizes (₹8L-12L per trip, 20-25% gross margin), business metrics.
- `Travel_Stall_Business_Blueprint_For_Tech_Team.md.pdf` (46 pp) — Travel Stall Tier-3 positioning (Mandeep model), Family Travel Quiz, email-first acquisition leveraging TMC/RFU/Visa customer database.
- `Visa_Sure_Business_Blueprint (1).pdf` (12 pp) — Visa Sure philosophy mirrored on RFU.
- `Visa Sure - CRM development.pdf` (1 p) — short-form requirements.
- `Travelstall - CRM development.pdf` (1 p) — short-form requirements (B2C holidays + ticketing).

**Tier C — marketing / strategy (context only, do not derive requirements):**
- `The_4_Tier_Business_Model_Understanding_Market_Positioning_1.pdf` (10 pp) — the 4-tier market positioning meta-narrative (Tier 1 vs 2 vs 3 vs 4) that underlies all four brands' premium positioning.
- `TMC SALES FUNNEL.pdf` — TMC funnel diagram for marketing.
- `TMC_Digital_Marketing_Phase_1_and_2_Plan_2026.pdf` — TMC marketing plan, lead-magnet calendar.
- `TMC_Diagnostic_Landing_Page.pdf` — diagnostic landing-page design reference.
- `TMC Lead Magnets .docx` — lead-magnet inventory for TMC funnel.
- `TMC Website Architecture and Structure 2026.pdf` — TMC website IA (not the CRM; the public site that feeds it).
- `TMC_Founder_Pre_Send_Review_Memo_2026.pdf` — founder review notes on marketing collateral.
- `TRAFFIC ECOSYSTEM.pdf` — cross-brand traffic / referral ecosystem.

---

## 4. Functional requirements (deduplicated across the 4 sub-verticals)

> Every requirement cites the source. If a requirement is single-brand it is tagged; otherwise it applies to all four. "Reuse" entries point to existing CRM machinery — only the extension/binding work is new.

### 4.1 Lead intake + sales funnel

- **Multi-source enquiry capture** — website forms, diagnostic submissions, WhatsApp, phone, email, ad platforms (Instagram, Facebook, LinkedIn, YouTube), referrals, walk-ins, existing customers. Auto-source-tag every enquiry. (`Req Doc` §5; `Travelstall CRM` §1) — **REUSE** existing Contact + LeadRoutingRule + marketplace_leads webhooks. Add per-source UTM/handler bindings.
- **Rule-based brand assignment** (NOT AI in Phase 1) — by lead source + product fit → mapped to brand/agent. (`Req Doc` §5; `Response` A.8) — **REUSE** existing `routes/lead_routing.js`; extend rule schema to filter on `subBrand`.
- **8-status pipeline + 8 lost reasons (locked)** — Statuses: New, Qualified, Diagnostic pending, Consultation booked, Follow-up pending, Won, Lost, Dormant. Lost reasons: Price, No response, Chose competitor, Wrong requirement, Timing issue, Budget issue, Trust issue, Duplicate enquiry. (`Req Doc` §5; `Response` Part C) — **REUSE** existing Pipeline + PipelineStage; seed one travel-default pipeline per sub-brand.
- **Diagnostic-first guard** — across all four brands, customers MUST take the diagnostic before any package/price is shown. "NEVER skip the diagnostic" (`Travel Stall Blueprint` §3). Quotation routes must reject quote creation for a contact with no completed diagnostic in Phase 1. (`RFU Blueprint` §4.1: "packages and prices are never shown before the diagnosis is complete")
- **AI qualification call (Eng/Hin/Urdu with mid-call switching)** — Callified.ai / Exotel pipeline. Records, transcribes, summarises, attaches summary to the lead. Gated to ad/marketing leads only in Phase 1 (organic, referral, walk-in → advisor directly). Pre-call TRAI disclosure mandatory. (`Req Doc` §7; `Response` B.5) — **REUSE** existing routes/voice.js + voice_transcription.js + Sentry; add Callified.ai client wrapper service.
- **Form-vs-call answer comparison + mismatch flag** — threshold ≥80% = MATCH, 60-80% = REVIEW (yellow), <60% = MISMATCH (red, blocking). Compact panel: form | call | confidence | suggested follow-up. Actions: ask customer (draft WA/email), override-with-form, override-with-call, mark-resolved. All actions logged. (`Req Doc` §7; `Response` B.11)
- **AI-to-advisor handover (B2C)** — configurable trigger; advisor notified via WhatsApp + CRM alert. (`Req Doc` §12 row)
- **Manager view** — pending tasks, delayed tasks, staff-wise workload across brands. (`Req Doc` §5; §12) — **REUSE** existing routes/staff.js + dashboards.
- **Lead source attribution + UTM tracking** through to closure. (`Req Doc` §5 marketing module)

### 4.2 Diagnostic engine (cross-cutting, every sub-vertical)

The diagnostic engine is the single biggest new build. It powers TMC's school diagnostic, RFU's Umrah Readiness Review, Visa Sure's 15Q readiness check, and Travel Stall's Family Travel Quiz. (`Response` A.8: 6 engineer-days in W2)

- **Diagnostic builder** — editable question bank per sub-brand, supports multiple-choice + scale + text + branching. (`TMC CRM` §1; `Visa Sure CRM` §1; `RFU CRM` §1)
- **Weighted scoring engine** — per-answer weight, summed/averaged to a score, mapped to a classification band. Editable from admin panel **— Phase 1: view-only with "request change" button routing a ticket to GS** (`Response` A.6 — protects 90-day analytics baseline). Phase 1.5: edit-with-audit + sandbox.
- **Classification bands** — 4 named levels per brand (RFU: Confident & Prepared / Guided for Peace of Mind / Assisted for Comfort & Correctness / Premium-Elder-Care; Visa Sure: 4 readiness levels; TMC: curriculum-readiness levels TBD). Levels drive both the advisor talking points and the product/tier recommended on the quotation.
- **Auto-generated branded PDF report** — sub-brand logo/colors/fonts; sent by WhatsApp + email immediately on completion. (`Req Doc` §6) — **REUSE** existing `backend/services/pdfRenderer.js`; add per-sub-brand templates.
- **Auto CRM record creation** — diagnostic submission creates a Contact + a TravelDiagnostic record + a Lead in `Diagnostic pending` → moves to `Qualified` on score. (`RFU CRM` §1)
- **Curriculum mapping logic** (TMC-only) — diagnostic answers map to curriculum alignment recommendations. (`TMC CRM` §1)
- **Risk flagging** (Visa Sure-specific) — complex case flag, rejection-history tag, advisor priority alert. (`Visa Sure CRM` §2)
- **LLM-generated talking points per advisor** — given diagnostic answers + classification + brand, generate context-aware advisor briefing. Multi-LLM switchable (Perplexity for search/citation; Claude for reasoning + talking points; Gemini Flash for bulk text + call summary; GPT as fallback). Defaults admin-editable per task class. (`Response` B.7)
- **AI summary notes** (Visa Sure-specific, optional) — advisor dashboard surfaces AI summary alongside diagnostic answers. (`Visa Sure CRM` §3)

### 4.3 Itinerary / package builder

- **RFU Umrah quotation engine (unified search)** — flight + hotel + transport in one screen, returns branded itinerary; rule-based markup/GST/discount logic (NO AI in markup); LLM-switchable layer for search/reasoning; auto-generated branded itinerary; WhatsApp/email delivery; version history (draft / sent / revised / accepted / rejected). (`Req Doc` §9; `Response` A.8 — 7d in W3) — partially overlaps with existing `routes/cpq.js` but custom build (CPQ ships product line items only, not multi-product trip composition).
- **Hotel rate comparator** — RateHawk (B2B wholesaler, P1) + manual contracted rates (P1 from W3) + Booking.com/Expedia direct (Phase 1.5 once contracts close, 4-8 wk). Lowest applicable rate auto-selected. (`Req Doc` §9; `Response` B.3)
- **Preference filters (RFU-specific)** — Haram-facing / Kaaba-facing view, room category, floor level. Preference data stored in hotel master + customer profile. (`Req Doc` §9)
- **Rule-based transport pricing with seasonal logic** — point-to-point rates × peak/lean season calendar. No AI. Admin-editable. (`Req Doc` §9)
- **Cost master admin panel** — contracted hotel rates, transport rate cards, seasonal calendars, visa fees, insurance. Editable by admin only. (`Req Doc` §9)
- **Branded itinerary PDF with version history** — every revision retrievable. Status: draft/sent/revised/accepted/rejected. (`Req Doc` §9 RFU; `Travel Stall` §10) — **REUSE** existing `services/pdfRenderer.js` + add version_history table per Itinerary.
- **Flight Quotation Chrome plugin** — extracts segment/timing/carrier/fare/baggage from Google Flights in one click, applies per-airline/per-route/per-fare-bucket markup rule, generates branded quote (up to 4 options), one-click WhatsApp share. Agent-level markup config + admin panel inside CRM. Distributed via private signed CRX (NOT Chrome Web Store), polled auto-update every 4-6h, force-update flag + 30-day rollback. (`Req Doc` §8; `Response` B.8)
- **Trip itinerary template per TMC trip** — used when confirming a school trip; powers the auto-generated microsite. (`Req Doc` §11)

### 4.4 Quote / invoice / payment

- **Quotation upload (Travel Stall-specific)** — manual quote attachment to a lead. (`Travelstall CRM` §2) — **REUSE** existing ContactAttachment + Quote.
- **Manual or structured quotation (Visa Sure)** — depending on case complexity. (`Visa Sure CRM` §4) — **REUSE** existing Quote / CPQ; gate "structured" mode on case-complexity flag.
- **Invoice generation with GST capture** — CGST, SGST, IGST as applicable; receipt per payment; refund with reason codes. (`Req Doc` §11) — **REUSE** existing `routes/billing.js` + Invoice model; extend with `cgstAmount` / `sgstAmount` / `igstAmount` fields if not already present.
- **CA / Tally export** — exportable financial reports; light accounting only (full automation OUT OF SCOPE). (`Req Doc` §11; `RFU CRM` §5) — **REUSE** existing audit_viewer.js + add Tally-XML and CA-CSV exporters.
- **Excel Software for Travel bridge** — P1: file import; P1.5: API once docs available. (`Response` Part C)
- **Per-entity payment tracking** — linked to correct legal entity (TMC Nexus / Labbaik / Travel Stall / Visa Sure entity TBD). Each Invoice carries entity tag. (`RFU CRM` §5; `Travelstall CRM` §4)
- **Payment plan tracking (TMC-specific)** — per-student instalments, due dates, paid status, pending amount, WhatsApp+email reminders on due date + overdue. (`Req Doc` §11; `TMC CRM` §3) — **REUSE** existing Payment model + Sequence engine; new TripPaymentPlan + Instalment models.

### 4.5 Booking + supplier coordination

- **Trip / Booking record** (TMC-specific) — auto-created on trip confirmation; spawns microsite, registration portal, payment plan, document checklist, rooming. (`Req Doc` §11; `TMC CRM` §3) — **REUSE** existing Booking model; extend with `tripCode`, `microsite Url`, `legalEntity` fields.
- **TMC confirmed-trip microsite** — `trip-<code>.tmc.travelstall.in` (e.g. `trip-bali2026.tmc.travelstall.in`). Public itinerary view: link-only, UUID-per-trip, no login. Sensitive views (payment, docs, registration): 4-digit OTP via WhatsApp, 10-min validity. Teacher access: separate OTP link with read-only student list + rooming. (`Req Doc` §11; `Response` B.9) — extend existing `services/landingPageRenderer.js`.
- **Parent / teacher registration portal** — collects student data, passport upload with OCR + manual verification, Aadhaar OCR via **DigiLocker** (recommended path; signed Aadhaar XML; store masked last-4 + token only). Consent: explicit checkbox at start; record stored with timestamp/IP/token; 24-month retention; in-app withdrawal triggers retention-end workflow. (`Req Doc` §11; `Response` B.10)
- **Rooming allocation interface** + downloadable rooming list (single/twin/triple). (`TMC CRM` §3)
- **Departure checklist** + per-student document checklist. (`TMC CRM` §3; `Req Doc` §11)
- **RFU customer database** — full profile: full name, contact, DOB, family members, passport details + expiry, visa history, document history, frequent flyer numbers, seat + meal preferences, travel history, budget range, travel style, emergency contact, medical notes, special assistance, past complaints. (`Req Doc` §11)
- **Customer-duplicate detection** — basic dedupe (name + phone + passport) in P1; full pop-up flow with preferences in Phase 2. (`Response` A.5) — **REUSE** existing `utils/deduplication.js`; extend match keys to include passport number.
- **Login vault** — secure storage of supplier and operational portal logins (flights, visa, hotels, consolidators, GDS, insurance, transport, activities, payment gateways, government portals). Masking, role access, audit logs, AES-256 encryption at rest. (`Req Doc` §4; `Response` A.8 — 2d Dev) — **REUSE** existing `lib/fieldEncryption.js` (wellness PII helper) for AES-256-GCM; new SupplierCredential model + dedicated /vault routes.

### 4.6 Web check-in (cross-cutting, mostly TMC + RFU)

- **P1A — tracking + delivery (committed)** — auto-scheduled check-in window per airline (typically T-48h or T-24h); WA + email reminder to passenger; agent task auto-created; agent uploads boarding pass; auto-delivered to passenger by WA + email; PNR/seat/meal pulled from booking record; dashboard of check-in status. (`Req Doc` §10; `Response` A.8)
- **P1B — top-4 airline automation** — IndiGo, Air India / AI Express, Vistara, Emirates (Tier 1, committed W4, 6d). Tier 2 (SpiceJet, Akasa, Etihad, Saudia, Qatar, Air Arabia) → Phase 1.5 (1-2d each). Captcha-heavy (Lufthansa, Turkish) → Phase 2 / MCP. (`Response` B.1)
- **Fallback** — 2 failed retries within 30 min → agent task with failure reason + manual-checkin action. Portal-down >2h → all that-carrier passengers go to agents immediately. (`Response` B.1)
- **Boarding-pass auto-delivery** by WhatsApp + email. (`Req Doc` §10)

### 4.7 Visa documents + compliance (Visa Sure + cross-cutting docs)

- **Structured document checklist + status tracking** — per visa type / per passenger. (`Visa Sure CRM` §5; `RFU CRM` §4)
- **Passport OCR + secure storage** — auto-extract on upload; encrypted store; role-based access (only assigned advisor + ops role can view passport / Aadhaar / financial). (`Req Doc` §11)
- **Document security model** (binding across all four sub-brands):
  - Region: **AWS Mumbai (ap-south-1) multi-AZ**; DR replica in Singapore (DR-access only). (`Response` B.2)
  - Encryption: AES-256 at rest (KMS, per-tenant keys, 365-day rotation); TLS 1.3 in transit.
  - Audit log: 24 months online + 36 months cold; every view/download/share/edit/delete logged.
  - Dynamic watermark: viewer name + email + timestamp on every rendered doc.
  - Share-link expiry: default 7 days, max 30, per-role configurable, revoke-anytime.
  - Backup: 30-day PIT; 12-month archival snapshots; quarterly restore test.
  - Retention by type: passport 24m post-trip; call recording 12m; financial 84m; diagnostic responses = lifetime of profile.
- **Rejection-recovery program** (Visa Sure-specific) — tagged workflow for previously-rejected applicants; tracks rejection history. (`Visa Sure CRM` product ladder item 3)
- **Aadhaar OCR** — DigiLocker preferred; offline KYC fallback; direct OCR not recommended (Aadhaar Act risk). (`Response` B.10)

### 4.8 Customer communications

Almost entirely reuse of the existing CRM machinery.

- **Embedded WhatsApp Web for staff** — conversation logging. (`Req Doc` §4) — **REUSE** existing routes/whatsapp.js + Wati BSP integration.
- **WhatsApp Business API for automation** — reminders, follow-ups, file delivery, template messages. Single Wati Business account (₹10,999/mo) with 3 WABA numbers (TMC, RFU, ops-shared). Meta per-message rates apply (utility ~₹0.115, marketing ~₹0.8631 — Jan-2026 rates, +10% from prior). Wati 20% markup on Meta charges. Template approval: utility 24-48h, marketing 48-72h, auth 24h. (`Response` B.4)
- **Email** — Gmail + Mailgun + Nodemailer + IMAP. (`Req Doc` §4 Workspace) — **REUSE** existing email machinery wholesale.
- **Calendar / Meet booking** — Google Workspace OAuth. Consultation platform: **Google Meet** (recommended per `Response` Part C; no extra licence; native calendar inside Workspace). (`Req Doc` §12)
- **Drive folder auto-creation for confirmed TMC trips** — naming convention from input pack; folder created on confirmed-trip CRM trigger. (`Req Doc` §4; `Response` A.8 — 1d W2)
- **Umrah journey reminders** (RFU-specific) — driver, hotel, group, departure milestones. (`Req Doc` §11) — **REUSE** existing Sequence + scheduledEmailEngine + Wati templates.
- **Religious-guidance content delivery** (RFU-specific) — links from a curated content library, scheduled delivery. (`Req Doc` §11)
- **Trip reminders + post-trip feedback form** (TMC-specific) — auto-triggered after return date. (`Req Doc` §11) — **REUSE** existing Survey + SurveyResponse.
- **Birthday / anniversary greetings** — Phase 2 (`Response` Part C). 1-2d plug-in. — **REUSE** existing scheduledEmail + Wati when added.

### 4.9 Reports / dashboards

- **Management dashboard KPIs (cross-brand)** — leads by brand/source/status; diagnostics started/completed/converted; AI calls made / qualified leads / consultations booked; tasks pending/overdue/staff-wise workload; won+lost with lost-reason breakdown; campaign performance and lead-source attribution; confirmed-trip ops snapshot (TMC). (`Req Doc` §11; §12 — 2d Dev W5)
- **TMC analytics** — revenue by destination, repeat school rate, profit margin by trip, conversion by diagnostic score. (`Req Doc` §11; `TMC CRM` §6) — **REUSE** existing routes/reports.js + custom_reports.js + dashboards.
- **RFU analytics** — revenue by tier, conversion by tier, repeat customer rate. (`Req Doc` §11; `RFU CRM` §6)
- **Travel Stall analytics** — revenue by destination, conversion rate by channel, salesperson performance. (`Travelstall CRM` §5)
- **Visa Sure analytics** — rejection-recovery success rate, conversion by readiness level, lead source → application rate. (`Visa Sure CRM` §6)
- **Platform-wise marketing reports** — posts / reach / engagement / video views / CTR / open rate / leads generated / CPL / conversion-to-qualified per platform. (`Req Doc` §5; §12 — AdsGPT integration)
- **TMC ops dashboard per confirmed trip** — student count vs target, pending payments, missing documents, rooming status, departure-readiness score. (`Req Doc` §11)

### 4.10 Sub-vertical-specific call-outs

- **TMC** — diagnostic-first positioning ("not destination-first"); curriculum mapping logic; school database integration; teacher access portal (rooming + student list, OTP-protected); GST + accounting CA export.
- **RFU** — product-tier tagging (4 levels) drives quotation tier; Haram-facing hotel filters; LLM-switchable layer for quotation engine; Aadhaar OCR via DigiLocker; passport OCR; religious-guidance content library; Umrah journey reminders.
- **Travel Stall** — Family Travel Quiz; personalised 3-5 recommendations PDF; 50% advance booking pattern; email-first acquisition (zero paid ads model).
- **Visa Sure** — 15Q readiness assessment; rejection-recovery program; advisor risk dashboard; complex-case flagging; manual quotation route for complex cases.

---

## 5. Data model — new Prisma models

> All travel-vertical models scope to `tenantId` (same multi-tenant pattern as wellness models). All money fields use `Decimal @db.Decimal(18,4)` for INR-safety. All JSON columns use `String? @db.Text` per the standing rule in `CLAUDE.md`.

### 5.1 New models

```prisma
// 4.2 Diagnostic engine — shared across all sub-brands
model TravelDiagnostic {
  id            String   @id @default(cuid())
  tenantId      String
  subBrand      String   // "tmc" | "rfu" | "travelstall" | "visasure"
  contactId     String?  // back-link if known at submission; else captured midway
  leadId        String?  // links to Deal/Lead in pipeline
  questionsJson String   @db.Text           // immutable snapshot of Q-bank at submission
  answersJson   String   @db.Text           // {qid: answer}
  score         Decimal? @db.Decimal(10,4)
  classification String?                    // "level_1" .. "level_4"
  classificationLabel String?               // "Confident & Prepared" etc
  recommendedTier String?                   // "entry" | "primary" | "premium"
  reportPdfUrl  String?                     // generated PDF
  talkingPointsJson String? @db.Text        // LLM-generated advisor brief
  consentCapturedAt DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([tenantId, subBrand, contactId])
}

model TravelDiagnosticQuestionBank {
  id         String @id @default(cuid())
  tenantId   String
  subBrand   String
  version    Int    @default(1)
  questionsJson  String @db.Text   // ordered Qs + weights + branching rules
  scoringRulesJson String @db.Text // band thresholds + classification labels
  isActive   Boolean @default(true)
  createdAt  DateTime @default(now())
  @@index([tenantId, subBrand, isActive])
}

// 4.3 Itinerary — RFU + Travel Stall multi-product trips
model Itinerary {
  id           String   @id @default(cuid())
  tenantId     String
  subBrand     String
  contactId    String
  leadId       String?
  status       String   @default("draft")   // draft|sent|revised|accepted|rejected
  version      Int      @default(1)
  parentItineraryId String?                 // version-history chain
  destination  String
  startDate    DateTime?
  endDate      DateTime?
  pricingJson  String?  @db.Text            // breakdown
  totalAmount  Decimal? @db.Decimal(18,4)
  currency     String   @default("INR")
  pdfUrl       String?
  shareToken   String?  @unique             // WA/email share
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  items        ItineraryItem[]
  @@index([tenantId, subBrand, contactId, status])
}

model ItineraryItem {
  id          String   @id @default(cuid())
  itineraryId String
  itemType    String   // "flight"|"hotel"|"transfer"|"activity"|"visa"|"insurance"
  position    Int
  description String
  detailsJson String?  @db.Text             // type-specific payload
  supplierId  String?
  unitCost    Decimal? @db.Decimal(18,4)
  markup      Decimal? @db.Decimal(18,4)
  gstAmount   Decimal? @db.Decimal(18,4)
  totalPrice  Decimal? @db.Decimal(18,4)
  itinerary   Itinerary @relation(fields: [itineraryId], references: [id], onDelete: Cascade)
  @@index([itineraryId])
}

// 4.3 Cost master — supplier rates + seasonal calendar (RFU first)
model TravelCostMaster {
  id          String   @id @default(cuid())
  tenantId    String
  subBrand    String
  category    String   // "hotel"|"flight"|"transport"|"visa"|"insurance"
  supplierId  String?
  routeOrSku  String   // "MAA-JED" or "Makkah:Hilton:Deluxe-HaramFacing"
  attributesJson String? @db.Text // floor/view/room category for hotels
  baseRate    Decimal  @db.Decimal(18,4)
  currency    String   @default("INR")
  seasonId    String?
  validFrom   DateTime?
  validTo     DateTime?
  isActive    Boolean  @default(true)
  @@index([tenantId, subBrand, category, isActive])
}

model TravelSeasonCalendar {
  id         String   @id @default(cuid())
  tenantId   String
  subBrand   String
  seasonName String   // "peak" | "lean" | "ramadan-peak" | "school-holiday"
  startDate  DateTime
  endDate    DateTime
  multiplier Decimal? @db.Decimal(6,4)      // optional uniform multiplier
  @@index([tenantId, subBrand, startDate, endDate])
}

model TravelMarkupRule {
  id         String @id @default(cuid())
  tenantId   String
  subBrand   String
  scope      String  // "flight"|"hotel"|"transport"|"package"
  matchKeyJson String @db.Text              // airline+route+fareBucket / hotel+city / route
  markupPct  Decimal? @db.Decimal(6,4)
  markupFlat Decimal? @db.Decimal(18,4)
  ownerUserId String?                       // agent-level markup (flight plugin)
  priority   Int    @default(100)
  isActive   Boolean @default(true)
  @@index([tenantId, subBrand, scope, isActive])
}

// 4.5 TMC trip — extends existing Booking with trip-specific bits
model TmcTrip {
  id            String   @id @default(cuid())
  tenantId      String
  tripCode      String   @unique             // "bali2026"
  schoolContactId String                     // FK Contact (B2B school)
  destination   String
  departDate    DateTime
  returnDate    DateTime
  legalEntity   String   @default("tmc_nexus")
  micrositeUrl  String?
  micrositeUuid String?  @unique
  pricePerStudent Decimal? @db.Decimal(18,4)
  status        String   @default("confirmed") // confirmed|in-trip|completed
  driveFolderId String?
  createdAt     DateTime @default(now())
  participants  TripParticipant[]
  rooming       RoomingAssignment[]
  paymentPlan   TripPaymentPlan?
  documentRequirements TripDocumentRequirement[]
  @@index([tenantId, status])
}

model TripParticipant {
  id            String  @id @default(cuid())
  tripId        String
  fullName      String
  passportNumber String?
  passportExpiry DateTime?
  passportDocId  String?                     // ContactAttachment id
  aadhaarLast4   String?
  aadhaarTokenId String?                     // DigiLocker token, encrypted
  parentName     String?
  parentPhone    String?
  parentEmail    String?
  medicalNotes   String? @db.Text
  consentCapturedAt DateTime?
  trip          TmcTrip @relation(fields: [tripId], references: [id], onDelete: Cascade)
  @@index([tripId])
}

model RoomingAssignment {
  id        String @id @default(cuid())
  tripId    String
  roomNumber String
  roomType  String  // single|twin|triple
  participantIds String @db.Text  // JSON array of TripParticipant ids
  trip      TmcTrip @relation(fields: [tripId], references: [id], onDelete: Cascade)
  @@index([tripId])
}

model TripPaymentPlan {
  id        String @id @default(cuid())
  tripId    String @unique
  instalmentsJson String @db.Text  // [{dueDate, amount, reminderDays}]
  graceDays Int @default(0)
  trip      TmcTrip @relation(fields: [tripId], references: [id], onDelete: Cascade)
}

model TripInstalmentPayment {
  id         String @id @default(cuid())
  tripId     String
  participantId String
  instalmentIndex Int
  dueDate    DateTime
  amount     Decimal @db.Decimal(18,4)
  paidAmount Decimal @default(0) @db.Decimal(18,4)
  paidAt     DateTime?
  invoiceId  String?
  status     String @default("pending") // pending|partial|paid|overdue
  @@index([tripId, status])
}

model TripDocumentRequirement {
  id        String  @id @default(cuid())
  tripId    String
  docType   String  // "passport"|"aadhaar"|"medical-form"|"consent-form"|"school-id"
  required  Boolean @default(true)
  trip      TmcTrip @relation(fields: [tripId], references: [id], onDelete: Cascade)
  @@index([tripId])
}

// 4.6 Web check-in
model WebCheckin {
  id           String   @id @default(cuid())
  tenantId     String
  contactId    String
  itineraryId  String?
  pnr          String
  airlineCode  String
  flightNumber String
  departureAt  DateTime
  windowOpenAt DateTime                       // T-48h or T-24h
  passengerName String
  seatPref     String?
  mealPref     String?
  status       String   @default("pending")   // pending|reminded|in-progress|done|fallback-agent|failed
  attemptsJson String?  @db.Text              // [{at, result, errorReason}]
  boardingPassUrl String?
  deliveredAt  DateTime?
  assignedAgentId String?
  @@index([tenantId, status, windowOpenAt])
}

// 4.5 Supplier credentials — login vault
model SupplierCredential {
  id        String @id @default(cuid())
  tenantId  String
  category  String  // "airline"|"hotel"|"gds"|"visa-portal"|"payment-gateway"|"insurance"|"government"
  supplierName String
  loginIdEncrypted String @db.Text   // AES-256-GCM via lib/fieldEncryption
  passwordEncrypted String @db.Text
  metadataJson String? @db.Text       // 2FA backup codes, MFA seed, notes
  ownerUserId  String?
  createdAt    DateTime @default(now())
  lastUsedAt   DateTime?
  @@index([tenantId, category])
}

model SupplierCredentialAccessLog {
  id        String @id @default(cuid())
  credentialId String
  userId    String
  action    String   // "viewed"|"used-in-checkin"|"rotated"|"deleted"
  at        DateTime @default(now())
  ip        String?
  @@index([credentialId, at])
}

// 4.7 Visa Sure
model VisaApplication {
  id           String   @id @default(cuid())
  tenantId     String
  contactId    String
  applicationType String  // "tourist"|"business"|"student"|"work"|"umrah"|"hajj"
  destinationCountry String
  status       String   @default("intake")  // intake|docs-pending|filed|approved|rejected|appeal
  readinessLevel Int?                         // 1-4 from diagnostic
  complexCase  Boolean  @default(false)
  rejectionHistoryJson String? @db.Text       // [{country, date, reason}]
  advisorRiskFlag String?                     // null|"low"|"medium"|"high"|"priority"
  filedAt      DateTime?
  decidedAt    DateTime?
  outcome      String?                        // null|"approved"|"rejected"
  outcomeReason String? @db.Text
  recoveryProgramId String?                   // links to Rejection Recovery program enrolment
  @@index([tenantId, status, advisorRiskFlag])
}

model VisaDocumentChecklistItem {
  id         String @id @default(cuid())
  applicationId String
  docType    String
  required   Boolean @default(true)
  status     String  @default("pending")     // pending|uploaded|verified|rejected
  attachmentId String?
  notes      String? @db.Text
  @@index([applicationId, status])
}

// 4.1 RFU customer profile extension
model RfuLeadProfile {
  id           String   @id @default(cuid())
  tenantId     String
  contactId    String   @unique
  passportNumber String?
  passportExpiry DateTime?
  visaHistoryJson String? @db.Text
  frequentFlyerJson String? @db.Text
  seatPref     String?
  mealPref     String?
  travelStyle  String?
  budgetMin    Decimal? @db.Decimal(18,4)
  budgetMax    Decimal? @db.Decimal(18,4)
  emergencyContactName String?
  emergencyContactPhone String?
  medicalNotes String? @db.Text
  specialAssistance String? @db.Text
  pastComplaintsJson String? @db.Text
  productTier  String?                       // entry|primary|premium
  @@index([tenantId, productTier])
}

// 4.5 Trip microsite (TMC) — public, OTP-gated for sensitive views
model TripMicrosite {
  id             String   @id @default(cuid())
  tenantId       String
  tripId         String   @unique
  publicUuid     String   @unique
  subdomain      String                       // "trip-bali2026"
  itineraryHtml  String   @db.Text
  faqJson        String?  @db.Text
  publishedAt    DateTime?
  expiresAt      DateTime?
  @@index([tenantId, subdomain])
}

model TripMicrositeOtp {
  id          String @id @default(cuid())
  micrositeId String
  phone       String
  purpose     String   // "registration"|"payment-plan"|"document-checklist"|"teacher-access"
  otpHash     String
  expiresAt   DateTime
  usedAt      DateTime?
  @@index([micrositeId, phone, purpose])
}
```

### 5.2 Extensions to existing models

- **Tenant** — `vertical` column already exists as `String @default("generic")`. Add the value `"travel"` in the seed + a `subBrandConfigJson` JSON column to store per-sub-brand WhatsApp number / Wati WABA / legal entity / GST registration / Drive folder root. (No schema migration needed for vertical; addition of `subBrandConfigJson` is a new column.)
- **Contact** — add nullable `subBrand` String for tagging which sub-vertical the contact entered through (analytics use). Existing `tenantId` already isolates.
- **Deal** — add nullable `subBrand` + `diagnosticId` (FK to TravelDiagnostic). Reuse `pipelineId` for the 8-status travel pipeline.
- **Booking** — extend with optional `tripId` (FK TmcTrip) + `itineraryId` (FK Itinerary) to bridge to the new travel models without forking.
- **Invoice** — already has `tenantId`, `amount`, `currency`. Add optional `legalEntityCode` (e.g. `tmc_nexus`, `labbaik_travels`) so a single tenant can issue invoices under different GST registrations.
- **User** — add nullable `subBrandAccess` JSON array (`["tmc","rfu"]`) to support brand-level access control inside one tenant.

### 5.3 Reuse decisions (explicit)

| Need | Decision | Reasoning |
|---|---|---|
| Contact / Lead | **REUSE** existing Contact; add `subBrand` tag | Contact dedupe + audit + GDPR already work |
| Sales pipeline | **REUSE** Pipeline / PipelineStage; seed travel-default pipeline per sub-brand | 8-status mapping is just stage rows |
| Quote / line items | **REUSE** Quote / QuoteLineItem for simple quotes; NEW Itinerary / ItineraryItem for RFU multi-product trip composition | Quote model lacks polymorphic items + version chain |
| Invoice + Payment | **REUSE** Invoice + Payment; add `legalEntityCode` | GST + refund already supported |
| Email / WA / SMS / Calendar | **REUSE** wholesale | Most expensive surface; no work needed beyond Wati WABA config |
| Drive integrations | **REUSE** existing calendar_google.js patterns; add Drive client | 1d new |
| Sequence / drip | **REUSE** Sequence + scheduledEmailEngine for journey reminders, payment-plan reminders, post-trip feedback | Templates only |
| Survey / Feedback | **REUSE** Survey + SurveyResponse for post-trip feedback | Templates only |
| ChatbotConversation | **REUSE** for AI qualification call transcript attachment | New Callified.ai integration writes here |
| Audit log | **REUSE** AuditLog + audit_viewer.js | Mandatory for B.2 document-security audit trail |
| PDF rendering | **REUSE** services/pdfRenderer.js | Add per-sub-brand templates only |
| Sentry | **REUSE** existing wrapper | No change |
| RBAC | **REUSE** verifyToken + verifyRole; add `subBrandAccess` filter at route layer | One middleware addition |

---

## 6. Route plan

All routes under `backend/routes/`, mounted at `/api/...` per existing pattern.

### 6.1 New route files

| File | Endpoints | Notes |
|---|---|---|
| `travel.js` | `GET /api/travel/dashboard`, `GET /api/travel/sub-brands`, `POST /api/travel/sub-brands/:code/switch` | Cross-sub-brand summary; brand-switcher |
| `travel_diagnostics.js` | `GET /api/travel/diagnostics/banks`, `POST /api/travel/diagnostics/banks` (admin), `POST /api/travel/diagnostics/submit` (public + auth variants), `GET /api/travel/diagnostics/:id`, `GET /api/travel/diagnostics/:id/report.pdf`, `POST /api/travel/diagnostics/:id/talking-points/regen` | Public submit endpoint for landing-page integration; needs CORS + rate-limit per existing public webhook pattern |
| `travel_itineraries.js` | `POST /api/travel/itineraries`, `GET /api/travel/itineraries/:id`, `PUT /api/travel/itineraries/:id` (creates new version, links via `parentItineraryId`), `POST /api/travel/itineraries/:id/share` (WA + email), `GET /api/travel/itineraries/:id/pdf`, `POST /api/travel/itineraries/:id/accept`, `POST /api/travel/itineraries/:id/reject` | Version chain server-side |
| `travel_quotation_flight.js` | `POST /api/travel/quotations/flight/extract` (Chrome plugin webhook; takes Google Flights page snapshot or structured JSON), `POST /api/travel/quotations/flight/render` (applies markup, returns branded PDF + WhatsApp link), `GET /api/travel/markup-rules`, `POST /api/travel/markup-rules` (admin/user-scoped per agent) | Chrome plugin auth via per-user signed token |
| `travel_cost_master.js` | `GET/POST/PUT /api/travel/cost-master`, `GET/POST/PUT /api/travel/cost-master/seasons` | Admin-only; per-sub-brand scope |
| `travel_supplier_vault.js` | `POST /api/travel/vault/credentials`, `GET /api/travel/vault/credentials/:id/use` (logs access; returns decrypted only with role check), `DELETE /api/travel/vault/credentials/:id` | Role-gated; every access logged |
| `travel_trips.js` (TMC) | `POST /api/travel/tmc/trips` (creates Trip + microsite + Drive folder), `GET /api/travel/tmc/trips/:id`, `GET /api/travel/tmc/trips/:id/ops-dashboard`, `POST /api/travel/tmc/trips/:id/participants`, `GET /api/travel/tmc/trips/:id/rooming`, `POST /api/travel/tmc/trips/:id/rooming/auto`, `GET /api/travel/tmc/trips/:id/rooming.xlsx` (export) | Generates microsite UUID + tripCode-keyed subdomain on confirm |
| `travel_trip_microsite_public.js` | `GET /p/trip/:uuid` (public itinerary), `POST /p/trip/:uuid/otp/request`, `POST /p/trip/:uuid/otp/verify`, `GET /p/trip/:uuid/registration` (OTP-gated), `POST /p/trip/:uuid/registration/submit` (Aadhaar OCR + passport OCR + consent) | Public; rate-limited; CORS-narrow to microsite subdomain |
| `travel_payment_plans.js` | `POST /api/travel/tmc/trips/:tripId/payment-plan`, `GET .../instalments/:participantId`, `POST .../record-payment` (creates Invoice), `POST .../trigger-reminders` (admin) | Reminder cron handles auto |
| `travel_webcheckin.js` | `GET /api/travel/webcheckin/upcoming`, `POST /api/travel/webcheckin/:id/attempt-auto` (triggers automation engine for top-4 airlines), `POST /api/travel/webcheckin/:id/upload-boarding-pass`, `POST /api/travel/webcheckin/:id/deliver` (WA + email) | Cron creates the records at T-48h/T-24h |
| `travel_visa.js` (Visa Sure) | `POST /api/travel/visa/applications`, `GET /api/travel/visa/applications/:id`, `POST .../docs`, `POST .../file`, `POST .../decide` (approved/rejected/appeal), `POST .../recovery-program/enrol` | Status-machine enforced server-side |
| `travel_callified.js` | `POST /api/travel/callified/webhook` (call-end webhook from Callified.ai; persists transcript + summary + form-vs-call comparison), `POST /api/travel/callified/initiate` (admin/agent initiates call), `GET /api/travel/callified/calls/:id` | Form-vs-call mismatch detection runs on webhook receipt |

### 6.2 Reused routes (no change beyond seed templates / per-sub-brand config)

`auth.js`, `contacts.js`, `deals.js`, `pipelines.js`, `tasks.js`, `notifications.js`, `email.js`, `whatsapp.js`, `sms.js`, `calendar_google.js`, `cpq.js`, `quotes.js`, `billing.js` (Invoice), `payments.js`, `sequences.js`, `surveys.js`, `audit_viewer.js`, `landing_pages.js`, `ai.js`, `voice.js`, `voice_transcription.js`, `staff.js`, `lead_routing.js`, `marketplace_leads.js` (webhook for IndiaMART-style aggregators if applicable), `signatures.js` (consent forms).

### 6.3 New cron engines (`backend/cron/`)

| Engine | Cadence | Purpose |
|---|---|---|
| `webCheckinScheduler.js` | every 15 min | scan upcoming bookings; create WebCheckin records at T-48h / T-24h; queue WA + email reminder |
| `webCheckinAutomation.js` | event-driven (window-opened) | for top-4 airlines, attempt browser-automation login + check-in; fallback to agent on 2 retries / 30 min |
| `tripPaymentReminders.js` | daily 09:00 IST | scan TripInstalmentPayment for due/overdue; queue WA + email reminders |
| `travelJourneyReminders.js` | every 30 min | RFU Umrah journey reminders (driver / hotel / group / departure milestones) |
| `tripPostTripFeedback.js` | daily 06:00 IST | trigger SurveyResponse invitations 24h after trip return |
| `travelDiagnosticAdvisorAlerts.js` | every 5 min | on completed diagnostic with no advisor outreach in 30 min, escalate |

---

## 7. Frontend page plan

All pages under `frontend/src/pages/travel/`, code-split via React.lazy() per existing pattern. Sub-brand context lives in `AuthContext` (current user's `subBrandAccess` array).

| Page | Path | Notes |
|---|---|---|
| `Dashboard.jsx` | `/travel` | Landing; cross-sub-brand KPIs + sub-brand switcher |
| `Leads.jsx` | `/travel/leads` | Unified lead list filtered by `subBrand` + status |
| `LeadDetail.jsx` | `/travel/leads/:id` | Contact + diagnostic + AI call transcript + form-vs-call mismatch panel + talking points |
| `DiagnosticBuilder.jsx` | `/travel/admin/diagnostics` | Admin: Q-bank editor; Phase 1 = view-only with "request change" button |
| `DiagnosticPreview.jsx` | `/travel/diagnostics/preview/:bankId` | Internal preview of the question flow |
| `DiagnosticPublic.jsx` | `/p/diagnostic/:subBrand/:bankId` | PUBLIC route (no auth); the customer-facing diagnostic |
| `ItineraryBuilder.jsx` | `/travel/itineraries/new` | RFU unified-search quotation engine — flight + hotel + transport in one screen |
| `ItineraryDetail.jsx` | `/travel/itineraries/:id` | Version history; status; share/accept/reject |
| `CostMaster.jsx` | `/travel/admin/cost-master` | Hotel rates, transport cards, seasonal calendars |
| `FlightQuoteAgent.jsx` | `/travel/flights/quote` | Optional in-CRM fallback if Chrome plugin unavailable |
| `MarkupRules.jsx` | `/travel/admin/markup-rules` | Per-airline / per-route / per-fare-bucket + agent-scoped |
| `SupplierVault.jsx` | `/travel/admin/vault` | Login vault UI; masked-by-default; access-log viewer |
| `TmcTrips.jsx` | `/travel/tmc/trips` | List + create-on-confirm flow |
| `TmcTripDetail.jsx` | `/travel/tmc/trips/:id` | Per-trip ops dashboard: students, payments, docs, rooming, departure-readiness |
| `TmcRooming.jsx` | `/travel/tmc/trips/:id/rooming` | Drag-drop rooming assignment; export rooming list |
| `TmcPaymentPlan.jsx` | `/travel/tmc/trips/:id/payment-plan` | Instalment tracker per student |
| `TmcDocumentChecklist.jsx` | `/travel/tmc/trips/:id/documents` | Per-student doc status |
| `TmcMicrositePreview.jsx` | `/travel/tmc/trips/:id/microsite` | Admin preview of the public microsite |
| `WebCheckinQueue.jsx` | `/travel/checkin` | Upcoming check-ins; status; manual upload boarding pass |
| `RfuPatientProfile.jsx` (renamed `RfuCustomerProfile.jsx`) | `/travel/rfu/customers/:id` | Full RFU customer profile per §4.5 |
| `RfuJourneyReminders.jsx` | `/travel/rfu/customers/:id/journey` | Active reminder schedule |
| `VisaApplications.jsx` | `/travel/visa/applications` | Visa Sure (Phase 2) |
| `VisaApplicationDetail.jsx` | `/travel/visa/applications/:id` | Doc checklist, risk flags, status machine |
| `VisaAdvisorDashboard.jsx` | `/travel/visa/advisor` | Risk-flagged queue (Phase 2) |
| `TravelStallFamilyQuiz.jsx` | `/p/family-quiz` | Travel Stall public quiz (Phase 2) |
| `TravelReports.jsx` | `/travel/reports` | Per-sub-brand analytics tabs (TMC: revenue-by-dest, repeat-school, margin; RFU: revenue-by-tier, conversion-by-tier, repeat-customer) |

### 7.1 Public micro-sites (separate static / SSR)

- `frontend/src/pages/travel/public/TripMicrosite.jsx` — bound to `/p/trip/:uuid` — rendered server-side via `services/landingPageRenderer.js` for SEO + speed.

### 7.2 Chrome extension (separate package — `flight-plugin/` at repo root)

- Manifest v3; content script for `https://www.google.com/flights*`; popup with markup-rule selector + "Generate Quote" button; calls `/api/travel/quotations/flight/extract`. Signed CRX hosted on private GS update server. Auto-update every 4-6h. Force-update + 30-day rollback. (`Response` B.8)

---

## 8. Vertical config additions

### 8.1 Tenant.vertical enum addition

`Tenant.vertical` is already `String @default("generic")` ([backend/prisma/schema.prisma:63](../backend/prisma/schema.prisma#L63)) — no enum, just a new value `"travel"`. Add to seed + any sidebar / theme switch.

### 8.2 Sidebar additions

Extend `frontend/src/components/Sidebar.jsx` with a `renderTravelNav()` function. Slim travel-focused nav (~20 items, mirroring the wellness slim pattern):

```
[Sub-brand switcher: TMC | RFU | Travel Stall | Visa Sure]
─ Dashboard (/travel)
─ Leads (/travel/leads)
─ Diagnostics
   ├ Public links (/travel/admin/diagnostics)
   └ Q-bank admin (/travel/admin/diagnostics/banks)
─ Quotations
   ├ Flight quick-quote (/travel/flights/quote)
   ├ Itineraries (/travel/itineraries)
   └ Cost master (/travel/admin/cost-master)
─ TMC (visible only with tmc in subBrandAccess)
   ├ Trips (/travel/tmc/trips)
   ├ Rooming
   └ Payment plans
─ RFU (visible only with rfu)
   ├ Customers (/travel/rfu/customers)
   └ Journey reminders
─ Visa Sure (Phase 2)
─ Web check-in (/travel/checkin)
─ Supplier vault (/travel/admin/vault)
─ Reports (/travel/reports)
─ Settings → Markup rules / Templates / Sub-brands
```

### 8.3 Theme file

New `frontend/src/theme/travel.css` scoped under `[data-vertical="travel"]`. Suggested palette from the brand context across documents (premium positioning, trust-first):
- Primary: deep navy `#0F2952` (trust)
- Accent: warm amber `#D97706` (premium / pilgrimage warmth — works for both RFU and TMC palettes)
- Background: soft cream `#FAF7F0`
- Surface: white `#FFFFFF`
- Per-sub-brand override pattern via `[data-sub-brand="rfu"]` / `[data-sub-brand="tmc"]` cascades (RFU may want green-gold; TMC may want school-blue) — defer per-sub-brand polish to a UX pass once brand assets land in the Section 13 packet.

Activated in `App.jsx` by setting `data-vertical="travel"` + `data-sub-brand="<code>"` on `body` based on `tenant.vertical` + active sub-brand selection.

### 8.4 Landing route

Travel users land on `/travel` instead of `/dashboard`. Add to App.jsx route guard:
```js
if (tenant.vertical === 'travel') return <Navigate to="/travel" replace />;
```

### 8.5 Seed

Extend `prisma/seed.js` (or new `prisma/seed-travel.js` mirroring `seed-wellness.js`) to create:
- Travel Stall tenant (`vertical: "travel"`)
- 4 sub-brand configs (TMC, RFU, Travel Stall, Visa Sure) with legal-entity codes, default WhatsApp WABA numbers, GST registrations
- 1 admin + 1 manager + 1 agent per sub-brand (Yasin as admin across all four)
- 1 sample diagnostic Q-bank per sub-brand (RFU 12Q, Visa Sure 15Q, TMC school-readiness, Travel Stall family-quiz)
- 1 sample TmcTrip + 1 sample Itinerary + 1 sample VisaApplication
- 1 sample SupplierCredential (encrypted)

---

## 9. External integrations called out by the docs

| Integration | Sub-brand(s) | Cited in | Reuse status |
|---|---|---|---|
| **Wati** (WhatsApp Business API BSP) | all | `Response` B.4 | NEW client (existing `routes/whatsapp.js` uses Cloud API directly; Wati is a BSP wrapper) |
| **Meta WhatsApp Cloud API** | all | `Response` B.4 | REUSE existing |
| **Callified.ai / Exotel** (AI calling Eng/Hin/Urdu) | TMC, RFU | `Response` B.5, `Req Doc` §12 | NEW client + Exotel webhook handler |
| **Google Workspace** (Gmail/Calendar/Drive/Meet/Docs/Sheets/Contacts/Forms) | all | `Req Doc` §4 | REUSE Calendar; NEW Drive client; REUSE Gmail IMAP |
| **RateHawk** (hotel B2B wholesaler) | RFU | `Response` B.3 | NEW client (P1) |
| **Booking.com / Expedia** | RFU | `Response` B.3 | NEW (Phase 1.5) — pending commercial agreement |
| **DigiLocker** (Aadhaar XML) | TMC, RFU, Visa Sure | `Response` B.10 | NEW client |
| **Passport OCR** | RFU, TMC, Visa Sure | `Req Doc` §11 | NEW; Google Document AI or Microsoft Form Recognizer |
| **AdsGPT** (Globussoft internal — already live) | all | `Response` A.3 | REUSE existing; campaign tracking + content gen |
| **LLM router** (Perplexity/Gemini/Claude/GPT) | all (RFU heavy) | `Response` B.7; `Req Doc` §12 | REUSE existing `lib/ai/*` if present; add Perplexity client; defaults admin-editable per task class |
| **Meta / Google / LinkedIn / YouTube Ads APIs** | all | `Req Doc` §12 marketing | REUSE if existing; else NEW (3d Integration per `Response` A.8) |
| **Excel Software for Travel** (Bombay accounting) | all | `Response` Part C | NEW: P1 file-import; P1.5 API |
| **Airline portals** (IndiGo, Air India / AI Express, Vistara, Emirates, Tier-2 list) | TMC, RFU | `Response` B.1 | NEW: browser-automation per airline |
| **Razorpay / PayU / Cashfree** | all | `Response` A.2 (gateway pref TBD) | REUSE existing `routes/payments.js` (Razorpay + Stripe wired) |
| **Branofy** (workflow + quality benchmark only) | all | `Req Doc` §7 | OUT of build scope — reference only |
| **Tally** (CA export format) | all | `Req Doc` §11 | NEW exporter |

### 9.1 LLM routing defaults (per `Response` B.7)

- search / citation → Perplexity (Sonar)
- reasoning + talking points + form-vs-call → Claude (fallback GPT)
- bulk text → Gemini Flash (fallback Claude Haiku)
- call summary → Gemini Flash
- defaults are admin-editable per task class
- **API keys held by Travel Stall** per `Response` B.7 — store under `SupplierCredential` category `"llm-key"`

---

## 10. Phased implementation plan

This plan follows the GlobusSoft-Travel Stall contract (`Response` §B.13–B.14) precisely. The 6-week / 42-day commitment is for **Phase 1 (TMC + RFU only)**. Travel Stall and Visa Sure are Phase 2 / 3 inside the long-term partnership but covered structurally in §5–§7 above.

### Phase 1 — TMC + RFU MVP (6 weeks / 42 days; ₹1,25,000 + ₹1,25,000 milestones; cite `Response` A.1)

**Recommended Phase 1 sub-vertical: TMC + RFU together** — the spec, the commercial doc, and the 6-week plan are all written around this dual ship. Picking only one would break the contract and the platform-wide diagnostic engine which serves both. The 3 parallel workstreams are:
- **Platform** — CRM tenants, SSO, roles, 8-status pipeline, login vault, diagnostic builder, RFU quotation engine, flight Chrome plugin, microsite, LLM router, scoring, customer profile.
- **Integrations** — Workspace OAuth, Wati workspaces (3 WABA), Meta templates, ad-platform APIs, RateHawk, Google Meet, web check-in agent, DigiLocker, passport OCR, accounting bridge.
- **Delivery** — brand assets, KPI definitions, reminder schedules, diagnostic content load, PDF templates, talking-point templates, marketing/TMC/RFU reports, ops dashboard.

| Week | Days | Exit gate | Effort (engineer-days) |
|---|---|---|---|
| W1 | D1–D7 | SSO live; inbound WhatsApp creates enquiries; templates submitted | ~14 (3 parallel) |
| W2 | D8–D14 | Both diagnostics live; AI calling with summary attached | ~16 |
| W3 | D15–D21 | Flight plugin: 4-option quote in 60s; RFU quotation returns lowest rate | ~17 |
| W4 | D22–D28 | Web check-in live for top-4 airlines; TMC microsite pilot | ~17 |
| W5 | D29–D35 | Dashboards meet KPI list; CA export validated | ~13 |
| W6 | D36–D42 | UAT ≥90% P1A pass; go-live D42 | ~10 |

Total phase-1 effort estimate per `Response` A.8: **~87 engineer-days across 3 workstreams = ~29 days per workstream over 6 weeks**, which matches a 1-engineer-per-workstream plan with overlap on diagnostic engine + quotation engine.

### Phase 1.5 — same-quarter follow-on (~4-6 weeks)

- Web check-in Tier-2 airlines (1-2d each: SpiceJet, Akasa, Etihad, Saudia, Qatar, Air Arabia)
- Admin-editable diagnostic scoring with audit + sandbox (2d)
- Excel Software API bridge (once integration docs available)
- Booking.com + Expedia direct APIs (after commercial agreement closes)
- Long-tail airline automation (captcha-aware)

### Phase 2 — Travel Stall sub-brand (~4-6 weeks)

- Travel Stall Family Travel Quiz (mirror diagnostic builder, new Q-bank)
- Personalised 3-5 destination recommendations (LLM-generated PDF; mirror RFU itinerary builder)
- Travel Stall public landing + booking flow (50% advance pattern)
- Customer-duplicate full pop-up flow with preferences
- Birthday / anniversary greetings

### Phase 3 — Visa Sure sub-brand (~6-8 weeks)

- 15Q readiness diagnostic with risk-flag engine
- Visa application status machine + document checklist UI
- Rejection-recovery program enrolment + tracking
- Advisor risk-dashboard with priority alerts
- Visa-specific reports

### Phase 4 — long-term enhancements

- Customer travel app (out-of-scope for Phase 1 per `Req Doc` §1)
- Full booking engine (out-of-scope Phase 1)
- Full accounting automation (out-of-scope Phase 1)
- Universal AI quotation engine across all travel products with live booking (out-of-scope Phase 1)
- R&D module / full HR recruitment / AdsGPT resale / SaaS resale (out-of-scope entirely per `Req Doc` §1)

---

## 11. Reuse from existing modules

| Existing module | Reuse decision | Action |
|---|---|---|
| Contact / Activity / Task | REUSE | Add `subBrand` tag column on Contact + Deal |
| Pipeline / PipelineStage | REUSE | Seed one 8-status pipeline per sub-brand |
| Deal | REUSE | Add nullable `subBrand` + `diagnosticId` FK |
| Quote / QuoteLineItem | REUSE for simple quotes; NEW Itinerary for multi-product trips | RFU quotation engine = new model |
| Invoice / Payment | REUSE | Add `legalEntityCode` column |
| Booking | REUSE | Add nullable `tripId` + `itineraryId` FK |
| Email / Mailgun / Nodemailer / IMAP | REUSE wholesale | New per-sub-brand templates only |
| WhatsApp Cloud API | REUSE | Plus NEW Wati BSP wrapper for 3-WABA isolation |
| SMS (Twilio / MSG91) | REUSE | n/a (WhatsApp + email-first per spec) |
| Calendar (Google + Outlook) | REUSE | Add Drive client + Meet booking layer |
| Voice + transcription | REUSE | Plus NEW Callified.ai integration |
| Sequence / drip + scheduledEmailEngine | REUSE | Templates for journey reminders + payment-plan reminders + post-trip feedback |
| Survey + SurveyResponse | REUSE | Templates for post-trip feedback |
| ChatbotConversation | REUSE | For AI qualification call transcript attachment |
| AuditLog + audit_viewer | REUSE | Mandatory for B.2 document-security 24-month audit |
| pdfRenderer service | REUSE | New per-sub-brand templates (diagnostic report; itinerary PDF; flight quote PDF; rooming list PDF) |
| Sentry monitoring | REUSE | No change |
| Auth (JWT + RBAC + 2FA + SSO) | REUSE | Plus Google Workspace SSO config |
| Field encryption (`lib/fieldEncryption.js` AES-256-GCM) | REUSE | For SupplierCredential + Aadhaar token + passport |
| Deduplication (`utils/deduplication.js`) | REUSE | Extend match keys for passport number |
| LandingPage + landingPageRenderer | REUSE | TMC trip microsite renders through this |
| BookingPage + Booking | REUSE | Travel Stall Phase 2 booking flow |
| AI (Gemini) | REUSE | Plus NEW Perplexity + LLM-router middleware layer with admin task-class config |
| Notifications (Web Push + push-service) | REUSE | For agent alerts on diagnostic completion, AI handover, check-in fallback |
| Workflow engine | REUSE | For diagnostic-complete → advisor-alert, payment-overdue, etc. |
| GDPR / retention engine | REUSE | Bind passport (24m post-trip), call rec (12m), financial (84m), diagnostic (lifetime-of-profile) retention rules |

---

## 12. Open questions / blockers requiring product calls

| # | Question | Source | Owner | Blocker for |
|---|---|---|---|---|
| Q1 | **Section 13 packet not yet delivered** by Travel Stall — TMC school DB, diagnostic Qs + scoring, RFU product ladder + cost master, markup/GST/discount rules, airline portal creds + PNR fields, RFU website URL + form fields, Workspace admin, WhatsApp numbers, staff list + brand access, branding assets, templates, retention durations, reminder schedules, TMC payment + rooming logic, KPI definitions, LLM keys, manager users | `Response` Part D; `Yasin clarifications` §3 | Yasin (Travel Stall) | Day 0 kickoff is gated on this packet |
| Q2 | **Aadhaar consent legal copy** — to be drafted by GS, approved by Travel Stall counsel | `Response` A.2 | Travel Stall counsel | Parent/teacher registration portal |
| Q3 | **DigiLocker partner credentials** — held by Travel Stall? If not, GS to initiate | `Response` A.2 | Yasin | Aadhaar OCR (TMC + RFU) |
| Q4 | **Payment gateway preference** — Razorpay / PayU / Cashfree | `Response` A.2 | Yasin | Accounting integration |
| Q5 | **Sample CA export** from accountant for parity testing | `Response` A.2 | Yasin | CA export format |
| Q6 | **Data residency confirmation** — GS proposed AWS Mumbai; need explicit sign-off | `Response` A.2 | Yasin | Hosting setup |
| Q7 | **SSO provider** — Google Workspace (GS recommended) vs Microsoft Entra | `Response` A.7 Q1 | Yasin | W1 SSO setup |
| Q8 | **Excel Software for Travel** — API or file-import only? Share integration docs | `Response` A.7 Q2 | Yasin | Light accounting wire-in |
| Q9 | **WhatsApp numbers per brand** — final allocation across TMC, RFU, ops-shared | `Response` A.7 Q3 | Yasin | Wati WABA provisioning |
| Q10 | **Final 8-status + 8-lost-reason labels** — confirm wording | `Response` A.7 Q4 | Yasin | Pipeline seed |
| Q11 | **Default LLM per task class** — confirm and where API keys are held | `Response` A.7 Q6 | Yasin | LLM router defaults |
| Q12 | **KPI reporting period defaults** — daily/weekly/monthly/custom? Per brand? | `Response` A.7 Q8 | Yasin | Dashboards |
| Q13 | **Diagnostic length per brand** — number of questions, pages, time-to-complete | `Response` A.7 Q10 | Yasin | Diagnostic content load |
| Q14 | **Document retention durations** per type — passport, Aadhaar, PAN, visa, financial, call recording, contract — confirm against GS proposal (passport 24m, call 12m, financial 84m, diagnostic lifetime) | `Response` A.7 Q11; B.2 | Yasin | Retention engine wiring |
| Q15 | **Named UAT lead + 3 test users per brand** | `Response` A.7 Q12 | Yasin | W6 UAT |
| Q16 | **Conflict — RFU admin-editable scoring** — RFU CRM brief says "Editable scoring logic from admin panel"; TMC says "non-technical staff should not edit scoring in phase one"; GS recommends view-only P1 + edit-with-audit P1.5. Decision pending | `Req Doc` §6; `RFU CRM` §1; `Response` A.6 | Yasin | Diagnostic builder Phase 1 |
| Q17 | **Conflict — Travel Stall is "out of scope" for Phase 1 per `Req Doc` §1, but `Travelstall - CRM development.pdf` and `Travel_Stall_Business_Blueprint` describe full requirements** — confirm Travel Stall is Phase 2 (not slipping into Phase 1 scope creep) | `Req Doc` §1 vs `Travelstall CRM` whole file | Yasin | Phase 1 scope freeze |
| Q18 | **Conflict — Visa Sure** — similar to Q17. Out of Phase 1, but full requirements described. Confirm Phase 3 | `Req Doc` §1 vs `Visa Sure CRM` | Yasin | Phase 1 scope freeze |
| Q19 | **Conflict — hotel rate comparator** — `Req Doc` §9 says "Hotel rate comparator across Booking.com, Expedia and direct contract rates"; `Response` B.3 says Booking/Expedia are NOT currently licensed for B2B resale, recommends RateHawk for P1 + Booking/Expedia P1.5. Confirm RateHawk-only ship for P1 | `Req Doc` §9 vs `Response` B.3 | Yasin | RFU quotation engine W3 |
| Q20 | **Top-10 airline list for web check-in** — `Req Doc` §10 names "IndiGo, Emirates, Air India, Vistara and similar"; `Response` B.1 commits Tier-1 = IndiGo / Air India + AI Express / Vistara / Emirates (4 airlines, not 10). Confirm the top-10 list and accept the 4/6 P1+P1.5 split | `Req Doc` §10 + Section 13 input | Yasin | W4 web check-in scope |
| Q21 | **Subdomain ownership** — `Response` B.9 proposes `trip-<code>.tmc.travelstall.in`. Confirm Travel Stall owns `*.tmc.travelstall.in` DNS or whether the pattern needs adjustment (e.g. `*.themodernclassroom.in`) | `Response` B.9 | Travel Stall ops | TMC microsite |
| Q22 | **Brand assets package** — logos, colors, fonts for TMC + RFU diagnostic PDFs, itineraries, microsites, email templates, WhatsApp templates | Section 13 | Yasin | All PDF/templated surfaces |
| Q23 | **Premium support tier** — `Response` B.12 recommends Premium (24×7 critical + phone hotline) for first 90 days. Confirm | `Response` B.12 | Yasin | Hypercare scope |
| Q24 | **Decimal precision for INR amounts** — confirm `Decimal(18,4)` matches existing CRM convention. Verify with backend lead before schema migration | Schema decision | Backend lead | Schema migration |
| Q25 | **Sub-brand-level access vs separate tenants** — current PRD assumes 4 sub-brands in 1 tenant with `subBrandAccess` per User. Alternative: 4 separate tenants. Choose one explicitly; switching later is expensive | PRD architectural call | Yasin + Backend lead | Tenant provisioning |

---

*End of PRD — total ~4,500 words. Phase 1 kickoff is gated on Q1 (Section 13 packet) and the 5 named items in `Response` A.2.*
