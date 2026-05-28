// Issue #816 — unit tests for backend/lib/csvEntities.js
//
// Drives each entity's parseRow() with a representative payload and pins:
//   - the validator surfaces the right column-level error message
//   - the happy-path returns the Prisma-ready `data` shape
//   - cross-entity helpers (parseBool / parseNumber / parseDateOnly) handle
//     edge cases (yes/no/1/0, comma-separated thousands, malformed dates).
//
// No prisma boot — when a parseRow needs lookup context (packages,
// bookings), we hand it a stub ctx.lookups so the FK-resolution branches
// are exercised in isolation.

import { describe, test, expect } from 'vitest';

const {
  getEntity,
  _internal,
} = require('../../lib/csvEntities');

const { parseBool, parseNumber, parseInteger, parseDateOnly } = _internal;

describe('parseBool', () => {
  test.each([
    ['true', true],
    ['false', false],
    ['YES', true],
    ['no', false],
    ['1', true],
    ['0', false],
    ['active', true],
    ['Inactive', false],
  ])('"%s" → %s', (input, expected) => {
    expect(parseBool(input)).toBe(expected);
  });

  test('empty string + null + undefined return null', () => {
    expect(parseBool('')).toBeNull();
    expect(parseBool(null)).toBeNull();
    expect(parseBool(undefined)).toBeNull();
  });

  test('unrecognised value returns undefined (signals error)', () => {
    expect(parseBool('maybe')).toBeUndefined();
  });
});

