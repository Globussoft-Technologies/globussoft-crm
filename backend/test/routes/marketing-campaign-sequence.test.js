// @ts-check
/**
 * Unit tests for backend/routes/marketing.js — Campaign → Sequence linkage.
 *
 * Issue context
 * ─────────────
 *   #932 — follow-up to #898 acceptance #4. Travel-vertical marketers (and
 *          every other vertical, since the linkage is generic) need a way
 *          to auto-enroll a campaign's recipients into a follow-up drip
 *          sequence after the campaign dispatches. Pre-fix, the workflow
 *          was: "send campaign" → manually walk each recipient → POST
 *          /api/sequences/:id/enroll one-by-one, which is N HTTP round
 *          trips for every nurture batch.
 *
 * What this file pins
 * ───────────────────
 *   1. POST /campaigns accepts an optional sequenceId in the body and
 *      persists it on the Campaign row. The FK is nullable so existing
 *      campaigns without a linked sequence keep working.
 *   2. POST /campaigns rejects a sequenceId that doesn't belong to the
 *      caller's tenant with 400 (defensive — the FK alone would surface
 *      an ugly Prisma error).
 *   3. PUT /campaigns/:id supports clearing the linkage (sequenceId: null)
 *      and re-linking to a different sequence (round-trip).
 *   4. sendCampaign with campaign.sequenceId set calls
 *      enrollRecipientsInSequence for every recipient — fan-out
 *      contract.
 *   5. sendCampaign with campaign.sequenceId = null does NOT call
 *      enrollRecipientsInSequence — back-compat for existing campaigns.
 *   6. enrollRecipientsInSequence is idempotent: a contact already
 *      enrolled in the linked sequence is skipped, not duplicated.
 *
 * Test pattern
 * ────────────
 *   Mirror of marketing-audience.test.js + sequences-triggers.test.js — we
 *   stub the prisma client + auth middleware in the CJS require cache,
 *   then drive the route through supertest. The helper
 *   enrollRecipientsInSequence is exported directly for the unit-level
 *   fan-out assertions. The sendCampaign indirection through
 *   module.exports.enrollRecipientsInSequence (the CJS self-mocking seam)
 *   lets us spy on the helper without a real Prisma connection.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── In-memory fake Prisma ────────────────────────────────────────────────
//
// The route module reads `prisma.campaign.*`, `prisma.sequence.*`,
// `prisma.sequenceEnrollment.*`, `prisma.contact.*` and a couple of audit-
// log writes. We provide a tiny in-memory backing store so the fan-out
// helper's idempotency assertion can observe a real "already enrolled"
// row.
function makeFakePrisma() {
  const state = {
    campaigns: [],
    sequences: [],
    enrollments: [],
    contacts: [],
    audits: [],
    nextCampaignId: 1,
    nextEnrollmentId: 1,
  };

  return {
    state,
    campaign: {
      findFirst: vi.fn(async ({ where }) =>
        state.campaigns.find(
          (c) => c.id === where.id && c.tenantId === where.tenantId,
        ) || null,
      ),
      findMany: vi.fn(async ({ where }) =>
        state.campaigns.filter((c) => c.tenantId === where.tenantId),
      ),
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextCampaignId++, ...data };
        state.campaigns.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.campaigns.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }) => {
        state.campaigns = state.campaigns.filter((c) => c.id !== where.id);
        return {};
      }),
    },
    sequence: {
      findFirst: vi.fn(async ({ where }) =>
        state.sequences.find(
          (s) => s.id === where.id && s.tenantId === where.tenantId,
        ) || null,
      ),
    },
    sequenceEnrollment: {
      findFirst: vi.fn(async ({ where }) =>
        state.enrollments.find(
          (e) => e.sequenceId === where.sequenceId && e.contactId === where.contactId,
        ) || null,
      ),
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextEnrollmentId++, ...data };
        state.enrollments.push(row);
        return row;
      }),
    },
    contact: {
      findMany: vi.fn(async ({ where }) => {
        return state.contacts.filter((c) => {
          if (where.tenantId !== c.tenantId) return false;
          if (where.email && where.email.not !== undefined) {
            if (c.email === where.email.not) return false;
          }
          return true;
        });
      }),
      count: vi.fn(async () => state.contacts.length),
    },
    auditLog: {
      create: vi.fn(async ({ data }) => {
        state.audits.push(data);
        return data;
      }),
    },
    emailMessage: {
      create: vi.fn(async ({ data }) => ({ id: Math.random(), ...data })),
    },
    emailTracking: {
      create: vi.fn(async ({ data }) => ({ id: Math.random(), ...data })),
    },
    smsMessage: {
      create: vi.fn(async ({ data }) => ({ id: Math.random(), ...data })),
    },
  };
}

// ── Module-load wiring ────────────────────────────────────────────────────

let fakePrisma;
let marketingRouter;
let marketingExports;

beforeEach(() => {
  // Patch prisma + auth + service deps in the CJS require cache BEFORE the
  // route module is loaded.
  const prismaPath = requireCJS.resolve('../../lib/prisma');
  fakePrisma = makeFakePrisma();
  requireCJS.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: fakePrisma,
  };

  const authPath = requireCJS.resolve('../../middleware/auth');
  requireCJS.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      verifyToken: (req, _res, next) => {
        req.user = { userId: 1, tenantId: 1, role: 'ADMIN' };
        next();
      },
      verifyRole: () => (_req, _res, next) => next(),
    },
  };

  const smsPath = requireCJS.resolve('../../services/smsProvider');
  requireCJS.cache[smsPath] = {
    id: smsPath,
    filename: smsPath,
    loaded: true,
    exports: { sendSms: vi.fn(async () => ({ ok: true })) },
  };

  const slaPath = requireCJS.resolve('../../lib/leadSla');
  requireCJS.cache[slaPath] = {
    id: slaPath,
    filename: slaPath,
    loaded: true,
    exports: { computeFirstResponseDueAt: () => null },
  };

  const sanitizePath = requireCJS.resolve('../../lib/sanitizeJson');
  requireCJS.cache[sanitizePath] = {
    id: sanitizePath,
    filename: sanitizePath,
    loaded: true,
    exports: {
      sanitizeText: (s) => s,
      sanitizeHtmlBody: (s) => s,
      sanitizeJsonForStringColumn: (s) => (typeof s === 'string' ? s : JSON.stringify(s)),
    },
  };

  // Force a fresh route module load so the new prisma stub takes effect.
  const marketingPath = requireCJS.resolve('../../routes/marketing');
  delete requireCJS.cache[marketingPath];
  marketingExports = requireCJS('../../routes/marketing');
  marketingRouter = marketingExports;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/marketing', marketingRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────
// 1 — POST /campaigns persists sequenceId
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/marketing/campaigns — #932 sequenceId persistence', () => {
  test('campaign creation with sequenceId persists the FK on the row', async () => {
    fakePrisma.state.sequences.push({ id: 42, name: 'Welcome drip', tenantId: 1 });
    const app = makeApp();

    const res = await request(app)
      .post('/api/marketing/campaigns')
      .send({ name: 'Spring Promo', channel: 'EMAIL', budget: 0, sequenceId: 42 });

    expect(res.status).toBe(201);
    expect(res.body.sequenceId).toBe(42);
    expect(res.body.name).toBe('Spring Promo');
    // Persisted in our fake store.
    const stored = fakePrisma.state.campaigns.find((c) => c.id === res.body.id);
    expect(stored.sequenceId).toBe(42);
  });

  test('campaign creation without sequenceId stores null (back-compat)', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/marketing/campaigns')
      .send({ name: 'No-link Campaign', channel: 'EMAIL', budget: 0 });

    expect(res.status).toBe(201);
    expect(res.body.sequenceId).toBeNull();
  });

  test('sequenceId pointing to a non-existent sequence yields 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/marketing/campaigns')
      .send({ name: 'Orphan', channel: 'EMAIL', sequenceId: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Sequence not found/i);
  });

  test('non-numeric sequenceId yields 400', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/marketing/campaigns')
      .send({ name: 'Bad', channel: 'EMAIL', sequenceId: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid sequenceId/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2 — PUT /campaigns/:id round-trips the linkage
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /api/marketing/campaigns/:id — #932 sequenceId update', () => {
  test('can re-link a campaign to a different sequence', async () => {
    fakePrisma.state.sequences.push(
      { id: 42, name: 'A', tenantId: 1 },
      { id: 77, name: 'B', tenantId: 1 },
    );
    fakePrisma.state.campaigns.push({ id: 1, name: 'C', tenantId: 1, sequenceId: 42 });
    const app = makeApp();

    const res = await request(app)
      .put('/api/marketing/campaigns/1')
      .send({ sequenceId: 77 });

    expect(res.status).toBe(200);
    expect(res.body.sequenceId).toBe(77);
  });

  test('can clear the linkage by passing null', async () => {
    fakePrisma.state.sequences.push({ id: 42, name: 'A', tenantId: 1 });
    fakePrisma.state.campaigns.push({ id: 1, name: 'C', tenantId: 1, sequenceId: 42 });
    const app = makeApp();

    const res = await request(app)
      .put('/api/marketing/campaigns/1')
      .send({ sequenceId: null });

    expect(res.status).toBe(200);
    expect(res.body.sequenceId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3 — enrollRecipientsInSequence fan-out + idempotency
// ─────────────────────────────────────────────────────────────────────────

describe('enrollRecipientsInSequence — #932 fan-out contract', () => {
  test('enrolls every contact when linked sequence exists', async () => {
    fakePrisma.state.sequences.push({ id: 5, name: 'Aftercare', tenantId: 1 });
    const campaign = { id: 1, tenantId: 1, sequenceId: 5 };
    const contacts = [
      { id: 100, tenantId: 1 },
      { id: 101, tenantId: 1 },
      { id: 102, tenantId: 1 },
    ];

    const summary = await marketingExports.enrollRecipientsInSequence(campaign, contacts);

    expect(summary.enrolled).toBe(3);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(fakePrisma.state.enrollments).toHaveLength(3);
    expect(fakePrisma.state.enrollments.every((e) => e.sequenceId === 5 && e.status === 'Active')).toBe(true);
  });

  test('is idempotent — already-enrolled contacts skip, not duplicate', async () => {
    fakePrisma.state.sequences.push({ id: 5, name: 'Aftercare', tenantId: 1 });
    fakePrisma.state.enrollments.push({
      id: 1,
      sequenceId: 5,
      contactId: 100,
      status: 'Active',
      tenantId: 1,
    });

    const campaign = { id: 1, tenantId: 1, sequenceId: 5 };
    const contacts = [
      { id: 100, tenantId: 1 },
      { id: 101, tenantId: 1 },
    ];

    const summary = await marketingExports.enrollRecipientsInSequence(campaign, contacts);

    expect(summary.enrolled).toBe(1); // only 101
    expect(summary.skipped).toBe(1); // 100 was already enrolled
    expect(fakePrisma.state.enrollments).toHaveLength(2); // not 3
  });

  test('no-op when campaign.sequenceId is null', async () => {
    const campaign = { id: 1, tenantId: 1, sequenceId: null };
    const summary = await marketingExports.enrollRecipientsInSequence(campaign, [{ id: 100, tenantId: 1 }]);
    expect(summary).toEqual({ enrolled: 0, skipped: 0, failed: 0 });
    expect(fakePrisma.state.enrollments).toHaveLength(0);
  });

  test('skipped when linked sequence is deleted between save + send', async () => {
    // sequenceId set on campaign but no matching Sequence row (stale ref).
    const campaign = { id: 1, tenantId: 1, sequenceId: 999 };
    const contacts = [{ id: 100, tenantId: 1 }, { id: 101, tenantId: 1 }];

    const summary = await marketingExports.enrollRecipientsInSequence(campaign, contacts);

    expect(summary.enrolled).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(fakePrisma.state.enrollments).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4 — sendCampaign integrates the fan-out
// ─────────────────────────────────────────────────────────────────────────

describe('sendCampaign — #932 post-dispatch fan-out integration', () => {
  test('sendCampaign with sequenceId calls enrollRecipientsInSequence for every recipient', async () => {
    fakePrisma.state.sequences.push({ id: 5, name: 'Aftercare', tenantId: 1 });
    fakePrisma.state.contacts.push(
      { id: 100, tenantId: 1, email: 'a@x.com' },
      { id: 101, tenantId: 1, email: 'b@x.com' },
    );
    fakePrisma.state.campaigns.push({
      id: 1,
      name: 'Promo',
      tenantId: 1,
      channel: 'EMAIL',
      status: 'Draft',
      sequenceId: 5,
    });

    // Spy on the module's own export — the CJS self-mocking seam means
    // sendCampaign's internal call goes through module.exports.enroll*,
    // so this spy intercepts the fan-out without standing up real
    // enrollment side-effects.
    const spy = vi.spyOn(marketingExports, 'enrollRecipientsInSequence');

    const result = await marketingExports.sendCampaign(
      { ...fakePrisma.state.campaigns[0] },
      null,
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const [calledCampaign, calledContacts] = spy.mock.calls[0];
    expect(calledCampaign.sequenceId).toBe(5);
    expect(calledContacts).toHaveLength(2);
    expect(result.sent).toBeGreaterThanOrEqual(0);
    expect(result.enrollment).toBeDefined();

    spy.mockRestore();
  });

  test('sendCampaign without sequenceId does NOT enroll anyone (back-compat)', async () => {
    fakePrisma.state.contacts.push({ id: 100, tenantId: 1, email: 'a@x.com' });
    fakePrisma.state.campaigns.push({
      id: 1,
      name: 'No-link',
      tenantId: 1,
      channel: 'EMAIL',
      status: 'Draft',
      sequenceId: null,
    });

    await marketingExports.sendCampaign(
      { ...fakePrisma.state.campaigns[0] },
      null,
    );

    // No enrollment rows created.
    expect(fakePrisma.state.enrollments).toHaveLength(0);
  });
});
