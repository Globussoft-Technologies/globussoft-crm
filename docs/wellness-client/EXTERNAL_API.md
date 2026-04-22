# Globussoft CRM — External Partner API (v1)

**Base URL:** `https://crm.globusdemos.com/api/v1/external`
**Auth:** `X-API-Key: glbs_<48-hex-chars>` header on every request
**Audience:** Sister Globussoft products — currently **Callified.ai** (voice + WhatsApp) and **Globus Phone** (softphone). Future: any internal product that needs CRM data.

---

## 1. End-to-end flow this API supports

```
┌──────────┐   POST /leads     ┌────────────┐
│ Website  │ ────────────────▶ │ Globussoft │
│ form     │                    │ CRM        │
└──────────┘                    └─────┬──────┘
                                      │ GET /leads?since=…
                                      │  (Callified polls every minute)
                                      ▼
                              ┌──────────────┐
                              │ Callified.ai │   1. AI dials the lead
                              │ or Globus    │   2. Records the call
                              │ Phone        │   3. Stores recording URL
                              └──────┬───────┘
                                     │ POST /calls
                                     │  { contactId, recordingUrl, ... }
                                     ▼
                              ┌──────────────┐
                              │ CRM CallLog  │ ← user plays recording from
                              │              │   the URL inside the CRM UI
                              └──────────────┘
```

Recording stays on the dialer's storage; the CRM only stores the URL. The CRM user clicks the call log → the `<audio>` player streams from Callified/Globus Phone.

---

## 2. Getting an API key

Each partner gets one or more API keys, scoped to a **tenant**. A key gives full read/write access to that tenant's CRM data — treat it like a password.

### Demo keys (Enhanced Wellness tenant)

The seed script creates two on every run. Find them in the seed output:

```
$ node prisma/seed-wellness.js
…
[seed-wellness] partner API keys (give these to the respective teams):
  [exists] Callified.ai (demo key)        glbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  [exists] Globus Phone (demo key)        glbs_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy
```

(Or query the DB directly: `SELECT name, keySecret FROM ApiKey WHERE tenantId=2;`)

### Generating a key for a real partner

Either:
- Log in to the CRM as the tenant ADMIN, go to **Developer** → **API Keys** → **Generate**, OR
- POST to `/api/developer/apikeys` with a JWT.

Keys are stored plaintext in DB (matches existing convention). Future hardening will move to hashed storage.

---

## 3. Reference

All endpoints return JSON. Error shape:

```json
{ "error": "Human-readable message", "code": "OPTIONAL_MACHINE_CODE" }
```

Status codes: `200 OK`, `201 Created`, `400 Bad Request`, `401 Unauthorized` (missing/bad key), `403 Forbidden` (tenant inactive), `404 Not Found`, `500 Server Error`.

---

### 3.1 Health & tenant info

**GET `/health`** — ping. No auth required.
```json
{ "status": "ok", "apiVersion": "v1" }
```

**GET `/me`** — who am I, what tenant am I scoped to.
```json
{
  "tenant": { "id": 2, "name": "Enhanced Wellness", "slug": "enhanced-wellness", "vertical": "wellness", "plan": "professional" },
  "apiKey": { "id": 7, "name": "Callified.ai (demo key)", "lastUsed": "2026-04-22T12:34:56.000Z" },
  "capabilities": { "wellness": true }
}
```

---

### 3.2 Lead lifecycle (the core flow)

#### POST `/leads` — create a new lead in the CRM

The **website** calls this when a form is submitted. Callified can also call this when a new caller is identified.

```
POST /api/v1/external/leads
X-API-Key: glbs_…
Content-Type: application/json

{
  "name": "Aarav Sharma",
  "phone": "+919876543210",
  "email": "aarav@example.com",
  "source": "website-form",
  "note": "Enquiry about hair transplant",
  "utm": { "source": "meta", "campaign": "hair_transplant_oct" }
}
```

**Response 201:**
```json
{
  "id": 1234,
  "name": "Aarav Sharma",
  "email": "aarav@example.com",
  "phone": "+919876543210",
  "status": "Lead",
  "source": "website-form",
  "createdAt": "2026-04-22T10:00:00.000Z"
}
```

**Idempotency:** if a contact with the same email already exists, returns `200 OK` with the existing contact (with `_deduped: true`).

**Required fields:** at least one of `name`, `phone`, `email`.

#### GET `/leads?since=…` — poll for new leads

Callified polls this every 60 seconds. `since` is an ISO datetime; only leads created at or after `since` are returned.

```
GET /api/v1/external/leads?since=2026-04-22T09:55:00Z&source=website-form&limit=100
X-API-Key: glbs_…
```

