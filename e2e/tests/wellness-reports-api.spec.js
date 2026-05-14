// @ts-check
/**
 * Wellness Reports API — G-18 from docs/E2E_GAPS.md.
 *
 * Target: backend/routes/wellness.js (4,050 lines, ~41% coverage). The
 * Reports surface is the 4-tab Owner-Dashboard reporting page —
 * P&L-by-service, Per-Professional, Per-Location, Attribution — plus the
 * per-#227 export siblings (.csv + .pdf for each tab). Sister specs:
 *   - wellness-telecaller-api.spec.js (G-19, commit 09d7328) — queue + dispose
 *   - wellness-dashboard-api.spec.js (G-17, this same wave)
 *   - wellness-clinical-api.spec.js — patients/visits/Rx/consent/services
 *   - wellness-rbac-api.spec.js — cross-cutting role gates (#214/#326)
 *
 * Endpoints covered (12):
 *   GET /api/wellness/reports/pnl-by-service           — JSON  (P&L tab)
 *   GET /api/wellness/reports/pnl-by-service.csv       — CSV export
 *   GET /api/wellness/reports/pnl-by-service.pdf       — PDF export
 *   GET /api/wellness/reports/per-professional         — JSON  (Per-Pro tab)
 *   GET /api/wellness/reports/per-professional.csv     — CSV export
 *   GET /api/wellness/reports/per-professional.pdf     — PDF export
 *   GET /api/wellness/reports/per-location             — JSON  (Per-Location tab)
 *   GET /api/wellness/reports/per-location.csv         — CSV export
 *   GET /api/wellness/reports/per-location.pdf         — PDF export
 *   GET /api/wellness/reports/attribution              — JSON  (Attribution tab)
 *   GET /api/wellness/reports/attribution.csv          — CSV export
 *   GET /api/wellness/reports/attribution.pdf          — PDF export
 *
 * Why this exists: the wellness Reports tabs back the Owner's go-no-go
 * decisions (campaign attribution, doctor productivity, P&L per service).
 * Pre-this-spec, these endpoints had ZERO regression coverage. The
 * #207/#216/#326 series + the #281 P&L mismatch + the #233 attribution
 * leak + the #232 four-tabs-disagreeing fix all happened on this surface.
 * Without a spec, the next compute-helper rewrite silently breaks the
 * Owner's view of revenue.
 *
 * Surface contract (per route source):
 *   1. RBAC: every report is gated `verifyWellnessRole(["admin","manager"])`.
 *      Doctor / professional / helper / telecaller → 403 WELLNESS_ROLE_FORBIDDEN.
 *      Generic-tenant ADMIN → 403 WELLNESS_TENANT_REQUIRED (#326 vertical gate).
 *   2. Date range: `?from=YYYY-MM-DD&to=YYYY-MM-DD`. Defaults to last 30 days.
 *      DATE_ONLY tokens get expanded to start-of-day / end-of-day UTC.
 *      Bad input → 400 INVALID_DATE_RANGE; from > to → 400 INVERTED_DATE_RANGE;
 *      year < 2000 or > 2100 → 400 DATE_OUT_OF_RANGE.
 *   3. JSON shape (every report):
 *      { window:{from,to[,locationId]}, totals:{...}, rows:[...] }
 *      P&L additionally surfaces a `canonical:{visits,revenue}` block (#281)
 *      so the frontend can render an "+N visits without service" footnote
 *      without the headline KPIs disagreeing with the row sum.
 *   4. CSV exports: Content-Type "text/csv; charset=utf-8", Content-Disposition
 *      attachment with date-range filename, leading UTF-8 BOM (0xEF 0xBB 0xBF)
 *      so Excel auto-detects encoding for ₹ glyph + Hindi names.
 *   5. PDF exports: Content-Type "application/pdf", Content-Disposition
 *      attachment, body starts with "%PDF-" magic bytes, non-empty.
 *
 * Tenant-isolation contract:
 *   - Every helper scopes by `tenantId: req.user.tenantId`. Two tenants with
 *     overlapping data must NEVER see each other's revenue. We don't have a
 *     second wellness tenant in seed, so this spec proves cross-VERTICAL
 *     isolation (generic admin → 403) — which is the same defence-in-depth
 *     wall, just expressed via the tenant.vertical column.
 *
 * Numerical sanity (asserted on JSON):
 *   - rows is an array of objects (possibly empty)
 *   - every numeric field >= 0 (revenue, visits, productCost, leads, junk)
 *   - junkRate / conversionRate ∈ [0, 100]
 *   - P&L: rows are sorted by revenue desc (the route does this — locks
 *     the contract so a future "sort by name" change is deliberate).
 *   - canonical.visits >= sum(rows.count) (i.e. unbucketed >= 0).
 *
 * PII / leak safety on exports:
 *   - CSV / PDF must not include patient names, phones, emails, internal
 *     notes, aiScore, or wellnessRole-internal fields beyond what the
 *     route's column list explicitly exposes. The columns are
 *     deliberately curated (Service / Category / Tier / Visits / …) so
 *     this assertion is "no rogue PII regex hits" rather than a positive
 *     allowlist match.
 *
 * Contract drift recorded vs the wave-18 prompt:
 *   1. Export endpoints are PATH-suffix `.csv` / `.pdf`, NOT `?format=csv`
 *      query params. Spec asserts the actual route shape.
 *   2. P&L JSON has BOTH a `totals` block AND a separate `canonical` block —
 *      the orchestrator brief mentioned only "top-level keys"; we pin both.
 *   3. Auth-only token (no role) returning 403 not 401 — the global guard
 *      in server.js rejects unauthenticated calls with 403, not 401, so
 *      we accept either.
 *
 * Test environment:
 *   - BASE_URL defaults to https://crm.globusdemos.com
 *   - Local: cd e2e && BASE_URL=http://127.0.0.1:5000 npx playwright test \
 *            --project=chromium --no-deps tests/wellness-reports-api.spec.js
 *   - Fixtures (all password123):
 *       admin@globussoft.com           — GENERIC tenant ADMIN (vertical-gate test)
 *       admin@wellness.demo            — WELLNESS ADMIN (gate-allowed via "admin")
 *       manager@enhancedwellness.in    — WELLNESS MANAGER (gate-allowed via "manager")
 *       drharsh@enhancedwellness.in    — WELLNESS USER+doctor (wrong role → 403)
 *       stylist1@enhancedwellness.in   — WELLNESS USER+professional (wrong role → 403)
 *       helper1@enhancedwellness.in    — WELLNESS USER+helper (wrong role → 403)
 *       telecaller@enhancedwellness.in — WELLNESS USER+telecaller (wrong role → 403)
 *
 * Pattern: cloned from e2e/tests/wellness-telecaller-api.spec.js (G-19, 09d7328)
 * + e2e/tests/wellness-rbac-api.spec.js for the gate matrix.
 *
 * Self-clean: this spec only READS — no fixtures created, no cleanup needed.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_REPORTS_${Date.now()}`;

// All four JSON endpoints, plus a parameterised list of (json, csv, pdf) triples
// for the export matrix.
const REPORT_JSON_PATHS = [
  '/api/wellness/reports/pnl-by-service',
  '/api/wellness/reports/per-professional',
  '/api/wellness/reports/per-location',
  '/api/wellness/reports/attribution',
];

const REPORT_TRIPLES = [
  {
    name: 'pnl-by-service',
    json: '/api/wellness/reports/pnl-by-service',
    csv: '/api/wellness/reports/pnl-by-service.csv',
    pdf: '/api/wellness/reports/pnl-by-service.pdf',
    csvHeaderFirstCol: 'Service',
  },
  {
    name: 'per-professional',
    json: '/api/wellness/reports/per-professional',
    csv: '/api/wellness/reports/per-professional.csv',
    pdf: '/api/wellness/reports/per-professional.pdf',
    csvHeaderFirstCol: 'Staff',
  },
  {
    name: 'per-location',
    json: '/api/wellness/reports/per-location',
    csv: '/api/wellness/reports/per-location.csv',
    pdf: '/api/wellness/reports/per-location.pdf',
    csvHeaderFirstCol: 'Location',
  },
  {
    name: 'attribution',
    json: '/api/wellness/reports/attribution',
    csv: '/api/wellness/reports/attribution.csv',
    pdf: '/api/wellness/reports/attribution.pdf',
    csvHeaderFirstCol: 'Source',
  },
];

const FIXTURES = {
  genericAdmin: { email: 'admin@globussoft.com',           password: 'password123' },
  admin:        { email: 'admin@wellness.demo',            password: 'password123' },
  manager:      { email: 'manager@enhancedwellness.in',    password: 'password123' },
  doctor:       { email: 'drharsh@enhancedwellness.in',    password: 'password123' },
  professional: { email: 'stylist1@enhancedwellness.in',   password: 'password123' },
  helper:       { email: 'helper1@enhancedwellness.in',    password: 'password123' },
  telecaller:   { email: 'telecaller@enhancedwellness.in', password: 'password123' },
};

const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fixture = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fixture,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        tokenCache[who] = j.token;
        userIdCache[who] = j.user && j.user.id;
        return { token: tokenCache[who], userId: userIdCache[who] };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${(await login(request, who)).token}`,
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}

// Pre-flight: confirm fixtures resolve so test failures point at the right place.
test.beforeAll(async ({ request }) => {
  for (const who of ['admin', 'manager', 'doctor', 'professional', 'helper', 'telecaller', 'genericAdmin']) {
    const r = await login(request, who);
    expect(r.token, `${who} fixture must seed`).toBeTruthy();
  }
});

// =====================================================================
// 1. Auth gate — no token
// =====================================================================

test.describe('Wellness Reports API — auth gate (no token)', () => {
  for (const path of REPORT_JSON_PATHS) {
    test(`GET ${path} without token → 401/403`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${path}`);
      expect([401, 403]).toContain(res.status());
    });
  }

  test('GET pnl-by-service.csv without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/wellness/reports/pnl-by-service.csv`);
    expect([401, 403]).toContain(res.status());
  });

  test('GET pnl-by-service.pdf without token → 401/403', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/wellness/reports/pnl-by-service.pdf`);
    expect([401, 403]).toContain(res.status());
  });
});

// =====================================================================
// 2. Wellness-role gate — non-admin/manager wellnessRole → 403
// =====================================================================

test.describe('Wellness Reports API — wellnessRole gate (#207/#216 financial-leak fix)', () => {
  // The four wellness "low-privilege" roles must all bounce off every report
  // — they're the org-wide P&L view, not their personal slice. Anyone with
  // a wellnessRole that isn't admin/manager (or matching ADMIN/MANAGER role)
  // gets 403 WELLNESS_ROLE_FORBIDDEN.
  const FORBIDDEN_ROLES = ['doctor', 'professional', 'helper', 'telecaller'];

  for (const role of FORBIDDEN_ROLES) {
    test(`${role} → 403 WELLNESS_ROLE_FORBIDDEN on /reports/pnl-by-service`, async ({ request }) => {
      const res = await authGet(request, '/api/wellness/reports/pnl-by-service', role);
      expect(res.status()).toBe(403);
      const body = await res.json().catch(() => ({}));
      expect(body.code).toBe('WELLNESS_ROLE_FORBIDDEN');
    });

    test(`${role} → 403 on /reports/per-professional`, async ({ request }) => {
      const res = await authGet(request, '/api/wellness/reports/per-professional', role);
      expect(res.status()).toBe(403);
    });

    test(`${role} → 403 on /reports/per-location`, async ({ request }) => {
      const res = await authGet(request, '/api/wellness/reports/per-location', role);
      expect(res.status()).toBe(403);
    });

    test(`${role} → 403 on /reports/attribution`, async ({ request }) => {
      const res = await authGet(request, '/api/wellness/reports/attribution', role);
      expect(res.status()).toBe(403);
    });
  }

  test('doctor → 403 on .csv export (gate runs before serializer)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/pnl-by-service.csv', 'doctor');
    expect(res.status()).toBe(403);
  });

  test('telecaller → 403 on .pdf export', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/attribution.pdf', 'telecaller');
    expect(res.status()).toBe(403);
  });
});

// =====================================================================
// 3. Tenant-vertical gate — generic ADMIN → 403 (#326)
// =====================================================================

test.describe('Wellness Reports API — tenant-vertical gate (#326)', () => {
  for (const path of REPORT_JSON_PATHS) {
    test(`generic admin → 403 WELLNESS_TENANT_REQUIRED on ${path}`, async ({ request }) => {
      const res = await authGet(request, path, 'genericAdmin');
      expect(res.status()).toBe(403);
      const body = await res.json().catch(() => ({}));
      expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
    });
  }

  test('generic admin → 403 on .csv export', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/pnl-by-service.csv', 'genericAdmin');
    expect(res.status()).toBe(403);
    const body = await res.json().catch(() => ({}));
    expect(body.code).toBe('WELLNESS_TENANT_REQUIRED');
  });

  test('generic admin → 403 on .pdf export', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/per-location.pdf', 'genericAdmin');
    expect(res.status()).toBe(403);
  });
});

// =====================================================================
// 4. Allowed roles (admin + manager) — happy path on every JSON report
// =====================================================================

test.describe('Wellness Reports API — allowed roles happy path', () => {
  for (const who of ['admin', 'manager']) {
    for (const path of REPORT_JSON_PATHS) {
      test(`${who} → 200 on GET ${path}`, async ({ request }) => {
        const res = await authGet(request, path, who);
        expect(res.status(), `body: ${await res.text()}`).toBe(200);
        const body = await res.json();
        // Every report has the same envelope.
        expect(body).toHaveProperty('window');
        expect(body.window).toHaveProperty('from');
        expect(body.window).toHaveProperty('to');
        expect(body).toHaveProperty('totals');
        expect(body).toHaveProperty('rows');
        expect(Array.isArray(body.rows)).toBe(true);
      });
    }
  }
});

// =====================================================================
// 5. P&L-by-service shape + numerical sanity
// =====================================================================

test.describe('Wellness Reports API — pnl-by-service JSON shape', () => {
  let payload;

  test.beforeAll(async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/pnl-by-service', 'admin');
    expect(res.status()).toBe(200);
    payload = await res.json();
  });

  test('window has from + to + locationId (null by default)', () => {
    expect(payload.window).toHaveProperty('from');
    expect(payload.window).toHaveProperty('to');
    expect(payload.window).toHaveProperty('locationId');
    // Default locationId (no query param) is null per route source.
    expect(payload.window.locationId).toBeNull();
  });

  test('totals carries visits, revenue, productCost, contribution, unbucketed', () => {
    const t = payload.totals;
    expect(typeof t.visits).toBe('number');
    expect(typeof t.revenue).toBe('number');
    expect(typeof t.productCost).toBe('number');
    expect(typeof t.contribution).toBe('number');
    expect(typeof t.unbucketed).toBe('number');
    // Numerical sanity — every total is non-negative.
    expect(t.visits).toBeGreaterThanOrEqual(0);
    expect(t.revenue).toBeGreaterThanOrEqual(0);
    expect(t.productCost).toBeGreaterThanOrEqual(0);
    expect(t.unbucketed).toBeGreaterThanOrEqual(0);
    // contribution = revenue - productCost; allow tiny float epsilon.
    expect(Math.abs(t.contribution - (t.revenue - t.productCost))).toBeLessThan(0.01);
  });

  test('canonical block surfaces the un-bucketed totals (#281)', () => {
    expect(payload.canonical).toBeTruthy();
    expect(typeof payload.canonical.visits).toBe('number');
    expect(typeof payload.canonical.revenue).toBe('number');
    // canonical >= bucketed (the difference is unbucketed).
    expect(payload.canonical.visits).toBeGreaterThanOrEqual(payload.totals.visits);
  });

  test('rows are sorted by revenue desc (locked contract)', () => {
    if (payload.rows.length < 2) test.skip(true, 'need >=2 rows to assert ordering');
    for (let i = 1; i < payload.rows.length; i++) {
      expect(payload.rows[i - 1].revenue).toBeGreaterThanOrEqual(payload.rows[i].revenue);
    }
  });

  test('each row has id, name, category, ticketTier, count, revenue, productCost, contribution', () => {
    for (const r of payload.rows) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('category');
      expect(r).toHaveProperty('ticketTier');
      expect(typeof r.count).toBe('number');
      expect(typeof r.revenue).toBe('number');
      expect(typeof r.productCost).toBe('number');
      expect(typeof r.contribution).toBe('number');
      // No PII / internal-fields leak.
      expect(r).not.toHaveProperty('aiScore');
      expect(r).not.toHaveProperty('internalNotes');
      expect(r).not.toHaveProperty('tenantId');
      // Sanity: count is a non-negative integer.
      expect(r.count).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.count)).toBe(true);
      expect(r.revenue).toBeGreaterThanOrEqual(0);
    }
  });
});

// =====================================================================
// 6. Per-Professional shape
// =====================================================================

test.describe('Wellness Reports API — per-professional JSON shape', () => {
  let payload;

  test.beforeAll(async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/per-professional', 'admin');
    expect(res.status()).toBe(200);
    payload = await res.json();
  });

  test('totals carries visits + revenue + unbucketed', () => {
    const t = payload.totals;
    expect(typeof t.visits).toBe('number');
    expect(typeof t.revenue).toBe('number');
    expect(typeof t.unbucketed).toBe('number');
    expect(t.visits).toBeGreaterThanOrEqual(0);
    expect(t.revenue).toBeGreaterThanOrEqual(0);
  });

  test('rows have id, name, role, wellnessRole, visits, revenue', () => {
    for (const r of payload.rows) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('role');
      expect(r).toHaveProperty('wellnessRole');
      expect(typeof r.visits).toBe('number');
      expect(typeof r.revenue).toBe('number');
      expect(r.visits).toBeGreaterThanOrEqual(0);
      expect(r.revenue).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.visits)).toBe(true);
      // Must NOT leak email / phone — the route's select pulls email but
      // the comp acc never carries it through. Belt-and-braces:
      expect(r).not.toHaveProperty('email');
      expect(r).not.toHaveProperty('phone');
    }
  });

  test('rows sorted by revenue desc', () => {
    if (payload.rows.length < 2) test.skip(true, 'need >=2 rows');
    for (let i = 1; i < payload.rows.length; i++) {
      expect(payload.rows[i - 1].revenue).toBeGreaterThanOrEqual(payload.rows[i].revenue);
    }
  });
});

// =====================================================================
// 7. Per-Location shape
// =====================================================================

test.describe('Wellness Reports API — per-location JSON shape', () => {
  let payload;

  test.beforeAll(async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/per-location', 'admin');
    expect(res.status()).toBe(200);
    payload = await res.json();
  });

  test('rows have id, name, city, state, isActive, visits, revenue, patients', () => {
    for (const r of payload.rows) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('name');
      expect(r).toHaveProperty('city');
      expect(r).toHaveProperty('state');
      expect(typeof r.isActive).toBe('boolean');
      expect(typeof r.visits).toBe('number');
      expect(typeof r.revenue).toBe('number');
      expect(typeof r.patients).toBe('number');
      // Sanity.
      expect(r.visits).toBeGreaterThanOrEqual(0);
      expect(r.revenue).toBeGreaterThanOrEqual(0);
      expect(r.patients).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.visits)).toBe(true);
      expect(Number.isInteger(r.patients)).toBe(true);
    }
  });

  test('totals.visits >= sum(rows.visits) (canonical >= bucketed; unbucketed >= 0)', () => {
    const summed = payload.rows.reduce((s, r) => s + r.visits, 0);
    expect(payload.totals.visits).toBeGreaterThanOrEqual(summed);
    expect(payload.totals.unbucketed).toBeGreaterThanOrEqual(0);
  });

  test('rows sorted by revenue desc', () => {
    if (payload.rows.length < 2) test.skip(true, 'need >=2 rows');
    for (let i = 1; i < payload.rows.length; i++) {
      expect(payload.rows[i - 1].revenue).toBeGreaterThanOrEqual(payload.rows[i].revenue);
    }
  });
});

// =====================================================================
// 8. Attribution shape — leads / junkRate / conversionRate / revenue (#233 fix)
// =====================================================================

test.describe('Wellness Reports API — attribution JSON shape', () => {
  let payload;

  test.beforeAll(async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/attribution', 'admin');
    expect(res.status()).toBe(200);
    payload = await res.json();
  });

  test('totals carries leads, junk, qualified, revenue (all non-negative)', () => {
    const t = payload.totals;
    expect(typeof t.leads).toBe('number');
    expect(typeof t.junk).toBe('number');
    expect(typeof t.qualified).toBe('number');
    expect(typeof t.revenue).toBe('number');
    expect(t.leads).toBeGreaterThanOrEqual(0);
    expect(t.junk).toBeGreaterThanOrEqual(0);
    expect(t.qualified).toBeGreaterThanOrEqual(0);
    expect(t.revenue).toBeGreaterThanOrEqual(0);
    // junk + qualified + (still-Lead) cannot exceed total leads.
    expect(t.junk + t.qualified).toBeLessThanOrEqual(t.leads);
  });

  test('rows have source + leads + junk + qualified + revenue + computed rates', () => {
    for (const r of payload.rows) {
      expect(typeof r.source).toBe('string');
      expect(typeof r.leads).toBe('number');
      expect(typeof r.junk).toBe('number');
      expect(typeof r.qualified).toBe('number');
      expect(typeof r.revenue).toBe('number');
      expect(typeof r.junkRate).toBe('number');
      expect(typeof r.conversionRate).toBe('number');
      expect(typeof r.revenuePerLead).toBe('number');
      // Rates must be in [0, 100] — junk/qualified can never exceed leads.
      expect(r.junkRate).toBeGreaterThanOrEqual(0);
      expect(r.junkRate).toBeLessThanOrEqual(100);
      expect(r.conversionRate).toBeGreaterThanOrEqual(0);
      expect(r.conversionRate).toBeLessThanOrEqual(100);
      // Counts non-negative integers.
      expect(r.leads).toBeGreaterThanOrEqual(0);
      expect(r.junk).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.leads)).toBe(true);
      expect(Number.isInteger(r.junk)).toBe(true);
      // #233: a row with 0 leads must have 0 revenue (no orphan attribution).
      if (r.leads === 0) expect(r.revenue).toBe(0);
    }
  });

  test('rows sorted by revenue desc', () => {
    if (payload.rows.length < 2) test.skip(true, 'need >=2 rows');
    for (let i = 1; i < payload.rows.length; i++) {
      expect(payload.rows[i - 1].revenue).toBeGreaterThanOrEqual(payload.rows[i].revenue);
    }
  });

  test('row counts roll up into totals exactly', () => {
    const sumLeads = payload.rows.reduce((s, r) => s + r.leads, 0);
    const sumJunk = payload.rows.reduce((s, r) => s + r.junk, 0);
    expect(sumLeads).toBe(payload.totals.leads);
    expect(sumJunk).toBe(payload.totals.junk);
  });
});

// =====================================================================
// 9. Date filter — ?from + ?to query params
// =====================================================================

test.describe('Wellness Reports API — date filter (?from + ?to)', () => {
  test('valid YYYY-MM-DD range echoed in window block', async ({ request }) => {
    const from = '2026-04-01';
    const to = '2026-04-30';
    const res = await authGet(
      request,
      `/api/wellness/reports/pnl-by-service?from=${from}&to=${to}`,
      'admin',
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Route expands DATE_ONLY tokens to start/end of UTC day.
    expect(body.window.from).toContain('2026-04-01');
    expect(body.window.to).toContain('2026-04-30');
  });

  test('invalid date string → 400 INVALID_DATE_RANGE', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/pnl-by-service?from=garbage&to=alsojunk',
      'admin',
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_DATE_RANGE');
  });

  test('inverted range (from > to) → 400 INVERTED_DATE_RANGE', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/pnl-by-service?from=2026-12-01&to=2026-01-01',
      'admin',
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVERTED_DATE_RANGE');
  });

  test('out-of-range year → 400 DATE_OUT_OF_RANGE', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/pnl-by-service?from=1850-01-01&to=1850-12-31',
      'admin',
    );
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('DATE_OUT_OF_RANGE');
  });

  test('narrow future window with no completed visits → empty rows + zero totals (no 500)', async ({ request }) => {
    // 2099 is in-range (MAX_REPORT_YEAR === 2100) but no seeded visit lives there.
    const res = await authGet(
      request,
      '/api/wellness/reports/pnl-by-service?from=2099-01-01&to=2099-01-02',
      'admin',
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.rows.length).toBe(0);
    expect(body.totals.visits).toBe(0);
    expect(body.totals.revenue).toBe(0);
  });

  test('attribution honours date filter without 500', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/attribution?from=2099-01-01&to=2099-01-02',
      'admin',
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.totals.leads).toBe(0);
    expect(body.totals.revenue).toBe(0);
  });
});

// =====================================================================
// 10. CSV exports — content-type + UTF-8 BOM + disposition + headers
// =====================================================================

test.describe('Wellness Reports API — CSV exports (#227)', () => {
  for (const triple of REPORT_TRIPLES) {
    test(`${triple.name}.csv: 200 + text/csv content-type + UTF-8 BOM + attachment disposition`, async ({ request }) => {
      const res = await authGet(request, triple.csv, 'admin');
      expect(res.status(), `body: ${await res.text()}`).toBe(200);

      const contentType = res.headers()['content-type'] || '';
      expect(contentType).toContain('text/csv');
      expect(contentType).toContain('charset=utf-8');

      const disposition = res.headers()['content-disposition'] || '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('.csv');

      // Body starts with UTF-8 BOM (0xEF 0xBB 0xBF) so Excel auto-detects encoding.
      const buf = await res.body();
      expect(buf.length).toBeGreaterThan(3);
      expect(buf[0]).toBe(0xEF);
      expect(buf[1]).toBe(0xBB);
      expect(buf[2]).toBe(0xBF);

      // First text line after BOM is the header row.
      const text = buf.slice(3).toString('utf8');
      const firstLine = text.split(/\r?\n/)[0];
      expect(firstLine).toContain(triple.csvHeaderFirstCol);
    });
  }

  test('CSV body has CRLF line endings (Excel-friendly)', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/pnl-by-service.csv', 'admin');
    const text = (await res.body()).toString('utf8');
    expect(text).toContain('\r\n');
  });

  test('manager role can export CSV', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/per-professional.csv', 'manager');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/csv');
  });

  test('CSV honours date filter (filename echoes range)', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/pnl-by-service.csv?from=2026-04-01&to=2026-04-30',
      'admin',
    );
    expect(res.status()).toBe(200);
    const disposition = res.headers()['content-disposition'] || '';
    expect(disposition).toContain('2026-04-01');
    expect(disposition).toContain('2026-04-30');
  });

  test('CSV with bad date → 400 (no leak of partial body)', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/pnl-by-service.csv?from=garbage&to=alsojunk',
      'admin',
    );
    expect(res.status()).toBe(400);
  });

  test('CSV body must not leak PII columns (no aiScore / internalNotes / tenantId tokens)', async ({ request }) => {
    // Defence-in-depth: the route picks columns explicitly so this is a
    // belt-and-braces check that future "add a debug column" rewrites
    // don't silently expose internal fields. We scan the entire CSV.
    const res = await authGet(request, '/api/wellness/reports/per-professional.csv', 'admin');
    const text = (await res.body()).toString('utf8');
    expect(text).not.toMatch(/aiScore/i);
    expect(text).not.toMatch(/internalNotes/i);
    expect(text).not.toMatch(/tenantId/i);
    expect(text).not.toMatch(/passwordHash/i);
  });
});

// =====================================================================
// 11. PDF exports — content-type + magic bytes + disposition
// =====================================================================

test.describe('Wellness Reports API — PDF exports (#227)', () => {
  for (const triple of REPORT_TRIPLES) {
    test(`${triple.name}.pdf: 200 + application/pdf + %PDF- magic + attachment disposition`, async ({ request }) => {
      const res = await authGet(request, triple.pdf, 'admin');
      expect(res.status(), `body: ${await res.text().catch(() => '')}`).toBe(200);

      expect(res.headers()['content-type']).toBe('application/pdf');

      const disposition = res.headers()['content-disposition'] || '';
      expect(disposition).toContain('attachment');
      expect(disposition).toContain('.pdf');

      // Body starts with "%PDF-" magic bytes and is non-empty.
      const buf = await res.body();
      expect(buf.length).toBeGreaterThan(100);
      expect(buf.slice(0, 5).toString('ascii')).toBe('%PDF-');
    });
  }

  test('manager role can export PDF', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/attribution.pdf', 'manager');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('application/pdf');
  });

  test('PDF honours date filter (filename echoes range)', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/per-location.pdf?from=2026-04-01&to=2026-04-30',
      'admin',
    );
    expect(res.status()).toBe(200);
    const disposition = res.headers()['content-disposition'] || '';
    expect(disposition).toContain('2026-04-01');
    expect(disposition).toContain('2026-04-30');
  });

  test('Content-Length header set on PDF response', async ({ request }) => {
    const res = await authGet(request, '/api/wellness/reports/pnl-by-service.pdf', 'admin');
    expect(res.status()).toBe(200);
    const len = parseInt(res.headers()['content-length'] || '0', 10);
    expect(len).toBeGreaterThan(100);
    const buf = await res.body();
    expect(buf.length).toBe(len);
  });

  test('PDF with bad date → 400 (no leak of partial PDF bytes)', async ({ request }) => {
    const res = await authGet(
      request,
      '/api/wellness/reports/attribution.pdf?from=garbage&to=alsojunk',
      'admin',
    );
    expect(res.status()).toBe(400);
  });
});

// =====================================================================
// 12. #565 (HI-16) canonical revenue reconciliation across surfaces
// =====================================================================
//
// Wave 9 Agent A, 2026-05-10. The bug this pins:
//   /wellness Owner Dashboard, /wellness/reports P&L tab, and /wellness/reports
//   per-professional / per-location tabs were each computing revenue with a
//   different status filter. The 2026-05-07 retest comment on #565 logged
//   five different totals for the same window. Post-this-spec, all surfaces
//   read sum(amountCharged) WHERE status='completed' (the canonical, encoded
//   in backend/lib/pnlMath.js).
//
// What we assert: for the SAME tenant + window, the headline revenue figure
// surfaced by /reports/pnl-by-service.totalRevenue equals the sum of the
// /reports/per-professional rows AND equals the sum of the /reports/per-location
// rows. We also assert /pnl-by-service.totalRevenue == sum(rows.revenue) on
// itself (the #281 internal-sanity contract).
//
// The dashboard's /api/wellness/dashboard endpoint reports yesterday.revenue
// for a fixed yesterday IST window. We can't trivially align the report's
// from/to to that exact window from the test because the dashboard window
// is server-side IST midnight-anchored. We assert a weaker contract: for a
// 30-day window covering yesterday, the P&L revenue is >= the dashboard's
// yesterday.revenue (i.e. the dashboard figure is a single day's slice of
// the larger window). This catches regressions where yesterday.revenue
// silently sums non-completed visits and exceeds the canonical bound.
//
// Tenant choice: the wellness Admin's view. Demo seed has enough data
// across 30 days for the rows to actually have nonzero revenue.

test.describe('#565 (HI-16) — canonical revenue reconciliation across surfaces', () => {
  test('P&L by-service totalRevenue == sum(rows.revenue) (internal sanity, #281)', async ({ request }) => {
    const r = await authGet(request, '/api/wellness/reports/pnl-by-service', 'admin');
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(typeof body.totalRevenue).toBe('number');
    const sumOfRows = (body.rows || []).reduce(
      (s, row) => s + (Number(row.revenue) || 0),
      0,
    );
    // toBeCloseTo with 2 decimals — float accumulation can drift in the
    // 12th decimal otherwise.
    expect(body.totalRevenue).toBeCloseTo(sumOfRows, 2);
  });

  test('P&L revenue == per-professional revenue total (same window)', async ({ request }) => {
    const pnl = await authGet(request, '/api/wellness/reports/pnl-by-service', 'admin');
    const perPro = await authGet(request, '/api/wellness/reports/per-professional', 'admin');
    expect(pnl.ok()).toBeTruthy();
    expect(perPro.ok()).toBeTruthy();
    const pnlBody = await pnl.json();
    const perProBody = await perPro.json();
    // Note: per-professional.totals.revenue uses the canonical computation
    // over the full visit set — equals the P&L canonical.revenue (which is
    // the un-bucketed total). pnl.totalRevenue is the BUCKETED total
    // (rows summed) and may differ from canonical when visits lack a
    // serviceId. We compare against pnl.canonical.revenue here per the
    // route's documented contract.
    expect(typeof pnlBody.canonical?.revenue).toBe('number');
    expect(typeof perProBody.totals?.revenue).toBe('number');
    expect(pnlBody.canonical.revenue).toBeCloseTo(perProBody.totals.revenue, 2);
  });

  test('P&L revenue == per-location revenue total (same window)', async ({ request }) => {
    const pnl = await authGet(request, '/api/wellness/reports/pnl-by-service', 'admin');
    const perLoc = await authGet(request, '/api/wellness/reports/per-location', 'admin');
    expect(pnl.ok()).toBeTruthy();
    expect(perLoc.ok()).toBeTruthy();
    const pnlBody = await pnl.json();
    const perLocBody = await perLoc.json();
    expect(typeof pnlBody.canonical?.revenue).toBe('number');
    expect(typeof perLocBody.totals?.revenue).toBe('number');
    expect(pnlBody.canonical.revenue).toBeCloseTo(perLocBody.totals.revenue, 2);
  });

  test('per-professional and per-location agree on revenue total (transitive)', async ({ request }) => {
    const perPro = await authGet(request, '/api/wellness/reports/per-professional', 'admin');
    const perLoc = await authGet(request, '/api/wellness/reports/per-location', 'admin');
    expect(perPro.ok()).toBeTruthy();
    expect(perLoc.ok()).toBeTruthy();
    const perProBody = await perPro.json();
    const perLocBody = await perLoc.json();
    expect(perProBody.totals.revenue).toBeCloseTo(perLocBody.totals.revenue, 2);
  });

  test('dashboard yesterday.revenue is bounded by P&L for same tenant + 30-day window', async ({ request }) => {
    // Sanity bound: dashboard.yesterday.revenue is a single-day window
    // inside the 30-day default report window. Post-#565 fix the dashboard
    // value uses the canonical filter, so 0 <= yesterday.revenue <=
    // pnl.canonical.revenue (default 30-day).  Pre-fix the dashboard value
    // could exceed P&L because cancelled/no-show rows leaked in.
    const dashRes = await authGet(request, '/api/wellness/dashboard', 'admin');
    const pnlRes = await authGet(request, '/api/wellness/reports/pnl-by-service', 'admin');
    expect(dashRes.ok()).toBeTruthy();
    expect(pnlRes.ok()).toBeTruthy();
    const dash = await dashRes.json();
    const pnl = await pnlRes.json();
    const yesterdayRevenue = Number(dash?.yesterday?.revenue ?? 0);
    const pnlRevenue = Number(pnl?.canonical?.revenue ?? 0);
    expect(yesterdayRevenue).toBeGreaterThanOrEqual(0);
    // Strict-less-equal with a 1-rupee slack for window-boundary timing
    // (the dashboard uses startOfDay/endOfDay IST; the report defaults
    // to "now - 30 days" which may chop the boundary by ms).
    expect(yesterdayRevenue).toBeLessThanOrEqual(pnlRevenue + 1);
  });
});

// =====================================================================
// 13. RUN_TAG sanity — this spec creates no fixtures, but log the tag
// =====================================================================

// Read-only spec: no afterAll / fixture cleanup needed. RUN_TAG ${RUN_TAG}
// is unique-per-run and would mark any rows we inserted, but this spec
// asserts pre-existing seed data rather than mutating state. Documented
// here so a future agent expanding this spec to mutate (e.g. seed a Visit
// then assert it shows up in P&L) knows to add proper afterAll cleanup.
void RUN_TAG;
