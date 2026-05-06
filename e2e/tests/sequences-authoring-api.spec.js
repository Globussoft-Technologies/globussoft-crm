// @ts-check
/**
 * Sequences AUTHORING API gate — closes #374, #375, #376, #394, #395, #396, #397, #398.
 *
 * Target: routes/sequences.js (POST/PATCH/GET /api/sequences for the SEQUENCE
 * HEADER + canvas, plus POST/PUT /:id/steps for step.delayMinutes coverage).
 *
 * Why this is separate from sequences-input-sanitization-api.spec.js + sequences-step-list.spec.js:
 *   - sequences-input-sanitization-api.spec.js (#398) → pins the sanitization
 *     of HTML inside Sequence.name / node labels / smsBody / conditionJson.
 *   - sequences-step-list.spec.js (#9) → pins the new explicit step-list
 *     CRUD + engine path that replaces the legacy ReactFlow synth.
 *   - THIS spec (#374, #375, #376, #394, #395, #396, #397, #398) → pins the
 *     SEQUENCE-AUTHORING contract: header create/update validation, status
 *     defaults (DRAFT vs ACTIVE), canvas {nodes, edges} round-trip via
 *     server-side persistence (drip state cannot live browser-only),
 *     step.delayMinutes numeric guard, structured error envelope shape.
 *
 * The gap (regression-coverage-backlog.md #15): all 8 closed issues had
 * partial / oblique coverage — the validation existed in routes/sequences.js
 * but no spec asserted the full authoring contract end-to-end. A regression
 * to any of (a) "name required" guard, (b) "default to DRAFT not ACTIVE", or
 * (c) "structured error shape" would have shipped silently.
 *
 * ─── Drift findings (gap-card vs route reality, captured pre-implementation) ───
 *
 *   | Card claim                         | Route reality                                   |
 *   | ---                                | ---                                             |
 *   | Status defaults to "DRAFT"         | DRIFT: schema is Sequence.isActive Boolean      |
 *   |                                    |   (default false). No status enum. We pin the   |
 *   |                                    |   SEMANTIC equivalent: isActive === false on    |
 *   |                                    |   create when caller omits the flag.            |
 *   | Round-trip via GET /:id            | DRIFT: routes/sequences.js has no GET /:id      |
 *   |                                    |   handler — only GET / (list). Round-trip is    |
 *   |                                    |   verified via list-and-find-by-id instead.     |
 *   | Update via PUT /:id                | DRIFT: handler is PATCH /:id (NOT PUT). PUT     |
 *   |                                    |   exists only for /steps/:id.                   |
 *   | Error shape `{error, code, hint}`  | DRIFT: route returns `{error, code}` ONLY —     |
 *   |                                    |   no `hint` field exists today. We pin the      |
 *   |                                    |   actual contract (error + code present, both   |
 *   |                                    |   non-empty strings, code is the documented     |
 *   |                                    |   sentinel) and explicitly do NOT require hint. |
 *   |                                    |   Add `hint` later as an additive change.       |
 *   | step.delay numeric only            | DRIFT: field is `delayMinutes` not `delay`,     |
 *   |                                    |   error code is `INVALID_DELAY`. Asserted on    |
 *   |                                    |   the actual field name.                        |
 *   | nodes/edges round-trip preserved   | EXACT MATCH semantically — but the storage is   |
 *   |                                    |   `String? @db.Text` JSON-serialised, so GET    |
 *   |                                    |   returns a JSON string that the spec parses    |
 *   |                                    |   before deep-equal comparison.                 |
 *
 * Per CLAUDE.md "tighter-of-{actual, card}" standing rule, the spec asserts
 * the route's REAL contract today. If the route later adopts the card's
 * shape (status enum, hint field, GET /:id), this spec is the canary that
 * needs the new assertions wired in.
 *
 * ─── Tests pinned (~22 across 6 acceptance points) ───
 *
 *   POST name validation (#395, #396, #398):
 *     1. POST with empty string name → 400 INVALID_SEQUENCE
 *     2. POST with whitespace-only name → 400 INVALID_SEQUENCE
 *     3. POST with name omitted entirely → 400 INVALID_SEQUENCE
 *     4. POST with pure-HTML name (post-strip empty) → 400 INVALID_SEQUENCE
 *     5. POST with name containing emoji → 201, emoji preserved verbatim
 *     6. POST with name containing SQL-like quotes → 201, quotes preserved
 *        (Prisma parameterisation, not string interpolation)
 *
 *   POST status default (#374, #376):
 *     7. POST WITHOUT explicit isActive → 201 + isActive === false (DRAFT)
 *     8. POST with isActive: true → 201 + isActive === true (explicit ACTIVE)
 *     9. POST with isActive: "yes" (truthy non-bool) → 201 + isActive === false
 *        (route requires `=== true`, so coerced/truthy non-bool stays DRAFT)
 *
 *   Canvas round-trip (#394):
 *    10. POST with non-trivial nodes/edges → list.find by id returns nodes
 *        and edges that JSON.parse to the original arrays
 *    11. PATCH with new nodes (same id) → list.find returns the updated
 *        canvas, not the original (drip state truly persists server-side)
 *    12. PATCH with edges only → nodes preserved, edges updated
 *
 *   Validation: nodes shape (#395):
 *    13. POST with nodes: "not-an-array" → 400 INVALID_SEQUENCE
 *    14. POST with nodes: { fake: "object" } → 400 INVALID_SEQUENCE
 *
 *   step.delayMinutes numeric guard (#375):
 *    15. POST /:id/steps with delayMinutes: "tomorrow" → 400 INVALID_DELAY
 *    16. POST /:id/steps with delayMinutes: -5 → 400 INVALID_DELAY
 *        (regex `^\d+$` rejects the leading minus sign)
 *    17. POST /:id/steps with delayMinutes: 30 → 201, value persists as 30
 *    18. PUT /sequences/steps/:id with delayMinutes: "soon" → 400 INVALID_DELAY
 *
 *   Structured error envelope (#395):
 *    19. Empty-name 400 body has both `error` and `code` keys (strings,
 *        non-empty), and `code === 'INVALID_SEQUENCE'`. Body MUST NOT echo
 *        raw "Compilation of Drip Array failed." or any internal err.message.
 *    20. delayMinutes=NaN-like 400 body has `code === 'INVALID_DELAY'`.
 *
 *   PATCH name validation (#396, #398):
 *    21. PATCH /:id with empty name → 400 INVALID_SEQUENCE (not silently
 *        accepted)
 *    22. PATCH /:id with name omitted → 200 (omitted field is no-op,
 *        existing name preserved)
 *
 * Pattern: cloned from sequences-input-sanitization-api.spec.js
 *   (cached-token helpers + RUN_TAG-prefixed cleanup + per-test resilience).
 * RUN_TAG is `E2E_FLOW_SEQ_AUTH_<ts>` — already covered by global-teardown
 * regex /^E2E_FLOW_/ in e2e/test-data-patterns.js.
 *
 * Environment expectations:
 *   - BASE_URL defaults to https://crm.globusdemos.com (override per-env).
 *   - Seed user: admin@globussoft.com / password123 (generic ADMIN — owns
 *     /api/sequences via verifyToken; step routes additionally use
 *     verifyRole(['ADMIN']), so ADMIN is the right credential).
 *   - DELETE /api/sequences/:id exists and cascades enrollments before
 *     deleting the parent — afterAll uses it for hard cleanup.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_FLOW_SEQ_AUTH_${Date.now()}`;

// ── Cached admin token ──────────────────────────────────────────────────
let adminToken = null;
let adminTenantId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, tenantId: j.tenant && j.tenant.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, tenantId: null };
}

async function getAdmin(request) {
  if (!adminToken) {
    const r = await loginAs(request, 'admin@globussoft.com', 'password123');
    adminToken = r.token;
    adminTenantId = r.tenantId;
  }
  return { token: adminToken, tenantId: adminTenantId };
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function apiPost(request, token, path, body) {
  return request.post(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function apiPatch(request, token, path, body) {
  return request.patch(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function apiPut(request, token, path, body) {
  return request.put(`${BASE_URL}${path}`, {
    headers: headers(token),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}
async function apiGet(request, token, path) {
  return request.get(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}
async function apiDelete(request, token, path) {
  return request.delete(`${BASE_URL}${path}`, {
    headers: headers(token),
    timeout: REQUEST_TIMEOUT,
  });
}

// ── Cleanup tracking ────────────────────────────────────────────────────
// DELETE /api/sequences/:id (routes/sequences.js:166) cascades enrollments.
// If a delete fails, the RUN_TAG prefix means global-teardown
// (e2e/test-data-patterns.js, /^E2E_FLOW_/) will sweep the row.
const createdSequenceIds = [];

test.afterAll(async ({ request }) => {
  const { token } = await getAdmin(request);
  if (!token) return;
  for (const id of createdSequenceIds) {
    await apiDelete(request, token, `/api/sequences/${id}`).catch(() => {});
  }
});

// Tiny helper: round-trip lookup. The route has no GET /:id (drift), so
// rounding back through the LIST endpoint is the only option. We filter
// by the created id to get an exact-match read.
async function findSequenceById(request, token, id) {
  const res = await apiGet(request, token, '/api/sequences');
  expect(res.ok(), `list sequences: ${res.status()}`).toBe(true);
  const list = await res.json();
  expect(Array.isArray(list)).toBe(true);
  return list.find((s) => s.id === id) || null;
}

// ─────────────────────────────────────────────────────────────────────────
// 1. POST name validation (#395, #396, #398)
// ─────────────────────────────────────────────────────────────────────────

test.describe('POST /api/sequences — name validation', () => {
  test('empty string name → 400 INVALID_SEQUENCE', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: '',
      nodes: [],
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  test('whitespace-only name → 400 INVALID_SEQUENCE', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: '   \t\n  ',
      nodes: [],
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
  });

  test('name field omitted entirely → 400 INVALID_SEQUENCE', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      nodes: [],
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
  });

  test('name that is purely HTML (img tag) → 400 INVALID_SEQUENCE', async ({ request }) => {
    // The global sanitizeBody strips DANGEROUS_TAG_RE wholesale (img is in
    // the list) → '' → route's sanitizeText sees '' → length 0 → 400.
    // <script>x</script> would NOT work here because sanitizeBody preserves
    // inner text content "x" — so script-with-text remains 201 (non-empty
    // after strip). See sequences-input-sanitization-api spec line 217-237
    // for the canonical explanation.
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: '<img src=x onerror=alert(1)>',
      nodes: [],
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
  });

  test('name with emoji → 201, emoji preserved verbatim', async ({ request }) => {
    const { token } = await getAdmin(request);
    const name = `${RUN_TAG} promo flow 🚀✨`;
    const res = await apiPost(request, token, '/api/sequences', {
      name,
      nodes: [],
      edges: [],
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdSequenceIds.push(body.id);
    // Emoji are 4-byte utf8mb4 chars, MUST round-trip without mojibake.
    expect(body.name).toContain('🚀');
    expect(body.name).toContain('✨');
    expect(body.name).toContain(RUN_TAG);
  });

  test('name with SQL-like quote chars → 201, quotes preserved (parameterised)', async ({ request }) => {
    const { token } = await getAdmin(request);
    // Classic SQLi probe — must round-trip verbatim (Prisma uses parameterised
    // queries, not string interpolation, so this is just text data). The
    // sanitizeText helper preserves apostrophes via the entity-decode pass.
    const name = `${RUN_TAG} O'Brien'); DROP TABLE Sequence;--`;
    const res = await apiPost(request, token, '/api/sequences', {
      name,
      nodes: [],
      edges: [],
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    createdSequenceIds.push(body.id);
    expect(body.name).toContain("O'Brien");
    expect(body.name).toContain('DROP TABLE Sequence');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. POST status default (#374, #376) — DRIFT: route uses isActive Boolean
//    not a status enum. The semantic intent of "defaults to DRAFT" maps to
//    isActive === false. Confirmed against backend/prisma/schema.prisma.
// ─────────────────────────────────────────────────────────────────────────

test.describe('POST /api/sequences — isActive defaults to false (DRAFT)', () => {
  test('omitting isActive → 201, persisted isActive === false', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} default-draft`,
      nodes: [],
      edges: [],
      // NOTE: deliberately no isActive field.
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdSequenceIds.push(body.id);
    expect(body.isActive).toBe(false);

    // Round-trip via list — defence against a write-only default that
    // doesn't actually persist.
    const found = await findSequenceById(request, token, body.id);
    expect(found, 'sequence in list').toBeTruthy();
    expect(found.isActive).toBe(false);
  });

  test('explicit isActive: true → 201, persisted isActive === true', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} explicit-active`,
      nodes: [],
      edges: [],
      isActive: true,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdSequenceIds.push(body.id);
    expect(body.isActive).toBe(true);
  });

  test('truthy non-bool isActive: "yes" → 201, persisted false (route requires === true)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} truthy-nonbool`,
      nodes: [],
      edges: [],
      isActive: 'yes',
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    createdSequenceIds.push(body.id);
    // routes/sequences.js:89 → `isActive: isActive === true ? true : false`
    // means anything other than literal `true` falls through to false.
    // This protects "save & activate" semantics from accidental coercion.
    expect(body.isActive).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Canvas {nodes, edges} round-trip (#394) — drip state lives server-side
// ─────────────────────────────────────────────────────────────────────────

test.describe('Canvas round-trip — drip state persists server-side, not browser-only (#394)', () => {
  test('POST nontrivial canvas → list.find returns same nodes + edges (parsed from JSON-string)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const nodes = [
      { id: 'n1', type: 'email', position: { x: 0, y: 0 }, data: { label: `${RUN_TAG} step 1` } },
      { id: 'n2', type: 'wait', position: { x: 200, y: 0 }, data: { label: 'wait 24h', delay: 1440 } },
      { id: 'n3', type: 'sms', position: { x: 400, y: 0 }, data: { label: `${RUN_TAG} reminder` } },
    ];
    const edges = [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
    ];
    const res = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} canvas-roundtrip`,
      nodes,
      edges,
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const created = await res.json();
    createdSequenceIds.push(created.id);

    // Round-trip via the list endpoint (no GET /:id exists).
    const found = await findSequenceById(request, token, created.id);
    expect(found).toBeTruthy();

    // nodes + edges are stored as JSON strings (Sequence.nodes is
    // String? @db.Text). The route stringifies on write; read returns
    // the raw string.
    expect(typeof found.nodes).toBe('string');
    expect(typeof found.edges).toBe('string');

    const parsedNodes = JSON.parse(found.nodes);
    const parsedEdges = JSON.parse(found.edges);

    expect(Array.isArray(parsedNodes)).toBe(true);
    expect(parsedNodes).toHaveLength(3);
    expect(parsedNodes[0].id).toBe('n1');
    expect(parsedNodes[0].data.label).toContain(RUN_TAG);
    expect(parsedNodes[1].data.delay).toBe(1440); // numeric child preserved
    expect(parsedNodes[2].id).toBe('n3');

    expect(Array.isArray(parsedEdges)).toBe(true);
    expect(parsedEdges).toHaveLength(2);
    expect(parsedEdges[0].source).toBe('n1');
    expect(parsedEdges[0].target).toBe('n2');
    expect(parsedEdges[1].source).toBe('n2');
  });

  test('PATCH replaces canvas — list.find returns NEW state, not original', async ({ request }) => {
    const { token } = await getAdmin(request);
    const initial = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} canvas-patch`,
      nodes: [{ id: 'old', type: 'email', position: { x: 0, y: 0 }, data: { label: 'before' } }],
      edges: [],
    });
    expect(initial.status()).toBe(201);
    const created = await initial.json();
    createdSequenceIds.push(created.id);

    // PATCH with a wholly different canvas.
    const newNodes = [
      { id: 'a', type: 'email', position: { x: 100, y: 0 }, data: { label: 'after step 1' } },
      { id: 'b', type: 'sms', position: { x: 300, y: 0 }, data: { label: 'after step 2' } },
    ];
    const newEdges = [{ id: 'e-new', source: 'a', target: 'b' }];
    const patchRes = await apiPatch(request, token, `/api/sequences/${created.id}`, {
      nodes: newNodes,
      edges: newEdges,
    });
    expect(patchRes.status(), `patch: ${await patchRes.text()}`).toBe(200);

    const found = await findSequenceById(request, token, created.id);
    const parsedNodes = JSON.parse(found.nodes);
    const parsedEdges = JSON.parse(found.edges);
    // Old node id MUST be gone — the canvas was REPLACED, not merged.
    expect(parsedNodes.find((n) => n.id === 'old')).toBeFalsy();
    expect(parsedNodes.find((n) => n.id === 'a')).toBeTruthy();
    expect(parsedNodes.find((n) => n.id === 'b')).toBeTruthy();
    expect(parsedEdges).toHaveLength(1);
    expect(parsedEdges[0].source).toBe('a');
  });

  test('PATCH edges only → nodes preserved, edges updated', async ({ request }) => {
    const { token } = await getAdmin(request);
    const nodes = [
      { id: 'p1', type: 'email', position: { x: 0, y: 0 }, data: { label: 'persist 1' } },
      { id: 'p2', type: 'email', position: { x: 200, y: 0 }, data: { label: 'persist 2' } },
    ];
    const initial = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} edges-only`,
      nodes,
      edges: [{ id: 'e-old', source: 'p1', target: 'p2' }],
    });
    expect(initial.status()).toBe(201);
    const created = await initial.json();
    createdSequenceIds.push(created.id);

    // PATCH only edges — nodes field omitted.
    const patchRes = await apiPatch(request, token, `/api/sequences/${created.id}`, {
      edges: [{ id: 'e-replaced', source: 'p2', target: 'p1' }],
    });
    expect(patchRes.status()).toBe(200);

    const found = await findSequenceById(request, token, created.id);
    const parsedNodes = JSON.parse(found.nodes);
    const parsedEdges = JSON.parse(found.edges);
    // nodes preserved verbatim (PATCH is partial update).
    expect(parsedNodes).toHaveLength(2);
    expect(parsedNodes.find((n) => n.id === 'p1')).toBeTruthy();
    // edges replaced.
    expect(parsedEdges).toHaveLength(1);
    expect(parsedEdges[0].id).toBe('e-replaced');
    expect(parsedEdges[0].source).toBe('p2');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. POST nodes-shape validation (#395) — non-array → 400 INVALID_SEQUENCE
// ─────────────────────────────────────────────────────────────────────────

test.describe('POST /api/sequences — nodes shape validation', () => {
  test('nodes: "not-an-array" string → 400 INVALID_SEQUENCE', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} bad-nodes-string`,
      nodes: 'not-an-array',
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
  });

  test('nodes: {fake: "object"} → 400 INVALID_SEQUENCE', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} bad-nodes-object`,
      nodes: { fake: 'object' },
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. step.delayMinutes numeric guard (#375)
// ─────────────────────────────────────────────────────────────────────────

test.describe('POST /:id/steps — delayMinutes accepts only numeric values (#375)', () => {
  // Helper: make a parent sequence to attach steps to.
  async function makeParent(request, token, suffix) {
    const r = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} parent-${suffix}`,
      nodes: [],
      edges: [],
    });
    expect(r.status(), `parent create: ${await r.text()}`).toBe(201);
    const body = await r.json();
    createdSequenceIds.push(body.id);
    return body.id;
  }

  test('delayMinutes: "tomorrow" → 400 INVALID_DELAY', async ({ request }) => {
    const { token } = await getAdmin(request);
    const seqId = await makeParent(request, token, 'delay-text');
    const res = await apiPost(request, token, `/api/sequences/${seqId}/steps`, {
      kind: 'email',
      delayMinutes: 'tomorrow',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DELAY');
    expect(typeof body.error).toBe('string');
    expect(body.error).toMatch(/non-negative integer/i);
  });

  test('delayMinutes: -5 → 400 INVALID_DELAY (regex rejects leading minus)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const seqId = await makeParent(request, token, 'delay-neg');
    const res = await apiPost(request, token, `/api/sequences/${seqId}/steps`, {
      kind: 'email',
      delayMinutes: '-5',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DELAY');
  });

  test('delayMinutes: 30 → 201, value persists as 30', async ({ request }) => {
    const { token } = await getAdmin(request);
    const seqId = await makeParent(request, token, 'delay-ok');
    const res = await apiPost(request, token, `/api/sequences/${seqId}/steps`, {
      kind: 'email',
      delayMinutes: 30,
    });
    expect(res.status(), `step create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.delayMinutes).toBe(30);
  });

  test('PUT /sequences/steps/:id with delayMinutes: "soon" → 400 INVALID_DELAY', async ({ request }) => {
    const { token } = await getAdmin(request);
    const seqId = await makeParent(request, token, 'delay-put');

    // Seed a clean step to update.
    const seedRes = await apiPost(request, token, `/api/sequences/${seqId}/steps`, {
      kind: 'email',
      delayMinutes: 5,
    });
    expect(seedRes.status()).toBe(201);
    const step = await seedRes.json();

    const res = await apiPut(request, token, `/api/sequences/steps/${step.id}`, {
      delayMinutes: 'soon',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DELAY');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Structured error envelope (#395) — never leak raw err.message
// ─────────────────────────────────────────────────────────────────────────

test.describe('Error envelope shape — {error, code} structured JSON, no raw err.message', () => {
  test('empty-name 400 → body has {error, code}, error never matches raw "Compilation of Drip Array failed."', async ({ request }) => {
    const { token } = await getAdmin(request);
    const res = await apiPost(request, token, '/api/sequences', {
      name: '',
      nodes: [],
      edges: [],
    });
    expect(res.status()).toBe(400);
    const body = await res.json();

    // Pin the actual contract: error + code present, both non-empty strings.
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    expect(typeof body.code).toBe('string');
    expect(body.code).toBe('INVALID_SEQUENCE');

    // The raw legacy error message MUST NEVER reach the wire — it was
    // an internal Prisma/JSON-parse error string per #395.
    expect(body.error).not.toMatch(/Compilation of Drip Array failed/i);
    // Defence-in-depth: no stack trace either.
    expect(body.error).not.toMatch(/\bat\s+\w+\s*\(/);

    // DRIFT NOTE: the gap card called for a `hint` field; the route does
    // NOT emit one today. We deliberately do NOT assert hint exists — if
    // future work adds it, this comment is the canary that says "extend
    // this assertion to cover the new field".
  });

  test('invalid delayMinutes 400 → body.code is INVALID_DELAY (not raw NaN error)', async ({ request }) => {
    const { token } = await getAdmin(request);
    const parentRes = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} envelope-delay`,
      nodes: [],
      edges: [],
    });
    expect(parentRes.status()).toBe(201);
    const parent = await parentRes.json();
    createdSequenceIds.push(parent.id);

    const res = await apiPost(request, token, `/api/sequences/${parent.id}/steps`, {
      kind: 'email',
      delayMinutes: 'not-a-number',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DELAY');
    expect(typeof body.error).toBe('string');
    // Must NOT leak parseInt/NaN-flavoured internal stringification.
    expect(body.error).not.toMatch(/NaN/i);
    expect(body.error).not.toMatch(/Cannot convert/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. PATCH /:id name validation (#396, #398) — DRIFT: PATCH not PUT
// ─────────────────────────────────────────────────────────────────────────

test.describe('PATCH /api/sequences/:id — name validation', () => {
  test('PATCH with empty name → 400 INVALID_SEQUENCE (not silently accepted)', async ({ request }) => {
    const { token } = await getAdmin(request);
    // Seed a clean row.
    const seedRes = await apiPost(request, token, '/api/sequences', {
      name: `${RUN_TAG} patch-empty-pre`,
      nodes: [],
      edges: [],
    });
    expect(seedRes.status()).toBe(201);
    const seed = await seedRes.json();
    createdSequenceIds.push(seed.id);

    const res = await apiPatch(request, token, `/api/sequences/${seed.id}`, {
      name: '   ',
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_SEQUENCE');
  });

  test('PATCH with name omitted → 200, existing name preserved', async ({ request }) => {
    const { token } = await getAdmin(request);
    const original = `${RUN_TAG} preserve-on-patch`;
    const seedRes = await apiPost(request, token, '/api/sequences', {
      name: original,
      nodes: [],
      edges: [],
    });
    expect(seedRes.status()).toBe(201);
    const seed = await seedRes.json();
    createdSequenceIds.push(seed.id);

    // PATCH something other than name (toggle isActive).
    const res = await apiPatch(request, token, `/api/sequences/${seed.id}`, {
      isActive: true,
    });
    expect(res.status()).toBe(200);
    const updated = await res.json();
    expect(updated.name).toBe(original); // name field untouched
    expect(updated.isActive).toBe(true);
  });
});
