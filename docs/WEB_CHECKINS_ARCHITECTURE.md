# Web Check-ins Feature — Complete Developer Guide

> Globussoft CRM — Travel module. A system for managing airline check-in for flight itineraries: staff can manually upload boarding passes, OR automation can attempt to check in automatically via airline websites.

---

## Quick Overview

**What it does:** When a travel itinerary with flights is accepted/paid, the system creates a `WebCheckin` row per passenger/flight. That row lives in a queue that staff can manually handle OR the system tries to handle automatically. The row moves through states (`pending` → `reminded` → `done` or `fallback-agent`) based on time windows, staff uploads, automation success, or customer self-confirmation.

**Two ways to get a boarding pass:**
1. **Manual** — staff member uploads a PDF/image via the UI, saves it to the database
2. **Automated** — cron engine tries to check in via the airline website (currently all airlines "not implemented" → falls back to manual)

**Current status:** Manual path is fully working. Automated path has the infrastructure but the airline adapters are stubs (no real airline login automation exists yet).

---

## The Two Flows: Manual vs. Automated

### Flow 1: MANUAL Web Check-in (✅ Fully Implemented)

```
Timeline:
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   T - 48h    │  │   T - 0h     │  │   Staff UI   │  │   T - 0h     │
│              │  │ (or earlier) │  │              │  │              │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
      │                  │                  │                │
      ▼                  ▼                  ▼                ▼
1. Flight item   2. Window opens   3. Staff opens   4. File uploaded
   parsed from      (windowOpenAt)  queue & sees     & marked done
   itinerary        row moves to    reminder
                    "reminded"

Actors:
  • Advisor/Staff: accepts itinerary → WebCheckin rows auto-created
  • Staff: opens /travel/web-checkins queue → uploads PDF file → clicks "Deliver"
  • System (cron): pending→reminded transition every 15 min

Flow Detail:
  Itinerary Acceptance or Payment
    ↓
  POST /api/travel/itineraries/:id/accept (or payment triggers it)
    ↓
  Backend calls: autoCreateWebCheckinsForItinerary(itineraryId, tenantId)
    • Find each ItineraryItem with itemType = "flight"
    • Extract pnr, flightNumber, departureAt from detailsJson
    • Derive airlineCode (first 2 chars of flight number, e.g., "6E" from "6E-237")
    • Compute windowOpenAt via webCheckinWindow.js (usually T-48h or T-24h)
    • Create WebCheckin row with status = "pending"
    ↓
  WebCheckinScheduler cron (every 15 min)
    • Find all WebCheckin rows where status = "pending" AND windowOpenAt <= NOW
    • Set status = "reminded"
    • Create Notification + WhatsApp nudge to passenger
    ↓
  Staff opens /travel/web-checkins UI
    • Sees list of rows with status "reminded" or "fallback-agent"
    • Clicks "Upload" on a row
    ↓
  POST /api/travel/webcheckins/:id/upload-boarding-pass (multipart/form-data)
    • File (PDF/PNG/JPEG/WebP, max 8MB) saved to backend/uploads/boarding-passes/
    • Prisma update: boardingPassUrl = "/uploads/boarding-passes/<filename>"
    • Status stays "reminded" (not yet marked done)
    ↓
  Staff clicks "Deliver"
    ↓
  POST /api/travel/webcheckins/:id/deliver
    • Set deliveredAt = NOW
    • Set status = "done"
    • Create WhatsApp notification to passenger (stubbed; fires when BSP creds available)
    ↓
  [DONE] Customer can see boarding pass at /travel/portal/itineraries/:id
```

**Status: ✅ FULLY WORKING**
- Auto-spawn on acceptance: ✅ works
- Upload endpoint: ✅ works
- Delivery notification: ✅ works (WhatsApp stub ready; fires when credentials present)
- Customer portal display: ✅ works
- Staff queue UI: ✅ works

---

### Flow 2: AUTOMATED Web Check-in (⚠️ Partially Implemented)

