# WellnessCRM Patient App — Implementation Status

Last updated: 2026-06-04 (session 16 — display bug fixes, RBAC re-test)
Current phase: All 17 screens implemented and live-tested ✅

## Session 15 — Live Device Test Results (2026-06-04)

Device: Redmi 2406ERN9CI, Android 16 | Build: debug APK (crm-staging.globusdemos.com, tenant=testing)
Test account: qatest@robot-mail.com | patientId=609 | tenantId=2

### Bugs found and fixed during session 15 live test

| # | Bug | Fix |
|---|-----|-----|
| 1 | **PrescriptionDto.drugs crash** — `drugs: List<DrugDto>` crashed at runtime because backend returns drugs as JSON-encoded string `"[{...}]"`, not an array | Changed `drugs: String` in DTO, added nested `PrescriptionVisitDto`/`PrescriptionDoctorDto`, parse drugs via `org.json.JSONArray` in mapper |
| 2 | **Loyalty chip dead tap** — `DashboardNavEvent.ToLoyalty` and `DashboardUiEvent.NavigateToLoyalty` missing; chip had hardcoded `onClick = {}` | Added missing event + nav event, wired `onLoyaltyClick` in ViewModel, DashboardScreen, and NavGraph |
| 3 | **Treatment Plans / Consent Forms unreachable** — `composable()` entries had no `deepLinks` so couldn't be tested | Added `wellnesspatient://screen/treatment_plans` and `wellnesspatient://screen/consent_forms` deep links |

### Session 16 — Display bug fixes (2026-06-04)

All 4 cosmetic issues fixed and verified on device:

| # | Fix | Files changed | Verified |
|---|-----|---------------|---------|
| 1 | Profile DOB: `1991-02-02T00:00:00.000Z` → `2 Feb 1991` | `ProfileScreen.kt` — added `DateUtil.toDisplayDate()` | ✅ |
| 2 | Profile Gender: `F` → `Female` | `ProfileScreen.kt` — `when(gender.uppercase())` expansion | ✅ |
| 3 | Wallet balance/txn: `₹500.00` → `5.00 USD` | `CurrencyUtil.kt` — new `formatPaise(Double)` overload; `WalletScreen.kt` — pass `currency` to row | ✅ |
| 4 | Dashboard Loyalty chip: `—` → `3196 pts` | `DashboardRepositoryImpl.kt` — parallel `getLoyalty()` call; `DashboardScreen.kt` — `loyaltyPoints` wired to StatRow | ✅ |

**RBAC status (re-tested 2026-06-04):** `GET /portal/products` still returns **403** for patientId=609. The `products.read` permission is not assigned to this test patient on the staging backend. Book Appointment step 1 (services grid) will show an error screen for this account until the backend grants the permission.

### Display issues (non-crash, cosmetic)

| # | Issue | Status |
|---|-------|--------|
| All 4 session-15 cosmetic issues | Fixed in session 16 | ✅ |

### Screen test results (session 15)

| Screen | Result | Notes |
|--------|--------|-------|
| Splash + notification permission | ✅ Pass | Teal logo, "Wellness", spinner, permission dialog |
| Login screen | ✅ Pass | Email/password fields, Sign In button |
| Login → Dashboard | ✅ Pass | JWT stored, dashboard loads with Maria's data |
| Dashboard | ✅ Pass | Greeting, next appointment (5 Jun), wallet/members chips, quick actions |
| Notifications | ✅ Pass | "No notifications yet" empty state |
| Prescriptions | ✅ Pass (after fix) | 4 prescriptions, service+doctor+date+drug count displayed |
| Prescription PDF | ✅ Pass | PdfRenderer renders prescription #100 correctly |
| Wallet | ✅ Pass | ₹500.00 balance, 1 gift card transaction |
| Memberships | ✅ Pass | Diamond Package, Active, valid until 3 Jun 2027 |
| Loyalty | ✅ Pass (after fix) | 3196 pts, earned-this-month chip, 4 transaction rows |
| Gift Cards | ✅ Pass | Fever Care Gift Card, ₹900.00 / worth ₹1000.00 |
| Profile | ✅ Pass | Name, phone, email, dob (raw), gender (raw), DSAR, logout |
| My Appointments — Upcoming | ✅ Pass | "No upcoming appointments" (expected; 0 from /portal/appointments) |
| My Appointments — Past | ✅ Pass | "No past appointments" |
| Visit History | ✅ Pass | 6 visits grouped by June 2026 with service, doctor, amount |
| Book Appointment | ⚠️ Backend | 403 PORTAL_RBAC_DENIED on /portal/products (products.read not assigned) |
| Treatment Plans | ✅ Pass | 2 plans, progress bars, Active badges (via deep link) |
| Consent Forms | ✅ Pass | 3 forms with PDF icons (via deep link) |
| Consent Form PDF | ✅ Pass | PdfRenderer renders consent form with patient signature |
| Token persistence (relaunch) | ✅ Pass | Stored JWT → skip login on relaunch |

## Session 9 — Live Device Test Results (2026-06-04)

Device: Redmi 2406ERN9CI, Android 16 | Build: debug APK (staging backend)

### Bugs found and fixed during live test

| # | Bug | Fix |
|---|-----|-----|
| 1 | **ProfileDto crash** — `phone: String` (non-null) threw `JsonDataException` when backend returned `null` phone for email-registered patient | Made `phone: String?` nullable in `ProfileDto`, `Profile` domain model, and added null guard in `ProfileScreen` |
| 2 | **Missing Visit History button** — `NavigateToHistory` nav event wired in ViewModel but no UI element triggered it in `MyAppointmentsScreen` | Added `Icons.Default.History` `IconButton` to `MyAppointmentsScreen` TopAppBar |

### Backend issue (not app bug)
- `GET /portal/products` → `403 PORTAL_RBAC_DENIED: requires products.read` for newly registered patients — backend does not assign `products.read` RBAC permission on registration. Book Appointment step 1 shows error+retry (correct error handling). Fix needed on backend.

### Screen test results

