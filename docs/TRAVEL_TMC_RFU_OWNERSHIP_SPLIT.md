# TMC + RFU — Build Ownership Split (Client vs. GlobusSoft)

**Filed:** 2026-06-08 • **Source:** [`travel-crm/TMC_RFU_ownership (1).pdf`](../travel-crm/TMC_RFU_ownership%20(1).pdf) — meeting sheet 1 June 2026 • **Status:** REFERENCE — not a feature PRD

> Scope-of-work split between **Yasin + Jihad** (client side: websites + lead capture + microsites + CMS/SEO/hosting) and **GlobusSoft** (everything else: CRM, AI calling, diagnostic, itineraries, payments, WhatsApp, telephony, ops dashboards, Workspace integration). Confirmed for TMC + RFU sub-brands; the same shape extends to Travel Stall + Visa Sure in Phase 2 + 3.

> **Why this lives as a separate doc (not inside `TRAVEL_CRM_PRD.md`).** The master PRD documents WHAT gets built. This doc documents WHO builds it. Different audiences — engineering reads the PRD; commercial + ops reads this for handoff alignment. Cross-references: master PRD [`TRAVEL_CRM_PRD.md`](TRAVEL_CRM_PRD.md), TMC diagnostic engine [`PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md`](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md), open questions [`TRAVEL_CRM_OPEN_QUESTIONS.md`](TRAVEL_CRM_OPEN_QUESTIONS.md), gap audit [`TRAVEL_CRM_GAP_AUDIT_2026-05-22.md`](TRAVEL_CRM_GAP_AUDIT_2026-05-22.md), ownership of credentials [`CREDS_TRACKER.md`](CREDS_TRACKER.md).

---

## 1. The Modern Classroom (TMC)

### 1.1 You + Jihad own

| Deliverable | Notes |
|---|---|
| Modern Classroom website | Pages: Home, Programmes, For Schools, For Students, Contact |
| Lead capture forms + CRM hand-off | Webhook/API to CRM — exact fields + endpoint + brand-tag format must settle pre-kickoff (see §3 open items) |
| Per-trip microsite | E.g. `trip-bali2026.tmc.travelstall.in` with OTP-gated pages (parent registration, payment plan, rooming list) |
| Website CMS, SEO, analytics tags, hosting | Out of scope for GS |

### 1.2 GlobusSoft owns

| Deliverable | Maps to (existing repo) |
|---|---|
| CRM setup for TMC brand — tagged pipeline, roles, activity log | Existing `Tenant.subBrandAccess[]`, `Pipeline.subBrand`, seed-travel.js seeds 4 diagnostic banks + TMC pipeline |
| Pull TMC website leads into CRM + route to right agent | `routes/lead_routing.js`, marketplace_leads webhook pattern, brand-tag matcher |
| AI calling agent (Callified.ai) to qualify TMC leads in Hindi/English | `services/callifiedClient.js` (stub-mode shipping; real call swaps in when Q9 creds arrive); cred-blocked per [`CREDS_TRACKER.md`](CREDS_TRACKER.md) |
| **Diagnostic tool** — scores schools/students, branded PDF + talking points | **THIS IS THE LARGER NEW BUILD** — [`PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md`](PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md) |
| Branded itineraries with version history | `routes/travel_itineraries.js` (status: draft/sent/revised/accepted/rejected) + [`PRD_TRAVEL_ITINERARY_UPGRADES.md`](PRD_TRAVEL_ITINERARY_UPGRADES.md) |
| Student list, rooming list, departure + document checklists | `TmcTrip` + `TripParticipant` + `RoomingAssignment` + `DocumentRequirement` models |
| Payment plan setup with reminders; trip + post-trip feedback | `TripPaymentPlan` + `TripInstalmentPayment` + Sequence engine + Survey/SurveyResponse |
| Parent/teacher registration, DigiLocker, passport OCR, secure storage | `routes/travel_microsites.js` public/OTP endpoints + DigiLocker integration (cred-blocked Q3) |
| **Airline web check-in (top 4: IndiGo, Air India, Vistara, Emirates)** | `routes/travel_webcheckin.js` + `cron/webCheckinScheduler.js` — Tier 1 committed; Tier 2 + captcha-heavy → Phase 1.5/2 |
| **Flight quotation Chrome plugin for agents** | Separate `flight-plugin/` package at repo root — private signed CRX, polled auto-update every 4-6h, force-update flag + 30-day rollback. **Multi-day work; not in repo yet.** |
| WhatsApp via Vati (TMC number) + call telephony via Exotel | `routes/whatsapp.js` + Wati BSP integration (Q9 cred-blocked); Exotel via `services/telephonyProvider.js` |
| TMC ops dashboard per trip + analytics (revenue, repeat, margin, conversion) | `routes/travel_dashboard.js` + `routes/travel_reports.js` + custom_reports.js |
| Google Workspace, Drive auto-folders, Google Meet booking | Google Workspace OAuth (Q7 settled in [`TRAVEL_CRM_OPEN_QUESTIONS.md`](TRAVEL_CRM_OPEN_QUESTIONS.md)); Drive folder auto-create on confirmed-trip CRM trigger |

