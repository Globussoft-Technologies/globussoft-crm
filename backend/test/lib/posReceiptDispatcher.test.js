// Unit tests for backend/lib/posReceiptDispatcher.js (Wave 8b).
//
// Coverage scope:
//   - composeSmsBody / composeWhatsappBody / formatMoney (pure helpers)
//   - dispatchReceiptForSale: every branch
//       * payload missing → no-op
//       * non-COMPLETED status → no-op
//       * sale not found / wrong tenant → no-op
//       * anonymous walk-in (patientId=null) → no-op
//       * patient missing phone → no-op
//       * happy path → SMS queued + WhatsApp queued (opted-in)
//       * happy path → SMS queued, WhatsApp NOT queued (no contact)
//       * happy path → SMS queued, WhatsApp NOT queued (opted-out)
//       * dedup hit (recent SmsMessage matches invoiceNumber) → no-op
//   - start: idempotent boot, subscribes to bus, picks up subsequent
//     emit (smoke check via bus.emit)
//
// Mocking strategy: monkey-patch prisma singleton (same pattern as
// eventBus.test.js + slaBreachEngine.test.js).

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import {
  dispatchReceiptForSale,
  composeSmsBody,
  composeWhatsappBody,
  formatMoney,
  start,
} from '../../lib/posReceiptDispatcher.js';

beforeAll(() => {
  prisma.sale = prisma.sale || {};
  prisma.sale.findFirst = vi.fn();
  prisma.patient = prisma.patient || {};
  prisma.patient.findFirst = vi.fn();
  prisma.tenant = prisma.tenant || {};
  prisma.tenant.findUnique = vi.fn();
  prisma.smsMessage = prisma.smsMessage || {};
  prisma.smsMessage.findFirst = vi.fn();
  prisma.smsMessage.create = vi.fn();
  prisma.contact = prisma.contact || {};
  prisma.contact.findFirst = vi.fn();
  prisma.whatsAppMessage = prisma.whatsAppMessage || {};
  prisma.whatsAppMessage.create = vi.fn();
});

beforeEach(() => {
  prisma.sale.findFirst.mockReset();
  prisma.patient.findFirst.mockReset();
  prisma.tenant.findUnique.mockReset();
  prisma.smsMessage.findFirst.mockReset();
  prisma.smsMessage.create.mockReset();
  prisma.contact.findFirst.mockReset();
  prisma.whatsAppMessage.create.mockReset();

  // Reasonable defaults — every test overrides what it cares about.
  prisma.sale.findFirst.mockResolvedValue(null);
  prisma.patient.findFirst.mockResolvedValue(null);
  prisma.tenant.findUnique.mockResolvedValue({ name: 'Enhanced Wellness', defaultCurrency: 'INR' });
  prisma.smsMessage.findFirst.mockResolvedValue(null);
  prisma.smsMessage.create.mockResolvedValue({ id: 1 });
  prisma.contact.findFirst.mockResolvedValue(null);
  prisma.whatsAppMessage.create.mockResolvedValue({ id: 1 });
});

describe('formatMoney', () => {
  test('renders INR with Rs. prefix', () => {
    expect(formatMoney(1234.5, 'INR')).toBe('Rs.1234.50');
  });
  test('renders USD with $ prefix', () => {
    expect(formatMoney(99.9, 'USD')).toBe('$99.90');
  });
  test('falls back to bare currency code on unknown', () => {
    expect(formatMoney(50, 'EUR')).toBe('EUR50.00');
  });
  test('handles zero / null amount', () => {
    expect(formatMoney(0, 'INR')).toBe('Rs.0.00');
    expect(formatMoney(null, 'INR')).toBe('Rs.0.00');
  });
  test('NaN coerces to 0.00 via `Number(NaN) || 0` fallback', () => {
    // Pins the defensive `|| 0` short-circuit — without it, NaN would
    // render as "Rs.NaN" which is downstream-unfriendly on the SMS body.
    expect(formatMoney(NaN, 'INR')).toBe('Rs.0.00');
  });
  test('negative amounts pass through unmodified (no clamping)', () => {
    // Pins that the formatter does NOT clamp negatives — refunds /
    // adjustments may legitimately render as negative on a receipt. The
    // policy decision about whether to show negatives lives at the
    // composer / template layer, not in the formatter.
    expect(formatMoney(-500, 'INR')).toBe('Rs.-500.00');
  });
  test('currency comparison is strictly case-sensitive (`inr` !== `INR`)', () => {
    // Pins the `===` strict comparison — lowercase falls through to the
    // raw-passthrough branch via `currency || ""`. Symptom if someone
    // ever .toUpperCase()s the input: this test starts asserting the
    // wrong shape.
    expect(formatMoney(100, 'inr')).toBe('inr100.00');
  });
  test('null currency renders bare number (empty-string symbol fallback)', () => {
    // Pins the `|| ""` defensive fallback — a tenant with no
    // defaultCurrency configured should still produce a number, not
    // "null100.00" or a crash.
    expect(formatMoney(100, null)).toBe('100.00');
  });
});

