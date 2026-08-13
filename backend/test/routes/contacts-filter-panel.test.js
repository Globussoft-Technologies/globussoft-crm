// @ts-check
/**
 * Freshsales-style "Filter by" panel — pins the new contract added to
 * backend/routes/contacts.js:
 *
 *   - GET  /api/contacts/filter-fields         — static FILTERABLE_FIELDS
 *     merged with this tenant's LeadCustomFieldDefinition rows.
 *   - GET  /api/contacts/filter-values/:field  — distinct values for a
 *     field: text-kind columns (DISTINCT scan), id-kind columns (User /
 *     Territory join for a human label), and "custom_<id>" fields (fixed
 *     `options` for dropdown/radio/multiselect, DISTINCT scan otherwise).
 *   - GET  /api/contacts?filters=<JSON>        — generic where-clause
 *     builder (buildFilterClause / buildCustomFieldClause) for
 *     contains / not_contains / is_empty / is_not_empty, composed into
 *     where.AND alongside the existing status/source/tenant filters.
 *
 * Both new routes are registered BEFORE the existing GET /:id route (see
 * comment in contacts.js) — a regression there would make Express treat
 * "filter-fields" as an :id value instead, which the "does not collide
 * with /:id" tests below would catch as a 400 INVALID_SOURCE-shaped or
 * id-parsing response instead of the expected filter-panel response.
 *
 * Pattern reference: contacts-source-filter.test.js (prisma singleton
 * monkey-patch + supertest against the mounted router, auth middleware
 * pass-through). Per repo convention, JWT key is userId not id.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import prisma from '../../lib/prisma.js';
import { createRequire } from 'node:module';
const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');
authMw.verifyToken = (_req, _res, next) => next();
authMw.verifyRole = () => (_req, _res, next) => next();

prisma.contact = prisma.contact || {};
prisma.contact.findMany = vi.fn();
prisma.contact.findFirst = vi.fn();
prisma.contact.count = vi.fn();
prisma.fieldPermission = prisma.fieldPermission || {};
prisma.fieldPermission.findMany = vi.fn().mockResolvedValue([]);
prisma.user = prisma.user || {};
prisma.user.findMany = vi.fn();
prisma.territory = prisma.territory || {};
prisma.territory.findMany = vi.fn();
prisma.leadCustomFieldDefinition = prisma.leadCustomFieldDefinition || {};
prisma.leadCustomFieldDefinition.findMany = vi.fn();
prisma.leadCustomFieldDefinition.findFirst = vi.fn();
prisma.leadCustomFieldValue = prisma.leadCustomFieldValue || {};
prisma.leadCustomFieldValue.findMany = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();

import express from 'express';
import request from 'supertest';
const contactsRouter = requireCJS('../../routes/contacts');

const SAMPLE_CONTACT = {
  id: 9001,
  name: 'Amita Rao',
  email: 'amita@example.com',
  status: 'Lead',
  source: 'Organic',
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
  prisma.contact.findFirst.mockReset().mockResolvedValue({ id: 1 });
  // /filter-fields no longer probes row counts at all (see the NOTE above
  // FILTERABLE_FIELDS) — this mock only backstops the ?count=1 branch on
  // the list route and keeps an accidental reintroduction visible.
  prisma.contact.count.mockReset().mockResolvedValue(2);
  prisma.user.findMany.mockReset().mockResolvedValue([]);
  prisma.territory.findMany.mockReset().mockResolvedValue([]);
  prisma.leadCustomFieldDefinition.findMany.mockReset().mockResolvedValue([]);
  prisma.leadCustomFieldDefinition.findFirst.mockReset().mockResolvedValue(null);
  // Default to a generic tenant — most tests aren't about vertical gating.
  // Tests that ARE about it (subBrand/kycStatus visibility) override this.
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ vertical: 'generic' });
  prisma.leadCustomFieldValue.findMany.mockReset().mockResolvedValue([]);
});

describe('GET /api/contacts/filter-fields', () => {
  // The field list is "every field this org HAS" — the Leads/Contacts
  // built-in columns (kept in lockstep with BUILTIN_COLUMNS in
  // table_column_preferences.js) plus every custom field the tenant's
  // admin created. There is deliberately no row-count / has-data gate;
  // see the NOTE above FILTERABLE_FIELDS in routes/contacts.js.

  test('returns every built-in field for a generic tenant with no custom fields', async () => {
    const res = await request(makeApp()).get('/api/contacts/filter-fields');

    expect(res.status).toBe(200);
    expect(res.body.fields.map((f) => f.field)).toEqual([
      'name', 'email', 'phone', 'company', 'status', 'source', 'tags', 'aiScore', 'createdAt', 'assignedToId',
    ]);
  });

  test('field kinds drive the operator + value UI: text / range / date / id', async () => {
    const res = await request(makeApp()).get('/api/contacts/filter-fields');

    const byKey = Object.fromEntries(res.body.fields.map((f) => [f.field, f]));
    expect(byKey.name.kind).toBe('text');
    expect(byKey.status.kind).toBe('text');
    expect(byKey.aiScore.kind).toBe('range');
    expect(byKey.createdAt.kind).toBe('date');
    expect(byKey.assignedToId.kind).toBe('id');
    expect(byKey.assignedToId.label).toBe('Sales Owner');
  });

  test('every column the Leads/Contacts table renders is filterable (BUILTIN_COLUMNS parity)', async () => {
    // Regression for the live report "table has columns the filter panel
    // doesn't offer". BUILTIN_COLUMNS (table_column_preferences.js) is the
    // org-facing definition of "what columns exist"; this pins that the
    // filter picker covers the same set.
    const res = await request(makeApp()).get('/api/contacts/filter-fields');

    const fieldKeys = res.body.fields.map((f) => f.field);
    for (const key of ['name', 'email', 'phone', 'company', 'aiScore', 'source', 'status', 'assignedToId', 'createdAt']) {
      expect(fieldKeys).toContain(key);
    }
  });

  test('a field with ZERO stored values is STILL offered — the org has the field either way', async () => {
    // Regression: an earlier revision gated fields on row counts, which hid
    // freshly-created custom fields (date / JOB TITLE / UTM Source / Drop
    // down / Select a Product on the live generic tenant) even though the
    // table renders a column for each. Field existence and value presence
    // are separate questions; only the VALUE list is data-driven.
    prisma.contact.count.mockResolvedValue(0);
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
      { id: 7, label: 'date', fieldType: 'date' },
      { id: 8, label: 'UTM Source', fieldType: 'text' },
    ]);

    const res = await request(makeApp()).get('/api/contacts/filter-fields');

    const fieldKeys = res.body.fields.map((f) => f.field);
    expect(fieldKeys).toContain('custom_7');
    expect(fieldKeys).toContain('custom_8');
    expect(fieldKeys).toContain('phone');
  });

  test('no per-field probe queries are issued — the list is pure metadata', async () => {
    await request(makeApp()).get('/api/contacts/filter-fields');

    expect(prisma.contact.count).not.toHaveBeenCalled();
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test("merges in this tenant's admin-defined Lead custom fields, tagged custom:true", async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
      { id: 55, label: 'Referral Source', fieldType: 'dropdown' },
      { id: 56, label: 'Budget', fieldType: 'number' },
    ]);

    const res = await request(makeApp()).get('/api/contacts/filter-fields');

    expect(res.status).toBe(200);
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 1 } }),
    );
    const custom = res.body.fields.filter((f) => f.custom);
    expect(custom).toHaveLength(2);
    expect(custom[0]).toMatchObject({ field: 'custom_55', label: 'Referral Source', kind: 'text', fieldType: 'dropdown' });
    expect(custom[1]).toMatchObject({ field: 'custom_56', label: 'Budget', fieldType: 'number' });
  });

  test('custom fields are scoped to the caller tenant — another org never sees them', async () => {
    await request(makeApp({ tenantId: 42 })).get('/api/contacts/filter-fields');

    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: 42 } }),
    );
  });

  test('does not collide with /:id — "filter-fields" is not parsed as a contact id', async () => {
    const res = await request(makeApp()).get('/api/contacts/filter-fields');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('fields');
  });

  describe('vertical gate (subBrand / kycStatus are travel-only)', () => {
    // REGRESSION — the live bug report: a generic tenant (NovaCrest) had a
    // single stray/seed Contact row with subBrand:"tmc", and EVERY row
    // carries kycStatus:"unverified" from the schema's own @default, so
    // both leaked "travel feature" fields into a generic org's picker.
    // Gating on Tenant.vertical is what keeps them out.

    test('generic tenant never sees subBrand or kycStatus', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ vertical: 'generic' });

      const res = await request(makeApp()).get('/api/contacts/filter-fields');

      const fieldKeys = res.body.fields.map((f) => f.field);
      expect(fieldKeys).not.toContain('subBrand');
      expect(fieldKeys).not.toContain('kycStatus');
    });

    test('wellness tenant never sees subBrand or kycStatus either', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });

      const res = await request(makeApp()).get('/api/contacts/filter-fields');

      const fieldKeys = res.body.fields.map((f) => f.field);
      expect(fieldKeys).not.toContain('subBrand');
      expect(fieldKeys).not.toContain('kycStatus');
    });

    test('travel tenant DOES see subBrand/kycStatus', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ vertical: 'travel' });

      const res = await request(makeApp()).get('/api/contacts/filter-fields');

      const fieldKeys = res.body.fields.map((f) => f.field);
      expect(fieldKeys).toContain('subBrand');
      expect(fieldKeys).toContain('kycStatus');
    });

    test('a tenant row with no vertical falls back to generic (no travel fields)', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);

      const res = await request(makeApp()).get('/api/contacts/filter-fields');

      expect(res.status).toBe(200);
      expect(res.body.fields.map((f) => f.field)).not.toContain('subBrand');
    });
  });
});

describe('GET /api/contacts/filter-values/:field', () => {
  test('unknown field → 404 UNKNOWN_FIELD', async () => {
    const res = await request(makeApp()).get('/api/contacts/filter-values/notAField');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'UNKNOWN_FIELD' });
  });

  test('text-kind REQUIRED field (status) → DISTINCT scan filters not-empty-string, NOT not-null', async () => {
    // Regression test for a real production bug: Contact.status is
    // `String @default(...)` — non-nullable — and Prisma's real client
    // rejects `{ not: null }` on it ("Argument `not` must not be null",
    // confirmed against a live Prisma client/DB, not just this mock) since
    // null is not a legal value for that field's type at all. The mock
    // here can't catch that class of error (it accepts any where-shape),
    // which is exactly how this bug shipped once already — the assertion
    // on the exact where-clause shape is what pins the fix.
    prisma.contact.findMany.mockResolvedValue([{ status: 'Lead' }, { status: 'Customer' }]);

    const res = await request(makeApp({ tenantId: 3 })).get('/api/contacts/filter-values/status');

    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
      // scopeWhere (empty here, unscoped) is AND-combined as AND[0] rather
      // than flat-spread — see the collision-avoidance comment in
      // contacts.js above this query.
      where: { tenantId: 3, deletedAt: null, AND: [{}, { status: { not: '' } }] },
      distinct: ['status'],
    }));
    expect(res.body.values).toEqual([
      { value: 'Lead', label: 'Lead' },
      { value: 'Customer', label: 'Customer' },
    ]);
  });

  test('id-kind field assignedToId → resolves User rows, not a DISTINCT scan on Contact', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 7, name: 'Jane Doe', email: 'jane@x.com' },
      { id: 8, name: null, email: 'noname@x.com' },
    ]);

    const res = await request(makeApp()).get('/api/contacts/filter-values/assignedToId');

    expect(res.status).toBe(200);
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(res.body.values).toEqual([
      { value: '7', label: 'Jane Doe' },
      { value: '8', label: 'noname@x.com' }, // falls back to email when name is null
    ]);
  });

  test('a field not in FILTERABLE_FIELDS → 404 (territoryId is not a table column, so not offered)', async () => {
    const res = await request(makeApp()).get('/api/contacts/filter-values/territoryId');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'UNKNOWN_FIELD' });
  });

  test('custom_<id> not owned by this tenant → 404 UNKNOWN_FIELD (no cross-tenant leak)', async () => {
    prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue(null);

    const res = await request(makeApp({ tenantId: 1 })).get('/api/contacts/filter-values/custom_999');

    expect(res.status).toBe(404);
    expect(prisma.leadCustomFieldDefinition.findFirst).toHaveBeenCalledWith({ where: { id: 999, tenantId: 1 } });
  });

  test('custom_<id> dropdown field → returns the field\'s own `options`, not a DB value scan', async () => {
    prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({
      id: 55, tenantId: 1, fieldType: 'dropdown', options: JSON.stringify(['Referral', 'Ad', 'Organic']),
    });

    const res = await request(makeApp()).get('/api/contacts/filter-values/custom_55');

    expect(res.status).toBe(200);
    expect(prisma.leadCustomFieldValue.findMany).not.toHaveBeenCalled();
    expect(res.body.values).toEqual([
      { value: 'Referral', label: 'Referral' },
      { value: 'Ad', label: 'Ad' },
      { value: 'Organic', label: 'Organic' },
    ]);
  });

  test('custom_<id> text field → DISTINCT scan on LeadCustomFieldValue.valueText', async () => {
    prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({ id: 56, tenantId: 1, fieldType: 'text', options: null });
    prisma.leadCustomFieldValue.findMany.mockResolvedValue([{ valueText: '5000' }, { valueText: '10000' }]);

    const res = await request(makeApp()).get('/api/contacts/filter-values/custom_56');

    expect(res.status).toBe(200);
    expect(prisma.leadCustomFieldValue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { fieldId: 56, tenantId: 1, valueText: { not: null } },
      distinct: ['valueText'],
    }));
    expect(res.body.values).toEqual([
      { value: '5000', label: '5000' },
      { value: '10000', label: '10000' },
    ]);
  });

  describe('?status=<value> scoping (Leads page passes status=Lead)', () => {
    // Uses the `email` field (not `status`) — querying /filter-values/
    // status would legitimately put a `status` key in the where-clause as
    // the DISTINCT column filter itself, colliding with the ?status scoping
    // key this block is testing.
    test('without ?status, the static-field DISTINCT scan is not scoped by status', async () => {
      prisma.contact.findMany.mockResolvedValue([{ email: 'a@x.com' }]);

      await request(makeApp()).get('/api/contacts/filter-values/email');

      const call = prisma.contact.findMany.mock.calls[0][0];
      // scopeWhere is AND-combined (AND[0]) alongside the column filter
      // (AND[1]) rather than flat-spread — see the collision-avoidance
      // comment above this query in contacts.js. Unscoped → AND[0] is {}.
      expect(call.where.AND[0]).toEqual({});
    });

    test('?status=Lead scopes the static-field DISTINCT scan to status:"Lead"', async () => {
      prisma.contact.findMany.mockResolvedValue([{ email: 'a@x.com' }]);

      await request(makeApp()).get('/api/contacts/filter-values/email?status=Lead');

      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ tenantId: 1, deletedAt: null });
      expect(call.where.AND).toEqual([{ status: 'Lead' }, { email: { not: null } }]);
    });

    test('REGRESSION: ?status=Lead scoping /filter-values/status itself does not get clobbered by the column filter', async () => {
      // The exact bug found live: /filter-values/status?status=Lead returned
      // ALL statuses instead of just "Lead", because a flat spread let the
      // column filter's `status` key silently overwrite the scope's
      // `status` key (both targeted the same object property). Confirmed
      // fixed against the live dev DB — this pins the where-clause shape
      // that makes it work.
      prisma.contact.findMany.mockResolvedValue([{ status: 'Lead' }]);

      await request(makeApp()).get('/api/contacts/filter-values/status?status=Lead');

      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{ status: 'Lead' }, { status: { not: '' } }]);
    });

    test('?status=Lead scopes the custom-field value scan through the contact relation', async () => {
      prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({ id: 56, tenantId: 1, fieldType: 'text', options: null });
      prisma.leadCustomFieldValue.findMany.mockResolvedValue([{ valueText: 'x' }]);

      await request(makeApp()).get('/api/contacts/filter-values/custom_56?status=Lead');

      const call = prisma.leadCustomFieldValue.findMany.mock.calls[0][0];
      expect(call.where.contact).toEqual({ status: 'Lead', deletedAt: null });
    });

    test('without ?status, the custom-field value scan does not join through `contact` at all', async () => {
      prisma.leadCustomFieldDefinition.findFirst.mockResolvedValue({ id: 56, tenantId: 1, fieldType: 'text', options: null });
      prisma.leadCustomFieldValue.findMany.mockResolvedValue([{ valueText: 'x' }]);

      await request(makeApp()).get('/api/contacts/filter-values/custom_56');

      const call = prisma.leadCustomFieldValue.findMany.mock.calls[0][0];
      expect(call.where).not.toHaveProperty('contact');
    });

    test('owner (assignedToId) values are NOT status-scoped — the User list is org-wide regardless of view', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 7, name: 'Jane Doe', email: 'jane@x.com' }]);

      await request(makeApp()).get('/api/contacts/filter-values/assignedToId?status=Lead');

      expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 1 } }));
    });
  });

  describe('"date" kind — values are day-labels (YYYY-MM-DD), time-of-day dropped', () => {
    test('createdAt DISTINCT scan is deduped + normalized to calendar-day strings', async () => {
      prisma.contact.findMany.mockResolvedValue([
        { createdAt: new Date('2026-01-15T08:30:00Z') },
        { createdAt: new Date('2026-01-15T21:00:00Z') }, // same day, different time — dedupes to one value
        { createdAt: new Date('2026-02-01T00:00:00Z') },
      ]);

      const res = await request(makeApp()).get('/api/contacts/filter-values/createdAt');

      expect(res.status).toBe(200);
      expect(res.body.values).toEqual([
        { value: '2026-01-15', label: '2026-01-15' },
        { value: '2026-02-01', label: '2026-02-01' },
      ]);
    });

    test('required date field (createdAt) DISTINCT scan has no not-null/not-empty predicate — every row already has a value', async () => {
      prisma.contact.findMany.mockResolvedValue([]);

      await request(makeApp()).get('/api/contacts/filter-values/createdAt');

      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{}, {}]);
    });
  });

  describe('"range" kind — aiScore offers fixed buckets, never a DISTINCT scan of individual scores', () => {
    test('returns the four Lead Score buckets and never queries Contact', async () => {
      // Regression: a DISTINCT scan listed every individual score present
      // (5, 36, 49, 64, 66, 68, 72…) — an unusable checkbox list that grows
      // with the data. Buckets mirror Contacts.jsx's SCORE_BUCKETS.
      const res = await request(makeApp()).get('/api/contacts/filter-values/aiScore');

      expect(res.status).toBe(200);
      expect(res.body.values).toEqual([
        { value: '0-25', label: '0 - 25' },
        { value: '26-50', label: '26 - 50' },
        { value: '51-75', label: '51 - 75' },
        { value: '76-100', label: '76 - 100' },
      ]);
      expect(prisma.contact.findMany).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/contacts?filters=<JSON> — generic where-clause builder', () => {
  test('absent ?filters → no where.AND key added', async () => {
    const res = await request(makeApp()).get('/api/contacts');
    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });

  test('invalid JSON → 400 INVALID_FILTERS; findMany not called', async () => {
    const res = await request(makeApp()).get('/api/contacts?filters=not-json');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FILTERS' });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
  });

  test('non-array JSON → 400 INVALID_FILTERS', async () => {
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify({ field: 'status' }))}`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_FILTERS' });
  });

  test('text field "contains" → OR of `contains` matches inside where.AND', async () => {
    const filters = [{ field: 'source', operator: 'contains', values: ['Referral', 'Web'] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([
      { OR: [{ source: { contains: 'Referral' } }, { source: { contains: 'Web' } }] },
    ]);
  });

  test('text field "not_contains" → AND of negated `contains` matches', async () => {
    const filters = [{ field: 'source', operator: 'not_contains', values: ['Referral'] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([
      { AND: [{ source: { not: { contains: 'Referral' } } }] },
    ]);
  });

  test('"is_empty" on a text field → OR[null, ""]; values array ignored', async () => {
    const filters = [{ field: 'email', operator: 'is_empty', values: [] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ OR: [{ email: null }, { email: '' }] }]);
  });

  test('"is_not_empty" on a text field → AND[not null, not ""]', async () => {
    const filters = [{ field: 'email', operator: 'is_not_empty', values: [] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ AND: [{ email: { not: null } }, { email: { not: '' } }] }]);
  });

  test('"is_empty" on the REQUIRED text field (status) → equality "" only, no `null` reference at all', async () => {
    // Regression test: Contact.status is non-nullable — a where-clause
    // that mentions `{ status: null }` (even inside an OR) is what a real
    // Prisma client rejects for this column. Pins that the required-field
    // branch never produces a null literal for `status`.
    const filters = [{ field: 'status', operator: 'is_empty', values: [] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ status: '' }]);
  });

  test('"is_not_empty" on the REQUIRED text field (status) → not-empty-string only, no `not: null`', async () => {
    // Regression test for the exact bug that shipped: this used to be
    // `{ AND: [{ status: { not: null } }, ...] }`, which a real (unmocked)
    // Prisma client throws on for a non-nullable column ("Argument `not`
    // must not be null") — confirmed against the live dev DB. This mock
    // alone can't catch that error class, which is why the wrong shape
    // shipped once already; the exact-shape assertion is what pins it.
    const filters = [{ field: 'status', operator: 'is_not_empty', values: [] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ status: { not: '' } }]);
  });

  test('id-kind field (assignedToId) "contains" → { in: [...] } on the raw ids, non-numeric values dropped', async () => {
    const filters = [{ field: 'assignedToId', operator: 'contains', values: ['7', '8', 'not-a-number'] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ assignedToId: { in: [7, 8] } }]);
  });

  test('id-kind field "is_empty" → equality null (no OR[""], integers have no empty string)', async () => {
    const filters = [{ field: 'assignedToId', operator: 'is_empty', values: [] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ assignedToId: null }]);
  });

  test('unknown field is skipped silently (stale client cache, not an error)', async () => {
    const filters = [{ field: 'notAField', operator: 'contains', values: ['x'] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });

  test('unknown operator is skipped silently', async () => {
    const filters = [{ field: 'status', operator: 'greater_than', values: ['x'] }];
    const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });

  test('custom_<id> field owned by this tenant → relational `some` clause on leadCustomFieldValues', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([{ id: 55 }]);
    const filters = [{ field: 'custom_55', operator: 'contains', values: ['Referral'] }];
    const res = await request(makeApp({ tenantId: 1 })).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1 },
      // fieldType comes back too — it decides which typed column on
      // LeadCustomFieldValue the clause probes (valueDate vs valueText).
      select: { id: true, fieldType: true },
    });
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([
      { leadCustomFieldValues: { some: { fieldId: 55, OR: [{ valueText: { contains: 'Referral' } }] } } },
    ]);
  });

  test('custom_<id> field NOT belonging to this tenant → silently dropped (no cross-tenant filter leak)', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([{ id: 55 }]); // tenant only owns 55
    const filters = [{ field: 'custom_999', operator: 'contains', values: ['x'] }]; // probing a foreign id
    const res = await request(makeApp({ tenantId: 1 })).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });

  test('custom_<id> "is_empty" → OR[no value row at all, OR row exists with empty valueText]', async () => {
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([{ id: 55 }]);
    const filters = [{ field: 'custom_55', operator: 'is_empty', values: [] }];
    const res = await request(makeApp({ tenantId: 1 })).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{
      OR: [
        { leadCustomFieldValues: { none: { fieldId: 55 } } },
        { leadCustomFieldValues: { some: { fieldId: 55, OR: [{ valueText: null }, { valueText: '' }] } } },
      ],
    }]);
  });

  test('combined with existing ?status= param — both compose in the same where', async () => {
    const filters = [{ field: 'source', operator: 'contains', values: ['Referral'] }];
    const res = await request(makeApp()).get(`/api/contacts?status=Lead&filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.status).toBe('Lead');
    expect(call.where.AND).toEqual([{ OR: [{ source: { contains: 'Referral' } }] }]);
  });

  test('tenant scope preserved alongside filters', async () => {
    const filters = [{ field: 'status', operator: 'is_not_empty', values: [] }];
    const res = await request(makeApp({ tenantId: 42 })).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

    expect(res.status).toBe(200);
    const call = prisma.contact.findMany.mock.calls[0][0];
    expect(call.where.tenantId).toBe(42);
  });

  describe('"range" kind (aiScore) — bucket keys resolve to gte/lte ranges', () => {
    test('"contains" → OR of {gte,lte} per picked bucket; unknown bucket keys dropped', async () => {
      const filters = [{ field: 'aiScore', operator: 'contains', values: ['26-50', '76-100', 'not-a-bucket'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{
        OR: [
          { aiScore: { gte: 26, lte: 50 } },
          { aiScore: { gte: 76, lte: 100 } },
        ],
      }]);
    });

    test('"not_contains" → AND of NOT{gte,lte}', async () => {
      const filters = [{ field: 'aiScore', operator: 'not_contains', values: ['0-25'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{ AND: [{ NOT: { aiScore: { gte: 0, lte: 25 } } }] }]);
    });

    test('only unknown bucket keys → clause dropped entirely (no bogus range)', async () => {
      const filters = [{ field: 'aiScore', operator: 'contains', values: ['999-1000'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toBeUndefined();
    });

    test('"is_empty" on required number field (aiScore) → matches nothing (every row already has a value)', async () => {
      const filters = [{ field: 'aiScore', operator: 'is_empty', values: [] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{ id: { in: [] } }]);
    });

    test('"is_not_empty" on required number field (aiScore) → matches everything (no-op predicate)', async () => {
      const filters = [{ field: 'aiScore', operator: 'is_not_empty', values: [] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{}]);
    });
  });

  describe('"date" kind (createdAt) — exact calendar-day match via [start,end) ranges', () => {
    test('"contains" with one date → OR[{gte,lt}] spanning that UTC day', async () => {
      const filters = [{ field: 'createdAt', operator: 'contains', values: ['2026-01-15'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toHaveLength(1);
      const clause = call.where.AND[0];
      expect(clause.OR).toHaveLength(1);
      expect(clause.OR[0].createdAt.gte.toISOString()).toBe('2026-01-15T00:00:00.000Z');
      expect(clause.OR[0].createdAt.lt.toISOString()).toBe('2026-01-16T00:00:00.000Z');
    });

    test('"not_contains" → AND[NOT{range}], unparseable date values are dropped', async () => {
      const filters = [{ field: 'createdAt', operator: 'not_contains', values: ['2026-01-15', 'not-a-date'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const call = prisma.contact.findMany.mock.calls[0][0];
      const clause = call.where.AND[0];
      expect(clause.AND).toHaveLength(1); // "not-a-date" dropped, not a second AND entry
      expect(clause.AND[0].NOT.createdAt.gte.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    test('"is_empty" on required date field (createdAt) → matches nothing', async () => {
      const filters = [{ field: 'createdAt', operator: 'is_empty', values: [] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const call = prisma.contact.findMany.mock.calls[0][0];
      expect(call.where.AND).toEqual([{ id: { in: [] } }]);
    });
  });

  describe('"between" operator — the calendar range a date field is picked with', () => {
    const andOf = () => prisma.contact.findMany.mock.calls[0][0].where.AND;

    test('[from, to] → one inclusive-of-both-days range', async () => {
      const filters = [{ field: 'createdAt', operator: 'between', values: ['2026-08-01', '2026-08-31'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      const r = andOf()[0].createdAt;
      expect(r.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      // End day is exclusive-of-the-NEXT-day, so a timestamp at any hour on
      // Aug 31 still matches. `lte` against Aug 31 midnight would drop them.
      expect(r.lt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    test('same date on both ends → that single day', async () => {
      const filters = [{ field: 'createdAt', operator: 'between', values: ['2026-08-03', '2026-08-03'] }];
      await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const r = andOf()[0].createdAt;
      expect(r.gte.toISOString()).toBe('2026-08-03T00:00:00.000Z');
      expect(r.lt.toISOString()).toBe('2026-08-04T00:00:00.000Z');
    });

    test('open-ended [from, ""] → only a lower bound; the blank end is not shifted into `from`', async () => {
      const filters = [{ field: 'createdAt', operator: 'between', values: ['2026-05-01', ''] }];
      await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const r = andOf()[0].createdAt;
      expect(r.gte.toISOString()).toBe('2026-05-01T00:00:00.000Z');
      expect(r.lt).toBeUndefined();
    });

    test('open-ended ["", to] → only an upper bound', async () => {
      const filters = [{ field: 'createdAt', operator: 'between', values: ['', '2026-05-01'] }];
      await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const r = andOf()[0].createdAt;
      expect(r.gte).toBeUndefined();
      expect(r.lt.toISOString()).toBe('2026-05-02T00:00:00.000Z');
    });

    test('both ends blank / unparseable → clause dropped, not an empty range', async () => {
      const filters = [{ field: 'createdAt', operator: 'between', values: ['', 'not-a-date'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      expect(prisma.contact.findMany.mock.calls[0][0].where.AND).toBeUndefined();
    });

    test('"between" on a non-date field is ignored', async () => {
      const filters = [{ field: 'source', operator: 'between', values: ['2026-01-01', '2026-12-31'] }];
      await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(prisma.contact.findMany.mock.calls[0][0].where.AND).toBeUndefined();
    });
  });

  describe('custom DATE fields query valueDate, not valueText', () => {
    // Regression: every custom field was handed to the clause builder as
    // "text", so a Date-picker field probed valueText — always NULL for a
    // date field, since its values live in valueDate. `between` then built
    // no clause at all and the request came back completely UNFILTERED,
    // which reads as "the filter did nothing" rather than as an error.
    beforeEach(() => {
      prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
        { id: 7, fieldType: 'date' },
        { id: 9, fieldType: 'dropdown' },
      ]);
    });

    test('between on a custom date field → valueDate range on the relation', async () => {
      const filters = [{ field: 'custom_7', operator: 'between', values: ['2026-08-01', '2026-08-31'] }];
      const res = await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      expect(res.status).toBe(200);
      const some = prisma.contact.findMany.mock.calls[0][0].where.AND[0].leadCustomFieldValues.some;
      expect(some.fieldId).toBe(7);
      expect(some.valueDate.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(some.valueDate.lt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(some.valueText).toBeUndefined();
    });

    test('is_not_empty on a custom date field checks valueDate', async () => {
      const filters = [{ field: 'custom_7', operator: 'is_not_empty', values: [] }];
      await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const some = prisma.contact.findMany.mock.calls[0][0].where.AND[0].leadCustomFieldValues.some;
      expect(some).toEqual({ fieldId: 7, valueDate: { not: null } });
    });

    test('a non-date custom field still matches on valueText', async () => {
      const filters = [{ field: 'custom_9', operator: 'contains', values: ['Google'] }];
      await request(makeApp()).get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify(filters))}`);

      const some = prisma.contact.findMany.mock.calls[0][0].where.AND[0].leadCustomFieldValues.some;
      expect(some.fieldId).toBe(9);
      expect(some.OR).toEqual([{ valueText: { contains: 'Google' } }]);
    });
  });

});
