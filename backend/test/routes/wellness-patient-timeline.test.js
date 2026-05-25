// @ts-check
/**
 * Unit tests for tick #198 — GET /api/wellness/patients/:id/timeline
 *
 * What this file pins
 * ───────────────────
 *  T1. Endpoint mounted + reachable for ADMIN on a wellness tenant; merges
 *      VISIT + PRESCRIPTION + CONSENT + TREATMENT_PLAN events into a
 *      single uniform-shape feed with the documented envelope
 *      ({ patientId, count, events: [...] }).
 *  T2. Unauthenticated → 401 (no req.user — phiReadGate fires).
 *  T3. role=USER with no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN
 *      (phiReadGate blocks low-trust viewers from any PHI surface).
 *  T4. Unknown patient → 404 (cross-tenant probe or deleted patient).
 *  T5. Events sort descending by eventAt — newest event first across all
 *      four sources interleaved.
 *  T6. Tie-breaker stability: two events sharing the same eventAt timestamp
 *      return in deterministic order (eventType ASC, then eventId ASC).
 *      Load-bearing for paginated callers.
 *  T7. ?from / ?to filter narrows the time window to the events inside it.
 *  T8. ?types=VISIT,RX filters out CONSENT + TREATMENT_PLAN events.
 *      RX is the documented alias for PRESCRIPTION (frontend's historical
 *      label on the flat /prescriptions endpoint).
 *  T9. ?limit caps the result count + the hard cap is 200 (?limit=9999
 *      collapses back to 200).
 *  T10. Masking applies to low-trust viewers — when shouldMaskForViewer
 *       returns true (wellnessRole=telecaller), every event's `summary`
 *       field collapses to the literal "[masked]". eventType / eventAt /
 *       refId still surface (the timeline SHAPE remains useful for
 *       non-clinical operators).
 *
 * Test pattern mirrors backend/test/routes/wellness-patients-bulk-tags.test.js
 * + backend/test/routes/wellness-patients-xlsx.test.js — patch the prisma
 * singleton BEFORE requiring the router so the require'd router binds to the
 * spy'd functions; mount the router under a tiny Express app; inject
 * `req.user` via a synthetic middleware. The `vertical: 'wellness'` claim on
 * req.user lets phiReadGate / verifyWellnessRole short-circuit the
 * tenant.findUnique lookup.
 *
 * Why mocked prisma (not the live MySQL container): keeps the unit-test
 * gate fast + isolated. The MERGE-AND-SORT logic IS the contract we're
 * pinning here; the e2e-full / api_tests suite exercises round-trip
 * persistence against real MySQL.
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

/**
 * Default to "patient 42 exists in tenant 1". Override per-test via
 * mockResolvedValueOnce(null) for the 404 case.
 */
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

// ─── T1 endpoint mounted ──────────────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T1 endpoint mounted', () => {
  test('returns 200 for ADMIN with merged events across all 4 sources', async () => {
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

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ patientId: 42, count: 4 });
    expect(res.body.events).toHaveLength(4);
    const types = res.body.events.map((e) => e.eventType).sort();
    expect(types).toEqual(['CONSENT', 'PRESCRIPTION', 'TREATMENT_PLAN', 'VISIT']);

    // Each event carries the documented uniform shape.
    for (const ev of res.body.events) {
      expect(ev).toHaveProperty('eventType');
      expect(ev).toHaveProperty('eventId');
      expect(ev).toHaveProperty('eventAt');
      expect(ev).toHaveProperty('summary');
      expect(ev).toHaveProperty('refType');
      expect(ev).toHaveProperty('refId');
      // eventId / refId are the same int (refId mirrors the audit-log
      // convention of refType/refId pairing).
      expect(ev.eventId).toBe(ev.refId);
    }
  });
});

// ─── T2 unauthenticated → 401 ─────────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T2 unauthenticated', () => {
  test('no req.user → 401 from phiReadGate', async () => {
    const res = await request(makeApp({ noAuth: true })).get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(401);
    // patient lookup must NOT have run — gate fired before the handler.
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });
});

// ─── T3 USER without wellnessRole → 403 ───────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T3 USER role denied', () => {
  test('role=USER + no wellnessRole → 403 WELLNESS_ROLE_FORBIDDEN', async () => {
    const res = await request(makeApp({ role: 'USER', wellnessRole: null }))
      .get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'WELLNESS_ROLE_FORBIDDEN' });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
  });
});

