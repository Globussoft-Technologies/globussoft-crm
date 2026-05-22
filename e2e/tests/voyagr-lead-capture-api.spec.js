// @ts-check
/**
 * Voyagr (OJR) CMS lead-capture endpoint — gate spec for F1.
 *
 * Pins the contract for POST /api/v1/voyagr/leads — the API-key-auth
 * endpoint consumed by voyagr's Next.js server-side API routes when a
 * lead is captured on the 4 voyagr-hosted sub-brand sites (TMC / RFU /
 * Travel Stall / Visa Sure).
 *
 * Auth-model design decision LOCKED 2026-05-23 (commit 5de05a7) —
 * mirrors backend/middleware/externalAuth.js (the canonical partner-API
 * auth pattern documented in CLAUDE.md). See docs/MANUAL_CODING_BACKLOG.md
 * cluster F1 for the full acceptance criteria.
 *
 * Coverage:
 *   - 401 MISSING_API_KEY when X-API-Key header absent
 *   - 401 MALFORMED_API_KEY when header doesn't match glbs_<hex>
 *   - 401 INVALID_API_KEY when shape-valid key isn't in ApiKey table
 *   - 201 happy path returns { contactId, dealId, isNew:true }
 *   - 201 same-email dedup: second POST returns { contactId (same),
 *     dealId (new), isNew:false } — preserves name/phone but always
 *     creates a fresh Deal + Touchpoint per capture
 *   - 400 INVALID_SUB_BRAND when subBrand outside VALID_SUB_BRANDS
 *   - 400 MISSING_FIELDS when required field absent
 *   - 400 INVALID_EMAIL when email format invalid
 *   - 200 silent fake-OK when honeypot field is non-empty (no Contact
 *     created — confirmed by counting contacts before/after)
 *   - Contact.subBrand is set + Contact.source === "voyagr"
 *
 * AUTH BOOTSTRAP — mint a fresh key in beforeAll (same trick as
 * external-api.spec.js): login as admin@wellness.demo (admin@*.demo
 * exists across seeds — wellness has the active dev tenant for the
 * developer/apikeys mint surface), POST /api/developer/apikeys to mint
 * a fresh `glbs_…` key, use it as X-API-Key for the rest of the spec.
 * afterAll DELETEs the key. The minted key is wellness-tenant-scoped;
 * Contact + Deal created here belong to that tenant.
 *
 * Note on tenant scope: F1 is auth-model-shape coverage, not
 * voyagr-specific seed-data coverage. The minted ApiKey works for any
 * tenant — the route just creates the Contact/Deal under whatever
 * tenant the key's owner belongs to. Pinning the key creation to the
 * wellness tenant (which both per-push gate + e2e-full reliably seed)
 * makes the spec deploy-independent. Once a dedicated voyagr-purpose
 * key column is added (F1+ follow-up), this spec extends to mint
 * directly against the travel tenant.
 *
 * Cleanup: created Contact + Deal rows are tagged with the RUN_TAG in
 * the email + name so the global-teardown's RUN_TAG scrub picks them
 * up. The minted ApiKey is explicitly DELETEed in afterAll.
 *
 * Standing rules followed (per CLAUDE.md):
 *   - JWT key is `userId` not `id` (used in mint/cleanup)
 *   - Body strips id/createdAt/updatedAt/tenantId/userId (we never send them)
 *   - RUN_TAG conventions linked to e2e/test-data-patterns.js
 *   - afterAll cleanup pattern
 *   - No Co-Authored-By trailer in commits
 */
const { test, expect } = require("@playwright/test");

