// @ts-check
/**
 * backend/routes/travel_csv_io.js — CSV import/export contract pin.
 *
 * What's pinned
 * -------------
 * Eight mounted endpoints across four travel-vertical resources:
 *
 *   GET  /api/travel/cost-master/export.csv         verifyToken + requireTravelTenant
 *   POST /api/travel/cost-master/import.csv         ADMIN | MANAGER
 *   GET  /api/travel/diagnostic-banks/export.csv    verifyToken + requireTravelTenant
 *   POST /api/travel/diagnostic-banks/import.csv    ADMIN only
 *   GET  /api/travel/seasons/export.csv             verifyToken + requireTravelTenant
 *   POST /api/travel/seasons/import.csv             ADMIN | MANAGER
 *   GET  /api/travel/markup-rules/export.csv        verifyToken + requireTravelTenant
 *   POST /api/travel/markup-rules/import.csv        ADMIN | MANAGER
 *
 * Test surfaces (12+ cases minimum, drawn from the standing-rule contract list):
 *   - Happy export: 200, Content-Type text/csv, body is BOM-prefixed CSV with the
 *     expected header row + serialised data rows.
 *   - Happy import: row inserts vs. updates (idempotency key behaviour); returns
 *     { imported, updated, skipped, errors } envelope.
 *   - Auth gate: missing Authorization → 401.
 *   - Vertical gate: non-travel tenant → 403 WRONG_VERTICAL.
 *   - RBAC gate: USER hitting import → 403; MANAGER hitting diagnostic-banks
 *     import → 403 (ADMIN-only); MANAGER hitting cost-master import → 200 (allowed).
 *   - Validation: empty CSV → 400 EMPTY_CSV; no body at all → 400 NO_CSV; too many
 *     rows → 413 TOO_MANY_ROWS; invalid category query → 400 INVALID_CATEGORY.
 *   - Per-row error reporting: bad subBrand / missing fields / bad baseRate
 *     surfaced inside the errors[] array but the request itself returns 200 with
 *     summary counters.
 *   - Sub-brand isolation: USER with subBrandAccess=['rfu'] importing 'tmc' rows
 *     gets the rows rejected as `sub-brand access denied`; the export query
 *     narrows where.subBrand by the allowed set.
 *
 * Pattern mirrors travel-cost-master.test.js + travel-quotes-duplicate-pdf.test.js
 * (the bufferParser helper for binary-ish CSV bodies). Prisma singleton patched
 * BEFORE the router require so verifyToken's revokedToken probe + the route's
 * findFirst/create probes both land on the stubs. Audit-log create is mocked to a
 * pass-through resolve — the chained-hash compute in lib/audit.js still executes
 * (it's exception-safe and bounded; we just don't pin its details here, since
 * audit-chain.test.js owns that contract).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// Patch prisma BEFORE requiring the router.
prisma.travelCostMaster = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.travelDiagnosticQuestionBank = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.travelSeasonCalendar = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.travelMarkupRule = {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1,
  vertical: 'travel',
  name: 'Test Travel',
  slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
const csvIoRouter = requireCJS('../../routes/travel_csv_io');

function makeApp() {
  const app = express();
  // express.json + express.text are mounted INSIDE the router for text/csv;
  // we still need a default JSON parser for the multipart fallback path.
  app.use(express.json());
  app.use('/api/travel', csvIoRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// CSV downloads are text/csv but the BOM prefix and CRLF endings can be
// mangled by supertest's default string coercion; parsing as Buffer lets
// us assert the BOM byte (0xFEFF as the literal UTF-8 3-byte sequence
// EF BB BF) is present.
function bufferParser(r, cb) {
  const chunks = [];
  r.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeEach(() => {
  prisma.travelCostMaster.findMany.mockReset();
  prisma.travelCostMaster.findFirst.mockReset();
  prisma.travelCostMaster.create.mockReset();
  prisma.travelCostMaster.update.mockReset();
  prisma.travelDiagnosticQuestionBank.findMany.mockReset();
  prisma.travelDiagnosticQuestionBank.findFirst.mockReset();
  prisma.travelDiagnosticQuestionBank.create.mockReset();
  prisma.travelDiagnosticQuestionBank.update.mockReset();
  prisma.travelSeasonCalendar.findMany.mockReset();
  prisma.travelSeasonCalendar.findFirst.mockReset();
  prisma.travelSeasonCalendar.create.mockReset();
  prisma.travelSeasonCalendar.update.mockReset();
  prisma.travelMarkupRule.findMany.mockReset();
  prisma.travelMarkupRule.findFirst.mockReset();
  prisma.travelMarkupRule.create.mockReset();
  prisma.travelMarkupRule.update.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
});

// Build a valid diagnostic-bank questionsJson + scoringRulesJson pair. parseBank
// requires both to be valid JSON with non-empty questions[] + bands[].
function validBankJson() {
  return {
    questions: JSON.stringify({
      questions: [{ id: 'q1', text: 'Are you ready to travel?', weight: 1 }],
    }),
    rules: JSON.stringify({
      method: 'weighted-sum',
      bands: [{ label: 'low', min: 0, max: 5 }, { label: 'high', min: 6, max: 10 }],
    }),
  };
}

// --- cost-master export -----------------------------------------------------

describe('GET /api/travel/cost-master/export.csv', () => {
  test('happy export: 200 text/csv with BOM + header row + data row', async () => {
    prisma.travelCostMaster.findMany.mockResolvedValue([
      {
        id: 1, subBrand: 'tmc', category: 'hotel', routeOrSku: 'AGRA-DLX',
        supplierId: 12, baseRate: '4500.00', currency: 'INR', seasonId: null,
        attributesJson: null, validFrom: new Date('2026-06-01'),
        validTo: new Date('2026-12-31'), isActive: true,
      },
    ]);

    const res = await request(makeApp())
      .get('/api/travel/cost-master/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/travel-cost-master-export\.csv/);
    // UTF-8 BOM (EF BB BF) must be first 3 bytes — Excel-on-Windows needs it.
    expect(res.body.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const body = res.body.toString('utf8');
    expect(body).toMatch(/id,subBrand,category,routeOrSku/);
    expect(body).toMatch(/AGRA-DLX/);
    expect(body).toMatch(/2026-06-01/);
    expect(body).toMatch(/2026-12-31/);
    // The findMany query must be tenant-scoped.
    expect(prisma.travelCostMaster.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }),
    );
  });

  test('?category=cruise (not in VALID_CATEGORIES) returns 400 INVALID_CATEGORY', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/export.csv?category=cruise')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_CATEGORY' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('?subBrand=bogus returns 400 INVALID_SUB_BRAND', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/export.csv?subBrand=bogus')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SUB_BRAND' });
    expect(prisma.travelCostMaster.findMany).not.toHaveBeenCalled();
  });

  test('USER with subBrandAccess=["rfu"] narrows where.subBrand to the allowed set', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'USER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    prisma.travelCostMaster.findMany.mockResolvedValue([]);
    await request(makeApp())
      .get('/api/travel/cost-master/export.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .buffer(true)
      .parse(bufferParser);
    const calledWhere = prisma.travelCostMaster.findMany.mock.calls[0][0].where;
    expect(calledWhere.tenantId).toBe(1);
    // narrowWhereBySubBrand sets {in:[...]} when query.subBrand absent.
    expect(calledWhere.subBrand).toEqual({ in: expect.arrayContaining(['rfu']) });
  });
});

// --- cost-master import -----------------------------------------------------

describe('POST /api/travel/cost-master/import.csv', () => {
  test('happy import: text/csv body inserts new row and returns imported:1', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue(null);
    prisma.travelCostMaster.create.mockResolvedValue({ id: 42 });

    const csv = [
      'subBrand,category,routeOrSku,baseRate,currency',
      'tmc,hotel,AGRA-DLX,4500,INR',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    expect(res.body.errors).toEqual([]);
    expect(prisma.travelCostMaster.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1,
          subBrand: 'tmc',
          category: 'hotel',
          routeOrSku: 'AGRA-DLX',
          baseRate: 4500,
          currency: 'INR',
        }),
      }),
    );
  });

  test('existing row by (tenantId, subBrand, category, routeOrSku) is UPDATED not duplicated', async () => {
    prisma.travelCostMaster.findFirst.mockResolvedValue({
      id: 99, subBrand: 'tmc', category: 'hotel', routeOrSku: 'AGRA-DLX',
    });
    prisma.travelCostMaster.update.mockResolvedValue({ id: 99 });

    const csv = [
      'subBrand,category,routeOrSku,baseRate',
      'tmc,hotel,AGRA-DLX,5000',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, updated: 1, skipped: 0 });
    expect(prisma.travelCostMaster.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 99 } }),
    );
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('missing body returns 400 NO_CSV', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send('');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_CSV' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('header-only CSV returns 400 EMPTY_CSV', async () => {
    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send('subBrand,category,routeOrSku,baseRate');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_CSV' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('USER role is rejected with 403 (ADMIN+MANAGER gate)', async () => {
    const csv = 'subBrand,category,routeOrSku,baseRate\r\ntmc,hotel,AGRA-DLX,4500';
    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(403);
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('MANAGER role IS allowed for cost-master import (gate is ADMIN+MANAGER)', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    prisma.travelCostMaster.findFirst.mockResolvedValue(null);
    prisma.travelCostMaster.create.mockResolvedValue({ id: 50 });

    const csv = 'subBrand,category,routeOrSku,baseRate\r\nrfu,visa,IN-UAE,3000';
    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1 });
  });

  test('per-row validation: invalid category surfaces inside errors[] with rowNumber 2', async () => {
    const csv = [
      'subBrand,category,routeOrSku,baseRate',
      'tmc,cruise,X,1000', // cruise is NOT in VALID_CATEGORIES
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({
      rowNumber: 2,
      reason: expect.stringMatching(/invalid category/i),
    });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('per-row validation: negative baseRate goes into errors[] (NOT a 400 response)', async () => {
    const csv = [
      'subBrand,category,routeOrSku,baseRate',
      'tmc,hotel,X,-100',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.errors[0].reason).toMatch(/invalid baseRate/i);
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('sub-brand isolation: MANAGER with subBrandAccess=["rfu"] importing tmc row gets denied per-row', async () => {
    // MANAGER passes the RBAC gate (ADMIN+MANAGER); the per-row sub-brand
    // check then narrows access. ADMIN cannot be used here because
    // getSubBrandAccessSet short-circuits ADMINs to "full access" regardless
    // of their subBrandAccess column — so the gate to pin sub-brand isolation
    // for a write must use MANAGER (or USER, but USER fails the RBAC gate).
    prisma.user.findUnique.mockResolvedValue({
      role: 'MANAGER',
      subBrandAccess: JSON.stringify(['rfu']),
    });
    const csv = 'subBrand,category,routeOrSku,baseRate\r\ntmc,hotel,X,1000';
    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].reason).toMatch(/sub-brand access denied: tmc/);
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });
});

// --- diagnostic-banks import (ADMIN-only) -----------------------------------

describe('POST /api/travel/diagnostic-banks/import.csv', () => {
  test('MANAGER role is rejected with 403 — diagnostic banks are ADMIN-only', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
    const { questions, rules } = validBankJson();
    // The CSV is moot — we never get past the gate.
    const csv = `subBrand,version,questionsJson,scoringRulesJson\r\ntmc,1,"${questions.replace(/"/g, '""')}","${rules.replace(/"/g, '""')}"`;
    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks/import.csv')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(403);
    expect(prisma.travelDiagnosticQuestionBank.create).not.toHaveBeenCalled();
  });

  test('ADMIN happy path inserts new bank row, returns imported:1', async () => {
    prisma.travelDiagnosticQuestionBank.findFirst.mockResolvedValue(null);
    prisma.travelDiagnosticQuestionBank.create.mockResolvedValue({ id: 7 });
    const { questions, rules } = validBankJson();
    // Quote-escape the JSON cells per RFC4180 (internal " doubled).
    const csv = `subBrand,version,questionsJson,scoringRulesJson\r\ntmc,1,"${questions.replace(/"/g, '""')}","${rules.replace(/"/g, '""')}"`;

    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, updated: 0, skipped: 0 });
    expect(prisma.travelDiagnosticQuestionBank.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 1, subBrand: 'tmc', version: 1,
        }),
      }),
    );
  });

  test('non-JSON questionsJson surfaces per-row error (not a 400 on the request)', async () => {
    const csv = [
      'subBrand,version,questionsJson,scoringRulesJson',
      'tmc,1,"not-json","{}"',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/diagnostic-banks/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].reason).toMatch(/not valid JSON/);
    expect(prisma.travelDiagnosticQuestionBank.create).not.toHaveBeenCalled();
  });
});

// --- seasons export + markup-rules import (smoke-cover the remaining endpoints) ---

describe('GET /api/travel/seasons/export.csv', () => {
  test('happy export with date rendering: 200 text/csv body contains ISO date prefix', async () => {
    prisma.travelSeasonCalendar.findMany.mockResolvedValue([
      {
        id: 1, subBrand: 'rfu', seasonName: 'Ramadan 2026',
        startDate: new Date('2026-03-01'), endDate: new Date('2026-04-15'),
        multiplier: '1.50',
      },
    ]);
    const res = await request(makeApp())
      .get('/api/travel/seasons/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .buffer(true)
      .parse(bufferParser);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/travel-seasons-export\.csv/);
    const body = res.body.toString('utf8');
    expect(body).toMatch(/2026-03-01/);
    expect(body).toMatch(/2026-04-15/);
    expect(body).toMatch(/Ramadan 2026/);
  });
});

describe('POST /api/travel/markup-rules/import.csv', () => {
  test('exactly-one-of markupPct/markupFlat invariant enforced per-row', async () => {
    const csv = [
      'subBrand,scope,matchKeyJson,markupPct,markupFlat,priority',
      // Both set → error
      'tmc,hotel,"{""brand"":""x""}",10,500,1',
      // Neither set → error
      'tmc,hotel,"{""brand"":""y""}",,,2',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/markup-rules/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, updated: 0, skipped: 2 });
    expect(res.body.errors).toHaveLength(2);
    for (const e of res.body.errors) {
      expect(e.reason).toMatch(/exactly one of markupPct \/ markupFlat/);
    }
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('markup-rule with markupPct only is inserted; matchKeyJson is normalised', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue(null);
    prisma.travelMarkupRule.create.mockResolvedValue({ id: 11 });
    const csv = [
      'subBrand,scope,matchKeyJson,markupPct,priority',
      'tmc,hotel,"{ ""brand"": ""x"" }",12.5,10',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/markup-rules/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, skipped: 0 });
    const data = prisma.travelMarkupRule.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: 1, subBrand: 'tmc', scope: 'hotel',
      markupPct: 12.5, markupFlat: null, priority: 10,
    });
    // matchKeyJson is normalised — whitespace dropped via JSON.parse + JSON.stringify
    expect(data.matchKeyJson).toBe('{"brand":"x"}');
  });


  test('minPax is stored when valid positive integer is supplied', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue(null);
    prisma.travelMarkupRule.create.mockResolvedValue({ id: 12 });
    const csv = [
      'subBrand,scope,matchKeyJson,markupPct,minPax,priority',
      'tmc,hotel,"{}",10,50,5',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/markup-rules/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, skipped: 0 });
    const data = prisma.travelMarkupRule.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ minPax: 50 });
  });

  test('minPax omitted (column absent from CSV) → stored as null', async () => {
    prisma.travelMarkupRule.findFirst.mockResolvedValue(null);
    prisma.travelMarkupRule.create.mockResolvedValue({ id: 13 });
    // No minPax column at all
    const csv = [
      'subBrand,scope,matchKeyJson,markupPct,priority',
      'tmc,hotel,"{}",8,3',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/markup-rules/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, skipped: 0 });
    const data = prisma.travelMarkupRule.create.mock.calls[0][0].data;
    expect(data.minPax).toBeNull();
  });

  test('minPax=0 in CSV is rejected as invalid per-row (not a valid threshold)', async () => {
    const csv = [
      'subBrand,scope,matchKeyJson,markupPct,minPax,priority',
      'tmc,hotel,"{}",10,0,1',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/markup-rules/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, skipped: 1 });
    expect(res.body.errors[0].reason).toMatch(/invalid minPax/);
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });

  test('minPax=abc in CSV is rejected as non-integer', async () => {
    const csv = [
      'subBrand,scope,matchKeyJson,markupPct,minPax,priority',
      'tmc,hotel,"{}",10,abc,1',
    ].join('\r\n');

    const res = await request(makeApp())
      .post('/api/travel/markup-rules/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, skipped: 1 });
    expect(res.body.errors[0].reason).toMatch(/invalid minPax/);
    expect(prisma.travelMarkupRule.create).not.toHaveBeenCalled();
  });
});

// --- Auth + vertical gates --------------------------------------------------

describe('auth + vertical gates', () => {
  test('missing Authorization header on export returns 401', async () => {
    const res = await request(makeApp())
      .get('/api/travel/cost-master/export.csv');
    expect(res.status).toBe(401);
  });

  test('non-travel tenant returns 403 WRONG_VERTICAL on import', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic Co', slug: 'generic',
    });
    const csv = 'subBrand,category,routeOrSku,baseRate\r\ntmc,hotel,X,1000';
    const res = await request(makeApp())
      .post('/api/travel/cost-master/import.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .set('Content-Type', 'text/csv')
      .send(csv);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
    expect(prisma.travelCostMaster.create).not.toHaveBeenCalled();
  });

  test('wellness-vertical tenant blocked from diagnostic-banks export', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'wellness', name: 'Wellness Co', slug: 'wellness',
    });
    const res = await request(makeApp())
      .get('/api/travel/diagnostic-banks/export.csv')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WRONG_VERTICAL' });
  });
});