// ─── T4 patient not found → 404 ───────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T4 unknown patient', () => {
  test('patient.findFirst returns null → 404', async () => {
    prisma.patient.findFirst.mockResolvedValue(null);
    const res = await request(makeApp()).get('/api/wellness/patients/9999/timeline');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Patient not found' });
    // Sub-resource fan-out must NOT have run when the patient lookup misses.
    expect(prisma.visit.findMany).not.toHaveBeenCalled();
    expect(prisma.prescription.findMany).not.toHaveBeenCalled();
    expect(prisma.consentForm.findMany).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.findMany).not.toHaveBeenCalled();
  });
});

// ─── T5 sort order: eventAt DESC ──────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T5 sort DESC by eventAt', () => {
  test('newest event first across all 4 sources interleaved', async () => {
    setPatientFound(42);
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
        id: 4, startedAt: new Date('2026-05-25T10:00:00Z'), name: 'Plan A', status: 'active',
        completedSessions: 0, totalSessions: 1,
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(200);
    const seq = res.body.events.map((e) => e.eventType);
    // Expected order by eventAt DESC:
    //   2026-05-25 TREATMENT_PLAN
    //   2026-05-20 PRESCRIPTION
    //   2026-05-15 VISIT
    //   2026-05-10 CONSENT
    expect(seq).toEqual(['TREATMENT_PLAN', 'PRESCRIPTION', 'VISIT', 'CONSENT']);
  });
});

// ─── T6 tie-breaker stability ─────────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T6 tie-breaker', () => {
  test('events sharing eventAt sort by eventType ASC then eventId ASC', async () => {
    setPatientFound(42);
    const sharedTs = new Date('2026-05-20T10:00:00Z');
    prisma.visit.findMany.mockResolvedValue([
      { id: 10, visitDate: sharedTs, status: 'completed', service: null },
    ]);
    prisma.prescription.findMany.mockResolvedValue([
      { id: 20, createdAt: sharedTs, instructions: null, doctor: null },
    ]);
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 30, signedAt: sharedTs, templateName: 'general' },
    ]);
    prisma.treatmentPlan.findMany.mockResolvedValue([
      {
        id: 40, startedAt: sharedTs, name: 'Plan', status: 'active',
        completedSessions: 0, totalSessions: 1,
      },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(200);
    // All 4 events share the same eventAt. Tie-breaker = eventType ASC:
    //   CONSENT, PRESCRIPTION, TREATMENT_PLAN, VISIT
    const seq = res.body.events.map((e) => e.eventType);
    expect(seq).toEqual(['CONSENT', 'PRESCRIPTION', 'TREATMENT_PLAN', 'VISIT']);
  });

  test('same eventType + same eventAt → eventId ASC', async () => {
    setPatientFound(42);
    const sharedTs = new Date('2026-05-20T10:00:00Z');
    prisma.visit.findMany.mockResolvedValue([
      { id: 200, visitDate: sharedTs, status: 'completed', service: null },
      { id: 100, visitDate: sharedTs, status: 'completed', service: null },
      { id: 150, visitDate: sharedTs, status: 'completed', service: null },
    ]);

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e) => e.eventId);
    // All same type + same eventAt → eventId ASC wins the order.
    expect(ids).toEqual([100, 150, 200]);
  });
});

// ─── T7 ?from / ?to filter ────────────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T7 from/to filter', () => {
  test('narrows to events whose eventAt falls inside [from, to]', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: new Date('2026-05-01T10:00:00Z'), status: 'completed', service: null }, // BEFORE
      { id: 2, visitDate: new Date('2026-05-15T10:00:00Z'), status: 'completed', service: null }, // INSIDE
      { id: 3, visitDate: new Date('2026-05-30T10:00:00Z'), status: 'completed', service: null }, // AFTER
    ]);

    const res = await request(makeApp())
      .get('/api/wellness/patients/42/timeline?from=2026-05-10T00:00:00Z&to=2026-05-20T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.events[0].eventId).toBe(2);
  });
});

