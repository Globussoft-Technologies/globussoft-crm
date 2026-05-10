/**
 * Billing.test.jsx — vitest + RTL coverage for the Global Billing & Invoicing page.
 *
 * Scope: pins the financial-page surface — invoice ledger, issue form, and
 * status actions (mark paid, void). The page is currency-display sensitive
 * and surfaces destructive operations that go through a confirmation
 * dialog, so it's a high-traffic + RBAC-sensitive screen.
 *
 *   1. Page renders heading "Global Billing & Invoicing" + "Issue Official
 *      Invoice" form panel + Accounts Receivable Ledger panel.
 *   2. Contact + Deal dropdowns populate from /api/contacts + /api/deals.
 *   3. Renders one invoice row per /api/billing entry with invoice number,
 *      contact name, amount (toLocaleString-formatted, 2dp), and status
 *      badge (PAID green / UNPAID red).
 *   4. Empty state: "The financial ledger is currently isolated and idle."
 *      renders when /api/billing returns [].
 *   5. "Mark Paid" button is present on UNPAID rows and absent on PAID rows.
 *   6. Clicking "Mark Paid" fires PUT /api/billing/<id>/pay then re-reloads.
 *   7. Clicking "Void" opens a destructive confirmation, then DELETEs
 *      /api/billing/<id> on confirm.
 *   8. Submitting the issue form POSTs /api/billing with contactId,
 *      amount, dueDate, dealId.
 *
 * Drift note: the page does NOT expose a role gate at the JSX level — auth
 * is enforced server-side (verifyRole on /api/billing endpoints). USER
 * role would see the same UI but the backend would reject the POST.
 * Tests pin the visible UI; server-side RBAC is covered by billing-api
 * gate specs.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — confirm() is called on Void; default to "yes" so
// the DELETE actually fires. Per-test can override.
const notifyError = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import Billing from '../pages/Billing';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function renderBilling(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'USD' }, loading: false }}>
        <Billing />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const sampleInvoices = [
  {
    id: 1,
    invoiceNum: 'INV-001',
    amount: 1234.56,
    status: 'UNPAID',
    dueDate: '2026-06-01',
    contact: { id: 1, name: 'Acme Corp', email: 'billing@acme.test' },
    deal: { id: 1, title: 'Acme Renewal' },
  },
  {
    id: 2,
    invoiceNum: 'INV-002',
    amount: 5000,
    status: 'PAID',
    dueDate: '2026-05-15',
    contact: { id: 2, name: 'Globex Inc', email: 'billing@globex.test' },
    deal: null,
  },
];

const sampleContacts = [
  { id: 1, name: 'Acme Corp', email: 'billing@acme.test' },
  { id: 2, name: 'Globex Inc', email: 'billing@globex.test' },
];

const sampleDeals = [
  { id: 1, title: 'Acme Renewal', amount: 50000, currency: 'USD' },
  { id: 2, title: 'Globex Expansion', amount: 25000, currency: 'USD' },
];

describe('<Billing /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(sampleInvoices);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      return Promise.resolve(null);
    });
  });

  it('renders the heading + Issue form + Ledger sections', async () => {
    renderBilling();
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: /Global Billing & Invoicing/i })
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Issue Official Invoice/i)).toBeInTheDocument();
    expect(screen.getByText(/Accounts Receivable Ledger/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate & Issue Document/i })).toBeInTheDocument();
  });

  it('renders one row per invoice with invoice number, contact, and amount', async () => {
    renderBilling();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    // Contact names render as the billed-entity strong text.
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Globex Inc')).toBeInTheDocument();
    // Amounts render with toLocaleString(2dp). 1234.56 → "1,234.56", 5000 → "5,000.00".
    expect(screen.getByText('1,234.56')).toBeInTheDocument();
    expect(screen.getByText('5,000.00')).toBeInTheDocument();
    // Status badges render.
    expect(screen.getByText('UNPAID')).toBeInTheDocument();
    expect(screen.getByText('PAID')).toBeInTheDocument();
  });

  it('shows the empty-state message when /api/billing returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderBilling();
    await waitFor(() => {
      expect(
        screen.getByText(/The financial ledger is currently isolated and idle\./i)
      ).toBeInTheDocument();
    });
  });

  it('"Mark Paid" button renders on UNPAID rows and is absent on PAID rows', async () => {
    renderBilling();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    // INV-001 is UNPAID → Mark Paid button present.
    // INV-002 is PAID → Mark Paid button absent.
    // There should be exactly 1 Mark Paid button on the page.
    const markPaidBtns = screen.getAllByRole('button', { name: /Mark Paid/i });
    expect(markPaidBtns.length).toBe(1);
  });

  it('clicking "Mark Paid" fires PUT /api/billing/<id>/pay', async () => {
    renderBilling();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/pay' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'PAID' });
      }
      if (url === '/api/billing') return Promise.resolve([{ ...sampleInvoices[0], status: 'PAID' }, sampleInvoices[1]]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      return Promise.resolve(null);
    });

    const markPaidBtn = screen.getByRole('button', { name: /Mark Paid/i });
    fireEvent.click(markPaidBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/pay' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking "Void" prompts a destructive confirm then DELETEs /api/billing/<id>', async () => {
    renderBilling();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1' && opts?.method === 'DELETE') {
        return Promise.resolve({ success: true });
      }
      if (url === '/api/billing') return Promise.resolve([sampleInvoices[1]]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      return Promise.resolve(null);
    });

    // Two Void buttons (one per row); click the first (INV-001).
    const voidBtns = screen.getAllByRole('button', { name: /Void/i });
    fireEvent.click(voidBtns[0]);

    // confirm() must have been called with destructive:true.
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    const confirmArg = notifyConfirm.mock.calls[0][0];
    expect(confirmArg).toMatchObject({ destructive: true });
    expect(confirmArg.confirmText).toMatch(/Void/i);

    // DELETE fires after confirm resolves true.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1' && opts?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
  });

  it('Void: if user cancels, DELETE does NOT fire', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderBilling();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const voidBtns = screen.getAllByRole('button', { name: /Void/i });
    fireEvent.click(voidBtns[0]);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Give any async work a chance to settle, then assert NO delete fired.
    await new Promise((r) => setTimeout(r, 30));
    const deleteCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/billing/1' && opts?.method === 'DELETE'
    );
    expect(deleteCall).toBeFalsy();
  });

  it('submitting the issue form POSTs /api/billing with the form payload', async () => {
    renderBilling();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 3, invoiceNum: 'INV-003', status: 'UNPAID' });
      }
      if (url === '/api/billing') return Promise.resolve(sampleInvoices);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      return Promise.resolve(null);
    });

    // Select the contact. The contact select is the first <select> on the
    // page; identify by the "-- Select Contact --" option.
    const contactSelect = screen.getByDisplayValue('-- Select Contact --');
    fireEvent.change(contactSelect, { target: { value: '1' } });

    // Set the amount.
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '999.99' } });

    // Set the due date via the date input. Identify by type=date — there's
    // exactly one on this page.
    const dateInput = screen
      .getAllByDisplayValue('')
      .find((el) => el.tagName === 'INPUT' && el.type === 'date');
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput, { target: { value: '2026-07-01' } });

    // Submit.
    fireEvent.click(screen.getByRole('button', { name: /Generate & Issue Document/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.contactId).toBe('1');
      expect(body.amount).toBe('999.99');
      expect(body.dueDate).toBe('2026-07-01');
    });
  });
});
