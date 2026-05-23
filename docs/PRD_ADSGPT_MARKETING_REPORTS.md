# AdsGPT Marketing-Reports Integration — Product Requirements

**Status:** SPEC — wiring is cred-blocked on **Q1** ("AdsGPT handover packet")
per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) Section 13.
The decision tree is partially made — the *customer-facing* AdsGPT SSO surface
already ships in production (`frontend/src/utils/adsgpt.js` + the dashboard
card at commit `22fe62c`); what remains is the *server-to-server* ingest +
export plumbing that lets AdsGPT and the CRM exchange spend + conversion data.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §7 (Marketing) +
the cross-cutting Reports + Dashboards section.

**Audience:** Yasin (delivery owner of the AdsGPT handover artifacts),
AdsGPT engineering, Travel Stall ops, GS engineering.

---

## 1. Background

AdsGPT is a sister Globussoft product that aggregates paid-marketing data
across **Meta / Google / LinkedIn / YouTube** into one operator-facing
dashboard with AI-generated insights ("Meta CTR dropped 30% on the Goa Q1
campaign — likely caused by …"). The CRM's job in this loop is bidirectional:

- **Outbound (CRM → AdsGPT):** when a lead lands on the CRM via a UTM-tagged
  click, the CRM logs a `Touchpoint` row tying that contact to a UTM set;
  AdsGPT polls the CRM for "conversions by utm_source / utm_campaign" and
  computes per-platform ROAS / CPL / conversion-rate.
- **Inbound (AdsGPT → CRM):** AdsGPT pushes "ad spend by campaign by day" to
  the CRM so the CRM's marketing reports can show spend ALONGSIDE attributed
  revenue without a context switch for the operator.

Three rows in the portal matrix together describe this surface:

| Row | Item | Status |
|---|---|---|
| **O14** | Marketing campaign tracking + AdsGPT integration | ⏸️ BLOCKED (Q1) — no AdsGPT route in travel namespace |
| **O15** | Meta / Google / LinkedIn / YouTube ad-platform API integrations | ⏸️ BLOCKED (Q1) — no surface yet (handled by AdsGPT upstream) |
| **O16** | Platform-wise marketing performance reports | ⏸️ BLOCKED (Q1) — schema ready; consumer pending creds |

Cluster **C7** in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md)
estimates **~2-3 days post-handover** for `services/adsGptClient.js` +
attribution wiring + marketing-report endpoints.

### 1.1 Source attribution + how the architecture arrived here

The AdsGPT requirement comes from **Yasin's 2026-05-13 clarifications email**
(`travel-crm/Understanding and clarifications - Yasin.pdf`, 2026-05-13 16:48
IST). Section 13 of that email — "Inputs we need from you" — names
*"AdsGPT template"* among the artifacts Yasin owes for Phase 1 launch.
Surrounding context is set by:

