// @ts-check
/**
 * Gate spec — Public flyer share + render surface (slice S18).
 *
 * Pins the public landing endpoints PRD_TRAVEL_MARKETING_FLYER FR-3.5.3/4
 * mirrored from slice C9 (Quote Accept Landing):
 *
 *   POST /api/v1/flyers/:id/share              (auth, ADMIN+MANAGER)
 *       → { shareUrl, embedCode, expiresAt }
 *
 *   GET  /api/v1/flyers/public/:slug?t=<jwt>   (PUBLIC, no auth)
 *       → renders the flyer via services/flyerRenderEngine
 *
 *   GET  /api/v1/flyers/public/:slug/meta?t=<jwt>  (PUBLIC, no auth)
 *       → { templateName, brandName, expiresAt, availableFormats, ... }
 *
 * --- Probe-and-skip ---
 *
 * The route file `backend/routes/travel_flyer_public.js` is NOT mounted in
 * server.js as part of this slice — wire-in is a follow-up gap row to
 * avoid the shared-file collision with sibling parallel agents (S19 + S10
 * also live on Wave 14). The mount in server.js plus the
 * `/v1/flyers/public` openPaths entry land in the wire-in slice.
 *
 * Until that lands, every test in this file skips against demo. The spec
 * is structured so that once the mount lands, ALL tests light up
 * automatically — no spec changes required. The probe is a single
 * unauthenticated GET that returns 404 (route absent) vs 401 (route
 * present, missing token).
 *
 * --- Deploy-gate registration ---
 *
 * NOT added to deploy.yml / coverage.yml gate lists in this slice — the
 * route is unmounted, so the gate would silently skip every test on every
 * push. Once the wire-in slice lands AND a smoke test against demo
 * confirms the mount, a follow-up commit adds this spec to the gate list.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_S18_PUBFLYER_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;
let routeMounted = null; // probed in beforeAll

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
async function get(request, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, {
    timeout: REQUEST_TIMEOUT,
  }));
}
async function getAuthed(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, {
    headers: headers(token), timeout: REQUEST_TIMEOUT,
  }));
}
async function del(request, token, path) {
  return retryOn5xx(() => request.delete(`${BASE_URL}${path}`, {
    headers: headers(token), timeout: REQUEST_TIMEOUT,
  }));
}

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

const created = { templateIds: [] };

let templateId = null;
let validShareUrl = null;
let validToken = null;
let canonicalSlug = null;

// Probe whether `/api/v1/flyers/public/:slug` is reachable. A mounted route
// returns 401 MISSING_TOKEN on a no-token GET; an unmounted route falls
// through to the SPA / a 404. We treat 401 as "mounted" — the public route
// is reachable + the JWT gate is live.
async function probeRouteMounted(request) {
  if (routeMounted !== null) return routeMounted;
  try {
    const r = await get(request, "/api/v1/flyers/public/probe-slug");
    routeMounted = r.status() === 401;
  } catch (_e) {
    routeMounted = false;
  }
  return routeMounted;
}

test.beforeAll(async ({ request }) => {
  const mounted = await probeRouteMounted(request);
  if (!mounted) return; // every test skips below
  const token = await getTravelAdmin(request);
  if (!token) return;
  const res = await post(request, token, "/api/travel/flyer-templates", {
    name: `${RUN_TAG} pubflyer template`,
    paletteJson: JSON.stringify(validPaletteJson),
    layoutJson: JSON.stringify(validLayoutJson),
  });
  if (res.status() === 201) {
    const body = await res.json();
    templateId = body.id;
    created.templateIds.push(body.id);
    // Slugify must match the route's `slugify(template.name)`.
    canonicalSlug = `${RUN_TAG.toLowerCase()}-pubflyer-template`
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)+/g, "")
      .slice(0, 80);

    // Mint a real share URL via POST /:id/share so downstream tests can use it.
    const mintRes = await post(request, token, `/api/v1/flyers/${templateId}/share`, {});
    if (mintRes.status() === 200) {
      const mintBody = await mintRes.json();
      validShareUrl = mintBody.shareUrl;
      // Extract t=... from the URL.
      try {
        const url = new URL(mintBody.shareUrl);
        validToken = url.searchParams.get("t");
      } catch (_e) { validToken = null; }
      // The slug is also in the body for sanity.
      if (mintBody.slug) canonicalSlug = mintBody.slug;
    }
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

test.describe("Travel flyer public — guards on POST /:id/share", () => {
  test("rejects unauthenticated callers with 401/403", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted: backend/routes/travel_flyer_public.js not in server.js");
    const r = await request.post(`${BASE_URL}/api/v1/flyers/1/share`, {
      data: {},
      headers: { "Content-Type": "application/json" },
      timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(r.status());
  });

  test("rejects generic-vertical admin with 403 WRONG_VERTICAL", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    const token = await getGenericAdmin(request);
    test.skip(!token, "admin@globussoft.com not seeded");
    const r = await post(request, token, "/api/v1/flyers/1/share", {});
    expect([403, 404]).toContain(r.status());
  });

  test("returns 400 INVALID_ID for non-numeric :id", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin token");
    const r = await post(request, token, "/api/v1/flyers/abc/share", {});
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_ID");
  });

  test("returns 404 TEMPLATE_NOT_FOUND for a non-existent :id", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin token");
    const r = await post(request, token, "/api/v1/flyers/999999999/share", {});
    expect(r.status()).toBe(404);
    expect((await r.json()).code).toBe("TEMPLATE_NOT_FOUND");
  });
});

test.describe("Travel flyer public — POST /:id/share happy path", () => {
  test("ADMIN with valid template → 200, returns shareUrl + embedCode + expiresAt", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(templateId == null, "no seed template");
    const token = await getTravelAdmin(request);
    test.skip(!token, "no travel admin token");
    const r = await post(request, token, `/api/v1/flyers/${templateId}/share`, {});
    expect(r.status(), await r.text().catch(() => "")).toBe(200);
    const body = await r.json();
    expect(body.shareUrl).toMatch(/\/p\/flyer\//);
    expect(body.shareUrl).toMatch(/t=/);
    expect(body.embedCode).toContain("<iframe");
    expect(body.embedCode).toContain("embed=1");
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.slug).toBeTruthy();
    expect(body.flyerId).toBe(templateId);
  });
});

test.describe("Travel flyer public — GET /public/:slug", () => {
  test("missing ?t= → 401 MISSING_TOKEN", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    const r = await get(request, "/api/v1/flyers/public/any-slug");
    expect(r.status()).toBe(401);
    expect((await r.json()).code).toBe("MISSING_TOKEN");
  });

  test("tampered token → 401 INVALID_TOKEN", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    const r = await get(request, "/api/v1/flyers/public/any-slug?t=not-a-real-jwt");
    expect(r.status()).toBe(401);
    expect((await r.json()).code).toBe("INVALID_TOKEN");
  });

  test("valid share URL → 200, binary buffer + correct Content-Type", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(!validToken || !canonicalSlug, "share-mint failed");
    const r = await get(
      request,
      `/api/v1/flyers/public/${canonicalSlug}?t=${encodeURIComponent(validToken)}&format=pdf-a4`,
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");
    expect(r.headers()["x-flyer-render-engine"]).toBeTruthy();
  });

  test("PNG format → 200, PNG headers", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(!validToken || !canonicalSlug, "share-mint failed");
    const r = await get(
      request,
      `/api/v1/flyers/public/${canonicalSlug}?t=${encodeURIComponent(validToken)}&format=png-square`,
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("image/png");
    expect(r.headers()["x-flyer-width-px"]).toBe("1200");
    expect(r.headers()["x-flyer-height-px"]).toBe("1200");
  });

  test("bad format → 400 INVALID_FORMAT", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(!validToken || !canonicalSlug, "share-mint failed");
    const r = await get(
      request,
      `/api/v1/flyers/public/${canonicalSlug}?t=${encodeURIComponent(validToken)}&format=gif-animated`,
    );
    expect(r.status()).toBe(400);
    expect((await r.json()).code).toBe("INVALID_FORMAT");
  });

  test("slug mismatch → 404 FLYER_NOT_FOUND", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(!validToken, "share-mint failed");
    const r = await get(
      request,
      `/api/v1/flyers/public/wrong-slug?t=${encodeURIComponent(validToken)}`,
    );
    expect(r.status()).toBe(404);
    expect((await r.json()).code).toBe("FLYER_NOT_FOUND");
  });

  test("fallback slug `flyer-<id>` resolves the same flyer", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(!validToken || templateId == null, "share-mint failed");
    const r = await get(
      request,
      `/api/v1/flyers/public/flyer-${templateId}?t=${encodeURIComponent(validToken)}&format=pdf-a4`,
    );
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toContain("application/pdf");
  });
});

test.describe("Travel flyer public — GET /public/:slug/meta", () => {
  test("missing ?t= → 401 MISSING_TOKEN", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    const r = await get(request, "/api/v1/flyers/public/any-slug/meta");
    expect(r.status()).toBe(401);
    expect((await r.json()).code).toBe("MISSING_TOKEN");
  });

  test("valid token → 200, returns templateName + availableFormats", async ({ request }) => {
    const mounted = await probeRouteMounted(request);
    test.skip(!mounted, "route_unmounted");
    test.skip(!validToken || !canonicalSlug, "share-mint failed");
    const r = await get(
      request,
      `/api/v1/flyers/public/${canonicalSlug}/meta?t=${encodeURIComponent(validToken)}`,
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.templateName).toContain("pubflyer template");
    expect(Array.isArray(body.availableFormats)).toBe(true);
    expect(body.availableFormats.length).toBe(5);
    expect(body.defaultFormat).toBe("png-square");
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
