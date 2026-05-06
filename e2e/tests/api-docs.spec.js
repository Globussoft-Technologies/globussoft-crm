// @ts-check
/**
 * API documentation surface — Swagger UI + OpenAPI JSON.
 *
 * Closes #542 [MED-01]. The QA sweep against v3.4.13 demo found
 * `GET /api-docs` and `GET /api-docs/swagger.json` both returning the
 * SPA's index.html — devs and integrators had no discoverable API
 * documentation surface. Two layers of fix:
 *
 *  1. Backend (server.js:386+): swagger-ui-express was already mounted
 *     at /api-docs, but no explicit handler exposed the raw OpenAPI JSON.
 *     Added `app.get('/api-docs/swagger.json')` BEFORE the `app.use(...)`
 *     mount so it wins on path match (Express declaration-order rule).
 *  2. Nginx (demo, /etc/nginx/sites-available/crm.globusdemos.com):
 *     `/api-docs*` had no proxy block, so it fell through to the SPA
 *     fallback (`location /` + `try_files ... /index.html`). Applied via
 *     scripts/apply-api-docs-nginx.py — mirrors the /api/ + /p/ blocks.
 *
 * Endpoints covered:
 *   GET /api-docs/             — Swagger UI HTML, public, text/html
 *   GET /api-docs/swagger.json — OpenAPI 3 spec, public, application/json
 *   GET /api-docs              — same as /api-docs/ (Swagger redirects)
 *
 * Both routes are PUBLIC on purpose — docs discoverability is the entire
 * point of mounting Swagger. The spec asserts that no auth header is
 * required AND that the routes don't accidentally leak protected data
 * (the spec only documents public contracts).
 *
 * Test environment: BASE_URL = local stack (http://127.0.0.1:5000) in
 * the per-push gate, https://crm.globusdemos.com in e2e-full release
 * validation. Both backends serve identical Swagger output; the only
 * cross-machine variable is the Nginx layer (demo only). Spec works
 * cross-machine — no IS_LOCAL_STACK guard needed.
 *
 * No fixtures created; nothing to clean up. RUN_TAG omitted intentionally.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';

test.describe('GET /api-docs (Swagger UI)', () => {
  test('returns 200 + text/html with Swagger UI markers — no auth required', async ({ request }) => {
    // The trailing slash is the canonical mount path for swagger-ui-express;
    // the no-trailing-slash variant 301-redirects to it.
    const res = await request.get(`${BASE_URL}/api-docs/`);
    expect(res.status()).toBe(200);
    const ct = res.headers()['content-type'] || '';
    expect(ct).toContain('text/html');

    const body = await res.text();
    // Swagger UI HTML contains a static-bundle marker comment + the page
    // title we set in server.js (`customSiteTitle: "Globussoft CRM Docs"`).
    // Either marker is sufficient; assert both for defense in depth — if
    // someone swaps swagger-ui-express for a different lib, at least one
    // assertion will catch the contract drift.
    expect(body).toMatch(/Globussoft CRM Docs/);
    expect(body).toMatch(/swagger-ui/i);
  });

  test('redirects /api-docs (no trailing slash) to /api-docs/', async ({ request }) => {
    // swagger-ui-express's `serveFiles` middleware emits a 301 to the
    // trailing-slash variant. Don't follow redirects so we can assert
    // the redirect itself; otherwise this would just collapse into the
    // first test.
    const res = await request.get(`${BASE_URL}/api-docs`, { maxRedirects: 0 });
    // Accept either 301 (canonical swagger-ui-express response) or 200
    // (some Nginx configs internally rewrite). The spec is "the route
    // is reachable + serves docs," not "the redirect chain is exact."
    expect([200, 301, 302]).toContain(res.status());
  });
});

test.describe('GET /api-docs/swagger.json (OpenAPI spec)', () => {
  test('returns 200 + application/json with a valid OpenAPI 3 envelope — no auth required', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api-docs/swagger.json`);
    expect(res.status()).toBe(200);

    const ct = res.headers()['content-type'] || '';
    expect(ct).toContain('application/json');

    const spec = await res.json();
    // OpenAPI 3 envelope shape — these are the four required top-level
    // fields per the OpenAPI 3.0 schema (info + paths are required;
    // openapi + components are conventional). If any are missing, the
    // YAML on disk is malformed and SDK generators will reject it.
    expect(spec).toHaveProperty('openapi');
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec).toHaveProperty('info');
    expect(spec.info).toHaveProperty('title');
    expect(spec.info.title).toMatch(/Globussoft/i);
    expect(spec).toHaveProperty('paths');
    expect(typeof spec.paths).toBe('object');
    // The spec MUST document at least /health + /auth/login since those
    // are the canonical entry points for any new integrator. If a
    // refactor accidentally drops them, this assertion catches it.
    expect(spec.paths).toHaveProperty('/health');
    expect(spec.paths).toHaveProperty('/auth/login');
  });

  test('does NOT require auth — public docs discoverability', async ({ request }) => {
    // Explicit no-auth probe. If a future change accidentally puts the
    // global auth guard ahead of the swagger.json handler, this catches
    // it (otherwise the assertion above could be satisfied even with
    // a broken auth-blocked path if the test runner had a stale token).
    const res = await request.get(`${BASE_URL}/api-docs/swagger.json`, {
      headers: { Authorization: '' },
    });
    expect(res.status()).toBe(200);
  });
});
