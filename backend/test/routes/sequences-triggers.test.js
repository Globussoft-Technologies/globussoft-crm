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

// ─── Catalog size + shape pins (tick #N coverage drain) ─────────────
//
// The cases above pin behaviour ("wellness sees wellness triggers"); the
// block below pins the catalog's static shape (count, uniqueness, naming
// convention, field types) so an accidental copy-paste duplicate or a
// missing required field is caught at unit-test time rather than at the
// frontend picker.

describe('Catalog static-shape contract (#616 extension)', () => {
  test('GENERIC_SEQUENCE_TRIGGERS has exactly 5 entries (size pin)', () => {
    // Counts the static list ships with — if a 6th generic trigger is
    // added later, this test forces the author to bump the number here
    // intentionally (rather than silently expanding the picker).
    expect(GENERIC_SEQUENCE_TRIGGERS.length).toBe(5);
  });

  test('WELLNESS_SEQUENCE_TRIGGERS has exactly 4 entries (size pin)', () => {
    // 4 wellness-event triggers ship today: visit.scheduled,
    // visit.completed, treatment.started, consent.signed.
    expect(WELLNESS_SEQUENCE_TRIGGERS.length).toBe(4);
  });

  test('every trigger value matches the entity.action naming convention', () => {
    // Frontend trigger picker groups by the dotted prefix; an entry
    // missing the dot would render in a "misc" group and look broken.
    const all = [...GENERIC_SEQUENCE_TRIGGERS, ...WELLNESS_SEQUENCE_TRIGGERS];
    for (const t of all) {
      expect(t.value).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });

  test('combined generic + wellness catalog has no duplicate value keys', () => {
    // A duplicate value would let two trigger rows fire the same handler
    // path under different labels — confusing UX and a class of subtle bugs.
    const all = [...GENERIC_SEQUENCE_TRIGGERS, ...WELLNESS_SEQUENCE_TRIGGERS];
    const values = all.map((t) => t.value);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });

  test('every generic trigger row carries vertical=generic + required string fields', () => {
    // Mirror of the wellness shape check in the first describe block —
    // pins that the generic catalog also has full shape (no missing
    // description / label / vertical field on any row).
    for (const t of GENERIC_SEQUENCE_TRIGGERS) {
      expect(t.vertical).toBe('generic');
      expect(typeof t.value).toBe('string');
      expect(t.value.length).toBeGreaterThan(0);
      expect(typeof t.label).toBe('string');
      expect(t.label.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  test('listTriggersForVertical returns a NEW array each call (no shared mutation)', () => {
    // Defensive: a caller that mutates the returned array (push/splice)
    // must not corrupt the next caller's result. The helper uses
    // `[...GENERIC_SEQUENCE_TRIGGERS]` to ship a fresh array.
    const a = listTriggersForVertical('wellness');
    const b = listTriggersForVertical('wellness');
    expect(a).not.toBe(b); // different array identities
    a.push({ value: 'rogue.injection', vertical: 'wellness' });
    // b is untouched.
    expect(b.find((t) => t.value === 'rogue.injection')).toBeUndefined();
    // Subsequent calls also clean.
    const c = listTriggersForVertical('wellness');
    expect(c.find((t) => t.value === 'rogue.injection')).toBeUndefined();
  });

  test('listTriggersForVertical with undefined / null / empty falls back to generic', () => {
    // Multiple "falsy vertical" inputs all collapse to the generic
    // catalog — pins the implicit defensive default. (The existing
    // test covers 'aerospace' as a string fallback; this extends to
    // the three nullish/empty cases the JWT might realistically ship.)
    for (const input of [undefined, null, '']) {
      const list = listTriggersForVertical(input);
      expect(list).toEqual(GENERIC_SEQUENCE_TRIGGERS);
    }
  });

  test('GET /triggers wellness response orders generic FIRST then wellness (positional pin)', async () => {
    // Pins the catalog ORDER, not just membership — the picker UI
    // renders in array order, so swapping the slices would visually
    // re-group the dropdown. The helper does `[...generic, ...wellness]`
    // so generic always leads; verify by index.
    const app = makeApp({ vertical: 'wellness' });
    const res = await request(app).get('/api/sequences/triggers');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(GENERIC_SEQUENCE_TRIGGERS.length + WELLNESS_SEQUENCE_TRIGGERS.length);
    // First N entries are the generic catalog in original order.
    for (let i = 0; i < GENERIC_SEQUENCE_TRIGGERS.length; i++) {
      expect(res.body[i].value).toBe(GENERIC_SEQUENCE_TRIGGERS[i].value);
      expect(res.body[i].vertical).toBe('generic');
    }
    // Remaining entries are the wellness catalog in original order.
    for (let i = 0; i < WELLNESS_SEQUENCE_TRIGGERS.length; i++) {
      const idx = GENERIC_SEQUENCE_TRIGGERS.length + i;
      expect(res.body[idx].value).toBe(WELLNESS_SEQUENCE_TRIGGERS[i].value);
      expect(res.body[idx].vertical).toBe('wellness');
    }
  });
});
