import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BillingPersons from '../pages/BillingPersons';
import { NotifyProvider } from '../utils/notify';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), registerGlobalNotify: vi.fn() }));
import { fetchApi } from '../utils/api';

const payload = {
  billingPersons: [{
    id: 71, name: 'Bina Shah', phone: '9000011111', email: 'bina@example.com', notes: 'Senior billing', isActive: true,
    customerIds: [61], plotSiteIds: [30],
    user: { id: 21, name: 'Bina Shah', email: 'bina@example.com', phone: '9000011111' },
  }],
  customers: [{ id: 61, name: 'Li Wei', company: 'Acme', phone: '9000033333' }],
  plots: [{ id: 30, name: 'Plot 24', availability: 'AVAILABLE' }],
  staffUsers: [{ id: 22, name: 'Ravi Billing', email: 'ravi@example.com', phone: '9000022222' }],
  staffRole: { id: 10, key: 'BILLING', name: 'Billing Department' },
  summary: { total: 1, active: 1, linked: 1 },
};

beforeEach(() => fetchApi.mockReset());

const renderPage = () => render(<NotifyProvider><BillingPersons /></NotifyProvider>);

describe('<BillingPersons />', () => {
  it('lists billing people with their login and status', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    renderPage();
    expect(await screen.findByText('Bina Shah')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Billing persons' })).toHaveStyle({ width: '100%', minWidth: '0', tableLayout: 'fixed' });
    expect(screen.getByText('bina@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Edit Bina Shah' })).toHaveTextContent('');
    expect(screen.getByRole('button', { name: 'Deactivate Bina Shah' })).toHaveTextContent('');
  });

  it('keeps the page fixed while only the table data scrolls', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    renderPage();
    await screen.findByText('Bina Shah');

    expect(screen.getByTestId('billing-directory-page')).toHaveStyle({ overflow: 'hidden', minHeight: '0' });
    expect(screen.getByTestId('billing-directory-table-scroll')).toHaveStyle({ overflowY: 'auto', minHeight: '0' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveStyle({
      position: 'sticky', top: '0px',
      background: 'linear-gradient(var(--table-header-bg, rgba(148,163,184,.08)), var(--table-header-bg, rgba(148,163,184,.08))), var(--popover-bg, #fff)',
    });
  });

  it('links an existing Billing-role staff member', async () => {
    fetchApi
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ id: 72 })
      .mockResolvedValueOnce({ ...payload, billingPersons: [] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Add Billing Person/i }));
    expect(screen.getByRole('dialog', { name: 'Add Billing Person' })).toHaveStyle({
      opacity: '1', background: 'var(--popover-bg, #fff)', backdropFilter: 'none',
    });
    fireEvent.change(screen.getByLabelText('Billing login setup'), { target: { value: 'existing' } });
    fireEvent.change(screen.getByLabelText('Existing billing staff'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/billing-persons',
      expect.objectContaining({ method: 'POST' }),
    ));
    const createCall = fetchApi.mock.calls.find(([url, options]) => url.endsWith('/billing-persons') && options?.method === 'POST');
    expect(JSON.parse(createCall[1].body)).toMatchObject({ staffUserId: 22, name: 'Ravi Billing' });
  });

  it('saves shared customer and plot assignments for a billing person', async () => {
    fetchApi
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ id: 71 })
      .mockResolvedValueOnce(payload);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Bina Shah' }));
    fireEvent.click(screen.getByRole('button', { name: 'Billing customers (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Li Wei/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Billing plots / sites (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Plot 24/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/billing-persons/71',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const updateCall = fetchApi.mock.calls.find(([url, options]) => url.endsWith('/billing-persons/71') && options?.method === 'PUT');
    expect(JSON.parse(updateCall[1].body)).toMatchObject({ customerIds: [61], plotSiteIds: [30] });
  });

  it('deactivates a billing person', async () => {
    fetchApi
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ id: 71, isActive: false })
      .mockResolvedValueOnce(payload);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate Bina Shah' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/pickup-plot-inventory/billing-persons/71/status', {
      method: 'PATCH', body: JSON.stringify({ isActive: false }),
    }));
  });
});
