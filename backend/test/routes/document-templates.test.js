// @ts-check
/**
 * Unit tests for backend/routes/document_templates.js — pin the contract of
 * the document-template CRUD + variable-substitution + render/render-pdf +
 * send-email surface.
 *
 * Why this file exists
 * ────────────────────
 * routes/document_templates.js (367 LOC) had ZERO vitest coverage prior to
 * this file. It owns the DocumentTemplate CRUD (GET / POST / PUT / DELETE),
 * the /:id/render endpoint that substitutes {{contact.name}}-style mustache
 * placeholders against contact/deal/tenant/user variable maps, the
 * /:id/render-pdf endpoint that wraps the rendered HTML with a print
 * stylesheet for client-side window.print() → PDF, and /:id/send-email
 * that renders + Mailgun-dispatches + logs an EmailMessage row + emits a
 * socket.io event. Silent contract drift on any of these would either red
 * the proposal-send flow (used in Deal detail → Send Proposal) OR (worse)
 * leak HTML across tenants by failing to honour the tenantId scope on the
 * template lookup. Pin the wire shape now.
 *
 * Endpoints under test
 * ────────────────────
 *   1. GET    /                       — list (tenant-scoped + ?type filter)
 *   2. POST   /                       — create (name + content required)
 *   3. GET    /:id                    — get-one (cross-tenant 404)
 *   4. PUT    /:id                    — partial update (cross-tenant 404)
 *   5. DELETE /:id                    — soft delete via prisma.delete
 *   6. POST   /:id/render             — substitute variables, return HTML
 *   7. POST   /:id/render-pdf         — wrap rendered HTML in print CSS
 *   8. POST   /:id/send-email         — render + Mailgun + log EmailMessage
 *
 * Cases (15 total)
 * ────────────────
 *   list: tenant-scoped findMany + ordering (1); ?type= filter (1)
 *   get-one: 404 cross-tenant (1); 200 happy path (1)
 *   create: 400 missing name (1); 400 missing content (1); 201 happy with
 *     defaults + variables JSON-stringified (1)
 *   update: 404 cross-tenant (1); 200 partial update (1)
 *   delete: 404 cross-tenant (1); 200 success envelope (1)
 *   render: 404 cross-tenant (1); substitutes {{contact.name}} from
 *     variable map + leaves unknown placeholders verbatim (1)
 *   render-pdf: wraps rendered HTML in <!doctype> + print CSS shell (1)
 *   send-email: 400 missing subject (1)
 *
 * Test pattern
 * ────────────
 * Mirrors backend/test/routes/sla.test.js — prisma singleton monkey-patch
 * BEFORE requiring the router + fake-auth middleware in makeApp that
 * populates req.user with { userId, tenantId, role }. The route doesn't
 * call eventBus / verifyRole directly (the global guard handles auth at
 * server.js level), so makeApp's middleware is the only auth seam needed.
 *
 * Mailgun is stubbed via global.fetch — the route uses the Node 18 built-in
 * fetch() for its Mailgun POST. We replace globalThis.fetch with a vi.fn()
 * that returns a minimal Response shape; afterAll restores the real one.
 */

