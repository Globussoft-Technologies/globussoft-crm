# Flight Quotation Chrome Extension — Product Requirements

**Status:** SPEC — not yet started. Lives in a **SEPARATE repo** (not
`globussoft-crm`); the repo doesn't exist yet pending DC-1 below. Six
hand-over decisions block kickoff (§5). Backend half (~½ day endpoint +
per-advisor API key issuance UI) can ship CRM-side independently once
DC-1 lands.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §6
(Integrations) + portal matrix row O22 in
[TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md);
backlog row B4 in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md).

**Audience:** Yasin (decision owner of DC-1 / DC-2 / DC-3), GS engineering
(implementation), Travel Stall advisors (end-users).

**Engineer-days estimate:** ~10-15 days for MVP (3 airlines + endpoint + key
issuance UI + Chrome Web Store submission). Per-airline adapter ~2-3 days
each; +12-18 days to reach the full 6-airline target.

---

## 1. Background

Flight quotation is the **single highest-friction step** in the Travel
Stall sales workflow. Across the 4 sub-brands the per-month flight-quote
load is approximately:

| Sub-brand | Quote velocity | Pattern |
|---|---|---|
| **TMC** | 50-100 flights / month | School-trip group bookings; rare individual fares; multi-leg common for long-haul school tours |
| **RFU** | 30-60 flights / month | Pilgrim group flights into JED / MED; preferred carriers Saudia, Emirates, Air India Express |
| **Travel Stall** | 100-200 flights / month | Family-holiday round-trip; widest airline coverage; price-sensitive — advisors compare ≥3 carriers per quote |
| **Visa Sure** | 20-40 flights / month | Visa-applicant flights; rare; mostly outbound from BLR/BOM |

Today every quote is **manually scraped**: advisor opens the airline (or
aggregator) site, finds a fare, copy-pastes the price + class + route into
the CRM itinerary item, then re-types the markup. Roughly **3-5 minutes
per quote** of pure typing — across ~250 quotes / month that's ~15-20
advisor-hours of mechanical work that doesn't differentiate the brand.

### 1.1 Source attribution

The Chrome plugin originates from **one line in Yasin's clarifications
email** (`travel-crm/Understanding and clarifications - Yasin.pdf`,
2026-05-13 16:48 IST → chandrikapaul@globussoft.in /
souravpatra@globussoft.in / sumit@globussoft.com). Under "Additional
clarifications we need from you," Yasin wrote:

> **Flight Chrome plugin:** how updates are pushed to agents post-install.

That single line carries 3 implicit assumptions: (a) the plugin exists or
is planned; (b) it's distributed to "agents" (= advisors); (c) post-
install updates are non-trivial enough to warrant a written answer. §3
FR-7 below is the formal reply.

The plugin appears in the operator-CRM feature matrix at row **O22** (P1
W3, currently **🏗️ MULTI-DAY** with `Glob flight-plugin/**` returning
zero — no code surface yet) and in the manual-coding backlog at cluster
**B4** (~10-15 engineer-days; Manifest V3 + per-airline DOM adapters;
*"lives in a SEPARATE repo (not `globussoft-crm`)"*).

This document is the formal pre-implementation spec — what needs to be
true before an engineer starts on day 1.

**Source-of-truth chain:**
```
Yasin's email (2026-05-13)             ← 1-line ask
  └─ Portal matrix O22 (W3, P1)         ← surface-area + state classification
       └─ Manual-coding backlog B4       ← 10-15d estimate + separate-repo decision
            └─ this PRD (live)            ← formal spec; 6 decisions blocking kickoff
                 └─ flight-plugin repo    ← to be created post-DC-1
                      └─ CRM backend endpoint POST /api/v1/flight-plugin/quotes (+ key UI)
```

---

## 2. Use cases

All 4 sub-brands consume this plugin. Operator persona is the **advisor**
sitting in the GS operator CRM at `/travel`, doing per-lead quote work.

### 2.1 Primary — single-leg quote

1. Advisor opens IndiGo / Air India / Vistara / SpiceJet / Emirates /
   Qatar Airways search page in a regular Chrome tab.
