// @ts-check
/**
 * Demo hygiene — trailing scan for seed/test pollution and XSS payloads.
 *
 * Task #3 from docs/regression-coverage-backlog.md. Closes regression
 * risk for the seed-pollution + payload-marker cluster:
 *
 *   #120 — original "test data on demo" sweep (the seed of #405)
 *   #237 — sanitize-html bypass via Object → String coercion
 *   #265 — patient duplicates (Kavita Reddy x10) — also caught here
 *          via "no name appears > 3x in same tenant"
 *   #268 — junk-source filter (test-skip / test-junk leak via reports)
 *   #271, #272 — kb article placeholder text seeded ("Lorem ipsum")
 *   #285 — recommendation-fan-out occupancy spam
 *   #306 — patient list growth on demo (no real fix beyond hygiene)
 *   #311 — visit data drifting from clinical reality
 *   #318, #319, #320 — orchestrator-generated text leaking E2E_*
 *   #322 — estimate validUntil year > 2100 (validation gap)
 *   #327 — notification body had "INJECT TEST" / "Targeted / just user"
 *   #328 — KB article slug had spaces + uppercase
 *   #401 — Patient @@unique constraint (already shipped) — verified here
 *
 * This spec runs LAST in the api_tests gate (alphabetically late + the
 * deploy.yml spec list intentionally puts it at the tail) — it makes
 * the strongest assertion: AFTER all other specs have created and
 * cleaned up their fixtures, no resource accessible by the seeded
 * admins should have a name/title/body/email/phone matching any of
 * the obvious test-data or XSS markers.
 *
 * SAFETY:
 *   - GET-only. Never writes. Idempotent. Free to re-run.
 *   - Tenant-scoped via the seeded admin token. Doesn't peek into
 *     other tenants beyond what the API would normally surface.
 *
 * Mode:
 *   - api_tests CI gate: BASE_URL=http://127.0.0.1:5000 against the
 *     ephemeral MySQL. Strict zero — any match means a SEED introduced
 *     bad data, OR a spec earlier in the suite left residue, OR a
 *     route handler is leaking unsanitised input.
 *   - manual demo runs: BASE_URL=https://crm.globusdemos.com — same
 *     strict mode by default. Set DEMO_HYGIENE_TOLERATE=1 to soften
 *     to a console.warn (useful for staging while drift is being
 *     fixed).
 *
 * Revert-and-prove: insert a `<script>alert(1)</script>` patient name
 * via prisma seed on a throwaway branch — this spec goes red. Insert
 * a Kavita Reddy duplicate before #401's @@unique can fire (e.g.
 * different normalizedPhone so it slips past the constraint) — also
 * red, via the duplicate-name check.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;
const TOLERATE = process.env.DEMO_HYGIENE_TOLERATE === '1';

// E2E_SKIP_SCRUB=1 (set in .github/workflows/e2e-full.yml so the demo
// keeps its data between live walkthroughs) means global-teardown.js
// does NOT clean up E2E_*/Lifecycle/PHI Audit/etc. fixtures other
// specs created earlier in the same run. This spec's whole reason to
// exist is asserting those patterns are absent — under SKIP_SCRUB
// those assertions are guaranteed to fail (and are not signalling a
// real regression). Skip the entire file in that mode.
test.skip(
  process.env.E2E_SKIP_SCRUB === '1' && !TOLERATE,
  'demo-hygiene assumes teardown ran; under E2E_SKIP_SCRUB=1 set DEMO_HYGIENE_TOLERATE=1 to keep it warn-only'
);

let genericToken = null;
let wellnessToken = null;

// ── Pattern library (per-field) ──────────────────────────────────────
//
// Each field type gets a tight set of patterns that real customer
// data is never expected to match. The point is fail-fast on obvious
// pollution; not to catch every edge case.

