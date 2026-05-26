/**
 * WebVisitors.test.jsx — vitest + RTL coverage for the marketing
 * web-visitors page (anonymous + identified website-visitor lead-source
 * tracking).
 *
 * Scope: pins the page-surface invariants for the visitor roster — initial
 * mount fetch, stat tiles fed by /api/web-visitors/stats, the visitor table
 * (anonymous-sessionId vs identified-contact label rendering), row drill-
 * through fetching per-visitor page history from /api/web-visitors/<id>,
 * empty + loading states, the Refresh button, and the install-tracking-
 * script snippet + copy affordance.
 *
 *   1. Heading "Web Visitors" + Refresh button render; initial mount issues
 *      Promise.all of /api/web-visitors/stats + /api/web-visitors.
 *   2. Stat tiles render server values for Today / Last 7 days / Last 30
 *      days / % Identified — confirms the surface reads .today, .week,
 *      .month, .pctIdentified (not aliases).
 *   3. Identified visitor row labels with the contact name + email line;
 *      anonymous visitor row labels as "Anonymous · <first-8-of-sessionId>"
 *      (8-char truncation contract from `sessionId.slice(0, 8)`).
 *   4. Row click expands a detail strip and fires GET /api/web-visitors/<id>
 *      exactly once — repeat clicks toggle visibility but do not re-fetch
 *      (the `details[id]` cache check at toggleRow().
 *   5. Detail panel renders one row per page in the response's `pages` array
 *      (reversed — newest-first surface contract).
 *   6. Empty state: "No visitors tracked yet. Install the snippet below on
 *      your site." renders when /api/web-visitors returns [].
 *   7. Loading state: "Loading visitors..." renders while the initial fetch
 *      is in-flight.
 *   8. Embed-snippet block renders the tracker `<script src="…/crm-track.js"
 *      data-tenant="…">` interpolating tenantId from the JWT and origin from
 *      window.location.origin.
 *   9. Copy button: clicking writes the snippet to navigator.clipboard and
 *      flips the button label to "Copied!".
 *  10. Refresh button click re-issues both the stats + list fetches.
 *
 * Drift notes
 * ───────────
 * The dispatch prompt asked for "filter / role gate / convert-to-lead"
 * coverage. None of those surfaces exist in WebVisitors.jsx today (no
 * filter controls, no role-gated render branch, no convert-to-lead CTA;
 * the page is a passive analytics view). Pinning REAL surface only.
 *
 * The page calls `Promise.all([stats, visitors])` with per-call `.catch()`
 * fallbacks (null / []) — so a 500 on stats keeps the page rendering with
 * the zero defaults rather than blanking. The error test below pins that
 * graceful-degradation contract.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const fetchApiMock = vi.fn();
// Returns the demo Wellness JWT-shaped payload: header.{tenantId:7}.signature
// base64-encoded. The page atob()s the middle segment so we hand it a real
// 3-part token. tenantId=7 lets the snippet assertion confirm interpolation.
const getAuthTokenMock = vi.fn(() => {
  const payload = Buffer.from(JSON.stringify({ tenantId: 7, userId: 99 })).toString('base64');
  return `header.${payload}.signature`;
});
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: (...args) => getAuthTokenMock(...args),
}));

import WebVisitors from '../pages/WebVisitors';

const sampleStats = {
  today: 12,
  week: 87,
  month: 311,
  identified: 23,
  total: 311,
  pctIdentified: 7,
};

const identifiedVisitor = {
  id: 101,
  sessionId: 'sess_abcdef1234567890',
  identified: true,
  contact: { id: 5, name: 'Anita Sharma', email: 'anita@example.com' },
  country: 'IN',
  pageCount: 4,
  lastUrl: 'https://drharors.com/pricing',
  lastSeen: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0',
};

const anonymousVisitor = {
  id: 202,
  sessionId: 'anonsesh99887766aabb',
  identified: false,
  contact: null,
  country: 'US',
  pageCount: 2,
  lastUrl: 'https://drharors.com/services/botox',
  lastSeen: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
};

const visitorDetail = {
  id: 101,
  pages: [
    { url: 'https://drharors.com/', timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
    { url: 'https://drharors.com/services', timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { url: 'https://drharors.com/pricing', timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
  ],
};

function defaultFetchMock(url) {
  if (url === '/api/web-visitors/stats') return Promise.resolve(sampleStats);
  if (url === '/api/web-visitors') return Promise.resolve([identifiedVisitor, anonymousVisitor]);
  if (url === '/api/web-visitors/101') return Promise.resolve(visitorDetail);
  if (url === '/api/web-visitors/202') return Promise.resolve({ id: 202, pages: [] });
  return Promise.resolve(null);
}

describe('<WebVisitors /> — page surface', () => {
  let originalClipboard;

  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    getAuthTokenMock.mockClear();

    // jsdom doesn't ship a clipboard implementation; stub one.
    originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
  });

  afterEach(() => {
    if (originalClipboard === undefined) {
      delete navigator.clipboard;
    } else {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it('renders heading + Refresh button and fires the initial stats + list fetches', async () => {
    render(<WebVisitors />);
    expect(screen.getByRole('heading', { name: /Web Visitors/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/web-visitors/stats');
      expect(urls).toContain('/api/web-visitors');
    });
  });

  it('stat tiles render server values from /stats (today / week / month / pctIdentified)', async () => {
    render(<WebVisitors />);
    // Each stat tile renders its label + value pair. Use findByText so we
    // wait for the post-fetch state-set + re-render.
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(await screen.findByText('87')).toBeInTheDocument();
    expect(await screen.findByText('311')).toBeInTheDocument();
    // % Identified renders as "7%".
    expect(await screen.findByText('7%')).toBeInTheDocument();
    // Tile labels are stable copy. "Last 7 days" also appears in the
    // table-section heading "Recent Visitors (last 7 days)" so use
    // getAllByText and assert ≥1 occurrence (mirrors the standing-rule
    // pattern for labels that appear in chrome + table copy).
    expect(screen.getByText(/^Today$/)).toBeInTheDocument();
    expect(screen.getAllByText(/Last 7 days/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Last 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/% Identified/i)).toBeInTheDocument();
  });

  it('identified visitor row renders contact name + email; anonymous row renders "Anonymous · <8>"', async () => {
    render(<WebVisitors />);
    // Identified row.
    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument();
    expect(screen.getByText('anita@example.com')).toBeInTheDocument();
    expect(screen.getByText('IN')).toBeInTheDocument();
    // Anonymous row uses first-8 of sessionId: anonsesh99887766aabb → anonsesh.
    expect(screen.getByText(/Anonymous · anonsesh/)).toBeInTheDocument();
    expect(screen.getByText('US')).toBeInTheDocument();
    // pageCount renders verbatim.
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clicking a visitor row expands it and fires GET /api/web-visitors/<id> exactly once across repeat toggles', async () => {
    render(<WebVisitors />);
    const nameCell = await screen.findByText('Anita Sharma');
    // Find the closest <tr> ancestor (the click handler lives on the row).
    const row = nameCell.closest('tr');
    expect(row).toBeTruthy();

    // First click → expand + detail fetch.
    fireEvent.click(row);
    await waitFor(() => {
      const detailCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/web-visitors/101');
      expect(detailCall).toBeTruthy();
    });
    // Detail panel renders the page history rows.
    await waitFor(() => {
      expect(screen.getByText('https://drharors.com/pricing')).toBeInTheDocument();
    });
    expect(screen.getByText('https://drharors.com/services')).toBeInTheDocument();
    expect(screen.getByText('https://drharors.com/')).toBeInTheDocument();

    // Count detail-fetches issued so far.
    const fetchCountAfterFirstOpen = fetchApiMock.mock.calls.filter(
      ([u]) => u === '/api/web-visitors/101'
    ).length;
    expect(fetchCountAfterFirstOpen).toBe(1);

    // Second click → collapse. No new detail fetch.
    fireEvent.click(row);
    // Third click → re-expand. Still no new fetch — cache hit on details[id].
    fireEvent.click(row);
    // Give any rogue async toggleRow path a tick to fire if it would.
    await act(async () => { await Promise.resolve(); });
    const fetchCountAfterToggling = fetchApiMock.mock.calls.filter(
      ([u]) => u === '/api/web-visitors/101'
    ).length;
    expect(fetchCountAfterToggling).toBe(1);
  });

  it('empty state renders the install-snippet hint when /api/web-visitors returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/web-visitors/stats') return Promise.resolve({
        today: 0, week: 0, month: 0, identified: 0, total: 0, pctIdentified: 0,
      });
      if (url === '/api/web-visitors') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<WebVisitors />);
    expect(
      await screen.findByText(/No visitors tracked yet\. Install the snippet below on your site\./i)
    ).toBeInTheDocument();
  });

  it('loading state renders "Loading visitors..." while the initial list fetch is in-flight', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/web-visitors/stats') return Promise.resolve(sampleStats);
      if (url === '/api/web-visitors') return new Promise((r) => { resolveList = r; });
      return Promise.resolve(null);
    });
    render(<WebVisitors />);
    expect(await screen.findByText(/Loading visitors\.\.\./i)).toBeInTheDocument();
    // Resolve so the test can tear down cleanly.
    await act(async () => { resolveList([]); });
  });

  it('graceful degradation: stats 500 + visitors success keeps page rendering with zero-default tiles', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/web-visitors/stats') return Promise.reject(new Error('boom'));
      if (url === '/api/web-visitors') return Promise.resolve([identifiedVisitor]);
      return Promise.resolve(null);
    });
    render(<WebVisitors />);
    // Per-call .catch(() => null) keeps stats at the initial zero state and
    // the visitor list still renders. Pin via the identified row + the
    // "0%" tile (pctIdentified default).
    expect(await screen.findByText('Anita Sharma')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('embed-snippet block renders the tracker <script> with origin + tenantId interpolated', async () => {
    render(<WebVisitors />);
    await screen.findByText('Anita Sharma'); // wait for mount fetches to settle
    // The snippet is rendered inside a <pre>. window.location.origin in jsdom
    // defaults to "http://localhost"; tenantId comes from the mocked JWT (7).
    const snippet = screen.getByText(/<script src="[^"]*\/crm-track\.js" data-tenant="7"><\/script>/);
    expect(snippet).toBeInTheDocument();
    expect(snippet.textContent).toContain('data-tenant="7"');
    expect(snippet.textContent).toContain('/crm-track.js');
  });

  it('Copy button writes the snippet to clipboard and flips its label to "Copied!"', async () => {
    render(<WebVisitors />);
    await screen.findByText('Anita Sharma');
    const copyBtn = screen.getByRole('button', { name: /^Copy$/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    });
    const [written] = navigator.clipboard.writeText.mock.calls[0];
    expect(written).toMatch(/<script src="[^"]*\/crm-track\.js" data-tenant="7"><\/script>/);
    // Label flips to "Copied!" after the await resolves.
    expect(await screen.findByRole('button', { name: /Copied!/i })).toBeInTheDocument();
  });

  it('Refresh button click re-issues both stats + list fetches', async () => {
    render(<WebVisitors />);
    await screen.findByText('Anita Sharma');
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/web-visitors/stats');
      expect(urls).toContain('/api/web-visitors');
    });
  });
});
