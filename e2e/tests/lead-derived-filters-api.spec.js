const { test, expect } = require('@playwright/test');
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

test('Generic derived filters separate names and use only tracking metadata', async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, { data: { email: 'admin@globussoft.com', password: 'password123' } });
  expect(login.ok()).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const tag = `DERIVED_${Date.now()}_${process.pid}_${test.info().workerIndex}`;
  // Preserve the timestamp/process/worker discriminator using letters only:
  // Generic contact names intentionally reject digits and underscores.
  const nameToken = tag.replace(/\d/g, (digit) => String.fromCharCode(97 + Number(digit))).replace(/_/g, '');
  expect(nameToken).toMatch(/^[A-Za-z]+$/);
  const contacts = [];
  let formId;
  try {
    const created = await request.post(`${BASE_URL}/api/forms`, { headers, data: {
      name: tag, fields: [
        { sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name' },
        { sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email' },
        { sourceKind: 'contact', sourceKey: 'company', fieldType: 'text', label: 'Company' },
        { sourceKind: 'custom', sourceKey: 'utm_source', fieldType: 'text', label: 'Unrelated value' },
      ],
    } });
    expect(created.status()).toBe(201);
    const form = await created.json();
    formId = form.id;
    for (const [index, name, tracking] of [
      [0, `John ${nameToken}`, { utm_source: tag }],
      [1, 'Alice John', { utm_source: '' }],
      [2, nameToken, {}],
    ]) {
      const submitted = await request.post(`${BASE_URL}/api/forms/public/${form.slug}/submit`, {
        headers: { 'x-gbs-tracking': JSON.stringify(tracking) },
        data: { name, email: `${tag}_${index}@example.com`, company: tag, utm_source: tag },
      });
      expect(submitted.status(), await submitted.text()).toBe(201);
      contacts.push((await submitted.json()).contactId);
    }
    const matches = async (field, operator, values) => {
      const filters = encodeURIComponent(JSON.stringify([{ field, operator, values }]));
      const response = await request.get(`${BASE_URL}/api/contacts?status=Lead&q=${tag}&filters=${filters}`, { headers });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()).map((row) => row.id).sort((a, b) => a - b);
    };
    expect(await matches('firstName', 'contains', ['John'])).toEqual([contacts[0]]);
    expect(await matches('lastName', 'contains', ['John'])).toEqual([contacts[1]]);
    expect(await matches('lastName', 'is_empty', [])).toEqual([contacts[2]]);
    expect(await matches('utm_source', 'contains', [tag])).toEqual([contacts[0]]);
    expect(await matches('utm_source', 'is_empty', [])).toEqual(contacts.slice(1).sort((a, b) => a - b));
    expect(await matches('utm_source', 'not_contains', [tag])).toEqual(contacts.slice(1).sort((a, b) => a - b));
    for (const field of ['lastName', 'utm_source']) {
      const expectedValue = field === 'lastName' ? nameToken : tag;
      const response = await request.get(`${BASE_URL}/api/contacts/filter-values/${field}?status=Lead&q=${expectedValue}`, { headers });
      expect(response.status()).toBe(200);
      expect((await response.json()).values).toContainEqual({ value: expectedValue, label: expectedValue });
    }
  } finally {
    if (formId) await request.delete(`${BASE_URL}/api/forms/${formId}`, { headers });
    for (const id of contacts) await request.delete(`${BASE_URL}/api/contacts/${id}`, { headers });
  }
});