- `travel-crm/TRAFFIC ECOSYSTEM.pdf` — the paid-marketing channel mix Travel
  Stall plans to run (organic + Meta + Google + influencer + LinkedIn for
  TMC's B2B school-trip side + YouTube long-form for RFU pilgrim education).
- `travel-crm/TMC_Digital_Marketing_Phase_1_and_2_Plan_2026.pdf` — the per-
  platform spend plan + creative cadence for TMC; AdsGPT is named as the
  reporting layer that consolidates all four ad-platform APIs into one view.

**Architectural decision (2026-05-04, commit `22fe62c`):** before any
server-side ingest existed, GS shipped a **customer-facing SSO impersonation
flow** so operators could one-click into AdsGPT from the CRM's left nav +
Owner Dashboard. That code path uses `socket.adsgpt.io` for token exchange
+ `dashboard.adsgpt.io` for the dashboard surface (see
`frontend/src/utils/adsgpt.js`). The SSO bridge is real, in production, and
unrelated to the cred-blocked S2S ingest this PRD covers.

Then on 2026-05-19 issue **#831** landed the *integration row* model — the
CRM's `/api/integrations` endpoint now persists an `adsgpt` provider row per
tenant with `isActive` + `settings` JSON. The Sidebar AdsGPT card and the
Owner Dashboard AdsGPT card both read that row before opening the SSO flow.
This is the **anchor point for adding S2S creds without re-designing**:
when Q1 lands, the same `Integration` row gains the API token + tenant
account binding; AdsGPT cron polling and ingest jobs read from there.

**Source-of-truth chain:**
```
Yasin's email (2026-05-13)         ← original ask, Section 13 inputs list
  └─ portal matrix O14-O16          ← scope decomposition
       └─ cluster C7 in MANUAL_CODING_BACKLOG  ← ~2-3d post-handover
            └─ this PRD (live)      ← full spec; serves as ack to Yasin
                 ├─ frontend SSO (22fe62c)     ← ✅ SHIPPED
                 ├─ Integration row (#831)     ← ✅ SHIPPED
                 └─ services/adsGptClient.js   ← 🔴 NOT-STARTED (Q1)
```

§5 below answers the four decisions Yasin will need to make once the
handover packet ships so the cred drop unblocks all three rows cleanly.

---

## 2. Use cases — what depends on AdsGPT S2S wiring

### 2.1 Customer-side conversion attribution (CRM → AdsGPT)

The CRM's `Touchpoint` model already captures UTM-tagged contact arrivals
(`schema.prisma:1981` — `channel` / `source` / `medium` + campaign FK).
Today the data sits unused by AdsGPT because there's no poll surface.

| Surface | Today | After Q1 ships |
|---|---|---|
| UTM-tagged lead lands on Travel Stall microsite | `Touchpoint` row written; data dead-ends | Same row, plus AdsGPT polls `/api/v1/external/adsgpt/conversions` and aggregates per `utmCampaign` for ROAS computation |
| Lead converts to enquiry → quote → won deal | `Deal` flips to `won`; revenue recorded | Same path, plus revenue flows back to AdsGPT via the same poll endpoint with the originating `utmCampaign` attached so AdsGPT can compute per-campaign closed-won revenue |
| AdsGPT operator opens `dashboard.adsgpt.io` | SSO works; numbers are AdsGPT-only (clicks + impressions + spend) | Same SSO, plus the dashboard shows CRM-side revenue attributed back to each campaign |

### 2.2 Spend display inside the CRM (AdsGPT → CRM)

The CRM's marketing reports today (`backend/routes/attribution.js`'s
`first-touch-revenue` + `multi-touch-revenue` endpoints) show revenue
broken down by `Touchpoint.source` — but not the SPEND that drove it.
Without spend, operators cannot read ROAS from inside the CRM.

| Surface | Today | After Q1 ships |
|---|---|---|
| Operator opens CRM `/marketing-reports` (or extended `/reports/attribution`) | Shows revenue by source/campaign | Shows revenue + spend + ROAS side-by-side per platform per campaign |
| Owner opens Owner Dashboard | AdsGPT card shows linked-status only (`isActive`) | Card shows last-sync + current-month spend tile + 1-paragraph AI commentary |
| Operator filters by sub-brand (TMC / RFU / Travel Stall / Visa Sure) | Revenue numbers narrow | Spend numbers narrow alongside (each sub-brand has its own ad accounts in AdsGPT) |

### 2.3 AI commentary surface