```
Timeline:
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   T - 48h    │  │   T - 0h     │  │  Cron runs   │  │   T - 0h     │
│              │  │ (or earlier) │  │  (15 min)    │  │              │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
      │                  │                  │                │
      ▼                  ▼                  ▼                ▼
1. Flight item   2. Window opens   3. Automation   4. Result logged
   parsed         row moves to      engine tries
                  "reminded"        to check in
                                    via airline

Actors:
  • System (cron): webCheckinAutomation.js runs every 15 min
  • Airline adapters: contain the login / check-in logic (CURRENTLY ALL STUBBED)

Flow Detail:
  [Same as Flow 1 up to "reminded" state]
    ↓
  WebCheckinAutomation cron (every 15 min)
    • Find all WebCheckin rows where:
      - status IN ("reminded", "in-progress")
      - automationSkipped = false (passenger didn't opt out)
      - windowOpenAt <= NOW (check-in window open)
      - departureAt > NOW (flight hasn't departed)
    ↓
  For each row:
    • Call resolveAdapter(airlineCode) → get the airline's adapter
    • Call adapter.performCheckIn({ pnr, lastName, seatPref, mealPref })
    ↓
    Possible outcomes:
    
    ✅ SUCCESS: adapter logged in, retrieved boarding pass
      → Set boardingPassUrl to the URL/file
      → Set status = "done"
      → Create notification to passenger
    
    ⚠️ CAPTCHA: website required a CAPTCHA (human needed)
      → Set status = "fallback-agent"
      → Create alert for staff
    
    ❌ NOT-IMPLEMENTED: adapter stub detected (current reality)
      → Set status = "fallback-agent"
      → Log reason: "Adapter not implemented for 6E"
    
    ❌ FAILURE (e.g., wrong PNR, timeout, wrong password)
      → Increment attemptsJson.count (max 3 retries)
      → If retries < 3: wait 1/5/15 min, retry in next cron run
      → If retries >= 3: set status = "fallback-agent"
    ↓
  Write WebCheckinAutomationRun audit row
    • Record: webCheckinId, airlineCode, outcome, attempt #, duration, error reason
    ↓
  Fallback Escalation (if stalled for 30 min)
    • WebCheckinScheduler detects reminded→fallback timeout
    • Assign to an agent (assignedAgentId)
    • Create alert: "Check-in stuck, manual intervention needed"
    ↓
  [MANUAL TAKEOVER] — staff uploads boarding pass manually (Flow 1)
```

**Status: ⚠️ INFRASTRUCTURE READY, ADAPTERS STUBBED**
- Scheduler transitions: ✅ works
- Automation engine framework: ✅ works (runs every 15 min, finds eligible rows, calls adapters)
- Audit trail (WebCheckinAutomationRun): ✅ works
- Adapter registry: ✅ works (can register adapters)
- **Airline adapters:** ❌ ALL RETURN "not-implemented" (stubs in [backend/services/airlineAdapters/_stub.js](backend/services/airlineAdapters/_stub.js))
- Fallback escalation: ✅ works

