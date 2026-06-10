# WellnessCRM Patient App — Claude Session Context

> Place this file at the **root of the Android repo** as `CLAUDE.md`.
> Claude reads it automatically at the start of every session.

---

## What This Project Is

A **white-label Android application** (Kotlin + Jetpack Compose) that serves as the patient self-service portal for clinics running WellnessCRM — a multi-tenant clinic management SaaS built by Globussoft Technologies. Patients use this app to book appointments, view prescriptions, manage their wallet and memberships, receive push notifications, and track their clinical journey.

This app is a **separate Android repo** consuming the WellnessCRM backend (`/api/wellness`). The backend lives at `https://github.com/Globussoft-Technologies/globussoft-crm`. The full specifications live in that repo under `docs/`:
- `docs/PATIENT_APP_PRD.md` — all screens, user flows, API contracts, backend gap spec
- `docs/PATIENT_APP_ARCHITECTURE.md` — package structure, code patterns, DI, Room, Navigation
- `docs/WELLNESS_CRM_ANALYSIS.md` — full CRM system analysis for context

---

## App Identity

| Field | Value |
|-------|-------|
| Package name | `com.globussoft.wellness.patient` |
| Language | Kotlin |
| UI | Jetpack Compose + Material 3 |
| Min SDK | 26 (Android 8.0) |
| Architecture | Feature-based Clean Architecture (MVVM per feature) |
| DI | Hilt |
| HTTP | Retrofit 2 + OkHttp 4 |
| Local DB | Room |
| Auth | Phone OTP → 30-day Portal JWT |
| Payments | Razorpay Android SDK |
| Push | Firebase Cloud Messaging (FCM) |

---

## Backend Connection

| Environment | Base URL |
|-------------|----------|
| Production | `https://crm.globusdemos.com/api/wellness/` |
| Local emulator (AVD) | `http://10.0.2.2:5000/api/wellness/` |
| Local device (USB) | `http://192.168.x.x:5000/api/wellness/` |

**Auth header:** `Authorization: Bearer <portal_jwt>`
**All error responses:** `{ "error": "message", "code": "OPTIONAL_CODE" }`

### Demo credentials (against local CRM backend)

The CRM backend needs these in its `.env` to enable OTP bypass for testing:
```
WELLNESS_DEMO_OTP=1234
WELLNESS_DEMO_OTP_PHONES=9876500001
NODE_ENV=development
```

Test flow:
```
POST /portal/login/request-otp  { "phone": "9876500001" }  →  { "ok": true }
POST /portal/login/verify-otp   { "phone": "9876500001", "otp": "1234" }  →  { "token": "...", "patient": { "id": 1, "name": "..." } }
```

> **OTP is 4 digits.** Backend returns `{"error":"OTP must be 4 digits"}` for any other length.
> OTP resend cooldown is **30 seconds** (web portal source-verified).

---

## Architecture Rules (enforce these in every file you touch)

1. **Feature-first package structure** — code lives in `feature/<name>/data|domain|presentation`, never in a global `data/` or `presentation/` folder
2. **Features never import from each other** — cross-feature navigation only through `core/navigation/Screen`
3. **No business logic in ViewModels or Composables** — all logic lives in UseCases
4. **Repositories own data-source decisions** — remote vs. cache is transparent to UseCases
5. **No Android imports in `domain/`** — pure Kotlin; fully unit-testable without instrumentation
6. **Composables are stateless** — accept `UiState` + `onEvent` lambda only; no ViewModel reference inside sub-composables
7. **One-shot navigation events via `Channel<NavEvent>`** — never navigate from inside a Composable; consume navigation events in NavGraph
8. **`Result<T>` is the universal return type** — every UseCase returns `Result.Success`, `Result.Error`, or `Result.Loading`

---

## Package Structure

