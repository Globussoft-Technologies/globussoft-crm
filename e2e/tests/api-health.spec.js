// @ts-check
/**
 * API Health spec — direct HTTP health checks for all backend API endpoints.
 * Validates that endpoints return expected status codes and response shapes.
 *
 * These tests use page.request (Playwright's API testing client) for direct
 * HTTP calls without browser rendering overhead.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

let authToken = null;

/**
 * Helper: get a valid auth token by POSTing to /api/auth/login
 */
async function getAuthToken(request) {
  if (authToken) return authToken;

  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
  });

  if (response.ok()) {
    const data = await response.json();
    authToken = data.token;
  }

  return authToken;
}

/**
 * Helper: make authenticated GET request
 */
async function authGet(request, path) {
  const token = await getAuthToken(request);
  return request.get(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

// ============================================================
// Authentication Endpoints
// ============================================================

test.describe('API Health — Authentication endpoints', () => {
  test('POST /api/auth/login with valid credentials returns 200 and token', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty('token');
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(10);
  });

  test('POST /api/auth/login with invalid credentials returns 401', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: 'wrong@example.com', password: 'wrongpassword' },
      headers: { 'Content-Type': 'application/json' },
    });

    expect(response.status()).toBe(401);
  });

  test('GET /api/auth/users returns list of users', async ({ request }) => {
    const response = await authGet(request, '/api/auth/users');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ============================================================
// Contacts Endpoints
// ============================================================

test.describe('API Health — Contacts endpoints', () => {
  test('GET /api/contacts returns 200 with array', async ({ request }) => {
    const response = await authGet(request, '/api/contacts');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/contacts creates a new contact and returns 200/201', async ({ request }) => {
    const token = await getAuthToken(request);
    const uniqueEmail = `e2e-api-${Date.now()}@example.com`;

    const response = await request.post(`${BASE_URL}/api/contacts`, {
      data: {
        name: `API Test Contact ${Date.now()}`,
        email: uniqueEmail,
        company: 'E2E Corp',
        title: 'Tester',
        status: 'Lead',
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    expect([200, 201]).toContain(response.status());

    const body = await response.json();
    expect(body).toHaveProperty('id');
  });

  test('GET /api/contacts/:id returns a single contact', async ({ request }) => {
    // First get all contacts to find a valid ID
    const listResponse = await authGet(request, '/api/contacts');
    const contacts = await listResponse.json();

    if (contacts.length > 0) {
      const contactId = contacts[0].id;
      const response = await authGet(request, `/api/contacts/${contactId}`);

      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty('id', contactId);
    }
  });

  test('GET /api/contacts/:id returns 404 for non-existent contact', async ({ request }) => {
    const response = await authGet(request, '/api/contacts/nonexistent-id-99999');

    expect([404, 400]).toContain(response.status());
  });
});

// ============================================================
// Deals Endpoints
// ============================================================

test.describe('API Health — Deals endpoints', () => {
  test('GET /api/deals returns 200 with array', async ({ request }) => {
    const response = await authGet(request, '/api/deals');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('POST /api/deals creates a new deal', async ({ request }) => {
    const token = await getAuthToken(request);

    const response = await request.post(`${BASE_URL}/api/deals`, {
      data: {
        title: `API Test Deal ${Date.now()}`,
        company: 'E2E Corp',
        amount: 10000,
        probability: 75,
        stage: 'lead',
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    expect([200, 201]).toContain(response.status());

    const body = await response.json();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('stage', 'lead');
  });
});

// ============================================================
// Billing Endpoints
// ============================================================

test.describe('API Health — Billing endpoints', () => {
  test('GET /api/billing returns 200 with array', async ({ request }) => {
    const response = await authGet(request, '/api/billing');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ============================================================
// Developer Endpoints
// ============================================================

test.describe('API Health — Developer endpoints', () => {
  test('GET /api/developer/apikeys returns 200 with array', async ({ request }) => {
    const response = await authGet(request, '/api/developer/apikeys');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('GET /api/developer/webhooks returns 200 with array', async ({ request }) => {
    const response = await authGet(request, '/api/developer/webhooks');

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });
});

// ============================================================
// Marketing Endpoints
// ============================================================

test.describe('API Health — Marketing endpoints', () => {
  test('GET /api/campaigns returns 200', async ({ request }) => {
    const response = await authGet(request, '/api/campaigns');

    // Accept 200 or 404 (endpoint may not exist yet)
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });
});

// ============================================================
// Unauthenticated access
// ============================================================

test.describe('API Health — Unauthenticated access protection', () => {
  const PROTECTED_ENDPOINTS = [
    '/api/contacts',
    '/api/deals',
    '/api/billing',
    '/api/developer/apikeys',
    '/api/auth/users',
  ];

  for (const endpoint of PROTECTED_ENDPOINTS) {
    test(`GET ${endpoint} returns 401 without auth token`, async ({ request }) => {
      const response = await request.get(`${BASE_URL}${endpoint}`, {
        headers: { 'Content-Type': 'application/json' },
      });

      // Should reject unauthenticated requests
      expect([401, 403]).toContain(response.status());
    });
  }
});

// ============================================================
// Response shape validation
// ============================================================

test.describe('API Health — Response shape validation', () => {
  test('contact object has expected fields', async ({ request }) => {
    const response = await authGet(request, '/api/contacts');
    const contacts = await response.json();

    if (contacts.length > 0) {
      const contact = contacts[0];
      expect(contact).toHaveProperty('id');
      expect(contact).toHaveProperty('name');
      expect(contact).toHaveProperty('email');
    }
  });

  test('deal object has expected fields', async ({ request }) => {
    const response = await authGet(request, '/api/deals');
    const deals = await response.json();

    if (deals.length > 0) {
      const deal = deals[0];
      expect(deal).toHaveProperty('id');
      expect(deal).toHaveProperty('title');
      expect(deal).toHaveProperty('stage');
      expect(deal).toHaveProperty('amount');
    }
  });

  test('invoice object has expected fields', async ({ request }) => {
    const response = await authGet(request, '/api/billing');
    const invoices = await response.json();

    if (invoices.length > 0) {
      const invoice = invoices[0];
      expect(invoice).toHaveProperty('id');
      expect(invoice).toHaveProperty('amount');
    }
  });

  test('user object has expected fields (no password hash exposed)', async ({ request }) => {
    const response = await authGet(request, '/api/auth/users');
    const users = await response.json();

    if (users.length > 0) {
      const user = users[0];
      expect(user).toHaveProperty('id');
      expect(user).toHaveProperty('email');
      expect(user).toHaveProperty('role');

      // Password hash must NOT be returned in the API response
      expect(user).not.toHaveProperty('password');
      expect(user).not.toHaveProperty('passwordHash');
      expect(user).not.toHaveProperty('password_hash');
    }
  });
});
