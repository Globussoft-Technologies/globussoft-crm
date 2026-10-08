# TMC Meeting Forms — Website Integration Guide

This document is the implementation handoff for a website team integrating the TMC scheduling experience. It covers the ready-made iframe, the public API, booking confirmation, production prerequisites, error handling, and launch verification.

## 1. What the integration provides

The Meeting Forms service supports three integration styles:

1. **Option A — APIs:** the website renders its own interface and calls the public configuration, availability, validation, booking, and confirmation endpoints.
2. **Option B — Embed:** TMC renders the complete form, calendar, time slots, validation, loading states, and confirmation screen.
3. **Option C — Store an external booking:** the website or Zoom Scheduler completes scheduling, then sends the confirmed payload to the generated `POST /external-bookings` URL for display in CRM. Travel CRM can optionally add a host calendar event and send a confirmation email.

Options A and B use the CRM configuration and availability rules. A successful CRM-managed booking:

- atomically reserves the selected slot;
- creates the Zoom meeting;
- creates the host's Google Calendar appointment when **Add to host calendar** is enabled;
- creates or updates the CRM contact;
- records the contact journey and meeting activity; and
- attempts to send the configured branded confirmation email when enabled.

Option C stores the booking in the CRM. It also creates a host Google Calendar event when **Add to host calendar** is enabled and sends a CRM confirmation email when **Send confirmation email** is enabled. It does not create a Zoom meeting or CRM contact. If the external scheduler already emails the customer, turn off CRM email to avoid two confirmations.

## 2. What the website team receives

The website team only needs to copy the complete generated iframe or API URLs from **Travel CRM → Marketing → Meeting Forms → Embed & API** and use them directly.

They do not need to configure `CRM_ORIGIN`, extract or store `PUBLIC_KEY` separately, or add an API-key header. The generated URLs already contain everything needed to identify the published form. CORS and website access are handled centrally by the CRM settings.

### Do not deploy localhost URLs

During local development, `http://localhost:5173/api/...` works because the Vite development server proxies `/api` to `http://localhost:5000`.

| Environment | Website/embed origin | API origin |
|---|---|---|
| Local development | `http://localhost:5173` | `http://localhost:5173` through the Vite proxy, or backend `http://localhost:5000` |
| Staging | Staging CRM HTTPS origin | Same staging CRM HTTPS origin |
| Production | Production CRM HTTPS origin | Same production CRM HTTPS origin |

Production website code must use the deployed HTTPS CRM origin, never `localhost:5173`.

## 3. CRM-side prerequisites

Before the website team starts acceptance testing, the CRM administrator must complete all of the following:

- Select the correct host in Meeting Form settings.
- Connect that host's **Google Calendar** account.
- Configure and verify the tenant's **Zoom Server-to-Server OAuth** connection.
- Give the Zoom app the required scopes:
  - `meeting:write:meeting:admin`
  - `meeting:delete:meeting:admin`
- Configure the timezone, appointment duration, weekly hours, minimum notice, buffers, booking horizon, date limits, daily limit, overrides, and blackout dates.
- Configure and order all public form fields.
- Confirm that **Designation** is configured as a Select field. New and legacy forms use these default choices: Principal, Vice Principal, Head of School, Academic Coordinator, Teacher / Faculty, School Management, and Other.
- Configure the confirmation email subject, body, placeholders, and optional footer logo.
- Optionally add confirmation email CC recipients for team members who should receive the customer's meeting confirmation and link.
- Review the Travel CRM SendGrid status under **CRM Settings**:
  - when customer-managed SendGrid (BYOK) is configured, its API key and verified sender are used; or
  - when BYOK is not configured, the CRM-managed backend SendGrid account is used automatically.
- Add the website's exact HTTPS origin under **CRM Settings → Embed Allowlist**.
- For CRM-managed booking, enable **Create Zoom meeting** and choose whether to add the host calendar event and send a confirmation email. For external booking, turn off CRM Zoom; choose independently whether the CRM should add a host calendar event or send an email. Then enable **Active/published**.
- Save changes and copy the current embed/API details.

Recipient mailboxes do not need to be synced to the CRM. Only the sending channel must be connected and operational.

## 4. Option A — APIs

Open **Travel CRM → Marketing → Meeting Forms → Embed & API** and copy the complete generated API URLs shown there. Use those URLs directly in the website; the website team does not need to construct an API base, extract the public key, or add an API-key header.