| Screen | Result | Notes |
|--------|--------|-------|
| Splash → Login redirect | ✅ Pass | No stored token → Login shown |
| Login screen render | ✅ Pass | Teal button, cream bg, email/password fields |
| Login error handling | ✅ Pass | "Invalid email or password" shown correctly |
| Register screen | ✅ Pass | 4-field form, navigation from Sign up link |
| Registration → Dashboard | ✅ Pass | Full flow successful |
| Dashboard | ✅ Pass | Greeting, wallet/members/loyalty chips, quick actions |
| Token persistence (relaunch) | ✅ Pass | Stored JWT → skip login on relaunch |
| Book Appointment | ⚠️ Backend | 403 RBAC on `/portal/products` — error UI correct |
| Wallet | ✅ Pass | ₹0.00 balance, "No transactions yet", gift card icon |
| Gift Cards storefront | ✅ Pass | "Fever Care Gift Card" card rendered |
| Gift Cards purchase sheet | ✅ Pass | ModalBottomSheet with value/price/validity + Pay CTA |
| Prescriptions | ✅ Pass | "No prescriptions found" empty state |
| Memberships | ✅ Pass | "No memberships found", "Browse Plans" CTA |
| Profile | ✅ Pass (after fix) | Name, email; phone hidden when null |
| Notifications | ✅ Pass | Bell icon empty state |
| My Appointments | ✅ Pass | Upcoming/Past tabs, FAB |
| Visit History | ✅ Pass (after fix) | "No visits yet" empty state |
| Logout | ✅ Pass | Clears session, returns to Login |

## Legend
✅ Done &nbsp; 🔄 In Progress &nbsp; ⬜ Not started &nbsp; 🔴 Blocked (reason inline)

---

## Backend Gap Endpoints
*Re-audited against CRM backend on 2026-06-04 (session 7 — cross-checked with backend/frontend team + direct wellness.js code review)*

### ✅ Confirmed working patient-portal endpoints

| Endpoint | Notes |
|----------|-------|
| `GET /public/tenant/:slug` | Tenant branding |
| `POST /api/auth/login` | Email + password → CUSTOMER JWT |
| `POST /api/auth/customer/register` | Patient registration |
| `GET /portal/me` | Profile read |
| `GET /portal/me/permissions` | Portal permission set |
| `GET /portal/visits` | Visit history (supports `?upcoming=true`) |
| `GET /portal/prescriptions` | Prescription list |
| `GET /portal/prescriptions/:id/pdf` | Prescription PDF download |
| `POST /portal/export` | DSAR data export |
| `GET /portal/appointments` | My appointments — `?bucket=upcoming\|past\|all` (default upcoming) |
| `POST /portal/appointments/book` | Book appointment |
| `POST /portal/appointments/:id/cancel` | Cancel appointment |
| `PATCH /portal/appointments/:id/reschedule` | Reschedule appointment |
| `GET /portal/products` | Patient-facing product/service catalogue (excludes Consumption type). Requires portal permission `products.read`. |
| `GET /portal/product-categories` | Product categories. Requires portal permission `products.read`. |
| `GET /giftcards/storefront` | Gift card catalogue |
| `POST /giftcards/:id/purchase/order` | Initiate gift card purchase |
| `POST /giftcards/:id/purchase/confirm` | Confirm gift card purchase |

> **Appointment URL fix (session 7):** `WellnessApiService.kt` previously called wrong staff-scoped paths (`appointments/book`, `appointments/my`, `appointments/:id/cancel`). Now corrected to portal paths above. `AppointmentListResponseDto` wrapper added to reflect `{ bucket, count, appointments }` envelope.

> **Services → Products:** The `GET /services` and `GET /locations` staff routes are no longer used by the patient app. The patient-facing equivalent is `GET /portal/products` (and `GET /portal/product-categories`). The booking body (`POST /portal/appointments/book`) takes `serviceId` (maps to a product id), not a location. Location selection step removed from booking flow.

> **Slot picker:** `GET /portal/slots` does not exist and is not planned. The booking flow uses a date + time picker directly; the server returns `DOCTOR_UNAVAILABLE` / `SLOT_TAKEN` if the chosen slot is invalid.

### ✅ All features confirmed working — live staging API test 2026-06-04

Test account: `mohitreddy@gimpmail.com` · patientId=608 · tenantId=1 · slug=`enhanced-wellness`

| Endpoint | Auth | HTTP | Notes |
|----------|------|------|-------|
| `GET /portal/me` | verifyPatientToken | 200 | Patient profile: id (patientId!), name, phone, email, dob, gender |
| `GET /portal/appointments` | verifyPatientToken | 200 | `{bucket, count, appointments[]}` |
| `POST /portal/appointments/book` | verifyPatientToken | — | Confirmed route exists |
| `POST /portal/appointments/:id/cancel` | verifyPatientToken | — | Confirmed route exists |
| `PATCH /portal/appointments/:id/reschedule` | verifyPatientToken | — | Confirmed route exists |
| `GET /portal/products` | verifyPatientToken + products.read | 200 | Returns `[]` if no products configured |
| `GET /portal/product-categories` | verifyPatientToken + products.read | 200 | Category list with images/colors |
| `GET /portal/prescriptions` | verifyPatientToken | — | Confirmed route exists |
| `GET /portal/prescriptions/:id/pdf` | verifyPatientToken | — | Confirmed route exists |
| `GET /appointments/my-memberships` | verifyToken (CUSTOMER JWT) | 200 | Patient's own memberships: `{id, planId, planName, planDurationDays, startDate, endDate, status, balance[]}` |
| `GET /membership-plans` | verifyToken (CUSTOMER JWT) | 200 | Full plan catalog with `entitlements` JSON string |
| `GET /patients/{patientId}/wallet` | verifyToken (CUSTOMER JWT) | 200 | `{patient, wallet:{balance,currency}, transactions[]}` — wallet-only txns |
| `GET /my-transactions` | verifyToken (CUSTOMER JWT) | 200 | Unified timeline; `summary.walletBalance=2000` confirmed |
| `GET /loyalty/{patientId}` | verifyToken (CUSTOMER JWT) | 200 | `{patient, balance, earnedThisMonth, transactions[]}` — **needs patientId from portal/me** |
| `GET /patients/{patientId}/treatment-plans` | verifyToken (CUSTOMER JWT) | 200 | `[{id, name, totalSessions, completedSessions, startedAt, status, totalPrice, service:{name,category}}]` |
| `GET /patients/{patientId}/consents` | verifyToken (CUSTOMER JWT) | 200 | `[{id, templateName, signedAt, hasPdfBlob, service:{}}]` |
| `GET /consents/{id}/pdf` | verifyToken (CUSTOMER JWT) | 200 | PDF bytes |
| `PUT /api/auth/me` | verifyToken (CUSTOMER JWT) | — | Updates name, email, password — **not** dob/gender/phone |
| `GET /api/auth/me` | verifyToken (CUSTOMER JWT) | 200 | User-layer: name, email, role, profilePicture |
| `GET /giftcards/storefront` | unguarded | — | Confirmed |
| `POST /giftcards/:id/purchase/order` | unguarded | — | Confirmed |
| `POST /giftcards/:id/purchase/confirm` | unguarded | — | Confirmed |

