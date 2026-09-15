// Gate coverage for the TMC parent review endpoints. The full parent happy
// path is covered by backend route tests because CI's travel seed does not
// create a parent portal account; these checks pin the public auth boundary.

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

test.describe('TMC parent reviews API — auth boundary', () => {
  test('review list requires a portal token', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/portal/tmc/parent/reviews`);
    expect(response.status()).toBe(401);
  });

  test('review submission requires a portal token', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/portal/tmc/parent/trips/7/review`, {
      data: { answers: { rating: 5, experience: 'Excellent trip.' } },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);
  });
});
