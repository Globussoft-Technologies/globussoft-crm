// Generic CRM Leads assistant API contract. These checks intentionally avoid
// provider spend: they pin auth, vertical isolation, and request validation.
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

async function loginAs(request, email, password) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok()) return null;
  return (await response.json()).token;
}

test('Leads assistant requires authentication', async ({ request }) => {
  const response = await request.post(`${BASE_URL}/api/leads-assistant/message`, {
    data: { message: 'show my leads' },
  });
  expect(response.status()).toBe(401);
});

test('Leads assistant validates the message envelope for Generic CRM', async ({ request }) => {
  const token = await loginAs(request, 'admin@globussoft.com', 'password123');
  test.skip(!token, 'Generic CRM demo credentials are unavailable in this environment');
  const response = await request.post(`${BASE_URL}/api/leads-assistant/message`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message: '  ' },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('MISSING_MESSAGE');
});

test('Leads assistant is isolated from Wellness tenants', async ({ request }) => {
  const token = await loginAs(request, 'admin@wellness.demo', 'password123');
  test.skip(!token, 'Wellness demo credentials are unavailable in this environment');
  const response = await request.post(`${BASE_URL}/api/leads-assistant/message`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { message: 'show my leads' },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).code).toBe('GENERIC_TENANT_REQUIRED');
});

test('confirmed deal moves reject unknown pipelines and normalize Won probability', async ({ request }) => {
  const token = await loginAs(request, 'admin@globussoft.com', 'password123');
  test.skip(!token, 'Generic CRM demo credentials are unavailable in this environment');
  const headers = { Authorization: `Bearer ${token}` };
  const marker = `assistant-${process.pid}-${test.info().workerIndex}-${Date.now()}`;
  let contactId;
  let dealId;
  try {
    const contact = await request.post(`${BASE_URL}/api/contacts`, {
      headers, data: { name: marker, email: `${marker}@example.com`, status: 'Lead' },
    });
    expect(contact.ok()).toBe(true);
    contactId = (await contact.json()).id;
    const created = await request.post(`${BASE_URL}/api/deals`, {
      headers, data: { title: marker, contactId, stage: 'proposal', amount: 100, probability: 50 },
    });
    expect(created.ok()).toBe(true);
    dealId = (await created.json()).id;

    const denied = await request.post(`${BASE_URL}/api/leads-assistant/confirm`, {
      headers, data: { action: { type: 'move_deal_stage', dealId, stage: 'won', pipelineId: 2147483647 } },
    });
    expect(denied.status()).toBe(404);
    expect((await denied.json()).code).toBe('PIPELINE_NOT_FOUND');
    const before = await request.get(`${BASE_URL}/api/deals/${dealId}`, { headers });
    expect(before.ok()).toBe(true);
    expect(await before.json()).toMatchObject({ stage: 'proposal', probability: 50 });

    const moved = await request.post(`${BASE_URL}/api/leads-assistant/confirm`, {
      headers, data: { action: { type: 'move_deal_stage', dealId, stage: 'won' } },
    });
    expect(moved.ok()).toBe(true);
    const after = await request.get(`${BASE_URL}/api/deals/${dealId}`, { headers });
    expect(after.ok()).toBe(true);
    expect(await after.json()).toMatchObject({ stage: 'won', probability: 100 });
  } finally {
    if (dealId) await request.delete(`${BASE_URL}/api/deals/${dealId}`, { headers });
    if (contactId) await request.delete(`${BASE_URL}/api/contacts/${contactId}`, { headers });
  }
});
