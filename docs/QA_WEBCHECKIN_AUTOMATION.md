# Web Check-in Automation — QA Test Plan

**Version:** 1.0  
**Date:** 2026-07-01  
**Feature:** Travel CRM - Airline Web Check-in Automation (Phase 1)  
**Scope:** API endpoints, database transactions, state machine, reporting, permissions  
**Status:** Ready for QA Testing

---

## 1. FEATURE OVERVIEW

### What is Being Tested
Automated web check-in workflow for travel bookings. When a customer accepts a travel itinerary with booked flights, the system automatically:
1. Creates a check-in task per flight (WebCheckin row)
2. Monitors when the airline's check-in window opens (T-48h to T-0h)
3. Attempts automated check-in via airline adapter
4. Falls back to manual upload if automation fails
5. Delivers boarding pass to customer via WhatsApp

### Supported Airlines (Phase 1)
- **6E (IndiGo)** — Scaffold only; returns `not-implemented`
- **AI (Air India)** — Scaffold only; returns `not-implemented`
- **UK (Vistara)** — Scaffold only; returns `not-implemented`
- **EK (Emirates)** — Scaffold only; returns `not-implemented`

**Note:** Real Playwright automation blocked on PRD DC-1/DC-3/DC-5. Current implementation routes all attempts to fallback-agent (manual upload path).

---

## 2. TEST SCOPE & ASSUMPTIONS

### In Scope
✅ WebCheckin CRUD API endpoints  
✅ Automated state transitions (pending → reminded → fallback-agent/done)  
✅ Stub adapter for deterministic testing (PNR-prefix driven outcomes)  
✅ Statistics & rollup endpoints (by-month, by-quarter, by-year)  
✅ Automation health reporting (per-airline success rates)  
✅ Manual boarding pass upload  
✅ WhatsApp delivery stub logging  
✅ Multi-tenant isolation & sub-brand narrowing  
✅ Permission gates (read/write/update/delete)  

### Out of Scope
❌ Real Playwright airline portal automation (pending PRD implementation)  
❌ Real Wati WhatsApp send (pending Q9 BSP credentials)  
❌ SMS/voice delivery alternatives  
❌ Post-trip review workflows  

### Environment Assumptions
- ✅ MySQL database available (local or Docker)
- ✅ Backend running on localhost:5000 (or configurable)
- ✅ `WEBCHECKIN_AUTOMATION_STUB=1` enabled (dev/staging)
- ✅ Travel CRM tenant created with sample flights
- ✅ Demo credentials available (admin, manager, user)

---

## 3. TEST DATA REQUIREMENTS

### Pre-Test Setup

#### Create Travel Tenant
```bash
POST /api/tenants
{
  "name": "QA Travel Booking Co",
  "vertical": "travel",
  "defaultCurrency": "INR",
  "subBrandConfigJson": {
    "tmc": { "name": "TMC School Trips", "wabaId": "..." },
    "rfu": { "name": "RFU Umrah", "wabaId": "..." }
  }
}
→ tenantId = 100
```

#### Create Contacts
```bash
POST /api/contacts
{
  "tenantId": 100,
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "+919876543210"
}
→ contactId = 500

POST /api/contacts
{
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phone": "+919988776655"
}
→ contactId = 501
```

#### Create Flights (Itinerary + Items)
```bash
POST /api/travel/itineraries
{
  "tenantId": 100,
  "contactId": 500,
  "subBrand": "tmc",
  "title": "School Trip - Mumbai to Delhi",
  "status": "draft"
}
→ itineraryId = 67

POST /api/travel/itineraries/67/items
[
  {
    "type": "flight",
    "airlineCode": "6E",
    "flightNumber": "6E-001",
    "departureAt": "2026-07-15T10:30:00Z",
    "detailsJson": {
      "pnr": "ABC123XY",
      "lastNameOnTicket": "DOE",
      "seatPref": "12A",
      "mealPref": "veg"
    }
  },
  {
    "type": "flight",
    "airlineCode": "AI",
    "flightNumber": "AI-201",
    "departureAt": "2026-07-17T14:00:00Z",
    "detailsJson": {
      "pnr": "XYZ789AB",
      "lastNameOnTicket": "DOE",
      "seatPref": "15F",
      "mealPref": "veg"
    }
  }
]
```

