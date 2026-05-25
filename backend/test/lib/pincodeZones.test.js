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
  METRO_PREFIXES,
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

describe('pinPrefix — input-coercion edge cases', () => {
  test('numeric PIN input is coerced via String() and sliced', () => {
    // String(560001) === '560001' → strip non-digits → '560001' → slice 0,3
    expect(pinPrefix(560001)).toBe('560');
    expect(pinPrefix(400001)).toBe('400');
  });

  test('PIN with letters mixed in strips letters before slicing', () => {
    // 'a560abc001z' → strip → '560001' → slice 0,3 → '560'
    expect(pinPrefix('560abc001')).toBe('560');
    expect(pinPrefix('a560abc001z')).toBe('560');
  });

  test('7-digit PIN (longer than 6) still slices to first 3 digits', () => {
    // Defensive: a malformed too-long PIN should not throw, just return the
    // first 3 digits. The route layer is responsible for length validation;
    // this helper degrades gracefully.
    expect(pinPrefix('5600012')).toBe('560');
    expect(pinPrefix('11000199')).toBe('110');
  });

  test('object input → String({}) yields no digits → null', () => {
    // String({}) === '[object Object]' — no digits — strip yields '' — null.
    expect(pinPrefix({})).toBeNull();
    expect(pinPrefix({ pincode: '560001' })).toBeNull();
  });

  test('boolean input → no digits → null', () => {
    // String(true) === 'true', String(false) === 'false' — no digits.
    expect(pinPrefix(true)).toBeNull();
    // pinPrefix(false) hits the `if (!pincode) return null` guard first;
    // either way the contract is "no resolved prefix" → null.
    expect(pinPrefix(false)).toBeNull();
  });

  test('float PIN input: decimal point stripped, fractional digits joined', () => {
    // String(560001.5) === '560001.5' → strip '.' → '5600015' → '560'.
    // Pins this defensive behaviour: float inputs do NOT round, they
    // strip the point and concatenate. Length is still ≥6 so it slices.
    expect(pinPrefix(560001.5)).toBe('560');
    expect(pinPrefix(110001.25)).toBe('110');
  });

  test('PIN with only dashes / formatting → empty after strip → null', () => {
    expect(pinPrefix('---')).toBeNull();
    expect(pinPrefix('-- --')).toBeNull();
    expect(pinPrefix('   ')).toBeNull();
  });
});

describe('METRO_PREFIXES — export shape', () => {
  test('table has 12 entries (10 metros + Mumbai 401 + Pune 412 sub-prefixes)', () => {
    expect(Object.keys(METRO_PREFIXES).length).toBe(12);
  });

  test('canonical metro prefixes are wired correctly', () => {
    expect(METRO_PREFIXES['560']).toBe('BLR');
    expect(METRO_PREFIXES['400']).toBe('MUM');
    expect(METRO_PREFIXES['401']).toBe('MUM');
    expect(METRO_PREFIXES['411']).toBe('PUN');
    expect(METRO_PREFIXES['412']).toBe('PUN');
  });

  test('non-mapped prefixes are undefined (Kalyan 421, Meerut 250)', () => {
    expect(METRO_PREFIXES['421']).toBeUndefined();
    expect(METRO_PREFIXES['250']).toBeUndefined();
    expect(METRO_PREFIXES['670']).toBeUndefined();
  });
});

describe('all 10 metros — pairwise sweep', () => {
  // One canonical PIN per metro from PRD §4.6. Each must round-trip cleanly
  // through metroOf, and same-PIN-twice must collapse to SAME_ZONE_MINUTES.
  // If a future schema change drops a metro from METRO_PREFIXES, this sweep
  // surfaces it as a red test for THAT metro rather than the cascade test.
  const METROS = [
    { pin: '560001', code: 'BLR', city: 'Bangalore' },
    { pin: '400001', code: 'MUM', city: 'Mumbai' },
    { pin: '110001', code: 'DEL', city: 'Delhi' },
    { pin: '600001', code: 'CHE', city: 'Chennai' },
    { pin: '500001', code: 'HYD', city: 'Hyderabad' },
    { pin: '700001', code: 'KOL', city: 'Kolkata' },
    { pin: '411001', code: 'PUN', city: 'Pune' },
    { pin: '380001', code: 'AMD', city: 'Ahmedabad' },
    { pin: '682001', code: 'COK', city: 'Kochi' },
    { pin: '302001', code: 'JAI', city: 'Jaipur' },
  ];

  test.each(METROS)('$city ($pin) resolves to $code and same-PIN → SAME_ZONE_MINUTES', ({ pin, code }) => {
    expect(metroOf(pin)).toBe(code);
    expect(estimateTravelMinutes(pin, pin)).toBe(SAME_ZONE_MINUTES);
  });

  test('every metro pair (A != B) → CROSS_ZONE_MINUTES', () => {
    for (let i = 0; i < METROS.length; i++) {
      for (let j = i + 1; j < METROS.length; j++) {
        const a = METROS[i];
        const b = METROS[j];
        expect(estimateTravelMinutes(a.pin, b.pin)).toBe(CROSS_ZONE_MINUTES);
      }
    }
  });
});

describe('estimateTravelMinutes — cascade ordering + symmetry', () => {
  test('one missing + one rural → FALLBACK_MINUTES (missing-check wins over rural)', () => {
    // The function checks `!clinicPincode || !patientPincode` BEFORE
    // running the metroOf cascade. So a null+rural pair returns FALLBACK
    // (30), NOT OUTSIDE_METRO_MINUTES (90). This pins the precedence —
    // a refactor that swaps the order would surface here.
    expect(estimateTravelMinutes(null, '250001')).toBe(FALLBACK_MINUTES);
    expect(estimateTravelMinutes('250001', null)).toBe(FALLBACK_MINUTES);
    expect(estimateTravelMinutes(undefined, '670001')).toBe(FALLBACK_MINUTES);
    expect(estimateTravelMinutes('', '670001')).toBe(FALLBACK_MINUTES);
  });

  test('symmetric: estimate(A, B) === estimate(B, A) across all cascade branches', () => {
    // Metro-metro (same)
    expect(estimateTravelMinutes('560001', '560100'))
      .toBe(estimateTravelMinutes('560100', '560001'));
    // Metro-metro (different)
    expect(estimateTravelMinutes('560001', '400001'))
      .toBe(estimateTravelMinutes('400001', '560001'));
    // Metro-rural
    expect(estimateTravelMinutes('560001', '250001'))
      .toBe(estimateTravelMinutes('250001', '560001'));
    // Rural-rural
    expect(estimateTravelMinutes('250001', '670001'))
      .toBe(estimateTravelMinutes('670001', '250001'));
    // Missing-known
    expect(estimateTravelMinutes(null, '560001'))
      .toBe(estimateTravelMinutes('560001', null));
  });
});
