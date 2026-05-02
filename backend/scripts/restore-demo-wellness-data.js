#!/usr/bin/env node
// One-shot script to repair demo data corruption surfaced by the
// wellness UI test triage on 2026-05-02:
//
//   1. Location.id=1 had its `name` renamed from 'Ranchi' to 'smoke-test'.
//      The wellness public-booking endpoint (routes/wellness.js:2730)
//      filters out locations whose name matches:
//         /^(smoke-test|e2e[-_ ]|test[-_ ]|qa[-_ ]|dev[-_ ])/i
//      so the renamed Ranchi clinic gets stripped from /book/enhanced-wellness.
//      Result: the customer-facing booking widget has an empty location
//      picker. Restore name = 'Ranchi'.
//
//   2. Tenant.id=2 (Enhanced Wellness) had its `name` truncated to
//      'Enhance'. Cosmetic but visible on the public booking page heading.
//      Restore to 'Enhanced Wellness' per backend/prisma/seed-wellness.js.
//
//   3. (optional, gated by --include-orphans) — 11 stranded
//      `E2E_WC_*_CLEANED_LOC_*` rows from this session's
//      wellness-clinical-api.spec.js runs against demo. They're already
//      filtered by INTERNAL_LOCATION_NAME_RE so they don't break
//      anything user-facing, but they clutter the admin /wellness/locations
//      page. Set isActive=false on them.
//
// Run as wellness ADMIN (admin@wellness.demo) against the demo box:
//   node backend/scripts/restore-demo-wellness-data.js               # dry-run by default
//   node backend/scripts/restore-demo-wellness-data.js --apply       # actually run the PUTs
//   node backend/scripts/restore-demo-wellness-data.js --apply --include-orphans
//
// Idempotent: re-running is safe (PUTs with same payload are no-ops).

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const ADMIN_EMAIL = 'admin@wellness.demo';
const ADMIN_PASSWORD = 'password123';
const APPLY = process.argv.includes('--apply');
const INCLUDE_ORPHANS = process.argv.includes('--include-orphans');

const ORPHAN_LOCATION_IDS = [44, 45, 46, 47, 49, 50, 51, 52, 58, 59, 60, 61];

async function login() {
  const r = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`Login failed: ${r.status}`);
  const j = await r.json();
  return j.token;
}

async function put(token, path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  console.log(`[demo-restore] target: ${BASE_URL}`);
  console.log(`[demo-restore] mode: ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to commit)'}`);
  console.log('');

  const token = await login();
  console.log(`[demo-restore] authed as ${ADMIN_EMAIL}`);
  console.log('');

  // Fix 1: Location.id=1 → name=Ranchi
  console.log('Fix 1: Location.id=1  smoke-test → Ranchi');
  if (APPLY) {
    const out = await put(token, '/api/wellness/locations/1', { name: 'Ranchi' });
    console.log(`  HTTP ${out.status}: name=${out.body?.name ?? '?'}`);
  } else {
    console.log(`  PUT /api/wellness/locations/1 {name: "Ranchi"}`);
  }
  console.log('');

  // Fix 2: Tenant.id=2 → name=Enhanced Wellness
  console.log('Fix 2: Tenant.id=2  Enhance → Enhanced Wellness');
  if (APPLY) {
    const out = await put(token, '/api/tenants/current', { name: 'Enhanced Wellness' });
    console.log(`  HTTP ${out.status}: name=${out.body?.name ?? '?'}`);
  } else {
    console.log(`  PUT /api/tenants/current {name: "Enhanced Wellness"}`);
  }
  console.log('');

  // Fix 3: deactivate stranded E2E_WC_CLEANED_LOC rows
  if (INCLUDE_ORPHANS) {
    console.log(`Fix 3: deactivate ${ORPHAN_LOCATION_IDS.length} stranded E2E_WC_*_CLEANED_LOC_* rows`);
    for (const id of ORPHAN_LOCATION_IDS) {
      if (APPLY) {
        const out = await put(token, `/api/wellness/locations/${id}`, { isActive: false });
        console.log(`  id=${id} → HTTP ${out.status}: active=${out.body?.isActive ?? '?'}`);
      } else {
        console.log(`  PUT /api/wellness/locations/${id} {isActive: false}`);
      }
    }
    console.log('');
  } else {
    console.log(`Fix 3: skipped (use --include-orphans to deactivate ${ORPHAN_LOCATION_IDS.length} stranded E2E_WC_*_CLEANED_LOC_* rows)`);
    console.log('');
  }

  console.log('[demo-restore] done.');
}

main().catch((e) => {
  console.error('[demo-restore] FATAL:', e.message);
  process.exit(2);
});
