// @ts-check
const { test, expect } = require('@playwright/test');

test.describe.configure({ mode: 'serial' });

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const IS_LOCAL_STACK = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(BASE_URL);

async function login(request, email) {
  const response = await request.post(`${BASE_URL}/api/auth/login`, {
    data: { email, password: 'password123' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token;
}

const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

test('Travel admin can list meeting forms and eligible hosts', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const forms = await request.get(`${BASE_URL}/api/travel/meeting-forms`, { headers: auth(token) });
  expect(forms.status()).toBe(200);
  expect(Array.isArray(await forms.json())).toBeTruthy();

  const hosts = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  expect(hosts.status()).toBe(200);
  const rows = await hosts.json();
  expect(Array.isArray(rows)).toBeTruthy();
  expect(rows.every((row) => Array.isArray(row.calendarIntegrations))).toBeTruthy();

  const zoom = await request.get(`${BASE_URL}/api/travel/meeting-forms/zoom-config`, { headers: auth(token) });
  expect(zoom.status()).toBe(200);
  const zoomStatus = await zoom.json();
  expect(typeof zoomStatus.configured).toBe('boolean');
  expect(zoomStatus.clientSecret).toBeUndefined();
  expect(zoomStatus.clientSecretEncrypted).toBeUndefined();
});

test('Generic CRM tenant cannot access Travel Meeting Forms', async ({ request }) => {
  const token = await login(request, 'admin@globussoft.com');
  const response = await request.get(`${BASE_URL}/api/travel/meeting-forms`, { headers: auth(token) });
  expect(response.status()).toBe(403);
});

test('Create validation rejects an invalid host without writing a form', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const response = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: { name: 'Invalid host probe', hostUserId: 2147483647, timezone: 'Asia/Kolkata' },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('INVALID_HOST');
});

test('Create validation rejects an enabled Select field without options', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const hostsResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  expect(hostsResponse.status()).toBe(200);
  const hosts = await hostsResponse.json();
  test.skip(!hosts[0], 'Travel tenant has no eligible staff host');

  const response = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: {
      name: 'Invalid select options probe',
      hostUserId: hosts[0].id,
      timezone: 'Asia/Kolkata',
      fields: [{ key: 'custom_choice', label: 'Choose one', type: 'select', enabled: true, options: [] }],
    },
  });
  expect(response.status()).toBe(400);
  expect((await response.json()).code).toBe('SELECT_OPTIONS_REQUIRED');
});

test('Create validation rejects invalid Meeting Form date limits', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const hostsResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  expect(hostsResponse.status()).toBe(200);
  const hosts = await hostsResponse.json();
  test.skip(!hosts[0], 'Travel tenant has no eligible staff host');

  const invertedRange = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: {
      name: 'Invalid date range probe',
      hostUserId: hosts[0].id,
      timezone: 'Asia/Kolkata',
      allowedStartDate: '2099-02-10',
      allowedEndDate: '2099-02-09',
    },
  });
  expect(invertedRange.status()).toBe(400);
  expect(await invertedRange.json()).toMatchObject({ code: 'INVALID_DATE_RANGE' });

  const pastEndDate = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: {
      name: 'Past end date probe',
      hostUserId: hosts[0].id,
      timezone: 'Asia/Kolkata',
      allowedEndDate: '2000-01-01',
    },
  });
  expect(pastEndDate.status()).toBe(400);
  expect(await pastEndDate.json()).toMatchObject({ code: 'END_DATE_IN_PAST' });
});

test('Travel admin can delete a Meeting Form that has no bookings', async ({ request }) => {
  const token = await login(request, 'yasin@travelstall.in');
  const hostsResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  expect(hostsResponse.status()).toBe(200);
  const hosts = await hostsResponse.json();
  test.skip(!hosts[0], 'Travel tenant has no eligible staff host');

  const marker = `${Date.now()}-${process.pid}`;
  const createResponse = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
    headers: auth(token),
    data: {
      name: `Delete form probe ${marker}`,
      slug: `delete-form-probe-${marker}`,
      hostUserId: hosts[0].id,
      timezone: 'Asia/Kolkata',
      isActive: false,
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json();

  const deleteResponse = await request.delete(`${BASE_URL}/api/travel/meeting-forms/${created.id}`, { headers: auth(token) });
  expect(deleteResponse.status()).toBe(200);
  expect(await deleteResponse.json()).toMatchObject({ success: true, id: created.id });

  const readResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/${created.id}`, { headers: auth(token) });
  expect(readResponse.status()).toBe(404);
});

test('Unknown public form does not disclose tenant data', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/api/travel/meeting-forms/public/tmcmf_not_a_real_form`);
  expect(response.status()).toBe(404);
  expect((await response.json()).code).toBe('NOT_FOUND');
});

