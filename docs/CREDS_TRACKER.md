# Credentials & Asset Chase Tracker

Consolidated index of every credential, vendor doc, brand asset, or domain registration blocking implementation across the 33 PRDs in `docs/`. Companion to `docs/DECISIONS_TRACKER.md` (which captures product/design decisions).

**Updated:** 2026-05-23 (tick #74, authored by overnight cron)
**Total items pending:** 47 across 6 categories.

---

## How to use this tracker

- **Drive cred-chase agendas** — each row names: what's needed, who owns it (Yasin / Rishu / Suresh / external vendor / counsel), what implementation it blocks, and the workaround currently in place (usually a `// STUB:` marker or env-var fallback to a synthetic client).
- **Mark items RESOLVED inline** — when a cred drops, edit the row from `[PENDING]` → `[RESOLVED 2026-MM-DD: <one-line>]` and link the commit that swaps the stub.
- **Don't confuse cred-chase with design-decision** — if the user needs to PICK something (vendor / approach / pattern), it goes in DECISIONS_TRACKER. If the user needs to PROVIDE / CHASE something (key / doc / asset), it goes here.
- **Q-markers in this tracker mirror `docs/TRAVEL_CRM_OPEN_QUESTIONS.md`** — the 25 Q-numbered items there were all "decided" 2026-05-20 in terms of what to do; the CRED-chase rows below capture what's still being *delivered* against those decisions. A row stays open here until the cred / asset / doc actually lands in GS hands.
- **Per-PRD cred-chase IDs** (e.g. `Q-MF-1`, `Q-AI-3`, `Q-IT-1`, `Q-PB-2`, `Q-BR-1`, `Q-BILL-1`, `Q-ZG-1`, `Q-RFUG-x`) live in the source PRD's §5 — preserve the source ID in the row so cross-references stay clickable.

---

## Items by category

### Category 1: Vendor API credentials (24 items)

- **Q9** [PENDING] WhatsApp Business API (Wati) — 3 WABA accounts: TMC / RFU / ops-shared. **Owner:** Yasin (via Wati account team + Meta Business Manager access). **Blocks:** 7 cron engines + 3 endpoints (sequence, scheduledEmail, slaBreach, appointmentReminders, wellnessOps, marketing, workflow). **Workaround:** STUB-dispatching with correct WABA selection routed through `backend/lib/subBrandConfig.js` (commit `621aab7`). **Real-mode swap:** ~1-2 days post-cred — see `docs/MANUAL_CODING_BACKLOG.md` cluster C1. **Cred chase doc:** `docs/WHATSAPP_INTEGRATION_PRD.md`. **Decision pinned:** 2026-05-20 (Q9 in `TRAVEL_CRM_OPEN_QUESTIONS.md`).

- **Q11** [PENDING] LLM API keys — Gemini 2.5 (itinerary draft / sentiment / KPI), Gemini Live (AI qualification call), Gemini Vision (document OCR fallback), Perplexity (diagnostic interpretation, real-time search). **Owner:** GS / Yasin. **Blocks:** every AI surface (lib/llmRouter.js, AI Surfaces PRD's 8 new tasks, sentimentEngine, dealInsightsEngine, leadJunkFilter LLM fallback). **Workaround:** stub responses in `lib/llmRouter.js`; cost-tracking + budget caps un-wired. **Real-mode swap:** ~1 day post-cred — see cluster C2 + `Q-AI-1/2/3` in `PRD_AI_SURFACES.md` §5.

- **Q-AI-1** [PENDING] OpenAI API key (GPT-4) — overlaps Q11 task-class routing. **Owner:** Travel Stall (Yasin). **Where:** `SupplierCredential category='llm-key' supplier='openai'`. **Source:** `PRD_AI_SURFACES.md` §5.

- **Q-AI-2** [PENDING] Anthropic API key (Claude Opus + Haiku). **Owner:** Travel Stall. **Where:** `SupplierCredential category='llm-key' supplier='anthropic'`. **Source:** `PRD_AI_SURFACES.md` §5.

- **Q-AI-3** [PENDING] Google AI Studio API key (Gemini Pro + Flash). **Owner:** Travel Stall. **Overlaps:** Q-MF-2 (Marketing Flyer AI image-gen), Q-IT-2 (Itinerary suggest), Q11 routing. **Source:** `PRD_AI_SURFACES.md` §5.

- **Q-AI-5** [DEFERRED] EU-region endpoints (OpenAI EU + Anthropic EU + Gemini EU) — needed only when first EU tenant lands; not a Phase 1 blocker. **Source:** `PRD_AI_SURFACES.md` §5.

- **Q19** [PENDING] RateHawk API key + API ID + production base URL. **Owner:** Yasin (per Q19 decision 2026-05-20 — RateHawk-only P1). **Blocks:** RFU unified-search lowest-rate auto-pick + `backend/services/ratehawkClient.js` (NOT YET WRITTEN — unlike Q9/Q11/Q3 which have stubs). **Effort:** ~3-5 days post-cred (write client from scratch) — cluster C4. **Source:** `PRD_RATEHAWK_INTEGRATION.md` §5.1.

- **Q-RFUG-1** [PENDING] Zikr Cabs partner-account onboarding — production + sandbox API keys + webhook secret + API docs PDF. **Owner:** Yasin (paid ~SAR 5k setup + per-booking commission, OR confirmation RFU already has an account). **Blocks:** GH #926, FR-3.1.a–h of `PRD_RFU_GROUND_SERVICES.md`. **Effort post-cred:** ~3-5 days. **Source:** `PRD_RFU_GROUND_SERVICES.md` §5.1.

- **Q-RFUG-2..6** [PENDING] 5 Saudi hotel portals — Almosafer, Tajawal, MyHoliday2, Pilgrims Choice, Reservation House. Per-portal: scrape-with-ToS-review OR partner-API onboarding + sandbox key. **Owner:** Yasin + GS counsel (ToS review). **Blocks:** GH #927 (5-portal orchestrator), FR-3.2.a per-portal. **Effort:** 0 weeks (scrape) or 2-4 weeks per portal (partner). **Source:** `PRD_RFU_GROUND_SERVICES.md` §5.1.

- **Q-RFUG-7** [PENDING] Haramain HSR B2B partner program — confirm program exists, onboarding + sandbox + production keys + API docs + group-booking tier confirmation. **Owner:** Yasin (Saudi-govt-affiliated; 3-6 weeks vendor-side). **Blocks:** GH #928, FR-3.3.a–h of `PRD_RFU_GROUND_SERVICES.md`. **Source:** `PRD_RFU_GROUND_SERVICES.md` §5.1.

- **Q3** [PENDING] DigiLocker partner credentials — `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET` + Aadhaar XML pull endpoint config. **Owner:** Yasin (Travel Stall already has the partner account per Q3 decision 2026-05-20; share via secure channel). **Blocks:** real Aadhaar OCR swap in TMC enrollment flow. **Workaround:** stub at `backend/services/digilockerClient.js` (`1babe1b`). **Effort post-cred:** ~1 day (cluster C3). **Source:** `PRD_TRAVEL_CRM.md` Q3 + `docs/DIGILOCKER_INTEGRATION_SPEC.md`.

- **Q1-Callified** [PENDING] Callified.ai API base URL + per-tenant API key + persona library + webhook signing secret + recording URL signing key + OpenAPI docs. **Owner:** Yasin (single multi-vendor packet committed 2026-05-13 email). **Blocks:** form-vs-call compute live mode, AI qualification calls, real call recording. **Workaround:** `external.js /calls/POST/PATCH` endpoints accept hand-typed `callTranscript`. **Effort post-cred:** ~2-3 days (cluster C6). **Source:** `PRD_AI_CALLING_CALLIFIED.md` §5.1.

- **Q1-AdsGPT** [PENDING] AdsGPT API key (per-tenant token) + account ID + per-platform ad-account IDs + (optional) webhook signing key. **Owner:** Yasin (Path A: Yasin generates himself; Path B: delegate to GS via workspace invite to `sumit@chingari.io`). **Blocks:** marketing-reports integration, conversion-export feedback loop. **Effort post-cred:** ~30 min env wiring + ~2-3 days endpoint work (cluster C7). **Source:** `PRD_ADSGPT_MARKETING_REPORTS.md` §5.1, §5.3.

- **Q-PC1-passport** [PENDING] Passport OCR vendor credentials — gated on PC-1 vendor pick (Google DocAI vs Azure Form Recognizer vs hybrid vs Indian alternative). **For Google DocAI:** `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_DOCAI_PROJECT_ID` + `GOOGLE_DOCAI_PASSPORT_PROCESSOR_ID` + `GOOGLE_DOCAI_LOCATION` (`asia-south1` per PC-2). **For Azure:** `AZURE_FORM_RECOGNIZER_ENDPOINT` + `AZURE_FORM_RECOGNIZER_KEY`. **Workaround:** stub at `backend/services/passportOcrClient.js` mirroring `digilockerClient.js`. **Source:** `PRD_PASSPORT_OCR.md` §5.2.

- **Booking.com partner creds** [PENDING] `BOOKING_COM_CLIENT_ID` + `BOOKING_COM_CLIENT_SECRET` (OAuth2 m2m) + property-data subscription tier + `BOOKING_COM_WEBHOOK_SECRET` + `BOOKING_COM_BASE_URL`. **Owner:** Travel Stall (Yasin) — Affiliate Partner Centre application → KYB → contract → cred drop, 2-4 weeks vendor-side. **Blocks:** Phase 1.5 / Phase 2 Booking.com expansion of unified-search. **Source:** `PRD_BOOKING_EXPEDIA_DIRECT.md` §5.1. **Decision pinned:** P1.5 per Q19 2026-05-20.

- **Expedia EAN partner creds** [PENDING] `EXPEDIA_EAN_API_KEY` + `EXPEDIA_EAN_SHARED_SECRET` (HMAC-SHA256) + per-tenant EAN account ID + `EXPEDIA_EAN_BASE_URL`. **Owner:** Travel Stall (Yasin). 2-4 weeks vendor-side. **Blocks:** Phase 2 Expedia inventory in unified-search. **Source:** `PRD_BOOKING_EXPEDIA_DIRECT.md` §5.1.

- **Q-MF-1** [PENDING] Asset storage credentials — S3 access key + secret + bucket OR Cloudinary cloud name + API key + API secret. **Owner:** Yasin / GS infra. **Blocks:** FR-3.2.2 (Marketing Flyer asset upload at scale beyond local disk + the wider CRM asset-storage modernization). **Source:** `PRD_TRAVEL_MARKETING_FLYER.md` §5.

- **Q-MF-2** [PENDING] AI image-gen API key — OpenAI / Replicate / Midjourney enterprise key. **Overlaps:** Q-AI-3. **Blocks:** FR-3.2.4 + FR-3.6.3 live AI image generation; stub mode ships without. **Source:** `PRD_TRAVEL_MARKETING_FLYER.md` §5.

- **Q-IT-1** [DEFERRED] Mapbox API key — optional, DD-5.4 defaults to OSM + Leaflet (no key needed). Unlocks ~10 lines of provider-swap if polish tier matters later. **Source:** `PRD_TRAVEL_ITINERARY_UPGRADES.md` §5.

- **Q-PB-1** [PENDING] Stripe Customer + Subscription API access — secret key + restricted-scope key for Subscription / Customer / PaymentMethod APIs. **Overlaps:** GH #896 cred chase. **Source:** `PRD_PLANS_BILLING_SELF_SERVE.md` §5.

- **Q-PB-2** [PENDING] Razorpay subscriptions module — `rzp_live_*` key with Subscriptions module enabled on the Razorpay dashboard (current test key may have only orders + payments). **Decision pinned:** 2026-05-20 (Q4 — Razorpay for Travel). **Source:** `PRD_PLANS_BILLING_SELF_SERVE.md` §5.

- **Q-ZG-1** [PENDING] Biometric device vendor API credentials — after DD-5.6 picks vendor (Mantra / Realtime / eSSL / other). **Owner:** Rishu. **Blocks:** Wellness biometric attendance flow. **Source:** `PRD_ZYLU_GAP_CONSOLIDATED.md` §5.

- **Q-ZG-3** [PENDING] S3 / storage credentials for microsite logo + hero image hosting (or use existing tenant file storage). **Source:** `PRD_ZYLU_GAP_CONSOLIDATED.md` §5.

- **Voyagr per-site API key** [PARTIAL] Per-site API key issued via CRM admin UI for the Voyagr lead-capture endpoint. **Status:** backend SHIPPED (commit `0299031` + per-sub-brand scoping `84efe0f`); voyagr-side env-var wiring is the residual chase. **Source:** `MANUAL_CODING_BACKLOG.md` cluster F1.

### Category 2: Brand assets (5 items)

- **Q22 / Q-BR-1** [PENDING] Yasin brand pack per sub-brand — for each of TMC / RFU / Travel Stall / Visa Sure: logo PNG (light + dark) + brand color hex + brand fonts (Google Fonts family or upload) + tagline + PDF cover templates. **Owner:** Yasin. **Decision pinned:** "All ready — share now" (Q22 2026-05-20) via Drive/Figma. **Blocks (simultaneously):** `PRD_TRAVEL_MARKETING_FLYER.md` AC-6.1 + `PRD_THEME_MANAGEMENT.md` AC-6.3 + `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` AC-6.1–6.10 + `PRD_TRAVEL_BILLING.md` DD-5.7 + the CRM-wide `[data-vertical="travel"]` placeholder palette (navy `#122647` / gold `#C89A4E`) in `CLAUDE.md` line 27. **Workaround:** travel theme uses placeholder palette pending handover. **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q22 + `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` §5.

- **TMC starter brand kit** [PENDING] TMC logo (SVG + PNG, light + dark) + TMC navy/gold palette + font stack + Headmaster-trip PDF cover template. **Owner:** Yasin (Q22 sub-deliverable). **Source:** `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` §5 DD-5.3.

- **RFU starter brand kit** [PENDING] RFU logo + Umrah-green palette + Makkah-skyline PDF cover + Arabic-script font stack (Phase 2 RTL nice-to-have). **Owner:** Yasin (Q22 sub-deliverable). **Source:** same as above.

- **Travel Stall starter brand kit** [PENDING] Travel Stall logo + warm-orange palette + family-holiday PDF cover. **Owner:** Yasin (Q22 sub-deliverable). **Phase:** Phase 2 (Travel Stall scope per Q17 decision 2026-05-20). **Source:** same as above.

- **Visa Sure starter brand kit** [PENDING] Visa Sure logo + customs-blue palette + visa-application PDF cover. **Owner:** Yasin (Q22 sub-deliverable). **Phase:** Phase 3 (Visa Sure scope per Q18 decision 2026-05-20). **Source:** same as above.

### Category 3: Vendor docs (no key yet, just API spec) (8 items)

- **Q8** [PENDING] Excel Software for Travel — REST API documentation (endpoints + auth + payload shapes + rate limits + error responses) OR sample CSV / file-import spec (column headers + delimiters + encoding + date format + decimal separator + how cancellations/refunds are encoded). **Owner:** Yasin (chase the vendor). **Decision pinned:** 2026-05-20 (Q8 — has REST API, will share docs). **Blocks:** Excel Software accounting bridge — write `backend/services/excelSoftwareClient.js` (NO STUB YET — vendor-doc-blocked). **Effort:** ~3-5 days post-docs (cluster C5). **Source:** `PRD_EXCEL_SOFTWARE_ACCOUNTING.md` §5.1.

- **Zikr Cabs API docs** [PENDING] API spec PDF (or OpenAPI / Postman collection) + cancellation-policy reference. **Owner:** Yasin (Q-RFUG-1 sub-deliverable). **Source:** `PRD_RFU_GROUND_SERVICES.md` §5.3.

- **5 Saudi hotel portal docs** [PENDING] Each of 5 portals' partner-API docs OR scraping target URLs + example HTML pages (for scraper-path portals) + cancellation-policy reference per portal. **Owner:** Yasin (Q-RFUG-2..6 sub-deliverable). **Source:** `PRD_RFU_GROUND_SERVICES.md` §5.3.

- **Haramain HSR API spec** [PENDING] Partner API spec + group-booking tier documentation. **Owner:** Yasin (Q-RFUG-7 sub-deliverable). **Source:** `PRD_RFU_GROUND_SERVICES.md` §5.3.

- **Q5** [PENDING] Tally CA export sample — column headers, account-code conventions, voucher-type encoding. **Owner:** Yasin (Q5 decision 2026-05-20 — "Have a Tally export to share"). **Blocks:** Excel Software CA-export mirror format. **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q5.

- **Meta Lead Ads webhook signature spec** [PENDING] `X-Hub-Signature-256` HMAC verification details. **Owner:** GS engineering (read from Meta docs). **Source:** `PRD_TRAVEL_MULTICHANNEL_LEADS.md` §5.3.

- **IndiaMART / JustDial / TradeIndia API rate-limit + response shape docs** [PENDING] Per-marketplace API rate limits + response envelope shapes + webhook payload shapes. **Source:** `PRD_TRAVEL_MULTICHANNEL_LEADS.md` §5.3.

- **Wati WhatsApp webhook shape** [PENDING] Wati's webhook envelope (channel-specific to Wati, not WhatsApp Cloud API directly — they wrap it). **Source:** `PRD_TRAVEL_MULTICHANNEL_LEADS.md` §5.3.

### Category 4: Counsel-owned (4 items)

- **Q2** [PARTIAL] Aadhaar consent legal copy — GS-drafted at `7d162cd` (`docs/TRAVEL_AADHAAR_CONSENT_DRAFT.md`); awaiting Travel Stall counsel review + sign-off + replacement of placeholder string in `routes/travel_diagnostics.js`. **Owner:** Travel Stall counsel. **Decision pinned:** 2026-05-20 (Q2 — GS drafts, counsel reviews). **Effort post-counsel:** ~15 min string swap. **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q2 + `MANUAL_CODING_BACKLOG.md` cluster E1.

- **TRAI pre-call recording disclosure** [PENDING] Exact wording per DC-5 of `PRD_AI_CALLING_CALLIFIED.md`. GS recommendation: "This call is from <SubBrand> and may be recorded for service quality." in Eng/Hin/Urdu. Counsel review on whether AI-agent disclosure is also required under emerging DPDP / DoT-AI norms. **Owner:** GS counsel + Travel Stall counsel. **Source:** `PRD_AI_CALLING_CALLIFIED.md` §5.2 DC-5.

- **AI-decline wording** [PENDING] DC-4 of `PRD_AI_CALLING_CALLIFIED.md` — exact wording when a parent declines AI engagement. GS recommendation: "Understood. I'll have a senior travel consultant call you back within the next hour. Thank you for your time." Counsel review. **Source:** `PRD_AI_CALLING_CALLIFIED.md` §5.2 DC-4.

- **Passport OCR consent text (PC-3)** [PENDING] Legal copy shown before image upload, mirroring Q2 Aadhaar format. Counsel reviews wording once; same wording applies cross-document. **Owner:** counsel (same queue as Q2). **Source:** `PRD_PASSPORT_OCR.md` §5.1 PC-3.

### Category 5: Domain / DNS / hosting (3 items)

- **Q21** [PENDING] DNS access + wildcard SSL for `*.tmc.travelstall.in` — Travel Stall ops owns DNS. **Owner:** Travel Stall ops. **Decision pinned:** 2026-05-20 (Q21 — `trip-<code>.tmc.travelstall.in`). **Blocks:** TMC microsite dynamic subdomain provisioning + wildcard SSL setup. **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q21.

- **Q6** [PENDING] On-prem hosting access — SSH creds + server specs + DNS control. **Owner:** Travel Stall ops. **Decision pinned:** 2026-05-20 (Q6 — on-prem / Travel Stall-managed; surfaced R11 risk in `TRAVEL_CRM_RISKS.md`). **Blocks:** Travel CRM Phase 1 deploy target (GS deploys to Travel Stall infra, not AWS Mumbai). **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q6.

- **Voyagr per-site domain CORS allowlist** [PARTIAL] Each voyagr site's domain added to `corsAllowlist` in `backend/server.js`. **Status:** infrastructure shipped; per-domain entries are added as each site goes live. **Source:** `MANUAL_CODING_BACKLOG.md` cluster F1.

### Category 6: SaaS account provisioning (3 items)

- **Q7** [PENDING] Google Workspace SSO admin access — for OAuth client + Workspace admin handle to provision UAT users + admin handle for shared mailbox setup. **Owner:** Yasin. **Decision pinned:** 2026-05-20 (Q7 — Google Workspace). **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q7.

- **Q15** [PENDING] UAT user names — 1 lead + 3 testers per brand × 2 brands = 8 users (TMC + RFU). **Owner:** Yasin. **Decision pinned:** 2026-05-20 (Q15 — All identified, will share). **Blocks:** UAT seed users at W5. **Source:** `TRAVEL_CRM_OPEN_QUESTIONS.md` Q15.

- **Stripe + Razorpay activation per #896** [PARTIAL] Production Stripe + Razorpay account activation for the Globussoft entity issuing invoices + KYB approval + restricted-scope keys per-environment. **Status:** test keys exist; production activation pending. **Overlaps:** Q-PB-1 + Q-PB-2. **Source:** GH #896 + `PRD_PLANS_BILLING_SELF_SERVE.md` §5.

---

## Items by urgency

### Block immediate implementation (highest priority — single cred unblocks 3+ surfaces)

- **Q22 Yasin brand pack** — blocks `PRD_TRAVEL_MARKETING_FLYER` + `PRD_THEME_MANAGEMENT` + `PRD_TRAVEL_PER_SUBBRAND_BRANDING` + `PRD_TRAVEL_BILLING` PDF templates + the CRM-wide `[data-vertical="travel"]` placeholder palette ALL AT ONCE. Highest-fanout cred-chase item.
- **Q9 Wati WABA × 3** — 7 cron engines + 3 endpoints currently stubbing dispatch. The `subBrandConfig.js` pre-routing is shipped; the swap-in is mechanical.
- **Q11 LLM keys** — every AI surface (8 new AI Surfaces tasks + sentimentEngine + dealInsightsEngine + leadJunkFilter fallback + form-vs-call AI). Cost-tracking + budget caps un-wired without it.
- **Q3 DigiLocker creds** — TMC Aadhaar enrollment flow is stubbed; partner account confirmed exists Travel Stall-side per Q3 2026-05-20.
- **Q19 RateHawk** — Phase 1 hotel rate comparator entirely gated on this; client doesn't even exist yet (unlike Q9/Q11/Q3 which have stubs).

### Block per-PRD implementation (medium priority)

- **Q-RFUG-1..7** — 7 RFU-specific vendor onboardings (Zikr Cabs + 5 Saudi hotel portals + Haramain HSR). Each blocks a specific FR cluster in `PRD_RFU_GROUND_SERVICES.md` but RFU can ship its non-ground-services functionality without them.
- **Q1-Callified + Q1-AdsGPT** — bundled in Yasin's Section 13 multi-vendor packet. Each blocks one PRD (AI Calling + AdsGPT Marketing Reports). Cluster C6 + C7 work post-cred is ~2-3 days each.
- **Q8 Excel Software docs** — blocks `PRD_EXCEL_SOFTWARE_ACCOUNTING` (no stub today — vendor-doc-blocked). Q5 Tally CA export sample supports the design but doesn't block start.
- **Q-PC1-passport** — blocks `PRD_PASSPORT_OCR`. PC-1 vendor pick (Google DocAI vs Azure vs hybrid) must land first; then ~5-min cred drop + ~5-6 days engineering.
- **Q-MF-1 + Q-MF-2** — block `PRD_TRAVEL_MARKETING_FLYER` asset-storage-at-scale + AI image-gen. Cloudinary or S3 + DALL-E / SD / MJ keys.
- **Booking.com + Expedia partner creds** — block Phase 1.5/2 expansion of unified-search to Booking + Expedia per Q19 decision.
- **Q2 Aadhaar consent (PARTIAL)** — counsel review on GS-drafted text. ~15-min code swap post-approval.
- **Q-PB-1 + Q-PB-2 + Stripe/Razorpay activation** — block `PRD_PLANS_BILLING_SELF_SERVE` production rollout.
- **Q21 DNS + Q6 on-prem hosting** — block Travel CRM Phase 1 deploy + microsite subdomain provisioning. Travel Stall ops-owned.

### Defer / not blocking (low priority)

- **Q-AI-5** EU-region LLM endpoints — needed only when first EU tenant lands; not Phase 1.
- **Q-IT-1** Mapbox key — optional; DD-5.4 defaults to OSM + Leaflet (no key).
- **Q-MF-3** WhatsApp Business creds for flyer share-from-CRM — overlaps Q9; resolves when Q9 lands.
- **Q-IT-2** Gemini key for itinerary-suggest — overlaps Q-AI-3 (same key, different task class); resolves when Q11 routing lands.
- **TRAI / AI-decline / passport-OCR consent wording** — counsel-owned; GS recommendations stand pending counsel sign-off.
- **Q-ZG-1 biometric device + Q-ZG-3 wellness microsite storage** — wellness-vertical, separate timeline from Travel Phase 1.
- **Travel Stall + Visa Sure starter brand kits** — Q22 sub-deliverables for Phase 2 (Travel Stall) + Phase 3 (Visa Sure); not Phase 1.
- **Q15 UAT user names** — needed by W5; not blocking Day 0 kickoff.
- **Q7 Google Workspace SSO admin handle** — needed for first SSO test; not blocking other work.

---

## Resolution log

_(Empty — append `RESOLVED YYYY-MM-DD: <one-line> — commit <sha>` rows here as creds / assets land.)_
