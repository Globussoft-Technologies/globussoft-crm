// @ts-check
/**
 * Travel CRM — DiagnosticDetail.jsx blind-collapsed brief-reveal audit test (G104).
 *
 * Pins backend/routes/travel_diagnostics.js:
 *   POST /api/travel/diagnostics/:id/brief-reveal
 *
 * What's pinned:
 *   - Auth gate: missing Bearer → 401.
 *   - Tenant gate: requireTravelTenant — generic vertical → 403 WRONG_VERTICAL.
 *   - Body validation: missing sectionKey → 400 MISSING_SECTION_KEY;
 *     sectionKey > 100 chars → 400 INVALID_SECTION_KEY.
 *   - Cross-tenant diagnostic → 404 DIAGNOSTIC_NOT_FOUND.
 *   - Happy path: returns { ok: true }; sectionKey trimmed; writeAudit was
 *     called with action="BRIEF_SECTION_REVEALED" + entity="TravelDiagnostic".
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Stub LLM router + pdf renderer to keep module-load side-effects inert.
const llmRouter = requireCJS('../../lib/llmRouter');
llmRouter.routeRequest = vi.fn();
const pdfRenderer = requireCJS('../../services/pdfRenderer');
pdfRenderer.renderTravelDiagnosticPdf = vi.fn();

// Stub fs writes so module-load mkdirSync does not crash on rare paths.
const fs = requireCJS('fs');
fs.mkdirSync = vi.fn();
fs.promises.writeFile = vi.fn().mockResolvedValue(undefined);

// Spy on writeAudit at the lib/audit module so the brief-reveal call is observable.
const auditLib = requireCJS('../../lib/audit');
const writeAuditSpy = vi.spyOn(auditLib, 'writeAudit').mockResolvedValue(undefined);

prisma.travelDiagnostic = {
  ...(prisma.travelDiagnostic || {}),
  findFirst: vi.fn(),
};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({
  id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
});
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({
  role: 'MANAGER', subBrandAccess: null,
});
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

const router = requireCJS('../../routes/travel_diagnostics');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel', router);
  return app;
}

function tokenFor(role = 'MANAGER', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

beforeEach(() => {
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({
    role: 'MANAGER', subBrandAccess: null,
  });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  writeAuditSpy.mockReset().mockResolvedValue(undefined);
});

describe('POST /diagnostics/:id/brief-reveal', () => {
  test('missing Bearer → 401', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/5/brief-reveal')
      .send({ sectionKey: 'lead_with' });
    expect(res.status).toBe(401);
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  test('generic-vertical tenant → 403 WRONG_VERTICAL', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 1, vertical: 'generic', name: 'Generic', slug: 'g',
    });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/5/brief-reveal')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ sectionKey: 'lead_with' });
    expect(res.status).toBe(403);
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  test('missing sectionKey → 400 MISSING_SECTION_KEY', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/5/brief-reveal')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SECTION_KEY');
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  test('sectionKey > 100 chars → 400 INVALID_SECTION_KEY', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/5/brief-reveal')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ sectionKey: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SECTION_KEY');
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  test('non-numeric :id → 400 INVALID_ID', async () => {
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/abc/brief-reveal')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ sectionKey: 'lead_with' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  test('cross-tenant diagnostic → 404 DIAGNOSTIC_NOT_FOUND', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/99/brief-reveal')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ sectionKey: 'lead_with' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DIAGNOSTIC_NOT_FOUND');
    expect(writeAuditSpy).not.toHaveBeenCalled();
  });

  test('happy path: writes audit row with sectionKey + subBrand', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue({
      id: 5, subBrand: 'tmc',
    });
    const res = await request(makeApp())
      .post('/api/travel/diagnostics/5/brief-reveal')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ sectionKey: '  lead_with  ' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(writeAuditSpy).toHaveBeenCalledOnce();
    const args = writeAuditSpy.mock.calls[0];
    expect(args[0]).toBe('TravelDiagnostic');
    expect(args[1]).toBe('BRIEF_SECTION_REVEALED');
    expect(args[2]).toBe(5);
    expect(args[3]).toBe(7); // userId
    expect(args[4]).toBe(1); // tenantId
    expect(args[5]).toEqual({ sectionKey: 'lead_with', subBrand: 'tmc' });
  });
});
