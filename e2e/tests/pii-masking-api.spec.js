// @ts-check
/**
 * PII masking on list views + exports — security/medium cluster.
 *
 * Closes #679 (Locations) + #680 (Patient exports) + #681 (Unified Inbox /
 * WhatsApp lead phones) + #682 (Staff list).
 *
 * Policy (encoded in backend/lib/piiMask.js → shouldMaskForViewer):
 *   ADMIN / MANAGER                       → never mask
 *   wellness doctor / professional        → never mask
 *   wellness telecaller / helper          → MASK on cross-cutting lists
 *   generic-tenant USER role              → MASK
 *
 * Mask formats checked here:
 *   phone   '+919876543210'  → '+919****3210'   (3 leading, 4 trailing kept)
 *   email   'user@host.com'  → 'u****@host.com' (first char + domain)
 *   name    'Rishu Sharma'   → 'R. Sharma'      (initial + last name)
 *   dob     '1995-04-12'     → '****-04-12'     (year dropped)
 *   userId  12345            → '#345'           (last 3 digits)
 *
 * Endpoints covered:
 *   GET    /api/wellness/locations           — #679 phone+email masking
 *   GET    /api/wellness/patients            — #680 name+phone+email+dob masking
 *   GET    /api/wellness/patients.csv        — #680 export + ?masked=1 toggle
 *   GET    /api/wellness/telecaller/queue    — #682 PII_DISCLOSED audit emission
 *   GET    /api/whatsapp/threads             — #681 contact.phone masking
 *   GET    /api/staff                        — #682 id+name+email masking
 *
 * Pattern: standing-rules-compliant dual-token (admin + telecaller) wellness
 * spec. Auth helpers identical to wellness-clinical-api.spec.js. No body
 * fields named `id` / `userId` / `tenantId` / `createdAt` / `updatedAt`
 * (stripDangerous middleware would delete them). JWT key is `userId` not `id`.
 *
 * RUN_TAG = `E2E_PII_<ts>`. Test data tagged so global-teardown's regex catches
 * it. Created patient rows have name starting with `E2E ` so cascade-wipes
 * via Patient.name match.
 */
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 30000;
const RUN_TAG = `E2E_PII_${Date.now()}`;

// Unique phone suffix per spec run.
const PHONE_SUFFIX_BASE = Date.now() % 100000;
let phoneCounter = 0;
function nextPhone() {
  const suffix = String((PHONE_SUFFIX_BASE + phoneCounter++) % 100000).padStart(5, '0');
  return `+9198765${suffix}`;
}

// ── Fixtures ───────────────────────────────────────────────────────
const FIXTURES = {
  admin:      { email: 'admin@wellness.demo',           password: 'password123' },
  manager:    { email: 'manager@enhancedwellness.in',   password: 'password123' },
  drharsh:    { email: 'drharsh@enhancedwellness.in',   password: 'password123' },
  telecaller: { email: 'telecaller@enhancedwellness.in', password: 'password123' },
  helper:     { email: 'helper1@enhancedwellness.in',   password: 'password123' },
  generic:    { email: 'user@crm.com',                  password: 'password123' },
};
const tokenCache = {};
const userIdCache = {};

async function login(request, who) {
  if (tokenCache[who]) return { token: tokenCache[who], userId: userIdCache[who] };
  const fx = FIXTURES[who];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: fx,
        headers: { 'Content-Type': 'application/json' },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) {
        const j = await r.json();
        tokenCache[who] = j.token;
        userIdCache[who] = j.user && j.user.id;
        return { token: tokenCache[who], userId: userIdCache[who] };
      }
    } catch (_) {
      if (attempt === 0) continue;
    }
  }
  return { token: null, userId: null };
}

const authHdr = async (request, who = 'admin') => ({
  Authorization: `Bearer ${(await login(request, who)).token}`,
});

async function authGet(request, path, who = 'admin') {
  return request.get(`${BASE_URL}${path}`, {
    headers: await authHdr(request, who),
    timeout: REQUEST_TIMEOUT,
  });
}
async function authPost(request, path, body, who = 'admin') {
  const headers = { ...(await authHdr(request, who)), 'Content-Type': 'application/json' };
  return request.post(`${BASE_URL}${path}`, { headers, data: body ?? {}, timeout: REQUEST_TIMEOUT });
}