```
com.globussoft.wellness.patient/
├── app/                            ← Application class (Hilt), MainActivity
├── core/
│   ├── network/                    ← WellnessApiService, AuthInterceptor, TokenManager
│   ├── storage/                    ← DataStoreManager, EncryptedPrefsManager
│   ├── navigation/                 ← Screen sealed class, NavGraph, DeepLinkHandler
│   ├── theme/                      ← WellnessTheme, Color, Typography, Shape
│   ├── util/                       ← Result<T>, DateUtil, CurrencyUtil, PhoneUtil
│   ├── fcm/                        ← WellnessFcmService, FcmHelper
│   └── di/                         ← AppModule, NetworkModule, DatabaseModule, RepositoryModule
└── feature/
    ├── auth/                       ← Splash, PhoneEntry, OtpVerify, Register
    ├── dashboard/                  ← Home Dashboard
    ├── booking/                    ← BookAppointment (4-step), MyAppointments, VisitHistory
    ├── health/                     ← Prescriptions, TreatmentPlans*, ConsentForms*
    ├── membership/                 ← MyMemberships, plan browse
    ├── wallet/                     ← Wallet, GiftCards (Razorpay)
    ├── loyalty/                    ← Loyalty & Referrals*
    ├── profile/                    ← Profile, DSAR export
    └── notifications/              ← Notification Inbox
```
*Phase 2 — data/domain layer built in Phase 1, presentation deferred.

### Inside every feature

```
feature/<name>/
├── data/
│   ├── remote/dto/                 ← Moshi @JsonClass DTOs
│   ├── local/entity/               ← Room @Entity
│   ├── local/dao/                  ← Room @Dao
│   ├── mapper/                     ← Dto.toDomain(), Entity.toDomain(), Domain.toEntity()
│   └── repository/                 ← implements domain interface
├── domain/
│   ├── model/                      ← pure Kotlin data classes
│   ├── repository/                 ← interface
│   └── usecase/                    ← one class, one suspend invoke()
└── presentation/
    ├── screen/                     ← @Composable screens
    ├── viewmodel/                  ← @HiltViewModel
    └── state/                      ← UiState data class, UiEvent sealed class
```

---

## Core Code Patterns (use these consistently)

### Result<T>
```kotlin
sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(val code: String, val message: String, val httpStatus: Int? = null) : Result<Nothing>()
    object Loading : Result<Nothing>()
}
```

### UiState + UiEvent per feature
```kotlin
data class <Feature>UiState(val isLoading: Boolean = true, val error: String? = null, ...)
sealed class <Feature>UiEvent { ... }
```

### ViewModel structure
```kotlin
@HiltViewModel
class <Feature>ViewModel @Inject constructor(private val useCase: <Action>UseCase) : ViewModel() {
    private val _uiState = MutableStateFlow(<Feature>UiState())
    val uiState: StateFlow<<Feature>UiState> = _uiState.asStateFlow()
    private val _navigationEvent = Channel<NavEvent>(Channel.BUFFERED)
    val navigationEvent = _navigationEvent.receiveAsFlow()

    fun onEvent(event: <Feature>UiEvent) { ... }
}
```

### UseCase structure
```kotlin
class <Action>UseCase @Inject constructor(private val repository: <Feature>Repository) {
    suspend operator fun invoke(): Result<T> = try {
        Result.Success(repository.getData())
    } catch (e: HttpException) {
        if (e.code() == 401) Result.Error("UNAUTHORIZED", "Session expired", 401)
        else Result.Error("HTTP_${e.code()}", e.message(), e.code())
    } catch (e: IOException) {
        val cached = repository.getCached()
        if (cached.isNotEmpty()) Result.Success(cached) else Result.Error("NETWORK_ERROR", "No connection")
    }
}
```

### NavGraph wiring pattern
```kotlin
composable(Screen.Feature.route) {
    val vm: FeatureViewModel = hiltViewModel()
    val state by vm.uiState.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.navigationEvent.collect { event -> /* navController.navigate(...) */ } }
    FeatureScreen(state, vm::onEvent)
}
```

### Mapper naming convention
```kotlin
fun FeatureDto.toDomain(): Feature = ...      // remote → domain
fun FeatureEntity.toDomain(): Feature = ...   // cache → domain
fun Feature.toEntity(): FeatureEntity = ...   // domain → cache
// DTOs and Entities never leave the data layer
```

---

## All Screens (17 total)

