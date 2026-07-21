// attendanceGeofence.js — geo-tagged attendance (wellness vertical only).
//
// Decides whether a clock-in/out punch is accepted, given the coordinates
// the browser captured and the punching user's assigned clinics.
//
// Design (per product decisions):
//   - Enforced ONLY for wellness-vertical tenants. Other verticals (travel,
//     generic) share the same clock-in/out route unmodified.
//   - A user with NO assigned Location (UserLocation rows) is NOT enforced —
//     falls back to today's unconditional-accept behaviour. This lets an
//     admin roll geofencing out clinic-by-clinic without locking out staff
//     who haven't been assigned yet.
//   - A user CAN be assigned to multiple clinics (e.g. a doctor splitting
//     time across two locations) — the punch passes if it's within radius
//     of ANY ONE of their assigned Locations.
//   - GPS accuracy is checked independently of distance: a reading fuzzier
//     than ACCURACY_THRESHOLD_M is rejected before the distance check even
//     runs, since a low-accuracy fix can't reliably confirm OR deny
//     proximity.
//   - Locations without their own geofenceRadiusM fall back to
//     DEFAULT_RADIUS_M rather than requiring a backfill on every existing row.
//
// Reuses the exact haversine implementation already shipped for travel POI
// dedup (lib/poiDedup.js) instead of a second copy.

const { haversineDistanceMeters } = require("./poiDedup");

const DEFAULT_RADIUS_M = 150;
// Was 100m — raised to 500m after confirming (via a real Chrome DevTools
// payload capture) that ordinary laptop/WiFi-based geolocation routinely
// reports ±500m accuracy, nowhere near 100m-GPS-grade. At 100m, staff
// checking in from a desktop at their own clinic could get blocked by their
// own device's positioning method, not by actually being far away. 500m
// still catches genuinely-unusable multi-km-off readings while letting
// normal desktop/laptop check-ins reach the real distance/radius check below.
const ACCURACY_THRESHOLD_M = 500;

// Formats a meter distance for a user-facing message. Below 1km, whole
// meters ("340m"); at or above 1km, kilometers to 1 decimal ("1500.1km") —
// a 7-digit meter count (e.g. "1500143m") reads as noise, and testers hitting
// this from another city/country routinely produce distances in that range.
function formatDistanceM(meters) {
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)}km`;
  }
  return `${Math.round(meters)}m`;
}

/**
 * @param {{latitude:number, longitude:number, accuracy:number}} coords
 * @returns {{ok:boolean, code?:string, error?:string}}
 */
function checkAccuracy(coords) {
  const { latitude, longitude, accuracy } = coords || {};
  if (
    typeof latitude !== "number" || !Number.isFinite(latitude) ||
    typeof longitude !== "number" || !Number.isFinite(longitude)
  ) {
    return { ok: false, code: "LOCATION_REQUIRED", error: "Location coordinates are required to punch in/out at this clinic." };
  }
  if (typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy > ACCURACY_THRESHOLD_M) {
    return {
      ok: false,
      code: "ACCURACY_TOO_LOW",
      error: `We can't verify your location precisely enough to check in. Your device's location reading is only accurate to ±${formatDistanceM(accuracy)} — we need it accurate to within ${ACCURACY_THRESHOLD_M}m. Try moving outdoors or near a window, or use a phone with GPS enabled, then try again.`,
    };
  }
  return { ok: true };
}

/**
 * Resolve whether `coords` falls within radius of ANY of `locations`.
 * @param {{latitude:number, longitude:number}} coords
 * @param {Array<{id:number, name:string, latitude:number|null, longitude:number|null, geofenceRadiusM:number|null}>} locations
 * @returns {{ok:boolean, matchedLocationId?:number, code?:string, error?:string}}
 */
function checkWithinAnyRadius(coords, locations) {
  const usable = (locations || []).filter((l) => typeof l.latitude === "number" && typeof l.longitude === "number");
  if (usable.length === 0) {
    // Assigned to a Location, but that Location has no coordinates set —
    // can't enforce a check we have no reference point for. Fail open
    // (mirrors the "no assignment" case) rather than block every punch at
    // a mis-configured clinic.
    return { ok: true };
  }
  let nearest = null;
  for (const loc of usable) {
    const radius = typeof loc.geofenceRadiusM === "number" ? loc.geofenceRadiusM : DEFAULT_RADIUS_M;
    const distance = haversineDistanceMeters(coords.latitude, coords.longitude, loc.latitude, loc.longitude);
    if (distance <= radius) {
      return { ok: true, matchedLocationId: loc.id };
    }
    if (!nearest || distance < nearest.distance) nearest = { id: loc.id, name: loc.name, distance, radius };
  }
  // `radius` here is whatever's actually configured for the nearest clinic —
  // the admin's Location.geofenceRadiusM if they set one, otherwise
  // DEFAULT_RADIUS_M (150m). Never hardcode a number in this message; it
  // must always reflect the real per-location value from `nearest.radius`.
  return {
    ok: false,
    code: "OUTSIDE_RADIUS",
    error: nearest
      ? `You're too far from ${nearest.name} to check in. Check-in is only available within ${nearest.radius}m of your assigned location (you're currently ${formatDistanceM(nearest.distance)} away). Please move closer and try again.`
      : "You're too far from your assigned location to check in. Please move closer and try again.",
  };
}

/**
 * Full geofence decision for a punch attempt.
 *
 * @param {object} opts
 * @param {string} opts.vertical - req.travelTenant/tenant.vertical style value
 * @param {Array} opts.assignedLocations - Location rows the user is assigned to (already fetched)
 * @param {{latitude?:number, longitude?:number, accuracy?:number}} opts.coords - raw body input
 * @returns {{enforced:boolean, ok:boolean, code?:string, error?:string, matchedLocationId?:number}}
 */
function evaluatePunchGeofence({ vertical, assignedLocations, coords }) {
  if (vertical !== "wellness") {
    return { enforced: false, ok: true };
  }
  if (!assignedLocations || assignedLocations.length === 0) {
    return { enforced: false, ok: true };
  }

  const accCheck = checkAccuracy(coords || {});
  if (!accCheck.ok) {
    return { enforced: true, ok: false, code: accCheck.code, error: accCheck.error };
  }

  const radiusCheck = checkWithinAnyRadius(coords, assignedLocations);
  if (!radiusCheck.ok) {
    return { enforced: true, ok: false, code: radiusCheck.code, error: radiusCheck.error };
  }
  return { enforced: true, ok: true, matchedLocationId: radiusCheck.matchedLocationId };
}

module.exports = {
  DEFAULT_RADIUS_M,
  ACCURACY_THRESHOLD_M,
  checkAccuracy,
  checkWithinAnyRadius,
  evaluatePunchGeofence,
};
