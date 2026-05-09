#!/usr/bin/env bash
# PRD §14.4 demo — simulate Callified WhatsApp chatbot booking → CRM Visit.
# See docs/wellness-client/DEMO_14_4.md for the full walkthrough.

set -euo pipefail

: "${WELLNESS_KEY:?Set WELLNESS_KEY to the Callified demo API key (glbs_...)}"
: "${BASE_URL:=https://crm.globusdemos.com}"

API="${BASE_URL}/api/v1/external"
H_KEY=(-H "X-API-Key: ${WELLNESS_KEY}")
H_JSON=(-H "Content-Type: application/json")

DEMO_PHONE="${DEMO_PHONE:-+919999000111}"
DEMO_NAME="${DEMO_NAME:-Anjali Verma}"
DEMO_MSG="${DEMO_MSG:-Hi, I want to book a hair transplant consultation for next Saturday morning.}"

echo
echo "▶ Step 1 — Simulate inbound WhatsApp lead"
echo "   POST ${API}/leads"
LEAD=$(curl -sS "${H_KEY[@]}" "${H_JSON[@]}" \
  -X POST "${API}/leads" \
  -d "$(jq -n \
    --arg phone "$DEMO_PHONE" \
    --arg name "$DEMO_NAME" \
    --arg msg "$DEMO_MSG" \
    '{phone:$phone, name:$name, source:"whatsapp", message:$msg, locale:"en-IN"}')")
echo "   ↳ $LEAD" | jq -C .

echo
echo "▶ Step 2 — Log the inbound WhatsApp message"
echo "   POST ${API}/messages"
curl -sS "${H_KEY[@]}" "${H_JSON[@]}" \
  -X POST "${API}/messages" \
  -d "$(jq -n \
    --arg phone "$DEMO_PHONE" \
    --arg msg "$DEMO_MSG" \
    '{channel:"whatsapp", direction:"inbound", from:$phone, body:$msg}')" \
  | jq -C .

echo
echo "▶ Step 3 — Look up the patient by phone"
echo "   GET ${API}/patients/lookup?phone=${DEMO_PHONE}"
PATIENT=$(curl -sS "${H_KEY[@]}" "${API}/patients/lookup?phone=${DEMO_PHONE}")
echo "$PATIENT" | jq -C .
PATIENT_ID=$(echo "$PATIENT" | jq -r '.data[0].id // .id // empty')
if [[ -z "$PATIENT_ID" || "$PATIENT_ID" == "null" ]]; then
  echo "   ⚠ patient not auto-created by /leads — falling back to first seeded patient"
  PATIENT_ID=$(curl -sS "${H_KEY[@]}" "${API}/patients/lookup?phone=" | jq -r '.data[0].id')
fi
echo "   ↳ patient id: $PATIENT_ID"

echo
echo "▶ Step 4 — Resolve service + doctor + location IDs"
SERVICE_ID=$(curl -sS "${H_KEY[@]}" "${API}/services" | jq -r '.data[0].id')
DOCTOR_ID=$(curl -sS "${H_KEY[@]}" "${API}/staff?role=doctor" | jq -r '.data[0].id')
LOCATION_ID=$(curl -sS "${H_KEY[@]}" "${API}/locations" | jq -r '.data[0].id // empty')
echo "   ↳ service=$SERVICE_ID  doctor=$DOCTOR_ID  location=${LOCATION_ID:-(none)}"

# Slot: tomorrow 11:30 IST
SLOT_START=$(python3 -c "from datetime import datetime, timedelta, timezone; t=datetime.utcnow()+timedelta(days=1); t=t.replace(hour=6, minute=0, second=0, microsecond=0); print(t.isoformat()+'Z')" 2>/dev/null || \
              date -u -v+1d -v6H -v0M -v0S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
              date -u -d "tomorrow 06:00" +"%Y-%m-%dT%H:%M:%SZ")

echo
echo "▶ Step 5 — Create the Visit"
echo "   POST ${API}/appointments  (slotStart=$SLOT_START — 11:30 IST tomorrow)"
VISIT=$(curl -sS "${H_KEY[@]}" "${H_JSON[@]}" \
  -X POST "${API}/appointments" \
  -d "$(jq -n \
    --argjson patientId "$PATIENT_ID" \
    --argjson serviceId "$SERVICE_ID" \
    --argjson doctorId "$DOCTOR_ID" \
    --arg slotStart "$SLOT_START" \
    '{patientId:$patientId, serviceId:$serviceId, doctorId:$doctorId, slotStart:$slotStart, status:"booked", notes:"Booked via Callified WhatsApp demo"}')")
echo "$VISIT" | jq -C .
VISIT_ID=$(echo "$VISIT" | jq -r '.id // empty')

echo
if [[ -n "$VISIT_ID" && "$VISIT_ID" != "null" ]]; then
  echo "✅ Visit ${VISIT_ID} created. Demo URL:"
  echo "   ${BASE_URL}/wellness/calendar"
  echo "   ${BASE_URL}/wellness/patients/${PATIENT_ID}"
else
  echo "❌ Visit not returned — check API response above."
  exit 1
fi
