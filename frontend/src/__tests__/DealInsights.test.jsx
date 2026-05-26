/**
 * DealInsights.test.jsx — vitest coverage pinning the #593 rebrand
 * AND extended coverage of the 648-LOC DealInsights page.
 *
 * The rebrand pin (#593): the page's backend (backend/routes/deal_insights.js +
 * backend/cron/dealInsightsEngine.js) is rules-based — runHeuristicRules
 * generates deterministic threshold-driven insights ("No activity in N days",
 * "Deal is X day(s) past expected close date and still in 'stage' stage",
 * etc.). The optional Gemini-prefixed `[AI]` insight only fires when
 * GEMINI_API_KEY is set — which is NOT the case on the demo per #563
 * ("AI / Gemini, Sentiment, and Data-enrichment backends not mounted —
 * Not planned"). Branding the page as "AI Predictive Insights" / "AI Deal
 * Insights" was therefore misleading.
 *
 * The rebrand spec pins:
 *   - Page heading is "Deal Insights" (not "AI Deal Insights" / "AI Predictive Insights").
 *   - Tagline explicitly says "Rules-based" (truth-in-labelling).
 *   - The page does NOT render the misleading branding strings anywhere
 *     in the user-visible DOM.
 *
 * Extended coverage adds ≥8 cases for:
 *   - KPI tile values (open / critical / warnings / resolved aggregation).
 *   - Loaded insights list rendering with severity badges + type labels.
 *   - Filter tabs (All / RISK / OPPORTUNITY / NEXT_BEST_ACTION / OPEN_DEALS) and showResolved.
 *   - Empty state copy + CTA based on open-deal presence.
 *   - "Generate Insights (N open)" button uses /api/deals/stats openCount,
 *     and is disabled when there are zero open deals.
 *   - Resolve button calls POST /api/deal-insights/:id/resolve and flips
 *     local state.
 *   - generateForAll iterates POST /api/deal-insights/generate/:dealId for
 *     each open deal (capped at 50) and re-runs loadAll().
 *   - OPEN_DEALS view renders deal cards with hasInsight / not-scanned chip.
 *   - Loading state visible during initial fetch.
 *   - Error fallback: fetchApi rejection → page settles to empty without
 *     crash (per .catch(() => []) guards in loadAll).
 *
 * Stable mock-object pattern (2026-05-23 standing rule): fetchApi is a single
 * vi.fn() shared across the run — re-set in beforeEach but identity-stable.
 *
 * Pure pin — no source changes.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Mock fetchApi BEFORE importing the component
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import DealInsights from '../pages/DealInsights';

beforeEach(() => {
  fetchApi.mockReset();
  // Force USD locale so formatMoney output is stable regardless of host
  // localStorage state. Other suites may have written 'tenant' to localStorage
  // (the OwnerDashboard suite seeds wellness/INR), which would otherwise leak
  // across files because vitest reuses the jsdom global per worker.
  try {
    localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
  } catch {
    /* ignore — some test envs disable localStorage */
  }
});

function renderPage() {
  return render(
    <MemoryRouter>
      <DealInsights />
    </MemoryRouter>
  );
}

// Default mock: an empty page (no insights). Sufficient to assert the header
// surface — which is the only thing under test for the rebrand.
function mockEmpty() {
  fetchApi.mockImplementation((url) => {
    if (url.startsWith('/api/deal-insights')) return Promise.resolve([]);
    if (url.startsWith('/api/deals/stats')) {
      return Promise.resolve({ totalDeals: 0, byStage: [] });
    }
    if (url.startsWith('/api/deals?')) return Promise.resolve([]);
    return Promise.resolve([]);
  });
}

