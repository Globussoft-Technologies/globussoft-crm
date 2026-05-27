// backend/routes/marketing.js — buildContactWhere wellness-vertical extension.
//
// What's tested
//   - generic filters (status / source / aiScoreMin/Max / tags) keep working
//   - wellness keys (#598): treatmentOfInterest, preferredPractitionerId,
//     preferredLocationId, patientCategory new/active/churned all build the
//     correct Prisma `where` clause against Contact
//   - patientCategory windows resolve to the expected createdAt boundary
//     (within 30d / within 90d / older than 90d) — the "lastSeen" proxy
//     because Contact has no updatedAt column
//
// Why
//   Pre-#598 the Marketing audience filter accepted only generic CRM
//   keys. Wellness clinics need to segment by treatment / practitioner /
//   patient-category. The filter builder is the chokepoint that all four
//   call sites (POST /audience preview, GET /audience/count, POST /send,
//   cron campaignEngine) route through, so pinning its contract here
//   covers every audience-resolution path.

import { describe, test, expect } from 'vitest';

// The route module imports prisma + middleware that we don't need for the
// pure-function buildContactWhere. To avoid the module side-effect tax we
// stub require()s before the module loads.

// Setup module mocks before importing the SUT.
import { vi } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../middleware/auth', () => ({
  verifyToken: (req, res, next) => next(),
  verifyRole: () => (req, res, next) => next(),
}));
vi.mock('../../services/smsProvider', () => ({
  sendSms: vi.fn(),
}));
vi.mock('../../lib/leadSla', () => ({
  computeFirstResponseDueAt: () => null,
}));
vi.mock('../../lib/sanitizeJson', () => ({
  sanitizeText: (s) => s,
  sanitizeHtmlBody: (s) => s,
  sanitizeJsonForStringColumn: (s) => s,
}));

const marketing = require('../../routes/marketing.js');
const buildContactWhere = marketing.__buildContactWhere;

describe('buildContactWhere — generic filters (regression guard)', () => {
  test('empty filters yields tenant-scoped where', () => {
    const where = buildContactWhere(7, null);
    expect(where).toEqual({ tenantId: 7 });
  });

  test('status, source, aiScore range, tags all map through', () => {
    const where = buildContactWhere(7, {
      status: 'Lead',
      source: 'IndiaMART',
      aiScoreMin: 30,
      aiScoreMax: 80,
      tags: ['vip'],
    });
    expect(where.tenantId).toBe(7);
    expect(where.status).toBe('Lead');
    expect(where.source).toBe('IndiaMART');
    expect(where.aiScore).toEqual({ gte: 30, lte: 80 });
    expect(where.OR).toBeDefined();
  });
});

describe('buildContactWhere — wellness keys (#598)', () => {
  test('treatmentOfInterest is exact-matched on the Contact column', () => {
    const where = buildContactWhere(7, { treatmentOfInterest: 'IVF' });
    expect(where.treatmentOfInterest).toBe('IVF');
  });

  test('preferredPractitionerId is coerced to Number', () => {
    const where = buildContactWhere(7, { preferredPractitionerId: '42' });
    expect(where.preferredPractitionerId).toBe(42);
  });

  test('preferredLocationId is coerced to Number', () => {
    const where = buildContactWhere(7, { preferredLocationId: 5 });
    expect(where.preferredLocationId).toBe(5);
  });

  test('patientCategory=new resolves to last-30-days createdAt window', () => {
    const before = Date.now();
    const where = buildContactWhere(7, { patientCategory: 'new' });
    const after = Date.now();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    const cutoff = where.createdAt.gte.getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(cutoff).toBeGreaterThanOrEqual(before - 31 * day);
    expect(cutoff).toBeLessThanOrEqual(after - 29 * day);
  });

  test('patientCategory=active applies last-90-days + excludes Churned', () => {
    const where = buildContactWhere(7, { patientCategory: 'active' });
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.status).toEqual({ not: 'Churned' });
  });

  test('patientCategory=active does not override an explicit status filter', () => {
    const where = buildContactWhere(7, {
      patientCategory: 'active',
      status: 'Customer',
    });
    expect(where.status).toBe('Customer');
  });

  test('patientCategory=churned matches old createdAt OR explicit Churned status', () => {
    const where = buildContactWhere(7, { patientCategory: 'churned' });
    expect(where.OR).toBeDefined();
    const codes = JSON.stringify(where.OR);
    expect(codes).toContain('createdAt');
    expect(codes).toContain('Churned');
  });

  test('garbage patientCategory is ignored (no extra clause)', () => {
    const where = buildContactWhere(7, { patientCategory: 'unknown-bucket' });
    expect(where.tenantId).toBe(7);
    expect(where.createdAt).toBeUndefined();
    expect(where.status).toBeUndefined();
  });

  test('all wellness keys + generic keys compose AND-style', () => {
    const where = buildContactWhere(7, {
      status: 'Customer',
      treatmentOfInterest: 'Laser',
      preferredPractitionerId: 11,
      preferredLocationId: 3,
    });
    expect(where).toMatchObject({
      tenantId: 7,
      status: 'Customer',
      treatmentOfInterest: 'Laser',
      preferredPractitionerId: 11,
      preferredLocationId: 3,
    });
  });
});

