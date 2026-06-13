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
    // G034 (FR-3.5.2) — resolver selects BOTH stateCode AND
    // billingStateCode in one round-trip so it can prefer the
    // billing-address state code when present.
    const prisma = makePrismaStub({ contactRow: { stateCode: 'IN-KA' } });
    await resolveStateCodes({ prisma, contactId: 77 });
    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { id: 77 },
      select: { stateCode: true, billingStateCode: true },
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

// === Edge / async-error coverage (+6 cases) ===
//
// Fills the SUT-contract gaps left by the original 17 cases:
//
//  18. resolveStateCodes() with NO arguments at all → uses `= {}` default
//      destructure (no prisma, no IDs, no overrides) → operator=IN-MH,
//      customer mirrors. Pins no-throw on missing args.
//  19. prisma.tenant.findUnique rejection → SUT has no try/catch, must
//      propagate. Pin via `await expect(...).rejects.toThrow()`.
//  20. prisma.contact.findUnique rejection → same propagation contract.
//      Operator side resolves first (Tenant ok), Contact side throws.
//  21. operatorOverride truthy + tenantId null → override wins, ZERO
//      Tenant lookup; Contact lookup STILL fires for the customer side.
//  22. customerOverride truthy + contactId null → override wins, ZERO
//      Contact lookup; Tenant lookup STILL fires for the operator side.
//  23. operatorOverride=0 (falsy) → defensive: `||` treats 0 as no override,
//      DB lookup fires. Pins the JSDoc's "truthy wins" wording at the
//      type-coercion edge.
describe('gstStateCodeResolver — edge / async-error', () => {
  test('no args at all (zero arguments) → does not throw, defaults both sides to IN-MH', async () => {
    // The SUT uses `= {}` default destructure on the params object,
    // so calling with NO args must still resolve cleanly. No prisma
    // is referenced because neither tenantId nor contactId is truthy.
    const result = await resolveStateCodes();
    expect(result).toEqual({ operatorStateCode: 'IN-MH', customerStateCode: 'IN-MH' });
  });

  test('prisma.tenant.findUnique rejection → propagates to caller', async () => {
    const prisma = {
      tenant: { findUnique: vi.fn().mockRejectedValue(new Error('DB down')) },
      contact: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      resolveStateCodes({ prisma, tenantId: 1, contactId: 5 })
    ).rejects.toThrow('DB down');
  });

  test('prisma.contact.findUnique rejection → propagates to caller', async () => {
    const prisma = {
      tenant: { findUnique: vi.fn().mockResolvedValue({ gstStateCode: 'IN-GJ' }) },
      contact: { findUnique: vi.fn().mockRejectedValue(new Error('contact lookup blew up')) },
    };
    await expect(
      resolveStateCodes({ prisma, tenantId: 1, contactId: 5 })
    ).rejects.toThrow('contact lookup blew up');
  });

  test('operatorOverride truthy + tenantId null → skips Tenant lookup but Contact lookup still fires', async () => {
    const prisma = makePrismaStub({ contactRow: { stateCode: 'IN-KA' } });
    const result = await resolveStateCodes({
      prisma,
      tenantId: null,
      contactId: 5,
      operatorOverride: 'IN-GJ',
    });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-KA' });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.contact.findUnique).toHaveBeenCalledTimes(1);
  });

  test('customerOverride truthy + contactId null → skips Contact lookup but Tenant lookup still fires', async () => {
    const prisma = makePrismaStub({ tenantRow: { gstStateCode: 'IN-GJ' } });
    const result = await resolveStateCodes({
      prisma,
      tenantId: 1,
      contactId: null,
      customerOverride: 'IN-KA',
    });
    expect(result).toEqual({ operatorStateCode: 'IN-GJ', customerStateCode: 'IN-KA' });
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });

  test('operatorOverride=0 (falsy) → `||` treats as no override, DB lookup fires', async () => {
    // Defensive pin: the JSDoc says "truthy wins", and the SUT uses `||`.
    // 0 is falsy in JS, so even though a caller passing 0 is nonsensical
    // (state codes are strings), the helper falls through to the DB row.
    const prisma = makePrismaStub({ tenantRow: { gstStateCode: 'IN-TN' } });
    const result = await resolveStateCodes({
      prisma,
      tenantId: 1,
      operatorOverride: 0,
    });
    expect(result.operatorStateCode).toBe('IN-TN');
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// G034 (PRD_TRAVEL_GST_COMPLIANCE FR-3.5.2) — billingStateCode preference
//
// Pins the new resolution chain on the customer side:
//   1. customerOverride          (highest — caller-supplied wins)
//   2. Contact.billingStateCode  (NEW — billing-address state for GST)
//   3. Contact.stateCode         (legacy residence state — fallback)
//   4. operator-mirror           (intra-state default when both NULL)
//
// All 4 cases are additive — pre-G034 Contact rows have
// billingStateCode=NULL so resolution falls through to stateCode and
// behaviour stays identical.
// ============================================================================
describe('gstStateCodeResolver — G034 billingStateCode preference', () => {
  test('billingStateCode populated → wins over stateCode', async () => {
    // Customer LIVES in IN-KA (residence) but BILLS to a corporate AP
    // desk in IN-MH. GST place-of-supply rules tax based on billing
    // address — so the resolver MUST return IN-MH (billing) not IN-KA.
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: { stateCode: 'IN-KA', billingStateCode: 'IN-MH' },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result.operatorStateCode).toBe('IN-GJ');
    expect(result.customerStateCode).toBe('IN-MH');
  });

  test('billingStateCode NULL + stateCode populated → falls back to stateCode (pre-G034 rows)', async () => {
    // Pre-G034 Contact rows leave billingStateCode=NULL. Resolver must
    // continue using stateCode so back-compat with the slice-3 contract
    // is preserved.
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: { stateCode: 'IN-KA', billingStateCode: null },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result.customerStateCode).toBe('IN-KA');
  });

  test('billingStateCode + stateCode BOTH NULL → mirrors operator (intra-state default)', async () => {
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: { stateCode: null, billingStateCode: null },
    });
    const result = await resolveStateCodes({ prisma, tenantId: 1, contactId: 5 });
    expect(result.customerStateCode).toBe('IN-GJ');
  });

  test('customerOverride wins over billingStateCode + stateCode both present', async () => {
    // override at the top of the chain — neither DB column matters.
    const prisma = makePrismaStub({
      tenantRow: { gstStateCode: 'IN-GJ' },
      contactRow: { stateCode: 'IN-KA', billingStateCode: 'IN-MH' },
    });
    const result = await resolveStateCodes({
      prisma,
      tenantId: 1,
      contactId: 5,
      customerOverride: 'IN-TN',
    });
    expect(result.customerStateCode).toBe('IN-TN');
    // DB lookup is skipped entirely when override wins.
    expect(prisma.contact.findUnique).not.toHaveBeenCalled();
  });
});
