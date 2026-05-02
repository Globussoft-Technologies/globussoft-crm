// CI-6 in TODOS.md — bundle-size budget gate.
//
// Reads frontend/.bundle-size-budget.json, walks frontend/dist/assets/,
// matches each chunk against the per-glob budget, and exits non-zero on
// overage. Also asserts total JS + total CSS budgets to catch the case
// where a new chunk appears that wasn't explicitly budgeted.
//
// Wire into deploy.yml's build job AFTER `vite build`. No new npm deps —
// this is a pure-Node script using fs + path globbing.
//
// Run locally: `npm run check:bundle-size` (defined in frontend/package.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(__dirname, '..');
const DIST_ASSETS = path.join(FRONTEND_ROOT, 'dist', 'assets');
const BUDGET_FILE = path.join(FRONTEND_ROOT, '.bundle-size-budget.json');

if (!fs.existsSync(DIST_ASSETS)) {
  console.error(`[bundle-size] dist/assets not found — run 'npm run build' first.`);
  process.exit(2);
}

if (!fs.existsSync(BUDGET_FILE)) {
  console.error(`[bundle-size] budget file missing: ${BUDGET_FILE}`);
  process.exit(2);
}

const budget = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
const files = fs.readdirSync(DIST_ASSETS).map((name) => {
  const full = path.join(DIST_ASSETS, name);
  return { name, sizeKB: fs.statSync(full).size / 1024 };
});

// Convert glob pattern (limited subset: * matches anything-not-/) to RegExp.
function patternToRegex(p) {
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

const violations = [];
const matched = new Set();

// Per-pattern budgets
console.log('=== Per-chunk budget check ===');
for (const entry of budget.chunks || []) {
  const re = patternToRegex(entry.pattern);
  const hits = files.filter((f) => re.test(f.name));
  if (hits.length === 0) {
    console.log(`  ⚠️  no chunk matched pattern: ${entry.pattern}`);
    continue;
  }
  for (const hit of hits) {
    matched.add(hit.name);
    const overBy = hit.sizeKB - entry.maxKB;
    if (overBy > 0) {
      violations.push({
        kind: 'chunk',
        file: hit.name,
        sizeKB: hit.sizeKB.toFixed(1),
        budgetKB: entry.maxKB,
        overByKB: overBy.toFixed(1),
        comment: entry.comment,
      });
      console.log(`  ❌ ${hit.name}: ${hit.sizeKB.toFixed(1)} KB > ${entry.maxKB} KB (over by ${overBy.toFixed(1)} KB)`);
    } else {
      console.log(`  ✅ ${hit.name}: ${hit.sizeKB.toFixed(1)} KB / ${entry.maxKB} KB (${((hit.sizeKB / entry.maxKB) * 100).toFixed(0)}%)`);
    }
  }
}

// Totals
const totalJsKB = files.filter((f) => f.name.endsWith('.js')).reduce((s, f) => s + f.sizeKB, 0);
const totalCssKB = files.filter((f) => f.name.endsWith('.css')).reduce((s, f) => s + f.sizeKB, 0);

console.log('');
console.log('=== Total budget check ===');
const totals = budget.totals || {};
if (totals['all-js-maxKB']) {
  if (totalJsKB > totals['all-js-maxKB']) {
    violations.push({
      kind: 'total-js',
      sizeKB: totalJsKB.toFixed(1),
      budgetKB: totals['all-js-maxKB'],
      overByKB: (totalJsKB - totals['all-js-maxKB']).toFixed(1),
    });
    console.log(`  ❌ all .js: ${totalJsKB.toFixed(1)} KB > ${totals['all-js-maxKB']} KB`);
  } else {
    console.log(`  ✅ all .js: ${totalJsKB.toFixed(1)} KB / ${totals['all-js-maxKB']} KB (${((totalJsKB / totals['all-js-maxKB']) * 100).toFixed(0)}%)`);
  }
}
if (totals['all-css-maxKB']) {
  if (totalCssKB > totals['all-css-maxKB']) {
    violations.push({
      kind: 'total-css',
      sizeKB: totalCssKB.toFixed(1),
      budgetKB: totals['all-css-maxKB'],
      overByKB: (totalCssKB - totals['all-css-maxKB']).toFixed(1),
    });
    console.log(`  ❌ all .css: ${totalCssKB.toFixed(1)} KB > ${totals['all-css-maxKB']} KB`);
  } else {
    console.log(`  ✅ all .css: ${totalCssKB.toFixed(1)} KB / ${totals['all-css-maxKB']} KB (${((totalCssKB / totals['all-css-maxKB']) * 100).toFixed(0)}%)`);
  }
}

console.log('');
const unmatched = files.filter((f) => /\.(js|css)$/.test(f.name) && !matched.has(f.name));
if (unmatched.length > 0) {
  console.log('=== Unbudgeted chunks (advisory; only fail via total budgets) ===');
  unmatched
    .sort((a, b) => b.sizeKB - a.sizeKB)
    .slice(0, 10)
    .forEach((f) => console.log(`  • ${f.name}: ${f.sizeKB.toFixed(1)} KB`));
  console.log('');
}

if (violations.length > 0) {
  console.log(`❌ ${violations.length} budget violation(s)`);
  console.log('To fix: investigate the offending chunk (often a large new dep, an accidental whole-barrel import, or a missing lazy-load). If the growth is justified, edit frontend/.bundle-size-budget.json and bump the budget with a comment explaining why.');
  process.exit(1);
}

console.log(`✅ All ${(budget.chunks || []).length} chunk budgets + totals OK.`);
process.exit(0);
