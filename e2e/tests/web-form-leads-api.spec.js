const { test, expect } = require('@playwright/test');
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
test.describe.configure({ mode: 'serial' });
test('web form leads stay scoped during search and pagination', async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, { data: { email: 'admin@globussoft.com', password: 'password123' } });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const ids = [];
  const tag = `E2E_FORM_LEADS_${Date.now()}_${process.pid}_${test.info().workerIndex}`;
  const leadNames = ['Priya Sharma Alpha', 'Priya Sharma Beta'];
  try {
    for (let i = 0; i < 2; i++) {
      const created = await request.post(`${BASE_URL}/api/forms`, { headers, data: { name: `${tag}_${i}`, fields: [
        { sourceKind: 'contact', sourceKey: 'name', label: 'Name', fieldType: 'text' },
        { sourceKind: 'contact', sourceKey: 'email', label: 'Email', fieldType: 'text' },
      ] } });
      expect(created.status()).toBe(201);
      const form = await created.json();
      ids.push(form.id);
      const submitted = await request.post(`${BASE_URL}/api/forms/public/${form.slug}/submit`, { data: { name: leadNames[i], email: `${tag}_${i}@example.com` } });
      expect(submitted.status(), await submitted.text()).toBe(201);
    }
    const response = await request.get(`${BASE_URL}/api/forms/${ids[0]}/leads?limit=1&search=${tag}`, { headers });
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.total).toBe(1);
    expect(data.leads[0].values[0]).toBe(leadNames[0]);
    expect(data.leads[0].createdAt).toBeTruthy();
    expect(data.leads[0].updatedAt).toBeTruthy();
    const excluded = await request.get(`${BASE_URL}/api/forms/${ids[0]}/leads?search=${tag}_1`, { headers });
    expect((await excluded.json()).total).toBe(0);
    const next = await request.get(`${BASE_URL}/api/forms/${ids[0]}/leads?limit=1&page=2`, { headers });
    expect((await next.json()).leads).toEqual([]);
  } finally {
    for (const id of ids) await request.delete(`${BASE_URL}/api/forms/${id}`, { headers });
  }
});

test('travel Web Forms logo selection has a real multipart upload endpoint', async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'yasin@travelstall.in', password: 'password123' },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();

  const response = await request.post(`${BASE_URL}/api/forms/logo-upload?scope=travel`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: {
      image: {
        name: `E2E_WEB_FORM_LOGO_${Date.now()}_${process.pid}_${test.info().workerIndex}.png`,
        mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
      },
    },
  });

  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json();
  expect(body.url).toBeTruthy();
  expect(['ocs', 's3', 'local']).toContain(body.storage);
  expect(body).toMatchObject({ mimeType: 'image/png' });
});
