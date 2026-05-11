// @ts-check
/**
 * #564 v3.7.3 — wellness consent staff-tablet-handoff + DB BLOB storage.
 *
 * Contract pinned by this spec:
 *   • POST /api/wellness/consents accepts an optional `captureMethod`
 *     ∈ {tablet-handoff, portal-self-serve, imported-pdf}. Unknown values
 *     fall back to the default 'tablet-handoff' (allowlist).
 *   • POST /api/wellness/consents stamps `capturedByUserId` from the JWT
 *     (the staff member who facilitated the capture).
 *   • POST /api/wellness/consents/:id/archive renders the PDF once and
 *     persists the bytes into ConsentForm.signedPdfBlob. Idempotent:
 *     re-archiving an already-archived row returns 200 with
 *     `alreadyArchived: true` and does NOT overwrite the frozen bytes.
 *   • GET /api/wellness/consents/:id/pdf prefers the archived BLOB if
 *     present; otherwise renders on demand from signatureSvg.
 *   • Archive endpoint is RBAC-gated to doctor/professional/admin
 *     (same as POST /consents). Telecaller / helper are 403.
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const REQUEST_TIMEOUT = 30000;

// Real-strokes signature: ~800 chars of base64 (well above the 500-char
// floor enforced by SIGNATURE_REQUIRED).
const FAKE_SIG = 'data:image/png;base64,' + 'A'.repeat(800);

const RUN_TAG = `E2E_C564_${Date.now()}`;

let doctorToken = '';
let telecallerToken = '';
let adminToken = '';
let patientId = null;

async function login(request, email, password) {
  const r = await request.post(`${API}/auth/login`, {
    data: { email, password },
    headers: { 'Content-Type': 'application/json' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(r.ok(), `${email} login must succeed`).toBe(true);
  return (await r.json()).token;
}

const auth = (t) => ({ Authorization: `Bearer ${t}` });

test.describe.configure({ mode: 'serial' });

test.describe('#564 v3.7.3 — consent captureMethod + BLOB archive', () => {
  test.beforeAll(async ({ request }) => {
    doctorToken = await login(request, 'drharsh@enhancedwellness.in', 'password123');
    telecallerToken = await login(request, 'telecaller@enhancedwellness.in', 'password123');
    adminToken = await login(request, 'admin@wellness.demo', 'password123');

    // Create a patient to attach consents to.
    const r = await request.post(`${API}/wellness/patients`, {
      headers: { ...auth(adminToken), 'Content-Type': 'application/json' },
      data: { name: `${RUN_TAG} Patient`, phone: `9${Date.now().toString().slice(-9)}` },
    });
    expect(r.ok(), `patient create body=${await r.text()}`).toBe(true);
    patientId = (await r.json()).id;
  });

  test('POST /consents defaults captureMethod to tablet-handoff when omitted', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} default-cm`,
        signatureSvg: FAKE_SIG,
      },
    });
    expect(r.status()).toBe(201);
    const body = await r.json();
    expect(body.captureMethod).toBe('tablet-handoff');
    expect(body.capturedByUserId).toBeTruthy();
  });

  test('POST /consents accepts explicit captureMethod=tablet-handoff', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} explicit-cm`,
        signatureSvg: FAKE_SIG,
        captureMethod: 'tablet-handoff',
      },
    });
    expect(r.status()).toBe(201);
    expect((await r.json()).captureMethod).toBe('tablet-handoff');
  });

  test('POST /consents accepts portal-self-serve (future flow)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} portal-cm`,
        signatureSvg: FAKE_SIG,
        captureMethod: 'portal-self-serve',
      },
    });
    expect(r.status()).toBe(201);
    expect((await r.json()).captureMethod).toBe('portal-self-serve');
  });

  test('POST /consents falls back to default for unknown captureMethod (allowlist)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} bogus-cm`,
        signatureSvg: FAKE_SIG,
        captureMethod: 'mind-reading',
      },
    });
    expect(r.status()).toBe(201);
    expect((await r.json()).captureMethod).toBe('tablet-handoff');
  });

  test('POST /consents/:id/archive freezes PDF bytes into BLOB', async ({ request }) => {
    // Create a fresh consent to archive.
    const createRes = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} archive-1`,
        signatureSvg: FAKE_SIG,
      },
    });
    expect(createRes.status()).toBe(201);
    const consent = await createRes.json();

    const archiveRes = await request.post(`${API}/wellness/consents/${consent.id}/archive`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
    });
    expect(archiveRes.status()).toBe(200);
    const archiveBody = await archiveRes.json();
    expect(archiveBody.ok).toBe(true);
    expect(archiveBody.alreadyArchived).toBe(false);
    expect(archiveBody.consentId).toBe(consent.id);
    expect(archiveBody.sizeBytes).toBeGreaterThan(0);
    expect(archiveBody.mime).toBe('application/pdf');
  });

  test('POST /consents/:id/archive is idempotent — second call returns alreadyArchived', async ({ request }) => {
    const createRes = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} archive-2`,
        signatureSvg: FAKE_SIG,
      },
    });
    expect(createRes.status()).toBe(201);
    const consent = await createRes.json();

    const first = await request.post(`${API}/wellness/consents/${consent.id}/archive`, {
      headers: auth(doctorToken),
    });
    expect(first.status()).toBe(200);
    expect((await first.json()).alreadyArchived).toBe(false);

    const second = await request.post(`${API}/wellness/consents/${consent.id}/archive`, {
      headers: auth(doctorToken),
    });
    expect(second.status()).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.alreadyArchived).toBe(true);
    expect(secondBody.sizeBytes).toBeGreaterThan(0);
  });

  test('GET /consents/:id/pdf returns frozen BLOB after archive', async ({ request }) => {
    const createRes = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} blob-pdf`,
        signatureSvg: FAKE_SIG,
      },
    });
    const consent = await createRes.json();

    // Archive it.
    await request.post(`${API}/wellness/consents/${consent.id}/archive`, {
      headers: auth(doctorToken),
    });

    // Now download — should be served from BLOB.
    const pdfRes = await request.get(`${API}/wellness/consents/${consent.id}/pdf`, {
      headers: auth(doctorToken),
    });
    expect(pdfRes.status()).toBe(200);
    expect(pdfRes.headers()['content-type']).toContain('application/pdf');
    const body = await pdfRes.body();
    // PDF header bytes — first 4 bytes are %PDF.
    expect(body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('POST /consents/:id/archive 403 for telecaller (WELLNESS_ROLE_FORBIDDEN)', async ({ request }) => {
    // Create as doctor, attempt archive as telecaller.
    const createRes = await request.post(`${API}/wellness/consents`, {
      headers: { ...auth(doctorToken), 'Content-Type': 'application/json' },
      data: {
        patientId,
        templateName: `${RUN_TAG} archive-rbac`,
        signatureSvg: FAKE_SIG,
      },
    });
    const consent = await createRes.json();

    const r = await request.post(`${API}/wellness/consents/${consent.id}/archive`, {
      headers: auth(telecallerToken),
    });
    expect(r.status()).toBe(403);
  });

  test('POST /consents/:id/archive 404 for non-existent id', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents/9999999/archive`, {
      headers: auth(doctorToken),
    });
    expect(r.status()).toBe(404);
  });

  test('POST /consents/:id/archive 400 for invalid id (non-numeric)', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents/not-a-number/archive`, {
      headers: auth(doctorToken),
    });
    expect(r.status()).toBe(400);
  });
});