AdsGPT generates 1-2 sentence AI commentary ("ROAS dropped 30% on Goa Q1 —
likely paused-bidding bug; recommend re-enabling the budget cap") that today
lives only in AdsGPT. With S2S in place the same commentary surfaces under
each platform row in the CRM's marketing report — via the same `bulk-text`
task in `backend/lib/llmRouter.js` (commit `583c06b`), the CRM does not
need a second LLM consumer relationship.

### 2.4 Per-sub-brand reporting

TMC (school trips, B2B), RFU (Umrah, B2C), Travel Stall (family holidays),
and Visa Sure have very different funnel mechanics — TMC's lead-to-close
takes 4-6 weeks; RFU's takes 2-3 weeks; Travel Stall's is <1 week. Mixing
their spend in a single ROAS column is a category error. The report MUST
filter by sub-brand and store per-sub-brand budgets / targets as
`TenantSetting` rows so the dashboard can show variance against plan.

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | NEW `backend/services/adsGptClient.js` (bidirectional client) — `ingestDailySpend({ tenantId, date })`, `exportConversions({ tenantId, since })`, `fetchInsights({ tenantId, campaignId })`. STUB mode per the `digilockerClient.js` + `googleDriveClient.js` patterns: synthetic deterministic returns when `process.env.ADSGPT_API_KEY` absent, real API calls when set. | 🔴 NOT-STARTED |
| FR-2 | **Schema (additive, no bless marker)** — extend `Touchpoint` with `adsGptCampaignId String?` + `adsGptCreativeId String?`. Both nullable; existing `source` / `medium` / `campaignId` columns stay. | 🔴 NOT-STARTED |
| FR-3 | **NEW model `AdSpendDaily`** — per-tenant per-platform per-campaign per-day cache. Columns: `tenantId`, `platform` (enum: META / GOOGLE / LINKEDIN / YOUTUBE), `campaignId`, `creativeId?`, `subBrand?`, `date`, `spendCents`, `currency`, `impressions`, `clicks`, `cpcCents?`, `cpmCents?`, `rawJson String? @db.Text` (raw payload from AdsGPT for replay/debug). Unique index on `(tenantId, platform, campaignId, creativeId, date)` for idempotent ingest. | 🔴 NOT-STARTED |
| FR-4 | **NEW cron `backend/cron/adsGptIngestEngine.js`** — daily at 02:00 IST per tenant (loops over Tenant rows where `Integration{provider=adsgpt, isActive=true}`). Calls `adsGptClient.ingestDailySpend()` for yesterday's date per platform. Upserts into `AdSpendDaily`. Logs to `LlmCallLog`-style `IntegrationCallLog` for cost visibility. | 🔴 NOT-STARTED |
| FR-5 | **NEW conversion-export endpoint** `POST /api/v1/external/adsgpt/conversions` — extends `backend/routes/external.js` partner-API pattern. AdsGPT polls this hourly; response shape: `{ conversions: [{ utmSource, utmCampaign, utmMedium, subBrand, contactHash, dealStage, dealValueCents?, firstTouchAt, convertedAt? }, ...], nextSince }`. Privacy: `contactHash` is SHA-256(`tenantId + contactId`), not the contact's email/phone. | 🔴 NOT-STARTED |
| FR-6 | **NEW report endpoint** `GET /api/reports/marketing-platform-summary?from=&to=&subBrand=&platform=` — joins `AdSpendDaily` ⋈ `Touchpoint` ⋈ `Deal` to produce per-platform per-campaign rows: spend / clicks / leads / qualifiedLeads / bookings / revenue / ROAS / CPL. Per-sub-brand filterable. | 🔴 NOT-STARTED |
| FR-7 | **Per-sub-brand budgets** — store per-sub-brand monthly ad budget as `TenantSetting{ key: 'adsgpt.budget.tmc' }` etc. Report tile shows variance: "TMC spent ₹4.2L of ₹5L (84%, on plan)". Budget edit UI in `frontend/src/pages/travel/MarketingBudgets.jsx` (new). | 🔴 NOT-STARTED |
| FR-8 | **AdsGPT insights via LLM router** — AI commentary fetched via `llmRouter.runTask({ task: 'bulk-text', prompt: '<campaign metrics + spend curve> → 1-paragraph insight' })`. 4th consumer alongside talking-points, form-vs-call, itinerary-draft, travelstall-PDF. Cached per `(tenantId, platform, campaignId, isoWeek)` in `AgentRecommendation`-style table. | 🔴 NOT-STARTED |
| FR-9 | **Integration row status extension** — the `Integration{ provider: 'adsgpt' }` row gains `lastSyncAt`, `lastSyncStatus` (success / partial / failed), `lastSyncErrorMessage`. Sidebar + Owner Dashboard AdsGPT cards read these and show a sync-health pill. | 🔴 NOT-STARTED |
| FR-10 | **Cost + audit** — every cred-bearing call to AdsGPT writes an `IntegrationCallLog` row (`provider=adsgpt`, latency, status, cost-estimate). Per-tenant monthly cap configurable via `TenantSetting{ key: 'adsgpt.monthly_cap_usd' }`; default `$50` per the cred-blocked policy decision. When cap hit, ingest cron pauses + emits ops alert via `eventBus.emit('integration.cap_exceeded')`. | 🔴 NOT-STARTED |

**Frontend SSO (`utils/adsgpt.js` + Sidebar + Owner Dashboard card)** —
✅ SHIPPED at commit `22fe62c`; unaffected by this PRD. The S2S work in
FR-1..FR-10 sits beside it, not on top.

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Ingest job latency** | Nightly sync at 02:00 IST — accept up to 2h drift for "yesterday's spend showing in today's report"; ingest completes for typical tenant (4 platforms × ~20 campaigns) in <2 minutes |
| **Conversion-export response time** | < 1 s p95 (AdsGPT polls; CRM serves from `Touchpoint` index on `(tenantId, utmCampaign, timestamp)`) |
| **Compliance** | No contact-level PII shared with AdsGPT — `contactHash` is SHA-256 of `(tenantId + contactId)`, not email/phone. Aggregates-only by default for V1 (per DC-3). DPDP + GDPR retention applies via the existing `retentionEngine.js`. |
| **Cost** | Nightly ingest: ~4 calls per tenant per day (one per platform). Estimate $0.001 per call → ~$0.12/tenant/month for ingest. Conversion-export: read-only from CRM side, zero cost. LLM commentary: counted in `bulk-text` task, cached weekly per campaign — ~5 calls/week/sub-brand. |
| **Reliability** | AdsGPT 5xx during nightly ingest → 3 retries with 1/2/4 s exponential backoff. Persistent failure → ops alert via existing `notifications.js` channel + `IntegrationCallLog` records the failure. Next-day ingest re-tries the missed window. |
| **Cap visibility** | Per-tenant monthly cap surfaced in `/admin/llm-spend`-style dashboard (extended for non-LLM provider rows). Operator sees current-month spend, projected EOM, cap, headroom. |

---

## 5. Hand-over requirements / decisions needed

This is the section that unblocks the four open decisions Yasin owes
alongside the Q1 handover packet.

### 5.1 The artifacts (the goal — regardless of delivery path)

For each tenant + sub-brand combination Travel Stall wants reported:

| Artifact | What it is | Where it lands in the codebase |
|---|---|---|
| **AdsGPT API key** | Per-tenant token AdsGPT issues for S2S polling. Scoped to the tenant's `wabaId`-equivalent in AdsGPT (the `aMember` user that ran the SSO; see `utils/adsgpt.js:17`). | `Integration{ provider: 'adsgpt' }.apiKey` (encrypted via existing `fieldEncryption.js`) |
| **AdsGPT account ID** | Identifier AdsGPT uses to scope spend data to the tenant's ad accounts. One per sub-brand or one shared (per DC-5). | `Integration.settings.accountId` (JSON; multi-value for multi-sub-brand) |
| **Per-platform ad-account IDs** | Meta Ad Account ID + Google Ads Customer ID + LinkedIn Org ID + YouTube Channel ID — already known to AdsGPT, surfaced via AdsGPT's API. CRM does not call platform APIs directly; AdsGPT does. | `Integration.settings.platformAccounts` (JSON) |
| **AdsGPT webhook signing key (optional)** | If AdsGPT wants to push insight updates rather than be polled. V1 is poll-only; webhook is V2. | `Integration.settings.webhookSigningKey` |
| **AI-insight prompt templates** | The starter set of templates AdsGPT recommends for the `bulk-text` LLM task ("Given [metric A] dropped [N]% week-over-week, [explain why] in 1 paragraph"). | Bundled into `backend/lib/prompts/adsgpt/*.txt` |

That's the complete delivery. No platform-API keys (Meta App Secret, Google
Ads developer token, etc.) ever touch the CRM — those live in AdsGPT.

