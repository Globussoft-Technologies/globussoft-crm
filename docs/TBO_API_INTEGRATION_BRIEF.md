# TBO API Integration — Why We Need the Keys & Where We Use Them

**Date:** 19 June 2026
**For:** The TBO (Travel Boutique Online / TBO Holidays) onboarding call
**From:** Travel Stall CRM (Globussoft) — multi-brand travel CRM

This is a one-page brief to make the TBO call productive: **what we're building, exactly where TBO's APIs plug into our CRM, and the precise credentials/access we need to switch it on.** Nothing here is built against TBO yet — the CRM surfaces that consume supplier rates already exist; TBO becomes the live data + booking engine behind them.

---

## 1. Who we are
A single travel CRM hosting **4 sub-brands** under one tenant:
- **TMC** — school / educational group trips
- **RFU** — Umrah / religious travel (Makkah · Madinah)
- **Travel Stall** — family & leisure holidays
- **Visa Sure** — visa processing

Each sub-brand quotes, prices, and books travel for its customers inside the CRM.

## 2. Why we need TBO's API (the gap today)
Right now the CRM has the **screens and the pricing engine**, but no live, bookable supplier inventory wired in:
- **Flights** are currently captured manually (a browser plugin scrapes a fare and the CRM applies markup) — there's **no live fare search and no actual ticketing**.
- **Hotels / transfers / sightseeing** have integration *scaffolding* (RateHawk etc.) but it's stubbed pending credentials — **no live rates, no bookings**.

**TBO is the single B2B source that can fill all of this at once** — hotels (global + Saudi for Umrah), flights, airport transfers, and sightseeing — through one API account. That's why TBO's keys are the unlock: one onboarding lights up live pricing **and** booking across every sub-brand.

## 3. Where TBO plugs into the CRM (product → exactly where it's used)

| TBO product | What it powers in the CRM | CRM surface / file |
|-------------|---------------------------|--------------------|
| **Hotel API** (search · pre-book · book · cancel) | Live hotel rates in quotes & itineraries; RFU Makkah/Madinah hotels; Travel Stall leisure stays | Quote Builder (`routes/travel_quotes.js`, `travel_quote_templates.js`), Itineraries (`travel_itineraries.js`), hotel-rate client (sibling to `services/ratehawkClient.js`) |
| **Air / Flight API** (fare search · quote · book · ticket) | Real-time flight fares + ticketing — replaces the manual scrape-and-markup flow; group fares for TMC, BLR→JED for RFU | Flight quotes (`routes/travel_flight_quotes.js`), Quote Builder, Itineraries |
| **Transfers API** | Airport ↔ hotel transfers in packages (incl. RFU ground movement) | Itineraries, Quote Builder, RFU ground services |
| **Sightseeing / Activities API** | Day tours & activities in leisure + school itineraries | Itineraries (`travel_itineraries.js`), itinerary templates |
| **Static content** (hotel/city master) | Hotel descriptions, images, geocodes for itinerary cards & quotes | Itineraries, microsites |

**Pricing stays ours:** every TBO rate flows through our single markup engine (`lib/travelPricing` + Cost Master `routes/travel_cost_master.js` + `travel_pricing.js`) before the customer sees a price — TBO gives the **net/base** rate, the CRM applies the per-sub-brand markup. TBO also flows into **Supplier Master** (`routes/travel_suppliers.js`) + commission/reconciliation so payouts and margins reconcile.

## 4. What we need FROM TBO (the credentials checklist)
Please provision a **B2B API agency account** and share:

**Access & credentials**
- [ ] **ClientId** (API client identifier)
- [ ] **API Username / Member login**
- [ ] **API Password** (and how token/auth works — e.g. Authenticate → TokenId, or Basic auth per product)
- [ ] **Base URLs** for **both Sandbox/UAT and Production**, per product (Hotel, Air, Transfers, Sightseeing)
- [ ] **IP whitelisting** — TBO APIs typically require our server IP(s) allow-listed. Our server IP: **163.227.174.141** (we'll confirm the production egress IP too)

**Which products to enable**
- [ ] Hotel API · [ ] Air/Flight API · [ ] Transfers · [ ] Sightseeing (we'd like all four; confirm what our account tier includes)

**Docs & onboarding**
- [ ] API documentation + **Postman collection / sample requests** (sandbox)
- [ ] Any **test-case certification** required before production go-live (and the checklist)
- [ ] Rate limits / throttling rules + a **technical support contact**

**Commercials (business side)**
- [ ] Credit line / wallet / deposit terms for bookings
- [ ] Net-rate vs commission model + how cancellations/refunds settle
- [ ] Markup/commission configuration on our account

## 5. How we'll integrate it (so TBO knows our side is ready)
- We add a **`tboClient.js`** service — a direct sibling to our existing `ratehawkClient.js` / `bookingCom.js` pattern (auth + search + book + cancel, with budget-cap + observability already scaffolded).
- Credentials live in env vars (`TBO_CLIENT_ID`, `TBO_USERNAME`, `TBO_PASSWORD`, `TBO_*_BASE_URL`) — **never in code or the repo**, never shared in chat.
- **Sandbox first** → run TBO's certification cases → flip to production via an env change (no code change).
- The CRM quote/itinerary/flight surfaces already exist (§3), so once keys land it's a **~few-days swap from stub to live**, per product.

## 6. Quick agenda for the call
1. Confirm our account covers **Hotel + Air + Transfers + Sightseeing** (sandbox + prod).
2. Get the **credentials + base URLs** and confirm the **auth flow** + **IP whitelist** requirement.
3. Get **docs + Postman** and the **certification** steps for production.
4. Agree **commercials** (credit/wallet, net vs commission, cancellation settlement).
5. Confirm **support contact** + rate limits.

---

*Internal cross-refs: this complements `docs/CREDS_TRACKER.md` and `docs/TRAVEL_API_KEYS_TO_REQUEST.md`. Add `TBO_*` to `backend/.env.example` when keys are received; build `services/tboClient.js` mirroring `services/ratehawkClient.js`.*
