/**
 * Pipeline.test.jsx — vitest pin for the kanban stage-grouping fix (#575).
 *
 * #575 (regression of #173): the demo's Default Org tenant had a pipeline_stages
 * configuration that included BOTH "Lead" and "New Lead" stage rows. Both names
 * normalize to the slug 'lead' via Pipeline.jsx's stageIdMap. Pre-fix, the
 * stages list rendered both rows with identical id='lead', and the per-column
 * grouping `deals.filter(d => d.stage === stage.id)` matched the same deal
 * set into both columns — testers saw "New Lead 99 / $90k" AND "Lead 99 / $90k"
 * with the first 8 cards bit-identical. Visual double-count of the pipeline,
 * inflated the perception of opportunity volume, fed downstream forecasting
 * confusion (#573).
 *
 * The fix dedupes the rendered stage list by normalized id (first-stage-wins,
 * preserving DB position order since /api/pipeline_stages returns rows
 * sorted by position asc). Two stage rows that collapse to the same id render
 * exactly ONE column.
 *
 * Contracts pinned here:
 *   1. Two distinct stage rows that normalize to the same id render ONE
 *      column, not two.
 *   2. With duplicate-collapsing stages, every deal appears in EXACTLY ONE
 *      column (no card rendered twice across columns).
 *   3. Distinct stages that map to distinct ids render separately and split
 *      deals correctly.
 *   4. Negotiation + Proposal Sent (both → 'proposal') also collapse to one
 *      column — exercises the same dedupe path on a different colliding pair.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

// socket.io-client tries to open a real network connection in jsdom; stub it
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

// DealModal pulls in heavy deps; the kanban contract doesn't need it
vi.mock('../components/DealModal', () => ({
  default: () => null,
}));

import { fetchApi } from '../utils/api';
import Pipeline from '../pages/Pipeline';

beforeEach(() => {
  vi.clearAllMocks();
  try {
    localStorage.setItem('tenant', JSON.stringify({ defaultCurrency: 'USD', locale: 'en-US' }));
  } catch {
    /* ignore */
  }
});

function renderPipeline() {
  return render(
    <MemoryRouter>
      <Pipeline />
    </MemoryRouter>,
  );
}

function mockApi({ deals = [], contacts = [], stages = [] }) {
  fetchApi.mockImplementation((url) => {
    if (url.startsWith('/api/deals')) return Promise.resolve(deals);
    if (url.startsWith('/api/contacts')) return Promise.resolve(contacts);
    if (url.startsWith('/api/pipeline_stages')) return Promise.resolve(stages);
    return Promise.resolve([]);
  });
}

