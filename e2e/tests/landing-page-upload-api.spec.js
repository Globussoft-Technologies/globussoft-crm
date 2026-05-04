// @ts-check
/**
 * Landing-page image-upload API — `POST /api/landing-pages/upload`.
 *
 * What/why:
 *   Issue #446 added an "Upload" button to the Image block in
 *   LandingPageBuilder.jsx so users no longer have to host images
 *   elsewhere first. The route is multer-based (multipart/form-data,
 *   field `image`), MIME-allowlists PNG/JPG/JPEG/WebP/GIF, and caps
 *   uploads at 5 MB. This spec pins the contract:
 *
 *     201 { url, mimetype, size, filename }
 *       - url is "/uploads/landing-page-images/tenant-<id>/<unique>.<ext>"
 *       - extension is derived from MIME, NOT the client filename
 *
 *     400 paths:
 *       - missing field           — multer returns nothing in req.file
 *       - non-image MIME          — file allowlist rejects (e.g. text/plain, image/svg+xml)
 *       - oversized file          — multer LIMIT_FILE_SIZE
 *
 *     401/403 — verifyToken (caller must be authenticated)
 *
 * Tenant isolation:
 *   Storage path embeds req.user.tenantId so a wellness upload + a
 *   generic upload land in different tenant-* directories. We assert
 *   the URL contains `tenant-<id>` matching the JWT's tenantId.
 *
 * Standing rules respected:
 *   - JWT user reference is req.user.userId (route uses tenantId only;
 *     no userId leakage). N/A.
 *   - stripDangerous middleware deletes id/createdAt/updatedAt/tenantId/
 *     userId from request bodies; it does NOT strip multipart parts so
 *     this route is unaffected.
 *   - No new test data is persisted (the upload writes a file to disk
 *     under uploads/, which is scrubbed by demo-monitor; we don't have
 *     to clean it).
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;

// 1x1 PNG (89 50 4E 47 …). Smallest valid PNG; deterministic.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
const TINY_PNG = Buffer.from(TINY_PNG_B64, 'base64');

// Tiny GIF — 1x1 transparent.
const TINY_GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const TINY_GIF = Buffer.from(TINY_GIF_B64, 'base64');

// Tiny WebP — Google's "VP8L" sample. The route trusts MIME + ext mapping,
// so we don't have to provide a strictly-valid WebP — we only need the
// MIME to be image/webp. Multer doesn't validate file contents.
const TINY_WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');

let genericToken = null;
let wellnessToken = null;
let genericTenantId = null;
let wellnessTenantId = null;

async function loginAs(request, email, password) {
  const r = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return { token: null, tenantId: null };
  const j = await r.json();
  return { token: j.token, tenantId: j.user?.tenantId || null };
}

test.beforeAll(async ({ request }) => {
  const g = await loginAs(request, 'admin@globussoft.com', 'password123');
  genericToken = g.token;
  genericTenantId = g.tenantId;
  const w = await loginAs(request, 'admin@wellness.demo', 'password123');
  wellnessToken = w.token;
  wellnessTenantId = w.tenantId;
});

// ── Helper: post a multipart body via Playwright's APIRequestContext.
// Playwright accepts a `multipart` field with name → { name, mimeType, buffer }.
async function postUpload(request, token, file, fieldName = 'image') {
  return request.post(`${BASE_URL}/api/landing-pages/upload`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    multipart: file
      ? { [fieldName]: file }
      : {},
    timeout: REQUEST_TIMEOUT,
  });
}

// ── Happy paths ───────────────────────────────────────────────────────

test.describe('POST /api/landing-pages/upload — happy paths', () => {
  test('201 PNG returns { url, mimetype, size, filename } with tenant-scoped path', async ({ request }) => {
    expect(genericToken, 'generic admin login must succeed').toBeTruthy();
    const res = await postUpload(request, genericToken, {
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    expect(res.status(), `upload PNG: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(typeof body.url).toBe('string');
    expect(body.url).toMatch(/^\/uploads\/landing-page-images\/tenant-\d+\//);
    expect(body.url).toContain(`tenant-${genericTenantId}/`);
    expect(body.url).toMatch(/\.png$/);
    expect(body.mimetype).toBe('image/png');
    expect(typeof body.size).toBe('number');
    expect(body.size).toBeGreaterThan(0);
    expect(typeof body.filename).toBe('string');
    expect(body.filename).toMatch(/\.png$/);
  });

  test('201 GIF lands on .gif extension, mimetype image/gif', async ({ request }) => {
    const res = await postUpload(request, genericToken, {
      name: 'tiny.gif',
      mimeType: 'image/gif',
      buffer: TINY_GIF,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/\.gif$/);
    expect(body.mimetype).toBe('image/gif');
  });

  test('201 WebP lands on .webp extension', async ({ request }) => {
    const res = await postUpload(request, genericToken, {
      name: 'tiny.webp',
      mimeType: 'image/webp',
      buffer: TINY_WEBP,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/\.webp$/);
    expect(body.mimetype).toBe('image/webp');
  });

  test('extension is derived from MIME, not the client filename (evil.svg masquerading as PNG → .png)', async ({ request }) => {
    // Send a file CALLED evil.svg but with mimetype image/png. The route
    // ignores the client filename (only uses it to pick from the
    // ALLOWED_IMAGE_MIMES table) so the file is saved with .png suffix.
    const res = await postUpload(request, genericToken, {
      name: 'evil.svg',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.url).toMatch(/\.png$/);
    expect(body.url).not.toMatch(/\.svg$/);
  });
});

// ── Tenant scoping ────────────────────────────────────────────────────

test.describe('POST /api/landing-pages/upload — tenant isolation', () => {
  test('wellness admin upload lands under tenant-<wellnessId>, NOT tenant-<genericId>', async ({ request }) => {
    test.skip(!wellnessToken, 'wellness admin login failed; skipping tenant-isolation check');
    test.skip(!genericTenantId || genericTenantId === wellnessTenantId, 'tenant ids identical or unknown — cannot prove isolation');
    const res = await postUpload(request, wellnessToken, {
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.url).toContain(`tenant-${wellnessTenantId}/`);
    expect(body.url).not.toContain(`tenant-${genericTenantId}/`);
  });
});

// ── Validation paths ──────────────────────────────────────────────────

test.describe('POST /api/landing-pages/upload — validation', () => {
  test('400 when no file uploaded', async ({ request }) => {
    const res = await postUpload(request, genericToken, null);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no image file/i);
  });

  test('400 rejects text/plain MIME', async ({ request }) => {
    const res = await postUpload(request, genericToken, {
      name: 'note.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello'),
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    // multer fileFilter error → 400 with the helper's message OR multer's
    // own LIMIT_UNEXPECTED_FILE-style fallback. Just confirm it's rejected
    // with a message about images.
    expect(body.error).toBeDefined();
    expect(body.error).toMatch(/image|allowed/i);
  });

  test('400 rejects image/svg+xml (SVG is a script vector)', async ({ request }) => {
    const res = await postUpload(request, genericToken, {
      name: 'evil.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    expect(res.status()).toBe(400);
  });

  test('400 rejects file over 5 MB', async ({ request }) => {
    // Multer LIMIT_FILE_SIZE → 400 "Image too large (max 5 MB)". Build a
    // 5.5 MB buffer of zeros — content doesn't matter for the size limit.
    const tooBig = Buffer.alloc(5.5 * 1024 * 1024, 0);
    const res = await postUpload(request, genericToken, {
      name: 'big.png',
      mimeType: 'image/png',
      buffer: tooBig,
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/too large|5 MB/i);
  });
});

// ── Auth gate ─────────────────────────────────────────────────────────

test.describe('POST /api/landing-pages/upload — auth gate', () => {
  test('401/403 without token', async ({ request }) => {
    const res = await postUpload(request, null, {
      name: 'pixel.png',
      mimeType: 'image/png',
      buffer: TINY_PNG,
    });
    expect([401, 403]).toContain(res.status());
  });
});