**Why all adapters are stubs:**
Real airline check-in requires:
- Reverse-engineering their website's form structure (changes often)
- Handling CAPTCHA (requires human intervention anyway)
- Credentials (BSP username/password, API keys) — not yet available
- Legal risk (automated login violates some airlines' ToS)

Current assumption: human staff always provides the boarding pass; automation is there IF/WHEN adapters are built.

---

## Implementation Status Matrix

| Feature | Status | Notes | To Enable |
|---------|--------|-------|-----------|
| **Auto-create WebCheckin on itinerary accept** | ✅ Done | Parses `detailsJson` for pnr/flightNumber/departureAt | None — automatic |
| **Compute check-in window (`windowOpenAt`)** | ✅ Done | Calls `webCheckinWindow.js`; T-48h or T-24h per airline | None — automatic |
| **Scheduler: pending→reminded every 15 min** | ✅ Done | Checks `windowOpenAt <= NOW` | None — runs automatically |
| **Scheduler: reminded→fallback after 30 min stall** | ✅ Done | Detects no progress in 30 min | None — automatic |
| **Staff upload UI at /travel/web-checkins** | ✅ Done | Queue page with upload modal | Navigate to the page |
| **Upload boarding pass endpoint** | ✅ Done | POST `/api/travel/webcheckins/:id/upload-boarding-pass` | Use the UI or call the endpoint |
| **Mark done + deliver** | ✅ Done | Sets `deliveredAt`, fires WhatsApp | Use the UI or POST `/api/travel/webcheckins/:id/deliver` |
| **Customer self-confirm in portal** | ✅ Done | POST `/api/portal/travel/itineraries/:id/webcheckin-confirm` marks all rows done | Customer opens portal & confirms |
| **Email reminders (T-36h, T-24h, T-12h)** | ✅ Done | `webCheckinEngine.js` runs hourly | None — automatic |
| **Automation engine framework** | ✅ Done | Finds eligible rows, calls adapters, logs outcomes | None — framework active |
| **Adapter registry** | ✅ Done | Can define new adapters in `backend/services/airlineAdapters/` | Define adapters for airlines |
| **Audit trail (WebCheckinAutomationRun)** | ✅ Done | Logs every attempt (success, failure, captcha, not-impl) | None — automatic |
| **Fallback agent assignment** | ✅ Done | Set `assignedAgentId` when automation fails | Integrated in automation engine |
| **Airline adapters (6E, AI, EK, UK)** | ❌ Not Implemented (Intentional) | All return "not-implemented" — stubs are correct. Web scraping is illegal. | Only build adapters for airlines with official APIs |
| **WhatsApp delivery of boarding pass** | ⚠️ Partial | Code path exists; fires when `WHATSAPP_CHANNEL_ACCESS_TOKEN` + `WHATSAPP_BUSINESS_ACCOUNT_ID` are set | Configure BSP credentials |
| **Email delivery of boarding pass** | ⚠️ Partial | Code path exists | Use existing email service (already configured) |

---

## How to Test Each Flow

### Test 1: Manual Web Check-in (Staff Upload)

**Setup:**
1. Go to demo at https://crm.globusdemos.com
2. Log in with an Enhanced Wellness or Travel tenant staff account
3. Create a travel itinerary with at least one flight item containing:
   - `detailsJson`: `{ "pnr": "ABC123", "flightNumber": "6E-237", "departureAt": "2026-08-15T10:00:00Z" }`
4. Accept the itinerary (or process payment if using the paid-itinerary path)

**Test steps:**
1. Navigate to `/travel/web-checkins`
   - **Expect:** See the WebCheckin row with status "pending"
2. Wait 15 seconds OR manually trigger the scheduler cron (dev-only):
   - **Expect:** Row status changes to "reminded"
3. Click "Upload" on the row
   - **Expect:** Modal opens asking for a file
4. Upload a PDF (e.g., `sample-boarding-pass.pdf` from local device)
   - **Expect:** File saved, `boardingPassUrl` populated with `/uploads/boarding-passes/<filename>`
5. Click "Deliver"
   - **Expect:** `deliveredAt` set, status = "done", WhatsApp notification queued (or fires if credentials present)
6. Open the customer portal at `/travel/portal`
   - **Expect:** Banner shows "You've checked in" or displays the boarding pass

**Code to inspect:**
- [backend/routes/travel_webcheckin.js](backend/routes/travel_webcheckin.js) — upload & deliver endpoints
- [frontend/src/pages/travel/WebCheckinQueue.jsx](frontend/src/pages/travel/WebCheckinQueue.jsx) — staff UI

---

### Test 2: Automated Escalation to Fallback (Stalls at "Reminded")

**Setup:**
1. Create a WebCheckin row via manual API or UI (same as Test 1, steps 1–2)
2. Row is in "reminded" state, automation will try but fail (no adapter)

**Test steps:**
1. Wait 30 minutes OR manually trigger the scheduler cron (dev-only) after row has been "reminded" for 30+ min
   - **Expect:** Scheduler detects `status = "reminded" AND updatedAt < NOW - 30 min`
   - **Expect:** Row moves to `status = "fallback-agent"`
   - **Expect:** `assignedAgentId` is set (may be a default or NULL if no agent selected)
   - **Expect:** Notification created alerting staff
2. Staff then manually uploads a boarding pass (Test 1 steps 3–5)

**Code to inspect:**
- [backend/cron/webCheckinScheduler.js](backend/cron/webCheckinScheduler.js) — the escalation logic
- Check the Notification rows in the database

---

### Test 3: Automation Attempt (Will Correctly Return "not-implemented")

**Setup:**
1. Create a WebCheckin row (same as Test 1, steps 1–2)
2. Row is in "reminded" state

**Test steps:**
1. Manually trigger the automation cron OR wait ~15 min:
   - **Expect:** `webCheckinAutomation.js` runs
   - **Expect:** Calls `resolveAdapter("6E")` (Indigo airlines)
   - **Expect:** Returns the stub adapter (intentional — no official API available)
   - **Expect:** Adapter returns `{ outcome: "not-implemented" }` (correct behavior, not a failure)
2. Check `WebCheckinAutomationRun` table:
   - **Expect:** New row with `outcome = "not-implemented"`, `errorReason = "No official API available; manual upload required"`
3. Check the WebCheckin row:
   - **Expect:** `status` is still "reminded" (automation didn't make progress, so no escalation yet)
   - **Expect:** `attemptsJson` contains attempt log

**Why "not-implemented" is the right answer:**
- 6E (Indigo), AI (Air India), EK (Emirates), UK (Vistara) don't have public APIs for check-in automation
- Web scraping their websites would be illegal (violates ToS, CFAA)
- The correct response is to fall back to manual staff upload
- After 30 min of no progress, the scheduler escalates to fallback-agent and staff uploads manually

**This is NOT a bug — it's the intended design.**

**Code to inspect:**
- [backend/cron/webCheckinAutomation.js](backend/cron/webCheckinAutomation.js) — orchestrates automation
- [backend/services/airlineAdapters/_stub.js](backend/services/airlineAdapters/_stub.js) — why stubs are correct
- [backend/services/airlineAdapters/index.js](backend/services/airlineAdapters/index.js) — registry

---

### Test 4: Customer Self-Confirm in Portal

**Setup:**
1. Create a WebCheckin row in "reminded" state (Test 1, steps 1–2)
2. Customer receives email notification (auto-sent 36h, 24h, 12h before departure)

**Test steps:**
1. Customer opens `/travel/portal` (or `/portal/travel`)
2. Logs in with their credentials
3. Sees their itinerary with `webCheckinDue: true`
4. Sees banner: "Have you checked in? Yes, I've checked in."
5. Clicks the button
   - **Expect:** All active WebCheckin rows for that itinerary → `status = "done"`
   - **Expect:** `deliveredAt` set (to NOW)
   - **Expect:** Notifications sent to passenger

**Code to inspect:**
- [backend/routes/portal.js](backend/routes/portal.js) — `/api/portal/travel/itineraries/:id/webcheckin-confirm` endpoint
- [frontend/src/pages/travel/TravelCustomerPortal.jsx](frontend/src/pages/travel/TravelCustomerPortal.jsx) — portal UI

---

## How to Implement Missing Parts

### ⚠️ LEGAL WARNING: Why Adapters Are Currently Stubs

**Web scraping airline websites to automate login is illegal and violates airline Terms of Service.**

Most airlines explicitly prohibit:
- Automated login via bots
- Scraping their websites
- Impersonating customers programmatically

**Legal risks of building real adapters via web scraping:**
- **Computer Fraud and Abuse Act (US)** — unauthorized access, even if technically possible
- **ToS violations** — airlines can sue or ban your service
- **Account termination** — the airline will detect bot traffic and block the account
- **Liability** — if a customer's booking is damaged by your bot, you're liable

**Why the adapters are stubs:** The current approach (all returning `{ outcome: "not-implemented" }`) is intentional. It forces manual staff upload, which is:
- ✅ Legal and supported
- ✅ Reliable (no bot detection, no website changes)
- ✅ Auditable (staff owns the action)

---

### The Only Legal Path Forward: Official Airline APIs

**IF you want to automate check-in, use official airline APIs:**

Some airlines expose APIs (requires partnership + credentials):
- **Lufthansa** — LH API Developer Portal (requires approval)
- **United Airlines** — partner API program
- **Delta** — developer.delta.com (requires partnership)
- **Air Canada** — API available for approved partners
- **British Airways** — partner integrations only

**Steps to use an official API:**

1. **Contact the airline's developer relations team**
   - Request API access for check-in automation
   - You'll likely need a business agreement
   - They'll provide credentials (API key, etc.)

2. **Create an adapter** that uses their official API instead of web scraping:

```javascript
// backend/services/airlineAdapters/lufthansa.js
import axios from 'axios';

export async function performCheckIn({ pnr, lastName, seatPref, mealPref }) {
  try {
    // Use official LH API with your partner credentials
    const response = await axios.post('https://api.lufthansa.com/v1/checkin', {
      pnr,
      lastName,
      // ... official API format ...
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.LUFTHANSA_API_KEY}`,
      },
    });

    if (response.data.success) {
      return {
        outcome: 'success',
        boardingPassUrl: response.data.boardingPassUrl,
      };
    } else {
      return {
        outcome: 'failure',
        reason: response.data.error,
      };
    }
  } catch (err) {
    return { outcome: 'failure', reason: err.message };
  }
}
```

3. **Register the adapter** in [backend/services/airlineAdapters/index.js](backend/services/airlineAdapters/index.js):

```javascript
import { performCheckIn as lufthansaCheckIn } from './lufthansa.js';

