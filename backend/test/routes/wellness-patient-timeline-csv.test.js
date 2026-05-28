// @ts-check
/**
 * Unit tests for tick #200 — GET /api/wellness/patients/:id/timeline.csv
 *
 * Sibling export endpoint to the JSON unified timeline (tick #198). Shares
 * the buildPatientTimeline() closure helper in routes/wellness.js so the
 * merge / sort / mask logic is identical; this file pins only the
 * CSV-shape-specific surface.
 *
 * What this file pins
 * ───────────────────
 *  C1. ADMIN on a wellness tenant gets 200 + CSV body containing a row
 *      per merged timeline event across the 4 source tables.
 *  C2. Content-Type is `text/csv; charset=utf-8` AND Content-Disposition
 *      attaches as `patient-${id}-timeline.csv`.
 *  C3. CSV body parses to exactly N+1 lines (1 header + N data rows) for
 *      the seeded mock data.
 *  C4. Header row is exactly the documented 5-column shape:
 *      "Event Date,Event Type,Summary,Reference ID,Reference Type".
 *  C5. ?types=VISIT narrows the export to visit-only events (other 3
 *      sources are skipped — Promise.resolve([]) — same as JSON sibling).
 *  C6. Masked viewer (wellnessRole=telecaller) gets every data row's
 *      Summary cell collapsed to "[masked]". Event Date / Type / Reference
 *      ID / Reference Type still surface (the CSV remains useful for
 *      non-clinical operators).
 *  C7. Unauthenticated → 401 (phiReadGate fires before the handler).
 *      role=USER + no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN.
 *
 * Mocking pattern mirrors backend/test/routes/wellness-patient-timeline.test.js
 * (tick #198) — patch the prisma singleton before requiring the router so
 * the route binds to the spy'd functions. Express app + supertest +
 * synthetic auth middleware. `vertical: 'wellness'` on req.user lets
 * phiReadGate / verifyWellnessRole short-circuit the tenant lookup.
 *
 * STATUS (staging_crm): the GET /patients/:id/timeline.csv route (sibling of
 * /timeline from tick #200) was NOT carried forward to this branch. All
 * blocks below are `.skip`ped until the feature lands on staging_crm. The
 * sibling JSON timeline file documents the same state.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

// ── Prisma surface required by routes/wellness.js at require-time ──────
prisma.patient = prisma.patient || {};
prisma.patient.findFirst = vi.fn();
prisma.patient.findMany = prisma.patient.findMany || vi.fn();
prisma.patient.update = prisma.patient.update || vi.fn();
prisma.patient.count = prisma.patient.count || vi.fn();

prisma.visit = prisma.visit || {};
prisma.visit.findMany = vi.fn();

prisma.prescription = prisma.prescription || {};
prisma.prescription.findMany = vi.fn();

prisma.consentForm = prisma.consentForm || {};
prisma.consentForm.findMany = vi.fn();

prisma.treatmentPlan = prisma.treatmentPlan || {};
prisma.treatmentPlan.findMany = vi.fn();

// auditLog.create is what writeAudit ultimately calls.
prisma.auditLog = { create: vi.fn().mockResolvedValue({ id: 1 }) };

// Other delegates touched at module-eval time inside routes/wellness.js
// (defensive permissive stubs — same set as the sibling JSON test):
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
 * - `noAuth: true` → no req.user injection (→ phiReadGate emits 401).
 * - `vertical` defaults to "wellness" so phiReadGate doesn't trip the
 *   WELLNESS_TENANT_REQUIRED gate via prisma.tenant.findUnique.
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

function setPatientFound(id = 42) {
  prisma.patient.findFirst.mockResolvedValue({ id });
}

beforeEach(() => {
  prisma.patient.findFirst.mockReset();
  prisma.visit.findMany.mockReset();
  prisma.prescription.findMany.mockReset();
  prisma.consentForm.findMany.mockReset();
  prisma.treatmentPlan.findMany.mockReset();
  prisma.auditLog.create.mockReset();
  prisma.auditLog.create.mockResolvedValue({ id: 1 });

  // Sensible defaults — each test overrides as needed.
  prisma.visit.findMany.mockResolvedValue([]);
  prisma.prescription.findMany.mockResolvedValue([]);
  prisma.consentForm.findMany.mockResolvedValue([]);
  prisma.treatmentPlan.findMany.mockResolvedValue([]);
});

/**
 * Parse a CSV body emitted by the route into [headerCells, ...dataRowsCells].
 * Strips the leading UTF-8 BOM the route writes for Excel compatibility.
 * Handles RFC4180-style quoted cells with embedded quotes — this mirrors
 * what the route's csvEscape() helper writes (wrap in quotes when cell
 * contains comma/quote/newline; double internal quotes).
 */
