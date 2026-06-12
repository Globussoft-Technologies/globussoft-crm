# Travel CRM — Client Requirements & Dependency List

**Date:** 2026-06-09
**Purpose:** Single source of truth for **everything the engineering team needs from the client (Yasin / Travel Stall)** before each remaining Travel-CRM gap can ship. Derived from a full code-level audit of all ~25 travel PRDs against `HEAD`.
**Companion docs:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) · [TRAVEL_CRM_PENDING_FEATURES.md](TRAVEL_CRM_PENDING_FEATURES.md) · [TRAVEL_BIG_SCOPE_BACKLOG.md](TRAVEL_BIG_SCOPE_BACKLOG.md) · [CREDS_TRACKER.md](CREDS_TRACKER.md) · [DECISIONS_TRACKER.md](DECISIONS_TRACKER.md)

---

## How to read this doc

Every blocked item is tagged by **what kind of input it needs from the client**:

| Tag             | Meaning                                                            | Who acts             |
| --------------- | ------------------------------------------------------------------ | -------------------- |
| 🔑 **CRED**     | An API key / account / token / vendor onboarding                   | Yasin (or vendor)    |
| 🧭 **DECISION** | A product/architecture choice only the client can make             | Yasin + GS lead      |
| 📝 **CONTENT**  | Copy / data / config the client owns (brand text, mappings, rates) | Yasin's team         |
| ⚖️ **LEGAL**    | Counsel sign-off on wording                                        | Travel Stall counsel |
| 🟢 **NONE**     | Nothing needed from client — engineering can build now             | GS engineering       |

**Engineering rule for everything below:** new code is **additive and behind the existing stub-mode pattern** (same recipe already used for DigiLocker / RateHawk / Callified). A cred/decision drop becomes a 1-line swap, and _nothing already shipped breaks_ while we wait.

---

## ⭐ TL;DR — the one message to send Yasin

Bundle these so we get them in one round-trip. Each unblocks one or more modules below.

1. 🔑 **WhatsApp / Wati (Q9)** — Wati account number + API key + 3 per-sub-brand sender IDs **OR** Meta: System-User access token + 3× phoneNumberId + 3× wabaId + App ID/Secret + webhook verify token. _(Unblocks 7 crons + 3 endpoints + flyer/quote share across the whole vertical.)_
2. 🔑 **Brand assets pack (Q22)** — per sub-brand (TMC / RFU / Travel Stall / Visa Sure): logo SVG+PNG (light/dark), colour palette (hex), fonts, PDF letterhead. _(Unblocks branding, marketing flyer, theme, all PDF templates, Visa Sure reports.)_
3. 🔑 **RateHawk (Q19)** — API key + API ID + production base URL.

4. 🔑 **DigiLocker (Q3)** — `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`.
5. 🔑 **LLM keys (Q11)** — OpenAI + Anthropic + Google AI Studio + Perplexity API keys.
6. 🧭 **Big-module decisions** — see the per-module DECISION rows in Tier 1 (B2B portal topology, Purchase-Order approval flow, Flight-plugin Web-Store account, airline-automation tech + ToS, hotel-portal scrape-vs-API, flyer editor library, Excel Software API-vs-CSV).
7. ⚖️ **One legal session** — Aadhaar consent copy + TRAI pre-call disclosure + passport-OCR consent + RFU portal ToS + airline web-checkin ToS (all in §Legal below).

---

# 🔴 Tier 1 — Big modules (the headline gaps)

For each: **what the client must provide** + **what engineering can start now without them**.

### 1. B2B Agent Portal + Corporate Portal — `PRD_TRAVEL_B2B_AGENT_PORTAL`

**State:** 0% — no models/routes. **Est:** ~25-45 eng-days after decisions.

Required from client:

- 🧭 **DD-5.1 Portal topology** — separate React app (`apps/b2b-portal/`) **vs** route prefix (`/portal/b2b/*`) on the existing app.
- 🧭 **DD-5.4 Travel-policy editor surface** — in-app form vs JSON upload vs spreadsheet upload.
- 🧭 **DD-5.5 Approval-workflow shape** — single-approver vs multi-stage vs per-corporate-configurable.
- 🧭 **DD-5.6 Expense-report format** — canonical CSV vs per-corporate column template.
- 🧭 **DD-5.7 Traveler-profile scope** — per-corporate-scoped vs cross-corp shared.
- 📝 **Commission model** — sub-agent commission %, tiers, settlement cadence, TDS threshold.
- 📝 **Corporate account structure** — roles (HR/Finance/Approver/Traveler), per-corporate travel-policy rules (budget caps, class limits, approval thresholds).
- 🧭 **OQ-9.1…9.7** — sub-agent hierarchy depth, corporate SSO need, multi-tenancy boundary.

