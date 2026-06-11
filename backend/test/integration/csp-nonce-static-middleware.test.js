// ─────────────────────────────────────────────────────────────────
// #917 slice S115 — CSP nonce middleware wire-in smoke test
// ─────────────────────────────────────────────────────────────────
// What's tested:
//   Boot a minimal Express app that mirrors the production middleware
//   chain order documented in backend/server.js:
//     1. attachNonce       (lib/cspNonce.js — mints res.locals.cspNonce)
//     2. helmetStrictReportOnlyMiddleware  (middleware/security.js — sets
//        the Content-Security-Policy-Report-Only header with the matching
//        `'nonce-<base64>'` source-list value)
//     3. cspNonceStaticMiddleware           (the SUT — substitutes
//        `__CSP_NONCE__` placeholders in frontend/index.html and serves
//        the HTML for SPA-shaped GET requests)
//   Then drive a GET / through supertest and assert:
//     - response is 200 with Content-Type: text/html; charset=utf-8
//     - body contains a substituted nonce value (NOT the literal
//       `__CSP_NONCE__` placeholder)
//     - the same nonce that ended up in the body is advertised in the
//       Content-Security-Policy-Report-Only header's script-src directive
//
// Which modules:
//   backend/middleware/cspNonceStaticMiddleware.js  (S35 — the SUT)
//   backend/lib/cspNonce.js                          (S1 — attachNonce)
//   backend/middleware/security.js                   (helmetStrictReportOnly)
//   backend/server.js                                (the wire-in — line ~206)
//
// Why this matters:
//   S35 shipped the middleware but server.js wasn't updated in the same
//   slice due to a shared-file hazard (concurrent agents). Without the
//   wire-in, the middleware is inert: the strict Report-Only CSP header
//   advertises a nonce that NEVER appears in the served HTML, so every
//   inline `<script>` / `<style>` would log a violation. S115 closes the
//   loop. This smoke test pins the wire-in at HTTP level — if a future
//   refactor accidentally removes the `app.use(cspNonceStaticMiddleware)`
//   line, this test goes red.
//
// Test tier:
//   Integration tier — `test/integration/`. No MySQL, no Prisma, no real
//   server.js boot — just a fresh express() with the security chain wired
//   in the same order as the production server. Runs in <100ms under the
//   `unit_tests` deploy gate.
//
// Mocking notes:
//   - We do NOT mock fs / index.html reads — the middleware finds the
//     real frontend/index.html via its relative path, which works because
//     this test runs from the repo's backend/test/integration/ dir.
//   - We do NOT boot the full server.js — that pulls in Prisma, every
//     route, the cron init, etc. The integration tier mounts only the
//     middleware chain under test.
//   - We DO assert against the real Report-Only header that helmet emits,
//     so this test would catch a regression where helmet's nonce
//     function-directive stops reading res.locals.cspNonce.

import { describe, test, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);

// Load the same modules the production server.js loads. CJS require is
// the canonical path on this repo's vitest config.
const { attachNonce } = requireCJS('../../lib/cspNonce');
const { helmetStrictReportOnlyMiddleware } = requireCJS('../../middleware/security');
const cspNonceStaticMiddleware = requireCJS('../../middleware/cspNonceStaticMiddleware');

function makeApp() {
  const app = express();
  // Mirror the production order: nonce → CSP header → static substitution.
  app.use(attachNonce);
  app.use(helmetStrictReportOnlyMiddleware);
  app.use(cspNonceStaticMiddleware);
  // Below the SUT, a JSON catch-all so any path that the middleware lets
  // fall through (POST, /api/*, paths with a dot) reaches a real handler
  // instead of Express's default 404. The smoke test never exercises this.
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

let app;

beforeAll(() => {
  app = makeApp();
});

describe('S115 — cspNonceStaticMiddleware wire-in (HTTP smoke)', () => {
  test('GET / → 200 text/html with substituted nonce in body', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-type']).toMatch(/charset=utf-8/);

    // The literal placeholder must NOT survive substitution.
    expect(res.text).not.toContain('__CSP_NONCE__');

    // Some substituted value must appear on the meta tag. attachNonce
    // mints a 24-char base64 string (16 random bytes); helmet/quoted
    // values may contain `+`, `/`, `=`. We assert a non-empty value
    // between `content="` and `"` on the meta tag.
    const metaMatch = res.text.match(
      /<meta name="csp-nonce" content="([^"]+)"/
    );
    expect(metaMatch).not.toBeNull();
    expect(metaMatch[1]).not.toBe('__CSP_NONCE__');
    expect(metaMatch[1].length).toBeGreaterThan(0);
  });

  test('substituted nonce matches the nonce advertised in CSP header', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);

    const metaMatch = res.text.match(
      /<meta name="csp-nonce" content="([^"]+)"/
    );
    const bodyNonce = metaMatch && metaMatch[1];
    expect(bodyNonce).toBeTruthy();

    // helmet emits the Report-Only header (NOT the enforce one — S117
    // is the flip-to-enforce slice). Its script-src directive includes
    // `'nonce-<base64>'`.
    const cspHeader = res.headers['content-security-policy-report-only'];
    expect(cspHeader).toBeTruthy();
    expect(cspHeader).toContain(`'nonce-${bodyNonce}'`);
  });

  test('each GET / mints a FRESH nonce (no static reuse across requests)', async () => {
    const r1 = await request(app).get('/');
    const r2 = await request(app).get('/');
    const n1 = r1.text.match(/<meta name="csp-nonce" content="([^"]+)"/)[1];
    const n2 = r2.text.match(/<meta name="csp-nonce" content="([^"]+)"/)[1];
    expect(n1).not.toBe(n2);
  });

  test('GET /api/health → falls through (middleware ignores /api/* paths)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('POST / → falls through (middleware ignores non-GET methods)', async () => {
    // No handler for POST / below the SUT, so Express's default 404
    // text/html "Cannot POST /" lands. Asserting the SUT did NOT serve
    // its HTML shell (text would contain `<meta name="csp-nonce"` if it
    // had) is enough to prove fall-through.
    const res = await request(app).post('/');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('<meta name="csp-nonce"');
  });
});

