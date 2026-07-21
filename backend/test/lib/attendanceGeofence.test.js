// Unit tests for backend/lib/attendanceGeofence.js — geo-tagged attendance
// (wellness vertical only). WHY this exists: clock-in/out needed a way to
// verify a staff member is actually near their clinic before accepting the
// punch, without breaking travel/generic tenants (which share the same
// route unmodified) or blocking wellness staff who haven't been assigned a
// Location yet.
//
// Covers: checkAccuracy (missing coords / low-accuracy rejection),
// checkWithinAnyRadius (single + multi-location "any" match, per-Location
// radius override, default radius fallback, unusable/no-coordinate
// Locations fail open), and the top-level evaluatePunchGeofence orchestrator
// (non-wellness bypass, no-assignment bypass, enforced accept/reject).
//
// Pure module — no prisma, no external SDK, no mocking needed. Reuses the
// real haversineDistanceMeters from lib/poiDedup.js (already covered by its
// own test file), so distances below are computed with real trigonometry,
// not stubbed.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RADIUS_M,
  ACCURACY_THRESHOLD_M,
  checkAccuracy,
  checkWithinAnyRadius,
  evaluatePunchGeofence,
} from '../../lib/attendanceGeofence';

// Ranchi clinic coordinates (arbitrary real-world point) as the reference.
const CLINIC = { id: 1, name: 'Ranchi Clinic', latitude: 23.3441, longitude: 85.3096, geofenceRadiusM: null };
// ~11m north of CLINIC (well within any reasonable radius).
const NEARBY = { latitude: 23.34420, longitude: 85.3096, accuracy: 20 };
// ~1.1km north of CLINIC (outside a 150m default radius).
const FAR = { latitude: 23.3541, longitude: 85.3096, accuracy: 20 };

describe('attendanceGeofence — module shape', () => {
  it('exports the expected constants + functions', () => {
    expect(DEFAULT_RADIUS_M).toBe(150);
    expect(ACCURACY_THRESHOLD_M).toBe(500);
    expect(typeof checkAccuracy).toBe('function');
    expect(typeof checkWithinAnyRadius).toBe('function');
    expect(typeof evaluatePunchGeofence).toBe('function');
  });
});

describe('checkAccuracy', () => {
  it('missing latitude/longitude → LOCATION_REQUIRED', () => {
    const out = checkAccuracy({});
    expect(out.ok).toBe(false);
    expect(out.code).toBe('LOCATION_REQUIRED');
  });

  it('non-finite latitude (NaN from a bad body) → LOCATION_REQUIRED', () => {
    const out = checkAccuracy({ latitude: NaN, longitude: 85.3 });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('LOCATION_REQUIRED');
  });

  it('accuracy worse than the 500m threshold → ACCURACY_TOO_LOW', () => {
    const out = checkAccuracy({ latitude: 23.34, longitude: 85.3, accuracy: 750 });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('ACCURACY_TOO_LOW');
    expect(out.error).toMatch(/750m/);
  });

  it('accuracy exactly at the threshold (500m) is accepted, not rejected', () => {
    const out = checkAccuracy({ latitude: 23.34, longitude: 85.3, accuracy: 500 });
    expect(out.ok).toBe(true);
  });

  it('typical laptop/WiFi-based accuracy (500m, matches a real Chrome DevTools capture) is accepted', () => {
    // Regression pin for the 100m -> 500m threshold change: ordinary
    // desktop/laptop geolocation (WiFi-based, not GPS) commonly reports
    // exactly this accuracy. Confirmed via a real browser payload capture
    // ({ latitude: 12.93282, longitude: 77.61566, accuracy: 500 }) that
    // used to be rejected under the old 100m threshold even for staff
    // checking in from their own desk.
    const out = checkAccuracy({ latitude: 12.93282, longitude: 77.61566, accuracy: 500 });
    expect(out.ok).toBe(true);
  });

  it('no accuracy field at all → accepted (browser may not report it)', () => {
    const out = checkAccuracy({ latitude: 23.34, longitude: 85.3 });
    expect(out.ok).toBe(true);
  });

  it('good accuracy (10m) → accepted', () => {
    const out = checkAccuracy({ latitude: 23.34, longitude: 85.3, accuracy: 10 });
    expect(out.ok).toBe(true);
  });
});