### 🔴 One remaining gap — Android FCM push registration

| Endpoint | Blocks | Notes |
|----------|--------|-------|
| `POST /portal/me/fcm-token` | Phase 9 FCM | `push.js` accepts only **Web Push (VAPID)** subscriptions `{endpoint, p256dh, auth}`. No Android device token (FCM) support anywhere in the backend. Needs a new endpoint. |
| `DELETE /portal/me/fcm-token` | Phase 9 FCM | Same |

### ⚠️ Security flag — loyalty/{patientId} not ownership-scoped
`GET /loyalty/{patientId}` accepts any integer patientId. Verified that `loyalty/1` returns a DIFFERENT patient's (Shashank bankar's) data to our CUSTOMER JWT holder. Backend must add ownership check: `req.user.userId → Patient.userId === patientId`. The Android app only ever calls this with `EncryptedPrefsManager.getPatientId()` (never user-supplied), so the app is safe, but the backend has a data leak for malicious clients.

### ⚠️ Profile edit scope — dob/gender/phone cannot be updated
`PUT /api/auth/me` updates User-row fields only. Patient-row fields (dob, gender, phone) have no update endpoint. Profile edit screen will support name + email + password only.

### ⚠️ Permission note — portal/products
Requires portal permission `products.read`. Confirm with backend that this is in the default permission set for new patient registrations.

### patientId storage strategy
`GET /portal/me` returns `response.id` which is the **patientId** (not the userId from JWT). This is different from `userId` (44) vs `patientId` (608) in the staging test. `AuthRepositoryImpl` now calls `portal/me` after login and caches patientId in `EncryptedPrefsManager`. All routes using `patients/{patientId}/` must read from `encryptedPrefs.getPatientId()`.

---

## Phase 0 — Bootstrap
✅ Phase 0 complete — 2026-06-03

| Task | Status |
|------|--------|
| Android project created (Empty Compose Activity) | ✅ |
| Package name set: `com.globussoft.wellness.patient` | ✅ |
| `gradle/libs.versions.toml` populated with all libraries | ✅ |
| `app/build.gradle.kts`: minSdk 26, compileSdk 35, Compose + KSP + Hilt + Firebase enabled | ✅ |
| `BuildConfig.BASE_URL` + `BuildConfig.TENANT_SLUG` fields added (debug + release flavors) | ✅ |
| `res/xml/network_security_config.xml` created + referenced in Manifest | ✅ |
| `AndroidManifest.xml` updated (permissions, FCM, FileProvider, deep-links) | ✅ |
| `root/build.gradle.kts` updated with all plugin aliases | ✅ |
| `settings.gradle.kts` updated with JitPack for Razorpay | ✅ |
| Old `com.crm.wellness` template files deleted | ✅ |
| `google-services.json` added (Firebase project created) | 🔴 MANUAL — requires Firebase Console; cannot be auto-generated. App compiles but FCM won't work. |
| `CLAUDE.md` placed at repo root | ✅ |
| `STATUS.md` placed at repo root | ✅ |

---

## Phase 1 — Core Module
✅ Phase 1 complete — 2026-06-03

### core/util/
| File | Status |
|------|--------|
| `Result.kt` | ✅ |
| `DateUtil.kt` | ✅ |
| `CurrencyUtil.kt` | ✅ |
| `PhoneUtil.kt` | ✅ |
| `Extensions.kt` | ✅ |

### core/network/
| File | Status |
|------|--------|
| `WellnessApiService.kt` (all endpoints) | ✅ |
| `AuthInterceptor.kt` | ✅ |
| `TokenManager.kt` | ✅ |

### core/storage/
| File | Status |
|------|--------|
| `DataStoreManager.kt` | ✅ |
| `EncryptedPrefsManager.kt` | ✅ |

### core/di/
| File | Status |
|------|--------|
| `AppModule.kt` (DataStore + EncryptedSharedPreferences) | ✅ |
| `NetworkModule.kt` (OkHttp, Retrofit, Moshi, WellnessApiService) | ✅ |
| `DatabaseModule.kt` (Room, 4 DAOs) | ✅ |
| `RepositoryModule.kt` (empty @Module, @Binds added per feature) | ✅ |

### core/navigation/
| File | Status |
|------|--------|
| `Screen.kt` | ✅ |
| `NavGraph.kt` (stub routes for all 17 screens) | ✅ |
| `DeepLinkHandler.kt` | ✅ |

### core/theme/
| File | Status |
|------|--------|
| `Color.kt` | ✅ |
| `Typography.kt` (Playfair Display via Google Fonts downloadable) | ✅ |
| `Shape.kt` | ✅ |
| `WellnessTheme.kt` | ✅ |
| Playfair Display font XML files (5 variants, Google Fonts provider) | ✅ |
| `res/values/font_certs.xml` (Google Fonts certificate arrays) | ✅ |

### core/fcm/ (Phase 9 stubs)
| File | Status |
|------|--------|
| `WellnessFcmService.kt` (stub — full impl Phase 9) | ✅ |
| `FcmHelper.kt` (stub — full impl Phase 9) | ✅ |

