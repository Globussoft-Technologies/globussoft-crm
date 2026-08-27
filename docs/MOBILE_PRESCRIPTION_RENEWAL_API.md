# Prescription Renewal — New APIs for the Mobile App

**Two new endpoints.** Everything else the flow needs — login, `GET /portal/prescriptions`,
the PDF download, the notification inbox — is unchanged and already in the app.

Base path `/api/wellness`. Same `Authorization: Bearer <token>` the app already sends;
both the `/api/auth/login` customer token and the phone+OTP portal token work.

Payloads below were captured from a running server. Verified against `v3.9.2`, 2026-08-26.

| Method | Path |
|---|---|
| **POST** | `/portal/prescription-requests` |
| **GET** | `/portal/prescription-requests` |

> **New RBAC grants.** These two endpoints are gated on `my_prescription_requests.write`
> and `my_prescription_requests.read` on the tenant's CUSTOMER role. They show up in the
> existing `GET /portal/me/permissions` array. Missing grant → `403 PORTAL_RBAC_DENIED`.

---

## 1. `POST /portal/prescription-requests`

Raise a renewal request against one of the caller's own prescriptions.

### Request body

```jsonc
{
  "prescriptionId": 367,                    // REQUIRED, integer
  "medicines": ["Azithromycin 500mg"],      // optional — see rule below
  "durationDays": 60,                       // optional, 1..365
  "from": "2026-09-01",                     // optional, YYYY-MM-DD
  "to": "2026-10-31",                       // optional, YYYY-MM-DD
  "notes": "Running low, please repeat."    // optional, max 2000 chars
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `prescriptionId` | int | **yes** | Must be a prescription belonging to the caller |
| `medicines` | string[] | no | **Omit for the whole prescription.** Names must match `drugs[].name` from `GET /portal/prescriptions` |
| `durationDays` | int | no | 1–365 |
| `from` / `to` | string | no | `YYYY-MM-DD`. `to` must be ≥ `from` |
| `notes` | string | no | Max 2000 chars |

### The one rule that matters

> **Omit `medicines` entirely to renew the COMPLETE prescription.**
> Not `[]`, not every drug name — absence *is* the signal.
>
> (`[]` does work and every-name collapses to whole-prescription too, so don't rely
> on getting a partial back. Omitting is the contract.)

When you do send `medicines`, each entry must be a drug name that appears on that
prescription. Anything else is a `400` naming the offender. Matching is case- and
whitespace-insensitive. Objects (`[{"name": "…"}]`) also work; plain strings are simpler.

**Never send a doctor id.** The prescriber is resolved server-side from the prescription;
anything the client sends about it is ignored.

### `201` response

```jsonc
{
  "id": 9,
  "status": "PENDING",
  "prescriptionId": 373,
  "patientId": 2965,
  "doctorId": 4,
  "doctorName": "Punam Singh",
  "patientName": "Mohit das",
  "patientPhone": "+916200039874",
  "isFullPrescription": true,
  "requestedDrugs": null,
  "requestedDurationDays": 10,
  "requestedFrom": null,
  "requestedTo": null,
  "notes": null,
  "reviewedById": null,
  "reviewedByName": null,
  "reviewedAt": null,
  "reviewNote": null,
  "fulfilledPrescriptionId": null,
  "createdAt": "2026-08-26T13:02:35.129Z",
  "updatedAt": "2026-08-26T13:02:35.129Z",
  "prescription": {
    "id": 373,
    "drugs": [
      { "name": "Finasteride 1mg",    "dosage": 1, "frequency": 1, "duration": 90 },
      { "name": "Vitamin D3 60000IU", "dosage": 1, "frequency": 1, "duration": 56 }
    ],
    "instructions": null,
    "status": "issued",
    "createdAt": "2026-06-10T10:23:05.180Z",
    "visitId": null,
    "visitDate": null,
    "serviceName": null
  }
}
```

### Errors

All errors share one envelope: `{ "error": "human readable", "code": "MACHINE_CODE" }`

| Status | `code` | When | Suggested copy |
|---|---|---|---|
| 400 | `PRESCRIPTION_ID_REQUIRED` | Missing / non-numeric id | (client bug) |
| 400 | `MEDICINE_NOT_ON_PRESCRIPTION` | A name isn't on that Rx | Show `error` verbatim — it names them |
| 400 | `INVALID_MEDICINES` | Not an array, or an entry has no name | (client bug) |
| 400 | `PRESCRIPTION_HAS_NO_DRUGS` | Specific medicines asked for on an Rx with none | "No medicines recorded" |
| 400 | `INVALID_DURATION` | Not a positive whole number | "Enter a whole number of days" |
| 400 | `DURATION_TOO_LONG` | Over 365 | "Maximum 365 days" |
| 400 | `INVALID_DATE` | Not `YYYY-MM-DD` | (client bug) |
| 400 | `INVALID_DATE_RANGE` | `to` before `from` | "End date must be after start date" |
| 400 | `NOTE_TOO_LONG` | Over 2000 chars | Cap the input at 2000 |
| 403 | `PORTAL_RBAC_DENIED` | Feature off for this tenant | Hide the action |
| 404 | `PRESCRIPTION_NOT_FOUND` | Not this patient's Rx, or absent | "Prescription not found" |
| 409 | `REQUEST_ALREADY_OPEN` | A pending/accepted request already exists | "You already have a request open" |
| 409 | `PRESCRIPTION_CANCELLED` | Source Rx was cancelled | "Please book a consultation" |

---

## 2. `GET /portal/prescription-requests`

The caller's own requests, newest first. Returns a **bare array** — same element shape
as the `201` above.

| Param | Type | Default | Notes |
|---|---|---|---|
| `status` | string | — | `PENDING` \| `ACCEPTED` \| `REJECTED` \| `COMPLETED`. Case-insensitive. An unrecognised value is **ignored**, not an error |
| `limit` | int | 50 | Capped at 200 |

```jsonc
// 200 — abridged
[
  {
    "id": 5,
    "status": "PENDING",
    "prescriptionId": 367,
    "doctorName": "Pratibha Laxmi Singh",
    "isFullPrescription": false,
    "requestedDrugs": [
      { "name": "Azithromycin 500mg", "dosage": "1 tablet",
        "frequency": "once daily", "duration": "7 days" }
    ],
    "requestedDurationDays": 60,
    "notes": "Running low, please repeat just the tablets.",
    "reviewNote": null,
    "reviewedAt": null,
    "createdAt": "2026-08-24T10:23:05.744Z",
    "prescription": { "id": 367, "drugs": [ /* … */ ] }
  }
]
```

### Field notes

| Field | Note |
|---|---|
| `isFullPrescription` | **Use this**, not `requestedDrugs == null`. It's the server's own answer, so the app and the clinic panel can never disagree |
| `requestedDrugs` | `null` when full-Rx. When present it's a **snapshot taken at request time** — values are **strings** here (`"1 tablet"`), unlike the integers in `GET /portal/prescriptions`. Render as-is |
| `reviewNote` | The clinic's message on accept / reject / complete. **Show it** — a decline the patient can't understand is worse than no decline |
| `reviewedAt` | ISO-8601, `null` while pending |
| `fulfilledPrescriptionId` | Set when the doctor issued a new Rx for this request. Deep-link to it when present |
| `patientName`, `patientPhone`, `reviewedById` | Present but of no use to the app. Ignore |

### Status machine

```
PENDING ──► ACCEPTED ──► COMPLETED
   │            │
   └────────────┴──► REJECTED