const adapters = {
  'LH': lufthansaCheckIn,  // Only add if you have official API access
  '6E': notImplemented,    // Keep as stub if no API
  'AI': notImplemented,
  // ...
};
```

4. **Test it** with real API calls (requires valid credentials)

**Gotchas with official APIs:**
- Approval process is slow (weeks to months)
- May require revenue-sharing or per-transaction fees
- Limited to airlines that have public APIs
- Credentials must be stored securely (encrypted at rest)

---

### Realistic Recommendation: Keep Manual as Primary, APIs as Optional

**Current state is actually correct:**
- ✅ Staff upload (manual) = primary path, fully supported, zero legal risk
- ⚠️ Automation via APIs = optional enhancement, only if airline partnership exists
- ❌ Web scraping adapters = do not build, illegal

**If a passenger's airline doesn't have an API:**
- Automation fails gracefully → `{ outcome: "not-implemented" }`
- Row escalates to fallback-agent after 30 min
- Staff uploads the boarding pass manually
- Passenger still gets the pass, just via manual upload instead of automation

**This is the right design.** The manual flow is fast, reliable, and legal. Automation is a nice-to-have for future partnerships, not a foundation to build on.

---

### To Enable WhatsApp Delivery (When BSP Credentials Arrive)

**Status:** Code path exists, fires when credentials are set.

**Setup:**
1. Contact your BSP provider (e.g., Vonage, Twilio, MessageBird) to get:
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`
   - `WHATSAPP_CHANNEL_ACCESS_TOKEN`
