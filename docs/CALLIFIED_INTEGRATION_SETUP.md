# Callified.ai Integration Setup Guide

## Overview

Callified.ai integrates with Globussoft CRM via the **External Partner API** at `/api/v1/external/`.

The CRM also calls Callified's `/api/external/transcripts` endpoint to fetch campaign data and transcripts.

**Authentication:**
- Callified → CRM: Use `X-API-Key` header (configured in Globussoft CRM admin)
- CRM → Callified: Use `X-API-Key` header (configured in Callified's API key settings)

---

## Authentication: X-API-Key Header

### Format
```
X-API-Key: glbs_<your-api-key-here>
```

### Example: cURL
```bash
curl -X GET "https://crm.globusdemos.com/api/v1/external/me" \
  -H "X-API-Key: glbs_YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json"
```

### Example: JavaScript/Node.js
```javascript
const response = await fetch('https://crm.globusdemos.com/api/v1/external/calls', {
  method: 'POST',
  headers: {
    'X-API-Key': 'glbs_YOUR_API_KEY_HERE',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    phone: '+919876543210',
    direction: 'INBOUND',
    duration: 45,
    status: 'COMPLETED',
  }),
});
```

---

## Available Endpoints

### 1. Health Check (No Auth Required)
```
GET /api/v1/external/health
```
Returns `{ status: "ok", apiVersion: "v1" }`

Use this to verify the API is reachable BEFORE configuring your key.

---

### 2. Verify Your API Key
```
GET /api/v1/external/me
```
**Requires:** `X-API-Key: glbs_YOUR_API_KEY`

Returns tenant info, your API key, and capabilities:
```json
{
  "tenant": {
    "id": 1,
    "name": "Enhanced Wellness",
    "slug": "enhanced-wellness",
    "vertical": "wellness",
    "plan": "professional"
  },
  "apiKey": {
    "id": 1,
    "name": "Callified.ai",
    "lastUsed": "2026-05-11T10:30:00Z"
  },
  "capabilities": {
    "wellness": true
  }
}
```

---

### 3. Create/Log a Call
```
POST /api/v1/external/calls
```

**Required Headers:**
```
X-API-Key: glbs_YOUR_API_KEY
Content-Type: application/json
```

**Request Body:**
```json
{
  "phone": "+919876543210",           // or "9876543210" (Indian format)
  "direction": "INBOUND",              // or "OUTBOUND"
  "duration": 45,                      // seconds
  "status": "COMPLETED",               // INITIATED, RINGING, CONNECTED, COMPLETED, MISSED, FAILED
  "recordingUrl": "https://callified.example.com/recordings/abc123.wav",
  "providerCallId": "call_abc123def",
  "contactId": 42,                     // optional: link to existing contact
  "agentUserId": 5,                    // optional: agent who handled the call
  "notes": "Customer asked about pricing"
}
```

**Response (201 Created):**
```json
{
  "id": 1005,
  "duration": 45,
  "direction": "INBOUND",
  "recordingUrl": "https://callified.example.com/recordings/abc123.wav",
  "status": "COMPLETED",
  "createdAt": "2026-05-11T10:30:00Z"
}
```

---

### 4. Update Call with Transcript
```
POST /api/v1/external/transcripts
```

**Request Body:**
```json
{
  "callId": 1005,
  "transcriptUrl": "https://callified.example.com/transcripts/abc123.json",
  "transcript": "Optional: raw transcript text if you want to store it directly"
}
```

Transcripts are stored in the CallLog's `notes` field with a marker: `[transcript: <url>]`

---

### 5. Get Transcripts
```
GET /api/v1/external/transcripts?from=2026-05-01&to=2026-05-13&limit=50
```

**Query Parameters:**
- `callId` — get a specific call's transcript
- `from` — ISO datetime start (e.g., `2026-05-01T00:00:00Z`)
- `to` — ISO datetime end
- `limit` — max results (default 50, max 200)
- `offset` — pagination offset

**Response:**
```json
{
  "data": [
    {
      "id": 1005,
      "duration": 45,
      "direction": "INBOUND",
      "recordingUrl": "https://...",
      "transcript": "transcript URL or text extracted from notes",
      "contact": {
        "id": 42,
        "name": "John Doe",
        "phone": "+919876543210"
      },
      "createdAt": "2026-05-11T10:30:00Z"
    }
  ],
  "total": 1
}
```

---

### 6. Create a Lead (from Callified Dialing)
```
POST /api/v1/external/leads
```

**Request Body:**
```json
{
  "name": "John Doe",
  "phone": "+919876543210",
  "email": "john@example.com",
  "source": "callified",
  "note": "Interested in premium plan"
}
```

**Response (201 Created):**
```json
{
  "id": 42,
  "name": "John Doe",
  "status": "Lead",
  "email": "john@example.com",
  "phone": "+919876543210",
  "createdAt": "2026-05-11T10:30:00Z"
}
```

---

### 7. Get New Leads (Polling)
```
GET /api/v1/external/leads?since=2026-05-11T00:00:00Z&unqualified=true&limit=100
```

**Query Parameters:**
- `since` — ISO datetime (only leads created after this time)
- `source` — filter by source (e.g., "callified")
- `limit` — max results (default 100)

---

## Troubleshooting Authentication Errors

### Error: "Missing X-API-Key header"
**Cause:** Request doesn't include the `X-API-Key` header

**Fix:**
1. Check your request headers
2. Ensure header name is exactly `X-API-Key` (case-insensitive)
3. Ensure value starts with `glbs_`

### Error: "Invalid API key"
**Cause:** The API key format is wrong or the key doesn't exist in the database

**Fix:**
1. Verify the API key was generated in Globussoft CRM admin panel
2. Verify exact key value (copy-paste, no extra spaces)
3. Generate a new key if the current one is revoked

### Error: 401 Unauthorized (various)
**Cause:** API key exists but is invalid or tenant is inactive

**Debugging Steps:**
1. **Test the health endpoint first (no auth):**
   ```bash
   curl https://crm.globusdemos.com/api/v1/external/health
   ```

2. **Test your API key:**
   ```bash
   curl -H "X-API-Key: glbs_YOUR_API_KEY" \
     https://crm.globusdemos.com/api/v1/external/me
   ```

3. **Check backend logs for detailed error:**
   - SSH to the demo server
   - `tail -f /var/log/crm-backend.log | grep external`
   - Look for `[externalAuth]` entries

4. **Verify API key in database:**
   ```sql
   SELECT id, name, keySecret, isActive, tenantId 
   FROM ApiKey 
   WHERE keySecret LIKE 'glbs_%';
   ```

### Error: "Tenant is not active"
**Cause:** The tenant associated with the API key is marked as inactive

**Fix:**
- Contact the CRM admin to reactivate the tenant
- Or regenerate the API key for an active tenant

---

## Common Callified Workflows

### Workflow 1: Inbound Call → Create Lead
```
1. Callified receives inbound call on agent's number
2. Agent dials customer or call is transferred to Callified bot
3. Callified POSTs to /api/v1/external/leads (X-API-Key header)
4. Lead appears in CRM Inbox
5. Callified records call, POSTs to /api/v1/external/calls (X-API-Key header)
6. Call appears in CRM under Contact
```

### Workflow 2: Get Outbound Leads → Dial → Update with Transcript
```
1. Callified GETs /api/v1/external/leads?since=<time>&limit=100
2. Filters/prioritizes leads
3. Initiates outbound calls
4. Stores callIds from POST /api/v1/external/calls response
5. When transcript ready, POSTs to /api/v1/external/transcripts with callId
6. CRM user can GETs /api/v1/external/transcripts to retrieve
```

---

## Rate Limiting

- General: **5000 requests per 15 minutes per tenant**
- Auth endpoints: **1000 requests per 15 minutes**

If you hit a rate limit, you'll receive:
```
HTTP 429 Too Many Requests
```

Wait 1-2 minutes before retrying.

---

## Support

If you encounter issues:

1. **Check this documentation** for the endpoint you're calling
2. **Test the health endpoint**: `GET /api/v1/external/health`
3. **Verify your API key** with `GET /api/v1/external/me`
4. **Check the backend logs** (if you have SSH access)
5. **Contact DevOps**: Include your API key name (not the secret), the endpoint you're calling, and the error response

---

## What Your DevOps Guy Needs to Do

### **Two-Way Setup:**

#### **1️⃣ Callified → CRM (Callified pushes data to us)**

In **Globussoft CRM admin panel:**
1. Generate an API key
   - Name: "Callified.ai"
   - Format: `glbs_<48-hex-chars>` (auto-generated)
2. Give to Callified team
3. Configure Callified:
   - Base URL: `https://crm.globusdemos.com/api/v1/external`
   - Header: `X-API-Key: glbs_YOUR_KEY`

#### **2️⃣ CRM → Callified (We fetch their data)**

In **Callified dashboard** (https://testgo1.callified.ai):
1. **Go to:** Settings → API Keys
2. **Click:** "Generate New API Key"
3. **Name it:** "Globussoft CRM"
4. **Copy the key**
5. **Add to our `.env`:**
   ```env
   CALLIFIED_API_KEY=your_callified_api_key_here
   ```
6. **Restart backend:**
   ```bash
   npm start
   ```

### **Verification:**

```bash
# Test CRM's external API (Callified calls this)
curl -H "X-API-Key: glbs_YOUR_KEY" \
  https://crm.globusdemos.com/api/v1/external/me

# Backend will automatically test Callified connection
# Check logs:
tail -f /var/log/crm-backend.log | grep -i callified
```

**Expected log output when working:**
```
[integrations] Callified auth: using X-API-Key method
[integrations] Fetching from https://testgo1.callified.ai/api/external/transcripts
```

---

## Example: Full End-to-End Test

```bash
#!/bin/bash
API_KEY="glbs_YOUR_API_KEY_HERE"
BASE_URL="https://crm.globusdemos.com/api/v1/external"

# 1. Test health
echo "1. Testing health..."
curl -s "$BASE_URL/health" | jq .

# 2. Verify API key
echo "2. Verifying API key..."
curl -s -H "X-API-Key: $API_KEY" "$BASE_URL/me" | jq .

# 3. Create a lead
echo "3. Creating a test lead..."
LEAD=$(curl -s -X POST "$BASE_URL/leads" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Lead",
    "phone": "+919876543210",
    "email": "test@example.com",
    "source": "callified"
  }' | jq .)

LEAD_ID=$(echo $LEAD | jq .id)
echo "Created lead ID: $LEAD_ID"

# 4. Log a call for that lead
echo "4. Logging a test call..."
curl -s -X POST "$BASE_URL/calls" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"contactId\": $LEAD_ID,
    \"phone\": \"+919876543210\",
    \"direction\": \"OUTBOUND\",
    \"duration\": 120,
    \"status\": \"COMPLETED\",
    \"recordingUrl\": \"https://callified.example.com/rec/test.wav\"
  }" | jq .

# 5. Retrieve transcripts
echo "5. Retrieving transcripts..."
curl -s -H "X-API-Key: $API_KEY" \
  "$BASE_URL/transcripts?limit=10" | jq .
```

---

## Version

- API Version: **v1** (stable)
- Last Updated: 2026-05-13
- Endpoint: `https://crm.globusdemos.com/api/v1/external/`