The CRM administrator only needs to add the website's origin under **CRM Settings → Embed Allowlist**. Once the form is active and the origin is allowed, browser requests from that website can use the copied public URLs. Never add a CRM admin token to website JavaScript.

### Endpoint summary

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | Copy the **form configuration** URL | Read the current public form contract |
| `GET` | Copy the **availability** URL | Read live dates and slots; replace `YYYY-MM-DD` |
| `POST` | Copy the **validate-slot** URL | Revalidate a chosen slot immediately before booking |
| `POST` | Copy the **book** URL | Atomically reserve and confirm the appointment |
| `POST` | Copy the **external-bookings** URL | Store an appointment already confirmed by the website or Zoom Scheduler |
| `GET` | Copy the **booking details** URL | After booking, replace `{confirmationToken}` in code with `payload.booking.confirmationToken` |
| `GET` | Add `/calendar.ics` to the booking-details URL | Download an add-to-calendar file |

### External scheduler flow

After the website confirms an appointment, call the generated `POST /external-bookings` endpoint. Send the contact fields, confirmed `selectedStartTime`, `duration`, and `timezone`. Zoom event ID, join URL, and external calendar event ID may be included when available. The record appears in the Meeting Form's **Bookings** tab, including the retained submitted payload. If the form's host calendar option is enabled, the CRM adds an event to that connected Google Calendar. The API returns a warning and still stores the booking if calendar creation fails.

Use a stable `Idempotency-Key` for every confirmed booking. When no header is provided, the CRM uses `zoomEventId` as the duplicate-prevention key; bookings without a Zoom ID require the header. Turn off **Create Zoom meeting** on external forms. The CRM calendar and email options are independent; disable CRM email if the external scheduler sends the confirmation.

## 5. Option B — Embed

Copy the generated iframe code from **Travel CRM → Marketing → Meeting Forms → Embed & API** and place it on the website.

```html
<iframe
  id="tmc-meeting-form"
  src="PASTE_THE_GENERATED_IFRAME_URL_HERE"
  title="Schedule a TMC conversation"
  style="width:100%;min-height:760px;border:0"
  loading="lazy"
></iframe>
```

The iframe automatically:

- reads the published field configuration;
- uses the configured Google Font;
- loads later months on demand up to the booking horizon;
- displays occupied times as unavailable;
- creates and reuses an idempotency key for safe submission;
- refreshes availability when a slot is taken by another visitor; and
- displays the confirmed Zoom link and email-delivery status.

### Optional automatic iframe resizing

The iframe posts its current height to the parent page. The parent must verify the sender's origin before using the message.

```html
<script>
  const frame = document.getElementById("tmc-meeting-form");
  const trustedCrmOrigin = new URL(frame.src).origin;

  window.addEventListener("message", (event) => {
    if (event.origin !== trustedCrmOrigin) return;
    if (event.data?.source !== "gbs-meeting-form") return;

    if (event.data.type === "size" && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.max(600, event.data.height)}px`;
    }

    if (event.data.type === "confirmed") {
      console.log("TMC meeting confirmed", event.data.booking);
      // Optional: fire website analytics or move to a thank-you section.
    }
  });