2. Add to `.env`:
```
WHATSAPP_BUSINESS_ACCOUNT_ID=123456789
WHATSAPP_CHANNEL_ACCESS_TOKEN=abc123...
```
3. Restart the backend

**Test:**
1. Upload a boarding pass via the staff UI (Test 1, step 4)
2. Click "Deliver"
3. Check WhatsApp messages on the passenger's phone
   - **Expect:** Message with the boarding pass PDF attachment

**Code to inspect:**
- [backend/routes/travel_webcheckin.js](backend/routes/travel_webcheckin.js) — search for `whatsappProvider`
- [backend/services/whatsappProvider.js](backend/services/whatsappProvider.js) — WhatsApp dispatch logic

---

### To Add Email Delivery Alongside WhatsApp

**Status:** Email infrastructure already exists in the system.

**Steps:**
1. In [backend/routes/travel_webcheckin.js](backend/routes/travel_webcheckin.js), after uploading a boarding pass, call:

```javascript
const { createNotification } = require('../lib/notificationService.js');

// When boarding pass is uploaded:
await createNotification(tenantId, contactId, {
  type: 'BOARDING_PASS_AVAILABLE',
  channel: 'EMAIL',
  data: { webCheckinId: id, boardingPassUrl },
});
```

2. A notification worker will pick it up and send via email (similar to WhatsApp)

---

## Database Schema

