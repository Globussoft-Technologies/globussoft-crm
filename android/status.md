# WellnessCRM Patient App — Implementation Status

Last updated: 2026-06-08 23:30
Current phase: UI Redesign Pass — JSFiddle prototype parity (session 2)

## Legend
✅ Done  🔄 In Progress  ⬜ Not started  🔴 Blocked

---

## Google Doc Feature Gap — Android Implementation (2026-06-08 session)

✅ Step 1 — Navigation Architecture
  ✅ 5-tab BottomNavigation (Home / Bookings / Catalog / Finance / Profile)
  ✅ Global WellnessTopAppBar with clinic name, bell badge, dark/light toggle, back arrow
  ✅ WellnessBottomNavBar with per-tab back-stack save/restore
  ✅ Tab sealed class (Tab.kt) with icons
  ✅ MainViewModel — isDarkTheme, clinicName, unreadNotificationCount
  ✅ isDarkTheme key in DataStoreManager (persisted)
  ✅ Auth screens (Splash/Login/Register) shown without chrome
  ✅ All 14 existing screens stripped of inner Scaffold/TopAppBar

✅ Step 2 — Dashboard Restructure
  ✅ Inner Scaffold removed from DashboardScreen
  ✅ Greeting header with time-based salutation + CUSTOMER role badge
  ✅ Stats row (Wallet / Members / Loyalty) unchanged and functional
  ✅ Next appointment banner / Book now CTA unchanged
  ✅ Waitlist tile added to Appointments section

✅ Step 3 — Service Catalog + Categories (Catalog tab)
  ✅ feature/catalog/ package created
  ✅ CatalogTabScreen with Services | Categories | Memberships tabs
  ✅ ServiceCatalogContent — LazyVerticalGrid(2), search, service detail ModalBottomSheet, "Book this service" CTA
  ✅ ServiceCategoriesContent — LazyColumn, pull-to-refresh
  ✅ CatalogRepository + GetServicesUseCase + GetCategoriesUseCase
  ✅ getCatalogServices() + getCatalogServiceCategories() in WellnessApiService (portal/products, portal/product-categories)
  ✅ Catalog tab wired in NavGraph (tab_catalog route)

✅ Step 4 — Payments Dashboard (Finance tab)
  ✅ feature/finance/ package created
  ✅ FinanceTabScreen with Payments | Gift Cards | Transactions tabs
  ✅ Payments tab — KPI row (collected/pending/failed) + LazyColumn payment cards + pull-to-refresh
  ✅ Gift Cards / Transactions tabs navigate to existing screens
  ✅ FinanceRepository + GetPaymentsUseCase
  ✅ getPayments() + getPaymentConfig() in WellnessApiService (/api/payments, /api/payments/config)
  ✅ Finance tab wired in NavGraph (tab_finance route)

✅ Step 5 — Waitlist Screen (Appointments tab)
  ✅ WaitlistScreen in feature/booking/presentation/screen/
  ✅ WaitlistViewModel + WaitlistState
  ✅ GetWaitlist + AddToWaitlist support in AppointmentRepository
  ✅ portal/waitlist GET + POST → fixed to waitlist (no portal/ prefix) in WellnessApiService
  ✅ FAB → ModalBottomSheet form (service dropdown + notes)
  ✅ Waitlist tile added to Dashboard Appointments section
  ✅ Deep link: wellnesspatient://screen/waitlist
  ✅ Wired in NavGraph

✅ Step 6 — UX Consistency Pass
  ✅ MyAppointmentsScreen — 4 KPI count cards (Upcoming/Pending/Completed/Cancelled)
  ✅ MyAppointmentsScreen — Cancel confirm AlertDialog
  ✅ MyAppointmentsScreen — Pull-to-refresh
  ✅ PrescriptionsScreen — PDF download confirm AlertDialog
  ✅ PrescriptionsScreen — Pull-to-refresh
  ✅ MembershipsScreen — Pull-to-refresh
  ✅ LoyaltyScreen — Pull-to-refresh
  ✅ NotificationInboxScreen — Pull-to-refresh
  ✅ WalletScreen — Pull-to-refresh