2. Selects a fare in the airline's results UI.
3. Clicks the plugin's **"Add to itinerary"** button (injected via content
   script).
4. Modal asks **"Which lead / itinerary?"** — plugin fetches list of
   advisor's active itineraries from CRM (via API key auth).
5. Advisor confirms → plugin POSTs to CRM → itinerary item appears with
   per-tenant markup applied + the fare URL stored for audit.

### 2.2 Multi-flight — round-trip + multi-leg

For round-trip or multi-segment itineraries the plugin captures **all
legs in one click** — the content script reads the airline's outbound +
return panes (or multi-city slot 1 / slot 2 / slot N) and POSTs them
together. Avoids the "advisor captured outbound then forgot return"
failure mode.

### 2.3 Markup engine on save

Plugin **does not compute markup client-side**. POST body sends the raw
fare; backend's existing `travelPricing.js` engine applies per-tenant +
per-sub-brand markup rules + GST + season multipliers and returns the
final `totalWithMarkup`. Single source of truth for pricing math.

### 2.4 Lead binding

When the modal opens, the plugin GETs `/api/v1/flight-plugin/itineraries`
(scoped to the advisor's tenant + `assignedToId = req.user.userId`) and
shows the advisor's 20 most-recent open itineraries. Filter-by-text for
when the advisor has more than 20 in flight.

### 2.5 Operator-side fallback (DOM extraction failure)

When the airline's DOM has shifted and the per-airline adapter can't
extract a fare (selector misses, captcha hit, A/B-test variant page), the
plugin shows a **fallback manual-entry form** with the page URL pre-
filled. Advisor can still capture the quote by hand-typing the 4 critical
fields (airline / fare-class / price / route) — the audit URL + the
extraction-failed flag get recorded so engineering sees the breakage.

### 2.6 Audit screenshot capture

At quote time the plugin captures the airline page as a screenshot (via
`chrome.tabs.captureVisibleTab`) and uploads it to CRM as evidence. Helps
when the airline's fare changes between quote-time and actual-booking
time — the screenshot proves what the advisor saw.

### 2.7 Per-airline health dashboard

The plugin emits an error event on every extraction failure. CRM
aggregates these into `/travel/plugin-health` showing per-airline
extraction success rate over the last 24h / 7d / 30d. When IndiGo's
success rate drops <70% over 1h, ops gets alerted (channel TBD per OQ-7).

---

## 3. Functional requirements

| FR-ID | Requirement | Status |
|---|---|---|
| FR-1 | **Manifest V3 compatibility** — Chrome + Edge + Brave on the V3 manifest (V2 is deprecated). Firefox Manifest V3 still in beta as of 2026 — deferred to Phase 2. | 🔴 NOT-STARTED |
| FR-2 | **Per-airline content script** — each airline lives in its own adapter file (`adapters/indigo.js`, `adapters/airIndia.js`, etc.). One airline's DOM-change maintenance never touches another's code. | 🔴 NOT-STARTED |
| FR-3 | **Initial airline coverage** (MVP target): IndiGo (`goindigo.in`), Air India (`airindia.in`), Vistara (`airvistara.com`), SpiceJet (`spicejet.com`), Emirates (`emirates.com`), Qatar Airways (`qatarairways.com`). DC-3 below decides which 3 ship first. | 🔴 NOT-STARTED |
| FR-4 | **Authentication: per-advisor API key** — mirror the partner API pattern at [`backend/routes/external.js`](../backend/routes/external.js) + [`backend/middleware/externalAuth.js`](../backend/middleware/externalAuth.js). Stored in `chrome.storage.local` (NOT plain `localStorage`); sent as `X-API-Key` header on every plugin → CRM request. | 🔴 NOT-STARTED |
| FR-5 | **Backend endpoint: `POST /api/v1/flight-plugin/quotes`** accepts `{airline, fareClass, pricePerPax, currency, departAt, returnAt?, route: {from, to}, fareUrl, screenshotUrl?, itineraryId, advisorId}`, returns `{itineraryItemId, totalWithMarkup, currency}`. Auth: `X-API-Key`. | 🔴 NOT-STARTED |
| FR-6 | **Markup engine integration** — plugin sends raw fare; backend's `lib/travelPricing.js` applies per-tenant + per-sub-brand markup rules and persists `ItineraryItem.basePaise` + `.markupPaise` + `.totalPaise` + `.currency`. | ✅ SHIPPED (engine side); 🔴 endpoint consumer not wired |
| FR-7 | **Auto-update mechanism** — Chrome Web Store auto-update (zero infra, ~1-2 hour Google review lag per release). Self-hosted update URL ruled out (would require GS to maintain `update.xml` + serve CRX). **This is Yasin's 2026-05-13 question — formal answer.** | 🔴 NOT-STARTED (decision: Chrome Web Store) |
| FR-8 | **Screenshot capture for audit** — `chrome.tabs.captureVisibleTab` at quote-confirm time; uploaded to CRM-side blob storage (S3 or local filesystem via existing `services/storage*` helper); URL stored on `ItineraryItem.evidenceUrls[]`. | 🔴 NOT-STARTED |
| FR-9 | **Error reporting** — every extraction failure POSTs to `/api/v1/flight-plugin/extraction-errors` with `{airline, pageUrl, adapterVersion, selectorThatFailed, userAgent}`. CRM aggregates into per-airline health. | 🔴 NOT-STARTED |
| FR-10 | **Settings UI** — advisor can (a) rotate their API key from within the plugin, (b) see per-airline health (green/yellow/red), (c) toggle screenshot capture on/off (GDPR opt-out path). | 🔴 NOT-STARTED |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Latency** (extraction → CRM-confirm modal close) | < 5 s p95 — mostly network round-trip; backend processing is <500ms |
| **Reliability** | Per-airline adapter independent; one airline's DOM change cannot break another's. Adapter failure falls back to manual entry (FR-2 + §2.5). |
| **Maintenance** | Per-airline DOM changes happen ~monthly per airline; budget 1-2 engineer-hr per change per airline. Annual maintenance ~75 engineer-hr across 6 airlines. |
| **Compatibility** | Chrome ≥ 120, Edge ≥ 120, Brave ≥ 1.55. Firefox deferred to Phase 2 (FF Manifest V3 still beta). |
| **Privacy** | Extension activates ONLY on the 6 whitelisted airline domains (declared in `manifest.json` `content_scripts[].matches`). No general web scraping; no telemetry on non-airline pages. |
| **Security** | API key in `chrome.storage.local` (not `localStorage`); HTTPS-only to CRM; CSP `connect-src` whitelisted to `crm.globusdemos.com` only. |
| **Update freshness** | Chrome Web Store auto-updates within 24h of a release; emergency releases can ship to "self-hosted CRX for the 12 advisors" while Google reviews, then promote to Web Store (escape hatch for DOM-change emergencies). |

---

## 5. Hand-over requirements — decisions needed before implementation

This section enumerates the **6 decisions blocking kickoff**. Without
each one a different downstream piece is undecided.

### DC-1. Repo location

**Decision:** new repo `globussoft-flight-plugin` (separate) vs `chrome-
extension/` subdirectory inside `gbs-crm`?

**Recommendation:** **separate repo**. Different CI cadence (no need to
gate plugin commits on CRM's 6 deploy gates), different release schedule
(CRM ships ~10×/week; plugin ships ~1×/month after maintenance), different
artifact (CRX/zip vs deploy.yml), different reviewer pool (one or two
engineers per-airline adapter, not the whole CRM team). Co-located repo
would mix concerns.

**Owner:** Yasin / GS engineering lead.
**Blocks:** every other decision below.
**Cost to defer:** plugin can't be scaffolded until this lands.

### DC-2. Chrome Web Store publisher account

**Decision:** who owns the Chrome Web Store publisher account?

**Background:** Chrome Web Store requires a developer account ($5 one-
time fee + Google verification). Account-owner has publishing rights +
sees the install / uninstall analytics + receives Google's review
verdicts. Choices:

- **Globussoft-internal** (`gs-publisher@globussoft.com` style identity)
  — preferred for ownership continuity; GS handles all submissions; Yasin
  is informed, not blocked.
- **Travel Stall-owned** — Yasin's account; GS publishes via co-admin
  access; Yasin sees install metrics directly.
- **Shared/hybrid** — GS account, Yasin added as co-admin (best of both;
  one Google fee).

**Recommendation:** GS account + Yasin as co-admin (hybrid).

**Owner:** Yasin + Chandrika (joint).
**Blocks:** Chrome Web Store submission step.
**Cost to defer:** plugin can be sideloaded (Developer Mode ZIP) during
beta without this — only blocks the public-store rollout.

### DC-3. Airline coverage priority

**Decision:** which 3 airlines ship first?

**Background:** advisor traffic profile (qualitative; needs quantification
post-launch via §2.7 health dashboard):
- IndiGo + Air India + Emirates likely covers **~80% of quote volume**
  (IndiGo: domestic dominant; Air India: domestic + international; Emirates:
  RFU + Travel Stall international families).
- Vistara: 2026 merger with Air India means Vistara DOM may consolidate
  into Air India's — may be redundant by Phase 2.
- SpiceJet: lower advisor preference per ops feedback; price-sensitive
  family-holiday segment only.
- Qatar Airways: RFU + ultra-premium Travel Stall families; lower volume
  but higher per-quote value.

**Recommendation:** Phase 1 = **IndiGo + Air India + Emirates** (3-week
adapter sprint). Phase 1.5 (post-MVP) = Vistara + SpiceJet + Qatar. Re-
prioritize after the §2.7 health dashboard surfaces real volume.

**Owner:** Yasin (operator-volume signal) + GS PM.
**Blocks:** which adapter is sprint-1 vs sprint-2.
**Cost to defer:** can default to recommendation if no answer by sprint
start.

### DC-4. Auth model

**Decision:** per-advisor API key vs per-tenant API key vs OAuth?

**Status:** **already decided** — per-advisor API key, mirroring the
voyagr F1 cluster decision (locked 2026-05-23 per
[MANUAL_CODING_BACKLOG.md F1](MANUAL_CODING_BACKLOG.md#f1-crm-side-public-lead-capture-endpoint)).

**Rationale:** advisors need to be able to revoke their own keys (e.g. on
laptop loss / employment change) without GS admin involvement. Per-tenant
key would mean one advisor's compromise = full tenant compromise. OAuth
flow is too heavy for a browser extension (would need a refresh-token
strategy; no proportional benefit over a long-lived per-user key).

**Implementation:** new `ApiKey.purpose = 'flight-plugin'` filter on the
existing `ApiKey` model (`prisma/schema.prisma`); same generation +
issuance code path as voyagr API keys; tied to `User.id` not just
`Tenant.id`.

**Owner:** decided — no further input needed.
**Cost to defer:** N/A.

### DC-5. Update mechanism

**Decision:** Chrome Web Store auto-update vs self-hosted update URL?

**Recommendation:** **Chrome Web Store** (already FR-7).

**Tradeoff explicitly evaluated:**

| Option | Pros | Cons |
|---|---|---|
| **Chrome Web Store** (recommended) | Zero infra; auto-update within 24h; Google's security review catches obvious bugs | 1-2 hr Google review lag per release; emergency DOM-change fixes still wait |
| Self-hosted `update.xml` + CRX | Instant push; no Google review | GS must serve update endpoint (uptime SLA); enterprises increasingly block side-loaded extensions; bypasses Google's malware checks |

**Emergency-fix escape hatch:** during the 1-2 hr Google review window,
GS can sideload a fixed CRX to the 12 advisors via the `crm.globusdemos.com`
"emergency CRX" download page (Developer Mode required on advisor
machines — already standard for the beta period). After Google approves,
the sideloaded version is superseded by the auto-update.

**This is Yasin's 2026-05-13 question** — formal answer: Chrome Web Store
with documented escape hatch.

**Owner:** decided.

### DC-6. Demo environment config

**Decision:** how does the plugin discover dev vs prod CRM endpoint?

**Options:**
- **Config-by-build (recommended):** separate dev build + prod build,
  each baked with the right `CRM_BASE_URL`. Dev build sideloaded to GS
  engineers; prod build published to Chrome Web Store.
- Single build + runtime config screen: advisor types the CRM URL into
  settings UI. Risk: typo → plugin silently sends to wrong endpoint.
- Single build + env-sniffing: plugin tries dev URL first, falls back to
  prod. Brittle.

**Recommendation:** config-by-build with 2 distinct extension IDs (dev
extension + prod extension can coexist in the same Chrome profile;
advisors install only the prod one).

**Owner:** GS engineering.
**Blocks:** sprint 1 scaffolding (the `manifest.json` build config).

### 5.1 Vendor / partner creds — none

Unlike other PRDs in this docs/ directory (DigiLocker, RateHawk,
Callified.ai, WhatsApp), this plugin **needs no third-party API
credentials**. It's a self-hosted browser extension talking to a CRM
endpoint we own. Chrome Web Store account + $5 fee are the only external
dependency (DC-2).

---

## 6. Acceptance criteria

The plugin is "done" when **all 6 of the following are demonstrable**:

| # | Test | Verifies |
|---|---|---|
| AC-1 | Advisor installs plugin from Chrome Web Store; pastes API key from CRM Settings → Profile → API Keys → "Generate plugin key"; plugin badge turns green ("connected"). | FR-4 + DC-4 auth flow end-to-end |
| AC-2 | Advisor opens IndiGo search → results page → clicks "Add to itinerary" button injected into the IndiGo page; modal asks lead/itinerary; confirm → CRM `ItineraryItem` row appears within 5s with markup applied. | §2.1 primary use case + FR-5 + FR-6 |
| AC-3 | Same flow against Air India + Emirates (or whichever DC-3 picks); all 3 Phase-1 airlines pass. | FR-2 per-airline adapter pattern |
| AC-4 | Simulated DOM-extraction failure (e.g. IndiGo A/B variant page) → plugin shows fallback manual-entry form pre-filled with the page URL → advisor can still capture the quote → CRM records `extractionFailed=true`. | §2.5 fallback + FR-9 error reporting |
| AC-5 | GS publishes plugin v1.0.1 with a fix to the IndiGo adapter; advisor's plugin auto-updates within 24h of Chrome Web Store approval; advisor sees no manual action required. | FR-7 update mechanism (Yasin's question) |
| AC-6 | Admin opens `/travel/plugin-health` → sees per-airline extraction success rate over 24h / 7d / 30d; clicking a red bar surfaces the last 10 failures with `pageUrl` + `selectorThatFailed` for engineering triage. | §2.7 health dashboard + FR-9 error pipeline |

GS owns the e2e validation; Yasin owns acknowledging acceptance.

---

## 7. Out of scope

- **Mobile** — no mobile extension equivalent; advisors quote on desktop.
  Mobile quoting (future) would need a separate native-app surface.
- **Booking flow** — plugin only **quotes**. Booking happens via the
  airline portal manually (advisor uses the supplier-credential vault at
  `routes/travel_suppliers.js` to log in and book; the booking is then
  captured via a `WebCheckin` row separately).
- **Round-the-world / open-jaw / complex multi-city** beyond simple multi-
  leg — Phase 4. MVP handles round-trip + 2-3 segment multi-city only.
- **Hotel quotation** — separate flow via RateHawk (see Q19 cred-chase;
  cluster C4 in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md#c4-q19-ratehawk--write-client-from-scratch--rfu-integration)).
- **Visa-cost quotation** — separate flow; Phase 3 Visa Sure scope.
- **Train tickets** — separate (IRCTC for India; Saudi train Madinah↔Makkah
  for RFU per blueprint §5.1); Phase 2 if at all.
- **Airline web check-in automation** — separate cluster B5 in
  [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md#b5-airline-web-check-in-automation-p1b). Shares the per-airline adapter architecture (so
  some adapter code may end up reusable across both — DC for sprint
  start: do we share a monorepo with web-check-in plugin, or two separate
  repos?). For this PRD assume separate.
- **Captcha-solving / anti-bot bypass** — out of scope. When an airline
  serves captcha, plugin shows the fallback manual-entry form (§2.5).
- **Aggregator sites** (Skyscanner, MakeMyTrip, Cleartrip) — Phase 1 is
  airline-direct only. Aggregators have stronger anti-bot than airlines
  + higher legal-risk profile for scraping.

---

## 8. Dependencies + downstream

### 8.1 CRM-side dependencies (ship independently of plugin)

| Item | Status | Path |
|---|---|---|
| `POST /api/v1/flight-plugin/quotes` endpoint | 🔴 NOT-STARTED (~½ day) | Mirror voyagr F1 endpoint pattern at `routes/external.js`; new file `routes/flight_plugin.js` |
| `ApiKey.purpose='flight-plugin'` filter | ✅ SHIPPED (just need the enum extension on issuance) | `prisma/schema.prisma` ApiKey model |
| Per-advisor API key issuance UI | 🔴 NOT-STARTED (~½ day) | New `frontend/src/pages/admin/FlightPluginApiKeys.jsx` — mirror voyagr F1 |
| `travelPricing.js` markup engine | ✅ SHIPPED | `backend/lib/travelPricing.js` |
| `ItineraryItem` schema | ✅ SHIPPED — accepts plugin output verbatim, no schema change | `prisma/schema.prisma` ItineraryItem model |
| Plugin health dashboard | 🔴 NOT-STARTED (~1 day post-MVP) | New `/travel/plugin-health` route + frontend page |
| Screenshot storage | 🔴 NOT-STARTED (~½ day) | Reuse existing wellness `Attachment` blob storage pattern |

**Total CRM-side work:** ~2 days. **Can ship before plugin exists** —
useful for the per-advisor API key issuance UI (gives the user something
to demo while the plugin is being built).

### 8.2 Plugin-side dependencies

- Chrome Web Store developer account (DC-2)
- Per-airline DOM understanding (initial reverse-engineering of each
  airline's selectors — typically 1 engineer-day per airline for the
  first pass)
- `chrome.storage` API, `chrome.tabs.captureVisibleTab`, `chrome.runtime`
  for messaging — all standard MV3 APIs, no extra licensing.

### 8.3 Downstream consumers (CRM-side benefits)

- `ItineraryItem` rows created via plugin flow same as manual entries
  through `travelPricing.js` — no special-casing.
- The advisor's `Itinerary.status` transitions to `quoted` when the first
  plugin-captured fare lands (same trigger as a manually-entered item).
- Marketing attribution (`backend/routes/attribution.js`) sees plugin-
  sourced quotes as `firstTouchSource = "flight-plugin"` for per-source
  conversion analytics.

### 8.4 Web check-in automation (cluster B5 — shares architecture)

The web-check-in automation cluster (B5, ~5-7 days) uses the **same per-
airline adapter pattern**. Decisions made here (DC-1 separate-repo, DC-3
airline-priority) inform that cluster. Possible Phase-2 consolidation: one
shared "airline adapter library" that both surfaces depend on. For Phase
1 keep them separate to avoid coupling.

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| OQ-1 | DC-1 repo location decision — separate repo `globussoft-flight-plugin` or `chrome-extension/` subdir in `gbs-crm`? | Yasin + GS engineering lead |
| OQ-2 | DC-2 Chrome Web Store publisher account — GS / Travel Stall / hybrid co-admin? | Yasin + Chandrika |
| OQ-3 | DC-3 airline priority — confirm IndiGo + Air India + Emirates for Phase 1? | Yasin (advisor volume signal) |
| OQ-4 | How do we test extension changes without going through Chrome Web Store review for every dev iteration? **Proposed answer:** sideload via Chrome Developer Mode + zipped CRX distributed to advisors during beta (Developer Mode left enabled on the 12 advisor machines until plugin reaches Chrome Web Store stable). | GS engineering |
| OQ-5 | Per-airline DOM-change maintenance owner — single GS dev as named-owner, or shared rotation across the travel engineers? Shared rotation risks "everyone's job is no-one's job"; named-owner concentrates context. | GS engineering lead |
| OQ-6 | Does the plugin send anonymous usage data back to CRM? Helpful for measuring value (quotes / week / advisor; time-saved estimate) but privacy implications — advisor's browsing on the 6 airline domains is captured. Default: opt-in via FR-10 settings toggle; default off until DPDP review. | Yasin + DPDP-counsel |
| OQ-7 | Post-airline-DOM-change alerting — when extraction success rate drops below 70% on one airline over 1 hour, alert via what channel? Slack / email / WhatsApp via the ops-shared WABA / GH issue auto-file? Most operationally useful is auto-filing a GH issue against `globussoft-flight-plugin` repo so the per-airline owner sees it in their normal triage. | GS engineering lead |
| OQ-8 | What's the offline / no-internet behavior? Advisor opens IndiGo + clicks "Add to itinerary" with no CRM connectivity — does the plugin queue locally + retry on reconnect, or hard-fail with "no connection"? Recommend: queue (use `chrome.storage.local` as a 10-item ring buffer) — but adds complexity. Phase 1 may want hard-fail simplicity. | GS engineering |
| OQ-9 | Edge / Brave parity — Manifest V3 in those is mostly compatible but Edge's add-on store has a separate submission flow. Submit to both Chrome Web Store + Microsoft Edge Add-ons, or Chrome-only and let Edge users sideload from the Chrome store? Currently Chrome-only with sideload acceptable for Edge. | GS engineering + Yasin |

---

## 10. Status snapshot

- **Plugin repo:** 🔴 NOT-STARTED — DC-1 decision pending
- **Backend endpoint `POST /api/v1/flight-plugin/quotes`:** 🔴 NOT-STARTED
  — ~½ day post-plugin scaffold; can ship CRM-side independently as soon
  as DC-1 lands (gives advisors a documented endpoint to test against
  during plugin development)
- **Per-airline adapters × 6:** 🔴 NOT-STARTED — ~2-3 days each = 12-18
  days. Phase 1 ships 3 airlines = ~7-9 days adapter work
- **Chrome Web Store publisher account:** ⏸️ pending DC-2
- **Markup engine integration (`travelPricing.js`):** ✅ SHIPPED — no
  change needed; consumes plugin output the same way it consumes manual
  entries
- **`ApiKey` model:** ✅ SHIPPED — just need `purpose='flight-plugin'` filter
  on issuance
- **Per-advisor API key issuance UI:** 🔴 NOT-STARTED — ~½ day post-DC-1
  (CRM-side; mirror voyagr F1)
- **Health dashboard `/travel/plugin-health`:** 🔴 NOT-STARTED — ~1 day
  post-MVP (don't block plugin launch on this)

**Engineering time to MVP after DC-1 / DC-2 / DC-3 land:**

| Phase | Work | Days |
|---|---|---|
| **Phase 1 — MVP** | Repo scaffold + Manifest V3 baseline + `manifest.json` for 3 airlines + content-script architecture | 2-3 |
|  | 3 per-airline DOM adapters (IndiGo + Air India + Emirates) | 7-9 |
|  | Settings UI + API key flow (`chrome.storage.local`) | 1-2 |
|  | CRM-side: `POST /api/v1/flight-plugin/quotes` endpoint + API key UI | 1 |
|  | Chrome Web Store submission + review | 1 + (1-2h Google) |
|  | **Phase 1 total** | **~12-16 days** |
| Phase 1.5 (post-MVP) | 3 more airlines (Vistara + SpiceJet + Qatar) | +9 |
|  | Health dashboard `/travel/plugin-health` | +1 |
|  | Screenshot capture flow (FR-8) | +1 |
| Phase 2 | Firefox port (when FF MV3 leaves beta) | +3-5 |
|  | Edge Add-ons store submission | +1 |
|  | Offline queue (OQ-8) if needed | +2 |
|  | Aggregator-site support (Skyscanner / MakeMyTrip) if cleared | +5-10 per provider |

---

**Ownership chain:**

- **Yasin / Travel Stall** owes DC-1 + DC-2 + DC-3 decisions (~30 min
  call covers all three) + OQ-6 / OQ-7 privacy + alerting calls.
- **GS engineering** owes the plugin repo + 3 per-airline adapters + CRM-
  side endpoint + key issuance UI + Chrome Web Store submission.
- **Google (Chrome Web Store)** owes 1-2 hour review per release —
  external dependency, not in GS's control; mitigated via FR-7 escape
  hatch.
