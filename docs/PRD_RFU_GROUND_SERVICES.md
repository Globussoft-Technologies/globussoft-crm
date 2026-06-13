# RFU Ground Services Integration — Product Requirements

**Status:** SPEC — three cred-dependent integrations bundled into a single PRD so the
design calls + cred chase can run in parallel rather than sequentially. All three
serve the same RFU (Religious Federation for Umrah) pilgrim's in-Saudi-Arabia
experience: airport → hotel → cab → train → hotel → airport. Today every leg is
quoted by hand off vendor websites; the operator pastes screenshots into the
itinerary. This PRD describes what GS will build once Yasin lands the three
vendor relationships.

**Master PRD anchor:** [TRAVEL_CRM_PRD.md](TRAVEL_CRM_PRD.md) §4.4 (RFU operating
model) + §7 (Pricing + Sourcing).

**Audience:** Yasin (delivery owner of the vendor relationships + cred handovers),
RFU ops (Sourav Patra), GS engineering.

**Related GH issues:** [#926](https://github.com/Globussoft-Technologies/globussoft-crm/issues/926)
Zikr Cabs + [#927](https://github.com/Globussoft-Technologies/globussoft-crm/issues/927)
5-portal hotel-scraper + [#928](https://github.com/Globussoft-Technologies/globussoft-crm/issues/928)
Haramain HSR.

**Sister PRDs:** [PRD_RATEHAWK_INTEGRATION.md](PRD_RATEHAWK_INTEGRATION.md) is the
closest pattern match for the Zikr Cabs + HHR client shape (single-vendor REST
client + markup layer + cancellation policy mapping). [PRD_BOOKING_EXPEDIA_DIRECT.md](PRD_BOOKING_EXPEDIA_DIRECT.md)
is the closest match for the 5-portal orchestrator's parallel-fanout shape.
[PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md](PRD_FLIGHT_PLUGIN_CHROME_EXTENSION.md)
is the closest match for the per-portal adapter maintenance pattern.

---

## Implementation Status (audited 2026-06-13 against HEAD `043b9ab3`)

| Metric | Value |
|---|---|
| Total FRs | 24 |
| ✅ Shipped | 0 (0%) |
| 🔌 Stub | 16 (Zikr Cabs 8 + Haramain HSR 8 — inert clients with budget-cap gates) |
| ❌ Missing | 8 (entire 5-portal Saudi hotel-scraper — no code) |
| ⏭️ Deferred NFRs | 5 |
| **Net gap** | **24 items, all cred/vendor-blocked** |
| Primary blocker | 7 vendor onboardings: Q-RFU-1 Zikr Cabs, Q-RFU-2..6 Almosafer/Tajawal/MyHoliday2/PilgrimsChoice/ReservationHouse hotel scrapers, Q-RFU-7 HHR Haramain. Plus RateHawk Q19 |

`backend/services/zikrCabsClient.js` + `haramainRailClient.js` exist as inert stubs with budget-cap + integration gates wired. `saudiHotelOrchestrator.js` and `hotelAdapters/` directory do NOT exist — full Saudi hotel-scraper build (~8-10d) starts when first 2 vendor creds drop.

**Single source of truth for all gap items + Wave 11 execution plan:** [TRAVEL_GAP_CLOSURE_TRACKER.md §4 (Q-RFU-*) + §6.RFU + §7 Wave 11](TRAVEL_GAP_CLOSURE_TRACKER.md).

---

## 1. Background

The 2026-05-23 portal feature matrix audit ([docs/TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md](TRAVEL_CRM_PORTAL_FEATURE_MATRIX.md))
surfaced three RFU sub-brand integration gaps. They were filed as separate GH
issues (#926/#927/#928) because each maps to a distinct vendor relationship — but
they belong in a single PRD because:

1. **Same operator workflow.** All three are quoted together in the same Umrah
   itinerary draft. An RFU operator opens a lead, picks dates + hotel city pair
   (Makkah ↔ Madinah), and needs cab + hotel + HSR rates for that itinerary in
   one view. Today: three browser tabs, manual paste. After: one quote-engine
   call returns all three.

2. **Same cred-chase cadence.** All three are blocked on Yasin completing vendor
   onboarding (existing partner account, fresh procurement, or scrape-with-ToS-review).
   Yasin's cred chase list grows by 3 items rather than handling them as
   sequential side-asks.

3. **Same delivery risk profile.** Each integration is medium-effort
   (~3-15 engineer days) but the combined feature is what RFU operators actually
   feel — shipping Zikr Cabs alone without hotel + HSR leaves the unified quote
   flow half-built.

### 1.1 Source attribution

| Integration | GH Issue | Audit source | Sister cluster |
|---|---|---|---|
| Zikr Cabs ground transfers | #926 | Portal matrix audit row "Ground transport — Saudi Arabia" | Cluster C (cred-dependent) |
| 5-portal Saudi hotel-scraper orchestrator | #927 | Portal matrix audit row "Hotel inventory — Saudi B2C portals" | Cluster B4 (Chrome flight plugin per-adapter pattern) |
| Haramain HSR pricing | #928 | Portal matrix audit row "Rail transport — Saudi Arabia" | Cluster C (cred-dependent) |

The portal matrix audit ([commit 08bc240](https://github.com/Globussoft-Technologies/globussoft-crm/commit/08bc240))
inventoried every booking surface RFU operators touch and tagged the ones with no
CRM-side integration. These three are the residue after de-duping against existing
work (RateHawk handles most non-Saudi hotel inventory; Booking/Expedia is
non-Saudi; flights are out-of-scope for ground services).

### 1.2 RFU's ground-services operating model

The "Correctness Assured Umrah Program" — RFU's flagship offering — promises the
pilgrim a fully-assembled package: visa + flight + airport meet-and-greet + hotel +
ground transport + (optional) HSR between Makkah and Madinah. The CRM today only
quotes the visa + flight + hotel legs cleanly. Ground transport and HSR are
operator-side manual lookups, which means:

- Quote turnaround time on a lead: 4-8 hours (operator runs 3 manual lookups +
  pastes into proposal email).
- Quote freshness: 1-2 days. Saudi rates fluctuate; operator's last lookup is
  stale by the time the parent signs off.
- Margin leakage: operator picks the first available rate, not the cheapest
  across vendors. Especially painful on hotels where the 5-portal spread can be
  18-25% on Hajj-season Makkah inventory.
- B2B-agent friction: RFU's sub-agents (50+) ping the home office for
  group-booking rates because they don't have direct vendor logins. Centralising
  rate discovery in CRM unblocks the sub-agent self-service workflow.

The combined integration cuts quote turnaround to <8s of CRM compute + the
operator's review-and-send overhead. Operator-perceived improvement: 4-8 hours
down to ~5 minutes.

---

## 2. Use cases — what depends on these integrations

### 2.1 Unified Umrah quote (RFU operator)

The dominant use case. Operator opens a lead in [routes/travel_itineraries.js](../backend/routes/travel_itineraries.js),
clicks "Quote", picks travel-date pair + hotel city pair + group size. CRM fans
out:

- **Zikr Cabs:** Jeddah airport → Makkah hotel (arrival leg) + Madinah hotel →
  Jeddah airport (departure leg). 1-2 cab quotes returned, classed by vehicle
  type (sedan / SUV / minivan / coach).
- **5-portal hotel-scraper:** Makkah hotel for N nights + Madinah hotel for M
  nights, lowest-rate-per-property across 5 portals. Surfaces 3-5 hotel options
  per city.
- **Haramain HSR:** Makkah → Madinah leg between the two hotel stays. 2-3 train
  options returned (economy / business, morning / afternoon / evening).

All three quotes land in the itinerary draft. Operator picks (or accepts CRM's
auto-selected cheapest combination), markup engine applies, parent receives the
itemised quote within 15 minutes.

### 2.2 B2B sub-agent self-service

RFU has ~50 sub-agents (mostly small travel agencies) selling Umrah packages on
RFU's account. Today they call the RFU home office for rates. After:

- Sub-agent logs into RFU CRM (sub-brand-scoped tenant access — see
  [backend/lib/subBrandConfig.js](../backend/lib/subBrandConfig.js)).
- Hits the same "Quote" flow but with their sub-agent markup tier applied.
- Books on parent's behalf; PNR flows back to home office for sub-agent commission
  tracking.

This drops 30-50 calls/day from the home office's queue.

### 2.3 Group booking (RFU's bread-and-butter)

RFU runs 80-200 pilgrim groups per Hajj cycle. Group bookings need:

- **Zikr Cabs:** multiple buses or a coach, often staggered pickup (10-20
  vehicles for a 200-pilgrim group).
- **Hotels:** block-booking 30-50 rooms in one Makkah hotel + 30-50 in one
  Madinah hotel. 5-portal scraper may not be relevant here (block rates are
  contracted, not portal-listed) — but the orchestrator must NOT clobber a
  contracted rate when one is on file.
- **HSR:** group ticket for 200 pilgrims (HHR has discount tiers at 50/100/200).

§5 below documents the open question on group-booking vs individual flow.

### 2.4 Cancellation reconciliation

If the parent cancels post-booking, all three legs must be cancelled coherently:

- Zikr Cabs cancellation policy (often 24h free, 12h penalty, <12h forfeit).
- Hotel cancellation per portal-of-record (Booking is generally lenient;
  Tajawal/Almosafer are stricter).
- HSR ticket cancellation (HHR has a non-refundable advance-booking class).

CRM must surface the cancellation-fee per leg + total exposure before the
operator confirms cancellation with the parent. The cancellation flow is a
single-button operation; the policy-engine fans out.

---

## 3. Functional requirements

Three sub-sections — one per integration. Each integration ships independently
but the unified quote flow (§2.1) requires all three.

### 3.1 Zikr Cabs ground-transfer API (#926)

**Service module:** `backend/services/zikrCabsClient.js` (new, mirrors `rateHawkClient.js`).

- **FR-3.1.a Quote a 1-leg cab transfer** given pickup point (Jeddah airport,
  Makkah hotel by address, Madinah hotel, Madinah airport) + dropoff point +
  vehicle class (sedan / SUV / minivan / 30-seat coach / 50-seat coach) + group
  size. Returns price in SAR + estimated travel time + cancellation policy.
- **FR-3.1.b Quote a multi-leg transfer** (e.g. airport → Makkah hotel + Madinah
  hotel → airport in one call). Returns per-leg + total.
- **FR-3.1.c Confirm a booking** with passenger names + flight PNR (for arrival
  meet-and-greet) + arrival/departure time. Returns Zikr booking reference + QR
  code (for in-Saudi driver verification).
- **FR-3.1.d Cancel a booking** with reason code. Returns refund amount + fee.
- **FR-3.1.e Track a booking** post-driver-assignment (driver name, vehicle reg
  number, ETA). Surfaced in pilgrim's WhatsApp microsite (sister WhatsApp PRD).
- **FR-3.1.f Webhook receiver** for Zikr-side status changes (`driver_assigned`,
  `pickup_completed`, `dropoff_completed`, `cancellation_confirmed`). Updates
  `TravelTripLeg` status.
- **FR-3.1.g Markup-engine integration** mirroring RateHawk: per-tenant + per-
  sub-brand markup tiers in `backend/lib/travelPricing.js`. Default RFU markup
  10%; sub-agent override 5-8% (config).
- **FR-3.1.h Audit trail** — all rate quotes + bookings + cancellations write
  audit rows so a P&L reconciliation can match operator-quoted vs vendor-billed.

**Data model addition:** `TravelGroundTransfer` Prisma model (booking ref +
vendor + vehicle class + passenger count + pickup point + dropoff point +
status + Zikr ref + price SAR + markup SAR + cancellation policy json + audit
trail).

### 3.2 5-portal Saudi hotel-scraper orchestrator (#927)

**Service module:** `backend/services/saudiHotelOrchestrator.js` + 5
per-portal adapters under `backend/services/hotelAdapters/` (almosafer.js,
tajawal.js, myholiday2.js, pilgrimsChoice.js, reservationHouse.js).

- **FR-3.2.a Submit search query to 5 portals in parallel** given city (Makkah
  or Madinah), check-in date, check-out date, room count, adult count, child
  count. 8-second wall-clock budget; portals that don't return in time get
  skipped with a warning logged (NOT a hard fail — partial results are fine).
- **FR-3.2.b Normalize per-portal response shapes** to a common
  `HotelRateResult` (property name, city, star rating, distance to Haram in
  meters, price SAR per night, total SAR for stay, cancellation policy text,
  meal plan, portal of record, deep-link to portal booking page).
- **FR-3.2.c Dedupe by property name + city** (different portals list the same
  property — pick the lowest-rate portal-of-record per property).
- **FR-3.2.d Surface the lowest 5-10 rates per city to operator** with the
  portal-of-record badge ("via Almosafer", "via Tajawal", etc.).
- **FR-3.2.e Cache rates** for the (city + check-in date + check-out date +
  room/guest count) tuple. Default TTL 4 hours; configurable per-portal in
  `backend/cron/saudiHotelCacheRefresh.js`. **Hajj-season override:** TTL drops
  to 30 minutes during Hajj month (Dhul-Hijjah) + Ramadan (rates volatile).
- **FR-3.2.f Per-portal failure handling** — if a portal's adapter returns >3
  consecutive errors, auto-disable that portal for 1 hour + log to Sentry.
  Operator UI shows "Almosafer unavailable — showing 4 of 5 portals".
- **FR-3.2.g Booking handoff** — the orchestrator does NOT book on the
  pilgrim's behalf (each portal has its own booking flow with KYC). It surfaces
  rates + deep-links the operator into the portal's booking UI with prefilled
  query params where possible.
- **FR-3.2.h Contracted-rate override** — if a hotel + city is in the
  `TravelContractedRate` table (operator-uploaded for block bookings), surface
  the contracted rate as a 6th option labelled "RFU contract — block booking"
  and let operator pick it over portal rates.

**Data model addition:** `SaudiHotelRateCache` Prisma model (city + date pair +
guest config + portal + property + rate + raw response json + fetched_at).
`TravelContractedRate` model (city + property + vendor + RFU agent + rate +
valid_from / valid_to + minimum-room-night commitment).

### 3.3 Haramain High-Speed Rail pricing API (#928)

**Service module:** `backend/services/haramainHsrClient.js` (new, mirrors RateHawk
pattern).

- **FR-3.3.a Search HSR schedule** by date + direction (Makkah → Madinah or
  Madinah → Makkah) + passenger count. Returns 4-8 train options
  (morning/midday/afternoon/evening) per class (economy / business).
- **FR-3.3.b Quote group rate** with HHR's group discount tiers (10+ pax 5%,
  50+ pax 10%, 100+ pax 15%, 200+ pax 18% — TBC by Yasin per §5).
- **FR-3.3.c Book a ticket** with passenger list (per-pilgrim name + passport
  number + nationality). Returns HHR PNR + e-ticket PDF URL.
- **FR-3.3.d Cancel a ticket** with reason. HHR's policy is generally
  non-refundable on the cheapest economy class + 50% refund on full economy /
  business if cancelled >24h before departure.
- **FR-3.3.e Markup-engine integration** — same shape as Zikr Cabs (FR-3.1.g).
  Default RFU HSR markup 8%.
- **FR-3.3.f Seat-map preview** (stretch) — HHR's API surfaces a seat map for
  business class. Operator can request a specific carriage block for a group.
- **FR-3.3.g Bilingual ticket** — HHR PDF tickets are Arabic + English. Surface
  both to the pilgrim.
- **FR-3.3.h Audit + reconciliation** — same shape as Zikr Cabs (FR-3.1.h).

**Data model addition:** `TravelHsrBooking` Prisma model (HHR PNR + departure
date + time + direction + class + passenger count + total SAR + markup SAR +
status + PDF URL + audit json).

---

## 4. Non-functional requirements

### 4.1 Latency budget

| Operation | Budget | Hard timeout |
|---|---|---|
| Unified quote (§2.1) — all 3 integrations parallel | 8s p95 | 12s |
| Zikr Cabs single-leg quote | 2s p95 | 4s |
| 5-portal hotel-scraper (5 portals parallel) | 6s p95 | 8s |
| Haramain HSR schedule lookup | 2s p95 | 4s |
| Zikr Cabs booking confirm | 4s p95 | 8s |
| HHR booking confirm | 4s p95 | 8s |

Quote latency is operator-facing and bounded by the parallel-fanout pattern;
booking latency is more forgiving because operator has already committed.

### 4.2 Rate limiting

- **Zikr Cabs:** assume 100 req/min per API key initially; revisit per Yasin's
  contract terms. Use `backend/middleware/sendLimiter.js` pattern.
- **5-portal scraper:** per-portal 60 req/min (conservative; portals may
  rate-limit anonymously-scraped vs partner-API differently). Aggregate cap of
  300 req/min across the orchestrator.
- **HHR:** assume 50 req/min initially. Partner API tier may bump to 200.

Operator-facing limits: any single operator can fire 20 quotes/min. Sub-agent
quotes share the operator's limit pool (sub-agents don't get their own
allocation by default — see §5 open Q on this).

### 4.3 Caching strategy

| Layer | What | TTL | Invalidation |
|---|---|---|---|
| Zikr Cabs rates | Per-route + vehicle-class rate card | 24h | Manual flush on vendor rate-card refresh |
| Hotel rates (5-portal) | Per city + date pair + guest config | 4h (Hajj: 30min) | Time-based + manual flush + per-portal adapter |
| HHR schedule | Per date + direction | 6h | Time-based |

Cache hits do NOT count against vendor rate limits. Hit-rate target 60% on
unified quotes (most quotes are for the next 30-90 days, so the same
city-date-pair gets re-queried often).

### 4.4 Retry strategy

- **Idempotent reads (rates, schedules):** 2 retries with exponential backoff
  (200ms → 800ms → 3.2s).
- **Non-idempotent writes (bookings, cancellations):** 1 retry only, and ONLY
  if the first attempt returned a transport-layer error (timeout, 5xx).
  Application-layer errors (validation, payment failure) never retry.
- **Webhook receivers (Zikr, HHR):** signature-validate; idempotent processing
  (dedupe by vendor ref); retry budget owned by vendor side.

### 4.5 Observability

- Per-integration Sentry tags (`integration=zikr_cabs` / `saudi_hotel` / `hhr`)
  + portal sub-tag for the 5-portal orchestrator.
- Per-integration dashboard tiles in `frontend/src/pages/Developer.jsx`:
  request count + p95 latency + error rate + cache hit rate, last 24h.
- Booking-side audit row for every Zikr/HHR booking + cancellation; surfaces in
  RFU operator audit log.

---

## 5. Hand-over requirements — cred chase + vendor docs + design decisions

This is what Yasin owes the integration code-wise to actually ship.

### 5.1 Vendor relationship + cred chase (Yasin)

| Vendor | What's needed | Effort | Blocker for |
|---|---|---|---|
| **Zikr Cabs** | (a) Partner-account onboarding (paid; expected ~SAR 5k setup + per-booking commission) OR (b) confirmation that RFU already has an account via existing Saudi-side ops + transfer creds to GS. (c) Production + sandbox API keys. (d) API documentation PDF. (e) Webhook secret. | 1-2 weeks vendor-side | FR-3.1.a → 3.1.h |
| **Almosafer (hotel portal 1)** | Decision: partner-API path OR scrape-with-ToS-review path. If partner-API, onboarding + sandbox key. | 2-4 weeks (partner path) or 0 weeks (scrape with legal review) | FR-3.2.a per-portal |
| **Tajawal (hotel portal 2)** | Same as Almosafer. | Same | FR-3.2.a per-portal |
| **MyHoliday2 (hotel portal 3)** | Same. | Same | FR-3.2.a per-portal |
| **Pilgrims Choice (hotel portal 4)** | Same. | Same | FR-3.2.a per-portal |
| **Reservation House (hotel portal 5)** | Same. | Same | FR-3.2.a per-portal |
| **Haramain HSR** | (a) Confirm B2B partner program exists (HHR's public website is B2C-only; partner API access is opaque). (b) If yes, onboarding + sandbox + production keys + API docs. (c) Group-booking tier confirmation. | 3-6 weeks (HHR is a Saudi-govt-affiliated entity; partner onboarding is slow) | FR-3.3.a → 3.3.h |

**Yasin's cred chase list grows by 7 items** (1 + 5 + 1). The MANUAL_CODING_BACKLOG.md
summary table reflects this.

### 5.2 Design decisions needed (joint product calls)

These are NOT cred-blocked; they are stakeholder calls that should happen IN
PARALLEL with the cred chase so the engineering team can scope.

| Decision | Owner | Required by |
|---|---|---|
| **D-5.2.a** Scrape-vs-partner-API per hotel portal (per-portal call; some are partners, some only public-scraping path is viable) | Sumit + Yasin + Globussoft counsel (ToS review) | Before FR-3.2.a per-portal kicks off |
| **D-5.2.b** Group-booking flow — single PNR per leg (one Zikr ref, one HHR ref) or per-pilgrim individual PNRs (200 refs)? Per-leg has billing simplicity; per-pilgrim has cancellation flexibility. | Yasin (operations) + Sourav Patra (RFU) | Before FR-3.1.b + FR-3.3.b |
| **D-5.2.c** Auto-confirmation policy — book on cheapest rate automatically once parent has paid the deposit, or always require human review? RateHawk's pattern is "operator confirms"; this is consistent and probably right. | Sumit (eng) + Sourav (RFU) | Before booking flows go live |
| **D-5.2.d** Sub-agent margin override — fixed %, per-leg config, or per-vendor config? Affects markup-engine schema design. | Sourav (RFU commercial) | Before FR-3.1.g + FR-3.3.e ship |
| **D-5.2.e** Hajj-season caching exception — confirmed at 30min TTL or tighter? | Yasin (operations) + Sourav | Before FR-3.2.e ships |
| **D-5.2.f** Cancellation reconciliation policy — auto-cancel cab if HSR cancels (linked legs)? Or surface as 3 independent cancellations to operator? Independent is more flexible but adds operator burden. | Sourav (RFU ops) | Before §2.4 ships |

### 5.3 Vendor documentation owed by Yasin

Once relationships are confirmed:
- Zikr Cabs API spec PDF (or OpenAPI / Postman collection)
- Each of 5 hotel portals' partner-API docs OR scraping target URLs +
  example HTML pages (for scraper-path portals)
- HHR partner API spec + group-booking tier documentation
- Cancellation-policy reference document per vendor

### 5.4 Sandbox + production environments

For each integration, GS needs:
- Sandbox endpoint + sandbox API key (for CI + local dev)
- Production endpoint + production API key (stored in `ApiKey` model with
  `subBrand=rfu` per [#899](https://github.com/Globussoft-Technologies/globussoft-crm/issues/899))
- Webhook receiver URL whitelist (so vendor knows to ping
  `crm.globusdemos.com/api/integrations/<vendor>/webhook` + production
  equivalent)
- Test-data scenarios per vendor (e.g. Zikr "booking that always fails for
  testing cancellation flow")

---

## 6. Acceptance criteria

Each integration ships with its own acceptance criteria; the combined unified
quote flow has cross-cutting criteria on top.

### 6.1 Per-integration AC

**Zikr Cabs (FR-3.1):**
- Quote returns within 4s p95 (sandbox).
- Booking confirm returns Zikr ref + QR code; audit row written.
- Cancellation returns refund amount matching policy.
- Webhook receives + processes 5 status events end-to-end without dupes.
- 6+ vitest cases in `backend/test/services/zikrCabsClient.test.js`.
- API gate spec `e2e/tests/zikr-cabs-api.spec.js` wired into `deploy.yml` +
  `coverage.yml`.

**5-portal hotel orchestrator (FR-3.2):**
- Parallel fan-out completes within 8s wall-clock with 5/5 portals up.
- With 1/5 portals down, orchestrator returns 4 portals' results + logs warning.
- Dedup by property name keeps the lowest-rate portal-of-record.
- Cache hit-rate >50% on a 1000-quote synthetic load.
- Per-portal adapter has its own vitest fixture-based test (5 test files).
- API gate spec `e2e/tests/saudi-hotel-orchestrator-api.spec.js` wired into CI.

**Haramain HSR (FR-3.3):**
- Schedule lookup returns 4-8 trains within 4s p95 (sandbox).
- Group-rate quote applies the right tier per passenger count.
- Booking returns HHR PNR + e-ticket PDF URL.
- Cancellation respects HHR's class-specific policy.
- 6+ vitest cases in `backend/test/services/haramainHsrClient.test.js`.
- API gate spec `e2e/tests/haramain-hsr-api.spec.js` wired into CI.

### 6.2 Unified-quote AC

- Operator clicks "Quote" on an Umrah lead with Makkah + Madinah hotel pair.
- All 3 integrations fire in parallel; results land in itinerary draft within
  12s wall-clock.
- Operator's UI shows: 2 cab quotes (arrival + departure) + 5-10 hotel options
  per city + 4-8 HSR options. Each is editable; operator picks/confirms.
- Markup engine applies; quote total appears in SAR + auto-converted to INR
  (FX layer existing).
- "Send to parent" button generates the itemised proposal PDF with all 3 legs
  + total + cancellation summary.
- End-to-end Playwright spec at `e2e/tests/rfu-unified-quote.spec.js` covers
  happy path + 1-portal-down resilience + cancellation reconciliation flow.

### 6.3 Smoke test plan (against staging once creds land)

Pre-prod smoke against sandbox endpoints:

1. Quote a 4-night Makkah + 2-night Madinah Umrah for 2 pilgrims, dates 60 days
   out. Confirm all 3 integrations return.
2. Confirm 1 cab booking, 1 hotel deep-link click-through, 1 HSR booking.
3. Cancel all 3 within 24h; confirm refund amounts match policy summary.
4. Replay with a 50-pilgrim group; confirm group discount on HSR + Zikr coach
   pricing.
5. Disable Almosafer in feature flag; confirm orchestrator gracefully returns
   4/5 portals + UI badge.

---

## 7. Out of scope

- **Visa Sure pilgrim track** — covered by [PRD_VISA_SURE_PHASE_3.md](PRD_VISA_SURE_PHASE_3.md).
  Visa application is a separate workflow; the unified Umrah quote does NOT
  include visa fees (operator adds those separately).
- **Madinah boutique hotels** — properties not listed on the 5 covered portals
  (small family-run guesthouses, contracted block-only properties). These stay
  in the operator's manual workflow + `TravelContractedRate` upload path
  (FR-3.2.h).
- **Currency conversion SAR → INR** — handled by existing FX layer
  (`backend/lib/forexRates.js`). This PRD assumes SAR throughout for vendor-side
  rates; INR conversion is the caller's responsibility.
- **Flight legs (international + domestic Saudi)** — handled by existing
  Amadeus/Sabre integration + Chrome flight plugin (cluster B4). Out of scope here.
- **Airport meet-and-greet vendor (separate from Zikr Cabs)** — RFU has a
  separate ground handler for VIP meet-and-greet at Jeddah. Not in this PRD.
- **Visa-Sure-style sub-brand isolation tests** — assumed in place via
  `subBrandConfig` helper; not re-validated here.
- **TMC + Travel Stall (non-RFU) Saudi-side workflows** — TMC school trips
  don't go to Saudi; Travel Stall family holidays use RateHawk. RFU is the
  only sub-brand needing this PRD.

---

## 8. Dependencies

| Dependency | Status | Resolution |
|---|---|---|
| `ApiKey.subBrand` column for per-sub-brand cred segregation | Open via [#899](https://github.com/Globussoft-Technologies/globussoft-crm/issues/899) | Needs landing before integration creds can be stored cleanly |
| `subBrandConfig` helper at [backend/lib/subBrandConfig.js](../backend/lib/subBrandConfig.js) | ✅ Shipped `621aab7` | Used by all 3 integrations to look up RFU-specific creds |
| Voyagr lead-capture endpoint ([#0299031](https://github.com/Globussoft-Technologies/globussoft-crm/issues/299031)) | Open — multi-day cross-repo work tracked in cluster F | RFU leads need to flow in via voyagr before unified quote is exercised at scale |
| Markup engine ([backend/lib/travelPricing.js](../backend/lib/travelPricing.js)) | ✅ Shipped | Per-integration markup configs added in §3 |
| `TravelTripLeg` + itinerary model in [backend/prisma/schema.prisma](../backend/prisma/schema.prisma) | ✅ Shipped | Three new models in §3 (TravelGroundTransfer, SaudiHotelRateCache, TravelHsrBooking) extend it |
| WhatsApp microsite for pilgrim status updates ([WHATSAPP_INTEGRATION_PRD.md](WHATSAPP_INTEGRATION_PRD.md)) | SPEC — Q9 cred-blocked | Required for FR-3.1.e (cab tracking notification); falls back to email if WhatsApp not yet live |
| `Sentry` (`backend/lib/sentry.js`) | ✅ Shipped | Used for per-integration observability per §4.5 |
| `audit` writeAudit helper | ✅ Shipped | Used for FR-3.1.h + FR-3.3.h audit trail |

**Critical path:** `#899` ApiKey.subBrand column → 7 vendor cred handovers
(Yasin) → engineering work (~16-25 days across 3 integrations) → unified-quote
operator UI + Playwright spec.

---

## 9. Open questions

| Q | Description | Owner | Blocking |
|---|---|---|---|
| **Q-RFUG-1** | Scrape vs partner-API per hotel portal — do we ToS-review-and-scrape, or partner-API-only? Mixed (some partner, some scrape) is fine if legal signs off per portal. | Sumit + Yasin + counsel | FR-3.2 implementation start |
| **Q-RFUG-2** | Group-booking PNR model — single PNR per leg, or per-pilgrim PNRs? | Yasin + Sourav | FR-3.1.b + FR-3.3.b |
| **Q-RFUG-3** | Auto-confirmation policy — auto-book on cheapest after parent deposit, or always operator-review? | Sumit + Sourav | Booking flows |
| **Q-RFUG-4** | Cancellation cascade — auto-cancel cab if HSR cancels (linked-legs model), or independent cancellations? | Sourav | §2.4 implementation |
| **Q-RFUG-5** | Sub-agent margin override structure — fixed %, per-leg, or per-vendor config in markup engine? | Sourav | FR-3.1.g + FR-3.3.e schema |
| **Q-RFUG-6** | Hajj-season Hotel cache TTL — confirmed at 30min, or tighter (5-10min during peak Dhul-Hijjah)? | Yasin + Sourav | FR-3.2.e default |
| **Q-RFUG-7** | Sub-agent rate-limit allocation — share with parent operator pool, or per-sub-agent quota? Affects §4.2 capacity planning + sub-agent-self-service viability. | Sumit + Yasin | Before sub-agent UI rolls out |
| **Q-RFUG-8** | HHR partner program existence — does HHR have a B2B program at all, or is partner-API a non-starter? If non-starter, fallback to scrape (ToS dependent) or operator-side manual quote (status-quo). | Yasin | FR-3.3 entire integration |
| **Q-RFUG-9** | Zikr Cabs commission model — per-booking %, flat per-leg, or tiered? Affects markup-engine config + RFU P&L. | Yasin | FR-3.1 commercial terms |
| **Q-RFUG-10** | Should the 5-portal orchestrator also surface deep-links for OPERATOR-SIDE booking workflow (CRM doesn't book directly per FR-3.2.g), and if so does the orchestrator log the click-through for attribution? | Sumit + Sourav | FR-3.2.g UX polish |

---

## 10. Status snapshot

| Integration | GH issue | Status | Effort | Blocker |
|---|---|---|---|---|
| Zikr Cabs | #926 | 🔴 NOT-STARTED | ~3-5 days post-cred | Yasin vendor onboarding + sandbox key |
| 5-portal hotel-scraper | #927 | 🔴 NOT-STARTED | ~10-15 days post-decisions | Q-RFUG-1 (scrape vs partner) per portal |
| Haramain HSR | #928 | 🔴 NOT-STARTED | ~3-5 days post-cred | Q-RFUG-8 (does HHR partner program exist?) + Yasin onboarding |
| **Combined (unified quote)** | (this PRD) | 🔴 NOT-STARTED | ~16-25 days post-creds | All 3 above + Q-RFUG-1..10 |

**This PRD:** WRITTEN 2026-05-23 (autonomous tick #17 / agent 1).

**Path to implementation:**
1. **Schedule design calls (1-2 weeks):** Q-RFUG-1 (legal + portal-by-portal),
   Q-RFUG-2 + Q-RFUG-4 (RFU ops), Q-RFUG-3 (eng + ops), Q-RFUG-5 (commercial),
   Q-RFUG-7 + Q-RFUG-10 (eng + product).
2. **Cred chase (Yasin, parallel to design calls, 2-6 weeks):** Zikr account +
   keys, each of 5 hotel portals' decision-and-keys-or-scrape-confirmation,
   HHR partner program inquiry.
3. **Engineering (~16-25 days):** sequenced Zikr (3-5d) → HHR (3-5d) →
   5-portal orchestrator (10-15d) → unified-quote glue layer (~2d) →
   end-to-end spec + Playwright.
4. **Smoke + UAT (1 week):** RFU operator dogfoods on a real lead; legal
   signoff per portal; production cutover.

**Total elapsed:** ~6-12 weeks if design calls + cred chase run in parallel
with engineering on the cred-confirmed legs.

**Cross-cutting findings from authoring this PRD:**

- Worth filing a **fourth combined PRD on RFU operator UI** (a single
  itinerary-builder page that surfaces all 3 quotes side-by-side). The
  integrations alone don't deliver operator value; the unified-quote UX is
  what RFU operators feel. UI work is ~3-5 days on top, and probably should
  be tracked separately so it doesn't get folded into the integration sprint.
- **subBrandConfig helper (`621aab7`) needs RFU-specific keys added** when
  the creds land — Zikr key, HHR key, 5 hotel-portal keys (or scrape adapters'
  per-portal config). Worth a follow-up TODOS row to make sure the wiring
  happens during integration.
- **The 7 cred-chase items in §5.1** should be filed as 7 separate Yasin asks
  with explicit ETA dates so the cred chase is visible — recommend a tracker
  issue per vendor or a single tracker for the whole RFU ground-services
  cred chase.

---

**Last updated:** 2026-05-23 (initial spec — autonomous tick #17 PRD-writer agent).
