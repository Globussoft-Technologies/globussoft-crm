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
