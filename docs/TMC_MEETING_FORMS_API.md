# TMC Meeting Forms

Meeting Forms is available only inside **Travel CRM → Marketing**. An admin configures availability once; the same scheduling engine powers the supplied embed and any customer-built UI.

## Deployment

The Prisma change is additive (four new tables and Tenant relation fields). This repository's production workflow can apply it with:

```bash
cd backend
npx prisma generate
npx prisma db push
```

No hand-written `migration.sql` is required for this deployment workflow. Back up the production database before any schema deployment and review Prisma's output before confirming.

## Per-tenant Zoom setup

Each Travel CRM tenant connects its own Zoom Server-to-Server OAuth app under **Marketing → Meeting Forms → Zoom Setup**. The tenant enters its Account ID, Client ID, Client Secret, and optional Zoom host email. The backend verifies the credentials with Zoom before saving them. No Zoom or encryption environment variables are required for Travel Meeting Forms.

The browser receives masked Account/Client identifiers and a boolean indicating that a secret exists; stored credentials are never returned by the API. Disconnecting Zoom permanently deletes that tenant's credential row after confirming there are no published Meeting Forms using it.

Required Zoom granular scopes are `meeting:write:meeting:admin` and `meeting:delete:meeting:admin`. Classic apps may use `meeting:write:admin`. A tenant cannot publish a Zoom Meeting Form without a verified connection, and cannot disconnect Zoom while a Meeting Form is published.

Zoom Account ID, Client ID, and Client Secret are encrypted at rest with
AES-256-GCM. Configure `TRAVEL_MEETING_CREDENTIAL_KEY` as exactly 64 hexadecimal
characters before connecting Zoom. Keep the key stable and outside source
control; losing or rotating it without re-encrypting existing rows makes those
connections unreadable.

## Integration options

The admin page displays the generated embed code and API URLs. No separate API key needs to be entered, stored, rotated, or sent by either party.

```html
<iframe
  src="https://YOUR-CRM/embed/meeting-form.html?form=PUBLIC_KEY"
  title="Schedule a conversation"
  style="width:100%;min-height:900px;border:0"
></iframe>
```

For a custom UI, call:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/travel/meeting-forms/public/:publicKey` | Public field/config contract |
| `GET` | `/api/travel/meeting-forms/public/:publicKey/availability?start=YYYY-MM-DD&days=31` | Live available slots |
| `POST` | `/api/travel/meeting-forms/public/:publicKey/validate-slot` | Revalidate immediately before submit |
| `POST` | `/api/travel/meeting-forms/public/:publicKey/book` | Atomically reserve and confirm |
| `GET` | `/api/travel/meeting-forms/public/:publicKey/bookings/:token` | Confirmed booking details |
| `GET` | `/api/travel/meeting-forms/public/:publicKey/bookings/:token/calendar.ics` | Add-to-calendar file |

Browser integrations must use an origin configured for the tenant under **CRM Settings → Embed Allowlist**. Server-to-server calls use the same generated public URLs without an API-key header. Booking requests use a stable `Idempotency-Key` generated automatically by the calling application so retries cannot create duplicates.

The public configuration response is the UI contract. Customer websites should render `apiFields`, arrange them using `bookingFlow.steps`, and follow `bookingSubmission` rather than maintaining a separate field list. The current three-step flow is:

1. **Your Details:** `firstName`, `lastName`, `designation`, `school`, `city`
2. **Choose a Time:** `selectedStartTime`
3. **Contact Details:** `email`, `phone`

`designation` is a Select field. Its choices are returned by the configuration API and default to Principal, Vice Principal, Head of School, Academic Coordinator, Teacher / Faculty, School Management, and Other. Existing forms saved with a text Designation field are upgraded in the public contract automatically.

TMC's existing UI can submit its native contract unchanged:

```json
{
  "firstName": "Priya",
  "lastName": "Sharma",
  "designation": "Principal",
  "school": "Delhi Public School",
  "city": "Bengaluru",
  "email": "priya.sharma@school.edu.in",
  "phone": "9876543210",
  "selectedStartTime": "2026-09-25T10:30:00+05:30",
  "duration": 30,
  "timezone": "Asia/Kolkata"
}
```

Both `firstName` and `lastName` are required when the split-name contract is used. `phone` must contain only 7 to 15 digits; format it as digits before submission. Designation must exactly match one of the `apiFields` options returned by the current configuration response.

The supplied `duration` and `timezone` must match the latest Meeting Form configuration; stale UI metadata receives `409 DURATION_MISMATCH` or `409 TIMEZONE_MISMATCH`. The older embed names (`contactName`, `institution`, `contactEmail`, `contactPhone`, and `scheduledAt`) remain supported.

`zoomEventId` is deliberately not accepted as authority from a public client. If included for compatibility it is ignored. After Zoom creates the real meeting, the confirmed response includes `zoomEventId`, `zoomJoinUrl`, `calendarEventId`, `selectedStartTime`, `duration`, `timezone`, and the submitted TMC contact fields.

Optional attribution values can accompany either contract:

```json
{
  "diagnosticReportSlug": "123-0123456789abcdef",
  "sourceUrl": "https://www.themodernclassroom.in/diagnostic/result"
}
```

`201` means the slot, Zoom meeting, calendar appointment, and CRM record are confirmed. A `409 SLOT_UNAVAILABLE` response includes refreshed slots and must return the visitor to time selection. Confirmation-email failure is returned as a warning because the appointment itself remains confirmed; admins can resend it from Meeting Forms. Travel CRM sends through the tenant's customer-managed SendGrid configuration when BYOK is configured; otherwise it uses the CRM-managed backend SendGrid account. Connected Gmail accounts are not used for Meeting Form confirmations. Successful sends are stored as outbound Unified Inbox messages.

The successful response contains `booking.confirmationToken`. The website must read that value and substitute it into the generated booking-details URL when a later lookup is needed. No confirmation token is entered manually or hardcoded before booking.

Diagnostic attribution is accepted only through a valid report slug belonging to the same TMC tenant. When valid, the contact journey records `Diagnostic Completed → Talk to an Expert → Meeting Booked`.
