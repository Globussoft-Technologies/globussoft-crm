// @ts-check
/**
 * Low-stock alerting engine — gate spec for cron/lowStockEngine.js (G-8).
 *
 * Engine contract (verified by reading backend/cron/lowStockEngine.js):
 *   1. Filter: Product.threshold > 0 AND Product.currentStock <= Product.threshold
 *      → "low" (threshold === 0 means "tracking disabled" per the schema
 *      comment; threshold > 0 with currentStock at or below the line trips
 *      the alert. Comparison is `<=` not `<` — so AT threshold IS alerted.)
 *   2. For each low product, side effects in this exact order:
 *        a. Notification rows (one per ADMIN+MANAGER user in tenant) with
 *           link `/inventory/low-stock?productId=<id>`, type=warning, title
 *           "Low stock: <name>", message body containing the SKU + counts.
 *        b. EmailMessage row (direction=OUTBOUND, status implicit via the
 *           default schema) to tenant.ownerEmail — only if ownerEmail set.
 *   3. Idempotency window: 24h. Engine queries Notification by
 *      (tenantId, link, createdAt >= now-24h) and skips the product if any
 *      match. Re-running within 24h on the SAME product produces no new rows.
 *   4. Tenant isolation: runLowStockForTenant only iterates products with
 *      tenantId === tenant.id. The /run route looks up tenant by
 *      req.user.tenantId, so a generic-tenant admin cannot drive alerts
 *      against the wellness tenant.
 *
 * Trigger endpoint:
 *   POST /api/wellness/inventory/low-stock/run
 *     middleware: verifyToken → verifyWellnessRole(["admin", "manager"])
 *     - 401 without token (verifyToken)
 *     - 403 with token but RBAC role=USER and wellnessRole != admin/manager
 *       (verifyWellnessRole, code=WELLNESS_ROLE_FORBIDDEN)
 *     - 403 with token but tenant.vertical != 'wellness'
 *       (verifyWellnessRole, code=WELLNESS_TENANT_REQUIRED)
 *     - 200 with admin/manager — returns { products, notifications, emails }.
 *
 * Cleanup notes (drift hazard):
 *   routes/cpq.js exposes POST/GET /api/cpq/products but NO DELETE / PUT.
 *   So our test-created Product rows cannot be cleaned via API. We
 *   add `Product` to e2e/global-teardown.js (see same-PR change), and
 *   every Product name carries the `E2E_FLOW_LOWSTOCK_<ts>` prefix so the
 *   teardown REGEXP catches it.
 *   Notification rows created by the engine ride the Product cascade
 *   (no FK), so we leave them in place — they're tagged in the message
 *   body via the product name and won't pollute the demo dashboard
 *   because they appear under userId scope only and disappear with the
 *   tenant teardown's older time window.
 *
 * Pattern: cached-token / authXyz helpers identical to
 * sequence-engine-api.spec.js. Two tokens: wellness admin (200 path) and
 * a non-admin wellness account (403 path) plus generic-tenant admin
 * (cross-vertical 403).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

const RUN_TAG = `E2E_FLOW_LOWSTOCK_${Date.now()}`;

// Serialise: every test in this spec drives the same /low-stock/run engine
// against the same wellness tenant. With Playwright's default 6 parallel
// workers, two tests racing on different low products would each see the
// other's products in the engine response counters and cross-contaminate
// notification listings. Forcing serial execution keeps each test's seed
// + run + assert phase isolated. Runtime cost: ~5s vs ~3s — small.
test.describe.configure({ mode: 'serial' });

// Wellness tenant credentials. seed-wellness.js seeds:
//   admin@wellness.demo  — RBAC ADMIN, wellnessRole=null
//   user@wellness.demo   — RBAC USER, wellnessRole=professional
//   admin@globussoft.com — generic-tenant ADMIN (vertical != wellness)
const FIXTURES = {
  admin: { email: 'admin@wellness.demo', password: 'password123' },
  pro: { email: 'user@wellness.demo', password: 'password123' },
  generic: { email: 'admin@globussoft.com', password: 'password123' },
};

const tokenCache = {};
async function login(request, who) {
  if (tokenCache[who]) return tokenCache[who];
  const fix = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fix,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const data = await r.json();
        tokenCache[who] = data.token;
        return tokenCache[who];
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${await login(request, who)}`,
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'admin') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── factories ──────────────────────────────────────────────────────────

// Product is created via /api/cpq/products. Engine reads `threshold` and
// `currentStock`; both pass through stripDangerous (only id/createdAt/
// updatedAt/tenantId/userId are stripped). Must include `price` (Float,
// required by Prisma schema). `sku` is unique, so we prefix with RUN_TAG
// to avoid collisions across spec runs.
async function createProduct(request, overrides = {}, who = 'admin') {
  const stamp = Date.now() + Math.floor(Math.random() * 100000);
  const payload = {
    name: `${RUN_TAG} ${overrides.name || 'product'}`,
    sku: `${RUN_TAG}-${stamp}`,
    price: overrides.price != null ? overrides.price : 100,
    threshold: overrides.threshold != null ? overrides.threshold : 0,
    currentStock: overrides.currentStock != null ? overrides.currentStock : 0,
    description: overrides.description || `${RUN_TAG} test product`,
  };
  const res = await authPost(request, '/api/cpq/products', payload, who);
  expect(res.status(), `product create: ${await res.text()}`).toBe(201);
  return res.json();
}

async function runEngine(request, who = 'admin') {
  return authPost(request, '/api/wellness/inventory/low-stock/run', {}, who);
}

// Read all admin notifications (paginated up to 100). The engine creates
// one Notification per ADMIN+MANAGER user per low product, so by querying
// admin@wellness.demo we'll see one row per product the engine alerted on
// during this RUN_TAG.
async function listNotifications(request, who = 'admin') {
  const res = await authGet(request, '/api/notifications?limit=100', who);
  expect(res.status()).toBe(200);
  const body = await res.json();
  return Array.isArray(body) ? body : body.notifications || [];
}

// Find a notification matching a specific link (engine writes a link
// `/inventory/low-stock?productId=<id>`). Matching is END-anchored so
// productId=10 doesn't accidentally match productId=100 / productId=1000
// notifications written by sibling tests running in parallel.
function findNotifForProduct(notifs, productId) {
  const suffix = `productId=${productId}`;
  return notifs.find((n) => n.link && n.link.endsWith(suffix));
}
function filterNotifsForProduct(notifs, productId) {
  const suffix = `productId=${productId}`;
  return notifs.filter((n) => n.link && n.link.endsWith(suffix));
}

// Count OUTBOUND emails currently in the tenant. The engine only writes
// OUTBOUND rows. /api/email returns just `{ total }`.
async function countOutboundEmails(request, who = 'admin') {
  const res = await authGet(request, '/api/email?folder=sent', who);
  expect(res.status()).toBe(200);
  const body = await res.json();
  return typeof body.total === 'number' ? body.total : 0;
}

// ── beforeAll: confirm both tenants are seeded ─────────────────────────
test.beforeAll(async ({ request }) => {
  const a = await login(request, 'admin');
  expect(a, 'admin@wellness.demo must be seeded').toBeTruthy();
});

// ── afterAll: scrub Notification rows the engine wrote ────────────────
//
// The engine creates Notification rows whose `title` is "Low stock: <name>"
// and whose `message` echoes the product name. Both fields end up matching
// the demo-hygiene + teardown-completeness regexes (`/ E2E[_ ]/` embedded
// tag) — and those gate specs run LATER in the same suite, BEFORE
// global-teardown gets a chance. Without this hook, the assertion specs
// trip on residue every run.
//
// We can't bulk-delete by query — there's no `/api/notifications?title=...`
// filter route — so we list, filter by RUN_TAG marker in title/link, and
// DELETE one by one via the existing `DELETE /api/notifications/:id`
// (#179 — admin-only, tenant-scoped, audited). Best-effort: a 404 / 500
// here doesn't fail the suite, since we can't do worse than the residue
// global-teardown wouldn't have caught anyway.
test.afterAll(async ({ request }) => {
  const token = await login(request, 'admin');
  if (!token) return;
  // Pull a wide page so RUN_TAG matches across all tests in this spec land
  // in one fetch. limit=500 covers the worst-case fan-out (one notif per
  // admin per low product per test invocation).
  const res = await request.get(`${BASE_URL}/api/notifications?limit=500`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  }).catch(() => null);
  if (!res || !res.ok()) return;
  const body = await res.json().catch(() => ({}));
  const list = Array.isArray(body) ? body : (body.notifications || []);
  // RUN_TAG is unique per test-process invocation, so this filter is
  // strictly scoped to OUR rows — never deletes a real customer notif.
  const ours = list.filter((n) =>
    (n.title && n.title.includes(RUN_TAG)) ||
    (n.message && n.message.includes(RUN_TAG))
  );
  for (const n of ours) {
    await request.delete(`${BASE_URL}/api/notifications/${n.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    }).catch(() => { /* best-effort */ });
  }
});

