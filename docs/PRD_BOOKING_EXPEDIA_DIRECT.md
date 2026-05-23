# Booking.com + Expedia EAN Direct API — Product Requirements

**Status:** SPEC — Phase 1.5/2 expansion of the unified-search abstraction
that [PRD_RATEHAWK_INTEGRATION.md](PRD_RATEHAWK_INTEGRATION.md) introduces in
V1. Cred-blocked on **partner-account onboarding for each vendor** —
Booking.com Affiliate Partner Centre + Expedia EAN (Expedia Affiliate
Network) — each of which is a multi-week external process Travel Stall has
to initiate. PRD lands now as the readiness signal so Yasin can start the
partner-account applications in parallel to engineering work elsewhere.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4.3
(Quotation engine — unified search) + Travel Stall blueprint
([Travel_Stall_Business_Blueprint_For_Tech_Team.md.pdf](../travel-crm/Travel_Stall_Business_Blueprint_For_Tech_Team.md.pdf))
§4 (family-holiday B2C funnel).

**Sister PRD:** [PRD_RATEHAWK_INTEGRATION.md](PRD_RATEHAWK_INTEGRATION.md)
(commit `f514028`) — RateHawk is the **single vendor in V1**; Booking +
Expedia are the **Phase 1.5/2 expansion** for inventory depth +
rate-comparison spread. This PRD plugs two new clients into RateHawk's
unified-search fan-out shape per the DC-6 "side-by-side, no premature
abstraction" decision in that PRD.

**Audience:** Yasin (delivery owner of the Booking.com Partner Centre +
Expedia EAN partner-account applications), Travel Stall ops, RFU ops, GS
engineering.

---

## 1. Background

The Travel CRM's Phase 1 hotel-rate sourcing ships RateHawk as the single
B2B aggregator vendor (per `PRD_RATEHAWK_INTEGRATION.md`). RateHawk alone
covers the geographies RFU cares about (Makkah / Madinah / Jeddah) and
gives Travel Stall workable family-holiday inventory across India + GCC.
But RateHawk does **not** give the **3-vendor coverage spread** that
Travel Stall's B2C funnel needs to consistently beat the customer's
"I checked Booking.com and you're 8% more expensive" sniff-test. For
popular family-holiday destinations (Goa / Maldives / Dubai / Bali /
Singapore), 3-vendor coverage is empirically ~30% more offers than
RateHawk alone, and ~5-15% lower headline rate at the top-of-list.

Phase 1.5/2 expands the unified-search fan-out to include **Booking.com
Affiliate Partner Centre API** + **Expedia EAN (Expedia Affiliate
Network)**. The expansion is **additive** — RateHawk stays in the
fan-out; no migration; ranker treats all 3 vendors equally.

### 1.1 Source attribution + how this scope evolved

This PRD originates from a **single sub-question in Yasin's clarifications
email** (`travel-crm/Understanding and clarifications - Yasin.pdf`,
2026-05-13 16:48 IST → chandrikapaul@globussoft.in /
souravpatra@globussoft.in / sumit@globussoft.com). Under "Additional
clarifications we need from you," Yasin wrote:

> **Hotel rate comparator:** are Booking.com and Expedia APIs licensed by
> you for B2B rate sourcing, or do we procure access?

The 2-vendor framing here is the load-bearing detail. Yasin's question
implies a **3-vendor target state** (Booking + Expedia + whatever
aggregator we pick) — not a 1-vendor V1. GS's response to that question
([GlobusSoft_Response_15May2026.pdf](../travel-crm/GlobusSoft_Response_15May2026.pdf)
Part B vendor selection) split the answer into two phases:

1. **Phase 1 (committed):** RateHawk single-vendor — single contract,
   single onboarding, fastest path to live. Sister PRD covers it.
2. **Phase 1.5/2 (this PRD):** Booking.com + Expedia direct APIs —
   each requires a separate B2B affiliate-program contract negotiated
   with the respective vendor (multi-week each), then engineering work
   per vendor (~7-10d post-cred).

The split is a deliberate **vendor-onboarding sequencing** decision:
RateHawk's single-contract path lets Phase 1 actually launch; Booking +
Expedia's longer partner-account timelines fit naturally into Phase 1.5/2
without blocking go-live. Travel Stall's commitment to **diagnostic-led
B2C family-holiday funnel** (per the Travel Stall blueprint) makes them
the primary consumer of the 3-vendor depth — but RFU benefits secondarily
since Makkah/Madinah hotel-bed inventory in non-Hajj seasons is also
better covered by 3-vendor fan-out.