describe('parseNumber', () => {
  test('strips comma-thousands separators', () => {
    expect(parseNumber('1,200')).toBe(1200);
    expect(parseNumber('5,000,000')).toBe(5_000_000);
  });

  test('returns NaN for non-numeric strings', () => {
    expect(Number.isNaN(parseNumber('abc'))).toBe(true);
  });

  test('returns null for blank / null / undefined', () => {
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
});

describe('parseInteger', () => {
  test('rejects fractional values as NaN', () => {
    expect(Number.isNaN(parseInteger('1.5'))).toBe(true);
  });

  test('accepts integer strings', () => {
    expect(parseInteger('42')).toBe(42);
    expect(parseInteger('-7')).toBe(-7);
  });
});

describe('parseDateOnly', () => {
  test('accepts ISO YYYY-MM-DD', () => {
    const d = parseDateOnly('2026-05-18');
    expect(d).toBeInstanceOf(Date);
    expect(d.toISOString().slice(0, 10)).toBe('2026-05-18');
  });

  test('rejects MM/DD/YYYY shape', () => {
    expect(Number.isNaN(parseDateOnly('05/18/2026'))).toBe(true);
  });
});

// ── services entity ─────────────────────────────────────────────────

describe('services.parseRow', () => {
  const services = getEntity('services');

  test('happy path produces Prisma-ready data', async () => {
    const { data, errors } = await services.parseRow({
      name: 'Hydrafacial',
      category: 'aesthetics',
      ticketTier: 'medium',
      basePrice: '3500',
      durationMin: '60',
      marketingRadiusKm: '30',
      description: 'Three-step',
      active: 'true',
    });
    expect(errors).toEqual([]);
    expect(data).toMatchObject({
      name: 'Hydrafacial',
      category: 'aesthetics',
      ticketTier: 'medium',
      basePrice: 3500,
      durationMin: 60,
      targetRadiusKm: 30,
      isActive: true,
    });
  });

  test('missing name → name error', async () => {
    const { errors } = await services.parseRow({ name: '', basePrice: '100', active: 'true' });
    expect(errors.find((e) => e.column === 'name')).toBeTruthy();
  });

  test('basePrice ≤ 0 rejected', async () => {
    const { errors } = await services.parseRow({ name: 'X', basePrice: '0', active: 'true' });
    expect(errors.find((e) => e.column === 'basePrice')).toBeTruthy();
  });

  test('durationMin > 720 rejected', async () => {
    const { errors } = await services.parseRow({ name: 'X', basePrice: '100', durationMin: '999', active: 'true' });
    expect(errors.find((e) => e.column === 'durationMin')).toBeTruthy();
  });

  test('invalid ticketTier rejected', async () => {
    const { errors } = await services.parseRow({ name: 'X', basePrice: '100', ticketTier: 'platinum', active: 'true' });
    expect(errors.find((e) => e.column === 'ticketTier')).toBeTruthy();
  });

  test('unrecognised active value rejected', async () => {
    const { errors } = await services.parseRow({ name: 'X', basePrice: '100', active: 'maybe' });
    expect(errors.find((e) => e.column === 'active')).toBeTruthy();
  });

  test('default active=true when blank', async () => {
    const { data } = await services.parseRow({ name: 'X', basePrice: '100', active: '' });
    expect(data.isActive).toBe(true);
  });

  test('naturalKey is lower-cased name::category', () => {
    expect(services.naturalKey({ name: 'Foo Bar', category: 'aesthetics' })).toBe('foo bar::aesthetics');
  });
});

// ── products (drugs) entity ─────────────────────────────────────────

describe('products.parseRow', () => {
  const products = getEntity('products');

  test('happy path', async () => {
    const { data, errors } = await products.parseRow({
      name: 'Crocin',
      genericName: 'Acetaminophen',
      dosageForm: 'tablet',
      strengthValue: '500',
      strengthUnit: 'mg',
      defaultDosage: '1 tablet',
      defaultFrequency: 'twice daily',
      defaultDuration: '5 days',
      notes: '',
      active: 'yes',
    });
    expect(errors).toEqual([]);
    expect(data).toMatchObject({
      name: 'Crocin',
      genericName: 'Acetaminophen',
      dosageForm: 'tablet',
      strengthValue: '500',
      strengthUnit: 'mg',
      isActive: true,
    });
  });

  test('invalid dosageForm rejected', async () => {
    const { errors } = await products.parseRow({ name: 'X', dosageForm: 'liquid', active: 'true' });
    expect(errors.find((e) => e.column === 'dosageForm')).toBeTruthy();
  });

  test('missing name rejected', async () => {
    const { errors } = await products.parseRow({ name: '', dosageForm: 'tablet', active: 'true' });
    expect(errors.find((e) => e.column === 'name')).toBeTruthy();
  });

  test('naturalKey combines name + strength', () => {
    expect(
      products.naturalKey({ name: 'Crocin', strengthValue: '500', strengthUnit: 'mg' }),
    ).toBe('crocin::500::mg');
  });
});

// ── customers (patients) entity ─────────────────────────────────────

describe('customers.parseRow', () => {
  const customers = getEntity('customers');

  test('happy path normalises phone', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      phone: '+91 98765 43210',
      email: 'anita@example.com',
      gender: 'F',
      dob: '1992-04-18',
      source: 'walk-in',
    });
    expect(errors).toEqual([]);
    expect(data.normalizedPhone).toBe('9876543210');
    expect(data.dob).toBeInstanceOf(Date);
    expect(data.gender).toBe('F');
  });

  test('missing phone rejected', async () => {
    const { errors } = await customers.parseRow({ name: 'X', phone: '' });
    expect(errors.find((e) => e.column === 'phone')).toBeTruthy();
  });

  test('phone with letters rejected', async () => {
    const { errors } = await customers.parseRow({ name: 'X', phone: '90361a46074' });
    expect(errors.find((e) => e.column === 'phone')).toBeTruthy();
  });

  test('phone too short rejected', async () => {
    const { errors } = await customers.parseRow({ name: 'X', phone: '12345' });
    expect(errors.find((e) => e.column === 'phone')).toBeTruthy();
  });

  test('malformed email rejected', async () => {
    const { errors } = await customers.parseRow({ name: 'X', phone: '9876543210', email: 'not-an-email' });
    expect(errors.find((e) => e.column === 'email')).toBeTruthy();
  });

  test('invalid gender rejected', async () => {
    const { errors } = await customers.parseRow({ name: 'X', phone: '9876543210', gender: 'Q' });
    expect(errors.find((e) => e.column === 'gender')).toBeTruthy();
  });

  test('invalid dob shape rejected', async () => {
    const { errors } = await customers.parseRow({ name: 'X', phone: '9876543210', dob: '04/18/1992' });
    expect(errors.find((e) => e.column === 'dob')).toBeTruthy();
  });

  test('naturalKey uses normalisedPhone', () => {
    expect(customers.naturalKey({ normalizedPhone: '9876543210' })).toBe('phone::9876543210');
  });
});

// ── packages entity ─────────────────────────────────────────────────

describe('packages.parseRow', () => {
  const packages = getEntity('packages');

  const ctx = {
    lookups: {
      findService: (name) => (name === 'Hydrafacial' ? 7 : null),
      findDrug: () => null,
      findPatientByPhone: () => null,
      findStaff: () => null,
    },
  };

  test('happy path stamps entitlements with serviceId', async () => {
    const { data, errors } = await packages.parseRow({
      name: 'Gold Facial Pack',
      serviceName: 'Hydrafacial',
      sessions: '10',
      discountPct: '15',
      durationDays: '180',
      price: '30000',
      description: '',
      active: 'true',
    }, ctx);
    expect(errors).toEqual([]);
    const ents = JSON.parse(data.entitlements);
    expect(ents).toEqual([{ serviceId: 7, quantity: 10 }]);
    expect(data.price).toBe(30000);
    expect(data.durationDays).toBe(180);
  });

  test('unknown serviceName rejected', async () => {
    const { errors } = await packages.parseRow({
      name: 'X',
      serviceName: 'Imaginary Service',
      sessions: '5',
      durationDays: '30',
      price: '500',
      active: 'true',
    }, ctx);
    expect(errors.find((e) => e.column === 'serviceName')).toBeTruthy();
  });

  test('non-integer sessions rejected', async () => {
    const { errors } = await packages.parseRow({
      name: 'X',
      serviceName: 'Hydrafacial',
      sessions: '2.5',
      durationDays: '30',
      price: '500',
      active: 'true',
    }, ctx);
    expect(errors.find((e) => e.column === 'sessions')).toBeTruthy();
  });

  test('discountPct out of range rejected', async () => {
    const { errors } = await packages.parseRow({
      name: 'X',
      serviceName: 'Hydrafacial',
      sessions: '5',
      durationDays: '30',
      price: '500',
      discountPct: '150',
      active: 'true',
    }, ctx);
    expect(errors.find((e) => e.column === 'discountPct')).toBeTruthy();
  });
});

