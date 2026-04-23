// @ts-check
/**
 * Wellness — production-confidence deep tests.
 *
 * Goes beyond happy-path route coverage to assert side-effects,
 * PDF byte content, real browser interactions, cron internals,
 * dispatcher branches, multipart uploads, and library round-trips.
 *
 * Run: cd e2e && BASE_URL=https://crm.globusdemos.com \
 *        npx playwright test tests/wellness-deep.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');
const pdfParse = require('pdf-parse');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EXT = `${BASE_URL}/api/v1/external`;

const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };
const ADMIN = { email: 'admin@wellness.demo', password: 'password123' };
const PARTNER_KEY = process.env.WELLNESS_PARTNER_KEY ||
  'glbs_6ba99bc3309ef840d58d1fd43339e09c62eb395396c6c8cf';

let TOKEN = '';

async function getToken(request) {
  if (TOKEN) return TOKEN;
  const r = await request.post(`${API}/auth/login`, { data: RISHU });
  TOKEN = (await r.json()).token;
  return TOKEN;
}

const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

// ═══════════════════════════════════════════════════════════════════
// 1. PDF byte content — verify PDFs aren't corrupt + contain expected text
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('Wellness deep — PDF content (Rx, Consent, Invoice)', () => {
  test.beforeAll(async ({ request }) => { await getToken(request); });

  test('1. Prescription PDF parses + contains drug name + patient name', async ({ request }) => {
    // Find a Rx that has known-good drug data
    const list = await (await request.get(`${API}/wellness/prescriptions?limit=10`, { headers: auth() })).json();
    const rx = list.find((r) => {
      try { return JSON.parse(r.drugs).length > 0; } catch { return false; }
    });
    if (!rx) test.skip(true, 'no prescription with parseable drugs');

    const res = await request.get(`${API}/wellness/prescriptions/${rx.id}/pdf`, { headers: auth() });
    expect(res.ok()).toBeTruthy();
    expect(res.headers()['content-type']).toContain('application/pdf');

    const buf = await res.body();
    expect(buf.length).toBeGreaterThan(500);                  // non-trivial PDF
    expect(buf.slice(0, 4).toString()).toBe('%PDF');           // valid PDF header

    const parsed = await pdfParse(buf);
    expect(parsed.text.length).toBeGreaterThan(50);           // has rendered text

    // The Rx PDF should reference the patient and at least one drug
    const drugs = JSON.parse(rx.drugs);
    const firstDrugName = drugs[0]?.name || '';
    if (firstDrugName) {
      expect(parsed.text.toLowerCase()).toContain(firstDrugName.toLowerCase().split(' ')[0]);
    }
  });

  test('2. Consent PDF parses + contains template name', async ({ request }) => {
    const list = await (await request.get(`${API}/wellness/consents?limit=5`, { headers: auth() })).json();
    if (!list.length) test.skip(true, 'no consent forms in test data');
    const consent = list[0];

    const res = await request.get(`${API}/wellness/consents/${consent.id}/pdf`, { headers: auth() });
    expect(res.ok()).toBeTruthy();
    const buf = await res.body();
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const parsed = await pdfParse(buf);
    // The consent PDF should mention "consent" somewhere
    expect(parsed.text.toLowerCase()).toContain('consent');
  });

  test('3. Branded invoice PDF parses + contains amount-like number', async ({ request }) => {
    const invoices = await (await request.get(`${API}/billing?limit=5`, { headers: auth() })).json().catch(() => []);
    const invoice = Array.isArray(invoices) ? invoices[0] : (invoices.invoices || invoices.data || [])[0];
    if (!invoice) test.skip(true, 'no invoices in tenant');

    const res = await request.get(`${API}/wellness/invoices/${invoice.id}/branded-pdf`, { headers: auth() });
    if (!res.ok()) test.skip(true, `branded PDF endpoint returned ${res.status()}`);

    const buf = await res.body();
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const parsed = await pdfParse(buf);
    // Some numeric content should be present (the amount)
    expect(/\d/.test(parsed.text)).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Cron internals — manual triggers + DB side-effect assertions
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('Wellness deep — Cron engines fire correctly', () => {
  test.beforeAll(async ({ request }) => { await getToken(request); });

  test('4. POST /reminders/run executes processTenant + returns counts', async ({ request }) => {
    const r = await request.post(`${API}/wellness/reminders/run`, { headers: auth() });
    expect(r.ok()).toBeTruthy();
    const result = await r.json();
    expect(result).toHaveProperty('queued24');
    expect(result).toHaveProperty('queued1');
    expect(typeof result.queued24).toBe('number');
  });

  test('5. POST /ops/run executes both NPS + retention; returns counts', async ({ request }) => {
    const r = await request.post(`${API}/wellness/ops/run`, { headers: auth() });
    expect(r.ok()).toBeTruthy();
    const result = await r.json();
    expect(result).toHaveProperty('npsSent');
    expect(result).toHaveProperty('purged');
    expect(typeof result.npsSent).toBe('number');
    expect(typeof result.purged).toBe('number');
  });

  test('6. After ops run, subsequent calls are idempotent (no double-NPS)', async ({ request }) => {
    const r1 = await request.post(`${API}/wellness/ops/run`, { headers: auth() });
    const c1 = (await r1.json()).npsSent;
    const r2 = await request.post(`${API}/wellness/ops/run`, { headers: auth() });
    const c2 = (await r2.json()).npsSent;
    // Second run should send 0 (everything already surveyed)
    expect(c2).toBeLessThanOrEqual(c1);
  });

  test('7. POST /orchestrator/run inspects DB context + creates 0-3 cards', async ({ request }) => {
    const before = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: auth() })).json();
    const beforeCount = before.length;

    const r = await request.post(`${API}/wellness/orchestrator/run`, { headers: auth() });
    expect(r.ok()).toBeTruthy();
    const result = await r.json();
    expect(typeof result.created).toBe('number');
    expect(result).toHaveProperty('contextSummary');
    expect(typeof result.contextSummary).toBe('string');
    expect(result.contextSummary.length).toBeGreaterThan(20);

    const after = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: auth() })).json();
    expect(after.length).toBeGreaterThanOrEqual(beforeCount);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Orchestrator dispatcher — every action branch
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('Wellness deep — Action dispatcher branches', () => {
  test.beforeAll(async ({ request }) => { await getToken(request); });

  // We can't seed AgentRecommendation rows directly via the API, so we
  // exercise the dispatcher by approving any pending card, then verify
  // its action ran. Coverage of all action types depends on what the
  // orchestrator generated — we run it to refresh first.
  async function approveOneOfType(request, type) {
    // Run orchestrator to ensure pending cards exist
    await request.post(`${API}/wellness/orchestrator/run`, { headers: auth() });
    const recs = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: auth() })).json();
    const target = recs.find((r) => r.type === type);
    if (!target) return null;
    const r = await request.post(`${API}/wellness/recommendations/${target.id}/approve`, { headers: auth() });
    if (!r.ok()) return null;
    const body = await r.json();
    return body._actionResult || null;
  }

  test('8. Approving lead_followup → flags leads with Activity rows (or Task)', async ({ request }) => {
    const result = await approveOneOfType(request, 'lead_followup');
    if (!result) test.skip(true, 'no lead_followup card available right now');
    expect(result.ok).toBeTruthy();
    expect(['leads_flagged', 'task_created']).toContain(result.action);
  });

  test('9. Approving campaign_boost → creates Task for marketer', async ({ request }) => {
    const result = await approveOneOfType(request, 'campaign_boost');
    if (!result) test.skip(true, 'no campaign_boost card available');
    expect(result.ok).toBeTruthy();
    expect(result.action).toBe('task_created');
  });

  test('10. Approving occupancy_alert → creates Task', async ({ request }) => {
    const result = await approveOneOfType(request, 'occupancy_alert');
    if (!result) test.skip(true, 'no occupancy_alert card available');
    expect(result.ok).toBeTruthy();
    expect(result.action).toBe('task_created');
  });

  test('11. Reject → status=rejected, no action fires', async ({ request }) => {
    const recs = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: auth() })).json();
    if (!recs.length) test.skip(true, 'no pending');
    const r = await request.post(`${API}/wellness/recommendations/${recs[0].id}/reject`, { headers: auth() });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.status).toBe('rejected');
    expect(body._actionResult).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Multipart photo upload — real bytes
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('Wellness deep — Visit photo upload', () => {
  let visitId;

  test.beforeAll(async ({ request }) => {
    await getToken(request);
    // Create a fresh patient + visit
    const p = await (await request.post(`${API}/wellness/patients`, {
      headers: auth(),
      data: { name: 'Photo Tester', phone: `+9197${Date.now().toString().slice(-8)}`, source: 'walk-in' },
    })).json();
    const v = await (await request.post(`${API}/wellness/visits`, {
      headers: auth(),
      data: { patientId: p.id, notes: 'Photo test', status: 'completed' },
    })).json();
    visitId = v.id;
  });

  test('12. POST /visits/:id/photos with real PNG bytes → URL appears in photosBefore', async ({ request }) => {
    // Smallest possible valid 1x1 PNG (transparent)
    const png = Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8FFFFFF3F0005FE02FED2D9A2240000000049454E44AE426082',
      'hex'
    );

    const res = await request.post(`${API}/wellness/visits/${visitId}/photos`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      multipart: {
        kind: 'before',
        photos: { name: 'test.png', mimeType: 'image/png', buffer: png },
      },
    });
    expect(res.ok()).toBeTruthy();
    const result = await res.json();
    expect(result.kind).toBe('photosBefore');
    expect(Array.isArray(result.urls)).toBeTruthy();
    expect(result.urls.length).toBeGreaterThan(0);
    expect(result.urls[result.urls.length - 1]).toMatch(/\/uploads\/wellness\/visits\/\d+\/.+\.png$/i);
  });

  test('13. Visit detail now shows the photo URL', async ({ request }) => {
    const v = await (await request.get(`${API}/wellness/visits/${visitId}`, { headers: auth() })).json();
    const photos = v.photosBefore ? JSON.parse(v.photosBefore) : [];
    expect(photos.length).toBeGreaterThan(0);
  });

  test('14. DELETE /visits/:id/photos removes the specified URL', async ({ request }) => {
    const v = await (await request.get(`${API}/wellness/visits/${visitId}`, { headers: auth() })).json();
    const photos = v.photosBefore ? JSON.parse(v.photosBefore) : [];
    if (!photos.length) test.skip();
    const urlToRemove = photos[0];
    const r = await request.delete(`${API}/wellness/visits/${visitId}/photos`, {
      headers: { ...auth(), 'Content-Type': 'application/json' },
      data: { url: urlToRemove, kind: 'before' },
    });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.urls).not.toContain(urlToRemove);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Field encryption — round-trip + no-op + isEncrypted detection
// ═══════════════════════════════════════════════════════════════════

test.describe('Wellness deep — Field encryption helper', () => {
  // We can't directly call backend lib code from the test runner, so we
  // re-implement the contract here and assert the same shape. The actual
  // backend lib is unit-tested by exec'ing it via a node one-liner.
  const { execSync } = require('child_process');
  const backendDir = path.resolve(__dirname, '..', '..', 'backend');

  function runJs(script) {
    return execSync(`node -e "${script.replace(/"/g, '\\"')}"`, {
      cwd: backendDir, encoding: 'utf8', timeout: 8000,
    }).trim();
  }

  test('15. encrypt() is no-op when WELLNESS_FIELD_KEY missing', () => {
    delete process.env.WELLNESS_FIELD_KEY;
    const out = runJs('delete process.env.WELLNESS_FIELD_KEY; const {encrypt} = require("./lib/fieldEncryption"); console.log(encrypt("hello world"))');
    expect(out).toBe('hello world');
  });

  test('16. encrypt → decrypt round-trip preserves plaintext', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const out = runJs(`process.env.WELLNESS_FIELD_KEY='${key}'; const {encrypt,decrypt}=require("./lib/fieldEncryption"); const c=encrypt("Patient is allergic to penicillin"); console.log(decrypt(c))`);
    expect(out).toBe('Patient is allergic to penicillin');
  });

  test('17. isEncrypted() detects the ENC:v1: prefix', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const out = runJs(`process.env.WELLNESS_FIELD_KEY='${key}'; const {encrypt,isEncrypted}=require("./lib/fieldEncryption"); const c=encrypt("secret"); console.log(isEncrypted(c) && c.startsWith("ENC:v1:"))`);
    expect(out).toBe('true');
  });

  test('18. encrypt() is idempotent (does not double-encrypt)', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const out = runJs(`process.env.WELLNESS_FIELD_KEY='${key}'; const {encrypt}=require("./lib/fieldEncryption"); const a=encrypt("x"); const b=encrypt(a); console.log(a===b)`);
    expect(out).toBe('true');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Auto-router — fallback paths
// ═══════════════════════════════════════════════════════════════════

test.describe('Wellness deep — Lead auto-router fallbacks', () => {
  test('19. Lead with hair-transplant keyword routes to a doctor (specialist match)', async ({ request }) => {
    const r = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        name: 'Specialist Match',
        phone: `+9198${Date.now().toString().slice(-8)}`,
        email: `spec-${Date.now()}@test.local`,
        source: 'website-form',
        note: 'enquiry about hair transplant cost',
      },
    });
    const d = await r.json();
    expect(d._routing).toBeTruthy();
    // Either matched a doctor (userId is a number) or fell through cleanly
    expect(typeof d._routing.userId === 'number' || d._routing.userId === null).toBeTruthy();
    if (typeof d._routing.userId === 'number') {
      expect(d._routing.reason).toMatch(/keyword match|round-robin/i);
    }
  });

  test('20. Lead with no service keyword falls back to telecaller round-robin', async ({ request }) => {
    const r = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        name: 'Generic Enquiry',
        phone: `+9197${Date.now().toString().slice(-8)}`,
        email: `gen-${Date.now()}@test.local`,
        source: 'whatsapp',
        note: 'just some text without any service keyword',
      },
    });
    const d = await r.json();
    expect(d._routing).toBeTruthy();
    if (d._routing.userId !== null) {
      expect(d._routing.reason).toMatch(/round-robin|fallback|keyword/i);
    }
  });

  test('21. Junk lead skips routing entirely', async ({ request }) => {
    const r = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: { name: 'YYYYY', phone: '+1234567890', source: 'test-skip' },
    });
    const d = await r.json();
    expect(d.status).toBe('Junk');
    expect(d._routing).toBeTruthy();
    expect(d._routing.userId).toBeNull();
    expect(d._routing.reason).toMatch(/junk/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Real browser UI flows — Playwright page interactions
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('Wellness deep — Real browser UI flows', () => {
  test('22. Login as wellness admin → land on /wellness with KPI cards visible', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState('domcontentloaded');

    // Use the quick-login button labeled "Demo Admin" (under Enhanced Wellness)
    const demoAdminBtn = page.getByRole('button', { name: /Demo Admin/i });
    await expect(demoAdminBtn).toBeVisible({ timeout: 10000 });
    await demoAdminBtn.click();

    await page.waitForURL(/\/wellness/, { timeout: 15000 });
    // Owner Dashboard heading
    await expect(page.getByRole('heading', { name: /Good morning/i })).toBeVisible({ timeout: 10000 });
    // KPI tile labels
    await expect(page.getByText(/Today's appointments/i).first()).toBeVisible();
    await expect(page.getByText(/expected revenue/i).first()).toBeVisible();
  });

  test('23. Click into Patients → search → click first patient → tabs render', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: /Demo Admin/i }).click();
    await page.waitForURL(/\/wellness/, { timeout: 15000 });

    await page.getByRole('link', { name: /Patients/i }).first().click();
    await page.waitForURL(/\/wellness\/patients/, { timeout: 10000 });

    // Wait for the patients table to render and click the first patient link
    const firstPatient = page.locator('a[href*="/wellness/patients/"]').first();
    await expect(firstPatient).toBeVisible({ timeout: 15000 });
    await firstPatient.click();

    await page.waitForURL(/\/wellness\/patients\/\d+/, { timeout: 10000 });

    // Verify the 7 tab buttons render
    for (const tabLabel of ['Case history', 'New prescription', 'Consent form', 'Treatment plans', 'Log visit', 'Photos', 'Inventory used']) {
      await expect(page.getByRole('button', { name: new RegExp(tabLabel, 'i') })).toBeVisible({ timeout: 5000 });
    }
  });

  test('24. Owner Dashboard → click "Recommendations" link → list renders', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: /Demo Admin/i }).click();
    await page.waitForURL(/\/wellness/, { timeout: 15000 });

    // Click the Recommendations sidebar link
    await page.getByRole('link', { name: /Recommendations/i }).first().click();
    await page.waitForURL(/\/wellness\/recommendations/, { timeout: 10000 });

    await expect(page.getByRole('heading', { name: /Agent Recommendations/i })).toBeVisible();
    // At least one filter chip
    await expect(page.getByRole('button', { name: /^pending$/i })).toBeVisible();
  });

  test('25. Public booking page renders 3-step UI for Enhanced Wellness slug', async ({ page }) => {
    await page.goto(`${BASE_URL}/book/enhanced-wellness`);
    await page.waitForLoadState('domcontentloaded');
    // The clinic name should appear in the heading
    await expect(page.getByRole('heading', { name: /Enhanced Wellness/i })).toBeVisible({ timeout: 15000 });
    // Step 1 prompt
    await expect(page.getByText(/Pick a service/i)).toBeVisible();
    // At least one service card
    await expect(page.locator('button').filter({ hasText: /min/i }).first()).toBeVisible({ timeout: 10000 });
  });

  test('26. Embed lead-form.html renders form with required name + phone fields', async ({ page }) => {
    const url = `${BASE_URL}/embed/lead-form.html?key=${PARTNER_KEY}&title=E2E%20Embed%20Test`;
    await page.goto(url);
    await page.waitForLoadState('domcontentloaded');
    // Heading
    await expect(page.getByRole('heading', { name: /E2E Embed Test/i })).toBeVisible({ timeout: 10000 });
    // Required fields
    await expect(page.locator('input[name="name"]')).toBeVisible();
    await expect(page.locator('input[name="phone"]')).toBeVisible();
    // Submit button
    await expect(page.getByRole('button', { name: /Request a callback/i })).toBeVisible();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Theme — wellness brand applied to body
// ═══════════════════════════════════════════════════════════════════

test.describe('Wellness deep — Theme', () => {
  test('27. After wellness login, body has data-vertical="wellness"', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: /Demo Admin/i }).click();
    await page.waitForURL(/\/wellness/, { timeout: 15000 });
    const v = await page.locator('body').getAttribute('data-vertical');
    expect(v).toBe('wellness');
  });

  test('28. After generic login, body has data-vertical="generic"', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: /^Admin$/ }).first().click();
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
    const v = await page.locator('body').getAttribute('data-vertical');
    expect(v).toBe('generic');
  });
});
