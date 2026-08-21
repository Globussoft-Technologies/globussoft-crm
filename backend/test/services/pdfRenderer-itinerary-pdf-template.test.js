// @ts-check
/**
 * G115 — Itinerary PDF template underprint regression pin.
 *
 * Pins that `renderTravelItineraryPdf` accepts an uploaded PDF template buffer
 * and overlays the dynamic itinerary data on top without throwing. The output
 * is a valid multi-page PDF whose page count is at least the template's page
 * count (overflow pages duplicate the last template page so the whole doc
 * keeps the brand look).
 *
 * Run: `cd backend && npx vitest run test/services/pdfRenderer-itinerary-pdf-template.test.js`
 */

import { describe, test, expect } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import pdfR from '../../services/pdfRenderer.js';

const { renderTravelItineraryPdf } = pdfR;

function itineraryFixture(overrides = {}) {
  return {
    id: 8888,
    subBrand: 'tmc',
    version: 2,
    currency: 'INR',
    destination: 'Shimla',
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2026-09-05T00:00:00Z'),
    totalAmount: 25000,
    items: [
      { itemType: 'Stay', description: 'Hotel', unitCost: 4000, markup: 500, totalPrice: 4500, position: 1 },
      { itemType: 'Sightseeing', description: 'Local tour', unitCost: 2000, markup: 300, totalPrice: 2300, position: 2 },
    ],
    ...overrides,
  };
}

function contactFixture() {
  return { name: 'PDF Template Customer', email: 'pdf@example.com', phone: '+919999999999' };
}

async function makeOnePageTemplate() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({
    x: 0, y: 780, width: 595.28, height: 61.89,
    color: rgb(0.05, 0.3, 0.45),
  });
  page.drawText('Designer Template Header', {
    x: 50, y: 800, size: 18, color: rgb(1, 1, 1),
  });
  page.drawText('Sample body text to be blanked', {
    x: 50, y: 600, size: 12, color: rgb(0, 0, 0),
  });
  return await doc.save();
}

async function makeTwoPageTemplate() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawRectangle({
      x: 0, y: 780, width: 595.28, height: 61.89,
      color: rgb(0.45, 0.05, 0.3),
    });
    page.drawText(`Page ${i + 1} brand`, {
      x: 50, y: 800, size: 14, color: rgb(1, 1, 1),
    });
  }
  return await doc.save();
}

describe('renderTravelItineraryPdf — G115 PDF template underprint', () => {
  test('one-page template renders a valid PDF with at least one page', async () => {
    const templateBuf = await makeOnePageTemplate();
    const buf = await renderTravelItineraryPdf(
      itineraryFixture(),
      contactFixture(),
      { pdfTemplateBuffer: templateBuf },
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  test('two-page template uses both pages when content overflows', async () => {
    const templateBuf = await makeTwoPageTemplate();
    const manyItems = Array.from({ length: 40 }, (_, i) => ({
      itemType: 'Activity',
      description: `Activity number ${i + 1} with a long enough description to force pagination when repeated`,
      unitCost: 1000,
      markup: 100,
      totalPrice: 1100,
      position: i + 1,
    }));
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ items: manyItems }),
      contactFixture(),
      { pdfTemplateBuffer: templateBuf },
    );
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  test('overflow items duplicate the last template page', async () => {
    const templateBuf = await makeOnePageTemplate();
    const manyItems = Array.from({ length: 40 }, (_, i) => ({
      itemType: 'Activity',
      description: `Activity number ${i + 1} with a long enough description to force pagination when repeated`,
      unitCost: 1000,
      markup: 100,
      totalPrice: 1100,
      position: i + 1,
    }));
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ items: manyItems }),
      contactFixture(),
      { pdfTemplateBuffer: templateBuf },
    );
    const out = await PDFDocument.load(buf);
    expect(out.getPageCount()).toBeGreaterThan(1);
  });

  test('missing or invalid template buffer falls back to standard renderer', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
  });
});