**Source-of-truth chain:**

```
Yasin's email (2026-05-13)               ← "Booking.com + Expedia licensed by you or do we procure?"
  └─ GS response (2026-05-15) Part B     ← split into RateHawk V1 + Booking/Expedia Phase 1.5/2
       └─ portal feature matrix R12      ← BLOCKED (this row)
            └─ MANUAL_CODING_BACKLOG B6  ← ~7-10d per provider post-cred
                 └─ this PRD              ← spec (you are here)
                      └─ 2 new clients   ← bookingComClient.js + expediaEanClient.js (NOT YET)
                           └─ Phase 2 partner-account cred drop (Yasin)
```

### 1.2 Why this PRD is "STUB-first then swap" (mirrors RateHawk)

Same pattern as RateHawk's PRD §1.4 + the prior 3 cred-blocked integrations
(Q3 DigiLocker, Q9 Wati, Q11 LLMs). The two new clients land STUB-side
before Travel Stall's partner-account applications clear; swap to
real-mode is `if (apiKey) realCall(...) else stubCall(...)` per call site.
Canonical pattern: [`backend/services/digilockerClient.js`](../backend/services/digilockerClient.js)
(commit `1babe1b`).

For Booking + Expedia, **no stub exists today.** First deliverable is
`backend/services/bookingComClient.js` + `backend/services/expediaEanClient.js`
written from scratch in STUB mode — each mirroring RateHawk client's
shape so `quoteRanker.js` sees a uniform per-vendor result array.

---

## 2. Use cases

All flows are quote-time in V1 — same scope as RateHawk's V1 (quoting only;
direct-book deferred to Phase 2 per §6 AC-6). The two new clients plug
into the existing unified-search fan-out without changing the operator UI
contract or the ranker output shape.

### 2.1 Unified-search expansion (primary use case)

The existing unified-search endpoint (`POST /api/travel/quote/unified-search`,
shipped in RateHawk PRD §3 FR-5) gains **2 new vendor branches**:

```
unified-search(criteria)
  ├─ ratehawkClient.search(criteria)        ← V1 (RateHawk PRD)
  ├─ bookingComClient.search(criteria)      ← Phase 1.5 (this PRD)
  └─ expediaEanClient.search(criteria)      ← Phase 2 (this PRD)
```

Ranker treats all 3 vendors equally — sorts by `totalRate` ascending; ties
broken by refundability preference (same DC-4 from RateHawk PRD; tiebreaker
rule does not change). Operator sees a merged top-10 list with a vendor
badge per row.

### 2.2 Family-holiday quote (Travel Stall — primary consumer)

1. **Parent submits family-trip enquiry** through the Travel Stall public
   funnel (existing Family Travel Quiz). Lead lands in the operator CRM.
2. **Advisor opens Travel Stall enquiry** in `/travel-stall/customers/:contactId`
   (operator UI pending per portal matrix TS row).
3. **Advisor clicks "Unified Search"** — same panel that RFU uses; just
   different `subBrand` parameter in the request body so the markup rules
   resolve to Travel Stall's tier.
4. **Backend fans out to all 3 vendors in parallel** (or 1-2 if creds for
   the others haven't arrived; healthy-vendor degradation per DC-5).
5. **Operator picks** based on the full row (price + cancellation policy +
   amenities + customer-review-score) — not just price-lowest.

### 2.3 Inventory-depth advantage (the commercial pitch)

For Travel Stall's top-20 destinations (Goa, Maldives, Dubai, Bangkok,
Bali, Singapore, Phuket, Krabi, Pattaya, Sri Lanka, Mauritius, Andaman,
Manali, Ooty, Munnar, Coorg, Jaipur, Udaipur, Kerala backwaters, Kashmir),
empirical observation from competitor research: 3-vendor coverage returns
**~30% more unique properties** than RateHawk alone, and the top-of-list
rate is **5-15% lower at p50** because the 3 vendors compete on the same
property. This is the structural advantage Travel Stall needs to beat the
"I checked Booking.com and you're more expensive" customer objection.

### 2.4 Cancellation harmonization

Vendor-specific cancellation policies arrive in 3 different shapes:

- **RateHawk:** structured JSON with `freeCancellationUntil` (ISO timestamp)
- **Booking.com:** structured but with vendor-specific timezones + per-room
  variance
- **Expedia EAN:** free-text + structured both, often with multi-tier
  refund schedules ("100% until T-14, 50% until T-7, 0% after")