### `WebCheckin` Table

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID | Primary key |
| `tenantId` | UUID | Multi-tenant scope |
| `itineraryId` | UUID | Parent itinerary |
| `contactId` | UUID | Passenger (Contact) |
| `pnr` | STRING | Airline booking reference (e.g., "ABC123") |
| `airlineCode` | STRING | IATA code (e.g., "6E", "AI") |
| `flightNumber` | STRING | Full flight number (e.g., "6E-237") |
| `departureAt` | TIMESTAMP | Flight departure time |
| `windowOpenAt` | TIMESTAMP | When check-in window opens (T-48h or T-24h) |
| `passengerName` | STRING | Display name on the boarding pass |
| `seatPref` | STRING | Preferred seat (e.g., "12A", "aisle") |
| `mealPref` | STRING | Meal preference |
| `status` | ENUM | `pending` \| `reminded` \| `in-progress` \| `done` \| `fallback-agent` |
| `boardingPassUrl` | STRING | Path to uploaded/retrieved boarding pass (e.g., "/uploads/boarding-passes/bp-123.pdf") |
| `deliveredAt` | TIMESTAMP | When boarding pass was delivered to passenger |
| `assignedAgentId` | UUID | Staff member assigned to handle fallback |
| `automationSkipped` | BOOLEAN | Passenger opted out of automation (use manual only) |
| `attemptsJson` | JSON | `{ count: 3, lastAttemptAt: "...", reasons: [...] }` |
| `emailRemindersJson` | JSON | `{ "36h": true, "24h": false, "12h": false }` — which milestones have sent |
| `createdAt` | TIMESTAMP | Row created |
| `updatedAt` | TIMESTAMP | Last modified |

### `WebCheckinAutomationRun` Table (Audit Trail)

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID | Primary key |
| `tenantId` | UUID | Multi-tenant scope |
| `webCheckinId` | UUID | FK to WebCheckin |
| `airlineCode` | STRING | Airline code at time of attempt |
| `outcome` | ENUM | `success` \| `failure` \| `captcha` \| `not-implemented` |
| `attempt` | INT | Attempt number (1–3) |
| `durationMs` | INT | How long the automation took |
| `errorReason` | TEXT | Why it failed (e.g., "Wrong PNR", "Connection timeout") |
| `createdAt` | TIMESTAMP | When the attempt ran |

---

## File Reference (Organized by Responsibility)

### Core Routes & Controllers

| File | Lines | Responsibility |
|------|-------|-----------------|
| [backend/routes/travel_itineraries.js](backend/routes/travel_itineraries.js) | L~450 | POST `/api/travel/itineraries/:id/accept` → calls `autoCreateWebCheckinsForItinerary` |
| [backend/routes/travel_webcheckin.js](backend/routes/travel_webcheckin.js) | L~1200 | CRUD + upload + deliver: `POST /api/travel/webcheckins/:id/upload-boarding-pass`, `POST /api/travel/webcheckins/:id/deliver`, `GET /api/travel/webcheckins` (queue list) |
| [backend/routes/portal.js](backend/routes/portal.js) | L~800 | `POST /api/portal/travel/itineraries/:id/webcheckin-confirm` — customer self-confirm |

### Cron Engines (Automation & Scheduling)

| File | Frequency | Responsibility |
|------|-----------|-----------------|
| [backend/cron/webCheckinScheduler.js](backend/cron/webCheckinScheduler.js) | Every 15 min | `pending` → `reminded` (window opened), `reminded` → `fallback-agent` (30 min stall) |
| [backend/cron/webCheckinAutomation.js](backend/cron/webCheckinAutomation.js) | Every 15 min | Finds eligible rows, calls airline adapters, records outcomes in WebCheckinAutomationRun |
| [backend/cron/webCheckinEngine.js](backend/cron/webCheckinEngine.js) | Hourly | T-36h, T-24h, T-12h email reminders |

### Helper Libraries

| File | Purpose |
|------|---------|
| [backend/lib/webCheckinWindow.js](backend/lib/webCheckinWindow.js) | Compute `windowOpenAt` given airlineCode + departureAt (T-48h or T-24h per airline) |
| [backend/lib/webCheckinContent.js](backend/lib/webCheckinContent.js) | Email reminder copy + milestone text |
| [backend/services/airlineAdapters/index.js](backend/services/airlineAdapters/index.js) | Adapter registry — `resolveAdapter(airlineCode)` returns the performer |
| [backend/services/airlineAdapters/_stub.js](backend/services/airlineAdapters/_stub.js) | Current stub — returns `{ outcome: "not-implemented" }` for all airlines |

