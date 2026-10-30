// @ts-check

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createRequire } from 'node:module';

import express from 'express';

import request from 'supertest';

import prisma from '../../lib/prisma.js';


const requireCJS = createRequire(import.meta.url);
const fs = requireCJS('node:fs');
const { runInNewContext } = requireCJS('node:vm');
const axios = requireCJS('axios');
axios.post = vi.fn();

const authMw = requireCJS('../../middleware/auth');

/**
 * @param {import('express').Request} _req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
authMw.verifyToken = (_req, _res, next) => next();


const emailSender = requireCJS('../../lib/emailSender');

emailSender.sendEmail = vi.fn().mockResolvedValue({ sent: true });

const s3Service = requireCJS('../../services/s3Service');
s3Service.uploadImage = vi.fn();
s3Service.isOciUrl = vi.fn();
s3Service.isLocalUrl = vi.fn();


prisma.webForm = prisma.webForm || {};
prisma.webFormFolder = {
  findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
};

prisma.webFormSubmission = prisma.webFormSubmission || {};

prisma.contact = prisma.contact || {};

prisma.deal = prisma.deal || {};

prisma.contactAttachment = prisma.contactAttachment || {};

prisma.leadCustomFieldDefinition = prisma.leadCustomFieldDefinition || {};

prisma.leadCustomFieldValue = prisma.leadCustomFieldValue || {};

prisma.tenant = prisma.tenant || {};

prisma.touchpoint = prisma.touchpoint || {};

prisma.tenantSetting = prisma.tenantSetting || {};

prisma.user = prisma.user || {};
prisma.emailTemplate = { findFirst: vi.fn() };
prisma.smsTemplate = { findFirst: vi.fn() };


for (const key of ['findMany', 'findFirst', 'create', 'update', 'delete', 'groupBy']) {

  prisma.webForm[key] = vi.fn();

  prisma.webFormSubmission[key] = vi.fn();

}

for (const key of ['findFirst', 'create', 'update']) {

  prisma.contact[key] = vi.fn();

  prisma.deal[key] = vi.fn();

  prisma.contactAttachment[key] = vi.fn();

}

prisma.touchpoint.create = vi.fn();

for (const key of ['findMany', 'upsert']) {

  prisma.leadCustomFieldDefinition[key] = vi.fn();

  prisma.leadCustomFieldValue[key] = vi.fn();

}

prisma.tenant.findUnique = vi.fn();

prisma.tenantSetting.findUnique = vi.fn();

prisma.user.findFirst = vi.fn();


const webFormsRouter = requireCJS('../../routes/web_forms');
const { buildEmbedCode } = webFormsRouter;
const { normalizeFields, isConditionalFieldVisible } = webFormsRouter;
prisma.webFormSubmission.count = vi.fn();


const TENANT_ID = 11;

const USER_ID = 22;


function makeApp(vertical = 'generic', tenantId = TENANT_ID) {

  const app = express();

  app.use(express.json());

  app.use((/** @type {any} */ req, /** @type {import('express').Response} */ _res, /** @type {import('express').NextFunction} */ next) => {

    req.user = { userId: USER_ID, tenantId, role: 'ADMIN', vertical };

    next();

  });

  app.use('/api/forms', webFormsRouter);

  return app;

}


beforeEach(() => {
  Object.values(prisma.webFormFolder).forEach((mock) => mock.mockReset());

  for (const model of [prisma.webForm, prisma.webFormSubmission, prisma.contact, prisma.deal, prisma.contactAttachment, prisma.leadCustomFieldDefinition, prisma.leadCustomFieldValue, prisma.tenant, prisma.tenantSetting, prisma.user, prisma.touchpoint]) {

    for (const key of Object.keys(model)) {

      if (typeof model[key]?.mockReset === 'function') model[key].mockReset();

    }

  }

  prisma.emailTemplate.findFirst.mockReset();
  prisma.smsTemplate.findFirst.mockReset();

  prisma.webForm.findMany.mockResolvedValue([]);

  prisma.webForm.findFirst.mockResolvedValue(null);

  prisma.webFormSubmission.groupBy.mockResolvedValue([]);

  prisma.webFormSubmission.create.mockResolvedValue({ id: 1001 });

  prisma.webForm.create.mockResolvedValue({ id: 1, tenantId: TENANT_ID, createdByUserId: USER_ID, name: 'Contact Us', slug: 'contact-us', description: '', isActive: true, fieldsJson: JSON.stringify([]), styleJson: JSON.stringify({}), settingsJson: JSON.stringify({}) });

  prisma.contact.findFirst.mockResolvedValue(null);

  prisma.contact.create.mockResolvedValue({ id: 2001, name: 'Jane Doe', email: 'jane@example.com', phone: '9876543210' });

  prisma.contact.update.mockImplementation(async ({ data }) => ({ id: 2001, name: 'Jane Doe', email: 'jane@example.com', phone: '9876543210', ...data }));

  prisma.touchpoint.create.mockResolvedValue({ id: 5001 });

  prisma.deal.create.mockResolvedValue({ id: 3001 });

  prisma.contactAttachment.create.mockResolvedValue({ id: 4001 });

  prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([]);

  prisma.leadCustomFieldValue.upsert.mockResolvedValue({});

  prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, defaultCurrency: 'USD' });

  prisma.tenantSetting.findUnique.mockResolvedValue(null);

  prisma.user.findFirst.mockResolvedValue(null);

  emailSender.sendEmail.mockReset();
  emailSender.sendEmail.mockResolvedValue({ sent: true });
  axios.post.mockReset();
  s3Service.uploadImage.mockReset();
  s3Service.uploadImage.mockResolvedValue('https://objectstorage.example.com/n/ns/b/forms/o/travel/web-forms/11/logos/logo.png');
  s3Service.isOciUrl.mockReset();
  s3Service.isOciUrl.mockReturnValue(true);
  s3Service.isLocalUrl.mockReset();
  s3Service.isLocalUrl.mockReturnValue(false);

});

