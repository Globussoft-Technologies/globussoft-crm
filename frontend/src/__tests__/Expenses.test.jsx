/**
 * Expenses.test.jsx — vitest + RTL coverage for frontend/src/pages/Expenses.jsx.
 *
 * Pinned to the CURRENT component shape (recipient + payment-method-split form,
 * 21 CATEGORY_OPTIONS, single Submit-for-Approval button, notify.prompt-based
 * rejection modal, notify.confirm-based delete). An earlier version of this
 * file pinned a speculative shape (Save-as-Draft, contacts dropdown,
 * window.prompt) that the component never implemented; this rewrite pins to
 * code reality per the verifying-gap-card-claims standing rule.
 *
 * Scope:
 *   1. Page chrome: heading, 4 totals chips (Pending / Approved / Reimbursed /
 *      total count), New Expense form heading + Submit-for-Approval button.
 *   2. Mount fires GET /api/expenses (component does NOT load /api/contacts).
 *   3. Empty list renders "No expenses recorded yet." + "0 total expenses".
 *   4. Each row renders title + $-formatted amount + CategoryBadge +
 *      StatusBadge + user-name-or-email-or-em-dash + formatted date.
 *   5. Category dropdown lists the canonical 21-item CATEGORY_OPTIONS with
 *      default "Building Rent".
 *   6. Submit POSTs /api/expenses with the canonical body shape (title +
 *      description + amount-as-float + category + expenseDate + notes +
 *      status:Pending), then notify.success + reload.
 *   7. Required-field validators fire notify.error WITHOUT POSTing.
 *   8. Payment-method total mismatch fires notify.error WITHOUT POSTing;
 *      matching breakdown encodes into notes as JSON.
 *   9. Amount input pins type=number + step=0.01 + min=0 + required.
 *  10. Row-action gating per status: Draft→Submit, Pending→Approve+Reject,
 *      Approved→Reimburse (title="Mark Reimbursed"), every row→Delete.
 *  11. Approve PATCHes /api/expenses/:id/approve + success toast.
 *  12. Reject prompts via notify.prompt; cancel (null) aborts; reason PATCHes
 *      /api/expenses/:id/reject with { reason } body.
 *  13. Reimburse PUTs /api/expenses/:id with { status: 'Reimbursed' }.
 *  14. Delete confirms via notify.confirm; cancel aborts; confirm DELETEs.
 *  15. Failed POST surfaces notify.error AND does NOT clear the form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object reference (the page uses useNotify inside async
// handlers — fresh objects per render risk identity-change cascades for any
// future useCallback dep). Mirrors the Patients/Approvals patterns.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn();
const notifyPrompt = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
  prompt: (...args) => notifyPrompt(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../utils/money', () => ({
  formatMoney: (n) => `$${Number(n).toFixed(2)}`,
  currencySymbol: () => '$',
}));

vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import Expenses from '../pages/Expenses';

const sampleExpenses = [
  {
    id: 1,
    title: 'Office stationery',
    amount: 120.5,
    category: 'Stationery',
    status: 'Draft',
    expenseDate: '2026-04-01',
    notes: '',
    user: { id: 7, name: 'Priya Kapoor', email: 'priya@x.test' },
  },
  {
    id: 2,
    title: 'Figma seat',
    amount: 15,
    category: 'Software/Tech Expenses',
    status: 'Pending',
    expenseDate: '2026-04-03',
    notes: '',
    user: { id: 7, name: 'Priya Kapoor', email: 'priya@x.test' },
  },
  {
    id: 3,
    title: 'Electricity bill',
    amount: 42.75,
    category: 'Electricity Bill',
    status: 'Approved',
    expenseDate: '2026-04-05',
    notes: '',
    user: null,
  },
  {
    id: 4,
    title: 'AdWords March',
    amount: 1000,
    category: 'Marketing Expenses',
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
  return Promise.resolve({ ok: true });
}

function renderExpenses() {
  return render(<Expenses />);
}

// The component's labels lack htmlFor/id pairing, so getByLabelText doesn't
// resolve the date input. There's exactly one input[type="date"] on the page
// (the Transaction Date field) — query it directly.
function getDateInput() {
  const el = document.querySelector('input[type="date"]');
  if (!el) throw new Error('Transaction Date input not found');
  return el;
}

describe('<Expenses /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyPrompt.mockReset();
    notifyConfirm.mockResolvedValue(true);
    notifyPrompt.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the heading + 4 totals chips + New Expense form + Submit button', async () => {
    renderExpenses();
    expect(
      await screen.findByRole('heading', { name: /Expense Management/i }),
    ).toBeInTheDocument();
    // Totals row chip text — Pending: 15.00, Approved: 42.75, Reimbursed: 1000.00, 4 total.
    expect(await screen.findByText(/Pending:\s*\$15\.00/i)).toBeInTheDocument();
    expect(await screen.findByText(/Approved:\s*\$42\.75/i)).toBeInTheDocument();
    expect(await screen.findByText(/Reimbursed:\s*\$1000\.00/i)).toBeInTheDocument();
    expect(await screen.findByText(/4 total expenses/i)).toBeInTheDocument();
    // New Expense form section heading + the lone submit button.
    expect(screen.getByRole('heading', { name: /New Expense/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit for Approval/i })).toBeInTheDocument();
  });

  it('initial mount fires GET /api/expenses', async () => {
    renderExpenses();
    await waitFor(() => {
      const expensesCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses' && (!o || !o.method || o.method === 'GET'),
      );
      expect(expensesCall).toBeTruthy();
    });
    // Component does NOT call /api/contacts — pin the negative shape so a
    // future regression that adds a stray GET wouldn't pass silently.
    const contactsCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/contacts');
    expect(contactsCall).toBeFalsy();
  });

  it('empty list renders the "No expenses recorded yet." placeholder + 0 total chip', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/expenses') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderExpenses();
    expect(
      await screen.findByText(/No expenses recorded yet\./i),
    ).toBeInTheDocument();
    expect(screen.getByText(/0 total expenses/i)).toBeInTheDocument();
  });

  it('renders one row per expense with title, $-formatted amount, category, status, user-or-em-dash, date', async () => {
    renderExpenses();
    expect(await screen.findByText('Office stationery')).toBeInTheDocument();
    expect(screen.getByText('Figma seat')).toBeInTheDocument();
    expect(screen.getByText('Electricity bill')).toBeInTheDocument();
    expect(screen.getByText('AdWords March')).toBeInTheDocument();

    // Row amounts now use the canonical formatMoney() helper (mocked above
    // as `$${Number(n).toFixed(2)}` — real INR/USD switching is covered by
    // money.test.js).
    expect(screen.getByText('$120.50')).toBeInTheDocument();
    expect(screen.getByText('$15.00')).toBeInTheDocument();
    expect(screen.getByText('$42.75')).toBeInTheDocument();
    expect(screen.getByText('$1000.00')).toBeInTheDocument();

    // Category badges in the rows — each value also appears once as an
    // <option> in the form's category select, so length should be ≥ 2.
    expect(screen.getAllByText('Stationery').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Software/Tech Expenses').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Electricity Bill').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Marketing Expenses').length).toBeGreaterThanOrEqual(2);

    // Status badges.
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Reimbursed')).toBeInTheDocument();

    // Row 3's user is null → em-dash placeholder in the User column.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    // Row 4's user has no name; falls back to email.
    expect(screen.getByText('finance@x.test')).toBeInTheDocument();

    // Formatted dates (mocked to ISO date prefix).
    expect(screen.getByText('2026-04-01')).toBeInTheDocument();
    expect(screen.getByText('2026-03-31')).toBeInTheDocument();
  });

  it('Category dropdown defaults to "Building Rent" and lists the canonical 21-item CATEGORY_OPTIONS', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');
    // The category select is the only <select> on the page; its default
    // value is `CATEGORY_OPTIONS[0]` which is "Building Rent".
    const allSelects = screen.getAllByRole('combobox');
    const categorySel = allSelects.find((s) => s.value === 'Building Rent');
    expect(categorySel).toBeTruthy();
    const options = Array.from(categorySel.querySelectorAll('option')).map((o) => o.value);
    expect(options).toEqual([
      'Building Rent',
      'Business Loan Repayment',
      'Electricity Bill',
      'Employee Commission',
      'Employee Salary',
      'Equipment Purchase',
      'Insurance Expenses',
      'Internet Bill',
      'Janitorial Expenses',
      'Marketing Expenses',
      'Miscellaneous',
      'Pantry',
      'Phone Bill',
      'Product Purchase',
      'Repair & Maintenance',
      'Software/Tech Expenses',
      'Staff Rent Expenses',
      'Stationery',
      'Supplier Payment',
      'Tips for Staff',
      'Travel',
    ]);
  });

  it('Submit for Approval POSTs /api/expenses with the canonical body shape (status:Pending), then success + reload', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    // Fill the three required fields: recipient name, amount, date.
    fireEvent.change(screen.getByPlaceholderText(/Enter recipient name/i), {
      target: { value: 'AWS bill April' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter amount/i), {
      target: { value: '249.99' },
    });
    fireEvent.change(getDateInput(), {
      target: { value: '2026-05-01' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    fireEvent.click(screen.getByRole('button', { name: /Submit for Approval/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.title).toBe('AWS bill April');
      expect(body.amount).toBe(249.99);                  // parseFloat'd
      expect(body.category).toBe('Building Rent');       // CATEGORY_OPTIONS[0]
      expect(body.expenseDate).toBe('2026-05-01');
      expect(body.status).toBe('Pending');
      // No payment breakdown entered → notes encodes to null.
      expect(body.notes).toBeNull();
      // Description is empty → null (component normalizes blank to null).
      expect(body.description).toBeNull();
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

  it('encodes payment-method breakdown into notes JSON when entered (totals must match Amount)', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    fireEvent.change(screen.getByPlaceholderText(/Enter recipient name/i), {
      target: { value: 'Cafeteria stock' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter amount/i), {
      target: { value: '100' },
    });
    fireEvent.change(getDateInput(), {
      target: { value: '2026-05-10' },
    });
    // Payment breakdown: cash=60, card=40 (sums to 100, matches Amount).
    const paymentInputs = screen.getAllByPlaceholderText('0.00');
    expect(paymentInputs.length).toBe(4); // cash, card, online, upi
    fireEvent.change(paymentInputs[0], { target: { value: '60' } }); // cash
    fireEvent.change(paymentInputs[1], { target: { value: '40' } }); // card

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    fireEvent.click(screen.getByRole('button', { name: /Submit for Approval/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.notes).not.toBeNull();
      const decoded = JSON.parse(body.notes);
      expect(decoded.payment).toEqual({ cash: 60, card: 40 });
    });
  });

  it('payment-method total mismatch fires notify.error WITHOUT POSTing', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    fireEvent.change(screen.getByPlaceholderText(/Enter recipient name/i), {
      target: { value: 'Mismatched payment' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter amount/i), {
      target: { value: '100' },
    });
    fireEvent.change(getDateInput(), {
      target: { value: '2026-05-10' },
    });
    // Breakdown sums to 80 ≠ 100 → should reject.
    const paymentInputs = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(paymentInputs[0], { target: { value: '50' } });
    fireEvent.change(paymentInputs[1], { target: { value: '30' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    fireEvent.click(screen.getByRole('button', { name: /Submit for Approval/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Payment-method total .* doesn't match Amount/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/expenses' && o?.method === 'POST',
    );
    expect(postCall).toBeFalsy();
  });

  it('Amount input pins type=number + step=0.01 + min=0 + required (browser-validation surface)', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');
    const amountInput = screen.getByPlaceholderText(/Enter amount/i);
    expect(amountInput).toHaveAttribute('type', 'number');
    expect(amountInput).toHaveAttribute('step', '0.01');
    expect(amountInput).toHaveAttribute('min', '0');
    expect(amountInput).toBeRequired();
  });

  it('Draft row shows Submit only; Pending shows Approve+Reject; Approved shows Reimburse; every row shows Delete', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    // Submit button — only the Draft row (id=1) renders it.
    expect(screen.getAllByRole('button', { name: /^Submit$/i }).length).toBe(1);
    // Approve + Reject — only Pending row (id=2).
    expect(screen.getAllByRole('button', { name: /^Approve$/i }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: /^Reject$/i }).length).toBe(1);
    // Reimburse (button label "Reimburse"; title="Mark Reimbursed") — only Approved row (id=3).
    expect(screen.getAllByRole('button', { name: /Reimburse/i }).length).toBe(1);
    // Delete — every row (4 total).
    expect(screen.getAllByRole('button', { name: /^Delete$/i }).length).toBe(4);
  });

  it('clicking Approve PATCHes /api/expenses/:id/approve and fires success toast', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

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
      expect(notifySuccess).toHaveBeenCalledWith('Expense approved');
    });
  });

  it('clicking Reject prompts via notify.prompt; cancel (null) aborts; reason PATCHes /:id/reject with { reason }', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    // First case: prompt resolves null (cancel) → no PATCH.
    notifyPrompt.mockResolvedValueOnce(null);
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Reject$/i }));
    await waitFor(() => {
      expect(notifyPrompt).toHaveBeenCalled();
    });
    const cancelledCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u.includes('/reject') && o?.method === 'PATCH',
    );
    expect(cancelledCall).toBeUndefined();

    // Second case: prompt resolves with a reason → PATCH fires.
    notifyPrompt.mockResolvedValueOnce('Out of policy');
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
      expect(notifySuccess).toHaveBeenCalledWith('Expense rejected');
    });
  });

  it('clicking Reimburse PUTs /api/expenses/:id with { status: "Reimbursed" }', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/expenses/3' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 3, status: 'Reimbursed' });
      }
      return defaultFetch(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /Reimburse/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses/3' && o?.method === 'PUT',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.status).toBe('Reimbursed');
    });
  });

  it('clicking Delete confirms via notify.confirm; cancel aborts; confirm DELETEs /api/expenses/:id', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    // First case: confirm resolves false (cancel) → no DELETE.
    notifyConfirm.mockResolvedValueOnce(false);
    fetchApiMock.mockClear();
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

    // Second case: confirm resolves true → DELETE for the row's id.
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
    await screen.findByText('Office stationery');

    fireEvent.change(screen.getByPlaceholderText(/Enter recipient name/i), {
      target: { value: 'Will fail' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter amount/i), {
      target: { value: '99' },
    });
    fireEvent.change(getDateInput(), {
      target: { value: '2026-05-15' },
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
    // Form state survives the failure — recipient name input still holds "Will fail".
    expect(screen.getByPlaceholderText(/Enter recipient name/i)).toHaveValue('Will fail');
  });

  it('clicking Submit on a Draft row PATCHes /api/expenses/:id/submit and fires success toast', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/expenses/1/submit' && opts?.method === 'PATCH') {
        return Promise.resolve({ id: 1, status: 'Pending' });
      }
      return defaultFetch(url, opts);
    });

    fireEvent.click(screen.getByRole('button', { name: /^Submit$/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/expenses/1/submit' && o?.method === 'PATCH',
      );
      expect(call).toBeTruthy();
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('Expense submitted for approval');
    });
  });

  it('whitespace-only recipient name fires notify.error without POSTing (JS-side .trim() check)', async () => {
    renderExpenses();
    await screen.findByText('Office stationery');

    // Fill recipientName with whitespace only — satisfies the HTML5 `required`
    // attribute (any non-empty string counts) but the component's
    // `.trim()` JS validator rejects it. Pins the JS-side guard separately
    // from the browser validation surface.
    fireEvent.change(screen.getByPlaceholderText(/Enter recipient name/i), {
      target: { value: '   ' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Enter amount/i), {
      target: { value: '50' },
    });
    fireEvent.change(getDateInput(), {
      target: { value: '2026-05-20' },
    });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(defaultFetch);

    fireEvent.click(screen.getByRole('button', { name: /Submit for Approval/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Recipient name is required/i),
      );
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/expenses' && o?.method === 'POST',
    );
    expect(postCall).toBeFalsy();
  });
});