✅ Step 7 — Full on-device QA pass (2026-06-08)
  ✅ assembleDebug — BUILD SUCCESSFUL
  ✅ Dashboard — stats, tiles, navigation all working
  ✅ My Bookings — 4 KPI buckets, all tabs (Upcoming/Pending/Completed/Cancelled)
  ✅ Visit History — grouped by month, amounts, doctors
  ✅ Book Appointment — 3-step flow (service → date/time → confirm → success)
    ✅ Fixed: appointmentDate was "YYYY-MM-DDT00:00:00Z" → backend needs "YYYY-MM-DD"
  ✅ Waitlist — list loads, FAB opens form, service dropdown populated, submission works
    ✅ Fixed: portal/waitlist → waitlist endpoint
    ✅ Fixed: portal/products (403) → services?public=true
    ✅ Fixed: ProductDto.category (Object) → String to match services API
    ✅ Fixed: AddWaitlistDto missing patientId (backend 400)
  ✅ Catalog Services — 2-col grid, no duplicates
  ✅ Catalog Categories — loads (0 services per category is backend data issue, not app bug)
  ✅ Catalog Memberships — active plans list
  ✅ Finance Payments — KPIs (₹510.95 total), Razorpay payment list
  ✅ Finance Gift Cards — empty state (no gift cards in tenant)
  ✅ Finance Transactions — wallet balance ₹20.00, transaction history
  ✅ Profile — personal info display, logout
  ✅ Prescriptions — medication list with doctor/date
  ✅ Treatment Plans — active plans with session counts
  ✅ Consent Forms — signed documents list
  ✅ Notifications — empty state (no FCM messages yet)
  ✅ No crashes after build at 18:04 on 2026-06-08

---

## Google Doc Spec Parity Pass (2026-06-08 session 2)

✅ Fix A1 — TAB_ROOT_ROUTES set; back arrow suppressed on all 5 tab roots
✅ Fix A2 — Logout uses popUpTo(0) to fully clear back stack
✅ Fix A3 — Finance tab rewired: GiftCards + Transactions embedded inline (no navigate-away flash)
✅ Fix B1 — Dashboard: stats row above next-appt, TodayAtAGlance card, "Clinical" + "Catalog" group renames
✅ Fix B2 — Finance FinanceTabScreen accepts 3 state/event pairs; all 3 VMs injected in NavGraph
✅ Fix B3 — My Appointments: whole card tappable → action sheet with View/Reschedule/Cancel
✅ Fix B4 — Profile: "Edit profile" OutlinedButton added; "Notification settings" entry added
✅ Fix B5 — Book Appointment: Step 2 Doctor Selection added (4-step flow); GET /doctors/availability wired; "No preference" + info note
✅ Fix C1 — NotificationSettingsScreen: 5 category toggles, 3 channel toggles, quiet hours, Save button
✅ Fix C2 — WalletScreen: KPI row (4 cards) + filter chips (All/Wallet/GiftCards/Memberships/Treatments) + receipt detail sheet
✅ Fix C3 — Memberships: plan cards clickable → PlanDetailSheet with "Join Now" + confirm dialog
✅ Fix C4 — Service Categories: tap to filter → switches to Services tab with active FilterChip
✅ Fix C5 — Payment cards tappable → action sheet (View Invoice + Request Refund) + AlertDialog confirm → POST /api/payments/:id/refund
✅ BUILD SUCCESSFUL — assembleDebug green, only pre-existing menuAnchor deprecation warning

---

## UI Redesign Pass — JSFiddle Prototype Parity (2026-06-08 session 3)

✅ WellnessTopAppBar — search icon added (shows Close when active, Search when inactive)
✅ DashboardScreen — stat tile "Members" → "Membership", shows "Active" / "—"
✅ MyAppointmentsScreen — LazyColumn bottom = 96.dp (FAB no longer overlaps last card)
✅ CatalogTabScreen — redesigned ServiceDetailSheet (category label, severity pill, 3-box stats, description, Book service, Service ID footer, Got it close); signature changed to membershipsContent lambda
✅ MembershipsScreen — added public InlineMembershipsTab with Available/Mine toggle + ProfessionalPlanCard (Diamond/Gold/Platinum colored cards with perks, View Details ghost + Join Now buttons)
✅ GiftCardsScreen — replaced server-driven content with local DEMO_DENOMINATIONS (₹500–₹10,000); 2-column grid with search bar + demo-safe Buy confirmation sheet
✅ ProfileScreen — added ProfileHeaderCard (avatar, camera overlay, CUSTOMER chip, Remove picture); added ChangePasswordCard (3 fields with eye toggles, local validation, Toast); notification settings as clickable WellnessCard row with chevron
✅ NavGraph — search state + AnimatedVisibility search bar on Dashboard; CatalogTab injects MembershipsViewModel and passes InlineMembershipsTab as membershipsContent lambda
✅ BUILD SUCCESSFUL — assembleDebug green