describe('web-form embed sizing', () => {
  test('server-generated embeds preserve extended attribution across host navigation and blocked iframe cookies', () => {
    const attribution = {
      utm_id: 'utm-123', gbraid: 'gb-123', wbraid: 'wb-123',
      campaign_id: 'campaign-123', adset_id: 'set-123', ad_id: 'ad-123',
      campaign_name: 'Launch', adset_name: 'Audience', ad_name: 'Creative',
      placement: 'feed', site_source_name: 'facebook',
      landing_page: 'https://external.example/landing', referrer: 'https://search.example/',
    };
    const code = buildEmbedCode({ id: 7, name: 'Contact Us', slug: 'contact-us', scope: 'generic' }, 'https://crm.example.com');
    const runtime = code.match(/<script>([\s\S]*?)<\/script>/)[1];
    const cookies = new Map();
    const visit = (query) => {
      const messages = [];
      const listeners = {};
      const frame = { contentWindow: { postMessage: (message) => messages.push(message) }, addEventListener: () => {} };
      const document = { currentScript: { previousElementSibling: frame }, documentElement: { clientWidth: 1000 }, title: 'External website' };
      Object.defineProperty(document, 'cookie', {
        get: () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        set: (value) => {
          const pair = value.split(';')[0];
          const separator = pair.indexOf('=');
          cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
        },
      });
      const location = new URL(`https://external.example/contact?${query}`);
      const window = { innerWidth: 1000, addEventListener: (type, callback) => { listeners[type] = callback; } };
      runInNewContext(runtime, { window, document, location, URLSearchParams });
      listeners.message({ source: frame.contentWindow, data: { source: 'gbs-web-form', type: 'ready' } });
      return messages.find((message) => message.type === 'context').attribution;
    };
    expect(visit(new URLSearchParams(attribution).toString())).toMatchObject(attribution);
    // The next page has no campaign query string; only first-party host cookies survive.
    const savedAttribution = visit('');
    expect(savedAttribution).toMatchObject(attribution);

    const html = fs.readFileSync(requireCJS.resolve('../../../frontend/public/embed/web-form.html'), 'utf8');
    const start = html.indexOf('function resolveTrackingAttribution(');
    const end = html.indexOf('function pageUrlWithoutQueryOrHash(', start);
    const iframe = { TRACKING_QUERY_KEYS: Object.keys(attribution), readCookie: () => '', rememberCookie: () => {} };
    runInNewContext(html.slice(start, end), iframe);
    expect(iframe.resolveTrackingAttribution(new URLSearchParams(), savedAttribution)).toMatchObject(attribution);
  });

  test.each([
    ['custom', undefined, undefined],
    ['custom', {}, undefined],
    ['custom', { utm_source: '' }, ''],
    ['custom', { utm_source: 'tracked-campaign' }, 'tracked-campaign'],
    [null, undefined, 'body-campaign'],
  ])('separates form content from attribution (%s, %j)', async (sourceKind, tracking, expected) => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 1, tenantId: TENANT_ID, name: 'Contact Us', slug: 'contact-us',
      scope: 'generic', isActive: true,
      fieldsJson: JSON.stringify([
        { sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name' },
        ...(sourceKind ? [{ sourceKind, sourceKey: 'utm_source', fieldType: 'text', label: 'Unrelated value' }] : []),
      ]),
      styleJson: '{}', settingsJson: '{}',
    });
    const response = await request(makeApp()).post('/api/forms/public/contact-us/submit')
      .send({ name: 'Jane Doe', utm_source: 'body-campaign',
        ...(tracking === undefined ? {} : { _gbsTracking: JSON.stringify(tracking) }) });
    expect(response.status).toBe(201);
    const payload = JSON.parse(prisma.webFormSubmission.create.mock.calls[0][0].data.payloadJson);
    expect(payload._meta.tracking.utm_source).toBe(expected);
    if (sourceKind) expect(payload['custom:utm_source']).toBe('body-campaign');
    expect(prisma.contact.create.mock.calls[0][0].data.firstTouchSource || undefined).toBe(expected || undefined);
  });

  test('generates a content-sized iframe without a fixed minimum or internal scroll cap', () => {
    const code = buildEmbedCode({ id: 7, name: 'Contact Us', slug: 'contact-us', scope: 'generic' }, 'https://crm.example.com');

    expect(code).toContain('style="width:100%;height:auto;border:0;display:block;"');
    expect(code).not.toContain('min-height:760px');
    expect(code).toContain('source!=="gbs-web-form"');
    expect(code).toContain('type:"responsive-device"');
    expect(code).toContain('window.innerWidth');
    expect(code).toContain('Max-Age="+maxAge');
    expect(code).toContain('attribution:savedAttribution');
    expect(code).toContain('"utm_source"');
    expect(code).toContain('"hsa_ver"');
  });

  test('uses the configured frontend base when no origin is supplied', () => {
    const previousFrontendUrl = process.env.FRONTEND_URL;
    const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
    process.env.FRONTEND_URL = 'https://globuscrm.com/';
    delete process.env.PUBLIC_BASE_URL;

    try {
      const code = buildEmbedCode({ id: 7, name: 'Contact Us', slug: 'contact-us', scope: 'generic' });
      expect(code).toContain('https://globuscrm.com/embed/web-form.html?id=7');
    } finally {
      if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
      else process.env.FRONTEND_URL = previousFrontendUrl;
      if (previousPublicBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
    }
  });

  test('keeps host attribution cookies scoped to Generic CRM forms', () => {
    const code = buildEmbedCode({ id: 8, name: 'Travel Enquiry', slug: 'travel-enquiry', scope: 'travel' }, 'https://crm.example.com');

    expect(code).not.toContain('Max-Age="+maxAge');
    expect(code).not.toContain('attribution:savedAttribution');
    expect(code).toContain('type:"responsive-device"');
  });
});

describe('web-form field types', () => {
  test('pins Generic Name, Email, and Phone to their assigned input types', () => {
    const fields = normalizeFields(JSON.stringify([
      { sourceKind: 'contact', sourceKey: 'name', fieldType: 'number' },
      { sourceKind: 'contact', sourceKey: 'email', fieldType: 'text' },
      { sourceKind: 'contact', sourceKey: 'phone', fieldType: 'number' },
    ]), 'generic');

    expect(fields.map((field) => field.fieldType)).toEqual(['text', 'email', 'tel']);
  });

  test('does not change Travel contact field types', () => {
    const fields = normalizeFields(JSON.stringify([
      { sourceKind: 'contact', sourceKey: 'phone', fieldType: 'number' },
      { sourceKind: 'contact', sourceKey: 'phone', fieldType: 'tel' },
    ]), 'travel');

    expect(fields[0].fieldType).toBe('number');
    expect(fields[1].fieldType).toBe('text');
  });
});

describe('Generic conditional fields', () => {
  test('hydrates lead custom choice options from the tenant definition', () => {
    const fields = normalizeFields(JSON.stringify([
      { id: 'business-type', sourceKind: 'lead_custom', sourceKey: 'business_type', fieldType: 'dropdown', label: 'Business type', options: [] },
    ]), 'generic', [
      { fieldKey: 'business_type', options: JSON.stringify(['SaaS', 'E-Commerce', 'Freelancer']) },
    ]);

    expect(fields[0].options).toEqual(['SaaS', 'E-Commerce', 'Freelancer']);
  });

  test('normalizes radio layout and defaults unsupported values to vertical', () => {
    const horizontal = normalizeFields(JSON.stringify([
      { id: 'platform', sourceKind: 'custom', sourceKey: 'platform', fieldType: 'radio', options: ['TikTok', 'Instagram'], choiceLayout: 'horizontal' },
    ]), 'generic');
    const vertical = normalizeFields(JSON.stringify([
      { id: 'platform', sourceKind: 'custom', sourceKey: 'platform', fieldType: 'radio', options: ['TikTok', 'Instagram'], choiceLayout: 'diagonal' },
    ]), 'generic');

    expect(horizontal[0].choiceLayout).toBe('horizontal');
    expect(vertical[0].choiceLayout).toBe('vertical');
  });

  const configuredFields = [
    {
      id: 'interest',
      sourceKind: 'custom',
      sourceKey: 'interest',
      fieldType: 'dropdown',
      options: ['WordPress', 'Shopify', 'SEO'],
      label: 'Are you interested in?',
    },
    {
      id: 'shopify-url',
      sourceKind: 'custom',
      sourceKey: 'shopifyUrl',
      fieldType: 'url',
      label: 'Shopify Store URL',
      showWhen: { fieldId: 'interest', fieldKey: 'interest', value: 'Shopify' },
    },
  ];

  test('preserves a valid parent and trigger value for Generic forms', () => {
    const fields = normalizeFields(JSON.stringify(configuredFields), 'generic');

    expect(fields[1].showWhen).toEqual({
      fieldId: 'interest',
      fieldKey: 'interest',
      parentQuestion: 'Are you interested in?',
      value: 'Shopify',
    });
    expect(isConditionalFieldVisible(fields[1], fields, { interest: 'Shopify' })).toBe(true);
    expect(isConditionalFieldVisible(fields[1], fields, { interest: 'WordPress' })).toBe(false);
  });

  test('supports multiple children and chained child conditions', () => {
    const fields = normalizeFields(JSON.stringify([
      ...configuredFields,
      {
        id: 'shopify-plan',
        sourceKind: 'custom',
        sourceKey: 'shopifyPlan',
        fieldType: 'dropdown',
        options: ['Basic', 'Advanced'],
        showWhen: { fieldId: 'shopify-url', fieldKey: 'shopifyUrl', value: 'https://shop.example' },
      },
    ]), 'generic');

    expect(isConditionalFieldVisible(fields[2], fields, { interest: 'Shopify', shopifyUrl: 'https://shop.example' })).toBe(true);
    expect(isConditionalFieldVisible(fields[2], fields, { interest: 'Shopify', shopifyUrl: 'https://other.example' })).toBe(false);
  });

  test('requires every ancestor in a nested conditional branch to be visible', () => {
    const fields = normalizeFields(JSON.stringify([
      { id: 'interest', sourceKind: 'custom', sourceKey: 'interest', fieldType: 'dropdown', options: ['Shopify', 'SEO'] },
      { id: 'store', sourceKind: 'custom', sourceKey: 'store', fieldType: 'text', showWhen: { fieldId: 'interest', value: 'Shopify' } },
      { id: 'plan', sourceKind: 'custom', sourceKey: 'plan', fieldType: 'text', showWhen: { fieldId: 'store', value: 'shop.example' } },
    ]), 'generic');

    expect(isConditionalFieldVisible(fields[2], fields, { interest: 'Shopify', store: 'shop.example' })).toBe(true);
    expect(isConditionalFieldVisible(fields[2], fields, { interest: 'SEO', store: 'shop.example' })).toBe(false);
  });

  test('clears an unlinked typed parent question', () => {
    const fields = normalizeFields(JSON.stringify([
      { id: 'interest', sourceKind: 'custom', sourceKey: 'interest', fieldType: 'dropdown', label: 'What service do you need?', options: ['SEO', 'Shopify'] },
      { id: 'details', sourceKind: 'custom', sourceKey: 'details', fieldType: 'text', label: 'Shopify details', showWhen: { parentQuestion: 'What service do you need?', value: 'Shopify' } },
    ]), 'generic');

    expect(fields[1].showWhen).toBeNull();
  });

  test('keeps conditional flows separate from contact and lead fields', () => {
    const fields = normalizeFields(JSON.stringify([
      { id: 'name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name' },
      { id: 'details', sourceKind: 'custom', sourceKey: 'details', fieldType: 'text', showWhen: { fieldId: 'name', value: 'WordPress' } },
    ]), 'generic');

    expect(fields[1].showWhen).toBeNull();
  });

  test('clears self, deleted, and invalid-choice rules while preserving Travel rules', () => {
    const fields = normalizeFields(JSON.stringify([
      { id: 'parent', sourceKind: 'custom', sourceKey: 'parent', fieldType: 'dropdown', options: ['Yes', 'No'] },
      { id: 'self', sourceKind: 'custom', sourceKey: 'self', fieldType: 'text', showWhen: { fieldId: 'self', value: 'x' } },
      { id: 'deleted', sourceKind: 'custom', sourceKey: 'deleted', fieldType: 'text', showWhen: { fieldId: 'missing', value: 'x' } },
      { id: 'invalid', sourceKind: 'custom', sourceKey: 'invalid', fieldType: 'text', showWhen: { fieldId: 'parent', value: 'Maybe' } },
    ]), 'generic');
    const travelFields = normalizeFields(JSON.stringify(configuredFields), 'travel');

    expect(fields.slice(1).every((field) => field.showWhen === null)).toBe(true);
    expect(travelFields[1].showWhen).toEqual({
      fieldId: 'interest',
      fieldKey: 'interest',
      parentQuestion: 'Are you interested in?',
      value: 'Shopify',
    });
  });

  test('clears cyclic nested rules while preserving valid chains', () => {
    const fields = normalizeFields(JSON.stringify([
      { id: 'root', sourceKind: 'custom', sourceKey: 'root', fieldType: 'dropdown', options: ['Yes', 'No'] },
      { id: 'child', sourceKind: 'custom', sourceKey: 'child', fieldType: 'dropdown', options: ['Next'], showWhen: { fieldId: 'root', value: 'Yes' } },
      { id: 'grandchild', sourceKind: 'custom', sourceKey: 'grandchild', fieldType: 'text', showWhen: { fieldId: 'child', value: 'Next' } },
      { id: 'cycle-a', sourceKind: 'custom', sourceKey: 'cycleA', fieldType: 'text', showWhen: { fieldId: 'cycle-b', value: 'x' } },
      { id: 'cycle-b', sourceKind: 'custom', sourceKey: 'cycleB', fieldType: 'text', showWhen: { fieldId: 'cycle-a', value: 'y' } },
    ]), 'generic');

    expect(fields[1].showWhen.fieldId).toBe('root');
    expect(fields[2].showWhen.fieldId).toBe('child');
    expect([fields[3].showWhen, fields[4].showWhen].filter(Boolean)).toHaveLength(0);
  });
});


