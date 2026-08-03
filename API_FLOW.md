# Callified API Flow — Login → Campaigns → Leads → AI Dial

This document describes the end-to-end API flow for authenticating with email/password, listing campaigns, adding a lead, enrolling it in a campaign, deleting a lead, triggering an AI/browser call, retrieving the call transcript and AI review, and retrieving call outcomes (duration, recording, sentiment, summary, cost).

---

## Base URL

```
https://app.callified.ai/api
```

All authenticated requests must include the header:

```
Authorization: Bearer <access_token>
```

---

## Step 1 — Login (get token)

Obtain a JWT by sending the user's email and password.

**Endpoint**

```http
POST /api/auth/login
```

**Headers**

```
Content-Type: application/json
```

**Request body**

```json
{
  "email": "admin@example.com",
  "password": "your-password"
}
```

**Example response — 200 OK**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token_type": "bearer",
  "user": {
    "id": 1,
    "email": "admin@example.com",
    "full_name": "Admin User",
    "role": "Admin",
    "org_id": 1,
    "org_name": "Acme Inc"
  }
}
```

> Save the `access_token` value. It is required for every subsequent request.

### Postman

1. Create a new request.
2. Method: `POST`.
3. URL: `https://app.callified.ai/api/auth/login`.
4. Go to **Body** → select **raw** → select **JSON**.
5. Paste the request body above.
6. Click **Send**.
7. Copy the `access_token` from the response.

---

## Step 2 — List campaigns

List all campaigns for the authenticated user's organisation. Filter for `status: "active"` to see running campaigns.

**Endpoint**

```http
GET /api/campaigns
```

**Headers**

```
Authorization: Bearer <access_token>
```

**Example response — 200 OK**

```json
[
  {
    "id": 42,
    "org_id": 1,
    "product_id": 7,
    "name": "Summer Voice Campaign",
    "status": "active",
    "tts_provider": "elevenlabs",
    "tts_voice_id": "Rachel",
    "tts_language": "en",
    "lead_source": "Website",
    "channel": "voice",
    "product_name": "AI Sales Bot",
    "created_at": "2026-06-15 09:30:00",
    "stats": {
      "total": 150,
      "called": 89,
      "qualified": 34,
      "appointments": 12
    }
  }
]
```

### Postman

1. Create a new request.
2. Method: `GET`.
3. URL: `https://app.callified.ai/api/campaigns`.
4. Go to **Headers**.
5. Add key `Authorization` with value `Bearer <access_token>`.
6. Click **Send**.
7. Note the `id` of the campaign you want to use.

---

## Step 3 — Add a lead

Adding a lead is a two-step process: create the lead, then enrol it into a campaign.

### 3a. Create the lead

**Endpoint**

```http
POST /api/leads
```

**Headers**

```
Content-Type: application/json
Authorization: Bearer <access_token>
```

**Request body**

```json
{
  "first_name": "Rahul",
  "last_name": "Sharma",
  "phone": "011-1234-5678",
  "company": "Acme Inc",
  "source": "Website",
  "interest": "AI Sales Bot",
  "executive_id": 0
}
```

> Fields:
> - `first_name` (required) — lead first name.
> - `last_name` (optional) — lead last name.
> - `phone` (required) — valid Indian phone number.
> - `company` (optional) — company or organisation name.
> - `source` (optional) — lead source, e.g. `Website`, `CSV`, `Manual`.
> - `interest` (optional) — product or interest note.
> - `executive_id` (optional) — assign the lead to a specific agent/executive user ID.

> Phone formats accepted:
> - `9876543210` (10-digit mobile)
> - `01112345678` (landline with STD code)
> - `+919876543210` / `+91-11-1234-5678`

**Example response — 201 Created**

```json
{
  "id": 101
}
```

### Postman — create lead

