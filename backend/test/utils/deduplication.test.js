// Unit tests for backend/utils/deduplication.js. The SUT instantiates a
// PrismaClient at module load (`new PrismaClient()`), so we have to install
// a fake `@prisma/client` in Node's require cache BEFORE the SUT is loaded.
// `vi.mock('@prisma/client')` does NOT intercept CJS `require()` from a CJS
// SUT in vitest 4 — verified during test development. `vi.hoisted` runs
// before ESM-import hoisting, which gives us the right window to monkey
// patch `Module._cache`.
import { describe, test, expect, vi, beforeEach } from 'vitest';

const fakePrisma = vi.hoisted(() => {
  const fake = {
    contact: {
      findUnique: () => null,
      findMany: () => [],
    },
    marketplaceLead: {
      findUnique: () => null,
    },
  };
  // Stash on globalThis so the FakePrismaClient constructor can return the
  // same singleton we expose to the test body.
  globalThis.__dedupFakePrisma = fake;

  const Module = require('node:module');
  const requireFromCwd = Module.createRequire(process.cwd() + '/');
  const prismaClientPath = requireFromCwd.resolve('@prisma/client');
  class FakePrismaClient {
    constructor() {
      return globalThis.__dedupFakePrisma;
    }
  }
  Module._cache[prismaClientPath] = {
    id: prismaClientPath,
    filename: prismaClientPath,
    loaded: true,
    exports: { PrismaClient: FakePrismaClient },
    children: [],
    paths: [],
  };
  return fake;
});

import dedup from '../../utils/deduplication.js';
const { normalizePhone, toE164, findDuplicateContact, findDuplicateMarketplaceLead, computeDuplicateGroupKey } = dedup;

beforeEach(() => {
  // Reset to vi.fn() per test so we can assert call shapes.
  fakePrisma.contact.findUnique = vi.fn();
  fakePrisma.contact.findMany = vi.fn();
  fakePrisma.marketplaceLead.findUnique = vi.fn();
});

describe('deduplication — module shape', () => {
  test('exports the public surface', () => {
    expect(typeof normalizePhone).toBe('function');
    expect(typeof findDuplicateContact).toBe('function');
    expect(typeof findDuplicateMarketplaceLead).toBe('function');
    expect(typeof computeDuplicateGroupKey).toBe('function');
  });
});

// #592 — computeDuplicateGroupKey backs the dismiss-persistence story.
// Stable hash of the sorted contact-id list lets the dismiss survive across
// re-runs of the detector regardless of which row the detector picked as
// the primary on a given pass.
describe('deduplication — computeDuplicateGroupKey (#592)', () => {
  test('returns null on empty input', () => {
    expect(computeDuplicateGroupKey(null, [])).toBeNull();
    expect(computeDuplicateGroupKey(undefined, undefined)).toBeNull();
  });

  test('returns a 64-char hex (sha256) digest', () => {
    const k = computeDuplicateGroupKey(1, [2]);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is stable across primary/duplicate role swaps (sort-invariant)', () => {
    // Same group of contacts {1, 2, 3}; two different framings of who's
    // "primary" must hash to the same key.
    expect(computeDuplicateGroupKey(1, [2, 3])).toBe(computeDuplicateGroupKey(2, [1, 3]));
    expect(computeDuplicateGroupKey(1, [2, 3])).toBe(computeDuplicateGroupKey(3, [2, 1]));
  });

  test('different id sets produce different keys', () => {
    expect(computeDuplicateGroupKey(1, [2])).not.toBe(computeDuplicateGroupKey(1, [3]));
    expect(computeDuplicateGroupKey(1, [2, 3])).not.toBe(computeDuplicateGroupKey(1, [2]));
  });

  test('coerces string ids to numbers', () => {
    expect(computeDuplicateGroupKey('1', ['2'])).toBe(computeDuplicateGroupKey(1, [2]));
  });

  test('drops non-finite ids defensively', () => {
    expect(computeDuplicateGroupKey(1, [2, NaN, undefined, 'x'])).toBe(computeDuplicateGroupKey(1, [2]));
  });
});