describe('folder tenant isolation', () => {
  test.each(['rename', 'delete', 'deleteForms', 'assign', 'create'])('rejects a foreign Generic tenant attempting %s', async (action) => {
    const ownerTenant = 42;
    prisma.webFormFolder.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.id === 501 && (where.tenantId == null || where.tenantId === ownerTenant)
        ? { id: 501, tenantId: ownerTenant, scope: 'generic' } : null,
    ));
    prisma.webForm.findFirst.mockImplementation(({ where }) => Promise.resolve(
      where.id === 601 ? { id: 601, tenantId: TENANT_ID, scope: 'generic' } : null,
    ));
    const app = makeApp('generic', TENANT_ID);
    let response;
    if (action === 'rename') response = await request(app).put('/api/forms/folders/501').send({ name: 'Hijacked' });
    if (action === 'delete' || action === 'deleteForms') response = await request(app).delete('/api/forms/folders/501').send({ deleteForms: action === 'deleteForms' });
    if (action === 'assign') response = await request(app).put('/api/forms/601/folder').send({ folderId: 501 });
    if (action === 'create') response = await request(app).post('/api/forms').send({ name: 'Foreign folder', folderId: 501 });
    expect(response.status).toBe(404);
    expect(prisma.webFormFolder.findFirst).toHaveBeenCalledWith({ where: { id: 501, tenantId: TENANT_ID, scope: 'generic' } });
    expect(prisma.webFormFolder.delete).not.toHaveBeenCalled();
    expect(prisma.webFormFolder.update).not.toHaveBeenCalled();
    expect(prisma.webForm.update).not.toHaveBeenCalled();
    expect(prisma.webForm.create).not.toHaveBeenCalled();
  });

  test('folder lists filter by both tenant and scope', async () => {
    prisma.webFormFolder.findMany.mockResolvedValue([]);
    expect((await request(makeApp()).get('/api/forms/folders')).status).toBe(200);
    expect(prisma.webFormFolder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: TENANT_ID, scope: 'generic' } }));
  });
});

describe('GET /api/forms', () => {

  test('isolates travel forms from generic forms for authenticated users', async () => {
    prisma.webForm.findMany.mockResolvedValue([{
      id: 8,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'travel',
      name: 'Travel enquiry',
      slug: 'travel-enquiry',
      isActive: true,
      fieldsJson: '[]',
      styleJson: '{}',
      settingsJson: '{}',
    }]);

    const response = await request(makeApp('travel')).get('/api/forms?scope=travel');

    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({ id: 8, scope: 'travel' });
    expect(prisma.webForm.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: TENANT_ID, scope: 'travel' },
    }));

    const forbidden = await request(makeApp('travel')).get('/api/forms?scope=generic');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORM_SCOPE_FORBIDDEN');
  });

  test('lists forms with submission counts', async () => {

    prisma.webForm.findMany.mockResolvedValue([

      { id: 1, tenantId: TENANT_ID, createdByUserId: USER_ID, name: 'Contact Us', slug: 'contact-us', description: 'Talk to us', isActive: true, fieldsJson: JSON.stringify([]), styleJson: JSON.stringify({}), settingsJson: JSON.stringify({}) },

      { id: 2, tenantId: TENANT_ID, createdByUserId: USER_ID, name: 'Book Demo', slug: 'book-demo', description: '', isActive: false, fieldsJson: JSON.stringify([]), styleJson: JSON.stringify({}), settingsJson: JSON.stringify({}) },

    ]);

    prisma.webFormSubmission.groupBy.mockResolvedValue([{ webFormId: 1, _count: { _all: 3 } }]);


    const res = await request(makeApp()).get('/api/forms');


    expect(res.status).toBe(200);

    expect(res.body).toHaveLength(2);

    expect(res.body[0].submissionCount).toBe(3);

    expect(res.body[1].submissionCount).toBe(0);

    expect(prisma.webForm.findMany).toHaveBeenCalledWith({

      where: { tenantId: TENANT_ID, scope: 'generic' },

      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],

    });

  });


  test('returns an empty list without creating a form', async () => {
    prisma.webForm.findMany.mockResolvedValue([]);

    const res = await request(makeApp()).get('/api/forms');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(prisma.webForm.create).not.toHaveBeenCalled();
  });

});