test('External scheduler can store a confirmed booking without CRM providers', async ({ request }) => {
  test.skip(!IS_LOCAL_STACK, 'writes and directly cleans an external-booking fixture; runs in the per-push local API gate');
  const token = await login(request, 'yasin@travelstall.in');
  const hostsResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/hosts`, { headers: auth(token) });
  const hosts = await hostsResponse.json();
  test.skip(!hosts[0], 'Travel tenant has no eligible staff host');
  const marker = `${Date.now()}-${process.pid}`;
  let created;
  try {
    const createResponse = await request.post(`${BASE_URL}/api/travel/meeting-forms`, {
      headers: auth(token),
      data: {
        name: `External booking probe ${marker}`,
        slug: `external-booking-probe-${marker}`,
        hostUserId: hosts[0].id,
        timezone: 'Asia/Kolkata',
        createZoom: false,
        createCalendarEvent: false,
        sendConfirmationEmail: false,
        isActive: true,
      },
    });
    expect(createResponse.status()).toBe(201);
    created = await createResponse.json();

    for (const url of ['javascript:alert(1)', 'https://zoom.us.evil.test/j/123']) {
      const invalid = await request.post(`${BASE_URL}/api/travel/meeting-forms/public/${created.publicKey}/external-bookings`, {
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `invalid-${marker}-${url.length}` },
        data: { firstName: 'Priya', lastName: 'Sharma', email: 'priya@school.edu.in',
          selectedStartTime: '2099-10-09T10:00:00+05:30', zoomJoinUrl: url },
      });
      expect(invalid.status()).toBe(400);
      expect((await invalid.json()).code).toBe('INVALID_MEETING_URL');
    }

    const bookingResponse = await request.post(`${BASE_URL}/api/travel/meeting-forms/public/${created.publicKey}/external-bookings`, {
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `external-${marker}` },
      data: {
        firstName: 'Priya',
        lastName: 'Sharma',
        email: 'priya@school.edu.in',
        selectedStartTime: '2099-10-09T10:00:00+05:30',
        duration: 30,
        timezone: 'Asia/Kolkata',
        zoomEventId: `zoom-${marker}`,
      },
    });
    expect(bookingResponse.status()).toBe(201);
    expect(await bookingResponse.json()).toMatchObject({ success: true, storedOnly: true, booking: { zoomEventId: `zoom-${marker}`, emailStatus: 'EXTERNAL' } });

    const bookingsResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/${created.id}/bookings`, { headers: auth(token) });
    expect(bookingsResponse.status()).toBe(200);
    expect(await bookingsResponse.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ zoomMeetingId: `zoom-${marker}`, emailChannel: 'external_scheduler' }),
    ]));
    const pagedResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/${created.id}/bookings?page=1&pageSize=1`, { headers: auth(token) });
    expect(pagedResponse.status()).toBe(200);
    expect(await pagedResponse.json()).toMatchObject({ total: 1, page: 1, pageSize: 1, totalPages: 1, items: [expect.objectContaining({ zoomMeetingId: `zoom-${marker}` })] });
    const invalidPageResponse = await request.get(`${BASE_URL}/api/travel/meeting-forms/${created.id}/bookings?page=0&pageSize=1`, { headers: auth(token) });
    expect(invalidPageResponse.status()).toBe(400);
    const booking = (await bookingsResponse.json()).find((row) => row.zoomMeetingId === `zoom-${marker}`);
    const retryResponse = await request.post(`${BASE_URL}/api/travel/meeting-forms/${created.id}/bookings/${booking.id}/retry-calendar`, { headers: auth(token) });
    expect(retryResponse.status()).toBe(409);
    const deleteResponse = await request.delete(`${BASE_URL}/api/travel/meeting-forms/${created.id}/bookings/${booking.id}`, { headers: auth(token) });
    expect(deleteResponse.status()).toBe(200);
    expect(await deleteResponse.json()).toMatchObject({ deletedBookingId: booking.id });
  } finally {
    if (created?.id) {
      const prisma = require('../../backend/lib/prisma');
      await prisma.travelMeetingBooking.deleteMany({ where: { meetingFormId: created.id } });
      await prisma.travelMeetingForm.deleteMany({ where: { id: created.id } });
    }
  }
});
