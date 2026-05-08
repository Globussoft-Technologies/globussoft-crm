// @ts-check
/**
 * Unit tests for backend/routes/sequences.js — pins the GET /triggers
 * vertical-aware catalog contract (#616).
 *
 * Issue context
 * ─────────────
 *   #616 — Marketing → Sequences trigger picker only listed generic CRM
 *          events (contact.created, deal.won, etc.). Wellness clinics
 *          could not build common journeys like "30 days after visit
 *          completed, send aftercare email" because no visit/treatment/
 *          consent triggers existed in the catalog.
 *
 * What this file pins
 * ───────────────────
 *   1. listTriggersForVertical('generic') returns ONLY generic triggers
 *      (no visit / treatment / consent leaks into a generic tenant's
 *      picker).
 *   2. listTriggersForVertical('wellness') returns generic + the four
 *      wellness triggers: visit.scheduled, visit.completed,
 *      treatment.started, consent.signed.
 *   3. GET /api/sequences/triggers responds with the wellness catalog
 *      when req.user.vertical === 'wellness'.
 *   4. GET /api/sequences/triggers responds with the generic catalog
 *      when req.user.vertical is missing / 'generic'.
 *   5. Each trigger row carries `value`, `label`, `description`, and a
 *      `vertical` discriminator the frontend uses for grouping.
 *
 * Test pattern
 * ────────────
 *   Mirror of backend/test/routes/communications.test.js — supertest +
 *   express + a tiny middleware that injects req.user. The router itself
 *   is required directly; verifyToken is the only middleware on the
 *   /triggers handler so we don't need a JWT.
 */

import { describe, test, expect } from 'vitest';

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Patch the auth middleware in the CJS require cache BEFORE we load the
// route — `require('../middleware/auth')` inside the router resolves to
// our stub. vi.mock() doesn't reach CJS requires made at module load.
const authPath = requireCJS.resolve('../../middleware/auth');
requireCJS.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    verifyToken: (req, _res, next) => next(),
    verifyRole: () => (_req, _res, next) => next(),
  },
};
const sequencesRouter = requireCJS('../../routes/sequences');
const {
  GENERIC_SEQUENCE_TRIGGERS,
  WELLNESS_SEQUENCE_TRIGGERS,
  listTriggersForVertical,
} = sequencesRouter;

function makeApp({ vertical } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: 7, tenantId: 1, vertical };
    next();
  });
  app.use('/api/sequences', sequencesRouter);
  return app;
}

// ─── listTriggersForVertical (pure helper) ──────────────────────────

describe('listTriggersForVertical — vertical-aware catalog (#616)', () => {
  test('generic vertical returns only generic triggers', () => {
    const list = listTriggersForVertical('generic');
    expect(list).toEqual(GENERIC_SEQUENCE_TRIGGERS);
    // No wellness leakage.
    for (const t of list) {
      expect(t.vertical).toBe('generic');
      expect(t.value).not.toMatch(/^(visit|treatment|consent)\./);
    }
  });

  test('wellness vertical returns generic + wellness triggers', () => {
    const list = listTriggersForVertical('wellness');
    // Generic triggers stay first; wellness triggers append.
    expect(list.length).toBe(GENERIC_SEQUENCE_TRIGGERS.length + WELLNESS_SEQUENCE_TRIGGERS.length);
    const values = list.map((t) => t.value);
    expect(values).toContain('visit.scheduled');
    expect(values).toContain('visit.completed');
    expect(values).toContain('treatment.started');
    expect(values).toContain('consent.signed');
  });

  test('unknown vertical falls back to generic-only', () => {
    const list = listTriggersForVertical('aerospace');
    expect(list).toEqual(GENERIC_SEQUENCE_TRIGGERS);
  });

  test('every wellness trigger row carries the vertical=wellness flag', () => {
    for (const t of WELLNESS_SEQUENCE_TRIGGERS) {
      expect(t.vertical).toBe('wellness');
      expect(typeof t.value).toBe('string');
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
    }
  });
});

// ─── GET /api/sequences/triggers — route contract ──────────────────

describe('GET /api/sequences/triggers — vertical-aware response (#616)', () => {
  test('wellness tenant sees the wellness triggers in the catalog', async () => {
    const app = makeApp({ vertical: 'wellness' });
    const res = await request(app).get('/api/sequences/triggers');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const values = res.body.map((t) => t.value);
    expect(values).toContain('visit.completed');
    expect(values).toContain('visit.scheduled');
    expect(values).toContain('treatment.started');
    expect(values).toContain('consent.signed');
    // Generic still present.
    expect(values).toContain('contact.created');
  });

  test('generic tenant does NOT see wellness triggers', async () => {
    const app = makeApp({ vertical: 'generic' });
    const res = await request(app).get('/api/sequences/triggers');
    expect(res.status).toBe(200);
    const values = res.body.map((t) => t.value);
    expect(values).not.toContain('visit.completed');
    expect(values).not.toContain('treatment.started');
    expect(values).not.toContain('consent.signed');
    // Generic triggers present.
    expect(values).toContain('contact.created');
    expect(values).toContain('deal.won');
  });

  test('missing vertical defaults to generic', async () => {
    const app = makeApp({});
    const res = await request(app).get('/api/sequences/triggers');
    expect(res.status).toBe(200);
    const values = res.body.map((t) => t.value);
    expect(values).not.toContain('visit.completed');
    expect(values).toContain('contact.created');
  });
});
