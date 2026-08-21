// @ts-check
/**
 * Travel CRM — PDF itinerary template processor unit tests (G115).
 */

import { describe, test, expect } from 'vitest';
import { PDFDocument, rgb } from 'pdf-lib';
import travelPdfTemplate from '../../lib/travelPdfTemplate.js';

const { analyzePdfTemplate, detectContentBox } = travelPdfTemplate;

function makeA4TextPdf() {
  const doc = PDFDocument.create();
  return doc.then((d) => {
    const page = d.addPage([595.28, 841.89]);
    page.drawRectangle({
      x: 0, y: 780, width: 595.28, height: 61.89,
      color: rgb(0.05, 0.3, 0.45),
    });
    page.drawText('Header brand', { x: 50, y: 800, size: 14, color: rgb(1, 1, 1) });
    page.drawText('Body line one', { x: 60, y: 500, size: 12, color: rgb(0, 0, 0) });
    page.drawText('Body line two', { x: 60, y: 470, size: 12, color: rgb(0, 0, 0) });
    page.drawText('Footer note', { x: 50, y: 40, size: 9, color: rgb(0.4, 0.4, 0.4) });
    return d.save();
  });
}

describe('detectContentBox', () => {
  test('returns a box inside the page bounds for typical header/body/footer text', () => {
    const items = [
      { str: 'Header brand', transform: [14, 0, 0, 14, 50, 800], width: 100, height: 14 },
      { str: 'Body line one', transform: [12, 0, 0, 12, 60, 500], width: 100, height: 12 },
      { str: 'Body line two', transform: [12, 0, 0, 12, 60, 470], width: 100, height: 12 },
      { str: 'Footer note', transform: [9, 0, 0, 9, 50, 40], width: 80, height: 9 },
    ];
    const box = detectContentBox(items, 595.28, 841.89);
    expect(box.x).toBeGreaterThan(0);
    expect(box.y).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(595.28);
    expect(box.y + box.height).toBeLessThanOrEqual(841.89);
    // The body lines sit between the header and footer bands.
    const top = box.y + box.height;
    const bottom = box.y;
    expect(top).toBeLessThan(800);
    expect(bottom).toBeGreaterThan(49);
  });

  test('returns a safe fallback when the page has no text', () => {
    const box = detectContentBox([], 595.28, 841.89);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });
});

describe('analyzePdfTemplate', () => {
  test('produces a blanked buffer and scaled regions for a multi-page PDF', async () => {
    const input = await makeA4TextPdf();
    const { blankedBuffer, regions } = await analyzePdfTemplate(Buffer.from(input));
    expect(Buffer.isBuffer(blankedBuffer)).toBe(true);
    expect(blankedBuffer.length).toBeGreaterThan(100);
    expect(regions).toHaveProperty('pageSize');
    expect(regions).toHaveProperty('contentBox');
    expect(regions).toHaveProperty('pages');
    expect(Array.isArray(regions.pages)).toBe(true);
    expect(regions.pages.length).toBeGreaterThanOrEqual(1);
    expect(regions.pages[0]).toHaveProperty('contentBox');
    expect(regions.contentBox.width).toBeGreaterThan(0);
    expect(regions.contentBox.height).toBeGreaterThan(0);
  });
});
