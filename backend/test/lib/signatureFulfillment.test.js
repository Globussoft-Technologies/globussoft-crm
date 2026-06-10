// Unit tests for backend/lib/signatureFulfillment.js
//
// Exercises the auto-convert + branch logic that fires when an Estimate is
// signed. Payment gateways are disabled (env keys stripped) so the real
// createInvoicePaymentLink short-circuits to NO_GATEWAY with zero network I/O
// — i.e. the "converted but no link" path. The gateway-present path is covered
// live + in paymentLink.test.js.
//
// Mocking: monkey-patch the shared prisma singleton (vitest's vi.mock can't
// intercept the SUT's CJS require) per the project pattern.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

// Gateways OFF — no real Stripe/Razorpay calls.
delete process.env.STRIPE_SECRET_KEY;
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const prisma = requireCjs('../../lib/prisma');
prisma.estimate = prisma.estimate || {};
prisma.estimate.findFirst = vi.fn();
prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn().mockResolvedValue({ defaultCurrency: 'INR' });
prisma.tenantSetting = prisma.tenantSetting || {};
prisma.tenantSetting.findFirst = vi.fn().mockResolvedValue(null);
prisma.auditLog = prisma.auditLog || {};
prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
prisma.payment = prisma.payment || {};
prisma.payment.create = vi.fn().mockResolvedValue({ id: 1 });

const txInvoice = { id: 900, invoiceNum: 'INV-AUTO01', amount: 4950 };
prisma.$transaction = vi.fn(async (cb) => cb({
  invoice: { create: vi.fn(async () => txInvoice) },
  estimate: { update: vi.fn(async () => ({ id: 5, status: 'Converted' })) },
}));

const { fulfillSignedEstimate } = requireCjs('../../lib/signatureFulfillment');

const ESTIMATE = {
  id: 5, estimateNum: 'EST-5', status: 'Draft', totalAmount: 4950,
  contactId: 77, dealId: null,
  contact: { id: 77, name: 'Mohit', email: 'mohit@example.com', phone: '+91999' },
  lineItems: [],
};

beforeEach(() => {
  prisma.estimate.findFirst.mockReset().mockResolvedValue({ ...ESTIMATE });
  prisma.$transaction.mockClear();
});

describe('fulfillSignedEstimate', () => {
  test('returns not_found when the estimate is missing', async () => {
    prisma.estimate.findFirst.mockResolvedValue(null);
    const r = await fulfillSignedEstimate({ documentId: 5, tenantId: 2 });
    expect(r.status).toBe('not_found');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('returns already_converted (no second conversion) for a Converted estimate', async () => {
    prisma.estimate.findFirst.mockResolvedValue({ ...ESTIMATE, status: 'Converted' });
    const r = await fulfillSignedEstimate({ documentId: 5, tenantId: 2 });
    expect(r.status).toBe('already_converted');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('returns no_contact when the estimate has no contact to bill', async () => {
    prisma.estimate.findFirst.mockResolvedValue({ ...ESTIMATE, contactId: null, contact: null });
    const r = await fulfillSignedEstimate({ documentId: 5, tenantId: 2 });
    expect(r.status).toBe('no_contact');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test('converts a Draft estimate to an invoice (gateways off → payLink null)', async () => {
    const r = await fulfillSignedEstimate({ documentId: 5, tenantId: 2 });
    expect(r.status).toBe('converted');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(r.invoice).toEqual(txInvoice);
    expect(r.currency).toBe('INR');
    expect(r.contact).toMatchObject({ email: 'mohit@example.com' });
    // No gateway configured in this suite → no link, payError surfaced.
    expect(r.payLink).toBe(null);
    expect(r.payError).toBeTruthy();
  });

  test('prefers the signer email over the contact email (contact may be a placeholder)', async () => {
    // Contact carries a synthetic placeholder address (e.g. WhatsApp-synced).
    prisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE,
      contact: { id: 77, name: 'Mohit', email: 'wa-919900@whatsapp.local', phone: '+91999' },
    });
    const r = await fulfillSignedEstimate({
      documentId: 5, tenantId: 2,
      signerName: 'Real Signer', signerEmail: 'real@customer.com',
    });
    expect(r.status).toBe('converted');
    expect(r.customerEmail).toBe('real@customer.com'); // signer wins
    expect(r.customerName).toBe('Real Signer');
  });
});