#### Accept Itinerary (Auto-creates WebCheckins)
```bash
PATCH /api/travel/itineraries/67/accept
{
  "status": "accepted"
}

# Verify WebCheckin rows auto-created
GET /api/travel/webcheckins?itineraryId=67
→ Returns 2 WebCheckin rows (one per flight)
```

### Test Data Summary Table

| Scenario | Contact | Airline | PNR Prefix | Expected Outcome |
|----------|---------|---------|-----------|-----------------|
| Happy Path | john@... | 6E | ABC123 | Success (stub) |
| Captcha | john@... | 6E | CAPTCHA-... | Fallback (no retry) |
| Transient Fail | john@... | AI | FAIL-... | Fallback (after 3 retries) |
| Portal Down | john@... | AI | DOWN-... | Fallback (after 3 retries) |
| Not Impl | jane@... | EK | XYZ789 | Fallback (not-implemented) |

---

## 4. TEST SCENARIOS & CASES

### 4.1 CRUD Operations

#### ✅ TC-1.1: Create WebCheckin (Manual)
**Precondition:** User has web_checkins.write permission  
**Steps:**
```bash
POST /api/travel/webcheckins
{
  "tenantId": 100,
  "contactId": 500,
  "pnr": "MANUAL001",
  "airlineCode": "6E",
  "flightNumber": "6E-999",
  "departureAt": "2026-07-20T10:00:00Z",
  "passengerName": "John Doe",
  "seatPref": "1A",
  "mealPref": "veg"
}
```

**Expected:**
- ✅ HTTP 201 Created
- ✅ Response includes `id`, `status=pending`, `windowOpenAt` (T-48h from departure)
- ✅ Row persisted in database

**Regression:** Try without required fields → HTTP 400 MISSING_FIELDS

---

#### ✅ TC-1.2: List WebCheckins (with Filters)
**Steps:**
```bash
GET /api/travel/webcheckins?status=pending&limit=10&offset=0
GET /api/travel/webcheckins?contactId=500
GET /api/travel/webcheckins?itineraryId=67
```

**Expected:**
- ✅ HTTP 200 OK
- ✅ Returns paginated results matching filters
- ✅ Includes `total` count
- ✅ Sub-brand filtering: manager sees only accessible sub-brands

---

#### ✅ TC-1.3: Fetch Single WebCheckin
**Steps:**
```bash
GET /api/travel/webcheckins/123
```

**Expected:**
- ✅ HTTP 200 OK
- ✅ Full row including `attemptsJson`, `boardingPassUrl`, `deliveredAt`
- ✅ HTTP 404 if not found
- ✅ HTTP 404 if belongs to different tenant

---

#### ✅ TC-1.4: Update WebCheckin
**Steps:**
```bash
PATCH /api/travel/webcheckins/123
{
  "status": "done",
  "seatPref": "2B",
  "mealPref": "non-veg",
  "boardingPassUrl": "/uploads/boarding-passes/bp-custom.pdf"
}
```

**Expected:**
- ✅ HTTP 200 OK
- ✅ Only `status`, `seatPref`, `mealPref`, `boardingPassUrl`, `assignedAgentId`, `attemptsJson`, `automationSkipped` are updatable
- ✅ Attempting to update `id`, `tenantId`, `createdAt` is silently ignored or 400
- ✅ Invalid status → HTTP 400 INVALID_STATUS

---

#### ✅ TC-1.5: Delete WebCheckin
**Precondition:** User is ADMIN  
**Steps:**
```bash
DELETE /api/travel/webcheckins/123
```

**Expected:**
- ✅ HTTP 204 No Content
- ✅ Row deleted from database
- ✅ Manager/User attempting delete → HTTP 403 Forbidden

---

### 4.2 Automation Engine (State Machine)

#### ✅ TC-2.1: Happy Path - Automation Succeeds
**Precondition:**
- WebCheckin with PNR="ABC123XY", status=pending
- `WEBCHECKIN_AUTOMATION_STUB=1` enabled
- Departure ≤ T-48h (window open)

**Steps:**
```bash
# Option 1: Wait for scheduler cron (every N minutes)
# Option 2: Manually trigger (if admin endpoint implemented)
POST /api/travel/webcheckins/{id}/automation/trigger

# After automation runs (~seconds), fetch row
GET /api/travel/webcheckins/{id}
```

