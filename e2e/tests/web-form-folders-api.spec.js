const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

test('folder management and assignment require authentication', async ({ request }) => {
  for (const [method, path, data] of [
    ['get', '/folders'], ['post', '/folders', { name: 'Unauthorized' }],
    ['put', '/folders/1', { name: 'Unauthorized' }],
    ['delete', '/folders/1', { deleteForms: true }],
    ['put', '/1/folder', { folderId: 1 }],
  ]) {
    const response = await request[method](`${BASE_URL}/api/forms${path}`, { data });
    expect(response.status()).toBe(401);
  }
});

test('foreign tenant cannot rename, delete, assign, or list an owner folder', async ({ request }) => {
  const tokens = [];
  for (const email of ['admin@globussoft.com', 'admin@wellness.demo']) {
    const response = await request.post(`${BASE_URL}/api/auth/login`, { data: { email, password: 'password123' } });
    expect(response.ok()).toBeTruthy();
    tokens.push((await response.json()).token);
  }
  const owner = { Authorization: `Bearer ${tokens[0]}` };
  const foreign = { Authorization: `Bearer ${tokens[1]}` };
  const name = `Folder isolation ${Date.now()} ${process.pid}`;
  let folderId;
  let formId;
  try {
    const folder = await request.post(`${BASE_URL}/api/forms/folders`, { headers: owner, data: { name } });
    expect(folder.status()).toBe(201);
    folderId = (await folder.json()).id;
    const form = await request.post(`${BASE_URL}/api/forms`, { headers: owner, data: { name, folderId } });
    expect(form.status()).toBe(201);
    formId = (await form.json()).id;
    for (const [method, path, data] of [
      ['get', '/folders'], ['put', `/folders/${folderId}`, { name: 'Hijacked' }],
      ['delete', `/folders/${folderId}`, { deleteForms: false }],
      ['delete', `/folders/${folderId}`, { deleteForms: true }],
      ['put', `/${formId}/folder`, { folderId: null }],
      ['post', '', { name: 'Foreign assignment', folderId }],
    ]) {
      const response = await request[method](`${BASE_URL}/api/forms${path}`, { headers: foreign, data });
      expect([400, 403, 404]).toContain(response.status());
    }
    const folders = await request.get(`${BASE_URL}/api/forms/folders`, { headers: owner });
    expect((await folders.json()).find((row) => row.id === folderId)?.name).toBe(name);
    const preserved = await request.get(`${BASE_URL}/api/forms/${formId}`, { headers: owner });
    expect(preserved.status()).toBe(200);
    expect((await preserved.json()).folderId).toBe(folderId);
  } finally {
    if (formId) await request.delete(`${BASE_URL}/api/forms/${formId}`, { headers: owner });
    if (folderId) await request.delete(`${BASE_URL}/api/forms/folders/${folderId}`, { headers: owner });
  }
});

test('Generic web form folders persist assignments and release forms on deletion', async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const tag = `Folder E2E ${Date.now()} ${process.pid}`;
  let folderId;
  let formId;

  try {
    const createdFolder = await request.post(`${BASE_URL}/api/forms/folders`, { headers, data: { name: tag } });
    expect(createdFolder.status()).toBe(201);
    folderId = (await createdFolder.json()).id;

    const createdForm = await request.post(`${BASE_URL}/api/forms`, { headers, data: { name: `${tag} form`, folderId } });
    expect(createdForm.status()).toBe(201);
    formId = (await createdForm.json()).id;

    const listed = await request.get(`${BASE_URL}/api/forms`, { headers });
    expect((await listed.json()).find((form) => form.id === formId)?.folderId).toBe(folderId);

    const movedOut = await request.put(`${BASE_URL}/api/forms/${formId}/folder`, { headers, data: { folderId: null } });
    expect(movedOut.ok()).toBeTruthy();
    expect((await movedOut.json()).folderId).toBeNull();

    const movedBack = await request.put(`${BASE_URL}/api/forms/${formId}/folder`, { headers, data: { folderId } });
    expect(movedBack.ok()).toBeTruthy();

    const travelFolder = await request.get(`${BASE_URL}/api/forms/folders?scope=travel`, { headers });
    expect(travelFolder.status()).toBe(403);

    const renamed = await request.put(`${BASE_URL}/api/forms/folders/${folderId}`, { headers, data: { name: `${tag} renamed` } });
    expect(renamed.ok()).toBeTruthy();

    const deleted = await request.delete(`${BASE_URL}/api/forms/folders/${folderId}`, { headers });
    expect(deleted.ok()).toBeTruthy();
    folderId = null;

    const formAfterDelete = await request.get(`${BASE_URL}/api/forms/${formId}`, { headers });
    expect((await formAfterDelete.json()).folderId).toBeNull();
  } finally {
    if (formId) await request.delete(`${BASE_URL}/api/forms/${formId}`, { headers });
    if (folderId) await request.delete(`${BASE_URL}/api/forms/folders/${folderId}`, { headers });
  }
});

test('Deleting a folder can also delete its forms', async ({ request }) => {
  const login = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
  });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();
  const headers = { Authorization: `Bearer ${token}` };
  const tag = `Folder delete E2E ${Date.now()} ${process.pid}`;
  let folderId;
  let formId;

  try {
    const createdFolder = await request.post(`${BASE_URL}/api/forms/folders`, { headers, data: { name: tag } });
    expect(createdFolder.status()).toBe(201);
    folderId = (await createdFolder.json()).id;

    const createdForm = await request.post(`${BASE_URL}/api/forms`, { headers, data: { name: `${tag} form`, folderId } });
    expect(createdForm.status()).toBe(201);
    formId = (await createdForm.json()).id;

    const deleted = await request.delete(`${BASE_URL}/api/forms/folders/${folderId}`, {
      headers, data: { deleteForms: true },
    });
    expect(deleted.status()).toBe(200);
    expect((await deleted.json()).deletedForms).toBe(1);
    folderId = null;

    const formAfterDelete = await request.get(`${BASE_URL}/api/forms/${formId}`, { headers });
    expect(formAfterDelete.status()).toBe(404);
    formId = null;
  } finally {
    if (formId) await request.delete(`${BASE_URL}/api/forms/${formId}`, { headers });
    if (folderId) await request.delete(`${BASE_URL}/api/forms/folders/${folderId}`, { headers });
  }
});
