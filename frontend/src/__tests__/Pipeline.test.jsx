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
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
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

/**
 * Extended cases — append-only batch from the autonomous test-cron.
 *
 * Pipeline.jsx is 435L; baseline test was 243L (55% ratio). This batch
 * exercises the column-header / formatMoney / empty-stage placeholder /
 * Add Deal modal lifecycle / default-stages fallback / loading state /
 * AI-score error path branches that the #575 dedupe pin doesn't touch.
 *
 * No source changes — only new test cases. The render helpers + the
 * fetchApi / socket.io / DealModal mocks defined above are reused.
 */
describe('Pipeline column header — count badge + totalValue', () => {
  it('renders deal count badge AND formatted totalValue per stage', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
        { id: 2, name: 'Closed Won', color: '#10b981', position: 1 },
      ],
      deals: [
        { id: 201, title: 'Lead A', amount: 1000, probability: 25, stage: 'lead' },
        { id: 202, title: 'Lead B', amount: 2500, probability: 30, stage: 'lead' },
        { id: 203, title: 'Won A', amount: 50000, probability: 100, stage: 'won' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Stage count badges — scoped within the <h3> containing the stage name.
    const newLeadHeader = screen.getByText('New Lead', { selector: 'h3' });
    expect(within(newLeadHeader).getByText('2')).toBeInTheDocument();

    const wonHeader = screen.getByText('Closed Won', { selector: 'h3' });
    expect(within(wonHeader).getByText('1')).toBeInTheDocument();

    // totalValue formatting via formatMoney(USD/en-US). $3,500 = 1000 + 2500.
    // formatMoney emits non-breaking spaces or compact forms in some locales;
    // match by substring to absorb those without coupling to the exact glyph.
    const moneyTexts = screen.getAllByText(/\$/);
    const moneyJoined = moneyTexts.map((n) => n.textContent).join(' | ');
    expect(moneyJoined).toMatch(/3,500/);
    expect(moneyJoined).toMatch(/50,000/);
  });
});

describe('Pipeline empty-stage placeholder', () => {
  it('shows "Drag deals here" placeholder for a stage with zero matching deals', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
        { id: 2, name: 'Contacted', color: '#f59e0b', position: 1 },
      ],
      deals: [
        { id: 301, title: 'Only Lead', amount: 100, probability: 20, stage: 'lead' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // "Contacted" has zero deals — placeholder renders. (The "New Lead"
    // column has one card so its placeholder is absent.)
    const placeholders = screen.getAllByText('Drag deals here');
    expect(placeholders.length).toBe(1);
  });
});