### 5.2 Decisions needed (DC-1 ... DC-6)

This is what Yasin needs to sign off on alongside the cred drop:

| # | Decision | Default / GS recommendation |
|---|---|---|
| **DC-1** | **Ingest cadence** — nightly is cheaper but less timely ("yesterday's spend visible by 03:00 IST"). 4-hourly is more timely but ~6× the API calls. Per-tenant configurable? | **Recommend: nightly default; configurable per tenant via `TenantSetting`.** Phase 1 tenants almost always want overnight numbers (no operator stares at the dashboard at noon); switch to 4-hourly only if a tenant proves the value. |
| **DC-2** | **Per-tenant monthly budget cap** — what's the default cap, and what happens when it's hit? Hard stop (ingest pauses) or soft warn (ingest continues, ops notified)? | **Recommend: $50/month default cap, hard stop with ops alert.** $50 covers ~50,000 ingest calls at $0.001 each; 4-hourly ingest for 4 platforms × 30 days = ~1,440 calls — well under cap. Hard stop avoids runaway billing if an upstream bug loops the cron. |
| **DC-3** | **PII boundary** — what data shape goes to AdsGPT in the conversion export? Aggregates-only (counts + revenue, no per-contact identifiers)? Or hashed contact IDs for cross-platform dedup? | **Recommend: aggregates-only for V1 (privacy-safe), hashed IDs as V2 if AdsGPT proves cross-platform dedup value.** Aggregates-only avoids DPDP §11 consent ambiguity; hashed-IDs would need an explicit opt-in checkbox on the consent form. |
| **DC-4** | **Per-sub-brand budget tracking** — separate monthly budgets per sub-brand (TMC / RFU / Travel Stall / Visa Sure) OR one shared budget across all four? | **Recommend: separate budgets per sub-brand.** Each sub-brand owner manages their own spend — TMC's headmaster-acquisition campaigns have a different ROAS target than RFU's pilgrim-acquisition campaigns. Storing them separately also lets the variance tile in §3 FR-7 show per-brand-on-plan vs over-budget. |
| **DC-5** | **AdsGPT account model** — one shared GS-owned AdsGPT account that hosts all tenants' data (multi-tenant inside AdsGPT) OR a per-tenant AdsGPT account each tenant pays for? | **Recommend: GS-owned account for Phase 1 (Travel Stall is the launch tenant; GS hosts the AdsGPT account on its `sumitgh2050` aMember login, see `utils/adsgpt.js:17`).** Per-tenant accounts become viable in Phase 2 when GS productizes the CRM+AdsGPT bundle for >5 customers. |
| **DC-6** | **Report ownership** — does AdsGPT's AI commentary count as customer-facing content (needs review before display) or operator-only (no review)? | **Recommend: operator-only for V1.** AI commentary is for the ops team to act on, not for the customer (parent / pilgrim / B2C lead) to see. If a future surface (owner-facing weekly digest email) wants the commentary, that's a separate product call. |