**Expected:**
- ✅ status transitions: pending → done
- ✅ boardingPassUrl populated: `/uploads/boarding-passes/stub-6E-ABC123XY.pdf`
- ✅ WebCheckinAutomationRun row created with outcome='success'
- ✅ Stats endpoint: delivered count +1

**Regression:**
- ✅ No update if automationSkipped=true
- ✅ No update if status already done/fallback-agent

---

#### ✅ TC-2.2: Captcha Challenge - No Retry
**Precondition:**
- WebCheckin with PNR="CAPTCHA-TEST"
- Stub adapter configured to return captcha outcome

**Steps:**
```bash
# Automation runs
GET /api/travel/webcheckins/{id}
```

**Expected:**
- ✅ status → fallback-agent (immediate, no retry)
- ✅ WebCheckinAutomationRun row: outcome='captcha'
- ✅ attemptsJson has 1 entry: {at, result: 'captcha', errorReason}
- ✅ No further automation attempts
- ✅ Operator must manually upload boarding pass

---

#### ✅ TC-2.3: Transient Failure - Retry 3 Times
**Precondition:**
- WebCheckin with PNR="FAIL-TEST"
- Stub returns transient failure
- Automation cron runs every 15 minutes

**Steps:**
```bash
# Cron tick 1 (T+0): Automation fails
GET /api/travel/webcheckins/{id}
→ status=pending (no change yet)
→ attemptsJson=[{at, result: 'transient', ...}]

# Wait 15 min or manually trigger cron again
# Cron tick 2 (T+15): 2nd attempt fails
GET /api/travel/webcheckins/{id}
→ status=pending
→ attemptsJson now has 2 entries

# Cron tick 3 (T+30): 3rd attempt fails
GET /api/travel/webcheckins/{id}
→ status=pending
→ attemptsJson now has 3 entries

# Cron tick 4 (T+45): No more automation (cap reached)
# Status transitions to fallback-agent
GET /api/travel/webcheckins/{id}
→ status=fallback-agent
```

**Expected:**
- ✅ After 3 failed attempts: status → fallback-agent
- ✅ WebCheckinAutomationRun rows: 3× outcome='transient'
- ✅ attemptsJson has all 3 attempts logged
- ✅ Operator notified (via TODOS or dashboard) to take manual action

---

#### ✅ TC-2.4: Portal Down - Retry Then Fallback
**Precondition:**
- WebCheckin with PNR="DOWN-TEST"
- Stub returns portal-down outcome

**Steps:**
Same as TC-2.3, but outcome='portal-down' instead

**Expected:**
- ✅ Same backoff + 3 attempts logic
- ✅ After 3 failures: status → fallback-agent

---

#### ✅ TC-2.5: Not Implemented - Direct Fallback
**Precondition:**
- WebCheckin for airline EK (Emirates, no Phase-1 adapter)
- OR all airlines when `WEBCHECKIN_AUTOMATION_STUB` is off

**Steps:**
```bash
GET /api/travel/webcheckins/{id}
```

**Expected:**
- ✅ status → fallback-agent (immediate, no retry)
- ✅ WebCheckinAutomationRun row: outcome='not-implemented'
- ✅ No further automation attempts

---

#### ✅ TC-2.6: Manual Retry (Re-arm Automation)
**Precondition:**
- WebCheckin in status=fallback-agent after failed attempts
- Operator wants to retry (airline portal recovered, etc.)

**Steps:**
```bash
POST /api/travel/webcheckins/{id}/automation/retry
```

**Expected:**
- ✅ HTTP 200 OK
- ✅ status reset to reminded
- ✅ attemptsJson cleared
- ✅ Next cron tick will attempt automation again (as if fresh)
- ✅ If status=done, return HTTP 409 ALREADY_DONE
- ✅ If automationSkipped=true, return HTTP 409 AUTOMATION_SKIPPED

---

### 4.3 Manual Upload Path

#### ✅ TC-3.1: Upload Boarding Pass (PDF)
**Precondition:**
- WebCheckin in any status (pending, fallback-agent, etc.)
- Have a valid PDF file (~1-2 MB)

**Steps:**
```bash
POST /api/travel/webcheckins/{id}/upload-boarding-pass
Content-Type: multipart/form-data
  file: @/path/to/boarding-pass.pdf

# Response:
{
  "success": true,
  "url": "/uploads/boarding-passes/bp-1720771200000-abc123.pdf",
  "webcheckin": { ...updated row... }
}
```