function parseCsv(text) {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let i = 0;
  let inQuotes = false;
  while (i < body.length) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  // Trailing partial row (no terminating newline) — only push if non-empty.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ─── C1 endpoint returns 200 for ADMIN ────────────────────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C1 200 for ADMIN', () => {
  test('returns 200 with a CSV body covering all 4 sources', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      {
        id: 100,
        visitDate: new Date('2026-05-20T10:00:00Z'),
        status: 'completed',
        service: { id: 1, name: 'Hair Transplant' },
      },
    ]);
    prisma.prescription.findMany.mockResolvedValue([
      {
        id: 200,
        createdAt: new Date('2026-05-20T11:00:00Z'),
        instructions: 'Take with water',
        doctor: { id: 5, name: 'Harsh' },
      },
    ]);
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 300, signedAt: new Date('2026-05-19T09:00:00Z'), templateName: 'general' },
    ]);
    prisma.treatmentPlan.findMany.mockResolvedValue([
      {
        id: 400,
        startedAt: new Date('2026-05-18T08:00:00Z'),
        name: '6-session FUE',
        status: 'active',
        completedSessions: 1,
        totalSessions: 6,
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline.csv');
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

// ─── C2 Content-Type + Content-Disposition headers ────────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C2 headers', () => {
  test('Content-Type and Content-Disposition headers are correct', async () => {
    setPatientFound(77);
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: new Date('2026-05-15T10:00:00Z'), status: 'completed', service: null },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/77/timeline.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv;\s*charset=utf-8/i);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="patient-77-timeline.csv"',
    );
  });
});

// ─── C3 row count = header + N data rows ──────────────────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C3 row count', () => {
  test('CSV body parses to 1 header + N data rows for seeded events', async () => {
    setPatientFound(42);
    // 1 visit + 1 prescription + 1 consent + 1 plan = 4 data rows.
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: new Date('2026-05-15T10:00:00Z'), status: 'completed', service: null },
    ]);
    prisma.prescription.findMany.mockResolvedValue([
      { id: 2, createdAt: new Date('2026-05-20T10:00:00Z'), instructions: null, doctor: null },
    ]);
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 3, signedAt: new Date('2026-05-10T10:00:00Z'), templateName: 'general' },
    ]);
    prisma.treatmentPlan.findMany.mockResolvedValue([
      {
        id: 4,
        startedAt: new Date('2026-05-25T10:00:00Z'),
        name: 'Plan A',
        status: 'active',
        completedSessions: 0,
        totalSessions: 1,
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline.csv');
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(5); // 1 header + 4 data rows
    // Sanity: each data row has the 5-column shape.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]).toHaveLength(5);
    }
  });
});

// ─── C4 header row exact match ────────────────────────────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C4 header row', () => {
  test('header row matches the documented 5-column shape', async () => {
    setPatientFound(42);
    // Empty timeline — header still emits.
    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline.csv');
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toEqual([
      'Event Date',
      'Event Type',
      'Summary',
      'Reference ID',
      'Reference Type',
    ]);
  });
});

