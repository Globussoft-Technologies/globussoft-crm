// @ts-check
/**
 * PRD §4.7 "Document security model" (gap A3) — dynamic viewer-identity
 * watermark on travel PDFs.
 *
 * Pins the contract for `applyViewerWatermark(doc, { viewerName,
 * viewerEmail, timestamp })` and its opt-in wiring into
 * renderTravelItineraryPdf / renderTravelDiagnosticPdf:
 *
 *   - OFF by default: calling the renderers WITHOUT opts.viewerWatermark
 *     must not invoke the helper and must not emit viewer identity into
 *     the PDF body (existing callers + the S52/S65 pinned vitest output
 *     stay byte-stable).
 *   - ON via opts.viewerWatermark: the rendered PDF text contains the
 *     viewer's name, email and timestamp, repeated (diagonal tiling).
 *   - Multi-page: the pageAdded hook re-applies the watermark on every
 *     overflow page (spied via the module.exports self-mocking seam —
 *     same pattern S51/S65 use for fetchLogoBuffer).
 *   - Layout safety: enabling the watermark doesn't disturb the
 *     renderer's content flow (brand label + grand total still render).
 *
 * Text extraction approach: same extractPdfText helper
 * test/services/pdfRenderer.test.js uses — inflate FlateDecode streams,
 * decode hex TJ arrays + literal Tj strings.
 *
 * Run: cd backend && npx vitest run test/services/pdfRenderer-viewer-watermark.test.js
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import zlib from 'node:zlib';
import pdfR from '../../services/pdfRenderer.js';

const {
  renderTravelItineraryPdf,
  renderTravelDiagnosticPdf,
  applyViewerWatermark,
} = pdfR;

// ── Helpers (lifted from pdfRenderer.test.js) ───────────────────────────

function extractPdfText(buf) {
  const str = buf.toString('latin1');
  let allOps = '';
  const lenRe = /\/Length\s+(\d+)\b[^>]*>>\s*stream\r?\n/g;
  let m;
  while ((m = lenRe.exec(str)) !== null) {
    const len = parseInt(m[1], 10);
    const start = lenRe.lastIndex;
    const raw = buf.subarray(start, start + len);
    try {
      allOps += zlib.inflateSync(raw).toString('latin1');
    } catch {
      allOps += raw.toString('latin1');
    }
  }
  let out = '';
  const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
  let s;
  while ((s = tjArrayRe.exec(allOps)) !== null) {
    const inner = s[1];
    const hexRe = /<([0-9a-fA-F\s]+)>/g;
    let h;
    while ((h = hexRe.exec(inner)) !== null) {
      const hex = h[1].replace(/\s+/g, '');
      for (let i = 0; i + 1 < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      }
    }
    out += ' ';
  }
  const tjLiteralRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((s = tjLiteralRe.exec(allOps)) !== null) {
    out += s[1].replace(/\\(.)/g, '$1') + ' ';
  }
  return out;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// ── Fixtures (conventions from travel-sibling-pdfs-brand-kit.test.js) ──

function itineraryFixture(overrides = {}) {
  return {
    id: 555,
    subBrand: 'tmc',
    version: 1,
    currency: 'INR',
    destination: 'Mussoorie',
    startDate: new Date('2026-07-01T00:00:00Z'),
    endDate: new Date('2026-07-04T00:00:00Z'),
    totalAmount: 80000,
    items: [
      { itemType: 'Stay', description: 'Hotel x 3 nights', unitCost: 12000, markup: 2000, totalPrice: 42000, position: 1 },
      { itemType: 'Transport', description: 'AC Bus', unitCost: 8000, markup: 1500, totalPrice: 9500, position: 2 },
    ],
    ...overrides,
  };
}

function contactFixture(overrides = {}) {
  return {
    name: 'Asha Mehta',
    email: 'asha@example.com',
    phone: '+919876543210',
    ...overrides,
  };
}

function diagnosticFixture(overrides = {}) {
  return {
    id: 12,
    subBrand: 'visasure',
    classificationLabel: 'High readiness',
    classification: 'high',
    score: 0.84,
    recommendedTier: 'Standard',
    answersJson: JSON.stringify({ q1: 'a' }),
    createdAt: new Date('2026-05-15T10:00:00Z'),
    ...overrides,
  };
}

function bankFixture(overrides = {}) {
  return {
    version: 3,
    questionsJson: JSON.stringify({
      questions: [{ id: 'q1', text: 'How ready are you?', options: [{ value: 'a', label: 'Very ready' }] }],
    }),
    ...overrides,
  };
}

const VIEWER = {
  viewerName: 'Ravi Advisor',
  viewerEmail: 'ravi.advisor@example.com',
  timestamp: '2026-06-12T10:30:00.000Z',
};

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Itinerary PDF ───────────────────────────────────────────────────────

describe('renderTravelItineraryPdf — viewer watermark (opt-in)', () => {
  test('OFF by default: no viewer identity in the PDF, helper never called', async () => {
    const spy = vi.spyOn(pdfR, 'applyViewerWatermark');
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture());
    expect(spy).not.toHaveBeenCalled();
    const text = extractPdfText(buf);
    expect(text).not.toContain(VIEWER.viewerEmail);
    expect(text).not.toContain(VIEWER.viewerName);
  });

  test('ON: name + email + timestamp appear, repeated diagonally', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture(), {
      viewerWatermark: VIEWER,
    });
    const text = extractPdfText(buf);
    expect(text).toContain(VIEWER.viewerName);
    expect(text).toContain(VIEWER.viewerEmail);
    expect(text).toContain(VIEWER.timestamp);
    // Diagonal tiling → the label repeats many times across the page.
    expect(countOccurrences(text, VIEWER.viewerEmail)).toBeGreaterThanOrEqual(3);
  });

  test('ON: content layout is undisturbed (brand label, items, grand total still render)', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture(), {
      viewerWatermark: VIEWER,
    });
    const text = extractPdfText(buf);
    expect(text).toContain('Asha Mehta');
    expect(text).toContain('Mussoorie');
    expect(text).toContain('Hotel x 3 nights');
    expect(text).toContain('Grand total');
  });

  test('multi-page: pageAdded hook re-applies the watermark on every page', async () => {
    const spy = vi.spyOn(pdfR, 'applyViewerWatermark');
    // ~30 items at 24pt row height forces at least one page break
    // (page-break headroom triggers past y > pageHeight - 120).
    const manyItems = Array.from({ length: 30 }, (_, i) => ({
      itemType: 'activity',
      description: `Activity day ${i + 1}`,
      totalPrice: 1000 + i,
      position: i + 1,
    }));
    const buf = await renderTravelItineraryPdf(
      itineraryFixture({ items: manyItems }),
      contactFixture(),
      { viewerWatermark: VIEWER },
    );
    // Once for page 1 + once per overflow page.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    // And the document really has 2+ pages.
    const pageCount = countOccurrences(buf.toString('latin1'), '/Type /Page\n');
    expect(pageCount).toBeGreaterThanOrEqual(2);
  });
});

// ── Diagnostic PDF ──────────────────────────────────────────────────────

describe('renderTravelDiagnosticPdf — viewer watermark (opt-in)', () => {
  test('OFF by default: no viewer identity in the PDF', async () => {
    const buf = await renderTravelDiagnosticPdf(diagnosticFixture(), contactFixture(), bankFixture());
    const text = extractPdfText(buf);
    expect(text).not.toContain(VIEWER.viewerEmail);
  });

  test('ON: viewer identity appears in the PDF', async () => {
    const buf = await renderTravelDiagnosticPdf(diagnosticFixture(), contactFixture(), bankFixture(), {
      viewerWatermark: VIEWER,
    });
    const text = extractPdfText(buf);
    expect(text).toContain(VIEWER.viewerName);
    expect(text).toContain(VIEWER.viewerEmail);
    expect(text).toContain(VIEWER.timestamp);
    // Diagnostic content still renders over the watermark.
    expect(text).toContain('High readiness');
  });
});

// ── applyViewerWatermark — direct helper behavior ───────────────────────

describe('applyViewerWatermark — helper edge cases', () => {
  test('missing email/timestamp: still stamps name + a default ISO timestamp (never throws)', async () => {
    const buf = await renderTravelItineraryPdf(itineraryFixture(), contactFixture(), {
      viewerWatermark: { viewerName: 'Solo Name' },
    });
    const text = extractPdfText(buf);
    expect(text).toContain('Solo Name');
    // Default timestamp is generated — assert an ISO-ish marker is present
    // on the same label (current year prefix is stable enough for a smoke).
    expect(text).toMatch(/Solo Name · 20\d\d-/);
  });

  test('empty viewer object: falls back to timestamp-only label (never throws)', async () => {
    await expect(
      renderTravelItineraryPdf(itineraryFixture(), contactFixture(), { viewerWatermark: {} }),
    ).resolves.toBeInstanceOf(Buffer);
  });

  test('is exported and callable', () => {
    expect(typeof applyViewerWatermark).toBe('function');
  });
});