**Expected:**
- ✅ HTTP 200 OK
- ✅ File saved to backend/uploads/boarding-passes/
- ✅ boardingPassUrl populated
- ✅ status auto-flipped to done
- ✅ File extension validated (.pdf, .png, .jpg, .webp)
- ✅ File size capped at 8MB

**Regression:**
- ✅ File size > 8MB → HTTP 400 INVALID_FILE
- ✅ File type not image/PDF → HTTP 400 INVALID_FILE
- ✅ WebCheckin not found → HTTP 404 NOT_FOUND
- ✅ Missing file field → HTTP 400 MISSING_FILE

---

#### ✅ TC-3.2: Upload Image (PNG/JPEG/WebP)
**Steps:**
```bash
POST /api/travel/webcheckins/{id}/upload-boarding-pass
Content-Type: multipart/form-data
  file: @screenshot.png
```

**Expected:**
- ✅ Accepted (same as PDF)
- ✅ URL includes .png extension

---

### 4.4 Delivery to Passenger

#### ✅ TC-4.1: Mark Delivered (WhatsApp Stub)
**Precondition:**
- WebCheckin in status=done
- boardingPassUrl populated

**Steps:**
```bash
POST /api/travel/webcheckins/{id}/deliver

# Response:
{
  "id": 123,
  "deliveredAt": "2026-07-13T14:30:00Z",
  ...
}
```

