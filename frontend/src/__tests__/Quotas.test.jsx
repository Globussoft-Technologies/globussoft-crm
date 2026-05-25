/**
 * Quotas.test.jsx — vitest + RTL coverage for the Sales Quotas page.
 *
 * Target: frontend/src/pages/Quotas.jsx (364 LOC) — rep target / attainment
 * tracking page used by sales managers. NO prior test file existed.
 *
 * Scope: pins page-surface invariants for the daily-use quota workflow.
 * No role-gating chrome lives in this page (server-side RBAC on the
 * underlying /api/quotas routes does the gating); the component itself is
 * uniformly rendered for any authenticated user. We pin the rendered
 * surface + the fetch contracts.
 *
 *   1. Mount fetches /api/staff (for the user-picker in the create modal)
 *      AND /api/quotas/attainment?period=<current-quarter> (table view is
 *      the default).
 *   2. Heading "Sales Quotas" + period dropdown + Table/Leaderboard toggle
 *      + "Set Quota" CTA all render.
 *   3. Loading state: "Loading quotas…" renders before the initial
 *      attainment fetch resolves.
 *   4. With attainment rows: per-rep row renders the name, target,
 *      achieved, and attainment % in the table view.
 *   5. KPI tiles render: Reps with Quota / Team Target / Team Achieved /
 *      Team Attainment, with the team attainment % computed client-side
 *      from sum(achieved) / sum(target).
 *   6. Empty table: "No quotas configured for <period>" empty row renders
 *      when /attainment returns [].
 *   7. Flipping to Leaderboard view fires /api/quotas/leaderboard instead
 *      of /api/quotas/attainment (different endpoint, same shape).
 *   8. Empty leaderboard: "No quotas set for this period yet." copy
 *      renders when /leaderboard returns [].
 *   9. Changing the period dropdown re-fires the active endpoint with the
 *      new ?period= value (e.g. next quarter).
 *  10. Clicking "Set Quota" opens the modal with the Sales-Rep <select>
 *      populated from /api/staff + a target-amount input. Submitting POSTs
 *      /api/quotas with { userId, period, target } and closes the modal.
 *  11. Edit-from-row: clicking the row Edit button opens the modal in edit
 *      mode (no Sales-Rep picker), submitting PUTs /api/quotas/<id>
 *      with { target } (no userId/period).
 *  12. Delete row with confirm() → fires DELETE /api/quotas/<id> and
 *      re-loads the attainment list.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — passed by reference to every render. Re-creating
// `{ confirm: vi.fn() }` per useNotify() call would invalidate the page's
// useCallback dependencies and cause the delete handler to flap.
const notifyError = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// money helpers — pin to deterministic locale-free output so tests don't
// depend on the test runner's Intl/ICU build (cf. the 2026-05-07 wave-6 TZ
// label cron-learning — same class of ICU-portability hazard).
vi.mock('../utils/money', () => ({
  formatMoney: (n) => `$${Number(n || 0).toLocaleString('en-US')}`,
  currencySymbol: () => '$',
}));

// Recharts ResponsiveContainer needs layout it can't get in jsdom. Stub the
// chart subtree so the leaderboard view renders deterministically — the
// chart's contract is "passes leaderboardData rows through to <Bar>", which
// we pin via the rest of the component's surface.
vi.mock('recharts', async () => {
  const actual = await vi.importActual('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }) => <div data-testid="rc">{children}</div>,
  };
});

import Quotas from '../pages/Quotas';

const sampleStaff = [
  { id: 1, name: 'Alice Rep', email: 'alice@example.com', role: 'USER' },
  { id: 2, name: 'Bob Manager', email: 'bob@example.com', role: 'MANAGER' },
];

const sampleAttainment = [
  {
    quotaId: 100,
    userId: 1,
    name: 'Alice Rep',
    target: 100000,
    achieved: 75000,
    attainmentPct: 75,
  },
  {
    quotaId: 101,
    userId: 2,
    name: 'Bob Manager',
    target: 200000,
    achieved: 220000,
    attainmentPct: 110,
  },
];

function defaultFetchMock(url) {
  if (url === '/api/staff') return Promise.resolve(sampleStaff);
  if (url.startsWith('/api/quotas/attainment')) return Promise.resolve(sampleAttainment);
  if (url.startsWith('/api/quotas/leaderboard')) return Promise.resolve(sampleAttainment);
  return Promise.resolve(null);
}

function renderQuotas() {
  return render(<Quotas />);
}

describe('<Quotas /> — Sales Quotas page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('mounts and fires /api/staff + /api/quotas/attainment?period=<current-quarter>', async () => {
    renderQuotas();
    await waitFor(() => {
      const staffCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/staff');
      expect(staffCall).toBeTruthy();
    });
    // The default view is `table`, so the attainment endpoint (NOT leaderboard)
    // fires on mount. The period is the current quarter (YYYY-Q#) computed
    // client-side; we just assert the URL prefix + a ?period= param exists.
    await waitFor(() => {
      const attCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/quotas/attainment?period=')
      );
      expect(attCall).toBeTruthy();
    });
  });

  it('renders heading + period dropdown + Table/Leaderboard toggle + Set Quota CTA', async () => {
    renderQuotas();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Sales Quotas/i })).toBeInTheDocument();
    });
    // View-toggle buttons.
    expect(screen.getByRole('button', { name: /Table/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Leaderboard/i })).toBeInTheDocument();
    // Set Quota CTA.
    expect(screen.getByRole('button', { name: /Set Quota/i })).toBeInTheDocument();
    // Period dropdown — current-quarter option is selected by default.
    expect(screen.getByText(/Current Quarter/i)).toBeInTheDocument();
  });

  it('shows "Loading quotas…" before the initial /attainment fetch resolves', async () => {
    let resolveAttainment;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url.startsWith('/api/quotas/attainment')) {
        return new Promise((r) => { resolveAttainment = r; });
      }
      return Promise.resolve(null);
    });
    renderQuotas();
    expect(await screen.findByText(/Loading quotas…/i)).toBeInTheDocument();
    // Resolve so the test tears down cleanly.
    resolveAttainment([]);
  });

  it('table view: one row per attainment entry shows name + target + achieved + %', async () => {
    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    expect(screen.getByText('Bob Manager')).toBeInTheDocument();
    // Money values rendered via the mocked formatMoney.
    expect(screen.getByText('$100,000')).toBeInTheDocument();
    expect(screen.getByText('$75,000')).toBeInTheDocument();
    expect(screen.getByText('$200,000')).toBeInTheDocument();
    expect(screen.getByText('$220,000')).toBeInTheDocument();
    // Attainment % column — "75%" appears twice (Alice's row + the
    // Team Attainment KPI), and "110%" once (Bob's row).
    expect(screen.getAllByText(/75%/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/110%/)).toBeInTheDocument();
  });

  it('renders the KPI tiles: Reps with Quota / Team Target / Team Achieved / Team Attainment', async () => {
    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    // Tile labels render.
    expect(screen.getByText(/Reps with Quota/i)).toBeInTheDocument();
    expect(screen.getByText(/Team Target/i)).toBeInTheDocument();
    expect(screen.getByText(/Team Achieved/i)).toBeInTheDocument();
    expect(screen.getByText(/Team Attainment/i)).toBeInTheDocument();
    // Reps-with-Quota tile shows the count of rows from /attainment.
    expect(screen.getByText('2')).toBeInTheDocument();
    // Team totals: target = 100k+200k = 300k; achieved = 75k+220k = 295k;
    // attainment = round(295000/300000*1000)/10 = 98.3%.
    expect(screen.getByText('$300,000')).toBeInTheDocument();
    expect(screen.getByText('$295,000')).toBeInTheDocument();
    expect(screen.getByText(/98\.3%/)).toBeInTheDocument();
  });

  it('shows "No quotas configured for <period>" when /attainment returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url.startsWith('/api/quotas/attainment')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderQuotas();
    await waitFor(() => {
      expect(screen.getByText(/No quotas configured for/i)).toBeInTheDocument();
    });
  });

  it('switching to Leaderboard view fires /api/quotas/leaderboard instead of /attainment', async () => {
    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Leaderboard/i }));
    await waitFor(() => {
      const lbCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/quotas/leaderboard?period=')
      );
      expect(lbCall).toBeTruthy();
      // And /attainment must NOT have fired during this view-flip.
      const attCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/quotas/attainment')
      );
      expect(attCall).toBeUndefined();
    });
  });

  it('leaderboard empty-state: "No quotas set for this period yet." renders when /leaderboard returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url.startsWith('/api/quotas/leaderboard')) return Promise.resolve([]);
      if (url.startsWith('/api/quotas/attainment')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderQuotas();
    // Wait for initial table-view empty-state to settle first.
    await waitFor(() => expect(screen.getByText(/No quotas configured for/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Leaderboard/i }));
    await waitFor(() => {
      expect(screen.getByText(/No quotas set for this period yet\./i)).toBeInTheDocument();
    });
  });

  it('changing the period dropdown re-fires the active endpoint with the new ?period=', async () => {
    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());

    // The period <select> doesn't carry a role label, but it's the only
    // <select> that's not inside the closed modal. Grab the select that
    // currently shows the current-quarter option as selected.
    const allSelects = document.querySelectorAll('select');
    const periodSelect = Array.from(allSelects).find(
      (s) => s.value && /^\d{4}-Q\d$/.test(s.value),
    );
    expect(periodSelect).toBeTruthy();

    // Find a "Next Quarter" option to pick — its value is also YYYY-Q#.
    const nextOption = Array.from(periodSelect.options).find(
      (o) => /Next Quarter/i.test(o.textContent),
    );
    expect(nextOption).toBeTruthy();

    fetchApiMock.mockClear();
    fireEvent.change(periodSelect, { target: { value: nextOption.value } });

    await waitFor(() => {
      const reFire = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/quotas/attainment?period=')
        && u.includes(encodeURIComponent(nextOption.value)),
      );
      expect(reFire).toBeTruthy();
    });
  });

  it('Set Quota opens the modal with the Sales-Rep <select>; submit POSTs /api/quotas with userId+period+target', async () => {
    let postBody = null;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url === '/api/quotas' && opts?.method === 'POST') {
        postBody = JSON.parse(opts.body);
        return Promise.resolve({ id: 999 });
      }
      if (url.startsWith('/api/quotas/attainment')) return Promise.resolve(sampleAttainment);
      return Promise.resolve(null);
    });

    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Set Quota/i }));

    // Modal opens — the Sales Rep <select> renders (only present in create
    // mode; absent in edit mode). The page pre-selects users[0].id, so the
    // Save button will go through with no user interaction required, but
    // we explicitly set it to pin the wire-up.
    const allSelects = document.querySelectorAll('select');
    // Modal's Sales-Rep select is the one whose option values match staff ids.
    const repSelect = Array.from(allSelects).find(
      (s) => Array.from(s.options).some((o) => o.value === '1' || o.value === '2'),
    );
    expect(repSelect).toBeTruthy();
    fireEvent.change(repSelect, { target: { value: '1' } });

    // Target amount input — only number input in the modal.
    const targetInput = document.querySelector('input[type="number"]');
    expect(targetInput).toBeTruthy();
    fireEvent.change(targetInput, { target: { value: '50000' } });

    // Submit via the form's Save button.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      expect(postBody).not.toBeNull();
      expect(postBody.userId).toBe(1);
      expect(postBody.target).toBe(50000);
      expect(typeof postBody.period).toBe('string');
      expect(postBody.period).toMatch(/^\d{4}(-Q\d)?$/);
    });
  });

  it('row Edit opens the modal in edit mode (no Sales-Rep picker) and submit PUTs /api/quotas/<id> with { target }', async () => {
    let putUrl = null;
    let putBody = null;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url.startsWith('/api/quotas/') && opts?.method === 'PUT') {
        putUrl = url;
        putBody = JSON.parse(opts.body);
        return Promise.resolve({ id: 100 });
      }
      if (url.startsWith('/api/quotas/attainment')) return Promise.resolve(sampleAttainment);
      return Promise.resolve(null);
    });

    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());

    // Row Edit button — title="Edit target" disambiguates from any other
    // edit affordance.
    const editBtns = document.querySelectorAll('button[title="Edit target"]');
    expect(editBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(editBtns[0]); // Alice's row (first).

    // Modal opens in edit mode — heading flips to "Edit Quota" + the
    // Sales-Rep <select> is NOT rendered. Period input is disabled.
    expect(await screen.findByRole('heading', { name: /Edit Quota/i })).toBeInTheDocument();
    // No Sales-Rep label/select in edit mode (the !form.id branch).
    expect(screen.queryByText(/^Sales Rep$/i)).not.toBeInTheDocument();

    // Set a new target.
    const targetInput = document.querySelector('input[type="number"]');
    fireEvent.change(targetInput, { target: { value: '120000' } });

    // Submit button label is "Update" in edit mode.
    fireEvent.click(screen.getByRole('button', { name: /^Update$/ }));

    await waitFor(() => {
      expect(putUrl).toBe('/api/quotas/100');
      expect(putBody).toEqual({ target: 120000 });
    });
  });

  it('row Delete with confirm() → fires DELETE /api/quotas/<id> and re-loads attainment', async () => {
    let deletedUrl = null;
    let attainmentCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url.startsWith('/api/quotas/') && opts?.method === 'DELETE') {
        deletedUrl = url;
        return Promise.resolve({ ok: true });
      }
      if (url.startsWith('/api/quotas/attainment')) {
        attainmentCallCount += 1;
        return Promise.resolve(sampleAttainment);
      }
      return Promise.resolve(null);
    });

    renderQuotas();
    await waitFor(() => expect(screen.getByText('Alice Rep')).toBeInTheDocument());
    const initialAttCount = attainmentCallCount;

    // Row Delete button — title="Delete quota".
    const deleteBtns = document.querySelectorAll('button[title="Delete quota"]');
    expect(deleteBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(deleteBtns[0]); // Alice's row.

    // confirm() must have been called with the row name in the message.
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
      const arg = notifyConfirm.mock.calls[0][0];
      expect(arg.message).toMatch(/Alice Rep/);
      expect(arg.destructive).toBe(true);
    });

    // DELETE fires for that quotaId; attainment re-fetches once after.
    await waitFor(() => {
      expect(deletedUrl).toBe('/api/quotas/100');
      expect(attainmentCallCount).toBeGreaterThan(initialAttCount);
    });
  });
});