Once these six decisions are made, GS has everything needed to ship the
~2-3 day implementation per cluster C7.

### 5.3 Two delivery paths — Travel Stall picks one

**Path A — Yasin generates the AdsGPT API key himself.** AdsGPT exposes a
"Generate API token" surface for `aMember` users (analogous to Meta's System
User flow in `WHATSAPP_INTEGRATION_PRD.md` §5.2 Path A). Yasin logs into
`dashboard.adsgpt.io` as `sumitgh2050` (the existing demo aMember), generates
a non-expiring API key scoped to the Travel Stall workspace + the per-
platform ad-account IDs, and delivers the bundle to GS via 1Password.

**Path B — Travel Stall delegates to GS.** Same as Path A in
`WHATSAPP_INTEGRATION_PRD.md`: Yasin adds a GS email (`sumit@chingari.io`
or `gs-integrations@globussoft.com`) to the AdsGPT workspace; GS performs
the key generation in Yasin's workspace and emails the bundle back.

GS pastes the bundle into `backend/.env` + seeds the `Integration{
provider: 'adsgpt', isActive: true, settings: {...} }` row. **~30 min of
GS work after delivery.** All FR-1..FR-10 lights up.

---

## 6. Acceptance criteria

The integration is "done" when **all six of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| **AC-1** | Nightly ingest job runs at 02:00 IST; AdsGPT spend data for the previous day appears in `AdSpendDaily` by 03:00 IST. Tested via `e2e/tests/adsgpt-ingest-engine-api.spec.js` invoking the manual-trigger admin endpoint. | FR-4 + FR-5 ingest end-to-end. |
| **AC-2** | `GET /api/reports/marketing-platform-summary?from=&to=` returns per-platform breakdown showing Meta + Google + LinkedIn + YouTube with current month's spend / clicks / leads / revenue / ROAS. | FR-6 report endpoint. |
| **AC-3** | Filtering by `subBrand=TMC` narrows numbers to TMC's ad accounts only; sum of per-sub-brand totals equals all-sub-brand total. | FR-7 per-sub-brand filter. |
| **AC-4** | AdsGPT (or a Playwright mock acting as AdsGPT) polls `/api/v1/external/adsgpt/conversions?since=` and receives sub-brand-tagged conversion events from the last 30 days. Response excludes raw contact identifiers (only `contactHash`). | FR-5 conversion-export + DC-3 PII boundary. |
| **AC-5** | AI commentary paragraph appears under each platform row in the marketing report; "Why this happened" CTAs link out to the corresponding AdsGPT detail view via the existing SSO flow. | FR-8 LLM commentary + frontend SSO interop. |
| **AC-6** | AdsGPT 5xx on first ingest call → 3 retries with 1/2/4 s backoff → success on 2nd attempt → ingest completes. Persistent failure (3 retries exhausted) → ops alert fires + `IntegrationCallLog` shows 4 rows (1 success record + 3 fail records). | NFR reliability + FR-10 audit. |

