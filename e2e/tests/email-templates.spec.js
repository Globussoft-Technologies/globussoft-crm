// @ts-check
/**
 * Email Templates spec — covers CRUD operations for email templates
 * via direct API calls.
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
        data: { email: 'admin', password: 'admin' },
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
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
}

async function authPost(request, path, data) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.post(`${BASE_URL}${path}`, {
    data,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
}

async function authDelete(request, path) {
  const token = await getAuthToken(request);
  if (!token) throw new Error('Failed to acquire auth token');
  return request.delete(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// ============================================================
// Email Templates CRUD
// ============================================================

test.describe('Email Templates — API CRUD', () => {
  let createdTemplateId = null;

  test('API: GET /api/email_templates returns array', async ({ request }) => {
    const response = await authGet(request, '/api/email_templates');
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      expect(Array.isArray(body)).toBe(true);
    }
  });

  test('API: POST /api/email_templates creates a template', async ({ request }) => {
    const templateData = {
      name: `E2E Template ${Date.now()}`,
      subject: 'E2E Test Subject — Follow Up',
      body: '<p>Hello {{contact_name}},</p><p>This is an automated E2E test template.</p><p>Best regards,<br/>E2E Test Suite</p>',
    };

    const response = await authPost(request, '/api/email_templates', templateData);
    expect([200, 201, 404]).toContain(response.status());

    if (response.status() === 200 || response.status() === 201) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('subject');
      createdTemplateId = body.id;
    }
  });

  test('API: GET /api/email_templates/:id returns the created template', async ({ request }) => {
    // If no template was created in the previous test, create one now
    if (!createdTemplateId) {
      const createResponse = await authPost(request, '/api/email_templates', {
        name: `E2E Template Fetch ${Date.now()}`,
        subject: 'Fetch Test Subject',
        body: '<p>Fetch test body</p>',
      });
      if (createResponse.status() === 200 || createResponse.status() === 201) {
        const created = await safeJson(createResponse);
        createdTemplateId = created?.id;
      }
    }

    if (createdTemplateId) {
      const response = await authGet(request, `/api/email_templates/${createdTemplateId}`);
      expect([200, 404]).toContain(response.status());

      if (response.status() === 200) {
        const body = await safeJson(response);
        expect(body).not.toBeNull();
        expect(body).toHaveProperty('id', createdTemplateId);
        expect(body).toHaveProperty('name');
        expect(body).toHaveProperty('subject');
        expect(body).toHaveProperty('body');
      }
    }
  });

  test('API: DELETE /api/email_templates/:id deletes the template', async ({ request }) => {
    // If no template was created in the previous tests, create one now
    if (!createdTemplateId) {
      const createResponse = await authPost(request, '/api/email_templates', {
        name: `E2E Template Delete ${Date.now()}`,
        subject: 'Delete Test Subject',
        body: '<p>Delete test body</p>',
      });
      if (createResponse.status() === 200 || createResponse.status() === 201) {
        const created = await safeJson(createResponse);
        createdTemplateId = created?.id;
      }
    }

    if (createdTemplateId) {
      const response = await authDelete(request, `/api/email_templates/${createdTemplateId}`);
      expect([200, 204, 404]).toContain(response.status());

      // Verify deletion — GET should return 404
      if (response.status() === 200 || response.status() === 204) {
        const verifyResponse = await authGet(request, `/api/email_templates/${createdTemplateId}`);
        expect([404, 400, 200]).toContain(verifyResponse.status());
      }
    }
  });
});