**Response 200:**
```json
{
  "data": [
    {
      "id": 1234, "name": "Aarav Sharma", "email": "...", "phone": "+919876543210",
      "source": "website-form", "firstTouchSource": "website-form",
      "status": "Lead", "aiScore": 0,
      "createdAt": "2026-04-22T10:00:00.000Z"
    }
  ],
  "total": 1,
  "since": "2026-04-22T09:55:00Z"
}
```

**Optional filters:** `source`, `limit` (default 100, max 200).

---

### 3.3 Calls — push the recording back

#### POST `/calls` — log a completed call

After the dialer finishes a call, push the record back so it shows up in the CRM contact's history. Recording stays at your URL; CRM streams from there.

```
POST /api/v1/external/calls
X-API-Key: glbs_…

{
  "contactId": 1234,                       // from POST /leads response
  "phone": "+919876543210",
  "direction": "OUTBOUND",                 // INBOUND | OUTBOUND
  "status": "COMPLETED",                   // COMPLETED | MISSED | FAILED | …
  "durationSec": 187,
  "recordingUrl": "https://callified.ai/recordings/abc.mp3",
  "providerCallId": "callified_call_xyz789",   // for idempotency
  "provider": "callified",
  "notes": "Customer wants pricing for hair transplant. Follow up in 3 days.",
  "agentUserId": 12                        // optional — CRM user who handled it
}
```

**Response 201:** the created CallLog row.

The CRM UI will render `recordingUrl` as a `<audio>` player so the staff member can play it back without leaving the CRM.

---

### 3.4 Messages — log WhatsApp / SMS exchanges

#### POST `/messages`

```
POST /api/v1/external/messages
X-API-Key: glbs_…

{
  "channel": "whatsapp",                   // whatsapp | sms
  "direction": "INBOUND",                  // INBOUND | OUTBOUND
  "phone": "+919876543210",
  "contactId": 1234,                       // optional but recommended
  "body": "Hi, I want to know hair transplant cost",
  "mediaUrl": "https://callified.ai/media/img1.jpg",   // optional
  "mediaType": "image/jpeg",               // optional
  "providerMsgId": "wamid.HBgL…",          // for idempotency
  "status": "RECEIVED"                     // QUEUED | SENT | DELIVERED | READ | FAILED | RECEIVED
}
```

**Response 201:** the created WhatsAppMessage / SmsMessage row.

---

### 3.5 Lookup — identify a caller

#### GET `/contacts/lookup?phone=…`

When an inbound call rings, look up who's calling. Match is on the last 10 digits (Indian-mobile-friendly).

```
GET /api/v1/external/contacts/lookup?phone=9876543210
X-API-Key: glbs_…
```

**Response 200** (found):
```json
{ "id": 1234, "name": "Aarav Sharma", "email": "...", "phone": "+919876543210",
  "status": "Lead", "source": "website-form", "company": null, "aiScore": 35,
  "assignedToId": 12, "createdAt": "2026-04-22T10:00:00.000Z" }
```

**Response 404** (not found): `{ "error": "Contact not found", "code": "NOT_FOUND" }`

You can also lookup by `?email=…`.

#### GET `/contacts/:id`

Full contact incl. last 20 activities + deals.

#### GET `/patients/lookup?phone=…` (wellness tenants only)

Same shape as contacts/lookup but searches the Patient table — relevant for clinical-CRM tenants.

#### GET `/patients/:id`

Full patient incl. last 20 visits, treatment plans, and last 10 prescriptions. Use this to give the AI calling agent context like "you are calling Aarav, who had a hair transplant on Apr 5 and is due for follow-up."

---

### 3.6 Catalogs — what to pitch on the call

#### GET `/services` (wellness)

```
GET /api/v1/external/services?category=hair-transplant&tier=high&limit=20
```

```json
{ "data": [
    { "id": 1, "name": "Ultra Receptive Hair Transplant", "category": "hair-transplant",
      "ticketTier": "high", "basePrice": 200000, "durationMin": 540,
      "targetRadiusKm": 200, "description": "..." }
  ],
  "total": 1
}
```

Filters: `?category=hair-transplant`, `?tier=high|medium|low`.

#### GET `/staff`

```json
{ "data": [
    { "id": 1, "name": "Demo Admin", "email": "admin@wellness.demo",
      "role": "ADMIN", "wellnessRole": null },
    { "id": 3, "name": "Dr. Harsh Kumar", "email": "drharsh@enhancedwellness.in",
      "role": "USER", "wellnessRole": "doctor" }
  ],
  "total": 22
}
```

Use `wellnessRole` to find the right specialist for a service category.

#### GET `/locations`

```json
{ "data": [
    { "id": 1, "name": "Ranchi", "addressLine": "The Ikon, Tagore Hill Road, Morabadi",
      "city": "Ranchi", "state": "Jharkhand", "pincode": "834008",
      "phone": "+91 9637866666", "email": "ranchi@enhancedwellness.in",
      "latitude": 23.3978, "longitude": 85.3192,
      "hours": "{...}", "isActive": true }
  ],
  "total": 1
}
```