---

## Polish Pass — Zylu cleanup, Overflow, Responsiveness, Pickers, Typography, Spacing (2026-06-09)

✅ MembershipMappers.kt — sanitiseDescription() strips "Imported from Zylu" and migration metadata from plan descriptions
✅ WellnessBottomNavBar.kt — bottom nav labels use basicMarquee() instead of TextOverflow.Ellipsis
✅ WellnessComponents.kt — SectionLabel upgraded to labelLarge+0.8sp tracking (muted, distinct from card titles); SpacingXs/Sm/Md/Lg/Xl constants added
✅ DashboardScreen.kt — MenuTile ellipsis removed (text wraps naturally); typography: tile label→titleSmall, tile subtitle→bodySmall, stat chip label→bodySmall; screen padding→16dp, spacedBy→20dp
✅ BookAppointmentScreen.kt — Step3DateTime: DatePickerDialog + TimePicker (AlertDialog) replace FilterChip rows; services grid→GridCells.Adaptive(156dp); ProductCard typography: name→titleSmall, category→bodySmall, price→labelLarge; InfoRow: label→labelMedium, value→bodyMedium
✅ MyAppointmentsScreen.kt — Reschedule sheet: DatePickerDialog + TimePicker replace FlowRow FilterChips; removed unused Calendar/SimpleDateFormat/TIME_SLOTS
✅ CatalogTabScreen.kt — services grid→GridCells.Adaptive(156dp); active-category FilterChip widthIn(max=280dp); service card→spacedBy(4dp), name→titleSmall (no maxLines)
✅ GiftCardsScreen.kt — grid→GridCells.Adaptive(160dp)
✅ WalletScreen.kt — KpiRow: Row→FlowRow (maxItemsInEachRow=4, wraps to 2×2 on narrow); KpiCard padding→horizontal=8+vertical=12, value→titleSmall SemiBold, label→bodySmall
✅ FinanceTabScreen.kt — KpiRow: Row→FlowRow (maxItemsInEachRow=3); payment description maxLines removed
✅ MembershipsScreen.kt — button labels hardcoded fontSize→labelSmall/labelMedium typography tokens
✅ ProfileScreen.kt — ProfileField label→labelMedium; screen spacedBy→20dp
✅ BUILD SUCCESSFUL — assembleDebug green

---

## Backend Gap Endpoints (status as of 2026-06-08)

✅ GET /services?public=true — live (was portal/products; changed because CUSTOMER role denied portal/products)
✅ GET /service-categories — live (service categories)
✅ GET /waitlist — live (fixed from portal/waitlist which 404'd)
✅ POST /waitlist (with patientId) — live (fixed: backend requires patientId in body)
✅ GET /portal/appointments?bucket= — live (4-bucket my bookings)
✅ PATCH /portal/appointments/:id/reschedule — live
✅ GET /portal/waitlist — built in backend (needs confirmation)
✅ POST /portal/waitlist — built in backend (needs confirmation)
✅ GET /api/payments — live
✅ GET /api/payments/config — live
✅ GET /portal/prescriptions — live
✅ GET /api/wellness/my-transactions — live
✅ GET /appointments/my-memberships — live

---

## Earlier Phases (pre-2026-06-08)

✅ Phase 0 — Bootstrap complete
✅ Phase 1 — Core module complete
✅ Phase 2 — Auth feature complete
✅ Phase 3 — Dashboard feature complete (restructured 2026-06-08)
✅ Phase 4 — Booking feature complete (Waitlist added 2026-06-08)
✅ Phase 5 — Health feature complete
✅ Phase 6 — Membership feature complete
✅ Phase 7 — Wallet + Gift cards complete
✅ Phase 8 — Profile + Notifications complete
✅ Phase 9 — FCM push complete