🟢 **Engineering can start now (low risk, no client input):** Prisma models behind a feature flag (`SubAgent`, `CorporateAccount`, `CorporateUser`, `SubAgentCommission`, `CorporatePolicy`, `CorporateApprovalRequest`) as additive nullable tables — _only once DD-5.1 topology is chosen_ (topology changes the auth/route shape, so we should NOT scaffold before that one decision).

---

### 2. Purchase Orders module — `PRD_PURCHASE_ORDERS`

**State:** 0% — PRD self-marks "NOT STARTED, design call needed." **Est:** ~8-12 eng-days after decisions.

Required from client:

- 🧭 **DD-5.1…5.8** — PO state machine (draft→approved→confirmed→settled), who approves, auto-PO-on-booking yes/no, PO numbering scheme.
- 📝 **Supplier payment terms** per supplier (already partly in `TravelSupplier`).
- 🧭 **OQ-9.2 / 9.3 / 9.10** — PO ↔ payable reconciliation tolerance, multi-currency PO handling.

🟢 **Engineering can start now:** nothing safely — the model shape depends on the approval-flow decision. Build after the design call.

---

### 3. Flight Quotation Chrome plugin — `PRD_FLIGHT_PLUGIN_CHROME_EXTENSION`

**State:** 0% — separate repo. **Est:** ~12-16 eng-days after decisions.

Required from client:

- 🧭 **DC-1 Repo location** — separate repo `globussoft-flight-plugin` vs subdir.
- 🔑 **DC-2 Chrome Web Store publisher account** — GS-owned vs Travel-Stall-owned (or private signed-CRX distribution).
- 🧭 **DC-3 Airline priority list** — which Google-Flights carriers to support first.
- 📝 **Per-airline / per-route / per-fare-bucket markup config** (can also be entered in-CRM later).

🟢 **Engineering can start now (CRM-side, ~2 days, no client input):** the backend `POST /api/v1/flight-plugin/quotes` endpoint + `ApiKey` `purpose='flight-plugin'` enum + admin key-issuance UI — these can ship independent of the plugin itself and de-risk the integration. **The plugin (Manifest V3 + adapters) is blocked on DC-1/DC-2.**

---

### 4. Airline web check-in automation (P1B) — `PRD_AIRLINE_WEBCHECKIN_AUTOMATION`

**State:** tracking layer (P1A) shipped; automation engine 0%. **Est:** ~5-7 eng-days + ongoing per-airline maintenance.

Required from client:

- 🧭 **DC-1** — Playwright headless vs MCP-via-LLM automation approach.
- 🧭 **DC-2** — airline priority (recommended: IndiGo + Air India + Vistara + Emirates).
- 🧭 **DC-3** — containerization / deploy model for the automation worker.
- ⚖️ **DC-5** — counsel ToS review of the 4 airlines' terms before production automation.
- 🔑 Airline portal credentials / PNR-access where the carrier requires a registered agent login (stored in the supplier vault).

