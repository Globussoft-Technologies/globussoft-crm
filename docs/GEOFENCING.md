# Geo-tagged attendance (geofencing) — wellness vertical

Status: **shipped end-to-end** as of this doc. Backend enforcement existed
already; this pass added the missing frontend pieces — browser location
capture on clock-in/out, admin UI to set a clinic's coordinates + radius, and
admin UI to assign staff to one or more clinics.

## What it is

Geofencing restricts clock-in/out to staff who are physically near an
assigned clinic. It's **enforced only for `wellness`-vertical tenants** —
generic and travel tenants share the same `/api/attendance/clock-in` and
`/api/attendance/clock-out` endpoints, unmodified, with no location check.

## How it works, end to end

1. **Admin sets clinic coordinates.** On the Locations page
   (`/wellness/locations`), each clinic can optionally have a latitude,
   longitude, and check-in radius (meters). A clinic with no coordinates has
   no geofence — anyone assigned there can clock in from anywhere.
2. **Admin assigns staff to one or more clinics.** On the Staff page
   (`/staff`), editing a staff member shows a "Clinic locations" picker —
   toggle chips, one per active clinic. A staff member can be assigned to
   multiple clinics (e.g. a doctor who splits time between two locations).
3. **Staff clocks in/out from the Attendance page.** The browser's
   Geolocation API captures the user's current latitude/longitude/accuracy
   and sends it along with the punch. The backend checks the punch against
   every clinic the staff member is assigned to and accepts it if it's
   within radius of **any one** of them.
4. **Enforcement is opt-in per staff member.** A staff member with **zero**
   assigned clinics is **not geofenced at all** — the punch is accepted
   unconditionally, same as before this feature existed. This lets an admin
   roll geofencing out clinic-by-clinic / staff-by-staff without locking
   anyone out by accident.

## Admin: configuring a location's geofence

1. Go to **Wellness → Locations**.
2. Click **New location** (or the pencil icon to edit an existing one).
3. Fill in the usual fields (name, address, city, …). Below the contact
   fields there's a **"Geofenced check-in"** section with three optional
   fields:
   - **Latitude** / **Longitude** — the clinic's coordinates. You can type
     these in directly, or click **"Use my current location"** if you're
     physically at the clinic — it reads your browser's GPS and fills both
     fields automatically.
   - **Radius (meters)** — how far from that point a clock-in/out is still
     accepted. Leave blank to use the platform default (**150 meters**).
4. Save. The location card now shows a green **"Geofenced — Nm radius"**
   badge, or a gray **"No geofence"** badge if coordinates were left blank.
5. Latitude and longitude must be supplied **together** — you can't set one
   without the other (the backend rejects that with `INCOMPLETE_COORDS`).

To turn geofencing back off for a clinic, edit it and clear both the
latitude and longitude fields, then save.

## Admin: assigning multiple locations to a staff member

1. Go to **Staff**, click **Edit** on the staff member's row.
2. Scroll to the **"Clinic locations"** section (wellness tenants only,
   and only shown once at least one clinic exists).
3. Click each clinic chip the staff member should be allowed to clock in
   from. Multiple chips can be selected — the staff member only needs to be
   near **one** of their assigned clinics to punch successfully, not all of
   them.
4. Click **Save clinic assignments**. This is a separate save action from
   the rest of the staff form (name/email/role/etc.) — it calls its own
   endpoint, so you don't need to hit the modal's main "Save changes" button
   for the location assignment to take effect (though it doesn't hurt to
   click both).
5. Leaving every chip unselected removes geofence enforcement for that
   staff member entirely — same effect as never having assigned them.

### Why this is a separate save action

Staff↔Location is a many-to-many relationship (`UserLocation` join table),
not a single field on the staff member's own row like their name or role.
The picker fetches and saves against its own endpoint
(`GET`/`PUT /api/wellness/location-assignments/:userId`) rather than being
bundled into the main staff-edit `PUT /api/staff/:id` call.

**Why `/location-assignments/:userId` and not `/staff/:userId/locations`:**
this repo enforces a strict namespacing rule (#348, see
`docs/API_NAMESPACING.md`) — `/api/wellness/*` is reserved for clinical
resources, and org-level resources like staff have **no** wellness alias.
`backend/routes/wellness.js` has a catch-all
`router.all("/staff/*", wellnessNamespacedRedirect("/api/staff"))` that
returns `410 WELLNESS_NAMESPACE_INVALID` for literally anything under
`/wellness/staff/*`, regardless of HTTP method. An earlier version of this
endpoint used that path and got swallowed by the redirect; it was moved to
`/location-assignments/:userId` to stay clear of the guard.

## What happens at punch time

When a wellness-tenant staff member clicks **Punch In** / **Punch Out** on
the Attendance page:

