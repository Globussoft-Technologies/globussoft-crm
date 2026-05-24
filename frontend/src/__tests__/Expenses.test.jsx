/**
 * Expenses.test.jsx — vitest + RTL coverage for the Finance / Expense
 * Management page (frontend/src/pages/Expenses.jsx, 426 LOC, NO existing
 * test as of 2026-05-25).
 *
 * Scope: pins the page-surface invariants for the create-then-approve
 * expense workflow that finance/managers exercise daily.
 *
 *   1. Page renders the heading "Expense Management", the totals chips
 *      (Pending / Approved / Reimbursed / total count), and the New Expense
 *      form chrome.
 *   2. Initial mount fires GET /api/expenses + GET /api/contacts in
 *      parallel via Promise.all (the loadData() shape on first render).
 *   3. Empty list renders the "No expenses recorded yet." copy.
 *   4. Populated list renders one <tr> per expense with title + dollar-
 *      formatted amount + CategoryBadge + StatusBadge + user-or-em-dash +
 *      formatted date.
 *   5. Totals chips aggregate amounts by status (Pending / Approved /
 *      Reimbursed) — pure client-side reduction over the loaded list.
 *   6. Category dropdown renders the canonical CATEGORY_OPTIONS vocab
 *      (General / Travel / Software / Office / Marketing / Other).
 *   7. Contact dropdown lists every loaded contact as "Name (email)" plus
 *      a leading "-- None --" sentinel.
 *   8. "Submit for Approval" button POSTs /api/expenses with status:
 *      'Pending' + parsed-float amount + contactId-or-null + the rest of
 *      the form fields, then fires notify.success and reloads.
 *   9. "Save as Draft" button POSTs /api/expenses with status: 'Draft'
 *      (same payload shape otherwise).
 *  10. Amount input is required + type=number + step=0.01 + min=0 — the
 *      browser-side validation surface that gates submit.
 *  11. Row-action gating: a Draft row renders Submit; a Pending row
 *      renders Approve + Reject; an Approved row renders Reimburse;
 *      every row renders Delete.
 *  12. Approve PATCHes /api/expenses/:id/approve and fires success toast.
 *  13. Reject prompts for a reason (window.prompt) and PATCHes
 *      /api/expenses/:id/reject with { reason } body; cancel-prompt aborts.
 *  14. Delete confirms via notify.confirm, then DELETEs /api/expenses/:id.
 *  15. Failed create surfaces notify.error and does NOT clear the form.
 *
 * Drift / contract notes:
 *   - The page uses `notify.confirm` (custom modal) for delete but the
 *     native `window.prompt` for reject reason. Two different patterns
 *     live in the same handler set — pinned here as-is.
 *   - Totals chips render as `$<amount>` hard-coded (NOT formatMoney) —
 *     the page predates currency-tenant-awareness for the chip row even
 *     though it imports formatMoney/currencySymbol. Pinned as-is.
 *   - The form sets `status` server-side at submit time (Draft vs Pending)
 *     — there is no client-side status field on the form itself.
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
// handlers; a fresh object per render risks identity-change cascades for
// any future useCallback dependency. Mirrors the Patients/Approvals tests.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// money helpers — pin currencySymbol to "$" so the Amount label is
// deterministic regardless of the test runner's locale/tenant LS state.
vi.mock('../utils/money', () => ({
  formatMoney: (n) => `$${Number(n).toFixed(2)}`,
  currencySymbol: () => '$',
}));

// date helper — short, deterministic, predictable.
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Expenses from '../pages/Expenses';

const sampleContacts = [
  { id: 11, name: 'Acme Inc', email: 'ap@acme.test' },
  { id: 12, name: 'Globex Ltd', email: 'invoices@globex.test' },
];

const sampleExpenses = [
  {
    id: 1,
    title: 'Client dinner',
    amount: 120.5,
    category: 'Travel',
    status: 'Draft',
    expenseDate: '2026-04-01',
    notes: '',
    user: { id: 7, name: 'Priya Kapoor', email: 'priya@x.test' },
  },
  {
    id: 2,
    title: 'Figma seat',
    amount: 15,
    category: 'Software',
    status: 'Pending',
    expenseDate: '2026-04-03',
    notes: '',
    user: { id: 7, name: 'Priya Kapoor', email: 'priya@x.test' },
  },
  {
    id: 3,
    title: 'Office stationery',
    amount: 42.75,
    category: 'Office',
    status: 'Approved',
    expenseDate: '2026-04-05',
    notes: '',
    user: null,
  },
  {
    id: 4,
    title: 'AdWords March',
    amount: 1000,
    category: 'Marketing',
    status: 'Reimbursed',
    expenseDate: '2026-03-31',
    notes: '',
    user: { id: 8, name: null, email: 'finance@x.test' },
  },
];

function defaultFetch(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/expenses' && method === 'GET') {
    return Promise.resolve(sampleExpenses);
  }
  if (url === '/api/contacts' && method === 'GET') {
    return Promise.resolve(sampleContacts);
  }
  // Mutations resolve with a harmless OK envelope by default.
  return Promise.resolve({ ok: true });
}

function renderExpenses() {
  return render(<Expenses />);
}

describe('<Expenses /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading + 4 totals chips + New Expense form chrome', async () => {
    renderExpenses();
    expect(
      await screen.findByRole('heading', { name: /Expense Management/i }),
    ).toBeInTheDocument();
    // Totals row chip text.
    expect(await screen.findByText(/Pending:\s*\$15\.00/i)).toBeInTheDocument();
    expect(await screen.findByText(/Approved:\s*\$42\.75/i)).toBeInTheDocument();
    expect(
      await screen.findByText(/Reimbursed:\s*\$1000\.00/i),
    ).toBeInTheDocument();
    expect(await screen.findByText(/4 total expenses/i)).toBeInTheDocument();
    // New Expense form section heading.
    expect(screen.getByRole('heading', { name: /New Expense/i })).toBeInTheDocument();
    // Both submit-shape buttons present.
    expect(screen.getByRole('button', { name: /Save as Draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit for Approval/i })).toBeInTheDocument();
  });

  it('initial mount fires GET /api/expenses + GET /api/contacts in parallel', async () => {
    renderExpenses();
    await waitFor(() => {
      const expensesCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses' && (!o || !o.method || o.method === 'GET'),
      );
      const contactsCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/contacts' && (!o || !o.method || o.method === 'GET'),
      );
      expect(expensesCall).toBeTruthy();
      expect(contactsCall).toBeTruthy();
    });
  });

  it('empty list renders the "No expenses recorded yet." placeholder', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/expenses') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderExpenses();
    expect(
      await screen.findByText(/No expenses recorded yet\./i),
    ).toBeInTheDocument();
    // Total count chip shows zero.
    expect(screen.getByText(/0 total expenses/i)).toBeInTheDocument();
  });

  it('renders one row per expense with title, $-formatted amount, category, status, user/em-dash, date', async () => {
    renderExpenses();
    expect(await screen.findByText('Client dinner')).toBeInTheDocument();
    expect(screen.getByText('Figma seat')).toBeInTheDocument();
    expect(screen.getByText('Office stationery')).toBeInTheDocument();
    expect(screen.getByText('AdWords March')).toBeInTheDocument();

    // Dollar-formatted amounts in the amount column.
    expect(screen.getByText('$120.50')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('$42.75')).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument();

    // Category badges render in the rows. Each category name ALSO appears
    // in the form's CATEGORY_OPTIONS <option> set, so use getAllByText and
    // assert length >= 2 (one in the row, one in the <option>). "Other" /
    // "General" only appear once (in the options) because no sample row
    // uses them. Pinned as-is for the row-categories that ARE present.
    expect(screen.getAllByText('Travel').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Software').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Office').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Marketing').length).toBeGreaterThanOrEqual(2);

    // Status badges.
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Reimbursed')).toBeInTheDocument();

    // Row 3's user is null → em-dash placeholder.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // Row 4's user has no name; falls back to email.
    expect(screen.getByText('finance@x.test')).toBeInTheDocument();

    // Formatted dates.
    expect(screen.getByText('2026-04-01')).toBeInTheDocument();
    expect(screen.getByText('2026-03-31')).toBeInTheDocument();
  });

  it('Category dropdown lists the canonical CATEGORY_OPTIONS vocab', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');
    // The Category select is the only <select> whose default value is
    // 'General' (the contact select defaults to '').
    const allSelects = screen.getAllByRole('combobox');
    const categorySel = allSelects.find((s) => s.value === 'General');
    expect(categorySel).toBeTruthy();
    const options = Array.from(categorySel.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual([
      'General', 'Travel', 'Software', 'Office', 'Marketing', 'Other',
    ]);
  });

  it('Contact dropdown lists "-- None --" plus every loaded contact as "Name (email)"', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');
    // "-- None --" sentinel option.
    expect(screen.getByRole('option', { name: /-- None --/i })).toBeInTheDocument();
    // Each contact rendered as "Name (email)".
    expect(
      screen.getByRole('option', { name: /Acme Inc \(ap@acme\.test\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Globex Ltd \(invoices@globex\.test\)/i }),
    ).toBeInTheDocument();
  });

  it('"Submit for Approval" POSTs /api/expenses with status:Pending + parsed-float amount + null contactId; then notify.success + reload', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    fireEvent.change(screen.getByPlaceholderText(/Client Dinner/i), {
      target: { value: 'AWS bill April' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '249.99' },
    });
    // Leave category as default ('General'); leave contact as '' (None).

    fetchApiMock.mockClear();
    // Page calls loadData() after success — keep the GETs responding.
    fetchApiMock.mockImplementation(defaultFetch);

    fireEvent.click(screen.getByRole('button', { name: /Submit for Approval/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.title).toBe('AWS bill April');
      expect(body.amount).toBe(249.99);          // parseFloat'd
      expect(body.category).toBe('General');
      expect(body.contactId).toBeNull();         // '' → null
      expect(body.status).toBe('Pending');
    });

    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Expense created as Pending/i),
      );
    });
    // loadData() refetch after success.
    await waitFor(() => {
      const refetch = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/expenses' && (!o || !o.method || o.method === 'GET'),
      );
      expect(refetch.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('"Save as Draft" POSTs the same shape with status:Draft', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    fireEvent.change(screen.getByPlaceholderText(/Client Dinner/i), {
      target: { value: 'Coffee with vendor' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '8.50' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    fireEvent.click(screen.getByRole('button', { name: /Save as Draft/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.status).toBe('Draft');
      expect(body.amount).toBe(8.5);
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Expense created as Draft/i),
      );
    });
  });

  it('Amount input pins type=number + step=0.01 + min=0 + required (browser-validation surface)', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');
    const amountInput = screen.getByPlaceholderText('0.00');
    expect(amountInput).toHaveAttribute('type', 'number');
    expect(amountInput).toHaveAttribute('step', '0.01');
    expect(amountInput).toHaveAttribute('min', '0');
    expect(amountInput).toBeRequired();
  });

  it('Draft row shows Submit only; Pending row shows Approve + Reject; Approved row shows Reimburse; every row shows Delete', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    // Submit button: only the Draft row (id=1) renders it. There is exactly
    // one Submit button across all rows.
    const submitBtns = screen.getAllByRole('button', { name: /^Submit$/i });
    expect(submitBtns.length).toBe(1);

    // Approve + Reject — only Pending row (id=2).
    expect(screen.getAllByRole('button', { name: /^Approve$/i }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: /^Reject$/i }).length).toBe(1);

    // Reimburse — only Approved row (id=3).
    expect(screen.getAllByRole('button', { name: /Reimburse/i }).length).toBe(1);

    // Delete — every row (4 total).
    expect(screen.getAllByRole('button', { name: /^Delete$/i }).length).toBe(4);
  });

  it('clicking Approve PATCHes /api/expenses/:id/approve and fires success toast', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/expenses/2/approve' && opts?.method === 'PATCH') {
        return Promise.resolve({ id: 2, status: 'Approved' });
      }
      return defaultFetch(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Approve$/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses/2/approve' && o?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Expense approved/i),
      );
    });
  });

  it('clicking Reject prompts via window.prompt, PATCHes /:id/reject with { reason }; cancel-prompt aborts the call', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    // First case: user cancels the prompt → no PATCH fired.
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValueOnce(null);
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    // Nothing async to await — confirm no PATCH /reject call landed.
    await waitFor(() => {
      expect(promptSpy).toHaveBeenCalled();
    });
    const cancelledCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u.includes('/reject') && o?.method === 'PATCH',
    );
    expect(cancelledCall).toBeUndefined();

    // Second case: user types a reason → PATCH fires with it.
    promptSpy.mockReturnValueOnce('Out of policy');
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/expenses/2/reject' && opts?.method === 'PATCH') {
        return Promise.resolve({ id: 2, status: 'Rejected' });
      }
      return defaultFetch(url, opts);
    });
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses/2/reject' && o?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.reason).toBe('Out of policy');
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Expense rejected/i),
      );
    });
  });

  it('clicking Delete confirms via notify.confirm then DELETEs /api/expenses/:id; cancelled confirm aborts', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    // First case: user clicks Cancel in the confirm modal → no DELETE.
    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();
    // Click delete on the first row (Draft / id=1).
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/i })[0]);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Delete this expense/i),
      );
    });
    const cancelledDelete = fetchApiMock.mock.calls.find(
      ([u, o]) => u.startsWith('/api/expenses/') && o?.method === 'DELETE',
    );
    expect(cancelledDelete).toBeUndefined();

    // Second case: user confirms → DELETE fires for that row's id.
    notifyConfirm.mockResolvedValueOnce(true);
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/expenses/1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetch(url, opts);
    });
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete$/i })[0]);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses/1' && o?.method === 'DELETE',
      );
      expect(call).toBeTruthy();
    });
  });

  it('failed POST surfaces notify.error AND does NOT clear the form', async () => {
    renderExpenses();
    await screen.findByText('Client dinner');

    fireEvent.change(screen.getByPlaceholderText(/Client Dinner/i), {
      target: { value: 'Will fail' },
    });
    fireEvent.change(screen.getByPlaceholderText('0.00'), {
      target: { value: '99' },
    });

    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/expenses' && opts?.method === 'POST') {
        return Promise.reject(new Error('Create failed'));
      }
      return defaultFetch(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /Submit for Approval/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to create expense/i),
      );
    });
    // Form state survives the failure — title input still holds "Will fail".
    expect(screen.getByPlaceholderText(/Client Dinner/i)).toHaveValue('Will fail');
  });
});