REJECTED and COMPLETED are terminal.
```

**Only the clinic changes status.** There is no patient-side cancel or edit endpoint —
a patient who changes their mind raises a fresh request once the current one closes.

| Status | Suggested label |
|---|---|
| `PENDING` | Pending review |
| `ACCEPTED` | Accepted |
| `COMPLETED` | Ready |
| `REJECTED` | Declined |

---

## 3. Preventing the 409

A prescription with a `PENDING` **or** `ACCEPTED` request cannot be requested again.
Build the map once and disable the action rather than letting the patient discover it
by tapping.

```kotlin
val openStatuses = setOf("PENDING", "ACCEPTED")
val openByPrescription: Map<Int, PrescriptionRequestDto> =
    requests.filter { it.status in openStatuses }
            .associateBy { it.prescriptionId }

// per prescription row
val open = openByPrescription[rx.id]
button.isEnabled = open == null
button.text = open?.let { "Renewal ${it.status.lowercase()}" } ?: "Request renewal"
```

`REJECTED` / `COMPLETED` do **not** block — the patient can ask again. After a successful
POST, re-read the list so the row flips to pending without a manual refresh.

---

## 4. Retrofit + DTOs (already committed)

Both are already in the Android repo — no need to write them.

```kotlin
// core/network/WellnessApiService.kt
@POST("portal/prescription-requests")
suspend fun createPrescriptionRequest(
    @Body body: CreatePrescriptionRequestDto,
): Response<PrescriptionRequestDto>

@GET("portal/prescription-requests")
suspend fun getPrescriptionRequests(
    @Query("status") status: String? = null,
): Response<List<PrescriptionRequestDto>>
```

```kotlin
// feature/health/data/remote/dto/HealthDtos.kt
@JsonClass(generateAdapter = true)
data class CreatePrescriptionRequestDto(
    val prescriptionId: Int,
    val medicines: List<String>? = null,   // null ⇒ whole prescription
    val durationDays: Int? = null,
    val from: String? = null,              // YYYY-MM-DD
    val to: String? = null,
    val notes: String? = null,
)

@JsonClass(generateAdapter = true)
data class PrescriptionRequestDto(
    val id: Int,
    val status: String,
    val prescriptionId: Int,
    val patientId: Int,
    val doctorId: Int?,
    val doctorName: String?,
    val isFullPrescription: Boolean,
    val requestedDrugs: List<RequestedDrugDto>?,
    val requestedDurationDays: Int?,
    val requestedFrom: String?,
    val requestedTo: String?,
    val notes: String?,
    val reviewNote: String?,
    val reviewedAt: String?,
    val createdAt: String?,
    val updatedAt: String?,
)
```

> **Moshi:** `CreatePrescriptionRequestDto` must **omit** null fields, not serialise them
> as `null`. Moshi's default omits nulls, so `medicines = null` correctly produces
> `{"prescriptionId": 367}`. Do not enable `serializeNulls()` on this call — `{"medicines": null}`
> happens to work today, but "absent" is the contract.

---

## Test account

Tenant `Dr. Enhanced Wellness` (id 1) · login `mohit@getmule.com` · patient id `2965`.
60 prescriptions and renewal requests in all four statuses.

```
node backend/scripts/seed-prescription-request-demo.js --email=mohit@getmule.com --wipe
```
