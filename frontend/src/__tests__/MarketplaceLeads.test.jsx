/**
 * MarketplaceLeads.test.jsx — vitest + RTL coverage for the IndiaMART /
 * JustDial / TradeIndia marketplace lead-aggregator page
 * (frontend/src/pages/MarketplaceLeads.jsx, 726 LOC).
 *
 * Scope — pins the core page-surface contracts. The page is large; this
 * file aims for high-signal coverage on the load-bearing surfaces rather
 * than every detail:
 *
 *   1. Page chrome: heading "Marketplace Leads" + Sync All / Configure
 *      buttons render after the initial fetch settles.
 *   2. Initial mount fires the 4 expected GETs — /marketplace-leads (with
 *      page=1&limit=50 query, NO provider/status filter), /stats, /config,
 *      and /integrations/marketplace/status.
 *   3. Stats cards: when /stats returns data, the Total / This Week /
 *      Conversion Rate counters render with the right values + the
 *      per-provider tiles render once each.
 *   4. Provider tabs (All Sources / IndiaMART / JustDial / TradeIndia)
 *      render; clicking IndiaMART fires a refetch with ?provider=indiamart
 *      AND resets page to 1.
 *   5. Status filter <select> changing to "New" fires a refetch with
 *      ?status=New AND resets page to 1.
 *   6. Search box debouncing — well, the search filter is CLIENT-side
 *      (filteredLeads.filter()), so typing in the box narrows the visible
 *      rows in-place without issuing a new fetch. Pinned by typing a query
 *      that matches one row only.
 *   7. Lead rows render with provider badge label, name, email, phone,
 *      company, product, city, status.
 *   8. New-row Actions: clicking the green Import button on a New row
 *      fires POST /api/marketplace-leads/import/:id, then refetches list +
 *      stats.
 *   9. Imported-row "View Contact" link renders for rows with status =
 *      Imported AND contactId set, pointing at /contacts/:contactId.
 *  10. Sync All fires POST /api/marketplace-leads/sync/:provider for each
 *      currently-active config (configs with isActive=true only).
 *  11. Per-chip Sync now button (connected/active provider) fires POST
 *      /api/marketplace-leads/sync/:provider for that single provider.
 *  12. Inconsistent-state banner (#581) renders when a provider chip is
 *      never_configured BUT stats.byProvider has a non-zero count for it.
 *  13. Configure button switches to the config view (renders "Marketplace
 *      Configuration" header + Back-to-Leads button). Click Back returns.
 *  14. 3-state empty-mode rendering: when there are 0 leads + ALL chips
 *      are never_configured, the page renders the "No marketplace
 *      integrations configured" title.
 *  15. Loading state: "Loading marketplace leads..." renders before the
 *      initial fetch resolves.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 *   - fetchApi mocked at ../utils/api (the page's only dependency
 *     surface). Stable notifyObj reference not needed — the page does
 *     not call useNotify().
 *   - date / percent utility imports use the REAL modules so any
 *     contract drift surfaces here. (formatDateTime + formatPercent are
 *     pure functions.)
 *   - All data-dependent assertions use findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import MarketplaceLeads from '../pages/MarketplaceLeads';

// ---------------------------------------------------------------------------
// Fixtures — realistic Indian marketplace lead shapes (not E2E_* placeholders).
// ---------------------------------------------------------------------------
const sampleLeads = [
  {
    id: 101,
    provider: 'indiamart',
    name: 'Rajesh Kumar',
    email: 'rajesh.kumar@nimbus-textiles.co.in',
    phone: '+919811223344',
    company: 'Nimbus Textiles',
    product: 'Cotton fabric (200 m)',
    city: 'Surat',
    status: 'New',
    createdAt: '2026-05-20T09:30:00.000Z',
  },
  {
    id: 102,
    provider: 'justdial',
    name: 'Priya Mehta',
    email: 'priya@kitchencraft.in',
    phone: '+919900123456',
    company: 'KitchenCraft Solutions',
    product: 'Modular kitchen quote',
    city: 'Mumbai',
    status: 'Imported',
    contactId: 5001,
    createdAt: '2026-05-19T11:15:00.000Z',
  },
  {
    id: 103,
    provider: 'tradeindia',
    name: 'Anil Verma',
    email: 'anil@versteel.in',
    phone: '+919812765432',
    company: 'VerSteel Industries',
    product: 'Stainless steel pipes (5000 kg)',
    city: 'Pune',
    status: 'Duplicate',
    createdAt: '2026-05-18T14:00:00.000Z',
  },
];

const sampleStats = {
  total: 142,
  thisWeek: 18,
  conversionRate: 23.5,
  byProvider: [
    { provider: 'indiamart', count: 87 },
    { provider: 'justdial', count: 41 },
    { provider: 'tradeindia', count: 14 },
  ],
};

const sampleConfigs = [
  { provider: 'indiamart', isActive: true, apiKey: 'im_key', apiSecret: 'im_secret', glueCrmKey: 'glusr_key', lastSyncAt: '2026-05-22T06:00:00.000Z' },
  { provider: 'justdial', isActive: true, apiKey: 'jd_key', apiSecret: 'jd_secret', lastSyncAt: '2026-05-21T06:00:00.000Z' },
  { provider: 'tradeindia', isActive: false, apiKey: '', apiSecret: '' },
];

const sampleStatus = [
  { provider: 'indiamart', label: 'IndiaMART', configured: true, isActive: true, lastSyncAt: '2026-05-22T06:00:00.000Z', leadsLast30d: 87, healthHint: 'connected' },
  { provider: 'justdial', label: 'JustDial', configured: true, isActive: true, lastSyncAt: '2026-05-21T06:00:00.000Z', leadsLast30d: 41, healthHint: 'connected' },
  { provider: 'tradeindia', label: 'TradeIndia', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 14, healthHint: 'never_configured' },
];

function defaultFetchMock(url, opts) {
  // GET list (page=, limit=, plus optional ?provider=&status=)
  if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({ leads: sampleLeads, pages: 3 });
  }
  if (url === '/api/marketplace-leads/stats') return Promise.resolve(sampleStats);
  if (url === '/api/marketplace-leads/config') return Promise.resolve(sampleConfigs);
  if (url === '/api/integrations/marketplace/status') return Promise.resolve(sampleStatus);
  // POST sync / import / etc — resolve empty so handlers proceed to refetch.
  return Promise.resolve({});
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MarketplaceLeads />
    </MemoryRouter>
  );
}

describe('<MarketplaceLeads /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('renders the heading + Sync All + Configure buttons after initial fetch', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Marketplace Leads/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync All/i })).toBeInTheDocument();
    // The header Configure button + the never_configured chip's Configure
    // button both render — getAllByRole returns ≥1.
    expect(screen.getAllByRole('button', { name: /Configure/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('initial mount fires GETs for /marketplace-leads, /stats, /config, /integrations/marketplace/status', async () => {
    renderPage();
    await waitFor(() => {
      // List call carries page=1 & limit=50, no provider/status filters.
      const listCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/marketplace-leads?')
        && u.includes('page=1')
        && u.includes('limit=50')
        && !u.includes('provider=')
        && !u.includes('status=')
      );
      expect(listCall).toBeTruthy();
      expect(fetchApiMock.mock.calls.find(([u]) => u === '/api/marketplace-leads/stats')).toBeTruthy();
      expect(fetchApiMock.mock.calls.find(([u]) => u === '/api/marketplace-leads/config')).toBeTruthy();
      expect(
        fetchApiMock.mock.calls.find(([u]) => u === '/api/integrations/marketplace/status')
      ).toBeTruthy();
    });
    // The status call uses { silent: true } per the page's defensive read.
    const statusCall = fetchApiMock.mock.calls.find(
      ([u]) => u === '/api/integrations/marketplace/status'
    );
    expect(statusCall[1]).toEqual(expect.objectContaining({ silent: true }));
  });

  it('renders stats cards with Total / This Week / Conversion Rate + a per-provider tile', async () => {
    renderPage();
    expect(await screen.findByText('142')).toBeInTheDocument();      // total
    expect(screen.getByText('18')).toBeInTheDocument();               // thisWeek
    expect(screen.getByText('23.5%')).toBeInTheDocument();            // conversionRate via formatPercent
    // per-provider counts — pinned via numeric text.
    expect(screen.getByText('87')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
    // "14" appears in stats AND leadsLast30d on the TradeIndia chip — both
    // are legitimate, so use getAllByText with a min count.
    expect(screen.getAllByText('14').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking the IndiaMART provider tab fires a refetch with ?provider=indiamart and resets page to 1', async () => {
    renderPage();
    // Wait for initial list fetch to settle before clearing mock history.
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The tab buttons live in the filter bar. Use exact "IndiaMART" tab
    // (the tab label is exactly "IndiaMART"; the chip label inside the
    // status row is also "IndiaMART" but lives inside a span, not button).
    const tabs = screen.getAllByRole('button', { name: /IndiaMART/i });
    // First match is the filter-bar tab.
    fireEvent.click(tabs[0]);

    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/marketplace-leads?')
        && u.includes('provider=indiamart')
        && u.includes('page=1')
      );
      expect(filtered).toBeTruthy();
    });
  });

  it('changing the status <select> to "New" fires a refetch with ?status=New', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The status filter is the only top-level <select>.
    const statusSelect = screen.getByRole('combobox');
    fireEvent.change(statusSelect, { target: { value: 'New' } });

    await waitFor(() => {
      const filtered = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/marketplace-leads?')
        && u.includes('status=New')
        && u.includes('page=1')
      );
      expect(filtered).toBeTruthy();
    });
  });

  it('client-side search narrows the visible rows in place (no new fetch)', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    expect(screen.getByText('Priya Mehta')).toBeInTheDocument();
    fetchApiMock.mockClear();

    const searchBox = screen.getByPlaceholderText(/Search leads by name, email, phone, company/i);
    fireEvent.change(searchBox, { target: { value: 'nimbus' } });

    // Rajesh's company is "Nimbus Textiles" → row visible.
    expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument();
    // Priya's row no longer matches → hidden.
    expect(screen.queryByText('Priya Mehta')).not.toBeInTheDocument();
    // No new fetch — search is purely client-side.
    const listCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.startsWith('/api/marketplace-leads?')
    );
    expect(listCall).toBeUndefined();
  });

  it('renders lead rows with name, contact (email + phone), company, product, city, status', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    // Names
    expect(screen.getByText('Priya Mehta')).toBeInTheDocument();
    expect(screen.getByText('Anil Verma')).toBeInTheDocument();
    // Email + phone cells
    expect(screen.getByText('rajesh.kumar@nimbus-textiles.co.in')).toBeInTheDocument();
    expect(screen.getByText('+919811223344')).toBeInTheDocument();
    // Company
    expect(screen.getByText('Nimbus Textiles')).toBeInTheDocument();
    // Product / inquiry
    expect(screen.getByText('Cotton fabric (200 m)')).toBeInTheDocument();
    // City
    expect(screen.getByText('Surat')).toBeInTheDocument();
    // Status badges — "New" + "Imported" + "Duplicate" each appear at least
    // once in the table cells (also appear as <option> labels in the filter
    // <select>, so use getAllByText).
    expect(screen.getAllByText('New').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Imported').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Duplicate').length).toBeGreaterThanOrEqual(1);
  });

  it('clicking the Import button on a New row fires POST /api/marketplace-leads/import/:id', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The Import button only renders for New-status rows. There's exactly
    // one such row in our fixtures (lead id=101).
    const importBtn = screen.getByRole('button', { name: /Import/i });
    fireEvent.click(importBtn);

    await waitFor(() => {
      const importCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/import/101' && o?.method === 'POST'
      );
      expect(importCall).toBeTruthy();
    });
  });

  it('Imported-status rows render a "View Contact" link pointing at /contacts/:contactId', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Priya Mehta')).toBeInTheDocument());
    const viewContactLink = screen.getByRole('link', { name: /View Contact/i });
    expect(viewContactLink).toBeInTheDocument();
    // Lead id=102 has contactId=5001.
    expect(viewContactLink.getAttribute('href')).toBe('/contacts/5001');
  });

  it('clicking "Sync All" fires POST /api/marketplace-leads/sync/:provider for each ACTIVE config', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Sync All/i }));

    // Two active configs in our fixtures: indiamart + justdial. TradeIndia
    // is inactive and should NOT be synced.
    await waitFor(() => {
      const imSync = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/sync/indiamart' && o?.method === 'POST'
      );
      const jdSync = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/sync/justdial' && o?.method === 'POST'
      );
      expect(imSync).toBeTruthy();
      expect(jdSync).toBeTruthy();
    });
    const tradeIndiaSync = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/marketplace-leads/sync/tradeindia' && o?.method === 'POST'
    );
    expect(tradeIndiaSync).toBeUndefined();
  });

  it('per-chip "Sync now" button fires POST /api/marketplace-leads/sync/<provider>', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The "Sync now" chip-buttons render for configured+active providers.
    // Two are visible (indiamart + justdial). Click the first one.
    const chipSyncBtns = screen.getAllByRole('button', { name: /Sync now/i });
    expect(chipSyncBtns.length).toBe(2);
    fireEvent.click(chipSyncBtns[0]);

    await waitFor(() => {
      const syncCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/sync/indiamart' && o?.method === 'POST'
      );
      expect(syncCall).toBeTruthy();
    });
  });

  it('renders the #581 "Inconsistent state" banner when a never_configured chip has non-zero stats count', async () => {
    // TradeIndia is never_configured in our default fixtures AND has
    // count=14 in stats.byProvider — exactly the inconsistent shape the
    // banner is designed to flag.
    renderPage();
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/Inconsistent state/i);
    expect(banner.textContent).toMatch(/14 leads exist from sources marked NOT CONFIGURED/i);
    expect(banner.textContent).toMatch(/TradeIndia/);
  });

  it('clicking Configure switches to the config view; Back returns to the leads view', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());

    // Both the header Configure button + the never_configured TradeIndia
    // chip's Configure button match /^Configure$/. The header one is
    // ALWAYS first in DOM order (renders inside <header> at the top of the
    // leads view, before the status chip row).
    const configureBtns = screen.getAllByRole('button', { name: /^Configure$/ });
    fireEvent.click(configureBtns[0]);

    // Config view renders the "Marketplace Configuration" heading.
    expect(
      await screen.findByRole('heading', { name: /Marketplace Configuration/i })
    ).toBeInTheDocument();
    // Back-to-Leads button is present.
    const backBtn = screen.getByRole('button', { name: /Back to Leads/i });
    expect(backBtn).toBeInTheDocument();

    fireEvent.click(backBtn);

    // Back on the leads view.
    expect(
      await screen.findByRole('heading', { name: /Marketplace Leads/i })
    ).toBeInTheDocument();
  });

  it('renders the "No marketplace integrations configured" empty state when 0 leads + all chips never_configured', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ leads: [], pages: 1 });
      }
      if (url === '/api/marketplace-leads/stats') return Promise.resolve({
        total: 0, thisWeek: 0, conversionRate: 0, byProvider: [],
      });
      if (url === '/api/marketplace-leads/config') return Promise.resolve([]);
      if (url === '/api/integrations/marketplace/status') return Promise.resolve([
        { provider: 'indiamart', label: 'IndiaMART', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
        { provider: 'justdial', label: 'JustDial', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
        { provider: 'tradeindia', label: 'TradeIndia', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
      ]);
      return Promise.resolve({});
    });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /No marketplace integrations configured/i })
    ).toBeInTheDocument();
    // CTA buttons inside the empty card.
    expect(screen.getByRole('button', { name: /Configure Marketplaces/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse all integrations/i })).toBeInTheDocument();
  });

  it('shows "Loading marketplace leads..." before the initial list fetch resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
        return new Promise((r) => { resolveList = r; });
      }
      if (url === '/api/marketplace-leads/stats') return Promise.resolve(null);
      if (url === '/api/marketplace-leads/config') return Promise.resolve([]);
      if (url === '/api/integrations/marketplace/status') return Promise.resolve([]);
      return Promise.resolve({});
    });
    renderPage();
    expect(await screen.findByText(/Loading marketplace leads/i)).toBeInTheDocument();
    // Resolve so cleanup is quiet.
    resolveList({ leads: [], pages: 1 });
  });
});
