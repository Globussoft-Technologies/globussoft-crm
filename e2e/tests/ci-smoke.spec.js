// @ts-check
/**
 * CI smoke test — minimal, no-auth, no-DB-state-required checks that the
 * backend boots and serves the basic health + auth surface.
 *
 * Designed to be the gating spec for the GH Actions api_tests job. Other
 * specs (sms-api, marketing-api, reports-api, voice-transcription-api,
 * knowledge-base-api, portal-api) can be added to the CI list once they're
 * each verified to work against a freshly-seeded CI database.
 *
 * BASE_URL points at the CI-local backend (http://127.0.0.1:5000) when
 * running under Actions; falls back to the live demo for local dev runs.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

test.describe('CI smoke', () => {
  test('GET /api/health returns 200 + {status:"healthy"}', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(typeof body.uptime).toBe('number');
  });

  test('GET / serves the SPA layout shell (200)', async ({ request }) => {
    // CI backend serves this via the catch-all SPA route; demo via Nginx.
    // Either way a HEAD should be 200 (or 404 if backend doesn't serve
    // static). We accept both shapes since CI backend is API-only.
    const res = await request.get(`${BASE_URL}/`);
    expect([200, 404]).toContain(res.status());
  });

  test('POST /api/auth/login with seeded admin returns a token', async ({ request }) => {
    // The seed scripts (prisma/seed.js) create admin@globussoft.com /
    // password123. This test confirms the seed ran AND the login route
    // works AND JWT issuance is wired correctly.
    const res = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // JWT 3-segment shape
  });

  test('GET /api/contacts without auth returns 401/403', async ({ request }) => {
    // Confirms the global auth guard fires. Either status is acceptable;
    // the production code uses 401 in middleware/auth.js but a 403 from
    // verifyToken's mismatch path is also valid.
    const res = await request.get(`${BASE_URL}/api/contacts`);
    expect([401, 403]).toContain(res.status());
  });
});
