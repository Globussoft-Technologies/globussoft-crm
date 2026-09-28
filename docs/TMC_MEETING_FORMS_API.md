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

Browser integrations must use an origin configured on the form. Server-to-server calls use the same generated public URLs without an API-key header. Booking requests use a stable `Idempotency-Key` generated automatically by the calling application so retries cannot create duplicates.

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

The supplied `duration` and `timezone` must match the latest Meeting Form configuration; stale UI metadata receives `409 DURATION_MISMATCH` or `409 TIMEZONE_MISMATCH`. The older embed names (`contactName`, `institution`, `contactEmail`, `contactPhone`, and `scheduledAt`) remain supported.

`zoomEventId` is deliberately not accepted as authority from a public client. If included for compatibility it is ignored. After Zoom creates the real meeting, the confirmed response includes `zoomEventId`, `zoomJoinUrl`, `calendarEventId`, `selectedStartTime`, `duration`, `timezone`, and the submitted TMC contact fields.

Optional attribution values can accompany either contract:

```json
{
  "diagnosticReportSlug": "123-0123456789abcdef",
  "sourceUrl": "https://www.themodernclassroom.in/diagnostic/result"
}
```

`201` means the slot, Zoom meeting, calendar appointment, and CRM record are confirmed. A `409 SLOT_UNAVAILABLE` response includes refreshed slots and must return the visitor to time selection. Confirmation-email failure is returned as a warning because the appointment itself remains confirmed; admins can resend it from Meeting Forms. Email is sent through the existing provider pipeline and stored as an outbound Unified Inbox message.

Diagnostic attribution is accepted only through a valid report slug belonging to the same TMC tenant. When valid, the contact journey records `Diagnostic Completed → Talk to an Expert → Meeting Booked`.
