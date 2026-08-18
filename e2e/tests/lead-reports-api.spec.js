// @ts-check
/**
 * Lead Reports cluster — API coverage (backend/routes/lead_reports.js).
 *
 * The seven generic-vertical reporting surfaces behind /api/lead-reports:
 *
 *   GET  /api/lead-reports/productivity          daily / weekly / monthly
 *   GET  /api/lead-reports/lead-quality          score bands + qualification
 *   GET  /api/lead-reports/follow-up-tracking    overdue / SLA / stale leads
 *   GET  /api/lead-reports/source-analysis       per-source conversion
 *   GET  /api/lead-reports/stages                funnel-builder config (read)
 *   PUT  /api/lead-reports/stages                funnel-builder config (write, ADMIN)
 *   GET  /api/lead-reports/stage-funnel          lead-stage funnel
 *   GET  /api/lead-reports/visits                meetings & site visits
 *   GET  /api/lead-reports/visit-done-not-booked recovery queue
 *
 * What this spec pins:
 *   - Auth: unauthenticated requests are rejected on every endpoint.
 *   - RBAC: the whole router is ADMIN/MANAGER; a plain USER gets 403.
 *           PUT /stages narrows further to ADMIN — MANAGER gets 403.
 *   - Response shape: each report returns its documented top-level keys, so a
 *     future refactor can't silently drop a section the UI renders.
 *   - Validation: an inverted date range returns 400 INVERTED_RANGE rather
 *     than silently reporting on a nonsense window; a malformed stage config
 *     returns 400 with a machine-readable code rather than persisting.
 *   - Round trip: PUT /stages then GET /stages returns the saved config, and
 *     the funnel recomputes against it. The spec restores the tenant's prior
 *     config in afterAll so it doesn't leave the demo tenant reconfigured.
 *   - Visits: creating a Task with type "Site Visit" makes it appear in the
 *     visits report — the contract that connects the Task Queue to the report.
 *
 * Assertions are demo-state-aware: they check shape, ordering invariants and
 * arithmetic identities (e.g. rates are 0-100) rather than absolute counts,
 * which drift as the demo tenant accumulates data.
 */
const { test, expect } = require('@playwright/test');

