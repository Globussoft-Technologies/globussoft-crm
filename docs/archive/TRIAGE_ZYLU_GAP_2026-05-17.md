# Zylu-Gap Triage — 2026-05-17

**HEAD scanned:** `741d8483c6a14e176b7a26d23db906abd5eb7945`
**Issues triaged:** 49 (matches expected count, no data drift)
**Triage discipline:** `verifying-issue-before-pickup` grep-audit applied per issue against actual code in `backend/routes/`, `backend/prisma/schema.prisma`, `backend/lib/`, `backend/cron/`, and `frontend/src/`.

## Executive summary

- **24 PHANTOM** — already shipped (schema, route, frontend page, cron, or all of the above). Close immediately with a one-line citation; ~10 min of bulk close-with-comment work, not engineering work. This is the single biggest finding — half the Zylu-Gap list is duplicate of work already landed in Wave 2 + Wave 7 + Wave 11 + Wave 6a + PRD Gap §13.
- **14 SHIP-NOW** — narrow gaps reachable in <4h each. Mostly UI surfacing of already-shipped backend (Cash Register admin page, Calendar tab on Attendance, Mini-Website snippet display, mark-resolve button) or 1-2 missing model columns (anniversary/gst already in schema, but wellness route doesn't read them). Total estimated effort: ~28 h (one focused day for one engineer, or one 4-agent wave).
- **7 PLAN** — multi-day investments that need product input or new module work (granular Roles UI matrix expansion across all modules, biometric vendor integration for ESSL/Realtime, full payroll CSV w/ deductions, Mini-Website page editor as a separate Settings surface from BookingPages, wallet bonus-rules + expiry engine, CSV import for customers/patients/packages, attendance Calendar+Leave unified calendar). ~3 dev-weeks total.
- **4 SKIP / DEFER** — out of scope for current direction or external-blocked: full Roles UI parity with Zylu (already covered by FieldPermissions module×action matrix shipped 2026-05-x; further work is cosmetic), polymorphic invoice replacement at the wellness tenant (POS already uses Sale+SaleLineItem; rebuilding `Invoice` to match Zylu's exact shape conflicts with the existing /api/v1/invoices public API contract), Zapier-style Catalog Import for bookings (different problem from CSV import — defer to Phase 2 PRD), and #790 CASH-001 cashback engine **already wired** but framing was "unverified" — verification belongs in the gate spec, not a fix.

## Triage matrix

Effort buckets: `30m` `1h` `2h` `4h` `1d` `2d` `3d` `1w` `2w`.

| # | Title | Verdict | Effort | Dependency | Notes / proof |
|---|---|---|---|---|---|
| #770 | POS-001 No Cash Register admin page — POS permanently gated | SHIP-NOW | 2h | none — backend routes exist | `backend/routes/pos.js:147-264` has full Register CRUD (`/api/pos/registers` GET/POST/PUT/DELETE). Just need a `frontend/src/pages/wellness/CashRegisters.jsx` admin page + sidebar entry. Sibling pattern: `Locations.jsx`. |
| #771 | POS-002 Booking/Walk-in tabs | PLAN | 1d | needs design call — current POS uses `bookingId`-link semantics implicitly | `PointOfSale.jsx` is monolithic single-screen. Restructure to URL-driven tabs (`?type=booking|walkin`) requires deciding what booking-id auto-fill does for the line-item builder. |
| #772 | POS-003 Guest Checkout toggle | PHANTOM | — | — | **Already shipped** in Wave 7C (`PointOfSale.jsx:89` `const [guestCheckout, setGuestCheckout] = useState(false);` + UI section + `patientId=null` on submit). Issue body even cites "Wave 7C extras" pattern. Close. |
| #773 | POS-004 Polymorphic line buttons | PHANTOM | — | — | **Already shipped**. `PointOfSale.jsx:52-58` has `LINE_TYPES = ['SERVICE','PRODUCT','MEMBERSHIP','GIFTCARD','PACKAGE']` and `pos.js:526` `VALID_LINE_TYPES`. Polymorphic `SaleLineItem.lineType + refId` schema at `schema.prisma:3693`. Only Wallet Top-up is not a separate line type (wallet credit/debit are direct ledger writes via `/wallet/:id/credit`). Close with note. |
| #774 | POS-005 Discount/Coupon/Manager/Notes/Save Draft | PHANTOM | — | — | **Already shipped** in Wave 7C: `PointOfSale.jsx:91-100` has `discountMode (percent/flat/coupon)`, `couponCode`, `overrideEnabled` (manager override w/ reason) + AuditLog wire. The `Save Draft` action could be a small follow-up but the rest is done. Close (or downgrade to a tiny SHIP-NOW if the user wants Save-Draft specifically). |
| #775 | POS-006 Polymorphic invoice schema | SKIP / DEFER | — | conflicts with existing `/api/v1/invoices` contract | The wellness tenant uses `Sale + SaleLineItem` (cash-and-carry checkout) at `pos.js`. The generic `Invoice` model + `/api/v1/invoices` shim has different semantics (deferred-revenue, dunning, multi-line). Rebuilding `Invoice` to match Zylu's spec breaks the public-API contract that scim/zapier consumers depend on. PRD Gap §2 already decided this tradeoff — the wellness POS uses Sale, the generic API uses Invoice. Close with rationale. |
| #776 | POS-007 REST APIs not implemented | PHANTOM | — | — | **Already shipped** at `backend/routes/v1_invoices.js`: `POST /api/v1/invoices`, `PATCH /:id`, `POST /:id/payments`, `POST /:id/complete` all live. `payments` endpoint computes running sum with `±0.01` tolerance and auto-flips to PAID. Sale-side equivalents at `pos.js`. Close. |
| #777 | POS-008 Inventory consumption + loyalty + SMS on invoice complete | PHANTOM | — | — | **Already shipped**. Inventory via `backend/lib/autoConsumptionApplier.js` wired into Sale completion; loyalty via `maybeAutoCreditLoyaltyForSale()` at `pos.js:68`; SMS receipt dispatch wired post-completion. Close. |
| #778 | POS-009 Invoice PDF + SMS/WhatsApp receipt | PHANTOM | — | — | **Already shipped**. `backend/routes/billing.js:459 router.get("/:id/pdf"...)` renders a pdfkit invoice. Dispatch surface = same receipt-channel config used by POS-008 above. Close. |
| #779 | CR-001 Open Shift / Closing / Deposit / Withdrawal | SHIP-NOW | 4h | none — partial backend exists | Open Shift + Set Closing Balance + Close Shift ARE shipped (`pos.js:298 /shifts/open`, `pos.js:367 /shifts/:id/close`). **Deposit + Withdrawal flows are NOT shipped.** Add `POST /api/pos/shifts/:id/deposit` + `/withdraw` routes (idempotent ledger writes) + frontend buttons. Variance already computed. |
| #780 | CR-002 Register status header (Opened/Closed) + total balance | SHIP-NOW | 1h | depends on #770 page existing | Once #770 ships the Cash Registers page, header is a `<RegisterStatusPill status="OPEN" balance={...}>` chip on each register row. Backend data already in `/api/pos/registers` + `/api/pos/shifts/current`. |
| #781 | CR-003 Recent Transactions per shift split into 3 buckets | SHIP-NOW | 2h | depends on #770 page existing | Backend `GET /api/pos/shifts/:id` already returns the shift with sales. Frontend needs to group sales by source (BookingsCash via Sale.bookingId presence, PartialCash via splitMethod, ExpensesCash via separate Expense.shiftId — that column may need adding). Verify Expense.shiftId column exists first. |
| #782 | CR-004 Auto-post cash invoices to open shift + variance flag | PHANTOM | — | — | **Already shipped**. `pos.js:393-435` computes `expectedCash = openingFloat + sum(CASH sales during shift)` on close + persists variance + emits `shift.closed` event with `{ variance, expectedCash, actualCash }`. Cash sales are auto-attached to the currently-open shift via the `shiftId` param on `POST /api/pos/sales`. Close. |
| #783 | MEM-001 Sell Membership at POS + deferred-revenue ledger | PHANTOM | — | — | **Already shipped** (Wave 6a). `MEMBERSHIP` is in `VALID_LINE_TYPES` at `pos.js:526`. Sale completion creates `Membership` rows + emits `membership.enrolled`/`membership.renewed`. Deferred-revenue computation at `wellness.js:2943-2958`. Close. |
| #784 | MEM-002 Auto-apply membership benefits at POS line match | PHANTOM | — | — | **Already shipped**. `MembershipRedemption` model + `wellness.js:2870 emit('membership.benefit_applied')`. Benefit-application logic in the membership-redemption flow. Close. |
| #785 | MEM-003 Renew / Cancel-with-refund / Auto-debit | PHANTOM | — | — | **Already shipped**. `wellness.js:2969 router.post("/memberships/:id/cancel"...)` does cancel; renewal is emit `membership.renewed` at `wellness.js:2707`. Auto-debit hook exists in `cron/wellnessOpsEngine.js`. Close. |
| #786 | MEM-004 T-7 expiry reminder | PHANTOM | — | — | **Already shipped**. `cron/wellnessOpsEngine.js:19 MEMBERSHIP_EXPIRY_WINDOW_DAYS = 7`. Workflow event `membership.renewal_due` (T-7) wired at `routes/workflows.js:45`. Close. |
| #787 | MEM-005 Memberships dashboard — schema verification | PHANTOM | — | — | **Already shipped**. `schema.prisma:3073 MembershipPlan`, `:3095 Membership`, `:3128 MembershipRedemption`. Dashboard live at `frontend/src/pages/wellness/Memberships.jsx`. Close. |
| #788 | WAL-001 Wallet Top-up with bonus rules + expiry | PLAN | 2d | needs product call on bonus tier shape | Wallet credit endpoint exists at `wellness.js:6621 router.post("/wallet/:walletId/credit"...)` with `wallet.topup` event emission. **Bonus rules table + expiry-per-topup are NOT shipped.** Need a new `WalletBonusRule` model (tiers like ₹5000→+₹500), an expiry column on `WalletTransaction`, and a reversal cron. Bonus-tier shape is a product call (flat-tier vs %-tier vs combo). |
| #789 | WAL-002 Wallet / Gift Card / Cashback as POS payment methods | SHIP-NOW | 2h | none | `pos.js:527 VALID_PAYMENT_METHODS = ['CASH','CARD','UPI','WALLET','GIFTCARD','COMBINED']` — Wallet + Gift Card already accepted. **Cashback as a payment method is NOT in the enum.** Add `CASHBACK` + wire the consumption flow against `cashback_ledger` (which already exists via `cashback.credited` event). |
| #790 | CASH-001 Cashback rules engine run-time crediting | PHANTOM | — | — | **Already shipped**. `wellness.js:7274 emit('cashback.credited')` after `computeCashbackEarn(rules, amount, serviceId)` + `writeWalletTransaction(...CREDIT_CASHBACK...)`. CashbackRule model at `schema.prisma:3376`. The issue body itself says "verification belongs in a gate spec" — close with a one-line "verified via grep, see commit X". |
| #791 | GC-001 Gift Card redeem-at-POS | PHANTOM (mostly) | — | — | Redeem endpoint exists: `wellness.js:6826 router.post("/giftcards/redeem"...)` + `giftcard.redeemed` event. POS uses GIFTCARD as a payment method already (`pos.js:527`). The "enter gift card code at POS payment step" UX flow is wired through the gift card redeem call. Close. |
| #792 | CUST-001 Patient anniversary + GST | SHIP-NOW | 1h | none | **Schema columns exist**: `schema.prisma:2454 anniversary DateTime?` + Contact has `:457 gst String?`. **Patient model has anniversary; gst is on Contact only, not Patient.** Add `gst String?` to Patient model + migration + surface both on the patient create/edit form + Patient 360 header. |
| #793 | CUST-002 Wallet balance as Patient 360 header chip | SHIP-NOW | 1h | none | `PatientDetail.jsx:97-120` patient header shows Source + counts but **no wallet chip**. Wallet balance is already loaded via `/api/wellness/patients/:id/wallet`. Add a `<HeaderChip icon={WalletIcon} value={formatMoney(walletBalance, currency)}>` next to the visit count. |
| #794 | ROLE-001 Granular Roles UI (matrix grid) | PHANTOM | — | — | **Already shipped**. `frontend/src/pages/FieldPermissions.jsx:13 MATRIX_ROLES` + `:9 ACTIONS = ['READ','WRITE','DELETE','EXPORT']` + the `view='matrix'` toggle at `:42-43`. Backend backed by `FieldPermission.action` column (`schema.prisma:2201`). Close. |
| #795 | ROLE-002 Permissions matrix table for backend enforcement | PHANTOM | — | — | **Already shipped**. `FieldPermission` model with `(role, entity, field, action, tenant)` unique key at `schema.prisma:2188-2209`. Middleware consults the matrix. Close. |
| #796 | WA-001 WhatsApp Threads All/Unread/Blocked tab layout | SHIP-NOW | 1h | none | `WhatsAppThreads.jsx:33-39` uses a `STATUS_OPTIONS` dropdown. Replace with 3 tabs (`All / Unread / Blocked`) — the Blocked filter pulls from `/api/whatsapp/opt-outs` (already exists at `whatsapp.js:657`). Pure UI refactor. |
| #797 | WA-002 Template picker with variable substitution | SHIP-NOW | 2h | none | Templates endpoint exists at `whatsapp.js:741 router.get("/templates"...)`. Add a Templates button to the compose area + a substitution modal. Variable detection via regex `/\{\{(\w+)\}\}/g`. |
| #798 | WA-003 Meta 24-hour send window enforcement banner | SHIP-NOW | 2h | none | `WhatsAppThread.lastInboundAt` already on schema. Compute `inside_24h_window = (now - lastInboundAt) < 86400000` in `/threads/:id` response. Frontend renders a banner + disables free-form input outside window + forces template select. Server-side reject of free-form outside window is a 5-line guard in `/send`. |
| #799 | WA-004 Agent assign / snooze / close-conversation | PHANTOM | — | — | **Already shipped**. `whatsapp.js:466 /threads/:id/assign`, `:550 /snooze`, `:523 /close`, `:587 /mark-read`. Frontend `WhatsAppThreads.jsx:218 assignToMe` + `:262 snoozeThread`. Close. |
| #800 | WA-005 Opt-out handling + blocked-numbers list page | PHANTOM (backend) / SHIP-NOW (UI) | 1h | none | Backend shipped: `whatsapp.js:617 POST /opt-outs`, `:657 GET /opt-outs`, `:705 DELETE /opt-outs/:id`. **A dedicated "Blocked Numbers" page is not in `frontend/src/pages/`.** It's reachable from each thread but no list page. Add a simple list page (sibling of `WhatsAppThreads`). |
| #801 | WA-006 Webhook ingestion + schema verification | PHANTOM | — | — | **Already shipped**. `whatsapp.js:987 GET /webhook` (verify) + `:1017 POST /webhook` (ingest). Schema: `schema.prisma:1325 WhatsAppMessage`, `:1357 WhatsAppThread`, `:1388 WhatsAppOptOut`. Demo data seed is the only outstanding item — but that's a seed-script row, not a gap. Close. |
| #802 | ATT-001 Attendance KPIs Early + On-Time | SHIP-NOW | 2h | none | Current KPIs: PRESENT / HALF_DAY / LATE / ABSENT / HOLIDAY (`frontend/src/pages/wellness/Attendance.jsx:37-43`). **No EARLY / ON_TIME status anywhere** (verified via grep across `backend/`). Adding requires: (a) extending Attendance status enum, (b) computing early/on-time from `clockInAt` vs shift-start time + tolerance, (c) surfacing the new KPI tiles. Needs WorkingHours data which already exists. |
| #803 | ATT-002 Calendar view of leaves and shifts | PLAN | 1d | needs WorkingHours + Leave + Attendance merge | A new Calendar tab on the Attendance page needs to overlay 3 data sources (WorkingHours = scheduled shift, Leave = leave days, Attendance = actual). Each source already has a route. The work is mostly UI (month-grid with per-day cells, filter by staff, cross-link to Leave). |
| #804 | ATT-003 Payroll CSV export | SHIP-NOW | 3h | none | No `payroll` / `export` in `backend/routes/attendance.js` (verified via grep). Add `GET /api/attendance/payroll.csv?from&to` that joins Attendance + WorkingHours + Leave per staff into hours_worked / lates / absences / leaves. Pattern: clone `backend/routes/csv_io.js` export shape. |
| #805 | ATT-004 Biometric + geofenced mobile check-in | PLAN | 3d | external biometric vendor SDK required | Backend half is shipped: `attendance.js:463 router.post("/biometric/webhook"...)` + BiometricDevice CRUD at `:336-431` + `schema.prisma:266 biometricDevices`. **What's missing**: per-vendor adapter (ESSL/Realtime) and a mobile geofenced check-in flow. ESSL/Realtime integration depends on which device the tenant buys — best handled as a Settings → Biometric Devices page that lets admin paste the vendor's webhook URL. Geofenced mobile check-in needs browser-geolocation + per-Location radius config (Location.radius column doesn't exist yet) + a `source = 'mobile'` write path. |
| #806 | CAL-001 Walk-in/At-Home/At-Store legend | PHANTOM | — | — | **Already shipped** (Wave 7D). `Calendar.jsx:44-49 BOOKING_TYPE_META = { CLINIC_VISIT, IN_HOME, VIDEO, PHONE }` w/ color + icon per type + `:438 booking-type-legend` rendered at top. Close. |
| #807 | CAL-002 Holidays wired into Calendar conflict UI | PHANTOM (backend) / SHIP-NOW (UI) | 1h | none | Backend: `backend/lib/bookingAvailability.js:19 HOLIDAY_BLOCKED` conflict code + `:175 Holiday rows matched`. **Calendar UI doesn't grey-out holiday slots** — the booking-create API rejects 409, but visually the operator sees no warning. Add CSS class for holiday days in `Calendar.jsx`. |
| #808 | CAL-003 Resource-conflict prevention on booking | PHANTOM | — | — | **Already shipped**. `backend/lib/bookingAvailability.js:74 RESOURCE_DOUBLE_BOOKED` + `:155 visit.resourceId overlap check` returns 409 with conflict detail. Close. |
| #809 | MINI-001 Mini Website page editor | PHANTOM (backend+model) / PLAN (Settings UX) | 2d | needs Settings → Mini Website nav placement decision | Schema + editor fields ARE shipped on `BookingPage`: `schema.prisma:2074-2088` has `logoUrl, heroImageUrl, heroHeadline, heroSubheadline, featuredServiceIds, contactPhone, contactEmail, hoursJson`. Editor live at `frontend/src/pages/BookingPages.jsx:302-340`. **But the spec wants this surfaced under Settings → Mini Website as a dedicated page** (separate from the generic BookingPages list). Either: (a) close this issue with "shipped under BookingPages" + add a Settings deep-link, or (b) build a Settings nav entry that linkpaks to BookingPages with the right defaults. |
| #810 | MINI-002 Embeddable JavaScript booking widget | SHIP-NOW | 2h | none | `frontend/public/embed/widget.js` exists (drop-in script) + `embed/lead-form.html`. **The Settings page doesn't show the copy-pasteable snippet anywhere.** Add an "Embed snippet" card on Settings → Integrations or on BookingPages that surfaces the `<script src=".../embed/widget.js" data-slug="{slug}">` block per location with a copy button. |
| #811 | MINI-003 Public booking API without auth | PHANTOM | — | — | **Already shipped**. `backend/routes/booking_pages.js:404 router.get("/public/:slug/slots"...)` (no auth) + `:422 router.post("/public/:slug/book"...)` rate-limited + captcha-style protections. `wellness.js:4728 /public/book` is the wellness sibling. Close. |
| #812 | MINI-004 booking-type enum + at-home buffer + at-store room/chair | PHANTOM (mostly) | — | — | **Already shipped**. `schema.prisma:2589 Visit.bookingType` enum (CLINIC_VISIT / IN_HOME / VIDEO / PHONE), `:2595 atHomeAddress, :2596 atHomeCity, :2597 atHomePincode`. Resource picker for at-store: `Resource` model at `:3398`. Travel-buffer column exists per spec. The "chair" sub-resource is just another Resource row with type=CHAIR (the model is generic). Close. |
| #813 | MINI-005 UTM capture from inbound links | PHANTOM | — | — | **Already shipped** (Wave 2 Agent LL). `schema.prisma:2615 utmSource`, `:2616 utmMedium`, `:2617 utmCampaign`, `:2618 utmTerm` on Visit + `:2669 @@index([tenantId, utmSource])` for attribution grouping. Public booking widget posts UTM into Visit row. Close. |
| #814 | NOT-001 Notifications rules engine + action items | PHANTOM | — | — | **Already shipped**. low-stock + expiring-membership + no-show-risk crons live at `backend/cron/lowStockEngine.js`, `wellnessOpsEngine.js`, plus tests at `test/cron/lowStockEngine.test.js`, `test/cron/noShowRisk.test.js`, `test/cron/membership-expiry.test.js`. `Notification` model at `schema.prisma:1079`. Close. |
| #815 | NOT-002 Per-item Mark as Read / Resolve | SHIP-NOW | 30m | none | `NotificationBell.jsx:155 markAsRead` + `:167 markAllRead` shipped. **Resolve button is NOT in NotificationBell.jsx.** Backend route `PATCH /api/notifications/:id/resolve` already exists at `notifications.js:99`. Just add a button. |
| #816 | SVC-001 Catalog Import/Export CSV | PLAN | 1d | needs scope decision — customers + bookings import are write-heavy | `csv_io.js` already covers services / products / membership-plans (import+export) + bookings (export-only). **NOT shipped: customers import + customers export + packages import + packages export + bookings import.** Adding customers import is non-trivial (dedup against phone, validate gender/dob, handle wellness-vertical vs generic Contact split). Estimate 1d for the full set; ~3h for services-only-but-also-add-customers-export. |
| #817 | EVT-001 Cross-cutting analytics events | PHANTOM | — | — | **Already shipped** (Wave 6a). All 17 events from the list emit: `membership.enrolled / .renewed / .benefit_applied / .expired / .cancelled / .renewal_due / .plan.created`, `invoice.created / .completed / .voided / .refunded`, `payment.collected`, `shift.opened / .closed (with variance)`, `wallet.topup / .spent`, `cashback.credited`, `giftcard.issued / .redeemed`, `attendance.checked_in / .checked_out`. Verified at `backend/test/routes/wave6a-event-emissions.test.js:400`. Close. |
| #818 | STAFF-001 commissionProfileId + revenueGoalId on staff | SHIP-NOW | 1h | none | `staff.commissionProfileId` IS settable from Staff Directory (`frontend/src/pages/Staff.jsx:540-546`). **`revenueGoalId` picker is NOT wired** (grep returned 0 matches in Staff.jsx). `schema.prisma:376 staffRevenueGoals StaffRevenueGoal[]` and `RevenueGoals.jsx` page both exist. Add the picker + persist + dashboard progress tracker. |

## By area — recommended dispatch order

### POS (9 issues: #770 #771 #772 #773 #774 #775 #776 #777 #778)
- Verdict cluster: **6 PHANTOM / 2 SHIP-NOW / 1 PLAN / 0 SKIP** (POS-006 → SKIP/DEFER).
- Recommended dispatch order: close phantoms first (#772 #773 #774 #776 #777 #778 — bulk close), then #770 + #779 + #780 + #781 as a single Cash-Register-UI agent dispatch. POS-002 (Booking/Walk-in tabs) waits for product input.
- Dependencies: #770 (Cash Registers admin page) unblocks #780 #781 visually (status header + recent transactions can't render without the page existing).

### WhatsApp (6 issues: #796 #797 #798 #799 #800 #801)
- Verdict cluster: **3 PHANTOM / 3 SHIP-NOW / 0 PLAN**.
- Recommended dispatch order: close #799 + #801; ship #796 + #797 + #798 + #800-UI as one 6h frontend-heavy agent (it's all `WhatsAppThreads.jsx` + one new `BlockedNumbers.jsx` page; same file means single-agent, not parallel-wave).
- Dependencies: #796 (tab layout) wants #800 (Blocked Numbers list) wired into the Blocked tab — ship together.

### Memberships (5 issues: #783 #784 #785 #786 #787)
- Verdict cluster: **5 PHANTOM / 0 SHIP-NOW / 0 PLAN**.
- Recommended dispatch order: bulk close all five with "shipped in Wave 6a" comment.
- Dependencies: none.

### Mini-Website (5 issues: #809 #810 #811 #812 #813)
- Verdict cluster: **3 PHANTOM / 1 SHIP-NOW / 1 PLAN**.
- Recommended dispatch order: close #811 #812 #813; ship #810 (embed snippet on Settings — 2h); #809 (Mini Website Settings nav) needs product input on whether it's a separate page or a Settings deep-link into BookingPages.
- Dependencies: #810 ships the snippet display, but the widget.js itself already works; this is pure surfacing.

### Attendance (4 issues: #802 #803 #804 #805)
- Verdict cluster: **0 PHANTOM / 2 SHIP-NOW / 2 PLAN**.
- Recommended dispatch order: #802 (Early/On-Time KPIs, 2h) + #804 (Payroll CSV, 3h) as a single Attendance-KPI-and-export agent. #803 (Calendar tab) is a separate 1d UI build. #805 (biometric/geofence) is multi-day, vendor-dependent — defer to Phase 2 PRD with a Settings → Biometric Devices placeholder.
- Dependencies: #802 → #803 (Calendar tab benefits from Early/On-Time pills); none blocking.

### Cash Register (4 issues: #779 #780 #781 #782)
- Verdict cluster: **1 PHANTOM / 3 SHIP-NOW / 0 PLAN**.
- Recommended dispatch order: must ship after #770 (POS-001 Cash Register admin page). Then #779 (deposit/withdraw routes + buttons), #780 (status header chip), #781 (recent transactions list) — all visible on the new admin page. Close #782 (auto-post + variance already shipped).
- Dependencies: ALL three SHIP-NOW items depend on #770 landing first. Don't dispatch in parallel — dispatch as a single agent that does #770 + #779 + #780 + #781 in one PR (~5h total).

### Calendar (3 issues: #806 #807 #808)
- Verdict cluster: **2 PHANTOM / 1 SHIP-NOW (UI-only on #807)**.
- Recommended dispatch order: close #806 #808; ship CSS-class addition for #807 (holiday slot grey-out — 1h).
- Dependencies: none.

### Customer / Patient (2 issues: #792 #793)
- Verdict cluster: **0 PHANTOM / 2 SHIP-NOW / 0 PLAN**.
- Recommended dispatch order: single 2h agent for both (#792 patient.gst column + UI surface, #793 wallet chip in Patient 360 header) — same file (`PatientDetail.jsx`) so single-agent.
- Dependencies: none.

### Notifications (2 issues: #814 #815)
- Verdict cluster: **1 PHANTOM / 1 SHIP-NOW**.
- Recommended dispatch order: close #814; ship #815 (Resolve button — 30 min).
- Dependencies: none.

### Roles (2 issues: #794 #795)
- Verdict cluster: **2 PHANTOM**.
- Recommended dispatch order: bulk close both with "shipped in PRD Gap §1.3 matrix view".
- Dependencies: none.

### Wallet (2 issues: #788 #789)
- Verdict cluster: **0 PHANTOM / 1 SHIP-NOW (#789 cashback as payment method, 2h) / 1 PLAN (#788 bonus rules + expiry, 2d)**.
- Recommended dispatch order: ship #789 first (low risk, enum extension + redemption flow), then plan #788 (needs product call on bonus-tier shape).
- Dependencies: #789 depends on cashback ledger which already exists.

### Singles
- **#790 CASH-001** PHANTOM — already shipped; close with grep citation.
- **#791 GC-001** PHANTOM — gift-card redeem-at-POS shipped; close.
- **#816 SVC-001** PLAN — full customers + packages + bookings import is 1d; partial (services-only) already done.
- **#817 EVT-001** PHANTOM — all 17 events shipped in Wave 6a; close.
- **#818 STAFF-001** SHIP-NOW — `revenueGoalId` picker missing in Staff.jsx, 1h.

## Cross-area dependencies

```
POS-001 (Cash Registers page, #770)
  └─ blocks visually:
     ├─ CR-002 status header (#780)
     ├─ CR-003 recent transactions list (#781)
     └─ CR-001 deposit/withdraw buttons (#779)

WA-001 tab layout (#796)
  └─ pulls Blocked tab from:
     └─ WA-005 Blocked Numbers list page (#800-UI)

CUST-001 patient gst (#792) + CUST-002 wallet chip (#793)
  └─ both modify PatientDetail.jsx → single agent

ATT-001 Early/On-Time KPI (#802)
  └─ enriches:
     └─ ATT-002 Calendar tab (#803)

WAL-001 bonus rules (#788) — independent
WAL-002 cashback as payment method (#789) — independent
  (both touch wallet ledger but no schema overlap)

EVT-001 events (#817) — already cross-cutting; close
```

## Recommendations

### 1. Phantoms to close immediately (~10 min total)

Close-with-comment 24 issues:
**POS:** #772 #773 #774 #776 #777 #778
**Memberships:** #783 #784 #785 #786 #787
**Mini-Website:** #811 #812 #813
**Calendar:** #806 #808
**Roles:** #794 #795
**Cash Register:** #782
**WhatsApp:** #799 #801
**Cashback:** #790
**Gift Cards:** #791
**Events:** #817

Each gets a one-line close-comment like:
> Shipped in Wave 6a (`b232110`) — verified at `backend/routes/wellness.js:2707 emit('membership.enrolled')` + frontend `Memberships.jsx`. Closing.

(Use exact citations from the matrix above.)

### 2. Sprint 1 dispatch — 4-agent wave, ~1 day (~24 h aggregate; ~6h wall-clock if parallel)

**Agent A — Cash Register UI bundle (5h):** ships #770 + #779 + #780 + #781 in a single PR. Single file ownership = `frontend/src/pages/wellness/CashRegisters.jsx` (new) + sidebar entry + 1-2 buttons added to `PointOfSale.jsx`. Backend: add `POST /shifts/:id/deposit` + `/withdraw` to `routes/pos.js` (mirror existing `/close` shape).

**Agent B — WhatsApp tab/template/24h-window bundle (6h):** ships #796 + #797 + #798 + #800-UI in a single PR. Single file ownership = `frontend/src/pages/wellness/WhatsAppThreads.jsx` + new `BlockedNumbers.jsx` page. Backend: 1 line in `whatsapp.js` /send to reject free-form outside 24h window.

**Agent C — Patient header + Attendance KPI/CSV bundle (6h):** ships #792 + #793 + #802 + #804 in a single PR. Two file owners: `frontend/src/pages/wellness/PatientDetail.jsx` (gst form field + wallet chip in header) and `frontend/src/pages/wellness/Attendance.jsx` + `backend/routes/attendance.js` (Early/On-Time KPI + payroll.csv route). Schema migration: `Patient.gst String?`.

**Agent D — Smalls bundle (4h):** ships #807 (holiday grey-out CSS — 1h), #810 (embed snippet on Settings — 2h), #815 (Resolve button on NotificationBell — 30m), #818 (revenueGoalId picker on Staff.jsx — 1h). Disjoint files; could split into 4 micro-agents but the file count is small enough for one.

**Total Sprint 1: 21h aggregate ÷ 4 parallel agents ≈ 5-6h wall-clock.** Phantoms close while agents are dispatched (in parallel, ~10 min).

### 3. Sprint 2 dispatch — after product input (~3 dev-weeks total)

Needs product calls before dispatch:
- **#771 POS-002** (Booking/Walk-in tabs) — what does Booking tab do that Walk-in doesn't beyond requiring bookingId? Needs UX decision on whether Walk-in tab should pre-populate a synthetic Visit row. — 1d once decided.
- **#788 WAL-001** (Bonus rules + expiry) — bonus-tier shape: flat-per-tier vs %-vs-amount-combo? Per-tenant configurable or fixed-tier? — 2d.
- **#803 ATT-002** (Attendance Calendar tab) — pure build, no product input, ~1d.
- **#816 SVC-001** (customers + packages + bookings CSV import) — dedup rule for customer phone: skip-if-exists vs update-in-place? — 1d.
- **#809 MINI-001** (Mini Website Settings nav) — separate page vs deep-link into BookingPages? — 2d.

### 4. Move to AI-era PRD Phase 2 scope

- **#775 POS-006** (rebuild Invoice schema to match Zylu polymorphic spec) — SKIP/DEFER. The existing Sale+SaleLineItem model serves the wellness vertical's needs without breaking the public `/api/v1/invoices` API contract. Revisiting this is a Phase 2 PRD item if Zylu-grade aesthetic invoice parity is needed.
- **#805 ATT-004** (biometric + geofenced mobile) — PLAN now; Phase 2 ship. Needs an actual vendor partnership (ESSL/Realtime) and a per-Location radius column. Currently a generic webhook ingestion exists.
- **#809 MINI-001** if the product call lands on "no, this needs a fully-separate Settings → Mini Website page that's NOT BookingPages" — that's a 1w build at minimum (rich-content editor with image uploads, theme picker, hours editor, service-order drag).

## If you dispatch a 4-agent wave next, here's what they should do

Open a parallel wave of four agents NAMED Agent A / B / C / D per Sprint 1 above. Agent A owns the Cash Register UI bundle (#770 + #779 + #780 + #781) — five-hour focused work touching only `pos.js` (deposit/withdraw routes) and a new `CashRegisters.jsx` + sidebar entry; Agent B owns the WhatsApp Threads UI bundle (#796 + #797 + #798 + #800-UI) — six hours touching `WhatsAppThreads.jsx` and a new `BlockedNumbers.jsx`; Agent C owns the Patient header + Attendance KPI/payroll bundle (#792 + #793 + #802 + #804) — six hours touching `PatientDetail.jsx`, `Attendance.jsx`, `routes/attendance.js`, plus a one-column Patient.gst schema migration; Agent D owns the smalls bundle (#807 + #810 + #815 + #818) — four hours of disjoint micro-fixes. Disjoint-files invariant holds across all four — no two agents touch the same backend route or schema model. Pre-flight rule: every agent runs `verifying-issue-before-pickup` against ALL four issues in their bundle as the first 30s of work — five of today's twenty-four phantoms were issues whose framing mismatched shipped code, so the bundle counts may shrink further at dispatch time. Bulk-close the twenty-four PHANTOM issues (with the matrix-cell citations) IN PARALLEL with the agent dispatch so the issue list shrinks from 49 → 21 while engineering work proceeds.
