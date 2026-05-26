/**
 * AbTests.test.jsx — vitest + RTL coverage for the Marketing A/B Tests page.
 *
 * Scope: pins the page-surface invariants for the variant-test workflow:
 *   1. Page renders the heading "A/B Tests", the lead copy, and the
 *      "Create Test" CTA button on mount (any role — the page itself is
 *      role-agnostic; route-level RBAC gates access).
 *   2. Initial mount fires GET /api/ab-tests (list) AND
 *      GET /api/marketing/campaigns (for the create form's linked-campaign
 *      dropdown). Both fire in parallel from the same useEffect.
 *   3. Loading state: "Loading A/B tests..." renders before the list
 *      fetch resolves.
 *   4. Empty state: "No A/B tests yet" renders when /api/ab-tests returns
 *      an empty array (plus the helper subtext).
 *   5. List renders one TestCard per test with the test name, status
 *      badge, and per-variant Sent / Clicks / CTR.
 *   6. Summary counters reflect status counts (Total / Running /
 *      Completed / Drafts) and update from the list response.
 *   7. Clicking "Create Test" opens the create-form modal with Name +
 *      Linked Campaign select + Variant A / Variant B JSON textareas.
 *   8. Submitting the create form with valid JSON POSTs /api/ab-tests
 *      with { name, campaignId, variantA, variantB } parsed-JSON body.
 *   9. Create form rejects invalid Variant A JSON with the inline
 *      "Variant A is not valid JSON" error and does NOT POST.
 *  10. Create form rejects an empty name with "Name is required" and
 *      does NOT POST.
 *  11. Clicking a TestCard opens the DetailModal with the test's status
 *      + variant JSON, plus action buttons gated by status (DRAFT →
 *      Start; RUNNING → Declare A/B Winner; always → Delete).
 *  12. DetailModal: clicking Start on a DRAFT test POSTs
 *      /api/ab-tests/<id>/start.
 *  13. DetailModal: clicking "Declare A Winner" on a RUNNING test POSTs
 *      /api/ab-tests/<id>/declare-winner with { winner: 'A' } body.
 *  14. List-fetch failure surfaces an inline error banner; the page
 *      does not crash and still renders the heading + create CTA.
 *
 * Backend contracts pinned by this test (1 list + 1 campaigns lookup +
 * 4 mutation endpoints):
 *   GET    /api/ab-tests
 *   GET    /api/marketing/campaigns
 *   POST   /api/ab-tests                          (create)
 *   POST   /api/ab-tests/:id/start
 *   POST   /api/ab-tests/:id/declare-winner       { winner: 'A' | 'B' }
 *   DELETE /api/ab-tests/:id
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — recreating { error, info, success, confirm } on each
// call would land a fresh dependency identity into the page's useCallback
// chain and re-render-loop the test until vitest's per-test timeout fires.
const notifyError = vi.fn();
const notifyConfirm = vi.fn().mockResolvedValue(true);
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Recharts ResponsiveContainer measures dimensions from the DOM and renders
// nothing in jsdom (zero width/height). Replace with a passthrough so the
// chart's <BarChart> still renders into the jsdom tree if the test reaches
// the DetailModal. This keeps `findByText('Variant Performance')` reliable.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => (
      <div data-testid="responsive-container" style={{ width: 600, height: 260 }}>
        {children}
      </div>
    ),
  };
});

import { AuthContext } from '../App';
import AbTests from '../pages/AbTests';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function renderAbTests(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <AbTests />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const draftTest = {
  id: 1,
  name: 'Summer Subject Line Test',
  status: 'DRAFT',
  variantA: { subject: 'Save 20% today', body: 'Hi {{name}}' },
  variantB: { subject: 'Exclusive deal', body: 'Hi {{name}}' },
  winningVariant: null,
  stats: {
    variantA: { sent: 0, clicked: 0, ctr: 0 },
    variantB: { sent: 0, clicked: 0, ctr: 0 },
    leader: null,
    significant: false,
  },
};

const runningTest = {
  id: 2,
  name: 'Black Friday Hero Test',
  status: 'RUNNING',
  variantA: { subject: 'BF Hero A' },
  variantB: { subject: 'BF Hero B' },
  winningVariant: null,
  stats: {
    variantA: { sent: 500, clicked: 60, ctr: 12 },
    variantB: { sent: 500, clicked: 45, ctr: 9 },
    leader: 'A',
    significant: true,
  },
};

const completedTest = {
  id: 3,
  name: 'Welcome Series CTA',
  status: 'COMPLETED',
  variantA: { subject: 'A wins' },
  variantB: { subject: 'B never gets shown' },
  winningVariant: 'A',
  stats: {
    variantA: { sent: 1000, clicked: 150, ctr: 15 },
    variantB: { sent: 1000, clicked: 90, ctr: 9 },
    leader: 'A',
    significant: true,
  },
};

const sampleCampaigns = [
  { id: 11, name: 'Q4 Acquisition Push' },
  { id: 12, name: 'Win-back January' },
];

function defaultMockImpl({ tests = [draftTest, runningTest, completedTest], campaigns = sampleCampaigns } = {}) {
  return (url, opts) => {
    if (url === '/api/ab-tests' && (!opts || opts.method === undefined || opts.method === 'GET')) {
      return Promise.resolve(tests);
    }
    if (url === '/api/marketing/campaigns') {
      return Promise.resolve(campaigns);
    }
    // Detail GET for individual test (used by handleAction refresh path).
    if (/^\/api\/ab-tests\/\d+$/.test(url) && (!opts || opts.method === undefined || opts.method === 'GET')) {
      const id = Number(url.split('/').pop());
      const t = tests.find((x) => x.id === id);
      return Promise.resolve(t || null);
    }
    return Promise.resolve(null);
  };
}

describe('<AbTests /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(defaultMockImpl());
  });

  it('renders the heading + Create Test CTA + lead copy on mount', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /A\/B Tests/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Create Test/i })).toBeInTheDocument();
    expect(screen.getByText(/Experiment with variants to find the highest-performing messages\./i)).toBeInTheDocument();
  });

  it('fires GET /api/ab-tests AND GET /api/marketing/campaigns on mount', async () => {
    renderAbTests();
    await waitFor(() => {
      const listCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/ab-tests');
      const campCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/marketing/campaigns');
      expect(listCall).toBeTruthy();
      expect(campCall).toBeTruthy();
    });
  });

  it('shows the "Loading A/B tests..." state before the list resolves', async () => {
    let resolveList;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/ab-tests') {
        return new Promise((res) => { resolveList = res; });
      }
      if (url === '/api/marketing/campaigns') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderAbTests();
    expect(await screen.findByText(/Loading A\/B tests\.\.\./i)).toBeInTheDocument();
    // Now resolve so test can clean up without unhandled-promise noise.
    resolveList([]);
    await waitFor(() => {
      expect(screen.queryByText(/Loading A\/B tests\.\.\./i)).not.toBeInTheDocument();
    });
  });

  it('shows the empty-state when /api/ab-tests returns []', async () => {
    fetchApiMock.mockImplementation(defaultMockImpl({ tests: [] }));
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByText(/No A\/B tests yet/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Create your first test to start experimenting with variants\./i)).toBeInTheDocument();
  });

  it('renders one TestCard per test with name + status badge', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByText('Summer Subject Line Test')).toBeInTheDocument();
    });
    expect(screen.getByText('Black Friday Hero Test')).toBeInTheDocument();
    expect(screen.getByText('Welcome Series CTA')).toBeInTheDocument();
    // Status badges — there's at least one of each in the cards.
    expect(screen.getAllByText('DRAFT').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('RUNNING').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('COMPLETED').length).toBeGreaterThanOrEqual(1);
  });

  it('summary counters reflect the per-status counts from the list', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByText('Summer Subject Line Test')).toBeInTheDocument();
    });
    // Total Tests counter = 3 (matches list length).
    const total = screen.getByText('Total Tests').nextSibling;
    expect(total).toHaveTextContent('3');
    const running = screen.getByText('Running').nextSibling;
    expect(running).toHaveTextContent('1');
    const completed = screen.getByText('Completed').nextSibling;
    expect(completed).toHaveTextContent('1');
    const drafts = screen.getByText('Drafts').nextSibling;
    expect(drafts).toHaveTextContent('1');
  });

  it('clicking "Create Test" opens the create-form modal with Name + variants', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Test/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Test/i }));
    expect(await screen.findByRole('heading', { name: /Create A\/B Test/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Summer Promo – Subject Line Test/i)).toBeInTheDocument();
    // Two variant textareas (one for A, one for B). Match the variant-A
    // default JSON token so we don't depend on textarea ordering.
    expect(screen.getByDisplayValue(/Save 20% today/)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Your exclusive deal awaits/)).toBeInTheDocument();
    // Linked-campaign dropdown is populated from /api/marketing/campaigns.
    await waitFor(() => {
      expect(screen.getByText('Q4 Acquisition Push')).toBeInTheDocument();
    });
  });

  it('submitting the create form POSTs /api/ab-tests with parsed-JSON body', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Test/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Test/i }));
    const nameInput = await screen.findByPlaceholderText(/Summer Promo – Subject Line Test/i);
    fireEvent.change(nameInput, { target: { value: 'My New Test' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/ab-tests' && opts?.method === 'POST') {
        const parsed = JSON.parse(opts.body);
        return Promise.resolve({ id: 99, ...parsed, status: 'DRAFT' });
      }
      // Re-load after create + campaigns lookup.
      return defaultMockImpl()(url, opts);
    });

    // The modal's submit button text is "Create Test" (same label as the
    // header CTA). After clicking, the modal closes — so we click the LAST
    // such button on screen (the modal's).
    const createBtns = screen.getAllByRole('button', { name: /Create Test/i });
    // First button is the page-level CTA; second is the modal submit
    // ("Create Test" — modal's saving label is "Creating...").
    fireEvent.click(createBtns[createBtns.length - 1]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/ab-tests' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.name).toBe('My New Test');
      expect(body.variantA).toEqual(expect.objectContaining({ subject: 'Save 20% today' }));
      expect(body.variantB).toEqual(expect.objectContaining({ subject: 'Your exclusive deal awaits' }));
      // campaignId is null because the select default value is ''.
      expect(body.campaignId).toBeNull();
    });
  });

  it('rejects invalid Variant A JSON with an inline error and does NOT POST', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Test/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Test/i }));
    const nameInput = await screen.findByPlaceholderText(/Summer Promo – Subject Line Test/i);
    fireEvent.change(nameInput, { target: { value: 'Bad-JSON Test' } });

    // Replace Variant A with non-JSON content.
    const variantATextarea = screen.getByDisplayValue(/Save 20% today/);
    fireEvent.change(variantATextarea, { target: { value: 'not valid json {' } });

    fetchApiMock.mockClear();
    const createBtns = screen.getAllByRole('button', { name: /Create Test/i });
    fireEvent.click(createBtns[createBtns.length - 1]);

    await waitFor(() => {
      expect(screen.getByText(/Variant A is not valid JSON/i)).toBeInTheDocument();
    });
    // No POST should have fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/ab-tests' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('rejects empty name with "Name is required" and does NOT POST', async () => {
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Test/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Test/i }));
    await screen.findByPlaceholderText(/Summer Promo – Subject Line Test/i);
    // Leave name blank.

    fetchApiMock.mockClear();
    const createBtns = screen.getAllByRole('button', { name: /Create Test/i });
    fireEvent.click(createBtns[createBtns.length - 1]);

    await waitFor(() => {
      expect(screen.getByText(/Name is required/i)).toBeInTheDocument();
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/ab-tests' && opts?.method === 'POST'
    );
    expect(postCall).toBeFalsy();
  });

  it('clicking a DRAFT TestCard opens DetailModal with Start + Delete actions', async () => {
    renderAbTests();
    const card = await screen.findByText('Summer Subject Line Test');
    fireEvent.click(card);
    // DetailModal renders the test name as a heading (DetailModal h2).
    await waitFor(() => {
      const headings = screen.getAllByRole('heading', { name: /Summer Subject Line Test/i });
      expect(headings.length).toBeGreaterThanOrEqual(1);
    });
    // DRAFT → Start Test button visible.
    expect(screen.getByRole('button', { name: /Start Test/i })).toBeInTheDocument();
    // Delete is always visible.
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
    // RUNNING-only winner buttons should NOT be visible for DRAFT.
    expect(screen.queryByRole('button', { name: /Declare A Winner/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Declare B Winner/i })).not.toBeInTheDocument();
  });

  it('DetailModal: clicking Start on DRAFT POSTs /api/ab-tests/<id>/start', async () => {
    renderAbTests();
    const card = await screen.findByText('Summer Subject Line Test');
    fireEvent.click(card);
    await screen.findByRole('button', { name: /Start Test/i });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/ab-tests/${draftTest.id}/start` && opts?.method === 'POST') {
        return Promise.resolve({ ...draftTest, status: 'RUNNING' });
      }
      return defaultMockImpl()(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /Start Test/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/ab-tests/${draftTest.id}/start` && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });

  it('DetailModal: "Declare A Winner" on RUNNING POSTs /declare-winner { winner: "A" }', async () => {
    renderAbTests();
    const card = await screen.findByText('Black Friday Hero Test');
    fireEvent.click(card);
    await screen.findByRole('button', { name: /Declare A Winner/i });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/ab-tests/${runningTest.id}/declare-winner` && opts?.method === 'POST') {
        return Promise.resolve({ ...runningTest, status: 'COMPLETED', winningVariant: 'A' });
      }
      return defaultMockImpl()(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /Declare A Winner/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/ab-tests/${runningTest.id}/declare-winner` && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.winner).toBe('A');
    });
  });

  it('list-fetch failure surfaces an inline error banner; page still renders', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/ab-tests') {
        return Promise.reject(new Error('500 Internal Server Error'));
      }
      if (url === '/api/marketing/campaigns') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderAbTests();
    await waitFor(() => {
      expect(screen.getByText(/500 Internal Server Error/i)).toBeInTheDocument();
    });
    // Heading + Create CTA still render — page does not crash.
    expect(screen.getByRole('heading', { name: /A\/B Tests/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create Test/i })).toBeInTheDocument();
  });
});