</script>
```

Do not use `'*'` as the receiving-side trust check. Match the exact CRM origin.

## 6. Read the public form configuration

```http
GET /api/travel/meeting-forms/public/{PUBLIC_KEY}
Accept: application/json
```

Example response:

```json
{
  "publicKey": "tmcmf_ZD-nbYujXEviWhAUcJ6DSliWIhJk9VtT",
  "name": "Talk to a TMC Experiential Learning Expert",
  "subBrand": "tmc",
  "durationMins": 30,
  "bookingHorizonDays": 365,
  "timezone": "Asia/Kolkata",
  "embedFontFamily": "DM Sans",
  "fields": [
    {
      "key": "contactName",
      "label": "Full Name",
      "type": "text",
      "required": true,
      "enabled": true,
      "order": 1,
      "placeholder": "",
      "options": []
    },
    {
      "key": "designation",
      "label": "Designation",
      "type": "select",
      "required": true,
      "enabled": true,
      "order": 2,
      "placeholder": "",
      "options": [
        "Principal",
        "Vice Principal",
        "Head of School",
        "Academic Coordinator",
        "Teacher / Faculty",
        "School Management",
        "Other"
      ]
    }
  ],
  "apiFields": [
    { "key": "firstName", "label": "First Name", "type": "text", "required": true, "maxLength": 80 },
    { "key": "lastName", "label": "Last Name", "type": "text", "required": true, "maxLength": 80 },
    {
      "key": "designation",
      "label": "Designation",
      "type": "select",
      "required": true,
      "options": ["Principal", "Vice Principal", "Head of School", "Academic Coordinator", "Teacher / Faculty", "School Management", "Other"]
    },
    { "key": "school", "label": "School / Institution", "type": "text", "required": true, "maxLength": 200 },
    { "key": "city", "label": "City", "type": "text", "required": true, "maxLength": 120 },
    { "key": "email", "label": "Work Email", "type": "email", "required": true, "maxLength": 191 },
    { "key": "phone", "label": "Phone / WhatsApp", "type": "tel", "required": true, "minLength": 7, "maxLength": 15, "inputMode": "numeric", "pattern": "[0-9]{7,15}" }
  ],
  "bookingFlow": {
    "version": 1,
    "steps": [
      { "id": "details", "number": 1, "label": "Your Details", "fields": ["firstName", "lastName", "designation", "school", "city"] },
      { "id": "time", "number": 2, "label": "Choose a Time", "fields": ["selectedStartTime"] },
      { "id": "contact", "number": 3, "label": "Contact Details", "fields": ["email", "phone"] }
    ]
  },
  "bookingSubmission": {
    "method": "POST",
    "endpointSuffix": "/book",
    "slotField": "selectedStartTime",
    "idempotencyKeyHeader": "Idempotency-Key",
    "idempotencyKeyRequired": true,
    "confirmationTokenPath": "booking.confirmationToken"
  },
  "confirmationMessage": "Your conversation has been scheduled.",
  "meetingType": "Zoom",
  "apiVersion": "2026-10-01",
  "acceptedBookingFields": [
    "firstName",
    "lastName",
    "designation",
    "school",
    "city",
    "email",
    "phone",
    "selectedStartTime",
    "duration",
    "timezone"
  ]
}
```

For the customer website's three-step UI, render inputs from `apiFields` and group them using `bookingFlow.steps`. Do not permanently hardcode the current field list or Designation choices. `fields` remains the hosted-form configuration and backward-compatible field contract. Supported field types are `text`, `email`, `tel`, `select`, and `textarea`. For a `select`, submit one of its returned `options` exactly.

The standard flow is:

1. **Your Details:** first name, last name, Designation dropdown, school/institution, and city.
2. **Choose a Time:** dates and exact `selectedStartTime` values returned by availability.
3. **Contact Details:** work email, numeric phone/WhatsApp, selected-conversation summary, and final submit.

If an older saved form has Designation stored as a text field, the public API upgrades it to the Select contract automatically. The website does not need a one-off migration.

## 7. Read availability

```http
GET /api/travel/meeting-forms/public/{PUBLIC_KEY}/availability?start=2026-09-28&days=31
Accept: application/json
```

Rules:

- `start` must be `YYYY-MM-DD` in the form's timezone.
- `days` is constrained to `1–62`; omitted values default to 14.
- For horizons longer than 62 days, request another block when the visitor navigates forward.
- Never calculate availability solely in the browser. The API includes Google Calendar conflicts, existing reservations, buffers, notice, overrides, blackouts, horizon, and daily limits.

Example response:

```json
{
  "timezone": "Asia/Kolkata",
  "durationMins": 30,
  "dates": [
    {
      "date": "2026-09-28",
      "available": true,
      "slots": [
        {
          "start": "2026-09-28T04:30:00.000Z",
          "end": "2026-09-28T05:00:00.000Z",
          "time": "10:00",
          "label": "10:00 AM",
          "selectedStartTime": "2026-09-28T04:30:00.000Z",
          "duration": 30,
          "timezone": "Asia/Kolkata"
        }
      ],
      "displaySlots": [
        {
          "start": "2026-09-28T05:00:00.000Z",
          "end": "2026-09-28T05:30:00.000Z",
          "time": "10:30",
          "label": "10:30 AM",
          "available": false,
          "unavailableReason": "occupied",
          "selectedStartTime": "2026-09-28T05:00:00.000Z",
          "duration": 30,
          "timezone": "Asia/Kolkata"
        }
      ]
    }
  ]
}
```

Use `slots` for selectable times. `displaySlots` may also contain disabled times with `unavailableReason` equal to `occupied`, `notice`, or `daily_limit`.

Always submit the exact ISO `start`/`selectedStartTime` returned by the API. Do not reconstruct it from the displayed label.

## 8. Validate the slot before submission

Validate immediately before the final booking call. This reduces avoidable conflicts but does not replace the atomic check performed by `/book`.

```http
POST /api/travel/meeting-forms/public/{PUBLIC_KEY}/validate-slot
Content-Type: application/json

