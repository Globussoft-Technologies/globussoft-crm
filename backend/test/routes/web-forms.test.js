// @ts-check

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createRequire } from 'node:module';

import express from 'express';

import request from 'supertest';

import prisma from '../../lib/prisma.js';



const requireCJS = createRequire(import.meta.url);

const authMw = requireCJS('../../middleware/auth');

authMw.verifyToken = (_req, _res, next) => next();



const emailSender = requireCJS('../../lib/emailSender');

emailSender.sendEmail = vi.fn().mockResolvedValue({ sent: true });



prisma.webForm = prisma.webForm || {};

prisma.webFormSubmission = prisma.webFormSubmission || {};

prisma.contact = prisma.contact || {};

prisma.deal = prisma.deal || {};

prisma.contactAttachment = prisma.contactAttachment || {};

prisma.leadCustomFieldDefinition = prisma.leadCustomFieldDefinition || {};

prisma.leadCustomFieldValue = prisma.leadCustomFieldValue || {};



for (const key of ['findMany', 'findFirst', 'create', 'update', 'delete', 'groupBy']) {

  prisma.webForm[key] = vi.fn();

  prisma.webFormSubmission[key] = vi.fn();

}

for (const key of ['create']) {

  prisma.contact[key] = vi.fn();

  prisma.deal[key] = vi.fn();

  prisma.contactAttachment[key] = vi.fn();

}

for (const key of ['findMany', 'upsert']) {

  prisma.leadCustomFieldDefinition[key] = vi.fn();

  prisma.leadCustomFieldValue[key] = vi.fn();

}



const webFormsRouter = requireCJS('../../routes/web_forms');



const TENANT_ID = 11;

const USER_ID = 22;



function makeApp() {

  const app = express();

  app.use(express.json());

  app.use((req, _res, next) => {

    req.user = { userId: USER_ID, tenantId: TENANT_ID, role: 'ADMIN' };

    next();

  });

  app.use('/api/forms', webFormsRouter);

  return app;

}



beforeEach(() => {

  for (const model of [prisma.webForm, prisma.webFormSubmission, prisma.contact, prisma.deal, prisma.contactAttachment, prisma.leadCustomFieldDefinition, prisma.leadCustomFieldValue]) {

    for (const key of Object.keys(model)) {

      if (typeof model[key]?.mockReset === 'function') model[key].mockReset();

    }

  }

  prisma.webForm.findMany.mockResolvedValue([]);

  prisma.webForm.findFirst.mockResolvedValue(null);

  prisma.webFormSubmission.groupBy.mockResolvedValue([]);

  prisma.webFormSubmission.create.mockResolvedValue({ id: 1001 });

  prisma.webForm.create.mockResolvedValue({ id: 1, tenantId: TENANT_ID, createdByUserId: USER_ID, name: 'Contact Us', slug: 'contact-us', description: '', isActive: true, fieldsJson: JSON.stringify([]), styleJson: JSON.stringify({}), settingsJson: JSON.stringify({}) });

  prisma.contact.create.mockResolvedValue({ id: 2001, name: 'Jane Doe', email: 'jane@example.com', phone: '9876543210' });

  prisma.deal.create.mockResolvedValue({ id: 3001 });

  prisma.contactAttachment.create.mockResolvedValue({ id: 4001 });

  prisma.leadCustomFieldDefinition.findMany.mockResolvedValue([]);

  prisma.leadCustomFieldValue.upsert.mockResolvedValue({});

  emailSender.sendEmail.mockClear();

});



describe('GET /api/forms', () => {

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

      where: { tenantId: TENANT_ID },

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

    expect(res.body.embedCode).toContain('/embed/web-form.html?slug=contact-us');

  });

});



describe('POST /api/forms/public/:slug/submit', () => {

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

        source: 'website-form',

        status: 'Lead',

      }),

    }));

    expect(prisma.webFormSubmission.create).toHaveBeenCalled();

    const submissionArg = prisma.webFormSubmission.create.mock.calls[0][0].data;

    expect(submissionArg.payloadJson).toContain('"interest":["A","B"]');

    expect(prisma.deal.create).toHaveBeenCalled();

    expect(emailSender.sendEmail).toHaveBeenCalledWith(expect.objectContaining({

      to: 'owner@example.com',

      subject: 'New web form submission: Contact Us',

    }));

  });

});