import { describe, test, expect, beforeEach, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// ── prisma singleton patching ──────────────────────────────────────────
const prisma = requireCJS('../../lib/prisma');

prisma.documentTemplate = prisma.documentTemplate || {};
prisma.documentTemplate.findMany = vi.fn();
prisma.documentTemplate.findFirst = vi.fn();
prisma.documentTemplate.create = vi.fn();
prisma.documentTemplate.update = vi.fn();
prisma.documentTemplate.delete = vi.fn();

prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();

prisma.deal = prisma.deal || {};
prisma.deal.findFirst = vi.fn();

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();

prisma.emailMessage = prisma.emailMessage || {};
prisma.emailMessage.create = vi.fn();

prisma.activity = prisma.activity || {};
prisma.activity.create = vi.fn();

// ── fetch stub (Mailgun POST) ──────────────────────────────────────────
const realFetch = globalThis.fetch;
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

import express from 'express';
import request from 'supertest';

const docTemplatesRouter = requireCJS('../../routes/document_templates');

/**
 * Build an express app with a fake-auth middleware so the router sees
 * req.user populated. No RBAC gates on this route — all endpoints are
 * accessible to any authenticated user behind the global guard.
 */
function makeApp({ tenantId = 1, userId = 7, role = 'USER' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/document-templates', docTemplatesRouter);
  return app;
}

beforeEach(() => {
  prisma.documentTemplate.findMany.mockReset();
  prisma.documentTemplate.findFirst.mockReset();
  prisma.documentTemplate.create.mockReset();
  prisma.documentTemplate.update.mockReset();
  prisma.documentTemplate.delete.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.deal.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.user.findUnique.mockReset();
  prisma.emailMessage.create.mockReset();
  prisma.activity.create.mockReset();
  fetchMock.mockReset();

  // Sensible defaults — individual tests override.
  prisma.documentTemplate.findMany.mockResolvedValue([]);
  prisma.documentTemplate.findFirst.mockResolvedValue(null);
  prisma.documentTemplate.create.mockResolvedValue({ id: 1 });
  prisma.documentTemplate.update.mockResolvedValue({ id: 1 });
  prisma.documentTemplate.delete.mockResolvedValue({ id: 1 });
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.deal.findFirst.mockResolvedValue(null);
  prisma.tenant.findUnique.mockResolvedValue(null);
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.emailMessage.create.mockResolvedValue({ id: 999 });
  prisma.activity.create.mockResolvedValue({ id: 1 });
  // Default fetch returns success (only matters for send-email; Mailgun
  // key is unset by default so sendMailgun short-circuits).
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ id: 'mailgun-msg-id' }),
    text: async () => 'ok',
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

// ─────────────────────────────────────────────────────────────────────────
// GET / — list templates
// ─────────────────────────────────────────────────────────────────────────

describe('GET / — list document templates', () => {
  test('200 with tenant-scoped findMany ordered by updatedAt desc', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { id: 1, name: 'Sales Proposal', type: 'PROPOSAL', tenantId: 42 },
      { id: 2, name: 'NDA Standard', type: 'NDA', tenantId: 42 },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/document-templates');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(prisma.documentTemplate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42 },
      orderBy: { updatedAt: 'desc' },
    });
  });

  test('200 with ?type=NDA filter narrows the where clause', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { id: 2, name: 'NDA Standard', type: 'NDA', tenantId: 1 },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/document-templates?type=NDA');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prisma.documentTemplate.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, type: 'NDA' },
      orderBy: { updatedAt: 'desc' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — get one
// ─────────────────────────────────────────────────────────────────────────

describe('GET /:id — get one template', () => {
  test('404 when template belongs to a different tenant (findFirst returns null)', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/document-templates/777');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.documentTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
  });

  test('200 returns the template when found within tenant scope', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue({
      id: 50,
      name: 'Quarterly Review',
      type: 'PROPOSAL',
      content: '<p>Hi {{contact.name}}</p>',
      tenantId: 1,
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/document-templates/50');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(50);
    expect(res.body.name).toBe('Quarterly Review');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create
// ─────────────────────────────────────────────────────────────────────────

describe('POST / — create template', () => {
  test('400 when name missing', async () => {
    const res = await request(makeApp())
      .post('/api/document-templates')
      .send({ content: '<p>Hello</p>' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and content/i);
    expect(prisma.documentTemplate.create).not.toHaveBeenCalled();
  });

  test('400 when content missing', async () => {
    const res = await request(makeApp())
      .post('/api/document-templates')
      .send({ name: 'Proposal' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name and content/i);
    expect(prisma.documentTemplate.create).not.toHaveBeenCalled();
  });

  test('201 with defaults: type=PROPOSAL, variables JSON-stringified, tenantId from JWT', async () => {
    prisma.documentTemplate.create.mockResolvedValue({
      id: 99,
      name: 'Sales Proposal',
      type: 'PROPOSAL',
      content: '<p>Hello</p>',
      tenantId: 42,
    });

    const res = await request(makeApp({ tenantId: 42 }))
      .post('/api/document-templates')
      .send({
        name: 'Sales Proposal',
        content: '<p>Hello {{contact.name}}</p>',
        variables: ['contact.name', 'contact.email'],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(99);
    const createArg = prisma.documentTemplate.create.mock.calls[0][0].data;
    expect(createArg.name).toBe('Sales Proposal');
    expect(createArg.type).toBe('PROPOSAL'); // default
    expect(createArg.content).toBe('<p>Hello {{contact.name}}</p>');
    // Array variables must be JSON-stringified for the @db.Text column.
    expect(createArg.variables).toBe(JSON.stringify(['contact.name', 'contact.email']));
    expect(createArg.tenantId).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — partial update
// ─────────────────────────────────────────────────────────────────────────

describe('PUT /:id — update template', () => {
  test('404 when template belongs to a different tenant', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/document-templates/777')
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(prisma.documentTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.documentTemplate.update).not.toHaveBeenCalled();
  });

  test('200 partial update: only supplied fields are written', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      name: 'Old Name',
      type: 'PROPOSAL',
      content: '<p>old</p>',
    });
    prisma.documentTemplate.update.mockResolvedValue({
      id: 50,
      name: 'Renamed',
      type: 'PROPOSAL',
      content: '<p>old</p>',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .put('/api/document-templates/50')
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(prisma.documentTemplate.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: { name: 'Renamed' },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id
// ─────────────────────────────────────────────────────────────────────────

describe('DELETE /:id — delete template', () => {
  test('404 when template belongs to a different tenant', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/document-templates/777');

    expect(res.status).toBe(404);
    expect(prisma.documentTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 777, tenantId: 1 },
    });
    expect(prisma.documentTemplate.delete).not.toHaveBeenCalled();
  });

  test('200 { success: true } on successful delete', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue({ id: 50, tenantId: 1 });
    prisma.documentTemplate.delete.mockResolvedValue({ id: 50 });

    const res = await request(makeApp({ tenantId: 1 }))
      .delete('/api/document-templates/50');

    // NOTE: the route returns 200 + { success: true } — it has NOT been
    // migrated to 204 No Content via the #550 sweep yet. Pin the current
    // contract; if the route adopts 204 later, update this assertion in
    // the same commit that changes the route.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(prisma.documentTemplate.delete).toHaveBeenCalledWith({ where: { id: 50 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/render — variable substitution
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/render — render with variable substitution', () => {
  test('404 when template belongs to a different tenant', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/document-templates/777/render')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('200 substitutes {{contact.name}} + {{deal.title}} + leaves unknown placeholders verbatim', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      name: 'Proposal',
      type: 'PROPOSAL',
      content:
        'Dear {{contact.name}}, your deal {{deal.title}} for {{deal.amount}} is ready. ' +
        'Sent by {{user.name}} on {{date.today}}. {{unknown.placeholder}} stays put.',
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 10,
      tenantId: 1,
      name: 'Rishu Mehta',
      email: 'rishu@enhancedwellness.in',
      phone: '+919876543210',
      company: 'Enhanced Wellness',
      title: 'Founder',
      status: 'ACTIVE',
      industry: 'Wellness',
      website: 'https://enhancedwellness.in',
    });
    prisma.deal.findFirst.mockResolvedValue({
      id: 20,
      tenantId: 1,
      title: 'Q3 Expansion',
      amount: 50000,
      currency: 'INR',
      stage: 'Negotiation',
      probability: 70,
    });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, name: 'Enhanced Wellness', plan: 'PRO',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 7, name: 'Sumit Goel', email: 'sumit@globussoft.com', role: 'ADMIN',
    });

    const res = await request(makeApp({ tenantId: 1, userId: 7 }))
      .post('/api/document-templates/50/render')
      .send({ contactId: 10, dealId: 20 });

    expect(res.status).toBe(200);
    expect(res.body.template).toEqual({ id: 50, name: 'Proposal', type: 'PROPOSAL' });
    // Verify substitution.
    expect(res.body.html).toContain('Dear Rishu Mehta');
    expect(res.body.html).toContain('your deal Q3 Expansion');
    expect(res.body.html).toContain('for 50000');
    expect(res.body.html).toContain('Sent by Sumit Goel');
    // Unknown placeholders are left verbatim (no key match).
    expect(res.body.html).toContain('{{unknown.placeholder}}');
    // Variable map is exposed for the frontend preview pane.
    expect(res.body.variables['contact.name']).toBe('Rishu Mehta');
    expect(res.body.variables['deal.amount']).toBe('50000');
    expect(res.body.variables['date.today']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Tenant scope was applied to both contact + deal lookups.
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: { id: 10, tenantId: 1 },
    });
    expect(prisma.deal.findFirst).toHaveBeenCalledWith({
      where: { id: 20, tenantId: 1 },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/render-pdf — print-CSS wrapper
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/render-pdf — wrap rendered HTML in print stylesheet', () => {
  test('200 wraps rendered body in <!doctype> + @page CSS + downloadable filename', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue({
      id: 50,
      tenantId: 1,
      name: 'Sales Proposal',
      type: 'PROPOSAL',
      content: '<p>Hello {{contact.name}}</p>',
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 10, tenantId: 1, name: 'Anita Sharma',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/document-templates/50/render-pdf')
      .send({ contactId: 10 });

    expect(res.status).toBe(200);
    expect(res.body.downloadable).toBe(true);
    // Spaces in the template name get _-substituted in the filename.
    expect(res.body.filename).toBe('Sales_Proposal.html');
    // Wrapper shape — doctype, print @page rule, rendered body.
    expect(res.body.html).toMatch(/^<!doctype html>/i);
    expect(res.body.html).toContain('@page { size: A4');
    expect(res.body.html).toContain('<p>Hello Anita Sharma</p>');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/send-email — render + Mailgun + EmailMessage log
// ─────────────────────────────────────────────────────────────────────────

describe('POST /:id/send-email — render + dispatch via Mailgun', () => {
  test('400 when subject missing (after template found)', async () => {
    prisma.documentTemplate.findFirst.mockResolvedValue({
      id: 50, tenantId: 1, name: 'Proposal', content: '<p>Hi</p>',
    });

    const res = await request(makeApp({ tenantId: 1 }))
      .post('/api/document-templates/50/send-email')
      .send({ to: 'someone@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subject/i);
    // Critically: no EmailMessage row written when the request is rejected.
    expect(prisma.emailMessage.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /?fields=summary — slim-shape opt-in (#920 slice 36)
// ─────────────────────────────────────────────────────────────────────────
//
// Mirrors the slim-shape contract pinned in slices 1-33. The default (no
// ?fields) path continues to return the full row including content + variables
// JSON. The ?fields=summary path drops the heavy content @db.LongText column
// + variables @db.Text + tenantId + createdAt, passing a `select` to Prisma
// so the wire payload (and the DB read) stay narrow. Anything other than the
// exact string "summary" is treated as default (no `select` key forwarded).
describe('GET /?fields=summary — slim-shape opt-in', () => {
  test('omitted ?fields returns full row with content + variables (no select forwarded)', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Sales Proposal',
        type: 'PROPOSAL',
        content: '<p>Hello {{contact.name}}</p>',
        variables: '["contact.name"]',
        tenantId: 42,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-15T00:00:00Z'),
      },
    ]);

    const res = await request(makeApp({ tenantId: 42 })).get('/api/document-templates');

    expect(res.status).toBe(200);
    expect(res.body[0].content).toBe('<p>Hello {{contact.name}}</p>');
    expect(res.body[0].variables).toBe('["contact.name"]');
    // No `select` key forwarded — full-row default path.
    const arg = prisma.documentTemplate.findMany.mock.calls[0][0];
    expect(arg.select).toBeUndefined();
    expect(arg).toEqual({
      where: { tenantId: 42 },
      orderBy: { updatedAt: 'desc' },
    });
  });

  test('?fields=summary forwards select with id+name+type+updatedAt only', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { id: 1, name: 'Sales Proposal', type: 'PROPOSAL', updatedAt: new Date('2026-01-15T00:00:00Z') },
      { id: 2, name: 'NDA Standard', type: 'NDA', updatedAt: new Date('2026-01-10T00:00:00Z') },
    ]);

    const res = await request(makeApp({ tenantId: 42 }))
      .get('/api/document-templates?fields=summary');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const arg = prisma.documentTemplate.findMany.mock.calls[0][0];
    // Heavy content + variables + tenantId + createdAt MUST NOT be in select.
    expect(arg.select).toEqual({
      id: true,
      name: true,
      type: true,
      updatedAt: true,
    });
    expect(arg.select.content).toBeUndefined();
    expect(arg.select.variables).toBeUndefined();
    expect(arg.select.tenantId).toBeUndefined();
    expect(arg.select.createdAt).toBeUndefined();
    // where + orderBy unchanged from default path.
    expect(arg.where).toEqual({ tenantId: 42 });
    expect(arg.orderBy).toEqual({ updatedAt: 'desc' });
  });

  test('?fields=summary composes with ?type filter — both narrow the read', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([
      { id: 2, name: 'NDA Standard', type: 'NDA', updatedAt: new Date('2026-01-10T00:00:00Z') },
    ]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/document-templates?fields=summary&type=NDA');

    expect(res.status).toBe(200);
    const arg = prisma.documentTemplate.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: 1, type: 'NDA' });
    expect(arg.select).toEqual({
      id: true,
      name: true,
      type: true,
      updatedAt: true,
    });
  });

  test('?fields=full (anything not exactly "summary") falls back to default full-row shape', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/document-templates?fields=full');

    expect(res.status).toBe(200);
    const arg = prisma.documentTemplate.findMany.mock.calls[0][0];
    // Exact-string gate: only "summary" trips the slim branch.
    expect(arg.select).toBeUndefined();
  });

  test('?fields=SUMMARY (uppercase) is treated as default — case-sensitive gate', async () => {
    prisma.documentTemplate.findMany.mockResolvedValue([]);

    const res = await request(makeApp({ tenantId: 1 }))
      .get('/api/document-templates?fields=SUMMARY');

    expect(res.status).toBe(200);
    const arg = prisma.documentTemplate.findMany.mock.calls[0][0];
    // The gate is `req.query.fields === "summary"` (case-sensitive). Pin
    // the contract so a future refactor to .toLowerCase() shows up as a
    // deliberate spec edit, not a silent behaviour change.
    expect(arg.select).toBeUndefined();
  });
});
