// @ts-check
/**
 * Unit tests for backend/routes/marketing.js — main campaign CRUD + delivery.
 *
 * What this file pins
 * ───────────────────
 *   The MAIN-flow envelope: list / create / read / update / delete /
 *   dispatch / schedule / pause / run + audience preview, auth gating,
 *   tenant isolation, HTML sanitization on Campaign.name, JSON-string
 *   handling for Campaign.scheduleFilters, and the public unauth /submit
 *   form-ingestion endpoint. Complements:
 *
 *     • marketing-audience.test.js          — buildContactWhere slice
 *                                              (#598 wellness keys, #898
 *                                              travel sub-brand)
 *     • marketing-campaign-sequence.test.js — #932 Campaign → Sequence
 *                                              linkage slice (sequenceId
 *                                              persistence + fan-out)
 *
 *   Together the three files cover the route's full surface without
 *   duplicating slice-specific assertions.
 *
 * Test pattern
 * ────────────
 *   Mirror marketing-campaign-sequence.test.js — patch prisma + auth +
 *   service deps in the CJS require cache BEFORE the route module loads,
 *   then drive the router via supertest. This sidesteps the real Prisma
 *   client + jsonwebtoken + sanitize-html init tax so the suite runs
 *   in-memory and stays fast.
 *
 * Standing rules honored
 * ──────────────────────
 *   • Test file lives in backend/test/routes/<route>.test.js.
 *   • CJS self-mocking via require.cache (matches the existing slice).
 *   • Real sanitizeJson is loaded — the HTML-sanitization assertion
 *     proves the route actually wires the helper, not the stub.
 *   • #550: DELETE returns 204 No Content with empty body.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── In-memory fake Prisma ────────────────────────────────────────────────
//
// Same shape as the campaign-sequence slice's fake — small backing store
// + vi.fn() spies so the audit-write / email-write side-effects can be
// asserted on without standing up a real DB.
function makeFakePrisma() {
  const state = {
    campaigns: [],
    sequences: [],
    enrollments: [],
    contacts: [],
    audits: [],
    emails: [],
    emailTrackings: [],
    smsMessages: [],
    deals: [],
    nextId: 1,
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
        state.campaigns.filter((c) => {
          if (where.tenantId !== c.tenantId) return false;
          if (where.channel && c.channel !== where.channel) return false;
          if (where.status && c.status !== where.status) return false;
          return true;
        }),
      ),
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextId++, status: 'Draft', sent: 0, createdAt: new Date(), ...data };
        state.campaigns.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.campaigns.find((c) => c.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }) => {
        const idx = state.campaigns.findIndex((c) => c.id === where.id);
        if (idx === -1) throw new Error('not found');
        state.campaigns.splice(idx, 1);
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
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({ id: state.nextId++, ...data })),
    },
    contact: {
      findMany: vi.fn(async ({ where, take, select }) => {
        let rows = state.contacts.filter((c) => c.tenantId === where.tenantId);
        if (where.email && where.email.not !== undefined) {
          rows = rows.filter((c) => c.email !== where.email.not);
        }
        if (where.phone && where.phone.not === null) {
          rows = rows.filter((c) => c.phone != null);
        }
        if (take) rows = rows.slice(0, take);
        if (select) {
          rows = rows.map((c) => {
            const out = {};
            for (const k of Object.keys(select)) out[k] = c[k];
            return out;
          });
        }
        return rows;
      }),
      count: vi.fn(async ({ where }) => {
        let rows = state.contacts.filter((c) => c.tenantId === where.tenantId);
        if (where.email && where.email.not !== undefined) {
          rows = rows.filter((c) => c.email !== where.email.not);
        }
        if (where.phone && where.phone.not === null) {
          rows = rows.filter((c) => c.phone != null);
        }
        return rows.length;
      }),
      upsert: vi.fn(async ({ where, create }) => {
        const key = where.email_tenantId;
        const existing = state.contacts.find(
          (c) => c.email === key.email && c.tenantId === key.tenantId,
        );
        if (existing) {
          Object.assign(existing, { source: 'Embedded Web Form' });
          return existing;
        }
        const row = { id: state.nextId++, ...create };
        state.contacts.push(row);
        return row;
      }),
    },
    deal: {
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextId++, ...data };
        state.deals.push(row);
        return row;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }) => {
        state.audits.push(data);
        return data;
      }),
    },
    emailMessage: {
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextId++, ...data };
        state.emails.push(row);
        return row;
      }),
    },
    emailTracking: {
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextId++, ...data };
        state.emailTrackings.push(row);
        return row;
      }),
    },
    smsMessage: {
      create: vi.fn(async ({ data }) => {
        const row = { id: state.nextId++, ...data };
        state.smsMessages.push(row);
        return row;
      }),
    },
    // Security audit-fix (214017c1): sendCampaign now resolves the per-tenant
    // from-address + Mailgun domain via lib/tenantSettings.getSetting(), which
    // reads prisma.tenantSetting.findUnique. Default to null so getSetting
    // falls back to FROM_EMAIL / env domain and the dispatch proceeds.
    tenantSetting: {
      findUnique: vi.fn(async () => null),
    },
  };
}

// ── Module-load wiring ────────────────────────────────────────────────────

let fakePrisma;
let marketingExports;
let currentUser; // mutable so tests can flip role / tenantId
let authActive;  // when false, verifyToken returns 401

function installModuleStubs() {
  const prismaPath = requireCJS.resolve('../../lib/prisma');
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
      verifyToken: (req, res, next) => {
        if (!authActive) return res.status(401).json({ error: 'Authentication required' });
        req.user = currentUser;
        next();
      },
      verifyRole: (roles) => (req, res, next) => {
        if (!roles.includes(req.user.role)) {
          return res.status(403).json({ error: 'RBAC denied', code: 'RBAC_DENIED' });
        }
        next();
      },
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
    exports: { computeFirstResponseDueAt: vi.fn(async () => ({ dueAt: null })) },
  };
  // sanitizeJson is intentionally NOT stubbed — we want the REAL helper to
  // run so the HTML-sanitization assertion proves the route wires it. The
  // helper is pure (no I/O) so it's safe to leave un-stubbed.
}

beforeEach(() => {
  fakePrisma = makeFakePrisma();
  currentUser = { userId: 1, tenantId: 1, role: 'ADMIN' };
  authActive = true;
  installModuleStubs();

  const marketingPath = requireCJS.resolve('../../routes/marketing');
  delete requireCJS.cache[marketingPath];
  marketingExports = requireCJS('../../routes/marketing');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/marketing', marketingExports);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────
// 1 — GET /campaigns: list, tenant-scoped, filterable
// ─────────────────────────────────────────────────────────────────────────

describe('GET /api/marketing/campaigns — list', () => {
  test('returns an array of campaigns scoped to req.user.tenantId', async () => {
    fakePrisma.state.campaigns.push(
      { id: 1, name: 'A', tenantId: 1, channel: 'EMAIL', status: 'Draft' },
      { id: 2, name: 'B', tenantId: 1, channel: 'SMS', status: 'Completed' },
      { id: 3, name: 'OTHER-TENANT', tenantId: 2, channel: 'EMAIL', status: 'Draft' },
    );
    const res = await request(makeApp()).get('/api/marketing/campaigns');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    const names = res.body.map((c) => c.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  test('?channel filter narrows the returned rows', async () => {
    fakePrisma.state.campaigns.push(
      { id: 1, name: 'A', tenantId: 1, channel: 'EMAIL', status: 'Draft' },
      { id: 2, name: 'B', tenantId: 1, channel: 'SMS', status: 'Draft' },
    );
    const res = await request(makeApp()).get('/api/marketing/campaigns?channel=SMS');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].channel).toBe('SMS');
  });

  test('?status filter narrows the returned rows', async () => {
    fakePrisma.state.campaigns.push(
      { id: 1, name: 'A', tenantId: 1, channel: 'EMAIL', status: 'Draft' },
      { id: 2, name: 'B', tenantId: 1, channel: 'EMAIL', status: 'Completed' },
    );
    const res = await request(makeApp()).get('/api/marketing/campaigns?status=Completed');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('Completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2 — POST /campaigns: create
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/marketing/campaigns — create', () => {
  test('creates a campaign with name + channel + budget', async () => {
    const res = await request(makeApp())
      .post('/api/marketing/campaigns')
      .send({ name: 'Spring Promo', channel: 'EMAIL', budget: 500 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Spring Promo');
    expect(res.body.channel).toBe('EMAIL');
    expect(res.body.budget).toBe(500);
    expect(res.body.tenantId).toBe(1);
  });

  test('missing name falls back to "Untitled Campaign" (not 400 — route is permissive)', async () => {
    // Pin actual contract: route uses `sanitizeText(name) || "Untitled Campaign"`
    // — there's no required-field validator. Test docs the permissive shape.
    const res = await request(makeApp())
      .post('/api/marketing/campaigns')
      .send({ channel: 'EMAIL' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Untitled Campaign');
  });

  test('defaults channel to EMAIL when not provided', async () => {
    const res = await request(makeApp())
      .post('/api/marketing/campaigns')
      .send({ name: 'Quick' });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('EMAIL');
  });

  test('HTML in name is stripped via sanitizeText (#398 class — Campaign.name renders in admin UI)', async () => {
    const res = await request(makeApp())
      .post('/api/marketing/campaigns')
      .send({
        name: '<script>alert(1)</script>Black Friday',
        channel: 'EMAIL',
      });

    expect(res.status).toBe(201);
    // sanitize-html with allowedTags:[] drops the <script> tags AND inner
    // text (server.js global stripDangerous first removes <script>x</script>
    // bodies in middleware, then route-level sanitizeText strips remaining
    // tags). Either way, the literal `<script>` markup must not survive.
    expect(res.body.name).not.toContain('<script>');
    expect(res.body.name).not.toContain('alert(1)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3 — GET /campaigns/:id: read with tenant isolation
// ─────────────────────────────────────────────────────────────────────────

describe('GET /api/marketing/campaigns/:id — read', () => {
  test('returns the campaign when tenant matches', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'Mine', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp()).get('/api/marketing/campaigns/7');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Mine');
  });

  test('returns 404 for a campaign owned by a different tenant', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'OtherTenant', tenantId: 99, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp()).get('/api/marketing/campaigns/7');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 404 when no campaign matches the id at all', async () => {
    const res = await request(makeApp()).get('/api/marketing/campaigns/999');
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4 — PUT /campaigns/:id: update + tenant isolation
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /api/marketing/campaigns/:id — update', () => {
  test('updates name + channel + budget + status', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'Old', tenantId: 1, channel: 'EMAIL', status: 'Draft', budget: 0,
    });
    const res = await request(makeApp())
      .put('/api/marketing/campaigns/7')
      .send({ name: 'New', channel: 'SMS', budget: 999, status: 'Completed' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
    expect(res.body.channel).toBe('SMS');
    expect(res.body.budget).toBe(999);
    expect(res.body.status).toBe('Completed');
  });

  test('cross-tenant PUT returns 404 (not 403 — route returns 404 to avoid existence leak)', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'NotYours', tenantId: 99, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp())
      .put('/api/marketing/campaigns/7')
      .send({ name: 'pwn' });
    expect(res.status).toBe(404);
  });

  test('HTML in name update is sanitized (sanitizeText again)', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'Original', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp())
      .put('/api/marketing/campaigns/7')
      .send({ name: '<iframe src=x>Promo' });
    expect(res.status).toBe(200);
    expect(res.body.name).not.toContain('<iframe');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5 — DELETE /campaigns/:id: 204 No Content + tenant isolation
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /api/marketing/campaigns/:id — delete', () => {
  test('deletes the row and returns 204 No Content (#550)', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'ToDelete', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp()).delete('/api/marketing/campaigns/7');
    expect(res.status).toBe(204);
    // 204 must have an empty body per HTTP spec
    expect(res.body).toEqual({});
    expect(fakePrisma.state.campaigns).toHaveLength(0);
  });

  test('cross-tenant DELETE returns 404 — does NOT delete the foreign row', async () => {
    fakePrisma.state.campaigns.push({
      id: 7, name: 'Protected', tenantId: 99, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp()).delete('/api/marketing/campaigns/7');
    expect(res.status).toBe(404);
    expect(fakePrisma.state.campaigns).toHaveLength(1); // still there
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6 — POST /campaigns/:id/send: dispatch + status guards
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/marketing/campaigns/:id/send — dispatch', () => {
  test('dispatches an EMAIL campaign and returns {status, code, sent, failed}', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Send Me', tenantId: 1, channel: 'EMAIL', status: 'Draft', sequenceId: null,
    });
    fakePrisma.state.contacts.push(
      { id: 100, tenantId: 1, email: 'a@x.com', phone: null },
      { id: 101, tenantId: 1, email: 'b@x.com', phone: null },
    );

    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/send')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.code).toBe('CAMPAIGN_SENT'); // #550 envelope
    expect(res.body.sent).toBe(2);
    expect(res.body.failed).toBe(0);
    // Side effect: campaign flipped to Completed
    expect(fakePrisma.state.campaigns[0].status).toBe('Completed');
    // Side effect: an EmailMessage row was created per recipient
    expect(fakePrisma.state.emails).toHaveLength(2);
    // Side effect: an audit row was written
    expect(fakePrisma.state.audits).toHaveLength(1);
    expect(fakePrisma.state.audits[0].action).toBe('UPDATE');
    expect(fakePrisma.state.audits[0].entity).toBe('Campaign');
  });

  test('returns 409 when campaign is already Sending', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'InFlight', tenantId: 1, channel: 'EMAIL', status: 'Sending',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/send')
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already being sent/i);
  });

  test('returns 409 when campaign is already Completed', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Done', tenantId: 1, channel: 'EMAIL', status: 'Completed',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/send')
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been sent/i);
  });

  test('cross-tenant send returns 404', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'NotMine', tenantId: 99, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/send')
      .send({});
    expect(res.status).toBe(404);
  });

  test('zero-audience send still completes (status flips to Completed, sent=0)', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Empty', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    // No contacts in tenant 1.
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/send')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(0);
    expect(fakePrisma.state.campaigns[0].status).toBe('Completed');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7 — POST /campaigns/:id/schedule + /pause: scheduleFilters JSON-string
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/marketing/campaigns/:id/schedule — schedule + scheduleFilters JSON-string column (#646 standing rule)', () => {
  test('persists scheduledAt + scheduleStatus=PENDING and stringifies filters', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Sched', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/schedule')
      .send({ scheduledAt: future, filters: { status: 'Lead', source: 'IndiaMART' } });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('scheduled');
    expect(res.body.code).toBe('CAMPAIGN_SCHEDULED'); // #550

    const row = fakePrisma.state.campaigns[0];
    expect(row.status).toBe('Scheduled');
    expect(row.scheduleStatus).toBe('PENDING');
    expect(row.scheduledAt).toBeInstanceOf(Date);
    // scheduleFilters is a String? @db.Text column — must be JSON-stringified
    // not stored as a raw object. (#646 standing rule — JSON-string columns
    // get stringified at the call site, not by the helper.)
    expect(typeof row.scheduleFilters).toBe('string');
    const parsed = JSON.parse(row.scheduleFilters);
    expect(parsed.status).toBe('Lead');
    expect(parsed.source).toBe('IndiaMART');
  });

  test('rejects missing scheduledAt with 400', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Sched', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/schedule')
      .send({ filters: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scheduledAt/i);
  });

  test('rejects invalid scheduledAt with 400', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Sched', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/schedule')
      .send({ scheduledAt: 'not-a-date' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid scheduledAt/i);
  });

  test('HTML in filters.body is sanitized via the safe-list HTML allow-list (#596)', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Sched', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/schedule')
      .send({
        scheduledAt: future,
        filters: {
          subject: '<script>alert(1)</script>Hi',
          body: '<p>Hello</p><script>alert(2)</script><a href="https://example.com">link</a>',
        },
      });

    expect(res.status).toBe(200);
    const parsed = JSON.parse(fakePrisma.state.campaigns[0].scheduleFilters);
    // subject went through strict sanitizeText (no tags allowed)
    expect(parsed.subject).not.toContain('<script>');
    // body went through sanitizeHtmlBody (safe-list HTML allowed)
    expect(parsed.body).toContain('<p>');
    expect(parsed.body).toContain('<a');
    expect(parsed.body).not.toContain('<script>');
  });
});

describe('POST /api/marketing/campaigns/:id/pause — cancel schedule (closes #412 paired with /schedule)', () => {
  test('pauses a scheduled campaign — status=Draft, scheduleStatus=CANCELLED', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Sched', tenantId: 1, channel: 'EMAIL', status: 'Scheduled',
      scheduleStatus: 'PENDING', scheduledAt: new Date(),
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/pause')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paused');
    expect(res.body.code).toBe('CAMPAIGN_PAUSED'); // #550

    const row = fakePrisma.state.campaigns[0];
    expect(row.status).toBe('Draft');
    expect(row.scheduleStatus).toBe('CANCELLED');
    // scheduledAt preserved for audit
    expect(row.scheduledAt).toBeDefined();
  });

  test('cross-tenant pause returns 404', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'NotMine', tenantId: 99, channel: 'EMAIL', status: 'Scheduled',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/pause')
      .send({});
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8 — POST /campaigns/run: ADMIN-only manual trigger (G-12 mirror)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/marketing/campaigns/run — manual trigger (G-12 admin mirror)', () => {
  test('admin trigger returns {success, tenantId, processed, dispatched, skipped, errors}', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'Due', tenantId: 1, channel: 'EMAIL', status: 'Scheduled',
      scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING',
    });
    fakePrisma.state.campaigns.push({
      id: 2, name: 'Future', tenantId: 1, channel: 'EMAIL', status: 'Scheduled',
      scheduledAt: new Date(Date.now() + 3600_000), scheduleStatus: 'PENDING',
    });

    const res = await request(makeApp())
      .post('/api/marketing/campaigns/run')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe(1);
    expect(res.body.processed).toBe(2);
    expect(res.body.dispatched).toBe(1); // the due one
    expect(res.body.skipped).toBe(1);    // the future one
    expect(Array.isArray(res.body.errors)).toBe(true);
  });

  test('non-admin user gets 403 RBAC_DENIED', async () => {
    currentUser = { userId: 1, tenantId: 1, role: 'USER' };
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/run')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('RBAC_DENIED');
  });

  test('only walks rows for the requesting tenant (cross-tenant isolation)', async () => {
    fakePrisma.state.campaigns.push(
      { id: 1, name: 'Mine', tenantId: 1, status: 'Scheduled',
        scheduledAt: new Date(Date.now() + 3600_000), scheduleStatus: 'PENDING' },
      { id: 2, name: 'OtherTenant', tenantId: 99, status: 'Scheduled',
        scheduledAt: new Date(Date.now() - 60_000), scheduleStatus: 'PENDING' },
    );

    const res = await request(makeApp())
      .post('/api/marketing/campaigns/run')
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.processed).toBe(1); // only the tenantId=1 row
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 9 — Audience preview + count (POST /audience + GET /audience/count)
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/marketing/campaigns/:id/audience — preview', () => {
  test('returns {count, sampleContacts, filters} for EMAIL campaign (email-required)', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'C', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    fakePrisma.state.contacts.push(
      { id: 100, tenantId: 1, email: 'a@x.com', phone: null, name: 'A', status: 'Lead', aiScore: 50 },
      { id: 101, tenantId: 1, email: '', phone: '+10', name: 'NoEmail', status: 'Lead', aiScore: 30 },
    );

    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/audience')
      .send({ filters: {} });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // only the one with email != ''
    expect(Array.isArray(res.body.sampleContacts)).toBe(true);
    expect(res.body.filters).toEqual({});
  });

  test('cross-tenant audience preview returns 404', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'NotMine', tenantId: 99, channel: 'EMAIL', status: 'Draft',
    });
    const res = await request(makeApp())
      .post('/api/marketing/campaigns/1/audience')
      .send({ filters: {} });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/marketing/campaigns/:id/audience/count — quick count', () => {
  test('returns {count} of channel-eligible contacts', async () => {
    fakePrisma.state.campaigns.push({
      id: 1, name: 'C', tenantId: 1, channel: 'EMAIL', status: 'Draft',
    });
    fakePrisma.state.contacts.push(
      { id: 100, tenantId: 1, email: 'a@x.com', phone: null },
      { id: 101, tenantId: 1, email: '', phone: '+10' },
    );
    const res = await request(makeApp()).get('/api/marketing/campaigns/1/audience/count');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 10 — Auth gate: no token → 401
// ─────────────────────────────────────────────────────────────────────────

describe('Auth gate', () => {
  test('GET /campaigns with no token returns 401', async () => {
    authActive = false;
    const res = await request(makeApp()).get('/api/marketing/campaigns');
    expect(res.status).toBe(401);
  });

  test('POST /campaigns with no token returns 401', async () => {
    authActive = false;
    const res = await request(makeApp())
      .post('/api/marketing/campaigns')
      .send({ name: 'X', channel: 'EMAIL' });
    expect(res.status).toBe(401);
  });

  test('public POST /submit does NOT require a token (form ingestion is unauth)', async () => {
    authActive = false;
    const res = await request(makeApp())
      .post('/api/marketing/submit')
      .send({ formId: 'lead-form', name: 'Alice Webb', email: 'alice@example.com', company_name: 'Acme Inc' });
    // Should NOT be 401 — the /submit route is mounted before verifyToken.
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    // Side effect: contact + deal rows created
    expect(fakePrisma.state.contacts.length).toBeGreaterThanOrEqual(1);
    expect(fakePrisma.state.deals.length).toBeGreaterThanOrEqual(1);
  });
});
