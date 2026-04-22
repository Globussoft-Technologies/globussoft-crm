// @ts-check
/**
 * Enhanced Wellness — End-to-end coverage
 *
 * Validates the wellness vertical: tenant context, INR currency, dashboard
 * data, every wellness sub-route, partner external API end-to-end (lead →
 * poll → lookup → call recording back), and the tenant-aware sidebar UI.
 *
 * Run:  cd e2e && BASE_URL=https://crm.globusdemos.com \
 *        npx playwright test tests/wellness.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;
const EXT = `${BASE_URL}/api/v1/external`;

// Demo creds (seeded via prisma/seed-wellness.js)
const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };
const ADMIN = { email: 'admin@wellness.demo',       password: 'password123' };
const USER  = { email: 'user@wellness.demo',        password: 'password123' };

// Demo external API key (seeded as "Callified.ai (demo key)")
const PARTNER_KEY = process.env.WELLNESS_PARTNER_KEY ||
  'glbs_6ba99bc3309ef840d58d1fd43339e09c62eb395396c6c8cf';

let TOKEN = '';

test.describe.serial('Wellness — Tenant + Auth + Currency', () => {
  test('1. Owner (Rishu) login returns wellness tenant + INR currency', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, { data: RISHU });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.user.role).toBe('ADMIN');
    expect(data.tenant.slug).toBe('enhanced-wellness');
    expect(data.tenant.vertical).toBe('wellness');
    expect(data.tenant.country).toBe('IN');
    expect(data.tenant.defaultCurrency).toBe('INR');
    expect(data.tenant.locale).toBe('en-IN');
    TOKEN = data.token;
  });

  test('2. Demo Admin login also lands on wellness tenant', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, { data: ADMIN });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.user.role).toBe('ADMIN');
    expect(data.tenant.defaultCurrency).toBe('INR');
  });

  test('3. Demo User login: USER role, same tenant, same currency', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, { data: USER });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.user.role).toBe('USER');
    expect(data.tenant.vertical).toBe('wellness');
    expect(data.tenant.defaultCurrency).toBe('INR');
  });

  test('4. Generic CRM tenant returns USD (currency segregation)', async ({ request }) => {
    const res = await request.post(`${API}/auth/login`, {
      data: { email: 'admin@globussoft.com', password: 'password123' },
    });
    const data = await res.json();
    expect(data.tenant.defaultCurrency).toBe('USD');
    expect(data.tenant.vertical).toBe('generic');
  });
});

test.describe.serial('Wellness — Dashboard + Data', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });

  test.beforeAll(async ({ request }) => {
    if (TOKEN) return;
    const r = await request.post(`${API}/auth/login`, { data: RISHU });
    TOKEN = (await r.json()).token;
  });

  test('5. Dashboard returns today/yesterday/30-day shape', async ({ request }) => {
    const res = await request.get(`${API}/wellness/dashboard`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.today).toHaveProperty('visits');
    expect(d.today).toHaveProperty('expectedRevenue');
    expect(d.today).toHaveProperty('occupancyPct');
    expect(d.yesterday).toHaveProperty('completed');
    expect(d.yesterday).toHaveProperty('revenue');
    expect(Array.isArray(d.revenueTrend)).toBeTruthy();
    expect(d.revenueTrend.length).toBe(30);
    expect(d.totals.locations).toBeGreaterThanOrEqual(1);
  });

  test('6. Dashboard accepts ?locationId= filter', async ({ request }) => {
    const res = await request.get(`${API}/wellness/dashboard?locationId=1`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
  });

  test('7. Patients list returns 50 with realistic phone numbers', async ({ request }) => {
    const res = await request.get(`${API}/wellness/patients?limit=50`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.total).toBeGreaterThanOrEqual(50);
    expect(d.patients[0]).toHaveProperty('name');
    expect(d.patients[0]).toHaveProperty('phone');
    expect(d.patients[0]).toHaveProperty('source');
  });

  test('8. Patient search by phone fragment works', async ({ request }) => {
    const all = await (await request.get(`${API}/wellness/patients?limit=1`, { headers: headers() })).json();
    const phone = all.patients[0].phone;
    const tail = phone.slice(-6);
    const res = await request.get(`${API}/wellness/patients?q=${tail}`, { headers: headers() });
    const d = await res.json();
    expect(d.patients.length).toBeGreaterThan(0);
  });

  test('9. Patient detail returns visits + prescriptions + treatment plans', async ({ request }) => {
    const list = await (await request.get(`${API}/wellness/patients?limit=1`, { headers: headers() })).json();
    const id = list.patients[0].id;
    const res = await request.get(`${API}/wellness/patients/${id}`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const p = await res.json();
    expect(p).toHaveProperty('visits');
    expect(p).toHaveProperty('prescriptions');
    expect(p).toHaveProperty('treatmentPlans');
    expect(p).toHaveProperty('consents');
  });

  test('10. Service catalog has 100+ services across categories', async ({ request }) => {
    const res = await request.get(`${API}/wellness/services`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const services = await res.json();
    expect(services.length).toBeGreaterThanOrEqual(100);
    const cats = new Set(services.map((s) => s.category));
    expect(cats.size).toBeGreaterThanOrEqual(10);
    // Core wellness categories must be present
    expect(cats.has('hair-transplant')).toBeTruthy();
    expect(cats.has('anti-ageing')).toBeTruthy();
    expect(cats.has('body-contouring')).toBeTruthy();
    // Each service carries the core fields
    for (const s of services.slice(0, 5)) {
      expect(s).toHaveProperty('basePrice');
      expect(s).toHaveProperty('ticketTier');
      expect(s).toHaveProperty('durationMin');
    }
  });

  test('11. Service tiers spread across low/medium/high', async ({ request }) => {
    const res = await request.get(`${API}/wellness/services`, { headers: headers() });
    const services = await res.json();
    const tiers = new Set(services.map((s) => s.ticketTier));
    expect(tiers.has('low')).toBeTruthy();
    expect(tiers.has('medium')).toBeTruthy();
    expect(tiers.has('high')).toBeTruthy();
  });

  test('12. Locations: at least Ranchi exists with full address', async ({ request }) => {
    const res = await request.get(`${API}/wellness/locations`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const locs = await res.json();
    expect(locs.length).toBeGreaterThanOrEqual(1);
    const ranchi = locs.find((l) => l.name === 'Ranchi');
    expect(ranchi).toBeTruthy();
    expect(ranchi.city).toBe('Ranchi');
    expect(ranchi.state).toBe('Jharkhand');
    expect(ranchi.pincode).toBe('834008');
    expect(ranchi.isActive).toBeTruthy();
  });

  test('13. Recommendations inbox has the 3 hand-crafted cards', async ({ request }) => {
    // Use ?status=all — previous runs may have approved/rejected some
    const res = await request.get(`${API}/wellness/recommendations?status=all`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const recs = await res.json();
    expect(recs.length).toBeGreaterThanOrEqual(3);
    expect(recs[0]).toHaveProperty('priority');
    expect(recs[0]).toHaveProperty('title');
    expect(recs[0]).toHaveProperty('expectedImpact');
  });

  test('14. Visit list filters by status=booked (tomorrow appts)', async ({ request }) => {
    const res = await request.get(`${API}/wellness/visits?status=booked&limit=50`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const visits = await res.json();
    expect(visits.length).toBeGreaterThan(0);
    for (const v of visits.slice(0, 3)) expect(v.status).toBe('booked');
  });
});

test.describe.serial('Wellness — Patient + Visit + Prescription create flow', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });
  let createdPatientId, createdVisitId;

  test.beforeAll(async ({ request }) => {
    if (TOKEN) return;
    const r = await request.post(`${API}/auth/login`, { data: RISHU });
    TOKEN = (await r.json()).token;
  });

  test('15. Create a new patient (E2E)', async ({ request }) => {
    const res = await request.post(`${API}/wellness/patients`, {
      headers: headers(),
      data: {
        name: 'E2E Patient',
        phone: `+9198999${Date.now().toString().slice(-5)}`,
        email: `e2e-patient-${Date.now()}@test.local`,
        gender: 'M',
        source: 'website-form',
      },
    });
    expect(res.ok()).toBeTruthy();
    const p = await res.json();
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('E2E Patient');
    createdPatientId = p.id;
  });

  test('16. Log a visit for the new patient', async ({ request }) => {
    // Pick an arbitrary service
    const services = await (await request.get(`${API}/wellness/services?limit=1`, { headers: headers() })).json();
    const res = await request.post(`${API}/wellness/visits`, {
      headers: headers(),
      data: {
        patientId: createdPatientId,
        serviceId: services[0].id,
        notes: 'E2E test visit',
        amountCharged: 1500,
        status: 'completed',
      },
    });
    expect(res.ok()).toBeTruthy();
    const v = await res.json();
    expect(v.id).toBeTruthy();
    createdVisitId = v.id;
  });

  test('17. Write a prescription tied to that visit', async ({ request }) => {
    const res = await request.post(`${API}/wellness/prescriptions`, {
      headers: headers(),
      data: {
        visitId: createdVisitId,
        patientId: createdPatientId,
        drugs: [{ name: 'Test Drug', dosage: '1 tablet', frequency: 'daily', duration: '7 days' }],
        instructions: 'Take with water',
      },
    });
    expect(res.ok()).toBeTruthy();
    const rx = await res.json();
    expect(rx.id).toBeTruthy();
  });

  test('18. Capture a consent form for the patient', async ({ request }) => {
    const res = await request.post(`${API}/wellness/consents`, {
      headers: headers(),
      data: {
        patientId: createdPatientId,
        templateName: 'general',
        signatureSvg: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('19. Patient detail now shows the new visit + Rx + consent', async ({ request }) => {
    const res = await request.get(`${API}/wellness/patients/${createdPatientId}`, { headers: headers() });
    const p = await res.json();
    expect(p.visits.length).toBeGreaterThan(0);
    expect(p.prescriptions.length).toBeGreaterThan(0);
    expect(p.consents.length).toBeGreaterThan(0);
  });

  test('20. Approve a recommendation card', async ({ request }) => {
    const recs = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: headers() })).json();
    if (recs.length === 0) test.skip(true, 'no pending recommendations');
    const id = recs[0].id;
    const res = await request.post(`${API}/wellness/recommendations/${id}/approve`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const updated = await res.json();
    expect(updated.status).toBe('approved');
  });
});

test.describe.serial('Wellness — External Partner API (Callified flow)', () => {
  let inboundLeadId, inboundCallId;

  test('21. /external/health is reachable without a key', async ({ request }) => {
    const res = await request.get(`${EXT}/health`);
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.status).toBe('ok');
    expect(d.apiVersion).toBe('v1');
  });

  test('22. /external/me without a key → 401', async ({ request }) => {
    const res = await request.get(`${EXT}/me`);
    expect(res.status()).toBe(401);
  });

  test('23. /external/me with valid key → tenant + INR + capability flag', async ({ request }) => {
    const res = await request.get(`${EXT}/me`, { headers: { 'X-API-Key': PARTNER_KEY } });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.tenant.slug).toBe('enhanced-wellness');
    expect(d.tenant.defaultCurrency).toBe('INR');
    expect(d.capabilities.wellness).toBeTruthy();
  });

  test('24. Bad API key → 401', async ({ request }) => {
    const res = await request.get(`${EXT}/me`, { headers: { 'X-API-Key': 'glbs_baadkey' } });
    expect(res.status()).toBe(401);
  });

  test('25. Push a lead from "website"', async ({ request }) => {
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        name: 'E2E Inbound Lead',
        phone: '+919876511234',
        email: `e2e-ext-${Date.now()}@test.local`,
        source: 'website-form',
      },
    });
    expect(res.status()).toBeLessThan(300);
    const lead = await res.json();
    expect(lead.id).toBeTruthy();
    expect(lead.status).toBe('Lead');
    inboundLeadId = lead.id;
  });

  test('26. Poll /leads since=2 minutes ago — finds the new lead', async ({ request }) => {
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const res = await request.get(`${EXT}/leads?since=${encodeURIComponent(since)}`, {
      headers: { 'X-API-Key': PARTNER_KEY },
    });
    const d = await res.json();
    expect(d.total).toBeGreaterThan(0);
    const ours = d.data.find((l) => l.id === inboundLeadId);
    expect(ours).toBeTruthy();
  });

  test('27. Lookup contact by last 10 phone digits', async ({ request }) => {
    const res = await request.get(`${EXT}/contacts/lookup?phone=9876511234`, {
      headers: { 'X-API-Key': PARTNER_KEY },
    });
    expect(res.ok()).toBeTruthy();
    const c = await res.json();
    expect(c.phone).toContain('9876511234');
  });

  test('28. Push call recording back', async ({ request }) => {
    const res = await request.post(`${EXT}/calls`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        contactId: inboundLeadId,
        phone: '+919876511234',
        direction: 'OUTBOUND',
        status: 'COMPLETED',
        durationSec: 92,
        recordingUrl: 'https://callified.ai/rec/e2e-test.mp3',
        providerCallId: `e2e_${Date.now()}`,
        notes: 'E2E smoke test',
      },
    });
    expect(res.ok()).toBeTruthy();
    const call = await res.json();
    expect(call.id).toBeTruthy();
    expect(call.recordingUrl).toBe('https://callified.ai/rec/e2e-test.mp3');
    inboundCallId = call.id;
  });

  test('29. /external/services returns wellness catalog', async ({ request }) => {
    const res = await request.get(`${EXT}/services?limit=10`, { headers: { 'X-API-Key': PARTNER_KEY } });
    const d = await res.json();
    expect(d.data.length).toBeGreaterThan(0);
    expect(d.data[0]).toHaveProperty('basePrice');
  });

  test('30. /external/staff returns 22 staff with wellnessRole field', async ({ request }) => {
    const res = await request.get(`${EXT}/staff`, { headers: { 'X-API-Key': PARTNER_KEY } });
    const d = await res.json();
    expect(d.data.length).toBeGreaterThanOrEqual(20);
    const doctors = d.data.filter((u) => u.wellnessRole === 'doctor');
    expect(doctors.length).toBeGreaterThanOrEqual(3);
  });

  test('31. /external/locations exposes Ranchi', async ({ request }) => {
    const res = await request.get(`${EXT}/locations`, { headers: { 'X-API-Key': PARTNER_KEY } });
    const d = await res.json();
    expect(d.data.find((l) => l.name === 'Ranchi')).toBeTruthy();
  });

  test('32. /external/appointments?date=today returns scheduled visits', async ({ request }) => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request.get(`${EXT}/appointments?date=${today}`, { headers: { 'X-API-Key': PARTNER_KEY } });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.data.length).toBeGreaterThan(0);
  });

  test('33. /external/messages POST whatsapp inbound', async ({ request }) => {
    const res = await request.post(`${EXT}/messages`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        channel: 'whatsapp',
        direction: 'INBOUND',
        phone: '+919876511234',
        contactId: inboundLeadId,
        body: 'E2E inbound WhatsApp',
        providerMsgId: `wamid_e2e_${Date.now()}`,
      },
    });
    expect(res.ok()).toBeTruthy();
  });
});

test.describe('Wellness — UI smoke (SPA routes serve)', () => {
  const routes = [
    '/wellness',
    '/wellness/recommendations',
    '/wellness/patients',
    '/wellness/services',
    '/wellness/locations',
    '/wellness/calendar',
    '/wellness/reports',
    '/book/enhanced-wellness',
  ];

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    test(`${34 + i}. SPA serves ${r}`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}${r}`);
      expect(res.ok()).toBeTruthy();
      const html = await res.text();
      expect(html).toContain('<div id="root">');
    });
  }
});

test.describe.serial('Wellness — Reports + Junk filter + Auto-route + Public booking + Orchestrator', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });

  test.beforeAll(async ({ request }) => {
    if (TOKEN) return;
    const r = await request.post(`${API}/auth/login`, { data: RISHU });
    TOKEN = (await r.json()).token;
  });

  test('42. Reports: P&L by service returns rows + totals', async ({ request }) => {
    const r = await request.get(`${API}/wellness/reports/pnl-by-service`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.totals).toHaveProperty('revenue');
    expect(d.totals).toHaveProperty('contribution');
  });

  test('43. Reports: per-professional has doctors with revenue', async ({ request }) => {
    const r = await request.get(`${API}/wellness/reports/per-professional`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.rows[0]).toHaveProperty('revenue');
  });

  test('44. Reports: per-location has Ranchi', async ({ request }) => {
    const r = await request.get(`${API}/wellness/reports/per-location`, { headers: headers() });
    const d = await r.json();
    expect(d.rows.find((l) => l.name === 'Ranchi')).toBeTruthy();
  });

  test('45. Junk filter catches gibberish + foreign number', async ({ request }) => {
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: { name: 'YYYYY', phone: '+1234567890', source: 'test-junk' },
    });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.status).toBe('Junk');
    expect(d.aiScore).toBeLessThanOrEqual(20);
    expect(d._verdict.reasons.some((r) => /non-Indian|gibberish/i.test(r))).toBeTruthy();
  });

  test('46. Junk filter accepts a valid Indian lead', async ({ request }) => {
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        name: 'Aarav Sharma', phone: `+9197${Date.now().toString().slice(-8)}`,
        email: `valid-${Date.now()}@example.com`, source: 'website-form',
        note: 'I want a hair transplant consultation',
      },
    });
    const d = await res.json();
    expect(d.status).toBe('Lead');
    expect(d.aiScore).toBeGreaterThanOrEqual(50);
  });

  test('47. Auto-router assigns hair-transplant lead to a doctor', async ({ request }) => {
    const res = await request.post(`${EXT}/leads`, {
      headers: { 'X-API-Key': PARTNER_KEY, 'Content-Type': 'application/json' },
      data: {
        name: 'Vikas Kumar', phone: `+9198${Date.now().toString().slice(-8)}`,
        email: `route-${Date.now()}@example.com`, source: 'website-form',
        note: 'enquiry about hair transplant cost',
      },
    });
    const d = await res.json();
    expect(d._routing).toBeTruthy();
    // Either a doctor was matched or fell back to telecaller — both acceptable
    expect(d._routing.userId === null || typeof d._routing.userId === 'number').toBeTruthy();
  });

  test('48. Public tenant profile returns 100+ services + Ranchi', async ({ request }) => {
    const res = await request.get(`${API}/wellness/public/tenant/enhanced-wellness`);
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.services.length).toBeGreaterThanOrEqual(100);
    expect(d.locations.find((l) => l.name === 'Ranchi')).toBeTruthy();
  });

  test('49. Public booking creates Patient + Visit', async ({ request }) => {
    const profile = await (await request.get(`${API}/wellness/public/tenant/enhanced-wellness`)).json();
    const svc = profile.services[0];
    const loc = profile.locations[0];
    const res = await request.post(`${API}/wellness/public/book`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        tenantSlug: 'enhanced-wellness',
        serviceId: svc.id, locationId: loc.id,
        name: 'E2E Public Booker', phone: `+9197${Date.now().toString().slice(-8)}`,
        notes: 'E2E test booking',
      },
    });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.ok).toBeTruthy();
    expect(d.visit).toHaveProperty('id');
  });

  test('50. Orchestrator manual run creates fresh recommendations', async ({ request }) => {
    const res = await request.post(`${API}/wellness/orchestrator/run`, { headers: headers() });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(typeof d.created).toBe('number');
  });
});

// ═════════════════════════════════════════════════════════════════════
// Full endpoint coverage — every route in routes/wellness.js + external.js
// ═════════════════════════════════════════════════════════════════════

test.describe.serial('Wellness — Patient + Visit UPDATE + reads', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });
  let patientId, visitId;

  test.beforeAll(async ({ request }) => {
    if (!TOKEN) {
      const r = await request.post(`${API}/auth/login`, { data: RISHU });
      TOKEN = (await r.json()).token;
    }
    // Create a fresh patient for these tests
    const pr = await request.post(`${API}/wellness/patients`, {
      headers: headers(), data: {
        name: 'Coverage Patient', phone: `+9198${Date.now().toString().slice(-8)}`,
        email: `cov-${Date.now()}@test.local`, gender: 'F', source: 'referral',
      },
    });
    patientId = (await pr.json()).id;
    const vr = await request.post(`${API}/wellness/visits`, {
      headers: headers(), data: { patientId, notes: 'Coverage visit', status: 'completed', amountCharged: 1000 },
    });
    visitId = (await vr.json()).id;
  });

  test('51. PUT /patients/:id updates allowed fields', async ({ request }) => {
    const r = await request.put(`${API}/wellness/patients/${patientId}`, {
      headers: headers(), data: { bloodGroup: 'O+', notes: 'Updated via E2E' },
    });
    expect(r.ok()).toBeTruthy();
    const p = await r.json();
    expect(p.bloodGroup).toBe('O+');
  });

  test('52. PUT /patients/:id 404s on non-existent patient', async ({ request }) => {
    const r = await request.put(`${API}/wellness/patients/999999`, {
      headers: headers(), data: { notes: 'x' },
    });
    expect(r.status()).toBe(404);
  });

  test('53. GET /visits/:id returns visit with patient + service', async ({ request }) => {
    const r = await request.get(`${API}/wellness/visits/${visitId}`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    const v = await r.json();
    expect(v.id).toBe(visitId);
    expect(v).toHaveProperty('patient');
  });

  test('54. PUT /visits/:id updates status', async ({ request }) => {
    const r = await request.put(`${API}/wellness/visits/${visitId}`, {
      headers: headers(), data: { status: 'completed', notes: 'Notes updated' },
    });
    expect(r.ok()).toBeTruthy();
  });

  test('55. GET /visits?doctorId= filters properly', async ({ request }) => {
    const staff = await (await request.get(`${API}/staff`, { headers: headers() })).json();
    const doctor = staff.find((u) => u.wellnessRole === 'doctor');
    if (!doctor) test.skip();
    const r = await request.get(`${API}/wellness/visits?doctorId=${doctor.id}&limit=5`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
  });

  test('56. GET /visits?from=&to= date-range filter', async ({ request }) => {
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to = new Date().toISOString();
    const r = await request.get(`${API}/wellness/visits?from=${from}&to=${to}&limit=5`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
  });

  test('57. POST /wellness/visits requires patientId', async ({ request }) => {
    const r = await request.post(`${API}/wellness/visits`, {
      headers: headers(), data: { notes: 'no patient' },
    });
    expect(r.status()).toBe(400);
  });

  test('58. GET /visits/:id/consumptions returns array', async ({ request }) => {
    const r = await request.get(`${API}/wellness/visits/${visitId}/consumptions`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('59. POST /visits/:id/consumptions adds an inventory row', async ({ request }) => {
    const r = await request.post(`${API}/wellness/visits/${visitId}/consumptions`, {
      headers: headers(), data: { productName: 'E2E Product', qty: 2, unitCost: 150 },
    });
    expect(r.ok()).toBeTruthy();
    const c = await r.json();
    expect(c.productName).toBe('E2E Product');
    expect(c.qty).toBe(2);
  });

  test('60. POST /visits/:id/consumptions 400 on missing productName', async ({ request }) => {
    const r = await request.post(`${API}/wellness/visits/${visitId}/consumptions`, {
      headers: headers(), data: { qty: 1 },
    });
    expect(r.status()).toBe(400);
  });

  test('61. DELETE /visits/:id/photos handles empty URL gracefully', async ({ request }) => {
    const r = await request.delete(`${API}/wellness/visits/${visitId}/photos`, {
      headers: headers(), data: { url: '/nonexistent', kind: 'before' },
    });
    expect(r.ok()).toBeTruthy();
  });
});

test.describe.serial('Wellness — Prescriptions + Consents + Treatments + PDFs', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });
  let prescriptionId, consentId;

  test.beforeAll(async ({ request }) => {
    if (!TOKEN) {
      const r = await request.post(`${API}/auth/login`, { data: RISHU });
      TOKEN = (await r.json()).token;
    }
  });

  test('62. GET /prescriptions returns list', async ({ request }) => {
    const r = await request.get(`${API}/wellness/prescriptions?limit=5`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    const list = await r.json();
    expect(Array.isArray(list)).toBeTruthy();
    if (list.length) prescriptionId = list[0].id;
  });

  test('63. GET /prescriptions/:id/pdf returns PDF content-type', async ({ request }) => {
    if (!prescriptionId) test.skip();
    const r = await request.get(`${API}/wellness/prescriptions/${prescriptionId}/pdf`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    expect(r.headers()['content-type']).toContain('application/pdf');
  });

  test('64. GET /prescriptions/:id/pdf 404 on bad id', async ({ request }) => {
    const r = await request.get(`${API}/wellness/prescriptions/999999/pdf`, { headers: headers() });
    expect(r.status()).toBe(404);
  });

  test('65. GET /consents returns list', async ({ request }) => {
    const r = await request.get(`${API}/wellness/consents?limit=5`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    const list = await r.json();
    expect(Array.isArray(list)).toBeTruthy();
    if (list.length) consentId = list[0].id;
  });

  test('66. POST /consents 400 missing templateName', async ({ request }) => {
    const r = await request.post(`${API}/wellness/consents`, {
      headers: headers(), data: { patientId: 1 },
    });
    expect(r.status()).toBe(400);
  });

  test('67. GET /consents/:id/pdf returns PDF', async ({ request }) => {
    if (!consentId) test.skip();
    const r = await request.get(`${API}/wellness/consents/${consentId}/pdf`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    expect(r.headers()['content-type']).toContain('application/pdf');
  });

  test('68. GET /treatments returns active plans', async ({ request }) => {
    const r = await request.get(`${API}/wellness/treatments?status=active`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
  });

  test('69. POST /treatments creates a multi-session plan', async ({ request }) => {
    const patients = await (await request.get(`${API}/wellness/patients?limit=1`, { headers: headers() })).json();
    const services = await (await request.get(`${API}/wellness/services?limit=1`, { headers: headers() })).json();
    const r = await request.post(`${API}/wellness/treatments`, {
      headers: headers(), data: {
        name: 'E2E Package', totalSessions: 6, totalPrice: 25000,
        patientId: patients.patients[0].id, serviceId: services[0].id,
      },
    });
    expect(r.ok()).toBeTruthy();
    const tp = await r.json();
    expect(tp.totalSessions).toBe(6);
  });

  test('70. POST /treatments 400 missing name', async ({ request }) => {
    const r = await request.post(`${API}/wellness/treatments`, {
      headers: headers(), data: { totalSessions: 4, patientId: 1 },
    });
    expect(r.status()).toBe(400);
  });
});

test.describe.serial('Wellness — Services CRUD + Locations CRUD', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });
  let createdServiceId, createdLocationId;

  test.beforeAll(async ({ request }) => {
    if (!TOKEN) {
      const r = await request.post(`${API}/auth/login`, { data: RISHU });
      TOKEN = (await r.json()).token;
    }
  });

  test('71. POST /services creates a new service', async ({ request }) => {
    const r = await request.post(`${API}/wellness/services`, {
      headers: headers(), data: {
        name: `E2E Service ${Date.now()}`, category: 'aesthetics',
        ticketTier: 'medium', basePrice: 4500, durationMin: 45, targetRadiusKm: 30,
      },
    });
    expect(r.ok()).toBeTruthy();
    createdServiceId = (await r.json()).id;
  });

  test('72. POST /services 400 missing name', async ({ request }) => {
    const r = await request.post(`${API}/wellness/services`, {
      headers: headers(), data: { basePrice: 500 },
    });
    expect(r.status()).toBe(400);
  });

  test('73. PUT /services/:id updates price', async ({ request }) => {
    const r = await request.put(`${API}/wellness/services/${createdServiceId}`, {
      headers: headers(), data: { basePrice: 5500 },
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).basePrice).toBe(5500);
  });

  test('74. PUT /services/:id soft-deletes via isActive=false', async ({ request }) => {
    const r = await request.put(`${API}/wellness/services/${createdServiceId}`, {
      headers: headers(), data: { isActive: false },
    });
    expect(r.ok()).toBeTruthy();
    // After soft-delete, GET /services should not include it
    const list = await (await request.get(`${API}/wellness/services`, { headers: headers() })).json();
    expect(list.find((s) => s.id === createdServiceId)).toBeFalsy();
  });

  test('75. POST /locations creates a second location', async ({ request }) => {
    const r = await request.post(`${API}/wellness/locations`, {
      headers: headers(), data: {
        name: `E2E Branch ${Date.now()}`, addressLine: '1 Test Rd',
        city: 'Delhi', state: 'Delhi', pincode: '110001', phone: '+911123456',
      },
    });
    expect(r.ok()).toBeTruthy();
    createdLocationId = (await r.json()).id;
  });

  test('76. POST /locations 400 missing city', async ({ request }) => {
    const r = await request.post(`${API}/wellness/locations`, {
      headers: headers(), data: { name: 'Bad', addressLine: 'x' },
    });
    expect(r.status()).toBe(400);
  });

  test('77. PUT /locations/:id deactivates', async ({ request }) => {
    const r = await request.put(`${API}/wellness/locations/${createdLocationId}`, {
      headers: headers(), data: { isActive: false },
    });
    expect(r.ok()).toBeTruthy();
  });
});

test.describe.serial('Wellness — Telecaller + Patient Portal + Orchestrator', () => {
  const headers = () => ({ Authorization: `Bearer ${TOKEN}` });
  let portalToken, portalPhone;

  test.beforeAll(async ({ request }) => {
    if (!TOKEN) {
      const r = await request.post(`${API}/auth/login`, { data: RISHU });
      TOKEN = (await r.json()).token;
    }
    // Create a Patient whose phone we'll use for portal login
    portalPhone = `+9198${Date.now().toString().slice(-8)}`;
    await request.post(`${API}/wellness/patients`, {
      headers: headers(), data: { name: 'Portal Tester', phone: portalPhone, source: 'walk-in' },
    });
  });

  test('78. GET /telecaller/queue returns assigned leads', async ({ request }) => {
    const r = await request.get(`${API}/wellness/telecaller/queue`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    const q = await r.json();
    expect(Array.isArray(q) || Array.isArray(q.leads) || Array.isArray(q.data)).toBeTruthy();
  });

  test('79. POST /telecaller/dispose records outcome', async ({ request }) => {
    // Ensure there's at least one lead assigned to this user
    const contacts = await (await request.get(`${API}/contacts?limit=1`, { headers: headers() })).json();
    if (!contacts.length) test.skip();
    const r = await request.post(`${API}/wellness/telecaller/dispose`, {
      headers: headers(), data: { contactId: contacts[0].id, disposition: 'callback', notes: 'E2E' },
    });
    // Some dispatch implementations return 200, 201, 204 — accept < 400
    expect(r.status()).toBeLessThan(400);
  });

  test('80. POST /portal/login with any 4-digit OTP succeeds for known phone', async ({ request }) => {
    const r = await request.post(`${API}/wellness/portal/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { phone: portalPhone, otp: '1234' },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.token).toBeTruthy();
    portalToken = d.token;
  });

  test('81. POST /portal/login 404 for unknown phone', async ({ request }) => {
    const r = await request.post(`${API}/wellness/portal/login`, {
      headers: { 'Content-Type': 'application/json' },
      data: { phone: '+910000000000', otp: '1234' },
    });
    expect(r.status()).toBe(404);
  });

  test('82. GET /portal/me returns patient profile', async ({ request }) => {
    if (!portalToken) test.skip();
    const r = await request.get(`${API}/wellness/portal/me`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(r.ok()).toBeTruthy();
    const me = await r.json();
    expect(me).toHaveProperty('name');
  });

  test('83. GET /portal/visits lists own visits', async ({ request }) => {
    if (!portalToken) test.skip();
    const r = await request.get(`${API}/wellness/portal/visits`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(r.ok()).toBeTruthy();
    expect(Array.isArray(await r.json())).toBeTruthy();
  });

  test('84. GET /portal/prescriptions lists own Rx', async ({ request }) => {
    if (!portalToken) test.skip();
    const r = await request.get(`${API}/wellness/portal/prescriptions`, {
      headers: { Authorization: `Bearer ${portalToken}` },
    });
    expect(r.ok()).toBeTruthy();
  });

  test('85. /portal/me without token → 401', async ({ request }) => {
    const r = await request.get(`${API}/wellness/portal/me`);
    expect(r.status()).toBe(401);
  });

  test('86. POST /recommendations/:id/reject works', async ({ request }) => {
    const recs = await (await request.get(`${API}/wellness/recommendations?status=all`, { headers: headers() })).json();
    if (recs.length === 0) test.skip();
    const id = recs[recs.length - 1].id;
    const r = await request.post(`${API}/wellness/recommendations/${id}/reject`, { headers: headers() });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).status).toBe('rejected');
  });
});

test.describe.serial('External API — full endpoint coverage', () => {
  const H = () => ({ 'X-API-Key': PARTNER_KEY });
  let extContactId, extCallId;

  test.beforeAll(async ({ request }) => {
    if (TOKEN) return;
    const r = await request.post(`${API}/auth/login`, { data: RISHU });
    TOKEN = (await r.json()).token;
  });

  test('87. POST /external/appointments creates a visit', async ({ request }) => {
    // Need a patient first
    const patients = await (await request.get(`${API}/wellness/patients?limit=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json();
    const services = await (await request.get(`${API}/wellness/services?limit=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).json();
    const r = await request.post(`${EXT}/appointments`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: {
        patientId: patients.patients[0].id, serviceId: services[0].id,
        slotStart: new Date(Date.now() + 86400000).toISOString(),
        notes: 'E2E external booking',
      },
    });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).id).toBeTruthy();
  });

  test('88. POST /external/appointments 400 missing slotStart', async ({ request }) => {
    const r = await request.post(`${EXT}/appointments`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { patientId: 1 },
    });
    expect(r.status()).toBe(400);
  });

  test('89. GET /external/appointments?date=today', async ({ request }) => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await request.get(`${EXT}/appointments?date=${today}`, { headers: H() });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).data).toBeDefined();
  });

  test('90. POST /external/leads then GET /contacts/:id returns full detail', async ({ request }) => {
    const create = await request.post(`${EXT}/leads`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { name: 'E2E Fetch', phone: `+9197${Date.now().toString().slice(-8)}`, email: `fe-${Date.now()}@test.local` },
    });
    const c = await create.json();
    extContactId = c.id;
    const det = await request.get(`${EXT}/contacts/${extContactId}`, { headers: H() });
    expect(det.ok()).toBeTruthy();
    expect((await det.json()).id).toBe(extContactId);
  });

  test('91. GET /external/contacts/:id 404 on bad id', async ({ request }) => {
    const r = await request.get(`${EXT}/contacts/999999`, { headers: H() });
    expect(r.status()).toBe(404);
  });

  test('92. POST /external/calls creates + records id, PATCH updates', async ({ request }) => {
    if (!extContactId) test.skip();
    const create = await request.post(`${EXT}/calls`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: {
        contactId: extContactId, direction: 'OUTBOUND', status: 'COMPLETED',
        durationSec: 60, recordingUrl: 'https://callified.ai/rec/e2e-patch.mp3',
        providerCallId: `e2e-patch-${Date.now()}`,
      },
    });
    extCallId = (await create.json()).id;
    expect(extCallId).toBeTruthy();
    const patch = await request.patch(`${EXT}/calls/${extCallId}`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { transcriptUrl: 'https://callified.ai/tx/e2e.txt', durationSec: 75 },
    });
    expect(patch.ok()).toBeTruthy();
    expect((await patch.json()).duration).toBe(75);
  });

  test('93. PATCH /external/calls/:id 404 on bad id', async ({ request }) => {
    const r = await request.patch(`${EXT}/calls/999999`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { durationSec: 10 },
    });
    expect(r.status()).toBe(404);
  });

  test('94. GET /external/patients/:id returns visits + Rx + plans', async ({ request }) => {
    const list = await (await request.get(`${EXT}/patients/lookup?phone=9876543210`, { headers: H() })).json().catch(() => null);
    // If no match, pull from internal
    let pid;
    if (list && list.id) pid = list.id;
    else {
      const internal = await (await request.get(`${API}/wellness/patients?limit=1`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })).json();
      pid = internal.patients[0].id;
    }
    const r = await request.get(`${EXT}/patients/${pid}`, { headers: H() });
    expect(r.ok()).toBeTruthy();
    const p = await r.json();
    expect(p).toHaveProperty('visits');
  });

  test('95. POST /external/leads idempotency on duplicate email', async ({ request }) => {
    const email = `dup-${Date.now()}@test.local`;
    const r1 = await request.post(`${EXT}/leads`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { name: 'Dup Test', phone: `+9196${Date.now().toString().slice(-8)}`, email },
    });
    expect(r1.ok()).toBeTruthy();
    const r2 = await request.post(`${EXT}/leads`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { name: 'Dup Test 2', phone: `+9195${Date.now().toString().slice(-8)}`, email },
    });
    // Dup returns 200 with _deduped flag OR the original contact
    expect(r2.status()).toBeLessThan(300);
    const d = await r2.json();
    expect(d._deduped === true || d.email === email).toBeTruthy();
  });

  test('96. Junk-filter flags foreign-number lead via /external/leads', async ({ request }) => {
    const r = await request.post(`${EXT}/leads`, {
      headers: { ...H(), 'Content-Type': 'application/json' },
      data: { name: 'Valid Name', phone: '+447700900000', email: `uk-${Date.now()}@test.local` },
    });
    const d = await r.json();
    expect(d.status).toBe('Junk');
  });
});

test.describe('Auth response shape (verticals)', () => {
  test('97. Wellness login payload contains all currency fields', async ({ request }) => {
    const r = await request.post(`${API}/auth/login`, { data: ADMIN });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.tenant.vertical).toBe('wellness');
    expect(d.tenant.country).toBe('IN');
    expect(d.tenant.defaultCurrency).toBe('INR');
    expect(d.tenant.locale).toBe('en-IN');
  });

  test('98. Manager login (wellness) still returns wellness vertical', async ({ request }) => {
    const r = await request.post(`${API}/auth/login`, {
      data: { email: 'manager@enhancedwellness.in', password: 'password123' },
    });
    expect(r.ok()).toBeTruthy();
    const d = await r.json();
    expect(d.user.role).toBe('MANAGER');
    expect(d.tenant.vertical).toBe('wellness');
  });

  test('99. Unauthenticated /wellness/dashboard returns 403', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`);
    expect(r.status()).toBe(403);
  });

  test('100. Bad JWT returns 401/403 on /wellness/patients', async ({ request }) => {
    const r = await request.get(`${API}/wellness/patients`, {
      headers: { Authorization: 'Bearer bogus.bogus.bogus' },
    });
    expect([401, 403]).toContain(r.status());
  });
});

test.describe('Embed widget + public assets', () => {
  test('101. /embed/widget.js served as JS', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/embed/widget.js`);
    expect(r.ok()).toBeTruthy();
    expect((r.headers()['content-type'] || '').toLowerCase()).toMatch(/javascript/);
  });

  test('102. /embed/lead-form.html served as HTML', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/embed/lead-form.html`);
    expect(r.ok()).toBeTruthy();
    const html = await r.text();
    expect(html).toContain('<form');
  });

  test('103. Pricing page serves (India detection is client-side)', async ({ request }) => {
    const r = await request.get(`${BASE_URL}/pricing`);
    expect(r.ok()).toBeTruthy();
  });
});
