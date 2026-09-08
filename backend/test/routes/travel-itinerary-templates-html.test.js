// @ts-check
/**
 * HTML page-body endpoints for PDF itinerary templates.
 *
 *   GET    /:id/html-template   current bodies + a hand-written starter
 *   PUT    /:id/html-template   save bodyCss + per-page bodyHtml, IN PLACE
 *   DELETE /:id/html-template   clear them, reverting to the built-in renderer
 *
 * What's pinned
 * -------------
 *   - Save updates the SAME row and never creates a version. PATCH /:id does
 *     version-on-edit (new row, new id), but itineraries bind to a template by
 *     exact id — so a versioning save would strand every existing itinerary on
 *     the old body and make editing look like a no-op. This is the test that
 *     stops someone "fixing" this endpoint to match PATCH.
 *   - Unparseable template syntax is rejected at save time, naming the page.
 *     Stored broken, it silently falls back at render time and reads as
 *     "saving did nothing".
 *   - Script/iframe/event-handler markup is stripped before storage.
 *   - Tenant scoping, RBAC and auth gates all run for real.
 *
 * Pattern mirrors travel-itinerary-templates.test.js — patch prisma BEFORE
 * requiring the router, drive with real HS256 JWTs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import prisma from '../../lib/prisma.js';

prisma.itineraryTemplate = prisma.itineraryTemplate || {};
prisma.itineraryTemplate.findFirst = vi.fn();
prisma.itineraryTemplate.findMany = vi.fn();
prisma.itineraryTemplate.count = vi.fn();
prisma.itineraryTemplate.create = vi.fn();
prisma.itineraryTemplate.update = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.auditLog = {
  ...(prisma.auditLog || {}),
  findMany: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockResolvedValue({ id: 1 }),
  findFirst: vi.fn().mockResolvedValue(null),
};
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || 'enterprise_super_secret_key_2026';
process.env.AWS_S3_URL = 'https://cdn.example.com';
const templatesRouter = requireCJS('../../routes/travel_itinerary_templates');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/travel/itinerary-templates', templatesRouter);
  return app;
}

function tokenFor(role = 'ADMIN', { userId = 7, tenantId = 1 } = {}) {
  return jwt.sign(
    { userId, tenantId, role, email: `${role.toLowerCase()}@test.local` },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

const SPEC = {
  version: 4,
  accentColor: '#00A9CE',
  pages: [
    { index: 1, role: 'cover', contentBox: { x: 40, y: 100, width: 500, height: 600 } },
    { index: 2, role: 'itinerary', contentBox: { x: 40, y: 90, width: 500, height: 640 } },
    { index: 3, role: 'static', contentBox: null },
  ],
};

function templateRow(overrides = {}) {
  return {
    id: 301,
    tenantId: 1,
    name: 'Nepal School Trip',
    isPdfTemplate: true,
    pdfTemplateUrl: 'https://cdn.example.com/blanked.pdf',
    pdfTemplateSourceUrl: 'https://cdn.example.com/source.pdf',
    pdfStyleSpecJson: JSON.stringify(SPEC),
    ...overrides,
  };
}

beforeEach(() => {
  prisma.itineraryTemplate.findFirst.mockReset().mockResolvedValue(templateRow());
  prisma.itineraryTemplate.update.mockReset().mockImplementation(({ data }) => ({ id: 301, ...data }));
  prisma.itineraryTemplate.create.mockReset();
  prisma.tenant.findUnique.mockReset().mockResolvedValue({
    id: 1, vertical: 'travel', name: 'Test Travel', slug: 'test-travel',
  });
  prisma.user.findUnique.mockReset().mockResolvedValue({ role: 'ADMIN', subBrandAccess: null });
});

describe('GET /:id/html-template', () => {
  test('returns current bodies and reports HTML as not enabled when there are none', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.pages).toHaveLength(3);
    expect(res.body.pages[0]).toMatchObject({ index: 1, role: 'cover', bodyHtml: '' });
  });

  test('reports enabled once any page has a body', async () => {
    const spec = JSON.parse(JSON.stringify(SPEC));
    spec.pages[0].bodyHtml = '<h1>{{title}}</h1>';
    spec.bodyCss = 'body{color:red}';
    prisma.itineraryTemplate.findFirst.mockResolvedValue(
      templateRow({ pdfStyleSpecJson: JSON.stringify(spec) }),
    );

    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.bodyCss).toBe('body{color:red}');
    expect(res.body.pages[0].bodyHtml).toBe('<h1>{{title}}</h1>');
  });

  test('offers a starter so the editor is never a blank box', async () => {
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.body.starter.bodyCss).toContain('@import');
    // Fillable roles get a starter body; a static page is copied through
    // untouched and therefore has none.
    const byIndex = Object.fromEntries(res.body.starter.pages.map((p) => [p.index, p.bodyHtml]));
    expect(byIndex[1]).toContain('{{title}}');
    expect(byIndex[2]).toContain('{{#each days}}');
    expect(byIndex[3]).toBe('');
  });

  test('404s for another tenant\'s template', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(null);
    const res = await request(makeApp())
      .get('/api/travel/itinerary-templates/999/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('401s without a token', async () => {
    const res = await request(makeApp()).get('/api/travel/itinerary-templates/301/html-template');
    expect(res.status).toBe(401);
  });
});

describe('PUT /:id/html-template', () => {
  test('saves bodies onto the SAME row and never creates a version', async () => {
    const res = await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        bodyCss: 'body{font-family:Poppins}',
        pages: [{ index: 1, bodyHtml: '<h1>{{title}}</h1>' }],
      });

    expect(res.status).toBe(200);
    expect(prisma.itineraryTemplate.create).not.toHaveBeenCalled();
    expect(prisma.itineraryTemplate.update).toHaveBeenCalledTimes(1);

    const call = prisma.itineraryTemplate.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 301 });
    const saved = JSON.parse(call.data.pdfStyleSpecJson);
    expect(saved.bodyCss).toBe('body{font-family:Poppins}');
    expect(saved.pages[0].bodyHtml).toBe('<h1>{{title}}</h1>');
    // Untouched pages keep whatever they had.
    expect(saved.pages[1].bodyHtml).toBeUndefined();
    // Structure the operator already confirmed must survive a styling save.
    expect(saved.pages.map((p) => p.role)).toEqual(['cover', 'itinerary', 'static']);
    expect(saved.accentColor).toBe('#00A9CE');
  });

  test('rejects unparseable template syntax and names the page', async () => {
    const res = await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ pages: [{ index: 2, bodyHtml: '{{#each days}}<tr></tr>' }] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TEMPLATE_SYNTAX');
    expect(res.body.pageIndex).toBe(2);
    expect(res.body.error).toMatch(/Page 2/);
    expect(prisma.itineraryTemplate.update).not.toHaveBeenCalled();
  });

  test('strips script and event-handler markup before storing', async () => {
    await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({
        pages: [{ index: 1, bodyHtml: '<div onclick="steal()">{{title}}</div><script>fetch("/x")</script>' }],
      });

    const saved = JSON.parse(prisma.itineraryTemplate.update.mock.calls[0][0].data.pdfStyleSpecJson);
    expect(saved.pages[0].bodyHtml).toBe('<div>{{title}}</div>');
  });

  test('an empty body clears that page back to the built-in layout', async () => {
    const spec = JSON.parse(JSON.stringify(SPEC));
    spec.pages[0].bodyHtml = '<h1>old</h1>';
    prisma.itineraryTemplate.findFirst.mockResolvedValue(
      templateRow({ pdfStyleSpecJson: JSON.stringify(spec) }),
    );

    await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ pages: [{ index: 1, bodyHtml: '   ' }] });

    const saved = JSON.parse(prisma.itineraryTemplate.update.mock.calls[0][0].data.pdfStyleSpecJson);
    expect(saved.pages[0].bodyHtml).toBeUndefined();
  });

  test('409s when the template has no analysed page structure yet', async () => {
    prisma.itineraryTemplate.findFirst.mockResolvedValue(
      templateRow({ pdfStyleSpecJson: null }),
    );
    const res = await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ pages: [{ index: 1, bodyHtml: '<p>x</p>' }] });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_STYLE_SPEC');
  });

  test('400s when pages is not an array', async () => {
    const res = await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ bodyCss: 'body{}' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PAGES');
  });

  test('USER role cannot save', async () => {
    prisma.user.findUnique.mockResolvedValue({ role: 'USER', subBrandAccess: null });
    const res = await request(makeApp())
      .put('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send({ pages: [] });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /:id/html-template', () => {
  test('clears every body and the stylesheet, reporting how many were cleared', async () => {
    const spec = JSON.parse(JSON.stringify(SPEC));
    spec.bodyCss = 'body{color:red}';
    spec.pages[0].bodyHtml = '<h1>a</h1>';
    spec.pages[1].bodyHtml = '<table></table>';
    prisma.itineraryTemplate.findFirst.mockResolvedValue(
      templateRow({ pdfStyleSpecJson: JSON.stringify(spec) }),
    );

    const res = await request(makeApp())
      .delete('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);

    const saved = JSON.parse(prisma.itineraryTemplate.update.mock.calls[0][0].data.pdfStyleSpecJson);
    expect(saved.bodyCss).toBeUndefined();
    expect(saved.pages.every((p) => p.bodyHtml === undefined)).toBe(true);
    // Reverting styling must not disturb the confirmed page roles.
    expect(saved.pages.map((p) => p.role)).toEqual(['cover', 'itinerary', 'static']);
  });

  test('is a no-op when nothing was set', async () => {
    const res = await request(makeApp())
      .delete('/api/travel/itinerary-templates/301/html-template')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(0);
  });
});