// ─── Auth + RBAC gates (run independently — no DB seed required) ──────

test.describe('Low-stock /run — auth + RBAC gates', () => {
  test('no token → 401', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/wellness/inventory/low-stock/run`, {
      headers: { 'Content-Type': 'application/json' },
      data: {},
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test('non-admin wellness user (professional) → 403 WELLNESS_ROLE_FORBIDDEN', async ({ request }) => {
    const res = await runEngine(request, 'pro');
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    // Engine guard surfaces a stable code so frontend can branch on it.
    expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
  });

  test('generic-tenant admin → 403 WELLNESS_TENANT_REQUIRED', async ({ request }) => {
    // admin@globussoft.com is RBAC ADMIN but tenant.vertical='generic'.
    // verifyWellnessRole's tenant gate refuses non-wellness verticals
    // regardless of role. Asserts the cross-vertical lockout.
    const res = await runEngine(request, 'generic');
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });

  test('wellness admin → 200 with {products,notifications,emails} envelope', async ({ request }) => {
    const res = await runEngine(request, 'admin');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('products');
    expect(body).toHaveProperty('notifications');
    expect(body).toHaveProperty('emails');
    expect(typeof body.products).toBe('number');
    expect(typeof body.notifications).toBe('number');
    expect(typeof body.emails).toBe('number');
  });
});

// ─── Threshold semantics (the heart of the engine) ────────────────────

test.describe('Low-stock engine — threshold comparison semantics', () => {
  test('product with currentStock < threshold creates a notification', async ({ request }) => {
    const p = await createProduct(request, {
      name: 'below-threshold',
      threshold: 10,
      currentStock: 3,
    });

    const before = await listNotifications(request);
    const beforeForP = findNotifForProduct(before, p.id);
    expect(beforeForP, 'no pre-existing notification for fresh product').toBeFalsy();

    const res = await runEngine(request);
    expect(res.status()).toBe(200);

    const after = await listNotifications(request);
    const got = findNotifForProduct(after, p.id);
    expect(got, 'engine wrote a Notification with the productId in the link').toBeTruthy();
    // Title contract: "Low stock: <name>"
    expect(got.title).toContain('Low stock');
    expect(got.title).toContain(RUN_TAG);
    // Type contract: warning (matches engine NOTIF_TYPE constant).
    expect(got.type).toBe('warning');
    // Body must contain the actual stock + threshold for ops legibility.
    expect(got.message).toMatch(/3/);
    expect(got.message).toMatch(/10/);
  });

  test('product with currentStock === threshold ALSO alerts (engine uses <=)', async ({ request }) => {
    // Edge contract: comparison is `currentStock <= threshold` per
    // lowStockEngine.js:42. So a product sitting exactly AT threshold IS
    // considered low. If a future refactor flips to strict-less-than this
    // assertion will fail loud — that's the intent.
    const p = await createProduct(request, {
      name: 'at-threshold',
      threshold: 5,
      currentStock: 5,
    });

    const res = await runEngine(request);
    expect(res.status()).toBe(200);

    const notifs = await listNotifications(request);
    const got = findNotifForProduct(notifs, p.id);
    expect(got, 'currentStock===threshold must alert under <= contract').toBeTruthy();
  });

  test('product with currentStock > threshold does NOT alert', async ({ request }) => {
    const p = await createProduct(request, {
      name: 'above-threshold',
      threshold: 5,
      currentStock: 50,
    });

    const res = await runEngine(request);
    expect(res.status()).toBe(200);

    const notifs = await listNotifications(request);
    const got = findNotifForProduct(notifs, p.id);
    expect(got, 'product above threshold must not be alerted').toBeFalsy();
  });

  test('product with threshold=0 (tracking disabled) is ignored even when stock is 0', async ({ request }) => {
    // schema.prisma:599 — "threshold=0 disables alerting per product".
    // Engine's where clause filters `threshold: { gt: 0 }`, so a 0/0
    // product never enters the candidate set.
    const p = await createProduct(request, {
      name: 'untracked-zero-stock',
      threshold: 0,
      currentStock: 0,
    });

    const res = await runEngine(request);
    expect(res.status()).toBe(200);

    const notifs = await listNotifications(request);
    const got = findNotifForProduct(notifs, p.id);
    expect(got, 'threshold=0 disables alerting — must not produce a Notification').toBeFalsy();
  });
});

// ─── Idempotency: 24h dedup window ────────────────────────────────────

test.describe('Low-stock engine — idempotency (24h dedup)', () => {
  test('running twice for the same low product does not duplicate notifications', async ({ request }) => {
    const p = await createProduct(request, {
      name: 'idempotent-product',
      threshold: 10,
      currentStock: 1,
    });

    // First run: creates the notification.
    const r1 = await runEngine(request);
    expect(r1.status()).toBe(200);
    const after1 = await listNotifications(request);
    const matches1 = filterNotifsForProduct(after1, p.id);
    expect(matches1.length, 'first run: exactly one notif for this product').toBe(1);

    // Second run within seconds — should be a no-op for this product.
    const r2 = await runEngine(request);
    expect(r2.status()).toBe(200);
    const after2 = await listNotifications(request);
    const matches2 = filterNotifsForProduct(after2, p.id);
    expect(
      matches2.length,
      'second run within 24h dedup window: still one notif',
    ).toBe(1);
  });

  test('engine response counters reflect dedup (re-run drops product count to 0 for already-alerted SKUs)', async ({ request }) => {
    // Seed a product that will be alerted by the upcoming run.
    const p = await createProduct(request, {
      name: 'response-counter',
      threshold: 5,
      currentStock: 2,
    });

    const r1 = await runEngine(request);
    expect(r1.status()).toBe(200);
    const body1 = await r1.json();
    // body1.products counts NEWLY-alerted products this tick. Must include
    // at least our new one (other RUN_TAG products from this spec run
    // already had alerts in earlier tests, so they don't double-count).
    expect(body1.products).toBeGreaterThanOrEqual(1);

    const r2 = await runEngine(request);
    expect(r2.status()).toBe(200);
    const body2 = await r2.json();
    // Second run: every low product seen in r1 is now within its 24h
    // dedup window, so the engine must NOT re-alert any of them. Seeing
    // a fresh row from another concurrent suite is unlikely on local
    // stacks; in CI we lock to 0.
    expect(body2.products).toBe(0);

    // Sanity: notification still pinned to the product from r1.
    const notifs = await listNotifications(request);
    const got = findNotifForProduct(notifs, p.id);
    expect(got).toBeTruthy();
  });
});

// ─── Email queue side effect ──────────────────────────────────────────

test.describe('Low-stock engine — email side effect', () => {
  test('low product bumps OUTBOUND email count on tenant', async ({ request }) => {
    // Wellness tenant has ownerEmail set (rishu@enhancedwellness.in per
    // seed-wellness.js:230), so the engine MUST queue an email when a
    // low product crosses the threshold. The /api/email?folder=sent
    // endpoint exposes only `{ total }` — sufficient to assert the
    // count moved up after the run.
    const before = await countOutboundEmails(request);

    const p = await createProduct(request, {
      name: 'email-side-effect',
      threshold: 10,
      currentStock: 0,
    });

    const r = await runEngine(request);
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.products).toBeGreaterThanOrEqual(1);
    expect(body.emails).toBeGreaterThanOrEqual(1);

    const after = await countOutboundEmails(request);
    expect(after, 'OUTBOUND email count must rise after a low-stock alert').toBeGreaterThan(before);

    // Sanity: notification still wrote correctly alongside the email.
    const notifs = await listNotifications(request);
    expect(findNotifForProduct(notifs, p.id)).toBeTruthy();
  });
});

// ─── Tenant isolation ─────────────────────────────────────────────────

test.describe('Low-stock engine — tenant isolation', () => {
  test('only products in the requesting tenant are evaluated', async ({ request }) => {
    // Stand up a low product in the wellness tenant.
    const p = await createProduct(request, {
      name: 'isolation-wellness',
      threshold: 10,
      currentStock: 0,
    });

    // Drive the engine. The route looks up the tenant via
    // req.user.tenantId, so only wellness-tenant products are scanned.
    const r = await runEngine(request, 'admin');
    expect(r.status()).toBe(200);

    // Wellness admin must see the notification.
    const wellnessNotifs = await listNotifications(request, 'admin');
    expect(findNotifForProduct(wellnessNotifs, p.id)).toBeTruthy();

    // The generic-tenant admin can never invoke the engine in the first
    // place (verifyWellnessRole tenant gate, asserted above), so there
    // is no cross-tenant trigger surface to test here. We re-confirm
    // that calling /run as the generic admin produces zero side effects
    // observable on the wellness tenant — i.e. the count stays as-is.
    const beforeCount = (await listNotifications(request, 'admin')).length;
    const blocked = await runEngine(request, 'generic');
    expect(blocked.status()).toBe(403);
    const afterCount = (await listNotifications(request, 'admin')).length;
    expect(afterCount).toBe(beforeCount);
  });
});