// The stage-config tests mutate a tenant-level setting that every other test
// in this file reads. Pin to serial so a parallel shuffle can't interleave a
// funnel read between the write and the restore.
test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_LEADRPT_${Date.now()}`;

let adminToken = null;
let managerToken = null;
let userToken = null;
let savedStages = null;
let savedWasCustom = false;
const createdTaskIds = [];

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token, userId: j.user.id };
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// The Cloudflare-fronted demo occasionally surfaces transient 5xx during
// origin restarts. Retry those; 4xx bails immediately so genuine RBAC or
// validator regressions still surface.
async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  return r;
}

const get = (request, token, path) =>
  retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
const put = (request, token, path, body) =>
  retryOn5xx(() => request.put(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));
const post = (request, token, path, body) =>
  retryOn5xx(() => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }));

const REPORT_PATHS = [
  '/api/lead-reports/productivity',
  '/api/lead-reports/lead-quality',
  '/api/lead-reports/follow-up-tracking',
  '/api/lead-reports/source-analysis',
  '/api/lead-reports/stage-funnel',
  '/api/lead-reports/visits',
  '/api/lead-reports/visit-done-not-booked',
  '/api/lead-reports/stages',
];

test.beforeAll(async ({ request }) => {
  adminToken = (await loginAs(request, 'admin@globussoft.com', 'password123')).token;
  managerToken = (await loginAs(request, 'manager@crm.com', 'password123')).token;
  userToken = (await loginAs(request, 'user@crm.com', 'password123')).token;

  // Snapshot the tenant's stage config so the PUT tests can restore it.
  if (adminToken) {
    const r = await get(request, adminToken, '/api/lead-reports/stages');
    if (r.ok()) {
      const j = await r.json();
      savedStages = j.stages;
      savedWasCustom = Boolean(j.isCustom);
    }
  }
});

test.afterAll(async ({ request }) => {
  if (adminToken && savedWasCustom && Array.isArray(savedStages)) {
    await put(request, adminToken, '/api/lead-reports/stages', { stages: savedStages });
  }
  for (const id of createdTaskIds) {
    await retryOn5xx(() =>
      request.delete(`${BASE_URL}/api/tasks/${id}`, { headers: headers(adminToken), timeout: REQUEST_TIMEOUT }));
  }
});

test.describe('Lead Reports — auth + RBAC', () => {
  for (const path of REPORT_PATHS) {
    test(`rejects an unauthenticated GET ${path}`, async ({ request }) => {
      const r = await retryOn5xx(() => request.get(`${BASE_URL}${path}`, { timeout: REQUEST_TIMEOUT }));
      expect(r.status()).toBeGreaterThanOrEqual(401);
      expect(r.status()).toBeLessThan(404);
    });
  }

  test('a plain USER is refused — the cluster is a manager oversight surface', async ({ request }) => {
    test.skip(!userToken, 'user@crm.com login unavailable');
    const r = await get(request, userToken, '/api/lead-reports/productivity');
    expect(r.status()).toBe(403);
  });

  test('a MANAGER may read the reports', async ({ request }) => {
    test.skip(!managerToken, 'manager@crm.com login unavailable');
    const r = await get(request, managerToken, '/api/lead-reports/lead-quality');
    expect(r.status()).toBe(200);
  });

  test('a MANAGER may NOT rewrite the funnel stage config — that is ADMIN-only', async ({ request }) => {
    test.skip(!managerToken, 'manager@crm.com login unavailable');
    const r = await put(request, managerToken, '/api/lead-reports/stages', {
      stages: [{ key: 'new', label: 'New', statuses: ['Lead'] }],
    });
    expect(r.status()).toBe(403);
  });
});

test.describe('Lead Reports — productivity', () => {
  test('returns a gap-free bucketed series plus per-user totals', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/productivity?period=daily&from=2026-01-01&to=2026-01-07');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.period).toBe('daily');
    expect(Array.isArray(j.series)).toBe(true);
    // Seven inclusive days — empty days are reported as zero rows, not dropped.
    expect(j.series).toHaveLength(7);
    expect(j.series[0]).toHaveProperty('label');
    expect(j.series[0]).toHaveProperty('leadsCreated');
    expect(Array.isArray(j.byUser)).toBe(true);
    expect(Array.isArray(j.users)).toBe(true);
    expect(j.totals).toHaveProperty('calls');
    expect(j.totals).toHaveProperty('revenue');
  });

  test('monthly period buckets by calendar month', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/productivity?period=monthly&from=2026-01-01&to=2026-03-31');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.period).toBe('monthly');
    expect(j.series.map((b) => b.key)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  test('an inverted date range is a 400, not a silently empty report', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/productivity?from=2026-03-01&to=2026-01-01');
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe('INVERTED_RANGE');
  });
});

test.describe('Lead Reports — lead quality', () => {
  test('returns totals, score bands, and per-source / per-owner breakdowns', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/lead-quality');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.totals).toHaveProperty('totalLeads');
    expect(j.totals).toHaveProperty('qualificationRate');
    expect(Array.isArray(j.scoreBands)).toBe(true);
    expect(j.scoreBands.map((b) => b.band)).toEqual(['0-20', '21-40', '41-60', '61-80', '81-100']);
    expect(Array.isArray(j.bySource)).toBe(true);
    expect(Array.isArray(j.byOwner)).toBe(true);
  });

  test('every rate is a sane 0-100 percentage', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/lead-quality');
    const j = await r.json();
    for (const key of ['qualificationRate', 'junkRate', 'conversionRate']) {
      expect(j.totals[key]).toBeGreaterThanOrEqual(0);
      expect(j.totals[key]).toBeLessThanOrEqual(100);
    }
  });
});

test.describe('Lead Reports — follow-up tracking', () => {
  test('returns the summary counters and the three work queues', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/follow-up-tracking');
    expect(r.status()).toBe(200);
    const j = await r.json();
    for (const key of ['openFollowUps', 'overdue', 'dueToday', 'upcoming', 'awaitingFirstResponse', 'staleLeads']) {
      expect(j.summary).toHaveProperty(key);
    }
    expect(Array.isArray(j.overdue)).toBe(true);
    expect(Array.isArray(j.awaitingFirstResponse)).toBe(true);
    expect(Array.isArray(j.stale)).toBe(true);
    expect(Array.isArray(j.byOwner)).toBe(true);
  });

  test('the open-follow-up counter equals the sum of its state buckets', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/follow-up-tracking');
    const j = await r.json();
    const s = j.summary;
    expect(s.overdue + s.dueToday + s.upcoming + s.undated).toBe(s.openFollowUps);
  });

  test('?staleDays is honoured', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/follow-up-tracking?staleDays=30');
    expect(r.status()).toBe(200);
    expect((await r.json()).summary.staleDays).toBe(30);
  });
});

test.describe('Lead Reports — source analysis', () => {
  test('returns per-source rows sorted by lead volume', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/source-analysis');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.sources)).toBe(true);
    expect(Array.isArray(j.firstTouch)).toBe(true);
    expect(Array.isArray(j.lastTouch)).toBe(true);
    expect(j.totals).toHaveProperty('sourceCount');
    for (let i = 1; i < j.sources.length; i++) {
      expect(j.sources[i - 1].leads).toBeGreaterThanOrEqual(j.sources[i].leads);
    }
  });
});

test.describe('Lead Reports — funnel builder', () => {
  test('GET /stages returns the active config plus the shipped defaults', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/stages');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.stages)).toBe(true);
    expect(j.stages.length).toBeGreaterThan(0);
    expect(Array.isArray(j.defaults)).toBe(true);
    expect(j.stages[0]).toHaveProperty('key');
    expect(j.stages[0]).toHaveProperty('label');
  });

  test('rejects an empty stage list', async ({ request }) => {
    const r = await put(request, adminToken, '/api/lead-reports/stages', { stages: [] });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_STAGES');
  });

  test('rejects a stage with no match rule', async ({ request }) => {
    const r = await put(request, adminToken, '/api/lead-reports/stages', {
      stages: [{ key: 'x', label: 'Nameless rule' }],
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('EMPTY_STAGE_RULE');
  });

  test('rejects duplicate stage keys', async ({ request }) => {
    const r = await put(request, adminToken, '/api/lead-reports/stages', {
      stages: [
        { key: 'new', label: 'New', statuses: ['Lead'] },
        { key: 'new', label: 'Also New', statuses: ['Prospect'] },
      ],
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('DUPLICATE_STAGE_KEY');
  });

  test('a saved config round-trips and drives the funnel', async ({ request }) => {
    const custom = [
      { key: `${RUN_TAG.toLowerCase().replace(/[^a-z0-9_-]/g, '')}_new`, label: 'Fresh', statuses: ['Lead'] },
      { key: 'won', label: 'Closed', statuses: ['Customer'] },
      { key: 'dead', label: 'Dead', callStatuses: ['junk'], leak: true },
    ];
    const w = await put(request, adminToken, '/api/lead-reports/stages', { stages: custom });
    expect(w.status()).toBe(200);
    expect((await w.json()).stages).toHaveLength(3);

    const r = await get(request, adminToken, '/api/lead-reports/stages');
    const j = await r.json();
    expect(j.isCustom).toBe(true);
    expect(j.stages.map((s) => s.label)).toEqual(['Fresh', 'Closed', 'Dead']);

    const f = await get(request, adminToken, '/api/lead-reports/stage-funnel');
    expect(f.status()).toBe(200);
    const fj = await f.json();
    // Only the two non-leak stages form the conversion ladder; the leak is
    // reported alongside it.
    expect(fj.stages.map((s) => s.label)).toEqual(['Fresh', 'Closed']);
    expect(fj.leaks.map((s) => s.label)).toEqual(['Dead']);
    // The last flow stage has nothing to convert into.
    expect(fj.stages[fj.stages.length - 1].conversionToNext).toBeNull();
    expect(fj.totals).toHaveProperty('unclassified');
  });
});

test.describe('Lead Reports — meetings & site visits', () => {
  test('returns the scoped window with a summary and per-owner rollup', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/visits?scope=week');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(j.scope).toBe('week');
    expect(Array.isArray(j.visits)).toBe(true);
    expect(Array.isArray(j.byOwner)).toBe(true);
    expect(j.summary).toHaveProperty('scheduled');
    expect(j.summary).toHaveProperty('bookingRate');
  });

  test('a Task created with type "Site Visit" shows up in the report', async ({ request }) => {
    const dueDate = new Date(Date.now() + 2 * 3600_000).toISOString();
    const c = await post(request, adminToken, '/api/tasks', {
      title: `${RUN_TAG} plot walkthrough`,
      type: 'Site Visit',
      priority: 'High',
      dueDate,
    });
    expect(c.status()).toBe(201);
    const created = await c.json();
    createdTaskIds.push(created.id);
    expect(created.type).toBe('Site Visit');

    const r = await get(request, adminToken, '/api/lead-reports/visits?scope=today');
    expect(r.status()).toBe(200);
    const j = await r.json();
    const mine = j.visits.find((v) => v.taskId === created.id);
    expect(mine).toBeTruthy();
    expect(mine.visitType).toBe('Site Visit');
    // Not completed yet → outcome defaults to pending, not booked.
    expect(mine.outcome).toBe('pending');
  });

  test('rejects an unknown task type rather than storing it', async ({ request }) => {
    const r = await post(request, adminToken, '/api/tasks', {
      title: `${RUN_TAG} bad type`,
      type: 'Teleportation',
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_TASK_TYPE');
  });

  test('rejects an unknown visit outcome', async ({ request }) => {
    const r = await post(request, adminToken, '/api/tasks', {
      title: `${RUN_TAG} bad outcome`,
      type: 'Site Visit',
      outcome: 'vibes',
    });
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe('INVALID_TASK_OUTCOME');
  });

  test('a task created without type/outcome still works — the columns are optional', async ({ request }) => {
    const r = await post(request, adminToken, '/api/tasks', { title: `${RUN_TAG} plain task` });
    expect(r.status()).toBe(201);
    const j = await r.json();
    createdTaskIds.push(j.id);
    expect(j.type).toBeNull();
    expect(j.outcome).toBeNull();
  });
});

test.describe('Lead Reports — visited but not booked', () => {
  test('returns the recovery queue with nurture coverage', async ({ request }) => {
    const r = await get(request, adminToken, '/api/lead-reports/visit-done-not-booked');
    expect(r.status()).toBe(200);
    const j = await r.json();
    expect(Array.isArray(j.leads)).toBe(true);
    expect(Array.isArray(j.byOwner)).toBe(true);
    for (const key of ['visitsDone', 'booked', 'notBooked', 'inNurture', 'notNurtured', 'bookingRate']) {
      expect(j.summary).toHaveProperty(key);
    }
    // booked + notBooked partitions the completed visits exactly.
    expect(j.summary.booked + j.summary.notBooked).toBe(j.summary.visitsDone);
    // Nobody in the list is booked — the queue is the not-booked half only.
    for (const lead of j.leads) {
      expect(lead.visitOutcome).not.toBe('booked');
      expect(lead).toHaveProperty('daysSinceVisit');
      expect(lead).toHaveProperty('inNurture');
    }
  });
});
