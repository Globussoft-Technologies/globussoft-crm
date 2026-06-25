// @ts-check
/**
 * PATCH /api/travel/diagnostics/:id — senior-reviewer blind human pick
 * (PRD §3.3.7 / DD-5.7). Records TravelDiagnostic.humanPick so the engine-vs-
 * human agreement analysis can run. This is the save endpoint the
 * DiagnosticDetail "Save pick" button calls (was missing → 404 before).
 *
 * Pins: auth gate, body validation, not-found, happy-path persist + audit.
 * Harness mirrors travel-diagnostics-brief-reveal.test.js.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';

// Keep module-load side-effects inert.
requireCJS('../../lib/llmRouter').routeRequest = vi.fn();
requireCJS('../../services/pdfRenderer').renderTravelDiagnosticPdf = vi.fn();
const fs = requireCJS('fs');
fs.mkdirSync = vi.fn();
fs.promises.writeFile = vi.fn().mockResolvedValue(undefined);

const auditLib = requireCJS('../../lib/audit');
const writeAuditSpy = vi.spyOn(auditLib, 'writeAudit').mockResolvedValue(undefined);

prisma.travelDiagnostic = { ...(prisma.travelDiagnostic || {}), findFirst: vi.fn(), update: vi.fn() };
prisma.contact = { ...(prisma.contact || {}), findFirst: vi.fn().mockResolvedValue(null) };
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel' });
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn().mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
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
  return jwt.sign({ userId, tenantId, role, email: `${role.toLowerCase()}@test.local` }, JWT_SECRET, { expiresIn: '1h' });
}
function diag(over = {}) {
  return { id: 15, tenantId: 1, subBrand: 'tmc', contactId: null, humanPick: null, ...over };
}

beforeEach(() => {
  prisma.travelDiagnostic.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelDiagnostic.update.mockReset().mockImplementation(async ({ data }) => diag(data));
  prisma.contact.findFirst.mockReset().mockResolvedValue(null);
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel' });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'MANAGER', subBrandAccess: null });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  writeAuditSpy.mockReset().mockResolvedValue(undefined);
});

describe('PATCH /diagnostics/:id — human pick', () => {
  test('missing Bearer → 401', async () => {
    const res = await request(makeApp()).patch('/api/travel/diagnostics/15').send({ humanPick: 'golden-triangle' });
    expect(res.status).toBe(401);
  });

  test('missing humanPick → 400 HUMAN_PICK_REQUIRED', async () => {
    const res = await request(makeApp())
      .patch('/api/travel/diagnostics/15')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HUMAN_PICK_REQUIRED');
    expect(prisma.travelDiagnostic.update).not.toHaveBeenCalled();
  });

  test('diagnostic not found → 404', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .patch('/api/travel/diagnostics/999')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ humanPick: 'golden-triangle' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('happy path: persists humanPick, returns diagnostic + audits', async () => {
    prisma.travelDiagnostic.findFirst.mockResolvedValue(diag());
    const res = await request(makeApp())
      .patch('/api/travel/diagnostics/15')
      .set('Authorization', `Bearer ${tokenFor('MANAGER')}`)
      .send({ humanPick: '  golden-triangle  ' });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(15);
    expect(res.body.humanPick).toBe('golden-triangle'); // trimmed
    expect(prisma.travelDiagnostic.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 15 }, data: { humanPick: 'golden-triangle' } }),
    );
    expect(writeAuditSpy).toHaveBeenCalledWith(
      'TravelDiagnostic', 'DIAGNOSTIC_HUMAN_PICK', 15, 7, 1,
      expect.objectContaining({ humanPick: 'golden-triangle' }),
    );
  });
});