describe('deduplication — normalizePhone', () => {
  test('returns null on null/undefined/empty', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  test('strips +, spaces, parens, dashes', () => {
    expect(normalizePhone('+91 (987) 654-3210')).toBe('919876543210');
  });

  test('prepends 91 to a 10-digit number', () => {
    expect(normalizePhone('9876543210')).toBe('919876543210');
  });

  test('leaves 12-digit number alone', () => {
    expect(normalizePhone('919876543210')).toBe('919876543210');
  });

  test('returns null when stripping leaves empty string', () => {
    expect(normalizePhone('---')).toBeNull();
    expect(normalizePhone('()')).toBeNull();
    expect(normalizePhone(' ')).toBeNull();
  });

  test('non-10-digit short numbers pass through as digits', () => {
    expect(normalizePhone('12345')).toBe('12345');
  });
});

// #595 — toE164 canonicalises the *display* phone form (with `+` prefix) for
// storage on Patient.phone and downstream auto-dialer / SMS / WhatsApp keys.
// Distinct from normalizePhone which returns the digits-only dedup key.
describe('deduplication — toE164 (#595)', () => {
  test('returns null on null/undefined/empty/non-string', () => {
    expect(toE164(null)).toBeNull();
    expect(toE164(undefined)).toBeNull();
    expect(toE164('')).toBeNull();
    expect(toE164('   ')).toBeNull();
    expect(toE164(9876543210)).toBeNull(); // numeric input rejected — caller must stringify
  });

  test('formats a 10-digit Indian mobile as +91XXXXXXXXXX', () => {
    expect(toE164('9876543210')).toBe('+919876543210');
    expect(toE164('6123456789')).toBe('+916123456789');
    expect(toE164('7000000000')).toBe('+917000000000');
    expect(toE164('8888888888')).toBe('+918888888888');
  });

  test('strips spaces / dashes / parens from a 10-digit input', () => {
    expect(toE164('98765 43210')).toBe('+919876543210');
    expect(toE164('98765-43210')).toBe('+919876543210');
    expect(toE164('(987) 654-3210')).toBe('+919876543210');
  });

  test('formats a 12-digit input starting with 91 + Indian mobile prefix', () => {
    expect(toE164('919876543210')).toBe('+919876543210');
    expect(toE164('91 98765 43210')).toBe('+919876543210');
  });

  test('rejects 10-digit numbers that do not start 6-9 (not a real Indian mobile)', () => {
    expect(toE164('1234567890')).toBeNull();
    expect(toE164('5876543210')).toBeNull();
  });

  test('rejects 12-digit 91-prefixed numbers whose mobile portion is invalid', () => {
    expect(toE164('911234567890')).toBeNull();
  });

  test('passes through an already-E.164 number unchanged (after stripping cosmetics)', () => {
    expect(toE164('+919876543210')).toBe('+919876543210');
    expect(toE164('+91 98765 43210')).toBe('+919876543210');
    expect(toE164('+1 (415) 555-1234')).toBe('+14155551234');
  });

  test('rejects too-short or too-long inputs', () => {
    expect(toE164('98765')).toBeNull();
    expect(toE164('1234567890123456')).toBeNull(); // 16 digits, over E.164 max
    expect(toE164('+1234567')).toBeNull();
  });
});

describe('deduplication — findDuplicateContact', () => {
  const rishu = {
    id: 1,
    name: 'Rishu Goyal',
    email: 'rishu@enhancedwellness.in',
    phone: '919876543210',
  };

  test('returns email match without ever touching phone path', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(rishu);
    const out = await findDuplicateContact('rishu@enhancedwellness.in', '9999999999');
    expect(out).toBe(rishu);
    expect(fakePrisma.contact.findUnique).toHaveBeenCalledWith({
      where: { email: 'rishu@enhancedwellness.in' },
    });
    expect(fakePrisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('skips email lookup when email is empty', async () => {
    fakePrisma.contact.findMany.mockResolvedValue([]);
    await findDuplicateContact('', '9876543210');
    expect(fakePrisma.contact.findUnique).not.toHaveBeenCalled();
    expect(fakePrisma.contact.findMany).toHaveBeenCalled();
  });

  test('falls through to phone match when email returns null', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.contact.findMany.mockResolvedValue([
      { id: 2, name: 'Other', phone: '+91 98765 43210' },
    ]);
    const out = await findDuplicateContact('rishu@x.in', '9876543210');
    expect(out).toEqual({ id: 2, name: 'Other', phone: '+91 98765 43210' });
    expect(fakePrisma.contact.findMany).toHaveBeenCalledWith({
      where: { phone: { not: null } },
    });
  });

  test('phone match normalises both sides before comparing', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.contact.findMany.mockResolvedValue([
      { id: 5, name: 'Stored Differently', phone: '+91-98765 43210' },
    ]);
    const out = await findDuplicateContact(null, '9876543210');
    expect(out).toEqual({ id: 5, name: 'Stored Differently', phone: '+91-98765 43210' });
  });

  test('returns null when no candidate phone matches', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.contact.findMany.mockResolvedValue([
      { id: 1, phone: '917777777777' },
      { id: 2, phone: '918888888888' },
    ]);
    const out = await findDuplicateContact(null, '9876543210');
    expect(out).toBeNull();
  });

  test('returns null when both email and phone are empty', async () => {
    const out = await findDuplicateContact('', '');
    expect(out).toBeNull();
    expect(fakePrisma.contact.findUnique).not.toHaveBeenCalled();
    expect(fakePrisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('returns null when both are null/undefined', async () => {
    const out = await findDuplicateContact(null, undefined);
    expect(out).toBeNull();
  });

  test('phone path is skipped if phone normalises to null', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(null);
    const out = await findDuplicateContact('miss@x.in', '---');
    expect(out).toBeNull();
    expect(fakePrisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('returns first matching candidate', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(null);
    const first = { id: 1, phone: '919876543210' };
    const second = { id: 2, phone: '919876543210' };
    fakePrisma.contact.findMany.mockResolvedValue([first, second]);
    const out = await findDuplicateContact(null, '9876543210');
    expect(out).toBe(first);
  });

  test('skips candidates whose phone normalises to null', async () => {
    fakePrisma.contact.findUnique.mockResolvedValue(null);
    fakePrisma.contact.findMany.mockResolvedValue([
      { id: 1, phone: '---' },
      { id: 2, phone: '919876543210' },
    ]);
    const out = await findDuplicateContact(null, '9876543210');
    expect(out.id).toBe(2);
  });
});

describe('deduplication — findDuplicateMarketplaceLead', () => {
  test('returns null when externalLeadId is empty', async () => {
    expect(await findDuplicateMarketplaceLead('indiamart', '')).toBeNull();
    expect(await findDuplicateMarketplaceLead('indiamart', null)).toBeNull();
    expect(await findDuplicateMarketplaceLead('indiamart', undefined)).toBeNull();
    expect(fakePrisma.marketplaceLead.findUnique).not.toHaveBeenCalled();
  });

  test('queries by composite unique key when id present', async () => {
    // #414 — composite unique is now (tenantId, provider, externalLeadId);
    // the Prisma generated finder name is `tenantId_provider_externalLeadId`.
    // Pre-fix this looked up by the legacy `provider_externalLeadId` alias
    // (which no longer exists in the generated client) → ran fine while the
    // schema still had the old 2-col constraint, threw "Argument `where`
    // ...needs at least one argument" once the constraint widened. The 500
    // surfaced on every marketplace webhook ingest until the helper was
    // realigned with the schema (commit fixing this same arc).
    const row = { id: 99, provider: 'indiamart', externalLeadId: 'EXT-42', tenantId: 1 };
    fakePrisma.marketplaceLead.findUnique.mockResolvedValue(row);
    const out = await findDuplicateMarketplaceLead('indiamart', 'EXT-42');
    expect(out).toBe(row);
    expect(fakePrisma.marketplaceLead.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_provider_externalLeadId: {
          tenantId: 1,
          provider: 'indiamart',
          externalLeadId: 'EXT-42',
        },
      },
    });
  });

  test('honors explicit tenantId when caller passes one (cross-tenant scope)', async () => {
    fakePrisma.marketplaceLead.findUnique.mockResolvedValue(null);
    await findDuplicateMarketplaceLead('indiamart', 'EXT-42', 5);
    const arg = fakePrisma.marketplaceLead.findUnique.mock.calls[0][0];
    expect(arg.where.tenantId_provider_externalLeadId.tenantId).toBe(5);
  });

  test('coerces numeric externalLeadId to string', async () => {
    fakePrisma.marketplaceLead.findUnique.mockResolvedValue(null);
    await findDuplicateMarketplaceLead('justdial', 12345);
    const arg = fakePrisma.marketplaceLead.findUnique.mock.calls[0][0];
    expect(arg.where.tenantId_provider_externalLeadId.externalLeadId).toBe('12345');
  });

  test('returns null when no row exists', async () => {
    fakePrisma.marketplaceLead.findUnique.mockResolvedValue(null);
    const out = await findDuplicateMarketplaceLead('tradeindia', 'X');
    expect(out).toBeNull();
  });

  test('propagates prisma errors as rejection', async () => {
    fakePrisma.marketplaceLead.findUnique.mockRejectedValue(new Error('DB down'));
    await expect(findDuplicateMarketplaceLead('indiamart', 'x')).rejects.toThrow('DB down');
  });
});