| # | Screen | Feature package | Phase | Key API |
|---|--------|----------------|-------|---------|
| 1 | Splash / Branding | auth | 1 | `GET /public/tenant/:slug` |
| 2 | Phone Entry | auth | 1 | `POST /portal/login/request-otp` |
| 3 | OTP Verify | auth | 1 | `POST /portal/login/verify-otp` |
| 4 | Registration | auth | 1 | `POST /portal/register` ★ |
| 5 | Home Dashboard | dashboard | 1 | `GET /portal/me/dashboard` ★ |
| 6 | Book Appointment (4 steps) | booking | 1 | `GET /services`, `GET /locations`, `GET /portal/slots` ★, `POST /appointments/book` |
| 7 | My Appointments | booking | 1 | `GET /portal/visits?upcoming=true`, `POST /appointments/:id/cancel` |
| 8 | Visit History | booking | 1 | `GET /portal/visits` |
| 9 | Prescriptions | health | 1 | `GET /portal/prescriptions`, `GET /portal/prescriptions/:id/pdf` |
| 10 | Treatment Plans | health | 2★ | `GET /portal/me/treatment-plans` ★ |
| 11 | Consent Forms | health | 2★ | `GET /portal/me/consents` ★ |
| 12 | Wallet | wallet | 1 | `GET /portal/me/wallet` ★ |
| 13 | Gift Cards | wallet | 1 | `GET /giftcards/storefront`, `POST /giftcards/:id/purchase/order+confirm` |
| 14 | Loyalty & Referrals | loyalty | 2★ | `GET /portal/me/loyalty` ★ |
| 15 | Profile | profile | 1 | `GET /portal/me`, `PUT /portal/me` ★, `POST /portal/export` |
| 16 | Notification Inbox | notifications | 1 | Room (FCM persisted locally) |
| 17 | My Memberships | membership | 1 | `GET /portal/me/memberships` ★, `GET /membership-plans` |

★ = New backend endpoint that must be built on the CRM backend first (see Backend Gap Endpoints below).

---

## Backend Gap Endpoints (must be built on CRM before app can use them)

These endpoints do not exist yet. They are fully specified in `docs/PATIENT_APP_PRD.md §10` in the CRM repo.

| Endpoint | Method | Auth | Blocks |
|----------|--------|------|--------|
| `/portal/register` | POST | public | Screen 4 |
| `/portal/me/dashboard` | GET | portal JWT | Screen 5 |
| `/portal/slots` | GET | public | Screen 6 Step 3 |
| `/portal/me/wallet` | GET | portal JWT | Screen 12 |
| `/portal/me/memberships` | GET | portal JWT | Screen 17 |
| `/portal/me` | PUT | portal JWT | Screen 15 edit |
| `/portal/me/fcm-token` | POST / DELETE | portal JWT | Push notifications |
| `/portal/me/treatment-plans` | GET | portal JWT | Screen 10 (Phase 2) |
| `/portal/me/consents` | GET | portal JWT | Screen 11 (Phase 2) |
| `/portal/me/consents/:id/pdf` | GET | portal JWT | Screen 11 (Phase 2) |
| `/portal/me/loyalty` | GET | portal JWT | Screen 14 (Phase 2) |

---

## Exact API Contracts (key endpoints)

### Auth
```
POST /portal/login/request-otp
Body:     { "phone": "9876512345" }
Response: { "ok": true, "expiresAt": "ISO8601" }
Errors:   400 { "error": "phone is required" } | 400 { "error": "Invalid phone" }

POST /portal/login/verify-otp
Body:     { "phone": "9876512345", "otp": "1234" }
Response: { "token": "jwt", "patient": { "id": 1, "name": "Priya" } }
Errors:   400 { "error": "OTP must be 4 digits" } | 401 { "error": "Invalid or expired code" }
```

### Appointments
```
POST /appointments/book
Body:     { "appointmentDate": "ISO8601", "appointmentTime": "10:30", "reason": "string",
            "doctorId": int?, "serviceId": int?, "membershipId": int? }
Response: { "success": true, "appointment": { "id", "patientName", "doctorName",
            "appointmentDate", "status": "booked", "reason" } }
Errors:   400 MISSING_FIELDS | 400 Reason required | 409 { "code": "DOCTOR_UNAVAILABLE" }

GET /appointments/my
Response: [{ "id", "doctorName", "serviceName", "appointmentDate", "status", "reason", "doctorAssigned" }]
Status values: booked | arrived | in-treatment | checked-in

POST /appointments/:id/cancel
Response: { "success": true, "appointment": { "id", "status": "cancelled" } }
Errors:   403 { "error": "Can only cancel your own appointments" } | 404 not found
```

### Visits (portal-scoped)
```
GET /portal/visits
GET /portal/visits?upcoming=true
Response: [{ "id", "visitDate", "status", "service": { "id", "name" }, "doctor": { "id", "name" } }]
Limit: 50 rows
```

### Profile
```
GET /portal/me
Response: { "id", "name", "phone", "email", "dob", "gender" }
Note: tenantId is stripped — never in response
```

