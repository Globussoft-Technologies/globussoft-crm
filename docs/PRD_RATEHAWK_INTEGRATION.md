# RateHawk Integration — Product Requirements

**Status:** SPEC — implementation is cred-blocked on Q19 ("RateHawk
production API key + per-tenant API ID") per
[TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md). Unlike Q9 (Wati
WhatsApp) and Q3 (DigiLocker), **no stub exists today** — `Glob
backend/services/ratehawk*` returns zero hits. `ratehawkClient.js` must be
written from scratch in STUB mode first, then swapped to real-mode on cred
drop. This PRD defines (a) what GS will build STUB-side pre-cred, and (b)
the swap surface for the real-mode wiring on cred arrival.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4.3
(Quotation engine — RFU unified search) + §5.1 (Pricing math) +
[RFU - CRM development.pdf](../travel-crm/RFU%20-%20CRM%20development.pdf) §4
(Quotation engine + cost master scope).

**Audience:** Yasin (delivery owner of the RateHawk B2B-hotel contract +
API credentials), RFU ops, GS engineering.

**Sister PRDs (separation rationale in §5 DC-6):**
- `docs/PRD_BOOKING_EXPEDIA_DIRECT.md` — Phase 2 expansion to Booking.com +
  Expedia direct APIs (cluster B6/C, ~7-10d per provider post-cred).

---

## 1. Background

RFU's Umrah operation is **pilgrim-group booking to Saudi Arabia** — Makkah
+ Madinah hotel inventory + Jeddah airport transfers + (sometimes)
Madinah↔Makkah ground transport, packaged on an `Itinerary` and quoted to
the parent / pilgrim with a fixed price-locked offer. Hotel rates in both
cities spike **5-10× during Hajj/Ramadan windows**, and pilgrim quotes
typically include 4-7 nights of hotel inventory — so the cost of "manually
checking 5 sources and missing the lowest by 2%" propagates directly into
RFU's gross margin. Lowest-rate sourcing is a **financial-survival skill**
for the sub-brand, not a nice-to-have.

### 1.1 Today's manual flow (the cost being eliminated)

Operators currently compare hotel rates across:

- **Booking.com** (lowest published rate, breadth)
- **Expedia** (occasional better Saudi-specific rate)
- **Trivago** (aggregator scan)
- **Almosafer** (GCC-region specialist; sometimes best Makkah/Madinah)
- **per-property direct** (sometimes negotiated rate)

Each enquiry → **hours of cross-tab rate comparison** per advisor per
quote. Volume × hours × advisor wage compounds to a meaningful operational
cost that scales with growth. Lowest-rate auto-pick is the canonical
"computers do this faster than humans, deterministically" CRM lever.

### 1.2 Why RateHawk for V1 (not Booking/Expedia direct)

Per GS response to Yasin's clarifications email (Part B vendor selection,
[GlobusSoft_Response_15May2026.pdf](../travel-crm/GlobusSoft_Response_15May2026.pdf)),
RateHawk is the **chosen B2B hotel-rate aggregator API for Phase 1**:

- Single contract, single API, **single onboarding** — vs Booking and
  Expedia each requiring separate B2B contract negotiations (typically
  3-6 months per provider)
- Covers the geographies RFU cares about (Makkah, Madinah, Jeddah +
  Mumbai/Bengaluru/Delhi for layovers) with competitive rates
- Per-API-call OR per-booking pricing models — choice is a contract
  negotiation lever (see DC-1 in §5)
- Booking.com direct API + Expedia direct API are scoped to **Phase 2**
  (cluster B6/C in [MANUAL_CODING_BACKLOG.md](MANUAL_CODING_BACKLOG.md);
  ~7-10d per provider post-cred). PRD `docs/PRD_BOOKING_EXPEDIA_DIRECT.md`
  is the sister-spec.

### 1.3 Source-of-truth chain

```
RFU Business Blueprint              ← Umrah operating model + supplier list
  └─ RFU - CRM development.pdf       ← R12 quotation engine scope
       └─ portal feature matrix R12  ← code-state evidence (this row is BLOCKED)
            └─ MANUAL_CODING_BACKLOG ← cluster C4 (~3-5d post-cred)
                 └─ Q19 cred chase    ← Yasin owes RateHawk API key
                      └─ this PRD     ← spec (you are here)
                           └─ backend/services/ratehawkClient.js (NOT YET)
```

### 1.4 Why this PRD is "STUB-first then swap"