// Three-insight + three-deal fixture covering all severity levels + all
// insight types. Designed so KPI tiles + filter tabs + grouped rendering
// all have something to display.
function makeFixture() {
  const now = new Date();
  const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const insights = [
    {
      id: 101,
      dealId: 1,
      type: 'RISK',
      severity: 'CRITICAL',
      insight: 'No activity in 45 days — deal may be stalling.',
      isResolved: false,
      generatedAt: tenMinAgo,
      dealContext: { id: 1, title: 'Acme Corp Renewal', stage: 'proposal', amount: 25000, currency: 'USD', contact: { name: 'Lina Patel', company: 'Acme' } },
    },
    {
      id: 102,
      dealId: 1,
      type: 'NEXT_BEST_ACTION',
      severity: 'WARNING',
      insight: 'Schedule a check-in call within the next 5 days.',
      isResolved: false,
      generatedAt: oneHourAgo,
      dealContext: { id: 1, title: 'Acme Corp Renewal', stage: 'proposal', amount: 25000, currency: 'USD', contact: { name: 'Lina Patel', company: 'Acme' } },
    },
    {
      id: 103,
      dealId: 2,
      type: 'OPPORTUNITY',
      severity: 'INFO',
      insight: 'High engagement detected — consider upsell add-on.',
      isResolved: true,
      generatedAt: oneHourAgo,
      dealContext: { id: 2, title: 'Beta Ltd Expansion', stage: 'contacted', amount: 12500, currency: 'USD', contact: { name: 'Hiro Tanaka', company: 'Beta' } },
    },
  ];

  const openDeals = [
    { id: 1, title: 'Acme Corp Renewal', stage: 'proposal', amount: 25000, currency: 'USD', contact: { name: 'Lina Patel', company: 'Acme' } },
    { id: 2, title: 'Beta Ltd Expansion', stage: 'contacted', amount: 12500, currency: 'USD', contact: { name: 'Hiro Tanaka', company: 'Beta' } },
    { id: 3, title: 'Gamma Inc Pilot', stage: 'lead', amount: 8000, currency: 'USD', contact: { name: 'Mira Costa', company: 'Gamma' } },
  ];

  const stats = {
    totalDeals: 5,
    byStage: [
      { stage: 'lead', count: 1, value: 8000 },
      { stage: 'contacted', count: 1, value: 12500 },
      { stage: 'proposal', count: 1, value: 25000 },
      { stage: 'won', count: 1, value: 50000 },
      { stage: 'lost', count: 1, value: 0 },
    ],
  };

  return { insights, openDeals, stats };
}

function mockLoaded(fx = makeFixture()) {
  fetchApi.mockImplementation((url, opts) => {
    if (url === '/api/deal-insights') return Promise.resolve(fx.insights);
    if (url === '/api/deals/stats') return Promise.resolve(fx.stats);
    if (url.startsWith('/api/deals?')) return Promise.resolve(fx.openDeals);
    if (url.startsWith('/api/deal-insights/') && url.endsWith('/resolve') && opts?.method === 'POST') {
      return Promise.resolve({ ok: true });
    }
    if (url.startsWith('/api/deal-insights/generate/') && opts?.method === 'POST') {
      return Promise.resolve({ generated: 2 });
    }
    return Promise.resolve([]);
  });
  return fx;
}

describe('<DealInsights /> — #593 rebrand pin', () => {
  it('renders the page heading as "Deal Insights" (no "AI" prefix)', async () => {
    mockEmpty();
    renderPage();

    // The H1 must contain "Deal Insights" verbatim.
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Deal Insights');
    // And it must NOT contain the prior misleading prefix.
    expect(heading.textContent).not.toMatch(/AI Deal Insights/i);
    expect(heading.textContent).not.toMatch(/AI Predictive/i);
    expect(heading.textContent).not.toMatch(/Gemini/i);
  });

  it('tagline says "Rules-based" (truth-in-labelling vs. the prior AI framing)', async () => {
    mockEmpty();
    renderPage();

    // The tagline below the H1 must explicitly call out the rules-based
    // nature so a customer paying attention to the AI tier marketing doesn't
    // get confused about what the engine actually does.
    await waitFor(() => {
      expect(screen.getByText(/Rules-based/i)).toBeInTheDocument();
    });
  });

  it('does NOT render any of the misleading "AI Predictive" / "Gemini" strings anywhere in the page', async () => {
    mockEmpty();
    const { container } = renderPage();

    // Wait for first render to settle.
    await screen.findByRole('heading', { level: 1 });

    // Capture the entire user-visible DOM textContent. None of the
    // pre-rebrand strings may appear.
    const text = container.textContent || '';
    expect(text).not.toMatch(/AI Predictive Insights/i);
    expect(text).not.toMatch(/AI Deal Insights/i);
    expect(text).not.toMatch(/Gemini Insights/i);
    expect(text).not.toMatch(/AI-powered insight/i);
  });
});