### Frontend UI

| File | Purpose |
|------|---------|
| [frontend/src/pages/travel/WebCheckinQueue.jsx](frontend/src/pages/travel/WebCheckinQueue.jsx) | Staff queue page: `/travel/web-checkins`. Lists rows, upload modal, deliver button |
| [frontend/src/pages/travel/AutomationHealth.jsx](frontend/src/pages/travel/AutomationHealth.jsx) | Dashboard: per-airline success rates, failure reasons, recent runs |
| [frontend/src/pages/travel/TravelCustomerPortal.jsx](frontend/src/pages/travel/TravelCustomerPortal.jsx) | Customer self-confirm page: shows "Have you checked in?" banner |

---

## Common Tasks & Gotchas

### "The WebCheckin row didn't auto-create after I accepted the itinerary"

**Check:**
1. The itinerary item has `itemType = "flight"` (not "hotel", "transport", etc.)
2. The `detailsJson` contains `pnr`, `flightNumber`, `departureAt` (all required)
3. Parsing didn't fail silently — add logging to [backend/routes/travel_itineraries.js](backend/routes/travel_itineraries.js) around the acceptance call

### "The automation ran but said 'not-implemented' — I want to build an adapter"

**Start with:**
1. [backend/services/airlineAdapters/_stub.js](backend/services/airlineAdapters/_stub.js) as a template
2. Copy it to a new file like `backend/services/airlineAdapters/indigo.js`
3. Replace the stub logic with real Puppeteer (or API calls) to the airline website
4. Register it in [backend/services/airlineAdapters/index.js](backend/services/airlineAdapters/index.js)
5. Test with a WebCheckin row for that airline

### "The status is stuck at 'reminded' — why didn't it escalate?"

**Reasons:**
1. Less than 30 minutes have passed since the row entered "reminded" state
2. The scheduler cron hasn't run yet (check PM2 logs: `pm2 logs globussoft-crm-backend`)
3. The row's `updatedAt` was refreshed (e.g., an API call modified it) — timestamp is reset

**To manually escalate (testing):**
```javascript
await prisma.webCheckin.update({
  where: { id: "row-id" },
  data: { status: "fallback-agent", assignedAgentId: "agent-id" },
});
```

### "WhatsApp delivery isn't firing even though credentials are set"

**Check:**
1. Credentials are in `.env` (case-sensitive: `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_CHANNEL_ACCESS_TOKEN`)
2. Backend has been restarted after adding them
3. The contact/passenger has a phone number saved in the database
4. Check PM2 logs for WhatsApp delivery errors: `pm2 logs globussoft-crm-backend | grep -i whatsapp`

---

### "Is it really illegal to build web scraping adapters for airlines?"

**Yes. Do not build adapters that scrape airline websites.**

**Why:**
1. **Violates airline ToS** — explicitly prohibited in the terms of service you agreed to as a customer
2. **Violates CFAA (US)** — Computer Fraud and Abuse Act criminalizes unauthorized computer access, even automated access
3. **Similar laws worldwide** — EU has eIDAS, UK has Computer Misuse Act, India has IPC §420 (fraud)
4. **Your service will be blocked** — airlines actively detect and block bot traffic; your IP/account will be banned
5. **No legal defense** — "the user consented" doesn't matter; the airline didn't consent, and they're the one you're accessing

**What to do instead:**
1. **Use official APIs** (if available) — Lufthansa, United, Delta have partner programs
2. **Contact airlines for authorization** — unlikely but possible for large travel agencies
3. **Accept manual upload as the path** — staff uploads the pass, no automation (current system is correct)
4. **Do not implement "just-to-see-if-it-works" web scraping adapters** — even for testing, this is risky

**Current system is correct:** The stubs return "not-implemented" → rows escalate to manual → staff uploads. This is the safe, legal path.

---

