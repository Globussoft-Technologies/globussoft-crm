// @ts-check
/**
 * Unit tests for POST /api/wellness/patients/import — #820 (final piece).
 *
 * STATUS (2026-05-27): suite is `describe.skip`-ed.
 * The dedicated `POST /api/wellness/patients/import` endpoint with the
 * `{ summary, errors, createdIds }` envelope, EMPTY_CSV/TOO_MANY_ROWS/
 * INVALID_FILE_TYPE error codes, and PATIENT_BULK_IMPORT audit row this
 * suite pins does NOT exist in routes/wellness.js. The closest existing
 * import surface is the generic `POST /api/wellness/csv/:entity/import`
 * (routes/wellnessCsv.js ~L315) which is mounted on a different prefix
 * (`/api/wellness/csv`) and exposes a different response contract.
 * Running these specs against the wellness router would 404 on every
 * assertion. Leaving the test logic intact so when the dedicated route
 * ships under #820 the suite can be flipped back to `describe` with the
 * fixtures it already encodes.
 *
 * What this file pins (once the route ships)
 * ──────────────────────────────────────────
 *   1. Endpoint mounted + accepts multipart/form-data with field name
 *      `file`; returns 200 on a valid CSV.
 *   2. Unauthenticated request (no req.user) → 401 from phiWriteGate.
 *      Handler body never runs.
 *   3. role=USER with no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN.
 *      phiWriteGate must block low-trust viewers from PHI bulk-create.
 *   4. Valid CSV with 3 well-formed rows → 3 patients created
 *      (`summary.imported === 3`); `createdIds.length === 3`.
 *   5. CSV containing 1 row with INVALID_PHONE — that row in `errors[]`
 *      with the right errorCode; the other rows still get created.
 *   6. CSV with a row whose phone matches an existing patient → that row
 *      marked `DUPLICATE_PHONE`; `summary.duplicates` increments; no
 *      patient.create call fires for that row.
 *   7. Empty CSV (header only, no data rows) → 400 EMPTY_CSV.
 *   8. CSV with > MAX_IMPORT_ROWS rows → 400 TOO_MANY_ROWS.
 *   9. Non-CSV upload (.txt, wrong mimetype, no .csv suffix) → 400
 *      INVALID_FILE_TYPE.
 *  10. Mixed batch (5 valid + 2 invalid + 1 duplicate) → summary numbers
 *      match: totalRows=8, imported=5, duplicates=1, invalid=2.
 *  11. Audit row PATIENT_BULK_IMPORT emitted with the summary payload
 *      (`{ totalRows, imported, duplicates, invalid }`).
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The e2e-full / api_tests gates exercise the
 * round-trip against real MySQL via the e2e/tests/wellness-*-api.spec.js
 * suites; this file pins the per-row branching + envelope shape in
 * isolation.
 *
 * Pattern mirrors backend/test/routes/wellness-patients-xlsx.test.js +
 * backend/test/routes/wellness-patients-import-template.test.js — patch
 * the prisma singleton BEFORE requiring the router so the require'd router
 * binds to the spy'd delegates, mount under a tiny Express app, inject
 * `req.user` via a synthetic middleware (the production global verifyToken
 * guard would otherwise populate it).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellness.js at require-time. ──
// /patients/import touches patient.findFirst (dedup probe), patient.create
// (per-row insert), and location.findMany (cross-tenant locationId guard).
// Other delegates are permissive stubs so the require below doesn't blow
// up at unrelated handlers' module-eval time.
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.patient.create = vi.fn();
prisma.patient.findMany = prisma.patient.findMany || vi.fn();
prisma.location = prisma.location || {};
prisma.location.findMany = vi.fn();

// auditLog.create is what writeAudit ultimately calls. Force-replace so
// the real client's delegate doesn't leak across tests.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// Other delegates touched at module-eval time inside routes/wellness.js
// (defensive permissive stubs):
prisma.loyaltyConfig = prisma.loyaltyConfig || { findUnique: vi.fn(), upsert: vi.fn() };
prisma.loyaltyTransaction = prisma.loyaltyTransaction || {
  findFirst: vi.fn(), aggregate: vi.fn(), findMany: vi.fn(), create: vi.fn(),
};
prisma.referral = prisma.referral || { findMany: vi.fn(), count: vi.fn() };

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);
const wellnessRouter = requireCJS('../../routes/wellness');

/**
 * Mount the wellness router with an optional synthetic auth middleware.
 * - `noAuth: true` → no req.user injection, so phiWriteGate returns 401.
 * - `vertical` defaults to "wellness" so phiWriteGate doesn't trip the
 *   WELLNESS_TENANT_REQUIRED gate (which would otherwise round-trip
 *   through prisma.tenant.findUnique).
 */
