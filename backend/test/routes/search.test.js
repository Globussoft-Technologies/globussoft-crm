// @ts-check
/**
 * Unit tests for backend/routes/search.js — global search contract pin.
 *
 * Why this file exists (regression class)
 * ───────────────────────────────────────
 *   routes/search.js is 65 LOC and powers the global Omnibar / CommandPalette
 *   "search across everything" surface — a single GET /api/search?q=<term>
 *   fans out to 10 Prisma models (Contact, Deal, Invoice, Ticket, Task,
 *   Project, Contract, Estimate, EmailMessage, KbArticle) in parallel,
 *   each tenant-scoped + capped at take=5, and returns a single envelope
 *   with a `totalResults` aggregate. Before this file the route had ZERO
 *   vitest-level coverage — only indirect e2e probes.
 *
 *   The route is small but load-bearing: the envelope KEY names map 1:1 to
 *   the frontend Omnibar's result categories. A silent rename of `kbArticles`
 *   → `articles` (the kind of "cleanup" a refactor agent might make) would
 *   blank out the KB section of the Omnibar with no JS error. This pin
 *   freezes the 10 envelope keys + the totalResults sum + the take=5 cap
 *   so any such rename trips the gate.
 *
 * What this file pins (8 cases)
 * ─────────────────────────────
 *   1. happy path with ?q=<term> → 200 + envelope contains every one of
 *      the 10 model keys + totalResults equals the sum of the 10 array
 *      lengths (the pin against a silent envelope-shape change)
 *   2. empty query (`?q=`) → 200 + body is an empty object {} (NOT a 400;
 *      pinned because the SUT explicitly short-circuits with `res.json({})`)
 *   3. whitespace-only query (`?q=   `) → same as empty: 200 + {} (the
 *      SUT calls `.trim()` before the length check)
 *   4. missing query param entirely (`/api/search` with no q) → same as
 *      empty: 200 + {} (defaults to "")
 *   5. tenant-scoped: every prisma findMany is invoked with
 *      where.tenantId === caller's tenantId (the pin against a cross-tenant
 *      leak the moment someone touches the where clause)
 *   6. take=5 cap honored across ALL 10 model calls (the pin against the
 *      "let me bump this to 25" refactor — Omnibar's UI was sized for 5)
 *   7. auth gate: no Authorization header → 401 via the REAL verifyToken
 *      middleware (CLAUDE.md standing rule for new specs)
 *   8. handler error → 500 { error: "Search failed" } (catch-all envelope
 *      stays neutral; no internal error.message leak)
 *
 * Test pattern
 * ────────────
 *   CJS self-mocking via require-cache injection: patch lib/eventBus
 *   (#937 prevention — even though search.js does not emit, the require
 *   chain pulls eventBus transitively via lib/prisma → fieldEncryption →
 *   nothing-eventBus today, but the defensive mock costs nothing and
 *   prevents future surprise). Patch middleware/auth so most tests
 *   bypass the JWT check; flip the switch on test 7 to exercise the real
 *   verifyToken's 401 path. Mock every prisma model method the route
 *   touches (10 findMany calls). JWT key is `userId` not `id` per
 *   CLAUDE.md standing rule. Pure pin — no source changes.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── #937 prevention: patch lib/eventBus BEFORE the router is required ────
// search.js does not directly emit today, but the defensive mock keeps
// any future emit from cascading into an unhandled-rejection on no-DB CI.
const eventBusPath = requireCJS.resolve('../../lib/eventBus.js');
Module._cache[eventBusPath] = {
  id: eventBusPath,
  filename: eventBusPath,
  loaded: true,
  exports: {
    emitEvent: vi.fn().mockResolvedValue(undefined),
    onEvent: () => {},
    setIO: () => {},
    getIO: () => null,
  },
};

// ── Patch auth middleware. Keep a switch so test 7 can opt back into
//    the REAL verifyToken to exercise the no-token 401 path. ─────────────
const authMw = requireCJS('../../middleware/auth');
const realVerifyToken = authMw.verifyToken;
const authState = { useReal: false };
authMw.verifyToken = (req, res, next) => {
  if (authState.useReal) return realVerifyToken(req, res, next);
  return next();
};

// ── Prisma singleton patching — every model method search.js touches ────
const MODELS = [
  'contact',
  'deal',
  'invoice',
  'ticket',
  'task',
  'project',
  'contract',
  'estimate',
  'emailMessage',
  'kbArticle',
];
for (const m of MODELS) {
  prisma[m] = prisma[m] || {};
  prisma[m].findMany = vi.fn();
}

import express from 'express';
import request from 'supertest';
const searchRouter = requireCJS('../../routes/search');

const TENANT_ID = 1;
const USER_ID = 7;

/**
 * Mount the router behind a small middleware that stamps req.user. The
 * skipAuth flag (used by test 7) omits the stamp so the real verifyToken
 * sees no Authorization header.
 */
function makeApp({ tenantId = TENANT_ID, userId = USER_ID, role = 'ADMIN', skipAuth = false } = {}) {
  const app = express();
  app.use(express.json());
  if (!skipAuth) {
    app.use((req, _res, next) => {
      req.user = { userId, tenantId, role };
      next();
    });
  }
  app.use('/api/search', searchRouter);
  return app;
}