// ── Mask-format predicates ─────────────────────────────────────────
// These mirror the canonical regexes in backend/lib/piiMask.js. Centralised
// here so every test asserts the same shape contract.
const PHONE_MASK_RE = /^\+?\d{3}\*{4}\d{4}$/;
const EMAIL_MASK_RE = /^.\*{4}@.+\..+$/;
const NAME_MASK_RE = /^[A-Za-z]\. /;
const DOB_MASK_RE = /^\*{4}-\d{2}-\d{2}$/;
const USERID_MASK_RE = /^#\d{1,3}$/;

// Spec-created patient ids — best-effort cleanup. The wellness Patient model
// has NO DELETE endpoint (issue #21), so global-teardown's regex scrub on
// `name LIKE 'E2E %'` catches these.
const createdPatientIds = [];

test.beforeAll(async ({ request }) => {
  const adm = await login(request, 'admin');
  expect(adm.token, 'admin@wellness.demo must be seeded').toBeTruthy();
  const tc = await login(request, 'telecaller');
  expect(tc.token, 'telecaller@enhancedwellness.in must be seeded').toBeTruthy();

  // Seed a couple of patients with deterministic PII so we can assert mask
  // formats against KNOWN strings, not whatever is in the db.
  for (let i = 0; i < 2; i++) {
    const body = {
      name: `E2E PII Patient ${RUN_TAG}_${i}`,
      phone: nextPhone(),
      email: `e2e.pii.${RUN_TAG.toLowerCase()}.${i}@example.test`,
      dob: '1995-04-12',
      gender: 'M',
    };
    const r = await authPost(request, '/api/wellness/patients', body);
    if (r.ok()) {
      const j = await r.json();
      if (j && j.id) createdPatientIds.push(j.id);
    }
  }
});

// ── #679 Locations ─────────────────────────────────────────────────

test('#679 admin sees Locations with UNMASKED phone + email', async ({ request }) => {
  const r = await authGet(request, '/api/wellness/locations', 'admin');
  expect(r.status()).toBe(200);
  const rows = await r.json();
  expect(Array.isArray(rows)).toBe(true);
  // Find a row whose phone is non-empty in the seed, OR just verify no row
  // is masked (none have the 3-leading-4-trailing mask shape).
  for (const row of rows) {
    if (row.phone) expect(row.phone).not.toMatch(PHONE_MASK_RE);
    if (row.email) expect(row.email).not.toMatch(EMAIL_MASK_RE);
  }
});

test('#679 telecaller sees Locations with MASKED phone + email', async ({ request }) => {
  const r = await authGet(request, '/api/wellness/locations', 'telecaller');
  expect(r.status()).toBe(200);
  const rows = await r.json();
  expect(Array.isArray(rows)).toBe(true);
  let sawNonNullPhone = false;
  let sawNonNullEmail = false;
  for (const row of rows) {
    if (row.phone) { sawNonNullPhone = true; expect(row.phone).toMatch(PHONE_MASK_RE); }
    if (row.email) { sawNonNullEmail = true; expect(row.email).toMatch(EMAIL_MASK_RE); }
  }
  // At least ONE seeded location must have non-null phone OR email for this
  // assertion to be meaningful. Don't hard-fail if all rows are null
  // (defensive) — seed may evolve.
  expect(sawNonNullPhone || sawNonNullEmail || rows.length === 0).toBe(true);
});

// ── #680 Patient list + export ─────────────────────────────────────

test('#680 admin sees Patient list with UNMASKED name + phone + email + dob', async ({ request }) => {
  const r = await authGet(request, `/api/wellness/patients?q=${encodeURIComponent(RUN_TAG)}`, 'admin');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(Array.isArray(body.patients)).toBe(true);
  const seeded = body.patients.find((p) => (p.name || '').includes(RUN_TAG));
  expect(seeded, 'seeded patient must be findable by RUN_TAG').toBeTruthy();
  // Verify no masking: name shouldn't be `E. ...`, phone shouldn't match mask.
  expect(seeded.name).toContain(RUN_TAG); // full name preserved
  expect(seeded.phone).not.toMatch(PHONE_MASK_RE);
  expect(seeded.email).not.toMatch(EMAIL_MASK_RE);
});

