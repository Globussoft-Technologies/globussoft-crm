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

  // ─────────────────────────────────────────────────────────────────────
  // Extension cases — added to lift coverage on previously-untested
  // branches: dismiss flow, bulk-import flow, pagination, config-view
  // save (per-provider PUT + IndiaMART-specific glueCrmKey field),
  // webhook URLs panel, 3-state empty (stale + all-quiet variants),
  // singular #581 banner wording, and the consistent-state "no banner"
  // negative branch.
  // ─────────────────────────────────────────────────────────────────────

  it('clicking the Dismiss (XCircle) button on a New row fires PUT /api/marketplace-leads/dismiss/:id', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The Dismiss button is the XCircle icon button (no text label); it's
    // identified by its title="Dismiss" attribute.
    const dismissBtn = screen.getByTitle('Dismiss');
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      const dismissCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/dismiss/101' && o?.method === 'PUT'
      );
      expect(dismissCall).toBeTruthy();
    });
    // After dismiss, page refetches list + stats.
    await waitFor(() => {
      const listRefetch = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.startsWith('/api/marketplace-leads?')
      );
      expect(listRefetch).toBeTruthy();
    });
  });

  it('selecting a New row + clicking "Import to CRM" fires POST /api/marketplace-leads/import-bulk with leadIds', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());

    // The row-level checkboxes only render for New-status rows. There is
    // exactly one such checkbox row (lead id=101) PLUS the header
    // toggleSelectAll checkbox. They share the same input role; locate by
    // counting and clicking the second one (first is the header).
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    // Click the row checkbox to select lead 101.
    fireEvent.click(checkboxes[1]);

    // The bulk-action bar now renders with "1 lead selected" + Import to
    // CRM button.
    expect(await screen.findByText(/1 lead selected/i)).toBeInTheDocument();
    fetchApiMock.mockClear();

    const bulkImportBtn = screen.getByRole('button', { name: /Import to CRM/i });
    fireEvent.click(bulkImportBtn);

    await waitFor(() => {
      const bulkCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/import-bulk' && o?.method === 'POST'
      );
      expect(bulkCall).toBeTruthy();
      // Body is a JSON string; verify leadIds contains 101.
      const body = JSON.parse(bulkCall[1].body);
      expect(body.leadIds).toEqual([101]);
    });
  });

  it('renders pagination controls when pages > 1, and clicking Next fires a refetch with page=2', async () => {
    renderPage();
    // Default fixtures resolve pages=3.
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    expect(screen.getByText(/Page 1 of 3/i)).toBeInTheDocument();

    // Previous is disabled on page 1.
    const prevBtn = screen.getByRole('button', { name: /Previous/i });
    expect(prevBtn).toBeDisabled();
    // Next is enabled.
    const nextBtn = screen.getByRole('button', { name: /Next/i });
    expect(nextBtn).not.toBeDisabled();

    fetchApiMock.mockClear();
    fireEvent.click(nextBtn);

    await waitFor(() => {
      const pagedCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/marketplace-leads?')
        && u.includes('page=2')
      );
      expect(pagedCall).toBeTruthy();
    });
  });

  it('config view: typing into the IndiaMART CRM Key + clicking Save Configuration fires PUT /api/marketplace-leads/config/indiamart', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());

    // Switch to config view via the header Configure button (first in DOM).
    const configureBtns = screen.getAllByRole('button', { name: /^Configure$/ });
    fireEvent.click(configureBtns[0]);

    // Wait for the Configuration heading.
    await screen.findByRole('heading', { name: /Marketplace Configuration/i });

    // The IndiaMART CRM Key field is provider-specific. Find the input by
    // placeholder.
    const crmKeyInput = screen.getByPlaceholderText(/Enter IndiaMART CRM Key/i);
    expect(crmKeyInput).toBeInTheDocument();
    fireEvent.change(crmKeyInput, { target: { value: 'glusr_demo_key_2026' } });

    fetchApiMock.mockClear();

    // Three Save Configuration buttons (one per provider). The first is the
    // IndiaMART one (renders first in the .map order).
    const saveBtns = screen.getAllByRole('button', { name: /Save Configuration/i });
    expect(saveBtns.length).toBe(3);
    fireEvent.click(saveBtns[0]);

    await waitFor(() => {
      const saveCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/marketplace-leads/config/indiamart' && o?.method === 'PUT'
      );
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(saveCall[1].body);
      expect(body.provider).toBe('indiamart');
      expect(body.glueCrmKey).toBe('glusr_demo_key_2026');
    });
    // After save, fetchConfigs refetches.
    await waitFor(() => {
      const refetch = fetchApiMock.mock.calls.find(([u]) => u === '/api/marketplace-leads/config');
      expect(refetch).toBeTruthy();
    });
  });

  it('config view: webhook URLs panel renders one row per provider with /webhook/<provider> code blocks', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());

    // Switch to config view.
    const configureBtns = screen.getAllByRole('button', { name: /^Configure$/ });
    fireEvent.click(configureBtns[0]);

    await screen.findByRole('heading', { name: /Marketplace Configuration/i });
    expect(screen.getByRole('heading', { name: /Webhook URLs/i })).toBeInTheDocument();

    // The webhook URLs are rendered inside <code> elements ending with
    // /api/marketplace-leads/webhook/<provider>. There are 3 — one per
    // provider.
    const codeBlocks = document.querySelectorAll('code');
    const webhookCodes = Array.from(codeBlocks).filter(c =>
      /\/api\/marketplace-leads\/webhook\//.test(c.textContent || '')
    );
    expect(webhookCodes.length).toBe(3);
    expect(webhookCodes.some(c => c.textContent.endsWith('/indiamart'))).toBe(true);
    expect(webhookCodes.some(c => c.textContent.endsWith('/justdial'))).toBe(true);
    expect(webhookCodes.some(c => c.textContent.endsWith('/tradeindia'))).toBe(true);
  });

  it('empty state: renders the "stale" variant when 0 leads + any chip has healthHint=stale', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ leads: [], pages: 1 });
      }
      if (url === '/api/marketplace-leads/stats') return Promise.resolve({
        total: 0, thisWeek: 0, conversionRate: 0, byProvider: [],
      });
      if (url === '/api/marketplace-leads/config') return Promise.resolve([]);
      if (url === '/api/integrations/marketplace/status') return Promise.resolve([
        { provider: 'indiamart', label: 'IndiaMART', configured: true, isActive: true, lastSyncAt: '2026-04-01T06:00:00.000Z', leadsLast30d: 0, healthHint: 'stale' },
        { provider: 'justdial', label: 'JustDial', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
        { provider: 'tradeindia', label: 'TradeIndia', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
      ]);
      return Promise.resolve({});
    });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /No leads — and one or more integrations may be stale/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/A configured integration has not synced in over 24 hours/i)
    ).toBeInTheDocument();
  });

  it('empty state: renders the "all quiet" variant when 0 leads + at least one chip is connected/idle (no stale)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ leads: [], pages: 1 });
      }
      if (url === '/api/marketplace-leads/stats') return Promise.resolve({
        total: 0, thisWeek: 0, conversionRate: 0, byProvider: [],
      });
      if (url === '/api/marketplace-leads/config') return Promise.resolve([]);
      if (url === '/api/integrations/marketplace/status') return Promise.resolve([
        { provider: 'indiamart', label: 'IndiaMART', configured: true, isActive: true, lastSyncAt: '2026-05-25T06:00:00.000Z', leadsLast30d: 0, healthHint: 'idle' },
        { provider: 'justdial', label: 'JustDial', configured: true, isActive: true, lastSyncAt: '2026-05-25T06:00:00.000Z', leadsLast30d: 5, healthHint: 'connected' },
        { provider: 'tradeindia', label: 'TradeIndia', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
      ]);
      return Promise.resolve({});
    });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: /No leads in this view/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/All your active integrations are connected and recently synced/i)
    ).toBeInTheDocument();
  });

  it('does NOT render the #581 inconsistent-state banner when stats and status are consistent', async () => {
    // All-configured-and-consistent: every provider with a non-zero count
    // is also marked configured. No banner should render.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ leads: sampleLeads, pages: 1 });
      }
      if (url === '/api/marketplace-leads/stats') return Promise.resolve({
        total: 100, thisWeek: 5, conversionRate: 12,
        byProvider: [
          { provider: 'indiamart', count: 60 },
          { provider: 'justdial', count: 40 },
          // tradeindia has count=0 so even though it's never_configured,
          // the banner stays hidden (the orphan-count would be 0).
          { provider: 'tradeindia', count: 0 },
        ],
      });
      if (url === '/api/marketplace-leads/config') return Promise.resolve(sampleConfigs);
      if (url === '/api/integrations/marketplace/status') return Promise.resolve([
        { provider: 'indiamart', label: 'IndiaMART', configured: true, isActive: true, lastSyncAt: '2026-05-22T06:00:00.000Z', leadsLast30d: 60, healthHint: 'connected' },
        { provider: 'justdial', label: 'JustDial', configured: true, isActive: true, lastSyncAt: '2026-05-22T06:00:00.000Z', leadsLast30d: 40, healthHint: 'connected' },
        { provider: 'tradeindia', label: 'TradeIndia', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 0, healthHint: 'never_configured' },
      ]);
      return Promise.resolve({});
    });
    renderPage();
    // Wait for the page to settle.
    await waitFor(() => expect(screen.getByText('Rajesh Kumar')).toBeInTheDocument());
    // No alert banner.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the #581 banner with SINGULAR wording ("1 lead exists") when only one orphaned lead', async () => {
    // Inconsistent state with exactly 1 orphan lead → singular wording.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/marketplace-leads?') && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ leads: sampleLeads, pages: 1 });
      }
      if (url === '/api/marketplace-leads/stats') return Promise.resolve({
        total: 1, thisWeek: 0, conversionRate: 0,
        byProvider: [
          { provider: 'tradeindia', count: 1 },
        ],
      });
      if (url === '/api/marketplace-leads/config') return Promise.resolve([]);
      if (url === '/api/integrations/marketplace/status') return Promise.resolve([
        { provider: 'tradeindia', label: 'TradeIndia', configured: false, isActive: false, lastSyncAt: null, leadsLast30d: 1, healthHint: 'never_configured' },
      ]);
      return Promise.resolve({});
    });
    renderPage();
    const banner = await screen.findByRole('alert');
    // Singular form: "1 lead exist" — no plural 's' on "lead".
    expect(banner.textContent).toMatch(/1 lead exist from sources marked NOT CONFIGURED/);
    expect(banner.textContent).not.toMatch(/1 leads exist/);
  });
});
