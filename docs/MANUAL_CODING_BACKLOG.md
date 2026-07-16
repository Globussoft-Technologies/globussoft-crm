# Manual Coding Backlog — for engineer assignment

**Generated:** 2026-05-23 from the post-PRD-drive audit state. Each item below is **NOT autonomous-doable** by the cron — it needs a human engineer with judgment, multi-day attention, design alignment, or post-cred-drop integration work. Filed as ready-to-bulk-create GitHub issues; copy any block into `gh issue create --title "..." --body "..."` or paste into the web UI.

**Category labels suggested:** `needs-design-call`, `multi-day-feature`, `cred-dependent`, `wellness-session`, `product-call`.

---

## A. NEEDS DESIGN CALL FIRST (single engineer can't decide alone)

These are architecture changes whose **first hour is a meeting, not a commit**. Don't assign to an engineer cold — schedule the call first, then assign the implementation.

### A1. Move JWT from localStorage to HttpOnly cookies
**Labels:** `needs-design-call`, `security`, `cross-cutting`

**PRD:** [PRD_TRAVEL_SECURITY_ARCHITECTURE.md](PRD_TRAVEL_SECURITY_ARCHITECTURE.md) §3.1 FR-3.1 (auth model migration — closes #914 #915 #924) + §5 design decisions + §9 OQ-9.4 (OAuth callback SameSite collision).

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

**PRD:** [PRD_TRAVEL_SECURITY_ARCHITECTURE.md](PRD_TRAVEL_SECURITY_ARCHITECTURE.md) §3.2 FR-3.2 (CSP hardening — closes #917 #923).

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

**PRD:** [PRD_TRAVEL_SECURITY_ARCHITECTURE.md](PRD_TRAVEL_SECURITY_ARCHITECTURE.md) §3.3 FR-3.3 (IDOR mitigation — closes #918).

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

**PRD:** [PRD_TRAVEL_SECURITY_ARCHITECTURE.md](PRD_TRAVEL_SECURITY_ARCHITECTURE.md) §3.4 FR-3.4 (tenant scoping completeness audit — closes #919) + §3.5 FR-3.5 (PII payload reduction — closes #920).

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

### B1. Pipeline Kanban view (#897) — mostly SHIPPED, residual is sub-brand filter + hardening
**Labels:** `multi-day-feature`, `frontend`, `travel`

**PRD:** [PRD_TRAVEL_PIPELINE_KANBAN.md](PRD_TRAVEL_PIPELINE_KANBAN.md) (10 sections, 8 design decisions, 8 open questions; written 2026-05-23 cron tick #18).

**Status update 2026-05-23:** The "/pipeline redirects to dashboard" framing in #897 is **phantom** — `frontend/src/pages/Pipeline.jsx` is a fully built Kanban (~386 lines, shipped `d1a30c7` April 2026, hardened across 8 follow-up commits). Drag-drop + custom stages + optimistic update + rollback + socket.io live sync are all in place. The PRD reframes the residual work to ~3-5 engineering days (vs the original ~5 days from-scratch estimate):

**Real residual work:**
- Sub-brand filter chip-row (FR-3.11 to 3.15) — ~150 LOC frontend + 30 LOC backend `?subBrand=` query param
- Mobile touch drag-drop (FR-3.16) — `@dnd-kit/core` swap-in for HTML5 native; 1 day
- Keyboard a11y for drag-drop (FR-3.17) — 1 day
- Virtualization for crowded columns (FR-3.18) — 1 day, only matters at ≥100 deals/column

**Cross-cutting:** issue #887 ("/pipeline → dashboard redirect") likely shares root cause with #897 — verify before closing; both should close together.

---

### B2. Quote Builder (#900)
**Labels:** `multi-day-feature`, `frontend`, `backend`, `travel`

**PRD:** [PRD_TRAVEL_QUOTE_BUILDER.md](PRD_TRAVEL_QUOTE_BUILDER.md) — 6 design decisions (fork vs extend Quote/Estimate is DD-5.1, cross-ref Billing DD-5.1 + Supplier DD-5.1 — settle in single call).

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

**PRD:** [PRD_VISA_SURE_PHASE_3.md](PRD_VISA_SURE_PHASE_3.md) — V1-V19 spec. SHELL pages (Dashboard / Applications / Checklists / AdvisorDashboard / Reports) shipped across this session's earlier ticks; risk-flag engine SHELL at `9e8c28f`; real implementation pending PC-8 + cred-chase for AI assessment.

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

**PRD:** [PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md](PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md) — 6 design decisions including DC-1 (repo location — blocks scaffolding).

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

**PRD:** [PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md](PRD_AIRLINE_WEBCHECKIN_AUTOMATION.md) — 6 design decisions including DC-1 (Playwright vs MCP — gates engineering scope) + DC-5 (per-airline ToS counsel review).

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

**PRD:** [PRD_BOOKING_EXPEDIA_DIRECT.md](PRD_BOOKING_EXPEDIA_DIRECT.md) — 7 design decisions including DC-1 (vendor priority — gates 2-4 week onboarding clock) + DC-4 (direct-book Phase 2 timing — demand-driven).

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

**PRD:** [PRD_RATEHAWK_INTEGRATION.md](PRD_RATEHAWK_INTEGRATION.md) — 6 design decisions including DC-1 (pricing model — gates FR-10 cap design) + DC-4 (lowest-rate auto-pick tiebreaker).

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

**PRD:** [PRD_EXCEL_SOFTWARE_ACCOUNTING.md](PRD_EXCEL_SOFTWARE_ACCOUNTING.md) — 6 design decisions including DC-1 (API path vs CSV path — gates transport-layer code). Doc-blocked (Yasin owes vendor REST spec before §3 can be specified concretely).

**Why manual:** **NO docs yet** (chase Yasin for the API spec first). Once we have the REST docs, write `backend/services/excelSoftwareClient.js` + sync invoice/payment from CRM → Excel Software for reconciliation. ~3-5 days post-docs.

**Acceptance criteria post-docs:**
- `services/excelSoftwareClient.js` per their REST API spec
- Sync trigger: on `Invoice` create / `Payment` create, POST to Excel Software
- Failure handling: queue retries + ADMIN notification on repeated fail
- Reconciliation report: nightly diff of CRM vs Excel Software invoices

---

### C6. Q1 Callified.ai — AI calling + form-vs-call live mode
**Labels:** `cred-dependent`, `Q1`, `backend`, `integration`

**PRD:** [PRD_AI_CALLING_CALLIFIED.md](PRD_AI_CALLING_CALLIFIED.md) — 7 design decisions including DC-1 ($100/mo cap + 90s per-call ceiling), DC-3 (persona/script per sub-brand), DC-5 (TRAI disclosure — counsel-owned), DC-7 (per-tenant disable toggle).

**Why manual:** waiting on Yasin's Callified.ai handover (creds + API docs). Once received, ~2-3 days to wire into the form-vs-call compute endpoint with real call recording.

**Acceptance criteria post-handover:**
- Real Callified API client (`services/callifiedClient.js` — partially exists at `external.js` /calls/POST/PATCH endpoints)
- Form-vs-call compute reads real call transcripts (not just hand-typed `callTranscript` body field)
- Per-tenant call-recording retention policy

---

### C7. Q1 AdsGPT — marketing reports integration
**Labels:** `cred-dependent`, `Q1`, `backend`, `integration`

**PRD:** [PRD_ADSGPT_MARKETING_REPORTS.md](PRD_ADSGPT_MARKETING_REPORTS.md) — 6 design decisions including DC-2 ($50/mo cap, hard stop) + DC-4 (per-sub-brand budget tracking).

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

### D8. Purchase Orders module (#847) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `procurement`

**Why manual:** entire procurement workflow missing — no PO model, no approval flow, no PO→Receipt linkage, no PO PDF/email dispatch. PRD drafted at `docs/PRD_PURCHASE_ORDERS.md` (tick #187, 2026-05-25 / Agent B). 8 design decisions + 10 open questions need product-call sign-off before implementation can start. Recommended first slice ships INVENTORY purpose only (wellness vendor POs with approval + receipt auto-link); slice 2 extends to TRAVEL purpose (per-Trip POs to TravelSupplier). Cross-references `PRD_TRAVEL_SUPPLIER_MASTER.md` (deferred PO workflow lands here) + `PRD_TRAVEL_BILLING.md` + `PRD_TRAVEL_GST_COMPLIANCE.md`. **Total estimated effort post-design: 5-8 engineering days** (slice 1 = 3-4d INVENTORY; slice 2 = 2-3d TRAVEL extension).

**Blocks before backend impl can start:** DD-5.1 (single model vs fork) + DD-5.2 (multi-approver scope) + DD-5.6 (Tenant.poApprovalConfigJson placement) + OQ-9.1 (default threshold ladder per vertical) + OQ-9.10 (receipts auto-link in v1).

---

### D9. Payment Gateway Configuration UI (#848) — PRD drafted, design call pending
**Labels:** `wellness-session`, `travel-session`, `backend`, `frontend`, `multi-day-feature`, `payments`, `security`

**Why manual:** Stripe/Razorpay keys live only in env vars today — every new tenant requires a backend restart + devops ticket. Multi-tenant isolation breaks at the gateway boundary (all tenants share one Stripe + one Razorpay account). PRD drafted at `docs/PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188, 2026-05-25 / Agent B). 8 design decisions + 10 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~2d) = schema + routes + Stripe adapter + Stripe-only admin UI against the sandbox; slice 2 (~1.5d) = Razorpay adapter + Razorpay admin UI; slice 3 (~1.5d) = routing-rules table + per-currency resolution + per-tenant webhook lookup refactor; slice 4 (~1d) = grace-window logic + cleanup cron + operator docs. Reuses existing `lib/credentialMasking.js` + `lib/fieldEncryption.js` verbatim. Cross-references `PRD_PLANS_BILLING_SELF_SERVE.md` (DD-5.3 there delegates gateway-config scope here) + `PRD_TRAVEL_BILLING.md` (per-invoice Pay Now consumes the new resolver) + `PRD_PURCHASE_ORDERS.md` (Phase 2 supplier payouts). **Total estimated effort post-design: 4-6 engineering days** across backend + frontend.

**Cred dependency:** GH #896 (P0 Activate Stripe + Razorpay — real keys onboarded for at least 1 tenant before "Done" can be declared). UI can ship in advance with empty-config state.

**Blocks before backend impl can start:** DD-5.1 (BYOK vs Stripe Connect) + DD-5.2 (BYOK vs Razorpay Route) + DD-5.4 (new PaymentGatewayConfig model vs extend Integration) + DD-5.6 (routing-rules table placement) + OQ-9.4 (auto-create routing rules on first save) + OQ-9.5 (block-save-until-test default).

---

### D10. Import/Export Job History (#850) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `data-ops`, `compliance`

**Why manual:** today's piecemeal CSV/XLSX endpoints (`/patients.csv`, `/patients.xlsx`, `/patients/import-template.csv` landed tick #189 + the generic `routes/csv_io.js` + `routes/travel_csv_io.js`) are stateless — request-in, work-happens, response-out, nothing persists. Breaks down at scale (50k-row exports hit HTTP timeout; 5k-row imports run silently for minutes with no row-level feedback; failed-row recovery requires bisect-by-hand; DSAR audit can't tell who exported what). PRD drafted at `docs/PRD_IMPORT_EXPORT_JOBS.md` (tick #189, 2026-05-25 / Agent B). 8 design decisions + 10 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~3d) = schema + cron engine + storage shim + PATIENT handler + 8 API routes + admin page; slice 2 (~2d) = remaining 7 resource-type handlers (CONTACT, LEAD, PRODUCT, SERVICE, VENDOR, DEAL-export, INVOICE-export); slice 3 (~1.5d) = threshold-based migration of existing CSV/XLSX endpoints + retry-failed-rows + re-run flows; slice 4 (~1d) = S3 storage adapter + cleanup cron + retention-extension UI. New `ImportExportJob` Prisma model with handler-registry extensibility + 2 new cron engines (`importExportEngine.js` polling + `jobArtifactCleanupEngine.js` daily sweep) + per-row error report CSV with stable error codes. Cross-references `PRD_PURCHASE_ORDERS.md` §7 (Phase 2 PO-bulk-create consumer) + `PRD_TRAVEL_SUPPLIER_MASTER.md` (existing `travel_csv_io.js` migrates into the job system in slice 2) + `PRD_TRAVEL_BILLING.md` (bulk-invoice export consumer). **Total estimated effort post-design: 6-9 engineering days** across backend + frontend.

**Blocks before backend impl can start:** DD-5.1 (single ImportExportJob table vs fork to ImportJob/ExportJob) + DD-5.2 (queue-and-notify vs SSE-progress) + DD-5.3 (migration strategy for existing CSV endpoints — threshold-based vs migrate-all vs migrate-none) + DD-5.5 (PHI gate semantics for patient exports — role-gate + operator-attest layering) + DD-5.6 (metadata-indefinite + files-finite retention split) + OQ-9.1 (S3 vs local-disk for v1) + OQ-9.2 (retention defaults) + OQ-9.3 (cancel-latency UX).

---

### D11. Unified Integrations Hub (#858) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `governance`

**Why manual:** today's integration footprint is functional but scattered — channel-specific config lives on each module page (`Channels.jsx`, `WhatsAppConfig`, `SmsConfig`, `CalendarSync.jsx`, payment gateway page per `PRD_PAYMENT_GATEWAY_CONFIG.md`, marketplace-leads page, SSO/SCIM pages, Zapier page, sister-product API key surface on `Developer.jsx`, etc.). No single page where an Admin can see "what integrations are configured for this tenant right now?". New-tenant onboarding pays a 30-60 minute discovery tax navigating 8+ different pages; compliance audits can't get a one-shot snapshot; operators don't discover integrations they don't already know about. PRD drafted at `docs/PRD_INTEGRATIONS_HUB.md` (tick #190, 2026-05-25 / Agent B). 7 design decisions + 9 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~2d) = static registry (25 entries) + 5 core status providers + 3 API endpoints + admin page with catalog + status badges + filters; slice 2 (~1.5d) = remaining 5+ status providers + Sister Products section with API key management + audit log integration + RBAC enforcement; slice 3 (~1d) = export/import config flow + provider logos + caching layer + URL-state for filters; slice 4 (~0.5-1d) = tests + CI gate-spec wiring + `docs/integration-registry-guide.md`. NO schema migration (pure aggregation over existing `Integration`/`ApiKey`/`Webhook`/`SmsConfig`/`WhatsAppConfig`/`TelephonyConfig`/`Chatbot`/`SsoConfig`/`ScimToken`/`MarketplaceConfig`/`CalendarIntegration` models). NO new cron engine. Pure backend aggregation + new frontend page. Cross-references `PRD_PAYMENT_GATEWAY_CONFIG.md` (deep-link target for payment cards) + `PRD_IMPORT_EXPORT_JOBS.md` (consumes integration credentials for email-on-completion notifications) + closes #651 credential-masking contract on every credential surface. **Total estimated effort post-design: 4-6 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** DD-5.1 (static curated registry vs auto-derived from models) + DD-5.2 (deep-link to existing config pages vs centralize all in hub) + DD-5.3 (live-polled vs cached status with manual refresh) + DD-5.4 (sister-product key management in same hub vs separate Developer surface) + DD-5.6 (synchronous Test button vs async with notify-on-completion) + Q1 (categorize by FUNCTION vs by VENDOR) + Q4 (Test button latency UX — 5s sync timeout acceptable?).

---

### D12. Tags Master List / CRUD (#857) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `data-quality`, `governance`

**Why manual:** today's tag storage is denormalized free-text JSON-string columns per entity (`Patient.tags String? @db.Text` at [backend/prisma/schema.prisma:2612-2622](../backend/prisma/schema.prisma#L2612-L2622), shipped tick #180 `5841d736`; the schema comment establishes this as canonical for any future `Contact.tags` / `Lead.tags` / `Deal.tags`). NO master list, NO rename, NO merge, NO usage analytics, NO controlled vocabulary, NO audit trail. Every operator hour adds typo'd duplicates silently — 5 operators typing "VIP" / "vip " / "V.I.P." / "Vip" produce 4 distinct tags that should be 1. Every downstream filter / campaign / report built on tag = `vip` silently misses everyone tagged `VIP` / `Vip` / `v.i.p`. PRD drafted at `docs/PRD_TAG_MASTER.md` (tick #191, 2026-05-25 / Agent B). 7 design decisions + 8 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma `TagMaster` model + `Tenant.tagsControlled` flag + 5 CRUD endpoints + admin page table view + create/edit modals + RBAC + audit; slice 2 (~1d) = merge endpoint + consumer registry + Patient sweep + merge modal with preview confirmation; slice 3 (~1d) = cron usage-recalc engine + one-time backfill script + bulk-import CSV endpoint + bulk-import modal + recalculate-usage trigger; slice 4 (~0.5-1d) = controlled-vocab pre-check at [backend/routes/wellness.js:1318](../backend/routes/wellness.js#L1318) bulk-tags + fuzzy-match suggestions + tag autocomplete on Patient detail + tests + CI gate-spec wiring + `docs/tag-consumer-guide.md`. Schema adds NEW `TagMaster` model + 1 nullable `Tenant.tagsControlled Boolean @default(false)` field (additive — passes `migration_check` gate). Pattern: METADATA-only model (DD-5.1) — Patient.tags JSON-string stays source of truth + TagMaster is metadata layer with usage-count cache. NEW cron engine `tagUsageEngine.js` (daily 03:30 IST). One-time idempotent backfill script `backend/scripts/backfill-tag-master.js`. Cross-references `PRD_IMPORT_EXPORT_JOBS.md` (CSV imports flow through controlled-mode validation when `tagsControlled=true`) + `PRD_INTEGRATIONS_HUB.md` (tags master may surface as a "Data Quality" card in Phase 2) + Patient.tags schema-comment convention (the comment gets cross-referenced post-ship). **Total estimated effort post-design: 3-5 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** DD-5.1 (METADATA-only vs polymorphic EntityTag join table) + DD-5.3 (fixed 12-color palette vs hex picker — needs designer dependency) + DD-5.6 (auto-create-on-write vs reject-unknown by default in `tagsControlled=false` mode) + DD-5.7 (daily cron vs real-time on-write usage recalc) + Q1 (cross-vertical single master vs per-vertical lists) + Q2 (controlled-vocab default = opt-in vs opt-out) + Q4 (starter tag set pre-seeded on install vs empty master populated organically).

---

### D13. Unified In-App AI Chat History (#855) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `audit-trail`, `compliance`, `dsar`

**Why manual:** the CRM today has multiple in-app AI consumption surfaces (talking-points / form-vs-call / itinerary-draft / religious-guidance / personalised-destinations via `lib/llmRouter.js`; chatbot conversations via `ChatbotConversation.messages` LongText JSON; WhatsApp AI auto-replies via `WhatsAppMessage.body`) but ZERO unified human-facing history view. Critical finding: `LlmCallLog` at [backend/prisma/schema.prisma:1250-1277](../backend/prisma/schema.prisma#L1250-L1277) stores ONLY metadata (task / model / tokens / costEstimate / surface / userId / errorMessage) — **NOT prompt or response bodies**. 5 of the 7 in-app surfaces capture metadata but no actual content. Compliance auditors asking "what AI told the patient" for DSAR — cannot produce. Operator asking "what talking-point did AI give me Tuesday for lead X" — cannot recall. ADMIN spot-checking for hallucinations or PII leaks — no surface. Sister Globussoft products (AdsGPT for marketing AI, Callified for voice AI) own their own histories externally — those are OUT OF SCOPE; THIS work is in-app surfaces only. PRD drafted at `docs/PRD_AI_CHAT_HISTORY.md` (tick #192, 2026-05-25 / Agent B — Bonus PRD #6 on top of the official 10 P3 + 5 prior bonus). 7 design decisions + 9 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.25d) = Prisma schema extension (LlmCallLog body columns + entity attribution + WhatsAppMessage.aiCallLogId) + LLM-router field passthrough + 5 caller updates; slice 2 (~1.5d) = `backend/routes/ai_history.js` list + detail endpoints + RBAC + audit log + History tab on `frontend/src/pages/AiHistory.jsx`; slice 3 (~1d) = Cost Breakdown tab + Audit Log tab + search box + filter UI; slice 4 (~0.75d) = CSV export + DSAR bundle + PHI un-redact toggle + backfill script + tests + CI gate-spec wiring. Schema extension is purely additive nullable columns on existing models (`LlmCallLog.prompt String? @db.MediumText`, `LlmCallLog.response String? @db.MediumText`, `LlmCallLog.entityType String?`, `LlmCallLog.entityId Int?`, `WhatsAppMessage.aiCallLogId Int?`) — passes `migration_check` gate without bless markers. Pattern: RUNTIME UNION (DD-5.1) — no new materialised table; aggregates `LlmCallLog` + `ChatbotConversation` + AI-tagged `WhatsAppMessage` at read time. NO new cron engine. One-shot opportunistic backfill script `backend/scripts/backfill-llm-history-bodies.js` (realistic 30-50% body coverage on historic rows; forward-going coverage is 100%). Cross-references `PRD_INTEGRATIONS_HUB.md` (AI cost as hub-level card in Phase 2 deep-linking to Cost Breakdown tab) + `PRD_IMPORT_EXPORT_JOBS.md` (large exports flow through async job infra) + `routes/audit.js` `/verify` chain (DSAR bundle embeds receipt). **Total estimated effort post-design: 3-5 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** DD-5.1 (runtime UNION vs materialised AiHistoryEntry table) + **DD-5.2 (persist prompt + response bodies — YES / NO / opt-in per tenant) — HIGHEST LEVERAGE; determines whether 60-70% of use cases ship in v1** + DD-5.6 (plain-text storage vs AES-256-GCM via `lib/fieldEncryption.js`) + DD-5.7 (indefinite retention vs 1-year cap vs per-tenant configurable) + Q4 (PHI un-redact permission — ADMIN-only or also MANAGER) + Q7 (WhatsApp inbound scope — AI-triggered exchanges only or all inbound regardless).

---

### D14. Named Customer Segments (#856) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `marketing`, `audience-targeting`, `governance`

**Why manual:** the CRM today has URL-param filters on every major list page (Patients, Contacts, Leads, Deals, Invoices — Patient filters shipped tick #191 commit `e74efa9e`) but ZERO way to NAME and SAVE a filter set so an operator can reuse it, share it, or feed it into a downstream marketing flow. Today's pattern: operator builds a filter via URL params, bookmarks it (fragile + private + un-shareable), rebuilds it from scratch when they want to send an SMS blast to the same audience, rebuilds AGAIN when they want to drip-enroll the same audience, and has no way to share the audience definition with a teammate (who re-derives it with slight drift). Other CRMs solved this years ago under various names: HubSpot "Smart Lists", Salesforce "List Views", Zoho "Custom Views", Pipedrive "Filters", Mailchimp / Intercom "Segments / Audiences". THIS PRD adopts "Segment" terminology (matches #856 issue title + Mailchimp + Intercom; avoids HubSpot "list" overload with CRM contact-lists). PRD drafted at `docs/PRD_CUSTOMER_SEGMENTS.md` (tick #193, 2026-05-25 / Agent B — Bonus PRD #7 on top of the official 10 P3 + 6 prior bonus). 8 design decisions + 7 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma `CustomerSegment` model + `segmentPredicate.js` compile/evaluate + `segmentFields.js` allowlist + 5 of 9 endpoints + audit + RBAC; slice 2 (~1.5d) = `segmentEvaluationEngine.js` cron + admin trigger + POST /evaluate + POST /preview + 5-min read-cache; slice 3 (~2.5d) = `frontend/src/pages/Segments.jsx` + `SegmentBuilder.jsx` visual predicate builder + sidebar entry; slice 4 (~1d) = 5 list-page integrations (Patients/Contacts/Leads/Pipeline/Invoices) with "Save filter as Segment" affordance + `?segmentId=:id` URL-param handler + "Segment: <name>" pill on each page + 5 backend list routes accept `?segmentId=`; slice 5 (~0.75d) = Campaign + Sequence consumer integration (`Campaign.targetSegmentId Int?` + `Sequence.targetSegmentId Int?` nullable additive FKs + engine-side resolution + DD-5.7 per-campaign live/frozen choice UX). Schema additions are purely additive nullable on existing models (no breaking changes; passes `migration_check` gate without bless markers): new `CustomerSegment` model + `Campaign.targetSegmentId Int?` + `Sequence.targetSegmentId Int?`. Pattern: Prisma `where`-compilation (DD-5.1) — NO raw SQL; tenant scoping structurally enforced via outermost-AND injection. Per-resourceType field allowlist (FR-3.4) — operators can only build predicates against allowlisted fields; prevents arbitrary cross-tenant probing. NEW cron engine `segmentEvaluationEngine.js` (1h cadence, engine #23 added to CLAUDE.md cron taxonomy). Cross-references `PRD_TAG_MASTER.md` (D12, segments reference TagMaster.name via `tagContains` op when D12 ships; meanwhile reference free-text Patient.tags) + `PRD_IMPORT_EXPORT_JOBS.md` (D10, large segment-member CSV exports flow through async job infra) + `PRD_AI_CHAT_HISTORY.md` (D13, Phase 2 segment AI-summarisation) + `PRD_INTEGRATIONS_HUB.md` (D11, Phase 2 audience-destination cards). **Total estimated effort post-design: 5-7 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** DD-5.1 (Prisma where-compilation vs raw SQL — security posture) + **DD-5.2 (STATIC semantics — frozen id list vs frozen fields vs hybrid materialised-then-current-joined) — HIGHEST LEVERAGE; determines the data model shape** + DD-5.4 (visual builder vs YAML/JSON editor — frontend scope) + DD-5.7 (campaign segment timing — live re-eval at send-time vs frozen at create-time vs per-campaign operator choice) + Q4 (fixed field allowlist vs operator-extensible via Custom Fields integration — security surface) + Q7 (strict single-resource v1 vs allow simple one-hop relations like "Patient with at least one Visit in last 30d" — predicate-engine scope).

---

### D15. Staff/Employee Detail Depth (#852) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `hr`, `payroll-inputs`, `compliance`, `encryption`

**Why manual:** today's `User` model at [backend/prisma/schema.prisma:348-395](../backend/prisma/schema.prisma#L348-L395) is auth-identity only (email, password, name, role, wellnessRole, 2FA, SSO, theme, sub-brand access — ~12 fields). Compared to Zylu's reference 26-field employee schema, it misses statutory IDs (PAN, Aadhaar), HR metadata (DOB, joiningDate, endDate, employmentType), payroll inputs (baseSalary, commissionPercent), banking (accountNumber, IFSC, bankName), emergency contact, address, document attachments (passport / education cert / signed offer letter / work-visa), photo, notes, and per-tenant custom fields. Today's operator workaround: spreadsheets / WhatsApp groups / paper files — fragile, private, unauditable, compliance-frail. Month-end payroll requires the accountant to ask the operator to compile bank + salary data manually each cycle. PF/ESIC audits scramble for Aadhaar records. Emergency contact for an unconscious doctor cannot be found. PRD drafted at `docs/PRD_STAFF_DETAIL.md` (tick #194, 2026-05-25 / Agent B — Bonus PRD #8 on top of the official 10 P3 + 7 prior bonus). 6 design decisions + 10 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma `EmployeeProfile` + `EmployeeProfileDocument` models + User back-relation + `employeeProfileAccess.js` RBAC + 3 of 7 endpoints (GET/PUT profile + POST photo) + `fieldEncryption.js` integration + audit events (CREATED / UPDATED / VIEWED / SALARY_VIEWED / AADHAAR_VIEWED / PAN_VIEWED / BANK_VIEWED); slice 2 (~1d) = document upload endpoints (POST/DELETE/GET-file) + Multer + MIME allowlist + DOC_UPLOADED / DOC_DELETED / DOC_VIEWED audit; slice 3 (~0.75d) = payroll CSV export + Staff page atomic POST extension + PAYROLL_EXPORTED audit; slice 4 (~2.5d) = `frontend/src/pages/admin/EmployeeProfile.jsx` (5 tabs: Personal / Statutory IDs / Bank-Payroll / Documents / Audit + optional Notes) + Staff Add/Edit Staff modal Step 2 extension + document-upload modal + RBAC field-hiding per FR-3.3; slice 5 (~0.5d) = vitest for `employeeProfileAccess.js` (RBAC matrix coverage) + CI gate-spec wiring. Schema additions are purely additive (new EmployeeProfile + EmployeeProfileDocument models + nullable User back-relation only — no field changes to existing models; passes `migration_check` gate without bless markers). Pattern: sibling EmployeeProfile model (DD-5.1) — auth identity stays minimal on User; HR data lives on sibling 1:1 model; encryption applies only to EmployeeProfile fields (PAN / Aadhaar / bank account via existing `lib/fieldEncryption.js`). Pluggable storage backend (DD-5.4) — local-disk default + S3 opt-in via `EMPLOYEE_DOC_STORAGE=local|s3` env var; re-uses existing `Attachment` model. Commission scheme links to existing `CommissionProfile` model (DD-5.5) — no duplication. Cross-references `PRD_IMPORT_EXPORT_JOBS.md` (D10, large payroll CSV exports flow through async job infra for >50 employees) + `PRD_INTEGRATIONS_HUB.md` (D11, Phase 3 HR sync to Zoho People / BambooHR / GreytHR as hub card) + `PRD_AI_CHAT_HISTORY.md` (D13, Phase 2 AI-summarisation of audit log "who viewed Aadhaar last week"). **Total estimated effort post-design: 5-7 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** **DD-5.1 (User extension vs sibling EmployeeProfile) — HIGHEST LEVERAGE; determines model shape + query patterns + encryption boundary across the entire surface** + DD-5.2 (India-default PAN+Aadhaar vs polymorphic statutory-ID table — schema flexibility) + DD-5.3 (strict MANAGER+ hides salary vs operator-configurable per-tenant or per-user — RBAC surface) + Q1 (region in v1; today's tenants are India-only) + Q2 (salary visibility — strict MANAGER+ vs operator-configurable — RBAC + tenant config) + Q6 (emergency contact default visibility — USER-only-own vs tenant-wide-on-flag — receptionist-access use case) + Q7 (self-edit scope — USER can edit own personal data only vs zero-self-edit ADMIN-managed entirely).

---

### D16. Wallet Top-up Flow with Bonus Rules + Expiry (#788) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `loyalty`, `payments`, `cron`

**Why manual:** the CRM today ships the WALLET STORAGE LAYER (`Wallet` + `WalletTransaction` models at [backend/prisma/schema.prisma:3496-3531](../backend/prisma/schema.prisma#L3496-L3531) + two ADMIN-only credit/debit endpoints at [backend/routes/wellness.js:7957](../backend/routes/wellness.js#L7957) + `writeWalletTransaction()` / `getOrCreateWallet()` helpers) but the OPERATOR + CUSTOMER-facing TOP-UP FLOW is missing entirely. Today's operator workaround: call the raw admin-credit endpoint via a sidebar tool with no UX, no bonus-rule application, no payment-method capture, no SMS receipt; bonus credits cannot exist (no `WalletBonusRule` model + no bucket distinction between principal vs bonus on `WalletTransaction`); expiry policy cannot exist (no `expiresAt` on credits + no cron sweep); customer cannot see a paginated wallet statement (only the raw ledger query is available); reversal flow is absent (operator does ad-hoc DEBIT rows with "refund" in `reason`); no SMS confirmation on top-up or expiry warning. Zylu (the salon CRM reference cited in #788) ships the full pattern: top-up form on patient detail + bonus rules ("pay ₹2000 → get ₹200 bonus") with operator-defined precedence + bonus expiry (12mo default) + customer SMS receipt + nightly expiry-sweep cron + T-7d warning + reversal flow with bonus clawback + paginated statement. PRD drafted at `docs/PRD_WALLET_TOPUP.md` (tick #195, 2026-05-25 / Agent B — Bonus PRD #9 on top of the official 10 P3 + 8 prior bonus). 8 design decisions + 11 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma `WalletBonusRule` + `WalletCreditBatch` models + WalletTransaction type-vocab lock + one-shot legacy migration script + `walletRuleEngine.js` (DD-5.1 rule selection) + `walletRedemption.js` (DD-5.3 batch walker) + 3 of 7 endpoints (POST topup + POST redeem + GET transactions) + idempotency + audit `WALLET_TOPUP / _REDEEM / _BALANCE_VIEWED` events; slice 2 (~1d) = `walletExpiryEngine.js` cron + admin trigger + T-7d + T-0 SMS + audit `WALLET_EXPIRY / _EXPIRY_WARNING_SENT`; slice 3 (~0.75d) = reversal endpoint + audit `WALLET_REVERSAL`; slice 4 (~1d) = admin rules endpoint set (`GET/POST/PUT /api/wallet/rules`) + audit `WALLET_RULE_CHANGED`; slice 5 (~2d) = `frontend/src/pages/admin/WalletRules.jsx` (rule list + edit modal + preview pane + audit feed) + Patient detail Wallet tab (8th tab on the existing 7-tab structure) + top-up modal + redeem flow + reversal modal + RBAC field-hiding per FR-3.9; slice 6 (~0.5d) = vitest for `walletRuleEngine.js` + `walletRedemption.js` + `walletExpiryEngine.js` + CI gate-spec wiring. Schema additions are purely additive (new `WalletBonusRule` + `WalletCreditBatch` models only — no field changes to existing models; passes `migration_check` gate without bless markers). Pattern: sibling `WalletCreditBatch` model (DD-5.2 path a) — every top-up creates 1 principal batch + (if rule applies) 1 bonus batch with `expiresAt`; redemption walks live batches per DD-5.3 priority (recommended: principal-FIFO + bonus-soonest-expiry-FIFO — customer-fair). NEW cron engine `walletExpiryEngine.js` (daily 03:30 IST, engine #24 added to CLAUDE.md cron taxonomy — joins after `segmentEvaluationEngine.js` from D14). Cross-references `PRD_PAYMENT_GATEWAY_CONFIG.md` (D9, gateway top-ups route through D9's payment surface; shared idempotency model per DD-5.6) + `PRD_IMPORT_EXPORT_JOBS.md` (D10, future wallet-statement PDF export Phase 2 flows through async job infra) + `PRD_AI_CHAT_HISTORY.md` (D13, Phase 2 AI "explain my wallet balance" customer-portal flow) + `PRD_CUSTOMER_SEGMENTS.md` (D14, Phase 2 "patients with bonus expiring in 30d" segment for proactive SMS campaigns). **Total estimated effort post-design: 4-6 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** DD-5.1 (bonus rule precedence — HIGHEST-PERCENT-WINS vs operator-defined-order vs all-stacked — engine flow) + **DD-5.2 (bucket-tracking — sibling `WalletCreditBatch` model vs bucket-columns on existing `WalletTransaction`) — HIGHEST LEVERAGE; determines data model shape + query patterns + redemption algorithm across the entire surface** + DD-5.3 (redemption priority — principal-FIFO + bonus-soonest-expiry-FIFO vs bonus-first vs operator-choice — engine flow + customer fairness) + DD-5.7 (reversal semantics — clawback-only-unredeemed vs full-reversal-and-visit-charge-back — reversal UX) + Q1 (bonus stacking — tied to DD-5.1) + Q5 (expiry months default — 6 vs 12 vs 24 months) + Q9 (principal expiry policy — tied to DD-5.5; legal review needed for non-(a) paths).

---

### D17. POS New Sale screen — Booking / Walk-in tabs (#771) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `pos`, `atomicity`, `cron`

**Why manual:** the CRM today ships the POS MVP (`Sale` + `SaleLineItem` + `Register` + `Shift` + `PettyCashLedger` Prisma models at [backend/prisma/schema.prisma:3817-3958](../backend/prisma/schema.prisma#L3817-L3958) + 18 routes under `/api/pos/*` at [backend/routes/pos.js](../backend/routes/pos.js) including the monolith `POST /sales` finalize at [:697-960](../backend/routes/pos.js#L697) + frontend flat-builder at [frontend/src/pages/wellness/PointOfSale.jsx](../frontend/src/pages/wellness/PointOfSale.jsx) with Wave 7C extras for guest-checkout / coupon / manager-override) but the OPERATOR-FACING **Booking vs Walk-in tab UX** is missing entirely. Today's operator at the front desk has a single flat builder: pick a `lineType` radio, type a memorised `refId`, type a name, type a quantity / price — no path begins a sale FROM an existing `Booking` row (no `Sale.bookingId` FK exists today); no items-autocomplete over the existing Service / Product / Membership / GiftCard / Package catalogues; payment-splitter column exists (`Sale.paymentBreakdownJson`, #789) but the UI does NOT emit it (operator picks ONE method); no PDF receipt emission helper exists (`pdfRenderer.js` lacks `renderReceiptPDF()` despite shipping `renderPrescriptionPDF` + `renderConsentPDF` + `renderInvoicePDF`); atomicity is leaky on wallet-debit (today's wallet redemption happens OUTSIDE the Prisma transaction — wallet failure AFTER sale-commit leaves orphaned state). Zylu (the salon CRM reference cited in #771) ships the full pattern: tab pivot between Bookings (today's confirmed bookings list) and Walk-in (blank canvas) + URL-driven shareable routes + autocomplete catalogue picker + multi-method payment splitter (cash + card + UPI + wallet + giftcard summing to total) + atomic finalize (Sale + SaleLineItem + Invoice + WalletTransaction + InventoryAdjustment + Booking status flip ALL in one transaction) + PDF receipt (thermal 80mm + A4) + void/refund with auto-reverse of inventory + wallet. PRD drafted at `docs/PRD_POS_NEW_SALE.md` (tick #196, 2026-05-25 / Agent B — Bonus PRD #10 on top of the official 10 P3 + 9 prior bonus). 8 design decisions + 12 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma `Sale.bookingId Int?` nullable FK + `lib/walletRedemption.js` internal helper (extracted from D16 slice 1) + `routes/pos.js` finalize extension (bookingId + Idempotency-Key + atomicity hardening — wallet redemption moves INSIDE the Prisma transaction) + `GET /api/pos/bookings/today` + audit `SALE_FINALIZED` (replaces legacy `SALE_CREATED`); slice 2 (~1d) = `GET /api/pos/bookings/:id/sale-draft` + `GET /api/pos/catalogue/search` + `backend/cron/draftSaleCleanupEngine.js` (engine #25 — daily sweep of abandoned drafts) + audit `SALE_DRAFT_CREATED / _DRAFT_ABANDONED`; slice 3 (~0.75d) = `POST /api/pos/sales/:id/void` per DD-5.4 + audit `SALE_VOIDED` + wallet reversal integration + inventory reversal; slice 4 (~1d) = `services/pdfRenderer.js::renderReceiptPDF()` (thermal 80mm + A4 layouts) + `GET /api/pos/sales/:id/receipt.pdf`; slice 5 (~3d) = `frontend/src/pages/wellness/pos/NewSale.jsx` tab container + `NewSaleBookingTab` + `NewSaleWalkInTab` + `PatientPicker` + `ItemsPicker` + `PaymentSplitter` + `VoidSaleModal` + RBAC field-hiding per FR-3.11 + draft-restore via URL `?draftId=N`; slice 6 (~0.5d) = vitest for `walletRedemption.js` + `draftSaleCleanupEngine.js` + frontend NewSale test for tab routing + payment-splitter delta validation + CI gate-spec wiring. Schema additions are purely additive (one nullable FK on Sale only — no field changes elsewhere; passes `migration_check` gate without bless markers). Pattern: URL-driven tab routing (DD-5.1 path a) — `/pos/new/booking` vs `/pos/new/walk-in` vs `/pos/new/booking/:bookingId` — shareable + back-button correct; autocomplete typeahead (DD-5.2 path a) — unified search across 5 line types; one-button-per-method payment splitter (DD-5.3 path a); ADMIN-only void (DD-5.4 path a — strictest audit); thermal + A4 receipt (DD-5.5 path a). Existing legacy `/pos` flat-builder page preserved at `/pos/legacy` for 30 days post-deploy; Phase 2 sunset via telemetry. NEW cron engine `draftSaleCleanupEngine.js` (daily, configurable via `POS_DRAFT_TTL_HOURS`, engine #25 — joins after `walletExpiryEngine.js` from D16). Cross-references `PRD_PAYMENT_GATEWAY_CONFIG.md` (D9, CARD/UPI/ONLINE payment lines route through D9's payment surface; shared idempotency model per DD-5.6) + `PRD_IMPORT_EXPORT_JOBS.md` (D10, Phase 2 bulk-sale-CSV-export flows through async job infra) + `PRD_WALLET_TOPUP.md` (D16, WALLET payment-line method calls `lib/walletRedemption.js` internal-helper extracted from D16 slice 1 — shared dependency between D16 and D17). **Total estimated effort post-design: 6-9 engineering days** across backend + frontend.

**Blocks before frontend impl can start:** DD-5.1 (tab routing — URL path vs query param vs in-page state — App.jsx route shape) + DD-5.2 (items picker ergonomics — autocomplete vs modal vs sidebar — UX surface) + **DD-5.4 (void/refund actor — ADMIN-only vs cashier-window vs configurable) — HIGHEST LEVERAGE; determines RBAC matrix + cashier UX + audit-trail shape across the surface** + DD-5.5 (receipt format — thermal + A4 vs single — pdfRenderer template count) + DD-5.6 (discount stacking — single-source-of-truth vs all-stacked vs configurable — pricing engine) + DD-5.7 (walk-in patient — picker-mandatory unless guest-checkout — Walk-in tab gate) + DD-5.8 (booking auto-flip on finalize — binary COMPLETED vs configurable PARTIALLY_COMPLETED) + Q1 (discount authorization threshold — cashier max % vs per-tenant configurable) + Q9 (membership reference shape — Sale-level `appliedMembershipId` vs per-line `SaleLineItem.appliedMembershipId`).

---

### D18. POS Polymorphic Invoice spine — `invoices` + `invoice_lines` + `payments` (#775) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `schema-migration`, `pos`, `billing`, `gst`, `back-compat`

**Why manual:** the CRM today ships TWO disjoint financial-data shapes that both partially address what #775 calls the "polymorphic invoice spine" — a generic `Invoice` model at [backend/prisma/schema.prisma:842-881](../backend/prisma/schema.prisma#L842-L881) (Deal-attached billing surface: `invoiceNum` + single-`amount Float` + `status ∈ {UNPAID,PAID,OVERDUE,VOIDED}` + `dueDate` + `dealId` + `contactId` + `visitId Int?` for wellness-visit rollup per #601 + `legalEntityCode String?` for travel multi-GST per Q-meta; used by `frontend/src/pages/Billing.jsx` + `frontend/src/pages/Invoices.jsx` + `backend/routes/billing.js`); and a wellness `Sale` + `SaleLineItem` parallel shape at [backend/prisma/schema.prisma:3895-3958](../backend/prisma/schema.prisma#L3895-L3958) (POS receipt: per-tenant-unique invoice number, single `paymentMethod String` or `COMBINED` magic + `paymentBreakdownJson @db.Text` JSON-bag for split-tender, polymorphic `lineType` ∈ `{SERVICE,PRODUCT,MEMBERSHIP,GIFTCARD,PACKAGE}` with indirect `refId Int` and NO per-line tax breakdown + NO per-line staff assignment); plus the existing generic `Payment` model at [backend/prisma/schema.prisma:2365-2384](../backend/prisma/schema.prisma#L2365-L2384) (Stripe/Razorpay charge ledger; 1-to-1 invoice↔charge cardinality; does NOT model split-tender). The wellness spine #775 demands is a first-class polymorphic shape with SIX line types (adds `WALLET_TOPUP` beyond today's 5-value vocab) + per-LOCATION invoice numbering (today's per-tenant scheme breaks down for multi-location chains — Bangalore #42 + Mumbai #42 cannot coexist) + per-line tax breakdown with GST CGST/SGST/IGST split for Indian audit-trail compliance + per-line `staff_id` + `time_slot` + `resources Json` + first-class M-Payments-per-Invoice split-tender (cash + UPI + wallet on one invoice = 3 queryable rows, not a `@db.Text` JSON column) + cents-not-Float monetary representation (consistent with WalletTransaction per PRD_WALLET_TOPUP D16 DD-5.6, avoids Float-rounding bug class across GST + discount + wallet computations). Zylu (the salon CRM reference cited in #775) ships the full pattern: `invoices` + `invoice_lines` + `payments` triple with the spine above. PRD drafted at `docs/PRD_POS_POLYMORPHIC_INVOICE.md` (tick #197, 2026-05-25 / Agent B — Bonus PRD #11 on top of the official 10 P3 + 10 prior bonus). 8 design decisions + 8 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma schema additions (NEW Invoice + InvoiceLine + InvoicePayment models + `Location.invoiceNumberTemplate` + `Tenant.invoiceVoidWindowHours` + `Tenant.taxInclusivePricing` + `Tenant.invoiceFiscalYearStartMonth`) + `dealInvoiceAdapter.js` back-compat shim + `invoiceNumberSequence.js` per-location atomic helper + `routes/wellness-invoices.js` core CRUD (LIST + DETAIL + CREATE + UPDATE) + api-spec tests; slice 2 (~1.5d) = FINALIZE endpoint with full atomic `$transaction` (Invoice + N lines + M payments + InventoryAdjustment + WalletTransaction in one tx) + payment-sum validation + audit `INVOICE_COMPLETED / PAYMENT_RECORDED`; slice 3 (~0.75d) = VOID + REFUND endpoints with reverse-side-effects + audit `INVOICE_VOIDED / INVOICE_REFUNDED / PAYMENT_REFUNDED` + RBAC matrix; slice 4 (~1d) = `services/pdfRenderer.js::renderWellnessInvoicePDF()` (THERMAL 80mm + A4 layouts) + `/pdf` + `/email` + `/sms` endpoints; slice 5 (~1d) = `scripts/backfill-wellness-invoices.js` one-shot backfill + admin trigger endpoint (per `adding-admin-trigger-endpoint` skill) + idempotency-by-saleId + runbook; slice 6 (~1d) = schema rename `Invoice` → `DealInvoice` with `[allow-rename]` bless marker + code sweep across `routes/billing.js` + `routes/invoices.js` + frontend `Billing.jsx` + `Invoices.jsx` + back-compat alias verification + CHANGELOG/README/CLAUDE.md updates. Schema additions are mostly additive (3 new models + ~5 column adds) BUT include one rename (generic `Invoice` → `DealInvoice`) gated by `[allow-rename]` bless marker; back-compat alias at `backend/lib/dealInvoiceAdapter.js` keeps the generic-CRM Billing surface working for 30d post-deploy. Pattern: clean fork (DD-5.2 path a) over discriminator-column (path b) — avoids implicit-filter risk across every wellness query + keeps the polymorphic spine schema clean; pure Int + lineType polymorphism (DD-5.1 path a) over 6-nullable-FK approach — matches today's `SaleLineItem.refId` pattern + bounded column count; GST CGST/SGST/IGST split (DD-5.4 path a) for India-default tenants + nullable on non-India tenants — future-compat with E-invoice GSTN integration; ADMIN-only void + MANAGER-with-window refund + partial-refund-supported-in-v1 (DD-5.7 path a) — strictest audit + financial-records-of-record bar; Int autoincrement PK (DD-5.8 path a) over UUID per Zylu's literal spec — preserves CRM-wide pattern + bounded index size; closed-enum payment methods (DD-5.6 path a) — 9 values incl `OTHER` catch-all. Cross-references `PRD_POS_NEW_SALE.md` (D17, UI consumer of this PRD's routes — D17 + D18 ship in coordination; D17's slice 5 frontend Invoice page surfaces THIS PRD's `Invoice` + `InvoiceLine` + `InvoicePayment` shape) + `PRD_WALLET_TOPUP.md` (D16, `WALLET_TOPUP` line type integrates with `lib/walletRedemption.js` from D16 slice 1; `InvoicePayment.method=WALLET` calls the same helper — shared dependency between D16 + D17 + D18) + `PRD_PAYMENT_GATEWAY_CONFIG.md` (D9, CARD / UPI / ONLINE InvoicePayment methods route through D9's payment surface; `InvoicePayment.gatewayPaymentId Int?` FKs to the existing `Payment` model for gateway-charge audit trail; shared idempotency model per DD-5.6) + `PRD_IMPORT_EXPORT_JOBS.md` (D10, Phase 2 bulk-invoice-CSV-export flows through async job infra). **Total estimated effort post-design: 7-10 engineering days** across backend + frontend.

**Blocks before implementation can start:** DD-5.1 (polymorphic `itemId` — pure `Int + lineType` vs first-class FK per type — InvoiceLine column count) + **DD-5.2 (existing generic Invoice — rename to `DealInvoice` clean-fork vs `kind` discriminator-column) — HIGHEST LEVERAGE; determines migration scope + generic-CRM Billing surface compatibility + back-compat window length** + DD-5.4 (tax model — GST CGST/SGST/IGST split vs simple total — InvoiceLine column count + PDF template) + DD-5.7 (void/refund actor + partial-refund semantics — RBAC matrix + status state machine) + Q1 (migrate-or-keep generic Invoice — tied to DD-5.2) + Q2 (invoice number reset cadence — annual fiscal-year-based for Indian GST vs continuous — sequence engine logic) + Q6 (GIFTCARD line type — SELLING giftcards vs REDEEMING payment method vs BOTH — line type semantics disambiguation).

---

### D19. Mini Website page editor — logo + hero + service-order + contact-info + theme on the public booking slug (#809) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `multi-day-feature`, `operator-ux`, `mini-website`, `image-processing`, `seo`, `back-compat`

**Why manual:** the CRM today ships partial scaffolding via the `BookingPage` model at [backend/prisma/schema.prisma:2207-2236](../backend/prisma/schema.prisma#L2207-L2236) — Wave-7D landed `logoUrl @db.Text` / `heroImageUrl @db.Text` / `heroHeadline` / `heroSubheadline @db.Text` / `featuredServiceIds @db.Text` (CSV-style JSON-string of Service ids) / `contactPhone` / `contactEmail` / `hoursJson @db.Text` as nullable columns alongside the booking-flow fields (slug, title, description, ownerId, durationMins, bufferMins, availability, isActive). The public slug renderer at `GET /api/booking-pages/public/:slug` ([backend/routes/booking_pages.js:355-403](../backend/routes/booking_pages.js#L355)) reads them; the admin sub-modal on [frontend/src/pages/BookingPages.jsx](../frontend/src/pages/BookingPages.jsx) (856 LOC; 32 field references) edits them — BUT the Settings → Mini Website first-class editor surface that #809's acceptance criteria name (drag-to-reorder services, structured theme picker with preset palette + accent override, per-location scoping with distinct slugs for multi-location chains, image upload with multi-size server-side resize via `sharp`, draft/published workflow with cache invalidation, page-preview, SEO meta-tag + open-graph + sitemap surface, custom-CSS power-user fallback with `sanitize-html` gating) is missing entirely. Operator workflow today is operator-hostile: memorize Service ids for `featuredServiceIds` CSV, paste image URLs into text fields (no upload UX for logo/hero — only background image upload exists at `/:id/upload`), no theme picker (public page renders with the generic blue accent across all tenants), no per-location pivot (Enhanced Wellness Bangalore + Mumbai + Hyderabad share one mini-website despite being 3 Location rows), no draft state (any save flips the public site immediately), no SEO surface (search engines + social-share previews get the generic title + no open-graph image), no public-visible-per-service toggle (internal services like "Internal Consultation" appear in the public catalogue alongside customer-bookable ones). Zylu (the salon CRM reference cited in #809) ships the full pattern: Settings → Mini Website page with WYSIWYG / structured editor (logo upload zone with multi-size resize, hero block with image + headline + subheadline + CTA, drag-to-reorder service ordering with publicVisible toggles + "primary" star, contact block with full address + business hours per-weekday + map embed, theme picker with 4 presets — Modern teal / Classic warm-brown / Bold purple / Spa sage-green — + font dropdown + accent color override, custom CSS field gated to ADMIN, draft / published workflow with preview button opening `/m/<slug>?preview=1`, SEO surface with meta tags + open-graph + per-location sitemap, audit `MINI_WEBSITE_CONFIGURED / _PUBLISHED / _DRAFT_SAVED / _IMAGE_UPLOADED / _SERVICES_REORDERED / _ARCHIVED / _VIEWED` events flowing through the existing tamper-evident hash-chain). PRD drafted at `docs/PRD_MINI_WEBSITE.md` (tick #198, 2026-05-25 / Agent B — Bonus PRD #12 on top of the official 10 P3 + 11 prior bonus). 8 design decisions + 12 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1d) = Prisma schema additions (NEW `MiniWebsiteConfig` + `MiniWebsiteServiceFeatured` models + nullable `locationId` FK + back-compat `bookingPageId` FK + `@@unique([tenantId, slug])` + `@@unique([locationId])` composite-unique indexes) + `backend/lib/imageResizer.js` extraction from existing wellness photo-upload pattern + `backend/routes/wellness/mini-website.js` core CRUD (LIST + DETAIL + CREATE + UPDATE + DELETE) + api-spec tests; slice 2 (~1d) = image upload endpoint (POST /:id/upload with multi-size `sharp` resize — logo: favicon 64×64 + header 200×80 + large 400×160; hero: desktop 1920×600 + mobile 960×300 + open-graph 1200×630) + featured-services bulk-set endpoint + publish/unpublish endpoints + audit events (`MINI_WEBSITE_IMAGE_UPLOADED / _SERVICES_REORDERED / _PUBLISHED / _UNPUBLISHED / _DRAFT_SAVED`); slice 3 (~0.5d) = `backend/routes/public/mini-website.js` public read endpoint with 5-min cache + cache-invalidation-on-publish + api-spec test for draft-not-shown-publicly + per-location distinct slugs + preview-mode short-lived JWT; slice 4 (~2.5d) = `frontend/src/pages/wellness/MiniWebsiteEditor.jsx` admin editor page with 6 tabs (Branding / Services / Contact / Theme / SEO / Custom CSS) + per-location switcher dropdown + preview/publish/unpublish workflow + drag-to-reorder via dnd-kit + sidebar nav entry; slice 5 (~1.5d) = `frontend/src/pages/public/MiniWebsite.jsx` server-rendered public page per DD-5.5 path (a) + SEO meta tags + open-graph + Book Now CTA linking to existing `/book/<slug>` PublicBooking flow + mobile-responsive at 320px width minimum; slice 6 (~0.5d) = `backend/scripts/migrate-bookingpage-to-mini-website.js` one-shot Wave-7D back-compat migration + admin trigger endpoint per `adding-admin-trigger-endpoint` skill + idempotency-by-bookingPageId; slice 7 (~0.5d) = documentation (CHANGELOG.md entry + README.md "At a glance" refresh + CLAUDE.md schema-notes update + operator runbook at `docs/runbook-mini-website.md`). Schema additions are purely additive (2 new models + 30d-deprecation flag on Wave-7D BookingPage fields — Phase 2 sunsets with `[allow-column-drop]` bless marker after migration window); passes `migration_check` gate without bless markers. Pattern: sibling `MiniWebsiteConfig` (DD-5.1 path b) over extending BookingPage — clean separation of concerns + booking-page stays focused on booking flow + per-location scope is more natural + the migration script is ~30 LOC; per-location scope (DD-5.2 path b) over per-tenant — multi-location chains need distinct mini-websites; preset palette + accent color override (DD-5.3 path b) over full Google Fonts picker — designer-approved palettes + bounded operator-flexibility + small implementation cost; local-disk storage default + S3-pluggable via `MINI_WEBSITE_STORAGE=local|s3` env var (DD-5.4 path b) — mirrors `PRD_STAFF_DETAIL.md` D15's `EMPLOYEE_DOC_STORAGE` pattern; server-side HTML rendering (DD-5.5 path a) over React-SSR or CSR — best SEO + perf + matches the largely-static mini-website surface (interactivity via the booking-flow SPA at `/book/<slug>`); meta tags + open-graph only (DD-5.6 path a) for v1 — covers 80% of SEO value + Phase 2 adds sitemap + Phase 3 adds JSON-LD; draft/published workflow (DD-5.7 path b) over single-state — matches Zylu reference + safer for operator; dnd-kit (DD-5.8 path c) over react-beautiful-dnd (de-prioritized) or HTML5 native (poor touch) — modern + touch-friendly + active maintenance. Cross-references `PRD_TRAVEL_PER_SUBBRAND_BRANDING.md` (existing, NOT a dependency — that PRD scopes per-sub-brand theme for the operator's INTERNAL app, THIS PRD scopes the CUSTOMER-FACING public mini-website; different audience + render layer + data model) + `PRD_STAFF_DETAIL.md` (D15, pluggable-storage pattern shared per DD-5.4 — `MINI_WEBSITE_STORAGE=local|s3` mirrors `EMPLOYEE_DOC_STORAGE`) + `PRD_POS_NEW_SALE.md` (D17, both reference the `Service` catalogue — D17 for line-pick at POS; D19 for featured-ordering on mini-website; shared dependency on Service shape; Q "Service.publicVisible toggle" cross-cuts both) + `PRD_INTEGRATIONS_HUB.md` (D11, Phase 3 mini-website preview/publish surfaces as a hub card for unified governance). **Total estimated effort post-design: 5-8 engineering days** across backend + frontend.

**Blocks before implementation can start:** **DD-5.1 (schema shape — extend BookingPage vs new sibling MiniWebsiteConfig — entire data-layer + back-compat migration scope + BookingPage's future role) — HIGHEST LEVERAGE** + DD-5.2 (per-tenant vs per-location scope — column nullability + composite-unique index shape) + DD-5.3 (theme depth — preset palette vs preset+accent vs full picker + Google Fonts — admin-page complexity + dependency list) + DD-5.5 (public render layer — server-side HTML vs React-SSR vs CSR — frontend architecture + SEO posture) + DD-5.7 (publish workflow — single vs draft/published — column count + audit event vocab) + Q1 (sidebar placement — Settings vs Wellness sidebar; URL pattern flat `/m/<slug>` vs hierarchical `/<tenantSlug>/<locationSlug>` — frontend routing + sidebar nav) + Q7 (custom CSS field — gate to ADMIN-only — RBAC matrix + sanitization shape) + Q12 (mini-website-to-booking handoff — confirm `/book/<slug>` reuse over a dedicated mini-website-scoped booking surface — frontend CTA routing).

---

### D20. Biometric attendance + geofenced mobile check-in — `AttendanceEvent` event-stream + ESSL/Realtime vendor adapter + mobile PWA (#805) — PRD drafted, design call pending
**Labels:** `wellness-session`, `backend`, `frontend`, `mobile-pwa`, `multi-day-feature`, `schema-migration`, `attendance`, `biometric`, `geofence`, `audit`, `back-compat`

**Why manual:** the CRM today ships partial scaffolding via the `Attendance` + `BiometricDevice` Prisma models at [backend/prisma/schema.prisma:3663-3714](../backend/prisma/schema.prisma#L3663-L3714) — Wave 2 Agent JJ (8 May 2026) landed a single-row-per-day `Attendance` model with `clockInAt` + `clockOutAt` + `source String @default("MANUAL")` (free-text against `BIOMETRIC | MANUAL | MOBILE`) + `biometricDeviceId Int?` + `totalMinutes Int?` + a `BiometricDevice` stub (`tenantId` + `locationId Int?` nullable + `deviceId` + `vendor` free-text + `apiKey String` PLAINTEXT at rest + `lastSyncAt` + `isActive`) + 793 LOC of `/api/attendance/*` routes at [backend/routes/attendance.js](../backend/routes/attendance.js) (clock-in/out + summary with #802/#804 early/on-time/late breakdown + biometric webhook with X-API-Key auth derived from `BiometricDevice.apiKey` via `@@unique` + admin device CRUD) — BUT the **event-stream `attendance_events` table** that #805's literal acceptance criterion demands is missing; the model is a **single-row-per-day rollup** with `@@unique([tenantId, userId, date])` collapsing the full event story (Indian clinic shifts routinely 09:00-13:30 morning + 14:30-21:00 evening with operator scanning the device 4 times — the four-event story is lost), AND the existing `BiometricDevice.apiKey` is PLAINTEXT (`lib/fieldEncryption.js` exists but is NOT wired here — used for Patient PII only per CLAUDE.md), AND there's NO `ipAddress` / `deviceSerial` / vendor-specific config columns (ESSL needs `baseUrl` + `pollIntervalSeconds`; Realtime needs `authHeadersJson`), AND there's NO IP-allowlist enforcement on the webhook, AND there's NO event-idempotency dedup (accidental double-tap on device creates duplicate Attendance updates), AND there's NO mobile geofenced check-in flow at all (Location has `latitude Float?` + `longitude Float?` already but NO `geofenceRadiusM` / `geofenceAccuracyThresholdM` / `geofenceStrict` columns, no consumer reads the lat/lng, no mobile PWA at all — wellness frontend is desktop-first), AND there's NO ESSL or Realtime per-vendor adapter (the existing webhook is generic / vendor-agnostic but the per-vendor poll-mode integration ATT-004 lists is missing — ESSL ships HTTP-API at port 4370 Push-SDK / port 80 RestAPI requiring CRM to POLL the device because clinic LAN NAT-blocks outbound; Realtime ships HMAC-SHA256-signed webhook push-mode), AND the manager-fallback flow is conflated with self-service (today's `/clock-in` endpoint always writes for the authenticated user — there's no `targetUserId` body param + verifyRole MANAGER/ADMIN override + mandatory `manualReason` text + payroll-grade audit `ATTENDANCE_MANUAL_OVERRIDE` event), AND the source-breakdown reports (% biometric / manual / mobile per user per week) don't exist (summary endpoint aggregates by status only, not source). Zylu (the salon CRM reference cited in #805) ships the full pattern: `attendance_events` event-stream table (UUID PK + `staff_id` + `type ∈ CHECK_IN | CHECK_OUT | BREAK_START | BREAK_END` + `event_at` + `source ∈ BIOMETRIC | MANUAL | MOBILE | API` + `latitude` + `longitude` + `accuracy_m` + `biometric_device_id` + `manual_reason` + `ip_address` + `device_serial` + `created_at`) + `biometric_devices` extended (vendor enum + device_serial + ip_address + base_url + api_key encrypted + poll_interval_seconds + auth_headers_json + ip_allowlist_json + active) + `location` geofence extension (`geofence_radius_m` + `geofence_accuracy_threshold_m` + `geofence_strict`) + ESSL HTTP-API poll-mode adapter + Realtime webhook push-mode adapter + mobile PWA (`navigator.geolocation` + haversine radius check + IndexedDB offline queue + service worker `'sync'` event flush) + manager-only manual-override route with mandatory reason + source-breakdown reports. PRD drafted at `docs/PRD_BIOMETRIC_ATTENDANCE.md` (tick #199, 2026-05-25 / Agent B — Bonus PRD #13 on top of the official 10 P3 + 12 prior bonus). 8 design decisions + 7 open questions need product-call sign-off before implementation can start. Recommended slicing: slice 1 (~1.5d) = Prisma `AttendanceEvent` model (event-stream spine) + `BiometricDevice` additive columns (`deviceSerial` + `ipAddress` + `baseUrl` + `pollIntervalSeconds` + `authHeadersJson` + `ipAllowlistJson`) + `User.biometricDeviceUserId` additive + `Location.geofenceRadiusM / _AccuracyThresholdM / _Strict` additive + `routes/attendance.js` extensions (`/biometric-event` + `/mobile-checkin` + `/manual-checkin` + `/events` + back-compat `/clock-in/out` internally writing AttendanceEvent + transactional rollup) + api-spec tests; slice 2 (~0.5d) = audit event vocab (`ATTENDANCE_CHECK_IN / _CHECK_OUT / _MANUAL_OVERRIDE / _BIOMETRIC_ERROR / _GEOFENCE_FAIL / _DEVICE_REGISTERED / _DEVICE_DEACTIVATED`) + `lib/fieldEncryption.js` wiring for `BiometricDevice.apiKey` (opt-in via new `BIOMETRIC_DEVICE_KEY` env var mirroring existing `WELLNESS_FIELD_KEY` pattern) + IP allowlist enforcement on `/biometric-event` + rate-limit 10 events/sec/device + idempotency `sha256(deviceSerial:eventAt:type)` 60s window; slice 3 (~2d) = ESSL vendor adapter at `services/biometricVendorAdapter.js::essl.js` (poll-mode against ESSL X990 / K20 / F22 RestAPI) + `cron/biometricDevicePollEngine.js` engine #25 (joining after the 24 existing engines per CLAUDE.md; runs every 5 min configurable via `BiometricDevice.pollIntervalSeconds`) + admin trigger endpoint `POST /api/attendance/devices/:id/sync-now` per `adding-admin-trigger-endpoint` skill + vitest for adapter + cron engine; slice 4 (~0.75d) = Realtime vendor adapter at `services/biometricVendorAdapter.js::realtime.js` (push-mode + HMAC-SHA256 webhook signing verify per Realtime spec) + vitest; slice 5 (~1d) = admin pages — `frontend/src/pages/settings/BiometricDevices.jsx` (CRUD with vendor dropdown + apiKey masked-after-create `glbs_***...***last4` pattern + Test Connection button) + `frontend/src/pages/settings/Geofences.jsx` (Leaflet map preview with radius circle + per-Location editable radius/accuracy/strict + "Set my current location" helper) + `frontend/src/pages/wellness/AttendanceEvents.jsx` (event-stream list with user/source/date/type filters + stacked bar chart % biometric/manual/mobile per user per week) + RBAC field-hiding per FR-3.8; slice 6 (~2d) = mobile PWA shell at `frontend/src/pages/m/Attendance.jsx` + service worker at `frontend/public/sw-attendance.js` + IndexedDB offline queue + PWA `manifest.json` for "Add to Home Screen" + Leaflet map preview on Geofences page + battery-aware geolocation (`enableHighAccuracy: true` + `maximumAge: 60000` + `timeout: 10000`); slice 7 (~1.25d) = source-breakdown reports (extends `/summary` endpoint with source breakdown JSON shape) + one-shot backfill script at `backend/scripts/backfill-attendance-events.js` (translates existing single-row-per-day `Attendance` rows into pseudo-AttendanceEvent rows — one CHECK_IN at `clockInAt`, one CHECK_OUT at `clockOutAt` per existing row — so the new event-stream has historical data on day 1) + admin trigger endpoint per `adding-admin-trigger-endpoint` skill + idempotency-by-attendance-id + operator runbook at `docs/runbook-biometric-attendance.md`. Schema additions are purely additive (1 new model + 6 columns on BiometricDevice + 1 column on User + 3 columns on Location); passes `migration_check` gate without bless markers. Pattern: event-stream + rollup cohabitation (DD-5.6 path a) — keep existing `Attendance` as cron-refreshed rollup table for fast `/summary` reads while AttendanceEvent is source-of-truth (Phase 2 deprecates direct Attendance writes; Phase 3 drops or materializes); STRICT geofence default with per-Location `geofenceStrict Boolean` override (DD-5.3 path a) — security-conscious clinics reject out-of-radius + flexibility for delivery-driver-style tenants; PWA-only mobile (DD-5.2 path a) v1 ships in 2d slice 6 vs 4-8 weeks per platform for native — "Add to Home Screen" gives near-native feel on Android; ESSL-only vendor (DD-5.1 path a) v1 — captures ~70% of Indian clinic biometric market with smallest cred chase + Realtime can ship in v1.1 once vendor docs land; new `User.assignedLocationId` field + picker fallback (DD-5.5 path a) over territory-derived (fragile) or picker-only (poor UX); both `User.biometricDeviceUserId` (this PRD writes) + `EmployeeProfile.biometricDeviceUserId` (PRD_STAFF_DETAIL D15 read-through alias) denormalised (DD-5.7 path c) — small write cost + bounded join surface vs JOIN-on-every-poll; Int autoincrement PK (DD-5.8 path a) over UUID per Zylu's literal spec — preserves CRM-wide pattern + bounded index size; server timestamp `eventAt` authoritative + capture `deviceClockAt` for drift detection (DD-5.4 path a) — biometric devices routinely have NTP-drift hours-off + audit-viewer surfaces drift. Cross-references **`PRD_STAFF_DETAIL.md` (D15, `EmployeeProfile.biometricDeviceUserId` denormalised mirror per DD-5.7 — coordinate ship order; D15 ships first → this PRD writes through, this PRD ships first → D15 added in coordination)** + `PRD_POS_NEW_SALE.md` (D17, Phase 2 reads `Sale.cashierId`'s shift-attendance from the AttendanceEvent rollup for cashier-shift-attendance audit) + `PRD_INTEGRATIONS_HUB.md` (D11, Phase 3 biometric vendor integrations — ESSL + Realtime + ZKTeco — surface as hub cards for unified governance + per-vendor cred-chase tracking). **Total estimated effort post-design: 8-12 engineering days** across backend + frontend + mobile PWA.

**Blocks before implementation can start:** **DD-5.3 (geofence enforcement — STRICT default with per-Location flag vs LENIENT with audit-only flag — mobile UX feedback loop + audit-viewer + tenant onboarding) — HIGHEST LEVERAGE; cascades to every mobile check-in's response shape + audit-viewer event vocab + clinic-onboarding posture** + **DD-5.6 (event-stream + rollup cohabitation — keep `Attendance` rollup vs deprecate; migration scope across existing 793-LOC route file + frontend Attendance page + payroll integration) — HIGHEST LEVERAGE; cascades to NFR-4.7 migration plan + slice 7 backfill scope + Phase 2/3 deprecation timing** + DD-5.1 (vendor scope — ESSL-only v1 vs multi-vendor v1 — affects §5 cred chase volume + slice 3 vs slices 3+4 effort) + DD-5.2 (mobile surface — PWA vs native — affects slice 6 effort 2d vs 4-8 weeks per platform) + DD-5.5 (User.assignedLocationId vs picker vs territory-derived — affects FR-3.3 + every mobile check-in UX) + DD-5.7 (User.biometricDeviceUserId vs EmployeeProfile.biometricDeviceUserId denormalisation — affects ship-order coordination with D15) + Q1 (vendor scope — tied to DD-5.1) + Q4 (multi-shift rollup math — affects FR-3.4.f rollup correctness + payroll integration) + Q6 (holiday-override auto-flag for events on declared holidays — affects FR-3.1 + payroll). **Cred chase blocks slice 3:** ESSL India developer documentation + physical ESSL X990 loaner device for integration testing — Yasin's contact at ESSL India is the source-of-truth.

---

### D21. Public Status Page — `/status` + health probes + incident feed + RSS/Atom (#<next>) — PRD drafted, design call pending
**Labels:** `multi-day-feature`, `backend`, `frontend`, `observability`, `public-surface`, `schema-migration`, `cron`, `needs-design-call`

**Why manual:** the CRM has no customer-facing status page. `GET /api/health` at `backend/server.js:1757` is a point-in-time liveness probe only; the Developer page (`/developer`) and Super Admin API Analytics (`/super-admin/api-analytics`) are auth-gated internal surfaces. Building a `status.claude.ai` / `status.moonshot.cn` equivalent requires new Prisma models (`StatusComponent`, `StatusIncident`, `StatusIncidentUpdate`, `StatusDailySnapshot`), a scheduled health-probe service that checks `/api/health`, `/api/travel/health`, and other critical subsystems every 5 minutes, a daily snapshot cron for uptime-history bars, public API routes, RSS/Atom feeds, a public React page at `/status`, and a small admin incident-management surface. The schema shape and routing depend on unresolved DD-5.1 (subdomain vs path), DD-5.2 (hardcoded component list vs DB-driven admin CRUD), and DD-5.5 (SUPER_ADMIN-only incident auth vs ADMIN inclusive).

**Slicing recommendation:**
- Slice 1 — Prisma migration + seed components + probe service + daily snapshot cron.
- Slice 2 — Public API routes (`/api/status`, `/api/status/history`, `/api/status/incidents`, RSS/Atom).
- Slice 3 — Public React page `/status` (banner, component list, 30/60/90-day chart, incidents).
- Slice 4 — Admin incident-management page (`/admin/status`) gated to SUPER_ADMIN.
- Slice 5 — Tests, deploy wiring, Nginx/CDN cache rules, and docs.

**Blocks before implementation can start:** **DD-5.1 (URL/hosting — `/status` path vs `status.globusdemos.com` subdomain) — affects DNS/Nginx + frontend routing** + DD-5.2 (component list source — hardcoded seed vs DB-driven admin CRUD) + DD-5.5 (incident auth boundary — SUPER_ADMIN only vs ADMIN too) + OQ-9.5 (uptime history window length) + OQ-9.7 (public page theme — clean light vs app dark glass).

**Effort estimate:** 4–6 engineering days post-design call.

**Cross-refs:** `PRD_STATUS_PAGE.md` (this PRD). No direct sibling dependency; can ship independently of wellness/travel feature work.

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

### F1. CRM-side public lead-capture endpoint ✅ SHIPPED
**Labels:** `multi-day-feature`, `backend`, `voyagr-integration`, `gbs-crm-repo`
**Design decision LOCKED 2026-05-23:** API-key auth (Option 1) — mirror `/api/v1/external` partner-API pattern at `backend/routes/external.js` + `backend/middleware/externalAuth.js`. Per-site API key issued via CRM admin UI; voyagr stores in env vars; sent as `X-API-Key` header from a tiny Next.js API route so the key never reaches the browser.

**Status:** ✅ SHIPPED pre-session at commit `0299031` — `backend/routes/voyagr.js` (POST `/api/v1/voyagr/leads`) + `backend/middleware/voyagrAuth.js` (X-API-Key validation + `req.requireSubBrandMatch` helper extracted to `lib/apiKeyAuth.js` tick #21 `d784d3f`). Auth + dedup + Touchpoint creation + audit log all working. Subsequently extended at tick #17 with **per-sub-brand API key scoping** (#899 Part A `84efe0f` — `ApiKey.subBrand String?` additive nullable + helper) and the helper extracted at tick #21 (`d784d3f`).

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

### F3. Cross-system attribution + UTM tracking ✅ BACKEND SHIPPED
**Labels:** `multi-day-feature`, `backend`, `voyagr-integration`, `analytics`

**Status:** ✅ Backend SHIPPED tick #15 at commit `4770054` — `GET /api/attribution/voyagr/summary?days=N` in `backend/routes/attribution.js` surfaces voyagr-sourced leads via `bySubBrand` (via `Contact.subBrand`) + `byUtmSource` (via `Touchpoint.source`) + `byChannel` + `wonValue` per subBrand (joined to Deal). 6 new gate-spec cases (15→21). **Schema drift caught + documented:** `Touchpoint` only has `channel/source/medium/url/campaignId` columns — `siteSlug` / `utm_campaign` / `utm_term` / `utm_content` are written to `AuditLog.details` JSON only (not queryable columns). `bySiteSlug` ships as forward-compat `[]` placeholder. Admin UI surface (originally specced) remains as follow-up — operators can hit the endpoint directly or via the existing `MarketingDashboard.jsx`.

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

**Consolidated PRD:** [docs/PRD_RFU_GROUND_SERVICES.md](PRD_RFU_GROUND_SERVICES.md) — single spec covers all 3 integrations under the "RFU unified Umrah quote" use case (operator quotes cab + hotel + HSR in one fan-out). Includes 10 open questions (Q-RFUG-1..10), §5 cred-chase breakdown (7 vendor onboardings under Yasin), §6 acceptance criteria per integration + unified flow, §10 implementation sequencing.

### G1. Zikr Cabs ground-transfer API (#926)
**Labels:** `enhancement`, `travel-crm`, `rfu`, `cred-dependent`
**PRD:** [docs/PRD_RFU_GROUND_SERVICES.md](PRD_RFU_GROUND_SERVICES.md) §3.1 (FR-3.1.a–h) + §5.1 cred chase + §9 Q-RFUG-2/3/4/5/9.

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
**PRD:** [docs/PRD_RFU_GROUND_SERVICES.md](PRD_RFU_GROUND_SERVICES.md) §3.2 (FR-3.2.a–h) + §5.1 cred chase + §9 Q-RFUG-1/6/10.

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
**PRD:** [docs/PRD_RFU_GROUND_SERVICES.md](PRD_RFU_GROUND_SERVICES.md) §3.3 (FR-3.3.a–h) + §5.1 cred chase + §9 Q-RFUG-8 (program-existence blocker).

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