{
  "selectedStartTime": "2026-09-28T04:30:00.000Z",
  "duration": 30,
  "timezone": "Asia/Kolkata"
}
```

Available response:

```json
{
  "available": true,
  "code": "SLOT_AVAILABLE",
  "date": "2026-09-28",
  "slots": []
}
```

If status is `409` with `SLOT_UNAVAILABLE`, replace the UI's slots with the returned current `slots` and ask the visitor to select again.

## 9. Create the booking

### Required headers

```http
Content-Type: application/json
Idempotency-Key: <UUID generated for this logical booking attempt>
```

Generate the key once and reuse the same key if the same request is retried because of a timeout or connection failure. Do not generate a new key for each automatic retry, because that could create duplicate bookings.

Browser example:

```js
const idempotencyKey = crypto.randomUUID();

async function createBooking(formValues, selectedSlot, config) {
  const validationResponse = await fetch("PASTE_VALIDATE_SLOT_URL_FROM_MEETING_FORM_CREATOR", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      selectedStartTime: selectedSlot.start,
      duration: config.durationMins,
      timezone: config.timezone
    })
  });

  const validation = await validationResponse.json();
  if (!validationResponse.ok) throw Object.assign(new Error(validation.error || "Slot unavailable"), { response: validation });

  const response = await fetch("PASTE_BOOK_URL_FROM_MEETING_FORM_CREATOR", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify({
      firstName: formValues.firstName,
      lastName: formValues.lastName,
      designation: formValues.designation,
      school: formValues.school,
      city: formValues.city,
      email: formValues.email,
      phone: String(formValues.phone || "").replace(/\D/g, "").slice(0, 15),
      selectedStartTime: selectedSlot.start,
      duration: config.durationMins,
      timezone: config.timezone,
      customFields: formValues.customFields || {},
      sourceUrl: window.location.href
    })
  });

  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || "Booking failed"), { response: payload });
  return payload;
}
```

### Supported request naming

The preferred website contract is:

```json
{
  "firstName": "Priya",
  "lastName": "Sharma",
  "designation": "Principal",
  "school": "Delhi Public School",
  "city": "Bengaluru",
  "email": "priya.sharma@school.edu.in",
  "phone": "919876543210",
  "selectedStartTime": "2026-09-28T04:30:00.000Z",
  "duration": 30,
  "timezone": "Asia/Kolkata",
  "customFields": {},
  "sourceUrl": "https://www.example.com/talk-to-an-expert"
}
```

The hosted/legacy aliases are also accepted:

| Preferred field | Accepted alias |
|---|---|
| `firstName` + `lastName` | `contactName` |
| `school` | `institution` |
| `email` | `contactEmail` |
| `phone` | `contactPhone` |
| `selectedStartTime` | `scheduledAt` |

Optional `diagnosticReportSlug` can attribute the meeting to a valid TMC diagnostic report. A client-supplied `zoomEventId` is ignored; Zoom authority always remains on the server.

### Successful response

Status `201` means the booking itself is confirmed. An idempotent replay returns status `200` with `idempotentReplay: true`.

```json
{
  "success": true,
  "booking": {
    "confirmationToken": "tmcb_<token>",
    "status": "CONFIRMED",
    "name": "Priya Sharma",
    "scheduledAt": "2026-09-28T04:30:00.000Z",
    "endsAt": "2026-09-28T05:00:00.000Z",
    "timezone": "Asia/Kolkata",
    "formattedDate": "Monday, 28 September 2026",
    "formattedTime": "10:00 AM GMT+5:30",
    "durationMins": 30,
    "meetingType": "Zoom",
    "meetingUrl": "https://zoom.us/j/<meeting>",
    "firstName": "Priya",
    "lastName": "Sharma",
    "designation": "Principal",
    "school": "Delhi Public School",
    "city": "Bengaluru",
    "email": "priya.sharma@school.edu.in",
    "phone": "919876543210",
    "selectedStartTime": "2026-09-28T04:30:00.000Z",
    "duration": 30,
    "zoomEventId": "<server-created-zoom-id>",
    "zoomJoinUrl": "https://zoom.us/j/<meeting>",
    "calendarEventId": "<server-created-calendar-id>",
    "emailStatus": "SENT",
    "emailChannel": "unified_inbox",
    "confirmationMessage": "Your conversation has been scheduled.",
    "addToCalendarUrl": "/api/travel/meeting-forms/public/<public-key>/bookings/<token>/calendar.ics"
  },
  "warning": null
}
```

If `warning` is present and `emailStatus` is `FAILED`, the meeting is still confirmed. Show the booking confirmation and Zoom details; do not submit the booking again. An operator on the CRM end can use **Bookings → Resend** after repairing the outbound email provider.

## 10. Confirmation lookup and calendar download

The website does not create or manually configure a confirmation token. Read it from `payload.booking.confirmationToken` after a successful `/book` response. Persist that returned value only if the website needs to restore the confirmation screen later, then replace the `{confirmationToken}` placeholder programmatically.

```http
GET /api/travel/meeting-forms/public/{PUBLIC_KEY}/bookings/{confirmationToken}
```

The response is the same public `booking` object returned by `/book`.

The returned `addToCalendarUrl` is relative to the same CRM domain already present in the copied API URLs. Alternatively, use the booking-details URL shown in **Embed & API** and add `/calendar.ics` after replacing `{confirmationToken}`.

The `.ics` file includes the confirmed start, end, Zoom URL, and stable booking UID.

## 11. Error handling

All JSON failures use an `error` message and stable `code`. The website should branch on `code`, not on the human-readable message.

| HTTP | Code | Website action |
|---:|---|---|
| `400` | `INVALID_DATE` | Send `start` as `YYYY-MM-DD`. |
| `400` | `INVALID_SLOT` | Use the exact ISO start returned by availability. |
| `400` | `INVALID_CONTACT` | Require a valid name and email. |
| `400` | `MISSING_REQUIRED_FIELDS` | Highlight keys returned in `fields`. |
| `400` | `INVALID_FIELD_VALUE` | Highlight invalid keys returned in `fields`. |
| `400` | `IDEMPOTENCY_KEY_REQUIRED` | Generate and send a stable UUID. |
| `403` | `ORIGIN_NOT_ALLOWED` | Ask the CRM admin to add the website origin to Embed Allowlist. |
| `404` | `NOT_FOUND` | Verify the public key and that the form is active. |
| `409` | `DURATION_MISMATCH` | Reload config/availability; use `expectedDuration`. |
| `409` | `TIMEZONE_MISMATCH` | Reload config/availability; use `expectedTimezone`. |
| `409` | `SLOT_UNAVAILABLE` | Replace the slot list from the response and ask for another selection. |
| `409` | `BOOKING_IN_PROGRESS` | Wait briefly, then retrieve/retry with the same idempotency key. |
| `429` | `BOOKING_RATE_LIMITED` | Stop automatic retries and ask the visitor to try later. |
| `424` | `ZOOM_CREATE_FAILED` | Show a temporary service error; do not claim confirmation. |
| `424` | `ZOOM_NOT_CONFIGURED` | CRM administrator must repair Zoom setup. |
| `503` | `AVAILABILITY_UNAVAILABLE` | Show retry UI; Google Calendar may be disconnected/unavailable. |

For network timeouts, retain the same idempotency key and retry conservatively. Never interpret a timeout as proof that the booking failed.

## 12. Origin, CORS, and security requirements

- Add the exact scheme and host, for example `https://www.themodernclassroom.in`, to **CRM Settings → Embed Allowlist**.
- Add separate entries for production, staging, and any approved preview origin.
- Do not add path components to an origin.
- HTTPS wildcard entries can be configured as `https://*.example.com` when intentionally required.
- Do not put a CRM JWT, Zoom credential, Google credential, or SendGrid key in website code.
- Treat `PUBLIC_KEY` and `confirmationToken` as unguessable routing identifiers, not as administrator authentication.
- Escape API-provided text before inserting it into HTML.
- Validate `postMessage` using the exact CRM origin.
- Do not trust or manufacture Zoom or calendar IDs on the client.