describe('POST /api/forms', () => {

  test('creates a form with an auto-slug', async () => {

    prisma.webForm.findFirst.mockResolvedValueOnce(null);


    const res = await request(makeApp()).post('/api/forms').send({

      name: 'Contact Us',

      description: 'Lead capture',

    });


    expect(res.status).toBe(201);

    expect(res.body.slug).toBe('contact-us');

    expect(prisma.webForm.create).toHaveBeenCalled();

    const createArg = prisma.webForm.create.mock.calls[0][0].data;

    expect(createArg.tenantId).toBe(TENANT_ID);

    expect(createArg.createdByUserId).toBe(USER_ID);

    expect(createArg.fieldsJson).toContain('contact');

  });

});

describe('POST /api/forms/logo-upload', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  test('uploads a travel form logo through the OCS-aware storage service', async () => {
    const res = await request(makeApp('travel'))
      .post('/api/forms/logo-upload?scope=travel')
      .attach('image', PNG, 'travel-logo.png');

    expect(res.status).toBe(201);
    expect(s3Service.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'travel-logo.png',
      'image/png',
      'travel/web-forms/11/logos',
    );
    expect(res.body).toMatchObject({
      storage: 'ocs',
      originalName: 'travel-logo.png',
      mimeType: 'image/png',
    });
  });

  test('does not expose the travel logo endpoint to other CRM verticals', async () => {
    const res = await request(makeApp('generic'))
      .post('/api/forms/logo-upload?scope=travel')
      .attach('image', PNG, 'travel-logo.png');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORM_SCOPE_FORBIDDEN');
    expect(s3Service.uploadImage).not.toHaveBeenCalled();
  });

  test('uploads a Generic form logo into the Generic tenant storage prefix', async () => {
    s3Service.uploadImage.mockResolvedValueOnce('https://objectstorage.example.com/generic-logo.png');
    s3Service.isOciUrl.mockReturnValueOnce(true);

    const res = await request(makeApp('generic'))
      .post('/api/forms/generic-logo-upload?scope=generic')
      .attach('image', PNG, 'generic-logo.png');

    expect(res.status).toBe(201);
    expect(s3Service.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'generic-logo.png',
      'image/png',
      `generic/web-forms/${TENANT_ID}/logos`,
    );
    expect(res.body).toMatchObject({
      storage: 'ocs',
      originalName: 'generic-logo.png',
      mimeType: 'image/png',
    });
  });
});


describe('PUT /api/forms/:id', () => {

  test('persists metadata, fields, styles, and settings together', async () => {
    const updatedFields = [
      { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Full name', required: true, hidden: false, width: 'full', options: [] },
    ];
    const updatedStyle = {
      backgroundColor: '#112233',
      formColor: '#F4F5F6',
      titleColor: '#223344',
      fieldLabelColor: '#334455',
      buttonColor: '#99B177',
      containerShadowColor: '#445566',
      containerShadowOpacity: 37,
      elementTextStyles: {
        title: { fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 700, fontStyle: 'italic', textDecoration: 'underline', textAlign: 'center' },
      },
    };
    const updatedSettings = {
      formTitle: 'Updated public title',
      submitButtonLabel: 'Send request',
      successMessage: 'Received',
      optInEnabled: true,
      multiStepEnabled: true,
      steps: [
        { id: 'contact-details', title: 'Contact details', description: 'Tell us about yourself' },
        { id: 'requirements', title: 'Requirements', description: '' },
      ],
    };

    prisma.webForm.findFirst.mockResolvedValueOnce({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Contact Us',
      slug: 'contact-us',
      description: 'Before',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({}),
    });
    prisma.webForm.update.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Updated form',
      slug: 'contact-us',
      description: 'After',
      isActive: false,
      fieldsJson: JSON.stringify(updatedFields),
      styleJson: JSON.stringify(updatedStyle),
      settingsJson: JSON.stringify(updatedSettings),
    });

    const res = await request(makeApp()).put('/api/forms/1').send({
      name: 'Updated form',
      slug: 'contact-us',
      description: 'After',
      isActive: false,
      fields: updatedFields,
      style: updatedStyle,
      settings: updatedSettings,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      name: 'Updated form',
      description: 'After',
      isActive: false,
      fields: expect.arrayContaining([expect.objectContaining({ label: 'Full name' })]),
      style: expect.objectContaining({
        buttonColor: '#99B177',
        containerShadowColor: '#445566',
        containerShadowOpacity: 37,
        elementTextStyles: expect.objectContaining({
          title: expect.objectContaining({ fontFamily: 'Georgia, serif', fontSize: 28, fontStyle: 'italic', textAlign: 'center' }),
        }),
      }),
      settings: expect.objectContaining({
        submitButtonLabel: 'Send request',
        multiStepEnabled: true,
        steps: expect.arrayContaining([expect.objectContaining({ id: 'requirements', title: 'Requirements' })]),
      }),
    }));
    expect(prisma.webForm.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Updated form',
        description: 'After',
        isActive: false,
        fieldsJson: expect.stringContaining('Full name'),
        styleJson: expect.stringContaining('#99B177'),
        settingsJson: expect.stringContaining('Requirements'),
      }),
    }));
    const persistedStyle = JSON.parse(prisma.webForm.update.mock.calls[0][0].data.styleJson);
    expect(persistedStyle).toMatchObject({
      containerShadowColor: '#445566',
      containerShadowOpacity: 37,
      elementTextStyles: {
        title: { fontFamily: 'Georgia, serif', fontSize: 28, fontWeight: 700, fontStyle: 'italic', textDecoration: 'underline', textAlign: 'center' },
      },
    });
  });

  test('renames a form without touching the slug so shared links keep working', async () => {

    prisma.webForm.findFirst
      .mockResolvedValueOnce({
        id: 1,
        tenantId: TENANT_ID,
        createdByUserId: USER_ID,
        name: 'Untitled form - 06 Aug 2026, 18:18',
        slug: 'untitled-form-06-aug-2026-18-18',
        description: '',
        isActive: true,
        fieldsJson: JSON.stringify([]),
        styleJson: JSON.stringify({}),
        settingsJson: JSON.stringify({}),
      })
      .mockResolvedValueOnce(null);

    prisma.webForm.update.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'EmpMonitor Demo',
      slug: 'untitled-form-06-aug-2026-18-18',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({}),
    });

    const res = await request(makeApp()).put('/api/forms/1').send({
      name: 'EmpMonitor Demo',
    });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('untitled-form-06-aug-2026-18-18');
    expect(prisma.webForm.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'EmpMonitor Demo',
      }),
    }));
    expect(prisma.webForm.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({
        slug: expect.any(String),
      }),
    }));
  });

  test('allows an existing form title to be cleared without regenerating the slug', async () => {

    prisma.webForm.findFirst.mockResolvedValueOnce({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Brand intake',
      slug: 'brand-intake',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({}),
    });

    prisma.webForm.update.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: '',
      slug: 'brand-intake',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({}),
    });

    const res = await request(makeApp()).put('/api/forms/1').send({
      name: '',
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('');
    expect(res.body.slug).toBe('brand-intake');
    expect(prisma.webForm.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({
        slug: expect.any(String),
      }),
    }));
    expect(prisma.webForm.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: '',
      }),
    }));
  });

});