describe('buildContactWhere — travel-vertical sub-brand audience scoping (#898)', () => {
  test('subBrand=tmc scopes audience to TMC contacts only', () => {
    const where = buildContactWhere(9, { subBrand: 'tmc' });
    expect(where).toEqual({ tenantId: 9, subBrand: 'tmc' });
  });

  test('subBrand=rfu composes with status filter', () => {
    const where = buildContactWhere(9, { subBrand: 'rfu', status: 'Lead' });
    expect(where).toMatchObject({ tenantId: 9, subBrand: 'rfu', status: 'Lead' });
  });

  test('empty subBrand string is treated as "all" — no where.subBrand clause', () => {
    const where = buildContactWhere(9, { subBrand: '', status: 'Customer' });
    expect(where.subBrand).toBeUndefined();
    expect(where.status).toBe('Customer');
  });

  test('subBrand coerces non-string values via String() — defends against numeric drift', () => {
    const where = buildContactWhere(9, { subBrand: 42 });
    expect(where.subBrand).toBe('42');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tick #N — +8 cases pinning the still-unpinned edges of buildContactWhere:
//   - aiScore half-open windows (min-only / max-only / falsy-zero floor)
//   - tags OR-array length + structure
//   - NaN coercion fallthrough for numeric-id filters
//   - patientCategory case-insensitivity + OR-merge with existing clauses
//   - filters=undefined returns the same shape as null (defensive)
// ─────────────────────────────────────────────────────────────────────────
describe('buildContactWhere — aiScore window edges', () => {
  test('aiScoreMin only yields { gte } and no lte (no Max passed)', () => {
    const where = buildContactWhere(7, { aiScoreMin: 50 });
    expect(where.aiScore).toEqual({ gte: 50 });
    expect(where.aiScore.lte).toBeUndefined();
  });

  test('aiScoreMax only yields { lte } and no gte (no Min passed)', () => {
    const where = buildContactWhere(7, { aiScoreMax: 80 });
    expect(where.aiScore).toEqual({ lte: 80 });
    expect(where.aiScore.gte).toBeUndefined();
  });

  test('aiScoreMin=0 (falsy-but-valid floor) still produces gte=0 — the != null guard catches this', () => {
    // Defends against a "if (filters.aiScoreMin)" regression that would
    // silently drop zero-floor filters because 0 is falsy in JS.
    const where = buildContactWhere(7, { aiScoreMin: 0 });
    expect(where.aiScore).toEqual({ gte: 0 });
  });
});

describe('buildContactWhere — tags OR-array structure', () => {
  test('single tag yields OR-array of length 1 with company + source sub-OR', () => {
    const where = buildContactWhere(7, { tags: ['vip'] });
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR.length).toBe(1);
    // Each tag entry is itself an OR over { company.contains } / { source.contains }.
    expect(where.OR[0].OR).toBeDefined();
    expect(where.OR[0].OR.length).toBe(2);
    const flat = JSON.stringify(where.OR[0].OR);
    expect(flat).toContain('vip');
    expect(flat).toContain('company');
    expect(flat).toContain('source');
  });

  test('multiple tags produce one OR-array entry per tag (preserves cardinality)', () => {
    const where = buildContactWhere(7, { tags: ['vip', 'partner', 'enterprise'] });
    expect(where.OR.length).toBe(3);
    const flat = JSON.stringify(where.OR);
    expect(flat).toContain('vip');
    expect(flat).toContain('partner');
    expect(flat).toContain('enterprise');
  });
});

describe('buildContactWhere — numeric-id NaN coercion guard', () => {
  test('preferredPractitionerId="abc" (NaN after Number()) is silently dropped — no clause emitted', () => {
    const where = buildContactWhere(7, { preferredPractitionerId: 'abc' });
    expect(where.preferredPractitionerId).toBeUndefined();
    expect(where.tenantId).toBe(7);
  });

  test('preferredLocationId="not-a-number" (NaN) is silently dropped — no clause emitted', () => {
    const where = buildContactWhere(7, { preferredLocationId: 'not-a-number' });
    expect(where.preferredLocationId).toBeUndefined();
    expect(where.tenantId).toBe(7);
  });
});

describe('buildContactWhere — patientCategory case + OR-merge edges', () => {
  test('patientCategory is normalized via toLowerCase — "NEW" === "new"', () => {
    // Defends against a "if (cat === 'new')" regression that would only
    // match the lowercase literal and silently no-op on UI-cased input.
    const where = buildContactWhere(7, { patientCategory: 'NEW' });
    expect(where.createdAt).toBeDefined();
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  test('patientCategory=churned + tags compose: the tags-OR entries survive the churned OR-spread', () => {
    // Implementation uses `...(where.OR || [])` so prior tag clauses
    // must not be clobbered when churned appends its createdAt/status entries.
    const where = buildContactWhere(7, { patientCategory: 'churned', tags: ['vip'] });
    expect(where.OR).toBeDefined();
    expect(where.OR.length).toBeGreaterThanOrEqual(3); // 1 tag entry + 2 churned entries
    const flat = JSON.stringify(where.OR);
    expect(flat).toContain('vip');       // tag survived
    expect(flat).toContain('createdAt'); // churned-old-row clause present
    expect(flat).toContain('Churned');   // churned-status clause present
  });
});

describe('buildContactWhere — defensive null/undefined input', () => {
  test('filters=undefined yields the same shape as filters=null (tenant-only where)', () => {
    const whereU = buildContactWhere(7, undefined);
    const whereN = buildContactWhere(7, null);
    expect(whereU).toEqual(whereN);
    expect(whereU).toEqual({ tenantId: 7 });
  });
});
