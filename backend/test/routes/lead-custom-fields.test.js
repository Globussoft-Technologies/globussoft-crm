// @ts-check
/**
 * Unit tests for backend/routes/lead_custom_fields.js
 *
 * Pins the admin-configurable Lead Custom Fields route:
 *   - GET /api/lead-custom-fields (authenticated, any role)
 *   - POST /api/lead-custom-fields (ADMIN only)
 *   - PUT /api/lead-custom-fields/:id (ADMIN only)
 *   - DELETE /api/lead-custom-fields/:id (ADMIN only)
 *
 * Covers the expanded field-type set (text, textarea, number, dropdown,
 * radio, date, url, checkbox, multiselect) plus tooltip/placeholder.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// ── Patch auth middleware to pass-through ──────────────────────────────
const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

// ── Prisma singleton patching ──────────────────────────────────────────
prisma.leadCustomFieldDefinition = prisma.leadCustomFieldDefinition || {};
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.leadCustomFieldDefinition.findMany = vi.fn();
prisma.leadCustomFieldDefinition.count = vi.fn();
prisma.leadCustomFieldDefinition.findUnique = vi.fn();
prisma.leadCustomFieldDefinition.findFirst = vi.fn();
prisma.leadCustomFieldDefinition.create = vi.fn();
prisma.leadCustomFieldDefinition.update = vi.fn();
prisma.leadCustomFieldDefinition.delete = vi.fn();
prisma.leadCustomFieldDefinition.aggregate = vi.fn();
prisma.$transaction = vi.fn();

const leadCustomFieldsRouter = requireCJS('../../routes/lead_custom_fields');

const TENANT_ID = 1;
const USER_ID = 7;

function makeApp({ role = 'ADMIN' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId: USER_ID, tenantId: TENANT_ID, role };
    next();
  });
  app.use('/api/lead-custom-fields', leadCustomFieldsRouter);
  return app;
}

beforeEach(() => {
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'generic' });
  prisma.leadCustomFieldDefinition.findMany.mockReset().mockResolvedValue([]);
  prisma.leadCustomFieldDefinition.count.mockReset().mockResolvedValue(0);
  prisma.leadCustomFieldDefinition.findUnique.mockReset().mockResolvedValue(null);
  prisma.leadCustomFieldDefinition.findFirst.mockReset().mockResolvedValue(null);
  prisma.leadCustomFieldDefinition.create.mockReset();
  prisma.leadCustomFieldDefinition.update.mockReset();
  prisma.leadCustomFieldDefinition.delete.mockReset();
  prisma.leadCustomFieldDefinition.aggregate.mockReset().mockResolvedValue({ _max: { displayOrder: null } });
  prisma.$transaction.mockReset().mockImplementation((operations) => Promise.all(operations));
});

// ───────────────────────────────────────────────────────────────────────
describe('GET /api/lead-custom-fields', () => {
  test('lists definitions with parsed options for this tenant', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
      { id: 1, tenantId: TENANT_ID, fieldKey: 'source', label: 'Source', fieldType: 'dropdown', options: JSON.stringify(['Google', 'Referral']), tooltip: null, placeholder: null, isRequired: false, displayOrder: 1 },
      { id: 2, tenantId: TENANT_ID, fieldKey: 'notes', label: 'Notes', fieldType: 'textarea', options: null, tooltip: 'Extra details', placeholder: 'Enter notes', isRequired: true, displayOrder: 2 },
    ]);

    const res = await request(makeApp()).get('/api/lead-custom-fields');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].options).toEqual(['Google', 'Referral']);
    expect(res.body[1].options).toBeNull();
    expect(res.body[1].tooltip).toBe('Extra details');
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    });
  });

  test('supports page, offset, and limit without changing the legacy array response', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
      { id: 3, tenantId: TENANT_ID, fieldKey: 'third', label: 'Third', fieldType: 'text', options: null, isRequired: false, displayOrder: 3 },
    ]);
    prisma.leadCustomFieldDefinition.count.mockResolvedValue(3);

    const res = await request(makeApp()).get('/api/lead-custom-fields?page=2&offset=1&limit=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(2);
    expect(res.body.offset).toBe(1);
    expect(res.body.limit).toBe(1);
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      skip: 1,
      take: 1,
    });
    expect(prisma.leadCustomFieldDefinition.count).toHaveBeenCalledWith({ where: { tenantId: TENANT_ID } });
  });

  test('allows travel tenants and keeps the definition query tenant-scoped', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: 'travel' });

    const res = await request(makeApp()).get('/api/lead-custom-fields');

    expect(res.status).toBe(200);
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    });
  });

  test('rejects unsupported verticals before reading definitions', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: 'wellness' });

    const res = await request(makeApp()).get('/api/lead-custom-fields');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('VERTICAL_NOT_SUPPORTED');
    expect(prisma.leadCustomFieldDefinition.findMany).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('POST /api/lead-custom-fields', () => {
  test('creates a text field', async () => {
    prisma.leadCustomFieldDefinition.create.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'referral_source', label: 'Referral Source', fieldType: 'text', options: null, tooltip: null, placeholder: null, isRequired: false, displayOrder: 1,
    });

    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: 'Referral Source',
      fieldType: 'text',
    });

    expect(res.status).toBe(201);
    expect(res.body.fieldKey).toBe('referral_source');
  });

  test.each([
    ['dropdown', ['Google', 'Referral']],
    ['radio', ['Yes', 'No']],
    ['multiselect', ['A', 'B', 'C']],
  ])('creates a %s field with options', async (fieldType, options) => {
    prisma.leadCustomFieldDefinition.create.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'choice', label: 'Choice', fieldType, options: JSON.stringify(options), tooltip: null, placeholder: null, isRequired: false, displayOrder: 1,
    });

    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: 'Choice',
      fieldType,
      options,
    });

    expect(res.status).toBe(201);
    expect(res.body.options).toEqual(options);
  });

  test.each(['textarea', 'number', 'date', 'url', 'checkbox'])('creates a %s field without options', async (fieldType) => {
    prisma.leadCustomFieldDefinition.create.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: fieldType, label: fieldType, fieldType, options: null, tooltip: null, placeholder: null, isRequired: false, displayOrder: 1,
    });

    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: fieldType,
      fieldType,
    });

    expect(res.status).toBe(201);
    expect(res.body.fieldType).toBe(fieldType);
  });

  test('rejects an unsupported fieldType', async () => {
    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: 'Bad',
      fieldType: 'formula',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_FIELD_TYPE');
  });

  test('rejects a dropdown without options', async () => {
    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: 'No options',
      fieldType: 'dropdown',
      options: [],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OPTIONS_REQUIRED');
  });

  test('stores tooltip and placeholder', async () => {
    prisma.leadCustomFieldDefinition.create.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'url', label: 'Website', fieldType: 'url', options: null, tooltip: 'Company website', placeholder: 'https://example.com', isRequired: false, displayOrder: 1,
    });

    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: 'Website',
      fieldType: 'url',
      tooltip: 'Company website',
      placeholder: 'https://example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.tooltip).toBe('Company website');
    expect(res.body.placeholder).toBe('https://example.com');
  });

  test('rejects a duplicate fieldKey', async () => {
    prisma.leadCustomFieldDefinition.findUnique.mockResolvedValue({ id: 1 });

    const res = await request(makeApp()).post('/api/lead-custom-fields').send({
      label: 'Referral Source',
      fieldType: 'text',
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_FIELD_KEY');
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('PUT /api/lead-custom-fields/:id', () => {
  test('updates radio options and tooltip', async () => {
    prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'priority', label: 'Priority', fieldType: 'radio', options: JSON.stringify(['High', 'Low']), tooltip: null, placeholder: null, isRequired: false, displayOrder: 1,
    });
    prisma.leadCustomFieldDefinition.update.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'priority', label: 'Priority', fieldType: 'radio', options: JSON.stringify(['High', 'Medium', 'Low']), tooltip: 'Choose priority', placeholder: 'Pick one', isRequired: true, displayOrder: 1,
    });

    const res = await request(makeApp()).put('/api/lead-custom-fields/1').send({
      options: ['High', 'Medium', 'Low'],
      tooltip: 'Choose priority',
      placeholder: 'Pick one',
      isRequired: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.options).toEqual(['High', 'Medium', 'Low']);
    expect(res.body.tooltip).toBe('Choose priority');
  });

  test('rejects options update on a non-choice field', async () => {
    prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'notes', label: 'Notes', fieldType: 'text', options: null, tooltip: null, placeholder: null, isRequired: false, displayOrder: 1,
    });

    const res = await request(makeApp()).put('/api/lead-custom-fields/1').send({
      options: ['A', 'B'],
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NOT_A_CHOICE_FIELD');
  });
});

describe('POST /api/lead-custom-fields/:id/move', () => {
  test('atomically reorders the complete tenant list across page boundaries', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
    prisma.leadCustomFieldDefinition.update.mockImplementation(({ where, data }) => Promise.resolve({ ...where, ...data }));

    const res = await request(makeApp()).post('/api/lead-custom-fields/2/move').send({ direction: 'up' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moved: true });
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      select: { id: true },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.leadCustomFieldDefinition.update.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: 2 }, data: { displayOrder: 1 } },
      { where: { id: 1 }, data: { displayOrder: 2 } },
      { where: { id: 3 }, data: { displayOrder: 3 } },
    ]);
  });

  test('does not expose or reorder a field from another tenant', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([{ id: 1 }]);

    const res = await request(makeApp()).post('/api/lead-custom-fields/99/move').send({ direction: 'down' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────
describe('DELETE /api/lead-custom-fields/:id', () => {
  test('deletes an existing field', async () => {
    prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, fieldKey: 'source', label: 'Source', fieldType: 'dropdown', options: null, tooltip: null, placeholder: null, isRequired: false, displayOrder: 1,
    });

    const res = await request(makeApp()).delete('/api/lead-custom-fields/1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
