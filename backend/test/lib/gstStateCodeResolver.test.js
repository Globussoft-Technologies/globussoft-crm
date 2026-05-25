// Unit tests for backend/lib/gstStateCodeResolver.js
//
// Slice 3 of the #902 GST & Compliance arc (PRD:
// docs/PRD_TRAVEL_GST_COMPLIANCE.md). Pins the resolution chain:
//
//   override → DB column (Tenant.gstStateCode / Contact.stateCode) →
//   hard-coded "IN-MH" default (operator) / operator-mirror (customer).
//
// === Stub pattern ===
//
// The helper takes `prisma` as an explicit argument (vs importing the
// shared singleton), so tests pass a hand-built object with vi.fn()
// implementations of .tenant.findUnique + .contact.findUnique. This
// dodges the CJS-require-vi.mock interop quirk that other lib tests
// have to work around with singleton-patching (see leadJunkFilter.test
// + bookingAvailability.test). Cleaner test surface; the production
// route in slice 4 will pass the real require('./prisma') client.
//
// === Coverage map (15 cases) ===
//
//   1. Both overrides supplied → uses overrides, zero DB calls
//   2. No overrides, both DB columns populated → returns DB values
//   3. No Tenant.gstStateCode → operator falls back to "IN-MH" default
//   4. No Contact.stateCode → customer mirrors operator (intra-state)
//   5. Operator override + Contact.stateCode populated → uses override +
//      Contact value (skips Tenant lookup entirely)
//   6. No contactId supplied → customer mirrors operator
//   7. No tenantId supplied → operator defaults to "IN-MH"
//   8. Contact lookup returns null (contact not found) → customer mirrors operator
//   9. Tenant lookup returns null (tenant not found) → operator defaults to "IN-MH"
//  10. Empty-string overrides → treated as no override (DB lookups fire)
//  11. Both DB columns set → returns DB values, no defaults applied
//  12. prisma.tenant.findUnique called with the correct select shape
//  13. prisma.contact.findUnique called with the correct select shape
//  14. Zero DB calls when both overrides cover both sides
//  15. Format-agnosticism — helper returns whatever the DB has (no
//      normalisation, no validation)

import { describe, test, expect, vi, beforeEach } from 'vitest';
const { resolveStateCodes, DEFAULT_OPERATOR_STATE } = require('../../lib/gstStateCodeResolver');

function makePrismaStub({ tenantRow = null, contactRow = null } = {}) {
  return {
    tenant: {
      findUnique: vi.fn().mockResolvedValue(tenantRow),
    },
    contact: {
      findUnique: vi.fn().mockResolvedValue(contactRow),
    },
  };
}

describe('gstStateCodeResolver — module shape', () => {
  test('exports resolveStateCodes function', () => {
    expect(typeof resolveStateCodes).toBe('function');
  });

  test('exports DEFAULT_OPERATOR_STATE constant pinned to "IN-MH"', () => {
    expect(DEFAULT_OPERATOR_STATE).toBe('IN-MH');
  });
});

