// ─────────────────────────────────────────────────────────────────
// Route-mount integrity audit
// ─────────────────────────────────────────────────────────────────
// What's tested:
//   For every top-level `backend/routes/<name>.js` file, verifies it is
//   referenced in `backend/server.js` via `require("./routes/<name>")`
//   (either the eager `const xRoutes = require(...)` form or the inline
//   `app.use("/api/...", require("./routes/<name>"))` form).
//
// Which modules:
//   backend/routes/*.js  (all top-level route files)
//   backend/server.js    (the canonical mount point)
//
// Why this matters:
//   This test exists to detect the bug class surfaced by commit 5c48de2a:
//   `routes/travel_flyer_templates.js` (14 slices) and
//   `routes/travel_commission_profiles.js` (13 slices) shipped with full
//   handlers + unit/api tests but were NEVER mounted in server.js.
//   Production traffic returned 404 API_ROUTE_NOT_FOUND silently because
//   the per-route vitest specs mounted them on bare express() apps for
//   isolation. The deploy gate stayed green; the demo box silently 404ed
//   every request to those routes. 5c48de2a fixed the immediate gap by
//   adding `app.use("/api/travel", require("./routes/travel_flyer_templates"))`
//   + the commission_profiles equivalent. This spec prevents the bug from
//   recurring by failing the unit_tests gate the moment a new route file
//   lands in `backend/routes/` without a corresponding server.js mount.
//
//   Pure-string analysis: reads server.js once, greps each route basename
//   for `./routes/<basename>` substring presence. No express boot, no
//   Prisma, no MySQL — sub-millisecond test, safe to run in the
//   unit_tests gate alongside the rest of the suite.
//
// Skip-list:
//   `ALLOWED_UNMOUNTED` below catalogues route files that are deliberately
//   not mounted in server.js (e.g. deprecated handlers behind a future
//   removal, feature-flagged shells awaiting credentials, helper modules
//   that export route factories rather than mountable routers). Every
//   entry MUST cite either a GH issue, a CHANGELOG.md release tag, or a
//   one-line rationale. Empty as of 2026-05-25 — all 141 route files are
//   currently mounted.
//
// Test tier:
//   Integration tier — `test/integration/` — same folder as
//   stripe-webhook.test.js (G-22). Runs under the same `unit_tests`
//   deploy gate.
//
// Contract:
//   Adding a new file under `backend/routes/<name>.js` MUST be accompanied
//   by an `app.use("/api/<prefix>", require("./routes/<name>"))` (or the
//   eager `const fooRoutes = require("./routes/<name>")` + later
//   `app.use(...)`) edit to server.js IN THE SAME COMMIT. If the file is
//   intentionally not yet mounted (cred-blocked, behind a flag), add its
//   basename (no .js) to ALLOWED_UNMOUNTED with a rationale comment.
//
// ─────────────────────────────────────────────────────────────────

// vitest is configured with `globals: true` in backend/vitest.config.js
// — `describe`, `it`, `expect` are available without import. Importing
// from 'vitest' would require ESM `import` syntax (see G-22's
// stripe-webhook.test.js); pure CJS `require('vitest')` fails. This
// spec uses only fs+path (CJS-clean Node builtins), so leaning on the
// globals is the simplest path.
const fs = require('fs');
const path = require('path');

const REPO_BACKEND = path.resolve(__dirname, '..', '..');
const ROUTES_DIR = path.join(REPO_BACKEND, 'routes');
const SERVER_JS = path.join(REPO_BACKEND, 'server.js');

// Route files that are intentionally NOT mounted in server.js.
// Each entry MUST cite a reason (GH issue, feature flag, deprecation).
// Empty as of 2026-05-25 — all 141 top-level route files are mounted.
const ALLOWED_UNMOUNTED = new Set([
  // Example:
  // 'foo_deprecated', // #1234 — slated for removal in v3.9, kept for back-compat
  'file-uploads', // S3 upload router scaffolded but not yet mounted — would
                  // conflict with the existing static `app.use("/api/uploads",
                  // express.static(...))` mount from PR #753. Real mount path
                  // (e.g. /api/file-uploads) requires a product decision —
                  // currently no consumer code calls these endpoints.
]);

function listRouteBasenames() {
  return fs
    .readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js'))
    .map((d) => d.name.replace(/\.js$/, ''))
    .sort();
}

describe('route-mount integrity', () => {
  const serverSrc = fs.readFileSync(SERVER_JS, 'utf8');
  const routeBasenames = listRouteBasenames();

  it('inventory: backend/routes/ contains at least 100 route files', () => {
    // Sanity check — if this drops below 100, something likely went wrong
    // with the readdir (path resolution, cwd mishap). The repo has 141 as
    // of authoring; floor at 100 leaves room for deprecations.
    expect(routeBasenames.length).toBeGreaterThanOrEqual(100);
  });

  it('every route file is referenced as "./routes/<name>" in server.js', () => {
    const unmounted = [];

    for (const basename of routeBasenames) {
      if (ALLOWED_UNMOUNTED.has(basename)) continue;

      // Match either the double-quoted or single-quoted require form.
      // server.js consistently uses double quotes, but accept both so a
      // future style migration doesn't false-fail this gate.
      const doubleQuoted = `"./routes/${basename}"`;
      const singleQuoted = `'./routes/${basename}'`;

      if (
        !serverSrc.includes(doubleQuoted) &&
        !serverSrc.includes(singleQuoted)
      ) {
        unmounted.push(`backend/routes/${basename}.js`);
      }
    }

    expect(
      unmounted,
      `The following route files exist under backend/routes/ but are NOT mounted in backend/server.js.\n` +
        `Each MUST either:\n` +
        `  (a) be mounted via app.use("/api/<prefix>", require("./routes/<name>")), OR\n` +
        `  (b) be added to ALLOWED_UNMOUNTED in this test with a rationale comment.\n` +
        `Unmounted files:\n  - ${unmounted.join('\n  - ')}`
    ).toEqual([]);
  });

  it('ALLOWED_UNMOUNTED entries correspond to real route files', () => {
    const stale = [];
    for (const skipped of ALLOWED_UNMOUNTED) {
      if (!routeBasenames.includes(skipped)) {
        stale.push(skipped);
      }
    }
    expect(
      stale,
      `ALLOWED_UNMOUNTED contains entries with no matching backend/routes/<name>.js file.\n` +
        `Remove stale entries:\n  - ${stale.join('\n  - ')}`
    ).toEqual([]);
  });
});