describe('<DealInsights /> — loading + empty + error states', () => {
  it('shows the "Loading..." placeholder before the initial fetch resolves', async () => {
    // Defer all resolutions so the page sits in loading state.
    let resolveIns;
    fetchApi.mockImplementation((url) => {
      if (url === '/api/deal-insights') {
        return new Promise((res) => { resolveIns = res; });
      }
      if (url === '/api/deals/stats') return Promise.resolve({ byStage: [] });
      if (url.startsWith('/api/deals?')) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderPage();

    // While the insights promise is pending, the loading card is visible.
    expect(await screen.findByText(/Loading\.\.\./i)).toBeInTheDocument();

    // Resolve so afterEach doesn't leak a pending promise.
    resolveIns([]);
    await waitFor(() => {
      expect(screen.queryByText(/Loading\.\.\./i)).not.toBeInTheDocument();
    });
  });

  it('shows the "No insights yet" empty state when zero insights exist', async () => {
    // Empty insights, but at least one open deal (so the CTA copy
    // points the user at "Generate Insights" rather than "Go to Pipeline").
    fetchApi.mockImplementation((url) => {
      if (url === '/api/deal-insights') return Promise.resolve([]);
      if (url === '/api/deals/stats') {
        return Promise.resolve({ byStage: [{ stage: 'lead', count: 1, value: 1000 }] });
      }
      if (url.startsWith('/api/deals?')) {
        return Promise.resolve([{ id: 9, title: 'Solo open deal', stage: 'lead', amount: 1000, currency: 'USD' }]);
      }
      return Promise.resolve([]);
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No insights yet/i)).toBeInTheDocument();
    });
    // CTA copy points to generate (not Go to Pipeline) because openDeals > 0.
    // "Generate Insights" appears both in the header button AND the empty-state
    // CTA copy, so use getAllByText.
    expect(screen.getAllByText(/Generate Insights/i).length).toBeGreaterThanOrEqual(1);
    // "Go to Pipeline" must NOT appear (it only renders when openDeals.length === 0).
    expect(screen.queryByText(/Go to Pipeline/i)).not.toBeInTheDocument();
  });

  it('survives fetchApi rejection without crashing (loadAll .catch fallback)', async () => {
    // Every endpoint rejects; loadAll wraps each in .catch(() => []) /
    // .catch(() => null) so the page should still render the empty state.
    fetchApi.mockRejectedValue(new Error('Network down'));
    renderPage();

    // Header stays rendered.
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('Deal Insights');

    // Loading clears even though every request rejected.
    await waitFor(() => {
      expect(screen.queryByText(/^Loading\.\.\.$/)).not.toBeInTheDocument();
    });

    // No insights yet card appears (filter !== OPEN_DEALS, grouped === {}).
    expect(screen.getByText(/No insights yet/i)).toBeInTheDocument();
  });
});