GS owns the e2e validation; Travel Stall owns acknowledging acceptance.

---

## 7. Out of scope

- **Direct ad-account management from CRM** — Meta Business Manager / Google
  Ads UI / LinkedIn Campaign Manager flows live in AdsGPT. The CRM does NOT
  call platform APIs directly; it only consumes AdsGPT's aggregated view.
- **Creative asset library sync** — Phase 2 polish; if needed, AdsGPT
  already hosts creative previews accessible via SSO.
- **Per-creative A/B test orchestration** — Phase 3; needs CRO
  infrastructure (multi-variant landing page rendering at the Travel Stall
  microsite layer + statistical-significance compute).
- **Multi-currency spend** — V1 assumes tenant's `defaultCurrency`. If a
  tenant runs USD ads against an INR P&L, spot-rate conversion lives in
  AdsGPT, not the CRM.
- **Per-region budget allocation** — multi-region tenants (e.g. TMC running
  separate Mumbai + Delhi campaigns) defer to Phase 2+.
- **Webhook push** from AdsGPT → CRM — V1 is poll-based (cron pulls);
  webhook push is V2 once volume justifies it (typically when a tenant has
  >100 campaigns active and nightly batch is too slow).
- **Replacing the existing `Campaign` model** — the existing CRM `Campaign`
  model stays as the OPERATOR-curated record (the operator names the
  campaign + assigns lead-routing rules to it). AdsGPT data sits BESIDE it
  as the AD-PLATFORM mirror, joined by `utmCampaign` string match.

---

## 8. Dependencies + downstream

- **Q11 (LLM defaults)** — when LLM creds arrive, the FR-8 commentary
  surface starts generating real insights (today, `bulk-text` is in
  `llmRouter.js` stub mode). Q11 + Q1 must both ship to fully light up the
  commentary surface, but the spend-display surface (FR-6) lights up
  independently on just Q1.
- **Existing infra leveraged:**
  - `backend/routes/attribution.js` — extends; current `first-touch-revenue`
    + `multi-touch-revenue` endpoints stay; new `marketing-platform-summary`
    adds spend join.
  - `backend/routes/external.js` partner-API pattern — extends with
    `/v1/external/adsgpt/conversions`.
  - `backend/lib/llmRouter.js` — extends with `bulk-text` consumer #4.
  - `frontend/src/pages/Reports.jsx` (or new `/marketing` page if the
    structure proves cleaner during implementation; default: extend
    Reports.jsx with a "Marketing platform" tab alongside the existing
    Sales / Pipeline / etc tabs).
- **Schema:** additive `Touchpoint.adsGptCampaignId` + `adsGptCreativeId`
  + new `AdSpendDaily` model + new `IntegrationCallLog` model. All additive
  nullable; no Prisma bless marker needed (no UNIQUE / NOT NULL / column-drop
  / type-narrow per `.github/workflows/deploy.yml` migration-check rules).
