# Travel CRM — pending features (cross-vertical view)

**Status as of 2026-06-09.** Companion to [TMC_PENDING_FEATURES.md](TMC_PENDING_FEATURES.md). Synthesizes 22 Travel-related PRDs + 4 trackers (TODOS, MANUAL_CODING_BACKLOG, DECISIONS, CREDS) into a single pending-features view.

Use this doc to triage the next sprint — what's actually waiting on us vs. waiting on Yasin vs. waiting on counsel.

---

## At a glance

| Bucket | Items | Approximate cost | Who unblocks |
|---|---|---|---|
| **Codeable today (no creds, no decisions)** | 8 features | ~25-35 eng-days | Engineering |
| **Cred-blocked on Yasin** | 12 items | ~20-30 eng-days post-cred | Yasin |
| **Product-call decisions still open** | 0 Travel-specific | — | (cleared 2026-05-25) |
| **Legal counsel bundle** | 5 items (one combined session) | ~1-2 eng-days post-counsel | Travel Stall counsel |
| **Multi-day big-scope** | 4 features | ~40-65 eng-days | Engineering (decisions resolved) |
| **STALE-PRD §10 blocks** | 8 PRDs to refresh | ~3-4 hrs editing | Engineering |

Decisions tracker is **effectively flushed clean** for Travel as of 2026-05-25. Implementation is no longer blocked on ambiguity — it's blocked on (a) credential drops from Yasin and (b) engineering time on the big-scope clusters.

---

## What can ship TODAY (no creds, no decisions)

These are codeable now with zero external dependency. Pure engineering time.

| # | Feature | PRD | Est. cost | Why now |
|---|---|---|---|---|
| 1 | **Travel Pipeline Kanban hardening** — mobile touch drag-drop (`@dnd-kit/core`) + keyboard a11y + virtualization for >100 cards/column | [PRD_TRAVEL_PIPELINE_KANBAN](PRD_TRAVEL_PIPELINE_KANBAN.md) | ~3 days | Core Kanban is done; only 3 polish FRs left |
| 2 | **Quote Builder customer-facing accept landing** + share-link JWT + version-snapshot history + cron expiry sweep | [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md) | ~5 days | Builder slices 2-8 already shipped |
| 3 | **Billing reminder crons** (T-7/T-3/T-1 milestone fires) + Aged Receivable / Aged Payable reports + TCS Form-27EQ CSV endpoint | [PRD_TRAVEL_BILLING](PRD_TRAVEL_BILLING.md) | ~6 days | Schema + base CRUD shipped |
| 4 | **TMC Curriculum Mapping** — CSV import endpoint + CSV export + coverage report endpoint + engine-extension top-N recs on TMC submit | [PRD_TMC_CURRICULUM_MAPPING](PRD_TMC_CURRICULUM_MAPPING.md) | ~4 days | Model + admin UI shipped; CSV/integration are the last legs |
| 5 | **Passport OCR stub-mode client** (clean interim ~½ day drop noted in PRD §5.4) + upload route + verification queue UI | [PRD_PASSPORT_OCR](PRD_PASSPORT_OCR.md) | ~3 days | Schema + encryption already live; even stub-mode unblocks downstream UX work |
| 6 | **Voyagr CRM-side wiring** — `POST /api/v1/voyagr/leads` ALREADY SHIPPED (`0299031` + `84efe0f`); residual is admin VoyagrApiKeys UI + audit + e2e spec | [PRD_TRAVEL_MULTICHANNEL_LEADS](PRD_TRAVEL_MULTICHANNEL_LEADS.md) cluster F1 | ~1 day | Backend done; UI is the closing slice |
| 7 | **PRD_TRAVEL_PIPELINE_KANBAN** sub-brand filter URL-param persistence (`?subBrand=tmc,rfu`) per FR-3.15 | Same PRD | ~½ day | Filter chip shipped; just add URL sync |
| 8 | **Unified RateHawk + Booking stub-mode** `POST /api/travel/quote/unified-search` endpoint + `quoteRanker.js` (FR-5/FR-6 of RateHawk PRD) — runs against stubs today | [PRD_RATEHAWK_INTEGRATION](PRD_RATEHAWK_INTEGRATION.md) | ~2 days | Both stub clients already shipped; the fan-out + ranker are pure code |

**Total: ~25 eng-days of codeable work, no external dependencies.**

---

## What's blocked on Yasin's credentials

Items will ship within 1-5 days each once the credential lands. Listed by fan-out impact (most-PRDs-unblocked first).