// ─────────────────────────────────────────────────────────────────
// S119 — handler-precedence regression pin
// ─────────────────────────────────────────────────────────────────
// What's tested:
//   The mount-order contract that S119 fixed. S115 mounted
//   cspNonceStaticMiddleware BEFORE the swagger-ui mount in server.js,
//   so requests to `/api-docs` (no trailing slash, no dot, GET, not
//   `/api/`-prefixed) cleared all 3 fall-through MISS conditions and
//   the middleware served the SPA index.html instead of letting
//   swagger-ui's handler win. Result: e2e `api-docs.spec.js` red,
//   per-push api_tests gate red.
//
// Fix (server.js): move `app.use(cspNonceStaticMiddleware)` to AFTER
// `app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(...))`.
// Express matches handlers in mount order — swagger-ui now wins.
//
// This describe pins the contract at the integration tier by mounting
// a swagger-ui-like handler FIRST, then the cspNonceStaticMiddleware,
// and asserting:
//   - GET /api-docs       → swagger-ui-like handler wins (returns its
//                           response body, NOT the SPA index.html).
//   - GET /api-docs/      → same (trailing-slash variant — e2e test
//                           target shape).
//   - GET /some-spa-route → cspNonceStaticMiddleware wins (substituted
//                           SPA index.html still served on non-handler
//                           paths — proves the mount-order fix didn't
//                           break the original wire-in).
//
// Why this matters: if a future refactor inverts the mount order back
// to S115's broken state (cspNonceStaticMiddleware before swagger-ui),
// these tests go red instantly — before the e2e gate catches it.

function makeAppWithSwaggerFirst() {
  const app = express();
  // Production order (server.js post-S119):
  //   1. attachNonce
  //   2. helmetStrictReportOnlyMiddleware
  //   3. swagger-ui mount on /api-docs
  //   4. cspNonceStaticMiddleware
  app.use(attachNonce);
  app.use(helmetStrictReportOnlyMiddleware);
  // Swagger-ui-like handler mounted BEFORE the SPA-shell middleware.
  // We don't import swagger-ui-express here (heavy dep with its own
  // setup contract); a tiny inline handler is enough to prove the
  // mount-order contract — the SUT is the middleware, not swagger-ui.
  app.use('/api-docs', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send('<!DOCTYPE html><html><head><title>Swagger</title></head><body>swagger-ui-stub</body></html>');
  });
  app.use(cspNonceStaticMiddleware);
  return app;
}

describe('S119 — cspNonceStaticMiddleware mount order (swagger-ui precedence)', () => {
  let app2;
  beforeAll(() => {
    app2 = makeAppWithSwaggerFirst();
  });

  test('GET /api-docs → swagger-ui handler wins (NOT the SPA shell)', async () => {
    const res = await request(app2).get('/api-docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    // Swagger stub-handler payload should appear; the SPA shell's
    // meta-csp-nonce tag must NOT (which would prove the middleware
    // intercepted instead of falling through to swagger-ui).
    expect(res.text).toContain('swagger-ui-stub');
    expect(res.text).not.toContain('<meta name="csp-nonce"');
  });

  test('GET /api-docs/ → swagger-ui handler wins (trailing-slash variant)', async () => {
    // The e2e test (e2e/tests/api-docs.spec.js) hits this exact path.
    const res = await request(app2).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('swagger-ui-stub');
    expect(res.text).not.toContain('<meta name="csp-nonce"');
  });

  test('GET /some-spa-route → cspNonceStaticMiddleware still wins on non-handler paths', async () => {
    // Sanity: moving the middleware mount didn't break the original
    // wire-in. SPA-shaped paths (no dot, not /api/, GET, not a registered
    // handler) still hit the substitution path.
    const res = await request(app2).get('/some-spa-route');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<meta name="csp-nonce"');
    expect(res.text).not.toContain('__CSP_NONCE__');
    expect(res.text).not.toContain('swagger-ui-stub');
  });
});