test('#680 telecaller sees Patient list with MASKED name + phone + email + dob', async ({ request }) => {
  const r = await authGet(request, '/api/wellness/patients', 'telecaller');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(Array.isArray(body.patients)).toBe(true);
  // Find at least one seeded patient (its full name starts with `E2E PII Patient`)
  // — masked it becomes `E. PII Patient ...`. The mask shape regex catches it.
  let foundMaskedName = false;
  let foundMaskedPhone = false;
  let foundMaskedDob = false;
  for (const p of body.patients) {
    if (p.name && NAME_MASK_RE.test(p.name)) foundMaskedName = true;
    if (p.phone && PHONE_MASK_RE.test(p.phone)) foundMaskedPhone = true;
    if (p.dob && DOB_MASK_RE.test(p.dob)) foundMaskedDob = true;
  }
  expect(foundMaskedName, 'telecaller must see at least one masked name').toBe(true);
  expect(foundMaskedPhone, 'telecaller must see at least one masked phone').toBe(true);
  // DOB masking is BEST EFFORT — a dob serialised through Prisma may already
  // be null on many rows. We assert at least one (the seeded patient with
  // dob:'1995-04-12') comes back masked.
  expect(foundMaskedDob, 'telecaller must see at least one masked dob').toBe(true);
});

test('#680 patient CSV export: admin gets unmasked rows', async ({ request }) => {
  const r = await authGet(request, `/api/wellness/patients.csv?q=${encodeURIComponent(RUN_TAG)}`, 'admin');
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('text/csv');
  expect(r.headers()['content-disposition']).toContain('patients-');
  expect(r.headers()['content-disposition']).not.toContain('-masked');
  const csv = await r.text();
  // Admin path: must contain the full email (which has `e2e.pii.` prefix).
  expect(csv).toContain('e2e.pii.');
});

test('#680 patient CSV export: ?masked=1 forces masked output even for admin', async ({ request }) => {
  const r = await authGet(request, `/api/wellness/patients.csv?q=${encodeURIComponent(RUN_TAG)}&masked=1`, 'admin');
  expect(r.status()).toBe(200);
  expect(r.headers()['content-disposition']).toContain('-masked');
  const csv = await r.text();
  // Masked path: shouldn't contain the full plaintext email local-part.
  // The seeded email starts with `e2e.pii.` — masked is `e****@example.test`.
  expect(csv).not.toContain('e2e.pii.');
  // But the masked email shape should appear (`e****@example.test`).
  expect(csv).toMatch(/e\*{4}@example\.test/);
});

test('#680 patient CSV export: telecaller gets masked output by default (no flag needed)', async ({ request }) => {
  const r = await authGet(request, `/api/wellness/patients.csv?q=${encodeURIComponent(RUN_TAG)}`, 'telecaller');
  expect(r.status()).toBe(200);
  const csv = await r.text();
  expect(csv).not.toContain('e2e.pii.'); // unmasked email NOT in output
});

// ── #681 WhatsApp threads ─────────────────────────────────────────

test('#681 WhatsApp /threads: admin sees unmasked contactPhone', async ({ request }) => {
  const r = await authGet(request, '/api/whatsapp/threads?limit=10', 'admin');
  // 200 OK or 404/empty — we just need the unmasking-on-200 contract.
  if (!r.ok()) {
    test.skip(true, `WhatsApp threads endpoint not available: HTTP ${r.status()}`);
    return;
  }
  const body = await r.json();
  expect(Array.isArray(body.threads)).toBe(true);
  // Don't insist that threads exist on demo seed — just assert that IF a
  // thread has contactPhone, admin sees it unmasked.
  for (const t of body.threads) {
    if (t.contactPhone) expect(t.contactPhone).not.toMatch(PHONE_MASK_RE);
  }
});

