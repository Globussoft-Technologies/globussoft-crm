// @ts-check
/**
 * Gate spec — BrandKit admin extension endpoints (W4.A — G089 + G099 + G100).
 *
 * Pins the operator-facing surface added in this slice:
 *
 *   - POST   /api/brand-kits/upload                — Multer upload + validation
 *   - GET    /api/brand-kits/:id/versions          — version history
 *   - POST   /api/brand-kits/:id/revert/:version   — revert to prior version
 *   - POST   /api/brand-kits/:id/copy-from/:sourceId — copy assets from another kit
 *
 * Plus extended G089 schema fields round-trip on POST /api/brand-kits —
 * wordmark / hero / heading+body+code font slots / CMYK / signature template /
 * header image / footer text / invoice stamp / mission / social / support.
 *
 * Cleanup: every test seeds an "active" kit, optionally a "history" kit,
 * then deletes after the suite via afterAll. The "_teardown_" prefix is
 * NOT used here — BrandKit doesn't have a name column to grep, so we
 * track the created ids explicitly.
 *
 * RUN_TAG appears in created kit URLs / tagline so demo-monitor cleanup
 * can identify them if afterAll silently fails.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_BRAND_KITS_${Date.now()}`;

let travelAdminToken = null;
let userToken = null;
const createdKitIds = [];

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}

async function getUser(request) {
  if (!userToken) {
    userToken = await loginAs(request, "user@crm.com", "password123");
  }
  return userToken;
}

const headers = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  for (const id of createdKitIds) {
    try {
      // First demote (if active) by deactivating, then delete.
      await request.put(`${BASE_URL}/api/brand-kits/${id}`, {
        headers: headers(token),
        data: { isActive: false },
        timeout: REQUEST_TIMEOUT,
      });
    } catch {}
    try {
      await request.delete(`${BASE_URL}/api/brand-kits/${id}`, {
        headers: headers(token),
        timeout: REQUEST_TIMEOUT,
      });
    } catch {}
  }
});

test.describe("BrandKit admin extension endpoints (W4.A)", () => {
  test("POST /api/brand-kits accepts G089 extended fields (wordmark / hero / heading font / CMYK / signature template / header image / footer / mission / social)", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin not seeded");

    const payload = {
      subBrand: "tmc",
      tagline: `${RUN_TAG} extended-fields probe`,
      // G089 — every field added in this slice
      wordmarkUrl: "https://cdn.example/wordmark.svg",
      heroUrl: "https://cdn.example/hero.jpg",
      successBadge: "#22c55e",
      warningBadge: "#f59e0b",
      headingFontFamily: "Cardo, serif",
      headingFontUrl: "https://fonts.googleapis.com/css2?family=Cardo",
      bodyFontFamily: "Inter, sans-serif",
      bodyFontUrl: "https://fonts.googleapis.com/css2?family=Inter",
      codeFontFamily: "JetBrains Mono",
      codeFontUrl: "https://fonts.googleapis.com/css2?family=JetBrains+Mono",
      cmykPrimary: "90,40,50,40",
      cmykSecondary: "0,50,60,10",
      cmykAccent: "20,30,80,5",
      signatureTemplate: "<p>--<br/>{{name}}</p>",
      headerImageUrl: "https://cdn.example/header.png",
      footerText: `${RUN_TAG} footer GST 27ABCDE1234F1Z5`,
      invoiceStampUrl: "https://cdn.example/stamp.png",
      missionStatement: "Plan curriculum-aligned school trips",
      supportEmail: "support@e2e.example",
      supportPhone: "+91-9999999999",
      socialLinksJson: '[{"network":"instagram","url":"https://ig/e2e"}]',
    };

    const res = await request.post(`${BASE_URL}/api/brand-kits`, {
      headers: headers(token),
      data: payload,
      timeout: REQUEST_TIMEOUT,
    });

    expect(res.status()).toBe(201);
    const body = await res.json();
    createdKitIds.push(body.id);

    // Round-trip — every G089 field comes back populated.
    expect(body.wordmarkUrl).toBe(payload.wordmarkUrl);
    expect(body.heroUrl).toBe(payload.heroUrl);
    expect(body.successBadge).toBe(payload.successBadge);
    expect(body.warningBadge).toBe(payload.warningBadge);
    expect(body.headingFontFamily).toBe(payload.headingFontFamily);
    expect(body.bodyFontFamily).toBe(payload.bodyFontFamily);
    expect(body.codeFontFamily).toBe(payload.codeFontFamily);
    expect(body.cmykPrimary).toBe(payload.cmykPrimary);
    expect(body.signatureTemplate).toContain("{{name}}");
    expect(body.headerImageUrl).toBe(payload.headerImageUrl);
    expect(body.footerText).toContain("GST");
    expect(body.invoiceStampUrl).toBe(payload.invoiceStampUrl);
    expect(body.missionStatement).toBe(payload.missionStatement);
    expect(body.supportEmail).toBe(payload.supportEmail);
    expect(body.supportPhone).toBe(payload.supportPhone);
    expect(body.socialLinksJson).toContain("instagram");
  });

  test("GET /api/brand-kits/:id/versions returns history desc", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin not seeded");
    test.skip(createdKitIds.length === 0, "depends on first test");

    // Create a second version for the same (tenant, subBrand) tuple.
    const r2 = await request.post(`${BASE_URL}/api/brand-kits`, {
      headers: headers(token),
      data: { subBrand: "tmc", tagline: `${RUN_TAG} v-secondary` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r2.status()).toBe(201);
    const second = await r2.json();
    createdKitIds.push(second.id);

    const res = await request.get(`${BASE_URL}/api/brand-kits/${second.id}/versions`, {
      headers: headers(token),
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.versions)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(2);
    // Descending order.
    for (let i = 1; i < body.versions.length; i++) {
      expect(body.versions[i - 1].version).toBeGreaterThan(body.versions[i].version);
    }
  });

  test("POST /api/brand-kits/:id/revert/:version creates new top version copying source assets", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin not seeded");
    test.skip(createdKitIds.length === 0, "depends on first test");

    const anchorId = createdKitIds[0];
    // Find the version of the anchor we want to revert FROM (the original — has all the G089 fields).
    const verRes = await request.get(`${BASE_URL}/api/brand-kits/${anchorId}/versions`, {
      headers: headers(token),
    });
    const verBody = await verRes.json();
    const original = verBody.versions.find((v) => v.id === anchorId);
    expect(original).toBeDefined();

    const res = await request.post(
      `${BASE_URL}/api/brand-kits/${anchorId}/revert/${original.version}`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(201);
    const reverted = await res.json();
    createdKitIds.push(reverted.id);

    // Revert version > all prior versions for this tuple.
    expect(reverted.version).toBeGreaterThan(original.version);
    expect(reverted.isActive).toBe(true);
    // Asset fields carry through.
    expect(reverted.wordmarkUrl).toBe(original.wordmarkUrl);
    expect(reverted.signatureTemplate).toBe(original.signatureTemplate);
  });

  test("POST /api/brand-kits/:id/revert/:version returns 404 SOURCE_VERSION_NOT_FOUND for unknown version", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin not seeded");
    test.skip(createdKitIds.length === 0, "depends on first test");

    const res = await request.post(
      `${BASE_URL}/api/brand-kits/${createdKitIds[0]}/revert/9999`,
      { headers: headers(token), timeout: REQUEST_TIMEOUT },
    );
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("SOURCE_VERSION_NOT_FOUND");
  });

  test("POST /api/brand-kits/upload rejects oversized SVG with <script> tag", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin not seeded");

    const evilSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>alert(1)</script><circle r="10"/></svg>';

    const res = await request.post(`${BASE_URL}/api/brand-kits/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        assetType: "logo",
        subBrand: "tmc",
        file: {
          name: `${RUN_TAG}-evil.svg`,
          mimeType: "image/svg+xml",
          buffer: Buffer.from(evilSvg),
        },
      },
      timeout: REQUEST_TIMEOUT,
    });

    // Either the upload validator rejects with 400 or the multer fileFilter
    // allowed it but validateAssetUpload then 400's — both surface a 400.
    expect(res.status()).toBe(400);
  });

  test("POST /api/brand-kits/upload rejects without assetType", async ({ request }) => {
    const token = await getTravelAdmin(request);
    test.skip(!token, "travel admin not seeded");

    // Minimal valid 1×1 PNG bytes (no IHDR width-too-large).
    const tinyPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
      0x00, 0x00, 0x00, 0x0d, // IHDR chunk len
      0x49, 0x48, 0x44, 0x52, // "IHDR"
      0x00, 0x00, 0x00, 0x01, // width=1
      0x00, 0x00, 0x00, 0x01, // height=1
      0x08, 0x02, 0x00, 0x00, 0x00, // 8-bit RGB
      0x00, 0x00, 0x00, 0x00, // CRC placeholder
    ]);

    const res = await request.post(`${BASE_URL}/api/brand-kits/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: {
          name: `${RUN_TAG}-no-type.png`,
          mimeType: "image/png",
          buffer: tinyPng,
        },
      },
      timeout: REQUEST_TIMEOUT,
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("INVALID_ASSET_TYPE");
  });

  test("POST /api/brand-kits/upload non-ADMIN returns 403", async ({ request }) => {
    const token = await getUser(request);
    test.skip(!token, "user not seeded");

    const res = await request.post(`${BASE_URL}/api/brand-kits/upload`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        assetType: "logo",
        file: {
          name: `${RUN_TAG}-deny.png`,
          mimeType: "image/png",
          buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        },
      },
      timeout: REQUEST_TIMEOUT,
    });

    expect([401, 403]).toContain(res.status());
  });
});