1. Method: `POST`.
2. URL: `https://app.callified.ai/api/leads`.
3. **Headers**: `Content-Type: application/json`, `Authorization: Bearer <access_token>`.
4. **Body** → **raw** → **JSON**: paste the request body.
5. Click **Send** and copy the returned `id`.

---

### 3b. Enrol lead into campaign

**Endpoint**

```http
POST /api/campaigns/{campaign_id}/leads
```

Replace `{campaign_id}` with the campaign ID from Step 2.

**Headers**

```
Content-Type: application/json
Authorization: Bearer <access_token>
```

**Request body**

```json
{
  "lead_ids": [101]
}
```

**Example response — 200 OK**

```json
{
  "added": 1
}
```

### Postman — add to campaign

1. Method: `POST`.
2. URL: `https://app.callified.ai/api/campaigns/42/leads` (replace `42` with your campaign ID).
3. **Headers**: `Content-Type: application/json`, `Authorization: Bearer <access_token>`.
4. **Body** → **raw** → **JSON**: paste `{"lead_ids": [<lead_id>]}`.
5. Click **Send**.

---

### 3c. Delete a lead

Permanently remove a lead from the organisation. The lead is also removed from any campaigns it was enrolled in.

**Endpoint**

```http
DELETE /api/leads/{lead_id}
```

**Headers**

```
Authorization: Bearer <access_token>
```

**Request body**

None.

**Example response — 200 OK**

```json
{
  "deleted": true
}
```

### Postman — delete lead

1. Method: `DELETE`.
2. URL: `https://app.callified.ai/api/leads/101`.
3. **Headers**: `Authorization: Bearer <access_token>`.
4. Click **Send**.

---

## Step 4 — Call the lead

There are three ways to call a lead: AI dial inside a campaign, browser (agent bridge) call inside a campaign, or single lead dial outside a campaign context.

### 4a. AI dial inside a campaign

Trigger an outbound AI call to a specific lead using the campaign's voice settings.

**Endpoint**

```http
POST /api/campaigns/{campaign_id}/dial/{lead_id}
```

**Headers**

```
Authorization: Bearer <access_token>
```

**Request body**

None.

**Example response — 200 OK**

```json
{
  "dialed": true
}
```

### Postman — AI dial

1. Method: `POST`.
2. URL: `https://app.callified.ai/api/campaigns/42/dial/101` (replace IDs as needed).
3. **Headers**: `Authorization: Bearer <access_token>`.
4. **Body**: none.
5. Click **Send**.

---

### 4b. Browser (agent bridge) call inside a campaign

Trigger an outbound call where the audio is bridged to the agent's browser. The agent connects via `/ws/agent?call_sid=...`.

**Endpoint**

```http
POST /api/campaigns/{campaign_id}/leads/{lead_id}/browser-call
```

**Headers**

```
Content-Type: application/json
Authorization: Bearer <access_token>
```

**Request body (optional)**

```json
{
  "exotel_account_id": 1,
  "scheduled_call_id": 0
}
```

> - `exotel_account_id` — optional Exotel account to use.
> - `scheduled_call_id` — optional scheduled callback ID to claim and connect.

**Example response — 200 OK**

```json
{
  "call_sid": "EXotel123abc",
  "agent_url": "/ws/agent?call_sid=EXotel123abc",
  "status": "dialing"
}
```

### Postman — browser call

1. Method: `POST`.
2. URL: `https://app.callified.ai/api/campaigns/42/leads/101/browser-call`.
3. **Headers**: `Content-Type: application/json`, `Authorization: Bearer <access_token>`.
4. **Body** (optional): `{"exotel_account_id": 1}`.
5. Click **Send**.
6. Use the returned `agent_url` to open the agent WebSocket.

---

### 4c. Single lead dial outside a campaign

Dial a lead directly without a campaign path. Optionally pass a campaign ID in the body to use that campaign's voice settings.

**Endpoint**

```http
POST /api/dial/{lead_id}
```

**Headers**

```
Content-Type: application/json
Authorization: Bearer <access_token>
```

**Request body (optional)**