describe('GET /api/forms/public/:slug', () => {
  test('returns the configured site key for an enabled draft preview', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 7,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Protected intake',
      slug: 'protected-intake',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ recaptchaEnabled: false }),
    });
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: 'tenant-public-site-key' });

    const res = await request(makeApp()).get('/api/forms/public/protected-intake');

    expect(res.status).toBe(200);
    expect(res.body.settings.recaptchaEnabled).toBe(false);
    expect(res.body.settings.recaptchaSiteKey).toBe('tenant-public-site-key');
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith({
      where: { tenantId_key: { tenantId: TENANT_ID, key: 'generic.webForm.recaptcha.siteKey' } },
      select: { value: true },
    });
  });

  test('falls back to the server site key when a tenant override is blank', async () => {
    const originalSiteKey = process.env.RECAPTCHA_SITE_KEY;
    process.env.RECAPTCHA_SITE_KEY = 'server-public-site-key';
    prisma.webForm.findFirst.mockResolvedValue({
      id: 8,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Protected intake',
      slug: 'protected-intake',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ recaptchaEnabled: true }),
    });
    prisma.tenantSetting.findUnique.mockResolvedValue({ value: '' });

    try {
      const res = await request(makeApp()).get('/api/forms/public/protected-intake');
      expect(res.status).toBe(200);
      expect(res.body.settings.recaptchaSiteKey).toBe('server-public-site-key');
    } finally {
      if (originalSiteKey === undefined) delete process.env.RECAPTCHA_SITE_KEY;
      else process.env.RECAPTCHA_SITE_KEY = originalSiteKey;
    }
  });

  test('includes current lead custom field options in the public form payload', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 3,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Business intake',
      slug: 'business-intake',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'business-type', sourceKind: 'lead_custom', sourceKey: 'business_type', fieldType: 'dropdown', label: 'Business type', options: [] },
      ]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({}),
    });
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
      { fieldKey: 'business_type', options: JSON.stringify(['SaaS', 'E-Commerce', 'Freelancer']) },
    ]);

    const res = await request(makeApp()).get('/api/forms/public/business-intake');

    expect(res.status).toBe(200);
    expect(res.body.fields[0].options).toEqual(['SaaS', 'E-Commerce', 'Freelancer']);
    expect(prisma.leadCustomFieldDefinition.findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT_ID },
      select: { fieldKey: true, options: true },
    });
  });

  test('preserves per-form lead custom choice options instead of replacing them with organization defaults', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 4,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Campaign-specific intake',
      slug: 'campaign-specific-intake',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([{
        id: 'business-type',
        sourceKind: 'lead_custom',
        sourceKey: 'business_type',
        fieldType: 'dropdown',
        label: 'Business type',
        options: ['Campaign A', 'Campaign B'],
        optionsCustomized: true,
      }]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({}),
    });
    prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([
      { fieldKey: 'business_type', options: JSON.stringify(['Organization default']) },
    ]);

    const res = await request(makeApp()).get('/api/forms/public/campaign-specific-intake');

    expect(res.status).toBe(200);
    expect(res.body.fields[0]).toMatchObject({
      options: ['Campaign A', 'Campaign B'],
      optionsCustomized: true,
    });
  });

  test('returns the active form with embed code', async () => {

    prisma.webForm.findFirst.mockResolvedValue({

      id: 1,

      tenantId: TENANT_ID,

      createdByUserId: USER_ID,

      name: 'Contact Us',

      slug: 'contact-us',

      description: 'Talk to us',

      isActive: true,

      fieldsJson: JSON.stringify([{ id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', placeholder: 'Your name', helpText: '', required: true, hidden: false, width: 'full', options: [] }]),

      styleJson: JSON.stringify({ backgroundColor: '#ffffff', formColor: '#ffffff' }),

      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', notificationEnabled: true, optInEnabled: true, optInText: 'I agree to receive communication on newsletters, promotional content, offers and events.', optInLinkText: 'privacy policy', optInLinkUrl: 'https://example.com/privacy' }),

    });


    const res = await request(makeApp()).get('/api/forms/public/contact-us');


    expect(res.status).toBe(200);

    expect(res.body.slug).toBe('contact-us');

    expect(res.headers['cache-control']).toBe('no-store');

    expect(res.body.embedCode).toContain('/embed/web-form.html?id=1');

    // Existing forms that predate the setting remain branded by default.
    expect(res.body.settings.showPoweredBy).toBe(true);
    expect(res.body.settings.whatsappEnabled).toBe(false);

  });

  test('preserves an explicit powered-by opt-out in the public payload', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 2,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Unbranded form',
      slug: 'unbranded-form',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ showPoweredBy: false, whatsappEnabled: true }),
    });

    const res = await request(makeApp()).get('/api/forms/public/unbranded-form');

    expect(res.status).toBe(200);
    expect(res.body.settings.showPoweredBy).toBe(false);
    expect(res.body.settings.whatsappEnabled).toBe(true);
  });

  test('resolves the active form by stable numeric id', async () => {

    prisma.webForm.findFirst.mockResolvedValue({

      id: 1,

      tenantId: TENANT_ID,

      createdByUserId: USER_ID,

      name: 'Contact Us',

      slug: 'contact-us',

      description: 'Talk to us',

      isActive: true,

      fieldsJson: JSON.stringify([]),

      styleJson: JSON.stringify({}),

      settingsJson: JSON.stringify({}),

    });


    const res = await request(makeApp()).get('/api/forms/public/1');


    expect(res.status).toBe(200);

    expect(res.body.id).toBe(1);

    expect(prisma.webForm.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, isActive: true } }),
    );

  });

});