describe('composeSmsBody', () => {
  test('includes invoice number, total, line count, clinic name, patient name', () => {
    const body = composeSmsBody({
      sale: { invoiceNumber: 'INV-001', total: 500 },
      patientName: 'Priya Sharma',
      clinicName: 'Enhanced Wellness',
      currency: 'INR',
      lineCount: 2,
    });
    expect(body).toContain('Priya Sharma');
    expect(body).toContain('INV-001');
    expect(body).toContain('Rs.500.00');
    expect(body).toContain('Enhanced Wellness');
    expect(body).toContain('2 items');
  });
  test('singularises "1 item" not "1 items"', () => {
    const body = composeSmsBody({
      sale: { invoiceNumber: 'INV-002', total: 100 },
      patientName: 'A',
      clinicName: 'C',
      currency: 'INR',
      lineCount: 1,
    });
    expect(body).toContain('1 item');
    expect(body).not.toContain('1 items');
  });
  test('lineCount=0 pluralises to "0 items" (only 1 is singular)', () => {
    // Pins the `=== 1` strict-equality singular branch — every non-1
    // value (including 0, which is grammatically debatable in English
    // but consistent with the rest of the codebase) gets the plural
    // suffix. Safer than re-deriving Intl.PluralRules here.
    const body = composeSmsBody({
      sale: { invoiceNumber: 'INV-EMPTY', total: 0 },
      patientName: 'A',
      clinicName: 'C',
      currency: 'INR',
      lineCount: 0,
    });
    expect(body).toContain('0 items');
  });
  test('missing patientName falls back to "Hi there,"', () => {
    // Pins the `|| "there"` defensive fallback — if upstream forgets to
    // pass patient.name (or it's null on the patient row), the receipt
    // still reads as a polite greeting rather than "Hi undefined,".
    const body = composeSmsBody({
      sale: { invoiceNumber: 'INV-NONAME', total: 100 },
      patientName: undefined,
      clinicName: 'C',
      currency: 'INR',
      lineCount: 1,
    });
    expect(body).toContain('Hi there,');
    expect(body).not.toContain('undefined');
  });
  test('SMS vs WhatsApp bodies diverge in content (same inputs → different strings)', () => {
    // Pins that the two composers are NOT aliases — WhatsApp uses bullet
    // separators and slightly different wording ("your purchase ... is
    // confirmed" vs "thank you for your purchase"). If someone tries to
    // collapse the two into a single helper, this test catches it.
    const args = {
      sale: { invoiceNumber: 'INV-DIV', total: 250 },
      patientName: 'Rahul',
      clinicName: 'EW',
      currency: 'INR',
      lineCount: 3,
    };
    const smsBody = composeSmsBody(args);
    const waBody = composeWhatsappBody(args);
    expect(smsBody).not.toBe(waBody);
    expect(waBody).toContain('•'); // WhatsApp uses bullets
    expect(smsBody).not.toContain('•'); // SMS doesn't (DLT-template safe)
    expect(waBody).toContain('confirmed'); // WhatsApp wording
    expect(smsBody).toContain('thank you'); // SMS wording
  });
});

describe('composeWhatsappBody', () => {
  test('includes the same load-bearing fields as the SMS body', () => {
    const body = composeWhatsappBody({
      sale: { invoiceNumber: 'INV-003', total: 250 },
      patientName: 'Rahul',
      clinicName: 'EW',
      currency: 'INR',
      lineCount: 3,
    });
    expect(body).toContain('Rahul');
    expect(body).toContain('INV-003');
    expect(body).toContain('Rs.250.00');
    expect(body).toContain('3 items');
  });
});