## Architecture Diagram (One Page Reference)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React)                             │
│  ┌──────────────────┐  ┌────────────────────────┐  ┌────────────┐  │
│  │ WebCheckinQueue  │  │ AutomationHealth       │  │   Portal   │  │
│  │ /travel/web-     │  │ /travel/automation-    │  │ /portal/   │  │
│  │ checkins         │  │ health                 │  │ travel     │  │
│  └────────┬─────────┘  └────────┬───────────────┘  └──────┬─────┘  │
│           │                     │                         │         │
└───────────┼─────────────────────┼─────────────────────────┼─────────┘
            │                     │                         │
            ▼                     ▼                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    BACKEND (Node.js / Express)                        │
│                                                                       │
│  ┌─ Routes ───────────────────────────────────────────────────────┐  │
│  │ POST /api/travel/itineraries/:id/accept                       │  │
│  │     ↓ calls autoCreateWebCheckinsForItinerary()               │  │
│  │                                                                 │  │
│  │ POST /api/travel/webcheckins/:id/upload-boarding-pass (staff) │  │
│  │ POST /api/travel/webcheckins/:id/deliver (staff)              │  │
│  │ POST /api/portal/travel/itineraries/:id/webcheckin-confirm    │  │
│  └────────────────────────────────────┬──────────────────────────┘  │
│                                       │                              │
│  ┌─ Crons (Automation) ───────────────┼──────────────────────────┐  │
│  │                                    │                          │  │
│  │ webCheckinScheduler (15 min)       │                          │  │
│  │   pending → reminded (window)      │                          │  │
│  │   reminded → fallback-agent (30min stall)                     │  │
│  │                                    ▼                          │  │
│  │ webCheckinAutomation (15 min)                                 │  │
│  │   ↓ finds rows in "reminded" status                           │  │
│  │   ↓ calls resolveAdapter(airlineCode)                         │  │
│  │   ↓ calls adapter.performCheckIn(...)                         │  │
│  │   ↓ logs outcome in WebCheckinAutomationRun                   │  │
│  │                                                                │  │
│  │ webCheckinEngine (hourly)                                     │  │
│  │   T-36h, T-24h, T-12h email reminders                         │  │
│  └────────────────────────────────────────────────────────────┬──┘  │
│                                                               │      │
│  ┌─ Helpers ──────────────────────────────────────────────┐  │      │
│  │ webCheckinWindow.js — compute windowOpenAt             │  │      │
│  │ airlineAdapters/index.js — adapter registry            │  │      │
│  │ airlineAdapters/_stub.js — current stub adapters       │  │      │
│  └────────────────────────────────────────────────────────┘  │      │
│                                                               │      │
└───────────────────────────────────────────────────────────────┼──────┘
                                                                │
                                                                ▼
                            ┌───────────────────────────────────────────┐
                            │    DATABASE (MySQL / Prisma)              │
                            │                                            │
                            │ WebCheckin                                 │
                            │ WebCheckinAutomationRun                    │
                            │ (+ Itinerary, ItineraryItem, Contact, etc)│
                            └────────────────────────────────────────────┘
```

---

## Glossary

| Term | Meaning |
|------|---------|
| **PNR** | Passenger Name Record — airline booking reference (e.g., "ABC123") |
| **IATA code** | 2-letter airline code (e.g., "6E" = Indigo, "AI" = Air India) |
| **Window** | The 24–48 hour period before a flight when online check-in opens |
| **Automation** | Cron engine trying to check in without human action |
| **Fallback-agent** | When automation fails or times out, a staff member takes over manually |
| **Boarding pass** | PDF/image proof of check-in, uploaded or retrieved automatically |
| **DeliveredAt** | Timestamp when the boarding pass was given to the passenger (SMS/WhatsApp/email) |

---

## Next Steps (For Your Team)

1. **Review the code:** Start with [backend/routes/travel_webcheckin.js](backend/routes/travel_webcheckin.js) and [backend/cron/webCheckinScheduler.js](backend/cron/webCheckinScheduler.js) to understand the current state
2. **Test locally:** Follow the test scenarios above (Test 1–4) to confirm everything works
3. **Plan adapters:** If you have airline credentials or APIs, start building adapters (see "How to Implement Missing Parts")
4. **Monitor production:** Set up alerts for rows stuck in "fallback-agent" — they indicate automation failures and need staff attention

---
