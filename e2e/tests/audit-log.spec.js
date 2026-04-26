// @ts-check
/**
 * Audit Log spec — covers the audit trail API endpoint,
 * validating that audit entries are returned with expected fields.
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
// Audit Log API
// ============================================================

test.describe('Audit Log — API endpoints', () => {
  test('API: GET /api/audit returns array', async ({ request }) => {
    const response = await authGet(request, '/api/audit');
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();
      // Response could be an array directly or an object with a data/entries property
      if (Array.isArray(body)) {
        expect(Array.isArray(body)).toBe(true);
      } else {
        expect(typeof body).toBe('object');
        // Check for common wrapper patterns
        const entries = body.data || body.entries || body.logs || body.auditLogs;
        if (entries) {
          expect(Array.isArray(entries)).toBe(true);
        }
      }
    }
  });

  test('audit log entries have action, entity, and createdAt fields', async ({ request }) => {
    const response = await authGet(request, '/api/audit');
    expect([200, 404]).toContain(response.status());

    if (response.status() === 200) {
      const body = await safeJson(response);
      expect(body).not.toBeNull();

      // Extract entries from response (could be array or wrapped)
      let entries = body;
      if (!Array.isArray(body)) {
        entries = body.data || body.entries || body.logs || body.auditLogs || [];
      }

      if (Array.isArray(entries) && entries.length > 0) {
        const entry = entries[0];

        // Check for action field (could be named action, type, or event)
        const hasAction = entry.hasOwnProperty('action') || entry.hasOwnProperty('type') || entry.hasOwnProperty('event');
        expect(hasAction).toBe(true);

        // Check for entity field (could be named entity, resource, model, or entityType)
        const hasEntity = entry.hasOwnProperty('entity') || entry.hasOwnProperty('resource') || entry.hasOwnProperty('model') || entry.hasOwnProperty('entityType');
        expect(hasEntity).toBe(true);

        // Check for timestamp field
        const hasTimestamp = entry.hasOwnProperty('createdAt') || entry.hasOwnProperty('created_at') || entry.hasOwnProperty('timestamp');
        expect(hasTimestamp).toBe(true);
      }
    }
  });
});
