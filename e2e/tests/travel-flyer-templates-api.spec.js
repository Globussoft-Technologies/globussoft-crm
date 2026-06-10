// @ts-check
/**
 * Gate spec — TravelFlyerTemplate POST /:id/render (slice S17).
 *
 * Pins the synchronous multi-format render surface for the Travel marketing
 * flyer studio. Covers the 5 deliverable formats called out in
 * docs/TRAVEL_BIG_SCOPE_BACKLOG.md S17 + docs/PRD_TRAVEL_MARKETING_FLYER.md
 * FR-3.4.1 / FR-3.4.2 / AC-6.3 / AC-6.4:
 *
 *   - pdf-a4         : Buffer with %PDF magic, Content-Type application/pdf
 *   - pdf-a5         : Buffer with %PDF magic, Content-Type application/pdf
 *   - png-square     : Buffer with PNG magic, Content-Type image/png,
 *                      X-Flyer-Width-Px: 1200, X-Flyer-Height-Px: 1200
 *   - png-portrait-ig: Buffer with PNG magic, X-Flyer-Width-Px: 1080,
 *                      X-Flyer-Height-Px: 1920
 *   - png-landscape-fb: Buffer with PNG magic, X-Flyer-Width-Px: 1920,
 *                       X-Flyer-Height-Px: 1080
 *
 * Plus:
 *   - INVALID_FORMAT (e.g. 'gif-animated') → 400 with code INVALID_FORMAT
 *   - TEMPLATE_NOT_FOUND (id=999999999)    → 404 with code TEMPLATE_NOT_FOUND
 *   - INVALID_ID (id='abc')                 → 400 with code INVALID_ID
 *   - WRONG_VERTICAL (generic admin)        → 403
 *   - auth gate (no token)                  → 401/403
 *   - X-Flyer-Render-Engine header set on every successful render
 *     (`'pdfkit'` for PDF, `'stub-1x1'` for PNG until Puppeteer lands)
 *
 * Sub-brand isolation + audit-row verification are out of scope for this
 * spec — the per-route sibling specs already pin those gates for /:id/export
 * and /:id/preview.pdf. This spec focuses on the new render surface only.
 *
 * RUN_TAG: each test run creates a single template with a unique
 * `E2E_S17_RENDER_<ts>` name + cleans up in afterAll.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_S17_RENDER_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) { if (attempt === 0) continue; }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  }
  return genericAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function post(request, token, path, body) {
  return retryOn5xx(() => request.post(`${BASE_URL}${path}`, {
    headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT,
  }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, {
    headers: headers(token), timeout: REQUEST_TIMEOUT,
  }));
}

// Valid palette + layout — must pass flyerTemplateValidator.validateTemplate
// (validator block types: text | image | cta | divider | logo).
const validPaletteJson = {
  primaryHex: "#122647",
  secondaryHex: "#C89A4E",
  accentHex: "#F5E6CC",
  textHex: "#1A1A1A",
  bgHex: "#FFFFFF",
};
const validLayoutJson = [
  { type: "logo", x: 20, y: 20, width: 120, height: 60, src: "https://cdn.example/logo.png" },
  { type: "text", x: 20, y: 100, width: 400, height: 40, content: `${RUN_TAG} Summer Umrah` },
  { type: "cta", x: 20, y: 600, width: 200, height: 50, content: "Book Now", href: "https://example.com/book" },
];
const validAssetsJson = {
  logo: "https://cdn.example/logo.png",
  hero: "https://cdn.example/hero.jpg",
};

const created = { templateIds: [] };

// PDF magic bytes: %PDF (0x25 0x50 0x44 0x46) at file start.
function isPdfMagic(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46
  );
}
// PNG magic bytes: \x89PNG\r\n\x1a\n at file start.
function isPngMagic(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

let templateId = null;

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const res = await post(request, token, "/api/travel/flyer-templates", {
    name: `${RUN_TAG} Render-test template`,
    paletteJson: JSON.stringify(validPaletteJson),
    layoutJson: JSON.stringify(validLayoutJson),
    assetsJson: JSON.stringify(validAssetsJson),
  });
  if (res.status() === 201) {
    const body = await res.json();
    templateId = body.id;
    created.templateIds.push(body.id);
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  const deadline = Date.now() + 40_000;
  for (const id of created.templateIds) {
    if (Date.now() > deadline) break;
    await del(request, token, `/api/travel/flyer-templates/${id}`).catch(() => {});
  }
});

test.describe("Travel flyer-templates POST /:id/render — guards", () => {
  test("rejects generic admin with 403 (wrong vertical)", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await post(request, token, "/api/travel/flyer-templates/1/render", {
      format: "pdf-a4",
    });
    expect([403, 404]).toContain(res.status());
  });

  test("rejects unauthenticated callers with 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/flyer-templates/1/render`, {
      data: { format: "pdf-a4" },
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });

  test("returns 400 INVALID_ID for non-numeric :id", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await post(request, token, "/api/travel/flyer-templates/abc/render", {
      format: "pdf-a4",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_ID");
  });

  test("returns 400 INVALID_FORMAT for an unrecognised format", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    if (templateId == null) test.skip(true, "seed template missing");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "gif-animated",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FORMAT");
  });

  test("returns 400 INVALID_FORMAT when format is missing", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    if (templateId == null) test.skip(true, "seed template missing");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_FORMAT");
  });

  test("returns 404 TEMPLATE_NOT_FOUND for a non-existent :id", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no travel admin token");
    const res = await post(request, token, "/api/travel/flyer-templates/999999999/render", {
      format: "pdf-a4",
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).code).toBe("TEMPLATE_NOT_FOUND");
  });
});

test.describe("Travel flyer-templates POST /:id/render — 5 formats", () => {
  test("pdf-a4 returns a PDF buffer with pdfkit engine header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "pdf-a4",
    });
    expect(res.status(), `pdf-a4: ${await res.text().catch(() => "")}`).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["x-flyer-render-engine"]).toBe("pdfkit");
    expect(res.headers()["content-disposition"]).toContain(".pdf");
    const body = await res.body();
    expect(isPdfMagic(body)).toBe(true);
  });

  test("pdf-a5 returns a PDF buffer with pdfkit engine header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "pdf-a5",
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["x-flyer-render-engine"]).toBe("pdfkit");
    const body = await res.body();
    expect(isPdfMagic(body)).toBe(true);
  });

  test("png-square returns a PNG buffer with 1200x1200 dimensions header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "png-square",
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect(res.headers()["x-flyer-width-px"]).toBe("1200");
    expect(res.headers()["x-flyer-height-px"]).toBe("1200");
    // Puppeteer-or-stub: today's CI stack does not have Puppeteer in
    // package.json, so we expect 'stub-1x1'. Once Puppeteer lands, this
    // assertion relaxes to (stub-1x1 | puppeteer).
    expect(["stub-1x1", "puppeteer"]).toContain(res.headers()["x-flyer-render-engine"]);
    const body = await res.body();
    expect(isPngMagic(body)).toBe(true);
  });

  test("png-portrait-ig returns a PNG buffer with 1080x1920 dimensions header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "png-portrait-ig",
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect(res.headers()["x-flyer-width-px"]).toBe("1080");
    expect(res.headers()["x-flyer-height-px"]).toBe("1920");
    const body = await res.body();
    expect(isPngMagic(body)).toBe(true);
  });

  test("png-landscape-fb returns a PNG buffer with 1920x1080 dimensions header", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "png-landscape-fb",
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/png");
    expect(res.headers()["x-flyer-width-px"]).toBe("1920");
    expect(res.headers()["x-flyer-height-px"]).toBe("1080");
    const body = await res.body();
    expect(isPngMagic(body)).toBe(true);
  });

  test("emits X-Flyer-Template-Hash + X-Flyer-Cache-Key headers on a successful render", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "pdf-a4",
    });
    expect(res.status()).toBe(200);
    const hash = res.headers()["x-flyer-template-hash"];
    const cacheKey = res.headers()["x-flyer-cache-key"];
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64); // SHA-256 hex
    expect(typeof cacheKey).toBe("string");
    // Cache key shape: "pdf:a4:<hash>" — see lib/flyerExport.buildOutputCacheKey
    expect(cacheKey.startsWith("pdf:a4:")).toBe(true);
    expect(cacheKey.endsWith(hash)).toBe(true);
  });
});

test.describe("Travel flyer-templates POST /:id/render — data overrides", () => {
  test("renders successfully with priceOverride / titleOverride / ctaOverride in body data", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || templateId == null) test.skip(true, "no seed");
    const res = await post(request, token, `/api/travel/flyer-templates/${templateId}/render`, {
      format: "pdf-a4",
      data: {
        priceOverride: "₹78,000",
        titleOverride: "Ramadan Umrah",
        dateOverride: "May 18",
      },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const body = await res.body();
    expect(isPdfMagic(body)).toBe(true);
  });
});