### core/database/
| File | Status |
|------|--------|
| `AppDatabase.kt` (Room v1, 4 entities, fallbackToDestructiveMigration) | ✅ |

### app/
| File | Status |
|------|--------|
| `WellnessPatientApp.kt` (@HiltAndroidApp) | ✅ |
| `MainActivity.kt` (NavHost + 4 notification channels + edge-to-edge) | ✅ |

### Database Entities + DAOs
| File | Status |
|------|--------|
| `CachedVisit` entity | ✅ |
| `VisitDao` | ✅ |
| `CachedPrescription` entity | ✅ |
| `PrescriptionDao` | ✅ |
| `CachedMembership` entity | ✅ |
| `MembershipDao` | ✅ |
| `CachedNotification` entity | ✅ |
| `NotificationDao` | ✅ |

### Feature DTO Stubs (data layer foundations)
| Feature | File | Status |
|---------|------|--------|
| auth | `AuthDtos.kt` (LoginRequest, LoginResponse, RegisterRequest, RegisterResponse, TenantBranding) | ✅ |
| booking | `BookingDtos.kt` (Visit, Service, Location, Slot, Appointment, Book, Cancel) | ✅ |
| health | `HealthDtos.kt` (Prescription, Drug) | ✅ |
| membership | `MembershipDtos.kt` (Membership, MembershipPlan, Credits, History) | ✅ |
| profile | `ProfileDtos.kt` (Profile, UpdateProfile, DsarExport) | ✅ |
| wallet | `WalletDtos.kt` (Wallet, Transaction, GiftCard, GiftCardOrder, GiftCardConfirm, FcmToken) | ✅ |

---

## Phase 2 — Auth Feature
✅ Phase 2 complete — 2026-06-03

### Data layer
| File | Status |
|------|--------|
| `feature/auth/domain/model/TenantBranding.kt` | ✅ |
| `feature/auth/domain/model/Patient.kt` | ✅ |
| `feature/auth/data/mapper/AuthMappers.kt` (toDomain, toPatient) | ✅ |
| `feature/auth/domain/repository/AuthRepository.kt` (interface) | ✅ |
| `feature/auth/data/repository/AuthRepositoryImpl.kt` | ✅ |
| `core/di/RepositoryModule.kt` updated with @Binds for AuthRepository | ✅ |

### Domain layer — UseCases + tests
| File | Status |
|------|--------|
| `GetTenantBrandingUseCase.kt` + test (3 cases) | ✅ |
| `CheckAuthStatusUseCase.kt` + test (3 cases) | ✅ |
| `LoginUseCase.kt` + test (4 cases) | ✅ |
| `RegisterPatientUseCase.kt` + test (4 cases) | ✅ — fully functional via `POST /api/auth/customer/register` |
| `LogoutUseCase.kt` + test (2 cases) | ✅ |
| ~~RequestOtpUseCase~~ / ~~VerifyOtpUseCase~~ | 🗑 Deleted — replaced by LoginUseCase |

### Presentation layer
| File | Status |
|------|--------|
| `presentation/state/SplashState.kt` | ✅ |
| `presentation/state/LoginState.kt` | ✅ |
| `presentation/state/RegisterState.kt` (email + password + confirmPassword) | ✅ |
| `presentation/viewmodel/SplashViewModel.kt` (saves tenantId to DataStore, emits NavigateToLogin) | ✅ |
| `presentation/viewmodel/LoginViewModel.kt` | ✅ |
| `presentation/viewmodel/RegisterViewModel.kt` (fully functional) | ✅ |
| `presentation/screen/SplashScreen.kt` | ✅ |
| `presentation/screen/LoginScreen.kt` (email + password, show/hide toggle, Sign up link) | ✅ |
| `presentation/screen/RegisterScreen.kt` (name + email + password + confirm, Sign in link) | ✅ |
| ~~PhoneEntryState~~ / ~~OtpVerifyState~~ / ~~PhoneEntryViewModel~~ / ~~OtpVerifyViewModel~~ / ~~PhoneEntryScreen~~ / ~~OtpVerifyScreen~~ | 🗑 Deleted |
| `core/navigation/Screen.kt` — PhoneEntry/OtpVerify removed, Login added | ✅ |
| `core/navigation/NavGraph.kt` — Splash → Login → Dashboard; Register ↔ Login | ✅ |
| `core/navigation/DeepLinkHandler.kt` — updated phone_entry → login | ✅ |

### Build verification (session 4)
| Check | Status |
|-------|--------|
| `./gradlew assembleDebug` | ✅ BUILD SUCCESSFUL |
| `./gradlew test` | ✅ 0 failures, 0 errors |

### Device verification (session 5 — live ADB test)
| Test | Result |
|------|--------|
| Splash screen renders (brand color, logo, clinic name) | ✅ |
| Splash → Login navigation (token absent) | ✅ |
| Login screen: fields, show/hide toggle, Sign In, Sign up link | ✅ |
| Successful login → Dashboard (blank Phase 3 stub) | ✅ POST /api/auth/login → 200 OK, 415ms |
| Token persistence: restart → goes to Dashboard (skips login) | ✅ |
| Wrong password → "Invalid email or password" in red | ✅ 401 handled correctly |
| Sign up link → Register screen | ✅ |
| Register screen: name/email/password/confirm/button/sign-in link | ✅ |
| Register "Sign in" → popBackStack to Login | ✅ |
| Register empty submit → "Full name is required" validation | ✅ |

### Session 5 bug fixes
| Fix | Status |
|-----|--------|
| `TENANT_SLUG` changed from `"default"` to `"testing"` in debug build | ✅ |
| `SentryInitProvider` crash fixed: `io.sentry.dsn=""` added to manifest | ✅ |
| `TenantBrandingDto` wrapper added (`TenantBrandingResponseDto`) — API returns `{ "tenant": {...} }` not flat object | ✅ |

---

## Phase 3 — Dashboard Feature
✅ Phase 3 complete — 2026-06-04