function makeApp({
  tenantId = 1,
  userId = 7,
  role = 'ADMIN',
  wellnessRole = null,
  vertical = 'wellness',
  noAuth = false,
} = {}) {
  const app = express();
  app.use(express.json());
  if (!noAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role, wellnessRole, vertical };
      next();
    });
  }
  app.use('/api/wellness', wellnessRouter);
  return app;
}

const HEADER = 'name,phone,email,dob,gender,source,locationId,tags,notes';

/**
 * Build a CSV buffer from an array of row-strings. Header is prepended.
 * Lines joined with \r\n to match a typical Excel-on-Windows save.
 */
function csvBuffer(rows) {
  return Buffer.from([HEADER, ...rows].join('\r\n'), 'utf8');
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.patient.create.mockReset();
  prisma.location.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });

  // Default: no existing patient → no dedup hits. Tests can override.
  prisma.patient.findFirst.mockResolvedValue(null);
  // Default: each create returns a synthetic row whose id increments.
  let nextId = 1000;
  prisma.patient.create.mockImplementation(async ({ data }) => ({
    id: nextId++,
    ...data,
  }));
  // Default: tenant has one valid location (id=1). Tests can override.
  prisma.location.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
});

// ────────────────────────────────────────────────────────────────────
// S103 — CSV bulk-import accepts firstName + lastName columns.
//
// The CSV import path lives at POST /api/wellness/csv/customers/import
// (routes/wellnessCsv.js) and delegates the per-row parsing to
// backend/lib/csvEntities.js's `customers` entity. The actual surface
// extended for S103 is the `customers` entity's:
//   - headers     (CSV header acceptance — firstName + lastName slots)
//   - parseRow    (per-row validator + row-mapper to Prisma payload)
//   - serialize   (export cell ordering matches headers)
//   - sample      (downloadable template populates the new columns)
//
// These tests drive `getEntity('customers')` directly + also exercise
// the wellnessCsv.js `runImport` orchestrator end-to-end against
// mocked prisma delegates. The dedicated `POST /patients/import`
// endpoint the older describe.skip suites below pin does NOT exist —
// patients are imported through the entity-driven `csv/:entity/import`
// route, not a dedicated wellness.js handler.
//
// Pins:
//   1. CSV with firstName + lastName columns → both persisted on Patient.
//   2. CSV with only firstName populated → lastName null.
//   3. CSV with neither column (legacy 9-column header) → both null.
//   4. firstName length > 80 → row error reported, other rows still imported.
//   5. Empty-string firstName → null (don't persist blank-string columns).
//   6. CSV with `name` + `firstName` + `lastName` all populated → all
//      three persisted (canonical `name` co-exists with structured split).
//   7. Non-string firstName (object) → row error (per-row isolation).
// ────────────────────────────────────────────────────────────────────

import { getEntity } from '../../lib/csvEntities.js';

const { runImport } = requireCJS('../../routes/wellnessCsv');

describe('S103 customers entity — firstName + lastName header acceptance', () => {
  const customers = getEntity('customers');

  test('headers include firstName + lastName slots (slot 2 + 3 after name)', () => {
    expect(customers.headers).toContain('firstName');
    expect(customers.headers).toContain('lastName');
    // Position after `name` keeps the human-readable template order.
    expect(customers.headers.indexOf('firstName')).toBe(1);
    expect(customers.headers.indexOf('lastName')).toBe(2);
  });

  test('sample template populates firstName + lastName (downloadable template)', () => {
    expect(customers.sample.firstName).toBeTruthy();
    expect(customers.sample.lastName).toBeTruthy();
  });
});

