import { describe, expect, test } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const { generateTravelInvoicePdf } = requireCJS('../../services/pdfRenderer');
const pdfjs = requireCJS('pdfjs-dist/legacy/build/pdf.js');

const invoice = {
  id: 23, invoiceNum: 'TMC/26-27/0023', subBrand: 'tmc', docType: 'TaxInvoice',
  currency: 'INR', status: 'Issued', totalAmount: 10000,
  contactName: 'Example Customer', issuedDate: new Date('2026-10-01'),
};
const line = {
  lineType: 'per_trip', description: 'School trip package', quantity: 1,
  unitPrice: 10000, amount: 10000, hsnSac: '9985',
  cgstPercent: 9, sgstPercent: 9, cgstAmount: 900, sgstAmount: 900,
};

async function readPdf(buffer) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(595.28, 0);
    expect(viewport.height).toBeCloseTo(841.89, 0);
    pages.push((await page.getTextContent()).items.map((item) => item.str).join(' '));
  }
  return pages;
}

describe('travel invoice A4 presentation', () => {
  test.each([
    ['paid', 10000, 'PAID', 'INR 0.00'],
    ['partially paid', 3500, 'PARTIALLY PAID', 'INR 6,500.00'],
    ['unpaid despite stale Paid status', 0, 'UNPAID', 'INR 10,000.00'],
  ])('%s uses received money for status and outstanding balance', async (_, amountPaid, status, balance) => {
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: { ...invoice, subBrand: 'rfu', status: 'Paid', amountPaid, cgstAmount: 900, sgstAmount: 900 },
      lines: [line],
    }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain(status);
    expect(pages[0]).toMatch(new RegExp(`Outstanding balance\\s+${balance.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(pages[0]).toContain('CGST (reported)');
    expect(pages[0]).toContain('SGST (reported)');
    expect(pages[0]).toContain('INR 10,000.00'); // actual taxable value, not zero
  });

  test('explicit zero-rate data stays at 0% and does not add GST', async () => {
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: { ...invoice, subBrand: 'rfu', amountPaid: 0, cgstAmount: 0, sgstAmount: 0 },
      lines: [{ ...line, cgstAmount: 0, sgstAmount: 0, cgstPercent: 0, sgstPercent: 0 }],
    }));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('9985 / 0%');
    expect(pages[0]).not.toContain('CGST (reported)');
  });

  test('the SAC summary uses the persisted code and line amount', async () => {
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: { ...invoice, subBrand: 'rfu' }, lines: [{ ...line, hsnSac: '999123', amount: 10000 }],
    }));
    expect(pages.join(' ')).toContain('999123 / 18%');
    expect(pages.join(' ')).toContain('See invoice items');
    expect(pages.join(' ')).toContain('INR 10,000.00');
  });

  test('TMC invoices keep totals but omit tax and SAC presentation', async () => {
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: { ...invoice, amountPaid: 0, cgstAmount: 900, sgstAmount: 900 },
      lines: [line],
    }));
    const content = pages.join(' ');
    expect(content).not.toMatch(/TAX|GST|HSN\/SAC Summary|TAXABLE VALUE|CGST|SGST|IGST|Taxable amount|SAC 9985/i);
    expect(content).toContain('Grand total');
    expect(content).toContain('INR 10,000.00');
  });

  test('service description and payment rows use recorded trip and transaction data', async () => {
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: {
        ...invoice,
        amountPaid: 10000,
        destination: 'Jaipur',
        travelStartDate: new Date('2026-11-01'),
        travelEndDate: new Date('2026-11-05'),
        tripReference: 'TRIP-55',
        paymentTransactions: [{
          id: 901, amount: 6000, currency: 'INR', method: 'razorpay',
          reference: 'pay_abc123', paidAt: new Date('2026-10-01'),
        }, {
          id: 902, amount: 4000, currency: 'INR', method: 'upi',
          reference: 'UPI-REF-902', paidAt: new Date('2026-10-02'),
        }],
      },
      lines: [{ ...line, description: 'School trip package', bookingRef: 'HOTEL-789' }],
    }));
    const content = pages.join(' ');
    expect(content).toContain('Jaipur');
    expect(content).toContain('HOTEL-789');
    expect(content).toContain('Razorpay');
    expect(content).toContain('pay_abc123');
    expect(content).toContain('INR 6,000.00');
    expect(content).toContain('INR 4,000.00');
    expect(content).toContain('Amount received');
    expect(content).toMatch(/Outstanding balance\s+INR 0\.00/);
  });

  test('prints configured seller details and actual place of supply without placeholders', async () => {
    const addressPages = await readPdf(await generateTravelInvoicePdf({
      invoice, lines: [line], tenant: { id: 1, name: 'Seller', subBrandConfigJson: JSON.stringify({
        tmc: { registeredOffice: {}, address: '42 Fallback Street' },
      }) },
    }));
    expect(addressPages.join(' ')).toContain('42 Fallback Street');
    const tenant = { id: 1, name: 'Example Travels Pvt Ltd', subBrandConfigJson: JSON.stringify({
      tmc: { displayName: 'TMC School Trips', gstin: '29ABCDE1234F1Z5', website: 'example.test',
        termsAndConditions: 'Booking terms apply.' },
    }) };
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: { ...invoice, placeOfSupply: 'IN-MH' }, lines: [line], tenant,
    }));
    const content = pages.join(' ');
    expect(content).toContain('29ABCDE1234F1Z5');
    expect(content).toContain('example.test');
    expect(content).toContain('IN-MH');
    expect(content).toContain('Booking terms apply.');
    expect(content).not.toContain('To be determined');
  });

  test('many wrapped rows continue across A4 pages with repeated table headings', async () => {
    const lines = Array.from({ length: 45 }, (_, index) => ({
      ...line, description: `Travel service ${index + 1}: hotel and transport for the school group with a detailed trip itinerary`,
      amount: 1000, unitPrice: 1000, cgstAmount: 0, sgstAmount: 0,
      cgstPercent: 0, sgstPercent: 0,
    }));
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice: { ...invoice, totalAmount: 45000 }, lines,
    }));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages.filter((content) => /Travel service \d+/.test(content))) {
      expect(page).toContain('DESCRIPTION');
    }
    expect(pages.join(' ')).toContain('Travel service 45');
    expect(pages.at(-1)).toContain('Outstanding balance');
  });

  test('a single very long description continues on the next page without losing its end', async () => {
    const description = `Start ${'detailed travel coordination '.repeat(175)} END-OF-DESCRIPTION`;
    const pages = await readPdf(await generateTravelInvoicePdf({
      invoice, lines: [{ ...line, description }],
    }));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(' ')).toMatch(/END-OF-\s*DESCRIPTION/);
    for (const page of pages.slice(0, -1)) expect(page).toContain('DESCRIPTION');
  });
});
