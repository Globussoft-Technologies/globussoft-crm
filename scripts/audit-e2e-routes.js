// Audits whether e2e specs reference correct route URLs.
//
// Output:
//   1. List of test URLs that DON'T match any actual backend route (broken)
//   2. List of route files that have ZERO test references (gaps)
//   3. Summary stats
//
// Run: node scripts/audit-e2e-routes.js
//
// Heuristic: a "test URL" is anything matching /api/<path> in spec source.
// We collapse :id segments and route params to a normalized form and check
// the prefix against the URL prefixes mounted in server.js.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'backend/server.js');
const ROUTES_DIR = path.join(REPO, 'backend/routes');
const SPECS_DIR = path.join(REPO, 'e2e/tests');

// 1. Parse server.js to map URL prefix → route file basename.
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const requireRe = /const\s+(\w+)\s*=\s*require\(["']\.\/routes\/([^"']+)["']\)/g;
const useRe = /app\.use\(["']([^"']+)["'],\s*(\w+)\)/g;
const varToFile = {};
for (const m of serverSrc.matchAll(requireRe)) varToFile[m[1]] = m[2];
const prefixToFile = {};
for (const m of serverSrc.matchAll(useRe)) {
  if (m[1].startsWith('/api/') && varToFile[m[2]]) {
    prefixToFile[m[1]] = varToFile[m[2]];
  }
}
// Sort by length desc so longer prefixes match first (e.g. /api/auth/2fa before /api/auth).
const sortedPrefixes = Object.keys(prefixToFile).sort((a, b) => b.length - a.length);

// 2. For each route file, parse all router.<verb>(path) declarations to get
//    the full set of supported subpaths.
const routeFileVerbs = {};
for (const f of fs.readdirSync(ROUTES_DIR)) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
  const verbRe = /router\.(get|post|put|patch|delete)\(["']([^"']+)["']/g;
  const verbs = [];
  for (const m of src.matchAll(verbRe)) verbs.push({ method: m[1].toUpperCase(), subpath: m[2] });
  routeFileVerbs[f] = verbs;
}

// 3. Walk every spec, collect URL strings.
const specUrls = []; // [{ file, line, url, normalized }]
// Treat any single trailing or in-path segment that follows a known prefix
// as a route parameter — covers numeric ids, UUIDs, and human-readable slugs
// like "enhanced-wellness" or "abc".
function normalize(u) {
  return u
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\?[^"'`]*$/, '')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[a-f0-9-]{36}(?=\/|$)/gi, '/:id');
}

// Routes mounted directly on the app (not via a routes/* file) — server.js
// has app.get('/api/health', ...) inline, plus a few others.
const TOP_LEVEL_ROUTES = new Set(['/api/health']);
for (const f of fs.readdirSync(SPECS_DIR)) {
  if (!f.endsWith('.spec.js')) continue;
  const src = fs.readFileSync(path.join(SPECS_DIR, f), 'utf8');
  const lines = src.split('\n');
  // Match /api/... inside string/template literals.
  const apiRe = /["'`](\/api\/[^"'`\s]+)["'`]|["'`]\$\{API\}(\/[^"'`\s]+)["'`]/g;
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(apiRe)) {
      const raw = m[1] || `/api${m[2]}`;
      specUrls.push({ file: f, line: i + 1, url: raw, normalized: normalize(raw) });
    }
  }
}

// 4. Match each spec URL against the routes.
function matchUrl(normalized) {
  if (TOP_LEVEL_ROUTES.has(normalized)) {
    return { prefix: normalized, file: '(server.js inline)', matched: true };
  }
  for (const prefix of sortedPrefixes) {
    if (normalized === prefix || normalized.startsWith(prefix + '/') || normalized === prefix + '/') {
      const tail = normalized.slice(prefix.length).replace(/^\//, '');
      const fileBase = prefixToFile[prefix];
      const file = `${fileBase}.js`;
      const verbs = routeFileVerbs[file] || [];
      // Collapse the route-defined subpaths the same way (replace /:foo with /:id, /:bar etc.)
      const candidates = verbs.map((v) => {
        const sub = v.subpath.replace(/:\w+/g, ':id').replace(/^\//, '');
        return { method: v.method, sub };
      });
      const targetSub = tail.replace(/:\w+/g, ':id');
      // Try the literal target first; then try replacing each segment that
      // looks like a parameter value (anything that isn't a route keyword) with
      // :id and seeing if a candidate matches. This handles slugs like
      // "enhanced-wellness" that weren't caught by the numeric/uuid normalizer.
      const variants = new Set([targetSub]);
      const segs = targetSub.split('/');
      for (let i = 0; i < segs.length; i++) {
        const v = segs.slice();
        v[i] = ':id';
        variants.add(v.join('/'));
      }
      // Also try collapsing consecutive segments → :id (covers /tenant/<slug>)
      for (let i = 0; i < segs.length - 1; i++) {
        const v = segs.slice();
        v[i + 1] = ':id';
        variants.add(v.join('/'));
      }
      const hit = candidates.find((c) => variants.has(c.sub));
      return { prefix, file, matched: !!hit, tailSub: targetSub, candidates };
    }
  }
  return { prefix: null, file: null, matched: false };
}

const broken = [];
const matchedByFile = {};
for (const u of specUrls) {
  const r = matchUrl(u.normalized);
  if (!r.matched) {
    broken.push({ ...u, ...r });
  } else {
    matchedByFile[r.file] = (matchedByFile[r.file] || 0) + 1;
  }
}

// 5. Identify route files with zero spec references.
const allRouteFiles = Object.values(prefixToFile).map((b) => `${b}.js`);
const untested = allRouteFiles.filter((f) => !matchedByFile[f]);

// 6. Report.
console.log('=== E2E route audit ===');
console.log(`Total spec URLs found:         ${specUrls.length}`);
console.log(`URLs matching a real route:    ${specUrls.length - broken.length}`);
console.log(`URLs that DON'T match a route: ${broken.length}`);
console.log(`Route files mounted in server: ${allRouteFiles.length}`);
console.log(`Route files with ANY test:     ${Object.keys(matchedByFile).length}`);
console.log(`Route files with NO tests:     ${untested.length}`);
console.log();

if (broken.length > 0) {
  console.log('=== BROKEN test URLs (no matching route handler) ===');
  // Group by URL for compactness.
  const groups = {};
  for (const b of broken) {
    const key = `${b.normalized} (prefix=${b.prefix || 'NO PREFIX'}, file=${b.file || '-'})`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(`${b.file}:${b.line}`);
  }
  for (const [key, locs] of Object.entries(groups)) {
    console.log(`  ${key}`);
    for (const loc of locs.slice(0, 3)) console.log(`     ${loc}`);
    if (locs.length > 3) console.log(`     ... and ${locs.length - 3} more`);
  }
  console.log();
}

console.log('=== UNTESTED route files (zero spec hits) ===');
for (const f of untested.sort()) {
  const verbs = routeFileVerbs[f] || [];
  console.log(`  ${f.padEnd(30)} (${verbs.length} handlers)`);
}

console.log();
console.log('=== Per-file test density (top 10 covered) ===');
Object.entries(matchedByFile)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .forEach(([f, n]) => console.log(`  ${f.padEnd(30)} ${n} test URL refs (${(routeFileVerbs[f] || []).length} handlers)`));
