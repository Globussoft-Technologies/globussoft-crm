# Manual Coding Backlog — for engineer assignment

**Generated:** 2026-05-23 from the post-PRD-drive audit state. Each item below is **NOT autonomous-doable** by the cron — it needs a human engineer with judgment, multi-day attention, design alignment, or post-cred-drop integration work. Filed as ready-to-bulk-create GitHub issues; copy any block into `gh issue create --title "..." --body "..."` or paste into the web UI.

**Category labels suggested:** `needs-design-call`, `multi-day-feature`, `cred-dependent`, `wellness-session`, `product-call`.

---

## A. NEEDS DESIGN CALL FIRST (single engineer can't decide alone)

These are architecture changes whose **first hour is a meeting, not a commit**. Don't assign to an engineer cold — schedule the call first, then assign the implementation.

### A1. Move JWT from localStorage to HttpOnly cookies
**Labels:** `needs-design-call`, `security`, `cross-cutting`

**Why manual:** touches every E2E spec + every frontend page that reads the token + every API consumer. Auto-shipping breaks ~50 specs and the demo simultaneously.

**Design call topics:**
- Cookie name + `SameSite` + `Secure` + `Path` flags
- Bearer-token deprecation timeline (or permanent coexistence?)
- Cross-origin handling (frontend on `crm.globusdemos.com`, backend on same domain via Nginx — `SameSite=Strict` should work)
- Backwards-compat for existing demo bookmarks with old tokens
- Refresh-token strategy (none today; should we add?)

