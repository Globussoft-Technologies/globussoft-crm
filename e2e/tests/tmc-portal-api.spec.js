// @ts-check
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const REQUEST_TIMEOUT = 60000;

async function login(request, email) {
  const res = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(200);
  return (await res.json()).token;
}

async function loginTeacherPortal(request) {
  const res = await request.post(`${BASE_URL}/api/portal/login`, {
    data: {
      email: 'teacher@getairmail.com',
      password: 'password123',
      portalRole: 'TEACHER',
    },
    timeout: REQUEST_TIMEOUT,
  });
  expect(res.status(), `teacher portal login: ${await res.text()}`).toBe(200);
  return (await res.json()).token;
}

test.describe('TMC portal API security contract', () => {
  test('teacher portal rejects requests without a portal token', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/portal/tmc/teacher/me`, {
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_TOKEN_REQUIRED' });
  });

  test('a staff JWT cannot be substituted for a contact portal JWT', async ({ request }) => {
    const token = await login(request, 'yasin@travelstall.in');
    const res = await request.get(`${BASE_URL}/api/portal/tmc/teacher/me`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'INVALID_PORTAL_TOKEN' });
  });

  test('generic-tenant staff cannot access the travel-only teacher directory', async ({ request }) => {
    const token = await login(request, 'admin@globussoft.com');
    const res = await request.get(`${BASE_URL}/api/portal/tmc/staff/teachers`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status()).toBe(403);
  });

  test('travel admin can list only the tenant-scoped TMC teacher directory', async ({ request }) => {
    const token = await login(request, 'yasin@travelstall.in');
    const res = await request.get(`${BASE_URL}/api/portal/tmc/staff/teachers`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.teachers)).toBe(true);
    for (const teacher of body.teachers) {
      expect(teacher).toEqual(expect.objectContaining({ id: expect.any(Number) }));
      expect(teacher).not.toHaveProperty('portalPasswordHash');
      expect(teacher).not.toHaveProperty('tenantId');
    }
  });

  test('assigned teacher can open the participant, payment, and rooming ledgers from Trips', async ({ request }) => {
    const token = await loginTeacherPortal(request);
    const headers = { Authorization: `Bearer ${token}` };
    const tripsRes = await request.get(`${BASE_URL}/api/portal/tmc/teacher/trips`, { headers, timeout: REQUEST_TIMEOUT });
    expect(tripsRes.status(), await tripsRes.text()).toBe(200);
    const trips = (await tripsRes.json()).trips || [];
    test.skip(trips.length === 0, 'The seeded tenant has no assigned teacher trips');

    const tripId = trips[0].id;
    const [participantsRes, paymentPlanRes, instalmentsRes, roomingRes] = await Promise.all([
      request.get(`${BASE_URL}/api/portal/tmc/teacher/trips/${tripId}/participants`, { headers, timeout: REQUEST_TIMEOUT }),
      request.get(`${BASE_URL}/api/portal/tmc/teacher/trips/${tripId}/payment-plan`, { headers, timeout: REQUEST_TIMEOUT }),
      request.get(`${BASE_URL}/api/portal/tmc/teacher/trips/${tripId}/instalments`, { headers, timeout: REQUEST_TIMEOUT }),
      request.get(`${BASE_URL}/api/portal/tmc/teacher/trips/${tripId}/rooming`, { headers, timeout: REQUEST_TIMEOUT }),
    ]);

    expect(participantsRes.status(), await participantsRes.text()).toBe(200);
    expect((await participantsRes.json()).participants).toEqual(expect.any(Array));
    expect([200, 404]).toContain(paymentPlanRes.status());
    expect(instalmentsRes.status(), await instalmentsRes.text()).toBe(200);
    expect((await instalmentsRes.json()).instalments).toEqual(expect.any(Array));
    expect(roomingRes.status(), await roomingRes.text()).toBe(200);
    expect((await roomingRes.json()).rooming).toEqual(expect.any(Array));
  });
});