### Q22 — Brand assets pack (highest fan-out — unblocks 4 PRDs)
Per-sub-brand logos (SVG + PNG light/dark), colour palettes, font files, PDF letterhead. 4 sub-deliverables: TMC / RFU / Travel Stall / Visa Sure.

**Unblocks:** [PRD_TRAVEL_MARKETING_FLYER](PRD_TRAVEL_MARKETING_FLYER.md), [PRD_THEME_MANAGEMENT](PRD_THEME_MANAGEMENT.md), [PRD_TRAVEL_PER_SUBBRAND_BRANDING](PRD_TRAVEL_PER_SUBBRAND_BRANDING.md), [PRD_TRAVEL_BILLING](PRD_TRAVEL_BILLING.md) PDF templates. Plus `[data-vertical="travel"]` palette.

### Q19 — RateHawk API key + ID + production base URL
Real-mode swap on the existing `ratehawkClient.js` stub. Unblocks the RFU lowest-rate hotel comparator.

**Unblocks:** [PRD_RATEHAWK_INTEGRATION](PRD_RATEHAWK_INTEGRATION.md). ~3-5 days post-cred.

### Q1 cluster — Callified.ai + AdsGPT handover packets
Two separate handovers, both from Yasin:
- **Callified.ai** API creds + per-tenant token + webhook URL + Section 13 packet → unblocks AI calling
- **AdsGPT** per-tenant token + account ID + per-platform ad-account IDs → unblocks marketing reports + conversion export

**Unblocks:** [PRD_AI_CALLING_CALLIFIED](PRD_AI_CALLING_CALLIFIED.md), [PRD_ADSGPT_MARKETING_REPORTS](PRD_ADSGPT_MARKETING_REPORTS.md). ~2-3 days each post-cred.

### Q9 — WhatsApp Business / Wati BSP credentials
Account number + API key + per-sub-brand sender IDs. Currently 7 cron jobs + 3 endpoints have stub WhatsApp dispatch waiting to swap to real.

**Unblocks:** Microsite OTP, web check-in WA notifications, journey reminders, marketplace lead WA pickup, multichannel leads PRD. ~½-1 day swap per consumer.

### Q3 — DigiLocker creds (`DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET`)
Partner account already confirmed exists per Q3. Unblocks real Aadhaar-XML pull for TMC parent registration (currently stubbed). ~½ day swap.

### Q-RFUG-1 — Zikr Cabs partner onboarding (~SAR 5k setup fee)
Prod + sandbox keys + webhook secret + API PDF.

**Unblocks:** [PRD_RFU_GROUND_SERVICES](PRD_RFU_GROUND_SERVICES.md) FR-3.1 (Zikr stub already shipped, swap to real). ~3-5 days post-cred.

### Q-RFUG-7 — Haramain HSR B2B partner program
First confirm program exists for B2B agents; then get creds + group-tier docs. 3-6 weeks vendor-side onboarding.

**Unblocks:** RFU Haramain HSR booking (stub already shipped). ~3-5 days post-cred.

### Booking.com Affiliate Partner Centre onboarding
`BOOKING_AFFILIATE_ID` + `BOOKING_API_KEY` + `BOOKING_API_SECRET`. 2-4 weeks vendor-side.

**Unblocks:** [PRD_BOOKING_EXPEDIA_DIRECT](PRD_BOOKING_EXPEDIA_DIRECT.md) Phase 1.5. ~5 days post-cred.

### LLM keys (Q-AI-1 / Q-AI-2 / Q-AI-3)
OpenAI + Anthropic + Google AI Studio. Stub-mode works for dev; real-mode swap is per-task-class.

**Unblocks:** Job A/B LLM narrative + Itinerary suggester + Marketing flyer copy + Marketing flyer image gen. ~½ day per task-class swap.

### Q-MF-1 — S3 or Cloudinary asset storage for Marketing Flyer
Decision: which provider + credentials.

**Unblocks:** Asset library + Multer pipeline + tag search ([PRD_TRAVEL_MARKETING_FLYER](PRD_TRAVEL_MARKETING_FLYER.md) FR-3.2). ~3 days post-cred.

### Q8 — Excel Software for Travel accounting bridge
API docs + sample export format + sandbox keys.

**Unblocks:** Tally-style CA export at the Travel-CRM-side mirror. ~2 days post-cred.

### Q-PB-2 — Razorpay subscriptions module check
Current `rzp_live_*` key may only have orders+payments scope. Need confirmation it supports subscriptions OR a new key with subscription scope.

**Unblocks:** Plans/billing self-serve subscriber flow.

---

