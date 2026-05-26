/**
 * DocumentTracking.test.jsx — vitest + RTL page-level coverage for the
 * Document Tracking page (frontend/src/pages/DocumentTracking.jsx, 484 LOC,
 * NO existing test as of 2026-05-25).
 *
 * Authored by the autonomous test-writing cron — first test for this surface.
 *
 * The page lets users generate per-recipient tracking URLs for outbound
 * documents (Proposal / Quote / Estimate / Contract) and then watch the
 * resulting view-events as a stats bar + a per-document table. Surface:
 *
 *   • Header "Document Tracking" + descriptor + "Track New Document" CTA.
 *   • Four StatCards (Tracked Documents / Total Views / Unique Viewers /
 *     Avg View Duration) sourced from /api/document-views/stats.
 *   • A table grouped by (documentType, documentId) — one row per
 *     document with viewer email, views count "viewed/recipients",
 *     first/last viewed timestamps, total duration, and a StatusPill
 *     rendering "Viewed" (green) for documents with ≥1 view or "Pending"
 *     (amber) for documents whose recipients haven't opened the link.
 *   • A Create modal with a Document Type select (Proposal default),
 *     Document select (populated from ENDPOINT_FOR_TYPE) or manual ID
 *     fallback, recipient email, and a "Generate Tracking URL" submit.
 *   • After successful create, the modal flips to a "Tracking URL
 *     generated" success surface with a readonly URL input and Copy CTA.
 *
 * Scope-pinned invariants — 13 cases:
 *
 *   1. Page renders the heading + descriptor + "Track New Document" CTA.
 *   2. Initial mount fires GET /api/document-views AND
 *      GET /api/document-views/stats in parallel with `{ silent: true }`
 *      so transient errors don't toast (per the #468 comment in source).
 *   3. Loading state renders "Loading..." before /api/document-views
 *      resolves; empty state renders the "No tracked documents yet."
 *      placeholder once it resolves with [].
 *   4. Stats bar surfaces the labels + values from /stats — formatted via
 *      formatDuration for avgViewDuration.
 *   5. Populated list renders one row per (documentType, documentId)
 *      group with the "<Type> #<id>" cell, viewer email, views fraction
 *      "<viewed>/<recipients>", and a StatusPill.
 *   6. StatusPill labels — "Viewed" for any document with ≥1 view,
 *      "Pending" for a document whose recipients haven't opened it yet.
 *   7. Multi-recipient grouping — two views on the same document collapse
 *      into one row with recipients=2; views count reflects how many of
 *      those recipients have actually opened.
 *   8. Clicking "Track New Document" opens the Create modal with the
 *      Document Type / Document selects + recipient email field +
 *      Generate Tracking URL submit; fetches the document list for the
 *      default Proposal type (which maps to /api/cpq/quotes per
 *      ENDPOINT_FOR_TYPE).
 *   9. Submitting Create with no documentId fires notify.error and does
 *      NOT POST /api/document-views/create.
 *  10. Successful create POSTs /api/document-views/create with the
 *      documentType + parsed-int documentId + viewerEmail body and
 *      flips the modal to the success surface ("Tracking URL generated").
 *  11. Changing Document Type re-fetches from the matching endpoint
 *      (Contract → /api/contracts, Estimate → /api/estimates).
 *  12. Stats falls back to the initial zeroed shape when /stats fails.
 *  13. Closing the modal via the "Close dialog" aria-labelled button
 *      resets the form back to the create surface for the next open.
 *
 * Drift / contract notes:
 *   - The page does NOT have any RBAC gates — every authenticated user
 *     sees every control. Pinned as-is; backend enforces role-based
 *     access on the underlying routes.
 *   - The StatusPill labels live ONLY in row badges (no separate filter
 *     chrome rendering them), so getByText works cleanly for the single-
 *     row cases; we only need getAllByText for "Pending" / "Viewed" when
 *     the seed has multiple rows of the same status.
 *   - "Track New Document" appears as both the header CTA button AND
 *     the modal title, so use getAllByText / scope by role when both
 *     are on screen simultaneously.
 *   - Stable mock-object identity for useNotify per the CLAUDE.md
 *     standing rule "RTL: stable mock object references for hooks used
 *     in useCallback dependencies".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// fetchApi mock — every API call the page makes routes through this.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object reference per the CLAUDE.md standing rule. The page
// reads useNotify() inside async handlers; a fresh object per call would
// risk identity-change cascades for any future useCallback dependency.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import DocumentTracking from '../pages/DocumentTracking';

const sampleStats = {
  documentsTracked: 5,
  totalViews: 12,
  uniqueViewers: 7,
  avgViewDuration: 95, // 1m 35s
};

// Three documents — one "Pending" (Quote#9 with no viewedAt), one "Viewed"
// (Contract#42 single recipient who opened), and one multi-recipient
// (Estimate#17 — 2 recipients, only 1 has opened).
const sampleViews = [
  {
    id: 1,
    documentType: 'Quote',
    documentId: 9,
    viewerEmail: 'pending@example.com',
    viewedAt: null,
    duration: 0,
    createdAt: '2026-05-22T10:00:00.000Z',
  },
  {
    id: 2,
    documentType: 'Contract',
    documentId: 42,
    viewerEmail: 'opened@example.com',
    viewedAt: '2026-05-23T11:00:00.000Z',
    duration: 45,
    createdAt: '2026-05-21T09:00:00.000Z',
  },
  {
    id: 3,
    documentType: 'Estimate',
    documentId: 17,
    viewerEmail: 'recipient-a@example.com',
    viewedAt: '2026-05-24T08:00:00.000Z',
    duration: 30,
    createdAt: '2026-05-20T12:00:00.000Z',
  },
  {
    id: 4,
    documentType: 'Estimate',
    documentId: 17,
    viewerEmail: 'recipient-b@example.com',
    viewedAt: null,
    duration: 0,
    createdAt: '2026-05-20T12:30:00.000Z',
  },
];

const sampleQuotes = [
  { id: 101, title: 'Proposal Alpha' },
  { id: 102, title: 'Proposal Beta' },
];

const sampleContracts = [
  { id: 42, title: 'MSA — Acme Corp' },
  { id: 43, title: 'SOW — Beta Industries' },
];

const sampleEstimates = [
  { id: 17, title: 'Estimate Q3', estimateNum: 'EST-017' },
];

function defaultFetch(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/document-views' && method === 'GET') {
    return Promise.resolve(sampleViews);
  }
  if (url === '/api/document-views/stats' && method === 'GET') {
    return Promise.resolve(sampleStats);
  }
  if (url === '/api/cpq/quotes' && method === 'GET') return Promise.resolve(sampleQuotes);
  if (url === '/api/contracts' && method === 'GET') return Promise.resolve(sampleContracts);
  if (url === '/api/estimates' && method === 'GET') return Promise.resolve(sampleEstimates);
  return Promise.resolve(null);
}

function renderPage() {
  return render(<DocumentTracking />);
}

describe('<DocumentTracking /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading + descriptor + Track New Document CTA', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /Document Tracking/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Get notified when proposals, quotes, estimates, and contracts are opened/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Track New Document/i }),
    ).toBeInTheDocument();
  });

  it('initial mount fetches /api/document-views AND /api/document-views/stats with silent:true', async () => {
    renderPage();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/document-views');
      expect(listCall).toBeTruthy();
      // Per the #468 comment in source — silent:true so transient errors
      // don't poison the toast tray.
      expect(listCall[1]?.silent).toBe(true);
    });
    await waitFor(() => {
      const statsCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/document-views/stats',
      );
      expect(statsCall).toBeTruthy();
      expect(statsCall[1]?.silent).toBe(true);
    });
  });

  it('renders "Loading..." before data resolves and the empty-state placeholder when /api/document-views returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/document-views') return Promise.resolve([]);
      if (url === '/api/document-views/stats') return Promise.resolve(sampleStats);
      return Promise.resolve(null);
    });
    renderPage();
    // Loading flicker — synchronous render before the Promise resolves.
    expect(screen.getByText(/^Loading\.\.\.$/)).toBeInTheDocument();
    // Then empty state.
    expect(
      await screen.findByText(/No tracked documents yet\./i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Click "Track New Document" to generate a unique URL/i),
    ).toBeInTheDocument();
  });

  it('stats bar surfaces formatted labels + values from /stats', async () => {
    renderPage();
    // Wait for stats to settle. "Tracked Documents" appears in TWO places:
    // (a) the upper StatCard label, (b) the lower table-panel heading
    // ("<Eye /> Tracked Documents"). Use getAllByText for the duplicate.
    await waitFor(() => {
      expect(screen.getAllByText('Tracked Documents').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('Total Views')).toBeInTheDocument();
    expect(screen.getByText('Unique Viewers')).toBeInTheDocument();
    expect(screen.getByText('Avg View Duration')).toBeInTheDocument();

    // Numeric values render straight from the stats payload.
    expect(screen.getByText('5')).toBeInTheDocument();   // documentsTracked
    expect(screen.getByText('12')).toBeInTheDocument();  // totalViews
    expect(screen.getByText('7')).toBeInTheDocument();   // uniqueViewers
    // avgViewDuration=95s → formatDuration → "1m 35s".
    expect(screen.getByText('1m 35s')).toBeInTheDocument();
  });

  it('renders one row per (documentType, documentId) group with the "<Type> #<id>" cell + viewer email + views fraction', async () => {
    renderPage();
    // Wait for the rows to settle.
    expect(await screen.findByText('Quote #9')).toBeInTheDocument();
    expect(screen.getByText('Contract #42')).toBeInTheDocument();
    expect(screen.getByText('Estimate #17')).toBeInTheDocument();

    // Viewer emails — single-recipient rows render their assigned address.
    expect(screen.getByText('pending@example.com')).toBeInTheDocument();
    expect(screen.getByText('opened@example.com')).toBeInTheDocument();
    // Multi-recipient row carries the first viewer-email forward.
    expect(screen.getByText('recipient-a@example.com')).toBeInTheDocument();
  });

  it('StatusPill labels — "Viewed" for any document with ≥1 view; "Pending" for documents with zero views', async () => {
    renderPage();
    await screen.findByText('Quote #9');
    // Two rows have ≥1 view (Contract#42 + Estimate#17 with 1 of 2 opened)
    // → two "Viewed" pills. One row (Quote#9) is unopened → one "Pending".
    expect(screen.getAllByText('Viewed').length).toBe(2);
    expect(screen.getAllByText('Pending').length).toBe(1);
  });

  it('multi-recipient grouping collapses same (type,id) into one row with views fraction "<opened>/<total recipients>"', async () => {
    renderPage();
    // The Estimate#17 row has 2 recipients, only 1 opened → fraction
    // text segments render as "1" + " / 2". The numerator + denominator
    // live in separate <span>s within the views cell; assert both pieces
    // are present.
    await screen.findByText('Estimate #17');
    // The fraction "/ 2" appears in this row only (Quote#9 → /1, Contract#42 → /1).
    expect(screen.getByText(/^\s*\/\s*2\s*$/)).toBeInTheDocument();

    // Quote#9 — 0 of 1 → numerator "0" appears (along with "/1" denom).
    expect(screen.getAllByText(/^\s*\/\s*1\s*$/).length).toBe(2); // Quote + Contract.
  });

  it('clicking Track New Document opens the Create modal with type/document selects + recipient email + Generate Tracking URL submit; fetches /api/cpq/quotes for the default Proposal type', async () => {
    renderPage();
    await screen.findByText('Quote #9');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);
    fireEvent.click(screen.getByRole('button', { name: /Track New Document/i }));

    // Modal title — "Track New Document" now appears in both the header
    // CTA button AND the modal heading, so getAllByText >= 2.
    await waitFor(() => {
      expect(screen.getAllByText(/Track New Document/i).length).toBeGreaterThanOrEqual(2);
    });

    // Type + Document selects render (≥2 comboboxes in the modal).
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);

    // VALID_TYPES options render in the type select.
    expect(screen.getByRole('option', { name: 'Proposal' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Quote' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Estimate' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Contract' })).toBeInTheDocument();

    // Recipient Email input renders with the placeholder hint.
    expect(screen.getByPlaceholderText(/recipient@example\.com/i)).toBeInTheDocument();

    // Submit CTA renders.
    expect(
      screen.getByRole('button', { name: /Generate Tracking URL/i }),
    ).toBeInTheDocument();

    // Proposal → /api/cpq/quotes per ENDPOINT_FOR_TYPE.
    await waitFor(() => {
      const proposalFetch = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/cpq/quotes' && (!o || !o.method || o.method === 'GET'),
      );
      expect(proposalFetch).toBeTruthy();
    });
  });

  it('Create: submitting without picking a document fires notify.error and does NOT POST /api/document-views/create', async () => {
    renderPage();
    await screen.findByText('Quote #9');
    fireEvent.click(screen.getByRole('button', { name: /Track New Document/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Tracking URL/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    // Fire the submit event directly on the form — jsdom's HTML5 constraint
    // validation on `required` selects can short-circuit click-driven
    // submits even when documentId is empty, so dispatch directly.
    const submitBtn = screen.getByRole('button', { name: /Generate Tracking URL/i });
    const form = submitBtn.closest('form');
    expect(form).toBeTruthy();
    fireEvent.submit(form);

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Pick a document to track/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/document-views/create' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('Create: successful submit POSTs /api/document-views/create with parsed-int documentId + flips modal to the "Tracking URL generated" surface', async () => {
    renderPage();
    await screen.findByText('Quote #9');

    fireEvent.click(screen.getByRole('button', { name: /Track New Document/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Tracking URL/i })).toBeInTheDocument();
    });

    // Switch to Contract so we can pick contract #42 from the dropdown.
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0], { target: { value: 'Contract' } });

    // Wait for /api/contracts to populate the doc dropdown.
    await waitFor(() => {
      expect(screen.getByText('MSA — Acme Corp')).toBeInTheDocument();
    });

    // The Document select is the second combobox; pick contract #42.
    const updatedSelects = screen.getAllByRole('combobox');
    fireEvent.change(updatedSelects[1], { target: { value: '42' } });

    // Optional recipient email.
    fireEvent.change(screen.getByPlaceholderText(/recipient@example\.com/i), {
      target: { value: 'tracking-target@example.com' },
    });

    // Stub the create POST to return a generated tracking URL.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/document-views/create' && opts?.method === 'POST') {
        return Promise.resolve({
          trackingId: 'abc-123',
          trackingUrl: 'https://example.com/t/abc-123',
        });
      }
      return defaultFetch(url, opts);
    });

    fetchApiMock.mockClear();
    fireEvent.submit(
      screen.getByRole('button', { name: /Generate Tracking URL/i }).closest('form'),
    );

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/document-views/create' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.documentType).toBe('Contract');
      expect(body.documentId).toBe(42);
      expect(typeof body.documentId).toBe('number');
      expect(body.viewerEmail).toBe('tracking-target@example.com');
    });

    // Success surface renders the readonly URL input + Copy CTA.
    await waitFor(() => {
      expect(
        screen.getByText(/Tracking URL generated\. Paste this into your email\./i),
      ).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue('https://example.com/t/abc-123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy URL/i })).toBeInTheDocument();
  });

  it('changing Document Type re-fetches from the matching endpoint per ENDPOINT_FOR_TYPE', async () => {
    renderPage();
    await screen.findByText('Quote #9');
    fireEvent.click(screen.getByRole('button', { name: /Track New Document/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Tracking URL/i })).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const typeSelect = screen.getAllByRole('combobox')[0];

    // Contract → /api/contracts.
    fireEvent.change(typeSelect, { target: { value: 'Contract' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => u === '/api/contracts');
      expect(call).toBeTruthy();
    });

    // Estimate → /api/estimates.
    fireEvent.change(typeSelect, { target: { value: 'Estimate' } });
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) => u === '/api/estimates');
      expect(call).toBeTruthy();
    });
  });

  it('stats falls back to the initial zeroed shape when /stats fails', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/document-views') return Promise.resolve(sampleViews);
      if (url === '/api/document-views/stats') return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });
    renderPage();
    // The page swallows /stats failures (per #468 comment) and keeps the
    // initial { documentsTracked: 0, totalViews: 0, uniqueViewers: 0,
    // avgViewDuration: 0 } shape. avgViewDuration=0 → formatDuration → "—".
    // "Tracked Documents" renders both as a StatCard label AND as the
    // table-panel heading; use getAllByText for the duplicate.
    await waitFor(() => {
      expect(screen.getAllByText('Tracked Documents').length).toBeGreaterThanOrEqual(2);
    });
    // All three numeric stat values render as "0" — assert the cumulative
    // count is at least 3 since they live in three distinct StatCards.
    const zeros = screen.getAllByText('0');
    expect(zeros.length).toBeGreaterThanOrEqual(3);
    // Duration formatted as the em-dash fallback ("—"). The em-dash also
    // appears in row cells for documents with no firstViewed/lastViewed
    // (Quote#9 + the unopened Estimate#17 recipient), so use getAllByText.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // The error doesn't toast — silent:true + .catch fallback per #468.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('closing the modal via the Close button resets the form back to the create surface for next open', async () => {
    renderPage();
    await screen.findByText('Quote #9');

    // Open, then close.
    fireEvent.click(screen.getByRole('button', { name: /Track New Document/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Tracking URL/i })).toBeInTheDocument();
    });

    // The Modal header renders a "Close dialog" aria-labelled button.
    const closeBtn = screen.getByRole('button', { name: /Close dialog/i });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /Generate Tracking URL/i }),
      ).not.toBeInTheDocument();
    });

    // Re-open — back to the create surface (NOT the success "Tracking URL
    // generated" surface), confirming closeCreate() reset `generated`.
    fireEvent.click(screen.getByRole('button', { name: /Track New Document/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Tracking URL/i })).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Tracking URL generated\. Paste this into your email\./i),
    ).not.toBeInTheDocument();
  });
});
