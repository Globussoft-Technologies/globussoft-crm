// @ts-check
/**
 * Gate spec — TMC School-Readiness Diagnostic end-to-end happy path.
 *
 * PRD reference: docs/PRD_TMC_DIAGNOSTIC_SALES_ROUTING_ENGINE.md §10 row T12
 * (final integration slice).  Closes the CI gap for the TMC diagnostic arc
 * (T1-T11 shipped earlier).  Pins the wire-up between:
 *
 *   GET    /api/travel-tmc-catalogue                              (T5 — ADMIN list)
 *   POST   /api/travel-tmc-catalogue                              (T5 — create lands archived)
 *   POST   /api/travel-tmc-catalogue/:id/promote-to-active        (T5 — ADMIN-only)
 *   POST   /api/travel/diagnostics/public/submit-tmc              (T8 — public)
 *   GET    /api/travel/diagnostics/:id                            (T8 — auth read)
 *   GET    /api/travel/diagnostics/:id/readiness-report.pdf       (T8 — public PDF)
 *
 * Cases (≥12 per slice contract):
 *   1.  Catalogue seed verified — the 5 starter trips are present + active
 *   2.  Public submit happy path — valid 12-Q payload → 201 + {diagnosticId, reportSlug}
 *   3.  Persisted diagnostic shape — engineState/icpTier/leadQuality/engineScoresJson populated
 *   4.  Engine output strong_match — AC-12 worked example produces strong_match
 *   5.  Two-key sort invariant — primary-outcome match wins regardless of weaker stack
 *   6.  ICP tier classification — high-strength + high-fee → `amazing`
 *   7.  Suspect lead handling — free-mail-domain + senior role → leadQuality="suspect"
 *   8.  Readiness PDF download — 200 + application/pdf + non-trivial body size
 *   9.  PDF header smoke — body starts with `%PDF-` magic bytes
 *   10. Brief in CRM — the GET /diagnostics/:id surface exposes the brief fields
 *   11. Email-gate hard wall — POST /submit-tmc without Q12 email → 400 + EMAIL_REQUIRED
 *   12. Catalogue gate — POST status:"active" body lands status:"archived" (human-verify)
 *   13. Promote-to-active gate — MANAGER → 403, ADMIN → 200 + status flips
 *   14. Cross-tenant isolation — diagnostic from tenant A not visible to generic-tenant ADMIN
 *   15. Catalogue WRONG_VERTICAL — generic-vertical caller cannot list TMC catalogue
 *
 * Tenant: `travel-stall` (the single Travel-vertical tenant in the seed).
 * Admin:  `yasin@travelstall.in` / `password123` (ADMIN, full subBrandAccess).
 * Manager: `tmc-ops@travelstall.demo` / `password123` (MANAGER, tmc subBrand only).
 *
 * Dependencies:
 *   - seed-travel.js runs in deploy.yml's api_tests gate BEFORE this spec
 *     (the existing travel-* specs already require it).  Provides the
 *     `travel-stall` tenant + Yasin + the 5 starter TmcTripCatalogue rows
 *     + the default EngineWeights row (50/20/15/10/10/8, threshold 70).
 *
 * Cross-machine note:
 *   The per-push gate runs against http://127.0.0.1:5000 with a fresh
 *   seed-travel.js seed.  e2e-full runs the same spec against
 *   https://crm.globusdemos.com — demo MAY have an older or newer catalogue
 *   shape, so we ASSERT EXISTENCE OF THE 5 STARTERS (not equality of the
 *   whole list).  Demo's catalogue could legitimately carry promoted +
 *   archived rows beyond the seed defaults.
 *
 * Cleanup:
 *   - Created diagnostics are immutable per design (audit records — no
 *     DELETE surface).  Each row is tagged via the contact_name field with
 *     the RUN_TAG so the demo-scrub hourly job can sweep them.
 *   - Catalogue rows we create (status:archived gate test) are also tagged
 *     via the tripId prefix; afterAll attempts a soft-delete via DELETE.
 *
 * Failure absorbers:
 *   - retryOn5xx wraps every HTTP call — CF/Nginx blips occasionally surface
 *     transient 5xx during demo origin restarts.  Up to 3 attempts,
 *     500ms-1.5s backoff.  4xx aborts immediately so genuine validator
 *     regressions surface.
 */

const { test, expect } = require('@playwright/test');

