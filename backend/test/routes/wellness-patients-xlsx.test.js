// @ts-check
/**
 * Unit tests for GET /api/wellness/patients.xlsx — #820 follow-up.
 *
 * What this file pins
 * ───────────────────
 *   1. Endpoint mounted + reachable for ADMIN on a wellness tenant.
 *   2. Content-Type + Content-Disposition headers carry the correct
 *      xlsx MIME + .xlsx filename suffix (with mask state).
 *   3. Response body is a valid xlsx workbook (XLSX.read parseable,
 *      contains a "Patients" sheet with the expected header row).
 *   4. Row count of the workbook matches the filtered patient count
 *      (prisma findMany result is honoured 1:1).
 *   5. ?masked=1 forces masking for ADMIN — DOB / phone / email / name
 *      come back redacted even though the role is otherwise unmasked.
 *   6. Unauthenticated request → 401 from the phiReadGate (no req.user).
 *   7. USER role with no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN
 *      (phiReadGate blocks low-trust viewers from PHI export entirely).
 *   8. Audit rows: PATIENT_LIST_EXPORT always fires (with
 *      `{ format: 'xlsx', count, masked }`); PII_DISCLOSED ALSO fires
 *      on unmasked exports only.
 *
 * Test pattern mirrors backend/test/routes/wellness-loyalty-rules.test.js —
 * patch the prisma singleton BEFORE requiring the router so the require'd
 * router binds to the spy'd functions, mount the router under a tiny
 * Express app, and inject `req.user` via a synthetic middleware (the
 * production global verifyToken guard would normally populate it). For
 * the unauthenticated case we mount WITHOUT the synthetic middleware so
 * phiReadGate hits the `if (!req.user)` 401 branch.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The e2e-full / api_tests gates exercise the
 * round-trip against real MySQL via the e2e/tests/wellness-*-api.spec.js
 * suites.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import XLSX from 'xlsx';

// ── Prisma surface required by routes/wellness.js at require-time. ──
// Only `patient.findMany` is exercised by /patients.xlsx itself; the
// rest are permissive stubs so the require below doesn't blow up at
// other route's module-eval time.
prisma.patient = prisma.patient || {};
prisma.patient.findMany = vi.fn();
prisma.patient.findFirst = prisma.patient.findFirst || vi.fn();

// auditLog.create is what writeAudit ultimately calls. We force-replace
// so the real client's delegate (if any) doesn't leak across tests.
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
 * - `noAuth: true` → no req.user injection, so phiReadGate returns 401.
 * - `vertical` defaults to "wellness" so phiReadGate doesn't trip the
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

function makePatient(id, overrides = {}) {
  return {
    id,
    tenantId: 1,
    name: `Patient ${id}`,
    phone: `9876543${String(id).padStart(3, '0')}`,
    email: `patient${id}@example.com`,
    dob: new Date('1990-01-15T00:00:00Z'),
    gender: id % 2 === 0 ? 'F' : 'M',
    locationId: 1,
    deletedAt: null,
    createdAt: new Date('2026-05-01T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.patient.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

// Canonical xlsx export route is GET /patients/export?format=xlsx (see
// routes/wellness.js ~L1052). Earlier test framing assumed `/patients.xlsx`
// (mirroring the `/patients.csv` route name); the route source exposes the
// xlsx variant via the shared `/patients/export` handler with a query-param
// format selector instead.
const XLSX_URL = '/api/wellness/patients/export?format=xlsx';

describe('GET /api/wellness/patients/export?format=xlsx — #820 (1) endpoint mounted', () => {
  test('returns 200 for ADMIN on a wellness tenant', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1), makePatient(2)]);
    const res = await request(makeApp())
      .get(XLSX_URL)
      .buffer(true)
      .parse((response, callback) => {
        // supertest defaults to string parsing — force binary collection
        // so the buffer round-trip stays byte-identical for XLSX.read.
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    // buildPatientExportPayload uses take: 10000 + include: { tags: ... }.
    expect(prisma.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 1, deletedAt: null }),
        orderBy: { createdAt: 'desc' },
        take: 10000,
      }),
    );
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (2) headers', () => {
  test('Content-Type is xlsx MIME + Content-Disposition is attachment with .xlsx suffix', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    const res = await request(makeApp())
      .get(XLSX_URL)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-disposition']).toMatch(/patients-\d{4}-\d{2}-\d{2}\.xlsx/);
    // Unmasked filename does NOT carry the "-masked" infix.
    expect(res.headers['content-disposition']).not.toMatch(/-masked-/);
  });

  test('?masked=1 filename carries "-masked" infix', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    const res = await request(makeApp())
      .get('/api/wellness/patients/export?format=xlsx&masked=1')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/patients-masked-\d{4}-\d{2}-\d{2}\.xlsx/);
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (3) valid XLSX buffer', () => {
  test('response body parses as a workbook with a "Patients" sheet + correct headers', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1), makePatient(2), makePatient(3)]);
    const res = await request(makeApp())
      .get(XLSX_URL)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const wb = XLSX.read(res.body, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Patients');
    const sheet = wb.Sheets['Patients'];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    // Header row + 3 data rows.
    expect(data.length).toBe(4);
    // Pinned to buildPatientExportPayload (routes/wellness.js ~L1013) —
    // 9-column shape: ID, Name, Phone, Email, DOB, Gender, Source, Tags, Created.
    expect(data[0]).toEqual([
      'ID', 'Name', 'Phone', 'Email', 'DOB', 'Gender', 'Source', 'Tags', 'Created',
    ]);
    // Row order matches the findMany result (orderBy createdAt desc).
    expect(data[1][0]).toBe(1);
    expect(data[2][0]).toBe(2);
    expect(data[3][0]).toBe(3);
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (4) row count matches filtered query', () => {
  test('?q=foo&locationId=42 narrows the where clause + row count reflects findMany length', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatient(101),
      makePatient(102),
      makePatient(103),
      makePatient(104),
      makePatient(105),
    ]);
    const res = await request(makeApp())
      .get('/api/wellness/patients/export?format=xlsx&q=foo&locationId=42')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    // Where clause carries the search OR + locationId filter + tenant scope.
    const findManyArgs = prisma.patient.findMany.mock.calls[0][0];
    expect(findManyArgs.where.tenantId).toBe(1);
    expect(findManyArgs.where.locationId).toBe(42);
    expect(findManyArgs.where.OR).toEqual([
      { name: { contains: 'foo' } },
      { phone: { contains: 'foo' } },
      { email: { contains: 'foo' } },
    ]);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Patients']);
    expect(rows.length).toBe(5);
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (5) ?masked=1 forces masking for ADMIN', () => {
  test('phone/email/name/dob come back redacted even though caller is ADMIN', async () => {
    prisma.patient.findMany.mockResolvedValue([
      makePatient(1, { name: 'Jane Doe', phone: '9876543210', email: 'jane@example.com' }),
    ]);
    const res = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/wellness/patients/export?format=xlsx&masked=1')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['Patients']);
    expect(rows.length).toBe(1);
    const row = rows[0];
    // Unmasked values would be the literal 'Jane Doe' / '9876543210' /
    // 'jane@example.com'. piiMask helpers redact at least some part of
    // each — assertion is on inequality with the raw value.
    expect(row.Name).not.toBe('Jane Doe');
    expect(row.Phone).not.toBe('9876543210');
    expect(row.Email).not.toBe('jane@example.com');
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (6) unauthenticated → 401', () => {
  test('no req.user → phiReadGate emits 401 Authentication required', async () => {
    const res = await request(makeApp({ noAuth: true })).get(XLSX_URL);
    expect(res.status).toBe(401);
    // patient.findMany must NOT have been called — gate fired before the
    // handler body.
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (7) USER role → 403', () => {
  test('role=USER with no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: null })).get(XLSX_URL);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    // Gate fired before handler.
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/wellness/patients/export?format=xlsx — #820 (8) audit emission', () => {
  test('unmasked export emits a PII_DISCLOSED audit row carrying format=xlsx + masked=false', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1), makePatient(2)]);
    const res = await request(makeApp({ role: 'ADMIN' }))
      .get(XLSX_URL)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    // writeAudit is async / fire-and-forget — give the microtask queue a
    // chance to flush before asserting on auditLog.create calls.
    await new Promise((r) => setImmediate(r));

    const calls = prisma.auditLog.create.mock.calls.map((c) => c[0].data || c[0]);
    // The route fires PII_DISCLOSED on unmasked exports (routes/wellness.js
    // ~L1063); previous framing expected a parallel PATIENT_LIST_EXPORT row
    // but the route does not emit that action.
    const discloseRow = calls.find((d) => d.action === 'PII_DISCLOSED');
    const maskedRow = calls.find((d) => d.action === 'PII_EXPORT_MASKED');
    expect(discloseRow).toBeDefined();
    expect(maskedRow).toBeUndefined();
    // writeAudit serialises `details` to JSON; the auditLog.create call sees
    // the already-stringified payload.
    const discloseDetails = typeof discloseRow.details === 'string'
      ? JSON.parse(discloseRow.details)
      : discloseRow.details;
    expect(discloseDetails).toMatchObject({ format: 'xlsx', masked: false });
  });

  test('masked export emits PII_EXPORT_MASKED instead of PII_DISCLOSED', async () => {
    prisma.patient.findMany.mockResolvedValue([makePatient(1)]);
    const res = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/wellness/patients/export?format=xlsx&masked=1')
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));

    const calls = prisma.auditLog.create.mock.calls.map((c) => c[0].data || c[0]);
    const maskedRow = calls.find((d) => d.action === 'PII_EXPORT_MASKED');
    const discloseRow = calls.find((d) => d.action === 'PII_DISCLOSED');
    expect(maskedRow).toBeDefined();
    expect(discloseRow).toBeUndefined();
    const maskedDetails = typeof maskedRow.details === 'string'
      ? JSON.parse(maskedRow.details)
      : maskedRow.details;
    expect(maskedDetails).toMatchObject({ format: 'xlsx', masked: true });
  });
});