**After the call — implementation scope:** ~2 days. Add cookie support alongside bearer (don't remove bearer yet); ship behind a feature flag; flip to cookie-default after 1 week of dual-mode.

**Originating issues:** #914, #915, #916 (cluster)

---

### A2. CSP `unsafe-inline` removal — adopt nonce strategy
**Labels:** `needs-design-call`, `security`, `cross-cutting`

**Why manual:** every inline `<script>` and `<style>` in the React-rendered HTML needs a per-request nonce; Vite's dev server doesn't emit them; needs build-step changes too.

**Design call topics:**
- Per-request nonce generation (`crypto.randomBytes(16)` in Express middleware)
- Vite plugin or runtime injection?
- Dev vs prod CSP differences (Vite needs `unsafe-eval` in dev — keep that scoped)
- Backwards-compat for any third-party widget that injects inline (Stripe.js, Mailgun, etc.)

**After the call — implementation scope:** ~1-2 days.

**Originating issue:** #918 (or similar — verify with `gh issue list --search "CSP"`)

---

### A3. Sequential IDs → opaque IDs across travel models
**Labels:** `needs-design-call`, `security`, `cross-cutting`, `schema-migration`

**Why manual:** the schema is full of `Int @id @default(autoincrement())`. Replacing with UUIDs / hashids / per-tenant slugs is a multi-week migration touching every route handler + every E2E spec.

**Design call topics:**
- ID scheme: UUID v4 / hashids / nanoid / per-tenant slug?
- Migration strategy: dual-column (keep `int id` + add `opaque_id`) → deprecate int → drop int? Or hard cutover?
- URL-path implications (`/travel/itineraries/42` → `/travel/itineraries/abc-xyz-123`)
- Per-tenant ID space vs global?
- Existing demo bookmarks — handle via redirect table?

**After the call — implementation scope:** ~1-2 weeks (every travel route + spec + frontend page).

**Originating issues:** #917, #920 (cluster)

---

### A4. IDOR audit — defense pattern across all travel routes
**Labels:** `needs-design-call`, `security`, `multi-day-feature`

**Why manual:** each route currently has its own `tenantWhere` / `requireXAccess` boilerplate; some are duplicated, some are missing edge cases (e.g. PATCH path-param mismatches body-param). Need a unified middleware that enforces "this user can touch this entity" for every resource.

**Design call topics:**
- One canonical `requireResourceAccess(modelName, paramName)` middleware vs per-route checks?
- How to wire it without breaking the 30+ travel routes that have bespoke logic
- Audit log emission on denial
- Test strategy: per-resource positive + negative pair

**After the call — implementation scope:** ~1 week (audit + middleware + per-route adoption + spec coverage).

**Originating issues:** #919, #921 (cluster)

---

## B. MULTI-DAY FEATURE BUILDS (single engineer, focused multi-day work)

These are concrete feature specs. The Day-1 scaffold may be cron-doable, but the meat needs an engineer for 3-10 days.

### B1. Pipeline Kanban view (#897)
**Labels:** `multi-day-feature`, `frontend`, `travel`

**Why manual:** drag-drop board + stage column persistence + WIP limits + filter-by-sub-brand + bulk-move + activity feed per deal. ~5 days. Cron can ship the empty grid + stage columns as Day-1 scaffold; everything else is engineer work.

**Acceptance criteria:**
- Drag a deal between stages → `PATCH /api/deals/:id { stage }` fires + optimistic UI
- Stage columns configurable per pipeline (read from `PipelineStage` rows)
- Sub-brand filter chip works
- Empty state per column ("No deals in <stage>")
- Mobile-responsive (stack columns vertically <768px)

---

### B2. Quote Builder (#900)
**Labels:** `multi-day-feature`, `frontend`, `backend`, `travel`

**Why manual:** line-items table + tax + discount + currency + PDF export + send-via-WA/email flow. Sits at `/quotes` (currently 404 per #886). ~5-7 days.

**Acceptance criteria:**
- New `/quotes` route mounting `QuoteBuilder.jsx`
- Line items: description + qty + unit price + tax % + subtotal (live calc)
- Total: subtotal + tax + discount + grand-total bands
- Save as draft → `POST /api/travel/quotes`
- Generate PDF via `pdfRenderer.js` (mirror itinerary PDF pattern)
- Send via WhatsApp (uses subBrandConfig helper for WABA selection — already shipped at `621aab7`) — STUB until Q9 lands

---

### B3. Phase 3 Visa Sure — route + UI + risk-flag engine
**Labels:** `multi-day-feature`, `backend`, `frontend`, `travel`, `phase-3`

**Why manual:** the whole Visa Sure sub-brand. Routes for `VisaApplication` already exist (schema models shipped); needs the operator UI + risk-flag engine + rejection-recovery workflow. ~2 weeks.

**Acceptance criteria:**
- 3 pages: `/travel/visa/applications` (list), `/travel/visa/applications/:id` (detail), `/travel/visa/checklists` (admin)
- Risk-flag engine: scoring on applicant profile + document completeness + destination/visa-type combo
- Rejection-recovery: when an application is marked rejected, surface "what to fix" suggestions + retry workflow
- Document upload flow (Aadhaar / passport / photo / supporting docs)
- Status timeline view (initiated → docs-collected → submitted → approved/rejected)

---

### B4. Chrome flight-quote plugin (browser extension)
**Labels:** `multi-day-feature`, `chrome-extension`, `separate-repo`

**Why manual:** Manifest V3 browser extension. Lives in a SEPARATE repo (not `globussoft-crm`). Per-airline DOM adapters for IndiGo / Air India / Vistara / SpiceJet / etc. ~10-15 engineer-days.

**Acceptance criteria:**
- Manifest V3 + content scripts per airline domain
- Scrapes fare quote from airline search results
- POSTs back to CRM `/api/travel/flight-quotes` endpoint
- Auth via per-user API key
- Sidebar UI to mark "include in current itinerary"

**Decision needed first:** which 3 airlines to support in MVP?

---

### B5. Airline web check-in automation (#P1B)
**Labels:** `multi-day-feature`, `automation`, `travel`, `paired-with-B4`

**Why manual:** browser automation per airline (Playwright in production?). High maintenance burden — airlines change DOM weekly. ~5-7 days for MVP + ongoing maintenance.

**Acceptance criteria:**
- For each `WebCheckin` row in status `auto-attempt`, headless browser:
  1. Loads airline check-in URL with PNR + last name
  2. Selects seat (use saved preference or auto-pick aisle/window)
  3. Generates boarding pass
  4. Uploads to `/api/travel/webcheckins/:id/upload-boarding-pass`
  5. Marks `WebCheckin.status = "done"`
- Failure handling: 3 retries → `status = "fallback-agent"` + notify ops
- Per-airline adapter pattern (mirror Chrome plugin's adapter shape)

---

### B6. Booking.com / Expedia direct API integration
**Labels:** `multi-day-feature`, `backend`, `cred-dependent`, `phase-2`

**Why manual:** OAuth flow + inventory sync + booking lifecycle + cancellation/refund handling. ~7-10 days per provider. Cred-blocked too (need Booking.com partner account + Expedia EAN credentials).

---

### B7. Birthday / anniversary marketing greetings
**Labels:** `multi-day-feature`, `backend`, `wellness-pattern`

**Why manual:** the wellness vertical has `contactGreetingsEngine.js` — travel needs similar logic with travel-specific copy + WhatsApp dispatch. ~2-3 days.

**Acceptance criteria:**
- Daily cron runs at 09:00 local per tenant
- For each Contact with `dateOfBirth` or `anniversaryDate` matching today, queue greeting
- Sub-brand-aware copy (TMC = "Happy Birthday to your child!", Travel Stall = "Have an unforgettable year!", etc.)
- WhatsApp dispatch via subBrandConfig helper (already shipped) — STUB until Q9

---

## C. CRED-DEPENDENT INTEGRATION WORK (engineering work AFTER creds arrive)

These items are stub-mode-complete today. When the cred drops, an engineer needs to do the swap + real-world integration testing. NOT just env-var flips.

### C1. Q9 Wati BSP — real-mode swap across 10 consumers
**Labels:** `cred-dependent`, `Q9`, `backend`, `integration`

**Why manual:** ~30-min swap per consumer × 10 consumers + real WABA testing + rate-limit tuning + delivery webhook handling + per-tenant `WhatsAppMessage` row persistence. ~1-2 days total post-cred-drop.

**Pre-work shipped:** subBrandConfig helper (`621aab7`) pre-routes per-sub-brand WABA — the swap is `if (apiKey) wati.send(...)` per send-site.

**Acceptance criteria post-cred:**
- All 7 crons + 3 endpoints send real WhatsApp messages
- `prisma.whatsAppMessage.create` row written per send
- Delivery webhook handler updates `WhatsAppMessage.deliveredAt`
- Per-tenant rate limits respected
- Failed sends logged + retry queue

**Cred chase doc:** `docs/WHATSAPP_INTEGRATION_PRD.md`

---

### C2. Q11 LLM API keys — real-mode swap + cost guards
**Labels:** `cred-dependent`, `Q11`, `backend`

**Why manual:** real-mode swap in `lib/llmRouter.js` is the easy part; needs cost-tracking + per-tenant budget caps + abuse guards (don't blow $1000 on a runaway loop). ~1 day.

**Acceptance criteria post-cred:**
- Per-provider `if (apiKey) realProviderCall(...)` branches
- `LlmCallLog.costEstimate` populated with real per-token pricing
- Per-tenant monthly budget cap (configurable; default $100/mo)
- Abuse guard: refuse >50 calls/min per tenant
- Cost alert: notify ADMIN at 80% of monthly cap

---

### C3. Q3 DigiLocker — real Aadhaar swap + compliance check
**Labels:** `cred-dependent`, `Q3`, `backend`, `compliance`

**Why manual:** swap stub for real DigiLocker OAuth + Aadhaar XML pull + UIDAI compliance retention check. ~1 day post-cred.

**Acceptance criteria post-cred:**
- Real OAuth → `DIGILOCKER_CLIENT_ID` + `DIGILOCKER_CLIENT_SECRET` redirect flow
- Real Aadhaar XML pull from DigiLocker
- Retention: `DigilockerSession` rows purged after N days per UIDAI guidelines (verify N with counsel)
- Last-4 storage encrypted at rest (field-level encryption via `fieldEncryption.js`)

**Cred chase docs:** `docs/DIGILOCKER_INTEGRATION_SPEC.md`, `docs/DIGILOCKER_USE_CASE.md`

---

### C4. Q19 RateHawk — write client from scratch + RFU integration
**Labels:** `cred-dependent`, `Q19`, `backend`, `multi-day-feature`

**Why manual:** **NO stub exists today** (unlike Q9/Q11/Q3). Need to write `backend/services/ratehawkClient.js` from scratch + wire into RFU unified-search lowest-rate auto-pick. ~3-5 days.

**Acceptance criteria post-cred:**
- New `services/ratehawkClient.js` with search + book + cancel endpoints
- Per-tenant API ID lookup (similar to subBrandConfig pattern)
- RFU unified-search calls RateHawk for hotel inventory
- Lowest-rate auto-pick logic + manual override
- Booking confirmation → `Itinerary` item

---

### C5. Q8 Excel Software for Travel — write accounting bridge
**Labels:** `cred-dependent`, `Q8`, `backend`, `multi-day-feature`

**Why manual:** **NO docs yet** (chase Yasin for the API spec first). Once we have the REST docs, write `backend/services/excelSoftwareClient.js` + sync invoice/payment from CRM → Excel Software for reconciliation. ~3-5 days post-docs.

**Acceptance criteria post-docs:**
- `services/excelSoftwareClient.js` per their REST API spec
- Sync trigger: on `Invoice` create / `Payment` create, POST to Excel Software
- Failure handling: queue retries + ADMIN notification on repeated fail
- Reconciliation report: nightly diff of CRM vs Excel Software invoices

---

### C6. Q1 Callified.ai — AI calling + form-vs-call live mode
**Labels:** `cred-dependent`, `Q1`, `backend`, `integration`

**Why manual:** waiting on Yasin's Callified.ai handover (creds + API docs). Once received, ~2-3 days to wire into the form-vs-call compute endpoint with real call recording.

**Acceptance criteria post-handover:**
- Real Callified API client (`services/callifiedClient.js` — partially exists at `external.js` /calls/POST/PATCH endpoints)
- Form-vs-call compute reads real call transcripts (not just hand-typed `callTranscript` body field)
- Per-tenant call-recording retention policy

---

### C7. Q1 AdsGPT — marketing reports integration
**Labels:** `cred-dependent`, `Q1`, `backend`, `integration`

**Why manual:** waiting on AdsGPT handover. Once received, ~2-3 days to add `services/adsGptClient.js` + attribution wiring + marketing-report endpoints.

---

## D. WELLNESS-VERTICAL SESSION WORK (single engineer day of focused wellness)

Don't mix into a travel sprint — wellness fixes shipped mid-travel-cycle tend to miss regressions. **Dedicate a focused wellness day to work down this list.**

### D1. Wellness POS sale tabs (#771)
**Labels:** `wellness-session`, `frontend`, `pos`

**Why manual:** the POS view at `/wellness/pos` ships the register shell but the sale-flow tabs (Products / Services / Packages / Memberships) are empty. ~½ day to build out + wire to existing `Sale` model.

---

### D2. Wellness invoice schema (#788)
**Labels:** `wellness-session`, `backend`, `schema`

**Why manual:** wellness needs a separate `WellnessInvoice` model (HSN codes + GST + IGST split + per-state tax rules). Currently using generic `Invoice` which doesn't have HSN. Schema migration needed (additive, no bless marker). ~1 day.

---

### D3. Wellness Wallet + Cashback + Coupons + Gift Cards (#775)
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`

**Why manual:** Wave 11 Agent FF shipped the 4 admin pages but the engines (cashback rules firing on Sale create, coupon redemption flow, gift card balance tracking) need work. ~2-3 days.

---

### D4. Wellness CSV I/O (#816)
**Labels:** `wellness-session`, `backend`

**Why manual:** wellness needs CSV import/export for Patient / Visit / Prescription. Travel ships `csv_io.js`; wellness needs the parallel + field-mapping UI. ~1 day.

---

### D5. Wellness inventory engines (#834, #835)
**Labels:** `wellness-session`, `backend`

**Why manual:** the `InventoryReceipt` + `InventoryAdjustment` models ship but the auto-decrement-on-prescription-fire logic + low-stock alert escalation needs work. ~1 day.

---

### D6. Memberships engine
**Labels:** `wellness-session`, `backend`

**Why manual:** `Membership` model + admin UI ship; the per-visit auto-discount-on-active-membership logic + expiry reminders + auto-renewal flow needs work. ~1-2 days.

---

### D7. 15 wellness QA bugs (#820-#843)
**Labels:** `wellness-session`, `bug`

**Why manual:** concrete bug surfaces (prescriptions / patient PDF / inventory filters / POS 404 / Owner Dashboard copy). Each is small (~30 min) but they need wellness context-switching. ~1 day to clear all 15.

**Open in batch:**
```bash
gh issue list --label "wellness" --state open --limit 20
```

---

## E. PRODUCT-CALL DEPENDENT (decision-first, then implementation)

These don't need an engineer — they need a stakeholder decision. Once the decision arrives, the implementation is small.

### E1. Q2 — Aadhaar consent legal copy
**Labels:** `product-call`, `Q2`, `legal`

**Owner:** Yasin's counsel.

**Decision needed:** exact wording shown to TMC parents when asked to consent to Aadhaar-via-DigiLocker pull.

**Status:** GS draft shipped at `7d162cd` — counsel needs to review + approve + replace placeholder.

**Post-decision implementation:** 15 minutes — replace the placeholder string in `routes/travel_diagnostics.js`.

---

### E2. Q13 — TMC curriculum mapping table
**Labels:** `product-call`, `Q13`, `academic`

**Owner:** TMC senior academic coordinator.

**Decision needed:** which school-trip destinations / activities map to which CBSE / ICSE / state-board learning outcomes?

**Status:** the diagnostic engine has a hook for "recommend trip based on curriculum alignment" but the mapping table is empty.

**Post-decision implementation:** ~½ day — admin UI to upload the mapping CSV + diagnostic engine reads it.

---

## F. CROSS-REPO INTEGRATION — Voyagr (OJR) CMS → CRM lead capture

**Repo:** [Globussoft-Technologies/voyagr](https://github.com/Globussoft-Technologies/voyagr) (Next.js 14 + Prisma multi-tenant CMS, locally at `c:/Users/Admin/gbs-projects/voyagr/`).

**Context:** voyagr powers the 4 travel sub-brand websites (TMC / RFU / Travel Stall / Visa Sure). Lead capturing + the full top-of-funnel happen on the websites; the CRM is the system of record for captured leads. Implementation spans TWO repos with coordinated CORS / auth / schema work.

### F1. CRM-side public lead-capture endpoint
**Labels:** `multi-day-feature`, `backend`, `voyagr-integration`, `gbs-crm-repo`
**Design decision LOCKED 2026-05-23:** API-key auth (Option 1) — mirror `/api/v1/external` partner-API pattern at `backend/routes/external.js` + `backend/middleware/externalAuth.js`. Per-site API key issued via CRM admin UI; voyagr stores in env vars; sent as `X-API-Key` header from a tiny Next.js API route so the key never reaches the browser.

**Why manual:** new public endpoint with API-key auth + CORS allowlist update for voyagr site domains + spam guards + source attribution (sub-brand + UTM + page URL) + dedup against existing Contacts. ~2-3 days.

**Acceptance criteria:**
- New `POST /api/v1/voyagr/leads` endpoint (NOT `/api/public/...` — auth-required path stays under `/api/v1/`)
- `X-API-Key` header validated via `backend/middleware/externalAuth.js` (extend existing middleware OR clone the pattern into a `voyagrAuth.js` if scope differs)
- API key issuance UI: new `frontend/src/pages/admin/VoyagrApiKeys.jsx` (mirror `backend/routes/external.js`'s admin-issued key pattern; per-site keys with rotation + revocation)
- Body shape: `{ subBrand, name, email, phone, source: { siteSlug, pageUrl, utm? }, payload: <form-specific fields> }`
- Creates Contact (with dedup against `[email, tenantId]` unique) + Deal in the correct sub-brand's pipeline with stage `lead`
- CORS allowlist extension: each voyagr site's domain added to `corsAllowlist` in `backend/server.js` (still needed for browser → voyagr-Next.js-API-route preflight; CRM endpoint itself doesn't need it since voyagr's server-to-server call has no Origin header)
- Rate limit: 60 req/min per IP + 1000 req/hr per API key (mirror marketplace-leads webhook pattern + add the per-key budget)
- Spam guards: honeypot field + optional hCaptcha integration (config-driven; defense-in-depth on top of the API key)
- Audit log row per capture (`writeAudit("voyagr.lead.captured", {...})`) including the API key's `name` for forensic attribution
- E2E spec: `e2e/tests/voyagr-lead-capture-api.spec.js` covering happy path + dedup + spam guard + missing/wrong API key (401) + per-sub-brand routing

---

### F2. Voyagr-side: lead-capture form components (× 4 form types)
**Labels:** `multi-day-feature`, `frontend`, `voyagr-integration`, `voyagr-repo`

**Why manual:** lives in the **voyagr repo**, not gbs-crm. Next.js components + a thin CRM client SDK + form validation + per-sub-brand styling. ~5-7 days for all 4 form types.

**Acceptance criteria** (one per form type, ship as separate commits in voyagr repo):
1. **Basic lead-capture form** — name + email + phone + interest area + free-text message. Lives on Contact page + footer of every page.
2. **TMC school-trip enquiry** — school name + class + student count + preferred dates + destination interest. Lives on TMC sub-brand site.
3. **RFU Umrah enquiry** — pilgrim count + preferred Hajj/Umrah season + budget range + visa status. Lives on RFU sub-brand site.
4. **Travel Stall family-holiday quiz** — 5-7 question diagnostic-style form (matches the existing `frontend/src/pages/public/TravelStallQuiz.jsx` quiz in the CRM repo). Lives on Travel Stall sub-brand site.

**Shared infrastructure:**
- New `voyagr/src/lib/crmClient.ts` — typed POST helper that hits `/api/v1/voyagr/leads`
- New `voyagr/src/components/forms/LeadCaptureForm.tsx` — shared form shell (name/email/phone + sub-brand selector + form-specific payload slot)
- Per-form components extending the shell
- Form validation via zod or similar
- Submit success/error UI per voyagr's theme system

---

### F3. Cross-system attribution + UTM tracking
**Labels:** `multi-day-feature`, `backend`, `voyagr-integration`, `analytics`

**Why manual:** captures need to flow through to the existing `Touchpoint` model (already exists at `backend/prisma/schema.prisma`) + tie into the marketing attribution reports. ~1-2 days.

**Acceptance criteria:**
- Lead-capture endpoint persists UTM params (utm_source / utm_medium / utm_campaign / utm_term / utm_content) on the Contact row + creates a Touchpoint
- Marketing report (`backend/routes/attribution.js` already exists) extended to filter by `voyagr` source
- Admin UI surface in `frontend/src/pages/MarketingDashboard.jsx` (or similar) showing voyagr-sourced leads per sub-brand × campaign

---

### F4. Diagnostic-quiz parity (Travel Stall) between voyagr and CRM
**Labels:** `multi-day-feature`, `frontend`, `voyagr-integration`, `coordinated-deploy`

**Why manual:** the CRM already ships `frontend/src/pages/public/TravelStallQuiz.jsx` (mounted publicly, no auth). Voyagr's quiz needs to be the same shape so a lead captured on voyagr → enters the same `TravelDiagnostic` pipeline → diagnostic score → tier recommendation → auto-itinerary draft. ~2-3 days.

**Acceptance criteria:**
- Voyagr quiz component matches the question bank shape used by `backend/routes/travel_diagnostics.js` `/diagnostics/public/banks` + `/diagnostics/public/submit` endpoints
- Submission flows through the same public endpoint; same DiagnosticBank rows serve both surfaces
- Result page (or post-submit redirect) shows the same classification label + recommended tier
- Decision: should voyagr quiz redirect to CRM's public itinerary preview URL, or render its own result page? (cleaner deploy if voyagr renders inline)

---

### F5. Webhook outbound — CRM → voyagr on Contact status change (optional, Phase 2)
**Labels:** `multi-day-feature`, `backend`, `voyagr-integration`, `optional`

**Why manual:** when a Contact moves through pipeline stages, voyagr's CMS can surface tailored content per stage (e.g. "thank you for booking" hero swap for "won" leads). Webhook out from CRM → voyagr signs requests with HMAC. ~1-2 days. **Optional** — only build if voyagr-side content personalization is on the roadmap.

---

### F6. Joint deployment + smoke test infrastructure
**Labels:** `devops`, `voyagr-integration`, `cross-repo`

**Why manual:** changes that span both repos (e.g. F1 endpoint shape change → F2 client SDK update) need coordinated deploy ordering: CRM ships endpoint first, voyagr ships client second. ~1 day for runbook + smoke tests.

**Acceptance criteria:**
- Runbook in `docs/VOYAGR_DEPLOY_RUNBOOK.md` covering deploy order + rollback for cross-repo changes
- Joint E2E smoke test (post-deploy): a script that hits voyagr's quiz form + verifies Contact + Deal appear in CRM
- Per-environment domain mapping table (dev / staging / prod) so CORS allowlist + API key bindings are unambiguous

---

## G. RFU-SPECIFIC INTEGRATIONS (newly-surfaced 2026-05-23)

These are RFU sub-brand-specific vendor integrations surfaced by the 2026-05-23 portal feature matrix audit (commit `08bc240`, see [docs/TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md) Open Questions section). All three are cred-dependent on Yasin onboarding the respective vendor — they are sister items to cluster C, but kept distinct because they were not in the initial PRD set and each maps to a single RFU operator workflow rather than a cross-vertical capability. Yasin's cred chase list grows to 10 items.

### G1. Zikr Cabs ground-transfer API (#926)
**Labels:** `enhancement`, `travel-crm`, `rfu`, `cred-dependent`

**Why manual:** RFU's "Correctness Assured Umrah Program" includes ground transfers — Jeddah → Makkah (~80km), Madinah → Jeddah airport (~440km). Today operators manually quote from Zikr Cabs (Saudi-side ground-transfer vendor). Needs a fresh `services/zikrCabsClient.js` mirroring the RateHawk pattern + wire into the unified quote flow so the ground-transfer leg appears alongside hotel + flight. ~3-5 days post-cred.

**Decisions needed (Yasin):**
- Vendor onboarding: does Yasin have a Zikr Cabs partner account, or do we procure?
- API model: REST OAuth vs CSV import vs web-scraping?
- Markup engine integration: same shape as RateHawk
- Cancellation policy mapping

**Cross-reference:** cluster C (cred-dependent integration work) — once Yasin lands the creds, this becomes a C-style swap.

---

### G2. 5-portal Saudi hotel-scraper orchestrator (#927)
**Labels:** `enhancement`, `travel-crm`, `rfu`, `cred-dependent`

**Why manual:** Makkah/Madinah hotels list across multiple Saudi-side B2C portals (Almosafer, Tajawal, MyHoliday2, Pilgrims Choice, Reservation House) with varying rates. RateHawk's coverage is thin for Saudi inventory; operator manually scrapes for lowest rate today. Needs an orchestrator that hits N portals in parallel (per-portal scraper adapters), normalizes rates, dedups by property + city, presents lowest-rate-by-property to operator. ~10-15 days (sister pattern to cluster B4 Chrome plugin's per-airline adapter shape).

**Decisions needed:**
- 5 portals' ToS — scraping vs partner-API path per portal
- Per-portal adapter maintenance (DOM changes; similar to Chrome flight plugin per-airline pattern)
- Caching strategy (Saudi rates spike during Hajj/Ramadan — aggressive caching is risky)
- Per-portal failure handling

**Cross-reference:** cluster B4 (Chrome flight-quote plugin) is the closest pattern match for per-adapter maintenance + sibling-of-cluster-B style multi-day feature build.

---

### G3. Haramain High-Speed Rail pricing API (#928)
**Labels:** `enhancement`, `travel-crm`, `rfu`, `cred-dependent`

**Why manual:** Saudi Arabia's Haramain High-Speed Rail (HHR) connects Makkah ↔ Madinah (~450km in 2.5h). Common alternative to the Madinah → Jeddah road transfer for RFU pilgrim groups. Pricing varies by class (economy/business) + group size + advance-booking window. Today's flow is manual lookup on HHR's public website. ~3-5 days post-cred (mirror RateHawk client pattern).

**Decisions needed (Yasin):**
- HHR's API access — public B2C only, or B2B partner program?
- Group-booking discount tiers
- Cancellation handling (HHR's policy)
- Per-class pricing structure (economy vs business)

**Cross-reference:** cluster C (cred-dependent integration work) — same client-write-from-scratch shape as C4 (RateHawk).

---

## Summary table

| Cluster | Items | Engineer-days | Blocking |
|---|---|---|---|
| A. Design-call-first | 4 | ~5 days post-call | Schedule the calls |
| B. Multi-day features | 7 | ~50 days | Engineer time |
| C. Cred-dependent integration | 7 | ~12 days post-cred | Yasin's cred chase |
| D. Wellness session | 7 | ~6 days | Pick a wellness day |
| E. Product-call | 2 | ~½ day post-call | Stakeholder decisions |
| **F. Voyagr (OJR) integration** | **6** | **~15 days** | **Design call on auth model + form-type prioritisation** |
| **G. RFU-specific integrations (newly-surfaced)** | **3** | **~16-25 days post-cred** | **Yasin's cred chase (×3 new vendors)** |

**Total engineer time to clear:** ~105-115 days across all clusters. **Total cred-/product-call asks:** 12 (Yasin owns 10, counsel owns 1, TMC owns 1). **Cross-repo coordination:** voyagr (OJR) work spans 2 repos and needs a deploy-order runbook.

---

## How to bulk-create issues from this doc

```bash
# One at a time (recommended — lets you tweak per-issue body):
gh issue create --title "A1. Move JWT from localStorage to HttpOnly cookies" \
  --label "needs-design-call,security,cross-cutting" \
  --body-file /tmp/A1.md

# Or paste each block into the GitHub web UI's "New issue" form.
```

A `gh issue create` per item gives you a stable issue number for tracking; copying into the web UI gives you the rich-text editor for follow-on discussion.