describe('Pipeline kanban stage grouping (#575)', () => {
  it('dedupes stages whose names collapse to the same id (Lead + New Lead → one column)', async () => {
    // Demo-shape: tenant created BOTH "Lead" and "New Lead" stages, both
    // normalize to slug 'lead'. Before the fix this rendered two columns
    // showing identical deals.
    mockApi({
      stages: [
        { id: 1, name: 'Lead', color: '#3b82f6', position: 0 },
        { id: 2, name: 'New Lead', color: '#3b82f6', position: 1 },
        { id: 3, name: 'Closed Won', color: '#10b981', position: 2 },
      ],
      deals: [
        { id: 101, title: 'Acme Corp Renewal', amount: 50000, probability: 25, stage: 'lead' },
        { id: 102, title: 'Globex Expansion', amount: 40000, probability: 30, stage: 'lead' },
        { id: 103, title: 'Initech Annual', amount: 90000, probability: 100, stage: 'won' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Only ONE of the two collapsing stages should render — first-position-wins,
    // so we keep "Lead" (position 0) and drop "New Lead" (position 1).
    // The stage title is a literal text node inside the <h3> alongside the
    // count badge; matching by text avoids the accessible-name concatenation.
    const leadTitles = screen.queryAllByText('Lead', { selector: 'h3' });
    const newLeadTitles = screen.queryAllByText('New Lead', { selector: 'h3' });
    expect(leadTitles.length + newLeadTitles.length).toBe(1);

    // "Closed Won" is unaffected.
    expect(screen.getByText('Closed Won', { selector: 'h3' })).toBeInTheDocument();
  });

  it('renders each deal in EXACTLY ONE column (no duplication across collapsing stages)', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'Lead', color: '#3b82f6', position: 0 },
        { id: 2, name: 'New Lead', color: '#3b82f6', position: 1 },
        { id: 3, name: 'Closed Won', color: '#10b981', position: 2 },
      ],
      deals: [
        { id: 101, title: 'Acme Corp Renewal', amount: 50000, probability: 25, stage: 'lead' },
        { id: 102, title: 'Globex Expansion', amount: 40000, probability: 30, stage: 'lead' },
        { id: 103, title: 'Initech Annual', amount: 90000, probability: 100, stage: 'won' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Every deal title appears exactly once across the whole kanban —
    // pre-fix the two lead-stage cards would each appear in BOTH the
    // Lead and New Lead columns.
    expect(screen.getAllByText('Acme Corp Renewal')).toHaveLength(1);
    expect(screen.getAllByText('Globex Expansion')).toHaveLength(1);
    expect(screen.getAllByText('Initech Annual')).toHaveLength(1);
  });

  it('keeps distinct stages with distinct ids as separate columns', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
        { id: 2, name: 'Contacted', color: '#f59e0b', position: 1 },
        { id: 3, name: 'Closed Won', color: '#10b981', position: 2 },
      ],
      deals: [
        { id: 101, title: 'Lead Card', amount: 1000, probability: 20, stage: 'lead' },
        { id: 102, title: 'Contacted Card', amount: 2000, probability: 50, stage: 'contacted' },
        { id: 103, title: 'Won Card', amount: 3000, probability: 100, stage: 'won' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('New Lead', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Contacted', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Closed Won', { selector: 'h3' })).toBeInTheDocument();

    // Each card appears exactly once.
    expect(screen.getAllByText('Lead Card')).toHaveLength(1);
    expect(screen.getAllByText('Contacted Card')).toHaveLength(1);
    expect(screen.getAllByText('Won Card')).toHaveLength(1);
  });

  it('also dedupes the Proposal Sent / Negotiation collision (both → proposal)', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'Proposal Sent', color: '#a855f7', position: 0 },
        { id: 2, name: 'Negotiation', color: '#ec4899', position: 1 },
      ],
      deals: [
        { id: 101, title: 'Mid-funnel Deal', amount: 5000, probability: 60, stage: 'proposal' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Only the first colliding stage renders. "Negotiation" is dropped.
    expect(screen.getByText('Proposal Sent', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.queryByText('Negotiation', { selector: 'h3' })).not.toBeInTheDocument();

    // The single deal renders exactly once, not twice.
    expect(screen.getAllByText('Mid-funnel Deal')).toHaveLength(1);
  });
});

// #897 (PRD_TRAVEL_PIPELINE_KANBAN FR-5) — sub-brand filter is only
// rendered for Travel-vertical tenants. Pipeline.jsx reads
// `user?.tenant?.vertical` from AuthContext; in test renders without
// an AuthContext.Provider, `useContext(AuthContext) || {}` returns
// `{}` so `isTravelTenant` is false and the dropdown stays hidden.
// This is the same shape as production behavior for generic/wellness
// tenants — pinning that the filter doesn't leak across verticals.
describe('Pipeline sub-brand filter (#897)', () => {
  it('does NOT render sub-brand selector for non-Travel tenants (default test context)', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
      ],
      deals: [
        { id: 101, title: 'Generic Deal', amount: 1000, probability: 30, stage: 'lead' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // The aria-labeled sub-brand selector must be absent for non-Travel
    // tenants. (Travel-vertical AuthContext-mocked rendering would
    // require provider wrap — separate test scope.)
    expect(screen.queryByLabelText('Filter by sub-brand')).not.toBeInTheDocument();

    // Header still renders Sales Pipeline + Add Deal button (smoke).
    expect(screen.getByText('Sales Pipeline', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Add Deal')).toBeInTheDocument();
  });
});
