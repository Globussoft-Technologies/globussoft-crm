// @ts-check

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createRequire } from 'node:module';

import express from 'express';

import request from 'supertest';

import prisma from '../../lib/prisma.js';


const requireCJS = createRequire(import.meta.url);

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

prisma.webFormSubmission = prisma.webFormSubmission || {};

prisma.contact = prisma.contact || {};

prisma.deal = prisma.deal || {};

prisma.contactAttachment = prisma.contactAttachment || {};

prisma.leadCustomFieldDefinition = prisma.leadCustomFieldDefinition || {};

prisma.leadCustomFieldValue = prisma.leadCustomFieldValue || {};

prisma.tenant = prisma.tenant || {};

prisma.tenantSetting = prisma.tenantSetting || {};

prisma.user = prisma.user || {};


for (const key of ['findMany', 'findFirst', 'create', 'update', 'delete', 'groupBy']) {

  prisma.webForm[key] = vi.fn();

  prisma.webFormSubmission[key] = vi.fn();

}

for (const key of ['findFirst', 'create', 'update']) {

  prisma.contact[key] = vi.fn();

  prisma.deal[key] = vi.fn();

  prisma.contactAttachment[key] = vi.fn();

}

for (const key of ['findMany', 'upsert']) {

  prisma.leadCustomFieldDefinition[key] = vi.fn();

  prisma.leadCustomFieldValue[key] = vi.fn();

}

prisma.tenant.findUnique = vi.fn();

prisma.tenantSetting.findUnique = vi.fn();

prisma.user.findFirst = vi.fn();


const webFormsRouter = requireCJS('../../routes/web_forms');
const { buildEmbedCode } = webFormsRouter;
prisma.webFormSubmission.count = vi.fn();


const TENANT_ID = 11;

const USER_ID = 22;


function makeApp(vertical = 'generic') {

  const app = express();

  app.use(express.json());

  app.use((/** @type {any} */ req, /** @type {import('express').Response} */ _res, /** @type {import('express').NextFunction} */ next) => {

    req.user = { userId: USER_ID, tenantId: TENANT_ID, role: 'ADMIN', vertical };

    next();

  });

  app.use('/api/forms', webFormsRouter);

  return app;

}


beforeEach(() => {

  for (const model of [prisma.webForm, prisma.webFormSubmission, prisma.contact, prisma.deal, prisma.contactAttachment, prisma.leadCustomFieldDefinition, prisma.leadCustomFieldValue, prisma.tenant, prisma.tenantSetting, prisma.user]) {

    for (const key of Object.keys(model)) {

      if (typeof model[key]?.mockReset === 'function') model[key].mockReset();

    }

  }

  prisma.webForm.findMany.mockResolvedValue([]);

  prisma.webForm.findFirst.mockResolvedValue(null);

  prisma.webFormSubmission.groupBy.mockResolvedValue([]);

  prisma.webFormSubmission.create.mockResolvedValue({ id: 1001 });

  prisma.webForm.create.mockResolvedValue({ id: 1, tenantId: TENANT_ID, createdByUserId: USER_ID, name: 'Contact Us', slug: 'contact-us', description: '', isActive: true, fieldsJson: JSON.stringify([]), styleJson: JSON.stringify({}), settingsJson: JSON.stringify({}) });

  prisma.contact.findFirst.mockResolvedValue(null);

  prisma.contact.create.mockResolvedValue({ id: 2001, name: 'Jane Doe', email: 'jane@example.com', phone: '9876543210' });

  prisma.deal.create.mockResolvedValue({ id: 3001 });

  prisma.contactAttachment.create.mockResolvedValue({ id: 4001 });

  prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([]);

  prisma.leadCustomFieldValue.upsert.mockResolvedValue({});

  prisma.tenant.findUnique.mockResolvedValue({ id: TENANT_ID, defaultCurrency: 'USD' });

  prisma.tenantSetting.findUnique.mockResolvedValue(null);

  prisma.user.findFirst.mockResolvedValue(null);

  emailSender.sendEmail.mockClear();
  s3Service.uploadImage.mockReset();
  s3Service.uploadImage.mockResolvedValue('https://objectstorage.example.com/n/ns/b/forms/o/travel/web-forms/11/logos/logo.png');
  s3Service.isOciUrl.mockReset();
  s3Service.isOciUrl.mockReturnValue(true);
  s3Service.isLocalUrl.mockReset();
  s3Service.isLocalUrl.mockReturnValue(false);

});