describe('POST /api/forms/public/:slug/submit', () => {

  function mockCaptchaForm({ withFile = false, scope = 'generic' } = {}) {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 83,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope,
      name: 'Protected form',
      slug: 'protected-form',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        ...(withFile
          ? [{ id: 'resume', sourceKind: 'custom', sourceKey: 'resume', fieldType: 'file', label: 'Resume', required: false, hidden: false, width: 'full', options: [] }]
          : []),
      ]),
      styleJson: '{}',
      settingsJson: JSON.stringify({ recaptchaEnabled: true }),
    });
    const expectedKey = `${scope}.webForm.recaptcha.secretKey`;
    prisma.tenantSetting.findUnique.mockImplementation((params) => (
      params.where?.tenantId_key?.key === expectedKey
        ? { value: `${scope}-server-only-secret` }
        : null
    ));
  }

  test('verifies CAPTCHA in the request body and never puts the secret in the URL', async () => {
    mockCaptchaForm();
    axios.post.mockResolvedValue({ data: { success: true } });

    const response = await request(makeApp())
      .post('/api/forms/public/protected-form/submit?scope=generic')
      .field('name', 'Protected Customer')
      .field('recaptchaToken', 'browser-token');

    expect(response.status).toBe(201);
    expect(axios.post).toHaveBeenCalledWith(
      'https://www.google.com/recaptcha/api/siteverify',
      expect.stringContaining('secret=generic-server-only-secret'),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 8000,
      }),
    );
    expect(axios.post.mock.calls[0][0]).not.toContain('generic-server-only-secret');
  });

  test('uses the Travel-specific CAPTCHA secret for Travel web forms', async () => {
    mockCaptchaForm({ scope: 'travel' });
    axios.post.mockResolvedValue({ data: { success: true } });

    const response = await request(makeApp('travel'))
      .post('/api/forms/public/protected-form/submit?scope=travel')
      .field('name', 'Travel Customer')
      .field('recaptchaToken', 'travel-browser-token');

    expect(response.status).toBe(201);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_key: { tenantId: TENANT_ID, key: 'travel.webForm.recaptcha.secretKey' } },
    }));
    expect(axios.post).toHaveBeenCalledWith(
      'https://www.google.com/recaptcha/api/siteverify',
      expect.stringContaining('secret=travel-server-only-secret'),
      expect.any(Object),
    );
  });

  test('falls back to the server secret when a tenant override is blank', async () => {
    const originalSecret = process.env.RECAPTCHA_SECRET_KEY;
    process.env.RECAPTCHA_SECRET_KEY = 'server-secret-key';
    mockCaptchaForm();
    prisma.tenantSetting.findUnique.mockImplementation((params) => (
      params.where?.tenantId_key?.key === 'generic.webForm.recaptcha.secretKey'
        ? { value: '' }
        : null
    ));
    axios.post.mockResolvedValue({ data: { success: true } });

    try {
      const response = await request(makeApp())
        .post('/api/forms/public/protected-form/submit?scope=generic')
        .field('name', 'Protected Customer')
        .field('recaptchaToken', 'browser-token');

      expect(response.status).toBe(201);
      expect(axios.post).toHaveBeenCalledWith(
        'https://www.google.com/recaptcha/api/siteverify',
        expect.stringContaining('secret=server-secret-key'),
        expect.any(Object),
      );
    } finally {
      if (originalSecret === undefined) delete process.env.RECAPTCHA_SECRET_KEY;
      else process.env.RECAPTCHA_SECRET_KEY = originalSecret;
    }
  });

  test('rejects invalid CAPTCHA before persisting uploaded files or CRM records', async () => {
    mockCaptchaForm({ withFile: true });
    axios.post.mockResolvedValue({ data: { success: false } });
    const writeFile = vi.spyOn(fs.promises, 'writeFile');

    try {
      const response = await request(makeApp())
        .post('/api/forms/public/protected-form/submit?scope=generic')
        .field('name', 'Rejected Customer')
        .field('recaptchaToken', 'invalid-token')
        .attach('resume', Buffer.from('not persisted'), {
          filename: 'resume.txt',
          contentType: 'text/plain',
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'CAPTCHA_FAILED' });
      expect(writeFile).not.toHaveBeenCalled();
      expect(prisma.contact.create).not.toHaveBeenCalled();
      expect(prisma.webFormSubmission.create).not.toHaveBeenCalled();
    } finally {
      writeFile.mockRestore();
    }
  });

  test('rejects more than five attachments before loading the public form', async () => {
    let pending = request(makeApp())
      .post('/api/forms/public/any-form/submit?scope=generic');
    for (let index = 0; index < 6; index += 1) {
      pending = pending.attach(`file${index}`, Buffer.from(String(index)), {
        filename: `file-${index}.txt`,
        contentType: 'text/plain',
      });
    }
    const response = await pending;

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'UPLOAD_LIMIT_EXCEEDED' });
    expect(prisma.webForm.findFirst).not.toHaveBeenCalled();
  });

  function mockGenericPhoneForm() {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 82,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'generic',
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-phone', sourceKind: 'contact', sourceKey: 'phone', fieldType: 'text', label: 'Phone', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: '{}',
      settingsJson: '{}',
    });
  }

  function mockGenericDateForm() {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 84,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'generic',
      name: 'Event registration',
      slug: 'event-registration',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-birth-date', sourceKind: 'contact', sourceKey: 'birthDate', fieldType: 'date', label: 'Birth date', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: '{}',
      settingsJson: '{}',
    });
  }

  test('rejects an impossible calendar date before persisting a Generic lead', async () => {
    mockGenericDateForm();

    const response = await request(makeApp())
      .post('/api/forms/public/event-registration/submit?scope=generic')
      .field('name', 'Calendar Customer')
      .field('birthDate', '2026-02-31');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_FIELD_TYPES',
      fields: { birthDate: 'Birth date must be a valid date' },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.webFormSubmission.create).not.toHaveBeenCalled();
  });

  test('accepts a complete E.164 Generic phone without phoneCountry for legacy clients', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Generic Customer')
      .field('phone', '+919876543210');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ phone: '+919876543210' }),
    }));
  });

  test('accepts a complete E.164 Generic phone together with its selected country', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'International Customer')
      .field('phoneCountry', '+91')
      .field('phone', '+918975678933');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ phone: '+918975678933' }),
    }));
  });

  test('copies the Generic phone into whatsappPhone when the same-number checkbox is selected', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Same WhatsApp Customer')
      .field('phoneCountry', '+91')
      .field('phone', '9876543210')
      .field('whatsappSameAsPhone', 'true');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phone: '+919876543210',
        whatsappPhone: '+919876543210',
      }),
    }));
  });

  test('stores a separate Generic WhatsApp number when the same-number checkbox is not selected', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Separate WhatsApp Customer')
      .field('phoneCountry', '+91')
      .field('phone', '9876543210')
      .field('whatsappPhone', '9123456789');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phone: '+919876543210',
        whatsappPhone: '+919123456789',
      }),
    }));
  });

  test('preserves an existing Generic WhatsApp number when the form does not submit WhatsApp fields', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 82,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'generic',
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: '{}',
      settingsJson: '{}',
    });
    prisma.contact.findFirst.mockResolvedValue({
      id: 2002,
      tenantId: TENANT_ID,
      name: 'Existing Customer',
      email: 'existing@example.com',
      whatsappPhone: '+919999999999',
    });

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Existing Customer')
      .field('email', 'existing@example.com');

    expect(response.status).toBe(201);
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('reports a failed Generic contact email notification and resolves tenant credentials', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 82,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'generic',
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: '{}',
      settingsJson: JSON.stringify({ contactNotificationChannels: ['email'] }),
    });
    emailSender.sendEmail.mockResolvedValue({ sent: false, reason: 'no_api_key' });
    prisma.contact.create.mockResolvedValue({
      id: 2001,
      name: 'Email Customer',
      email: 'email@example.com',
      phone: null,
    });

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Email Customer')
      .field('email', 'email@example.com');

    expect(response.status).toBe(201);
    expect(response.body.contactNotifications.email).toEqual({
      sent: false,
      code: 'EMAIL_SEND_FAILED',
      reason: 'no_api_key',
    });
    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      to: 'email@example.com',
    }));
  });

  test('does not run Generic contact notifications for a Travel form', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 81,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'travel',
      name: 'Plan my trip',
      slug: 'plan-my-trip',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: '{}',
      settingsJson: JSON.stringify({ contactNotificationChannels: ['email'] }),
    });

    const response = await request(makeApp('travel'))
      .post('/api/forms/public/plan-my-trip/submit?scope=travel')
      .field('name', 'Travel Customer')
      .field('email', 'travel@example.com');

    expect(response.status).toBe(201);
    expect(response.body.contactNotifications).toEqual({});
    expect(emailSender.sendEmail).not.toHaveBeenCalled();
  });

  test('accepts a formatted WhatsApp number pasted with its country code', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Formatted WhatsApp Customer')
      .field('phoneCountry', '+91')
      .field('phone', '9876543210')
      .field('whatsappPhone', '+91 91234-56789');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ whatsappPhone: '+919123456789' }),
    }));
  });

  test('validates and normalizes a WhatsApp number with its own country selector', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Separate WhatsApp Country Customer')
      .field('phoneCountry', '+91')
      .field('phone', '9876543210')
      .field('whatsappPhoneCountry', '+65')
      .field('whatsappPhone', '81234567');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ whatsappPhone: '+6581234567' }),
    }));
  });

  test('rejects non-numeric characters in a separate Generic WhatsApp number', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Invalid WhatsApp Customer')
      .field('phoneCountry', '+91')
      .field('phone', '9876543210')
      .field('whatsappPhone', '98765abc10');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_CONTACT_FIELDS',
      fields: { whatsappPhone: 'Only numbers are allowed.' },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('rejects a Generic WhatsApp number with the wrong country-specific length', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Invalid WhatsApp Length')
      .field('phoneCountry', '+91')
      .field('phone', '9876543210')
      .field('whatsappPhone', '12345');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_CONTACT_FIELDS',
      fields: { whatsappPhone: expect.stringContaining('10 digits') },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('accepts a valid 8-digit Singapore number from the Generic country selector', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Singapore Customer')
      .field('phoneCountry', '+65')
      .field('phone', '61234567');

    expect(response.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ phone: '+6561234567' }),
    }));
  });

  test('rejects a Generic country-selector phone exceeding the E.164 total-length limit', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Invalid Phone Length')
      .field('phoneCountry', '+91')
      .field('phone', '98765432123456');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_CONTACT_FIELDS',
      fields: { phone: expect.any(String) },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('rejects a Generic country-selector phone below the E.164 total-length minimum', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Invalid Short Phone')
      .field('phoneCountry', '+91')
      .field('phone', '12345');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_CONTACT_FIELDS',
      fields: { phone: expect.any(String) },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('rejects a Generic phone whose E.164 prefix does not match phoneCountry', async () => {
    mockGenericPhoneForm();

    const response = await request(makeApp())
      .post('/api/forms/public/contact-us/submit?scope=generic')
      .field('name', 'Wrong Prefix')
      .field('phoneCountry', '+1')
      .field('phone', '+6561234567');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_CONTACT_FIELDS',
      fields: { phone: expect.any(String) },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  test('creates travel submissions with travel scope and inbound web-form source', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 81,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      scope: 'travel',
      name: 'Plan my trip',
      slug: 'plan-my-trip',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: '{}',
      settingsJson: '{}',
    });

    const response = await request(makeApp('travel'))
      .post('/api/forms/public/plan-my-trip/submit?scope=travel')
      .field('name', 'Travel Customer');

    expect(response.status).toBe(201);
    expect(prisma.webForm.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { slug: 'plan-my-trip', scope: 'travel', isActive: true },
    }));
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: TENANT_ID,
        name: 'Travel Customer',
        source: 'inbound:web_form',
        status: 'Lead',
      }),
    }));
    expect(prisma.webFormSubmission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ tenantId: TENANT_ID, webFormId: 81, scope: 'travel' }),
    }));
  });

  test('creates a contact, writes the submission, and preserves multiselect values', async () => {

    prisma.webForm.findFirst.mockResolvedValue({

      id: 1,

      tenantId: TENANT_ID,

      createdByUserId: USER_ID,

      name: 'Contact Us',

      slug: 'contact-us',

      description: '',

      isActive: true,

      fieldsJson: JSON.stringify([

        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },

        { id: 'contact-source', sourceKind: 'contact', sourceKey: 'source', fieldType: 'dropdown', label: 'Source', required: false, hidden: true, defaultValue: 'Referral', width: 'full', options: ['Organic', 'Referral'] },

        { id: 'contact-status', sourceKind: 'contact', sourceKey: 'status', fieldType: 'dropdown', label: 'Lifecycle stage', required: false, hidden: true, defaultValue: 'Prospect', width: 'full', options: ['Lead', 'Prospect', 'Customer'] },

        { id: 'lead-interest', sourceKind: 'lead_custom', sourceKey: 'interest', fieldType: 'multiselect', label: 'Interest', required: false, hidden: false, width: 'full', options: ['A', 'B'] },

      ]),

      styleJson: JSON.stringify({}),

      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!', createDeal: true, notificationEnabled: true, notificationEmail: 'owner@example.com', optInEnabled: true, optInText: 'I agree to receive communication on newsletters, promotional content, offers and events.', optInLinkText: 'privacy policy', optInLinkUrl: 'https://example.com/privacy' }),

    });


    const res = await request(makeApp())

      .post('/api/forms/public/contact-us/submit')

      .set('X-GBS-Tracking', JSON.stringify({
        pageUrl: 'https://legacy.example.com/header',
        utm_source: 'legacy-header',
      }))

      .field('_gbsTracking', JSON.stringify({
        pageUrl: 'https://example.com/pricing',
        utm_source: 'newsletter',
        utm_id: 'utm-123',
        campaign_id: 'campaign-123',
        adset_id: 'adset-123',
        ad_id: 'ad-123',
        site_source_name: 'facebook',
        landing_page: 'https://example.com/landing',
        referrer: 'https://search.example.com/',
        location: 'Koramangala, Bengaluru, Karnataka, 560034, India',
        locationLatitude: '12.935200',
        locationLongitude: '77.624500',
      }))

      .field('name', 'Jane Doe')

      .field('interest', 'A')

      .field('interest', 'B');


    expect(res.status).toBe(201);

    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({

      data: expect.objectContaining({

        tenantId: TENANT_ID,

        name: 'Jane Doe',

        source: 'Referral',

        status: 'Prospect',

      }),

    }));

    expect(prisma.webFormSubmission.create).toHaveBeenCalled();

    const submissionArg = prisma.webFormSubmission.create.mock.calls[0][0].data;

    expect(submissionArg.payloadJson).toContain('"interest":["A","B"]');
    expect(JSON.parse(submissionArg.payloadJson)).toEqual(expect.objectContaining({
      utm_source: 'newsletter',
      utm_medium: null,
      utm_campaign: null,
      utm_term: null,
      utm_content: null,
    }));
    expect(JSON.parse(submissionArg.payloadJson)._meta.tracking).toEqual(expect.objectContaining({
      pageUrl: 'https://example.com/pricing',
      utm_source: 'newsletter',
      utm_id: 'utm-123',
      campaign_id: 'campaign-123',
      adset_id: 'adset-123',
      ad_id: 'ad-123',
      site_source_name: 'facebook',
      landing_page: 'https://example.com/landing',
      referrer: 'https://search.example.com/',
      location: 'Koramangala, Bengaluru, Karnataka, 560034, India',
      locationLatitude: '12.935200',
      locationLongitude: '77.624500',
      formName: 'Contact Us',
      formId: '1',
    }));

    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        medium: null,
        firstTouchSource: 'newsletter',
        lastTouchSource: 'newsletter',
      }),
    }));
    expect(prisma.touchpoint.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        contactId: 2001,
        tenantId: TENANT_ID,
        channel: 'web',
        source: 'newsletter',
        medium: null,
      }),
    }));

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({

      where: { id: TENANT_ID },

      select: { defaultCurrency: true },

    });

    expect(prisma.deal.create).toHaveBeenCalled();

    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({

      to: 'owner@example.com',

      subject: 'New web form submission: Contact Us',

    }));

  });

  test('reuses an existing contact when the submitted email already exists', async () => {

    prisma.webForm.findFirst.mockResolvedValue({

      id: 1,

      tenantId: TENANT_ID,

      createdByUserId: USER_ID,

      name: 'Contact Us',

      slug: 'contact-us',

      description: '',

      isActive: true,

      fieldsJson: JSON.stringify([

        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },

        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: true, hidden: false, width: 'full', options: [] },

      ]),

      styleJson: JSON.stringify({}),

      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!' }),

    });

    prisma.contact.findFirst.mockResolvedValueOnce({ id: 2002, tenantId: TENANT_ID, name: 'Monica', email: 'monica999@gmail.com' });


    const res = await request(makeApp())

      .post('/api/forms/public/contact-us/submit')

      .field('name', 'Monica')

      .field('email', 'monica999@gmail.com');


    expect(res.status).toBe(201);

    expect(res.body.contactId).toBe(2002);

    expect(prisma.contact.create).not.toHaveBeenCalled();

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();

    expect(prisma.webFormSubmission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 2002, tenantId: TENANT_ID }),
    }));

});


  test('auto-assigns Callified campaign by rule for new Lead', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: false, hidden: false, width: 'full', options: [] },
        { id: 'contact-source', sourceKind: 'contact', sourceKey: 'source', fieldType: 'dropdown', label: 'Source', required: false, hidden: true, defaultValue: 'website-form', width: 'full', options: [] },
      ]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!' }),
    });

    prisma.tenantSetting.findUnique.mockImplementation((/** @type {{ where?: { tenantId_key?: { key: string } } }} */ params) => {
      const { where } = params;
      if (where?.tenantId_key?.key === 'feature.callified.auto_campaign_rules') {
        return {
          value: JSON.stringify({
            enabled: true,
            rules: [{ enabled: true, column: 'source', value: 'website-form', campaignId: 77 }],
          }),
        };
      }
      return null;
    });

    const res = await request(makeApp())
      .post('/api/forms/public/contact-us/submit')
      .field('name', 'Web Lead');

    expect(res.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        source: 'website-form',
        status: 'Lead',
        callifiedCampaignId: 77,
      }),
    }));
  });

  test('normalises legacy lowercase Lead status and matches the submitting web form name', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-status', sourceKind: 'contact', sourceKey: 'status', fieldType: 'text', label: 'Status', required: false, hidden: true, defaultValue: 'lead', width: 'full', options: [] },
      ]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!' }),
    });

    prisma.tenantSetting.findUnique.mockImplementation((/** @type {{ where?: { tenantId_key?: { key: string } } }} */ params) => {
      if (params.where?.tenantId_key?.key === 'feature.callified.auto_campaign_rules') {
        return {
          value: JSON.stringify({
            enabled: true,
            rules: [{ enabled: true, column: 'webForm', value: 'Contact Us', campaignId: 88 }],
          }),
        };
      }
      return null;
    });

    const res = await request(makeApp())
      .post('/api/forms/public/contact-us/submit')
      .field('name', 'Legacy Form Lead');

    expect(res.status).toBe(201);
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'Lead',
        callifiedCampaignId: 88,
      }),
    }));
  });

  test('backfills Callified campaign on existing contact when rule matches', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-source', sourceKind: 'contact', sourceKey: 'source', fieldType: 'dropdown', label: 'Source', required: false, hidden: true, defaultValue: 'website-form', width: 'full', options: [] },
      ]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!' }),
    });

    prisma.tenantSetting.findUnique.mockImplementation((/** @type {{ where?: { tenantId_key?: { key: string } } }} */ params) => {
      const { where } = params;
      if (where?.tenantId_key?.key === 'feature.callified.auto_campaign_rules') {
        return {
          value: JSON.stringify({
            enabled: true,
            rules: [{ enabled: true, column: 'source', value: 'website-form', campaignId: 77 }],
          }),
        };
      }
      return null;
    });

    prisma.contact.findFirst.mockResolvedValueOnce({ id: 2003, tenantId: TENANT_ID, name: 'Monica', email: 'monica999@gmail.com', status: 'Lead', callifiedCampaignId: null });
    prisma.contact.update.mockResolvedValueOnce({ id: 2003, tenantId: TENANT_ID, name: 'Monica', email: 'monica999@gmail.com', status: 'Lead', callifiedCampaignId: 77 });

    const res = await request(makeApp())
      .post('/api/forms/public/contact-us/submit')
      .field('name', 'Monica')
      .field('email', 'monica999@gmail.com');

    expect(res.status).toBe(201);
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 2003 },
      data: { callifiedCampaignId: 77 },
    });
  });

  test('does not backfill a Callified campaign onto an existing non-Lead contact', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'email', label: 'Email', required: true, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!' }),
    });

    prisma.tenantSetting.findUnique.mockImplementation((/** @type {{ where?: { tenantId_key?: { key: string } } }} */ params) => {
      if (params.where?.tenantId_key?.key === 'feature.callified.auto_campaign_rules') {
        return {
          value: JSON.stringify({
            enabled: true,
            rules: [{ enabled: true, column: 'source', value: 'website-form', campaignId: 77 }],
          }),
        };
      }
      return null;
    });

    prisma.contact.findFirst.mockResolvedValueOnce({
      id: 2004,
      tenantId: TENANT_ID,
      name: 'Existing Customer',
      email: 'customer@example.com',
      status: 'Customer',
      callifiedCampaignId: null,
    });

    const res = await request(makeApp())
      .post('/api/forms/public/contact-us/submit')
      .field('name', 'Existing Customer')
      .field('email', 'customer@example.com');

    expect(res.status).toBe(201);
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
    expect(prisma.webFormSubmission.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 2004, tenantId: TENANT_ID }),
    }));
  });

  test('maps picker fallback customs to Contact columns instead of dropping them', async () => {
    prisma.webForm.findFirst.mockResolvedValue({
      id: 1,
      tenantId: TENANT_ID,
      createdByUserId: USER_ID,
      name: 'Contact Us',
      slug: 'contact-us',
      description: '',
      isActive: true,
      fieldsJson: JSON.stringify([
        { id: 'contact-name', sourceKind: 'contact', sourceKey: 'name', fieldType: 'text', label: 'Name', required: true, hidden: false, width: 'full', options: [] },
        { id: 'contact-email', sourceKind: 'contact', sourceKey: 'email', fieldType: 'text', label: 'Email', required: true, hidden: false, width: 'full', options: [] },
        { id: 'custom-industry', sourceKind: 'lead_custom', sourceKey: 'industry', fieldType: 'text', label: 'Industry', required: false, hidden: false, width: 'full', options: [] },
        { id: 'custom-job-roles', sourceKind: 'lead_custom', sourceKey: 'jobRoles', fieldType: 'text', label: 'Job Roles', required: false, hidden: false, width: 'full', options: [] },
        { id: 'custom-organization', sourceKind: 'lead_custom', sourceKey: 'organization', fieldType: 'text', label: 'Organization', required: false, hidden: false, width: 'full', options: [] },
        { id: 'custom headcount', sourceKind: 'lead_custom', sourceKey: 'numberOfEmployees', fieldType: 'text', label: 'No Of Employee', required: false, hidden: false, width: 'full', options: [] },
        { id: 'custom-medium', sourceKind: 'lead_custom', sourceKey: 'medium', fieldType: 'text', label: 'Medium', required: false, hidden: false, width: 'full', options: [] },
      ]),
      styleJson: JSON.stringify({}),
      settingsJson: JSON.stringify({ submitButtonLabel: 'Send', successMessage: 'Thanks!' }),
    });

    const res = await request(makeApp())
      .post('/api/forms/public/contact-us/submit')
      .field('name', 'Jane Doe')
      .field('email', 'jane@example.com')
      .field('industry', 'Logistics')
      .field('jobRoles', 'Sales Manager')
      .field('organization', 'Acme Corp')
      .field('numberOfEmployees', '51-200')
      .field('medium', 'Referral');

    expect(res.status).toBe(201);
    // Job title refers to Job title, No Of Employee refers to Company Size.
    expect(prisma.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        industry: 'Logistics',
        title: 'Sales Manager',
        company: 'Acme Corp',
        companySize: '51-200',
        source: 'website-form',
        medium: 'Referral',
      }),
    }));
    // Nothing left for the custom-field writer — no definitions needed.
    expect(prisma.leadCustomFieldValue.upsert).not.toHaveBeenCalled();
  });


});