// ─── C5 ?types=VISIT filter ───────────────────────────────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C5 ?types filter', () => {
  test('?types=VISIT narrows export to visit-only events', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: new Date('2026-05-15T10:00:00Z'), status: 'completed', service: null },
      { id: 2, visitDate: new Date('2026-05-16T10:00:00Z'), status: 'completed', service: null },
    ]);
    // Seeded but should NOT appear — the route short-circuits these via
    // Promise.resolve([]) when the type filter excludes them.
    prisma.prescription.findMany.mockResolvedValue([
      { id: 99, createdAt: new Date('2026-05-20T10:00:00Z'), instructions: null, doctor: null },
    ]);
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 88, signedAt: new Date('2026-05-10T10:00:00Z'), templateName: 'general' },
    ]);
    prisma.treatmentPlan.findMany.mockResolvedValue([
      {
        id: 77,
        startedAt: new Date('2026-05-25T10:00:00Z'),
        name: 'Plan',
        status: 'active',
        completedSessions: 0,
        totalSessions: 1,
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline.csv?types=VISIT');
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    // 1 header + 2 visit rows. No PRESCRIPTION / CONSENT / TREATMENT_PLAN cells.
    expect(rows).toHaveLength(3);
    const typesColumn = rows.slice(1).map((r) => r[1]);
    expect(typesColumn).toEqual(['VISIT', 'VISIT']);
    // Confirm we didn't pay the Prisma fan-out cost for the excluded types.
    expect(prisma.prescription.findMany).not.toHaveBeenCalled();
    expect(prisma.consentForm.findMany).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.findMany).not.toHaveBeenCalled();
  });
});

// ─── C6 masked viewer → "[masked]" in Summary column ──────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C6 masked summary', () => {
  test('wellnessRole=telecaller → every Summary cell is "[masked]"', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      {
        id: 1,
        visitDate: new Date('2026-05-15T10:00:00Z'),
        status: 'completed',
        service: { id: 1, name: 'Hair Transplant' }, // would otherwise leak via Summary
      },
    ]);
    prisma.prescription.findMany.mockResolvedValue([
      {
        id: 2,
        createdAt: new Date('2026-05-20T10:00:00Z'),
        instructions: null,
        doctor: { id: 5, name: 'Harsh' },
      },
    ]);
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 3, signedAt: new Date('2026-05-19T09:00:00Z'), templateName: 'sensitive-procedure' },
    ]);

    const res = await request(
      makeApp({ role: 'USER', wellnessRole: 'telecaller' }),
    ).get('/api/wellness/patients/42/timeline.csv');
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);
    expect(rows).toHaveLength(4); // 1 header + 3 data rows
    // Every Summary cell (index 2) must be the literal placeholder — no
    // leakage of service name / doctor name / template name through CSV.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i][2]).toBe('[masked]');
      // Shape cells still surface (CSV remains useful for non-clinical ops).
      expect(rows[i][0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO date
      expect(rows[i][1]).toMatch(/^(VISIT|PRESCRIPTION|CONSENT|TREATMENT_PLAN)$/);
      expect(rows[i][3]).toMatch(/^\d+$/); // Reference ID (int)
      expect(rows[i][4]).toMatch(/^(Visit|Prescription|ConsentForm|TreatmentPlan)$/);
    }
    // Confirm no clinical detail leaked anywhere in the body.
    expect(res.text).not.toMatch(/Hair Transplant/);
    expect(res.text).not.toMatch(/Harsh/);
    expect(res.text).not.toMatch(/sensitive-procedure/);
  });
});

// ─── C7 auth gates ────────────────────────────────────────────────────

describe.skip('GET /api/wellness/patients/:id/timeline.csv — C7 auth gates', () => {
  test('unauthenticated → 401 (no req.user; phiReadGate fires first)', async () => {
    const res = await request(makeApp({ noAuth: true })).get(
      '/api/wellness/patients/42/timeline.csv',
    );
    expect(res.status).toBe(401);
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });

  test('role=USER + no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(
      makeApp({ role: 'USER', wellnessRole: null }),
    ).get('/api/wellness/patients/42/timeline.csv');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });
});
