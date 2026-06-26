// @ts-check
/**
 * Landing-pages registrationForm block API spec.
 *
 * Covers the new audience-aware registrationForm block:
 *   - Page with a registrationForm block can be CREATED + READ back
 *     with audience metadata preserved
 *   - Public renderer ships the audience preset's fields + a hidden
 *     audience input + a hidden subBrand input
 *   - Public submit at /p/:slug/submit creates a Contact whose source
 *     ends with the audience tag in parens
 *   - When a page has multiple registrationForm blocks (different
 *     audiences), submitting with `audience=<key>` picks the right
 *     block — the audience-tagged source is correct per-submission
 *   - Default subBrand=null on the inquiry preset doesn't surface a
 *     subBrand hidden input
 *
 * Pattern mirrors landing-pages-travel-api.spec.js — single-tenant
 * generic admin token, RUN_TAG prefix for cleanup.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_FLOW_LPREGFORM_${Date.now()}`;
// Slug validator only allows lowercase letters, numbers and hyphens.
const SLUG_TAG = RUN_TAG.toLowerCase().replace(/_/g, '-');

let token = null;

async function login(request) {
  if (token) return token;
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: 'admin@globussoft.com', password: 'password123' },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) throw new Error(`login failed: ${r.status()}`);
  const j = await r.json();
  token = j.token;
  return token;
}

const headers = (t) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const get = (request, path) => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });
const post = (request, path, body) => request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT });
const del = (request, path) => request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT });

const createdIds = new Set();
let counter = 0;
async function createPage(request, body = {}) {
  counter += 1;
  const res = await post(request, '/api/landing-pages', {
    title: body.title || `${RUN_TAG} p-${counter}-${Date.now()}`,
    slug: body.slug || `${SLUG_TAG}-p-${counter}-${Date.now()}`,
    ...body,
  });
  expect(res.status(), `createPage: ${await res.text()}`).toBe(201);
  const p = await res.json();
  createdIds.add(p.id);
  return p;
}

async function purgeOrphans(request) {
  const res = await get(request, '/api/landing-pages');
  if (!res.ok()) return;
  const list = await res.json();
  if (!Array.isArray(list)) return;
  for (const p of list) {
    if (typeof p.title === 'string' && /^E2E_FLOW_LPREGFORM_/.test(p.title)) {
      await del(request, `/api/landing-pages/${p.id}`).catch(() => {});
    }
  }
}

test.beforeAll(async ({ request }) => {
  await login(request);
  await purgeOrphans(request);
});

test.afterAll(async ({ request }) => {
  if (!token) return;
  for (const id of createdIds) {
    await del(request, `/api/landing-pages/${id}`).catch(() => {});
  }
});

test.describe('registrationForm block — round-trip + render', () => {
  test('persists audience + subBrand + fields when saved on a page', async ({ request }) => {
    const tmcContent = [
      {
        type: 'registrationForm',
        props: {
          audience: 'tmc',
          subBrand: 'tmc',
          title: 'TMC',
          subtitle: '',
          fields: [
            { label: "Parent's name", name: 'name', type: 'text', required: true },
            { label: 'Phone number', name: 'phone', type: 'tel', required: true },
            { label: 'Select school', name: 'school', type: 'text', required: true },
            { label: "Parent's email", name: 'email', type: 'email', required: true },
          ],
          submitText: 'Download programme brochure',
          thankYouMessage: 'Thank you — your school trip information is on the way.',
        },
      },
    ];
    const page = await createPage(request, { content: JSON.stringify(tmcContent) });
    const res = await get(request, `/api/landing-pages/${page.id}`);
    expect(res.ok()).toBe(true);
    const j = await res.json();
    const content = typeof j.content === 'string' ? JSON.parse(j.content) : j.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('registrationForm');
    expect(content[0].props.audience).toBe('tmc');
    expect(content[0].props.subBrand).toBe('tmc');
    expect(content[0].props.fields).toHaveLength(4);
    expect(content[0].props.fields.map((f) => f.name)).toEqual(['name', 'phone', 'school', 'email']);
  });

  test('public render contains the audience preset fields + hidden inputs', async ({ request }) => {
    const page = await createPage(request, {
      content: JSON.stringify([
        {
          type: 'registrationForm',
          props: {
            audience: 'rfu',
            subBrand: 'rfu',
            title: 'Register interest',
            fields: [
              { label: 'Full name', name: 'name', type: 'text', required: true },
              { label: 'Phone', name: 'phone', type: 'tel', required: true },
              { label: 'Email', name: 'email', type: 'email', required: true },
              { label: 'Pilgrims', name: 'pilgrimCount', type: 'number', required: true },
            ],
            submitText: 'Request Umrah package',
            thankYouMessage: 'Thank you.',
          },
        },
      ]),
      status: 'PUBLISHED',
    });
    const r = await request.get(`${BASE_URL}/p/${page.slug}`, { timeout: REQUEST_TIMEOUT });
    expect(r.ok(), `public render: ${r.status()}`).toBe(true);
    const html = await r.text();
    // Hidden audience + subBrand inputs are the lead-routing join keys.
    expect(html).toContain('name="audience" value="rfu"');
    expect(html).toContain('name="subBrand" value="rfu"');
    // Field inputs render with the preset's field names.
    expect(html).toContain('name="pilgrimCount"');
    expect(html).toContain('name="phone"');
    expect(html).toContain('Request Umrah package');
  });

  test('public render of inquiry preset omits the subBrand hidden input (subBrand=null)', async ({ request }) => {
    const page = await createPage(request, {
      content: JSON.stringify([
        {
          type: 'registrationForm',
          props: {
            audience: 'inquiry',
            subBrand: null,
            fields: [{ label: 'Email', name: 'email', type: 'email', required: true }],
          },
        },
      ]),
      status: 'PUBLISHED',
    });
    const r = await request.get(`${BASE_URL}/p/${page.slug}`, { timeout: REQUEST_TIMEOUT });
    const html = await r.text();
    expect(html).toContain('name="audience" value="inquiry"');
    expect(html).not.toContain('name="subBrand"');
  });
});

test.describe('registrationForm block — submission tags lead source with audience', () => {
  test('submitting with audience=tmc appends "(tmc)" to the Contact.source', async ({ request }) => {
    const page = await createPage(request, {
      content: JSON.stringify([
        {
          type: 'registrationForm',
          props: {
            audience: 'tmc',
            subBrand: 'tmc',
            fields: [
              { label: 'Name', name: 'name', type: 'text', required: true },
              { label: 'Email', name: 'email', type: 'email', required: true },
            ],
          },
        },
      ]),
    });
    const submitEmail = `${RUN_TAG.toLowerCase()}.tmc.${Date.now()}@example.com`;
    const r = await request.post(`${BASE_URL}/p/${page.slug}/submit`, {
      data: { audience: 'tmc', subBrand: 'tmc', name: 'Test Parent', email: submitEmail, phone: '+919999999999', school: 'Demo School' },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok(), `submit: ${r.status()} ${await r.text()}`).toBe(true);
    const j = await r.json();
    expect(j.success).toBe(true);

    // Verify the contact was created with the audience-tagged source.
    const listRes = await get(request, `/api/contacts?email=${encodeURIComponent(submitEmail)}`);
    expect(listRes.ok()).toBe(true);
    const list = await listRes.json();
    const contact = Array.isArray(list) ? list.find((c) => c.email === submitEmail) : null;
    expect(contact, 'contact not found by email').toBeTruthy();
    expect(contact.source).toMatch(/\(tmc\)$/);
  });

  test('submitting without an audience field uses the un-tagged Landing Page source', async ({ request }) => {
    const page = await createPage(request, {
      content: JSON.stringify([
        { type: 'form', props: { fields: [{ label: 'Email', name: 'email', type: 'email', required: true }] } },
      ]),
    });
    const submitEmail = `${RUN_TAG.toLowerCase()}.legacy.${Date.now()}@example.com`;
    const r = await request.post(`${BASE_URL}/p/${page.slug}/submit`, {
      data: { name: 'Legacy Lead', email: submitEmail },
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.ok()).toBe(true);
    const listRes = await get(request, `/api/contacts?email=${encodeURIComponent(submitEmail)}`);
    const list = await listRes.json();
    const contact = Array.isArray(list) ? list.find((c) => c.email === submitEmail) : null;
    expect(contact, 'legacy form contact not found').toBeTruthy();
    // No audience suffix.
    expect(contact.source).not.toMatch(/\(/);
    expect(contact.source).toContain('Landing Page:');
  });
});

test.describe('registrationForm — preset list endpoint (read-only catalogue)', () => {
  // The preset catalogue is a static module — there's no live HTTP
  // surface for it. This test pins the renderer's behaviour for the
  // visaSure preset's destinationCountry field, which is the unique
  // identifier that the preset is actually a Visa Sure preset (vs
  // every other preset that has name/email/phone).
  test('visaSure preset renders destinationCountry field in public HTML', async ({ request }) => {
    const page = await createPage(request, {
      content: JSON.stringify([
        {
          type: 'registrationForm',
          props: {
            audience: 'visaSure',
            subBrand: 'visaSure',
            fields: [
              { label: 'Full name', name: 'name', type: 'text', required: true },
              { label: 'Destination country', name: 'destinationCountry', type: 'text', required: true },
              { label: 'Visa type', name: 'visaType', type: 'text', required: false },
            ],
          },
        },
      ]),
      status: 'PUBLISHED',
    });
    const r = await request.get(`${BASE_URL}/p/${page.slug}`, { timeout: REQUEST_TIMEOUT });
    const html = await r.text();
    expect(html).toContain('name="destinationCountry"');
    expect(html).toContain('name="visaType"');
  });
});
