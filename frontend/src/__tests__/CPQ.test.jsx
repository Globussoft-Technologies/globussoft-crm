/**
 * CPQ.test.jsx — vitest + RTL coverage for the Configure-Price-Quote PAGE
 * wrapper (`frontend/src/pages/CPQ.jsx`, 99 LOC). This is the sales-side
 * deal-selector page that lists deals on the left and lazily mounts the
 * CPQBuilder child on the right when a deal is picked.
 *
 * Distinct from sibling `CPQBuilder.test.jsx` — that suite covers the
 * child's quote-building internals (line-items, MRR math, save POST). This
 * suite pins the page wrapper's surface:
 *   1. Page renders the "Configure Price Quote" heading + intro blurb +
 *      "Deal Selection" panel chrome.
 *   2. Initial mount fires GET /api/deals (no params); the response array
 *      drives the deal-list render.
 *   3. While the initial fetch is in flight the panel renders "Loading
 *      deals…".
 *   4. After the fetch resolves with [] the panel renders the empty-state
 *      "No deals available. Create a deal in the pipeline first."
 *   5. After the fetch resolves with N deals the right-side empty-state
 *      ("No deal selected" + "Choose a deal from the left panel…") renders
 *      until a deal is clicked, AND the counter "N deals" reflects the
 *      list length.
 *   6. Rejected fetch surfaces the inline error chrome "Unable to load
 *      deals." (the catch branch sets the error state but leaves loading
 *      false — pinned).
 *   7. Each deal row renders title + contact.company (or "No contact
 *      linked" fallback) + stage; clicking a row mounts the CPQBuilder
 *      (passed dealId) and hides the "No deal selected" panel.
 *   8. Non-array fetch response (the catch-all in CPQ.jsx:16 coerces to
 *      []) renders the empty-state, not a crash.
 *
 * Drift notes: CPQ.jsx hardcodes the GET endpoint as `/api/deals` (no
 * pagination params); if that endpoint ever moves to `/api/deals?limit=…`
 * or a `/stats` shape, this test will go red — intentional, the page's
 * "show ALL deals in a sidebar" UX assumes a small dataset. The
 * `deals.length` counter is unbounded by the response shape; under a
 * paginated future, the page would need a server-side count field. Logged
 * as a latent concern; no commit needed today.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// CPQBuilder mounts when a deal is selected. We stub it to a sentinel so
// (a) tests don't have to mock its child fetches (already covered by
// CPQBuilder.test.jsx) and (b) we can assert it received the right
// `dealId` prop.
vi.mock('../components/CPQBuilder', () => ({
  default: (props) => (
    <div data-testid="cpq-builder-stub" data-deal-id={String(props.dealId)}>
      CPQ Builder Stub
    </div>
  ),
}));

import CPQ from '../pages/CPQ';

const sampleDeals = [
  {
    id: 101,
    title: 'Globussoft Annual Renewal',
    stage: 'negotiation',
    contact: { company: 'Acme Corp' },
  },
  {
    id: 102,
    title: 'Wellness Clinic Onboarding',
    stage: 'proposal',
    contact: { company: 'Dr Haror Clinic' },
  },
  {
    id: 103,
    title: 'Unlinked Deal',
    stage: 'lead',
    contact: null,
  },
];

describe('<CPQ /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('renders the "Configure Price Quote" heading + intro blurb + Deal Selection panel chrome', async () => {
    fetchApiMock.mockResolvedValueOnce(sampleDeals);
    render(<CPQ />);

    expect(
      screen.getByRole('heading', { name: /Configure Price Quote/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Select a sales deal and build CPQ quotes/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /Deal Selection/i }),
    ).toBeInTheDocument();

    // Counter renders even before data arrives — initially "0 deals".
    expect(screen.getByText(/0 deals/i)).toBeInTheDocument();

    // After fetch resolves the counter flips to "3 deals".
    expect(await screen.findByText(/3 deals/i)).toBeInTheDocument();
  });

  it('initial mount fires GET /api/deals (single call, no params)', async () => {
    fetchApiMock.mockResolvedValueOnce(sampleDeals);
    render(<CPQ />);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/deals');
    });
    // No second call from the page wrapper itself — CPQBuilder is stubbed.
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });

  it('renders "Loading deals…" before the initial fetch resolves', async () => {
    let resolveDeals;
    fetchApiMock.mockImplementation(
      () => new Promise((r) => { resolveDeals = r; }),
    );
    render(<CPQ />);

    expect(await screen.findByText(/Loading deals…/i)).toBeInTheDocument();
    // Resolve so React Testing Library can cleanly tear down.
    resolveDeals([]);
  });

  it('renders the empty-state "No deals available." when /api/deals returns []', async () => {
    fetchApiMock.mockResolvedValueOnce([]);
    render(<CPQ />);

    expect(
      await screen.findByText(/No deals available\. Create a deal in the pipeline first\./i),
    ).toBeInTheDocument();
    // Counter shows "0 deals".
    expect(screen.getByText(/0 deals/i)).toBeInTheDocument();
    // The right-side "No deal selected" panel still renders (no deal picked).
    expect(
      screen.getByRole('heading', { name: /No deal selected/i }),
    ).toBeInTheDocument();
    // CPQBuilder stub is NOT mounted yet.
    expect(screen.queryByTestId('cpq-builder-stub')).not.toBeInTheDocument();
  });

  it('renders one row per deal with title + company (or "No contact linked" fallback) + stage', async () => {
    fetchApiMock.mockResolvedValueOnce(sampleDeals);
    render(<CPQ />);

    // Wait for all three rows to render.
    await waitFor(() => {
      expect(screen.getByText('Globussoft Annual Renewal')).toBeInTheDocument();
    });
    expect(screen.getByText('Wellness Clinic Onboarding')).toBeInTheDocument();
    expect(screen.getByText('Unlinked Deal')).toBeInTheDocument();

    // Company + stage render together as "<company> · <stage>".
    expect(screen.getByText(/Acme Corp · negotiation/i)).toBeInTheDocument();
    expect(screen.getByText(/Dr Haror Clinic · proposal/i)).toBeInTheDocument();
    // Fallback for null contact.
    expect(screen.getByText(/No contact linked · lead/i)).toBeInTheDocument();
  });

  it('surfaces "Unable to load deals." when /api/deals rejects', async () => {
    fetchApiMock.mockRejectedValueOnce(new Error('boom — backend down'));
    render(<CPQ />);

    expect(
      await screen.findByText(/Unable to load deals\./i),
    ).toBeInTheDocument();
    // Loading message no longer rendered (loading flipped to false in the
    // finally branch).
    expect(screen.queryByText(/Loading deals…/i)).not.toBeInTheDocument();
  });

  it('clicking a deal row mounts CPQBuilder with the selected dealId and hides the empty-state panel', async () => {
    fetchApiMock.mockResolvedValueOnce(sampleDeals);
    render(<CPQ />);

    // Wait for deals to render.
    const dealBtn = await screen.findByText('Wellness Clinic Onboarding');

    // Pre-click: the right-side "No deal selected" panel renders.
    expect(
      screen.getByRole('heading', { name: /No deal selected/i }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('cpq-builder-stub')).not.toBeInTheDocument();

    // Click the deal row (button wraps the whole content — the title is
    // inside the button, so the closest button is the click target).
    fireEvent.click(dealBtn.closest('button'));

    // CPQBuilder stub mounts with the right dealId; empty-state panel hides.
    const stub = await screen.findByTestId('cpq-builder-stub');
    expect(stub.getAttribute('data-deal-id')).toBe('102');
    expect(
      screen.queryByRole('heading', { name: /No deal selected/i }),
    ).not.toBeInTheDocument();
  });

  it('non-array fetch response is coerced to [] and renders the empty-state (no crash)', async () => {
    // CPQ.jsx line 16: `setDeals(Array.isArray(data) ? data : [])`. A
    // backend regression that returns `{ deals: [...] }` envelope without
    // a top-level array MUST render the empty-state instead of throwing.
    fetchApiMock.mockResolvedValueOnce({ deals: sampleDeals, total: 3 });
    render(<CPQ />);

    expect(
      await screen.findByText(/No deals available\. Create a deal in the pipeline first\./i),
    ).toBeInTheDocument();
    // Counter shows "0 deals" (the coerced empty array's length).
    expect(screen.getByText(/0 deals/i)).toBeInTheDocument();
  });
});
