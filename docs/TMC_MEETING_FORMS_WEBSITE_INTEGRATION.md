# TMC Meeting Forms — Website Integration Guide

This document is the implementation handoff for a website team integrating the TMC scheduling experience. It covers the ready-made iframe, the public API, booking confirmation, production prerequisites, error handling, and launch verification.

## 1. What the integration provides

The Meeting Forms service supplies one scheduling engine for both integration styles:

1. **Option A — APIs:** the website renders its own interface and calls the public configuration, availability, validation, booking, and confirmation endpoints.
2. **Option B — Embed:** TMC renders the complete form, calendar, time slots, validation, loading states, and confirmation screen.

Both options use the same CRM configuration and availability rules. A successful booking:

- atomically reserves the selected slot;
- creates the Zoom meeting;
- creates the host's Google Calendar appointment;
- creates or updates the CRM contact;
- records the contact journey and meeting activity; and
- attempts to send the configured branded confirmation email.

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
- Configure the confirmation email subject, body, placeholders, and optional footer logo.
- Configure a working outbound email channel:
  - connect the selected host's Gmail account to Unified Inbox; or
  - configure SendGrid with an active plan/available credits, a key with `mail.send`, and a verified sender.
- Add the website's exact HTTPS origin under **CRM Settings → Embed Allowlist**.
- Enable **Create Zoom meeting** and **Active/published**.
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
| `GET` | Copy the **booking details** URL | Replace `{confirmationToken}` with the returned token |
| `GET` | Add `/calendar.ics` to the booking-details URL | Download an add-to-calendar file |

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
    }
  ],
  "confirmationMessage": "Your conversation has been scheduled.",
  "meetingType": "Zoom",
  "apiVersion": "2026-09-24",
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

Render fields dynamically from `fields`; do not permanently hardcode the current field list. Supported field types are `text`, `email`, `tel`, `select`, and `textarea`. For a `select`, submit one of its returned `options` exactly.

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
      phone: formValues.phone,
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
  "phone": "+91 98765 43210",
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
    "phone": "+91 98765 43210",
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

If `warning` is present and `emailStatus` is `FAILED`, the meeting is still confirmed. Show the booking confirmation and Zoom details; do not submit the booking again. The CRM team can use **Bookings → Resend** after repairing the outbound email provider.

## 10. Confirmation lookup and calendar download

Persist the returned `confirmationToken` if the website needs to restore the confirmation screen.

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
| `502` | `ZOOM_CREATE_FAILED` | Show a temporary service error; do not claim confirmation. |
| `503` | `ZOOM_NOT_CONFIGURED` | CRM administrator must repair Zoom setup. |
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

1. The CRM first tries the selected host's Gmail connection in Unified Inbox.
2. If Gmail is absent or its send fails, the CRM tries SendGrid.
3. The status is `SENT` only after Gmail or SendGrid accepts the message.
4. A Google Calendar update is not counted as confirmed email delivery.
5. If both channels fail, the booking remains `CONFIRMED`, `emailStatus` becomes `FAILED`, and the CRM operator can resend it.

Operational examples:

- `sendgrid_401` with `Maximum credits exceeded` means the SendGrid account must renew, upgrade, or wait for its credit reset.
- A recipient mailbox does not need CRM synchronization.
- Connecting the host's Gmail account provides the primary sending route and avoids depending exclusively on SendGrid.

## 14. Custom API UI state flow

```text
Load public config
  → Load availability
  → Render configured fields, dates, and slots
  → Visitor chooses a slot
  → Validate slot
  → POST booking with stable Idempotency-Key
      → 201/200: show confirmation and Zoom details
      → SLOT_UNAVAILABLE: refresh slots and return to selection
      → timeout: retry with the same Idempotency-Key
      → provider/config error: show retry/support message
```

Disable the submit button while `/book` is pending. Do not allow double-click submission.

## 15. Launch checklist

### CRM team

- [ ] Correct host selected.
- [ ] Host Google Calendar connected.
- [ ] Zoom Server-to-Server OAuth verified.
- [ ] Schedule, timezone, duration, horizon, and blackout dates reviewed.
- [ ] Form fields reviewed.
- [ ] Confirmation subject/body/logo reviewed.
- [ ] Gmail sender connected or SendGrid credits/key/sender verified.
- [ ] Production and staging website origins added to Embed Allowlist.
- [ ] Form saved and Active/published enabled.

### Website team

- [ ] Production code uses the HTTPS deployed CRM origin, not localhost.
- [ ] Current public key is configured per environment.
- [ ] Iframe renders without horizontal scrolling, or custom UI renders fields dynamically.
- [ ] Later months load up to the configured horizon.
- [ ] Exact availability ISO values are submitted.
- [ ] A stable UUID is sent in `Idempotency-Key`.
- [ ] Submit button is disabled during booking.
- [ ] `SLOT_UNAVAILABLE` refreshes available times.
- [ ] Confirmed booking displays even when only email delivery fails.
- [ ] Zoom link opens in a new tab with `rel="noopener noreferrer"`.
- [ ] Iframe message handler validates `event.origin`.
- [ ] Mobile, keyboard, and screen-reader behaviour has been tested.

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

Do not create another booking. The CRM operator should repair Gmail/SendGrid and use Resend from the Bookings tab.

### Local URLs work but production does not

Replace `http://localhost:5173` with the deployed CRM HTTPS origin and add the website origin to Embed Allowlist.

## 17. Source of truth

The **Embed & API** tab inside the Meeting Form creator is the source of truth. Copy the complete iframe code or complete API URLs shown there and use them directly. No separate domain, public-key, API-key, or authentication configuration needs to be supplied to the website team.