describe('checkWithinAnyRadius', () => {
  it('single Location, punch nearby → ok with matchedLocationId', () => {
    const out = checkWithinAnyRadius(NEARBY, [CLINIC]);
    expect(out.ok).toBe(true);
    expect(out.matchedLocationId).toBe(1);
  });

  it('single Location, punch far away (default 150m radius) → OUTSIDE_RADIUS', () => {
    const out = checkWithinAnyRadius(FAR, [CLINIC]);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('OUTSIDE_RADIUS');
    expect(out.error).toMatch(/Ranchi Clinic/);
  });

  it('Location.geofenceRadiusM overrides the 150m default (a large campus radius accepts a far punch)', () => {
    const bigCampus = { ...CLINIC, geofenceRadiusM: 2000 };
    const out = checkWithinAnyRadius(FAR, [bigCampus]);
    expect(out.ok).toBe(true);
  });

  it('Location.geofenceRadiusM can also be stricter than the default (a small radius rejects a punch the default would accept)', () => {
    const tinyRadius = { ...CLINIC, geofenceRadiusM: 5 };
    const out = checkWithinAnyRadius(NEARBY, [tinyRadius]);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('OUTSIDE_RADIUS');
  });

  it('multi-location: passes if within radius of ANY assigned clinic, even if far from another', () => {
    const otherFarClinic = { id: 2, name: 'Delhi Clinic', latitude: 28.6139, longitude: 77.2090, geofenceRadiusM: null };
    const out = checkWithinAnyRadius(NEARBY, [otherFarClinic, CLINIC]);
    expect(out.ok).toBe(true);
    expect(out.matchedLocationId).toBe(1);
  });

  it('multi-location: fails only if outside radius of EVERY assigned clinic', () => {
    const otherFarClinic = { id: 2, name: 'Delhi Clinic', latitude: 28.6139, longitude: 77.2090, geofenceRadiusM: null };
    const out = checkWithinAnyRadius(FAR, [otherFarClinic, CLINIC]);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('OUTSIDE_RADIUS');
  });

  it('assigned Location with no lat/lng set → fails open (ok:true), can\'t enforce with no reference point', () => {
    const misconfigured = { id: 3, name: 'New Clinic (no coords yet)', latitude: null, longitude: null, geofenceRadiusM: null };
    const out = checkWithinAnyRadius(NEARBY, [misconfigured]);
    expect(out.ok).toBe(true);
  });
});

describe('evaluatePunchGeofence — orchestrator', () => {
  it('non-wellness vertical (travel) → not enforced, regardless of coords or assignments', () => {
    const out = evaluatePunchGeofence({ vertical: 'travel', assignedLocations: [CLINIC], coords: {} });
    expect(out.enforced).toBe(false);
    expect(out.ok).toBe(true);
  });

  it('non-wellness vertical (generic) → not enforced', () => {
    const out = evaluatePunchGeofence({ vertical: 'generic', assignedLocations: [CLINIC], coords: FAR });
    expect(out.enforced).toBe(false);
    expect(out.ok).toBe(true);
  });

  it('wellness tenant, user with NO assigned Locations → not enforced (roll-out-friendly default)', () => {
    const out = evaluatePunchGeofence({ vertical: 'wellness', assignedLocations: [], coords: {} });
    expect(out.enforced).toBe(false);
    expect(out.ok).toBe(true);
  });

  it('wellness tenant, assigned + nearby + good accuracy → enforced + accepted', () => {
    const out = evaluatePunchGeofence({ vertical: 'wellness', assignedLocations: [CLINIC], coords: NEARBY });
    expect(out.enforced).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.matchedLocationId).toBe(1);
  });

  it('wellness tenant, assigned + missing coords → enforced + rejected LOCATION_REQUIRED (accuracy check runs before distance)', () => {
    const out = evaluatePunchGeofence({ vertical: 'wellness', assignedLocations: [CLINIC], coords: {} });
    expect(out.enforced).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('LOCATION_REQUIRED');
  });

  it('wellness tenant, assigned + fuzzy GPS reading → enforced + rejected ACCURACY_TOO_LOW BEFORE the distance check runs', () => {
    // FAR coords would also fail on distance, but accuracy is checked first —
    // pin that a fuzzy-but-in-range reading still gets ACCURACY_TOO_LOW, not
    // OUTSIDE_RADIUS, so the user gets the right actionable message. Uses
    // 5000m (well above the 500m threshold) rather than exactly 500m, since
    // 500m is now the accepted boundary, not a rejected value.
    const out = evaluatePunchGeofence({
      vertical: 'wellness',
      assignedLocations: [CLINIC],
      coords: { latitude: NEARBY.latitude, longitude: NEARBY.longitude, accuracy: 5000 },
    });
    expect(out.enforced).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('ACCURACY_TOO_LOW');
  });

  it('wellness tenant, assigned + good accuracy + too far → enforced + rejected OUTSIDE_RADIUS', () => {
    const out = evaluatePunchGeofence({ vertical: 'wellness', assignedLocations: [CLINIC], coords: FAR });
    expect(out.enforced).toBe(true);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('OUTSIDE_RADIUS');
  });
});