```json
{
  "campaign_id": 42
}
```

**Example response — 200 OK**

```json
{
  "dialed": true
}
```

### Postman — single lead dial

1. Method: `POST`.
2. URL: `https://app.callified.ai/api/dial/101`.
3. **Headers**: `Content-Type: application/json`, `Authorization: Bearer <access_token>`.
4. **Body** (optional): `{"campaign_id": 42}`.
5. Click **Send**.

---

## Step 5 — Retrieve call summary / transcript

After the call completes, fetch transcripts and the AI-generated review.

### 5a. All transcripts for a lead

**Endpoint**

```http
GET /api/leads/{lead_id}/transcripts
```

**Headers**

```
Authorization: Bearer <access_token>
```

**Example response — 200 OK**

```json
[
  {
    "id": 501,
    "lead_id": 101,
    "campaign_id": 42,
    "transcript": [
      {"role": "agent", "text": "Hello, this is Rachel from Acme."},
      {"role": "user", "text": "Hi, tell me more."}
    ],
    "recording_url": "/api/recordings/rec_2026_abc.wav",
    "tts_language": "en",
    "call_duration_s": 56.78,
    "created_at": "2026-07-02 14:22:10"
  }
]
```

### Postman

1. Method: `GET`.
2. URL: `https://app.callified.ai/api/leads/101/transcripts`.
3. **Headers**: `Authorization: Bearer <access_token>`.
4. Click **Send**.

---

### 5b. AI review for a transcript

Use the `id` from the transcript object above as `{transcript_id}`.

**Endpoint**

```http
GET /api/transcripts/{transcript_id}/review
```

**Example response — 200 OK**

```json
{
  "id": 55,
  "transcript_id": 501,
  "org_id": 1,
  "quality_score": 8.5,
  "sentiment": "positive",
  "appointment_booked": true,
  "failure_reason": "",
  "what_went_well": "Agent greeted clearly and asked discovery questions.",
  "what_went_wrong": "",
  "summary": "Customer showed strong interest and agreed to a demo.",
  "insights": "Use this opening for similar leads.",
  "prompt_improvement_suggestion": "Add pricing mention earlier.",
  "created_at": "2026-07-02 14:25:00"
}
```

### Postman

1. Method: `GET`.
2. URL: `https://app.callified.ai/api/transcripts/501/review`.
3. **Headers**: `Authorization: Bearer <access_token>`.
4. Click **Send**.

---

## Complete curl script

```bash
# 1. Login
TOKEN=$(curl -s -X POST https://app.callified.ai/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}' | jq -r '.access_token')

# 2. List campaigns
CAMPAIGN_ID=$(curl -s https://app.callified.ai/api/campaigns \
  -H "Authorization: Bearer $TOKEN" | jq '.[0].id')

# 3a. Create lead (Delhi landline example)
LEAD_ID=$(curl -s -X POST https://app.callified.ai/api/leads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Rahul","last_name":"Sharma","phone":"011-1234-5678","company":"Acme Inc","source":"Website","interest":"AI Sales Bot"}' | jq -r '.id')

# 3b. Add lead to campaign
curl -s -X POST https://app.callified.ai/api/campaigns/$CAMPAIGN_ID/leads \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"lead_ids\":[$LEAD_ID]}"

# 4a. AI dial inside campaign
curl -s -X POST https://app.callified.ai/api/campaigns/$CAMPAIGN_ID/dial/$LEAD_ID \
  -H "Authorization: Bearer $TOKEN"

# 4b. Browser (agent bridge) call inside campaign
curl -s -X POST https://app.callified.ai/api/campaigns/$CAMPAIGN_ID/leads/$LEAD_ID/browser-call \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"exotel_account_id": 1}'

# 4c. Single lead dial outside campaign (optionally pass campaign_id for voice settings)
curl -s -X POST https://app.callified.ai/api/dial/$LEAD_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"campaign_id\":$CAMPAIGN_ID}"

# 5a. Get transcripts
curl -s https://app.callified.ai/api/leads/$LEAD_ID/transcripts \
  -H "Authorization: Bearer $TOKEN"

# 5b. Get AI review for first transcript
TRANSCRIPT_ID=$(curl -s https://app.callified.ai/api/leads/$LEAD_ID/transcripts \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
curl -s https://app.callified.ai/api/transcripts/$TRANSCRIPT_ID/review \
  -H "Authorization: Bearer $TOKEN"

# 6. Delete lead
curl -s -X DELETE https://app.callified.ai/api/leads/$LEAD_ID \
  -H "Authorization: Bearer $TOKEN"
```

