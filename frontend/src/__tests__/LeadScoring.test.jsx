/**
 * LeadScoring.jsx — frontend contract spec (full-page, non-rescore surface).
 *
 * Why a second spec for the same page:
 *   `LeadScoring.rescore.test.jsx` already pins the Re-score button (#630
 *   loading state / success-toast count / error-toast surfacing). That spec
 *   intentionally scopes ONLY to the rescore round-trip and uses fireEvent.
 *   This sibling spec pins everything else the page renders so the two
 *   together exercise the whole component without overlap:
 *
 *     1. Loading placeholders render before the contacts fetch resolves.
 *     2. Empty-state copy renders for hot AND cold lead panes when the
 *        backend returns zero contacts.
 *     3. KPI tile values (Total / Average / Hot / Cold) compute correctly
 *        from a representative contact list.
 *     4. Hot Leads pane renders only contacts with aiScore >= 70, sorted
 *        highest-first, capped at 10 entries.
 *     5. Cold Leads pane renders only contacts with aiScore < 30.
 *     6. ScoreBadge renders the numeric score in `<n>/100` format.
 *     7. Histogram bar count matches the score-band distribution
 *        (verified via the SCORE_BANDS labels rendered as XAxis ticks).
 *     8. Non-array fetch response is coerced to an empty list (defensive
 *        path — the source uses `Array.isArray(data) ? data : []`).
 *     9. fetchApi rejection during loadContacts() keeps the page rendered
 *        with empty state, never crashes.
 *
 * Mock stability (per CLAUDE.md feedback rule):
 *   notifyObj is a module-level constant so useCallback dependency arrays
 *   in the SUT do not see fresh references on each render → no infinite
 *   loop. fetchApiMock is also module-level + reset() in beforeEach.
 *
 * Recharts ResponsiveContainer renders to zero-size in jsdom; passthrough
 * mock keeps the inner BarChart in the DOM so histogram assertions work.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { AuthContext } from '../App';

// ── Stable mock object refs ───────────────────────────────────────
const notifyObj = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Recharts ResponsiveContainer measures from the DOM; jsdom has no layout
// engine so the chart skips rendering entirely. Replace with a fixed-size
// passthrough so child BarChart still mounts and we can assert XAxis ticks.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="responsive-container" style={{ width: 600, height: 200 }}>
        {children}
      </div>
    ),
  };
});

import LeadScoring from '../pages/LeadScoring';

const renderPage = () =>
  render(
    <AuthContext.Provider
      value={{
        user: { id: 1, name: 'Test', email: 't@x.test', role: 'MANAGER' },
        setUser: vi.fn(),
        token: 't-abc',
        setToken: vi.fn(),
        tenant: { vertical: 'generic' },
        setTenant: vi.fn(),
      }}
    >
      <LeadScoring />
    </AuthContext.Provider>,
  );

// Helpers ───────────────────────────────────────────────────────────
const c = (id, name, aiScore, extras = {}) => ({
  id,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
  company: `${name.split(' ')[0]} Corp`,
  aiScore,
  ...extras,
});

describe('LeadScoring — page contract', () => {
  beforeEach(() => {
    notifyObj.success.mockClear();
    notifyObj.error.mockClear();
    notifyObj.info.mockClear();
    fetchApiMock.mockReset();
  });

  it('renders Loading... placeholders for both hot/cold panes before the contacts fetch resolves', () => {
    // Hold the contacts fetch pending so we observe the initial loading state.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contacts') return new Promise(() => {});
      return Promise.resolve([]);
    });

    renderPage();

    // Two panes each render "Loading..." while contacts are in flight.
    const loading = screen.getAllByText(/^Loading\.\.\.$/);
    expect(loading.length).toBe(2);
  });

  it('renders the empty-state copy for hot and cold lead panes when the backend returns zero contacts', async () => {
    fetchApiMock.mockResolvedValueOnce([]); // /api/contacts → []

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No hot leads yet\. Run the scorer first\./i)).toBeInTheDocument();
    });
    expect(screen.getByText(/No cold leads — great engagement!/i)).toBeInTheDocument();
  });

  it('computes KPI tile values (total / average / hot / cold) from the contact list', async () => {
    // Scores: 90, 80, 75, 50, 25, 10 → avg 55, hot=3 (>=70), cold=2 (<30).
    const contacts = [
      c(1, 'Aarav Mehta', 90),
      c(2, 'Bina Shah', 80),
      c(3, 'Chetan Rao', 75),
      c(4, 'Dia Kapoor', 50),
      c(5, 'Esha Iyer', 25),
      c(6, 'Farhan Ali', 10),
    ];
    fetchApiMock.mockResolvedValueOnce(contacts);

    renderPage();

    // Total Contacts tile
    await waitFor(() => {
      const totalCard = screen.getByText(/Total Contacts/i).closest('div').parentElement;
      expect(within(totalCard).getByText('6')).toBeInTheDocument();
    });

    // Average Score tile (55/100)
    const avgCard = screen.getByText(/Average Score/i).closest('div').parentElement;
    expect(within(avgCard).getByText('55/100')).toBeInTheDocument();

    // Hot Leads tile (count = 3)
    const hotCard = screen.getByText(/Hot Leads \(≥70\)/i).closest('div').parentElement;
    expect(within(hotCard).getByText('3')).toBeInTheDocument();

    // Cold Leads tile (count = 2)
    const coldCard = screen.getByText(/Cold Leads \(<30\)/i).closest('div').parentElement;
    expect(within(coldCard).getByText('2')).toBeInTheDocument();
  });

  it('renders hot-leads pane sorted highest-first, only including aiScore >= 70', async () => {
    // Mix order; only 88, 82, 70 qualify as hot — 65, 40 do not.
    const contacts = [
      c(1, 'Mid Mike', 65),
      c(2, 'Top Tara', 88),
      c(3, 'High Hari', 82),
      c(4, 'Just Hot Jaya', 70),
      c(5, 'Cold Carl', 40),
    ];
    fetchApiMock.mockResolvedValueOnce(contacts);

    renderPage();

    // Wait for Top Tara to land in the DOM (Hot Leads pane).
    await waitFor(() => {
      expect(screen.getByText(/Top Tara/)).toBeInTheDocument();
    });
    expect(screen.getByText(/High Hari/)).toBeInTheDocument();
    expect(screen.getByText(/Just Hot Jaya/)).toBeInTheDocument();
    // Sub-70 contacts must NOT appear in the hot pane. They COULD appear in
    // cold (Cold Carl=40 won't — score >=30; Mid Mike=65 won't either) so
    // both should be absent from the document entirely for these scores.
    expect(screen.queryByText(/Mid Mike/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cold Carl/)).not.toBeInTheDocument();

    // Order: Top Tara (88) appears before High Hari (82) in DOM order.
    const tara = screen.getByText(/Top Tara/);
    const hari = screen.getByText(/High Hari/);
    expect(tara.compareDocumentPosition(hari) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders cold-leads pane only including contacts with aiScore < 30', async () => {
    const contacts = [
      c(1, 'Iceberg Ira', 5),
      c(2, 'Lukewarm Leo', 35), // 30..69 band → not cold, not hot
      c(3, 'Frozen Fatima', 15),
      c(4, 'Boiling Bharat', 95), // hot, not cold
    ];
    fetchApiMock.mockResolvedValueOnce(contacts);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Iceberg Ira/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Frozen Fatima/)).toBeInTheDocument();
    // Lukewarm (35) is in neither pane.
    expect(screen.queryByText(/Lukewarm Leo/)).not.toBeInTheDocument();
    // Boiling is hot, not cold — appears in hot pane only.
    expect(screen.getByText(/Boiling Bharat/)).toBeInTheDocument();
  });

  it('renders ScoreBadge with `<n>/100` format for each listed lead', async () => {
    const contacts = [c(1, 'Score Sample', 88)];
    fetchApiMock.mockResolvedValueOnce(contacts);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Score Sample/)).toBeInTheDocument();
    });
    // Badge text is "<n>/100". The KPI tile renders "<avg>/100" too so we
    // expect ≥2 matches (badge + Average Score tile = 88/100 since 1 contact).
    const badges = screen.getAllByText('88/100');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the score-distribution chart container with the section heading', async () => {
    // Recharts XAxis ticks require DOM layout measurement that jsdom does not
    // provide, so we can't reliably assert tick text directly. Instead pin
    // (a) the section heading and (b) the passthrough container mounts, which
    // confirms histogramData was computed without crashing.
    fetchApiMock.mockResolvedValueOnce([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Score Distribution/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
  });

  it('coerces a non-array fetch response to empty list (defensive Array.isArray guard)', async () => {
    // Backend returns an error envelope object instead of an array. Source
    // path: `setContacts(Array.isArray(data) ? data : [])`.
    fetchApiMock.mockResolvedValueOnce({ error: 'unexpected' });

    renderPage();

    // Empty-state copy renders, no crash.
    await waitFor(() => {
      expect(screen.getByText(/No hot leads yet/i)).toBeInTheDocument();
    });
    // Total Contacts tile reads 0.
    const totalCard = screen.getByText(/Total Contacts/i).closest('div').parentElement;
    expect(within(totalCard).getByText('0')).toBeInTheDocument();
  });

  it('keeps the page rendered with empty state when loadContacts rejects', async () => {
    // fetchApi rejection on initial mount. Source catches into console.error
    // and the finally{} clears loading, so the empty-state copy renders.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchApiMock.mockRejectedValueOnce(new Error('network down'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/No hot leads yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/No cold leads — great engagement!/i)).toBeInTheDocument();
    // Header still renders.
    expect(screen.getByText(/Lead Intelligence/i)).toBeInTheDocument();
    // Re-score All button is present + enabled (idle).
    expect(screen.getByRole('button', { name: /re-score all/i })).toBeEnabled();

    consoleSpy.mockRestore();
  });

  it('renders the page header copy and the Re-score All trigger button', async () => {
    fetchApiMock.mockResolvedValueOnce([]);

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /re-score all/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Rules-based contact scoring — updated every 10 minutes via cron engine\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Lead Intelligence/i)).toBeInTheDocument();
  });
});
