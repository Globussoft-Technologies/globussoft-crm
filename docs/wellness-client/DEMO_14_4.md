# PRD §14.4 Demo Script — WhatsApp chatbot booking → Visit

> **Audience:** anyone running a live demo of the wellness CRM who needs to show "WhatsApp message → real Appointment row appearing in the CRM" without waiting for Callified.ai's auto-post webhook to ship.
>
> **Status of the real integration:** Callified.ai's chatbot → CRM auto-post is partner-blocked (see [STATUS.md](STATUS.md)). The CRM's ingest contract on `POST /api/v1/external/appointments` is fully shipped and gated by `e2e/tests/external-api.spec.js`. This script stands in for Callified, exercising the same contract end-to-end.

## What it shows

1. A simulated inbound WhatsApp message creates a Patient lead via `/api/v1/external/leads` (junk-filter + auto-router run).
2. A second simulated message books a slot via `/api/v1/external/appointments` — a real `Visit` row is created.
3. The Visit is immediately visible on the wellness Calendar at `/wellness/calendar` and the patient's history.

## Prereqs

- Callified API key for the Enhanced Wellness tenant (printed by `node prisma/seed-wellness.js` — looks like `glbs_…`).
- A patient already in the system (or the script will create one). The seed includes Priya Sharma, Arjun Patel, Vikram Mehta.
- `curl` and `jq` (for pretty-printing).

## Run it

```bash
# From repo root
WELLNESS_KEY="glbs_<your-callified-key>" \
BASE_URL="https://crm.globusdemos.com" \
  bash scripts/demo-callified-booking.sh
```

Or against local stack:

```bash
WELLNESS_KEY="glbs_<key>" BASE_URL="http://127.0.0.1:5000" \
  bash scripts/demo-callified-booking.sh
```

## What the script does

1. POSTs to `/api/v1/external/leads` with a synthesized WhatsApp inbound payload (phone, name, message body containing `book hair transplant`). Junk filter passes, auto-router assigns to a doctor/professional based on the service keywords.
2. POSTs to `/api/v1/external/messages` to log the inbound WhatsApp message itself.
3. Looks up the resulting Patient by phone (`GET /api/v1/external/patients/lookup?phone=…`).
4. Looks up service + doctor + location (`GET /services`, `GET /staff`, `GET /locations`) for valid IDs.
5. POSTs to `/api/v1/external/appointments` with `slotStart`, returning the new Visit.
6. Prints the Visit's CRM URL — open it in your browser to show the demo audience.

## What this does NOT show

- The chatbot's NLP itself (slot picking, confirmation prompts) — that's Callified's surface, not ours.
- Two-way messaging through the chatbot (now possible via the Wave 2 WhatsApp Threads page at `/wellness/whatsapp` for human agent takeover, but the chatbot loop itself is Callified's).
- Voice transcription (`/calls` PATCH) — separate Callified contract, demo-able via `external-api.spec.js`.

## Closing PRD §14.4

Once Callified ships their auto-post webhook, this script becomes redundant — Callified will hit the same `/api/v1/external/appointments` endpoint directly. Until then the script + this doc are the demo-readiness proof.