**Expected:**
- ✅ HTTP 200 OK
- ✅ deliveredAt set to current timestamp
- ✅ Console/log shows: `[wati] boarding pass for PNR ABC123XY to +919876543210 — dispatch via watiClient — subBrand=tmc wabaId=...`
- ✅ No actual WhatsApp sent (stub mode)
- ✅ Status remains done (doesn't change)

**Regression:**
- ✅ No boardingPassUrl → HTTP 409 NO_BOARDING_PASS
- ✅ WebCheckin not found → HTTP 404 NOT_FOUND

---

#### ✅ TC-4.2: Delivery Without Boarding Pass
**Precondition:**
- WebCheckin with no boardingPassUrl

**Steps:**
```bash
POST /api/travel/webcheckins/{id}/deliver
```

**Expected:**
- ✅ HTTP 409 Conflict
- ✅ Error: "No boardingPassUrl on this check-in — upload via /upload-boarding-pass first"
- ✅ No deliveredAt update

---

### 4.5 Reporting & Analytics

#### ✅ TC-5.1: Snapshot Stats (Tenant-wide)
**Precondition:**
- 10 WebCheckin rows: 7 done, 2 pending, 1 fallback-agent
- Across airlines 6E, AI, EK
- Some with sub-brand tmc, some with _tenant

**Steps:**
```bash
GET /api/travel/webcheckins/stats
```

**Expected:**
```json
{
  "total": 10,
  "delivered": 7,
  "pending": 2,
  "upcomingWindow": 1,
  "byAirline": {
    "6E": { "count": 5 },
    "AI": { "count": 3 },
    "EK": { "count": 2 }
  },
  "bySubBrand": {
    "tmc": { "count": 6 },
    "_tenant": { "count": 4 }
  },
  "lastDeliveredAt": "2026-07-13T14:00:00Z",
  "aggregateExceedsCap": false
}
```

**Regression:**
- ✅ Sub-brand narrowing: manager sees only accessible sub-brands
- ✅ Date filter (?from=2026-07-01&to=2026-07-31) works
- ✅ Invalid date → HTTP 400 INVALID_DATE

---

#### ✅ TC-5.2: Monthly Trend (/by-month)
**Steps:**
```bash
GET /api/travel/webcheckins/by-month
```

**Expected:**
```json
{
  "months": [
    {
      "month": "2026-07",
      "count": 10,
      "deliveredCount": 7,
      "pendingCount": 3
    }
  ],
  "totalMonths": 1,
  "grandCount": 10,
  "grandDeliveredCount": 7,
  "limit": 12,
  "offset": 0
}
```

**Regression:**
- ✅ ?orderBy=month:asc|desc, count:asc|desc, deliveredCount:asc|desc
- ✅ ?from=2026-06&to=2026-08 (YYYY-MM format)
- ✅ Invalid format → HTTP 400 INVALID_MONTH_FORMAT

---

#### ✅ TC-5.3: Quarterly & Annual Trends
**Steps:**
```bash
GET /api/travel/webcheckins/by-quarter
GET /api/travel/webcheckins/by-year
```

**Expected:**
- ✅ Same aggregation logic, different bucket format (YYYY-Q[1-4], YYYY)
- ✅ Includes `bySubBrand` breakdown per bucket

---

#### ✅ TC-5.4: Automation Health (Per-Airline Success Rate)
**Steps:**
```bash
GET /api/travel/automation-health/per-airline?windowHours=24
```

**Expected:**
```json
{
  "windowHours": 24,
  "perAirline": [
    {
      "airlineCode": "6E",
      "total": 5,
      "success": 3,
      "failure": 1,
      "captcha": 1,
      "notImplemented": 0,
      "successRate": 0.75,
      "lastFailureAt": "2026-07-13T10:30:00Z"
    },
    {
      "airlineCode": "AI",
      "total": 3,
      "success": 3,
      "failure": 0,
      "captcha": 0,
      "notImplemented": 0,
      "successRate": 1.0,
      "lastFailureAt": null
    }
  ]
}
```

**Notes:**
- ✅ successRate = success / (success + failure + captcha)  
  - **NOT** including notImplemented in denominator (these are adapter-missing, not degraded)
- ✅ ?windowHours=24|48|168 (max 7 days)

**Regression:**
- ✅ No failures → successRate: null (avoid 0/0)
- ✅ All not-implemented → successRate: null

---

### 4.6 Upcoming Window

#### ✅ TC-6.1: Upcoming Check-ins (≤48h)
**Precondition:**
- WebCheckin with windowOpenAt < now + 48h
- status in (pending, reminded)

**Steps:**
```bash
GET /api/travel/webcheckins/upcoming
```

**Expected:**
- ✅ Returns only pending/reminded rows with windowOpenAt ≤ 48h from now
- ✅ Sorted by windowOpenAt ascending (earliest first)
- ✅ Useful for dashboard tile: "8 check-ins opening in next 48h"

---

### 4.7 Permissions & Multi-Tenant

#### ✅ TC-7.1: Cross-Tenant Isolation
**Precondition:**
- Two tenants (A=100, B=101)
- User belongs to tenant A only

**Steps:**
```bash
GET /api/travel/webcheckins  # Should see only tenant A rows
POST /api/travel/webcheckins  # Creates under tenant A

# Try to access tenant B's row
GET /api/travel/webcheckins/999  # Belongs to tenant B
→ HTTP 404 (row invisible to user)
```

**Expected:**
- ✅ Global middleware enforces `tenantId` from JWT
- ✅ All queries filtered by `req.travelTenant.id`
- ✅ No cross-tenant data leakage

---

#### ✅ TC-7.2: Sub-Brand Narrowing
**Precondition:**
- Manager user with subBrandAccess = ['tmc'] (not 'rfu', 'visa-sure')
- WebCheckins exist under both tmc & rfu sub-brands

**Steps:**
```bash
GET /api/travel/webcheckins/stats
```

**Expected:**
- ✅ bySubBrand shows only tmc rows (not rfu)
- ✅ Query pre-filters by allowed sub-brands
- ✅ Improves query performance (fewer rows scanned)

**Regression:**
- ✅ ADMIN sees all sub-brands (unrestricted)
- ✅ USER with no subBrandAccess restriction sees all (same as ADMIN)

---

#### ✅ TC-7.3: Permission Gates
**Steps:**
```bash
# USER (no web_checkins.write) attempts create
POST /api/travel/webcheckins
→ HTTP 403 Forbidden

# USER (no web_checkins.delete) attempts delete
DELETE /api/travel/webcheckins/123
→ HTTP 403 Forbidden

# MANAGER (web_checkins.read) can list
GET /api/travel/webcheckins
→ HTTP 200 OK

# MANAGER (web_checkins.update) can patch
PATCH /api/travel/webcheckins/123
→ HTTP 200 OK
```

**Expected:**
- ✅ Enforcement via requirePermission middleware
- ✅ Consistent across all CRUD endpoints

---

## 5. ACCEPTANCE CRITERIA

### Must-Pass Tests
- ✅ All TC-1.x (CRUD) pass
- ✅ All TC-2.x (State Machine) pass
- ✅ All TC-3.x (Upload) pass
- ✅ All TC-4.x (Delivery) pass
- ✅ All TC-5.x (Reporting) pass
- ✅ All TC-7.x (Permissions) pass
- ✅ No regression in existing travel routes
- ✅ No data corruption in WebCheckin table

### Nice-to-Have Tests
- ✅ Performance: /stats endpoint < 200ms for 10k rows
- ✅ Load: 100 concurrent POST /webcheckins requests
- ✅ Audit: every create/update logged (if audit enabled)

### Known Limitations (Document, Don't Block)
- ❌ Real airline automation (Playwright) not implemented
- ❌ Real WhatsApp delivery not available (stub only)
- ❌ Window open time calculation (T-48h) is hard-coded; no per-airline override yet

---

## 6. TEST EXECUTION GUIDE

### Pre-Test Checklist
```bash
# 1. Start backend & database
cd backend
npm install
npx prisma db push
npm run dev

# 2. Seed demo data
node prisma/seed.js

# 3. Enable stub adapter
export WEBCHECKIN_AUTOMATION_STUB=1

# 4. Verify health
curl http://localhost:5000/api/health
→ Should return 200 with uptime

# 5. Create travel tenant + test data (use TC data from §3)
```

### Running Tests

#### Manual Testing (Staging/Demo)
```bash
# Test via REST client (Postman, VSCode REST Client, curl)
# Create WebCheckin
curl -X POST http://localhost:5000/api/travel/webcheckins \
  -H "Authorization: Bearer {JWT}" \
  -H "Content-Type: application/json" \
  -d '{...payload...}'

# Monitor automation health
curl http://localhost:5000/api/travel/automation-health/per-airline

# Upload boarding pass
curl -X POST http://localhost:5000/api/travel/webcheckins/123/upload-boarding-pass \
  -H "Authorization: Bearer {JWT}" \
  -F "file=@boarding-pass.pdf"
```

#### Automated E2E Tests (Playwright)
```bash
cd e2e
npm install
npx playwright test --grep "webcheckin" --project=chromium
```

### Test Execution Timeline

| Phase | Duration | Activities |
|-------|----------|-----------|
| Setup | 30 min | DB setup, demo data, auth |
| Smoke | 15 min | Health checks, basic CRUD |
| Functional | 2-3 hrs | All TC scenarios |
| Regression | 1 hr | Cross-route impact, existing tests |
| Load | 30 min | Concurrent requests, perf checks |
| **Total** | **~4-5 hrs** | Full QA cycle |

---

## 7. BUG REPORT TEMPLATE

When reporting issues, use this template:

```markdown
## Bug Title
[Concise 1-liner]

## Severity
[ ] Critical (feature broken, data lost)
[ ] High (core path blocked, workaround exists)
[ ] Medium (edge case, minor workflow impact)
[ ] Low (cosmetic, no user impact)

## Test Case
TC-X.Y: [Name from §4]

## Precondition
- Tenant: QA Travel Booking Co (ID 100)
- User: manager@qa.demo
- WebCheckin: [ID, status, details]

## Steps to Reproduce
1. ...
2. ...
3. ...

## Expected Result
...

## Actual Result
...

## Logs
[Console output, network trace, database query results]

## Affected Routes
- POST /api/travel/webcheckins
- GET /api/travel/webcheckins/stats
```

---

## 8. REGRESSION TEST SUITE

### Existing Routes That Must NOT Break
- `POST /api/travel/itineraries` — WebCheckin auto-create on accept
- `PATCH /api/travel/itineraries/:id/accept` — Should trigger seed-webcheckin logic
- `GET /api/contacts` — Must not be affected
- `GET /api/travel/trips` — Must not be affected
- `PATCH /api/travel/itineraries/:id` — Should not touch WebCheckin
- `DELETE /api/travel/itineraries/:id` — Cascade-delete WebCheckins or soft-delete?

### Test (Regression Check)
```bash
# Accept itinerary → should auto-create WebCheckins (not affected by new feature)
PATCH /api/travel/itineraries/67/accept

# Verify old endpoints still work
GET /api/contacts
GET /api/travel/trips
GET /api/travel/itineraries
```

---

## 9. ENVIRONMENT CONFIGURATION

### Local Development (docker-compose)
```yaml
# docker-compose.yml (already present in repo)
services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: crm
      MYSQL_ROOT_PASSWORD: root
    ports:
      - "3307:3306"
```

```bash
# .env for backend
WEBCHECKIN_AUTOMATION_STUB=1
DATABASE_URL=mysql://root:root@localhost:3307/crm
NODE_ENV=development
JWT_SECRET=dev-secret-key
FRONTEND_URL=http://localhost:5173
PUBLIC_BASE_URL=http://localhost:5000
```

### Staging (Demo Server)
```bash
# crm.globusdemos.com environment
WEBCHECKIN_AUTOMATION_STUB=1  # Keep enabled until Playwright ready
DATABASE_URL=mysql://user:pwd@localhost:3306/gbscrm
NODE_ENV=production
JWT_SECRET=<from-secrets>
PUBLIC_BASE_URL=https://crm.globusdemos.com
```

---

## 10. KNOWN ISSUES & LIMITATIONS

### Blockers (Should NOT Test)
1. **Real Airline Automation** — Blocked on PRD DC-1/DC-3/DC-5 (Playwright implementation)
2. **Real WhatsApp Delivery** — Blocked on Q9 (Wati BSP credentials)
3. **Airline-Specific Window Overrides** — Not implemented (hard-coded T-48h)

### Workarounds
- ✅ Use `WEBCHECKIN_AUTOMATION_STUB=1` for predictable test outcomes
- ✅ Use PNR prefixes to drive outcomes:
  - `CAPTCHA-*` → captcha
  - `FAIL-*` → transient failure
  - `DOWN-*` → portal-down
  - Else → success
- ✅ Manual upload path works today (no Playwright needed)

---

## 11. SIGN-OFF & APPROVAL

| Role | Name | Signature | Date |
|------|------|-----------|------|
| QA Lead | ______________ | ______________ | ________ |
| Dev Lead | ______________ | ______________ | ________ |
| Product Owner | ______________ | ______________ | ________ |

### Test Execution Summary
- **Total Tests Defined:** 23 test cases (TC-1.1 to TC-7.3)
- **Total Tests Passed:** _____ / 23
- **Total Tests Failed:** _____ / 23
- **Regression Tests Passed:** _____ / 10
- **Coverage:** API ✅, DB ✅, State Machine ✅, Permissions ✅, Reporting ✅

### Blockers Before Release
- [ ] All Critical tests passed
- [ ] All High tests passed
- [ ] No data corruption observed
- [ ] Cross-tenant isolation verified
- [ ] Existing routes regression-tested

---

## 12. APPENDIX: QUICK REFERENCE

### API Endpoint Matrix

| Operation | Method | Endpoint | Permission |
|-----------|--------|----------|-----------|
| List | GET | `/api/travel/webcheckins` | read |
| Create | POST | `/api/travel/webcheckins` | write |
| Fetch | GET | `/api/travel/webcheckins/:id` | read |
| Update | PATCH | `/api/travel/webcheckins/:id` | update |
| Delete | DELETE | `/api/travel/webcheckins/:id` | delete |
| Upload | POST | `/api/travel/webcheckins/:id/upload-boarding-pass` | update |
| Deliver | POST | `/api/travel/webcheckins/:id/deliver` | update |
| Retry Auto | POST | `/api/travel/webcheckins/:id/automation/retry` | update |
| Stats | GET | `/api/travel/webcheckins/stats` | read |
| Health | GET | `/api/travel/automation-health/per-airline` | read |

### PNR Prefixes (Stub Adapter)
- `CAPTCHA-*` → Captcha challenge (no retry)
- `FAIL-*` → Transient failure (retry 3×)
- `DOWN-*` → Portal down (retry 3×)
- Other → Success (boarding pass generated)

### Status Transitions
```
pending → in-progress → done       (automation success)
pending → reminded → fallback-agent  (automation failed, retry)
pending → fallback-agent            (not-implemented)
fallback-agent → done               (manual upload)
```

### Demo Credentials
```
Admin:   admin@globussoft.com / password123
Manager: manager@crm.com / password123
User:    user@crm.com / password123
```

---

**End of QA Test Plan**

**Document Version:** 1.0  
**Last Updated:** 2026-07-01  
**Status:** Ready for QA Execution  
**Next Review:** After Phase 1 UAT Completion