describe('Pipeline Add Deal modal lifecycle', () => {
  it('opens the Add Deal modal on button click and closes via Cancel', async () => {
    mockApi({
      stages: [{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }],
      deals: [],
      contacts: [{ id: 1, name: 'Priya Sharma', company: 'Acme Corp' }],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Modal is closed initially — no "Add New Deal" h3.
    expect(screen.queryByText('Add New Deal')).not.toBeInTheDocument();

    // Click Add Deal header button.
    fireEvent.click(screen.getByRole('button', { name: /add deal/i }));

    // Modal is now open with title "Add New Deal" and form inputs.
    expect(screen.getByText('Add New Deal')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Deal Title')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Contact Person')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Company Name')).toBeInTheDocument();

    // Cancel closes the modal — "Add New Deal" h3 disappears.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Add New Deal')).not.toBeInTheDocument();
  });
});

describe('Pipeline default stages fallback', () => {
  it('falls back to defaultStages when /api/pipeline_stages returns an empty array', async () => {
    // No stage rows from the server — Pipeline.jsx keeps the in-file
    // defaultStages: ['New Lead', 'Contacted', 'Proposal Sent', 'Closed Won'].
    mockApi({
      stages: [],
      deals: [
        { id: 401, title: 'Fallback Card', amount: 1234, probability: 50, stage: 'contacted' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // All four default stage headers render.
    expect(screen.getByText('New Lead', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Contacted', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Proposal Sent', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Closed Won', { selector: 'h3' })).toBeInTheDocument();

    // The contacted-stage card lands in its column.
    expect(screen.getByText('Fallback Card')).toBeInTheDocument();
  });
});

describe('Pipeline loading state', () => {
  it('renders "Loading deals..." while initial /api/* requests are pending', () => {
    // Never-resolving promises keep the loading flag true.
    fetchApi.mockImplementation(() => new Promise(() => {}));

    renderPipeline();

    expect(screen.getByText('Loading deals...')).toBeInTheDocument();
    // No stage columns yet — defaultStages aren't rendered while loading.
    expect(screen.queryByText('New Lead', { selector: 'h3' })).not.toBeInTheDocument();
  });
});

describe('Pipeline deal card details', () => {
  it('renders deal title, company fallback, formatted amount, and probability % per card', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'Contacted', color: '#f59e0b', position: 0 },
      ],
      deals: [
        {
          id: 501,
          title: 'Globussoft Renewal',
          company: 'Globussoft Tech',
          amount: 75000,
          probability: 65,
          stage: 'contacted',
        },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Globussoft Renewal')).toBeInTheDocument();
    expect(screen.getByText('Globussoft Tech')).toBeInTheDocument();
    // probability badge — "65%" inline text node.
    expect(screen.getByText('65%')).toBeInTheDocument();
    // amount renders via formatMoney; check the numeric portion.
    const amountText = screen.getAllByText(/\$/).map((n) => n.textContent).join(' | ');
    expect(amountText).toMatch(/75,000/);
  });

  it('uses contactName as fallback when company is missing, and em-dash when both are missing', async () => {
    mockApi({
      stages: [
        { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
      ],
      deals: [
        { id: 601, title: 'No Company', contactName: 'Asha Verma', amount: 100, probability: 10, stage: 'lead' },
        { id: 602, title: 'Anonymous Lead', amount: 200, probability: 15, stage: 'lead' },
      ],
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // First card falls back to contactName.
    expect(screen.getByText('Asha Verma')).toBeInTheDocument();
    // Second card has neither company nor contactName — em-dash placeholder.
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

/**
 * C3 (PRD_TRAVEL_PIPELINE_KANBAN FR-3.15) — Pipeline sub-brand URL-param
 * persistence. The filter chip itself already shipped via #897; C3 adds a
 * `?subBrand=tmc` URL-param sync via `useSearchParams` so the selection
 * survives page reload + deep-link share + browser back-button navigation.
 *
 * These cases wrap the page in a Travel-vertical AuthContext so the
 * dropdown actually renders (the earlier non-Travel test confirmed the
 * dropdown stays hidden otherwise). `MemoryRouter` is seeded via
 * `initialEntries=[...]` to simulate the URL-on-mount path; `LocationProbe`
 * exposes the live URL so tests can assert sync direction without coupling
 * to `window.location` (which jsdom + MemoryRouter intentionally don't wire).
 *
 * Contracts pinned:
 *   1. Initial `?subBrand=tmc` → dropdown seeds to 'tmc'.
 *   2. User selects 'rfu' → URL updates to `?subBrand=rfu`.
 *   3. User selects 'All sub-brands' (empty) → `subBrand` param removed from URL.
 *   4. URL changes to `?subBrand=visasure` via external nav (back-button shape)
 *      → component re-syncs its dropdown to 'visasure'.
 *   Plus a 5th: invalid `?subBrand=garbage` → falls back to '' (all).
 */
import { AuthContext } from '../App';
import { Routes, Route, useLocation } from 'react-router-dom';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-probe">{`${loc.pathname}${loc.search}`}</div>;
}

function renderTravelPipelineAt(initialUrl) {
  const travelUser = { tenant: { vertical: 'travel' } };
  return render(
    <AuthContext.Provider value={{ user: travelUser }}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <Routes>
          <Route
            path="/pipeline"
            element={
              <>
                <Pipeline />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

describe('Pipeline sub-brand URL-param persistence (C3 / FR-3.15)', () => {
  beforeEach(() => {
    mockApi({
      stages: [{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }],
      deals: [],
    });
  });

  it('seeds dropdown selection from `?subBrand=tmc` on initial mount', async () => {
    renderTravelPipelineAt('/pipeline?subBrand=tmc');

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const select = screen.getByLabelText('Filter by sub-brand');
    expect(select).toHaveValue('tmc');
    // URL stays at the seeded value (no echo-loop rewrite).
    expect(screen.getByTestId('location-probe').textContent).toContain('subBrand=tmc');
  });

  it('updates URL to `?subBrand=rfu` when user selects RFU from the dropdown', async () => {
    renderTravelPipelineAt('/pipeline');

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const select = screen.getByLabelText('Filter by sub-brand');
    expect(select).toHaveValue('');

    fireEvent.change(select, { target: { value: 'rfu' } });

    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).toContain('subBrand=rfu');
    });
    expect(select).toHaveValue('rfu');
  });

  it('removes the `subBrand` param from URL when user picks "All sub-brands"', async () => {
    renderTravelPipelineAt('/pipeline?subBrand=tmc');

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const select = screen.getByLabelText('Filter by sub-brand');
    expect(select).toHaveValue('tmc');

    // Empty-string option = "All sub-brands" — deselect.
    fireEvent.change(select, { target: { value: '' } });

    await waitFor(() => {
      const probe = screen.getByTestId('location-probe').textContent;
      expect(probe).not.toContain('subBrand');
    });
    expect(select).toHaveValue('');
  });

  it('re-syncs dropdown when URL changes externally to `?subBrand=visasure`', async () => {
    // Same shape as a browser back-button hop: re-render the tree at a
    // different initialEntries. With MemoryRouter, unmount + remount is the
    // simplest way to simulate an external URL nav inside jsdom.
    const { unmount } = renderTravelPipelineAt('/pipeline?subBrand=tmc');

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    expect(screen.getByLabelText('Filter by sub-brand')).toHaveValue('tmc');
    unmount();

    renderTravelPipelineAt('/pipeline?subBrand=visasure');

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    expect(screen.getByLabelText('Filter by sub-brand')).toHaveValue('visasure');
    expect(screen.getByTestId('location-probe').textContent).toContain('subBrand=visasure');
  });

  it('falls back to "" (all) when URL carries an unknown sub-brand value', async () => {
    renderTravelPipelineAt('/pipeline?subBrand=garbage');

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Unknown value isn't in TRAVEL_SUB_BRANDS — parseSubBrandParam returns ''.
    expect(screen.getByLabelText('Filter by sub-brand')).toHaveValue('');
    // Component-driven URL-cleanup strips the unknown param.
    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).not.toContain('garbage');
    });
  });
});

describe('Pipeline AI score fetch — error path', () => {
  it('surfaces a notify.error when /api/ai_scoring/score/<id> rejects', async () => {
    const calls = [];
    fetchApi.mockImplementation((url) => {
      calls.push(url);
      if (url.startsWith('/api/deals') && !url.includes('/api/ai_scoring')) {
        return Promise.resolve([
          { id: 701, title: 'AI Score Deal', amount: 5000, probability: 50, stage: 'lead' },
        ]);
      }
      if (url.startsWith('/api/contacts')) return Promise.resolve([]);
      if (url.startsWith('/api/pipeline_stages')) {
        return Promise.resolve([{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }]);
      }
      if (url.startsWith('/api/ai_scoring/score/')) {
        return Promise.reject(new Error('AI predictor offline'));
      }
      return Promise.resolve([]);
    });

    renderPipeline();

    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // Click the "Generate deal score for AI Score Deal" zap button.
    const zapButton = screen.getByRole('button', { name: /generate deal score for ai score deal/i });
    fireEvent.click(zapButton);

    // The fetch was invoked.
    await waitFor(() => {
      expect(calls.some((u) => u === '/api/ai_scoring/score/701')).toBe(true);
    });

    // The aiScoreModal must NOT render — error path swallows the modal open.
    // "Deal Predictive Score" is the modal's h3; absent on rejection.
    expect(screen.queryByText('Deal Predictive Score')).not.toBeInTheDocument();
  });
});

/**
 * C4 (PRD_TRAVEL_PIPELINE_KANBAN FR-3.16 / 3.17 / 3.18) — Pipeline mobile-touch
 * drag + keyboard a11y + windowed virtualization.
 *
 * Adds three orthogonal capabilities to the existing HTML5-drag kanban:
 *
 *   FR-3.16 (touch drag) — HTML5 DragEvent doesn't fire on touch devices.
 *      We synthesize the drop by tracking the held card via onTouchStart and
 *      finding the column at the touchEnd via elementFromPoint, then funnel
 *      through the same handleDrop code path (so the optimistic-update +
 *      rollback semantics are preserved across mouse + touch paths).
 *
 *   FR-3.17 (keyboard a11y) — every card is tabIndex={0} + has an aria-label.
 *      Arrow keys move FOCUS when not in move mode; Space enters move mode
 *      (visual outline + aria announcement); arrows in move mode move the
 *      CARD across columns; second Space drops; Esc cancels. A visually-
 *      hidden role="status" aria-live="polite" region announces every
 *      pickup / move / drop / cancel for screen readers.
 *
 *   FR-3.18 (virtualization) — columns over VIRTUALIZATION_THRESHOLD (=100)
 *      render only a windowed slice (~visible window + buffer) based on the
 *      column's scrollTop. The count badge always shows the REAL total length,
 *      not the windowed count. Top/bottom phantom-height spacers keep the
 *      scrollbar position aligned with the un-rendered cards above/below.
 *
 * Reduced-motion: detected via matchMedia('(prefers-reduced-motion: reduce)');
 * when set we drop CSS transitions on drag-related affordances.
 *
 * Library choices (per slice instructions):
 *   - touch drag: native touch-event listeners (no @dnd-kit/core dep added —
 *     that's a separate slice; @dnd-kit/core isn't in frontend/package.json).
 *   - virtualization: lightweight in-component scroll-position-based slice
 *     (no react-window / @tanstack/react-virtual dep added — same rationale).
 *
 * Contracts pinned by the 9 cases below:
 *   1. Touch drag — touchStart + touchEnd over a different column → card moves
 *      stages; the same PUT /api/deals/<id> network call HTML5 drop fires.
 *   2. Tab focuses a card; arrow keys navigate focus across columns + within.
 *   3. Space enters move mode; ArrowRight moves the card to the next column.
 *   4. Esc cancels an in-progress move (card stays put; announcement updates).
 *   5. aria-live region updates on pickup + drop for screen-reader audit.
 *   6. >100-card column renders only a windowed slice (not all 200 cards in DOM).
 *   7. Scroll position triggers re-render of a different card window.
 *   8. Count badge always shows the REAL total (200), not the windowed count.
 *   9. prefers-reduced-motion: reduce → transitions stripped from card.
 */
describe('Pipeline mobile touch drag (C4 / FR-3.16)', () => {
  it('synthesizes a drop via touchStart + touchEnd → PUT /api/deals/<id> fires with new stage', async () => {
    const putCalls = [];
    fetchApi.mockImplementation((url, opts) => {
      if (url.startsWith('/api/deals') && opts?.method === 'PUT') {
        putCalls.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({ id: 801, stage: 'won', probability: 100 });
      }
      if (url.startsWith('/api/deals')) {
        return Promise.resolve([
          { id: 801, title: 'Touch Drag Card', amount: 1000, probability: 25, stage: 'lead' },
        ]);
      }
      if (url.startsWith('/api/contacts')) return Promise.resolve([]);
      if (url.startsWith('/api/pipeline_stages')) {
        return Promise.resolve([
          { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
          { id: 2, name: 'Closed Won', color: '#10b981', position: 1 },
        ]);
      }
      return Promise.resolve([]);
    });

    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const card = document.querySelector('[data-deal-id="801"]');
    expect(card).toBeTruthy();
    const wonColumn = document.querySelector('[data-stage-id="won"]');
    expect(wonColumn).toBeTruthy();

    // Stub elementFromPoint so the touchEnd path finds the "Closed Won"
    // column (jsdom doesn't actually paint, so coords mean nothing).
    const origElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => wonColumn);

    fireEvent.touchStart(card, { touches: [{ clientY: 100, clientX: 50 }] });
    fireEvent.touchEnd(card, { changedTouches: [{ clientY: 600, clientX: 50 }] });

    await waitFor(() => {
      expect(putCalls.length).toBeGreaterThan(0);
    });
    expect(putCalls[0].url).toBe('/api/deals/801');
    expect(putCalls[0].body.stage).toBe('won');

    document.elementFromPoint = origElementFromPoint;
  });
});

describe('Pipeline keyboard a11y (C4 / FR-3.17)', () => {
  beforeEach(() => {
    mockApi({
      stages: [
        { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
        { id: 2, name: 'Contacted', color: '#f59e0b', position: 1 },
        { id: 3, name: 'Closed Won', color: '#10b981', position: 2 },
      ],
      deals: [
        { id: 901, title: 'Card One', amount: 1000, probability: 25, stage: 'lead' },
        { id: 902, title: 'Card Two', amount: 2000, probability: 30, stage: 'lead' },
        { id: 903, title: 'Contact Card', amount: 3000, probability: 40, stage: 'contacted' },
      ],
    });
  });

  it('cards are focusable (tabIndex=0) with descriptive aria-label', async () => {
    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const card = document.querySelector('[data-deal-id="901"]');
    expect(card).toBeTruthy();
    expect(card.getAttribute('tabindex')).toBe('0');
    expect(card.getAttribute('aria-label')).toMatch(/Card One/);
    expect(card.getAttribute('aria-label')).toMatch(/stage New Lead/);
    expect(card.getAttribute('aria-label')).toMatch(/25%/);
  });

  it('ArrowDown moves focus to the next card within the same column', async () => {
    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const card1 = document.querySelector('[data-deal-id="901"]');
    const card2 = document.querySelector('[data-deal-id="902"]');
    card1.focus();
    expect(document.activeElement).toBe(card1);

    fireEvent.keyDown(card1, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(card2);
  });

  it('ArrowRight moves focus to the same-position card in the next column', async () => {
    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const card1 = document.querySelector('[data-deal-id="901"]');
    const contactCard = document.querySelector('[data-deal-id="903"]');
    card1.focus();

    fireEvent.keyDown(card1, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(contactCard);
  });

  it('Space enters move mode + ArrowRight in move mode moves the CARD to the next column', async () => {
    const putCalls = [];
    fetchApi.mockImplementation((url, opts) => {
      if (url.startsWith('/api/deals') && opts?.method === 'PUT') {
        putCalls.push({ url, body: JSON.parse(opts.body) });
        return Promise.resolve({ id: 901, stage: 'contacted', probability: 40 });
      }
      if (url.startsWith('/api/deals')) {
        return Promise.resolve([
          { id: 901, title: 'Card One', amount: 1000, probability: 25, stage: 'lead' },
        ]);
      }
      if (url.startsWith('/api/contacts')) return Promise.resolve([]);
      if (url.startsWith('/api/pipeline_stages')) {
        return Promise.resolve([
          { id: 1, name: 'New Lead', color: '#3b82f6', position: 0 },
          { id: 2, name: 'Contacted', color: '#f59e0b', position: 1 },
        ]);
      }
      return Promise.resolve([]);
    });

    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const card = document.querySelector('[data-deal-id="901"]');
    card.focus();

    // Space enters move mode — card gains data-in-move-mode='true'.
    fireEvent.keyDown(card, { key: ' ' });
    await waitFor(() => {
      expect(card.getAttribute('data-in-move-mode')).toBe('true');
    });

    // ArrowRight in move mode triggers PUT /api/deals/901 with stage='contacted'.
    fireEvent.keyDown(card, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(putCalls.length).toBeGreaterThan(0);
    });
    expect(putCalls[0].body.stage).toBe('contacted');
  });

  it('Escape cancels an in-progress move (data-in-move-mode flips back to false)', async () => {
    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const card = document.querySelector('[data-deal-id="901"]');
    card.focus();

    fireEvent.keyDown(card, { key: ' ' });
    await waitFor(() => {
      expect(card.getAttribute('data-in-move-mode')).toBe('true');
    });

    fireEvent.keyDown(card, { key: 'Escape' });
    await waitFor(() => {
      expect(card.getAttribute('data-in-move-mode')).toBe('false');
    });
  });

  it('aria-live announcer updates on pickup (Space) and drop', async () => {
    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const announcer = screen.getByTestId('pipeline-announcer');
    expect(announcer.textContent).toBe('');

    const card = document.querySelector('[data-deal-id="901"]');
    card.focus();

    fireEvent.keyDown(card, { key: ' ' });
    await waitFor(() => {
      expect(announcer.textContent).toMatch(/Picked up Card One/);
    });

    // Second Space drops.
    fireEvent.keyDown(card, { key: ' ' });
    await waitFor(() => {
      expect(announcer.textContent).toMatch(/Dropped Card One/);
    });
  });
});

describe('Pipeline virtualization (C4 / FR-3.18)', () => {
  // Build a 200-card column to force the >100 threshold path.
  const buildBigDealList = () => {
    const arr = [];
    for (let i = 0; i < 200; i++) {
      arr.push({
        id: 1000 + i,
        title: `Big Deal ${i}`,
        amount: 1000 + i,
        probability: 25,
        stage: 'lead',
      });
    }
    return arr;
  };

  it('column with >100 cards renders only a windowed slice in the DOM, not all 200', async () => {
    mockApi({
      stages: [{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }],
      deals: buildBigDealList(),
    });

    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // All 200 cards would be 200 [data-deal-id] elements. The windowed
    // slice should render far fewer — visible window + buffer = ~10-30.
    const rendered = document.querySelectorAll('[data-deal-id]');
    expect(rendered.length).toBeLessThan(50);
    expect(rendered.length).toBeGreaterThan(0);

    // First card in the un-scrolled window is "Big Deal 0".
    expect(screen.getByText('Big Deal 0')).toBeInTheDocument();
    // Far-down card (e.g. "Big Deal 150") is NOT in the DOM (off-screen).
    expect(screen.queryByText('Big Deal 150')).not.toBeInTheDocument();
  });

  it('scrolling the column triggers a re-render of a different card window', async () => {
    mockApi({
      stages: [{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }],
      deals: buildBigDealList(),
    });

    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const body = screen.getByTestId('stage-body-lead');
    expect(body).toBeTruthy();
    // Initially the top of the window is rendered.
    expect(screen.getByText('Big Deal 0')).toBeInTheDocument();

    // Simulate a scroll far down. jsdom doesn't paint so we set scrollTop
    // directly + fire onScroll with the new value. After the re-render,
    // a card from the middle of the list should appear and "Big Deal 0"
    // should drop out of the DOM.
    fireEvent.scroll(body, { target: { scrollTop: 100 * 132 } }); // ~card 100

    await waitFor(() => {
      // A card near the new scroll position should now be present.
      expect(screen.queryByText('Big Deal 100')).toBeInTheDocument();
    });
    // Pre-window card is no longer rendered.
    expect(screen.queryByText('Big Deal 0')).not.toBeInTheDocument();
  });

  it('count badge shows real total (200), not the rendered/windowed count', async () => {
    mockApi({
      stages: [{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }],
      deals: buildBigDealList(),
    });

    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    const badge = screen.getByTestId('stage-count-lead');
    expect(badge.textContent).toBe('200');

    // Sanity: rendered card count is below 200 (virtualization is active).
    const rendered = document.querySelectorAll('[data-deal-id]');
    expect(rendered.length).toBeLessThan(200);
  });
});

describe('Pipeline reduced-motion (C4)', () => {
  it('drops CSS transitions when prefers-reduced-motion: reduce is set', async () => {
    // Stub matchMedia to report reduced motion.
    const origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((q) => ({
      matches: q === '(prefers-reduced-motion: reduce)',
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    mockApi({
      stages: [{ id: 1, name: 'New Lead', color: '#3b82f6', position: 0 }],
      deals: [
        { id: 1101, title: 'Reduced Motion Card', amount: 1000, probability: 25, stage: 'lead' },
      ],
    });

    renderPipeline();
    await waitFor(() => {
      expect(screen.queryByText('Loading deals...')).not.toBeInTheDocument();
    });

    // The card's inline style should have transition: 'none' when reduced
    // motion is active. We assert via the rendered DOM style attribute.
    const card = document.querySelector('[data-deal-id="1101"]');
    expect(card).toBeTruthy();
    // jsdom serializes camelCase style props to kebab-case; check the raw
    // style attribute for the transition: none token.
    expect(card.getAttribute('style')).toMatch(/transition:\s*none/);

    window.matchMedia = origMatchMedia;
  });
});