// ── bookings entity ─────────────────────────────────────────────────

describe('bookings.parseRow', () => {
  const bookings = getEntity('bookings');

  const ctx = {
    lookups: {
      findService: (name) => (name === 'Hydrafacial' ? 7 : null),
      findDrug: () => null,
      findPatientByPhone: (p) => (p && p.replace(/\D/g, '').slice(-10) === '9876543210' ? { id: 100 } : null),
      findStaff: (name) => (name === 'Dr Harsh' ? 12 : null),
    },
  };

  test('happy path completed visit', async () => {
    const { data, errors } = await bookings.parseRow({
      patientPhone: '+919876543210',
      serviceName: 'Hydrafacial',
      practitionerName: 'Dr Harsh',
      startDateTime: '2026-05-18T10:00:00+05:30',
      endDateTime: '',
      status: 'completed',
      amountCharged: '3500',
      notes: '',
    }, ctx);
    expect(errors).toEqual([]);
    expect(data).toMatchObject({
      patientId: 100,
      serviceId: 7,
      doctorId: 12,
      status: 'completed',
      amountCharged: 3500,
    });
    expect(data.visitDate).toBeInstanceOf(Date);
  });

  test('happy path booked visit (service + doctor optional)', async () => {
    const { errors } = await bookings.parseRow({
      patientPhone: '+919876543210',
      startDateTime: '2026-05-18T10:00:00+05:30',
      status: 'booked',
    }, ctx);
    expect(errors).toEqual([]);
  });

  test('completed visit without serviceName rejected', async () => {
    const { errors } = await bookings.parseRow({
      patientPhone: '+919876543210',
      practitionerName: 'Dr Harsh',
      startDateTime: '2026-05-18T10:00:00+05:30',
      status: 'completed',
    }, ctx);
    expect(errors.find((e) => e.column === 'serviceName')).toBeTruthy();
  });

  test('unknown patient phone rejected', async () => {
    const { errors } = await bookings.parseRow({
      patientPhone: '+911111111111',
      startDateTime: '2026-05-18T10:00:00+05:30',
      status: 'booked',
    }, ctx);
    expect(errors.find((e) => e.column === 'patientPhone')).toBeTruthy();
  });

  test('invalid status rejected', async () => {
    const { errors } = await bookings.parseRow({
      patientPhone: '+919876543210',
      startDateTime: '2026-05-18T10:00:00+05:30',
      status: 'rescheduled',
    }, ctx);
    expect(errors.find((e) => e.column === 'status')).toBeTruthy();
  });

  test('missing startDateTime rejected', async () => {
    const { errors } = await bookings.parseRow({
      patientPhone: '+919876543210',
      status: 'booked',
    }, ctx);
    expect(errors.find((e) => e.column === 'startDateTime')).toBeTruthy();
  });

  test('amount over cap rejected', async () => {
    const { errors } = await bookings.parseRow({
      patientPhone: '+919876543210',
      startDateTime: '2026-05-18T10:00:00+05:30',
      status: 'booked',
      amountCharged: '10000000',
    }, ctx);
    expect(errors.find((e) => e.column === 'amountCharged')).toBeTruthy();
  });

  test('bookings have no natural key (every row is an insert)', () => {
    expect(bookings.naturalKey({})).toBeNull();
  });
});

describe('getEntity', () => {
  test('returns null for unknown entity', () => {
    expect(getEntity('not-a-thing')).toBeNull();
  });

  test('all five registered entities resolve', () => {
    for (const name of ['services', 'packages', 'products', 'customers', 'bookings']) {
      const def = getEntity(name);
      expect(def).toBeTruthy();
      expect(Array.isArray(def.headers)).toBe(true);
      expect(def.headers.length).toBeGreaterThan(0);
      expect(typeof def.parseRow).toBe('function');
      expect(typeof def.serialize).toBe('function');
    }
  });
});