### Gift cards
```
GET /giftcards/storefront
Response: { "giftCards": [{ "id", "name", "amount", "price", "color", "validityDays", "currency", "expiresAt" }] }

POST /giftcards/:id/purchase/order
Body:     { "patientId"?: int }
Response: { "orderId", "paymentId", "key" (Razorpay key), "amount" (paise), "currency",
            "giftCardId", "patientId", "patientName" }

POST /giftcards/:id/purchase/confirm
Body:     { "paymentId", "razorpay_order_id", "razorpay_payment_id", "razorpay_signature" }
Response: { "giftCard": {...}, "transaction": {...} }
```

---

## Room DB Entities (offline cache)

```kotlin
// feature/booking/data/local/entity/CachedVisit.kt
@Entity(tableName = "cached_visits")
data class CachedVisit(id, visitDate: Long, status, serviceName?, doctorName?,
                       locationName?, bookingType, videoCallUrl?, amountCharged?, cachedAt)

// feature/health/data/local/entity/CachedPrescription.kt
@Entity(tableName = "cached_prescriptions")
data class CachedPrescription(id, visitId, visitDate: Long, doctorName?, serviceName?,
                               drugCount, pdfBytes: ByteArray?, pdfCachedAt: Long?, cachedAt)

// feature/membership/data/local/entity/CachedMembership.kt
@Entity(tableName = "cached_memberships")
data class CachedMembership(id, status, startDate: Long, endDate: Long, daysLeft,
                             planName, planPrice, planCurrency, creditsJson, historyJson, cachedAt)

// feature/notifications/data/local/entity/CachedNotification.kt
@Entity(tableName = "cached_notifications")
data class CachedNotification(id: String, type, title, body, screen?, entityId?,
                               isRead: Boolean = false, receivedAt: Long)
```

Cache eviction on app start:
- Prescription PDFs: `evictStalePdfs(now - 7.days)` (7-day TTL for PDF bytes)
- Notifications: `deleteOlderThan(now - 90.days)`
- Everything else: cleared on logout

---

## Navigation Routes

```kotlin
sealed class Screen(val route: String) {
    object Splash          : Screen("splash")
    object PhoneEntry      : Screen("phone_entry")
    object OtpVerify       : Screen("otp_verify/{phone}") { fun createRoute(phone: String) = "otp_verify/$phone" }
    object Register        : Screen("register/{phone}")   { fun createRoute(phone: String) = "register/$phone" }
    object Dashboard       : Screen("dashboard")
    object BookAppointment : Screen("book_appointment?serviceId={serviceId}&membershipId={membershipId}") {
        fun createRoute(serviceId: Int? = null, membershipId: Int? = null) =
            "book_appointment?serviceId=${serviceId ?: ""}&membershipId=${membershipId ?: ""}"
    }
    object MyAppointments  : Screen("my_appointments")
    object VisitHistory    : Screen("visit_history")
    object Prescriptions   : Screen("prescriptions")
    object PrescriptionPdf : Screen("prescription_pdf/{id}") { fun createRoute(id: Int) = "prescription_pdf/$id" }
    object TreatmentPlans  : Screen("treatment_plans")   // Phase 2
    object ConsentForms    : Screen("consent_forms")     // Phase 2
    object Memberships     : Screen("memberships")
    object Wallet          : Screen("wallet")
    object GiftCards       : Screen("gift_cards")
    object Loyalty         : Screen("loyalty")           // Phase 2
    object Profile         : Screen("profile")
    object Notifications   : Screen("notifications")
}
// Deep-link scheme: wellnesspatient://screen/{screenName}?id={entityId}
```

---

## Hilt DI Modules (all in `core/di/`)

| Module | Provides |
|--------|----------|
| `AppModule` | DataStore, EncryptedSharedPreferences |
| `NetworkModule` | OkHttpClient (cert pinned), Retrofit, WellnessApiService |
| `DatabaseModule` | AppDatabase, VisitDao, PrescriptionDao, MembershipDao, NotificationDao |
| `RepositoryModule` | `@Binds` all Repository interfaces → implementations |

---

## Push Notifications (FCM)

### Channels (create in MainActivity.onCreate)
| Channel ID | Name | Importance |
|-----------|------|-----------|
| `wellness_reminders` | Appointment Reminders | HIGH + vibration |
| `wellness_health` | Health Updates | DEFAULT |
| `wellness_wallet` | Wallet & Payments | DEFAULT |
| `wellness_offers` | Offers & Surveys | LOW |