1. The browser asks for location permission (if not already granted) and
   reads the current GPS position.
2. If the browser denies permission, times out, or doesn't support
   geolocation, the punch is still sent — just without coordinates. Whether
   that succeeds depends on whether the staff member has any assigned
   clinics (see below).
3. The backend (`resolveGeofenceContext` in `backend/routes/attendance.js`)
   looks up the tenant's vertical and the staff member's assigned clinics,
   then calls `evaluatePunchGeofence()` (`backend/lib/attendanceGeofence.js`):

   | Situation | Result |
   |---|---|
   | Tenant isn't `wellness` | Always accepted, no location needed |
   | Staff member has 0 assigned clinics | Always accepted, no location needed |
   | No coordinates were sent, but staff member has ≥1 assigned clinic | Rejected — `403 LOCATION_REQUIRED` |
   | GPS accuracy worse than 500m | Rejected — `403 ACCURACY_TOO_LOW` |
   | Coordinates are outside every assigned clinic's radius | Rejected — `403 OUTSIDE_RADIUS` |
   | Coordinates are within radius of at least one assigned clinic | Accepted |

4. On rejection, the Attendance page shows a friendly message instead of
   the raw error code (see `geofenceErrorMessage()` in
   `frontend/src/pages/wellness/Attendance.jsx`).

## Defaults & constants

Defined in `backend/lib/attendanceGeofence.js`:

- `DEFAULT_RADIUS_M = 150` — applied when a Location has coordinates but no
  explicit `geofenceRadiusM`.
- `ACCURACY_THRESHOLD_M = 500` — a location reading fuzzier than this is
  rejected before the distance check even runs, since a low-accuracy fix
  can't reliably confirm or deny proximity. Originally 100m, raised to 500m
  after confirming (via a real browser payload capture) that ordinary
  laptop/WiFi-based geolocation routinely reports ~500m accuracy — at 100m,
  staff checking in from a desktop at their own clinic could get blocked by
  their device's positioning method rather than by actually being far away.
  500m still catches genuinely-unusable multi-km-off readings.

Both are only defaults for the *fallback radius*; there's currently no UI
to change the accuracy threshold or the platform default radius per-tenant
— that would require an env var change or a schema addition if a future
request needs it.

## Relevant files

| Layer | File |
|---|---|
| Geofence math (haversine distance, accuracy check) | `backend/lib/attendanceGeofence.js` |
| Clock-in/out enforcement | `backend/routes/attendance.js` (`resolveGeofenceContext`, `parseCoords`, wired into `POST /clock-in` and `/clock-out`) |
| Location CRUD (incl. lat/lng/radius) | `backend/routes/wellness.js` (`POST /locations`, `PUT /locations/:id`, `validateGeofenceFields`) |
| Staff↔Location assignment | `backend/routes/wellness.js` (`GET`/`PUT /location-assignments/:userId`) |
| Schema | `backend/prisma/schema.prisma` — `Location.latitude` / `.longitude` / `.geofenceRadiusM`, `UserLocation` join model |
| Admin: Locations page | `frontend/src/pages/wellness/Locations.jsx` |
| Admin: Staff assignment picker | `frontend/src/pages/Staff.jsx` (`LocationAccessPicker`) |
| Staff: clock-in/out | `frontend/src/pages/wellness/Attendance.jsx` (`getCurrentCoords`, `geofenceErrorMessage`) |
| Unit tests | `backend/test/lib/attendanceGeofence.test.js` |

## Known gaps / not built

- **No mobile-specific check-in flow.** The browser Geolocation API works on
  mobile web (most phones support it in-browser), but there's no dedicated
  PWA install prompt, no `source=MOBILE` write path, and no
  `/mobile-checkin` endpoint. If staff clock in from a phone browser today,
  it works the same as desktop — just less convenient.
- **No biometric device integration UI.** A `BiometricDevice` CRUD API
  exists in the schema/backend, but there's no Settings page to configure a
  fingerprint/face scanner vendor (ESSL, Realtime, etc.). Tracked
  separately in `docs/PRD_BIOMETRIC_ATTENDANCE.md` and blocked on a vendor
  decision (`DD-5.6` in `docs/DECISIONS_TRACKER.md`).
- **No tenant-level override for `DEFAULT_RADIUS_M` / `ACCURACY_THRESHOLD_M`.**
  These are global constants, not per-tenant settings.
- **No API test coverage yet** for the new `geofenceRadiusM` field on
  Location create/update, or for the new `/location-assignments/:userId`
  endpoints. Per this repo's standing rule, a new route handler should get
  a Playwright spec at `e2e/tests/<route>-api.spec.js` wired into the
  deploy gate — that's a follow-up, not done as part of this pass.