// Default fixture per model — one matching row each. Tests override per-case.
function defaultRowFor(model) {
  switch (model) {
    case 'contact':
      return { id: 1, name: 'Amita Rao', email: 'a@x.com', company: 'Globussoft', status: 'Lead' };
    case 'deal':
      return { id: 2, title: 'Enterprise rollout', amount: 50000, stage: 'Proposal' };
    case 'invoice':
      return { id: 3, invoiceNum: 'INV-001', contact: { name: 'Amita Rao' } };
    case 'ticket':
      return { id: 4, subject: 'Login issue', status: 'open', priority: 'high' };
    case 'task':
      return { id: 5, title: 'Call client', status: 'pending', priority: 'medium' };
    case 'project':
      return { id: 6, name: 'Migration sprint', status: 'active' };
    case 'contract':
      return { id: 7, title: 'MSA-2026', status: 'signed' };
    case 'estimate':
      return { id: 8, title: 'Q3 expansion', estimateNum: 'EST-009', status: 'sent' };
    case 'emailMessage':
      return { id: 9, subject: 'Re: kickoff', from: 'rohan@x.com', to: 'amita@x.com', direction: 'inbound', createdAt: new Date('2026-05-01').toISOString() };
    case 'kbArticle':
      return { id: 10, title: 'Login troubleshooting', slug: 'login-troubleshooting', isPublished: true };
    default:
      return { id: 0 };
  }
}

beforeEach(() => {
  for (const m of MODELS) {
    prisma[m].findMany.mockReset().mockResolvedValue([defaultRowFor(m)]);
  }
  authState.useReal = false;
});

// ─────────────────────────────────────────────────────────────────────
describe('GET /api/search — global search envelope', () => {
  test('1. happy path with ?q=test → 200 + all 10 envelope keys + totalResults equals sum of array lengths', async () => {
    const res = await request(makeApp()).get('/api/search?q=test');

    expect(res.status).toBe(200);
    // Envelope keys pin — these names map 1:1 to the frontend Omnibar.
    expect(res.body).toHaveProperty('contacts');
    expect(res.body).toHaveProperty('deals');
    expect(res.body).toHaveProperty('invoices');
    expect(res.body).toHaveProperty('tickets');
    expect(res.body).toHaveProperty('tasks');
    expect(res.body).toHaveProperty('projects');
    expect(res.body).toHaveProperty('contracts');
    expect(res.body).toHaveProperty('estimates');
    expect(res.body).toHaveProperty('emails');
    expect(res.body).toHaveProperty('kbArticles');
    expect(res.body).toHaveProperty('totalResults');

    // Each default fixture returns 1 row → totalResults must be 10.
    const computed =
      res.body.contacts.length +
      res.body.deals.length +
      res.body.invoices.length +
      res.body.tickets.length +
      res.body.tasks.length +
      res.body.projects.length +
      res.body.contracts.length +
      res.body.estimates.length +
      res.body.emails.length +
      res.body.kbArticles.length;
    expect(res.body.totalResults).toBe(computed);
    expect(res.body.totalResults).toBe(10);

    // Every model was queried exactly once.
    for (const m of MODELS) {
      expect(prisma[m].findMany).toHaveBeenCalledOnce();
    }
  });

  test('2. empty query (?q=) → 200 + body is {}; no prisma calls fired', async () => {
    const res = await request(makeApp()).get('/api/search?q=');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    for (const m of MODELS) {
      expect(prisma[m].findMany).not.toHaveBeenCalled();
    }
  });

  test('3. whitespace-only query (?q=%20%20%20) → 200 + {}; .trim() short-circuit', async () => {
    const res = await request(makeApp()).get('/api/search?q=%20%20%20');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    for (const m of MODELS) {
      expect(prisma[m].findMany).not.toHaveBeenCalled();
    }
  });

  test('4. missing query param entirely → 200 + {} (defaults to "")', async () => {
    const res = await request(makeApp()).get('/api/search');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  test('5. tenant-scoped — every findMany call carries where.tenantId === caller tenantId', async () => {
    const otherTenant = 42;
    const res = await request(makeApp({ tenantId: otherTenant })).get('/api/search?q=test');

    expect(res.status).toBe(200);
    for (const m of MODELS) {
      const args = prisma[m].findMany.mock.calls[0][0];
      expect(args.where.tenantId).toBe(otherTenant);
    }
  });

  test('6. take=5 cap honored across all 10 model calls (Omnibar UI sized for 5)', async () => {
    const res = await request(makeApp()).get('/api/search?q=test');

    expect(res.status).toBe(200);
    for (const m of MODELS) {
      const args = prisma[m].findMany.mock.calls[0][0];
      expect(args.take).toBe(5);
    }
  });

  test('7. auth gate — no Authorization header → 401 via real verifyToken', async () => {
    authState.useReal = true;
    const res = await request(makeApp({ skipAuth: true })).get('/api/search?q=test');

    expect(res.status).toBe(401);
    // Body shape: { error: "..." } — exact string is irrelevant, presence is the pin.
    expect(res.body).toHaveProperty('error');
    // WWW-Authenticate header asserted in middleware/auth: "Bearer".
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  test('8. handler error → 500 { error: "Search failed" } (neutral envelope; no .message leak)', async () => {
    // Force the first findMany to throw — Promise.all will reject; catch fires.
    prisma.contact.findMany.mockRejectedValueOnce(new Error('DB connection lost — internal detail'));

    const res = await request(makeApp()).get('/api/search?q=test');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Search failed' });
    // Negative pin: the internal error message MUST NOT appear in the body.
    expect(JSON.stringify(res.body)).not.toContain('DB connection lost');
  });
});