## Step 6 — Retrieve call outcome, duration, recording, sentiment, and summary

After a call ends, the details you need are stored across a few tables. There is no single endpoint that returns everything yet.

| Detail | Source | API endpoint |
|--------|--------|--------------|
| Outcome, duration, recording | `call_transcripts` + `leads.status` | `GET /api/campaigns/{campaign_id}/call-log` |
| Sentiment, summary, quality score | `call_reviews` | `GET /api/transcripts/{transcript_id}/review` |
| Cost (credit deduction) | `credit_transactions` | `GET /api/billing/credits/transactions` (org-wide, last 50) |

### 6a. Get call log for a campaign

**Endpoint**

```http
GET /api/campaigns/{campaign_id}/call-log
```

**Example response — 200 OK**

```json
[
  {
    "id": 501,
    "first_name": "Rahul",
    "last_name": "Sharma",
    "phone": "9876543210",
    "source": "Website",
    "lead_status": "contacted",
    "call_duration_s": 56.7,
    "recording_url": "/recordings/rec_abc.wav",
    "created_at": "2026-07-27 14:22:10",
    "outcome": "Connected"
  }
]
```

### 6b. Get sentiment and summary for a call

Use the `id` from the call log as the `transcript_id`.

**Endpoint**

```http
GET /api/transcripts/{transcript_id}/review
```

**Example response — 200 OK**

```json
{
  "id": 55,
  "transcript_id": 501,
  "sentiment": "positive",
  "summary": "Customer showed strong interest and agreed to a demo.",
  "appointment_booked": true,
  "failure_reason": "",
  "quality_score": 8.5
}
```

### 6c. Get call cost (org-wide ledger)

**Endpoint**

```http
GET /api/billing/credits/transactions
```

**Example response — 200 OK**

```json
[
  {
    "id": 123,
    "org_id": 1,
    "delta_paise": -470,
    "balance_after_paise": 1999530,
    "type": "exotel_abc123",
    "reference": "exotel_abc123",
    "call_duration_s": 56.7,
    "rate_per_min_paise": 500,
    "created_at": "2026-07-27 14:22:10"
  }
]
```

> `delta_paise` is negative for call charges. The `type`/`reference` field is the `call_sid`, but the call-log API does not currently expose `call_sid`, so matching a specific call to its cost requires backend changes.

### 6d. Webhook after a call

You can also receive a `call.completed` webhook. The payload includes:

```json
{
  "transcript_id": 501,
  "lead_id": 101,
  "campaign_id": 42,
  "duration_s": 56.7,
  "sentiment": "positive",
  "appointment_booked": true
}
```

Then call `GET /api/transcripts/{transcript_id}/review` to fetch the full summary.

---

## Postman collection tips

- Create a collection named **Callified Flow**.
- Add a collection variable `base_url` = `https://app.callified.ai/api`.
- Add a collection variable `token` (empty initially).
- In the **Login** request, add a **Tests** script to save the token automatically:

```js
var jsonData = pm.response.json();
pm.collectionVariables.set("token", jsonData.access_token);
```

- For all other requests, set the header:

```
Authorization: Bearer {{token}}
```

- Use Postman variables like `{{base_url}}`, `{{campaign_id}}`, and `{{lead_id}}` so you only need to update values in one place.
