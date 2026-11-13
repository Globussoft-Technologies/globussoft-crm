// Gate coverage for the TMC parent travel-document endpoints. The full
// authenticated upload and private-file flow is covered by backend route tests;
// these checks pin the public auth boundary used by CI's request-only gate.

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';

test.describe('TMC parent documents API — auth boundary', () => {
  test('document list requires a portal token', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/portal/tmc/parent/documents`);
    expect(response.status()).toBe(401);
  });

  test('document upload requires a portal token', async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/portal/tmc/parent/documents`, {
      multipart: {
        tripId: '7',
        documentRequirementId: '102',
        file: { name: 'medical-clearance.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') },
      },
    });
    expect(response.status()).toBe(401);
  });

  test('document files require a portal token', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/portal/tmc/parent/documents/11/file`);
    expect(response.status()).toBe(401);
  });
});