### Notification type → deep-link mapping
| `type` field in FCM data | Deep-link screen |
|--------------------------|-----------------|
| `APPOINTMENT_REMINDER_24H` / `APPOINTMENT_REMINDER_1H` | `appointments` |
| `BOOKING_CONFIRMED` / `BOOKING_CANCELLED` | `appointments` |
| `PRESCRIPTION_READY` | `prescriptions` |
| `MEMBERSHIP_EXPIRY` | `memberships` |
| `WALLET_CREDITED` | `wallet` |
| `NPS_SURVEY` | external URL |
| `NO_SHOW_REENGAGEMENT` | `book` |

FCM token lifecycle:
- Register: `POST /portal/me/fcm-token` `{ token, platform: "android" }` → on login + `onNewToken()`
- Deregister: `DELETE /portal/me/fcm-token` → on logout

---

## Theme

| Token | Value |
|-------|-------|
| Primary color | `#265855` (deep teal) |
| Accent color | `#CD9481` (warm blush) |
| Background | `#FAF7F2` (cream) |
| Primary button text | White |
| Body font | Roboto |
| Heading font | Playfair Display |
| Card radius | 12dp |
| Button radius | 24dp |

Apply clinic's `Tenant.brandColor` at runtime as the Material 3 seed color (fallback: `#265855`).

---

## Security Rules (enforce always)

- JWT stored in `DataStore` (app-private, file-level encrypted) — not SharedPreferences
- Patient name and phone stored in `EncryptedSharedPreferences` (AES-256-GCM, Android Keystore)
- Prescription PDFs in Room BLOB — served via `FileProvider`, never auto-saved to Downloads
- **No PHI in Logcat, Sentry breadcrumbs, or Firebase Analytics params** — use `patientId` (int), never name/phone
- `POST_NOTIFICATIONS` permission requested at runtime before FCM token registration
- Cert pinning in `network_security_config.xml` for production domain
- R8 minification enabled in release builds

---

## Implementation Phases

### Phase 0 — Bootstrap
Android Studio project, `libs.versions.toml`, `build.gradle.kts` (`minSdk 26`, `compileSdk 35`), Firebase `google-services.json`, `network_security_config.xml`, `BuildConfig.BASE_URL` + `BuildConfig.TENANT_SLUG`.

### Phase 1 — Core module
`core/network/` → `core/storage/` → `core/util/Result.kt` → `core/di/` (all 4 modules) → `core/theme/` → `core/navigation/Screen.kt` → `AppDatabase` with 4 entities.

### Phase 2 — Auth feature
`SplashScreen` (branding load + token check) → `PhoneEntryScreen` → `OtpVerifyScreen` (SMS Retriever API, 4-box input, 60s resend timer) → `RegisterScreen`. Token saved to DataStore on success. FCM token registered immediately after login.

### Phase 3 — Dashboard feature
`GET /portal/me/dashboard` → single-call aggregated response → greeting, next-appointment card (with cancel), 3 tappable stat chips (wallet, loyalty, memberships), quick-action row.

### Phase 4 — Booking feature
4-step `BookAppointmentScreen`: services grid → location + booking type → slot grid (30-min intervals, holiday-aware) → reason + membership picker. Plus `MyAppointmentsScreen` (upcoming/past tabs, cancel, Join Video Call for VIDEO type) and `VisitHistoryScreen` (grouped by month, bottom sheet detail).

### Phase 5 — Health feature
`PrescriptionsScreen` (permission-gated on `my_prescriptions.read`) → in-app PDF viewer via Android `PdfRenderer` → cached in Room `pdfBytes` (7-day eviction). Phase 2: Treatment Plans + Consent Forms screens.

### Phase 6 — Membership feature
`MembershipsScreen`: Active/Expired tabs, per-service `LinearProgressIndicator` (remaining/total), redemption history `ModalBottomSheet`, plan catalog accordion (GET /membership-plans), "Book with this membership" CTA.

### Phase 7 — Wallet + Gift cards
`WalletScreen`: balance + transaction timeline with type icons. `GiftCardsScreen`: 2-column storefront grid → review modal → Razorpay Android SDK checkout → wallet credit confirmation.

### Phase 8 — Profile + Notifications
`ProfileScreen`: view/edit name/email/DOB/gender, DSAR export (`POST /portal/export`), logout (clear all storage + FCM deregister). `NotificationInboxScreen`: Room-backed list, mark-read on tap, deep-link on tap, 90-day eviction.

### Phase 9 — FCM push
`WellnessFcmService`: `onNewToken()` registers token, `onMessageReceived()` persists to Room + shows system notification with correct channel. `MainActivity`: 4 channels created on `onCreate()`. `POST_NOTIFICATIONS` runtime permission request.