🟢 **Engineering can start now:** the `webCheckinAutomation.js` engine skeleton + `WebCheckinAutomationRun` model + `automationSkipped`/`completedAt` columns + manual re-trigger endpoint + per-airline health dashboard — **additive, safe**, leaving the actual per-airline adapter bodies stubbed until DC-1/DC-5. (Tracking + manual upload already work, so this won't disrupt the live flow.)

---

### 5. RFU 5-portal Saudi hotel orchestrator — `PRD_RFU_GROUND_SERVICES`

**State:** 0% (Zikr Cabs + Haramain HSR exist as read-only stubs). **Est:** ~10-15 eng-days.

Required from client:

- 🧭 **Q-RFUG-2…6** — per-portal **scrape vs partner-API** decision for Almosafer / Tajawal / MyHoliday2 / Pilgrims Choice / Reservation House.
- ⚖️ ToS review of each of the 5 portals (pairs with the legal session).
- 🔑 **Q-RFUG-1** — Zikr Cabs onboarding (~SAR 5k setup): prod + sandbox keys + webhook secret + API PDF.
- 🔑 **Q-RFUG-7/8** — confirm Haramain HSR has a B2B partner program; if yes, creds + group-tier docs (3-6 wk vendor onboarding).

🟢 **Engineering can start now:** the orchestrator fan-out shell + `SaudiHotelRateCache` + `TravelContractedRate` models + normalizer + dedupe + cache cron — **all runnable against stubs**, swapping per-portal adapters as decisions land. Zikr/HSR write paths stay `NOT_YET_ENABLED` until creds.

---

### 6. Marketing Flyer canvas editor — `PRD_TRAVEL_MARKETING_FLYER`

**State:** shell + template CRUD only. **Est:** ~10 days (Polotno) / ~20+ days (in-house).

Required from client:

- 🧭 **DD-5.1 Editor library** — **Polotno embed (faster, licence cost)** vs in-house build. _Do not start the editor until this is answered — it's the single biggest cost fork._
- 🔑 **DD-5.2 / Q-MF-1 Asset storage** — S3 vs Cloudinary account + creds (local disk OK for pilot).
- 🔑 **DD-5.3 / Q-MF-2 AI image provider** — DALL·E vs Stable Diffusion vs Midjourney API key.
- 🔑 **Q22 brand assets** (above) for brand-locked templates.
- 🔑 **Q9 WhatsApp** for flyer share.

🟢 **Engineering can start now:** the `Asset` model + Multer upload pipeline + tag search + PDF/PNG render via existing `pdfRenderer` (text-only) + brand-lock plumbing — safe groundwork. **The canvas editor itself waits on DD-5.1.**

---

### 7. Visual day-by-day itinerary editor — `PRD_TRAVEL_ITINERARY_UPGRADES`

**State:** template library + sightseeing master shipped; 3-pane editor + map + AI-suggest MISSING. **Est:** ~10 eng-days.

Required from client:

- 🟢 **NONE to start.** Schema already has `ItineraryItem.dayNumber` / `latitude` / `longitude`. Leaflet + OpenStreetMap is free (no key).
- 🔑 _(optional, later)_ **Q-IT-1** Mapbox key if we want premium tiles (Leaflet/OSM is the default, free).
- ⚖️ _(optional, later)_ **Q-IT-3** OpenTripMap licence review (~1 hr) only if we auto-import POI seed data.
- 🔑 **Q11 LLM keys** to make the AI "suggest itinerary" return real plans (stub works for dev/demo).

✅ **This is where engineering starts NOW** — see §Implementation below.

---

### 8. Excel Software accounting bridge — `PRD_EXCEL_SOFTWARE_ACCOUNTING`

**State:** ~0%. **Est:** ~2-3 eng-days after docs.

Required from client:

- 🔑 / 🧭 **Q8** — vendor REST API docs **+ DC-1 path decision (API webhook vs nightly CSV)** + sample export format + sandbox keys.

🟢 **Engineering can start now:** nothing meaningful — the file/field shape is defined entirely by the vendor's spec. Build after Q8 docs arrive.

---

# 🟡 Tier 2 — Integrations already coded as stubs (just need credentials)

These are **fully wired in stub mode**; a credential drop is a ~½-1 day swap each. **No engineering design needed — purely waiting on the client.**

| Integration            | PRD                            | Exact credential ask                                                                                                                 |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| WhatsApp / Wati        | `WHATSAPP_INTEGRATION_PRD`     | 🔑 Q9 — account no. + API key + 3 sender IDs **or** Meta token + 3× phoneNumberId + 3× wabaId + App ID/Secret + webhook verify token |
| RateHawk hotels        | `PRD_RATEHAWK_INTEGRATION`     | 🔑 Q19 — API key + API ID + prod base URL                                                                                            |
|  |
| DigiLocker Aadhaar     | `DIGILOCKER_INTEGRATION_SPEC`  | 🔑 Q3 — `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`                                                                          |
| Passport OCR           | `PRD_PASSPORT_OCR`             | 🧭 PC-1 vendor (Google Document AI vs Azure FR) + 🔑 keys                                                                            |
| Booking.com direct     | `PRD_BOOKING_EXPEDIA_DIRECT`   | 🔑 Affiliate ID + API key + API secret (2-4 wk Partner-Centre onboarding)                                                            |
| LLM real-mode          | PRD §9.1                       | 🔑 Q11 — OpenAI + Anthropic + Google AI Studio + Perplexity keys                                                                     |
| Razorpay subscriptions | `PRD_PLANS_BILLING_SELF_SERVE` | 🔑 Q-PB-2 — confirm `rzp_live_*` key has subscription scope, or new key                                                              |

> ⚠️ Note for Tier 2: a few of these (Callified, AdsGPT) also have **engineering gaps beyond the credential** — the dispatcher cron, schema columns, webhook endpoint, and report endpoints aren't built yet. The credential unblocks the swap, but those modules still need ~3-5 eng-days each on top. See [TRAVEL_CRM_PENDING_FEATURES.md](TRAVEL_CRM_PENDING_FEATURES.md).

---

# 🟠 Tier 3 — Partial features inside otherwise-shipped PRDs

Mostly engineering work, but these specific items **need client content/data** to be meaningful:

| Area                                      | PRD                                                                                 | Client ask                                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-sub-brand branding / theme / Visa PDF | `PRD_TRAVEL_PER_SUBBRAND_BRANDING`, `PRD_THEME_MANAGEMENT`, `PRD_VISA_SURE_PHASE_3` | 🔑 **Q22 brand assets** (logos/palettes/fonts/letterhead per sub-brand)                                                                                |
| TMC curriculum recommendations            | `PRD_TMC_CURRICULUM_MAPPING`                                                        | 📝 **PC-1** initial curriculum-mapping CSV from academic team (engine returns empty without it)                                                        |
| TMC readiness report credibility          | `PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE`                                           | 📝 **T19** real curriculum-hook copy for 5 starter trips; 📝 **T20** Q3 growth-area→skill map confirmation; 📝 **T21** verbatim LLM prompt source      |
| TMC booking CTA                           | same                                                                                | 🔑 **T18** Google Workspace project + OAuth consent + team calendars (for the Meet slot-picker)                                                        |
| GST compliance accuracy                   | `PRD_TRAVEL_GST_COMPLIANCE`, `PRD_TRAVEL_BILLING`                                   | 📝 per-sub-brand **GSTINs** + place-of-supply **state codes** + **SAC/HSN** confirmations + sample **CA/Tally export** + **LUT reference** for exports |
| Visa Sure go-live                         | `PRD_VISA_SURE_PHASE_3`                                                             | 📝 **15Q question bank + scoring rules**; 📝 document-checklist templates per visa type                                                                |
| UAT                                       | `TRAVEL_CRM_PRD`                                                                    | 📝 **Q15** named UAT lead + 3 test users per brand                                                                                                     |

🟢 **Most Tier-3 _engineering_ (per-line GST breakdown, opaque IDs, PII list projections, quote templates, pipeline a11y, etc.) needs nothing from the client** and can be scheduled independently — see [TRAVEL_CRM_PENDING_FEATURES.md](TRAVEL_CRM_PENDING_FEATURES.md) §"Codeable today."

---

# ⚖️ Legal — one bundled counsel session

Schedule a single ~30-45 min session covering all of these (each is a string-swap once approved):

1. **Aadhaar consent legal copy** — draft exists at [TRAVEL_AADHAAR_CONSENT_DRAFT.md](TRAVEL_AADHAAR_CONSENT_DRAFT.md) (Q2), needs sign-off.
2. **TRAI pre-call recording disclosure** wording — `PRD_AI_CALLING_CALLIFIED` DC-5.
3. **AI-decline / "this call is automated" wording** — same PRD DC-4.
4. **Passport-OCR consent text** — `PRD_PASSPORT_OCR` PC-3 (bundles with #1).
5. **RFU 5-portal ToS review** — scrape-vs-partner-API per Saudi hotel portal (Q-RFUG-2…6).
6. **Airline web check-in ToS review** — 4 carriers (`PRD_AIRLINE_WEBCHECKIN_AUTOMATION` DC-5).

---

# 🛠️ Implementation plan — what we build now vs. what waits

**Guiding principle:** ship the **unblocked** work additively while the client gathers the above. Nothing below modifies a shipped code path destructively.

### Phase A — start immediately (no client input, low breakage risk)

1. **Itinerary Upgrades module** (Tier 1 #7) — AI `itinerary-suggest` task class + endpoint (stub-mode), then the 3-pane visual day-by-day editor + Leaflet/OSM map. ← **IN PROGRESS**
2. **Airline-automation skeleton** (Tier 1 #4) — engine + models + health dashboard, adapters stubbed.
3. **RFU hotel-orchestrator shell** (Tier 1 #5) — fan-out + cache + normalizer against stubs.
4. **Flight-plugin CRM side** (Tier 1 #3) — endpoint + API-key issuance UI (plugin itself waits on DC-1/DC-2).
5. **Tier-3 no-client-input wins** — per-line GST breakdown, quote templates, pipeline a11y/URL-persistence, security S3/S35/S36.

### Phase B — unblocks on a single decision each

- Marketing Flyer editor (after DD-5.1 Polotno-vs-in-house)
- B2B portal models (after DD-5.1 topology)
- Purchase Orders (after the approval-flow design call)

### Phase C — unblocks on credential/content drops (Tier 2 + Tier 3 content)

- All stub→real swaps as creds land; brand-dependent PDFs/themes as Q22 lands; TMC/GST/Visa content as data lands.

---

_Maintainer note: when a credential or decision lands, update [CREDS_TRACKER.md](CREDS_TRACKER.md) / [DECISIONS_TRACKER.md](DECISIONS_TRACKER.md) and flip the matching row here. This doc is the client-facing index; those two are the internal ledgers._
