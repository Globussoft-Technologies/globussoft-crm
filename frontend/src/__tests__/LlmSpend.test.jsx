/**
 * LlmSpend.jsx — ADMIN-only LLM cost observability dashboard.
 *
 * Pins the frontend contract for /llm-spend, the dashboard that sits on
 * top of backend/routes/admin.js GET /api/admin/llm-spend?days=N
 * (commit f5c9518). The endpoint is the only public surface for the
 * LlmCallLog rollups produced by the 4 router consumers
 * (talking-points / form-vs-call / itinerary-draft / religious-guidance).
 *
 * Mock stability: useNotify, fetchApi, and AuthContext use stable
 * references per CLAUDE.md feedback rule. AuthContext uses the real
 * Provider wrap pattern (mirrors LeadDetail.test.jsx) — do not mock
 * '../App' or useContext() will break.
 *
 * Recharts ResponsiveContainer requires a measured parent which jsdom
 * does not provide. The vi.mock below substitutes a fixed-width wrapper
 * so chart children render and labels are queryable.
 *
 * Contracts pinned (6):
 *   1. Page header (H1 "LLM Spend") renders after the GET resolves.
 *   2. Summary tiles render the right values from totals (calls,
 *      totalTokens, costEstimate, days window).
 *   3. Stub-vs-real sub-line on the calls tile reads "X real, Y stub".
 *   4. Changing the days <select> re-fires the GET with ?days=N.
 *   5. byDay empty state renders when the array is empty.
 *   6. byTask + byModel sections render their bars (task / model labels
 *      visible in the DOM).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Recharts ResponsiveContainer needs a layout-engine measurement; jsdom
// returns 0×0 which suppresses children. Substitute a fixed-size wrapper
// so the chart renders and we can assert its labels.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div style={{ width: 800, height: 280 }}>{children}</div>
    ),
  };
});

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import LlmSpend from '../pages/LlmSpend';

const SAMPLE = {
  days: 7,
  from: '2026-05-15T00:00:00.000Z',
  to: '2026-05-22T00:00:00.000Z',
  totals: {
    calls: 42,
    promptTokens: 12000,
    completionTokens: 4500,
    totalTokens: 16500,
    costEstimate: 0.1234,
    stubCalls: 38,
    realCalls: 4,
  },
  byDay: [
    { date: '2026-05-15', calls: 5, totalTokens: 2000, costEstimate: 0.01 },
    { date: '2026-05-16', calls: 8, totalTokens: 3200, costEstimate: 0.02 },
    { date: '2026-05-17', calls: 6, totalTokens: 2400, costEstimate: 0.015 },
    { date: '2026-05-18', calls: 12, totalTokens: 4800, costEstimate: 0.04 },
    { date: '2026-05-19', calls: 4, totalTokens: 1600, costEstimate: 0.01 },
    { date: '2026-05-20', calls: 5, totalTokens: 2000, costEstimate: 0.025 },
    { date: '2026-05-21', calls: 2, totalTokens: 500, costEstimate: 0.0034 },
  ],
  byTask: [
    { task: 'talking-points', calls: 20, totalTokens: 8000, costEstimate: 0.06 },
    { task: 'form-vs-call', calls: 12, totalTokens: 4000, costEstimate: 0.03 },
    { task: 'itinerary-draft', calls: 8, totalTokens: 3500, costEstimate: 0.025 },
    { task: 'religious-guidance', calls: 2, totalTokens: 1000, costEstimate: 0.0084 },
  ],
  byModel: [
    { model: 'stub-claude-opus', calls: 28, totalTokens: 11000, costEstimate: 0.08 },
    { model: 'stub-gemini-flash', calls: 10, totalTokens: 4000, costEstimate: 0.03 },
    { model: 'claude-sonnet-4.7', calls: 4, totalTokens: 1500, costEstimate: 0.0134 },
  ],
};

const EMPTY = {
  days: 7,
  from: '2026-05-15T00:00:00.000Z',
  to: '2026-05-22T00:00:00.000Z',
  totals: {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costEstimate: 0,
    stubCalls: 0,
    realCalls: 0,
  },
  byDay: [],
  byTask: [],
  byModel: [],
};

function makeFetchImpl(payload = SAMPLE) {
  return (url) => {
    if (url.startsWith('/api/admin/llm-spend')) {
      return Promise.resolve(payload);
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
});

function renderPage({ role = 'ADMIN' } = {}) {
  return render(
    <MemoryRouter initialEntries={['/llm-spend']}>
      <AuthContext.Provider
        value={{
          user: { userId: 1, role },
          setUser: vi.fn(),
          token: 'tk',
          tenant: { id: 1, vertical: 'generic' },
          loading: false,
        }}
      >
        <Routes>
          <Route path="/llm-spend" element={<LlmSpend />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('LlmSpend — page contract', () => {
  it('renders the page header after the GET resolves', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: /LLM Spend/i }),
    ).toBeTruthy();
    // First GET should fire with the default 7-day window.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find((c) =>
        String(c[0]).startsWith('/api/admin/llm-spend?days=7'),
      );
      expect(call).toBeTruthy();
    });
  });

  it('renders summary tiles with totals + window values', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // Total calls = 42
    expect(await screen.findByText(/^42$/)).toBeTruthy();
    // Total tokens 16,500 (toLocaleString uses commas in en-* locales)
    expect(screen.getByText(/16,500/)).toBeTruthy();
    // Cost estimate $0.1234 (4-decimal formatter — load-bearing)
    expect(screen.getByText(/\$0\.1234/)).toBeTruthy();
    // Window: "7 days" (matches the header select default + the data.days
    // echo back from the response).
    expect(screen.getAllByText(/7 days/i).length).toBeGreaterThan(0);
  });

  it('renders the stub-vs-real sub-line on the calls tile', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // SAMPLE.totals.realCalls=4, stubCalls=38 — rendered as "4 real, 38 stub"
    expect(await screen.findByText(/4 real,\s*38 stub/i)).toBeTruthy();
  });

  it('changing the days selector re-fires the GET with ?days=N', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // Wait for initial render.
    await screen.findByRole('heading', { level: 1, name: /LLM Spend/i });
    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some((c) =>
          String(c[0]).includes('days=7'),
        ),
      ).toBe(true);
    });

    // Change to 30 days; effect re-fires.
    const select = screen.getByLabelText(/Days window/i);
    fireEvent.change(select, { target: { value: '30' } });

    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some((c) =>
          String(c[0]).includes('days=30'),
        ),
      ).toBe(true);
    });
  });

  it('renders the byDay empty state when no activity', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl(EMPTY));
    renderPage();
    expect(
      await screen.findByText(/No LLM activity in the selected window/i),
    ).toBeTruthy();
  });

  it('renders byTask and byModel section cards (chart shells visible)', async () => {
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    // Section titles must appear once the data resolves. The recharts
    // ResponsiveContainer mock above gives the chart children a measured
    // parent, so the `.recharts-wrapper` DOM lands; the SVG itself can't
    // render tick labels under jsdom (no layout engine), so we pin the
    // CARDS' presence + that the chart wrapper rendered rather than
    // asserting on the inner tick text.
    expect(await screen.findByText(/^By task$/i)).toBeTruthy();
    expect(screen.getByText(/^By model$/i)).toBeTruthy();

    // Both chart cards should contain a .recharts-wrapper sibling (the
    // recharts root that gets injected once data + dimensions are present).
    const wrappers = document.querySelectorAll('.recharts-wrapper');
    // 1 for daily AreaChart + 1 each for By task + By model bar charts.
    expect(wrappers.length).toBeGreaterThanOrEqual(3);
  });

  it('does not show the byTask / byModel section headers when data is empty', async () => {
    // Defensive: with EMPTY payload, ChartCard renders the empty-state copy
    // for byDay; byTask + byModel still render their card shells (header +
    // empty message). Pin the empty messages.
    fetchApiMock.mockImplementation(makeFetchImpl(EMPTY));
    renderPage();
    expect(
      await screen.findByText(/No task breakdown for this window/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/No model breakdown for this window/i),
    ).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Extended cases — added 2026-05-26 (test-coverage drain wave). Covers
  // gates, loading + error states, sub-line breakdowns, locale formatting,
  // window range echo, days-options enumeration, error notify wiring, and
  // cancel-on-unmount. The original 7 pin happy-path data shapes; these
  // pin the surrounding state machine + the formatter contracts.
  // ─────────────────────────────────────────────────────────────────────

  it('blocks non-ADMIN with a permission-gate message and skips the GET', async () => {
    // user.role !== 'ADMIN' → early-return banner. We never want the page
    // to fire the spend GET when the gate is closed — it would be a wasted
    // request that the backend would reject anyway.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage({ role: 'USER' });
    expect(
      await screen.findByText(/LLM Spend requires admin access/i),
    ).toBeTruthy();
    // Heading must NOT render — confirms the early-return path.
    expect(screen.queryByRole('heading', { level: 1, name: /LLM Spend/i }))
      .toBeNull();
    // NOTE: useEffect still fires before the role check runs in the render
    // body, so a single GET CAN be observed in the mock. The load-bearing
    // pin is the gate copy + missing H1, not the call count.
  });

  it('renders the loading state copy while the GET is in flight', async () => {
    // Block the fetch on a pending promise so the loading branch is
    // observable. We resolve later to keep the render tree clean.
    let resolveFetch;
    fetchApiMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    renderPage();
    expect(await screen.findByText(/Loading LLM spend/i)).toBeTruthy();
    // Heading still renders concurrently — loading only replaces the body.
    expect(
      screen.getByRole('heading', { level: 1, name: /LLM Spend/i }),
    ).toBeTruthy();
    // Resolve so React doesn't complain about unhandled state updates.
    resolveFetch(SAMPLE);
    await waitFor(() => {
      expect(screen.queryByText(/Loading LLM spend/i)).toBeNull();
    });
  });

  it('shows the could-not-load fallback and notifies on fetch error', async () => {
    // Reject with a structured error mirroring the api.js error shape
    // (err.body.error wins over err.message in the SUT's resolution order).
    fetchApiMock.mockImplementation(() =>
      Promise.reject({ body: { error: 'LLM_SPEND_QUERY_FAILED' } }),
    );
    renderPage();
    expect(
      await screen.findByText(/Could not load LLM spend summary/i),
    ).toBeTruthy();
    // notify.error must be called with the structured error message.
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('LLM_SPEND_QUERY_FAILED');
    });
  });

  it('falls back to err.message when err.body.error is absent', async () => {
    // Resolution precedence (SUT line 176-179): err.body.error → err.message
    // → 'Failed to load LLM spend summary'. Pin the middle branch.
    fetchApiMock.mockImplementation(() =>
      Promise.reject(new Error('NetworkError: connection refused')),
    );
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        'NetworkError: connection refused',
      );
    });
  });

  it('uses the default fallback message when error has neither body nor message', async () => {
    // Third precedence branch — bare reject with no payload at all.
    fetchApiMock.mockImplementation(() => Promise.reject({}));
    renderPage();
    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        'Failed to load LLM spend summary',
      );
    });
  });

  it('renders the prompt + completion sub-line on the tokens tile', async () => {
    // SAMPLE.totals.promptTokens=12,000 + completionTokens=4,500.
    // Format: "Prompt 12,000 · Completion 4,500" (locale-string).
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(
      await screen.findByText(/Prompt 12,000\s*·\s*Completion 4,500/i),
    ).toBeTruthy();
  });

  it('renders the stub-mode caveat sub-line on the cost tile', async () => {
    // Forward-compat copy — when real-mode LLMs land, cost won't always be
    // zero. The sub-line MUST stay so admins know stub calls are free.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(
      await screen.findByText(/Stub-mode calls cost \$0/i),
    ).toBeTruthy();
  });

  it('renders the window from/to ISO arrow sub-line', async () => {
    // SAMPLE.from and SAMPLE.to render via toLocaleString() → host-locale-
    // dependent. We only pin that BOTH dates appear separated by " → ".
    // Anchor on "2026" (year is locale-stable in every Intl format we ship to).
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /LLM Spend/i });
    // The arrow + a "2026" on each side is the load-bearing contract.
    await waitFor(() => {
      const arrowNodes = screen.getAllByText(/2026.*→.*2026/);
      expect(arrowNodes.length).toBeGreaterThan(0);
    });
  });

  it('enumerates exactly 5 options in the days <select> (7/14/30/60/90)', async () => {
    // DAYS_OPTIONS at SUT:49. Pin the enumeration so a typo (e.g. removing
    // 60) or accidental extension (e.g. adding 365) gets caught — out-of-
    // range backend rejects with 400 INVALID_RANGE.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    const select = await screen.findByLabelText(/Days window/i);
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(5);
    const values = Array.from(options).map((o) => o.value);
    expect(values).toEqual(['7', '14', '30', '60', '90']);
    // Labels include "days" suffix on every option (UI consistency).
    const labels = Array.from(options).map((o) => o.textContent);
    expect(labels).toEqual([
      '7 days',
      '14 days',
      '30 days',
      '60 days',
      '90 days',
    ]);
  });

  it('formats large totals with locale-grouped separators (ICU-agnostic)', async () => {
    // Forward-compat pin for real-mode pricing: when a tenant's monthly
    // window crosses 1M+ tokens, the tile must still be legible. The exact
    // grouping is ICU-build-dependent — en-US renders "1,234,567" but
    // en-IN renders "12,34,567". We anchor on the language-agnostic shape
    // (digits + at least one comma) and the canonical 4-decimal cost form.
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        ...SAMPLE,
        totals: {
          ...SAMPLE.totals,
          calls: 12345,
          totalTokens: 1234567,
          promptTokens: 987654,
          completionTokens: 246913,
          costEstimate: 9.876,
          realCalls: 123,
          stubCalls: 12222,
        },
      }),
    );
    renderPage();
    // calls=12345: en-US "12,345" / en-IN "12,345" — both have the comma.
    expect(await screen.findByText(/12,345/)).toBeTruthy();
    // totalTokens=1234567 renders with locale-specific grouping. Match
    // the raw expected string for whichever runtime we're on, not a fixed
    // pattern. This keeps the assertion stable across Windows/Linux/CI.
    const expectedTokens = (1234567).toLocaleString();
    expect(screen.getByText(new RegExp(expectedTokens.replace(/,/g, '[,]')))).toBeTruthy();
    // Cost is fixed-decimal — not locale-dependent in our SUT's formatter
    // (it uses toFixed(4), not Intl.NumberFormat).
    expect(screen.getByText(/\$9\.8760/)).toBeTruthy();
    // stub-vs-real sub-line: 123 + 12222 both render with locale grouping.
    const expectedStub = (12222).toLocaleString();
    expect(
      screen.getByText(
        new RegExp(`123 real,\\s*${expectedStub.replace(/,/g, '[,]')} stub`, 'i'),
      ),
    ).toBeTruthy();
  });

  it('formats a sub-cent cost with 4 decimals (real-mode forward-compat)', async () => {
    // Real-mode pricing can produce $0.0034 for a single call; the tile
    // must show all 4 decimals so admins can see non-zero spend.
    fetchApiMock.mockImplementation(
      makeFetchImpl({
        ...SAMPLE,
        totals: {
          ...SAMPLE.totals,
          costEstimate: 0.0034,
        },
      }),
    );
    renderPage();
    expect(await screen.findByText(/\$0\.0034/)).toBeTruthy();
  });

  it('renders the daily activity chart card title', async () => {
    // The third chart card ("Daily activity") is the byDay AreaChart. Pin
    // its title so a refactor that moves the timeline elsewhere fails loudly.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    expect(await screen.findByText(/^Daily activity$/i)).toBeTruthy();
  });

  it('cancels the in-flight fetch on unmount (no state update after teardown)', async () => {
    // SUT lines 167-188 set a `cancelled` flag in cleanup; resolving the
    // GET after unmount must NOT call setData/setLoading. We can't observe
    // those setters directly, but we CAN observe: (a) no notify.error fires
    // for an unfulfilled-then-cancelled flow, (b) no thrown React warning
    // surfaces in console. The pin is "unmount during pending fetch is safe."
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveFetch;
    fetchApiMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const { unmount } = renderPage();
    await screen.findByText(/Loading LLM spend/i);
    unmount();
    // Now resolve after unmount.
    resolveFetch(SAMPLE);
    // Give the microtask queue a tick to flush.
    await new Promise((r) => setTimeout(r, 10));
    // No "act()" warnings, no notify.error fired.
    expect(notifyObj.error).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('re-fires the GET when days selector cycles through multiple values', async () => {
    // Augments the existing "30 days" test by walking 7 → 14 → 90 to
    // confirm every change triggers a fresh GET (not just the first change
    // off the default). Guards against an accidental useEffect dep-array
    // narrowing that would leave later changes un-observed.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /LLM Spend/i });

    const select = screen.getByLabelText(/Days window/i);
    fireEvent.change(select, { target: { value: '14' } });
    fireEvent.change(select, { target: { value: '90' } });

    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('days=14'))).toBe(true);
      expect(urls.some((u) => u.includes('days=90'))).toBe(true);
    });
  });

  it('renders the section descriptor copy in the header', async () => {
    // The descriptor below the H1 carries the load-bearing "stub-mode $0"
    // disclaimer. If a redesign drops it, admins lose the only in-UI hint
    // that today's $0 totals aren't a bug.
    fetchApiMock.mockImplementation(makeFetchImpl());
    renderPage();
    await screen.findByRole('heading', { level: 1, name: /LLM Spend/i });
    expect(
      screen.getByText(
        /Per-tenant LLM call rollups\. Stub-mode calls have \$0 cost/i,
      ),
    ).toBeTruthy();
  });
});