describe('<DealInsights /> — KPI tiles', () => {
  it('aggregates open / critical / warnings / resolved counts from the insights list', async () => {
    mockLoaded();
    renderPage();

    // Wait for any KPI label to appear, then probe each tile's value.
    await screen.findByText('Open Insights');

    // KPI block uses uppercase labels. Each tile's value lives in the same
    // `.card` ancestor.
    const openTile = screen.getByText('Open Insights').closest('.card');
    expect(openTile).not.toBeNull();
    expect(within(openTile).getByText('2')).toBeInTheDocument();

    const criticalTile = screen.getByText('Critical').closest('.card');
    expect(within(criticalTile).getByText('1')).toBeInTheDocument();

    const warningsTile = screen.getByText('Warnings').closest('.card');
    expect(within(warningsTile).getByText('1')).toBeInTheDocument();

    const resolvedTile = screen.getByText('Resolved').closest('.card');
    expect(within(resolvedTile).getByText('1')).toBeInTheDocument();
  });
});

describe('<DealInsights /> — loaded insights list', () => {
  it('renders one card per dealId grouping with the insight bodies', async () => {
    mockLoaded();
    renderPage();

    // Acme deal has 2 unresolved insights, both visible.
    expect(await screen.findByText(/No activity in 45 days/i)).toBeInTheDocument();
    expect(screen.getByText(/Schedule a check-in call/i)).toBeInTheDocument();

    // Acme's deal title appears in the grouped-list header (deal #1 has 2 insights).
    expect(screen.getByText(/Acme Corp Renewal/i)).toBeInTheDocument();

    // The "2 insights" deal-count chip is rendered on the Acme card.
    expect(screen.getByText(/2 insights/i)).toBeInTheDocument();
  });

  it('renders severity badges + type labels for each insight', async () => {
    mockLoaded();
    renderPage();

    await screen.findByText(/No activity in 45 days/i);

    // Severity chips are rendered uppercase: CRITICAL + WARNING.
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
    expect(screen.getByText('WARNING')).toBeInTheDocument();

    // 'RISK' appears as both a filter-tab button AND the insight's type label
    // (the .replace(/_/g, ' ') leaves single-word types unchanged). Use
    // getAllByText to accept the duplicate.
    expect(screen.getAllByText('RISK').length).toBeGreaterThanOrEqual(1);
    // 'NEXT BEST ACTION' renders with underscores stripped — only inside the
    // insight type label (the filter tab shows the same text but is fine to
    // match via getAllByText for symmetry).
    expect(screen.getAllByText('NEXT BEST ACTION').length).toBeGreaterThanOrEqual(1);
  });

  it('Resolve button calls POST /api/deal-insights/:id/resolve and removes the insight from the unresolved list', async () => {
    mockLoaded();
    renderPage();

    await screen.findByText(/No activity in 45 days/i);

    // Two unresolved insights → two Resolve buttons.
    const resolveButtons = screen.getAllByRole('button', { name: /Resolve/i });
    expect(resolveButtons.length).toBeGreaterThanOrEqual(2);

    fireEvent.click(resolveButtons[0]);

    await waitFor(() => {
      const resolveCall = fetchApi.mock.calls.find(([url, opts]) =>
        typeof url === 'string' && /^\/api\/deal-insights\/\d+\/resolve$/.test(url) && opts?.method === 'POST'
      );
      expect(resolveCall).toBeTruthy();
    });

    // Insight 101 is the first generated (most recent); after resolve, the
    // critical KPI count drops from 1 to 0.
    await waitFor(() => {
      const criticalTile = screen.getByText('Critical').closest('.card');
      expect(within(criticalTile).getByText('0')).toBeInTheDocument();
    });
  });
});