describe('web-form embed sizing', () => {
  test('generates a content-sized iframe without a fixed minimum or internal scroll cap', () => {
    const code = buildEmbedCode({ id: 7, name: 'Contact Us', slug: 'contact-us', scope: 'generic' }, 'https://crm.example.com');

    expect(code).toContain('style="width:100%;height:auto;border:0;display:block;"');
    expect(code).not.toContain('min-height:760px');
    expect(code).toContain('source!=="gbs-web-form"');
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


  test('creates a starter form when the tenant has no forms', async () => {

    prisma.webForm.findMany.mockResolvedValue([]);

    prisma.webFormSubmission.groupBy.mockResolvedValue([]);

    prisma.webForm.findFirst.mockResolvedValueOnce(null);

    prisma.webForm.create.mockResolvedValueOnce({

      id: 9,

      tenantId: TENANT_ID,

      createdByUserId: USER_ID,

      name: 'Untitled form - 06 Aug 2026, 18:18',

      slug: 'untitled-form-06-aug-2026-18-18',

      description: '',

      isActive: true,

      fieldsJson: JSON.stringify([]),

      styleJson: JSON.stringify({}),

      settingsJson: JSON.stringify({}),

    });


    const res = await request(makeApp()).get('/api/forms');


    expect(res.status).toBe(200);

    expect(res.body).toHaveLength(1);

    expect(res.body[0]).toMatchObject({

      id: 9,

      tenantId: TENANT_ID,

      createdByUserId: USER_ID,

      slug: 'untitled-form-06-aug-2026-18-18',

      submissionCount: 0,

    });

    expect(prisma.webForm.create).toHaveBeenCalledTimes(1);

    expect(prisma.webForm.create).toHaveBeenCalledWith({

      data: expect.objectContaining({

        tenantId: TENANT_ID,

        createdByUserId: USER_ID,

        description: '',

        isActive: true,

        fieldsJson: expect.any(String),

        styleJson: expect.any(String),

        settingsJson: expect.any(String),

      }),

    });

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
    };
    const updatedSettings = {
      formTitle: 'Updated public title',
      submitButtonLabel: 'Send request',
      successMessage: 'Received',
      optInEnabled: true,
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
      style: expect.objectContaining({ buttonColor: '#99B177' }),
      settings: expect.objectContaining({ submitButtonLabel: 'Send request' }),
    }));
    expect(prisma.webForm.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: 'Updated form',
        description: 'After',
        isActive: false,
        fieldsJson: expect.stringContaining('Full name'),
        styleJson: expect.stringContaining('#99B177'),
        settingsJson: expect.stringContaining('Send request'),
      }),
    }));
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

      data: expect.objectContaining({

        contactId: 2002,

        tenantId: TENANT_ID,

      }),

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
      filesJson: null, contact: { id: 3, createdAt: '2026-01-01', updatedAt: '2026-02-01' },
    }]);
    const res = await request(makeApp()).get('/api/forms/7/leads?page=2&limit=25&search=Google');
    expect(res.status).toBe(200);
    expect(res.body.leads[0]).toMatchObject({ values: ['Website', 'Google', '  hello  '], createdAt: '2026-01-01', updatedAt: '2026-02-01' });
    expect(prisma.webForm.findFirst).toHaveBeenCalledWith({ where: { id: 7, tenantId: TENANT_ID, scope: 'generic' } });
    const query = prisma.webFormSubmission.findMany.mock.calls[0][0];
    expect(query).toMatchObject({ skip: 25, take: 25, where: { webFormId: 7, tenantId: TENANT_ID, scope: 'generic', contact: { is: { tenantId: TENANT_ID } } } });
    expect(query.where.OR).toContainEqual({ payloadJson: { contains: 'Google' } });
    expect(prisma.webFormSubmission.count).toHaveBeenCalledWith({ where: query.where });
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