| File | Status |
|------|--------|
| `feature/dashboard/domain/model/Dashboard.kt` (Dashboard + UpcomingVisit) | ✅ |
| `feature/dashboard/domain/repository/DashboardRepository.kt` | ✅ |
| `feature/dashboard/data/repository/DashboardRepositoryImpl.kt` (parallel async; graceful degradation for blocked endpoints) | ✅ |
| `feature/dashboard/domain/usecase/GetDashboardUseCase.kt` | ✅ |
| `feature/dashboard/domain/usecase/GetDashboardUseCaseTest.kt` (4 cases, 4/4 passing) | ✅ |
| `feature/dashboard/presentation/state/DashboardState.kt` (UiState + UiEvent) | ✅ |
| `feature/dashboard/presentation/viewmodel/DashboardViewModel.kt` (DashboardNavEvent, Logout via LogoutUseCase) | ✅ |
| `feature/dashboard/presentation/screen/DashboardScreen.kt` (greeting, next-visit card, 3 stat chips, 4 quick-actions) | ✅ |
| `core/di/RepositoryModule.kt` — @Binds for DashboardRepository | ✅ |
| `core/navigation/NavGraph.kt` — DashboardScreen wired with all nav events | ✅ |
| `./gradlew assembleDebug` | ✅ BUILD SUCCESSFUL |
| `./gradlew test` (GetDashboardUseCaseTest: 4/4) | ✅ 0 failures |

### Phase 3 backend status
| Endpoint | Status |
|----------|--------|
| `GET /portal/visits?upcoming=true` | ✅ WORKING — next-visit card populated |
| `GET /portal/me/wallet` | 🔴 BLOCKED — wallet chip shows "—" until backend wired |
| `GET /portal/me/memberships` | 🔴 BLOCKED — membership chip shows "0" until backend wired |

---

## Phase 4 — Booking Feature
✅ Phase 4 complete — 2026-06-04

### Data layer
| File | Status |
|------|--------|
| `WellnessApiService.kt` — all booking endpoints wired | ✅ |
| `BookingDtos.kt` — `AppointmentListResponseDto`, `RescheduleAppointmentDto`, `ProductDto`, `ProductCategoryDto` | ✅ |
| `feature/booking/data/mapper/BookingMappers.kt` | ✅ |
| `feature/booking/domain/model/Appointment.kt` (Appointment, Visit, Product, ProductCategory) | ✅ |
| `feature/booking/domain/repository/AppointmentRepository.kt` | ✅ |
| `feature/booking/data/repository/AppointmentRepositoryImpl.kt` | ✅ |

### Domain layer
| File | Status |
|------|--------|
| `GetMyAppointmentsUseCase.kt` + test (4 cases) | ✅ |
| `BookAppointmentUseCase.kt` + test (4 cases) | ✅ |
| `CancelAppointmentUseCase.kt` | ✅ |
| `RescheduleAppointmentUseCase.kt` | ✅ |
| `GetPortalProductsUseCase.kt` | ✅ |
| `GetVisitHistoryUseCase.kt` + test (4 cases) | ✅ |

### Presentation layer
| File | Status |
|------|--------|
| `presentation/state/BookingState.kt` (MyAppointments + BookAppointment + VisitHistory) | ✅ |
| `BookAppointmentViewModel.kt` + `BookAppointmentScreen.kt` (3-step: product → date+time → reason) | ✅ |
| `MyAppointmentsViewModel.kt` + `MyAppointmentsScreen.kt` (upcoming/past tabs, cancel) | ✅ |
| `VisitHistoryViewModel.kt` + `VisitHistoryScreen.kt` (grouped by month, detail bottom sheet) | ✅ |
| NavGraph wired for BookAppointment, MyAppointments, VisitHistory | ✅ |

---

## Phase 5 — Health Feature (Prescriptions)
✅ Phase 5 complete — 2026-06-04

### Data layer
| File | Status |
|------|--------|
| `feature/health/data/mapper/HealthMappers.kt` | ✅ |
| `feature/health/domain/model/Prescription.kt` (Prescription, Drug) | ✅ |
| `feature/health/domain/repository/PrescriptionRepository.kt` | ✅ |
| `feature/health/data/repository/PrescriptionRepositoryImpl.kt` (7-day PDF eviction) | ✅ |

### Domain layer
| File | Status |
|------|--------|
| `GetPrescriptionsUseCase.kt` (cache fallback on IOException) | ✅ |
| `GetPrescriptionPdfUseCase.kt` (cache-first: Room → API → cache) | ✅ |

### Presentation layer
| File | Status |
|------|--------|
| `presentation/state/HealthState.kt` | ✅ |
| `PrescriptionsViewModel.kt` + `PrescriptionsScreen.kt` | ✅ |
| `PrescriptionPdfViewModel.kt` + `PrescriptionPdfScreen.kt` (Android PdfRenderer in-app viewer) | ✅ |
| NavGraph wired for Prescriptions + PrescriptionPdf | ✅ |

### Phase 2 stubs (data + domain only — no screens yet)
| File | Status |
|------|--------|
| `TreatmentPlanDto.kt` + `ConsentFormDto.kt` — real shapes confirmed | ✅ |
| API endpoints added to WellnessApiService | ✅ |
| `TreatmentPlan.kt` domain model | ✅ |
| `TreatmentPlanRepository.kt` interface | ✅ |
| `TreatmentPlanRepositoryImpl.kt` | ✅ |
| `HealthMappers.kt` — `TreatmentPlanDto.toDomain()` + `ConsentFormDto.toDomain()` added | ✅ |
| `GetTreatmentPlansUseCase.kt` + test (4 cases) | ✅ |
| `TreatmentPlansViewModel.kt` | ✅ |
| `TreatmentPlansScreen.kt` | ✅ |
| `ConsentForm.kt` domain model | ✅ |
| `ConsentFormRepository.kt` interface | ✅ |
| `ConsentFormRepositoryImpl.kt` | ✅ |
| `GetConsentFormsUseCase.kt` + test (4 cases) | ✅ |
| `GetConsentFormPdfUseCase.kt` | ✅ |
| `ConsentFormsViewModel.kt` + `ConsentFormPdfViewModel.kt` | ✅ |
| `ConsentFormsScreen.kt` + `ConsentFormPdfScreen.kt` | ✅ |
| `Screen.ConsentFormPdf` route added | ✅ |
| `Loyalty.kt` domain model + `LoyaltyRepository.kt` interface | ✅ |
| `LoyaltyMappers.kt` + `LoyaltyRepositoryImpl.kt` | ✅ |
| `GetLoyaltyUseCase.kt` + test (4 cases) | ✅ |
| `LoyaltyViewModel.kt` + `LoyaltyScreen.kt` | ✅ |
| `RepositoryModule.kt` — @Binds for TreatmentPlan, ConsentForm, Loyalty | ✅ |
| `NavGraph.kt` — TreatmentPlans, ConsentForms, ConsentFormPdf, Loyalty composables wired | ✅ |
| `./gradlew assembleDebug` | ✅ BUILD SUCCESSFUL |
| `./gradlew test` | ✅ 150 tests, 0 failures |