Three contemporaneous integrations (Q3 DigiLocker, Q9 Wati, Q11 LLMs)
landed STUB clients **before** their credentials arrived, on the principle
that the stub pins the runtime contract — the swap to real mode is then
`if (process.env.API_KEY) realCall(...) else stubCall(...)` per call site.
This pattern compresses the post-cred swap from ~3-5 days down to ~½ day
of env wiring + smoke validation.

For RateHawk, **no stub exists today.** The first deliverable from this PRD
is `backend/services/ratehawkClient.js` written from scratch in STUB mode
— mirroring `backend/services/digilockerClient.js` (commit `1babe1b`) as
the canonical pattern. Post-cred swap then becomes the same ~½ day env
wiring + smoke validation as the prior 3 integrations.

W3 sprint exit-gate per [CLAUDE.md](../CLAUDE.md) ("unified-search
lowest-rate auto-pick") depends on the STUB landing before this sprint
concludes; the real-mode swap can land in a follow-up sprint once Q19
clears.

---

## 2. Use cases

All flows are **quote-time** — RateHawk integration is **quoting only** in
V1; actual booking happens through the operator's existing manual flow
with the supplier (see §7). Direct-book through RateHawk is V2 scope.

### 2.1 Primary RFU flow — advisor builds an Umrah quote

1. **Advisor opens enquiry** in `/travel/rfu/customers/:contactId` (existing
   RFU page) → existing diagnostic + product-tier UI captures dates +
   pax count + city pair (e.g. BLR-JED-MED-MAK-JED-BLR or
   DEL-JED-MAK-MED-JED-DEL).
2. **Advisor clicks "Unified Search"** (new panel — see FR-8).
3. **Backend fans out** in parallel:
   - **RateHawk** for hotel inventory in Makkah + Madinah (the cities on
     the itinerary leg)
   - **(Phase 2 placeholder)** Booking.com direct + Expedia direct (sister
     PRD; not in V1)
   - **Existing Itinerary builder** for flight inventory (no change in V1)
4. **Backend ranks results** by `totalRate` ascending; ties broken by
   refundability preference (DC-4); returns top-3 as `recommendations[]`.
5. **Operator reviews** the auto-picked lowest rate with full alternative
   list visible; can override with any returned offer (auto-pick is a
   default, not a contract).
6. **Operator publishes quote** → existing `travelPricing.js` engine
   applies tenant + sub-brand markup → customer-facing quote shows
   marked-up rate (NET rate is never customer-visible).

### 2.2 Operator manual override

Lowest-rate auto-pick highlights the recommended row but does **not
auto-commit** the offer. Operator can choose any returned row with a
"reason for override" field logged to audit (commercial / operational
reasons frequently override pure-price-lowest, e.g. property is
Haram-facing or has elder-care amenities — see R13 portal-matrix row).

### 2.3 Markup auto-apply

RateHawk returns **NET rates** (the rate GS pays the supplier). The
existing [`backend/lib/travelPricing.js`](../backend/lib/travelPricing.js)
engine applies tenant + sub-brand markup before the quote is shown to the
customer. The customer-facing quote shows **only the marked-up rate**,
never the NET. The audit-snapshot stored on the `Itinerary` captures both
(NET + markup amount + grand total) so margin reconciliation is
deterministic and auditable per the §1.4-comment in `travelPricing.js`
("reproduce yesterday's quote bit-for-bit a year from now").

### 2.4 Booking flow (V1 vs V2)

- **V1: RateHawk for quoting only.** Operator publishes quote → customer
  accepts → operator books **manually with the supplier** through whatever
  channel they've used historically (RateHawk's hotel-side booking portal,
  direct hotel email, supplier rep call). The Itinerary captures the
  booking-side reference as a manual entry.
- **V2: direct-book through RateHawk** — Phase 2 polish; not blocking V1.

---

## 3. Functional requirements

