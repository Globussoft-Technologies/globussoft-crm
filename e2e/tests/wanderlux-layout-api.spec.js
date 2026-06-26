// @ts-check
/**
 * Wanderlux hybrid-layout API spec — save + render round-trip.
 *
 * Covers the hybrid block-editing surface that lets admins reorder, hide,
 * and interleave custom blocks (Heading / Text / Image / Button / Divider
 * / Spacer / Video / Two Columns) into AI-generated wanderlux-v1 pages.
 *
 * Edits exercised:
 *   1. Default render (no _layout set) keeps the full reference template
 *      (every wanderlux section appears in document order).
 *   2. PUT-ing `_layout.items = [section, section]` HIDES every other
 *      section — the omitted ones disappear from the rendered HTML.
 *   3. Reordering swaps the section-marker positions in the rendered HTML.
 *   4. A custom Heading block injected between sections appears in the
 *      rendered HTML between the two surrounding section markers.
 *   5. A Button block with a javascript: URL has the URL stripped by
 *      `safeUrl` (defence-in-depth for operator-supplied URLs).
 *
 * Pattern: landing-pages-api.spec.js (dual-token, RUN_TAG cleanup).
 * Uses the `/api/landing-pages/:id/preview` route — it is authed by the
 * caller's JWT and renders via the live production pipeline so the spec
 * exercises the same HTML the public /p/:slug page would emit.
 */
const { test, expect } = require('@playwright/test');

// Serial: tests share a single wanderlux page id created in beforeAll
// + PUT it back to different layouts in each test. Parallel shuffle
// would race the layout state.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60_000;
const RUN_TAG = `E2E_FLOW_LP_${Date.now()}`;

let adminToken = null;
let pageId = null;
const createdIds = new Set();

async function login(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return j.token;
      }
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function getPreviewHtml(request, id) {
  const r = await request.get(`${BASE_URL}/api/landing-pages/${id}/preview`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.status(), `preview ${id} should 200`).toBe(200);
  return r.text();
}