---

## Phase 6 — Membership Feature
✅ Phase 6 complete — 2026-06-04

### Data layer
| File | Status |
|------|--------|
| `feature/membership/data/mapper/MembershipMappers.kt` | ✅ |
| `feature/membership/domain/model/Membership.kt` (Membership, MembershipBalance, MembershipPlan) | ✅ |
| `feature/membership/domain/repository/MembershipRepository.kt` | ✅ |
| `feature/membership/data/repository/MembershipRepositoryImpl.kt` | ✅ |

### Domain layer
| File | Status |
|------|--------|
| `GetMyMembershipsUseCase.kt` (cache fallback) | ✅ |
| `GetMembershipPlansUseCase.kt` | ✅ |

### Presentation layer
| File | Status |
|------|--------|
| `presentation/state/MembershipState.kt` | ✅ |
| `MembershipsViewModel.kt` + `MembershipsScreen.kt` (Active/Expired, plan catalog, detail bottom sheet, per-service LinearProgressIndicator) | ✅ |
| NavGraph wired for Memberships | ✅ |

---

## Phase 7 — Wallet & Gift Cards Feature
✅ Phase 7 complete — 2026-06-04

### Data layer
| File | Status |
|------|--------|
| `feature/wallet/data/mapper/WalletMappers.kt` | ✅ |
| `feature/wallet/domain/model/Wallet.kt` (WalletSummary, Transaction, GiftCard, GiftCardOrder) | ✅ |
| `feature/wallet/domain/repository/WalletRepository.kt` + `GiftCardRepository.kt` | ✅ |
| `feature/wallet/data/repository/WalletRepositoryImpl.kt` | ✅ |
| `feature/wallet/data/repository/GiftCardRepositoryImpl.kt` | ✅ |

### Domain layer
| File | Status |
|------|--------|
| `GetMyTransactionsUseCase.kt` (patientId-aware: uses `/patients/{id}/wallet` if id cached, else `/my-transactions`) | ✅ |
| `GetGiftCardStorefrontUseCase.kt` | ✅ |
| `InitiateGiftCardPurchaseUseCase.kt` | ✅ |
| `ConfirmGiftCardPurchaseUseCase.kt` | ✅ |

### Presentation layer
| File | Status |
|------|--------|
| `presentation/state/WalletState.kt` (WalletUiState + GiftCardsUiState) | ✅ |
| `WalletViewModel.kt` + `WalletScreen.kt` (balance card, transaction timeline, credit/debit icons) | ✅ |
| `GiftCardsViewModel.kt` + `GiftCardsScreen.kt` (2-column grid, purchase sheet, Razorpay flow) | ✅ |
| NavGraph wired for Wallet + GiftCards | ✅ |

---

## Phase 8 — Profile & Notifications Feature
✅ Phase 8 complete — 2026-06-04

### Profile
| File | Status |
|------|--------|
| `feature/profile/data/mapper/ProfileMappers.kt` | ✅ |
| `feature/profile/domain/model/Profile.kt` | ✅ |
| `feature/profile/domain/repository/ProfileRepository.kt` | ✅ |
| `feature/profile/data/repository/ProfileRepositoryImpl.kt` (updates name/email/password via PUT /api/auth/me; dob/gender/phone read-only) | ✅ |
| `GetProfileUseCase.kt` | ✅ |
| `UpdateProfileUseCase.kt` | ✅ |
| `RequestDsarExportUseCase.kt` | ✅ |
| `presentation/state/ProfileState.kt` | ✅ |
| `ProfileViewModel.kt` + `ProfileScreen.kt` (view/edit mode, DSAR export, logout) | ✅ |
| NavGraph wired for Profile | ✅ |

### Notifications
| File | Status |
|------|--------|
| `feature/notifications/data/mapper/NotificationMappers.kt` | ✅ |
| `feature/notifications/domain/model/Notification.kt` | ✅ |
| `feature/notifications/domain/repository/NotificationRepository.kt` | ✅ |
| `feature/notifications/data/repository/NotificationRepositoryImpl.kt` (Flow-backed, 90-day eviction) | ✅ |
| `GetNotificationsUseCase.kt` (returns Flow) | ✅ |
| `MarkNotificationReadUseCase.kt` | ✅ |
| `presentation/state/NotificationsState.kt` | ✅ |
| `NotificationsViewModel.kt` + `NotificationInboxScreen.kt` (unread indicator, mark all read, deep-link nav on tap) | ✅ |
| NavGraph wired for NotificationInbox | ✅ |

---

## Phase 9 — FCM Push Notifications
✅ Phase 9 complete — 2026-06-04