---

### 3.7 Appointments

#### GET `/appointments?date=YYYY-MM-DD`

Today's schedule by default. Filters: `?date=`, `?from=&to=`, `?status=booked`, `?locationId=`.

```json
{ "data": [
    {
      "id": 99, "visitDate": "2026-04-22T10:00:00.000Z", "status": "booked",
      "patient": { "id": 1234, "name": "Aarav Sharma", "phone": "+919876543210", "email": "..." },
      "service": { "id": 5, "name": "Hair PRP Therapy", "durationMin": 60, "basePrice": 5500 },
      "doctor":  { "id": 3, "name": "Dr. Harsh Kumar" }
    }
  ],
  "total": 1
}
```

#### POST `/appointments` — book a slot

After the AI agent qualifies the lead and the customer agrees on a slot:

```
POST /api/v1/external/appointments
X-API-Key: glbs_…

{
  "patientId": 1234,
  "serviceId": 5,
  "doctorId": 3,
  "locationId": 1,
  "slotStart": "2026-04-25T11:00:00+05:30",
  "notes": "Customer prefers morning slots",
  "status": "booked"
}
```

**Response 201:** the created Visit row.

If the caller is a `Contact` (not yet a `Patient`), create the Patient first via the (internal) wellness API or an admin will do it post-call. We can add a `POST /patients` external endpoint if needed — let us know.

---

## 4. Best practices

- **Always send `providerCallId` / `providerMsgId`** on POSTs — that's how we'll add idempotency in v1.1.
- **Poll `/leads?since=…` no more than once per minute.** Webhooks will replace polling in v1.1 — see §6.
- **Treat the API key like a password.** Don't commit it. Put it in a secret store / env var.
- **Phone format:** we accept E.164 (`+919876543210`) and Indian local (`9876543210`). Normalization compares last 10 digits.

---

## 5. Rate limits

Currently the global rate limit is 5,000 requests / 15 minutes per IP. Partner traffic shares this budget with browser traffic. If you're going to push high volume, tell us and we'll move you to a dedicated bucket.

---

## 6. Roadmap (v1.1+)

- **Webhooks** — `Webhook` model already exists. We'll let you POST to `/api/v1/external/webhooks` to register a URL, then we'll fire `lead.created`, `appointment.booked`, `call.logged`, etc. to your URL with HMAC signing. Replaces polling.
- **POST `/patients`** — create a patient (not just a contact). Wellness-only.
- **Idempotency on POSTs** — using `providerCallId` / `providerMsgId` to safely retry.
- **GraphQL endpoint** — for partners that want one round-trip to fetch contact + 20 activities + last call + last appointment.
- **Streaming endpoints** — long-poll `/events` for near-real-time updates without webhook setup.
- **Hashed API keys** — current keys are plaintext in DB; we'll migrate to hashed-with-prefix.

---

## 7. Quickstart

### cURL — pretend you're Callified picking up a new lead

```bash
KEY=glbs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
BASE=https://crm.globusdemos.com/api/v1/external

# 0. Sanity
curl -s "$BASE/health"
curl -s -H "X-API-Key: $KEY" "$BASE/me" | jq

# 1. Website pushes a lead
curl -s -X POST "$BASE/leads" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"name":"Aarav Sharma","phone":"+919876543210","email":"aarav@example.com","source":"website-form"}' | jq

# 2. Callified polls for new leads (last 5 min)
SINCE=$(date -u -d '5 minutes ago' +%FT%TZ)
curl -s -H "X-API-Key: $KEY" "$BASE/leads?since=$SINCE" | jq

# 3. Callified looks up the caller
curl -s -H "X-API-Key: $KEY" "$BASE/contacts/lookup?phone=9876543210" | jq

# 4. Callified pushes the call recording back
curl -s -X POST "$BASE/calls" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "contactId": 1234, "phone": "+919876543210",
    "direction": "OUTBOUND", "status": "COMPLETED", "durationSec": 187,
    "recordingUrl": "https://callified.ai/recordings/abc.mp3",
    "providerCallId": "callified_call_xyz789",
    "notes": "Wants pricing on hair transplant. Follow up Friday."
  }' | jq

# 5. Book a follow-up
curl -s -X POST "$BASE/appointments" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{
    "patientId": 1234, "serviceId": 5,
    "slotStart": "2026-04-25T11:00:00+05:30",
    "notes": "Confirmed via call"
  }' | jq
```

---

## 8. Contact

API issues / contract changes / new endpoint requests: reach out to the Globussoft CRM team via your account manager.
Source of truth for these endpoints: [`backend/routes/external.js`](../../backend/routes/external.js) on the `globussoft-crm` repo.