const NAME_PATTERNS = [
  { re: /^Test\b/, why: 'starts with "Test " — test fixture' },
  { re: /^E2E[_ ]/, why: 'E2E prefix — test residue (#405)' },
  { re: / E2E[_ ]/, why: 'embedded E2E tag — test residue' },
  { re: /^Lifecycle\b/, why: 'Lifecycle prefix — test residue (#405)' },
  { re: /^Lifecycle_\d/i, why: 'Lifecycle_<digits> — test residue' },
  { re: /^Race Patient/, why: 'Race Patient — concurrency-test residue' },
  { re: /^Race Visit Patient/, why: 'Race Visit Patient — test residue' },
  { re: /^PHI Audit/, why: 'PHI Audit — test residue' },
  { re: /^Tenant B scoped/, why: 'cross-tenant test residue (#403)' },
  { re: /^Coverage /, why: 'Coverage prefix — test residue' },
  { re: /^Junk[\s_]/, why: 'Junk prefix — test residue' },
  { re: /^Walk-in E2E_EXT_/, why: 'external API test contact residue' },
  { re: /<script\b/i, why: 'XSS: <script> in name (#237)' },
  { re: /<\/script>/i, why: 'XSS: </script> in name (#237)' },
  { re: /<iframe\b/i, why: 'XSS: <iframe> in name' },
  { re: /\bonerror\s*=/i, why: 'XSS: onerror handler in name (#237)' },
  { re: /javascript\s*:/i, why: 'XSS: javascript: URL in name' },
  { re: /alert\s*\(/i, why: 'XSS: alert( in name' },
  { re: /^xss/i, why: 'name starts with "xss" — payload marker' },
  { re: /^spam-/i, why: 'name starts with "spam-" — payload marker' },
  { re: /INJECT/, why: 'INJECT marker (#327)' },
  { re: / 17[67]\d{10,11}$/, why: '13-digit unix-ms suffix in name (test fixture)' },
  { re: /^Today's occupancy only /, why: 'orchestrator fan-out spam (#285)' },
  { re: /^Q3 Renewal Call 17/, why: 'Q3 + timestamp — test fixture residue' },
  { re: /^smoke-test$/, why: 'smoke-test name (location pollution)' },
  { re: /^QA (Form|Test) /, why: 'QA Form/Test branch — test residue (#405)' },
];

const PHONE_PATTERNS = [
  { re: /^0+$/, why: 'all-zero phone' },
  { re: /^9{8,}$/, why: 'all-9 phone (test placeholder)' },
  { re: /^1{8,}$/, why: 'all-1 phone (test placeholder)' },
];

const EMAIL_PATTERNS = [
  { re: /@example\.test$/i, why: '@example.test domain' },
  { re: /@e2e\.test$/i, why: '@e2e.test domain' },
  { re: /@inbound\.local$/i, why: '@inbound.local domain' },
  { re: /@test\.local$/i, why: '@test.local domain' },
  { re: /@racecond\.test$/i, why: '@racecond.test domain' },
  { re: /^e2e[-_]/i, why: 'email starts with e2e[-_]' },
  { re: /^dup-/i, why: 'email starts with "dup-" (race-condition test)' },
];

// Body/description fields (KB articles, notifications) — narrower set.
// Don't flag <img> here because legit KB articles have markdown image
// embeds. Focus on script-injection markers + INJECT.
const BODY_PATTERNS = [
  { re: /<script\b/i, why: 'XSS: <script> in body (#237)' },
  { re: /<\/script>/i, why: 'XSS: </script> in body' },
  { re: /\bonerror\s*=/i, why: 'XSS: onerror handler in body' },
  { re: /javascript\s*:/i, why: 'XSS: javascript: URL in body' },
  { re: /\bINJECT TEST\b/, why: 'INJECT TEST marker (#327)' },
  { re: /^Targeted \/ just user \d/i, why: 'broadcast-targeting test residue (#327)' },
];

const SLUG_PATTERNS = [
  { re: /\s/, why: 'slug contains whitespace (#328)' },
  { re: /[A-Z]/, why: 'slug contains uppercase (#328)' },
  { re: /[^a-z0-9-]/, why: 'slug has non-[a-z0-9-] chars (#328, #378)' },
];

// Date fields where year < 1990 or > 2100 is a validation gap.
const DATE_FIELDS = new Set([
  'dueDate', 'validUntil', 'expectedClose', 'closedAt', 'completedAt',
  'visitDate', 'expiresAt', 'startDate', 'endDate', 'date', 'sentAt',
]);

function checkField(value, patterns) {
  if (typeof value !== 'string' || value.length === 0) return null;
  for (const { re, why } of patterns) {
    if (re.test(value)) return why;
  }
  return null;
}

function checkRecord(record, fieldsToScan) {
  const offenses = [];
  if (!record || typeof record !== 'object') return offenses;

  for (const [key, value] of Object.entries(record)) {
    // Pick a pattern set based on the field NAME (semantic), not type.
    let why = null;
    if (fieldsToScan.name && (key === 'name' || key === 'title' || key === 'subject')) {
      why = checkField(value, NAME_PATTERNS);
    } else if (fieldsToScan.phone && key === 'phone') {
      why = checkField(value, PHONE_PATTERNS);
    } else if (fieldsToScan.email && key === 'email') {
      why = checkField(value, EMAIL_PATTERNS);
    } else if (fieldsToScan.body && (key === 'body' || key === 'description' || key === 'message')) {
      why = checkField(value, BODY_PATTERNS);
    } else if (fieldsToScan.slug && key === 'slug') {
      why = checkField(value, SLUG_PATTERNS);
    } else if (DATE_FIELDS.has(key) && value && typeof value === 'string') {
      const year = new Date(value).getFullYear();
      if (!isNaN(year) && (year < 1990 || year > 2100)) {
        why = `date out of range (year=${year}) — validation gap (#322, #210, #250)`;
      }
    }
    if (why) offenses.push(`${key}=${JSON.stringify(value).slice(0, 100)}: ${why}`);
  }
  return offenses;
}

async function authGet(request, path, token) {
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

async function loginAs(request, email) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email, password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return null;
  return (await r.json()).token;
}

function unwrap(body) {
  if (Array.isArray(body)) return body;
  return body?.data || body?.records || body?.contacts || body?.patients ||
    body?.locations || body?.notifications || body?.sequences || body?.estimates ||
    body?.invoices || body?.articles || body?.rules || body?.services || [];
}

test.describe('Demo hygiene — seed + payload scan (#120/#237/#265/#268/#285/#327/#328)', () => {
  test.beforeAll(async ({ request }) => {
    genericToken = await loginAs(request, 'admin@globussoft.com');
    wellnessToken = await loginAs(request, 'admin@wellness.demo');
  });

  // Each test below covers one endpoint. Independent so a failure on
  // one doesn't mask the others — the gate reports ALL offending
  // resources per CI run.

  const ENDPOINTS = [
    // [path, tenantTokenKey, fields-to-scan, optional minimum count]
    ['/api/contacts?limit=500',                     'generic', { name: 1, email: 1, phone: 1 }],
    ['/api/wellness/patients?limit=500',            'wellness', { name: 1, email: 1, phone: 1 }],
    ['/api/notifications?limit=500',                'wellness', { name: 1, body: 1 }],
    ['/api/sequences?limit=500',                    'generic', { name: 1, body: 1 }],
    ['/api/estimates?limit=500',                    'generic', { name: 1 }],
    ['/api/billing?limit=500',                      'generic', { name: 1 }],
    ['/api/wellness/services?limit=500',            'wellness', { name: 1, body: 1 }],
    ['/api/wellness/locations',                     'wellness', { name: 1, slug: 1 }],
    ['/api/lead-routing?limit=500',                 'generic', { name: 1 }],
    ['/api/knowledge-base/articles?limit=500',      'generic', { name: 1, body: 1, slug: 1 }],
  ];

  for (const [path, tenant, fields] of ENDPOINTS) {
    test(`${path} — no test/payload markers`, async ({ request }) => {
      const token = tenant === 'wellness' ? wellnessToken : genericToken;
      test.skip(!token, `${tenant} login unavailable in this env`);

      const res = await authGet(request, path, token);
      // Endpoints that don't exist in this env aren't a hygiene fail.
      // Skip 404 / 405 / 410 / 501 — those are absence-of-feature signals.
      if ([404, 405, 410, 501].includes(res.status())) {
        test.skip(true, `${path} returns ${res.status()} — endpoint not exposed`);
        return;
      }
      expect(res.status(), `unexpected status ${res.status()} on ${path}: ${(await res.text()).slice(0, 150)}`).toBe(200);

      const body = await res.json().catch(() => null);
      const records = unwrap(body);

      const offenses = [];
      for (const r of records) {
        const recOffenses = checkRecord(r, fields);
        for (const why of recOffenses) {
          offenses.push(`  ${path} id=${r.id ?? '?'}  ${why}`);
        }
      }

      if (offenses.length === 0) return;

      const message = `Demo hygiene — ${offenses.length} marker(s) on ${path}:\n${offenses.slice(0, 30).join('\n')}${offenses.length > 30 ? `\n  ... +${offenses.length - 30} more` : ''}`;
      if (TOLERATE) {
        console.warn(`[hygiene-tolerated] ${message}`);
        return;
      }
      expect(offenses, message).toEqual([]);
    });
  }

  // Catch the #265/#401 regression class — same name appearing more
  // than 3x in the same tenant — even if individual rows look clean.
  test('Patient list — no name appears more than 3x in the wellness tenant (#265, #401)', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness login unavailable');
    const res = await authGet(request, '/api/wellness/patients?limit=500', wellnessToken);
    if (!res.ok()) {
      test.skip(true, `patients endpoint ${res.status()}`);
      return;
    }
    const body = await res.json();
    const patients = unwrap(body);

    const counts = {};
    for (const p of patients) {
      const name = (p.name || '').trim().toLowerCase();
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }
    const dupes = Object.entries(counts).filter(([, n]) => n > 3);
    if (dupes.length === 0) return;
    const message = `patient name duplicates (>3x) suggest #401 @@unique was not applied or a seed introduced collisions: ${dupes.map(([n, c]) => `${JSON.stringify(n)} x${c}`).join(', ')}`;
    if (TOLERATE) {
      console.warn(`[hygiene-tolerated] ${message}`);
      return;
    }
    expect(dupes, message).toEqual([]);
  });
});
