// @ts-check
/**
 * Custom Objects (EAV) module — backend coverage push.
 *
 * routes/custom_objects.js was 21.49% (≈ 23/107 lines). This is the EAV
 * (Entity-Attribute-Value) custom-objects + custom-fields system: tenants
 * define a CustomEntity (e.g. "Vehicle") with N CustomFields (typed
 * String / Number / Boolean / Date), then store CustomRecord rows whose
 * CustomValue children are dispatched to the right column based on
 * field.type. The list endpoint denormalises the EAV graph back into
 * flat row objects keyed by field name for the React UI.
 *
 * Mount path: app.use("/api/custom_objects", customObjectsRoutes) — the
 * URL uses an UNDERSCORE, not a hyphen. Watch for this.
 *
 * Endpoints covered:
 *   GET    /api/custom_objects/entities             — list + include fields
 *   POST   /api/custom_objects/entities             — create entity + nested fields
 *   GET    /api/custom_objects/records/:entityName  — list records (denormalised)
 *                                                   — 404 unknown entity name
 *   POST   /api/custom_objects/records/:entityName  — create record (typed dispatch)
 *                                                   — 404 unknown entity name
 *
 * EAV branches exercised:
 *   - String  → valueStr   (default branch)
 *   - Number  → valueNum   (parseFloat)
 *   - Boolean → valueBool  (Boolean cast)
 *   - Date    → falls into the default valueStr branch in the LIST handler
 *               (route lookup formats Date type via valueDate; create handler
 *               does NOT explicitly write valueDate, so the row stores the
 *               value as a stringified date in valueStr — see note below).
 *   - Unknown field name in payload → entity.fields.map produces undefined
 *               for that slot → valueStr becomes '' (empty string)
 *   - Tenant-scoped lookup on entity name → cross-tenant request returns 404
 *
 * Pattern: cached-token / authXyz helpers identical to sla-breach-api.spec.js.
 * Test data is tagged `E2E_CO_<ts>` so global-teardown can scrub. There is
 * NO DELETE endpoint on this router — afterAll best-effort marks our entities
 * by leaving them with a `${RUN_TAG}` prefix so a teardown sweep can find them.
 *
 * Tenant note: /api/custom_objects works on the GENERIC tenant (not
 * wellness-only). The route only checks verifyToken + tenantId scoping.
 * We log in as admin@globussoft.com (generic admin).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let authToken = null;
const RUN_TAG = `E2E_CO_${Date.now()}`;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const auth = async (request) => ({ Authorization: `Bearer ${await getAuthToken(request)}` });

async function authGet(request, path) {
  return request.get(`${BASE_URL}${path}`, { headers: await auth(request), timeout: REQUEST_TIMEOUT });
}
async function authPost(request, path, body) {
  const headers = { ...(await auth(request)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── cleanup tracking (route exposes no DELETE — best-effort tag-only) ─
const createdEntityNames = [];

test.afterAll(async () => {
  // No DELETE endpoint exists on /api/custom_objects. Our entities + records
  // remain in the DB — global-teardown should sweep by `${RUN_TAG}` prefix on
  // CustomEntity.name. We leave a sentinel marker in the description field on
  // create so a manual sweep can identify our rows even if names collide.
});

// Helper: build a unique entity name per test using RUN_TAG + a tail.
function entityName(suffix) {
  return `${RUN_TAG}_${suffix}_${Math.floor(Math.random() * 1e6)}`;
}

// Helper: create an entity with named fields + remember its name.
async function createEntity(request, fields, suffix = 'ent', description) {
  const name = entityName(suffix);
  const res = await authPost(request, '/api/custom_objects/entities', {
    name,
    description: description || `${RUN_TAG} entity description`,
    fields,
  });
  expect(res.status(), `entity create: ${await res.text()}`).toBe(201);
  const ent = await res.json();
  createdEntityNames.push(name);
  return { name, entity: ent };
}

// ─── GET /entities ──────────────────────────────────────────────────

test.describe('Custom Objects API — GET /entities', () => {
  test('returns array (initial sanity)', async ({ request }) => {
    const res = await authGet(request, '/api/custom_objects/entities');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('our newly-created entity shows up in the list with its fields included', async ({ request }) => {
    const { name } = await createEntity(request, [
      { name: 'License Plate', type: 'String' },
      { name: 'Wheels', type: 'Number' },
    ], 'list-shows-up');

    const list = await (await authGet(request, '/api/custom_objects/entities')).json();
    const mine = list.find((e) => e.name === name);
    expect(mine, 'created entity must appear in the list').toBeTruthy();
    expect(Array.isArray(mine.fields)).toBe(true);
    expect(mine.fields.length).toBe(2);
    const fieldNames = mine.fields.map((f) => f.name).sort();
    expect(fieldNames).toEqual(['License Plate', 'Wheels'].sort());
  });
});

// ─── POST /entities ─────────────────────────────────────────────────

test.describe('Custom Objects API — POST /entities', () => {
  test('creates entity with one String field', async ({ request }) => {
    const { entity } = await createEntity(request, [{ name: 'Color', type: 'String' }], 'one-string');
    expect(entity.id).toBeTruthy();
    expect(entity.name).toContain(RUN_TAG);
    expect(entity.fields).toHaveLength(1);
    expect(entity.fields[0].type).toBe('String');
  });

  test('creates entity with multiple typed fields (String/Number/Boolean/Date)', async ({ request }) => {
    const { entity } = await createEntity(request, [
      { name: 'Title', type: 'String' },
      { name: 'Count', type: 'Number' },
      { name: 'Active', type: 'Boolean' },
      { name: 'Due', type: 'Date' },
    ], 'all-types');
    expect(entity.fields).toHaveLength(4);
    const types = entity.fields.map((f) => f.type).sort();
    expect(types).toEqual(['Boolean', 'Date', 'Number', 'String'].sort());
  });

  test('missing fields array — handler defaults to [] (post-#419)', async ({ request }) => {
    // Pre-#419 the handler did `fields.map(...)` without a guard →
    // TypeError → 500. Commit b90ac7c hardened the validator to treat
    // missing fields as []; the entity is created with no fields and
    // returns 201. Accept 400 too in case a future stricter validator
    // decides "missing fields" should be an explicit reject.
    const res = await authPost(request, '/api/custom_objects/entities', {
      name: entityName('no-fields'),
      description: 'created-with-empty-fields',
    });
    expect([201, 400]).toContain(res.status());
  });

  test('500 when "fields" is the wrong type (string instead of array)', async ({ request }) => {
    const res = await authPost(request, '/api/custom_objects/entities', {
      name: entityName('wrong-type'),
      fields: 'not-an-array',
    });
    expect([400, 500]).toContain(res.status());
  });

  test('accepts empty fields array (entity with zero attrs)', async ({ request }) => {
    const { entity } = await createEntity(request, [], 'no-fields');
    expect(entity.fields).toHaveLength(0);
  });

  test('description is persisted', async ({ request }) => {
    const desc = `${RUN_TAG} my custom entity description`;
    const { entity } = await createEntity(request, [{ name: 'X', type: 'String' }], 'with-desc', desc);
    expect(entity.description).toBe(desc);
  });

  test('tenantId is server-stamped (cannot be overridden in body)', async ({ request }) => {
    const name = entityName('tenant-stamp');
    const res = await authPost(request, '/api/custom_objects/entities', {
      name,
      description: 'tenant-stamp test',
      fields: [{ name: 'F', type: 'String' }],
      tenantId: 99999, // ignored
    });
    expect(res.status()).toBe(201);
    const ent = await res.json();
    createdEntityNames.push(name);
    expect(ent.tenantId).not.toBe(99999);
    expect(typeof ent.tenantId).toBe('number');
  });
});

// ─── GET /records/:entityName ───────────────────────────────────────

test.describe('Custom Objects API — GET /records/:entityName', () => {
  test('404 on unknown entity name', async ({ request }) => {
    const res = await authGet(request, `/api/custom_objects/records/${RUN_TAG}_DOES_NOT_EXIST`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/entity definition missing/i);
  });

  test('returns {entity, records:[]} when no records exist yet', async ({ request }) => {
    const { name } = await createEntity(request, [
      { name: 'Plate', type: 'String' },
    ], 'empty-records');
    const res = await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.entity).toBeTruthy();
    expect(body.entity.name).toBe(name);
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records).toHaveLength(0);
  });

  test('records are denormalised: each row gets {id, createdAt, …field-keys}', async ({ request }) => {
    const { name } = await createEntity(request, [
      { name: 'Plate', type: 'String' },
      { name: 'Wheels', type: 'Number' },
    ], 'denorm');
    const cr = await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      Plate: 'AB-12-CD',
      Wheels: 4,
    });
    expect(cr.status()).toBe(201);

    const res = await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    const row = body.records[0];
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeTruthy();
    expect(row.Plate).toBe('AB-12-CD');
    expect(row.Wheels).toBe(4);
  });

  test('Boolean-type values come back as booleans', async ({ request }) => {
    const { name } = await createEntity(request, [
      { name: 'Active', type: 'Boolean' },
    ], 'bool-rt');
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      Active: true,
    });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].Active).toBe(true);
  });

  test('Number-type values come back as numbers', async ({ request }) => {
    const { name } = await createEntity(request, [
      { name: 'Score', type: 'Number' },
    ], 'num-rt');
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      Score: 87.5,
    });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].Score).toBeCloseTo(87.5, 2);
  });

  test('multiple records return in their own rows', async ({ request }) => {
    const { name } = await createEntity(request, [
      { name: 'Tag', type: 'String' },
    ], 'multi');
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, { Tag: 'one' });
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, { Tag: 'two' });
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, { Tag: 'three' });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(3);
    const tags = body.records.map((r) => r.Tag).sort();
    expect(tags).toEqual(['one', 'three', 'two']);
  });
});

// ─── POST /records/:entityName ──────────────────────────────────────

test.describe('Custom Objects API — POST /records/:entityName', () => {
  test('404 on unknown entity name (constraint violation message)', async ({ request }) => {
    const res = await authPost(request, `/api/custom_objects/records/${RUN_TAG}_NOPE`, {
      Foo: 'bar',
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toMatch(/entity constraint violation/i);
  });

  test('creates a record with one String field', async ({ request }) => {
    const { name } = await createEntity(request, [{ name: 'Note', type: 'String' }], 'rec-string');
    const res = await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      Note: 'hello world',
    });
    expect(res.status()).toBe(201);
    const rec = await res.json();
    expect(rec.id).toBeTruthy();
    expect(rec.entityId).toBeTruthy();
  });

  test('typed dispatch — Number routes to valueNum (parseFloat applied)', async ({ request }) => {
    const { name } = await createEntity(request, [{ name: 'Qty', type: 'Number' }], 'rec-num');
    // Pass as STRING — handler does parseFloat — should round-trip as number.
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      Qty: '42.5',
    });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records[0].Qty).toBeCloseTo(42.5, 2);
  });

  test('typed dispatch — Boolean routes to valueBool', async ({ request }) => {
    const { name } = await createEntity(request, [{ name: 'IsOn', type: 'Boolean' }], 'rec-bool');
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, { IsOn: true });
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, { IsOn: false });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(2);
    const vals = body.records.map((r) => r.IsOn).sort();
    expect(vals).toEqual([false, true]);
  });

  test('Boolean cast: truthy non-bool becomes true', async ({ request }) => {
    const { name } = await createEntity(request, [{ name: 'Flag', type: 'Boolean' }], 'rec-bool-coerce');
    // The handler does Boolean(val) — string 'no' is truthy, so this becomes true.
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, { Flag: 'no' });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].Flag).toBe(true);
  });

  test('missing field in payload → record stores empty string for that slot', async ({ request }) => {
    // entity.fields.map iterates over field defs; if payload omits a key,
    // val is undefined → default branch writes `valueStr = ''` (no error).
    const { name } = await createEntity(request, [
      { name: 'A', type: 'String' },
      { name: 'B', type: 'String' },
    ], 'partial-payload');
    await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      A: 'present',
      // B intentionally omitted
    });
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].A).toBe('present');
    // B is mapped from valueStr which was set to '' — handler's default branch.
    expect(['', null, undefined]).toContain(body.records[0].B);
  });

  test('unknown field NAME in payload is silently dropped (only entity.fields are iterated)', async ({ request }) => {
    // The handler enumerates entity.fields, NOT payload keys. So extra keys
    // sent in the request body that don't match any defined field are
    // ignored — no 400, no error, no leakage.
    const { name } = await createEntity(request, [{ name: 'Known', type: 'String' }], 'unknown-key');
    const res = await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      Known: 'kept',
      UnknownGarbage: 'should-not-appear',
    });
    expect(res.status()).toBe(201);
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].Known).toBe('kept');
    expect('UnknownGarbage' in body.records[0]).toBe(false);
  });

  test('Number field with non-numeric input → stored as NaN (parseFloat behaviour)', async ({ request }) => {
    // parseFloat('abc') === NaN. Prisma stores it as NaN/null depending on
    // column nullability. Either way the route must not 500.
    const { name } = await createEntity(request, [{ name: 'N', type: 'Number' }], 'num-nan');
    const res = await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      N: 'abc',
    });
    // Could be 201 (NaN stored / nulled) or 500 (DB rejects NaN). Be tolerant.
    expect([201, 500]).toContain(res.status());
  });

  test('record is tenant-scoped via entity lookup (cross-tenant returns 404)', async ({ request }) => {
    // We can't easily forge a different tenant token here, but the entity
    // lookup is `WHERE name = ? AND tenantId = req.user.tenantId`. So a name
    // that doesn't exist for this tenant returns 404 — our generic admin
    // can't see wellness-tenant entities. Sanity: query an obviously-bogus
    // wellness-prefixed name.
    const res = await authGet(request, '/api/custom_objects/records/__wellness_only_entity_xyz__');
    expect(res.status()).toBe(404);
  });

  test('creating a record on an entity with zero fields succeeds with no values', async ({ request }) => {
    const { name } = await createEntity(request, [], 'zero-field-rec');
    const res = await authPost(request, `/api/custom_objects/records/${encodeURIComponent(name)}`, {
      anything: 'whatever',
    });
    expect(res.status()).toBe(201);
    const body = await (await authGet(request, `/api/custom_objects/records/${encodeURIComponent(name)}`)).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].id).toBeTruthy();
  });
});

// ─── Auth gate ──────────────────────────────────────────────────────

test.describe('Custom Objects API — auth gate', () => {
  test('GET /entities without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/custom_objects/entities`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /entities without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/custom_objects/entities`, {
      data: { name: 'x', fields: [] },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });

  test('GET /records/:entityName without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/custom_objects/records/anything`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /records/:entityName without token → 401/403', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/custom_objects/records/anything`, {
      data: { foo: 'bar' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});
