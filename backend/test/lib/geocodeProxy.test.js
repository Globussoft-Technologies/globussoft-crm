// Unit tests for backend/lib/geocodeProxy.js — shared Photon-backed place
// search. WHY this exists: the travel itinerary editor and the wellness
// clinic geofence picker both need "type a place name, get coordinates", and
// the parsing/validation was previously inlined in routes/travel_pois.js
// where a non-travel vertical could not reach it without calling a
// /api/travel/* URL.
//
// Covers the three pure functions — buildDisplayName (the readable label the
// picker's suggestion list shows), parsePhotonResults (GeoJSON -> flat rows,
// including the [lng, lat] coordinate order that is trivially easy to invert),
// and normalizeBbox (the region filter, which must degrade to "no filter"
// rather than throw on junk input).
//
// The network path (geocoderFetch / forwardGeocode / reverseGeocode) is NOT
// exercised here — hitting photon.komoot.io would make the suite non-
// deterministic and dependent on a third party's uptime. What matters is that
// whatever Photon returns is parsed correctly, and that is all pure.
import { describe, it, expect } from 'vitest';
import {
  buildDisplayName,
  parsePhotonResults,
  normalizeBbox,
} from '../../lib/geocodeProxy';

// Real Photon payload for "Nexus Mall Koramangala Bengaluru", trimmed. Note
// it carries NO `city` — a mall in Indian OSM data routinely has only
// district + county, which is exactly why the city fallback chain exists.
const MALL_FEATURE = {
  geometry: { coordinates: [77.6113428, 12.9348254] },
  properties: {
    name: 'Nexus Koramangala',
    street: 'Hosur Road',
    district: 'Lakkasandra',
    county: 'Bangalore South',
    state: 'Karnataka',
    country: 'India',
    postcode: '560029',
  },
};

// Real Photon payload for "Apollo Hospital Bangalore" — this one DOES carry
// a `city`, which must win over county/district.
const HOSPITAL_FEATURE = {
  geometry: { coordinates: [77.5971952, 12.8970191] },
  properties: {
    housenumber: '154',
    name: 'Apollo Hospital',
    street: 'Bannerghatta Road',
    locality: 'Panduranga Nagar',
    district: 'Doresanipalya',
    city: 'Bangalore',
    county: 'Bangalore South',
    state: 'Karnataka',
    country: 'India',
    postcode: '560076',
  },
};

describe('buildDisplayName', () => {
  it('joins name, street and the admin hierarchy in place order', () => {
    expect(buildDisplayName(MALL_FEATURE.properties, 'fallback')).toBe(
      'Nexus Koramangala, Hosur Road, Lakkasandra, Bangalore South, Karnataka, India',
    );
  });

  it('prefixes the house number onto the street line', () => {
    expect(buildDisplayName(HOSPITAL_FEATURE.properties, 'fallback')).toContain(
      '154 Bannerghatta Road',
    );
  });

  it('de-duplicates repeated admin levels', () => {
    // A city feature commonly repeats its own name across name/city/county;
    // without de-duplication the label reads "Ranchi, Ranchi, Ranchi, ...".
    const label = buildDisplayName(
      { name: 'Ranchi', city: 'Ranchi', county: 'Ranchi', state: 'Jharkhand', country: 'India' },
      'fallback',
    );
    expect(label).toBe('Ranchi, Jharkhand, India');
  });

  it('is case-insensitive when de-duplicating', () => {
    const label = buildDisplayName({ name: 'RANCHI', city: 'Ranchi', country: 'India' }, 'x');
    expect(label).toBe('RANCHI, India');
  });

  it('falls back to the raw query when every component is missing', () => {
    expect(buildDisplayName({}, 'whatever they typed')).toBe('whatever they typed');
    expect(buildDisplayName(null, 'whatever they typed')).toBe('whatever they typed');
  });
});

describe('parsePhotonResults', () => {
  it('reads GeoJSON [lng, lat] into the right lat/lng fields', () => {
    // The single highest-value assertion in this file: Photon emits
    // [longitude, latitude], and silently inverting it would put every Indian
    // clinic in the Indian Ocean while still "working".
    const [row] = parsePhotonResults({ features: [MALL_FEATURE] }, 'q');
    expect(row.lat).toBeCloseTo(12.9348254, 6);
    expect(row.lng).toBeCloseTo(77.6113428, 6);
  });

  it('falls back county -> district for city when Photon omits it', () => {
    const [row] = parsePhotonResults({ features: [MALL_FEATURE] }, 'q');
    expect(row.city).toBe('Bangalore South');
    expect(row.district).toBe('Lakkasandra');
    expect(row.county).toBe('Bangalore South');
  });

  it('prefers an explicit city over county/district', () => {
    const [row] = parsePhotonResults({ features: [HOSPITAL_FEATURE] }, 'q');
    expect(row.city).toBe('Bangalore');
    expect(row.street).toBe('154 Bannerghatta Road');
    expect(row.postcode).toBe('560076');
  });

  it('drops features whose coordinates are missing or non-numeric', () => {
    const data = {
      features: [
        MALL_FEATURE,
        { geometry: {}, properties: { name: 'No coords' } },
        { geometry: { coordinates: ['x', 'y'] }, properties: { name: 'Junk coords' } },
        { properties: { name: 'No geometry at all' } },
      ],
    };
    const rows = parsePhotonResults(data, 'q');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Nexus Koramangala');
  });

  it('returns an empty array for an empty or malformed payload', () => {
    expect(parsePhotonResults({ features: [] }, 'q')).toEqual([]);
    expect(parsePhotonResults({}, 'q')).toEqual([]);
    expect(parsePhotonResults(null, 'q')).toEqual([]);
  });

  it('never emits null/undefined address components', () => {
    // The frontend spreads these straight onto form fields; an undefined
    // would render React's uncontrolled-input warning and blank the box.
    const [row] = parsePhotonResults(
      { features: [{ geometry: { coordinates: [1, 2] }, properties: {} }] },
      'q',
    );
    for (const key of ['name', 'street', 'city', 'district', 'county', 'state', 'country', 'postcode']) {
      expect(typeof row[key]).toBe('string');
    }
  });
});

describe('normalizeBbox', () => {
  it('accepts a well-formed minLon,minLat,maxLon,maxLat box', () => {
    expect(normalizeBbox('68.1,6.5,97.4,35.7')).toBe('68.1,6.5,97.4,35.7');
  });

  it('returns null (= search worldwide) rather than throwing on junk', () => {
    // A malformed bbox is always a caller bug, never the end user's intent —
    // degrading to an unfiltered search beats 500-ing their typeahead.
    expect(normalizeBbox('nonsense')).toBeNull();
    expect(normalizeBbox('1,2,3')).toBeNull();
    expect(normalizeBbox('1,2,3,4,5')).toBeNull();
    expect(normalizeBbox('')).toBeNull();
    expect(normalizeBbox(null)).toBeNull();
    expect(normalizeBbox(undefined)).toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    expect(normalizeBbox('-181,6.5,97.4,35.7')).toBeNull();
    expect(normalizeBbox('68.1,-91,97.4,35.7')).toBeNull();
    expect(normalizeBbox('68.1,6.5,181,35.7')).toBeNull();
    expect(normalizeBbox('68.1,6.5,97.4,91')).toBeNull();
  });

  it('rejects an inverted or degenerate box', () => {
    expect(normalizeBbox('97.4,35.7,68.1,6.5')).toBeNull();
    expect(normalizeBbox('68.1,6.5,68.1,35.7')).toBeNull();
    expect(normalizeBbox('68.1,6.5,97.4,6.5')).toBeNull();
  });
});