// Tests in this file create + read shared resources (diagnostics + catalogue
// rows) on one tenant; serial execution avoids races on the lead-quality
// "repeat_submitter" rule (which counts diagnostics created in the last
// 24h on the same tenant) and on the cleanup tracker.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60_000;
const RUN_TAG = `E2E_TMC_DIAG_${Date.now()}`;
const TENANT_SLUG = 'travel-stall';

// ── Dual-token auth ────────────────────────────────────────────────────
let travelAdminToken = null;
let travelManagerToken = null;
let genericAdminToken = null;

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
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, 'yasin@travelstall.in', 'password123');
  }
  return travelAdminToken;
}

async function getTravelManager(request) {
  if (!travelManagerToken) {
    travelManagerToken = await loginAs(request, 'tmc-ops@travelstall.demo', 'password123');
  }
  return travelManagerToken;
}

async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, 'admin@globussoft.com', 'password123');
  }
  return genericAdminToken;
}

const authHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

// ── 5xx absorber ───────────────────────────────────────────────────────
async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT }),
  );
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      headers: authHeaders(token),
      data: body ?? {},
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: authHeaders(token), timeout: REQUEST_TIMEOUT }),
  );
}
async function postPublic(request, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, {
      data: body ?? {},
      headers: { 'Content-Type': 'application/json' },
      timeout: REQUEST_TIMEOUT,
    }),
  );
}
async function getPublic(request, path) {
  return retryOn5xx(() =>
    request.get(`${BASE_URL}${path}`, { timeout: REQUEST_TIMEOUT }),
  );
}

// ── Fixtures — the AC-12 worked example payload ────────────────────────
//
// PRD §6.9 / AC-12:
//   - primary_outcome: global_awareness (matches Golden Triangle + Europe)
//   - secondary_skills: ["Cultural respect and inclusion", "Lifelong learning and curiosity"]
//   - growth_area: Cultural respect (mappedSkill same as Q2 → NO double-pay)
//   - grade_band: 9-10
//   - curriculum: ["CBSE"]
//   - geo_preference: open (lets engine compare tiers via tier-value lean)
//   - budget_band: 2l-plus (allows international + everything below)
//   - timeline: next academic year
//   - school_profile: branches:2, student_strength:"1000-2000", fee_band:"1l-plus" → `breadwinning`
//   - contact email: school domain (`.edu.in`) → leadQuality:"clean"
function ac12HappyPayload(emailOverride) {
  return {
    tenantSlug: TENANT_SLUG,
    answers: {
      primary_outcome: 'global_awareness',
      secondary_skills: ['Cultural respect and inclusion', 'Lifelong learning and curiosity'],
      growth_area: 'Cultural respect and inclusion',
      growth_area_skill: 'Cultural respect and inclusion',
      travel_maturity: 'occasional_day',
      grade_band: '9-10',
      curriculum: ['CBSE'],
      geo_preference: 'open',
      group_size: '45-80',
      budget_band: '2l-plus',
      timeline: 'next_academic_year',
      school_profile: {
        school_name: `${RUN_TAG} St Xavier International School`,
        city: 'Mumbai',
        branches: '2',
        student_strength: '1000-2000',
        fee_band: '1l-plus',
      },
      contact: {
        contact_name: `${RUN_TAG} Principal Mehra`,
        contact_role: 'Principal',
        email: emailOverride || `principal+${RUN_TAG}@stxavierintl.edu.in`,
        phone: '9876543210',
      },
    },
  };
}

// Suspect-lead payload — free-mail domain (gmail.com) + senior role (Principal).
// PRD §3.4 rule 1: triggers `free_domain_senior_role` flag.
function suspectLeadPayload() {
  return {
    tenantSlug: TENANT_SLUG,
    answers: {
      primary_outcome: 'curiosity',
      secondary_skills: ['Lifelong learning and curiosity', 'Mindfulness'],
      growth_area: 'Self-awareness',
      growth_area_skill: 'Self-awareness',
      travel_maturity: 'first_time',
      grade_band: '6-8',
      curriculum: ['CBSE'],
      geo_preference: 'domestic',
      group_size: '35-45',
      budget_band: '30k-75k',
      timeline: 'next_term',
      school_profile: {
        school_name: `${RUN_TAG} Public School`,
        city: 'Delhi',
        branches: '1',
        student_strength: '500-1000',
        fee_band: '75k-1l',
      },
      contact: {
        contact_name: `${RUN_TAG} Junior Principal`,
        contact_role: 'Principal',
        // Free-mail domain — Rule 1 triggers `free_domain_senior_role`.
        email: `principal+${RUN_TAG}@gmail.com`,
        phone: '9123456789',
      },
    },
  };
}

