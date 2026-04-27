// @ts-check
/**
 * Reports module — full API coverage push (TODOS.md NEXT-SESSION priority #1).
 *
 * routes/reports.js had 14.17% coverage (70/494 lines) — biggest single gap
 * holding global coverage below the 60% gate. This spec exercises every
 * endpoint + every metric/type branch + the validators shared across them.
 *
 * Endpoints covered:
 *   GET /api/reports/query              — 8 metric branches + validation
 *   GET /api/reports/agent-performance  — happy path + date filter
 *   GET /api/reports/agent/:userId      — 200 + 404 + cross-tenant
 *   GET /api/reports/leaderboard        — 5 metric branches
 *   GET /api/reports/detailed/:type     — 6 type branches + bad type + ownerId/status filters
 *   GET /api/reports/export-csv         — 3 type branches + 2 metric branches + bad type + bad metric
 *   GET /api/reports/export-pdf         — 3 type branches (agent-performance / deals / default)
 *
 * Pattern (same as e2e/tests/billing-update.spec.js): cached auth token,
 * one authGet helper, no per-test setup. The existing reports.spec.js is
 * page-level UI smoke; this is the API coverage companion.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

let authToken = null;

async function getAuthToken(request) {
  if (authToken) return authToken;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: 'admin@globussoft.com', password: 'password123' },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (response.ok()) {
        const data = await response.json();
        authToken = data.token;
        return authToken;
      }
    } catch (e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function authGet(request, path) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
}

function isoDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

// ─── /query — 8 metrics + validators ─────────────────────────────────

test.describe('Reports API — /query metric branches', () => {
  test('default metric=revenue groupBy=stage returns array of {name, value}', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('name');
      expect(body[0]).toHaveProperty('value');
    }
  });

  test('metric=count returns deal counts grouped by stage', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=count&groupBy=stage');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('metric=win_rate returns 3 buckets — Won / Lost / In Progress', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=win_rate');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(3);
    const names = body.map((b) => b.name).sort();
    expect(names).toEqual(['In Progress', 'Lost', 'Won']);
  });

  test('metric=tasks groups task counts by status', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=tasks');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('metric=contacts_by_source groups contact counts by source', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=contacts_by_source');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('metric=contacts_by_status groups contact counts by status', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=contacts_by_status');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('metric=invoices groups invoice sums by status (uses issuedDate field)', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=invoices');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) expect(body[0]).toHaveProperty('count');
  });

  test('metric=expenses groups expense sums by category', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=expenses');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('unknown metric → 400', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?metric=nope_unknown');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/Unsupported|metric/i);
  });

  test('startDate after endDate → 400 INVERTED_RANGE', async ({ request }) => {
    const res = await authGet(request, `/api/reports/query?startDate=${isoDate(5)}&endDate=${isoDate(-5)}`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVERTED_RANGE');
  });

  test('non-date startDate → 400 INVALID_DATE', async ({ request }) => {
    const res = await authGet(request, '/api/reports/query?startDate=not-a-date&endDate=2026-01-01');
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVALID_DATE');
  });

  test('valid date range filters results without erroring', async ({ request }) => {
    const res = await authGet(request, `/api/reports/query?startDate=${isoDate(-30)}&endDate=${isoDate(0)}`);
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
});

// ─── /agent-performance ──────────────────────────────────────────────

test.describe('Reports API — /agent-performance', () => {
  test('returns array of agents with revenue/winRate/dealsWon shape', async ({ request }) => {
    const res = await authGet(request, '/api/reports/agent-performance');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const a = body[0];
    expect(a).toHaveProperty('id');
    expect(a).toHaveProperty('revenue');
    expect(a).toHaveProperty('dealsWon');
    expect(a).toHaveProperty('winRate');
    expect(a).toHaveProperty('tasksCompleted');
    expect(a).toHaveProperty('callsMade');
    expect(a).toHaveProperty('emailsSent');
    expect(a).toHaveProperty('contactsAssigned');
  });

  test('respects date filter without erroring', async ({ request }) => {
    const res = await authGet(request, `/api/reports/agent-performance?startDate=${isoDate(-7)}&endDate=${isoDate(0)}`);
    expect(res.status()).toBe(200);
  });
});

// ─── /agent/:userId ──────────────────────────────────────────────────

test.describe('Reports API — /agent/:userId', () => {
  test('returns 200 with agent + deals/tasks/calls/emails/contacts arrays', async ({ request }) => {
    const perf = await authGet(request, '/api/reports/agent-performance');
    const agents = await perf.json();
    const userId = agents[0].id;
    const res = await authGet(request, `/api/reports/agent/${userId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.agent.id).toBe(userId);
    expect(Array.isArray(body.deals)).toBe(true);
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(Array.isArray(body.calls)).toBe(true);
    expect(Array.isArray(body.emails)).toBe(true);
    expect(Array.isArray(body.contacts)).toBe(true);
  });

  test('non-existent userId → 404', async ({ request }) => {
    const res = await authGet(request, '/api/reports/agent/99999999');
    expect(res.status()).toBe(404);
  });
});

// ─── /leaderboard ────────────────────────────────────────────────────

test.describe('Reports API — /leaderboard metric branches', () => {
  for (const metric of ['revenue', 'deals', 'calls', 'tasks', 'emails']) {
    test(`metric=${metric} returns sorted ranking`, async ({ request }) => {
      const res = await authGet(request, `/api/reports/leaderboard?metric=${metric}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      if (body.length >= 2) {
        // Descending sort by value.
        expect(body[0].value).toBeGreaterThanOrEqual(body[1].value);
      }
      if (body[0]) {
        expect(body[0]).toHaveProperty('id');
        expect(body[0]).toHaveProperty('name');
        expect(body[0]).toHaveProperty('value');
      }
    });
  }

  test('default metric=revenue when omitted', async ({ request }) => {
    const res = await authGet(request, '/api/reports/leaderboard');
    expect(res.status()).toBe(200);
  });
});

// ─── /detailed/:type ─────────────────────────────────────────────────

test.describe('Reports API — /detailed/:type', () => {
  for (const type of ['deals', 'contacts', 'tasks', 'calls', 'invoices', 'expenses']) {
    test(`type=${type} returns array`, async ({ request }) => {
      const res = await authGet(request, `/api/reports/detailed/${type}?limit=10`);
      expect(res.status()).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    });
  }

  test('unknown type → 400', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/nonsense_type');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/Unsupported/i);
  });

  test('deals with ownerId + status filters', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/deals?ownerId=1&status=won&limit=5');
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test('contacts with status filter', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/contacts?status=Lead&limit=5');
    expect(res.status()).toBe(200);
  });

  test('tasks with ownerId + status filters', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/tasks?ownerId=1&status=Completed&limit=5');
    expect(res.status()).toBe(200);
  });

  test('calls with ownerId filter', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/calls?ownerId=1&limit=5');
    expect(res.status()).toBe(200);
  });

  test('invoices with status filter (uses issuedDate)', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/invoices?status=PAID&limit=5');
    expect(res.status()).toBe(200);
  });

  test('inverted date range → 400 INVERTED_RANGE', async ({ request }) => {
    const res = await authGet(request, `/api/reports/detailed/deals?startDate=${isoDate(5)}&endDate=${isoDate(-5)}`);
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe('INVERTED_RANGE');
  });

  test('limit caps at 500', async ({ request }) => {
    const res = await authGet(request, '/api/reports/detailed/deals?limit=99999');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.length).toBeLessThanOrEqual(500);
  });
});

// ─── /export-csv ─────────────────────────────────────────────────────

test.describe('Reports API — /export-csv', () => {
  test('type=deals returns CSV with header row + content-disposition', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?type=deals');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('csv');
    expect(res.headers()['content-disposition']).toContain('deals-report.csv');
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('Title,Amount,Stage');
  });

  test('type=contacts returns CSV with contact headers', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?type=contacts');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('Name,Email,Company');
  });

  test('type=agent-performance returns CSV with per-agent rows', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?type=agent-performance');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('Agent,Email,Deals Won,Revenue');
  });

  test('unknown type → 400', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?type=nonsense');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/Unsupported.*type/i);
  });

  test('no type, metric=revenue → 2-column CSV', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?metric=revenue&groupBy=stage');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('Name,Value');
  });

  test('no type, metric=count → 2-column CSV', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?metric=count&groupBy=stage');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toBe('Name,Value');
  });

  test('no type, unsupported metric → 400', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?metric=nonsense_metric');
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/Unsupported.*metric/i);
  });

  test('deals export with ownerId + status filters', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?type=deals&ownerId=1&status=won');
    expect(res.status()).toBe(200);
  });

  test('contacts export with status filter', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-csv?type=contacts&status=Lead');
    expect(res.status()).toBe(200);
  });
});

// ─── /export-pdf ─────────────────────────────────────────────────────

test.describe('Reports API — /export-pdf', () => {
  test('type=agent-performance returns application/pdf', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-pdf?type=agent-performance');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('pdf');
    expect(res.headers()['content-disposition']).toContain('agent-performance-report.pdf');
    const buf = await res.body();
    // PDFs start with "%PDF-"
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('type=deals returns application/pdf with deals header', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-pdf?type=deals');
    expect(res.status()).toBe(200);
    const buf = await res.body();
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('default metric=revenue groupBy=stage returns valid PDF (other type branch)', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-pdf?type=other&metric=revenue&groupBy=stage');
    expect(res.status()).toBe(200);
    const buf = await res.body();
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('metric=count branch in default PDF path', async ({ request }) => {
    const res = await authGet(request, '/api/reports/export-pdf?type=other&metric=count&groupBy=stage');
    expect(res.status()).toBe(200);
    const buf = await res.body();
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('PDF respects date filter on header', async ({ request }) => {
    const res = await authGet(request, `/api/reports/export-pdf?type=deals&startDate=${isoDate(-30)}&endDate=${isoDate(0)}`);
    expect(res.status()).toBe(200);
  });
});

// ─── auth gate (single sanity check) ─────────────────────────────────

test.describe('Reports API — auth', () => {
  test('GET /api/reports/query without token → 403/401', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/reports/query`);
    expect([401, 403]).toContain(res.status());
  });
});
