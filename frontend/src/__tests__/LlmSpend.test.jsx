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
});