describe('S103 customers.parseRow — firstName + lastName persistence', () => {
  const customers = getEntity('customers');

  test('both columns populated → both persisted on Prisma payload', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: 'Anita',
      lastName: 'Sharma',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe('Anita');
    expect(data.lastName).toBe('Sharma');
    // Canonical `name` still set (additive, not replacing).
    expect(data.name).toBe('Anita Sharma');
  });

  test('only firstName populated → lastName null', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Madonna',
      firstName: 'Madonna',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe('Madonna');
    expect(data.lastName).toBeNull();
  });

  test('only lastName populated → firstName null', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Khan',
      lastName: 'Khan',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBe('Khan');
  });

  test('legacy CSV (no firstName / lastName columns) → both null (backward compat)', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      phone: '+919876543210',
      email: 'anita@example.com',
      gender: 'F',
      dob: '1992-04-18',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBeNull();
  });

  test('empty-string firstName → null (don\'t persist blank columns)', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: '',
      lastName: '   ',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBeNull();
    expect(data.lastName).toBeNull();
  });

  test('firstName > 80 chars → row error with INVALID_NAME_FIELD-style column tag', async () => {
    const longName = 'A'.repeat(81);
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: longName,
      phone: '+919876543210',
    });
    expect(data).toBeNull();
    const err = errors.find((e) => e.column === 'firstName');
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/80/);
  });

  test('lastName > 80 chars → row error on the lastName column', async () => {
    const longName = 'B'.repeat(200);
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      lastName: longName,
      phone: '+919876543210',
    });
    expect(data).toBeNull();
    const err = errors.find((e) => e.column === 'lastName');
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/80/);
  });

  test('firstName at exactly 80 chars → accepted (boundary)', async () => {
    const exact = 'C'.repeat(80);
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: exact,
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe(exact);
  });

  test('non-string firstName (object) → row error', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: { hack: 'me' },
      phone: '+919876543210',
    });
    expect(data).toBeNull();
    const err = errors.find((e) => e.column === 'firstName');
    expect(err).toBeTruthy();
    expect(err.message).toMatch(/must be a string/);
  });

  test('firstName surrounded by whitespace → trimmed before persist', async () => {
    const { data, errors } = await customers.parseRow({
      name: 'Anita Sharma',
      firstName: '  Anita  ',
      lastName: '  Sharma  ',
      phone: '+919876543210',
    });
    expect(errors).toEqual([]);
    expect(data.firstName).toBe('Anita');
    expect(data.lastName).toBe('Sharma');
  });
});

