/**
 * Invoices.test.jsx — vitest + RTL coverage for the Invoices ledger page.
 *
 * Scope: pins the page-surface invariants for the daily-driver invoice
 * ledger — currency-aware money rendering, status badges + their hide/show
 * logic on row actions, Mark Paid + Void destructive flows, and the
 * inline create-invoice form POST shape.
 *
 * Drift note (vs. earlier #894 draft): the SUT does NOT use a drawer for
 * the Create Invoice form — the form is always-visible in the left column
 * of a 2-column grid. Tests pin the actual inline-form behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object so the useCallback identity stays stable across
// renders (Wave-11 standing rule — fresh objects per call cause infinite
// useCallback-dependency loops).
const notifyError = vi.fn();
const notifyInfo = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// formatMoney mock: prefixes "$" so the assertions are deterministic
// regardless of the tenant in localStorage. Real tenant-aware money is
// covered by money.test.js.
vi.mock('../utils/money', () => ({
  formatMoney: (v) => `$${(Number(v) || 0).toFixed(2)}`,
  currencySymbol: () => '$',
}));
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import { AuthContext } from '../App';
import Invoices from '../pages/Invoices';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };

function renderInvoices(user = ADMIN_USER, tenantOverrides = {}, initialEntries = ['/invoices']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1, defaultCurrency: 'USD', ...tenantOverrides }, loading: false }}>
        <Invoices />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

async function openCreateInvoiceForm() {
  fireEvent.click(screen.getByRole('button', { name: /Create Invoice/i }));
  await screen.findByRole('heading', { name: /Create Invoice/i });
}

function openInvoiceActions(invoiceNum) {
  fireEvent.click(
    screen.getByRole('button', {
      name: `More actions for invoice ${invoiceNum}`,
    }),
  );
}

const sampleInvoices = [
  {
    id: 1,
    invoiceNum: 'INV-001',
    amount: 1234.56,
    status: 'UNPAID',
    dueDate: '2026-06-01',
    issuedDate: '2026-05-01',
    contact: { id: 1, name: 'Acme Corp', email: 'billing@acme.test' },
    deal: { id: 1, title: 'Acme Renewal' },
    isRecurring: false,
  },
  {
    id: 2,
    invoiceNum: 'INV-002',
    amount: 5000,
    status: 'PAID',
    dueDate: '2026-05-15',
    issuedDate: '2026-04-15',
    paidAt: '2026-04-30',
    contact: { id: 2, name: 'Globex Inc', email: 'billing@globex.test' },
    deal: null,
    isRecurring: false,
  },
  {
    id: 3,
    invoiceNum: 'INV-003',
    amount: 250,
    status: 'VOIDED',
    dueDate: '2026-04-01',
    issuedDate: '2026-03-01',
    contact: { id: 3, name: 'Initech', email: 'billing@initech.test' },
    deal: null,
    isRecurring: false,
  },
];

const sampleContacts = [
  { id: 1, name: 'Acme Corp', email: 'billing@acme.test' },
  { id: 2, name: 'Globex Inc', email: 'billing@globex.test' },
];

const sampleDeals = [
  { id: 1, title: 'Acme Renewal', amount: 50000, currency: 'USD' },
];

const samplePaymentConfig = {
  stripe: { configured: false },
  razorpay: { configured: false },
};

const samplePatients = [
  {
    id: 11,
    name: 'Priya Sharma',
    phone: '+919876543210',
    email: 'priya@example.in',
    gst: null,
    contactId: null,
  },
  {
    id: 12,
    name: 'Arjun Mehta',
    phone: '+919876543211',
    email: 'arjun@example.in',
    gst: null,
    contactId: null,
  },
];

const sampleVisit = {
  id: 501,
  visitDate: '2026-06-10',
  status: 'completed',
  service: { id: 21, name: 'Skin consultation' },
};

const sampleVisitConsumptions = [
  { id: 601, productId: 31, productName: 'Aftercare kit', qty: 2, unitCost: 500 },
];

const sampleWellnessInvoices = [
  {
    ...sampleInvoices[0],
    patientId: 11,
    customerName: 'Priya Sharma',
    customerPhone: '+919876543210',
    customerEmail: 'priya@example.in',
    paymentMode: 'upi',
    lineItemsJson: JSON.stringify([
      { type: 'service', itemId: 21, name: 'Skin consultation', quantity: 2, unitPrice: 1500, amount: 3000 },
      { type: 'product', itemId: 31, name: 'Aftercare kit', quantity: 1, unitPrice: 500, amount: 500 },
    ]),
  },
];

const sampleServices = [
  { id: 21, name: 'Skin consultation', basePrice: 1500, discountedPrice: null },
];

const sampleProducts = [
  { id: 31, name: 'Aftercare kit', price: 500, discountedPrice: null },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/billing' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleInvoices);
  }
  if (url === '/api/contacts') return Promise.resolve(sampleContacts);
  if (url === '/api/deals') return Promise.resolve(sampleDeals);
  if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
  if (url === '/api/wellness/patients?limit=50&offset=0&fields=full') {
    return Promise.resolve({ patients: samplePatients, total: samplePatients.length });
  }
  if (url === '/api/wellness/patients/11/visits') return Promise.resolve([sampleVisit]);
  if (url === '/api/wellness/visits/501/consumptions') return Promise.resolve(sampleVisitConsumptions);
  if (url === '/api/wellness/services') return Promise.resolve(sampleServices);
  if (url === '/api/wellness/products?paginate=true&page=1&limit=100') {
    return Promise.resolve({ items: sampleProducts, pagination: { total: sampleProducts.length } });
  }
  return Promise.resolve(null);
}

describe('<Invoices /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('renders the heading + Create Invoice button + Invoice Ledger, and opens the form on click', async () => {
    renderInvoices();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /^Invoices$/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /Create Invoice/i })).toBeNull();
    expect(screen.getByText(/Invoice Ledger/i)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Contact$/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Products \/ Services/i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: /Payment Mode/i })).toBeNull();
    await openCreateInvoiceForm();
    expect(screen.getByRole('button', { name: /Issue Invoice/i })).toBeInTheDocument();
  });

  it('renders one row per invoice with invoiceNum, contact, amount, and status', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.getByText('INV-003')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Globex Inc')).toBeInTheDocument();
    // formatMoney mock prefixes "$" + 2dp; assert at least one amount renders.
    expect(screen.getByText('$1234.56')).toBeInTheDocument();
    expect(screen.getByText('$5000.00')).toBeInTheDocument();
    // Status badges (Paid/Unpaid/Voided). Multiple elements may match — Unpaid
    // and Paid also appear as <option>s in the create-form Status dropdown,
    // and Voided in the ledger's status-filter dropdown.
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Paid').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Voided').length).toBeGreaterThanOrEqual(1);
    const genericUnpaidBadge = screen.getAllByText('Unpaid').find((node) => node.closest('tr'));
    expect(genericUnpaidBadge.getAttribute('style')).not.toMatch(/border:\s*none/i);
  });

  it('shows the empty-state message when /api/billing returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/deals') return Promise.resolve([]);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => {
      expect(
        screen.getByText(/No invoices yet\. Create one to get started\./i)
      ).toBeInTheDocument();
    });
  });

  it('UNPAID rows show Mark Paid; PAID rows hide Mark Paid; VOIDED rows hide Void + Recur', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    openInvoiceActions('INV-001');
    expect(screen.getByRole('menuitem', { name: /Mark invoice INV-001 as paid/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Void invoice INV-001/i })).toBeInTheDocument();

    openInvoiceActions('INV-002');
    expect(screen.queryByRole('menuitem', { name: /Mark invoice INV-002 as paid/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /Void invoice INV-002/i })).toBeInTheDocument();

    openInvoiceActions('INV-003');
    expect(screen.queryByRole('menuitem', { name: /Mark invoice INV-003 as paid/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Void invoice INV-003/i })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Create Recurring/i })).toBeNull();
  });

  it('clicking "Mark Paid" fires PUT /api/billing/<id>/pay', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/pay' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'PAID' });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    const markPaidBtn = screen.getByRole('menuitem', { name: /Mark invoice INV-001 as paid/i });
    fireEvent.click(markPaidBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/pay' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('clicking "Void" prompts a destructive confirm then PUTs /api/billing/<id>/void', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/void' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, status: 'VOIDED' });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    const voidBtn = screen.getByRole('menuitem', { name: /Void invoice INV-001/i });
    fireEvent.click(voidBtn);

    // confirm() called with destructive:true.
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    const confirmArg = notifyConfirm.mock.calls[0][0];
    expect(confirmArg).toMatchObject({ destructive: true });
    expect(confirmArg.confirmText).toMatch(/Void/i);

    // PUT /void fires after confirm resolves true.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/void' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('Void: if user cancels the confirm, the void PUT does NOT fire', async () => {
    notifyConfirm.mockResolvedValue(false);
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();

    openInvoiceActions('INV-001');
    const voidBtn = screen.getByRole('menuitem', { name: /Void invoice INV-001/i });
    fireEvent.click(voidBtn);

    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    // Let any pending microtasks settle, then assert no /void PUT fired.
    await new Promise((r) => setTimeout(r, 30));
    const voidCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/billing/1/void' && opts?.method === 'PUT'
    );
    expect(voidCall).toBeFalsy();
  });

  it('submitting the create form POSTs /api/billing with the form payload', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 4, invoiceNum: 'INV-004', status: 'UNPAID' });
      }
      return defaultFetchMock(url, opts);
    });

    // Select the contact via the labeled Contact combobox (now SearchableSingleSelect).
    const user = userEvent.setup();
    const contactSelect = screen.getByLabelText(/^Contact$/i);
    await user.click(contactSelect);
    await user.click(await screen.findByRole('option', { name: /Acme Corp \(billing@acme.test\)/i }));

    // Amount input — placeholder is "0.00".
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '999.99' } });

    // Due date input — labeled "Due date".
    const dateInput = screen.getByLabelText(/^Due date$/i);
    fireEvent.change(dateInput, { target: { value: '2099-07-01' } });

    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.contactId).toBe('1');
      expect(body.amount).toBe('999.99');
      expect(body.dueDate).toBe('2099-07-01');
    });
  });

  it('blocks previous due dates and keeps the create modal open', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const dateInput = screen.getByLabelText(/^Due date$/i);
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(dateInput).toHaveAttribute('min', today);

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10.00' } });
    fireEvent.change(dateInput, { target: { value: '2000-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalledWith('Due date cannot be in the past'));
    expect(fetchApiMock.mock.calls.some(([url, opts]) => url === '/api/billing' && opts?.method === 'POST')).toBe(false);
    expect(screen.getByRole('dialog', { name: /Create Invoice/i })).toBeInTheDocument();
  });

  it('opens the native date picker when the due-date field itself is clicked', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const dateInput = screen.getByLabelText(/^Due date$/i);
    const showPicker = vi.fn();
    Object.defineProperty(dateInput, 'showPicker', { configurable: true, value: showPicker });
    fireEvent.click(dateInput);

    expect(showPicker).toHaveBeenCalledTimes(1);
  });

  it('Outstanding pill renders a currency-formatted total from formatMoney', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    // Outstanding = UNPAID (1234.56) — PAID + VOIDED are excluded.
    // formatMoney mock returns `$<value>`, so the pill text contains "$1234.56".
    expect(screen.getByText(/Outstanding:\s*\$1234\.56/i)).toBeInTheDocument();
  });

  it('Invoice # field is read-only and seeded from nextInvoiceNum', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();

    // Seed has INV-001, INV-002, INV-003 → next should be INV-004.
    const invInput = screen.getByLabelText(/Invoice number/i);
    expect(invInput.value).toMatch(/INV-004/);
    // Field is marked readOnly so the user can't pre-set it.
    expect(invInput).toHaveAttribute('readOnly');
  });

  it('renders the optional Deal dropdown with seeded deals', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const dealSelect = screen.getByLabelText(/Associated deal/i);
    expect(dealSelect).toBeInTheDocument();
    // Includes the placeholder "-- No Deal --" + the one seeded deal.
    expect(dealSelect.querySelectorAll('option').length).toBeGreaterThanOrEqual(2);
    expect(dealSelect.textContent).toMatch(/Acme Renewal/);
  });

  it('create-form POST includes dealId when a deal is selected', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.resolve({ id: 99 });
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/^Contact$/i));
    await user.click(await screen.findByRole('option', { name: /Acme Corp \(billing@acme.test\)/i }));
    fireEvent.change(screen.getByLabelText(/Associated deal/i), { target: { value: '1' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '250.00' } });
    fireEvent.change(screen.getByLabelText(/^Due date$/i), { target: { value: '2099-08-15' } });

    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.dealId).toBe('1');
    });
  });

  it('create-form: failed POST surfaces a notify.error', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    await openCreateInvoiceForm();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && opts?.method === 'POST') {
        return Promise.reject(new Error('boom'));
      }
      return defaultFetchMock(url, opts);
    });

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/^Contact$/i));
    await user.click(await screen.findByRole('option', { name: /Acme Corp \(billing@acme.test\)/i }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10.00' } });
    fireEvent.change(screen.getByLabelText(/^Due date$/i), { target: { value: '2099-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to create invoice/i);
  });

  it('Mark Paid failure surfaces a notify.error', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/pay' && opts?.method === 'PUT') {
        return Promise.reject(new Error('server-blew-up'));
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Mark invoice INV-001 as paid/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(notifyError.mock.calls[0][0]).toMatch(/Failed to mark invoice as paid/i);
  });

  it('renders compact View and More actions for each invoice row', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    expect(screen.getAllByRole('button', { name: /View invoice/i })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /More actions for invoice/i })).toHaveLength(3);
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toHaveStyle({ textAlign: 'left' });

    openInvoiceActions('INV-001');
    expect(screen.getByRole('menu', { name: /Actions for invoice INV-001/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Download PDF for invoice INV-001/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-001/i })).toBeInTheDocument();
    const moreButton = screen.getByRole('button', { name: /More actions for invoice INV-001/i });
    expect(moreButton).toHaveTextContent('More');
    expect(moreButton.querySelector('.lucide-more-horizontal')).toBeNull();
    expect(screen.getByRole('menu').closest('td')).toHaveClass('invoice-actions-cell--menu-open');
  });

  it('gives the wellness invoice and product columns consistent usable widths', async () => {
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const columns = screen.getByRole('table').querySelectorAll('col');
    expect(columns[0].style.width).toBe('180px');
    expect(columns[2].style.width).toBe('310px');
    expect(columns[9].style.width).toBe('250px');
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toHaveStyle({ textAlign: 'left' });
    expect(screen.getByRole('button', { name: /View invoice INV-001/i }).closest('td'))
      .toHaveStyle({ textAlign: 'left' });
  });

  it('status filter narrows the ledger to a single status', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    // All three rows visible initially.
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.getByText('INV-003')).toBeInTheDocument();

    // Filter -> PAID: only INV-002 remains.
    const filter = screen.getByLabelText(/Filter invoices by status/i);
    fireEvent.change(filter, { target: { value: 'PAID' } });
    expect(screen.queryByText('INV-001')).toBeNull();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.queryByText('INV-003')).toBeNull();

    // Filter -> ALL: all three rows back.
    fireEvent.change(filter, { target: { value: 'ALL' } });
    expect(screen.getByText('INV-001')).toBeInTheDocument();
    expect(screen.getByText('INV-002')).toBeInTheDocument();
    expect(screen.getByText('INV-003')).toBeInTheDocument();
  });

  it('filter "no matches" state renders the dashed-card message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([sampleInvoices[0]]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    const filter = screen.getByLabelText(/Filter invoices by status/i);
    fireEvent.change(filter, { target: { value: 'PAID' } });

    expect(screen.queryByText('INV-001')).toBeNull();
    expect(screen.getByText(/No invoices match the/i)).toBeInTheDocument();
  });

  it('renders the KPI pills: Outstanding, Paid This Month, and total count', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.getByText(/Outstanding:\s*\$1234\.56/i)).toBeInTheDocument();
    expect(screen.getByText(/Paid This Month:/i)).toBeInTheDocument();
    expect(screen.getByText(/3 total invoices/i)).toBeInTheDocument();
  });

  it('OVERDUE invoices surface an overdue-count pill', async () => {
    const withOverdue = [
      { ...sampleInvoices[0], id: 10, invoiceNum: 'INV-010', status: 'OVERDUE' },
      { ...sampleInvoices[0], id: 11, invoiceNum: 'INV-011', status: 'OVERDUE' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(withOverdue);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-010')).toBeInTheDocument());
    expect(screen.getByText(/2 Overdue/i)).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThanOrEqual(2);
  });

  it('clicking "Generate Payment Link" opens the payment-link modal scoped to that invoice', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/payment-link' && opts?.method === 'POST') {
        return Promise.resolve({ url: 'http://test.example/pay/inv-001' });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    const generateBtn = screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-001/i });
    fireEvent.click(generateBtn);

    await waitFor(() => expect(screen.getByText(/Payment Link/i)).toBeInTheDocument());
    expect(screen.getByText('http://test.example/pay/inv-001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close payment dialog/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Close payment dialog/i }));
    expect(screen.queryByRole('button', { name: /Close payment dialog/i })).toBeNull();
  });

  it('payment modal displays the generated link and a Copy button', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/payment-link' && opts?.method === 'POST') {
        return Promise.resolve({ url: 'http://test.example/pay/inv-001' });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-001/i }));
    await waitFor(() => expect(screen.getByText(/Payment Link/i)).toBeInTheDocument());

    expect(screen.getByText('http://test.example/pay/inv-001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Copy$/i })).toBeInTheDocument();
  });

  it('clicking "Recur" opens the recur modal with frequency options', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Create Recurring/i }));

    expect(screen.getByText(/Set up recurring billing/i)).toBeInTheDocument();
    // The activate button reads "Activate monthly" by default.
    expect(screen.getByRole('button', { name: /Activate monthly/i })).toBeInTheDocument();
  });

  it('activating recurring PUTs /api/billing/<id>/recurring with isRecurring=true', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/recurring' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 1, isRecurring: true });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Create Recurring/i }));

    fireEvent.click(screen.getByRole('button', { name: /Activate monthly/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing/1/recurring' && opts?.method === 'PUT'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.isRecurring).toBe(true);
      expect(body.recurFrequency).toBe('monthly');
    });
  });

  it('a recurring invoice shows its frequency label on the Recur button, not "Recur"', async () => {
    const withRecurring = [
      { ...sampleInvoices[0], id: 50, invoiceNum: 'INV-050', isRecurring: true, recurFrequency: 'quarterly' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(withRecurring);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-050')).toBeInTheDocument());

    openInvoiceActions('INV-050');
    expect(screen.getByRole('menuitem', { name: /Recurring: quarterly/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Create Recurring/i })).toBeNull();
  });

  it('opening Recur on an already-recurring invoice offers "Stop recurring" (not Activate)', async () => {
    const withRecurring = [
      { ...sampleInvoices[0], id: 51, invoiceNum: 'INV-051', isRecurring: true, recurFrequency: 'monthly' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(withRecurring);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-051')).toBeInTheDocument());

    openInvoiceActions('INV-051');
    fireEvent.click(screen.getByRole('menuitem', { name: /Recurring: monthly/i }));

    expect(screen.getByText(/Stop recurring billing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stop recurring/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate monthly/i })).toBeNull();
  });

  it('row with null contact falls back to "Unknown" in the Contact column', async () => {
    const noContact = [
      { ...sampleInvoices[0], id: 70, invoiceNum: 'INV-070', contact: null },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(noContact);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-070')).toBeInTheDocument());
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('nextInvoiceNum defaults to INV-001 when the invoice list is empty', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve([]);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText(/No invoices yet/i)).toBeInTheDocument());
    await openCreateInvoiceForm();
    const invInput = screen.getByLabelText(/Invoice number/i);
    expect(invInput.value).toBe('INV-001');
  });

  it('OVERDUE rows still expose Mark Paid + Generate Payment Link + Void (status branches as not-paid not-voided)', async () => {
    const overdue = [
      { ...sampleInvoices[0], id: 80, invoiceNum: 'INV-080', status: 'OVERDUE' },
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/billing') return Promise.resolve(overdue);
      if (url === '/api/contacts') return Promise.resolve(sampleContacts);
      if (url === '/api/deals') return Promise.resolve(sampleDeals);
      if (url === '/api/payments/config') return Promise.resolve(samplePaymentConfig);
      return Promise.resolve(null);
    });
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-080')).toBeInTheDocument());

    openInvoiceActions('INV-080');
    expect(screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-080/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Mark invoice INV-080 as paid/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Void invoice INV-080/i })).toBeInTheDocument();
  });

  it('Generate Payment Link is hidden on PAID rows AND on VOIDED rows', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    openInvoiceActions('INV-002');
    expect(screen.queryByRole('menuitem', { name: /Generate payment link for invoice INV-002/i })).toBeNull();
    openInvoiceActions('INV-003');
    expect(screen.queryByRole('menuitem', { name: /Generate payment link for invoice INV-003/i })).toBeNull();
    openInvoiceActions('INV-001');
    expect(screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-001/i })).toBeInTheDocument();
  });

  it('clicking PDF on a row fires fetch against /api/billing/<id>/pdf with Bearer token', async () => {
    const blobSpy = vi.fn(() => Promise.resolve(new Blob(['%PDF-stub'], { type: 'application/pdf' })));
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, blob: blobSpy }));
    const origFetch = global.fetch;
    global.fetch = fetchSpy;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:stub');
    URL.revokeObjectURL = vi.fn();

    try {
      renderInvoices();
      await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

      openInvoiceActions('INV-001');
      fireEvent.click(screen.getByRole('menuitem', { name: /Download PDF for invoice INV-001/i }));

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toMatch(/\/api\/billing\/1\/pdf$/);
      expect(opts.headers.Authorization).toMatch(/^Bearer test-token$/);
    } finally {
      global.fetch = origFetch;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('PDF fetch failure surfaces a notify.error', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, blob: () => Promise.resolve(new Blob()) }));
    const origFetch = global.fetch;
    global.fetch = fetchSpy;

    try {
      renderInvoices();
      await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

      openInvoiceActions('INV-001');
      fireEvent.click(screen.getByRole('menuitem', { name: /Download PDF for invoice INV-001/i }));

      await waitFor(() => expect(notifyError).toHaveBeenCalled());
      expect(notifyError.mock.calls.some(c => /Failed to download PDF/i.test(String(c[0])))).toBe(true);
    } finally {
      global.fetch = origFetch;
    }
  });

  it('Recur modal Cancel closes the modal without firing a PUT', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Create Recurring/i }));
    expect(screen.getByText(/Set up recurring billing/i)).toBeInTheDocument();

    fetchApiMock.mockClear();
    const cancels = screen.getAllByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancels[cancels.length - 1]);

    expect(screen.queryByText(/Set up recurring billing/i)).toBeNull();
    const recurCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => /\/recurring$/.test(url) && opts?.method === 'PUT'
    );
    expect(recurCall).toBeFalsy();
  });

  it('payment modal summary names the invoice contact and amount', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/payment-link' && opts?.method === 'POST') {
        return Promise.resolve({ url: 'http://test.example/pay/inv-001' });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-001/i }));
    await waitFor(() => expect(screen.getByText(/Payment Link/i)).toBeInTheDocument());

    const summary = screen.getByText((content, element) =>
      /Share this link with/.test(content) &&
      element?.textContent?.includes('Acme Corp') &&
      element?.textContent?.includes('INV-001')
    );
    expect(summary).toBeInTheDocument();
  });

  it('payment modal closes when the dark overlay is clicked (outside the dialog body)', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing/1/payment-link' && opts?.method === 'POST') {
        return Promise.resolve({ url: 'http://test.example/pay/inv-001' });
      }
      return defaultFetchMock(url, opts);
    });

    openInvoiceActions('INV-001');
    fireEvent.click(screen.getByRole('menuitem', { name: /Generate payment link for invoice INV-001/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Close payment dialog/i })).toBeInTheDocument());

    // Walk up to the overlay (first ancestor with position:fixed).
    const heading = screen.getByRole('heading', { name: /Payment Link/i });
    let node = heading;
    while (node && node.style?.position !== 'fixed') node = node.parentElement;
    expect(node).toBeTruthy();
    fireEvent.click(node);

    await waitFor(() => expect(screen.queryByRole('button', { name: /Close payment dialog/i })).toBeNull());
  });
});

describe('<Invoices /> — wellness customer invoice form', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('shows the wellness-only customer details and catalog sections without travel controls', async () => {
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    expect(screen.getByRole('heading', { name: /Customer Details/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Products & Services/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Customer or patient/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Patient visit/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Customer ID/i)).toBeNull();
    expect(screen.getByLabelText(/Full name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Phone number/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/GSTIN/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Billing address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Shipping or service address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Payment mode/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Filter invoices by sub-brand/i)).toBeNull();
    expect(screen.queryByLabelText(/^Sub-brand$/i)).toBeNull();
  });

  it('uses a bounded backend search for wellness patients', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/wellness/patients?limit=50&offset=0&fields=full') {
        return Promise.resolve({ patients: [samplePatients[0]], total: 1 });
      }
      if (url === '/api/wellness/patients?limit=50&offset=0&fields=full&q=Arjun') {
        return Promise.resolve({ patients: [samplePatients[1]], total: 1 });
      }
      return defaultFetchMock(url, opts);
    });
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const patientPicker = screen.getByRole('combobox', { name: /Customer or patient/i });
    fireEvent.focus(patientPicker);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: /Priya Sharma/ })).toBeInTheDocument();
    });
    fireEvent.change(patientPicker, { target: { value: 'Arjun' } });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/patients?limit=50&offset=0&fields=full&q=Arjun',
      );
      expect(screen.getByRole('option', { name: /Arjun Mehta/ })).toBeInTheDocument();
    });
    expect(fetchApiMock.mock.calls.some(([url]) => String(url).includes('offset=50'))).toBe(false);
  });

  it('finds products beyond the first catalogue page through backend search', async () => {
    const rareProduct = { id: 999, name: 'Rare treatment kit', price: 725, discountedPrice: null };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/wellness/products?paginate=true&page=1&limit=100&q=Rare') {
        return Promise.resolve({ items: [rareProduct], pagination: { total: 1 } });
      }
      return defaultFetchMock(url, opts);
    });
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    fireEvent.change(screen.getByLabelText(/Line item 1 type/i), { target: { value: 'product' } });
    const productPicker = screen.getByRole('combobox', { name: /Line item 1 product or service/i });
    fireEvent.change(productPicker, { target: { value: 'Rare' } });

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/products?paginate=true&page=1&limit=100&q=Rare',
      );
      expect(screen.getByRole('option', { name: 'Rare treatment kit' })).toBeInTheDocument();
    });
  });

  it('keeps the create modal fixed while scrolling only its form content', async () => {
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const dialog = screen.getByRole('dialog', { name: /Create Invoice/i });
    const formScroller = dialog.querySelector('.invoice-create-form-scroll');
    expect(dialog.style.position).toBe('fixed');
    expect(dialog.style.overflow).toBe('hidden');
    expect(formScroller.style.overflowY).toBe('auto');
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(screen.getByRole('button', { name: /Close create invoice form/i }));
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
  });

  it('prefills a patient profile, calculates catalog totals, and POSTs wellness invoice details', async () => {
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const patientPicker = screen.getByRole('combobox', { name: /Customer or patient/i });
    fireEvent.focus(patientPicker);
    fireEvent.click(screen.getByRole('option', { name: /Priya Sharma/i }));

    expect(screen.getByLabelText(/Full name/i).value).toBe('Priya Sharma');
    expect(screen.getByLabelText(/Phone number/i).value).toBe('+919876543210');
    expect(screen.getByLabelText(/Email address/i).value).toBe('priya@example.in');

    await waitFor(() => expect(screen.getByRole('option', { name: /Skin consultation/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Patient visit/i), { target: { value: '501' } });
    await waitFor(() => {
      expect(screen.getByLabelText(/Line item 1 product or service/i).value).toBe('21');
      expect(screen.getByLabelText(/Line item 2 product or service/i).value).toBe('Aftercare kit');
    });
    expect(screen.getByText('$2500.00', { selector: 'strong' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Billing address/i), { target: { value: '12 Clinic Road, Ranchi' } });
    fireEvent.change(screen.getByLabelText(/Shipping or service address/i), { target: { value: '12 Clinic Road, Ranchi' } });
    fireEvent.change(screen.getByLabelText(/Due date/i), { target: { value: '2099-12-31' } });
    fireEvent.change(screen.getByLabelText(/Payment mode/i), { target: { value: 'upi' } });

    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.patientId).toBe('11');
      expect(body.visitId).toBe('501');
      expect(body.customerName).toBe('Priya Sharma');
      expect(body.customerEmail).toBe('priya@example.in');
      expect(body.billingAddress).toBe('12 Clinic Road, Ranchi');
      expect(body.paymentMode).toBe('upi');
      expect(body.amount).toBe(2500);
      expect(body.lineItems).toEqual([
        expect.objectContaining({ type: 'service', itemId: '21', quantity: 1, unitPrice: '1500' }),
        expect.objectContaining({ type: 'product', itemId: '31', quantity: 2, unitPrice: '500' }),
      ]);
      expect(body.subBrand).toBeUndefined();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Create Invoice/i })).toBeNull();
      expect(notifySuccess).toHaveBeenCalledWith('Invoice created successfully');
    });
  });

  it('uses the persisted final visit bill instead of the catalogue service price', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/wellness/patients/11/visits') {
        return Promise.resolve([{ ...sampleVisit, amountCharged: 5000 }]);
      }
      if (url === '/api/wellness/visits/501/consumptions') return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });

    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const patientPicker = screen.getByRole('combobox', { name: /Customer or patient/i });
    fireEvent.focus(patientPicker);
    fireEvent.click(screen.getByRole('option', { name: /Priya Sharma/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Skin consultation/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Patient visit/i), { target: { value: '501' } });

    await waitFor(() => {
      expect(screen.getByLabelText(/Line item 1 unit price/i).value).toBe('5000');
      expect(screen.getByText('$5000.00', { selector: 'strong' })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Due date/i), { target: { value: '2099-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.amount).toBe(5000);
      expect(body.lineItems).toEqual([
        expect.objectContaining({ type: 'service', itemId: '21', unitPrice: '5000' }),
      ]);
    });
  });

  it('does not submit line items whose rounded total differs from the visit final bill', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/wellness/patients/11/visits') {
        return Promise.resolve([{ ...sampleVisit, amountCharged: 100 }]);
      }
      if (url === '/api/wellness/visits/501/consumptions') return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });

    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });
    await waitFor(() => expect(screen.getByText('Invoice Ledger')).toBeInTheDocument());
    await openCreateInvoiceForm();

    const patientPicker = screen.getByRole('combobox', { name: /Customer or patient/i });
    fireEvent.focus(patientPicker);
    fireEvent.click(screen.getByRole('option', { name: /Priya Sharma/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Skin consultation/ })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Patient visit/i), { target: { value: '501' } });
    await waitFor(() => expect(screen.getByLabelText(/Line item 1 unit price/i).value).toBe('100'));

    fireEvent.change(screen.getByLabelText(/Line item 1 quantity/i), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/Due date/i), { target: { value: '2099-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: /Issue Invoice/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'The invoice line items must add up exactly to the visit final bill',
      );
    });
    expect(
      fetchApiMock.mock.calls.some(
        ([url, opts]) => url === '/api/billing' && opts?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('shows wellness customer, product/service, quantity, and payment columns in the ledger', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/billing' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(sampleWellnessInvoices);
      }
      return defaultFetchMock(url, opts);
    });
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' });

    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.getByRole('columnheader', { name: /Customer \/ Patient/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Products \/ Services/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Qty$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Payment Mode/i })).toBeInTheDocument();
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Skin consultation')).toBeInTheDocument();
    expect(screen.getByText('Aftercare kit')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(screen.getByText('UPI')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2026-06-01' }).querySelector('svg')).toBeNull();
    const wellnessUnpaidBadge = screen.getAllByText('Unpaid').find((node) => node.closest('tr'));
    expect(wellnessUnpaidBadge.getAttribute('style')).toMatch(/border:\s*0px?\s+solid\s+transparent/i);
  });
});

describe('<Invoices /> — server-side date filter', () => {
  /** Same as defaultFetchMock but tolerant of a query string on /api/billing. */
  function rangeAwareMock(url, opts) {
    if (String(url).startsWith('/api/billing') && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve(sampleInvoices);
    }
    return defaultFetchMock(url, opts);
  }

  /** The most recent GET to the ledger endpoint. */
  function lastLedgerCall() {
    const calls = fetchApiMock.mock.calls.filter(
      ([url, opts]) => String(url).startsWith('/api/billing') && (!opts || !opts.method || opts.method === 'GET'),
    );
    return calls.length ? String(calls[calls.length - 1][0]) : null;
  }

  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifyInfo.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockResolvedValue(true);
    fetchApiMock.mockImplementation(rangeAwareMock);
  });

  it('sends no date params by default, so the ledger URL is unchanged', async () => {
    renderInvoices();
    await waitFor(() => expect(lastLedgerCall()).toBe('/api/billing'));
    // The whole point of defaulting to "All time": every existing caller and
    // test keeps hitting the bare endpoint.
    expect(lastLedgerCall()).not.toContain('from=');
    expect(lastLedgerCall()).not.toContain('dateField=');
  });

  it('re-fetches from the backend with a date range when a preset is picked', async () => {
    renderInvoices();
    await waitFor(() => expect(lastLedgerCall()).toBe('/api/billing'));

    fireEvent.change(screen.getByLabelText(/filter invoices by date range/i), {
      target: { value: '30' },
    });

    // The assertion that matters for "make sure it is from the backend": the
    // page issues a NEW request rather than slicing the array it already has.
    await waitFor(() => expect(lastLedgerCall()).toContain('from='));
    const url = lastLedgerCall();
    expect(url).toMatch(/from=\d{4}-\d{2}-\d{2}/);
    expect(url).not.toContain('dateField=');
    // A relative preset has no upper bound — "last 30 days" runs to now.
    expect(url).not.toContain('to=');
  });

  it('does not render a separate date-column filter next to the date range', async () => {
    renderInvoices();
    await waitFor(() => expect(lastLedgerCall()).toBe('/api/billing'));

    expect(screen.queryByLabelText(/choose which invoice date to filter on/i)).toBeNull();
    expect(screen.getByLabelText(/filter invoices by date range/i))
      .toHaveClass('invoice-date-range-filter');
    expect(screen.getByLabelText(/filter invoices by status/i)).toBeInTheDocument();
  });

  it('custom range exposes both date inputs and sends from + to', async () => {
    renderInvoices();
    await waitFor(() => expect(lastLedgerCall()).toBe('/api/billing'));

    fireEvent.change(screen.getByLabelText(/filter invoices by date range/i), {
      target: { value: 'CUSTOM' },
    });
    fireEvent.change(screen.getByLabelText(/^from date$/i), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText(/^to date$/i), { target: { value: '2026-08-28' } });

    await waitFor(() => expect(lastLedgerCall()).toContain('to=2026-08-28'));
    expect(lastLedgerCall()).toContain('from=2026-08-01');
    expect(lastLedgerCall()).not.toContain('dateField=');
  });

  it('leaves color-scheme to the stylesheet so the picker icon survives both themes', async () => {
    renderInvoices();
    await waitFor(() => expect(lastLedgerCall()).toBe('/api/billing'));

    fireEvent.change(screen.getByLabelText(/filter invoices by date range/i), {
      target: { value: 'CUSTOM' },
    });

    // index.css drives `color-scheme` off [data-theme] for every date input so
    // the browser's native calendar button renders dark-on-light in light mode
    // and light-on-dark in dark mode. An INLINE color-scheme outranks that
    // stylesheet rule — pinning "dark" painted a light icon onto light mode's
    // light input and the button vanished. Nothing here may set it inline.
    for (const label of [/^from date$/i, /^to date$/i]) {
      const input = screen.getByLabelText(label);
      expect(input.style.colorScheme).toBe('');
      expect(input.getAttribute('style') || '').not.toMatch(/color-scheme/i);
    }
  });

  it('the count chip stops claiming a tenant-wide total once a range is active', async () => {
    renderInvoices();
    await waitFor(() => expect(screen.getByText(/total invoices/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/filter invoices by date range/i), {
      target: { value: '30' },
    });

    // Every KPI chip is derived from the now-filtered array, so a label
    // reading "total invoices" would misreport the ledger.
    await waitFor(() => expect(screen.getByText(/invoices in range/i)).toBeInTheDocument());
    expect(screen.queryByText(/total invoices/i)).toBeNull();
  });
});

describe('<Invoices /> — report drill-down filter', () => {
  it('filters the ledger to invoice ids supplied by a report link', async () => {
    renderInvoices(ADMIN_USER, { vertical: 'wellness', defaultCurrency: 'INR' }, ['/invoices?invoiceIds=1']);

    await waitFor(() => expect(screen.getByText('INV-001')).toBeInTheDocument());
    expect(screen.queryByText('INV-002')).toBeNull();
    expect(screen.queryByText('INV-003')).toBeNull();
    expect(screen.getByText(/Report drill-down: 1 invoice/i)).toBeInTheDocument();
  });
});
