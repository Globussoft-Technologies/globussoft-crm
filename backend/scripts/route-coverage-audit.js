#!/usr/bin/env node
// Audits route ↔ test coverage:
//   1. Lists every backend/routes/*.js file
//   2. For each, greps e2e/tests/*.spec.js for any reference to the route's
//      mount point (e.g. routes/contacts.js → /api/contacts)
//   3. Flags PRD-skipped routes (Callified territory)
//   4. Flags routes covered by gated specs (in deploy.yml api_tests list)
//   5. Outputs a markdown table for TODOS.md or stdout
//
// Run from repo root: node backend/scripts/route-coverage-audit.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ROUTES_DIR = path.join(ROOT, 'backend', 'routes');
const E2E_TESTS_DIR = path.join(ROOT, 'e2e', 'tests');
const DEPLOY_YML = path.join(ROOT, '.github', 'workflows', 'deploy.yml');
const SERVER_JS = path.join(ROOT, 'backend', 'server.js');

const PRD_SKIPPED = new Set([
  'voice.js',
  'voice_transcription.js',
  'whatsapp.js',
]);

// Read actual mount paths from server.js — single source of truth.
//   app.use("/api/ai_scoring", aiScoringRoutes);
//   app.use("/api/contacts", contactsRoutes);
// Build a map: routeFile.js → mountPath
function readMountsFromServerJs() {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  // Pattern: app.use("/api/<path>", <routeVarName>);
  // Plus the require lines: const fooRoutes = require("./routes/foo");
  const requireRe = /const\s+(\w+)\s*=\s*require\(["']\.\/routes\/([\w/-]+)["']\)/g;
  const useRe = /app\.use\(["']\/api\/?([^"']*)["']\s*,\s*(\w+)\s*\)/g;

  const varToFile = {};
  let m;
  while ((m = requireRe.exec(src))) {
    varToFile[m[1]] = m[2] + '.js';
  }
  const fileToMount = {};
  while ((m = useRe.exec(src))) {
    const mountPath = '/' + m[1]; // strip leading "/api/" was the literal; we kept the rest
    const file = varToFile[m[2]];
    if (file) fileToMount[file] = '/api/' + m[1];
  }
  return fileToMount;
}

// Get the gated spec list from deploy.yml
function readGatedSpecs() {
  const yml = fs.readFileSync(DEPLOY_YML, 'utf8');
  const matches = yml.match(/tests\/[a-z_-]+-api\.spec\.js/g) || [];
  return new Set(matches.map((m) => m.replace('tests/', '')));
}

// Collect spec files
const specFiles = fs
  .readdirSync(E2E_TESTS_DIR)
  .filter((f) => f.endsWith('.spec.js'))
  .map((f) => ({
    name: f,
    content: fs.readFileSync(path.join(E2E_TESTS_DIR, f), 'utf8'),
  }));

const gatedSpecs = readGatedSpecs();

// Collect route files
const routeFiles = fs
  .readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

const fileToMount = readMountsFromServerJs();

// For each route, find which specs reference it
const audit = routeFiles.map((rf) => {
  const apiPath = fileToMount[rf];
  if (!apiPath) {
    return {
      file: rf,
      mount: '(not mounted in server.js — orphan route file)',
      prdSkipped: PRD_SKIPPED.has(rf),
      gatedSpecs: [],
      ungatedSpecs: [],
      totalSpecs: 0,
      orphan: true,
    };
  }

  const refs = specFiles
    .filter((sf) => sf.content.includes(apiPath))
    .map((sf) => sf.name);

  const gatedRefs = refs.filter((s) => gatedSpecs.has(s));
  const ungatedRefs = refs.filter((s) => !gatedSpecs.has(s));

  return {
    file: rf,
    mount: apiPath,
    prdSkipped: PRD_SKIPPED.has(rf),
    gatedSpecs: gatedRefs,
    ungatedSpecs: ungatedRefs,
    totalSpecs: refs.length,
  };
});

// Stats
const total = audit.length;
const prdSkipped = audit.filter((a) => a.prdSkipped).length;
const inGate = audit.filter((a) => a.gatedSpecs.length > 0).length;
const onlyUngated = audit.filter((a) => a.gatedSpecs.length === 0 && a.ungatedSpecs.length > 0 && !a.prdSkipped).length;
const noSpecs = audit.filter((a) => a.totalSpecs === 0 && !a.prdSkipped).length;

console.log('# Route ↔ test coverage audit');
console.log('');
console.log(`Generated: ${new Date().toISOString().slice(0, 10)}`);
console.log('');
console.log(`Total backend route files: **${total}**`);
console.log(`  - PRD-skipped (Callified territory): **${prdSkipped}**`);
console.log(`  - Covered by gated CI specs: **${inGate}**`);
console.log(`  - Covered by non-gated specs only: **${onlyUngated}**`);
console.log(`  - No specs at all: **${noSpecs}**`);
console.log('');

console.log('## ❌ Routes with NO specs at all (immediate gap)');
console.log('');
console.log('| Route | Mount |');
console.log('|---|---|');
audit
  .filter((a) => a.totalSpecs === 0 && !a.prdSkipped)
  .forEach((a) => console.log(`| \`${a.file}\` | \`${a.mount}\` |`));

console.log('');
console.log('## ⚠️ Covered by non-gated specs only (UI flows; not on per-push CI)');
console.log('');
console.log('| Route | Mount | Spec(s) |');
console.log('|---|---|---|');
audit
  .filter((a) => a.gatedSpecs.length === 0 && a.ungatedSpecs.length > 0 && !a.prdSkipped)
  .forEach((a) => console.log(`| \`${a.file}\` | \`${a.mount}\` | ${a.ungatedSpecs.join(', ')} |`));

console.log('');
console.log('## ✅ Covered by gated CI specs (per-push)');
console.log('');
console.log('| Route | Mount | Gated spec(s) |');
console.log('|---|---|---|');
audit
  .filter((a) => a.gatedSpecs.length > 0)
  .forEach((a) => console.log(`| \`${a.file}\` | \`${a.mount}\` | ${a.gatedSpecs.join(', ')} |`));

console.log('');
console.log('## 🛑 PRD-skipped (intentional)');
console.log('');
console.log('| Route | Mount | Reason |');
console.log('|---|---|---|');
audit
  .filter((a) => a.prdSkipped)
  .forEach((a) => console.log(`| \`${a.file}\` | \`${a.mount}\` | Callified.ai (PRD §6.5) |`));

// Exit code: 0 if no orphan routes; 1 if any. Can be wired into CI later.
process.exit(noSpecs > 0 ? 1 : 0);
