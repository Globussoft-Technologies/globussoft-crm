// @ts-check
/**
 * Portal travel-diagnostics parity pass (2026-08-27) — the customer-portal
 * diagnostic result (backend/routes/portal.js) was missing curriculumFit,
 * cancellationPolicy, and chosen-interest capture that the public diagnostic
 * report page (backend/routes/travel_diagnostics_public.js) already had.
 * This file pins:
 *   - GET  /api/portal/travel/diagnostics includes curriculumFit,
 *     cancellationPolicy, and chosenInterests per row (null when absent).
 *   - POST /api/portal/travel/diagnostics includes the same three fields
 *     in its response (chosenInterests always null — brand new row).
 *   - POST /api/portal/travel/diagnostics/:id/interests — new endpoint,
 *     scoped to the caller's OWN diagnostic (contactId + tenantId match,
 *     unlike the public route which authorizes via a report-slug token).
 *
 * Test pattern mirrors backend/test/routes/travel-diagnostics.test.js —
 * patch the prisma singleton + self-mock sibling lib modules BEFORE
 * requiring the router (CJS load semantics bypass vi.mock()), then drive
 * supertest with a real PORTAL JWT.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// ── Self-mock sibling lib modules BEFORE requiring the router ──────────
const curriculumFitLib = requireCJS('../../lib/travelDiagnosticCurriculumFit');
curriculumFitLib.buildCurriculumFitForDiagnostic = vi.fn().mockResolvedValue(null);

const travelRag = requireCJS('../../lib/travelRag');
travelRag.runRagForDiagnostic = vi.fn().mockResolvedValue(null);

const pdfModule = requireCJS('../../lib/travelDiagnosticPdf');
pdfModule.generateDiagnosticPdfBestEffort = vi.fn().mockResolvedValue('/api/uploads/diagnostics/diag-1-abc.pdf');

const cancellationPolicyLib = requireCJS('../../lib/travelDiagnosticCancellationPolicy');
cancellationPolicyLib.resolveCancellationPolicyForForm = vi.fn().mockResolvedValue(null);

const chosenInterestsLib = requireCJS('../../lib/diagnosticChosenInterests');
chosenInterestsLib.getChosenInterests = vi.fn().mockResolvedValue(null);
chosenInterestsLib.saveChosenInterests = vi.fn();

// Self-mocked so these tests exercise the ROUTE's plumbing without depending
// on diagnosticNotifications.js's own send logic — that's covered in
// test/lib/diagnosticNotifications.test.js.
const diagnosticNotifications = requireCJS('../../lib/diagnosticNotifications');
diagnosticNotifications.notifyDiagnosticSubmitted = vi.fn().mockResolvedValue(undefined);

const scoringLib = requireCJS('../../lib/travelDiagnosticScoring');
scoringLib.parseBank = vi.fn().mockReturnValue({
  bank: { method: 'weighted-sum', questions: [{ id: 'q1', options: [{ value: 'a', weight: 1 }] }] },
  warnings: [],
});
scoringLib.scoreDiagnostic = vi.fn().mockReturnValue({
  score: 5,
  classification: 'level_2',
  classificationLabel: 'Regular',
  recommendedTier: 'primary',
  warnings: [],
});

// Patch prisma models the diagnostic routes touch.
prisma.tenant = { ...(prisma.tenant || {}), findUnique: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findUnique: vi.fn() };
prisma.travelDiagnosticQuestionBank = {
  ...(prisma.travelDiagnosticQuestionBank || {}),
  findMany: vi.fn(),
};
prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
};
prisma.travelDiagnosticRagResult = {
  ...(prisma.travelDiagnosticRagResult || {}),
  findMany: vi.fn(),
};

const portalRouter = requireCJS('../../routes/portal');

const express = requireCJS('express');
const request = requireCJS('supertest');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/portal', portalRouter);
  return app;
}

function tokenFor({ contactId = 900, tenantId = 1 } = {}) {
  return jwt.sign({ type: 'PORTAL', contactId, tenantId }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });
  prisma.contact.findUnique.mockResolvedValue({ subBrand: 'tmc' });
  chosenInterestsLib.getChosenInterests.mockResolvedValue(null);
  cancellationPolicyLib.resolveCancellationPolicyForForm.mockResolvedValue(null);
  curriculumFitLib.buildCurriculumFitForDiagnostic.mockResolvedValue(null);
  travelRag.runRagForDiagnostic.mockResolvedValue(null);
  pdfModule.generateDiagnosticPdfBestEffort.mockResolvedValue('/api/uploads/diagnostics/diag-1-abc.pdf');
  diagnosticNotifications.notifyDiagnosticSubmitted.mockResolvedValue(undefined);
});

describe('GET /api/portal/travel/diagnostics', () => {
  test('includes null curriculumFit/cancellationPolicy/chosenInterests when nothing is set', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      { id: 500, subBrand: 'tmc', score: 5, classification: 'level_2', classificationLabel: 'Regular', recommendedTier: 'primary', reportPdfUrl: null, curriculumFitJson: null, createdAt: new Date() },
    ]);
    prisma.travelDiagnosticRagResult.findMany.mockResolvedValue([]);

    const res = await request(makeApp())
      .get('/api/portal/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: 500, curriculumFit: null, cancellationPolicy: null, chosenInterests: null });
    expect(res.body[0].curriculumFitJson).toBeUndefined();
  });

  test('includes parsed curriculumFit, cancellationPolicy, and chosenInterests when present', async () => {
    prisma.travelDiagnostic.findMany.mockResolvedValue([
      {
        id: 501, subBrand: 'tmc', score: 8, classification: 'level_1', classificationLabel: 'Power User', recommendedTier: 'premium',
        reportPdfUrl: '/x.pdf',
        curriculumFitJson: JSON.stringify({ curriculum: 'CBSE', grade: '8', recommendations: [{ destination: 'Hampi', fitScore: 90 }] }),
        createdAt: new Date(),
      },
    ]);
    prisma.travelDiagnosticRagResult.findMany.mockResolvedValue([]);
    cancellationPolicyLib.resolveCancellationPolicyForForm.mockResolvedValue({
      id: 1, name: 'Standard', description: null, tiers: [{ daysBeforeServiceStart: 30, refundPercent: 100 }],
    });
    chosenInterestsLib.getChosenInterests.mockResolvedValue({
      interests: [{ name: 'Hampi', driveLink: '' }],
      submittedAt: '2026-08-27T10:00:00.000Z',
    });

    const res = await request(makeApp())
      .get('/api/portal/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor()}`);

    expect(res.status).toBe(200);
    expect(res.body[0].curriculumFit).toEqual({ curriculum: 'CBSE', grade: '8', recommendations: [{ destination: 'Hampi', fitScore: 90 }] });
    expect(res.body[0].cancellationPolicy.name).toBe('Standard');
    expect(res.body[0].chosenInterests.interests).toEqual([{ name: 'Hampi', driveLink: '' }]);
  });

  test('missing Bearer → 401', async () => {
    const res = await request(makeApp()).get('/api/portal/travel/diagnostics');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/portal/travel/diagnostics', () => {
  test('happy: response includes curriculumFit, cancellationPolicy, and chosenInterests:null', async () => {
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      { id: 100, subBrand: 'tmc', version: 1, questionsJson: '{}', scoringRulesJson: '{}', isActive: true },
    ]);
    prisma.travelDiagnostic.create.mockResolvedValue({ id: 555, createdAt: new Date(), reportPdfUrl: null });
    curriculumFitLib.buildCurriculumFitForDiagnostic.mockResolvedValue({
      curriculum: 'CBSE', grade: '8', recommendations: [{ destination: 'Hampi', fitScore: 90 }],
    });
    cancellationPolicyLib.resolveCancellationPolicyForForm.mockResolvedValue({
      id: 1, name: 'Standard', description: null, tiers: [],
    });

    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ subBrand: 'tmc', answers: { q1: 'a' } });

    expect(res.status).toBe(201);
    expect(res.body.curriculumFit.recommendations).toEqual([{ destination: 'Hampi', fitScore: 90 }]);
    expect(res.body.cancellationPolicy.name).toBe('Standard');
    expect(res.body.chosenInterests).toBeNull();
    // Existing back-compat field untouched.
    expect(res.body.recommendations).toEqual([{ destination: 'Hampi', fitScore: 90 }]);
    // Cancellation policy is baked into the PDF generation call too.
    expect(pdfModule.generateDiagnosticPdfBestEffort).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cancellationPolicy: expect.objectContaining({ name: 'Standard' }) }),
    );
  });

  test('fires notifyDiagnosticSubmitted with the submitter contact label + score', async () => {
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      { id: 100, subBrand: 'tmc', version: 1, questionsJson: '{}', scoringRulesJson: '{}', isActive: true },
    ]);
    prisma.travelDiagnostic.create.mockResolvedValue({ id: 555, createdAt: new Date(), reportPdfUrl: null });
    prisma.contact.findUnique.mockResolvedValue({ subBrand: 'tmc', name: 'Modern School', email: 'admin@modern.edu' });

    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor({ tenantId: 1 })}`)
      .send({ subBrand: 'tmc', answers: { q1: 'a' } });

    expect(res.status).toBe(201);
    expect(diagnosticNotifications.notifyDiagnosticSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 1, subBrand: 'tmc', diagnosticId: 555,
        contactLabel: 'Modern School', score: 5, classificationLabel: 'Regular',
      }),
    );
  });

  test('a notification failure never blocks the submit response', async () => {
    prisma.travelDiagnosticQuestionBank.findMany.mockResolvedValue([
      { id: 100, subBrand: 'tmc', version: 1, questionsJson: '{}', scoringRulesJson: '{}', isActive: true },
    ]);
    prisma.travelDiagnostic.create.mockResolvedValue({ id: 555, createdAt: new Date(), reportPdfUrl: null });
    diagnosticNotifications.notifyDiagnosticSubmitted.mockRejectedValue(new Error('boom'));

    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ subBrand: 'tmc', answers: { q1: 'a' } });

    expect(res.status).toBe(201);
  });
});

describe('POST /api/portal/travel/diagnostics/:id/interests', () => {
  test('happy: saves interests scoped to the caller\'s own diagnostic', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({ id: 500, tenantId: 1 });
    chosenInterestsLib.saveChosenInterests.mockResolvedValue({
      interests: [{ name: 'Hampi Heritage Trail', driveLink: '' }],
      submittedAt: '2026-08-27T12:00:00.000Z',
    });

    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics/500/interests')
      .set('Authorization', `Bearer ${tokenFor({ contactId: 900, tenantId: 1 })}`)
      .send({ interests: [{ name: 'Hampi Heritage Trail', driveLink: '' }] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.travelDiagnostic.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 500, contactId: 900, tenantId: 1 } }),
    );
    expect(chosenInterestsLib.saveChosenInterests).toHaveBeenCalledWith({
      tenantId: 1,
      diagnosticId: 500,
      interests: [{ name: 'Hampi Heritage Trail', driveLink: '' }],
    });
  });

  test('a diagnostic belonging to another contact → 404 (isolation)', async () => {
    // findFirst's where-clause already scopes to the caller's contactId, so
    // a diagnostic owned by someone else simply doesn't match → null.
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);

    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics/999/interests')
      .set('Authorization', `Bearer ${tokenFor({ contactId: 900, tenantId: 1 })}`)
      .send({ interests: [{ name: 'x' }] });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(chosenInterestsLib.saveChosenInterests).not.toHaveBeenCalled();
  });

  test('non-numeric id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics/abc/interests')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ interests: [{ name: 'x' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
  });

  test('empty interests → 400 MISSING_INTERESTS (bubbled from the lib)', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({ id: 500, tenantId: 1 });
    const err = new Error("At least one interest with a name is required");
    err.status = 400;
    err.code = 'MISSING_INTERESTS';
    chosenInterestsLib.saveChosenInterests.mockRejectedValue(err);

    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics/500/interests')
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ interests: [] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_INTERESTS');
  });

  test('missing Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/portal/travel/diagnostics/500/interests')
      .send({ interests: [{ name: 'x' }] });
    expect(res.status).toBe(401);
  });
});
