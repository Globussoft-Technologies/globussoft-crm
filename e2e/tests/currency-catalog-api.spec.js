// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

test('currency catalog requires authentication', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/currencies/catalog`);
  expect([401, 403]).toContain(response.status());
});
