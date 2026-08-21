// @ts-check
/**
 * Unit tests for backend/routes/ai.js — pins the AI email-assist surface
 * (draft, reply, subject-line generation). Three POST endpoints:
 *
 *   1. POST /draft          — context → generated email body. Optional
 *      contactId / recipientEmail enrichment pulls a tenant-scoped
 *      Contact (with deals + activities) into the prompt context.
 *      Tone defaults to "professional yet warm"; explicit tone is passed
 *      to Gemini verbatim. A blocked-access error (no BYOK, no funded CRM
 *      subscription) falls through to a template generator
 *      (generateFallbackDraft) and returns `model: "template-fallback"`.
 *      Any OTHER error falls through to `model: "fallback-on-error"`.
 *
 *   2. POST /reply          — originalEmail → reply draft. Body of the
 *      original email is truncated to 2000 chars before being inlined
 *      into the prompt (DOS prevention — bounds the upstream provider
 *      payload). A blocked/other error returns a fixed canned reply with
 *      `model: "fallback"`.
 *
 *   3. POST /subject-lines  — context → array of N candidate subjects
 *      (default N=5). Provider output is split by newline, trimmed,
 *      filtered for empty lines, then sliced to N. A blocked/other error
 *      returns a templated 2-item fallback array using the supplied
 *      context.
 *
 * All three routes now go through lib/aiGateway.runAiRequest — the
 * mandatory resolve/gate/log/deduct entry point every AI feature in the
 * CRM shares (BYOK first, then a funded CRM-managed subscription). This
 * suite mocks aiGateway.runAiRequest directly rather than the Gemini SDK
 * (the route no longer touches the SDK — resolveProviderConfig/
 * generateChatCompletion inside aiGateway do, and those already have
 * their own dedicated unit coverage in test/lib/aiProviderManagement*
 * and test/lib/aiGateway*).
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
 *     interpolation.
 *   - /subject-lines slice cap respects body.count when provided, falls
 *     back to 5 when absent. Empty lines in the provider response are
 *     filtered out BEFORE the slice (so a noisy reply still produces N
 *     usable suggestions).
 *   - On a "friendly" blocked-access error, /draft returns
 *     model="template-fallback", /reply returns model="fallback",
 *     /subject-lines returns a 2-item array without a model field.
 *   - On a Gemini-limit error, all three return 429 with
 *     code=GEMINI_LIMIT_EXHAUSTED.
 *   - On any OTHER thrown error, /draft returns model="fallback-on-error".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';

// ─── Prisma singleton patch (must run BEFORE the router is required) ──────
prisma.contact = prisma.contact || {};
prisma.contact.findFirst = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue(null);
// verifyToken's live-session-state check (middleware/auth.js) reads
// prisma.user on every authenticated request.
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ deactivatedAt: null, sessionVersion: null });

// ─── aiGateway mock (must hoist BEFORE the route is required) ────────────
const { mockRunAiRequest } = vi.hoisted(() => ({ mockRunAiRequest: vi.fn() }));
vi.mock('../../lib/aiGateway', () => ({
  default: { runAiRequest: mockRunAiRequest },
  runAiRequest: mockRunAiRequest,
}));

import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
// The route requires aiGateway via CJS; make the CJS cache resolve to the
// same mock object vi.mock's ESM-level factory installed, mirroring the
// Module._cache injection pattern used across this test suite for CJS
// modules that vitest's ESM-level vi.mock can't otherwise intercept.
const aiGatewayPath = requireCJS.resolve('../../lib/aiGateway');
require('node:module')._cache[aiGatewayPath] = {
  id: aiGatewayPath,
  filename: aiGatewayPath,
  loaded: true,
  exports: { runAiRequest: mockRunAiRequest },
  children: [],
  paths: [],
};

const aiRouter = requireCJS('../../routes/ai');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRouter);
  return app;
}

import jwt from 'jsonwebtoken';
const { JWT_SECRET } = requireCJS('../../config/secrets');
function makeBearer({ userId = 7, tenantId = 1, role = 'ADMIN' } = {}) {
  return 'Bearer ' + jwt.sign({ userId, tenantId, role }, JWT_SECRET, { expiresIn: '1h' });
}

function friendlyBlockedError() {
  const err = new Error('Your organization has not configured an AI provider yet.');
  err.friendly = true;
  err.code = 'AI_NOT_CONFIGURED';
  return err;
}

beforeEach(() => {
  prisma.contact.findFirst.mockReset();
  mockRunAiRequest.mockReset();
  // Sensible default — most tests override this.
  mockRunAiRequest.mockResolvedValue({
    text: 'Mocked provider reply body.',
    model: 'gemini-2.5-flash-lite',
    provider: 'gemini',
    accessType: 'byok',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
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
    // No provider call should have fired.
    expect(mockRunAiRequest).not.toHaveBeenCalled();
    // No contact lookup either.
    expect(prisma.contact.findFirst).not.toHaveBeenCalled();
  });

  test('happy path with no contactId/recipientEmail: prompt contains context + tone instruction', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: 'Hello,\n\nGenerated body.\n\nBest regards,',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Q4 renewal follow-up', tone: 'formal' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toContain('Generated body.');
    expect(res.body.model).toBe('gemini-2.5-flash-lite');

    // aiGateway invoked once; the prompt carries context + tone.
    expect(mockRunAiRequest).toHaveBeenCalledTimes(1);
    const call = mockRunAiRequest.mock.calls[0][0];
    expect(call.task).toBe('email-draft');
    expect(call.tenantId).toBe(1);
    expect(call.userId).toBe(7);
    const prompt = call.messages[0].content;
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
    mockRunAiRequest.mockResolvedValue({
      text: 'Personalized body.',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer({ tenantId: 9 }))
      .send({ context: 'Renewal proposal', contactId: 42 });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('gemini-2.5-flash-lite');

    // Tenant scoping: where-clause must carry tenantId AND id.
    expect(prisma.contact.findFirst).toHaveBeenCalledTimes(1);
    const args = prisma.contact.findFirst.mock.calls[0][0];
    expect(args.where.tenantId).toBe(9);
    expect(args.where.id).toBe(42);
    // include shape: deals + activities pulled in for prompt context.
    expect(args.include.deals).toBeTruthy();
    expect(args.include.activities).toBeTruthy();

    // Prompt enrichment surfaced the CRM profile.
    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
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
    mockRunAiRequest.mockResolvedValue({
      text: 'Follow-up body.',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    });
    const app = makeApp();
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

    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
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

  test('blocked access (no BYOK, no funded subscription) → template-fallback envelope', async () => {
    mockRunAiRequest.mockRejectedValue(friendlyBlockedError());
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Quick check-in', tone: 'casual' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('template-fallback');
    // Casual tone surfaces a casual greeting in the template.
    expect(res.body.draft).toContain('Hey there,');
    // The context is interpolated into the fallback body.
    expect(res.body.draft).toContain('Quick check-in');
  });

  test('non-friendly provider error → fallback-on-error envelope, template draft body', async () => {
    mockRunAiRequest.mockRejectedValue(new Error('Provider down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Quick check-in', tone: 'casual' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fallback-on-error');
    expect(res.body.draft).toContain('Hey there,');
    expect(res.body.draft).toContain('Quick check-in');
  });

  test('provider quota exhaustion surfaces a friendly 429', async () => {
    mockRunAiRequest.mockRejectedValue(new Error('429 quota exceeded'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Quick check-in' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: 'GEMINI_LIMIT_EXHAUSTED',
      error: 'Gemini limit has been exhausted. Please try again later.',
    });
  });

  test('default tone (no body.tone) uses professional-yet-warm instruction', async () => {
    const app = makeApp();
    await request(app)
      .post('/api/ai/draft')
      .set('Authorization', makeBearer())
      .send({ context: 'Anything' });

    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
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
    expect(mockRunAiRequest).not.toHaveBeenCalled();
  });

  test('happy path: provider reply text returned with resolved model', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: 'Thanks for the note. Yes, Tuesday works.\n\nBest,',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: 'Can we meet Tuesday?', tone: 'friendly' });

    expect(res.status).toBe(200);
    expect(res.body.draft).toContain('Tuesday works');
    expect(res.body.model).toBe('gemini-2.5-flash-lite');

    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Can we meet Tuesday?');
    expect(prompt).toContain('Write in a friendly tone.');
  });

  test('originalEmail truncated to 2000 chars before prompt interpolation (DOS guard)', async () => {
    // 5000-char payload — the route slices to 2000 before inlining.
    const huge = 'A'.repeat(5000);
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: huge });

    expect(res.status).toBe(200);
    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
    const aRuns = prompt.match(/A+/g) || [];
    const longestARun = Math.max(...aRuns.map((s) => s.length));
    expect(longestARun).toBe(2000);
  });

  test('blocked/error → fallback envelope with canned reply, model=fallback', async () => {
    mockRunAiRequest.mockRejectedValue(friendlyBlockedError());
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: 'Anything' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fallback');
    expect(res.body.draft).toContain('Thank you for your email');
  });

  test('non-friendly provider error (outer catch) → different canned reply, model=fallback', async () => {
    mockRunAiRequest.mockRejectedValue(new Error('Provider down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/reply')
      .set('Authorization', makeBearer())
      .send({ originalEmail: 'Anything' });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('fallback');
    expect(res.body.draft).toContain("I'll review and get back to you shortly");
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
    expect(mockRunAiRequest).not.toHaveBeenCalled();
  });

  test('happy path: splits newlines, filters empty, slices to count (default 5)', async () => {
    // Note the empty / whitespace lines — the route must filter them out
    // BEFORE the slice, otherwise the caller gets <5 usable subjects.
    mockRunAiRequest.mockResolvedValue({
      text: 'Subject A\n\nSubject B\n   \nSubject C\nSubject D\nSubject E\nSubject F',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
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

    // The prompt requested 5 lines explicitly.
    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Generate 5 email subject lines');
    expect(prompt).toContain('Renewal email');
  });

  test('explicit count=3 caps the slice', async () => {
    mockRunAiRequest.mockResolvedValue({
      text: 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5',
      model: 'gemini-2.5-flash-lite',
      provider: 'gemini',
      accessType: 'byok',
      usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({ context: 'Anything', count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.subjects).toHaveLength(3);
    expect(res.body.subjects).toEqual(['Line 1', 'Line 2', 'Line 3']);
    const prompt = mockRunAiRequest.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Generate 3 email subject lines');
  });

  test('blocked access (no BYOK, no funded subscription) → 5-item templated fallback array', async () => {
    mockRunAiRequest.mockRejectedValue(friendlyBlockedError());
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({ context: 'Demo follow-up' });

    expect(res.status).toBe(200);
    expect(res.body.subjects).toHaveLength(5);
    expect(res.body.subjects[0]).toBe('Follow up: Demo follow-up');
    expect(res.body.subjects[2]).toBe('RE: Demo follow-up');
    // No model field on this envelope.
    expect(res.body.model).toBeUndefined();
  });

  test('non-friendly provider error (outer catch) → 2-item templated fallback array', async () => {
    mockRunAiRequest.mockRejectedValue(new Error('Provider down'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/ai/subject-lines')
      .set('Authorization', makeBearer())
      .send({ context: 'Demo follow-up' });

    expect(res.status).toBe(200);
    // The OUTER catch branch returns a 2-item array (one "Follow up:" + one "RE:").
    expect(res.body.subjects).toHaveLength(2);
    expect(res.body.subjects[0]).toBe('Follow up: Demo follow-up');
    expect(res.body.subjects[1]).toBe('RE: Demo follow-up');
    // No model field on this envelope.
    expect(res.body.model).toBeUndefined();
  });
});
