import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getActiveTenantId: () => null,
  getAuthToken: () => 'test-token',
}));

const notify = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));
vi.mock('../utils/money', () => ({ formatMoney: (value) => `$${(Number(value) || 0).toFixed(2) }` }));
vi.mock('../utils/date', () => ({ formatDate: (value) => value ? '2026-12-31' : '—' }));

import Quotes from '../pages/Quotes';

const quote = {
  id: 1,
  quoteNumber: 'QUO-001',
  title: 'Website refresh',
  customerName: 'Acme Corp',
  customerEmail: 'hello@acme.test',
  status: 'Draft',
  currency: 'USD',
  validUntil: '2026-12-31',
  totalAmount: 1180,
  lineItems: [{ id: 1 }],
};

const quoteDetail = {
  ...quote,
  contactId: 1,
  dealId: 1,
  quoteOwnerName: 'Rajesh Sharma',
  accountName: 'Acme Corp',
  adjustment: 0,
  billingAddress: JSON.stringify({ line1: '1 Main Street', city: 'Pune' }),
  shippingAddress: JSON.stringify({ line1: '1 Main Street', city: 'Pune' }),
  terms: 'Payment due within 30 days.',
  lineItems: [{ id: 1, productName: 'Implementation', description: 'Core setup', quantity: 1, cost: 500, unitPrice: 1000, discountPercent: 0, gstRate: 7.5, amount: 1000, total: 1075 }],
};

function defaultFetch(url, options) {
  if (url.startsWith('/api/quotes?')) return Promise.resolve({ data: [quote], pagination: { total: 1, totalPages: 1 } });
  if (url === '/api/quotes/stats') return Promise.resolve({ total: 1, byStatus: { Draft: 1 }, totalValue: 1180 });
  if (url === '/api/quotes/1' && !options?.method) return Promise.resolve(quoteDetail);
  if (url === '/api/quotes/1' && options?.method === 'PATCH') return Promise.resolve(quoteDetail);
  if (url === '/api/quotes/1' && options?.method === 'DELETE') return Promise.resolve({ ok: true });
  if (url.startsWith('/api/contacts')) return Promise.resolve([{ id: 1, name: 'Acme Corp', email: 'hello@acme.test' }]);
  if (url.startsWith('/api/deals')) return Promise.resolve([{ id: 1, title: 'Acme renewal' }]);
  if (url === '/api/quotes' && options?.method === 'POST') return Promise.resolve({ ...quote, id: 2 });
  return Promise.resolve([]);
}

describe('<Quotes />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetch);
    Object.values(notify).forEach((fn) => fn.mockClear());
  });

  it('renders the quote workspace and a quote row', async () => {
    render(<Quotes />);
    expect(await screen.findByRole('heading', { name: 'Quotes' })).toBeInTheDocument();
    expect(screen.getByText('QUO-001')).toBeInTheDocument();
    expect(screen.getByText('Website refresh')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create quote/i })).toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([url]) => url === '/api/quotes/catalog')).toBe(false);
  });

  it('opens the builder and posts quote information plus line items', async () => {
    render(<Quotes />);
    await screen.findByText('QUO-001');
    fireEvent.click(screen.getByRole('button', { name: /Create quote/i }));
    fireEvent.change(screen.getByPlaceholderText('e.g. Website redesign proposal'), { target: { value: 'New proposal' } });
    fireEvent.change(screen.getByLabelText('Item 1 name'), { target: { value: 'Implementation' } });
    fireEvent.change(screen.getByLabelText('Item 1 unit price'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Item 1 GST'), { target: { value: '7.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save quote/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/quotes' && options?.method === 'POST');
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.subject).toBe('New proposal');
      expect(body.lineItems[0]).toMatchObject({ productName: 'Implementation', unitPrice: '1000', gstRate: '7.5' });
    });
  });

  it('sets a minimum date for valid-until validation', async () => {
    render(<Quotes />);
    await screen.findByText('QUO-001');
    fireEvent.click(screen.getByRole('button', { name: /Create quote/i }));

    const validUntil = screen.getByLabelText('Valid until');
    expect(validUntil).toHaveAttribute('min');
    fireEvent.change(validUntil, { target: { value: '2020-01-01' } });
    expect(validUntil.checkValidity()).toBe(false);
  });

  it('loads a saved quote for editing and patches the updated values', async () => {
    render(<Quotes />);
    await screen.findByText('QUO-001');
    fireEvent.click(screen.getByRole('button', { name: 'Edit QUO-001' }));

    expect(await screen.findByRole('heading', { name: 'Edit quote' })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('Website refresh'), { target: { value: 'Updated proposal' } });
    fireEvent.click(screen.getByRole('button', { name: /Update quote/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url, options]) => url === '/api/quotes/1' && options?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toMatchObject({ subject: 'Updated proposal' });
    });
  });

  it('keeps edit, PDF download, and delete actions available on a saved quote', async () => {
    render(<Quotes />);
    await screen.findByText('QUO-001');

    expect(screen.getByRole('button', { name: 'Edit QUO-001' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF for QUO-001' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete QUO-001' }));

    await waitFor(() => {
      expect(fetchApiMock.mock.calls.some(([url, options]) => url === '/api/quotes/1' && options?.method === 'DELETE')).toBe(true);
    });
  });

  it('shows one editable status dropdown with the current quote status', async () => {
    render(<Quotes />);
    await screen.findByText('QUO-001');

    const statusSelect = screen.getByRole('combobox', { name: 'Change status for QUO-001' });
    expect(statusSelect).toHaveValue('Draft');
    expect(screen.getAllByRole('combobox', { name: 'Change status for QUO-001' })).toHaveLength(1);

    fireEvent.change(statusSelect, { target: { value: 'Sent' } });
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/quotes/1/status',
      { method: 'PATCH', body: JSON.stringify({ status: 'Sent' }) },
    ));
  });

  it('keeps template download inside the import flow', async () => {
    render(<Quotes />);
    await screen.findByText('QUO-001');

    expect(screen.queryByRole('button', { name: /^Template$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Import/i }));

    expect(await screen.findByRole('heading', { name: 'Import quotes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^CSV$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^XLSX$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Choose file/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Close import dialog$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Export$/i }));
    expect(screen.getByRole('menuitem', { name: /Export CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Export XLSX/i })).toBeInTheDocument();
  });
});
