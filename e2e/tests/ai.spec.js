// @ts-check
/**
 * AI assistance route smoke (`/api/ai`)
 *  - POST /draft (email body draft, falls back to template if no Gemini key)
 *  - POST /reply (reply suggestion)
 *  - POST /subject-lines (subject line suggestions)
 *
 * The route either calls Gemini OR returns a deterministic template fallback,
 * so any successful 200 with { draft } is acceptable. We assert validation
 * gates (missing context) and shape.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const ADMIN_EMAIL = 'admin@globussoft.com';
const ADMIN_PASSWORD = 'password123';

let adminToken = '';

test.describe.configure({ mode: 'serial' });

test.describe('AI assistance — /api/ai', () => {
  test.beforeAll(async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok(), 'admin login must succeed').toBeTruthy();
    const body = await login.json();
    adminToken = body.token;
    expect(adminToken).toBeTruthy();
  });

  const auth = () => ({ Authorization: `Bearer ${adminToken}` });

  test('auth gate — POST /draft without token returns 401/403', async ({ request }) => {
    const res = await request.post(`${API}/ai/draft`, { data: { context: 'hi' } });
    expect([401, 403]).toContain(res.status());
  });

  test('POST /draft rejects missing context with 400', async ({ request }) => {
    const res = await request.post(`${API}/ai/draft`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/subject|context/i);
  });

  test('POST /draft returns a draft body for valid context', async ({ request }) => {
    const res = await request.post(`${API}/ai/draft`, {
      headers: auth(),
      data: { context: 'follow up about quarterly review with Priya Sharma', tone: 'professional' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.draft).toBe('string');
    expect(body.draft.length).toBeGreaterThan(20);
    expect(body.model).toBeTruthy();
  });

  test('POST /reply rejects missing originalEmail with 400', async ({ request }) => {
    const res = await request.post(`${API}/ai/reply`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email|original/i);
  });

  test('POST /reply returns a reply draft for valid input', async ({ request }) => {
    const res = await request.post(`${API}/ai/reply`, {
      headers: auth(),
      data: { originalEmail: 'Hi, can we reschedule our call to Friday at 3 PM?', tone: 'professional' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.draft).toBe('string');
    expect(body.draft.length).toBeGreaterThan(10);
  });

  test('POST /subject-lines rejects missing context with 400', async ({ request }) => {
    const res = await request.post(`${API}/ai/subject-lines`, {
      headers: auth(),
      data: {},
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/context/i);
  });

  test('POST /subject-lines returns an array of subjects', async ({ request }) => {
    const res = await request.post(`${API}/ai/subject-lines`, {
      headers: auth(),
      data: { context: 'monthly product update for Arjun Patel', count: 3 },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.subjects)).toBe(true);
    expect(body.subjects.length).toBeGreaterThan(0);
  });
});
