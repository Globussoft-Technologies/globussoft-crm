// Unit tests for backend/lib/pincodeZones.js (Wave 8b residual).
//
// Pure helper — no DB, no fs. Tests pin the zone-mapping contract so a
// future "let's add a metro" change can't silently regress the existing
// metros' zone assignments.

import { describe, test, expect } from 'vitest';
import {
  estimateTravelMinutes,
  metroOf,
  pinPrefix,
  SAME_ZONE_MINUTES,
  CROSS_ZONE_MINUTES,
  OUTSIDE_METRO_MINUTES,
  FALLBACK_MINUTES,
} from '../../lib/pincodeZones.js';

describe('pinPrefix', () => {
  test('returns first 3 digits of a valid 6-digit PIN', () => {
    expect(pinPrefix('560001')).toBe('560');
    expect(pinPrefix('400050')).toBe('400');
  });
  test('handles leading-zero PINs (Delhi 110001)', () => {
    expect(pinPrefix('110001')).toBe('110');
  });
  test('strips non-digit characters before slicing', () => {
    expect(pinPrefix(' 560-001 ')).toBe('560');
  });
  test('returns null on missing or short input', () => {
    expect(pinPrefix(null)).toBeNull();
    expect(pinPrefix(undefined)).toBeNull();
    expect(pinPrefix('')).toBeNull();
    expect(pinPrefix('123')).toBeNull();
    expect(pinPrefix('12345')).toBeNull(); // 5 digits is not a valid PIN
  });
});

describe('metroOf', () => {
  test('Bangalore PINs resolve to BLR', () => {
    expect(metroOf('560001')).toBe('BLR');
    expect(metroOf('560100')).toBe('BLR');
  });
  test('Mumbai PINs resolve to MUM (both 400 and 401 prefixes)', () => {
    expect(metroOf('400001')).toBe('MUM');
    expect(metroOf('401501')).toBe('MUM');
  });
  test('Delhi PINs resolve to DEL', () => {
    expect(metroOf('110001')).toBe('DEL');
  });
  test('Pune PINs resolve to PUN (both 411 and 412)', () => {
    expect(metroOf('411001')).toBe('PUN');
    expect(metroOf('412105')).toBe('PUN');
  });
  test('Chennai/Hyderabad/Kolkata/Ahmedabad/Kochi/Jaipur all resolve', () => {
    expect(metroOf('600001')).toBe('CHE');
    expect(metroOf('500001')).toBe('HYD');
    expect(metroOf('700001')).toBe('KOL');
    expect(metroOf('380001')).toBe('AMD');
    expect(metroOf('682001')).toBe('COK');
    expect(metroOf('302001')).toBe('JAI');
  });
  test('non-metro / rural PIN → null', () => {
    expect(metroOf('250001')).toBeNull(); // Meerut
    expect(metroOf('670001')).toBeNull(); // Kannur
  });
  test('invalid input → null', () => {
    expect(metroOf(null)).toBeNull();
    expect(metroOf('')).toBeNull();
    expect(metroOf('abc')).toBeNull();
  });
});

describe('estimateTravelMinutes', () => {
  test('same zone (Bangalore → Bangalore) → SAME_ZONE_MINUTES', () => {
    expect(estimateTravelMinutes('560001', '560100')).toBe(SAME_ZONE_MINUTES);
    expect(SAME_ZONE_MINUTES).toBe(30);
  });

  test('cross-zone known metros (Bangalore → Mumbai) → CROSS_ZONE_MINUTES', () => {
    expect(estimateTravelMinutes('560001', '400001')).toBe(CROSS_ZONE_MINUTES);
    expect(CROSS_ZONE_MINUTES).toBe(60);
  });

  test('one side known, one side rural → OUTSIDE_METRO_MINUTES', () => {
    expect(estimateTravelMinutes('560001', '250001')).toBe(OUTSIDE_METRO_MINUTES);
    expect(estimateTravelMinutes('250001', '560001')).toBe(OUTSIDE_METRO_MINUTES);
    expect(OUTSIDE_METRO_MINUTES).toBe(90);
  });

  test('both sides rural → OUTSIDE_METRO_MINUTES', () => {
    expect(estimateTravelMinutes('250001', '670001')).toBe(OUTSIDE_METRO_MINUTES);
  });

  test('either side missing → FALLBACK_MINUTES (legacy behaviour)', () => {
    expect(estimateTravelMinutes(null, '560001')).toBe(FALLBACK_MINUTES);
    expect(estimateTravelMinutes('560001', null)).toBe(FALLBACK_MINUTES);
    expect(estimateTravelMinutes(null, null)).toBe(FALLBACK_MINUTES);
    expect(estimateTravelMinutes('', '')).toBe(FALLBACK_MINUTES);
    expect(FALLBACK_MINUTES).toBe(30);
  });

  test('Mumbai sub-zones (400 ↔ 401) treated as same metro → SAME_ZONE_MINUTES', () => {
    expect(estimateTravelMinutes('400001', '401501')).toBe(SAME_ZONE_MINUTES);
  });

  test('Pune sub-zones (411 ↔ 412) treated as same metro → SAME_ZONE_MINUTES', () => {
    expect(estimateTravelMinutes('411001', '412105')).toBe(SAME_ZONE_MINUTES);
  });

  test('handles whitespace and dashes in PIN inputs', () => {
    expect(estimateTravelMinutes(' 560-001 ', '560100')).toBe(SAME_ZONE_MINUTES);
  });
});

describe('contract (load-bearing constants)', () => {
  test('time bands are monotonic: SAME < CROSS < OUTSIDE', () => {
    expect(SAME_ZONE_MINUTES).toBeLessThan(CROSS_ZONE_MINUTES);
    expect(CROSS_ZONE_MINUTES).toBeLessThan(OUTSIDE_METRO_MINUTES);
  });

  test('FALLBACK matches the legacy DEFAULT_TRAVEL_TIME_MIN constant in routes/wellness.js', () => {
    // routes/wellness.js used a flat 30-min default before this helper landed.
    // Pinning the value here means a refactor that bumps FALLBACK_MINUTES
    // surfaces as a red unit test rather than a silent behaviour change in
    // every IN_HOME booking with a missing pincode.
    expect(FALLBACK_MINUTES).toBe(30);
  });
});
