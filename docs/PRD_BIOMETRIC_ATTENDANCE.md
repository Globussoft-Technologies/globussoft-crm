# PRD — Biometric attendance + geofenced mobile check-in: `AttendanceEvent` event-stream + ESSL/Realtime device adapter + mobile PWA geofence

**Status:** NOT STARTED — PRD draft only; design call required (DD-5.1 vendor matrix scope + DD-5.2 mobile surface PWA-vs-native + DD-5.3 geofence strict-vs-lenient + DD-5.6 event-stream vs single-row-per-day cohabitation determine the schema shape + downstream reporting + migration scope materially).
**Source:** GH #805 — [Zylu-Gap][ATT-004] Biometric device API integration + geofenced mobile check-in flow missing.
**Tier:** P3 — Wellness vertical operational spine (today's CRM ships a partial scaffold via the `Attendance` + `BiometricDevice` Prisma models at [backend/prisma/schema.prisma:3663-3714](../backend/prisma/schema.prisma#L3663-L3714) + the `/api/attendance/*` routes at [backend/routes/attendance.js](../backend/routes/attendance.js) (793 LOC; Wave 2 Agent JJ landed clock-in/out + summary + biometric webhook + device CRUD); it ships an X-API-Key webhook receiver at `POST /api/attendance/biometric/webhook` (auth via `BiometricDevice.apiKey`) and the global server.js openPaths exception for that route exactly like `/sms/webhook`. BUT the model is a **single-row-per-day Attendance** (`@@unique([tenantId, userId, date])`) with `clockInAt` + `clockOutAt` + `source String @default("MANUAL")` columns — NOT the event-stream `attendance_events` table that #805 demands. AND the `BiometricDevice` model carries `apiKey String` at rest (NOT encrypted via `lib/fieldEncryption.js`); ships NO `ipAddress` or `deviceSerial` columns; ships NO IP-allowlist enforcement on the webhook; ships NO event-idempotency dedup. AND there's NO mobile geofenced check-in flow at all — `Location` has nullable `latitude Float?` + `longitude Float?` but NO `geofenceRadiusM` column, and the existing `clock-in` endpoint doesn't verify location; AND there's NO ESSL or Realtime vendor adapter — the webhook is generic / vendor-agnostic but the per-vendor poll-mode integration that ATT-004 lists is missing. The wellness vertical's clinic operations cannot reliably enforce attendance without these three gaps closed: (a) event-stream rather than single-row-per-day so a doctor scanning the device at 09:01 AM then taking a 12:30-13:30 lunch break then scanning out at 18:05 produces FOUR audit-traceable events not collapsed-to-two; (b) per-vendor adapter so ESSL + Realtime devices' native poll-mode APIs land in the same stream as webhook-pushed events; (c) geofenced mobile PWA so field-deployed sales reps + telecallers can punch in from assigned territory without being physically present at a device).
**Authored:** 2026-05-25 (tick #199 / Agent B, autonomous overnight cron arc — Bonus PRD #13 in this batch wave on top of the official 10 P3 + 12 prior bonus). This is the LAST Zylu-Gap / wellness-gap issue without a PRD; after this lands, every open gap-issue in the QA cluster has either an implementation in flight, a PRD waiting for design call, or a stub/scaffold shipped.
**Sibling PRDs:** `PRD_PURCHASE_ORDERS.md` (tick #187, cluster D8) · `PRD_PAYMENT_GATEWAY_CONFIG.md` (tick #188, D9) · `PRD_IMPORT_EXPORT_JOBS.md` (tick #189, D10) · `PRD_INTEGRATIONS_HUB.md` (tick #190, D11) · `PRD_TAG_MASTER.md` (tick #191, D12) · `PRD_AI_CHAT_HISTORY.md` (tick #192, D13) · `PRD_CUSTOMER_SEGMENTS.md` (tick #193, D14) · **`PRD_STAFF_DETAIL.md`** (tick #194, D15 — `EmployeeProfile.biometricDeviceUserId` storage lives there) · `PRD_WALLET_TOPUP.md` (tick #195, D16) · `PRD_POS_NEW_SALE.md` (tick #196, D17) · `PRD_POS_POLYMORPHIC_INVOICE.md` (tick #197, D18) · `PRD_MINI_WEBSITE.md` (tick #198, D19).
**Cluster:** MANUAL_CODING_BACKLOG.md cluster D (wellness operational session) — proposing **D20**; see §10.
**Cred dependency:** ESSL India + Realtime India vendor documentation + a physical ESSL X990 / Realtime T502 device for local testing. **Yasin's contact at ESSL India is the source-of-truth.** Blocks FR-3.4.b (vendor adapter implementation) but does NOT block FR-3.4.a (the existing generic webhook), FR-3.4.c (mobile geofenced check-in), or FR-3.4.d (manager manual-override).

---

## §1 Background + source attribution

The CRM today has a **partial attendance scaffold** that addresses three out of four ATT-004 acceptance criteria at a shallow depth:

1. **Existing `Attendance` model** at [backend/prisma/schema.prisma:3663-3692](../backend/prisma/schema.prisma#L3663-L3692) — Wave 2 Agent JJ landed this on 8 May 2026 per the route file header. Shape: `id` (Int autoincrement), `tenantId` + `userId` FKs, `date DateTime`, `clockInAt DateTime?` + `clockOutAt DateTime?`, `clockInLocationId Int?` + `clockOutLocationId Int?`, `source String @default("MANUAL")` (free-text, route-validated against `BIOMETRIC | MANUAL | MOBILE`), `biometricDeviceId Int?`, `totalMinutes Int?` (server-computed), `status String @default("PRESENT")` (vocab: `PRESENT | HALF_DAY | LATE | ABSENT | HOLIDAY`), `notes String?`, `createdAt` + `updatedAt`. The **load-bearing constraint** is `@@unique([tenantId, userId, date])` — one Attendance row per user per calendar day. This collapses the entire event stream to ONE `clockInAt` + ONE `clockOutAt` per day. Indian wellness clinic shifts routinely have a 09:00-13:30 morning + 16:00-21:00 evening block (lunch in between) with the operator scanning the device FOUR times. The current model loses the lunch-block timestamps entirely.

2. **Existing `BiometricDevice` model** at [backend/prisma/schema.prisma:3694-3714](../backend/prisma/schema.prisma#L3694-L3714) — Wave 2 Agent JJ stub. Shape: `tenantId` + `locationId Int?` (nullable — questionable: a device IS tied to a location), `deviceId String` (operator-typed display id; @@unique with tenant), `vendor String` (free-text), `apiKey String` (PLAINTEXT at rest — `@@unique` globally so a webhook can derive tenant from the key; this is the SHIPPED pattern, see DD-5.6), `lastSyncAt DateTime?`, `isActive Boolean`. The model is intentionally minimal; it lacks `ipAddress` + `deviceSerial` + vendor-specific config (ESSL device needs base URL + poll cadence; Realtime needs different auth headers). The PLAINTEXT `apiKey` is the immediate security gap — `lib/fieldEncryption.js` already exists for this exact class of secret (used by `Patient` PII fields per CLAUDE.md note "AES-256-GCM helper for patient PII fields. Opt-in via `WELLNESS_FIELD_KEY` env var") but is not wired here yet.

3. **Existing `/api/attendance/*` routes** at [backend/routes/attendance.js](../backend/routes/attendance.js) (793 LOC). Surfaces shipped: `POST /clock-in` + `POST /clock-out` (self-service via verifyToken — writes Attendance row with source=MANUAL; NO geofence verification, NO location-tied enforcement; the optional `locationId` body param is operator-typed not geo-derived), `GET /me?from&to` + `GET /staff/:userId?from&to` (history queries), `GET /summary?from&to&userId` (aggregate including #802 + #804 early / on-time / late breakdown), `POST /biometric/webhook` (X-API-Key auth via BiometricDevice.apiKey — generic vendor-agnostic webhook; payload `{userId, type, eventAt, location?}`), `GET/POST/PUT/DELETE /devices` (admin CRUD).

4. **Existing `Location` model** at [backend/prisma/schema.prisma:3052-3086](../backend/prisma/schema.prisma#L3052-L3086) — already carries `latitude Float?` + `longitude Float?` + `timezone String` BUT lacks `geofenceRadiusM Int?` and `geofenceAccuracyThresholdM Int?`. The fields are present from a prior shipment but no consumer reads them today.

Per GH issue #805 verbatim:

> **Title:** [Zylu-Gap][ATT-004] Biometric device API integration + geofenced mobile check-in flow missing
>
> **Source — TIC Wellness Dev Implementation List**
> **ATTENDANCE & BIOMETRIC**:
> > Integrate a biometric device API for check-in/out.
> > Build a manual check-in/out fallback for managers.
> > Build a geofenced mobile check-in flow.
> > Create attendance_events table (staff_id, type check_in/check_out, ts, source biometric/manual/mobile, geo).
>
> **Zylu reference:** Zylu integrates ESSL / Realtime biometric APIs (configured per location) and has a mobile staff app with geofenced clock-in that writes `attendance_events.source = mobile` plus a geo blob.
>
> **Observed on crm-staging.globusdemos.com:** Attendance page only exposes a manager-style Punch In / Punch Out for self. No biometric integration page, no geofence config, no `source` toggle.
>
> **Acceptance criteria**
> - [ ] Settings page for biometric API config (vendor, base URL, location mapping, auth token).
> - [ ] Webhook ingestion endpoint writes `attendance_events` rows with source=biometric.
> - [ ] Mobile geofenced check-in flow (browser geolocation + radius check per location) writes source=mobile + geo.
> - [ ] Manager fallback continues to write source=manual.
> - [ ] All sources unified in `attendance_events` with required columns.

### What's missing (per GH #805)

Mapping #805's four acceptance criteria onto today's shape:

1. **AC1 — Settings page for biometric API config (vendor, base URL, location mapping, auth token).** Today's `/devices` admin CRUD has no UI surface (only API endpoints); no vendor-specific config columns (ESSL's `baseUrl` + `pollIntervalSeconds`; Realtime's auth headers); the `apiKey` is plaintext-stored. Acceptance criterion partially met — admin can CREATE/EDIT/DELETE a BiometricDevice but cannot configure per-vendor parameters.

2. **AC2 — Webhook ingestion endpoint writes `attendance_events` rows with source=biometric.** Today's webhook writes to a single-row-per-day `Attendance` row (`source=BIOMETRIC`, `biometricDeviceId` populated, `clockInAt` OR `clockOutAt` populated). Acceptance criterion NOT met against the literal #805 spec — the storage is NOT an event-stream `attendance_events` table; the model collapses the day to two timestamps. The shipped storage works for "did this employee come to work today?" reporting but fails for multi-shift / lunch-break / ad-hoc-scan use cases.

3. **AC3 — Mobile geofenced check-in flow (browser geolocation + radius check per location) writes source=mobile + geo.** Today's `clock-in` endpoint accepts an OPTIONAL `locationId` body param but does NOT verify the client's geolocation against the Location's lat/lng + radius. There is no `geofenceRadiusM` column on Location. There is no mobile PWA / native app — the existing wellness frontend ships a desktop-first Attendance page only.

4. **AC4 — Manager fallback continues to write source=manual.** Today's `clock-in` endpoint defaults to `source=MANUAL`. But this is the SAME endpoint that should be re-purposed for self-service mobile; the manager-acting-on-behalf-of-staff flow is not separately gated (today's endpoint always writes for the authenticated user — there's no `userId` body param + verifyRole(MANAGER/ADMIN) override path). Acceptance criterion PARTIALLY met — the source vocab is there, but the manager-fallback semantics are conflated with self-service.

5. **AC5 — All sources unified in `attendance_events` with required columns.** This is the load-bearing acceptance criterion: a single event-stream table with `userId / type / eventAt / source / geo` columns. Today's model is single-row-per-day with two timestamps; the table-shape mismatch is the core schema gap.

### Zylu reference pattern (prior art per #805)

Zylu's salon CRM ships ATT-004 as TWO tables + ONE per-location adapter pattern (today's `Attendance` + `BiometricDevice` are partial analogues but the column-set differs materially):

- **`attendance_events`:** UUID PK (today's `Attendance.id` is Int autoincrement — see DD-5.8); `staff_id` FK (today: `userId`); `type` enum ∈ `CHECK_IN | CHECK_OUT | BREAK_START | BREAK_END` (today's single-row model has NO type column — the event-or-not is implied by `clockInAt` vs `clockOutAt`); `event_at DateTime` (today: `clockInAt` OR `clockOutAt`); `source` enum ∈ `BIOMETRIC | MANUAL | MOBILE | API` (today: free-text); `latitude` + `longitude` Float + `accuracy_m` Int (NOT on today's `Attendance` model — geo is stored at Location level only); `biometric_device_id` FK (today's `Attendance.biometricDeviceId`); `manual_reason String` (for source=MANUAL — operator must explain why; not enforced today); `ip_address String?` (audit trail for webhook origin verification); `device_serial String?` (for biometric source — which physical device); `created_at`.

- **`biometric_devices`:** `tenant_id` + `location_id` (NOT NULL — a device is tied to a location; today's column is nullable); `vendor` enum ∈ `ESSL | REALTIME | ZKTECO | OTHER` (today: free-text); `device_serial String` (vendor-issued serial — distinct from operator-typed `device_id`); `device_id String` (operator-typed display id; today's column); `ip_address String?` (for poll-mode adapter — CRM polls device at this IP); `base_url String?` (for ESSL HTTP-API; null for webhook-only devices); `api_key String` (ENCRYPTED at rest via `lib/fieldEncryption.js`; today: PLAINTEXT); `poll_interval_seconds Int?` (for poll-mode devices); `auth_headers_json Text?` (for Realtime — custom HTTP auth shape); `active Boolean`; `last_sync_at DateTime?`; `created_at`.

- **`location` geofence extension:** Location carries `latitude` + `longitude` (today: present) + `geofence_radius_m Int?` (default 100m; today: MISSING) + `geofence_accuracy_threshold_m Int?` (default 100m; today: MISSING) + `geofence_strict Boolean` (whether out-of-radius is rejected vs warn-flagged; today: MISSING — implied STRICT but no config).

### Today's attendance flow (the gap)

1. Operator presses Punch In at `/attendance` desktop page → `POST /api/attendance/clock-in` → backend reads `req.user.userId`, anchors today's date to UTC midnight, upserts `Attendance` row with `clockInAt = now()` + `source = "MANUAL"` (the source param is currently NOT settable by the desktop UI but the route accepts it).
2. If no biometric device fires for that user today, the `Attendance` row stays at `source = "MANUAL"`. There's no way to distinguish "punched in via desktop browser at office computer" from "punched in via field-deployed mobile from cafe across town."
3. The biometric webhook (`POST /api/attendance/biometric/webhook`) gets a payload `{userId, type, eventAt}`, X-API-Key derives tenant from BiometricDevice row, upserts Attendance row with `source = "BIOMETRIC"` + `biometricDeviceId = <device>`.
4. Manager view at `/attendance/staff/:userId` reads single-row-per-day `Attendance` history. No event-level detail; the "doctor scanned at 09:01 + 12:30 + 13:30 + 18:05 = morning + lunch + back-from-lunch + end-of-day" four-event story is lost.

### Zylu reference flow (ATT-004 spec)

1. Operator presses CHECK_IN on the staff mobile app → browser `navigator.geolocation.getCurrentPosition()` → POST `/api/attendance/mobile-checkin` `{type: CHECK_IN, latitude, longitude, accuracyM, eventAt}` with JWT.
2. Backend verifies: (a) user is assigned to a Location with geofence config; (b) `haversine(lat/lng, location.lat/lng) <= location.geofenceRadiusM`; (c) `accuracyM <= location.geofenceAccuracyThresholdM`. On any miss, return 403 GEOFENCE_FAIL + emit `ATTENDANCE_GEOFENCE_FAIL` audit. On hit, create `AttendanceEvent` row with `source = MOBILE` + geo blob.
3. Operator at biometric device scans fingerprint → ESSL device pushes webhook to CRM `/api/attendance/biometric/webhook` (push-mode) OR CRM cron polls device's HTTP API every 5 min (poll-mode per Realtime's spec). Either way, `AttendanceEvent` row with `source = BIOMETRIC`.
4. Manager wants to fix a missed scan → `POST /api/attendance/manual-checkin` `{targetUserId, type, eventAt, manualReason}` verifyRole(MANAGER/ADMIN). Backend creates `AttendanceEvent` with `source = MANUAL` + `manualReason` populated + audit `ATTENDANCE_MANUAL_OVERRIDE` (high-trust event — manager identity recorded).
5. Reporting layer pivots the event-stream into per-day rollups (`first CHECK_IN` + `last CHECK_OUT` + total worked minutes minus break time) + source-breakdown (% biometric / manual / mobile per week).

### Source attribution

- GH issue #805 — [https://github.com/Globussoft-Technologies/globussoft-crm/issues/805](https://github.com/Globussoft-Technologies/globussoft-crm/issues/805)
- `backend/prisma/schema.prisma:3663-3692` — existing single-row-per-day `Attendance` model (Wave 2 Agent JJ; preserved as the rollup table, see DD-5.6)
- `backend/prisma/schema.prisma:3694-3714` — existing `BiometricDevice` stub (extended per FR-3.2)
- `backend/prisma/schema.prisma:3052-3086` — existing `Location` model (extended with geofence columns per FR-3.5)
- `backend/prisma/schema.prisma:348+433` — existing `User` model back-relations to `attendances` + `biometricDevices` (additive `biometricDeviceUserId String?` field per FR-3.3 — the local-id stored in the biometric device)
- `backend/routes/attendance.js:1-793` — existing routes (extended per FR-3.4)
- `backend/routes/attendance.js:643` — existing `/biometric/webhook` (extended per FR-3.4.a with IP-allowlist + idempotency)
- `backend/lib/fieldEncryption.js` — existing AES-256-GCM helper (wired in for `BiometricDevice.apiKey` per FR-3.2 + NFR-4.2)
- `backend/lib/audit.js` `writeAudit()` — existing tamper-evident chain; new `ATTENDANCE_*` event family flows through unchanged
- ESSL India developer docs — pending Yasin's outreach (per §5 cred chase)
- Realtime India developer docs — pending Yasin's outreach
- `PRD_STAFF_DETAIL.md` (D15) — `EmployeeProfile.biometricDeviceUserId` is the canonical location for the per-user device-local-id; this PRD's FR-3.3 adds a denormalised `User.biometricDeviceUserId` mirror IF the EmployeeProfile model doesn't land first (see DD-5.7)

### Why this isn't a "small extension" — it's an attendance-spine refactor + vendor adapter + mobile PWA

The today shape has FOUR structural gaps that the spine needs to address:

1. **The event-stream vs single-row-per-day model.** Migrating from `Attendance` (one row per day) to `AttendanceEvent` (one row per scan) is a code sweep across the existing `routes/attendance.js` (~30 LOC of clock-in/out logic + ~60 LOC of summary rollup) + the existing frontend attendance page + any downstream cron / report consumers. Done badly, this breaks the existing summary endpoint. Done well, the existing `Attendance` table becomes a server-derived rollup (computed nightly from the event stream OR computed on-demand from the event stream within a request — see DD-5.6) and the event stream is the source-of-truth.

2. **The vendor adapter pattern.** ESSL ships an HTTP-API where the CRM POLLS the device every N seconds (the device CANNOT initiate outbound HTTP because most clinic LANs NAT-block it). Realtime ships push-mode where the device POSTs to a webhook URL configured at provision-time. The CRM cron infra needs a new `biometricDevicePollEngine` engine (engine #25 — joining after the existing 24 cron engines per CLAUDE.md) that fetches new events from ESSL devices every 5 min. Webhook-mode (Realtime) reuses the existing `/biometric/webhook` route. The vendor abstraction sits behind `services/biometricVendorAdapter.js` with per-vendor implementations.

3. **The mobile PWA + geofence.** No native mobile app exists today. The wellness frontend at `/wellness/*` is a desktop-first SPA. Building a separate native app is multi-week work; a PWA (camera + geolocation + offline-queue via IndexedDB) shipping atop the existing SPA is a 1-2 week effort. The DD-5.2 decision determines whether v1 ships PWA-only (recommended) or holds for a native app.

4. **The audit + RBAC posture.** The manager-manual-override flow is high-trust (manager attesting to staff attendance for payroll). The audit must capture manager identity + the targetUserId + manualReason. The existing `writeAudit` infrastructure handles this trivially (additive event vocab `ATTENDANCE_CHECK_IN / _CHECK_OUT / _MANUAL_OVERRIDE / _BIOMETRIC_ERROR / _GEOFENCE_FAIL`), but the manual-override route does NOT exist as a separate surface today.

This PRD's slice 1 ships the `AttendanceEvent` model + the mobile-checkin endpoint + the manual-override endpoint; slice 2 ships the geofence config + Location extension + audit; slice 3 ships the ESSL vendor adapter + cron engine; slice 4 ships the Realtime vendor adapter + webhook hardening; slice 5 ships the admin Settings → Biometric Devices page + Geofences page; slice 6 ships the mobile PWA shell + offline queue; slice 7 ships the source-breakdown reports + rollup migration.

---

## §2 Use cases

1. **Clinic doctor punches in at the biometric device on entry — server receives event, creates `AttendanceEvent` row.** Dr Harsh arrives at Enhanced Wellness Bangalore (locationId=1) at 09:01 AM and scans his fingerprint on the ESSL X990 device (deviceSerial="X990-BAN-001"). ESSL device exposes HTTP-API; the `biometricDevicePollEngine` cron tick fires at 09:05 → polls device → fetches new event `{userId: drHarshDeviceUid, type: CHECK_IN, ts: 2026-05-25T09:01:23+05:30}` → maps `drHarshDeviceUid` to `User.id` via `EmployeeProfile.biometricDeviceUserId` lookup → creates `AttendanceEvent` row `{tenantId, userId, type: CHECK_IN, eventAt: 2026-05-25T03:31:23Z, source: BIOMETRIC, biometricDeviceId, deviceSerial: "X990-BAN-001", ipAddress: device's IP}` + writes audit `ATTENDANCE_CHECK_IN {userId, source: BIOMETRIC, deviceSerial}`. Dr Harsh takes lunch at 13:30 (CHECK_OUT) + 14:30 (CHECK_IN) + leaves at 18:05 (CHECK_OUT). Total: 4 `AttendanceEvent` rows for the day, all source=BIOMETRIC. The summary endpoint rolls them up into "first scan 09:01 + last scan 18:05 + total worked minutes 510" (i.e. 9:00-18:05 minus the 1-hour lunch break).

2. **Sales rep uses mobile PWA to punch in from field — geofence verifies location matches assigned territory.** Sales rep Priya is assigned to territoryId=4 (Bangalore South) which maps to Location 1 (Enhanced Wellness Bangalore) with `latitude=12.9716, longitude=77.5946, geofenceRadiusM=200`. She opens the mobile PWA at `/m/attendance` on her phone at 09:15 AM, taps CHECK_IN. Browser geolocation returns `{lat: 12.9719, lng: 77.5948, accuracyM: 12}`. PWA POSTs to `/api/attendance/mobile-checkin` with `{type: CHECK_IN, latitude, longitude, accuracyM, eventAt}` + JWT. Backend: `haversine(12.9719/77.5948, 12.9716/77.5946) = 35m <= 200m radius ✓`; `accuracyM 12 <= 100m threshold ✓`. Creates `AttendanceEvent` row with `source: MOBILE` + geo blob. Returns 200 `{eventId, attendanceRollup: {firstIn: 09:15, totalMinutes: 0}}`. If Priya instead tried from her home 5km away (`haversine = 5012m > 200m`), backend returns 403 `{error: "GEOFENCE_FAIL", code: "OUTSIDE_RADIUS", distance: 5012}` + writes audit `ATTENDANCE_GEOFENCE_FAIL` (high-signal event for the security review).

3. **Manager manually punches in for an absent staff (e.g. forgot to scan) — source=manual flagged in audit + payroll-grade attestation.** Receptionist Sunita scanned in at 09:00 but the ESSL device's offline-cache lost her 14:00-return-from-lunch event due to a network hiccup. Manager Rishu notices the missing scan at 17:00 + opens `/wellness/attendance/manager` admin view → clicks "Add manual event for Sunita" → enters `{type: CHECK_IN, eventAt: 2026-05-25T14:00, manualReason: "Device offline cache loss; staff confirmed return time verbally"}`. Frontend POSTs `/api/attendance/manual-checkin` `{targetUserId: sunitaId, type, eventAt, manualReason}` with manager's JWT. Backend: verifyRole(MANAGER/ADMIN) ✓; creates `AttendanceEvent` `{userId: sunitaId, type: CHECK_IN, eventAt, source: MANUAL, manualReason, createdByUserId: rishuId}` + writes audit `ATTENDANCE_MANUAL_OVERRIDE {managerId: rishuId, targetUserId: sunitaId, manualReason, type, eventAt}`. The audit row is the payroll-grade attestation — if Sunita disputes the time later, Rishu's identity + reason are immutably chained.

4. **Operations report: who punched in late this week, broken down by source.** Operations head Aanya opens `/wellness/attendance/reports` and selects "Last 7 days, by source." Frontend fetches `GET /api/attendance/events?from=2026-05-18&to=2026-05-25&groupBy=source`. Backend rolls up the AttendanceEvent stream into per-user-per-day counts: `{user: 'Dr Harsh', biometric: 6, manual: 0, mobile: 0, lateDays: 1, ...}, {user: 'Priya', biometric: 0, manual: 1, mobile: 5, lateDays: 2, ...}`. Renders a stacked bar chart per user (biometric / manual / mobile coloured segments). Operationally surfaces "Priya is field-deployed via mobile 5 days; Sunita has 2 manual overrides this week (investigate why the device isn't catching her)."

5. **Geofence-fail: rep tries to punch in from outside-territory home.** Field rep Karthik (assigned to Bangalore-South territory → Location 1) is working from home in Mysore (140km away). He taps CHECK_IN at 09:30. Browser returns `{lat: 12.2958, lng: 76.6394, accuracyM: 18}`. Backend: `haversine = 140km >> 200m radius`. Returns 403 `{error: "GEOFENCE_FAIL", code: "OUTSIDE_RADIUS", distance: 140234, allowedRadius: 200}`. PWA shows error toast: "You are 140km outside Bangalore Wellness territory. Contact your manager if working remotely today." Backend writes audit `ATTENDANCE_GEOFENCE_FAIL {userId: karthikId, lat, lng, distance, locationId}`. NO `AttendanceEvent` row created (per DD-5.3 strict path). Karthik calls Rishu; Rishu uses the manual-override flow (use case 3) to record Karthik's "remote work day" with `manualReason: "Approved remote work — client meeting in Mysore"`.

---

## §3 Functional requirements

### FR-3.1 NEW Prisma model `AttendanceEvent` (event-stream — the spine)

```prisma
model AttendanceEvent {
  id                Int       @id @default(autoincrement())     // DD-5.8 — Int autoincrement (NOT uuid)
  tenantId          Int       @default(1)
  tenant            Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId            Int
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade, name: "AttendanceEventUser")
  type              String                                       // CHECK_IN | CHECK_OUT | BREAK_START | BREAK_END
  eventAt           DateTime                                     // server-validated; device clock captured in deviceClockAt for drift detection
  deviceClockAt     DateTime?                                    // optional — drift detection per DD-5.4
  source            String                                       // BIOMETRIC | MANUAL | MOBILE | API — Phase 2 promotes to Prisma enum
  latitudeE7        Int?                                         // microdegrees ×10^7 for precision-without-Float — only for source=MOBILE
  longitudeE7       Int?                                         // microdegrees ×10^7
  accuracyM         Int?                                         // GPS accuracy in metres; only for source=MOBILE
  biometricDeviceId Int?                                         // FK to BiometricDevice; only for source=BIOMETRIC
  biometricDevice   BiometricDevice? @relation(fields: [biometricDeviceId], references: [id], onDelete: SetNull)
  deviceSerial      String?                                      // denormalised — frozen at event-write time
  manualReason      String?   @db.Text                           // for source=MANUAL; not enforced at schema (route validates non-empty when source=MANUAL)
  createdByUserId   Int?                                         // for source=MANUAL — manager identity; NULL for self-service
  createdBy         User?     @relation(fields: [createdByUserId], references: [id], onDelete: SetNull, name: "AttendanceEventCreatedBy")
  locationId        Int?                                         // resolved location at event time
  location          Location? @relation(fields: [locationId], references: [id], onDelete: SetNull, name: "AttendanceEventLocation")
  ipAddress         String?                                      // audit trail — webhook IP / mobile-PWA client IP
  rawWebhookJson    String?   @db.Text                           // for source=BIOMETRIC — full vendor payload archived for forensic replay
  idempotencyKey    String?                                      // dedup (userId, eventAt) within 60s window per NFR-4.5
  createdAt         DateTime  @default(now())

  @@index([tenantId, userId, eventAt])
  @@index([tenantId, source, eventAt])
  @@index([tenantId, eventAt])
  @@unique([tenantId, idempotencyKey])
}
```

**Auth:** `verifyToken` for all read endpoints; mutations require role-specific gating (see FR-3.8 RBAC matrix).

### FR-3.2 EXTEND existing Prisma model `BiometricDevice` (additive columns)

Add to existing model at [backend/prisma/schema.prisma:3694-3714](../backend/prisma/schema.prisma#L3694-L3714):

```prisma
model BiometricDevice {
  // ...existing fields preserved...
  locationId             Int?                                    // existing — promote to NON-NULL post-migration per DD-5.5
  deviceSerial           String?                                 // NEW — vendor-issued serial (distinct from operator-typed deviceId)
  ipAddress              String?                                 // NEW — for ESSL poll-mode; CRM polls this IP
  baseUrl                String?                                 // NEW — for ESSL HTTP-API base URL
  pollIntervalSeconds    Int?      @default(300)                 // NEW — for ESSL poll-mode; default 5 min
  authHeadersJson        String?   @db.Text                      // NEW — for Realtime — custom HTTP auth header bag
  ipAllowlistJson        String?   @db.Text                      // NEW — CSV-style JSON of allowed source IPs for webhook
  apiKey                 String                                  // EXISTING — but Phase 1 encrypts at rest via lib/fieldEncryption.js per NFR-4.2
  vendor                 String                                  // existing free-text; route-validates against ESSL | REALTIME | ZKTECO | OTHER
  events                 AttendanceEvent[]                       // NEW back-relation

  // ...existing constraints preserved...
}
```

### FR-3.3 EXTEND existing Prisma model `User` (additive nullable column)

```prisma
model User {
  // ...existing fields preserved...
  biometricDeviceUserId  String?                                 // NEW — local id stored in the biometric device (e.g. ESSL's per-user 1-9999 enrollment ID)
  // ...
}
```

**Migration note:** mirrored on `EmployeeProfile.biometricDeviceUserId` per `PRD_STAFF_DETAIL.md` D15 — when D15 ships first, this denormalised User column becomes a write-through alias; when this PRD ships first, the User column is the source-of-truth + D15 migrates to read from it. See DD-5.7.

### FR-3.4 Backend routes

#### FR-3.4.a `POST /api/attendance/biometric-event` (webhook — extends existing `/biometric/webhook`)

Auth: per-device shared secret via `X-API-Key` header — derives tenant from BiometricDevice row + verifies request IP against `BiometricDevice.ipAllowlistJson` (if set; empty allowlist = accept any IP for back-compat). Body shape:

```json
{
  "deviceUserId": "drHarshDeviceUid",    // local id in the device — maps to User.biometricDeviceUserId
  "type": "CHECK_IN",
  "eventAt": "2026-05-25T03:31:23Z",
  "deviceClockAt": "2026-05-25T09:01:23+05:30",
  "deviceSerial": "X990-BAN-001",
  "rawPayload": {...}                    // full vendor payload — archived to rawWebhookJson
}
```

Side effects: create `AttendanceEvent` `{source: BIOMETRIC, ...}` + writeAudit `ATTENDANCE_CHECK_IN` (or `_CHECK_OUT` per type) + dedup-against `idempotencyKey = sha256(deviceSerial:eventAt:type)` (60s window). Returns 201 `{eventId}` on success, 401 on bad key, 403 on IP miss, 409 on idempotency-replay (returns existing eventId), 422 on missing/invalid body, 500 on unexpected error (audit `ATTENDANCE_BIOMETRIC_ERROR`).

#### FR-3.4.b `POST /api/attendance/mobile-checkin` (mobile PWA — geofence verification)

Auth: `verifyToken` (JWT-authenticated user). Body shape:

```json
{
  "type": "CHECK_IN",
  "latitude": 12.9719,
  "longitude": 77.5948,
  "accuracyM": 12,
  "eventAt": "2026-05-25T03:45:00Z"      // optional — server uses now() if absent
}
```

Side effects: resolve user's assigned Location (via `User.assignedLocationId` IF that field exists, ELSE prompt operator to pick — see Q3 — for v1 the route expects `locationId` in the body, see DD-5.5); verify geofence; create `AttendanceEvent` `{source: MOBILE, latitudeE7, longitudeE7, accuracyM, ...}` + audit `ATTENDANCE_CHECK_IN` (or fail-path audit). Returns 201 `{eventId, distance}` on success, 403 on geofence-fail with reason code (`OUTSIDE_RADIUS | ACCURACY_TOO_LOW | NO_LOCATION_ASSIGNED`).

#### FR-3.4.c `POST /api/attendance/manual-checkin` (manager — verifyRole MANAGER/ADMIN)

Auth: `verifyToken` + `verifyRole(['MANAGER', 'ADMIN'])`. Body shape:

```json
{
  "targetUserId": 42,                    // note: NOT "userId" — stripDangerous middleware strips that field per CLAUDE.md
  "type": "CHECK_IN",
  "eventAt": "2026-05-25T08:30:00Z",
  "manualReason": "Device offline cache loss; verbal confirmation"
}
```

Side effects: validate `manualReason.length >= 10` (no empty/sparse reasons — payroll-grade attestation); create `AttendanceEvent` `{source: MANUAL, manualReason, createdByUserId: req.user.userId, ...}` + audit `ATTENDANCE_MANUAL_OVERRIDE` (high-signal event). Returns 201 `{eventId}`.

#### FR-3.4.d `GET /api/attendance/events` (paginated list)

Auth: `verifyToken` + tenant-scope. Query params: `?userId=N&from=ISO&to=ISO&source=BIOMETRIC|MANUAL|MOBILE|API&type=CHECK_IN|CHECK_OUT&limit=N&cursor=ID`. RBAC: USER reads own only (server-pins `userId = req.user.userId` regardless of query); MANAGER/ADMIN reads tenant-wide. Returns `{events: [...], nextCursor, hasMore, summary: {totalEvents, sourceBreakdown}}`.

#### FR-3.4.e `GET /api/attendance/events/:id` (single event — for audit drilldown)

Auth: `verifyToken` + role-scope. Returns the AttendanceEvent + writeAudit cross-ref + (for MANUAL events) the createdBy user details.

#### FR-3.4.f Existing endpoints preserved with rollup-on-event-stream

`POST /clock-in` and `POST /clock-out` continue to work (back-compat for the existing desktop attendance page) but internally now write an `AttendanceEvent` row AND update the legacy `Attendance` rollup row in the same Prisma transaction. The legacy `Attendance` model becomes a server-derived rollup — see DD-5.6.

### FR-3.5 EXTEND existing Prisma model `Location` (additive geofence columns)

```prisma
model Location {
  // ...existing fields preserved (latitude Float? + longitude Float? already there)...
  geofenceRadiusM             Int?                               // NEW — default 100m; null disables geofence for this location
  geofenceAccuracyThresholdM  Int?      @default(100)            // NEW — max GPS accuracy for valid check-in
  geofenceStrict              Boolean   @default(true)           // NEW — true rejects out-of-radius; false warns + allows
  // ...
}
```

### FR-3.6 Admin pages

- **Settings → Biometric Devices** at `/settings/biometric-devices` (admin only): CRUD list of BiometricDevice rows. Per-device fields surfaced: vendor (dropdown ESSL | REALTIME | ZKTECO | OTHER), deviceSerial, deviceId (display name), locationId (Location picker), ipAddress, baseUrl (for ESSL), pollIntervalSeconds, authHeadersJson (collapsible JSON editor for Realtime), apiKey (write-only, copy-on-create; show masked thereafter as `glbs_***...***last4` per CLAUDE.md credentialMasking pattern), ipAllowlistJson (textarea for IP CIDRs), isActive toggle, lastSyncAt (read-only). "Test connection" button (for ESSL — hits the device's HTTP-API ping endpoint, displays last 5 events fetched).

- **Settings → Geofences** at `/settings/geofences` (admin only): table of all Locations with `geofenceRadiusM` + `geofenceAccuracyThresholdM` + `geofenceStrict` editable inline. Map preview (Leaflet/OpenStreetMap) showing radius circle around lat/lng per location. "Set my current location" helper button (uses browser geolocation to populate lat/lng for the location row).

- **Wellness → Attendance Events** at `/wellness/attendance/events` (manager/admin): paginated event-stream list with filters (user / source / date range / type) + source-breakdown stacked bar chart (% biometric / manual / mobile per user per week) + drilldown to per-event detail (`/wellness/attendance/events/:id`).

- **Wellness → Mobile Check-in (PWA shell)** at `/m/attendance` (any authenticated user): single-page shell with two big buttons (CHECK_IN / CHECK_OUT), background sets to assigned Location's name + map pin, geolocation requested on tap, success/error toast. Offline queue (IndexedDB) flushes on reconnect.

### FR-3.7 Audit log — additive event vocab

The existing `lib/audit.js` `writeAudit()` chain accepts any new entity vocab without code change (per CLAUDE.md auditing posture). New events:

- `ATTENDANCE_CHECK_IN { eventId, userId, source, locationId?, biometricDeviceId? }`
- `ATTENDANCE_CHECK_OUT { eventId, userId, source, ...same shape }`
- `ATTENDANCE_MANUAL_OVERRIDE { eventId, managerId, targetUserId, manualReason, type, eventAt }` — high-signal; surface in audit-viewer
- `ATTENDANCE_BIOMETRIC_ERROR { biometricDeviceId, errorReason, rawPayload }` — for forensic replay
- `ATTENDANCE_GEOFENCE_FAIL { userId, lat, lng, distance, locationId, reason }` — security signal
- `ATTENDANCE_DEVICE_REGISTERED / _DEVICE_DEACTIVATED { adminUserId, deviceId, vendor }` — config-change audit

### FR-3.8 RBAC matrix

- **USER** (self-service): `POST /clock-in`, `POST /clock-out`, `POST /mobile-checkin` (self only — server-pins `userId = req.user.userId`); `GET /events?userId=<own>` (server-pins). NO access to other users' events.
- **MANAGER**: all USER rights + `POST /manual-checkin` (any tenant user) + `GET /events` (tenant-wide; no userId pin) + `GET /staff/:userId` (existing) + `GET /summary` (existing).
- **ADMIN**: all MANAGER rights + Settings → Biometric Devices CRUD + Settings → Geofences CRUD + ability to deactivate any device + view raw webhook payloads.

### FR-3.9 Mobile PWA shell — offline queue + service worker

- Service worker at `frontend/public/sw-attendance.js` caches the `/m/attendance` shell + assets for offline render.
- Offline queue: failed POSTs to `/mobile-checkin` (no network) are queued in IndexedDB; service worker re-fires on `'sync'` event when connectivity returns. Each queued event carries its original `eventAt` timestamp so the server records the actual check-in time, not the network-reconnect time.
- Battery: geolocation requested with `enableHighAccuracy: true` + `maximumAge: 60000` (60s) + `timeout: 10000` (10s) — balances accuracy with battery drain.
- Installable PWA manifest at `/m/manifest.json` so staff can "Add to Home Screen."

### FR-3.10 Cron engine `biometricDevicePollEngine` (engine #25)

New cron engine at `backend/cron/biometricDevicePollEngine.js`. Runs every 5 min (configurable per BiometricDevice via `pollIntervalSeconds`). For each `BiometricDevice` where `vendor='ESSL' AND isActive=true AND baseUrl IS NOT NULL`:

1. Fetch device's HTTP-API `/api/transactions?since=<lastSyncAt>` (ESSL standard endpoint per vendor docs — see Yasin's cred chase).
2. For each new transaction, map `deviceUserId → User.id` via `User.biometricDeviceUserId` lookup. If no match, write audit `ATTENDANCE_BIOMETRIC_ERROR { reason: 'UNKNOWN_USER', deviceUserId }` + skip.
3. Create `AttendanceEvent` row with `source=BIOMETRIC` + idempotency key from device's transaction id.
4. Update `BiometricDevice.lastSyncAt = max(transactionTs)`.
5. On HTTP error, write audit `ATTENDANCE_BIOMETRIC_ERROR { reason: 'POLL_FAILED', errorMessage }` + alert via existing notification surface.

Admin trigger endpoint `POST /api/attendance/devices/:id/sync-now` (verifyRole ADMIN) per the `adding-admin-trigger-endpoint` skill — manually fires the poll for a single device for testing.

### FR-3.11 Vendor adapter pattern

`backend/services/biometricVendorAdapter.js` exports `{ getAdapter(vendor) }`. Per-vendor implementations:

- `essl.js` — HTTP-API poll-mode; transforms ESSL transaction shape `{empId, ts, type}` → CRM's `{deviceUserId, eventAt, type}`.
- `realtime.js` — webhook push-mode; the `/biometric-event` route delegates payload parsing to this adapter.
- `zkteco.js` — Phase 2 placeholder; v1 returns 501.
- `other.js` — generic fallback; accepts a permissive payload shape.

Each adapter exposes `parseEvent(rawPayload) → {deviceUserId, eventAt, type, deviceSerial}` and (for poll-mode) `fetchTransactions(device, since) → [event]`.

---

## §4 Non-functional

### NFR-4.1 Per-tenant scoping

Every endpoint scopes queries by `req.user.tenantId`. The biometric webhook derives tenant from the matched `BiometricDevice` row (cross-tenant device keys are impossible because `@@unique([apiKey])` makes the key globally unique). The cron poll engine iterates `BiometricDevice.findMany({where: {isActive: true}})` across all tenants in one engine tick; each device's events are scoped to its `tenantId`.

### NFR-4.2 Biometric API key encryption at rest

The `BiometricDevice.apiKey` column is encrypted via `lib/fieldEncryption.js` (existing AES-256-GCM helper) — opt-in via `BIOMETRIC_DEVICE_KEY` env var (mirrors the existing `WELLNESS_FIELD_KEY` pattern for Patient PII per CLAUDE.md). Plaintext keys at rest in v1 (back-compat); Phase 2 migrates existing keys via one-shot script + flips the env var. The webhook uses the same encrypted-lookup pattern (decrypt-on-read; constant-time-compare against the incoming `X-API-Key`).

### NFR-4.3 Geofence accuracy threshold

Default `geofenceAccuracyThresholdM = 100`. Operators with weak GPS (e.g. indoor clinic with thick walls) may relax to 200m. Operators with sensitive territories may tighten to 50m. The 100m default matches typical urban Indian GPS accuracy on mid-range Android.

### NFR-4.4 Webhook security

- Per-device shared secret via `X-API-Key` (existing pattern).
- Per-device IP allowlist via `BiometricDevice.ipAllowlistJson` (NEW — null means accept any IP for back-compat; recommended for production).
- Rate limit: 10 events/sec/device (`express-rate-limit` per-key bucket — extends existing rate-limit middleware in `backend/server.js`).
- Body size limit: 8KB per webhook payload (catches accidental device-firmware bugs that POST oversized payloads).
- Replay protection: idempotency key `sha256(deviceSerial:eventAt:type)` dedupes within 60s window — accidental double-tap on the device by an impatient operator produces ONE AttendanceEvent, not two.

### NFR-4.5 Event idempotency

- For BIOMETRIC: `idempotencyKey = sha256(deviceSerial:eventAt:type)` — same scan replay returns existing event.
- For MOBILE: `idempotencyKey = sha256(userId:eventAt:type)` — accidental double-tap returns existing event.
- For MANUAL: NO idempotency (manager intent is the authority; a manager who clicks twice MEANT to record two events; rare but valid).
- For API: idempotency via the API-key consumer's optional `Idempotency-Key` request header (mirrors existing payment/sale idempotency pattern).

### NFR-4.6 Battery + offline (mobile PWA)

- Geolocation: `enableHighAccuracy: true` + `maximumAge: 60000` (60s) — battery vs accuracy tradeoff.
- Offline queue: IndexedDB-backed; service worker `'sync'` event re-fires on reconnect; events preserve original `eventAt` timestamp + accuracy.
- Each offline event marked `source: MOBILE` + `offlineSubmittedAt: <reconnect-ts>` (NEW optional column — Phase 2; v1 stores only `eventAt`).

### NFR-4.7 Migration plan

- Slice 1 ships `AttendanceEvent` model + endpoints; the existing single-row-per-day `Attendance` model stays as a SERVER-COMPUTED ROLLUP (see DD-5.6).
- A one-shot backfill script at `backend/scripts/backfill-attendance-events.js` translates existing `Attendance` rows into pseudo-AttendanceEvent rows (one CHECK_IN at `clockInAt`, one CHECK_OUT at `clockOutAt` per existing row) so the new event-stream has historical data on day 1.
- Phase 2 (~90 days post-deploy) DEPRECATES the standalone `Attendance` writes — all writes flow through the event-stream; rollup computed on-demand.
- Phase 3 (~180 days post-deploy) DROPS the legacy `Attendance` table OR retains it as a materialized-view (cron-refreshed) for fast `/summary` reads. DD-5.6 captures this.

### NFR-4.8 Performance

- Indexes on `AttendanceEvent`: `(tenantId, userId, eventAt)` for per-user history; `(tenantId, source, eventAt)` for source-breakdown reports; `(tenantId, eventAt)` for tenant-wide chronology.
- `/events` listing endpoint: cursor-paginated (cursor = `eventAt + id` to avoid OFFSET cost on large tenants).
- `/summary` endpoint: 5-min cache on the rollup result keyed by `(tenantId, userId?, from, to, source?)` — invalidated on any AttendanceEvent write for the affected user+day.

---

## §5 Hand-over reqs / cred chase / design decisions / vendor docs

### Design decisions (8 — product call required)

- **DD-5.1: Vendor matrix — ESSL only (v1) vs ESSL + Realtime + ZKTeco + others (v1).** Recommend ESSL ONLY for v1; extend later via the vendor adapter pattern in FR-3.11. ESSL dominates Indian clinic biometric market (~70% per vendor research); Realtime is ~15%; ZKTeco is enterprise/large-clinic. Shipping ESSL-only gets 70% of the addressable surface with the smallest cred chase. (Affects FR-3.10 + FR-3.11 + §8 dependencies.)

- **DD-5.2: Mobile app surface — PWA (camera + geolocation on existing web SPA) vs native (Android first, iOS later).** Recommend PWA for v1; native app Phase 2. PWA ships in 1-2 weeks atop the existing wellness SPA; native is 4-8 weeks per platform. PWA's geolocation + offline queue (IndexedDB) is sufficient for the v1 use case. Operator experience: "Add to Home Screen" gives near-native feel on Android; iOS PWA support is weaker but acceptable. (Affects FR-3.9 + §7 out-of-scope.)

- **DD-5.3: Geofence enforcement — strict (reject outside-radius) vs lenient (allow but flag).** Recommend STRICT for security-conscious clinics; CONFIGURABLE per tenant via `Location.geofenceStrict Boolean @default(true)`. Tenants who want lenient (e.g. delivery driver who legitimately moves outside the geofence mid-day) can flip the per-Location flag. (Affects FR-3.5 + FR-3.4.b + §7.) **HIGHEST LEVERAGE — determines the entire UX feedback loop for mobile users.**

- **DD-5.4: Event timestamp source — device clock (event-at-scan) vs server receive time (event-at-receive).** Recommend SERVER timestamp as `eventAt` (authoritative) + CAPTURE device clock too as `deviceClockAt` (drift detection). For BIOMETRIC events, the device may have hours of clock drift if the LAN NTP is misconfigured; the operator scanned at 09:01 device-time but the cron polled at 09:05 server-time and the device-time was actually 08:47. Capturing both lets the audit-viewer surface the drift. (Affects FR-3.1.)

- **DD-5.5: Mobile user's assigned Location — derived from `User.assignedLocationId` (NEW field) vs picker on every check-in vs server-derived from territory + booking.** Recommend NEW `User.assignedLocationId Int?` field (FR-3.3 addition) + picker fallback. The territory-mapping derivation is fragile (a user assigned to multiple territories has ambiguous location). Picker-only is poor UX (operator picks the same location 250 days/year). Recommend: default to `User.assignedLocationId`, allow override via body param. (Affects FR-3.4.b + Q3.)

- **DD-5.6: Event-stream + rollup cohabitation — keep single-row-per-day `Attendance` as server-derived rollup vs deprecate the rollup entirely.** Recommend KEEP `Attendance` as a cron-refreshed rollup table for fast `/summary` reads + DEPRECATE direct writes (Phase 2). Existing `frontend/src/pages/Attendance.jsx` reads `Attendance`; rewriting that page to query `AttendanceEvent` on every load is wasteful. Rollup table is updated transactionally on each AttendanceEvent write (single Prisma `upsert` on `(tenantId, userId, date)`) — keeps existing reads fast + new event-stream consumer pattern available. (Affects FR-3.4.f + NFR-4.7.) **HIGHEST LEVERAGE — determines migration scope across the existing 793-LOC route file + frontend.**

- **DD-5.7: User.biometricDeviceUserId vs EmployeeProfile.biometricDeviceUserId.** Recommend BOTH (denormalised) — `User.biometricDeviceUserId` is the source-of-truth that this PRD writes; `EmployeeProfile.biometricDeviceUserId` (per `PRD_STAFF_DETAIL.md` D15) is a read-through alias for the employee-detail page. If D15 ships first, both shipped fields write-through to `User`. If this PRD ships first, D15's column is added in coordination + back-fills from User. The denormalisation is small; the alternative (single source on EmployeeProfile) forces a JOIN on every biometric poll — undesirable. (Affects §8 + Q4.)

- **DD-5.8: Int autoincrement vs UUID PK for AttendanceEvent.** Recommend Int autoincrement (matches CRM-wide pattern — every other model uses Int). Zylu reference uses UUID for synthesis-into-distributed-systems compatibility; CRM is single-database so Int is sufficient + has bounded index size. (Affects FR-3.1.)

### Cred chase — Yasin owes

- **ESSL India developer documentation** — the HTTP-API spec for ESSL biometric devices (X990, K20, F22 — common India models). Endpoints: `GET /api/transactions?since=<ts>`, auth header shape, transaction payload schema, error codes. Without this, FR-3.10 (poll engine) and FR-3.11.a (ESSL adapter) cannot be implemented concretely. **Blocks slice 3.**
- **Physical ESSL device** for integration testing (X990 recommended — most common India clinic model). Yasin's contact at ESSL India should expedite a loaner unit. **Blocks slice 3 end-to-end testing.**
- **Realtime India developer documentation** — webhook payload schema + auth header shape for Realtime T502 / T700 devices. **Blocks slice 4.**
- **Sample ESSL device IP allowlist** for production deploy — what IP block does the demo clinic's ESSL device speak from? (Most clinic LANs are behind NAT so this is the LAN's public IP via the clinic's ISP.) **Blocks production rollout per location.**

### Vendor research notes (preliminary, pending Yasin's confirmation)

- ESSL X990 ships HTTP-API at port 4370 (Push SDK) and 80 (RestAPI subset). Most clinic deploys use the RestAPI poll-mode because the Push SDK requires a static public IP for the CRM (clinic LAN NAT-blocks outbound from the device).
- Realtime ships webhook push-mode with HMAC-SHA256 signing. CRM endpoint verifies `X-Signature` header against shared secret.
- ZKTeco (Phase 2) ships Push SDK; needs the same static-public-IP infrastructure as ESSL Push.

---

## §6 Acceptance criteria

1. **AttendanceEvent model exists + is the source-of-truth for new writes.** After implementation, `prisma.attendanceEvent.findMany({where: {tenantId, userId}})` returns the full event-stream history; existing `Attendance` rollup table is updated transactionally on every event-stream write. A vitest unit test verifies `Attendance.totalMinutes` matches `sum(checkOut.eventAt - checkIn.eventAt across day's events)`.

2. **Biometric webhook with IP allowlist + idempotency works against demo box.** Curl POST to `/api/attendance/biometric-event` with valid `X-API-Key` + within allowlisted IP + valid body → 201 + AttendanceEvent row created. Same POST replayed within 60s → 409 idempotency-replay + same event id returned (no duplicate). POST from non-allowlisted IP → 403. POST with wrong key → 401.

3. **Mobile geofenced check-in respects per-Location radius.** PWA at `/m/attendance` from a browser within the geofence radius (e.g. 50m of the office) → 201 + AttendanceEvent row with `source=MOBILE`. From outside the radius → 403 `{error: "GEOFENCE_FAIL", code: "OUTSIDE_RADIUS", distance}` + audit `ATTENDANCE_GEOFENCE_FAIL` row.

4. **Manager manual-override emits high-signal audit row.** ADMIN/MANAGER POSTs `/manual-checkin` with `{targetUserId, type, eventAt, manualReason}` → 201 + AttendanceEvent row with `source=MANUAL` + `createdByUserId=req.user.userId` + audit `ATTENDANCE_MANUAL_OVERRIDE` row surfaced in `/audit-viewer` with manager + target user + reason visible.

5. **Source-breakdown report shows three-way breakdown.** `GET /api/attendance/events?from=2026-05-18&to=2026-05-25&groupBy=source` returns `{biometric: N, manual: M, mobile: K, total: N+M+K}` + per-user breakdown. Frontend `/wellness/attendance/events` page renders a stacked bar chart with three colours per user-row. A vitest unit test verifies the rollup math: feeding 5 biometric + 2 manual + 3 mobile events for one user one week returns `{biometric: 5, manual: 2, mobile: 3}`.

---

## §7 Out of scope (v1)

- **Face recognition / fingerprint at the SPA layer** (camera-side capture + biometric match in the browser). Out for v1 — biometric DEVICE-side only. Phase 2 may add browser-side face recognition for the mobile PWA as an additional source.
- **Payroll calculation from attendance.** Out — payroll spans labor-law compliance, leave-encashment, overtime, statutory deductions; that's a separate PRD (`PRD_PAYROLL.md` doesn't exist yet but is implied by `PRD_STAFF_DETAIL.md` D15). This PRD ships the event stream; payroll reads from it.
- **Shift-roster auto-generation** (e.g. "auto-assign Dr Harsh to Mon-Wed 9-1, Thu-Sat 4-9"). Out — operational complexity. Phase 2 ships a Shift model + roster editor.
- **Indian labor-law compliance reports** (Form-A / Form-B / Form-C / Bonus Act / Apprentice Act statutory paperwork). Out — Phase 2; depends on payroll spine.
- **Geofence per-territory (vs per-Location).** Out — v1 supports per-Location geofence only. Territories may map to multiple Locations and the territory-as-geofence shape is ambiguous (a territory is a sales coverage area, not a fixed point). Phase 2 may add territory-radius if operationally needed.
- **Native mobile app** (Android + iOS) — out for v1. PWA is the v1 mobile surface. Phase 2 native app.
- **ZKTeco vendor adapter** — out for v1 (only ESSL + Realtime + generic Other in v1). Phase 2.
- **Multi-source-merge per event** (e.g. "biometric scan + GPS captured + manager note all on one event row"). Out — each AttendanceEvent has ONE source. If a manager notices an anomaly in a biometric scan, they create a SEPARATE MANUAL event linking to it via `manualReason` text (no FK).

---

## §8 Dependencies

### Existing infrastructure (preserved + extended)

- `Attendance` model (preserved as rollup per DD-5.6) at [backend/prisma/schema.prisma:3663-3692](../backend/prisma/schema.prisma#L3663-L3692)
- `BiometricDevice` model (extended per FR-3.2)
- `User` model (additive `biometricDeviceUserId` per FR-3.3)
- `Location` model (additive geofence columns per FR-3.5)
- `LeavePolicy` + `LeaveBalance` + `LeaveRequest` models — read-only dependency (the `/summary` endpoint joins leave data to mark holiday/leave days; preserved unchanged)
- `lib/fieldEncryption.js` — wired for BiometricDevice.apiKey encryption per NFR-4.2
- `lib/audit.js` `writeAudit()` — existing tamper-evident chain; new event vocab additive
- `lib/validateDateRange.js` — existing inverted-date-range guard (preserved for new endpoints)
- `middleware/auth.js` `verifyToken` + `verifyRole(['ADMIN', 'MANAGER'])` — existing
- `middleware/stripDangerous` — note: the new `manual-checkin` route uses `targetUserId` NOT `userId` body param (stripDangerous strips `userId`)
- `routes/attendance.js` — existing 793 LOC; extended additively

### Sibling PRDs

- **`PRD_STAFF_DETAIL.md` (D15)** — `EmployeeProfile.biometricDeviceUserId` mirrors `User.biometricDeviceUserId` per DD-5.7. Per-employee biometric device id storage lives there for the employee-detail page; this PRD writes/reads it on User directly.

### External services

- ESSL devices via HTTP-API (poll-mode) — pending cred chase
- Realtime devices via webhook (push-mode) — pending cred chase
- Browser geolocation API (W3C standard) — built-in
- Browser IndexedDB + service worker (W3C standard) — built-in

### Schema migrations

- Additive: 1 NEW model (`AttendanceEvent`) + 5 columns on `BiometricDevice` + 1 column on `User` + 3 columns on `Location`. Passes `migration_check` gate without bless markers.
- Phase 2 may need `[allow-column-drop]` bless marker for dropping `Attendance` columns if the model is fully deprecated (per DD-5.6).

---

## §9 Open questions (7 — for product call)

- **Q1: Vendor scope — ESSL only or multi-vendor matrix from day 1?** Affects FR-3.10 + FR-3.11 + §5 cred chase + slice 3 vs slices 3+4. (Recommend ESSL only v1; Realtime v1.1.)

- **Q2: Geofence enforcement — strict (reject) or warn-and-allow (audit-only)?** Affects FR-3.4.b 403 vs 200 response shape + audit-viewer UX. (Recommend STRICT default, per-Location flag for lenient.)

- **Q3: User's assigned Location — new `User.assignedLocationId` field, picker on every check-in, or territory-derived?** Affects FR-3.3 + FR-3.4.b + UX of every mobile check-in. (Recommend new field + picker fallback.)

- **Q4: Multi-shift staff — multiple check-in/out pairs per day, or single per shift?** The event-stream model supports any pair count; the rollup table needs to know how to aggregate. Recommend rollup = `(min(checkIn.eventAt), max(checkOut.eventAt), sum(checkOut-checkIn) across all pairs)`. (Affects FR-3.4.f + Attendance.totalMinutes computation.)

- **Q5: Late / early-leave grace window — fixed 5min / 15min, or per-tenant configurable?** Affects `/summary` reporting + status flag (`LATE` vs `PRESENT`). Today's policy at [routes/attendance.js summary code] hardcodes a shift-start window. Recommend per-tenant configurable via Tenant.attendanceGraceMin Int @default(15).

- **Q6: Holiday calendar integration — events on declared holidays auto-flagged as `HOLIDAY_OVERRIDE`?** The existing `Holiday` model (per CLAUDE.md Wave 11 Agent GG) is scoped per-location. A staff member who works on a declared holiday — should the AttendanceEvent be auto-flagged for HR review (overtime pay)? Recommend YES — populate `holidayOverride: true` on the event if eventAt falls in a Holiday row for the user's location. (Affects FR-3.1 + payroll integration.)

- **Q7: Audit retention — 1 year (Indian labor-law minimum) or longer?** AttendanceEvent rows are payroll-grade financial records (timeworked → wage). Indian Shops & Establishments Act / Factory Act minimum is 3 years for attendance registers. Recommend RETAIN at least 3 years (effectively forever for v1; archive job in Phase 2). (Affects GDPR retention engine — `retentionEngine.js` excludes AttendanceEvent from auto-purge.)

---

## §10 Status snapshot

- **Status:** NOT STARTED (PRD draft only)
- **Owner:** TBD per product call
- **Estimated effort post-design:** **8-12 engineering days** across backend + frontend
  - Slice 1 (~1.5d) = Prisma `AttendanceEvent` model + `BiometricDevice` + `User` + `Location` additive columns + `routes/attendance.js` extensions (`/biometric-event` + `/mobile-checkin` + `/manual-checkin` + `/events` + back-compat /clock-in/out internally writing AttendanceEvent + rollup) + api-spec tests
  - Slice 2 (~0.5d) = Audit event vocab + lib/fieldEncryption.js wiring for BiometricDevice.apiKey + IP allowlist enforcement on /biometric-event
  - Slice 3 (~2d) = ESSL vendor adapter at `services/biometricVendorAdapter.js::essl.js` + `cron/biometricDevicePollEngine.js` engine + admin trigger endpoint `POST /api/attendance/devices/:id/sync-now` + vitest for adapter
  - Slice 4 (~0.75d) = Realtime vendor adapter + webhook hardening (HMAC-SHA256 verify per Realtime spec) + vitest
  - Slice 5 (~1d) = Admin pages — `Settings → Biometric Devices` + `Settings → Geofences` + `/wellness/attendance/events` event-stream list + RBAC field-hiding
  - Slice 6 (~2d) = Mobile PWA shell at `frontend/src/pages/m/Attendance.jsx` + service worker at `frontend/public/sw-attendance.js` + IndexedDB offline queue + manifest.json + Leaflet map preview on Geofences page
  - Slice 7 (~1.25d) = Source-breakdown reports + backfill script at `backend/scripts/backfill-attendance-events.js` + admin trigger endpoint + runbook
- **Cred chase:** ESSL India docs + physical X990 device (blocks slice 3) + Realtime India docs (blocks slice 4) — Yasin's outreach
- **Cluster:** MANUAL_CODING_BACKLOG.md cluster D — proposing **D20**
- **Blocks before implementation can start:**
  - **DD-5.3 (geofence strict-vs-lenient default) — HIGHEST LEVERAGE; cascades to mobile UX feedback loop + audit-viewer + tenant onboarding**
  - **DD-5.6 (event-stream + rollup cohabitation) — HIGHEST LEVERAGE; cascades to migration scope across existing 793-LOC route file + frontend Attendance page + payroll integration**
  - DD-5.1 (vendor scope ESSL-only v1 vs multi-vendor) — affects §5 cred chase volume + slice 3 vs slices 3+4
  - DD-5.2 (mobile surface PWA vs native) — affects slice 6 effort (2d PWA vs 4-8 weeks native per platform)
  - DD-5.5 (User.assignedLocationId vs picker vs territory-derived) — affects FR-3.3 + every mobile check-in UX
  - Q1 (vendor scope — tied to DD-5.1)
  - Q4 (multi-shift rollup math) — affects FR-3.4.f rollup correctness + payroll integration
  - Q6 (holiday-override auto-flag) — affects FR-3.1 + payroll
- **Sibling PRDs:** PRD_STAFF_DETAIL (D15 — `EmployeeProfile.biometricDeviceUserId` cross-ref) · PRD_POS_NEW_SALE (D17 — `Sale.cashierId` reads from Attendance rollup for cashier-shift-attendance audit Phase 2) · PRD_INTEGRATIONS_HUB (D11 — Phase 3 biometric vendor integrations surface as hub cards for unified governance)
- **Provisional GitHub Issue label additions on #805 once this PRD lands:** `prd:drafted` + `decision:awaiting-product-call` + `cluster:D20`

---

**End of PRD draft.** The next step is the product call with Yasin + Rishu to walk DD-5.1 → DD-5.8 + Q1 → Q7. Estimated call duration: ~45 min. Post-call, the PRD updates to "Status: APPROVED" + the slice plan locks + implementation begins on slice 1 (additive schema + back-compat extension of existing routes — safe to ship without further blocking).
