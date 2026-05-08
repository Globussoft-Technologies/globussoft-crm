/**
 * DealInsights.test.jsx — vitest coverage pinning the #593 rebrand.
 *
 * #593: the page's backend (backend/routes/deal_insights.js +
 * backend/cron/dealInsightsEngine.js) is rules-based — runHeuristicRules
 * generates deterministic threshold-driven insights ("No activity in N days",
 * "Deal is X day(s) past expected close date and still in 'stage' stage",
 * etc.). The optional Gemini-prefixed `[AI]` insight only fires when
 * GEMINI_API_KEY is set — which is NOT the case on the demo per #563
 * ("AI / Gemini, Sentiment, and Data-enrichment backends not mounted —
 * Not planned"). Branding the page as "AI Predictive Insights" / "AI Deal
 * Insights" was therefore misleading.
 *
 * This spec pins the rebrand:
 *   - Page heading is "Deal Insights" (not "AI Deal Insights" / "AI Predictive Insights").
 *   - Tagline explicitly says "Rules-based" (truth-in-labelling).
 *   - The page does NOT render the misleading branding strings anywhere
 *     in the user-visible DOM.
 *
 * If a future commit re-wires the genuine Gemini backend (per #563 option 1)
 * and re-introduces "AI" branding, that's fine — but it should only happen
 * when the AI path is actually mounted by default. Re-evaluate this spec at
 * that point; until then it guards against accidental marketing-vs-truth
 * regression.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