## What's blocked on legal counsel (one bundled session)

Per DECISIONS_TRACKER's cross-cutting note, these can all land in a single counsel session:

1. **Q2 Aadhaar consent legal copy** — GS-drafted at `7d162cd`; awaiting Travel Stall counsel sign-off. ~15 min code post-counsel.
2. **TRAI pre-call recording disclosure wording** — [PRD_AI_CALLING_CALLIFIED](PRD_AI_CALLING_CALLIFIED.md) DC-5.
3. **AI-decline wording** — same PRD DC-4.
4. **PRD_PASSPORT_OCR PC-3 consent text** — bundles with Q2 Aadhaar.
5. **RFU per-portal ToS review** — 5 Saudi hotel portals' terms of service (for any scrape-vs-partner-API decisions per Q-RFUG-2..6).

Combined cost post-counsel: ~1-2 eng-days total (mostly string swaps).

---

## Multi-day engineering features (decisions resolved, engineering time only)

These are big enough to need dedicated planning cycles. Each gates one or more product capabilities.

| # | Feature | PRD | Estimate | Notes |
|---|---|---|---|---|
| 1 | **Travel Security architecture** — auth migration (JWT → httpOnly cookie + csurf) + CSP nonces + sequential IDs → opaque IDs + IDOR audit + PII list-endpoint summary projections | [PRD_TRAVEL_SECURITY_ARCHITECTURE](PRD_TRAVEL_SECURITY_ARCHITECTURE.md) | ~18-32 days | Closes 7 open GH issues (#914-#921). Critical-path before any production push to clients. DD-5.1, DD-5.2, DD-5.5 still need product call. |
| 2 | **Travel B2B Agent Portal** — sub-agent model + commission ledger + corporate accounts + travel policy validator + approval workflow + per-sub-brand theming | [PRD_TRAVEL_B2B_AGENT_PORTAL](PRD_TRAVEL_B2B_AGENT_PORTAL.md) | ~25-45 days | NOT STARTED. 7 DDs gating impl topology. |
| 3 | **Marketing Flyer canvas editor** — drag-drop block-type registry + brand-lock mode + AI copy/image (stub) + PNG/PDF render via Puppeteer + WhatsApp share | [PRD_TRAVEL_MARKETING_FLYER](PRD_TRAVEL_MARKETING_FLYER.md) | ~10 days (with Polotno embed) OR ~15 days (in-house) | DD-5.1 (Polotno vs in-house) needs product call before sprint 1. |
| 4 | **Itinerary visual day-by-day editor** — drag-drop builder + Leaflet+OSM map preview + OpenTripMap POI seed + LLM `itinerary-suggest` task class | [PRD_TRAVEL_ITINERARY_UPGRADES](PRD_TRAVEL_ITINERARY_UPGRADES.md) | ~10 days | Templates + sightseeing master already shipped. |

### Big-scope items waiting on either decisions or cred drops

| Feature | PRD | Estimate | What's needed first |
|---|---|---|---|
| **Flight Quotation Chrome plugin** (separate repo `globussoft-flight-plugin`) | [PRD_FLIGHT_PLUGIN_CHROME_EXTENSION](PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md) | ~12-16 days | DC-1 (repo location), DC-2 (Web Store publisher account), DC-3 (airline priority) from Yasin |
| **Airline Web Check-in Automation** — 4 airline adapters (IndiGo/AirIndia/Vistara/Emirates) under Playwright headless | [PRD_AIRLINE_WEBCHECKIN_AUTOMATION](PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md) | ~12-17 days | 6 DCs from Yasin (Playwright vs MCP, priority, containerization, retry, ToS counsel, notification channel) |
| **RFU 5-portal Saudi hotel orchestrator** — Almosafer/Tajawal/MyHoliday2/Pilgrims Choice/Reservation House | [PRD_RFU_GROUND_SERVICES](PRD_RFU_GROUND_SERVICES.md) | ~10-15 days OR 2-4 weeks/portal | Q-RFUG-2..6 decisions (scrape vs partner API per portal) |
| **Unified `POST /api/leads/intake` envelope** + dedupe engine + routing-rules engine + Form-ID mapping + Touchpoint chain | [PRD_TRAVEL_MULTICHANNEL_LEADS](PRD_TRAVEL_MULTICHANNEL_LEADS.md) | ~8-15 days | Per-channel scaffolding done; this is the unifying layer |

---

## STALE-PRD list (§10 status blocks out of date)

These PRDs claim things are "not started" or "partial" when the code actually ships them. Updating §10 prevents future planning cycles from re-scoping shipped work.

| PRD | What's claimed in §10 | What's actually shipped |
|---|---|---|
| [PRD_VISA_SURE_PHASE_3](PRD_VISA_SURE_PHASE_3.md) | Routes 🔴 NOT-STARTED, UI pages 🔴 NOT-STARTED, Risk-flag cron 🔴 NOT-STARTED | All 4 shipped (`travel_visa.js` + 6 UI pages + `visaRiskFlagEngine.js` + analytics) |
| [PRD_TMC_CURRICULUM_MAPPING](PRD_TMC_CURRICULUM_MAPPING.md) | CurriculumMapping model + admin + CRUD all NOT-STARTED | Model + admin (`CurriculumAdmin.jsx`) + CRUD all shipped (under `TravelCurriculumMapping`) |
| [PRD_TRAVEL_QUOTE_BUILDER](PRD_TRAVEL_QUOTE_BUILDER.md) | `/quotes` still resolves to `QuotesComingSoon.jsx` | App.jsx now mounts `QuoteBuilder.jsx` + `QuotesAdmin.jsx` (slices 2-8 shipped) |
| [PRD_TRAVEL_ITINERARY_UPGRADES](PRD_TRAVEL_ITINERARY_UPGRADES.md) | "no template library; no sightseeing master" | Both shipped — `ItineraryTemplates.jsx` + `SightseeingMaster.jsx` + route CRUD |
| [PRD_TRAVEL_MARKETING_FLYER](PRD_TRAVEL_MARKETING_FLYER.md) | "ZERO flyer authoring surface" | `FlyerTemplates.jsx` list + `MarketingFlyerStudio.jsx` shell shipped (slices 1-5) |
| [PRD_TRAVEL_GST_COMPLIANCE](PRD_TRAVEL_GST_COMPLIANCE.md) | "limited shipped surface" | GSTR-1/3B/HSN/Aged-Receivable/Tax-Summary CSV export endpoints all live |
| [PRD_AI_CALLING_CALLIFIED](PRD_AI_CALLING_CALLIFIED.md) | "sandbox-mock file does not exist" | `backend/scripts/sandbox/callified-mock.js` exists |
| [TRAVEL_CRM_PRD.md §4.7](TRAVEL_CRM_PRD.md) | "AWS Mumbai (ap-south-1)" | Q6 decided on-prem hosting |
| [PRD_RFU_GROUND_SERVICES](PRD_RFU_GROUND_SERVICES.md) | All three integrations 🔴 NOT-STARTED | Zikr + HHR shipped as `XXX_NOT_YET_ENABLED`-throwing stubs (matches cred-blocked-stub recipe) |
| [TRAVEL_CRM_GAP_AUDIT_2026-05-22.md](TRAVEL_CRM_GAP_AUDIT_2026-05-22.md) | 2026-05-22 snapshot | 17 days stale; GST endpoints + commission ledger landed since |
| [PRD_BOOKING_EXPEDIA_DIRECT](PRD_BOOKING_EXPEDIA_DIRECT.md) | FR-1/FR-2 names `bookingComClient.js` + `expediaEanClient.js` | Code shipped as unified `bookingExpediaClient.js` wrapper (architecture diverged — PRD update #4 acknowledges but FR table not refreshed) |

---

## What's NOT in this doc

- **TMC-specific gaps** — see [TMC_PENDING_FEATURES.md](TMC_PENDING_FEATURES.md). The 6 TMC 🔵 BLOCKED rows (T18-T23) are also Yasin-pending but live in their own pending-features companion.
- **Wellness vertical gaps** — separate planning thread (PRD_ZYLU_GAP_CONSOLIDATED.md and friends).
- **Generic CRM gaps** — not Travel-vertical.

---

## Recommended next moves

1. **Send Yasin a single message bundling Q22 + Q19 + Q1 (Callified packet) + Q1 (AdsGPT packet) + Q-RFUG-1 + Q9 + Q3.** Most are file-attachment drops; bundling saves round-trips. See [CREDS_TRACKER.md](CREDS_TRACKER.md) for the exact ask wording.
2. **Schedule the bundled counsel session** for the 5 legal items above. ~30-45 min session if pre-briefed.
3. **Trigger an autonomous build cron** for the 8 "codeable today" items above. Pattern matches `cd79917a` (TMC cron, just retired). The 4 multi-day items above are the next planning slot after these 8 ship.
4. **One-shot STALE-PRD sweep** to update the 11 PRDs above (~3-4 hrs editing time). Stops future planning cycles from rediscovering shipped work.
