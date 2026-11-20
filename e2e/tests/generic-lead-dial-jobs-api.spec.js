const { test, expect } = require('@playwright/test');
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
test.describe.configure({ mode: 'serial' });

test.describe('Generic lead dial queue API (no provider calls)', () => {
  let headers;
  test.beforeAll(async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/auth/login`, { data: { email: 'admin@globussoft.com', password: 'password123' } });
    expect(response.ok()).toBeTruthy();
    headers = { Authorization: `Bearer ${(await response.json()).token}` };
  });
  test('requires authentication', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/callified/dial-jobs`);
    expect([401, 403]).toContain(response.status());
  });
  test('lists bounded persistent runs', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/callified/dial-jobs`, { headers });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(Array.isArray(body.jobs)).toBeTruthy();
    expect(body.jobs.length).toBeLessThanOrEqual(30);
    for (const job of body.jobs) expect(job.audience).toBeUndefined();
    if (body.jobs.length) {
      const details = await request.get(`${BASE_URL}/api/callified/dial-jobs/${body.jobs[0].id}/details`, { headers });
      expect(details.ok()).toBeTruthy();
      expect(await details.json()).toMatchObject({ calls: expect.any(Array), leads: expect.any(Array), hasMore: expect.any(Boolean) });
    }
  });
  test('rejects qualified status before integration or dialing', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/callified/dial-jobs`, { headers, data: { contactIds: [1], statuses: ['qualified'] } });
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe('INVALID_DIAL_JOB');
  });
  test('previews hundreds of selected IDs without placing a call', async ({ request }) => {
    const contactIds = Array.from({ length: 300 }, (_, index) => 2147483000 + index);
    const response = await request.post(`${BASE_URL}/api/callified/dial-jobs/preview`, { headers, data: { contactIds } });
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toEqual({ eligibleIds: [], withPhone: 0, missingPhone: 0, unavailable: 300 });
  });
  test('rejects past schedules and ambiguous audiences', async ({ request }) => {
    for (const data of [
      { contactIds: [1], scheduledAt: new Date(Date.now() - 86_400_000).toISOString() },
      { contactIds: [1], campaignIds: [1] },
    ]) {
      const response = await request.post(`${BASE_URL}/api/callified/dial-jobs`, { headers, data });
      expect(response.status()).toBe(400);
    }
  });
  test('cannot stop or cancel nonexistent resources', async ({ request }) => {
    for (const path of ['2147483647/cancel', 'calls/2147483647/stop']) {
      const response = await request.post(`${BASE_URL}/api/callified/dial-jobs/${path}`, { headers, data: {} });
      expect(response.status()).toBe(404);
    }
  });
});