## 13. Email-delivery behaviour

Email delivery is separate from booking confirmation:

1. If the Travel CRM tenant has customer-managed SendGrid (BYOK) configured, the CRM sends with that API key, sender email, and sender name.
2. If the tenant has no BYOK configuration, the CRM sends with its CRM-managed backend SendGrid credentials and sender identity.
3. A saved but invalid customer-managed configuration fails visibly; it does not silently switch to the CRM-managed account.
4. A connected Gmail account in Unified Inbox is not used to deliver Meeting Form confirmation emails.
5. The status is `SENT` only after the selected SendGrid account accepts the message.
6. A Google Calendar update is not counted as confirmed email delivery.
7. If SendGrid delivery fails, the booking remains `CONFIRMED`, `emailStatus` becomes `FAILED`, and the CRM operator can resend it.

Operational examples:

- `sendgrid_401` with `Maximum credits exceeded` means the selected SendGrid account must renew, upgrade, or wait for its credit reset.
- A recipient mailbox does not need CRM synchronization.
- The Meeting Forms UI identifies the active route as **Using customer-managed SendGrid email** or **Using CRM-managed SendGrid email**.

## 14. Custom API UI state flow

```text
Load public config (`apiFields` + `bookingFlow`)
  → Step 1: collect Your Details
  → Load availability
  → Step 2: choose the exact returned slot
  → Step 3: collect Contact Details and show the slot summary
  → Validate slot
  → POST booking with stable Idempotency-Key
      → 201/200: read `booking.confirmationToken`; show confirmation and Zoom details
      → SLOT_UNAVAILABLE: refresh slots and return to Step 2
      → field error: map `fieldErrors` to Step 1 or Step 3
      → timeout: retry with the same Idempotency-Key
      → provider/config error: show retry/support message
```