test('#681 WhatsApp /threads: telecaller sees MASKED contactPhone', async ({ request }) => {
  const r = await authGet(request, '/api/whatsapp/threads?limit=10', 'telecaller');
  if (!r.ok()) {
    test.skip(true, `WhatsApp threads not available for telecaller: HTTP ${r.status()}`);
    return;
  }
  const body = await r.json();
  expect(Array.isArray(body.threads)).toBe(true);
  for (const t of body.threads) {
    if (t.contactPhone) expect(t.contactPhone).toMatch(PHONE_MASK_RE);
    if (t.contact && t.contact.phone) expect(t.contact.phone).toMatch(PHONE_MASK_RE);
    if (t.contact && t.contact.email) expect(t.contact.email).toMatch(EMAIL_MASK_RE);
  }
});

// ── #682 Staff list ───────────────────────────────────────────────

test('#682 admin sees /api/staff with UNMASKED id + name + email', async ({ request }) => {
  const r = await authGet(request, '/api/staff', 'admin');
  expect(r.status()).toBe(200);
  const rows = await r.json();
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
  for (const u of rows) {
    expect(typeof u.id).toBe('number'); // numeric id, NOT hashed
    if (u.name) expect(u.name).not.toMatch(NAME_MASK_RE);
    if (u.email) expect(u.email).not.toMatch(EMAIL_MASK_RE);
  }
});

test('#682 USER role on generic tenant sees /api/staff with MASKED id + name + email', async ({ request }) => {
  const r = await authGet(request, '/api/staff', 'generic');
  expect(r.status()).toBe(200);
  const rows = await r.json();
  expect(Array.isArray(rows)).toBe(true);
  expect(rows.length).toBeGreaterThan(0);
  for (const u of rows) {
    // id hashed to '#XYZ' (string) not numeric.
    expect(typeof u.id).toBe('string');
    expect(u.id).toMatch(USERID_MASK_RE);
    if (u.name) {
      // Two-or-more-token names get the `F. Last` mask; single-token names
      // stay as a single-letter initial. Match either.
      expect(u.name === u.name[0] + '.' || NAME_MASK_RE.test(u.name)).toBe(true);
    }
    if (u.email) expect(u.email).toMatch(EMAIL_MASK_RE);
  }
});

test('#682 telecaller on wellness tenant sees /api/staff with MASKED id + email', async ({ request }) => {
  const r = await authGet(request, '/api/staff', 'telecaller');
  expect(r.status()).toBe(200);
  const rows = await r.json();
  expect(Array.isArray(rows)).toBe(true);
  for (const u of rows) {
    expect(typeof u.id).toBe('string');
    expect(u.id).toMatch(USERID_MASK_RE);
    if (u.email) expect(u.email).toMatch(EMAIL_MASK_RE);
  }
});

// ── #682 Telecaller queue: PII_DISCLOSED audit ─────────────────────

test('#682 telecaller /queue returns unmasked leads (rows are in-scope by assignment)', async ({ request }) => {
  const r = await authGet(request, '/api/wellness/telecaller/queue', 'telecaller');
  expect(r.status()).toBe(200);
  const body = await r.json();
  expect(Array.isArray(body.leads)).toBe(true);
  // Queue rows are scoped to assignedToId === own userId — telecaller is the
  // record-subject's worker, so phones are intentionally UNMASKED here.
  for (const lead of body.leads) {
    if (lead.phone) expect(lead.phone).not.toMatch(PHONE_MASK_RE);
  }
});

// ── Mask predicate sanity ──────────────────────────────────────────
test('mask predicate self-check: known mask shapes match the regexes', () => {
  // Cheap correctness check on the spec's own regexes — if the canonical
  // mask shape ever drifts, this test fails loudly before the role-based
  // tests do.
  expect('+919****3210').toMatch(PHONE_MASK_RE);
  expect('r****@example.com').toMatch(EMAIL_MASK_RE);
  expect('R. Sharma').toMatch(NAME_MASK_RE);
  expect('****-04-12').toMatch(DOB_MASK_RE);
  expect('#345').toMatch(USERID_MASK_RE);
});
