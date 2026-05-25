// @ts-check
/**
 * Unit tests for backend/routes/ai.js — pins the AI email-assist surface
 * (draft, reply, subject-line generation). Three POST endpoints:
 *
 *   1. POST /draft          — context → generated email body. Optional
 *      contactId / recipientEmail enrichment pulls a tenant-scoped
 *      Contact (with deals + activities) into the prompt context.
 *      Tone defaults to "professional yet warm"; explicit tone is passed
 *      to Gemini verbatim. Gemini errors fall through to a template
 *      generator (generateFallbackDraft) and return `model:
 *      "fallback-on-error"`.
 *
 *   2. POST /reply          — originalEmail → reply draft. Body of the
 *      original email is truncated to 2000 chars before being inlined
 *      into the prompt (DOS prevention — bounds the upstream Gemini
 *      payload). Gemini errors return a fixed canned reply with
 *      `model: "fallback"`.
 *
 *   3. POST /subject-lines  — context → array of N candidate subjects
 *      (default N=5). Gemini output is split by newline, trimmed,
 *      filtered for empty lines, then sliced to N. Gemini errors
 *      return a templated 2-item fallback array using the supplied
 *      context.
 *
 * Pinned contracts (regression bait):
 *   - 400 envelope: { error: "Please provide a subject or context." }
 *     on /draft missing context; { error: "Original email content
 *     required." } on /reply; { error: "Context required." } on
 *     /subject-lines. Wording matters — frontend toasts read these.
 *   - Tenant scoping on Contact enrichment: where.tenantId === req.user.tenantId
 *     AND (where.id === parseInt(contactId) OR where.email === recipientEmail).
 *     A regression that drops tenantId would let cross-tenant Contact data
 *     leak into the LLM prompt.
 *   - contactId branch beats recipientEmail branch: when BOTH are present
 *     the route uses contactId and never falls into the recipientEmail
 *     else-if branch.
 *   - /reply truncates originalEmail to 2000 chars before prompt
 *     interpolation. Pinned via a 5000-char payload assertion that the
 *     prompt as inspected via the mock's call args is ≤ a sane upper bound.
 *   - /subject-lines slice cap respects body.count when provided, falls
 *     back to 5 when absent. Empty lines in the Gemini response are
 *     filtered out BEFORE the slice (so a noisy reply still produces N
 *     usable suggestions).
 *   - On Gemini error, /draft returns model="fallback-on-error", /reply
 *     returns model="fallback", /subject-lines returns 2-item array
 *     without a model field. These distinct envelopes let the frontend
 *     tell whether the AI ran or was bypassed.
 *
 * Pattern reference: backend/test/routes/ai-scoring.test.js for the
 * prisma singleton patch + req.user injection middleware; and
 * backend/test/cron/sentimentEngine.test.js for the Gemini hoisted
 * monkey-patch on @google/generative-ai (CJS require-cache + non-arrow
 * constructor — the engine does `new GoogleGenerativeAI(key)` so the
 * mock MUST be constructable).
 *
 * Mocking strategy:
 *   - @google/generative-ai: hoisted vi.hoisted() block that sets
 *     GEMINI_API_KEY BEFORE the route is required (the route's top-level
 *     `if (GEMINI_KEY) { genAI = new GoogleGenerativeAI(GEMINI_KEY); ... }`
 *     captures `model` ONCE at module load — without the key set BEFORE
 *     import, `model` stays null forever and every test falls through to
 *     the template fallback, defeating the Gemini-path coverage). Then
 *     monkey-patch the CJS export so `new GoogleGenerativeAI(...)` returns
 *     a stub whose `getGenerativeModel().generateContent` is a vi.fn() we
 *     swap per-test.
 *   - prisma: singleton patch on prisma.contact.findFirst BEFORE the
 *     router is required, same as ai-scoring.test.js. The route's
 *     top-level `require('../lib/prisma')` resolves to the same singleton
 *     because vitest.config.js inlines backend/routes/ via
 *     server.deps.inline.
 *   - verifyToken: bypassed by injecting req.user via a fake middleware
 *     before the router mounts; revokedToken.findUnique stubbed to
 *     resolve null defensively.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patch (must run BEFORE the router is required) ──────
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

// ─── Gemini SDK monkey-patch (must hoist BEFORE the route is required) ───
// See sentimentEngine.test.js for the canonical pattern + commit history.
// Critical asymmetries this block defends against:
//   (a) GEMINI_API_KEY must be truthy AT THE MOMENT the route module is
//       evaluated, because the route captures `model` ONCE at top-level.
//       In CI's unit_tests job no GEMINI_API_KEY is set in the env, so
//       we set it here unconditionally (the engine only checks truthiness;
//       our mock SDK ignores the value entirely).
//   (b) The SDK is consumed via CJS `require("@google/generative-ai")`
//       inside routes/ai.js. ESM `vi.mock('@google/generative-ai')` factories
//       do NOT intercept that require chain under this vitest setup
//       (server.deps.inline transforms routes/ via ESM but the SDK is
//       still resolved through CJS require-cache). Workaround: monkey-patch
//       the cached CJS export's GoogleGenerativeAI constructor via
//       createRequire inside vi.hoisted().
//   (c) The constructor must be a regular `function` (NOT an arrow) because
//       the route calls `new GoogleGenerativeAI(GEMINI_KEY)`. Arrow
//       functions throw TypeError on `new`, which the route's try/catch
//       would silently swallow — but the route's init is OUTSIDE the
//       try-catch (top-level module load), so an arrow-stub would crash
//       the entire test file at import time. Use a real function.
const { mockGenerateContent } = vi.hoisted(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-fake-key-ai-route';

  const { createRequire } = require('node:module');
  const requireCJS = createRequire(__filename || process.cwd() + '/');
  const genAIModule = requireCJS('@google/generative-ai');

  const fn = vi.fn();

  function MockGoogleGenerativeAI() {
    this.getGenerativeModel = function () {
      return { generateContent: fn };
    };
  }
  genAIModule.GoogleGenerativeAI = MockGoogleGenerativeAI;
  return { mockGenerateContent: fn };
});

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const aiRouter = requireCJS('../../routes/ai');

function makeApp({ tenantId = 1, userId = 7 } = {}) {
  const app = express();
  app.use(express.json());
  // Bypass verifyToken by injecting req.user up-front. The route's
  // verifyToken middleware will still execute (it's wired inside the
  // router) but since the global guard isn't installed and we never
  // send a token, the test would 401 — instead we mount the router
  // through a wrapper that pre-populates req.user AND skips the token
  // check. Cleanest path: wire a fake auth middleware that mirrors what
  // verifyToken does on success and lets every request through.
  //
  // The route's actual `verifyToken` reads Bearer tokens; we just need
  // req.user.tenantId populated before the handler body runs. The
  // simplest approach is to mount the router AFTER our middleware and
  // rely on supertest sending no auth header — the real verifyToken
  // will 401. So instead: stub verifyToken via require-cache so its
  // export becomes a passthrough.
  app.use((req, _res, next) => {
    req.user = { userId, tenantId, role: 'ADMIN' };
    next();
  });
  app.use('/api/ai', aiRouter);
  return app;
}

// The route's verifyToken middleware enforces Bearer-token presence;
// since our test app injects req.user without a token, we need to make
// verifyToken a passthrough. The router was already required (with the
// real verifyToken bound inside its handler registrations), so we can't
// undo that binding. Workaround: stub revokedToken.findUnique to resolve
// null and provide a valid JWT in the Authorization header. We sign with
// the same JWT_SECRET the route's verifyToken resolves to.
import jwt from 'jsonwebtoken';
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  mockGenerateContent.mockReset();
  // Sensible default — most tests override this.
  mockGenerateContent.mockResolvedValue({
    response: { text: () => 'Mocked Gemini reply body.' },
  });
});

// ─── POST /draft — context → email body ─────────────────────────────

describe('POST /draft — AI email draft', () => {
  test('400 when context missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Please provide a subject or context.');
    // No Gemini call should have fired.
    expect(mockGenerateContent).not.toHaveBeenCalled();
    // No contact lookup either.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('happy path with no contactId/recipientEmail: prompt contains context + tone instruction', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Hello,\n\nGenerated body.\n\nBest regards,' },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Q4 renewal follow-up', tone: 'formal' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toContain('Generated body.');
    expect(res.body.model).toBe('gemini-2.5-flash');

    // Gemini invoked once; the prompt carries context + tone.
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('Q4 renewal follow-up');
    expect(prompt).toContain('Write in a formal tone.');
    // No CRM enrichment fired because no contactId/recipientEmail.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('contactId enrichment: tenant-scoped lookup with deals + activities folded into prompt', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 42,
      name: 'Acme Industries',
      company: 'Acme Co',
      title: 'CFO',
      status: 'Prospect',
      aiScore: 81,
      deals: [
        { title: 'Annual subscription', stage: 'proposal', amount: 50000, currency: 'USD' },
      ],
      activities: [
        { type: 'Call', description: 'Discussed renewal terms with Sarah from Acme' },
      ],
    });
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Personalized body.' },
    });
    const app = makeApp({ tenantId: 9 });
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer({ tenantId: 9 }))
      .send({ context: 'Renewal proposal', contactId: 42 });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('gemini-2.5-flash');

    // Tenant scoping: where-clause must carry tenantId AND id.
    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(9);
    expect(args.where.id).toBe(42);
    // include shape: deals + activities pulled in for prompt context.
    expect(args.include.deals).toBeTruthy();
    expect(args.include.activities).toBeTruthy();

    // Prompt enrichment surfaced the CRM profile.
    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('Acme Industries');
    expect(prompt).toContain('Acme Co');
    expect(prompt).toContain('CFO');
    expect(prompt).toContain('Lead Score: 81/100');
    expect(prompt).toContain('Annual subscription');
  });

  test('recipientEmail enrichment (no contactId): tenant-scoped email lookup', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 99,
      name: 'Jordan Lee',
      company: 'Northbeam',
      status: 'Customer',
      aiScore: 67,
    });
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Follow-up body.' },
    });
    const app = makeApp({ tenantId: 3 });
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer({ tenantId: 3 }))
      .send({ context: 'Demo follow-up', recipientEmail: 'jordan@northbeam.io' });

    expect(res.status).toBe(200);

    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(3);
    expect(args.where.email).toBe('jordan@northbeam.io');
    // recipientEmail branch is the lighter enrichment (one-line summary,
    // no deals/activities expansion) — pinned by absence of include.
    expect(args.include).toBeUndefined();

    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('Jordan Lee');
    expect(prompt).toContain('Northbeam');
  });

  test('contactId branch beats recipientEmail when both present', async () => {
    prisma.contact.findFirst.mockResolvedValue({
      id: 10,
      name: 'By-id contact',
      company: 'CoX',
      title: 'CEO',
      status: 'Lead',
      aiScore: 50,
      deals: [],
      activities: [],
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({
        context: 'Test both branches',
        contactId: 10,
        recipientEmail: 'should-be-ignored@example.com',
      });

    expect(res.status).toBe(200);
    // Exactly ONE prisma call, and it's the contactId branch (where.id present,
    // where.email absent).
    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.id).toBe(10);
    expect(args.where.email).toBeUndefined();
  });

  test('Gemini throws → fallback-on-error envelope, template draft body', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Quick check-in', tone: 'casual' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fallback-on-error');
    // Casual tone surfaces a casual greeting in the template.
    expect(res.body.draft).toContain('Hey there,');
    // The context is interpolated into the fallback body.
    expect(res.body.draft).toContain('Quick check-in');
  });

  test('default tone (no body.tone) uses professional-yet-warm instruction', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Body.' },
    });
    const app = makeApp();
    await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Anything' });

    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('professional yet warm tone');
  });
});

// ─── POST /reply — originalEmail → reply body ───────────────────────

describe('POST /reply — AI reply suggestion', () => {
  test('400 when originalEmail missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Original email content required.');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  test('happy path: Gemini reply text returned with model=gemini-2.5-flash', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Thanks for the note. Yes, Tuesday works.\n\nBest,' },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: 'Can we meet Tuesday?', tone: 'friendly' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toContain('Tuesday works');
    expect(res.body.model).toBe('gemini-2.5-flash');

    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('Can we meet Tuesday?');
    expect(prompt).toContain('Write in a friendly tone.');
  });

  test('originalEmail truncated to 2000 chars before prompt interpolation (DOS guard)', async () => {
    mockGenerateContent.mockResolvedValue({
      response: { text: () => 'Reply.' },
    });
    // 5000-char payload — the route slices to 2000 before inlining.
    const huge = 'A'.repeat(5000);
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: huge });

    expect(res.status).toBe(200);
    const prompt = mockGenerateContent.mock.calls[0][0];
    // The interpolated payload inside the prompt must be exactly 2000 A's,
    // NOT 5000. Counting all A's in the prompt — the prompt body itself
    // has no other 'A' runs of this length, so a simple regex count works.
    const aRuns = prompt.match(/A+/g) || [];
    const longestARun = Math.max(...aRuns.map((s) => s.length));
    expect(longestARun).toBe(2000);
  });

  test('Gemini throws → fallback envelope with canned reply, model=fallback', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: 'Anything' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fallback');
    expect(res.body.draft).toContain('Thank you for your email');
    expect(res.body.draft).toContain("I'll");
  });
});

// ─── POST /subject-lines — context → array of subjects ──────────────

describe('POST /subject-lines — AI subject suggestions', () => {
  test('400 when context missing', async () => {
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Context required.');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  test('Gemini happy path: splits newlines, filters empty, slices to count (default 5)', async () => {
    // Note the empty / whitespace lines — the route must filter them out
    // BEFORE the slice, otherwise the caller gets <5 usable subjects.
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () =>
          'Subject A\n\nSubject B\n   \nSubject C\nSubject D\nSubject E\nSubject F',
      },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({ context: 'Renewal email' });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.subjects)).toBe(true);
    // Default count = 5 → exactly 5 subjects returned.
    expect(res.body.subjects).toHaveLength(5);
    expect(res.body.subjects[0]).toBe('Subject A');
    expect(res.body.subjects[1]).toBe('Subject B');
    expect(res.body.subjects[2]).toBe('Subject C');
    expect(res.body.subjects[3]).toBe('Subject D');
    expect(res.body.subjects[4]).toBe('Subject E');
    // 'Subject F' was sliced off because count=5.

    // The Gemini prompt requested 5 lines explicitly.
    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('Generate 5 email subject lines');
    expect(prompt).toContain('Renewal email');
  });

  test('explicit count=3 caps the slice', async () => {
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
      },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({ context: 'Anything', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.subjects).toHaveLength(3);
    expect(res.body.subjects).toEqual(['Line 1', 'Line 2', 'Line 3']);
    const prompt = mockGenerateContent.mock.calls[0][0];
    expect(prompt).toContain('Generate 3 email subject lines');
  });

  test('Gemini throws → 2-item templated fallback array (no model field)', async () => {
    mockGenerateContent.mockRejectedValue(new Error('Gemini down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({ context: 'Demo follow-up' });

    expect(res.status).toBe(200);
    // The catch branch returns a 2-item array (one "Follow up:" + one "RE:").
    expect(res.body.subjects).toHaveLength(2);
    expect(res.body.subjects[0]).toBe('Follow up: Demo follow-up');
    expect(res.body.subjects[1]).toBe('RE: Demo follow-up');
    // No model field on this envelope.
    expect(res.body.model).toBeUndefined();
  });
});