describe('gstStateCodeResolver — override paths', () => {
  let prisma;

  beforeEach(() => {
    prisma = makePrismaStub();
  });

  test('both overrides supplied → uses overrides, makes zero DB calls', async () => {
    const result = await resolveStateCodes({
      prisma,
      tenantId: 1,
      contactId: 5,
      operatorOverride: 'IN-GJ',
      customerOverride: 'IN-KA',
    });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-KA' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('operator override + no customer override + Contact.stateCode populated → uses override + Contact value, skips Tenant lookup', async () => {
    prisma = makePrismaStub({ contactRow: { stateCode: 'IN-KA' } });
    const result = await resolveStateCodes({
      prisma,
      tenantId: 1,
      contactId: 5,
      operatorOverride: 'IN-GJ',
    });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-KA' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findUnique).toHaveBeenCalledTimes(1);
  });

  test('empty-string overrides → treated as no override (DB lookups fire)', async () => {
    prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-MH' },
      contactRow: { stateCode: 'IN-KA' },
    });
    const result = await resolveStateCodes({
      prisma,
      tenantId: 1,
      contactId: 5,
      operatorOverride: '',
      customerOverride: '',
    });
    expect(result).toEqual({ operatorStateCode: 'IN-MH', customerStateCode: 'IN-KA' });
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('gstStateCodeResolver — DB lookup paths', () => {
  test('no overrides, both DB columns populated → returns DB values', async () => {
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: { stateCode: 'IN-TN' },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-TN' });
  });

  test('Tenant.gstStateCode null → operator falls back to "IN-MH" default', async () => {
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: null },
      contactRow: { stateCode: 'IN-KA' },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result).toEqual({ operatorStateCode: 'IN-MH', customerStateCode: 'IN-KA' });
  });

  test('Contact.stateCode null → customer mirrors operator (intra-state default)', async () => {
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: { stateCode: null },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-GJ' });
  });

  test('both DB columns set → returns DB values, no defaults applied', async () => {
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-UP' },
      contactRow: { stateCode: 'IN-DL' },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 7, contactId: 99 });
    expect(result.operatorStateCode).toBe('IN-UP');
    expect(result.customerStateCode).toBe('IN-DL');
  });
});

describe('gstStateCodeResolver — null / missing id paths', () => {
  test('no contactId supplied → customer mirrors operator (no Contact lookup)', async () => {
    const prisma = makePrismaStub({ tenantRow: { gstStateCode: 'IN-GJ' } });
    const result = await resolveStateCodes({ prisma, tenantId: 1 });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-GJ' });
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('no tenantId supplied → operator defaults to "IN-MH" (no Tenant lookup)', async () => {
    const prisma = makePrismaStub({ contactRow: { stateCode: 'IN-KA' } });
    const result = await resolveStateCodes({ prisma, contactId: 5 });
    expect(result).toEqual({ operatorStateCode: 'IN-MH', customerStateCode: 'IN-KA' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  test('Contact lookup returns null (contact not found) → customer mirrors operator', async () => {
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: null,
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 999 });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-GJ' });
  });

  test('Tenant lookup returns null (tenant not found) → operator defaults to "IN-MH"', async () => {
    const prisma = makePrismaStub({
      tenantRow: null,
      contactRow: { stateCode: 'IN-KA' },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 999, contactId: 5 });
    expect(result).toEqual({ operatorStateCode: 'IN-MH', customerStateCode: 'IN-KA' });
  });

  test('no args at all → operator defaults to "IN-MH", customer mirrors operator', async () => {
    const prisma = makePrismaStub();
    const result = await resolveStateCodes({ prisma });
    expect(result).toEqual({ operatorStateCode: 'IN-MH', customerStateCode: 'IN-MH' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });
});

describe('gstStateCodeResolver — prisma call shape', () => {
  test('prisma.tenant.findUnique called with correct where + select shape', async () => {
    const prisma = makePrismaStub({ tenantRow: { gstStateCode: 'IN-MH' } });
    await resolveStateCodes({ prisma, tenantId: 42 });
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { gstStateCode: true },
    });
  });

  test('prisma.contact.findUnique called with correct where + select shape', async () => {
    const prisma = makePrismaStub({ contactRow: { stateCode: 'IN-KA' } });
    await resolveStateCodes({ prisma, contactId: 77 });
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { stateCode: true },
    });
  });
});

describe('gstStateCodeResolver — format-agnosticism', () => {
  test('helper returns whatever the DB has (no normalisation)', async () => {
    // Intentionally unusual values — bare two-letter, lowercase, padded
    // strings — to pin that the helper is opaque about format.
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'MH' },
      contactRow: { stateCode: 'in-ka' },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result.operatorStateCode).toBe('MH');
    expect(result.customerStateCode).toBe('in-ka');
  });
});