Disable the submit button while `/book` is pending. Do not allow double-click submission.

## 15. Launch checklist when using APIs

- [ ] The Meeting Form is configured, saved, and active.
- [ ] Google Calendar, Zoom, and SendGrid are ready in Travel CRM.
- [ ] The website domain is added to **CRM Settings → Embed Allowlist**.
- [ ] The website uses the correct production API URLs and public key.
- [ ] Form fields and Designation choices are loaded from the configuration API.
- [ ] Available dates and times are loaded from the availability API.
- [ ] Phone numbers contain only 7 to 15 digits.
- [ ] The selected time is validated before the booking is submitted.
- [ ] The submit button is disabled while the booking request is processing.
- [ ] A successful booking shows the confirmation and meeting link.
- [ ] Booking, unavailable-slot, email-failure, and mobile flows have been tested.

### End-to-end acceptance test

1. Open the website from an allowed origin.
2. Confirm the form configuration and available times load.
3. Complete every required field.
4. Select an available slot and submit once.
5. Confirm the website receives `201` and `booking.status === "CONFIRMED"`.
6. Open the returned Zoom link.
7. Confirm the appointment appears on the host's Google Calendar.
8. Confirm the CRM contact, activity, and booking appear in Travel CRM.
9. Confirm the branded email arrives, including its configured body and footer logo.
10. Retry the identical booking request with the same idempotency key and confirm no duplicate is created.
11. Attempt a now-occupied slot and confirm the UI handles `409 SLOT_UNAVAILABLE`.

## 16. Troubleshooting

### `404 NOT_FOUND`

The key is wrong, the form is inactive, or the request points to the wrong environment.

### `403 ORIGIN_NOT_ALLOWED`

Add the page's exact `window.location.origin` under CRM Settings → Embed Allowlist. Check differences such as `www`, scheme, port, and staging subdomain.

### Availability stops after 62 days

This is expected per request. Load another maximum 62-day block as the visitor navigates forward. The hosted iframe already does this.

### `409 SLOT_UNAVAILABLE`

Another calendar event or booking now conflicts with the slot. Use the refreshed slots returned by the API.

### Booking confirmed but email failed

Do not create another booking. The CRM operator should repair the selected customer-managed or CRM-managed SendGrid configuration and use Resend from the Bookings tab.

### Local URLs work but production does not

Replace `http://localhost:5173` with the deployed CRM HTTPS origin and add the website origin to Embed Allowlist.

## 17. Source of truth

The **Embed & API** tab inside the Meeting Form creator is the source of truth. Copy the complete iframe code or complete API URLs shown there and use them directly. No separate domain, public-key, API-key, or authentication configuration needs to be supplied to the website team.