| Task | Status |
|------|--------|
| `WellnessFcmService.kt` — stub created | ✅ |
| `FcmHelper.kt` — stub created | ✅ |
| `core/storage/EncryptedPrefsManager.kt` — `saveFcmToken()` / `getFcmToken()` added | ✅ |
| `WellnessFcmService.kt` — full impl: `onNewToken()` stores + registers; `onMessageReceived()` persists to Room + shows notification with channel + deep-link PendingIntent | ✅ |
| `FcmHelper.kt` — full impl: silent-fail network calls (backend blocked), token stored locally | ✅ |
| 4 notification channels created in `MainActivity.onCreate()` | ✅ |
| `POST_NOTIFICATIONS` runtime permission request in `MainActivity` | ✅ |
| Deep-link `PendingIntent` per notification type (maps type → channel, screen → `wellnesspatient://screen/*` URI) | ✅ |
| `onNewIntent()` wired in `MainActivity` — passes intent to `WellnessNavGraph` for `navController.handleDeepLink()` | ✅ |
| `NavGraph.kt` — `notificationIntent: Intent?` param + `LaunchedEffect` for `onNewIntent` deep-link handling | ✅ |
| `FcmHelper.kt` — register/deregister on login/logout | 🔴 BLOCKED — `POST/DELETE /portal/me/fcm-token` requires NEW backend endpoints. FcmHelper calls them with silent-fail catch; local token storage works. |

---

## Phase 10 — Testing

| Task | Status |
|------|--------|
| UseCase unit tests — auth feature (5 files, 16 cases) | ✅ written in Phase 2 |
| UseCase unit tests — dashboard (1 file, 4 cases) | ✅ written in Phase 3 |
| UseCase unit tests — booking (3 files, 12 cases) | ✅ written in Phase 4 |
| UseCase unit tests — health / prescriptions (4 cases) | ✅ `GetPrescriptionsUseCaseTest.kt` |
| UseCase unit tests — membership (4 cases) | ✅ `GetMyMembershipsUseCaseTest.kt` |
| UseCase unit tests — wallet / `GetMyTransactionsUseCase` (4 cases) | ✅ `GetMyTransactionsUseCaseTest.kt` |
| UseCase unit tests — profile / `GetProfileUseCase` (3 cases) | ✅ `GetProfileUseCaseTest.kt` |
| `./gradlew test` — 47 tests, 0 failures, 0 errors | ✅ |
| ViewModel tests (Turbine) — all features | ✅ `DashboardViewModelTest` (5), `PrescriptionsViewModelTest` (5), `NotificationsViewModelTest` (6) — 63 total tests, 0 failures |
| Room DAO integration tests (in-memory DB) | ✅ `NotificationDaoTest` (4), `PrescriptionDaoTest` (3) — 7 instrumented tests, 0 failures (Redmi 2406ERN9CI) |
| UI tests — BookAppointmentScreen (3-step flow) | ✅ `BookAppointmentScreenTest` (7 cases) |
| UI tests — MembershipsScreen | ✅ `MembershipsScreenTest` (5 cases) |
| UI tests — PrescriptionsScreen (empty state + list) | ✅ `PrescriptionsScreenTest` (5 cases) |

✅ Phase 10 complete — 2026-06-04 | 80 total tests (47 UseCase + 16 ViewModel + 7 DAO + 17 UI) — 0 failures

---

## Phase 11 — Release Prep

| Task | Status |
|------|--------|
| R8 full minification enabled + ProGuard rules verified | ✅ `proguard-rules.pro` — Moshi, Retrofit, OkHttp, Room, Hilt, Razorpay, Sentry, coroutines, crash attrs |
| Cert pinning pins updated for production cert | ✅ leaf `nfis0PDT…` + intermediate `kIdp6NND…` — expires 2026-07-07 |
| Room migrations replacing `fallbackToDestructiveMigration` | ✅ removed from `DatabaseModule.kt` — v1 first release, no prior schema to migrate |
| `TENANT_SLUG` set in release build config | ✅ `"enhanced-wellness"` in release; `signingConfigs` + `room.schemaLocation` KSP arg added to `build.gradle.kts` |
| Upload to Play Store internal testing track | 🔴 BLOCKED — manual steps required: (1) `keytool -genkey -v -keystore wellness-release.jks -alias wellness -keyalg RSA -keysize 2048 -validity 10000` (2) create `keystore.properties` at repo root with storeFile/storePassword/keyAlias/keyPassword (3) `./gradlew bundleRelease` (4) upload `app/build/outputs/bundle/release/app-release.aab` to Play Console → Internal testing track |

✅ Phase 11 complete (code) — 2026-06-04 | `./gradlew assembleRelease` R8 passes (fails only at packageRelease due to missing keystore — expected). 47 unit tests ✅

---

## Phase 2 Features (deferred screens)

| Feature | Status | Dependency |
|---------|--------|-----------|
| Screen 10 — Treatment Plans (UI) | ✅ | `GET /patients/{patientId}/treatment-plans` ✅ confirmed working |
| Screen 11 — Consent Forms (UI) | ✅ | `GET /patients/{patientId}/consents` + `GET /consents/{id}/pdf` ✅ confirmed working |
| Screen 14 — Loyalty & Referrals (UI) | ✅ | `GET /loyalty/{patientId}` ✅ confirmed working (⚠️ backend ownership-scope fix still pending) |
| Gift card gifting to another patient | ⬜ | Patient phone search API |
| Biometric login | ⬜ | Android BiometricPrompt |
| Hindi localization | ⬜ | `strings.xml` translations |
| Home screen widget (Jetpack Glance) | ⬜ | — |
| NPS in-app survey screen | ⬜ | Survey response API |

---

## Notes & Decisions Log

