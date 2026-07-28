import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';
const RUN_TAG = `wellness-public-enquiry-${Date.now()}`;

test.describe.serial('Wellness public enquiry API', () => {
  const uniquePhone = '9' + String(Date.now()).slice(-9);
  const uniqueEmail = `${RUN_TAG}@example.com`;

  test('POST /api/wellness/public/enquiry creates a wellness lead', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/wellness/public/enquiry`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        firstName: 'Asha',
        lastName: 'Iyer',
        email: uniqueEmail,
        phone: uniquePhone,
        service: 'Hair Restoration',
        message: `${RUN_TAG} checking consultation availability`,
      },
    });

    expect(res.ok(), `create enquiry: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(typeof body.contactId).toBe('number');
    expect(body.message).toMatch(/we'll be in touch/i);
  });

  test('duplicate enquiry returns duplicate:true instead of creating a second lead', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/wellness/public/enquiry`, {
      data: {
        tenantSlug: 'enhanced-wellness',
        firstName: 'Asha',
        lastName: 'Iyer',
        email: uniqueEmail,
        phone: uniquePhone,
        service: 'Hair Restoration',
        message: `${RUN_TAG} duplicate submission`,
      },
    });

    expect(res.ok(), `duplicate enquiry: ${await res.text()}`).toBeTruthy();
    const body = await res.json();
    expect(body.created).toBe(false);
    expect(body.duplicate).toBe(true);
    expect(typeof body.contactId).toBe('number');
  });
});