describe('Generic web form leads popup API', () => {
  test('scopes pagination and search to the form and tenant, preserving submitted values', async () => {
    prisma.webForm.findFirst.mockResolvedValue({ id: 7, fieldsJson: JSON.stringify([
      { id: 's', sourceKind: 'contact', sourceKey: 'source', label: 'Source' },
      { id: 'm', sourceKind: 'lead_custom', sourceKey: 'medium', label: 'Medium' },
      { id: 'x', sourceKind: 'custom', sourceKey: 'message', label: 'Message' },
    ]) });
    prisma.webFormSubmission.count.mockResolvedValue(26);
    prisma.webFormSubmission.findMany.mockResolvedValue([{ id: 9,
      payloadJson: JSON.stringify({ source: 'Website', medium: 'Google', 'custom:message': '  hello  ' }),
      filesJson: null, contact: { id: 3, createdAt: '2026-01-01', updatedAt: '2026-02-01', deletedAt: '2026-02-02', status: 'Lead' },
    }]);
    const res = await request(makeApp()).get('/api/forms/7/leads?page=2&limit=25&search=Google');
    expect(res.status).toBe(200);
    expect(res.body.leads[0]).toMatchObject({ values: ['Website', 'Google', '  hello  '], createdAt: '2026-01-01', updatedAt: '2026-02-01', deletedAt: '2026-02-02' });
    expect(prisma.webForm.findFirst).toHaveBeenCalledWith({ where: { id: 7, tenantId: TENANT_ID, scope: 'generic' } });
    const query = prisma.webFormSubmission.findMany.mock.calls[0][0];
    expect(query).toMatchObject({ skip: 25, take: 25, where: { webFormId: 7, tenantId: TENANT_ID, scope: 'generic' } });
    expect(query.where.contact).toBeUndefined();
    expect(query.where.OR).toContainEqual({ payloadJson: { contains: 'Google' } });
    expect(prisma.webFormSubmission.count).toHaveBeenCalledWith({ where: query.where });
  });
  test('keeps orphaned and non-Lead submissions visible and marks them absent from Leads', async () => {
    prisma.webForm.findFirst.mockResolvedValue({ id: 7, fieldsJson: JSON.stringify([]) });
    prisma.webFormSubmission.count.mockResolvedValue(2);
    prisma.webFormSubmission.findMany.mockResolvedValue([
      { id: 10, payloadJson: '{}', filesJson: null, submittedAt: '2026-02-03', contact: { id: 4, createdAt: '2026-01-03', updatedAt: '2026-02-03', deletedAt: null, status: 'Customer' } },
      { id: 11, payloadJson: '{}', filesJson: null, submittedAt: '2026-02-04', contact: null },
    ]);

    const res = await request(makeApp()).get('/api/forms/7/leads');

    expect(res.status).toBe(200);
    expect(res.body.leads).toMatchObject([
      { contactId: 4, isLead: false, deletedAt: null },
      { contactId: null, isLead: false, deletedAt: null, createdAt: '2026-02-04', updatedAt: '2026-02-04' },
    ]);
    const query = prisma.webFormSubmission.findMany.mock.calls[0][0];
    expect(query.where.contact).toBeUndefined();
  });
  test.each(['wellness', 'travel'])('denies %s access', async (vertical) => {
    expect((await request(makeApp(vertical)).get('/api/forms/7/leads')).status).toBe(403);
    expect(prisma.webFormSubmission.findMany).not.toHaveBeenCalled();
  });
  test('rejects invalid and inaccessible forms', async () => {
    expect((await request(makeApp()).get('/api/forms/no/leads')).status).toBe(400);
    expect((await request(makeApp()).get('/api/forms/7/leads')).status).toBe(404);
    expect(prisma.webFormSubmission.findMany).not.toHaveBeenCalled();
  });
});