---

## 2. Ready for Umrah (RFU)

### 2.1 You + Jihad own

| Deliverable | Notes |
|---|---|
| Ready for Umrah website with custom (non-group) package showcases | |
| Package inquiry form + CRM hand-off (triggers AI callback) | Same webhook contract as TMC (§3.1 below) |
| Blog / SEO landing pages, payment gateway on site, hosting | |

### 2.2 GlobusSoft owns

| Deliverable | Maps to |
|---|---|
| CRM setup for RFU brand — separate tagged pipeline, roles, activity log | Same shape as TMC, distinct `subBrand=rfu` |
| Pull RFU leads into CRM; trigger AI callback within seconds | `routes/lead_routing.js` + AI-callback cron |
| AI calling agent qualifies RFU leads, Hot/Warm/Cold scoring | `services/callifiedClient.js` (cred-blocked Q9) |
| Umrah quotation engine — flight + hotel + transport in one screen | `routes/travel_pricing.js` (engine + cost master + season calendar + markup rules already ship) + `Itinerary` model |
| Hotel rate comparator (RateHawk + manual; Booking/Expedia later) | `services/ratehawkClient.js` (cred-blocked Q19); manual contracted rates via `routes/travel_cost_master.js`; Booking/Expedia → Phase 1.5 once contracts close |
| Preference filters — Haram-facing view, room category, floor level | Hotel master fields + customer profile fields on `RfuLeadProfile` |
| Rule-based transport pricing with peak/lean season logic | `routes/travel_pricing.js` reads `TravelSeasonCalendar` + transport rate cards |
| Branded Umrah itineraries with version history, WhatsApp share | `Itinerary` model + `services/pdfRenderer.js` per-sub-brand templates |
| LLM-switchable layer (Perplexity, Gemini, Claude, GPT) | `backend/lib/llmRouter.js` — already ships with router defaults (`Response` B.7); cred-blocked Q11 for real API keys |
| RFU customer profiles, dedupe, journey reminders, religious content | `RfuLeadProfile` model + `utils/deduplication.js` (extended for passport) + `cron/travelJourneyReminders.js` + `cron/religiousGuidanceEngine.js` |
| **RFU diagnostic with tier tagging + scoring** | Same `routes/travel_diagnostics.js` shell, RFU-specific bank (4 levels: Confident & Prepared / Guided for Peace of Mind / Assisted for Comfort & Correctness / Premium-Elder-Care) |
| WhatsApp via Vati (RFU number) + telephony via Exotel | Same as TMC, distinct WABA phoneNumberId |
| RFU analytics (revenue, conversion, repeat by tier) | `routes/travel_reports.js` |
| Flight quotation Chrome plugin (shared, also serves RFU air tickets) | Same plugin as §1.2; multi-brand-aware |

---

## 3. Built once by GlobusSoft, serves both brands

The shared base under both sub-brands. All items reuse the existing CRM machinery; the only new build is the binding/extension per sub-brand.