async function saveContent(request, id, contentObj) {
  const r = await request.put(`${BASE_URL}/api/landing-pages/${id}`, {
    headers: headers(adminToken),
    data: { content: JSON.stringify(contentObj) },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.status(), `PUT ${id} should 200`).toBe(200);
}

test.beforeAll(async ({ request }) => {
  adminToken = await login(request, 'admin@globussoft.com', 'password123');
  if (!adminToken) test.skip(true, 'admin login failed — backend down?');

  // Create a wanderlux-v1 page. The templateType must be set on create
  // (the builder sets it when generating; we POST it directly here).
  const create = await request.post(`${BASE_URL}/api/landing-pages`, {
    headers: headers(adminToken),
    data: {
      title: `${RUN_TAG} layout`,
      templateType: 'wanderlux-v1',
      content: JSON.stringify({ brand: { name: 'Demo' } }),
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(create.status(), `create page: ${await create.text()}`).toBe(201);
  const created = await create.json();
  pageId = created.id;
  createdIds.add(pageId);
});

test.afterAll(async ({ request }) => {
  if (!adminToken) return;
  for (const id of createdIds) {
    await request.delete(`${BASE_URL}/api/landing-pages/${id}`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    }).catch(() => {});
  }
});

test.describe('wanderlux hybrid layout — render', () => {
  test('default (no _layout) renders the full template with HERO + FOOTER in order', async ({ request }) => {
    await saveContent(request, pageId, { brand: { name: 'Demo' } });
    const html = await getPreviewHtml(request, pageId);
    const heroIdx = html.indexOf('===================== HERO');
    const footerIdx = html.indexOf('===================== FOOTER');
    expect(heroIdx).toBeGreaterThan(0);
    expect(footerIdx).toBeGreaterThan(heroIdx);
    // Floating register pill stays always-on.
    expect(html).toContain('FLOATING REGISTER');
  });

  test('reordering moves FOOTER above HERO in the emitted HTML', async ({ request }) => {
    await saveContent(request, pageId, {
      brand: { name: 'Demo' },
      _layout: {
        items: [
          { kind: 'section', key: 'footer' },
          { kind: 'section', key: 'hero' },
        ],
      },
    });
    const html = await getPreviewHtml(request, pageId);
    const heroIdx = html.indexOf('===================== HERO');
    const footerIdx = html.indexOf('===================== FOOTER');
    expect(footerIdx).toBeGreaterThan(0);
    expect(heroIdx).toBeGreaterThan(0);
    expect(footerIdx).toBeLessThan(heroIdx);
  });

  test('hidden sections are omitted from the rendered HTML', async ({ request }) => {
    await saveContent(request, pageId, {
      brand: { name: 'Demo' },
      _layout: {
        items: [
          { kind: 'section', key: 'hero' },
          { kind: 'section', key: 'footer' },
        ],
      },
    });
    const html = await getPreviewHtml(request, pageId);
    expect(html).not.toContain('===================== SAFETY');
    expect(html).not.toContain('===================== INVESTMENT');
    expect(html).not.toContain('===================== TESTIMONIALS');
    expect(html).not.toMatch(/<sc-if\s+value="\{\{\s*showSafety\s*\}\}"/);
  });

  test('custom Heading block injected between sections appears in the rendered HTML', async ({ request }) => {
    const marker = `WANDERLUX_LAYOUT_${RUN_TAG}_HEADING`;
    await saveContent(request, pageId, {
      brand: { name: 'Demo' },
      _layout: {
        items: [
          { kind: 'section', key: 'hero' },
          { kind: 'block', id: 'b_h1', type: 'heading', props: { text: marker, level: 'h2', align: 'center', color: '#111' } },
          { kind: 'section', key: 'footer' },
        ],
      },
    });
    const html = await getPreviewHtml(request, pageId);
    const heroIdx = html.indexOf('===================== HERO');
    const footerIdx = html.indexOf('===================== FOOTER');
    // The marker text also appears inside the injected window.__PAGE_CONFIG
    // JSON in the <head>, so locate the *rendered* heading by its closing
    // tag rather than a raw string match.
    const headingMatch = html.match(new RegExp(`<h2[^>]*>${marker}</h2>`));
    expect(headingMatch, 'rendered heading should appear in body').toBeTruthy();
    const headingIdx = headingMatch.index;
    expect(headingIdx).toBeGreaterThan(heroIdx);
    expect(footerIdx).toBeGreaterThan(headingIdx);
  });

  test('custom Button block with javascript: URL has the URL neutralised (defence-in-depth)', async ({ request }) => {
    const marker = `WANDERLUX_LAYOUT_${RUN_TAG}_BTN`;
    await saveContent(request, pageId, {
      brand: { name: 'Demo' },
      _layout: {
        items: [
          { kind: 'block', id: 'b_btn', type: 'button', props: { text: marker, url: 'javascript:alert(1)' } },
        ],
      },
    });
    const html = await getPreviewHtml(request, pageId);
    expect(html).toContain(marker);
    expect(html).not.toMatch(/href="javascript:/);
  });

  test('Divider and Spacer custom blocks render through the public pipeline', async ({ request }) => {
    await saveContent(request, pageId, {
      brand: { name: 'Demo' },
      _layout: {
        items: [
          { kind: 'block', id: 'b_div', type: 'divider', props: { color: '#abcdef', margin: '8px' } },
          { kind: 'block', id: 'b_sp', type: 'spacer', props: { height: '77px' } },
        ],
      },
    });
    const html = await getPreviewHtml(request, pageId);
    expect(html).toMatch(/<hr[^>]*style="[^"]*#abcdef/);
    expect(html).toContain('height:77px');
  });

  test('unknown custom-block type is silently dropped (closed catalogue)', async ({ request }) => {
    const marker = `WANDERLUX_LAYOUT_${RUN_TAG}_OK`;
    await saveContent(request, pageId, {
      brand: { name: 'Demo' },
      _layout: {
        items: [
          { kind: 'block', id: 'b_form', type: 'form', props: { fields: [] } },                          // not in catalogue
          { kind: 'block', id: 'b_ok', type: 'heading', props: { text: marker, level: 'h3' } },        // ok
        ],
      },
    });
    const html = await getPreviewHtml(request, pageId);
    expect(html).toContain(marker);
    // form block was dropped — no <form ... onsubmit> in the body.
    expect(html).not.toMatch(/<form[^>]*onsubmit="return false/);
  });

  test('saved _layout survives the GET round-trip', async ({ request }) => {
    const layout = {
      items: [
        { kind: 'section', key: 'hero' },
        { kind: 'block', id: 'b_rt', type: 'text', props: { text: 'round-trip' } },
        { kind: 'section', key: 'footer' },
      ],
    };
    await saveContent(request, pageId, { brand: { name: 'Demo' }, _layout: layout });
    const r = await request.get(`${BASE_URL}/api/landing-pages/${pageId}`, {
      headers: headers(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    const parsed = typeof j.content === 'string' ? JSON.parse(j.content) : j.content;
    expect(parsed._layout).toBeTruthy();
    expect(Array.isArray(parsed._layout.items)).toBe(true);
    expect(parsed._layout.items).toHaveLength(3);
    expect(parsed._layout.items[0]).toMatchObject({ kind: 'section', key: 'hero' });
    expect(parsed._layout.items[1]).toMatchObject({ kind: 'block', type: 'text' });
    expect(parsed._layout.items[2]).toMatchObject({ kind: 'section', key: 'footer' });
  });
});
