/**
 * Contracts.test.jsx — vitest + RTL page-level smoke for the Contracts page
 * (frontend/src/pages/Contracts.jsx, 364 LOC, NO existing test as of
 * 2026-05-25).
 *
 * Scope: pins the page-surface invariants for the contract lifecycle —
 * create, activate, terminate, delete. Mirrors the Estimates.test.jsx /
 * Expenses.test.jsx pattern (page-level smoke for a finance ledger).
 *
 *   1. Page renders heading "Contracts" + intro paragraph + "Create
 *      Contract" form panel + "All Contracts" table panel.
 *   2. Stats bar surfaces "{n} Draft", "{n} Active", and a formatted
 *      "$<active-total> active value" chip. Counts come from a pure
 *      client-side filter over the loaded list.
 *   3. Initial mount fires GET /api/contracts + GET /api/contacts +
 *      GET /api/deals in parallel via Promise.all.
 *   4. Empty list renders the "No contracts yet…" placeholder when
 *      /api/contracts returns [].
 *   5. Populated list renders one <tr> per contract with title, contact
 *      name (or em-dash), deal title (or em-dash), $-formatted value,
 *      StatusBadge, formatted start/end dates.
 *   6. Contact dropdown lists every loaded contact as "Name (email)".
 *      Deal dropdown lists every loaded deal as "title - $amount".
 *   7. Submitting the create form POSTs /api/contracts with the full
 *      form body (title, contactId, dealId, value, dates, terms), then
 *      clears the form + reloads the data set.
 *   8. Failed create surfaces notify.error('Failed to create contract').
 *   9. "Activate" button on a Draft row PUTs /api/contracts/:id with
 *      { status: 'Active' } and triggers a reload.
 *  10. "Terminate" button on an Active row PUTs /api/contracts/:id with
 *      { status: 'Terminated' } and triggers a reload.
 *  11. Active rows render Terminate + Delete (no Activate); Terminated
 *      rows render Delete only (no Activate, no Terminate).
 *  12. Delete confirms via notify.confirm; cancelling the confirm skips
 *      the DELETE call; confirming fires DELETE /api/contracts/:id.
 *  13. Active value chip aggregates Active-status rows only (Draft +
 *      Terminated values excluded) — the canonical pin for the
 *      filter-aware total.
 *
 * Drift / contract notes:
 *   - Status labels (Draft, Active, Terminated) appear in BOTH the stats
 *     pills AND the StatusBadge cells, so use getAllByText with
 *     length >= N. Same pattern Estimates.test.jsx + Expenses.test.jsx
 *     use for filter-chrome-vs-row-badge collisions.
 *   - "Create Contract" appears as the form panel heading AND the submit
 *     button label, so use getAllByText with length >= 2 to assert
 *     presence. Same trick Estimates uses for "Create Estimate".
 *   - The page uses notify.confirm (custom modal) for delete; activate
 *     and terminate fire without confirmation by design.
 *   - The page does NOT render any role-gated controls (no ADMIN/MANAGER
 *     toggles in the source as of 2026-05-25) — every action button is
 *     visible to every authenticated user. Pinned as-is; RBAC is enforced
 *     at the backend route layer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// fetchApi mock — every API call the page makes routes through this.
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object reference — the page uses useNotify() inside async
// handlers. A fresh object per call would risk identity-change cascades
// for any future useCallback dependency. Pattern matches the standing
// rule in CLAUDE.md (RTL: stable mock object references).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// money helpers — pin to "$" so the value chip + value cells are
// deterministic regardless of the runner's locale / tenant LS state.
vi.mock('../utils/money', () => ({
  formatMoney: (n, _opts) => `$${Number(n || 0).toFixed(2)}`,
  currencySymbol: () => '$',
}));

// date helper — short, deterministic, predictable.
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Contracts from '../pages/Contracts';

const sampleContacts = [
  { id: 11, name: 'Acme Inc', email: 'ap@acme.test' },
  { id: 12, name: 'Globex Ltd', email: 'invoices@globex.test' },
];

const sampleDeals = [
  { id: 21, title: 'Acme Renewal', amount: 50000 },
  { id: 22, title: 'Globex Expansion', amount: 25000 },
];

const sampleContracts = [
  {
    id: 1,
    title: 'Annual SaaS License',
    status: 'Draft',
    value: 12000,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    contact: { id: 11, name: 'Acme Inc', email: 'ap@acme.test' },
    deal: { id: 21, title: 'Acme Renewal', amount: 50000 },
  },
  {
    id: 2,
    title: 'Support Retainer',
    status: 'Active',
    value: 8000,
    startDate: '2026-02-01',
    endDate: '2027-01-31',
    contact: { id: 12, name: 'Globex Ltd', email: 'invoices@globex.test' },
    deal: null,
  },
  {
    id: 3,
    title: 'Pilot Engagement',
    status: 'Active',
    value: 3000,
    startDate: '2026-03-01',
    endDate: '2026-08-31',
    contact: null,
    deal: { id: 22, title: 'Globex Expansion', amount: 25000 },
  },
  {
    id: 4,
    title: 'Legacy Service Agreement',
    status: 'Terminated',
    value: 5000,
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    contact: { id: 11, name: 'Acme Inc', email: 'ap@acme.test' },
    deal: null,
  },
];

function defaultFetch(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/contracts' && method === 'GET') {
    return Promise.resolve(sampleContracts);
  }
  if (url === '/api/contacts' && method === 'GET') {
    return Promise.resolve(sampleContacts);
  }
  if (url === '/api/deals' && method === 'GET') {
    return Promise.resolve(sampleDeals);
  }
  // Mutations resolve with a harmless OK envelope by default.
  return Promise.resolve({ ok: true });
}

function renderContracts() {
  return render(<Contracts />);
}

describe('<Contracts /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading + intro + Create Contract form panel + All Contracts panel', async () => {
    renderContracts();
    expect(
      await screen.findByRole('heading', { name: /^Contracts$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Manage client contracts, track statuses/i),
    ).toBeInTheDocument();
    // "Create Contract" appears as both the form-panel heading AND the
    // submit button label, so length >= 2.
    expect(screen.getAllByText(/Create Contract/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /Create Contract/i })).toBeInTheDocument();
    expect(screen.getByText(/All Contracts/i)).toBeInTheDocument();
  });

  it('initial mount fires GET /api/contracts + /api/contacts + /api/deals in parallel', async () => {
    renderContracts();
    await waitFor(() => {
      const contractsCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/contracts' && (!o || !o.method || o.method === 'GET'),
      );
      const contactsCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/contacts' && (!o || !o.method || o.method === 'GET'),
      );
      const dealsCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/deals' && (!o || !o.method || o.method === 'GET'),
      );
      expect(contractsCall).toBeTruthy();
      expect(contactsCall).toBeTruthy();
      expect(dealsCall).toBeTruthy();
    });
  });

  it('empty list renders the "No contracts yet…" placeholder', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contracts') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderContracts();
    expect(
      await screen.findByText(/No contracts yet\. Create your first contract to get started\./i),
    ).toBeInTheDocument();
    // Stats chips fall back to 0.
    expect(screen.getByText(/^0 Draft$/i)).toBeInTheDocument();
    expect(screen.getByText(/^0 Active$/i)).toBeInTheDocument();
  });

  it('stats bar renders Draft + Active counts + active-value chip', async () => {
    renderContracts();
    // 1 Draft (id:1), 2 Active (ids:2,3), 1 Terminated (id:4).
    expect(await screen.findByText(/^1 Draft$/i)).toBeInTheDocument();
    expect(screen.getByText(/^2 Active$/i)).toBeInTheDocument();
    // Active value = 8000 + 3000 = 11000 (Draft + Terminated excluded).
    expect(screen.getByText(/\$11000\.00 active value/i)).toBeInTheDocument();
  });

  it('renders one row per contract with title, contact, deal, value, status, dates', async () => {
    renderContracts();
    expect(await screen.findByText('Annual SaaS License')).toBeInTheDocument();
    expect(screen.getByText('Support Retainer')).toBeInTheDocument();
    expect(screen.getByText('Pilot Engagement')).toBeInTheDocument();
    expect(screen.getByText('Legacy Service Agreement')).toBeInTheDocument();

    // Acme Inc appears as a row-contact for 2 rows AND in the Contact
    // dropdown option label "Acme Inc (ap@acme.test)" — that option label
    // is a single text node, so it doesn't collide with the bare "Acme Inc"
    // text in the row. Still, accept >= 1.
    expect(screen.getAllByText('Acme Inc').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Globex Ltd').length).toBeGreaterThanOrEqual(1);

    // Deal titles in rows. "Acme Renewal" appears once (row 1) + once in
    // the deals dropdown option text — that option text is "Acme Renewal -
    // $50000.00" (single node) so doesn't collide.
    expect(screen.getAllByText('Acme Renewal').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Globex Expansion').length).toBeGreaterThanOrEqual(1);

    // $-formatted values in the value column. $5000.00 appears only in
    // row 4 (Terminated, $5000).
    expect(screen.getByText('$12000.00')).toBeInTheDocument();
    expect(screen.getByText('$8000.00')).toBeInTheDocument();
    expect(screen.getByText('$3000.00')).toBeInTheDocument();
    expect(screen.getByText('$5000.00')).toBeInTheDocument();

    // StatusBadge text — Draft + Active + Terminated also appear in the
    // stats chips ("1 Draft", "2 Active") so use getAllByText with
    // length >= N: 1 badge + chip for Draft and Terminated; 2 badges + 1
    // chip for Active.
    expect(screen.getAllByText('Draft').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Terminated').length).toBeGreaterThanOrEqual(1);

    // Em-dash placeholder appears for row 2 (deal=null) + row 3
    // (contact=null) — at least 2 em-dashes in row cells.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);

    // Formatted dates (mocked formatDate yields ISO YYYY-MM-DD).
    expect(screen.getByText('2026-01-01')).toBeInTheDocument();
    expect(screen.getByText('2027-01-31')).toBeInTheDocument();
  });

  it('contact + deal dropdowns list every loaded record', async () => {
    renderContracts();
    await screen.findByText('Annual SaaS License');
    // Contact <option> labels — "Name (email)" form.
    expect(screen.getByText(/Acme Inc \(ap@acme\.test\)/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Globex Ltd \(invoices@globex\.test\)/i),
    ).toBeInTheDocument();
    // Deal <option> labels — "title - $amount" form.
    expect(screen.getByText(/Acme Renewal - \$50000\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/Globex Expansion - \$25000\.00/i)).toBeInTheDocument();
    // Sentinels.
    expect(screen.getByText(/-- Select Contact --/i)).toBeInTheDocument();
    expect(screen.getByText(/-- No Deal --/i)).toBeInTheDocument();
  });

  it('submitting the create form POSTs /api/contracts with the form body and clears the form', async () => {
    renderContracts();
    await screen.findByText('Annual SaaS License');
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contracts' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetch(url, opts);
    });

    // Fill the form. The title input is required and has placeholder
    // "e.g. Annual SaaS License" — use that to target it.
    const titleInput = screen.getByPlaceholderText(/e\.g\. Annual SaaS License/i);
    fireEvent.change(titleInput, { target: { value: 'New 2026 contract' } });

    // Value input — placeholder "0.00", type=number, step=0.01.
    const valueInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(valueInput, { target: { value: '4500.50' } });

    // Terms textarea — has placeholder "Contract terms and conditions...".
    const termsInput = screen.getByPlaceholderText(/Contract terms and conditions/i);
    fireEvent.change(termsInput, { target: { value: 'Net-30 payment terms' } });

    // Submit.
    fireEvent.click(screen.getByRole('button', { name: /Create Contract/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contracts' && opts?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.title).toBe('New 2026 contract');
      // Stored as form string per the source (no parseFloat at submit).
      expect(body.value).toBe('4500.50');
      expect(body.terms).toBe('Net-30 payment terms');
      // Optional fields default to '' per EMPTY_FORM.
      expect(body.contactId).toBe('');
      expect(body.dealId).toBe('');
      expect(body.startDate).toBe('');
      expect(body.endDate).toBe('');
    });

    // After successful create, the form resets — title input is empty.
    await waitFor(() => {
      expect(titleInput.value).toBe('');
    });
  });

  it('failed create surfaces notify.error("Failed to create contract")', async () => {
    renderContracts();
    await screen.findByText('Annual SaaS License');
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contracts' && opts?.method === 'POST') {
        return Promise.reject(new Error('500 boom'));
      }
      return defaultFetch(url, opts);
    });

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Annual SaaS License/i), {
      target: { value: 'Will fail' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Contract/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Failed to create contract');
    });
  });

  it('Activate button PUTs /api/contracts/:id with { status: "Active" }', async () => {
    renderContracts();
    await screen.findByText('Annual SaaS License');
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contracts/1' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'Active' });
      }
      return defaultFetch(url, opts);
    });

    // The Draft row (id:1) renders the Activate button. There are 2 such
    // buttons (one per non-Active-non-Terminated row); only row 1 is Draft
    // here. Use getAllByRole then click the first.
    const activateBtns = screen.getAllByRole('button', { name: /Activate/i });
    expect(activateBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(activateBtns[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contracts/1' && opts?.method === 'PUT',
      );
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ status: 'Active' });
    });
  });

  it('Terminate button PUTs /api/contracts/:id with { status: "Terminated" }', async () => {
    renderContracts();
    await screen.findByText('Support Retainer');
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (/^\/api\/contracts\/\d+$/.test(url) && opts?.method === 'PUT') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetch(url, opts);
    });

    // 3 rows render Terminate (Draft + 2 Active); row 4 (Terminated)
    // does NOT. Click the first.
    const terminateBtns = screen.getAllByRole('button', { name: /Terminate/i });
    expect(terminateBtns.length).toBe(3);
    fireEvent.click(terminateBtns[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          /^\/api\/contracts\/\d+$/.test(url) &&
          opts?.method === 'PUT' &&
          JSON.parse(opts.body).status === 'Terminated',
      );
      expect(call).toBeTruthy();
    });
  });

  it('Terminated row renders Delete only (no Activate, no Terminate)', async () => {
    // Custom dataset: a single Terminated row.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contracts') {
        return Promise.resolve([
          {
            id: 99,
            title: 'Closed Out',
            status: 'Terminated',
            value: 1000,
            startDate: '2025-01-01',
            endDate: '2025-06-30',
            contact: { id: 11, name: 'Acme Inc', email: 'ap@acme.test' },
            deal: null,
          },
        ]);
      }
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderContracts();
    await screen.findByText('Closed Out');

    // Activate + Terminate absent on the Terminated row.
    expect(screen.queryByRole('button', { name: /Activate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Terminate/i })).not.toBeInTheDocument();
    // Delete still present.
    expect(screen.getByRole('button', { name: /Delete/i })).toBeInTheDocument();
  });

  it('Delete confirms via notify.confirm; cancel skips DELETE; confirm fires DELETE /api/contracts/:id', async () => {
    renderContracts();
    await screen.findByText('Annual SaaS License');

    // Cancel branch first — notify.confirm returns false.
    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    const deleteBtns = screen.getAllByRole('button', { name: /Delete/i });
    expect(deleteBtns.length).toBe(4); // every row renders Delete.
    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // After confirm-cancel, no DELETE fired.
    const cancelDeleteCall = fetchApiMock.mock.calls.find(
      ([_, opts]) => opts?.method === 'DELETE',
    );
    expect(cancelDeleteCall).toBeFalsy();

    // Now confirm — notify.confirm returns true (default mock).
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/contracts/1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetch(url, opts);
    });

    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/contracts/1' && opts?.method === 'DELETE',
      );
      expect(call).toBeTruthy();
    });
  });

  it('notify.confirm payload describes the destructive delete intent', async () => {
    renderContracts();
    await screen.findByText('Annual SaaS License');
    notifyConfirm.mockClear();
    notifyConfirm.mockResolvedValue(false);

    const deleteBtns = screen.getAllByRole('button', { name: /Delete/i });
    fireEvent.click(deleteBtns[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledTimes(1);
    });
    const arg = notifyConfirm.mock.calls[0][0];
    expect(arg).toMatchObject({
      title: 'Delete contract',
      confirmText: 'Delete',
      destructive: true,
    });
    expect(arg.message).toMatch(/cannot be undone/i);
  });

  it('Active value chip excludes Draft + Terminated rows from the total', async () => {
    // Edge case: a dataset where only the Draft row has a big value but
    // the Active rows are tiny — the chip should still reflect Active-only.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/contracts') {
        return Promise.resolve([
          { id: 1, title: 'Big Draft', status: 'Draft', value: 99999 },
          { id: 2, title: 'Small Active', status: 'Active', value: 100 },
          { id: 3, title: 'Old Terminated', status: 'Terminated', value: 88888 },
        ]);
      }
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderContracts();
    await screen.findByText('Big Draft');

    // Active value chip = 100 only.
    expect(screen.getByText(/\$100\.00 active value/i)).toBeInTheDocument();
    // Counts.
    expect(screen.getByText(/^1 Draft$/i)).toBeInTheDocument();
    expect(screen.getByText(/^1 Active$/i)).toBeInTheDocument();
  });
});