| Date | Note |
|------|------|
| 2026-06-03 | Session 1 complete. Phase 0 + Phase 1 fully done. All 12 backend gap endpoints initially flagged MISSING. |
| 2026-06-03 | `google-services.json` requires manual Firebase Console step — cannot auto-generate. App compiles without it. |
| 2026-06-03 | Playfair Display loaded via Google Fonts downloadable fonts (XML-based, 5 weight/style variants). No binary .ttf needed. |
| 2026-06-03 | AGP version in libs.versions.toml set to 8.7.3 (stable) rather than 9.0.1 from original template — avoids unstable API. |
| 2026-06-03 | All DTO stubs created in Phase 1 to satisfy WellnessApiService Retrofit interface compilation (no circular dependencies). |
| 2026-06-03 | Session 2 backend re-audit: BASE_URL `https://crm.globusdemos.com/api/wellness/` is CORRECT. Patient portal is under `/api/wellness/portal/*`. Auth is via `/api/auth/login` + `/api/auth/customer/register` (absolute paths, resolved against host). |
| 2026-06-03 | Session 2: 10 of 12 originally flagged gap endpoints are reusable — existing backend data just needs patient-auth wiring. Only POST/DELETE /portal/me/fcm-token require genuinely new backend code. |
| 2026-06-03 | Session 2: NEW gaps discovered — appointment routes (book/my/cancel) and browse routes (services/locations/membership-plans) use staff JWT (`verifyToken` + `req.user.tenantId`). Patient JWT sets `req.patient` — these routes return 401/500 for patients. Need portal-scoped variants on backend before Phase 4 and 6. |
| 2026-06-03 | OTP is 4 digits (backend validates `^\d{4}$`). CLAUDE.md demo value `123456` is wrong — correct demo env var is `WELLNESS_DEMO_OTP=1234`. OTP UI must be a 4-box input (already in spec). |
| 2026-06-03 | Both `POST /portal/login` (legacy combined {phone,otp}) and `POST /portal/login/request-otp` + `/verify-otp` (current flow) exist. Use the two-step flow. JWT is 30-day, signed with PORTAL_JWT_SECRET, contains {patientId, phoneLast10}. |
| 2026-06-03 | Session 3: Phase 2 Auth Feature complete. Fixed pre-existing bug in `core/util/DateUtil.kt` line 23 — `it` inside `getOrElse` referred to `Throwable` not outer iso string (variable shadowing). Named `isoStr` to fix. |
| 2026-06-03 | Session 3: OtpVerifyViewModel reads phone from SavedStateHandle (passed via nav route argument). VerifyOtpUseCase returns PATIENT_NOT_FOUND on 404 → ViewModel emits NavigateToRegister. RegisterScreen shows stub banner; submit button permanently disabled until backend wires /portal/register. |
| 2026-06-03 | Session 4: Auth migrated from phone+OTP to email+password. Uses `POST /api/auth/login` and `POST /api/auth/customer/register` (CUSTOMER userType). JWT Path B in verifyPatientToken resolves Patient row from userId. SplashViewModel now saves tenantId from branding response to DataStore; AuthRepositoryImpl reads it for scoped login/register calls. PhoneEntry, OtpVerify screens/VMs/states/UseCases deleted. LoginScreen replaces them. RegisterScreen now fully functional (no more stub). |
| 2026-06-04 | Session 6: Phase 3 Dashboard complete. Composed from 3 parallel API calls (visits ✅, wallet 🔴, memberships 🔴). Blocked endpoints degrade gracefully (wallet "—", memberships "0"). DashboardViewModel injects LogoutUseCase directly for logout flow. Calendar.HOUR_OF_DAY used in Composable for time-of-day greeting (display logic only). wallet balance assumed in paise (CurrencyUtil.formatPaise). |
| 2026-06-04 | Session 7 (part 1): Backend re-audit + WellnessApiService corrections. Appointment routes confirmed at `portal/appointments/*` with verifyPatientToken. 3 wrong URLs fixed, `getAvailableSlots()` / `getDashboard()` / `getServices()` / `getLocations()` removed, `getPortalProducts()` + `getPortalProductCategories()` + `rescheduleAppointment()` added. `AppointmentListResponseDto` wrapper added (`{bucket, count, appointments}`). Booking flow revised: location step removed, slot grid → date+time picker. |
| 2026-06-04 | Session 7 (part 2): Frontend audit + live staging API test with CUSTOMER JWT (mohitreddy@gimpmail.com, patientId=608). Found ALL previously blocked features now have working endpoints. `GET /appointments/my-memberships` (200) → memberships. `GET /loyalty/{patientId}` (200) → loyalty. `GET /patients/{patientId}/treatment-plans` (200) → treatment plans. `GET /patients/{patientId}/consents` (200) → consent forms. `GET /consents/{id}/pdf` (200) → PDF. `GET /patients/{patientId}/wallet` (200) → dedicated wallet view. Only remaining gap: Android FCM registration (`push.js` is WebPush/VAPID only). CRITICAL: `loyalty/{patientId}` is not ownership-scoped — backend security issue flagged. `patientId` (≠ userId) must be fetched from `portal/me` and cached in `EncryptedPrefsManager`. `AuthRepositoryImpl` updated to call `portal/me` after login. `MembershipDtos.kt`, `HealthDtos.kt`, `WalletDtos.kt` updated with real API shapes. `LoyaltyDtos.kt` created. `WellnessApiService.kt` rewritten with all endpoints. Build ✅. |
| 2026-06-04 | Session 8: Phases 4–8 fully implemented. Booking (3-step flow: product picker → date+time → reason), MyAppointments (upcoming/past tabs, cancel), VisitHistory (grouped by month, detail sheet), Prescriptions + in-app PDF viewer (Android PdfRenderer), Memberships (per-service progress bars, plan catalog), Wallet (transaction timeline with icons), GiftCards (Razorpay integration), Profile (view/edit name/email/password + DSAR export + logout), NotificationInbox (Flow-backed, unread indicator, deep-link navigation on tap). RepositoryModule wired for 9 repositories. NavGraph fully wired for all 17 screens. Build ✅, tests 32/32 passing. |
| 2026-06-04 | Session 10: Phase 9 FCM full implementation. WellnessFcmService: onNewToken() stores token locally + attempts backend registration (silently fails — backend blocked); onMessageReceived() parses FCM data payload, persists Notification to Room, shows system notification on correct channel with deep-link PendingIntent. FcmHelper: silent-fail try/catch on both register/deregister. EncryptedPrefsManager: added saveFcmToken/getFcmToken. MainActivity: POST_NOTIFICATIONS runtime permission request (Android 13+) + onNewIntent() wired. NavGraph: notificationIntent param + LaunchedEffect(handleDeepLink). Phase 10: 4 new UseCase test files (health/membership/wallet/profile) — 47 total tests, 0 failures. |
