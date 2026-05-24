// @ts-check
/**
 * Unit tests for GET /api/wellness/patients/import-template.csv — #820.
 *
 * What this file pins
 * ───────────────────
 *   1. Endpoint mounted + reachable for ADMIN on a wellness tenant
 *      (returns 200, no prisma reads — this is a static template).
 *   2. Content-Type is `text/csv; charset=utf-8`; Content-Disposition is
 *      attachment with the canonical filename `patients-import-template.csv`.
 *   3. Body parses as a valid CSV with exactly 2 lines (header + one
 *      example row) — no trailing blank rows beyond the line terminator.
 *   4. Header row carries the full 9-column set:
 *      name, phone, email, dob, gender, source, locationId, tags, notes.
 *   5. Example row arity matches the header (9 cells), and the example
 *      values are the canonical sample (Anita Sharma + +91…).
 *   6. Unauthenticated request → 401 from the phiReadGate. The handler
 *      body never runs (no header / body emission).
 *
 * Test pattern mirrors backend/test/routes/wellness-patients-xlsx.test.js —
 * patch the prisma singleton BEFORE requiring the router so module-eval
 * doesn't blow up, mount the router under a tiny Express app, and inject
 * `req.user` via a synthetic middleware. For the unauthenticated case we
 * mount WITHOUT the synthetic middleware so phiReadGate hits its 401 branch.
 *
 * Why no audit assertion: the template endpoint emits ZERO PHI by design
 * (the example row is fictional sample data, no real patient touched),
 * so no audit row fires. Asserting "no audit row" would be over-specifying
 * — the absence is incidental to the no-prisma-touch design.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellness.js at require-time. ──
// The /import-template.csv handler itself touches NO prisma, but the
// router module-load evaluates many other handlers; permissive stubs
// keep require() happy.
prisma.patient = prisma.patient || {};
// Force-replace findMany with a spy so the "did NOT touch prisma" assertion
// in test (1) works — the live Prisma delegate is a plain function, not a
// vi spy, so `.toHaveBeenCalled` would throw on it.
prisma.patient.findMany = vi.fn();
prisma.patient.findFirst = prisma.patient.findFirst || vi.fn();
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };
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

/**
 * Tiny CSV line splitter that honours quoted fields with embedded commas
 * and escaped double-quotes (`""`). Sufficient for asserting on the
 * template emission shape; not a general-purpose RFC-4180 parser.
 */
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/** Strip leading UTF-8 BOM if present (the handler emits one for Excel). */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

beforeEach(() => {
  prisma.patient.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });
});

describe('GET /api/wellness/patients/import-template.csv — #820 (1) endpoint mounted', () => {
  test('returns 200 for ADMIN on a wellness tenant + does NOT touch prisma.patient.findMany', async () => {
    const res = await request(makeApp()).get(
      '/api/wellness/patients/import-template.csv',
    );
    expect(res.status).toBe(200);
    // Static template — no patient list read.
    expect(prisma.patient.findMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/wellness/patients/import-template.csv — #820 (2) headers', () => {
  test('Content-Type csv + Content-Disposition is attachment with canonical filename', async () => {
    const res = await request(makeApp()).get(
      '/api/wellness/patients/import-template.csv',
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8$/i);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="patients-import-template.csv"',
    );
  });
});

describe('GET /api/wellness/patients/import-template.csv — #820 (3) body shape', () => {
  test('body parses as a valid CSV with exactly 2 non-empty lines (header + example)', async () => {
    const res = await request(makeApp()).get(
      '/api/wellness/patients/import-template.csv',
    );
    expect(res.status).toBe(200);
    const body = stripBom(res.text);
    // Split on CRLF or LF; drop trailing empty token from terminal newline.
    const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
  });
});

describe('GET /api/wellness/patients/import-template.csv — #820 (4) header columns', () => {
  test('header row carries all 9 expected columns in canonical order', async () => {
    const res = await request(makeApp()).get(
      '/api/wellness/patients/import-template.csv',
    );
    expect(res.status).toBe(200);
    const body = stripBom(res.text);
    const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
    const header = parseCsvLine(lines[0]);
    expect(header).toEqual([
      'name',
      'phone',
      'email',
      'dob',
      'gender',
      'source',
      'locationId',
      'tags',
      'notes',
    ]);
  });
});

describe('GET /api/wellness/patients/import-template.csv — #820 (5) example row arity', () => {
  test('example row has 9 cells matching the header arity + canonical sample values', async () => {
    const res = await request(makeApp()).get(
      '/api/wellness/patients/import-template.csv',
    );
    expect(res.status).toBe(200);
    const body = stripBom(res.text);
    const lines = body.split(/\r?\n/).filter((l) => l.length > 0);
    const example = parseCsvLine(lines[1]);
    expect(example).toHaveLength(9);
    // Canonical sample — pins so the frontend "Download template" button +
    // any operator-facing docs can rely on a stable shape.
    expect(example[0]).toBe('Anita Sharma');
    expect(example[1]).toBe('+919876543210');
    expect(example[2]).toBe('anita.example@gmail.com');
    expect(example[3]).toBe('1990-03-15');
    expect(example[4]).toBe('F');
    expect(example[5]).toBe('walk-in');
    expect(example[6]).toBe('1');
    expect(example[7]).toBe('VIP;repeat');
    // notes cell contains an em-dash + a comma-free phrase; pin verbatim.
    expect(example[8]).toBe('Sample notes — replace with real patient data');
  });
});

describe('GET /api/wellness/patients/import-template.csv — #820 (6) unauthenticated → 401', () => {
  test('no req.user → phiReadGate emits 401; handler body never runs', async () => {
    const res = await request(makeApp({ noAuth: true })).get(
      '/api/wellness/patients/import-template.csv',
    );
    expect(res.status).toBe(401);
    // No CSV body should have been emitted.
    expect(res.headers['content-type']).not.toMatch(/text\/csv/);
  });
});