| Shared deliverable | Maps to |
|---|---|
| **One multi-brand CRM** for 5–6 agents, full TMC/RFU separation | `Tenant.vertical=travel` + `Tenant.subBrandAccess[]` per User + `subBrand` field on Deal/Pipeline/Itinerary/Quote/Invoice/etc. |
| **Unified lead inbox**, custom travel fields, 8-status pipeline, 8 lost reasons | Statuses: New, Qualified, Diagnostic pending, Consultation booked, Follow-up pending, Won, Lost, Dormant. Lost reasons: Price, No response, Chose competitor, Wrong requirement, Timing issue, Budget issue, Trust issue, Duplicate enquiry. Seeded in seed-travel.js. |
| **Management dashboard across both brands** | `routes/travel_dashboard.js` + `Dashboards.jsx` per-vertical |
| Light accounting (invoice, receipt, GST, refund, CA export) + Excel bridge | [`PRD_TRAVEL_BILLING.md`](PRD_TRAVEL_BILLING.md) + [`PRD_TRAVEL_GST_COMPLIANCE.md`](PRD_TRAVEL_GST_COMPLIANCE.md); Excel Software bridge cred-blocked Q8 |
| **Wati WhatsApp with three separated numbers** (TMC, RFU, ops) | Wati Business account (₹10,999/mo) + 3 WABA numbers; per-message rates per `Response` B.4. `subBrandConfigJson` (commit `621aab7`) routes per-sub-brand WABA — Q9 swap is zero-edit per consumer when creds arrive |
| Hosting on AWS Mumbai, document security, audit logs, SSO, data ownership + exit | `Response` B.2 — AWS ap-south-1 multi-AZ + DR Singapore + AES-256 + 24m+36m audit retention + `Tenant`-scoped data ownership |

---

## 4. Open settlements (from the meeting sheet's "Settle tomorrow" line)

| ID | Item | Default proposal | Owner | Status |
|---|---|---|---|---|
| **OS-1** | **Website-to-CRM hand-off contract** — exact lead fields, webhook/API endpoint, brand-tag format | Standard JSON webhook to `POST /api/marketplace-leads/webhook` (existing path) with body `{subBrand: "tmc"\|"rfu", source: "website-form", utm: {...}, contact: {name, email, phone}, customFields: {primary_outcome?, grade_band?, ...}}`. Brand-tag = `subBrand` field literal. Bearer-token auth with per-website token in CRM admin. | Tech (GS) + Jihad | OPEN |
| **OS-2** | **Price contradiction** — Rs 2,17,000 vs Rs 2,50,000 across the proposal + later docs | GS commercial confirmation. The `Response` document (2026-05-15) carries the final number; older proposal supersedes. Likely 2,50,000 is the final per `GlobusSoft_Response_15May2026.pdf` §B.14. | Yasin + GS commercial | OPEN |
| **OS-3** | **Timeline contradiction** — 30 vs 42 days | Same as OS-2; the `Response` doc commits 42 days (6 weeks). Older proposal had a shorter ambition. | Yasin + GS commercial | OPEN |
| **OS-4** | **Booking.com / Expedia rates** — promised in proposal, not licensed per later response | Confirm Phase 1 is `RateHawk + manual contracted rates` ONLY. Booking.com + Expedia direct → Phase 1.5 once contracts close (4-8 wk lead time). Communicated already in `Response` B.3. | Yasin + GS commercial | RESOLVED-IN-DOCS but needs sign-off |

---

## 5. What this changes vs. the existing PRDs

This ownership-split doc **doesn't add new functionality.** It does three things:

1. **Locks down who delivers what.** The master PRD ([`TRAVEL_CRM_PRD.md`](TRAVEL_CRM_PRD.md)) describes the WHAT but doesn't draw the line. This doc draws it.
2. **Surfaces the website-to-CRM handoff contract** (OS-1) as the single biggest cross-team coupling. Without that contract settled, every webhook integration is a guess.
3. **Resolves the 3 commercial contradictions** (OS-2, OS-3, OS-4) before they show up as scope drift mid-build.

The deliverable list under §1.2 (TMC GlobusSoft) + §2.2 (RFU GlobusSoft) + §3 (shared base) is the **scope baseline for the Phase 1 sprint plan** in [`TRAVEL_CRM_PRD.md §10.1`](TRAVEL_CRM_PRD.md). Every row maps to an existing repo path or to a tracked GAP-AUTONOMOUS/GAP-STUB-ABLE/cred-blocked item in [`TRAVEL_CRM_GAP_AUDIT_2026-05-22.md`](TRAVEL_CRM_GAP_AUDIT_2026-05-22.md).

---

End of ownership-split.