// ─── T8 ?types filter ─────────────────────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T8 types filter', () => {
  test('?types=VISIT,RX excludes CONSENT + TREATMENT_PLAN sources', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      { id: 1, visitDate: new Date('2026-05-15T10:00:00Z'), status: 'completed', service: null },
    ]);
    prisma.prescription.findMany.mockResolvedValue([
      { id: 2, createdAt: new Date('2026-05-20T10:00:00Z'), instructions: null, doctor: null },
    ]);
    // These two SHOULD NOT be queried at all (the route short-circuits the
    // findMany via Promise.resolve([])).
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 3, signedAt: new Date('2026-05-10T10:00:00Z'), templateName: 'general' },
    ]);
    prisma.treatmentPlan.findMany.mockResolvedValue([
      {
        id: 4, startedAt: new Date('2026-05-25T10:00:00Z'), name: 'Plan', status: 'active',
        completedSessions: 0, totalSessions: 1,
      },
    ]);

    const res = await request(makeApp())
      .get('/api/wellness/patients/42/timeline?types=VISIT,RX');
    expect(res.status).toBe(200);
    const types = res.body.events.map((e) => e.eventType);
    expect(types.sort()).toEqual(['PRESCRIPTION', 'VISIT']);
    // Confirm we didn't pay the Prisma fan-out cost for the excluded types.
    expect(prisma.consentForm.findMany).not.toHaveBeenCalled();
    expect(prisma.treatmentPlan.findMany).not.toHaveBeenCalled();
  });
});

// ─── T9 ?limit cap (default 50, max 200) ──────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T9 limit', () => {
  test('?limit=3 caps the response to 3 events', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        id: 100 + i,
        visitDate: new Date(`2026-05-${10 + i}T10:00:00Z`),
        status: 'completed',
        service: null,
      })),
    );

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline?limit=3');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.events).toHaveLength(3);
  });

  test('?limit=9999 collapses back to the hard 200 cap', async () => {
    setPatientFound(42);
    // Seed 250 visits so the cap (not the dataset size) is what trims.
    prisma.visit.findMany.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => ({
        id: 1000 + i,
        // Spread timestamps over a single year so they're all distinct +
        // sortable. Date math is deterministic per index.
        visitDate: new Date(2025, 0, 1 + i),
        status: 'completed',
        service: null,
      })),
    );

    const res = await request(makeApp()).get('/api/wellness/patients/42/timeline?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(200);
    expect(res.body.events).toHaveLength(200);
  });
});

// ─── T10 masking for low-trust viewers ────────────────────────────────

describe('GET /api/wellness/patients/:id/timeline — T10 mask summary for telecaller', () => {
  test('wellnessRole=telecaller → every event.summary collapses to "[masked]"', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      {
        id: 1,
        visitDate: new Date('2026-05-15T10:00:00Z'),
        status: 'completed',
        service: { id: 1, name: 'Hair Transplant' }, // would otherwise leak service name
      },
    ]);
    prisma.prescription.findMany.mockResolvedValue([
      { id: 2, createdAt: new Date('2026-05-20T10:00:00Z'), instructions: null, doctor: { id: 5, name: 'Harsh' } },
    ]);
    prisma.consentForm.findMany.mockResolvedValue([
      { id: 3, signedAt: new Date('2026-05-19T09:00:00Z'), templateName: 'sensitive-procedure' },
    ]);

    const res = await request(makeApp({ role: 'USER', wellnessRole: 'telecaller' }))
      .get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(3);
    // EVERY summary must be the literal placeholder — no leakage of
    // service name / doctor name / template name through this field.
    for (const ev of res.body.events) {
      expect(ev.summary).toBe('[masked]');
      // Shape fields still surface so the timeline is useful for
      // non-clinical scheduling.
      expect(ev).toHaveProperty('eventType');
      expect(ev).toHaveProperty('eventAt');
      expect(ev).toHaveProperty('refId');
    }
  });

  test('role=ADMIN → no masking — summary carries real clinical detail', async () => {
    setPatientFound(42);
    prisma.visit.findMany.mockResolvedValue([
      {
        id: 1,
        visitDate: new Date('2026-05-15T10:00:00Z'),
        status: 'completed',
        service: { id: 1, name: 'Hair Transplant' },
      },
    ]);

    const res = await request(makeApp({ role: 'ADMIN' }))
      .get('/api/wellness/patients/42/timeline');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].summary).toContain('Hair Transplant');
    expect(res.body.events[0].summary).not.toBe('[masked]');
  });
});
