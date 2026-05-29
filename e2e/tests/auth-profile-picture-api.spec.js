// @ts-check
/**
 * Profile-picture endpoints on routes/auth.js — gate-level coverage.
 *
 * Surface:
 *   GET    /api/auth/me                  — must include `profilePicture` field
 *   POST   /api/auth/me/profile-picture  — multipart upload → S3, replaces old
 *   DELETE /api/auth/me/profile-picture  — idempotent clear + S3 delete
 *
 * What this spec deterministically pins:
 *   - 401 without Authorization header (both POST + DELETE)
 *   - 400 NO_FILE when POST has no `file` part attached
 *   - 200 + profilePicture:null when DELETE is called against a user with
 *     no picture set (idempotent)
 *   - GET /me surfaces the `profilePicture` field on the envelope (null
 *     when not set — important for the FE upload UI to render the
 *     placeholder vs the avatar correctly)
 *
 * What this spec does NOT exercise here:
 *   - The S3 upload happy path. CI's api_tests env block does not set
 *     AWS_S3_BUCKET_NAME / AWS_ACCESS_KEY_ID — the upload path returns
 *     503 STORAGE_UNCONFIGURED in this environment by design (the route
 *     refuses to silently no-op). Unit tests in
 *     backend/test/routes/auth-profile-picture.test.js cover the upload +
 *     replace + S3-delete happy paths against a mocked s3Service.
 *   - The 415 / 413 / replace-deletes-old-key branches — also unit-tested.
 *
 * Pattern: clones notifications-api.spec.js — login as admin via
 * /api/auth/login, hold the token for the file, run all assertions
 * against admin@globussoft.com. afterAll attempts a DELETE so the demo
 * box state stays clean across runs.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

let adminToken = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
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
    } catch (_) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getAdminToken(request) {
  if (!adminToken) {
    adminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return adminToken;
}

test.afterAll(async ({ request }) => {
  // Best-effort: clear any picture left over from a failed upload-path
  // probe in earlier runs so the spec stays idempotent.
  const token = await getAdminToken(request);
  if (!token) return;
  try {
    await request.delete(`${BASE_URL}/api/auth/me/profile-picture`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
  } catch (_) {
    // Demo unreachable / network blip — afterAll is best-effort.
  }
});

test('GET /api/auth/me — envelope includes profilePicture field', async ({ request }) => {
  const token = await getAdminToken(request);
  test.skip(!token, 'Could not log in — demo unreachable');

  const res = await request.get(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  // The field must EXIST on the envelope (null when not set, string when
  // set). The FE Profile page reads `profile.profilePicture` and the
  // header avatar reads `authUser.profilePicture` — both crash on
  // undefined access if the key is missing.
  expect(body).toHaveProperty('profilePicture');
  expect(body.profilePicture === null || typeof body.profilePicture === 'string').toBe(true);
});

test('POST /api/auth/me/profile-picture — 401 without Authorization', async ({ request }) => {
  const res = await request.post(`${BASE_URL}/api/auth/me/profile-picture`, {
    multipart: {
      file: { name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status()).toBe(401);
});

test('POST /api/auth/me/profile-picture — 400 NO_FILE when no file part attached', async ({ request }) => {
  const token = await getAdminToken(request);
  test.skip(!token, 'Could not log in — demo unreachable');

  const res = await request.post(`${BASE_URL}/api/auth/me/profile-picture`, {
    headers: { Authorization: `Bearer ${token}` },
    multipart: { foo: 'bar' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.code).toBe('NO_FILE');
});

test('DELETE /api/auth/me/profile-picture — 401 without Authorization', async ({ request }) => {
  const res = await request.delete(`${BASE_URL}/api/auth/me/profile-picture`, {
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status()).toBe(401);
});

test('DELETE /api/auth/me/profile-picture — 200 + profilePicture:null when nothing set (idempotent)', async ({ request }) => {
  const token = await getAdminToken(request);
  test.skip(!token, 'Could not log in — demo unreachable');

  // First DELETE call clears whatever might be set. Idempotent: a second
  // back-to-back DELETE must ALSO return 200 with profilePicture:null —
  // the FE Profile page calls this on Remove + the user might double-tap.
  const first = await request.delete(`${BASE_URL}/api/auth/me/profile-picture`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
  expect(first.status()).toBe(200);
  const firstBody = await first.json();
  expect(firstBody.profilePicture).toBeNull();

  const second = await request.delete(`${BASE_URL}/api/auth/me/profile-picture`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: REQUEST_TIMEOUT,
  });
  expect(second.status()).toBe(200);
  const secondBody = await second.json();
  expect(secondBody.profilePicture).toBeNull();
});