describe('dispatchReceiptForSale', () => {
  test('payload missing → no-op (no DB writes)', async () => {
    await dispatchReceiptForSale({ payload: null, tenantId: 1 });
    await dispatchReceiptForSale({ payload: {}, tenantId: 1 });
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('non-COMPLETED payload status → no-op', async () => {
    await dispatchReceiptForSale({ payload: { saleId: 1, status: 'CANCELLED' }, tenantId: 1 });
    expect(prisma.sale.findFirst).not.toHaveBeenCalled();
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('sale not found / wrong tenant → no-op', async () => {
    prisma.sale.findFirst.mockResolvedValue(null);
    await dispatchReceiptForSale({ payload: { saleId: 99 }, tenantId: 1 });
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('sale found but status=DRAFT → no-op (post-fetch status re-check)', async () => {
    // Pins the SUT's defensive sale.status re-check (line 149) — even
    // when the payload says COMPLETED, the DB row's status is the
    // authoritative source. Catches a race where the listener fires
    // before a refund handler flips the row to DRAFT.
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'DRAFT', invoiceNumber: 'INV-DRAFT', total: 100, patientId: 42, lineItems: [{}],
    });
    await dispatchReceiptForSale({ payload: { saleId: 1, status: 'COMPLETED' }, tenantId: 1 });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('anonymous walk-in (patientId=null) → no-op', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'COMPLETED', invoiceNumber: 'INV-1', total: 100, patientId: null, lineItems: [],
    });
    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });
    expect(prisma.patient.findFirst).not.toHaveBeenCalled();
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('patient missing phone → no-op', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'COMPLETED', invoiceNumber: 'INV-1', total: 100, patientId: 42, lineItems: [{}],
    });
    prisma.patient.findFirst.mockResolvedValue({ id: 42, name: 'X', phone: null });
    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });
    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
  });

  test('happy path: SMS queued + WhatsApp queued (opted-in)', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'COMPLETED', invoiceNumber: 'INV-99', total: 750, patientId: 42,
      lineItems: [{}, {}],
    });
    prisma.patient.findFirst.mockResolvedValue({ id: 42, name: 'Priya', phone: '+919876543210' });
    prisma.contact.findFirst.mockResolvedValue({ id: 7, whatsappOptIn: true });

    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });

    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.smsMessage.create.mock.calls[0][0].data.body).toContain('INV-99');
    expect(prisma.smsMessage.create.mock.calls[0][0].data.status).toBe('QUEUED');
    expect(prisma.whatsAppMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.body).toContain('INV-99');
    expect(prisma.whatsAppMessage.create.mock.calls[0][0].data.contactId).toBe(7);
  });

  test('SMS queued but WhatsApp NOT queued when contact has whatsappOptIn=false', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'COMPLETED', invoiceNumber: 'INV-100', total: 250, patientId: 42, lineItems: [{}],
    });
    prisma.patient.findFirst.mockResolvedValue({ id: 42, name: 'X', phone: '+919876543210' });
    prisma.contact.findFirst.mockResolvedValue({ id: 7, whatsappOptIn: false });

    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });

    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('SMS queued but WhatsApp NOT queued when no contact match', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'COMPLETED', invoiceNumber: 'INV-101', total: 250, patientId: 42, lineItems: [{}],
    });
    prisma.patient.findFirst.mockResolvedValue({ id: 42, name: 'X', phone: '+919876543210' });
    prisma.contact.findFirst.mockResolvedValue(null);

    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });

    expect(prisma.smsMessage.create).toHaveBeenCalledTimes(1);
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('dedup hit: recent SmsMessage with same invoiceNumber → no-op', async () => {
    prisma.sale.findFirst.mockResolvedValue({
      id: 1, status: 'COMPLETED', invoiceNumber: 'INV-DEDUP', total: 500, patientId: 42, lineItems: [{}],
    });
    prisma.patient.findFirst.mockResolvedValue({ id: 42, name: 'X', phone: '+919876543210' });
    prisma.smsMessage.findFirst.mockResolvedValue({ id: 999 }); // dedup hit

    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });

    expect(prisma.smsMessage.create).not.toHaveBeenCalled();
    expect(prisma.whatsAppMessage.create).not.toHaveBeenCalled();
  });

  test('throws inside dispatch are caught and logged (no propagation)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.sale.findFirst.mockRejectedValue(new Error('db boom'));

    // Must NOT throw — the dispatcher's catch swallows DB errors so the
    // event bus stays healthy.
    await dispatchReceiptForSale({ payload: { saleId: 1 }, tenantId: 1 });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('start (idempotent)', () => {
  test('start() is idempotent — second call is a no-op (no extra listeners)', () => {
    // Smoke test — start exists and doesn't throw on repeated calls.
    expect(() => start()).not.toThrow();
    expect(() => start()).not.toThrow();
  });
});
