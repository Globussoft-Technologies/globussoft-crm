// @ts-check
/**
 * API gate for the itinerary cover + editable HTML-template routes added in
 * PR #1402. Deep persistence/rendering behavior is pinned by backend unit
 * tests; this spec ensures the deployed Express routes, auth, travel guard,
 * multipart parser, and validation envelopes remain wired together.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
let token;

test.beforeAll(async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'yasin@travelstall.in', password: 'password123' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(200);
  token = (await response.json()).token;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

test('cover upload requires authentication', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/travel/itineraries/1/cover-image`, {
    multipart: {
      file: {
        name: 'cover.png',
        mimeType: 'image/png',
        buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
      },
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(401);
});

test('cover upload rejects spoofed image bytes', async ({ request }) => {
  // A real itinerary id is deliberately unnecessary: multer/content
  // validation executes before the row lookup and must reject the payload.
  const response = await request.post(`${BASE_URL}/api/travel/itineraries/1/cover-image`, {
    headers: auth(),
    multipart: {
      file: {
        name: 'cover.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from('<script>alert(1)</script>'),
      },
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('INVALID_IMAGE_CONTENT');
});

for (const entry of [
  ['GET', '/api/travel/itinerary-templates/not-a-number/html-template'],
  ['POST', '/api/travel/itinerary-templates/not-a-number/propose-html-template'],
  ['PUT', '/api/travel/itinerary-templates/not-a-number/html-template'],
  ['DELETE', '/api/travel/itinerary-templates/not-a-number/html-template'],
]) {
  const [method, route] = entry;
  test(`${method} ${route} returns canonical invalid-id response`, async ({ request }) => {
    const response = await request.fetch(`${BASE_URL}${route}`, {
      method,
      headers: { ...auth(), 'Content-Type': 'application/json' },
      data: method === 'PUT' ? { pages: [] } : {},
      timeout: REQUEST_TIMEOUT,
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).code).toBe('INVALID_ID');
  });
}

test('itinerary template-schema route is authenticated', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/travel/itineraries/1/template-schema`, {
    timeout: REQUEST_TIMEOUT,
  });
  expect(response.status()).toBe(401);
});