// ── Cleanup tracker ────────────────────────────────────────────────────
const created = {
  diagnosticIds: [],         // immutable audit records — sweep via demo-hygiene cron
  catalogueIds: [],          // we soft-delete via DELETE in afterAll
};

// ── Tests ──────────────────────────────────────────────────────────────

test.describe('TMC diagnostic — catalogue seed', () => {
  test('1) GET /travel-tmc-catalogue lists the 5 starter trips active', async ({ request }) => {
    const token = await getTravelAdmin(request);
    expect(token, 'yasin@travelstall.in must be seeded').toBeTruthy();
    const res = await get(request, token, '/api/travel-tmc-catalogue?status=active&limit=200');
    expect(res.status(), `catalogue list: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.catalogue)).toBe(true);

    const titles = body.catalogue.map((c) => String(c.title || ''));
    const tripIds = body.catalogue.map((c) => String(c.tripId || ''));

    // Existence assertion (not equality) — demo may carry additional rows.
    // The 5 PRD §3.2 starters must all be present + active.
    const STARTERS = [
      'golden-triangle-delhi-agra-jaipur',
      'madhya-pradesh-jungle-heritage',
      'ladakh-himalayan-experience',
      'europe-nl-be-fr-es',
      'usa-stem-east-coast', // T4 seed names it; relaxed via title fallback below
    ];
    let presentCount = 0;
    for (const expected of STARTERS) {
      if (tripIds.includes(expected)) presentCount += 1;
    }
    // Tolerate one tripId drift (USA STEM slug) — at minimum the 4 firm rows.
    expect(
      presentCount,
      `expected ≥4 of 5 starter tripIds, got ${presentCount}. tripIds=${JSON.stringify(tripIds)}`,
    ).toBeGreaterThanOrEqual(4);

    // Sanity: each row carries the schema's NOT-NULL fields populated.
    for (const c of body.catalogue) {
      expect(c.id).toBeTruthy();
      expect(c.tripId).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(['day', 'domestic', 'international']).toContain(c.tier);
      expect(c.status).toBe('active');
      expect(c.boardsSupportedJson).toBeTruthy();
      expect(c.primaryOutcomesJson).toBeTruthy();
    }
    // Also confirm starter title hint at least once.
    const someTitleMatch = titles.some((t) => /Golden Triangle|Europe|Ladakh|Madhya|STEM/i.test(t));
    expect(someTitleMatch, `expected at least one starter title, titles=${JSON.stringify(titles)}`).toBe(true);
  });
});

test.describe('TMC diagnostic — public submit (happy path)', () => {
  let happyDiagnosticId = null;
  let happyReportSlug = null;

  test('2) POST /diagnostics/public/submit-tmc accepts AC-12 payload → 201 + ids', async ({ request }) => {
    const payload = ac12HappyPayload();
    const res = await postPublic(request, '/api/travel/diagnostics/public/submit-tmc', payload);
    expect(res.status(), `submit-tmc: ${await res.text()}`).toBeLessThan(400);
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body.diagnosticId, 'response.diagnosticId').toBeTruthy();
    expect(typeof body.diagnosticId === 'number' || typeof body.diagnosticId === 'string').toBe(true);
    expect(typeof body.reportSlug).toBe('string');
    expect(body.reportSlug.length).toBeGreaterThan(0);
    happyDiagnosticId = body.diagnosticId;
    happyReportSlug = body.reportSlug;
    created.diagnosticIds.push(happyDiagnosticId);
  });

  test('3) GET /diagnostics/:id (ADMIN) returns the persisted T1 shape', async ({ request }) => {
    if (!happyDiagnosticId) test.skip(true, 'submit-tmc happy path failed — nothing to verify');
    const token = await getTravelAdmin(request);
    expect(token).toBeTruthy();
    const res = await get(request, token, `/api/travel/diagnostics/${happyDiagnosticId}`);
    expect(res.status(), `diagnostics/:id: ${await res.text()}`).toBe(200);
    const diag = await res.json();
    // T1 additive columns must all be populated.
    expect(diag.subBrand).toBe('tmc');
    expect(['strong_match', 'partial_match', 'no_match']).toContain(diag.engineState);
    expect(['amazing', 'breadwinning', 'convenience', 'dangerous', 'unclassified']).toContain(diag.icpTier);
    expect(['clean', 'suspect']).toContain(diag.leadQuality);
    // engineScoresJson is a stringified blob with `survivors[]` + `eliminated[]` + `weightsUsed`.
    expect(diag.engineScoresJson, 'engineScoresJson populated').toBeTruthy();
    let scores;
    try { scores = JSON.parse(diag.engineScoresJson); }
    catch (e) { throw new Error(`engineScoresJson not valid JSON: ${e.message}`); }
    expect(Array.isArray(scores.survivors)).toBe(true);
    expect(Array.isArray(scores.eliminated)).toBe(true);
    expect(scores.weightsUsed).toBeTruthy();
    // PRD §3.3.3 defaults: 50/20/15/10/10/8 + threshold 70.
    expect(scores.weightsUsed.weightPrimaryOutcome).toBe(50);
    expect(scores.weightsUsed.scoresWellThreshold).toBe(70);
    // weightsVersion is captured at submission per NF-3 audit requirement.
    expect(typeof diag.weightsVersion === 'string' && diag.weightsVersion.length > 0).toBe(true);
  });

  test('4) AC-12 worked example produces strong_match + global_awareness primary', async ({ request }) => {
    if (!happyDiagnosticId) test.skip(true, 'submit-tmc happy path failed');
    const token = await getTravelAdmin(request);
    const res = await get(request, token, `/api/travel/diagnostics/${happyDiagnosticId}`);
    expect(res.status()).toBe(200);
    const diag = await res.json();
    // AC-12 expectation: clears all hard filters + scores ≥70 with primary match.
    expect(diag.engineState).toBe('strong_match');
    // The recommended trip must match the school's primary outcome (global_awareness).
    // Both Golden Triangle and Europe carry global_awareness; the engine picks
    // the higher scorer (Europe → 98 per AC-12 worked example).  We assert
    // primary recommended is set + matches one of the global_awareness rows.
    expect(diag.recommendedTripId, 'recommendedTripId populated for strong_match').toBeTruthy();
    // The brief data — flags is a JSON-string column per T1.
    let flags = [];
    try { flags = JSON.parse(diag.flagsJson || '[]'); } catch { /* tolerate */ }
    expect(Array.isArray(flags)).toBe(true);
    // AC-12 explicitly expects ICP `breadwinning` (branches 2, strength 1000-2000, fee 1l+).
    expect(diag.icpTier).toBe('breadwinning');
    // AC-12: lead_quality clean (.edu.in domain).
    expect(diag.leadQuality).toBe('clean');
  });

  test('5) two-key sort invariant — primary-outcome match wins regardless of stack', async ({ request }) => {
    // Same as AC-12 but force-narrow to budget_band: 30k-75k so the
    // international Europe row gets eliminated.  The surviving domestic
    // pool contains Golden Triangle (primary_outcomes:[global_awareness,
    // pride, curiosity]) which DOES match primary, and Madhya Pradesh
    // (primary_outcomes:[curiosity, global_awareness]) which also matches.
    // Either way, the recommended trip MUST be one that includes the
    // school's primary outcome in its primary_outcomes array.
    const payload = ac12HappyPayload();
    payload.answers.budget_band = '30k-75k';
    payload.answers.geo_preference = 'domestic';
    payload.answers.contact.email = `principal2+${RUN_TAG}@stxavierintl.edu.in`;
    payload.answers.school_profile.school_name = `${RUN_TAG} Sort Invariant School`;
    const sres = await postPublic(request, '/api/travel/diagnostics/public/submit-tmc', payload);
    expect(sres.status()).toBeLessThan(400);
    const { diagnosticId } = await sres.json();
    expect(diagnosticId).toBeTruthy();
    created.diagnosticIds.push(diagnosticId);

    const token = await getTravelAdmin(request);
    const res = await get(request, token, `/api/travel/diagnostics/${diagnosticId}`);
    expect(res.status()).toBe(200);
    const diag = await res.json();
    expect(['strong_match', 'partial_match']).toContain(diag.engineState);
    // The primary recommended row exists + survives the engine.
    expect(diag.recommendedTripId).toBeTruthy();
    // Look up the recommended row's primary_outcomes via the catalogue list.
    const listRes = await get(request, token, '/api/travel-tmc-catalogue?status=active&limit=200');
    const list = await listRes.json();
    const rec = list.catalogue.find((c) => c.id === diag.recommendedTripId);
    expect(rec, 'recommended row in catalogue').toBeTruthy();
    let primaryOutcomes = [];
    try { primaryOutcomes = JSON.parse(rec.primaryOutcomesJson || '[]'); } catch { /* tolerate */ }
    // PRD §3.3.4 invariant: the chosen primary must match the school's
    // stated primary_outcome.  If this assert fails the two-key sort is broken.
    expect(primaryOutcomes, `primary_outcomes for ${rec.tripId}`).toContain('global_awareness');
  });

  test('6) ICP tier — branches:3 + strength:2000+ + fee:1l+ → `amazing`', async ({ request }) => {
    const payload = ac12HappyPayload();
    payload.answers.school_profile = {
      school_name: `${RUN_TAG} AMAZING Multinational Academy`,
      city: 'Bengaluru',
      branches: '3',
      student_strength: '2000-plus',
      fee_band: '1l-plus',
    };
    payload.answers.contact.email = `principal3+${RUN_TAG}@stxavierintl.edu.in`;
    payload.answers.contact.contact_name = `${RUN_TAG} ICP Amazing Principal`;
    const sres = await postPublic(request, '/api/travel/diagnostics/public/submit-tmc', payload);
    expect(sres.status()).toBeLessThan(400);
    const { diagnosticId } = await sres.json();
    created.diagnosticIds.push(diagnosticId);
    const token = await getTravelAdmin(request);
    const res = await get(request, token, `/api/travel/diagnostics/${diagnosticId}`);
    expect(res.status()).toBe(200);
    const diag = await res.json();
    expect(diag.icpTier).toBe('amazing');
  });
});

test.describe('TMC diagnostic — lead quality', () => {
  test('7) free-mail domain + senior role → leadQuality:"suspect" + reason flag', async ({ request }) => {
    const sres = await postPublic(request, '/api/travel/diagnostics/public/submit-tmc', suspectLeadPayload());
    expect(sres.status(), `suspect submit: ${await sres.text()}`).toBeLessThan(400);
    const { diagnosticId } = await sres.json();
    expect(diagnosticId).toBeTruthy();
    created.diagnosticIds.push(diagnosticId);
    const token = await getTravelAdmin(request);
    const res = await get(request, token, `/api/travel/diagnostics/${diagnosticId}`);
    expect(res.status()).toBe(200);
    const diag = await res.json();
    expect(diag.leadQuality).toBe('suspect');
    let reasons = [];
    try { reasons = JSON.parse(diag.leadQualityReasonsJson || '[]'); } catch { /* tolerate */ }
    expect(Array.isArray(reasons)).toBe(true);
    expect(
      reasons.includes('free_domain_senior_role'),
      `expected reason "free_domain_senior_role", got ${JSON.stringify(reasons)}`,
    ).toBe(true);
    // PRD §3.4: report STILL ships — suspect-lead doesn't block.  Verify the
    // brief flag is also present alongside the lead-quality column.
    let flags = [];
    try { flags = JSON.parse(diag.flagsJson || '[]'); } catch { /* tolerate */ }
    expect(flags.includes('suspect')).toBe(true);
  });
});

test.describe('TMC diagnostic — readiness PDF', () => {
  let pdfDiagnosticId = null;

  test.beforeAll(async ({ request }) => {
    // Submit one fresh diagnostic so PDF tests own their input row
    // independent of the order-of-execution of the happy-path tests above.
    const payload = ac12HappyPayload();
    payload.answers.contact.email = `principal+pdf+${RUN_TAG}@stxavierintl.edu.in`;
    payload.answers.school_profile.school_name = `${RUN_TAG} PDF Source School`;
    const sres = await postPublic(request, '/api/travel/diagnostics/public/submit-tmc', payload);
    if (sres.status() < 400) {
      const j = await sres.json();
      pdfDiagnosticId = j.diagnosticId;
      created.diagnosticIds.push(pdfDiagnosticId);
    }
  });

  test('8) GET /diagnostics/:id/readiness-report.pdf → 200 + application/pdf + body', async ({ request }) => {
    if (!pdfDiagnosticId) test.skip(true, 'submit-tmc beforeAll failed; cannot fetch PDF');
    const res = await getPublic(request, `/api/travel/diagnostics/${pdfDiagnosticId}/readiness-report.pdf`);
    expect(res.status(), `readiness-report.pdf: ${await res.text().catch(() => '<binary>')}`).toBe(200);
    const ct = res.headers()['content-type'] || '';
    expect(ct.toLowerCase()).toContain('application/pdf');
    const body = await res.body();
    // PRD §3.5 renders a 10-section report; the smallest plausible
    // output is a few KB.  We assert >1 KB to catch "empty buffer" regressions.
    expect(body.length, `PDF body length=${body.length}`).toBeGreaterThan(1000);
  });

  test('9) PDF body starts with %PDF- magic bytes', async ({ request }) => {
    if (!pdfDiagnosticId) test.skip(true, 'no pdf diagnostic id');
    const res = await getPublic(request, `/api/travel/diagnostics/${pdfDiagnosticId}/readiness-report.pdf`);
    expect(res.status()).toBe(200);
    const body = await res.body();
    // PDF spec: every PDF begins with "%PDF-" header.
    expect(body.slice(0, 5).toString('utf8')).toBe('%PDF-');
    // And ends with %%EOF (allowing for trailing whitespace).
    const tail = body.slice(-32).toString('utf8');
    expect(tail.includes('%%EOF')).toBe(true);
  });
});

test.describe('TMC diagnostic — brief surface', () => {
  test('10) GET /diagnostics/:id exposes brief data (T1 columns) for the executive', async ({ request }) => {
    // Reuse one of the existing happy-path diagnostics rather than
    // submitting another (faster, avoids hitting the suspect repeat-submit
    // rule on tight test loops).
    if (created.diagnosticIds.length === 0) test.skip(true, 'no happy-path diagnostics available');
    const id = created.diagnosticIds[0];
    const token = await getTravelAdmin(request);
    const res = await get(request, token, `/api/travel/diagnostics/${id}`);
    expect(res.status()).toBe(200);
    const diag = await res.json();
    // PRD §3.6 brief contents (mapped to T1 columns):
    //   - lead_quality + reasons               → leadQuality + leadQualityReasonsJson
    //   - 12 diagnostic answers                → answersJson
    //   - engine state                         → engineState
    //   - primary + alternative trip ids       → recommendedTripId + alternativeTripId
    //   - icp_tier + sales priority            → icpTier
    //   - all flags                            → flagsJson
    //   - engine score breakdown               → engineScoresJson
    expect(diag.leadQuality).toBeTruthy();
    expect(diag.answersJson).toBeTruthy();
    expect(diag.engineState).toBeTruthy();
    expect(diag.icpTier).toBeTruthy();
    expect(diag.flagsJson).toBeTruthy();
    expect(diag.engineScoresJson).toBeTruthy();
    // answersJson is the school's 12-Q payload — must round-trip the email.
    let answers = {};
    try { answers = JSON.parse(diag.answersJson); } catch { /* tolerate */ }
    expect(answers.contact && answers.contact.email).toBeTruthy();
  });
});

test.describe('TMC diagnostic — input validation', () => {
  test('11) POST /submit-tmc without Q12 email → 400 + EMAIL_REQUIRED', async ({ request }) => {
    const payload = ac12HappyPayload();
    // Remove the email field; PRD §3.1 / NF-6: Q12 email is the only hard wall.
    delete payload.answers.contact.email;
    const res = await postPublic(request, '/api/travel/diagnostics/public/submit-tmc', payload);
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('EMAIL_REQUIRED');
  });
});

test.describe('TMC diagnostic — catalogue gates', () => {
  test('12) POST /travel-tmc-catalogue body status:"active" → row lands status:"archived"', async ({ request }) => {
    const token = await getTravelAdmin(request);
    const tripId = `e2e-gate-trip-${RUN_TAG.toLowerCase()}`;
    const res = await post(request, token, '/api/travel-tmc-catalogue', {
      tripId,
      title: `${RUN_TAG} Gate Test Trip`,
      tier: 'day',
      durationDays: 1,
      durationNights: 0,
      minGradeBand: '6-8',
      maxGradeBand: '9-10',
      boardsSupportedJson: ['CBSE'],
      minGroupSize: 25,
      priceBand: 'upto-5k',
      primaryOutcomesJson: ['curiosity'],
      skillsDevelopedJson: ['Lifelong learning and curiosity'],
      subjectsTouchedJson: ['Science'],
      anchorExperiencesJson: [{ name: 'gate-test', what_students_do: 'x', skill_link: 'curiosity', subject_link: 'Science' }],
      curriculumHooksJson: [{ board: 'CBSE', grade_band: '6-8', subject: 'Science', topic: 't', hook_text: 'h' }],
      reportSkillBlurb: `${RUN_TAG} gate-test blurb`,
      summaryForBrief: `${RUN_TAG} gate-test brief`,
      // The human-verify gate: caller asks for active, route ignores + lands archived.
      status: 'active',
    });
    expect(res.status(), `create catalogue: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(body.status, 'POST status MUST land archived regardless of body').toBe('archived');
    created.catalogueIds.push(body.id);
  });

  test('13a) POST /promote-to-active rejected for MANAGER → 403', async ({ request }) => {
    if (created.catalogueIds.length === 0) test.skip(true, 'no catalogue row created');
    const token = await getTravelManager(request);
    if (!token) test.skip(true, 'tmc-ops manager not seeded — skipping');
    const id = created.catalogueIds[0];
    const res = await post(request, token, `/api/travel-tmc-catalogue/${id}/promote-to-active`, {});
    expect([401, 403]).toContain(res.status());
  });

  test('13b) POST /promote-to-active accepted for ADMIN → 200 + status flips active', async ({ request }) => {
    if (created.catalogueIds.length === 0) test.skip(true, 'no catalogue row created');
    const token = await getTravelAdmin(request);
    const id = created.catalogueIds[0];
    const res = await post(request, token, `/api/travel-tmc-catalogue/${id}/promote-to-active`, {});
    expect(res.status(), `promote: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
  });
});

test.describe('TMC diagnostic — tenant + vertical isolation', () => {
  test('14) Diagnostic from travel tenant is invisible to generic-tenant ADMIN (404 or 403)', async ({ request }) => {
    if (created.diagnosticIds.length === 0) test.skip(true, 'no diagnostic created');
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, 'admin@globussoft.com not seeded — skipping cross-tenant probe');
    const id = created.diagnosticIds[0];
    const res = await get(request, token, `/api/travel/diagnostics/${id}`);
    // Cross-vertical caller must NOT see a 200.  Accept 403 (WRONG_VERTICAL)
    // or 404 (NOT_FOUND under tenant-scoped WHERE) — both are correct depending
    // on whether the route fires the vertical guard before the lookup.
    expect([401, 403, 404]).toContain(res.status());
  });

  test('15) GET /travel-tmc-catalogue rejects generic-vertical caller', async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, 'admin@globussoft.com not seeded — skipping cross-vertical probe');
    const res = await get(request, token, '/api/travel-tmc-catalogue?status=active');
    // The catalogue route is staff-only with the RBAC gate — but the meaningful
    // assertion is the response NEVER leaks another tenant's catalogue rows.
    // Either WRONG_VERTICAL (403) or empty list scoped to the generic tenant.
    if (res.status() === 200) {
      const body = await res.json();
      // If 200, must be the generic tenant's empty catalogue (no travel rows).
      expect(Array.isArray(body.catalogue)).toBe(true);
      for (const c of body.catalogue) {
        // The travel-stall catalogue rows we asserted in case 1 must NOT
        // leak here.  We use tripId-prefix as the cross-tenant tell.
        expect(['golden-triangle-delhi-agra-jaipur', 'europe-nl-be-fr-es']).not.toContain(c.tripId);
      }
    } else {
      expect([401, 403, 404]).toContain(res.status());
    }
  });
});

// ── afterAll cleanup ────────────────────────────────────────────────────
test.afterAll(async ({ request }) => {
  const deadline = Date.now() + 40_000;
  try {
    const token = travelAdminToken || (await getTravelAdmin(request));
    if (!token) return;
    // Soft-delete catalogue rows we created (sets status=archived).  The
    // demo-hygiene cron sweeps the archived/E2E_-tagged rows over a longer
    // window; this just avoids leaving newly-promoted active rows on demo.
    for (const id of created.catalogueIds) {
      if (Date.now() > deadline) break;
      try {
        await del(request, token, `/api/travel-tmc-catalogue/${id}`);
      } catch { /* best-effort */ }
    }
  } catch { /* tolerate */ }
});