The operator looking at 3 vendor rows on the same property reads 3
different formats and slows down. A **3-tier normalizer** (refundable /
partial / non-refundable) flattens the surface so the operator can pick
on price + amenity + customer-rating, with the original raw policy
expandable on click for the legal detail.

### 2.5 Phase 2: direct-book through the CRM (deferred)

V1 + Phase 1.5 = quoting only. **Phase 2** wires direct-book — when the
operator confirms a quote, the CRM POSTs the booking back to the
originating vendor; vendor returns a confirmation number; CRM stores it
on `Itinerary.externalBookingRef`. Cancellations + amendments routed
back to the originating vendor too. Phase 2 timing is a design call
(DC-4 in §5).

---

## 3. Functional requirements

| FR-ID | Requirement | V1 status target |
|---|---|---|
| FR-1 | **NEW `backend/services/bookingComClient.js`** — mirrors `digilockerClient.js` STUB pattern + RateHawk client's method shape. Header comment: `// STUB: Booking.com Affiliate Partner Centre integration pending partner-account onboarding`. Swap surface: `if (bookingComEnabled()) realCall(...) else stubResponse(...)`. | STUB lands Phase 1.5 W1 |
| FR-2 | **NEW `backend/services/expediaEanClient.js`** — same STUB pattern + same method shape. Header comment: `// STUB: Expedia EAN integration pending partner-account onboarding`. | STUB lands Phase 1.5 W1 (parallel to FR-1) |
| FR-3 | **Methods on both clients** — uniform with RateHawk: `search(criteria)` → `{ propertyName, propertyCity, ratePerNight, totalRate, currency, refundability, sourceRef, vendor: "booking" \| "expedia" }[]`; `getPropertyDetail(sourceRef)` → extended room-type + amenities + photos + reviewScore; `quote(sourceRef, dates, pax)` → finalises (locks price). | STUB lands Phase 1.5 W1 |
| FR-4 | **Auth per vendor:** Booking.com uses **OAuth2 client-credentials grant** (machine-to-machine token flow with periodic refresh); Expedia EAN uses **API-key + signature header** (HMAC-SHA256 of request body + shared secret). Both stored per-tenant via the existing `Integration` model (additive nullable JSON columns `bookingComConfig` + `expediaEanConfig`), encrypted at rest via `credentialMasking`. | Phase 1.5 |
| FR-5 | **Unified-search expansion** — existing `POST /api/travel/quote/unified-search` (from RateHawk PRD §3 FR-5) fans out to all 3 vendors in parallel; merges results; deduplicates by `(propertyName + propertyCity)` (same property may appear in 2+ vendors with different rates — keep all but flag as dedup cluster so operator sees them grouped). | Phase 1.5 |
| FR-6 | **NEW `backend/lib/cancellationNormalizer.js`** — pure-functions; converts vendor-specific policy text/JSON into the 3-tier model `{ tier: "refundable" \| "partial" \| "non_refundable", freeCancellationUntil?: ISO, rawPolicy: original }`. Pure surface so vitest covers the mapping without touching the DB (mirror `travelPricing.js`'s "pure math" discipline). | Phase 1.5 |
| FR-7 | **Inventory-sync background job: NEW `backend/cron/hotelInventorySync.js`** — nightly cron (02:30 IST), warms a per-tenant inventory cache for the top-100 most-searched properties per tenant. Trade-off: nightly freshness vs faster unified-search response next day (cache hit on warm property = 1 vendor API call avoided × 3 vendors = up to 3x latency improvement on common searches). Cache TTL 24h; configurable per tenant in DC-3. | Phase 1.5 |
| FR-8 | **Per-vendor health monitoring** — per-vendor success rate + p95 latency + error rate surfaced in the existing `/admin/llm-spend`-style dashboard alongside RateHawk. Operator can see "Booking.com is degraded" at a glance and pre-empt the toast. | Phase 1.5 |
| FR-9 | **Failure UX** — when any vendor returns 5xx or times out, unified-search **returns offers from the healthy vendors** with a banner ("Booking.com inventory unavailable; retry later"). Operator can act on partial results — does NOT hard-fail the whole search (DC-5). | Phase 1.5 |
| FR-10 | **Phase 2 direct-book** (deferred): operator confirms quote → CRM POSTs booking to originating vendor → vendor returns confirmation number → stored on `Itinerary.externalBookingRef`. Cancellations + amendments routed back to the originating vendor with vendor-specific API calls. | Phase 2 |
| FR-11 | **Cost cap, per-vendor** — both vendors are **mostly per-booking commission-based** (not per-call), so the FR-10 monthly-cap shape from RateHawk PRD is less critical. But caching (FR-7) reduces API spam and the per-call rate-limit must be respected (Booking.com tier-rate-limits ~50 req/sec free tier; Expedia EAN ~100 req/sec). Per-vendor daily call cap configurable per tenant (default 10k/day each). | Phase 1.5 |
| FR-12 | **Vendor-data residency compliance** — both Booking and Expedia are EU-headquartered (Netherlands + Washington-state respectively). Tenant data shared with vendor on quote-finalize (and Phase-2 direct-book: guest names + nationalities) must respect the tenant's residency setting (GDPR + India DPDP). | Phase 2 (compliance for direct-book; V1 quote phase shares only pax count + dates) |

---

## 4. Non-functional requirements

| NFR | Target |
|---|---|
| **Latency** | Unified-search adds 2 parallel HTTP fan-out branches on top of RateHawk's 1; budget **+1s p95** over RateHawk-only latency target → end-to-end ≤4s p95. Each individual vendor branch should respond <1.5s; the +1s envelope accounts for the slowest-of-3 + ranker merge + dedup pass. |
| **Reliability** | Vendor 5xx → retry 2× with exponential backoff (250ms / 750ms); persistent fail → unified-search returns healthy-vendor results with banner (FR-9 partial-results UX). Vendor timeout: 8s per branch (vendor-side connection issues should not stall the whole search). |
| **Cost visibility** | Per-vendor monthly spend surfaced in the same dashboard as RateHawk + LLM spend. Since Booking + Expedia are mostly commission-on-booking (not per-call), the cost surface is `bookingsRoutedToVendor × estimatedCommissionPct` — informational, not hard-cap. |
| **Compliance** | GDPR + India DPDP — both vendors are EU/US-headquartered. V1 quote phase shares only pax count + dates (no PII). Phase 2 direct-book shares guest names + nationalities + passport numbers (the same envelope DigiLocker stores), with residency setting honored. |
| **Concurrency** | Multiple advisors on the same tenant share the FR-7 inventory cache (per-tenant, not per-advisor). 3-vendor concurrent fan-out from the same query is bounded by Node's HTTP keep-alive pool. |
| **Idempotency** | `quote(sourceRef, dates, pax)` is idempotent within the vendor's price-lock window (Booking: 10-30 min depending on property; Expedia: typically 15 min). Same args within the window return the same locked offer. |

---

## 5. Hand-over requirements + decisions needed

### 5.1 The creds — partner-account onboarding chase (BOTH vendors)

Travel Stall (via Yasin) owes **two separate partner-account onboardings**.
Each is a multi-week external process; the two can run in parallel.

| Vendor | Artifact | What it is | Where it lands | Timeline |
|---|---|---|---|---|
| **Booking.com Affiliate Partner Centre** | `clientId` + `clientSecret` (OAuth2 m2m) + property-data subscription tier | Generated inside Booking.com Partner Centre after partner-account approval. Used for OAuth2 client-credentials grant to get short-lived access tokens. | `BOOKING_COM_CLIENT_ID` + `BOOKING_COM_CLIENT_SECRET` env vars; encrypted into per-tenant `Integration.bookingComConfig` JSON. | **2-4 weeks** (application → KYB review → contract → cred drop) |
| **Booking.com webhook signing secret** | HMAC secret used to verify Booking-initiated webhooks (e.g. price changes, availability updates) | Generated in Partner Centre webhook config | `BOOKING_COM_WEBHOOK_SECRET` env var | Same |
| **Expedia EAN** | `apiKey` + `sharedSecret` (HMAC-SHA256 signature) + per-tenant EAN account ID | Generated inside Expedia EAN partner portal after partner-account approval. Used for per-request HMAC signature header. | `EXPEDIA_EAN_API_KEY` + `EXPEDIA_EAN_SHARED_SECRET` env vars; encrypted into per-tenant `Integration.expediaEanConfig` JSON. | **2-4 weeks** (application → KYB review → contract → cred drop) |
| **Production base URLs** | Booking.com vs Expedia EAN staging vs production endpoint URLs | One per vendor, typically swapped via env var | `BOOKING_COM_BASE_URL` + `EXPEDIA_EAN_BASE_URL` env vars; default to production | Same |

**PRD lands now; STUBs ship pre-cred; real-mode swap is ~½ day per vendor
post-cred drop.** Total post-cred engineering: ~7-10 days per vendor +
2-3 days unified-search expansion + cancellation normalizer + inventory-sync
cron + tests.

### 5.2 Design calls needed before Phase 1.5 implementation

These are the 7 design calls that gate the Phase 1.5/2 work. GS
recommendations are noted; Yasin / Suresh approval needed on each.

| DC-ID | Decision | GS recommendation |
|---|---|---|
| **DC-1** | **Vendor priority** — which vendor first if Travel Stall's bandwidth is constrained on partner-account applications? | **Booking.com first.** Larger inventory in India + South Asia (Travel Stall's primary market); simpler OAuth2 flow (Expedia's HMAC signature header is fiddlier to get right); Booking has a more mature affiliate-partner program. Expedia second. If both partner-account applications can run in parallel, run them in parallel — they're independent processes at the vendor side. |
| **DC-2** | **Dedup strategy** — same property appearing on 3 vendors with different rates: show all 3 or pick the cheapest only? | **Show all 3 with vendor badges.** Operator picks based on cancellation policy + amenities + review score, not just price-lowest. Hiding 2 of 3 robs the operator of the override surface (the same rationale as DC-4 manual-override in RateHawk PRD). UI groups them as a "dedup cluster" so the operator sees them adjacent + can compare side-by-side. |
| **DC-3** | **Caching aggressiveness** — FR-7 nightly inventory-sync cache trades latency for freshness. Nightly enough, or 4-hour refresh? | **Nightly for V1, configurable per tenant later.** Hotel rates change frequently but the top-100 properties' rate-of-change rarely exceeds ±5% in a 24h window — close enough for a "is this still in budget?" first-pass. Operator clicks "refresh rates" on the quote panel to get a live re-fetch when they're ready to commit. Configurable refresh interval per tenant can land in Phase 2 if a tenant proves the need. |
| **DC-4** | **Direct-book scope** — Phase 1.5 V1 = quoting only; Phase 2 = direct-book through CRM. Confirm Phase 2 timing — quarter, or "when there's demand"? | **"When there's demand."** Direct-book is operationally complex (cancellation flows + amendments + refund handling per vendor) and operators today have an existing manual booking flow that works. Wait until the operator's manual-booking-time-per-confirmed-quote metric crosses a threshold (e.g. ≥20% of operator time) before greenlighting Phase 2. |
| **DC-5** | **Failure UX** — vendor down → "results partial" banner OR "results unavailable" hard-fail? | **Partial-with-banner.** Operator can act on what's returned (the other 2 vendors usually cover the same property anyway). Hard-fail wastes operator time + customer trust. Banner copy: "{Vendor} inventory unavailable — retrying. Results below from {healthy vendors}." |
| **DC-6** | **Cancellation normalizer rules** — refundable / partial / non-refundable thresholds — who owns the policy mapping logic? | **GS-internal initially, with operator override per quote.** The 3-tier model is a simplification of vendor-specific reality; some edge cases will mis-classify (e.g. "100% refundable but only via voucher" — is that refundable or partial?). GS engineering owns the initial mapping rules (heuristic on vendor's structured fields + free-text regex); operator can override the tier per-quote via a dropdown. Phase 2 polish: surface the override rate as a signal for rule tuning. |
| **DC-7** | **Vendor brand visibility** — does the customer-facing quote show "Booked via Booking.com" or is it invisible? | **Invisible.** Operator branding owns the experience; the customer doesn't need to know which supplier-of-suppliers we used. Vendor-attribution sits in the audit log + the Itinerary's internal `vendorRef` field only. Same rationale as RateHawk PRD OQ-4. If a vendor's terms of service requires public attribution (some do for affiliate programs), surface a small "Inventory provided by partners" footer on the quote PDF — not per-row. |

---

## 6. Acceptance criteria

The integration is "done" when **all 6 of the following are demonstrable**
(STUB-mode acceptance pre-cred; real-mode acceptance per-vendor post-partner-account):

| # | Test | Verifies |
|---|---|---|
| **AC-1** | Advisor enters Goa + 4 nights + 2 adults + 2 kids → unified-search returns offers from RateHawk + Booking + Expedia within **4 s p95** (each vendor branch present in the result). | FR-1, FR-2, FR-3, FR-5, NFR latency. |
| **AC-2** | Booking.com returns 5xx during a search → unified-search returns RateHawk + Expedia offers with a banner ("Booking.com inventory unavailable; retry later"). Operator can act on the partial results without re-running. | FR-9, NFR reliability, DC-5. |
| **AC-3** | Same property (e.g. "Taj Exotica Goa") appears on RateHawk + Booking + Expedia with different rates → unified-search surfaces all 3 as a "dedup cluster" with vendor badges; operator picks based on cancellation policy + amenities + review score. | FR-5 dedup, DC-2. |
| **AC-4** | Cancellation normalizer (`cancellationNormalizer.js`) maps vendor-specific policy text/JSON into the 3-tier model `{ refundable \| partial \| non_refundable }` for ≥95% of returned offers (manual operator override available for the ambiguous remainder). | FR-6, DC-6. |
| **AC-5** | Per-vendor health dashboard shows per-vendor success rate + p95 latency over the trailing 24h, side-by-side with RateHawk + LLM-spend monitors. | FR-8, NFR cost visibility. |
| **AC-6** | **Phase 2 deferred AC:** operator confirms quote → vendor returns confirmation number → stored on `Itinerary.externalBookingRef`; cancellation request routed back to originating vendor with vendor-specific API call. | FR-10 (Phase 2 only — does not gate Phase 1.5 readiness). |

GS owns the e2e validation; Yasin owns acknowledging acceptance per phase.

---

## 7. Out of scope

- **Hotel review ingestion** from vendor APIs (Booking + Expedia surface review counts + average score; deep review text ingestion is Phase 3 polish).
- **Photo/gallery deep integration** — basic single-photo URL is enough for V1 + Phase 1.5; multi-image carousel + 360°-tour ingestion is Phase 2 polish.
- **Vendor-specific loyalty programs** (Booking.com Genius / Marriott Bonvoy / Hilton Honors) — these surface chain-direct, not via aggregator APIs; out of scope indefinitely (same as RateHawk PRD §7).
- **Non-hotel inventory** — both Booking + Expedia surface flights + activities + car rentals via their APIs; out of V1 scope. Flight inventory already shipped via existing Itinerary builder.
- **Real-time price tracking** (price-drop alerts to customer post-quote) — Phase 3 customer-experience polish.
- **Multi-currency rate display** — vendors return USD/EUR/SAR/INR depending on property; convert to tenant's `Tenant.defaultCurrency` (INR for Travel Stall + RFU) via existing `travelPricing.js` engine. No new code.
- **Vendor-side cancellation lifecycle automation** — V1/Phase 1.5 quoting only; operator handles cancellation manually via the vendor's portal. Phase 2 direct-book is the prerequisite for automated cancellation.
- **Webhooks from vendors** (price-change notifications, availability updates) — Phase 2 polish; V1 + Phase 1.5 pull-only.

---

## 8. Dependencies + downstream

### 8.1 Existing infra reused (zero net-new abstractions)

- **`PRD_RATEHAWK_INTEGRATION.md` unified-search abstraction** — the unified-search endpoint + `quoteRanker.js` + `travelPricing.js` markup pass are V1 deliverables; this PRD just plugs in 2 new clients to the existing fan-out shape per the DC-6 "side-by-side, no premature abstraction" decision in RateHawk PRD.
- [`backend/lib/travelPricing.js`](../backend/lib/travelPricing.js) — markup math is vendor-agnostic; same per-tenant + per-sub-brand markup rules apply to Booking + Expedia rates as to RateHawk rates.
- `Itinerary` + `ItineraryItem` models — store the resulting quote; `ItineraryItem.vendorRef` already supports an opaque per-vendor source reference.
- `writeAudit` — per-vendor cost-tracking + per-quote selection rationale audit logging (same shape as RateHawk PRD FR-9).
- `credentialMasking` — encrypts vendor `clientSecret` / `sharedSecret` at rest.
- `notificationService` — vendor-degraded notification on persistent 5xx; per-tenant daily call-cap soft-warn at 80%.

### 8.2 Schema

- **Additive nullable JSON columns on `Integration` model:** `bookingComConfig` + `expediaEanConfig` — **no bless marker needed** (additive nullable JSON, the schema-safety detector won't flag).
- **`Itinerary.externalBookingRef`** (Phase 2 only): nullable string — additive when Phase 2 lands.
- No new models needed; per-tenant config storage extends the existing `Integration` model pattern (same approach RateHawk PRD §5.2 DC-2 takes).

### 8.3 Vendor onboarding (cred chase — the main blocker)

- **Booking.com Affiliate Partner Centre signup** — Yasin's action; 2-4 weeks lead time from application → KYB → contract → cred drop. PRD lands as the readiness signal so this can start in parallel to engineering work elsewhere.
- **Expedia EAN signup** — Yasin's action; same 2-4 weeks; independent of Booking.com (can run in parallel).
- Both vendors' KYB processes require Travel Stall's business-registration documents, GST registration (India), and a primary contact email + phone. No GS engineering involvement.

### 8.4 Downstream Phase 1.5/2 unblock

Once both partner-account onboardings clear + STUBs swap to real-mode:

- **R12 in portal feature matrix** — "Hotel rate comparator (Booking.com / Expedia / direct)" — flips from BLOCKED to SHIPPED.
- **Travel Stall "I checked Booking and you're more expensive" customer objection** — structurally eliminated by 3-vendor coverage; ~5-15% lower top-of-list rate at p50.
- **RFU non-Hajj inventory depth** — secondary benefit; Makkah/Madinah non-peak inventory coverage improves.
- **MANUAL_CODING_BACKLOG cluster B6** — closed.

---

## 9. Open questions

| # | Question | Owner |
|---|---|---|
| **OQ-1** | Yasin's vendor onboarding timeline — when does Travel Stall start the Booking.com Partner Centre + Expedia EAN applications? Each is 2-4 weeks to cred drop. | Yasin. |
| **OQ-2** | DC-1 / DC-2 / DC-3 / DC-4 / DC-5 / DC-6 / DC-7 — design-call approvals on the 7 GS recommendations in §5.2. | Yasin + Suresh. |
| **OQ-3** | Which destinations have the largest RateHawk-inventory gap? Empirical observation from Travel Stall ops would help prioritise per-destination Booking + Expedia validation testing post-cred. | Travel Stall ops. |
| **OQ-4** | Rate-drop alerts — Phase 3 customer-facing feature ("we found a lower rate; want to switch?"), or operator-only ("flag this quote for re-pricing")? **GS recommendation: operator-only Phase 3.** Customer-facing rate-drop alerts create renegotiation surface that doesn't pay off for low-margin family-holiday quotes. | Yasin + Travel Stall product. |
| **OQ-5** | Commission reconciliation — both Booking + Expedia pay GS a commission per confirmed booking (Phase 2). How does that flow into operator-side reporting? Per-advisor incentive surface, or treasury-only? | Yasin + GS finance. |
| **OQ-6** | Vendor-specific certifications — when Phase 2 direct-book passes card data through the CRM → vendor flow, PCI scope applies. Is GS already PCI-DSS compliant (via Stripe/Razorpay as the PCI proxy), or does direct-book bypass that and need its own PCI assessment? **GS recommendation: defer to legal/PCI counsel pre-Phase-2.** | Yasin + GS compliance. |
| **OQ-7** | Failure-mode display — when **all 3 vendors** are down simultaneously (rare but possible during regional Booking/Expedia outage), unified-search returns zero offers. UX should be? **GS recommendation:** same "no inventory" CTA as RateHawk PRD DC-5 — explicit "request manual quote" link that routes to existing manual flow. | RFU + Travel Stall ops. |

---

## 10. Status snapshot

### 2026-05-24 update — STUB client shipped + Phase-1/2 split enforced

**Backend STUB shipped:** `backend/services/bookingExpediaClient.js` at commit `db06414` (~213 LOC). Mirrors the canonical STUB pattern (header marker + `// STUB:` warning + canned response shape + console.log observability + CJS self-mocking seam). 11/11 vitest cases pass.

**Phase-1/2 split enforced at code level:** `assertProviderEnabled(provider)` throws `EXPEDIA_NOT_YET_ENABLED` when `provider === 'expedia'` per DC-1's "Booking first, Expedia Phase 2 (demand-driven)" resolution. The Booking code path is fully wired; Expedia code paths exist as placeholders. Flipping Phase 2 is a single-line code change (remove `'expedia'` from `PHASE_2_PROVIDERS` array).

**Per-tenant cap wired:** Shared `booking_expedia` integration key in the cross-cutting TenantSetting cap pattern. Cap helper KEYS extension shipping this tick by a sibling agent (canonical `getBudgetCap('booking_expedia')` path). Operator-writable cap-override surface at `/api/tenant-settings` per commit `1542b8e` + admin UI at `0054a03`.

**Decisions implemented:** DC-1 (Booking first, Expedia Phase 2).

**Cred chase status:** docs/CREDS_TRACKER.md Cat 1 B6/C row. Booking partner account onboarding is the unblock; ~1-2 weeks per the cred chase. ~1 day post-cred to swap stub→real per the digilockerClient/googleDriveClient precedent.

**What's now possible:**
- Caller code can invoke `bookingExpediaClient.searchHotels({tenantId, provider: 'booking', ...})` and get a structured stub response
- Per-tenant cap configurable via /api/tenant-settings (admin UI live)
- Tests can spy on `module.exports.<fn>` per the CJS self-mocking seam

**Still pending:**
- DC-2 / DC-3 / DC-4 / DC-5 — PRD-internal details (cancellation policies, inventory filters, lowest-rate tiebreaker for Booking vs RateHawk, ToS counsel review)
- Real-mode swap (cred-blocked on Booking partner onboarding)

**Path to real-mode:** When Booking creds drop, swap the stub-mode body of `searchHotels` / `bookHotel` / `cancelBooking` with real REST/SOAP calls. Cap / observability / Phase-1/2 enforcement scaffold stays unchanged. Expedia stays disabled until DC-4 flip (demand-driven).

---

| Area | Status |
|---|---|
| **RateHawk client (foundation)** | ⏸️ PRD shipped (`f514028`); STUB-mode engineering blocked on RateHawk PRD Q19 design calls; real-mode swap blocked on Q19 cred drop |
| **`backend/services/bookingComClient.js`** | 🔴 **NOT-STARTED** — no stub today; cred-blocked on Booking.com Affiliate Partner Centre partner-account onboarding (2-4 weeks lead time) |
| **`backend/services/expediaEanClient.js`** | 🔴 **NOT-STARTED** — no stub today; cred-blocked on Expedia EAN partner-account onboarding (2-4 weeks lead time, independent of Booking.com) |
| **Unified-search expansion** (3-vendor fan-out) | ⏸️ BLOCKED on RateHawk PRD Q19 + Booking.com partner-account + Expedia EAN partner-account |
| **NEW `backend/lib/cancellationNormalizer.js`** | 🔴 NOT-STARTED (~½ day standalone — can land pre-cred; uses synthetic test fixtures from vendor docs) |
| **NEW `backend/cron/hotelInventorySync.js`** | 🔴 NOT-STARTED (~1 day standalone — can land pre-cred against STUB clients) |
| **Per-vendor health dashboard** | 🔴 NOT-STARTED (~1 day; extends existing `/admin/llm-spend` page) |
| **Phase 2 direct-book** | 🔴 NOT-STARTED — deferred per DC-4; revisit when manual-booking-time-per-confirmed-quote metric crosses 20% threshold |
| **Engineering time post-creds** | **~7-10 days per vendor** + 2-3 days unified-search expansion + cancellation normalizer + inventory-sync cron + per-vendor health dashboard + tests |

### Sprint sequencing

1. **Phase 1.5 W1 (pre-cred, pre-Booking-partner-account):** Land STUB-mode `bookingComClient.js` + `expediaEanClient.js` + `cancellationNormalizer.js` + `hotelInventorySync.js` + vitest coverage + e2e specs against STUBs. Wires the 2 new vendors into the existing unified-search fan-out behind the same `if (enabled) realCall(...) else stubCall(...)` swap pattern RateHawk uses. **Satisfies the structural expansion ahead of cred drop.**
2. **Post-Booking-cred (whenever Booking.com partner-account clears):** ~½ day env wiring + per-tenant `Integration.bookingComConfig` seed + smoke validation against Booking's production endpoint. Real-mode swap is a one-liner per call site.
3. **Post-Expedia-cred (whenever Expedia EAN partner-account clears, independent of Booking):** ~½ day same shape.
4. **Phase 2 (post-V1 + Phase 1.5 stable, demand-driven per DC-4):** direct-book through originating vendor; cancellation + amendment routing; webhook handlers for vendor-initiated price/availability updates.

---

**Ownership chain:**

- **Yasin** owes the two partner-account onboarding processes (Booking.com Partner Centre + Expedia EAN; ~2-4 weeks each; independent so can run in parallel) + the 7 DC-* design-call approvals in §5.2.
- **GS engineering** owes the STUB-mode clients + `cancellationNormalizer.js` + `hotelInventorySync.js` + per-vendor health dashboard + vitest + e2e specs **before** Phase 1.5 W1 closes, then the ~½ day real-mode swap per vendor on each cred drop, then ~7-10 days per-vendor production-integration testing.
- **Booking.com + Expedia EAN** owe their respective API keys + sandbox access + per-property rate-card visibility once their partner-account contracts close.