- **Downstream:** `frontend/src/components/Sidebar.jsx` AdsGPT card
  (commit `22fe62c`) + Owner Dashboard AdsGPT card (`OwnerDashboard.jsx`,
  #831) gain live sync-health + spend tile. The 9 vitest cases at
  `frontend/src/__tests__/adsgpt.test.js` stay green (SSO surface is
  unaffected); new tests cover the Integration row extensions.
- **LLM router consumer:** `bulk-text` task gains 4th non-stub consumer
  once Q11 lands (alongside talking-points / form-vs-call / itinerary-draft
  / travelstall-PDF).
- **DPDP / GDPR retention:** AdSpendDaily data is aggregate-only (no PII);
  retention per ad-platform contract (~24 months typical). Wire into
  existing `retentionEngine.js` with a new policy row.

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| **OQ-1** | Q1 handover ETA + initial AI-insight LLM prompt templates from Yasin | Yasin |
| **OQ-2** | DC-1 / DC-2 / DC-3 / DC-4 / DC-5 / DC-6 sign-off (defaults proposed in §5.2) | Yasin + GS product |
| **OQ-3** | What tier of AdsGPT insights — basic spend reporting only, or AI-driven recommendations as well? (V1 default: both, gated by Q11 LLM creds for the AI portion) | Yasin |
| **OQ-4** | Alerting — when AdsGPT detects a "ROAS dropped 50%" signal, surface in CRM operator notifications, only on the AdsGPT side, or both? | GS product |
| **OQ-5** | Customer-facing depth — does the Owner Dashboard spend tile only show summary numbers, or do per-campaign drill-ins live in the CRM too? (V1 default: summary in CRM, drill-in via SSO to AdsGPT) | Yasin + GS product |
| **OQ-6** | Existing `Campaign` model coexistence — confirmed COMPLEMENT (not REPLACE) per §7; verify with Yasin that this matches AdsGPT's data model expectations | Yasin |
| **OQ-7** | Operator CSV export — can operators download "spend by campaign by day" as CSV from the marketing report? (Recommend: yes, V1, via the existing `csv_io.js` pattern) | GS product |
| **OQ-8** | Webhook push from AdsGPT → CRM — when does it become worth implementing? (Threshold proposed: >100 active campaigns per tenant OR nightly batch >5 min) | GS engineering |

---

## 10. Status snapshot

### 2026-05-24 update #2 — Operator routes + admin UI

**Backend wrapper routes shipped:** `backend/routes/adsgpt.js` at commit `0d66a74` (~154 LOC, 5/5 vitest pass). Routes:
- `GET /reports/ads` — fetch per-platform performance report (delegates to client; surfaces `ADSGPT_BUDGET_EXCEEDED` as 402)
- `GET /cap-status` — ADMIN-only cap check returning `{spentCents, capCents, percent, withinCap, alertThreshold}`

**Admin UI shipping THIS TICK (in-flight by sibling agent):** `frontend/src/pages/admin/AdsGPTReports.jsx` — operator reporting surface with date-range filter + platform selector + cap-status pill + stub-mode banner ("real metrics populate when Q1 creds land").

**Sub-brand isolation:** `?subBrand=` query param force-overridden by `req.apiKeySubBrand` when set (external API keys can't fetch reports for other sub-brands; 403 SUB_BRAND_MISMATCH).

**Architectural finding (post-ship):** the wrapper pattern (route handles auth + isolation + audit + cap surfacing; service does provider call) was promoted to a reusable template. Sibling routes scheduled: `/api/ratehawk` (THIS TICK by sibling), `/api/callified` (next tick), `/api/booking-expedia` (after).

**CJS-mock pitfall captured:** vitest agent had to use `requireCJS('../../services/adsGptClient')` for both mock-target AND router so they share the require-cache object. Documented inline in the test header for sibling wrapper authors.

**Still pending:**
- Real-mode swap (cred-blocked on Q1 Yasin handover)
- DC-3 (per-platform attribution model — not yet specified beyond the canned platforms)
- DC-4 (sub-brand budget split — per-sub-brand caps under the tenant cap; PRD-internal future slice)

**Path to real-mode:** When Yasin's handover lands, swap the stub body of `fetchAdReport` in `services/adsGptClient.js` with the real REST call. The wrapper routes / cap / sub-brand isolation / admin UI stay unchanged — only the service-internal body changes. ~1 day post-cred per the precedent.

### 2026-05-24 update — STUB client shipped + cap wired

**Backend STUB shipped:** `backend/services/adsGptClient.js` at commit `9f35040`. Mirrors the
canonical STUB pattern (header marker + `// STUB:` warning + canned response shape +
console.log observability + CJS self-mocking seam per the 4-instance pattern logged
to CLAUDE.md cron-learnings tick #99). 6/6 vitest cases pass.

**Per-tenant cap wired:** Calls `getBudgetCap(tenantId, 'adsgpt')` via the
cross-cutting TenantSetting pattern (helper at `backend/lib/tenantSettings.js`,
operator-writable surface at `/api/tenant-settings` per commit `1542b8e`).
Hard-stops at cap with `ADSGPT_BUDGET_EXCEEDED`. 80% threshold alert via console.warn.
Admin UI for cap overrides shipping this tick by a sibling agent.

**Decisions implemented:** DC-2 ($50/mo default per-tenant cap, operator-overridable).

**Cred chase status:** docs/CREDS_TRACKER.md Cat 1 Q1 row, cluster C7 (Yasin AdsGPT
handover packet). Stub is the swap-point; ~1 day to real-mode swap when creds drop
(mirror the digilockerClient/googleDriveClient post-cred swap pattern documented at
1babe1b/192de86).

**What's now possible:**
- Caller code can invoke `adsGptClient.fetchAdReport()` and get a structured
  stub response (no longer throws "integration not configured")
- Operator can set per-tenant cap override via /api/tenant-settings (admin UI in flight)
- Tests can spy on `module.exports.fetchAdReport` per the CJS self-mocking seam

**Still pending:**
- Real-mode swap (cred-blocked on Q1 Yasin handover — AdsGPT API key + S2S endpoint URL)
- Daily ingest cron `backend/cron/adsGptIngestEngine.js` (consumes the client; ~½ day)
- `POST /api/v1/external/adsgpt/conversions` conversion-export endpoint (~½ day)
- Per-platform marketing dashboard endpoint + Reports.jsx tab (~1 day)
- AdsGPT insights LLM consumer FR-8 (~½ day, gated by Q11 LLM-spend cap decision)
- Schema additions: `AdSpendDaily`, `IntegrationCallLog`, `Touchpoint` columns

**Path to real-mode:** When creds drop, swap the stub-mode canned response body
in `fetchAdReport()` with the real AdsGPT S2S `fetch()` call. Cap / observability /
feature-flag scaffold stays unchanged. ~1 day post-cred per the 3-similar-stubs pattern
that's now established (adsgpt + ratehawk + callified all built on the same skeleton
in successive ticks; bookingExpedia in-flight this tick is the 4th).

---

| Component | State |
|---|---|
| Frontend AdsGPT SSO surface (`utils/adsgpt.js` + Sidebar card + Owner Dashboard card) | ✅ **SHIPPED** (commit `22fe62c`) |
| `Integration{ provider: 'adsgpt' }` row + linked-status read flow | ✅ **SHIPPED** (issue #831) |
| Existing infra leveraged (Touchpoint + attribution routes + Reports.jsx) | ✅ **SHIPPED** |
| `backend/services/adsGptClient.js` (STUB-mode) | ✅ **SHIPPED** (commit `9f35040`, 6/6 vitest, cap-wired) |
| `backend/services/adsGptClient.js` (REAL-mode swap) | 🔴 **NOT-STARTED** — cred-blocked on Q1 |
| Daily ingest cron `backend/cron/adsGptIngestEngine.js` | 🔴 **NOT-STARTED** |
| Conversion-export endpoint `POST /api/v1/external/adsgpt/conversions` | 🔴 **NOT-STARTED** |
| Per-platform marketing dashboard endpoint + frontend tab | 🔴 **NOT-STARTED** (~1 day) |
| AdsGPT insights LLM consumer (FR-8) | 🔴 **NOT-STARTED** (~½ day, gated by Q11) |
| Schema additions (`AdSpendDaily`, `IntegrationCallLog`, `Touchpoint` columns) | 🔴 **NOT-STARTED** (additive, no bless marker) |
| Q1 AdsGPT handover packet | ⏸️ **BLOCKED on Yasin** |
| **Engineering time after handover + decisions:** | **~2-3 days** per cluster C7 |

---

**Ownership chain:**

- **Travel Stall (Yasin)** owes the §5 bundle + DC-1..DC-6 sign-off —
  outstanding per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md)
  Q1.
- **GS engineering** owes the ~2-3 days of implementation per cluster C7
  in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md) once §5 lands.
- **AdsGPT engineering** owes the polling client on their side once the
  CRM's `/api/v1/external/adsgpt/conversions` endpoint ships + a contract
  doc for the prompt-template formats they recommend for the FR-8
  commentary surface.
