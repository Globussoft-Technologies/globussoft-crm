// @ts-check
/**
 * Arc 2 #904 slice 8 — GET /api/contacts ?source=<prefix> server-side filter.
 *
 * Pins the new prefix-filter contract added to backend/routes/contacts.js
 * (line ~155). Replaces the STUB client-side `source.startsWith('inbound:')`
 * scan in InboundLeads.jsx (slice 7, 56f549f7) — that scan was bounded by
 * the route's ?limit=100 page-size + the 500-row hard cap (#172), so any
 * tenant with >500 contacts silently dropped inbound rows from the
 * Inbound-Leads page. Pushing the predicate into Prisma via `startsWith`
 * removes the coverage hole.
 *
 * Contracts pinned
 * ────────────────
 *   - Without ?source param → no where.source key set; existing behaviour
 *     preserved (verified via the spied prisma.contact.findMany call args).
 *   - ?source=inbound → where.source = { startsWith: "inbound" }.
 *   - ?source=inbound:voyagr (multi-segment prefix) → where.source =
 *     { startsWith: "inbound:voyagr" }.
 *   - ?source= (empty string) → 400 INVALID_SOURCE; findMany NOT called.
 *   - ?source=<129-char string> → 400 INVALID_SOURCE; findMany NOT called.
 *   - ?source=<128-char string> (boundary) → 200 + filter applied.
 *   - Tenant scope is still applied alongside the source filter (defence
 *     against the source filter accidentally widening to cross-tenant).
 *   - Combined with ?status=Lead — both filters present in the same where.
 *   - Response shape unchanged — the route returns the same contact array
 *     (filterReadFields no-ops because fieldPermission.findMany returns []).
 *   - 500 envelope on prisma error (no source-filter-specific 500 path).
 *
 * Decisions
 * ─────────
 *   - "?source= (empty)" is treated as PRESENT-but-invalid (400) rather
 *     than "absent → no filter". `req.query.source` is `""` when the
 *     querystring contains `source=` with nothing after `=`; that's a
 *     caller signalling intent to filter and failing — surfacing the
 *     mistake via 400 is more honest than silently returning every row.
 *   - "?source" with no `=` at all is also `""` in Express; same handling
 *     applies (caller typo'd the URL, 400 INVALID_SOURCE).
 *   - "?source=foo&source=bar" yields an array — `typeof !== 'string'` so
 *     prefix becomes '' and 400 INVALID_SOURCE fires. Documented above
 *     ("typeof check defends against array shape").
 *
 * Pattern reference: backend/test/routes/billing.test.js (auth middleware
 * pass-through + prisma singleton monkey-patch + supertest against the
 * mounted router). Per CLAUDE.md standing rule, JWT key is userId not id.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

// Patch auth middleware BEFORE requiring the router so the route's
// `const { verifyToken, verifyRole } = require(...)` destructures land on
// pass-through fns. We inject req.user via the test's express middleware.
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// Prisma singleton patching — the route touches contact + (transitively, via
// filterReadFields) fieldPermission. Stub fieldPermission.findMany to return
// [] so filterReadFields is a no-op pass-through.
prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);

import express from 'express';
import request from 'supertest';
const contactsRouter = requireCJS('../../routes/contacts');

const SAMPLE_CONTACT = {
  id: 9001,
  name: 'Amita Rao',
  email: 'amita@example.com',
  phone: '+919876543210',
  status: 'Lead',
  source: 'inbound:voyagr',
  tenantId: 1,
  assignedToId: 7,
  deletedAt: null,
  activities: [],
  tasks: [],
  assignedTo: null,
};

function makeApp({ tenantId = 1, userId = 7, role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role };
    next();
  });
  app.use('/api/contacts', contactsRouter);
  return app;
}

beforeEach(() => {
  prisma.contact.findMany.mockReset().mockResolvedValue([SAMPLE_CONTACT]);
});

describe('GET /api/contacts ?source=<prefix> — server-side filter', () => {
  test('absent ?source → no where.source key set; existing behaviour preserved', async () => {
    const res = await request(makeApp()).get('/api/contacts');

    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('source');
    expect(call.where.tenantId).toBe(1);
  });

  test('?source=inbound → where.source = { startsWith: "inbound" }', async () => {
    const res = await request(makeApp()).get('/api/contacts?source=inbound');

    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.source).toEqual({ startsWith: 'inbound' });
  });

  test('?source=inbound:voyagr (multi-segment prefix) → startsWith preserves the colon', async () => {
    const res = await request(makeApp()).get('/api/contacts?source=inbound:voyagr');

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.source).toEqual({ startsWith: 'inbound:voyagr' });
  });

  test('?source= (empty string) → 400 INVALID_SOURCE; findMany NOT called', async () => {
    const res = await request(makeApp()).get('/api/contacts?source=');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SOURCE', field: 'source' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('?source=<129-char string> → 400 INVALID_SOURCE; findMany NOT called', async () => {
    const tooLong = 'x'.repeat(129);
    const res = await request(makeApp()).get(`/api/contacts?source=${tooLong}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SOURCE' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('?source=<128-char boundary string> → 200, filter applied', async () => {
    const boundary = 'x'.repeat(128);
    const res = await request(makeApp()).get(`/api/contacts?source=${boundary}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.source).toEqual({ startsWith: boundary });
  });

  test('tenant scope is preserved alongside the source filter', async () => {
    const res = await request(makeApp({ tenantId: 42 })).get('/api/contacts?source=inbound');

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(42);
    expect(call.where.source).toEqual({ startsWith: 'inbound' });
  });

  test('combined with ?status=Lead → both filters present in the same where', async () => {
    const res = await request(makeApp()).get('/api/contacts?source=inbound&status=Lead');

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.source).toEqual({ startsWith: 'inbound' });
    expect(call.where.status).toBe('Lead');
    expect(call.where.tenantId).toBe(1);
  });

  test('response shape unchanged — returns the contact array as before', async () => {
    const res = await request(makeApp()).get('/api/contacts?source=inbound');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: SAMPLE_CONTACT.id,
      name: SAMPLE_CONTACT.name,
      email: SAMPLE_CONTACT.email,
      source: SAMPLE_CONTACT.source,
    });
  });

  test('500 envelope on prisma error', async () => {
    prisma.contact.findMany.mockReset().mockRejectedValue(new Error('boom'));
    const res = await request(makeApp()).get('/api/contacts?source=inbound');

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Failed to fetch contacts' });
  });

  test('?source=foo&source=bar (duplicate-key array) → 400 INVALID_SOURCE (typeof !== "string" defence)', async () => {
    const res = await request(makeApp()).get('/api/contacts?source=foo&source=bar');

    // Express parses duplicate query keys into an array. Our typeof check
    // converts the array to '' which fails the length>=1 gate. Documents
    // that the only supported shape is a single string prefix.
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_SOURCE' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });
});