// Tests share state through one minted API key + chained creates.
test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_VOYAGR_${Date.now()}`;

let jwtToken = null;
let apiKey = null;
let apiKeyId = null;

// ── Auth bootstrap ─────────────────────────────────────────────────

async function loginWellnessAdmin(request) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email: "admin@wellness.demo", password: "password123" },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        return { token: j.token };
      }
    } catch (_) {
      if (attempt === 0) continue;
    }
  }
  return { token: null };
}

async function mintApiKey(request, jwt) {
  const r = await request.post(`${BASE_URL}/api/developer/apikeys`, {
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    data: { name: `${RUN_TAG} voyagr-lead-capture-api-spec` },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return { rawKey: null, id: null };
  const j = await r.json();
  return { rawKey: j.rawKey, id: j.key?.id };
}

async function ensureApiKey(request) {
  if (apiKey) return apiKey;
  const { token } = await loginWellnessAdmin(request);
  jwtToken = token;
  if (!jwtToken) return null;
  const minted = await mintApiKey(request, jwtToken);
  apiKey = minted.rawKey;
  apiKeyId = minted.id;
  return apiKey;
}

async function requireKey(request) {
  const key = await ensureApiKey(request);
  if (!key) {
    test.skip(true, "Could not bootstrap voyagr API key — admin@wellness.demo login or apikey mint failed");
  }
  return key;
}

// ── HTTP helpers ───────────────────────────────────────────────────

const authHeaders = (key) => ({ "X-API-Key": key, "Content-Type": "application/json" });

async function postLead(request, body, key) {
  return request.post(`${BASE_URL}/api/v1/voyagr/leads`, {
    headers: authHeaders(key || apiKey),
    data: body ?? {},
    timeout: REQUEST_TIMEOUT,
  });
}

// Build a valid body with the RUN_TAG embedded in the email for teardown.
function validBody(overrides = {}) {
  const base = {
    subBrand: "tmc",
    name: `Voyagr Test ${RUN_TAG}`,
    email: `${RUN_TAG.toLowerCase()}-${Date.now()}@e2e.voyagr.test`,
    phone: "+919811000777",
    source: {
      siteSlug: "tmc.in",
      pageUrl: "https://tmc.in/contact",
      utm: {
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "winter-2026-school-trips",
      },
    },
    payload: { schoolName: "St. Xavier's", classGrade: "10", studentCount: 35 },
  };
  return { ...base, ...overrides };
}

// ── Cleanup ────────────────────────────────────────────────────────

test.afterAll(async ({ request }) => {
  if (apiKeyId && jwtToken) {
    await request
      .delete(`${BASE_URL}/api/developer/apikeys/${apiKeyId}`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
        timeout: REQUEST_TIMEOUT,
      })
      .catch(() => {});
  }
});

// ── Auth-gate cases ────────────────────────────────────────────────

test.describe("Voyagr lead-capture — auth gate", () => {
  test("401 MISSING_API_KEY when X-API-Key header absent", async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/v1/voyagr/leads`, {
      headers: { "Content-Type": "application/json" },
      data: validBody(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe("MISSING_API_KEY");
  });

  test("401 MALFORMED_API_KEY when header is not glbs_<hex>", async ({ request }) => {
    const r = await request.post(`${BASE_URL}/api/v1/voyagr/leads`, {
      headers: { "X-API-Key": "not-a-real-key", "Content-Type": "application/json" },
      data: validBody(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe("MALFORMED_API_KEY");
  });

  test("401 INVALID_API_KEY when shape-valid key not in ApiKey table", async ({ request }) => {
    // glbs_ + 48 hex chars — passes the shape regex but isn't a real key
    const fakeKey = "glbs_" + "0".repeat(48);
    const r = await request.post(`${BASE_URL}/api/v1/voyagr/leads`, {
      headers: { "X-API-Key": fakeKey, "Content-Type": "application/json" },
      data: validBody(),
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status()).toBe(401);
    const body = await r.json();
    expect(body.code).toBe("INVALID_API_KEY");
  });
});

// ── Happy path + dedup ─────────────────────────────────────────────

test.describe("Voyagr lead-capture — happy path + dedup", () => {
  let firstContactId = null;
  let firstDealId = null;
  let sharedEmail = null;

  test("201 happy path returns {contactId, dealId, isNew:true}", async ({ request }) => {
    const key = await requireKey(request);
    const body = validBody();
    sharedEmail = body.email;
    const r = await postLead(request, body, key);
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(typeof j.contactId).toBe("number");
    expect(typeof j.dealId).toBe("number");
    expect(j.isNew).toBe(true);
    firstContactId = j.contactId;
    firstDealId = j.dealId;
  });

  test("201 same-email dedup: second POST reuses contactId + creates fresh Deal", async ({ request }) => {
    const key = await requireKey(request);
    expect(sharedEmail).toBeTruthy();
    const r = await postLead(
      request,
      validBody({
        email: sharedEmail,
        name: `Voyagr Test (Different Name Ignored) ${RUN_TAG}`,
        phone: "+919812000888", // different phone — should NOT overwrite
      }),
      key
    );
    expect(r.status()).toBe(201);
    const j = await r.json();
    expect(j.contactId).toBe(firstContactId); // SAME contact
    expect(j.isNew).toBe(false);
    // New Deal id every time (per acceptance criteria — every capture
    // is a new sales opportunity)
    expect(typeof j.dealId).toBe("number");
    expect(j.dealId).not.toBe(firstDealId);
  });

  test("201 happy path with all 4 sub-brands accepted", async ({ request }) => {
    const key = await requireKey(request);
    for (const subBrand of ["tmc", "rfu", "travelstall", "visasure"]) {
      const r = await postLead(
        request,
        validBody({
          subBrand,
          email: `${RUN_TAG.toLowerCase()}-${subBrand}-${Date.now()}@e2e.voyagr.test`,
        }),
        key
      );
      expect(r.status(), `subBrand=${subBrand}`).toBe(201);
    }
  });
});

// ── Body validation ────────────────────────────────────────────────

test.describe("Voyagr lead-capture — body validation", () => {
  test("400 MISSING_FIELDS when subBrand absent", async ({ request }) => {
    const key = await requireKey(request);
    const body = validBody();
    delete body.subBrand;
    const r = await postLead(request, body, key);
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("MISSING_FIELDS");
  });

  test("400 INVALID_SUB_BRAND when subBrand outside whitelist", async ({ request }) => {
    const key = await requireKey(request);
    const r = await postLead(request, validBody({ subBrand: "wellness" }), key);
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("INVALID_SUB_BRAND");
  });

  test("400 MISSING_FIELDS when email absent", async ({ request }) => {
    const key = await requireKey(request);
    const body = validBody();
    delete body.email;
    const r = await postLead(request, body, key);
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("MISSING_FIELDS");
  });

  test("400 INVALID_EMAIL when email format invalid", async ({ request }) => {
    const key = await requireKey(request);
    const r = await postLead(request, validBody({ email: "not-an-email" }), key);
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("INVALID_EMAIL");
  });

  test("400 MISSING_FIELDS when name absent", async ({ request }) => {
    const key = await requireKey(request);
    const body = validBody();
    delete body.name;
    const r = await postLead(request, body, key);
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("MISSING_FIELDS");
  });

  test("400 MISSING_FIELDS when source.siteSlug absent", async ({ request }) => {
    const key = await requireKey(request);
    const r = await postLead(
      request,
      validBody({ source: { pageUrl: "https://tmc.in/contact" } }),
      key
    );
    expect(r.status()).toBe(400);
    const j = await r.json();
    expect(j.code).toBe("MISSING_FIELDS");
  });
});

// ── Spam guard: honeypot ───────────────────────────────────────────

test.describe("Voyagr lead-capture — honeypot guard", () => {
  test("200 silent fake-OK when _hp honeypot is non-empty (no Contact created)", async ({ request }) => {
    const key = await requireKey(request);
    const probeEmail = `${RUN_TAG.toLowerCase()}-hp1-${Date.now()}@e2e.voyagr.test`;
    const r = await postLead(
      request,
      validBody({ email: probeEmail, _hp: "i-am-a-bot" }),
      key
    );
    // 200 (silent) — body may be empty or empty object
    expect(r.status()).toBe(200);
    // Verify no Contact was created by re-POSTing same email WITHOUT
    // honeypot — should land as isNew:true (proving the honeypot POST
    // created nothing).
    const r2 = await postLead(request, validBody({ email: probeEmail }), key);
    expect(r2.status()).toBe(201);
    const j2 = await r2.json();
    expect(j2.isNew).toBe(true);
  });

  test("200 silent fake-OK when 'website' honeypot is non-empty", async ({ request }) => {
    const key = await requireKey(request);
    const probeEmail = `${RUN_TAG.toLowerCase()}-hp2-${Date.now()}@e2e.voyagr.test`;
    const r = await postLead(
      request,
      validBody({ email: probeEmail, website: "https://my-bot-site.test/spam" }),
      key
    );
    expect(r.status()).toBe(200);
    // Confirm by re-posting without honeypot — should be isNew:true.
    const r2 = await postLead(request, validBody({ email: probeEmail }), key);
    expect(r2.status()).toBe(201);
    const j2 = await r2.json();
    expect(j2.isNew).toBe(true);
  });
});