### Phase 10 — Testing
UseCase unit tests (JUnit 5 + MockK), ViewModel tests (Turbine), Room DAO integration tests (in-memory), key UI tests (Compose + Hilt). Target: 100% UseCase coverage, ≥90% ViewModel coverage.

### Phase 11 — Release prep
R8 full minification, ProGuard rules, cert pin update, Room migrations (replace `fallbackToDestructiveMigration`), Play Store internal testing track upload.

---

## Key Library Versions

```toml
kotlin              = "2.0.21"
compose-bom         = "2024.12.01"
hilt                = "2.52"
retrofit            = "2.11.0"
okhttp              = "4.12.0"
moshi               = "1.15.1"
room                = "2.6.1"
datastore           = "1.1.1"
firebase-bom        = "33.7.0"
sentry              = "7.20.0"
razorpay            = "1.6.40"
coil                = "2.7.0"
turbine             = "1.2.0"
compose-navigation  = "2.8.5"
hilt-navigation     = "1.2.0"
```

Full `libs.versions.toml` with all library coordinates is in `docs/PATIENT_APP_ARCHITECTURE.md §P` of the CRM repo.

---

## status.md — Live Progress Tracker

`status.md` lives at the **repo root** alongside `CLAUDE.md`. It is the single source of truth for what is done and what is left. Claude must read it at session start and update it after every completed task.

### Rules for status.md

- **Read it first** — before writing any code, read `status.md` to know exact current state
- **Update it immediately** — mark a task `✅` the moment a file is written and compiles; do not batch updates
- **Never delete entries** — completed items stay in the file so progress is always visible
- **Add blockers inline** — if a backend gap endpoint is missing, note it with `🔴 BLOCKED: <reason>` on that task row
- **One source of truth** — if `status.md` says something is done, it is done; if it is not in `status.md`, it has not been started

### status.md format

```markdown
# WellnessCRM Patient App — Implementation Status

Last updated: YYYY-MM-DD HH:MM
Current phase: Phase X — <name>

## Legend
✅ Done  🔄 In Progress  ⬜ Not started  🔴 Blocked

---

## Phase 0 — Bootstrap
✅ Android project created
✅ libs.versions.toml configured
...

## Phase 1 — Core Module
✅ core/network/WellnessApiService.kt
🔄 core/network/AuthInterceptor.kt
⬜ core/network/TokenManager.kt
...

## Backend Gap Endpoints
✅ POST /portal/register — built + tested
🔴 GET /portal/me/dashboard — NOT YET BUILT on CRM backend
⬜ GET /portal/slots
...

## Phase 2 — Auth Feature
⬜ feature/auth/data/remote/dto/AuthTokenDto.kt
...
```

### When to update status.md

| Trigger | Action |
|---------|--------|
| Session start | Read status.md, confirm current phase, resume from first `⬜` or `🔄` |
| File written + compiles | Mark `✅` immediately |
| File started but not finished | Mark `🔄` |
| Backend endpoint confirmed working | Mark `✅` in Backend Gap section |
| Backend endpoint missing | Mark `🔴 BLOCKED` with note |
| Phase fully complete | Add a `✅ Phase X complete — YYYY-MM-DD` line at top of that section |

---

## Session Start Checklist

At the start of every Claude session in this repo, you should:

1. **Read `status.md`** — find the current phase and the first `⬜` or `🔄` task; that is where you start
2. **Check backend gap endpoints** — for the current feature's required endpoints, confirm they exist on the CRM backend before proceeding; update status.md with `✅` or `🔴`
3. **Follow the architecture rules** — re-read the 8 rules in "Architecture Rules" before writing any new class
4. **One feature at a time** — complete all 3 layers (data → domain → presentation) for a feature before starting the next
5. **Test as you go** — write the UseCase test alongside the UseCase, not after
6. **Update `status.md` after every file** — never let it fall behind actual progress

## What NOT to do

- Do not put any business logic in a Composable or ViewModel
- Do not let a feature import from another feature package
- Do not use `runBlocking` outside of `AuthInterceptor`
- Do not log patient name, phone, or clinical details to Logcat or analytics
- Do not hardcode the tenant slug in Composables — always read from `BuildConfig.TENANT_SLUG`
- Do not skip the `Result<T>` wrapper — every UseCase must return it
- Do not use `LiveData` — use `StateFlow` and `Flow` only
- Do not use XML layouts — Jetpack Compose only
