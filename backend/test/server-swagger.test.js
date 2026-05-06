// Regression guard for #542 — the QA sweep against v3.4.13 demo found
// `GET /api-docs` and `GET /api-docs/swagger.json` returning the SPA
// index.html (Nginx had no proxy block for /api-docs; backend lacked
// the explicit raw-spec handler).
//
// Two-layer fix landed:
//   1. server.js — added `app.get('/api-docs/swagger.json')` BEFORE the
//      `app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(...))` mount
//      so Express's declaration-order routing serves raw JSON on the
//      `swagger.json` path before falling through to the UI handler.
//   2. Nginx (demo only, applied via scripts/apply-api-docs-nginx.py) —
//      added `location /api-docs { proxy_pass http://localhost:5099; }`
//      so the path doesn't fall through to the SPA fallback.
//
// This test pins the BACKEND half of the contract via static grep — if a
// future refactor accidentally drops the `/api-docs/swagger.json`
// handler, removes the swagger-ui-express mount, or reorders the
// declarations so the catch-all `app.use('/api-docs', ...)` wins on
// `/api-docs/swagger.json`, this test fails in CI before it ships.
//
// We additionally parse-check swagger.yaml here — a corrupted YAML
// would crash `YAML.load` at boot (which would surface in api_tests
// indirectly via "no backend on :5000") but a structurally-invalid
// spec (missing `openapi:` / `info:` / `paths:` keys) wouldn't crash
// boot — it would just serve a useless spec. The structural assertions
// catch that class of drift at unit-test time, ~1ms.
//
// Static grep is right here for the same reasons as server-version.test.js:
//   - Booting express in vitest to hit /api-docs is overkill when the
//     failure mode is "someone reordered or deleted the mount."
//   - The e2e/tests/api-docs.spec.js gate spec covers the runtime path
//     against a real backend; this is the cheap pre-flight.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';
import YAML from 'yamljs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_JS = path.resolve(__dirname, '..', 'server.js');
const SWAGGER_YAML = path.resolve(__dirname, '..', 'swagger.yaml');

describe('server.js Swagger mount — regression guard for #542', () => {
  test('imports swagger-ui-express', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');
    expect(
      src,
      'server.js must require swagger-ui-express to serve /api-docs',
    ).toMatch(/require\(['"]swagger-ui-express['"]\)/);
  });

  test('mounts Swagger UI at /api-docs', () => {
    const src = stripJsComments(fs.readFileSync(SERVER_JS, 'utf8'));
    // Match the canonical mount pattern. Allow line-continuation in
    // arguments by using `[\s\S]*?` between the path and `swaggerUi.serve`.
    // Strip JS comments first so the doc-block above the mount (which
    // describes the pattern) doesn't accidentally satisfy the regex.
    expect(
      src,
      'server.js must mount Swagger UI at /api-docs (app.use(\'/api-docs\', swaggerUi.serve, ...))',
    ).toMatch(/app\.use\(\s*['"]\/api-docs['"][\s\S]*?swaggerUi\.serve/);
  });

  test('exposes raw OpenAPI JSON at /api-docs/swagger.json', () => {
    const src = stripJsComments(fs.readFileSync(SERVER_JS, 'utf8'));
    // The explicit raw-spec handler. Without it, swagger-ui-express's
    // setup() catch-all serves the UI HTML on every sub-path including
    // /swagger.json, which breaks SDK generators (openapi-generator,
    // swagger-codegen, Postman import).
    expect(
      src,
      'server.js must register an explicit GET handler for /api-docs/swagger.json that returns the spec as JSON',
    ).toMatch(/app\.get\(\s*['"]\/api-docs\/swagger\.json['"]/);
  });

  test('raw-spec handler is declared BEFORE the swagger-ui mount (Express declaration-order)', () => {
    const src = stripJsComments(fs.readFileSync(SERVER_JS, 'utf8'));
    const getMatch = src.match(/app\.get\(\s*['"]\/api-docs\/swagger\.json['"]/);
    const useMatch = src.match(/app\.use\(\s*['"]\/api-docs['"][\s\S]*?swaggerUi\.serve/);
    expect(getMatch, 'GET /api-docs/swagger.json handler missing').not.toBeNull();
    expect(useMatch, 'app.use(/api-docs, swaggerUi.serve) missing').not.toBeNull();
    // Express matches handlers in declaration order. If the catch-all
    // app.use sits BEFORE the GET handler, the GET handler is never
    // reached and /api-docs/swagger.json silently serves UI HTML again.
    expect(
      getMatch.index,
      'app.get(/api-docs/swagger.json) MUST appear before app.use(/api-docs, swaggerUi.serve, ...) — Express matches in declaration order',
    ).toBeLessThan(useMatch.index);
  });
});

/**
 * Strip JS line + block comments so static-grep regexes don't match
 * documentation that DESCRIBES the canonical mount pattern (the
 * `// app.use('/api-docs', ...)` header above the actual mount). Keeps
 * line-and-character offsets within ~the same range as the original
 * (replaces comment chars with spaces of the same length) so the
 * declaration-order assertion stays meaningful.
 */
function stripJsComments(src) {
  // Block comments first (they may span multiple lines).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  // Then line comments (string-literal escapes are fine since this is
  // a static source-grep, not an interpreter — false-positives for
  // `// inside a string` are acceptable; server.js doesn't have any).
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

describe('backend/swagger.yaml — OpenAPI 3 spec validity', () => {
  test('parses as YAML without throwing', () => {
    expect(() => YAML.load(SWAGGER_YAML)).not.toThrow();
  });

  test('declares OpenAPI 3.x with required top-level fields', () => {
    const spec = YAML.load(SWAGGER_YAML);
    expect(spec).toBeTruthy();
    expect(spec.openapi, 'openapi version field required').toBeTruthy();
    expect(String(spec.openapi)).toMatch(/^3\./);
    expect(spec.info, 'info section required').toBeTruthy();
    expect(spec.info.title, 'info.title required').toBeTruthy();
    expect(spec.info.version, 'info.version required').toBeTruthy();
    expect(spec.paths, 'paths section required').toBeTruthy();
    expect(typeof spec.paths).toBe('object');
  });

  test('documents at least the canonical entry-point routes (auth + health)', () => {
    const spec = YAML.load(SWAGGER_YAML);
    // These are the two routes any new integrator hits first. If the
    // YAML loses them, the docs page is useless. The full route table
    // (~91 files) is documented in source comments; this spec is a
    // curated machine-readable surface.
    expect(spec.paths, '/health route must be documented').toHaveProperty('/health');
    expect(spec.paths, '/auth/login route must be documented').toHaveProperty('/auth/login');
  });
});