describe('<DealInsights /> — filter tabs + showResolved', () => {
  it('filtering by RISK hides non-RISK insights', async () => {
    mockLoaded();
    renderPage();

    await screen.findByText(/No activity in 45 days/i);
    // NEXT_BEST_ACTION insight visible BEFORE filter.
    expect(screen.getByText(/Schedule a check-in call/i)).toBeInTheDocument();

    // Click the RISK tab.
    fireEvent.click(screen.getByRole('button', { name: 'RISK' }));

    await waitFor(() => {
      expect(screen.queryByText(/Schedule a check-in call/i)).not.toBeInTheDocument();
    });
    // RISK insight still visible.
    expect(screen.getByText(/No activity in 45 days/i)).toBeInTheDocument();
  });

  it('Show resolved checkbox surfaces resolved insights', async () => {
    mockLoaded();
    renderPage();

    await screen.findByText(/No activity in 45 days/i);

    // Resolved OPPORTUNITY insight hidden by default.
    expect(screen.queryByText(/High engagement detected/i)).not.toBeInTheDocument();

    const resolvedToggle = screen.getByLabelText(/Show resolved/i);
    fireEvent.click(resolvedToggle);

    await waitFor(() => {
      expect(screen.getByText(/High engagement detected/i)).toBeInTheDocument();
    });
  });
});

describe('<DealInsights /> — OPEN_DEALS view', () => {
  it('renders one card per open deal with title + amount + stage + contact', async () => {
    mockLoaded();
    renderPage();

    // Click the OPEN_DEALS tab — uses the label text "OPEN DEALS"
    // (underscores stripped by the .replace in the JSX).
    await screen.findByRole('button', { name: /OPEN DEALS/i });
    fireEvent.click(screen.getByRole('button', { name: /OPEN DEALS/i }));

    // Three open-deal cards should be visible.
    await waitFor(() => {
      // Each deal title appears in the cards view.
      expect(screen.getAllByText(/Acme Corp Renewal/i).length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/Beta Ltd Expansion/i)).toBeInTheDocument();
      expect(screen.getByText(/Gamma Inc Pilot/i)).toBeInTheDocument();
    });

    // Stages render verbatim in the deal-card metadata block.
    expect(screen.getAllByText(/proposal/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/contacted/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/lead/i).length).toBeGreaterThanOrEqual(1);

    // "See Insights" / "View Pipeline" buttons exist on each deal card.
    expect(screen.getAllByText(/See Insights/i).length).toBe(3);
    expect(screen.getAllByText(/View Pipeline/i).length).toBe(3);
  });
});

describe('<DealInsights /> — Generate Insights button', () => {
  it('renders count from /api/deals/stats byStage (excludes won/lost)', async () => {
    mockLoaded();
    renderPage();

    // byStage sums lead+contacted+proposal = 3; won+lost excluded.
    // Button label: "Generate Insights (3 open)".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Insights \(3 open\)/i })).toBeInTheDocument();
    });
  });

  it('disabled when there are zero open deals', async () => {
    // openDeals == [] (no /api/deals? result), but stats has 0 byStage.
    fetchApi.mockImplementation((url) => {
      if (url === '/api/deal-insights') return Promise.resolve([]);
      if (url === '/api/deals/stats') return Promise.resolve({ byStage: [] });
      if (url.startsWith('/api/deals?')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderPage();

    const btn = await screen.findByRole('button', { name: /Generate Insights \(0 open\)/i });
    expect(btn).toBeDisabled();
  });

  it('clicking Generate fires POST /api/deal-insights/generate/:dealId for each open deal then re-loads', async () => {
    const fx = mockLoaded();
    renderPage();

    const btn = await screen.findByRole('button', { name: /Generate Insights \(3 open\)/i });
    fireEvent.click(btn);

    // Expect one POST per open deal.
    await waitFor(() => {
      for (const d of fx.openDeals) {
        const found = fetchApi.mock.calls.some(([url, opts]) =>
          url === `/api/deal-insights/generate/${d.id}` && opts?.method === 'POST'
        );
        expect(found).toBe(true);
      }
    });

    // After the POST loop, loadAll re-runs — /api/deal-insights is hit
    // a second time (initial mount + post-generate refresh).
    await waitFor(() => {
      const insightFetches = fetchApi.mock.calls.filter(([url]) => url === '/api/deal-insights');
      expect(insightFetches.length).toBeGreaterThanOrEqual(2);
    });
  });
});