describe('S103 runImport — mixed batch with per-row firstName/lastName isolation', () => {
  const customers = getEntity('customers');

  test('legacy 9-col CSV (no firstName/lastName) still imports unchanged', async () => {
    const legacyCsv = [
      'name,phone,email,gender,dob,source,bloodGroup,allergies,notes',
      'Anita Sharma,+919876543210,anita@example.com,F,1992-04-18,walk-in,O+,,',
    ].join('\r\n');
    const result = await runImport(
      customers,
      Buffer.from(legacyCsv, 'utf8'),
      1,
      { lookups: {}, req: { user: { tenantId: 1, userId: 7 } } },
      'csv',
    );
    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([]);
    // The persisted row should have firstName + lastName null.
    expect(prisma.patient.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBeNull();
    expect(createArg.data.lastName).toBeNull();
  });

  test('new 11-col CSV with firstName + lastName → both persisted', async () => {
    const newCsv = [
      'name,firstName,lastName,phone,email,gender,dob,source,bloodGroup,allergies,notes',
      'Anita Sharma,Anita,Sharma,+919876543210,anita@example.com,F,1992-04-18,walk-in,O+,,',
    ].join('\r\n');
    const result = await runImport(
      customers,
      Buffer.from(newCsv, 'utf8'),
      1,
      { lookups: {}, req: { user: { tenantId: 1, userId: 7 } } },
      'csv',
    );
    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([]);
    const createArg = prisma.patient.create.mock.calls[0][0];
    expect(createArg.data.firstName).toBe('Anita');
    expect(createArg.data.lastName).toBe('Sharma');
    expect(createArg.data.name).toBe('Anita Sharma');
  });

  test('mixed batch: oversized firstName on row 2 → row error, row 1 + 3 still imported', async () => {
    const long = 'X'.repeat(81);
    // Full 11-column header so the required-header check passes; only
    // row 2's firstName is malformed.
    const mixedCsv = [
      'name,firstName,lastName,phone,email,gender,dob,source,bloodGroup,allergies,notes',
      'Anita Sharma,Anita,Sharma,+919876543210,,,,,,,',
      `Bob Verma,${long},Verma,+919876543211,,,,,,,`,
      'Carol Singh,Carol,Singh,+919876543212,,,,,,,',
    ].join('\r\n');
    const result = await runImport(
      customers,
      Buffer.from(mixedCsv, 'utf8'),
      1,
      { lookups: {}, req: { user: { tenantId: 1, userId: 7 } } },
      'csv',
    );
    expect(result.inserted).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const rowErr = result.errors.find((e) => e.column === 'firstName');
    expect(rowErr).toBeTruthy();
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (1) endpoint mounted', () => {
  test('accepts multipart upload + returns 200 with envelope shape', async () => {
    const csv = csvBuffer(['Alice Test,+919876543210,,,,,,,']);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      summary: expect.objectContaining({
        totalRows: 1,
        imported: 1,
        duplicates: 0,
        invalid: 0,
      }),
      errors: [],
      createdIds: expect.arrayContaining([expect.any(Number)]),
    });
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (2) unauthenticated → 401', () => {
  test('no req.user → phiWriteGate emits 401, no creates fire', async () => {
    const csv = csvBuffer(['Alice Test,+919876543210,,,,,,,']);
    const res = await request(makeApp({ noAuth: true }))
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(401);
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (3) USER role → 403', () => {
  test('role=USER with no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const csv = csvBuffer(['Alice Test,+919876543210,,,,,,,']);
    const res = await request(makeApp({ role: 'USER', wellnessRole: null }))
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (4) all-valid CSV', () => {
  test('3 valid rows → 3 imports + 0 errors + createdIds.length=3', async () => {
    const csv = csvBuffer([
      'Alice Sharma,+919876543210,alice@example.com,1990-03-15,F,walk-in,1,VIP;new,Sample notes',
      'Bob Verma,+919876543211,bob@example.com,1985-07-22,M,referral,2,returning,',
      'Carol Singh,+919876543212,,1992-11-30,F,ad,,,',
    ]);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalRows: 3,
      imported: 3,
      duplicates: 0,
      invalid: 0,
    });
    expect(res.body.errors).toEqual([]);
    expect(res.body.createdIds.length).toBe(3);
    expect(prisma.patient.create).toHaveBeenCalledTimes(3);
    // tags split-on-`;` and persisted as JSON-stringified array.
    const firstCreate = prisma.patient.create.mock.calls[0][0].data;
    expect(JSON.parse(firstCreate.tags)).toEqual(['VIP', 'new']);
    // tenant scope honoured on every create.
    for (const call of prisma.patient.create.mock.calls) {
      expect(call[0].data.tenantId).toBe(1);
    }
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (5) one invalid phone', () => {
  test('invalid phone row marked invalid; sibling rows still create', async () => {
    const csv = csvBuffer([
      'Alice Sharma,+919876543210,,,,,,,',
      'Mallory Bad,abc123notaphone,,,,,,,',
      'Carol Singh,+919876543212,,,,,,,',
    ]);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalRows: 3,
      imported: 2,
      duplicates: 0,
      invalid: 1,
    });
    expect(res.body.errors.length).toBe(1);
    expect(res.body.errors[0]).toMatchObject({
      row: 3, // header + 2 rows above = row 3
      errorCode: 'INVALID_PHONE',
    });
    expect(prisma.patient.create).toHaveBeenCalledTimes(2);
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (6) duplicate phone', () => {
  test('row whose phone matches existing patient → DUPLICATE_PHONE, no create', async () => {
    // First row's findFirst returns an existing patient; second returns null.
    let callIdx = 0;
    prisma.patient.findFirst.mockImplementation(async () => {
      callIdx++;
      return callIdx === 1 ? { id: 555 } : null;
    });
    const csv = csvBuffer([
      'Alice Dup,+919876543210,,,,,,,',  // duplicate
      'Bob Fresh,+919876543211,,,,,,,', // ok
    ]);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalRows: 2,
      imported: 1,
      duplicates: 1,
      invalid: 0,
    });
    expect(res.body.errors[0]).toMatchObject({
      row: 2,
      errorCode: 'DUPLICATE_PHONE',
    });
    expect(prisma.patient.create).toHaveBeenCalledTimes(1);
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (7) empty CSV → 400', () => {
  test('header-only CSV → 400 EMPTY_CSV', async () => {
    const csv = Buffer.from(HEADER, 'utf8');
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'EMPTY_CSV' });
  });

  test('totally empty buffer → 400 EMPTY_CSV (defensive)', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', Buffer.from('', 'utf8'), 'patients.csv');
    // multer treats zero-byte uploads as "no file" — accept either error
    // envelope; both are correct rejections.
    expect(res.status).toBe(400);
    expect(['EMPTY_CSV', 'NO_FILE']).toContain(res.body.code);
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (8) too many rows → 400', () => {
  test('501 data rows → 400 TOO_MANY_ROWS', async () => {
    const rows = [];
    for (let i = 0; i < 501; i++) {
      rows.push(`Row ${i},+91987654${String(i).padStart(4, '0')},,,,,,,`);
    }
    const csv = csvBuffer(rows);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_ROWS' });
    // Guard fires BEFORE per-row work — no creates should have run.
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (9) non-CSV → 400', () => {
  test('upload with .txt suffix + text/plain mimetype → 400 INVALID_FILE_TYPE', async () => {
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', Buffer.from('not a csv', 'utf8'), {
        filename: 'rogue.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FILE_TYPE' });
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (10) mixed batch', () => {
  test('5 valid + 2 invalid + 1 duplicate → correct summary numbers', async () => {
    // Row 8 (last data row) is the dup; everything else healthy or invalid.
    let dupHit = false;
    prisma.patient.findFirst.mockImplementation(async ({ where }) => {
      if (where && where.normalizedPhone && where.normalizedPhone.endsWith('9999999000')) {
        if (!dupHit) {
          dupHit = true;
          return { id: 777 };
        }
      }
      return null;
    });
    const csv = csvBuffer([
      // 5 valid (rows 2-6)
      'V1 Sharma,+919876543210,,,,,,,',
      'V2 Verma,+919876543211,,,,,,,',
      'V3 Singh,+919876543212,,,,,,,',
      'V4 Patel,+919876543213,,,,,,,',
      'V5 Reddy,+919876543214,,,,,,,',
      // 2 invalid (row 7: missing name; row 8: bad phone)
      ',+919876543215,,,,,,,',
      'BadPhone,abc,,,,,,,',
      // 1 duplicate (row 9)
      'Dup User,+919999999000,,,,,,,',
    ]);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      totalRows: 8,
      imported: 5,
      duplicates: 1,
      invalid: 2,
    });
    expect(res.body.errors.length).toBe(3);
    const codes = res.body.errors.map((e) => e.errorCode).sort();
    expect(codes).toEqual(['DUPLICATE_PHONE', 'INVALID_PHONE', 'NAME_REQUIRED']);
    expect(prisma.patient.create).toHaveBeenCalledTimes(5);
  });
});

describe.skip('POST /api/wellness/patients/import — #820 (11) audit emission', () => {
  test('PATIENT_BULK_IMPORT audit row fired with summary payload', async () => {
    const csv = csvBuffer([
      'Alice Sharma,+919876543210,,,,,,,',
      'Bob Verma,+919876543211,,,,,,,',
    ]);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    // writeAudit is fire-and-forget — give the microtask queue a chance
    // to flush before asserting on auditLog.create calls.
    await new Promise((r) => setImmediate(r));

    const calls = prisma.auditLog.create.mock.calls.map((c) => c[0].data || c[0]);
    const importRow = calls.find((d) => d.action === 'PATIENT_BULK_IMPORT');
    expect(importRow).toBeDefined();
    // writeAudit serialises `details` to JSON; the auditLog.create call
    // sees the already-stringified `details`.
    const details = typeof importRow.details === 'string'
      ? JSON.parse(importRow.details)
      : importRow.details;
    expect(details).toMatchObject({
      totalRows: 2,
      imported: 2,
      duplicates: 0,
      invalid: 0,
    });
  });
});

describe.skip('POST /api/wellness/patients/import — #820 cross-tenant locationId guard', () => {
  test('row referencing a locationId NOT in this tenant → INVALID_LOCATION', async () => {
    // Operator's tenant has only location 1, 2 — row references 999.
    prisma.location.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const csv = csvBuffer(['Alice Test,+919876543210,,,,,999,,']);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalRows: 1, imported: 0, invalid: 1 });
    expect(res.body.errors[0]).toMatchObject({
      row: 2,
      errorCode: 'INVALID_LOCATION',
    });
    expect(prisma.patient.create).not.toHaveBeenCalled();
  });
});

describe.skip('POST /api/wellness/patients/import — #820 BOM-tolerant', () => {
  test('CSV with UTF-8 BOM at start parses cleanly', async () => {
    const csv = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]), // UTF-8 BOM
      Buffer.from([HEADER, 'Alice BOM,+919876543210,,,,,,,'].join('\r\n'), 'utf8'),
    ]);
    const res = await request(makeApp())
      .post('/api/wellness/patients/import')
      .attach('file', csv, 'patients.csv');
    expect(res.status).toBe(200);
    expect(res.body.summary.imported).toBe(1);
  });
});