| FR-ID | Requirement | V1 status target |
|---|---|---|
| FR-1 | **NEW `backend/services/ratehawkClient.js`** — mirrors `digilockerClient.js` STUB pattern. Header comment: `// STUB: RateHawk integration pending Q19 creds`. Swap surface: `if (ratehawkEnabled()) realCall(...) else stubResponse(...)`. | STUB lands W3 |
| FR-2 | **Methods on `ratehawkClient`:** `search(criteria)` → `{ propertyName, propertyCity, ratePerNight, totalRate, currency, refundability, sourceRef, vendor: "ratehawk" }[]`; `getPropertyDetail(sourceRef)` → extended room-type + amenities + photos; `quote(sourceRef, dates, pax)` → finalises (locks price for ~15 min). | STUB lands W3 |
| FR-3 | **Auth: per-tenant `apiKey` + `apiId`** via the existing `Integration` model (DC-2). Encrypted at rest via the existing `credentialMasking` infra. | Schema add (additive nullable cols if new model; zero schema work if `Integration` model extension — see DC-2) |
| FR-4 | **Per-tenant rate caching: 5-min in-memory cache** keyed by the canonicalised search criteria hash. Re-runs within 5 min hit cache (RateHawk pricing is dynamic; 5 min is the freshness-vs-retry-loop sweet spot). Not configurable per tenant in V1 (DC-3). | W3 |
| FR-5 | **NEW endpoint `POST /api/travel/quote/unified-search`** — auth `verifyToken + verifyRole(["ADMIN","MANAGER"])` — accepts search criteria, returns ranked offers from RateHawk + (Phase 2 placeholder) Booking + Expedia. | W3 |
| FR-6 | **NEW `backend/lib/quoteRanker.js`** — pure-functions; sorts by `totalRate` asc; ties broken by refundability preference (DC-4); returns top-3 as `recommendations[]`. Pure surface so vitest covers the math without touching the DB (mirror `travelPricing.js`'s "pure math" discipline). | W3 |
| FR-7 | **Markup integration** — each returned rate passes through existing `travelPricing.js` to apply tenant + sub-brand markup; customer-facing quote shows marked-up rate only; audit snapshot stores NET + markup + grand-total for margin reconciliation. | W3 (existing `travelPricing.js` already supports the inputs) |
| FR-8 | **Operator UI** — extends existing RFU `/travel/rfu/customers/:contactId` page with a "New unified search" panel. PRD-shellable as part of the FE implementation phase (not in V1 spec scope). | Follow-up |
| FR-9 | **Audit** — every RateHawk API call logged with vendor-side NET rate (cost-tracking surface for §5 DC-1 cost model); every operator quote selection logged with selection rationale (forensic + commercial reconciliation). Uses existing `writeAudit` infra. | W3 |
| FR-10 | **Cost cap** — per-tenant monthly RateHawk-call cap (default **$200**, configurable per tenant). Soft-warn at 80% via `notificationService`; hard-stop at 100% returns `cost cap reached` error to operator (not silent fail). | W3 |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Latency** | Unified-search end-to-end **< 3 s p95**. RateHawk's API is typically sub-second; the 3s envelope budgets for our fan-out + ranker + per-tenant markup pass. |
| **Reliability** | Vendor 5xx → retry **2× with exponential backoff** (250ms / 750ms); persistent fail → quote returns RateHawk-only results OR (Phase 2) falls back to Booking/Expedia; operator sees a "vendor degraded" toast but quote still completes. |
| **Cost visibility** | Per-tenant per-month RateHawk spend surfaced in admin `/admin/llm-spend`-style dashboard (Phase 2 polish; FR-10 cap enforcement is V1). |
| **Compliance** | RateHawk requires per-property terms acceptance; V1 displays each property's cancellation policy inline on the quote panel (transparency). PII passed to vendor: pax count only in V1 quote phase (guest names + nationalities only required at real-booking, V2 scope — DC-6 + OQ-6). |
| **Concurrency** | Concurrent unified-search calls from multiple advisors on the same tenant share the cache (FR-4 cache is per-tenant, not per-advisor). |
| **Idempotency** | `quote(sourceRef, dates, pax)` is idempotent within the 15-min price-lock window; same args return same locked offer. |

---

## 5. Hand-over requirements + decisions needed

### 5.1 The cred — Q19 in Yasin's chase

Yasin owes (per [TRAVEL_CRM_OPEN_QUESTIONS.md](TRAVEL_CRM_OPEN_QUESTIONS.md) Q19):

| Artifact | What it is | Where it lands |
|---|---|---|
| **RateHawk API key** | Per-tenant or shared API key (depends on contract scope — see DC-1) | `RATEHAWK_API_KEY` env var; then per-tenant `Integration.config.apiKey` (encrypted) |
| **RateHawk API ID** | Account identifier for billing + rate-limit allocation | `Integration.config.apiId` |
| **Pricing model confirmation** | Per-call vs per-booking — affects FR-10 cap design | DC-1 |
| **Production base URL** | RateHawk staging vs production endpoint | `RATEHAWK_BASE_URL` env var; default production |

**PRD lands now; STUB ships pre-cred; real-mode swap is ~½ day post-cred drop.**

### 5.2 Design calls needed before W3 implementation

These are the 6 design calls that gate the W3 sprint. GS recommendations
are noted; Yasin / Suresh approval needed on each.

| DC-ID | Decision | GS recommendation |
|---|---|---|
| **DC-1** | **Pricing model with RateHawk** — per-API-call vs per-booking? | Pick whichever Yasin has negotiated. PRD assumes **per-call** for cost-cap design (FR-10) because it's the more constraining model. If per-booking lands, FR-10 cap becomes a per-month-bookings cap instead (one-line config change). |
| **DC-2** | **Config storage** — new `RatehawkConfig` model OR extend existing `Integration` model with `type='ratehawk'`? | **Extend `Integration` model** — consistent with how AdsGPT, Callified, Mailgun, Twilio etc. are already tracked. Zero schema change. Per-tenant `Integration.config` JSON stores `{ apiKey, apiId, baseUrl, monthlyCallCapUsd }`. |
| **DC-3** | **Rate caching policy** — 5-min default in FR-4; configurable per tenant? | **Not configurable in V1.** Extra complexity for marginal value. Promote to configurable only if a tenant proves the need post-launch. |
| **DC-4** | **Lowest-rate auto-pick tiebreaker** — refundability preference, or pick the lowest regardless? | **Refundability-preferred.** TMC + RFU bookings frequently get cancelled close to date (visa rejection, pilgrim health, school-trip parental withdrawal); refundability protects margin. Tiebreaker rule: at same `totalRate`, `refundability=free_cancellation_until_T-N` wins over `refundability=non_refundable`. |
| **DC-5** | **Error UX** — when RateHawk returns 0 results, show "no inventory" or auto-route to manual quote? | **Show "no inventory" with a "request manual quote" CTA.** Auto-routing risks operator surprise; explicit CTA respects the operator's choice and preserves the existing manual-quote flow as a graceful fallback. |
| **DC-6** | **Phase-2 expansion to Booking + Expedia** — keep RateHawk client + add new clients side-by-side, or wrap in a unified-vendor abstraction? | **Side-by-side** per [CLAUDE.md](../CLAUDE.md) "no premature abstraction" + sister PRD `docs/PRD_BOOKING_EXPEDIA_DIRECT.md`. Each client is its own file; `quoteRanker.js` accepts an array of per-vendor result arrays and merges. Abstraction emerges naturally once 3 vendors are live; forcing it at vendor-count=1 is speculative. |

---

## 6. Acceptance criteria

The integration is "done" when **all 6 of the following are demonstrable** (STUB-mode acceptance pre-cred; real-mode acceptance post-Q19):

| # | Test | Verifies |
|---|---|---|
| **AC-1** | Advisor enters Makkah + 5 nights + 3 pax → unified-search returns ≥1 RateHawk offer within **3 s**. | FR-1, FR-2, FR-5, NFR latency. |
| **AC-2** | Lowest-rate auto-pick row highlighted; advisor overrides with a different returned offer; override reason logged to audit. | FR-6 ranker + §2.2 manual-override behaviour. |
| **AC-3** | Tenant markup applied via existing `travelPricing.js`; customer-facing quote shows marked-up rate; audit snapshot captures NET + markup + grand-total. | FR-7 markup integration. |
| **AC-4** | Vendor 5xx → 2 retries → success on second retry → quote completes; no operator-visible error. | NFR reliability. |
| **AC-5** | Tenant monthly call-cap hit → 81st call returns `cost cap reached` error to operator (not silent fail); soft-warn notification fired at 80%. | FR-10 cost cap. |
| **AC-6** | Audit log shows RateHawk API call count + per-call NET rate (cost-tracking) + operator's selected offer + selection rationale (manual override reason or "auto-picked-lowest"). | FR-9 audit + §3 commercial reconciliation. |

GS owns the e2e validation; Yasin owns acknowledging acceptance.

---

## 7. Out of scope

- **Direct-book through RateHawk** — V1 is quoting only; manual booking with supplier post-quote. V2 polish.
- **Bed types / room layout deep-config** — RateHawk supports it; defer to V2.
- **Multi-currency conversion** — RateHawk returns USD or SAR per property; we display in tenant's `Tenant.defaultCurrency` (INR for RFU) via existing currency-conversion infra. No new code.
- **Booking.com / Expedia direct API** — sister PRD `docs/PRD_BOOKING_EXPEDIA_DIRECT.md`; Phase 2 cluster B6/C.
- **Loyalty-program rate access** (Bonvoy / Hilton Honors) — not surfaced by RateHawk or other aggregators; chain-direct only; out of scope indefinitely.
- **Flight inventory** — already shipped via existing Itinerary builder; not part of this PRD. Unified-search fans out to it but the flight side is not RateHawk-fed.
- **Ground transport** (Zikr Cabs API, Madinah↔Makkah trains) — separate Phase 2 candidates per the "Other potential PRDs identified" section of the portal matrix.

---

## 8. Dependencies + downstream

### 8.1 Schema

- **DC-2 recommendation (extend `Integration` model):** **zero schema change.** Per-tenant `Integration.config` JSON stores `{ apiKey, apiId, baseUrl, monthlyCallCapUsd }`. No migration bless marker needed.
- **DC-2 alternative (new `RatehawkConfig` model):** additive nullable columns — also no bless marker required, but adds one more model to maintain. **GS recommendation is to extend the existing model.**

### 8.2 Existing infra reused (zero net-new dependencies)

- [`backend/lib/travelPricing.js`](../backend/lib/travelPricing.js) — markup math, audit snapshot
- `Itinerary` + `ItineraryItem` models — store the resulting quote
- `writeAudit` — cost-tracking + selection rationale audit logging
- `credentialMasking` — encrypts `apiKey` at rest
- `notificationService` — FR-10 soft-warn at 80% cap utilisation

### 8.3 Sister PRD — Phase 2 expansion

[`docs/PRD_BOOKING_EXPEDIA_DIRECT.md`](PRD_BOOKING_EXPEDIA_DIRECT.md) (Phase 2) reuses this PRD's unified-search abstraction. The `side-by-side` decision in DC-6 makes that future expansion clean — each vendor's client lives in its own file; `quoteRanker.js` accepts an array of per-vendor result arrays and merges.

### 8.4 Downstream Q19 unblock

Q19 cred drop unblocks:

- **R12** in portal feature matrix — Hotel rate comparator (Booking.com / Expedia / direct)
- **R11** in portal feature matrix — Quotation engine unified-search lowest-rate auto-select (the "PARTIAL" status flips to SHIPPED)
- **W3 sprint exit-gate** per [CLAUDE.md](../CLAUDE.md) — "unified-search lowest-rate auto-pick" is the gating deliverable; STUB-mode satisfies the exit-gate ahead of Q19, real-mode swap lands on cred drop

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| **OQ-1** | Q19 cred ETA from Yasin? | Yasin. |
| **OQ-2** | DC-1 / DC-2 / DC-3 / DC-4 / DC-5 / DC-6 — design-call approvals on the 6 GS recommendations in §5.2. | Yasin + Suresh. |
| **OQ-3** | Do we want SLA monitoring on RateHawk (5xx rate per hour, p95 latency)? **GS recommendation: yes** — surface in existing admin dashboard alongside LLM-spend monitor. | GS engineering (post-V1 polish). |
| **OQ-4** | Customer-facing display of "this rate is from RateHawk" — branded badge or invisible? **GS recommendation: invisible** — operator branding owns the experience; the customer doesn't need to know which supplier-of-suppliers we used. | Yasin + RFU ops. |
| **OQ-5** | Cancellation flow when CRM-side booking changes — does RateHawk get notified? **V1: no** (manual operator action via existing supplier channel). **V2: maybe** (depends on whether DC-6 V2 direct-book lands). | RFU product call. |
| **OQ-6** | PII passed to RateHawk — V1 quote phase OK with **pax count only**? Guest names + nationalities only required at real-booking, which is out of V1 scope. **GS recommendation: pax count only in V1.** | Yasin + RFU compliance. |

---

## 10. Status snapshot

### 2026-05-24 update — STUB client shipped + cap wired

**Backend STUB shipped:** `backend/services/ratehawkClient.js` at commit `2852b82`. Mirrors the
canonical STUB pattern (header marker + `// STUB:` warning + canned response shape +
console.log observability + CJS self-mocking seam per the 4-instance pattern logged
to CLAUDE.md cron-learnings tick #99). 6/6 vitest cases pass. **Closes the
"no stub exists today" gap** noted in CREDS_TRACKER tick #74 — this was the ONLY
Cat-1 cred-blocked item with no STUB written before this tick.

**Per-tenant cap wired:** Calls `getBudgetCap(tenantId, 'ratehawk')` via the
cross-cutting TenantSetting pattern (helper at `backend/lib/tenantSettings.js`,
operator-writable surface at `/api/tenant-settings` per commit `1542b8e`).
Hard-stops at cap with `RATEHAWK_BUDGET_EXCEEDED`. 80% threshold alert via console.warn.
Admin UI for cap overrides shipping this tick by a sibling agent.

**Decisions implemented:** DC-1 (per-call cap), DC-4 (auto-with-override
lowest-rate tiebreaker logic baked into the stub response ordering).

**Cred chase status:** docs/CREDS_TRACKER.md Cat 1 Q19 row (RateHawk partner
onboarding — API key + API ID). Stub is the swap-point; ~1 day to real-mode swap
when creds drop (mirror the digilockerClient/googleDriveClient post-cred swap
pattern documented at 1babe1b/192de86).

**What's now possible:**
- Caller code can invoke `ratehawkClient.searchHotels()`, `bookHotel()`, `cancelBooking()`
  and get structured stub responses (no longer throws "integration not configured")
- Operator can set per-tenant cap override via /api/tenant-settings (admin UI in flight)
- Tests can spy on `module.exports.searchHotels` / `bookHotel` / `cancelBooking` per
  the CJS self-mocking seam
- W3 sprint exit-gate now satisfied for the client surface

**Still pending:**
- Real-mode swap (cred-blocked on Q19 Yasin handover — RateHawk API key + API ID)
- `POST /api/travel/quote/unified-search` endpoint (consumes the client; ~1 day)
- `backend/lib/quoteRanker.js` rate-ranker (~½ day, DC-4 logic surfaced from stub into ranker)
- Operator UI (RFU unified-search panel) — separate FE phase (~1-2 days)

**Path to real-mode:** When creds drop, swap the stub-mode canned response bodies
in the 3 methods with real RateHawk `fetch()` calls. Cap / observability /
feature-flag scaffold stays unchanged. ~1 day post-cred per the 3-similar-stubs pattern
that's now established (adsgpt + ratehawk + callified all built on the same skeleton
in successive ticks; bookingExpedia in-flight this tick is the 4th).

---

| Area | Status |
|---|---|
| **Schema** (per DC-2 — extending `Integration` model) | ✅ READY (no schema change needed) |
| **`backend/services/ratehawkClient.js`** (STUB-mode) | ✅ **SHIPPED** (commit `2852b82`, 6/6 vitest, cap-wired, DC-1/DC-4 implemented) |
| **`backend/services/ratehawkClient.js`** (REAL-mode swap) | 🔴 **NOT-STARTED** — cred-blocked on Q19 |
| **NEW `POST /api/travel/quote/unified-search`** endpoint | 🔴 NOT-STARTED |
| **NEW `backend/lib/quoteRanker.js`** rate-ranker | 🔴 NOT-STARTED |
| **Operator UI** (RFU unified-search panel) | 🔴 NOT-STARTED (separate FE phase) |
| **Q19 RateHawk API key + API ID** | ⏸️ BLOCKED on Yasin |
| **Engineering time post Q19 + decisions** | **~3-5 days** (STUB-mode client first, real-mode swap on cred drop) |

### Sprint sequencing

1. **W3 (this sprint, pre-Q19):** Land STUB-mode `ratehawkClient.js` + `quoteRanker.js` + `POST /api/travel/quote/unified-search` + vitest coverage + e2e spec against STUB. **Satisfies W3 sprint exit-gate.**
2. **Post-Q19:** ~½ day env wiring + per-tenant `Integration` row seed + smoke validation against RateHawk production. Real-mode swap is a one-liner: `if (ratehawkEnabled()) realCall(...) else stubCall(...)` in the client.
3. **Phase 2 (post-V1 stable):** Booking.com + Expedia direct via sister PRD; direct-book through RateHawk; SLA monitoring dashboard.

---

**Ownership chain:**

- **Yasin** owes the Q19 cred bundle + the 6 DC-* design-call approvals in §5.2.
- **GS engineering** owes the STUB-mode client + `quoteRanker.js` + unified-search endpoint + vitest + e2e spec **before** W3 closes, then the ~½ day real-mode swap on Q19 drop.
- **RateHawk** owes the API key + sandbox access + per-property pricing rate-card visibility once contract closes.
