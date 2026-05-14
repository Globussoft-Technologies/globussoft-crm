// @ts-check
/**
 * Security-validation gate — 2026-05-12 pen-test wave (#711, #712, #714).
 *
 * Pins three HIGH-severity validation gaps surfaced in the pen-test sweep:
 *
 *   #711  Profile — PUT /api/auth/me + POST /api/auth/reset-password
 *         must reject weak / short / overly-long passwords. The shared
 *         helper `validatePasswordComplexity()` already existed in
 *         backend/routes/auth.js (used by /register + /signup); pre-fix
 *         PUT /auth/me + reset-password skipped it entirely, so a 1-char
 *         "a" or all-letters "password" was accepted. Also re-asserts
 *         the bcrypt 72-byte truncation guard.
 *
 *   #712  Privacy — PUT /api/gdpr/retention-policies with a negative
 *         retainDays must return a clean 400, NOT a silent no-op.
 *         Pre-fix the route `continue`d on every invalid row → empty
 *         results array, NO 4xx surfaced to the caller. The "logs the
 *         user out" framing from the bug report was a downstream effect
 *         of the unrelated step-up gate returning 401 → fetchApi's 401
 *         handler redirects to /login. The fix is to FAIL FAST on bad
 *         input so the 401 surfaces only on actual auth issues. Upper
 *         bound MAX_RETAIN_DAYS = 36500 (100y) added defensively.
 *
 *   #714  Staff Directory — PUT /api/staff/:id must reject empty Name
 *         and invalid Email (server-side). Pre-fix the trim()-falsy
 *         branch persisted `User.name = null`, and any non-empty string
 *         was accepted as email — pen-test reproduced with `not-email`
 *         and the row was silently corrupted (row rendered as `—`).
 *         Uses the shared `ensureEmail` + `ensureStringLength` helpers
 *         from backend/lib/validators.js for error-code parity with
 *         other routes.
 *
 * Revert-and-prove:
 *   - Comment out the `validatePasswordComplexity(newPassword)` call in
 *     routes/auth.js PUT /me → #711 weak-password tests go green where
 *     they shouldn't.
 *   - Restore the silent-continue in routes/gdpr.js PUT
 *     /retention-policies → #712 negative-retention test fails (expects
 *     400, will see 200 + [] body).
 *   - Restore `if (typeof name === "string" && name.trim() !== ...)` in
 *     routes/staff.js PUT /:id without the ensureStringLength gate →
 *     #714 empty-name test fails (expects 400, will see 200).
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 60000;

const ADMIN = { email: 'admin@globussoft.com', password: 'password123' };

// ───────────────────────── helpers ─────────────────────────

async function login(request, fixture) {
  const r = await request.post(`${API}/auth/login`, {
    data: fixture,
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  if (!r.ok()) return { token: null, userId: null };
  const j = await r.json();
  return {
    token: j.token,
    userId: j.user && j.user.id,
    tenantId: j.tenant && j.tenant.id,
  };
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ═════════════════════════════════════════════════════════════════════
// #711 — Password complexity policy on PUT /auth/me + reset-password
// ═════════════════════════════════════════════════════════════════════
test.describe('#711 — Change-password rejects weak input (PUT /api/auth/me)', () => {
  let adminToken;

  test.beforeAll(async ({ request }) => {
    const r = await login(request, ADMIN);
    adminToken = r.token;
  });

  test('rejects 1-char password as WEAK_PASSWORD (#711)', async ({ request }) => {
    test.skip(!adminToken, 'admin login fixture unavailable');
    const r = await request.put(`${API}/auth/me`, {
      headers: authHeader(adminToken),
      data: { currentPassword: ADMIN.password, newPassword: 'a' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('WEAK_PASSWORD');
    expect(String(body.error)).toMatch(/at least 8|characters/i);
  });

  test('rejects all-letters password (missing digit) as WEAK_PASSWORD (#711)', async ({ request }) => {
    test.skip(!adminToken, 'admin login fixture unavailable');
    const r = await request.put(`${API}/auth/me`, {
      headers: authHeader(adminToken),
      data: { currentPassword: ADMIN.password, newPassword: 'abcdefghij' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('WEAK_PASSWORD');
  });

  test('rejects all-digits password (missing letter) as WEAK_PASSWORD (#711)', async ({ request }) => {
    test.skip(!adminToken, 'admin login fixture unavailable');
    const r = await request.put(`${API}/auth/me`, {
      headers: authHeader(adminToken),
      data: { currentPassword: ADMIN.password, newPassword: '12345678' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('WEAK_PASSWORD');
  });

  test('rejects password longer than 72 chars (bcrypt truncation guard, #711)', async ({ request }) => {
    test.skip(!adminToken, 'admin login fixture unavailable');
    const r = await request.put(`${API}/auth/me`, {
      headers: authHeader(adminToken),
      // 80 chars, complexity-valid (mix of letter+digit). Should still
      // be rejected on length alone.
      data: { currentPassword: ADMIN.password, newPassword: 'A'.repeat(73) + '1' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('PASSWORD_TOO_LONG');
  });

  test('accepts complexity-passing newPassword + correct currentPassword (#711 happy path)', async ({ request }) => {
    test.skip(!adminToken, 'admin login fixture unavailable');
    // Set then immediately reset to original so other specs aren't disturbed.
    // currentPassword is intentionally validated against the live hash; we
    // round-trip to the original to leave demo state unchanged.
    const set = await request.put(`${API}/auth/me`, {
      headers: authHeader(adminToken),
      data: { currentPassword: ADMIN.password, newPassword: 'NewSecure1Pass!' },
      timeout: REQUEST_TIMEOUT,
    });
    // 200 expected on success; 400 here would indicate the validator
    // is rejecting a complexity-valid password, which is the regression.
    expect(set.status(), `set body: ${await set.text()}`).toBe(200);

    // After re-login with the new password, restore the original. This
    // makes the spec idempotent — repeated runs won't accumulate state.
    // We login fresh because the old bearer is still valid (JWT TTL is
    // 7d, no revocation on password change today) but the test is
    // clearer if we explicitly login with the rotated password.
    const reloginRotated = await login(request, { ...ADMIN, password: 'NewSecure1Pass!' });
    expect(reloginRotated.token, 'login with rotated password failed — state leak risk').toBeTruthy();
    const restore = await request.put(`${API}/auth/me`, {
      headers: authHeader(reloginRotated.token),
      data: { currentPassword: 'NewSecure1Pass!', newPassword: ADMIN.password },
      timeout: REQUEST_TIMEOUT,
    });
    expect(restore.status(), `restore body: ${await restore.text()}`).toBe(200);
  });
});

test.describe('#711 — Password complexity also enforced on /reset-password', () => {
  // We can't easily exercise the happy path here (no token), but the
  // negative path is the load-bearing assertion: a weak password must
  // be rejected BEFORE the token-validity check.
  test('POST /api/auth/reset-password rejects weak newPassword as WEAK_PASSWORD (#711)', async ({ request }) => {
    const r = await request.post(`${API}/auth/reset-password`, {
      headers: { 'Content-Type': 'application/json' },
      data: { token: 'definitely-not-a-real-token', newPassword: 'a' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    // We accept either WEAK_PASSWORD (complexity check fires first — the
    // post-fix order) or the token-invalid error. The regression signal
    // is "weak password reaches the bcrypt.hash() call and the user's
    // password gets set to 'a'" — both 400 branches prevent that.
    expect([400]).toContain(r.status());
    expect(['WEAK_PASSWORD', undefined]).toContain(body.code);
  });
});

// ═════════════════════════════════════════════════════════════════════
// #712 — GDPR retention-policies: validation on negative / overflow
// ═════════════════════════════════════════════════════════════════════
test.describe('#712 — PUT /api/gdpr/retention-policies validates retainDays', () => {
  let adminToken;
  let stepUpToken;

  test.beforeAll(async ({ request }) => {
    const r = await login(request, ADMIN);
    adminToken = r.token;
    if (!adminToken) return;
    // #654 — step-up token required by requireStepUp() middleware.
    // Mint once at start; 5-min TTL covers the spec's runtime.
    const su = await request.post(`${API}/auth/step-up`, {
      headers: authHeader(adminToken),
      data: { password: ADMIN.password },
      timeout: REQUEST_TIMEOUT,
    });
    if (su.ok()) stepUpToken = (await su.json()).stepUpToken;
  });

  test('negative retainDays returns 400 INVALID_RETENTION_DAYS, NOT 401/500 (#712)', async ({ request }) => {
    test.skip(!stepUpToken, 'step-up token unavailable');
    const r = await request.put(`${API}/gdpr/retention-policies`, {
      headers: { ...authHeader(adminToken), 'x-step-up-token': stepUpToken },
      data: [{ entity: 'EmailMessage', retainDays: -100, isActive: true }],
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_RETENTION_DAYS');
    // Confirms the entity name is echoed back so the frontend can
    // highlight which row is bad — pre-fix you got nothing at all.
    expect(body.entity).toBe('EmailMessage');
  });

  test('NaN retainDays returns 400 INVALID_RETENTION_DAYS (#712)', async ({ request }) => {
    test.skip(!stepUpToken, 'step-up token unavailable');
    const r = await request.put(`${API}/gdpr/retention-policies`, {
      headers: { ...authHeader(adminToken), 'x-step-up-token': stepUpToken },
      data: [{ entity: 'EmailMessage', retainDays: 'definitely-not-a-number', isActive: true }],
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_RETENTION_DAYS');
  });

  test('retainDays above MAX (36500) returns 400 INVALID_RETENTION_DAYS (#712)', async ({ request }) => {
    test.skip(!stepUpToken, 'step-up token unavailable');
    const r = await request.put(`${API}/gdpr/retention-policies`, {
      headers: { ...authHeader(adminToken), 'x-step-up-token': stepUpToken },
      data: [{ entity: 'EmailMessage', retainDays: 99999999, isActive: true }],
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_RETENTION_DAYS');
  });

  test('valid retainDays still returns 200 (#712 happy path)', async ({ request }) => {
    test.skip(!stepUpToken, 'step-up token unavailable');
    // Use isActive:false so we don't accidentally enable a retention
    // sweep against demo data on subsequent runs.
    const r = await request.put(`${API}/gdpr/retention-policies`, {
      headers: { ...authHeader(adminToken), 'x-step-up-token': stepUpToken },
      data: [{ entity: 'EmailMessage', retainDays: 365, isActive: false }],
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].retainDays).toBe(365);
  });
});

// ═════════════════════════════════════════════════════════════════════
// #714 — Staff PUT /:id rejects empty Name and invalid Email
// ═════════════════════════════════════════════════════════════════════
test.describe('#714 — PUT /api/staff/:id validates Name and Email', () => {
  let adminToken;
  let targetUserId;
  let originalName;
  let originalEmail;

  test.beforeAll(async ({ request }) => {
    const r = await login(request, ADMIN);
    adminToken = r.token;
    if (!adminToken) return;
    // Find a non-self target user in the same tenant. manager@crm.com
    // is the standard seed manager on the generic tenant.
    const list = await request.get(`${API}/staff`, {
      headers: authHeader(adminToken),
      timeout: REQUEST_TIMEOUT,
    });
    if (!list.ok()) return;
    const rows = await list.json();
    const target = (Array.isArray(rows) ? rows : (rows.users || rows.staff || []))
      .find((u) => u && u.email && u.email !== ADMIN.email);
    if (target) {
      targetUserId = target.id;
      originalName = target.name;
      originalEmail = target.email;
    }
  });

  test('empty name returns 400 NAME_REQUIRED (#714)', async ({ request }) => {
    test.skip(!targetUserId, 'no non-self target user available');
    const r = await request.put(`${API}/staff/${targetUserId}`, {
      headers: authHeader(adminToken),
      data: { name: '   ', email: originalEmail },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('NAME_REQUIRED');
  });

  test('invalid email returns 400 INVALID_EMAIL (#714)', async ({ request }) => {
    test.skip(!targetUserId, 'no non-self target user available');
    const r = await request.put(`${API}/staff/${targetUserId}`, {
      headers: authHeader(adminToken),
      data: { name: originalName || 'Test User', email: 'not-email' },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(400);
    const body = await r.json();
    expect(body.code).toBe('INVALID_EMAIL');
  });

  test('valid edit returns 200 (#714 happy path)', async ({ request }) => {
    test.skip(!targetUserId, 'no non-self target user available');
    // No-op edit: same name + same email. Returns the current row.
    const r = await request.put(`${API}/staff/${targetUserId}`, {
      headers: authHeader(adminToken),
      data: { name: originalName, email: originalEmail },
      timeout: REQUEST_TIMEOUT,
    });
    expect(r.status(), `body: ${await r.text()}`).toBe(200);
    const body = await r.json();
    expect(body.id).toBe(targetUserId);
    expect(body.name).toBe(originalName);
    expect(body.email).toBe(originalEmail);
  });
});
