import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BillingPersons from '../pages/BillingPersons';
import { NotifyProvider } from '../utils/notify';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), registerGlobalNotify: vi.fn() }));
import { fetchApi } from '../utils/api';

const payload = {
  billingPersons: [{
    id: 71, name: 'Bina Shah', phone: '9000011111', email: 'bina@example.com', notes: 'Senior billing', isActive: true,
    customerIds: [61], plotSiteIds: [30], assignments: [{ customerId: 61, plotSiteId: 30 }],
    plots: [{ id: 30, name: 'Plot 24', address: 'North Avenue, Bengaluru' }],
    user: { id: 21, name: 'Bina Shah', email: 'bina@example.com', phone: '9000011111' },
  }],
  customers: [{ id: 61, name: 'Li Wei', company: 'Acme', phone: '9000033333', transportPlotSiteId: 30 }],
  plots: [{ id: 30, name: 'Plot 24', address: 'North Avenue, Bengaluru', availability: 'AVAILABLE' }],
  staffUsers: [{ id: 22, name: 'Ravi Billing', email: 'ravi@example.com', phone: '9000022222' }],
  staffRole: { id: 10, key: 'BILLING', name: 'Billing Department' },
  summary: { total: 1, active: 1, linked: 1 },
};

beforeEach(() => {
  fetchApi.mockReset();
  window.localStorage.removeItem('pickup-plot-billing-directory-column-widths');
});

const renderPage = () => render(<NotifyProvider><BillingPersons /></NotifyProvider>);

describe('<BillingPersons />', () => {
  it('lists billing people with their login and status', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    renderPage();
    expect(await screen.findByText('Bina Shah')).toBeInTheDocument();
    expect(screen.queryByText('Linked logins')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toHaveStyle({ height: '44px', boxSizing: 'border-box' });
    expect(screen.getByRole('button', { name: /Add Billing Person/i })).toHaveStyle({ minHeight: '44px', alignItems: 'center' });
    expect(screen.getByTestId('billing-persons-table-width')).toHaveStyle({ width: '1370px', minWidth: '100%' });
    expect(screen.getByRole('table', { name: 'Billing persons' })).toHaveStyle({ width: '100%', tableLayout: 'fixed' });
    expect(screen.getByRole('columnheader', { name: 'S.No.' })).toBeInTheDocument();
    expect(screen.getAllByRole('separator', { name: /Resize .+ column/ })).toHaveLength(8);
    expect(screen.getByText('bina@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Plot 24 address in Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=North%20Avenue%2C%20Bengaluru',
    );
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Edit Bina Shah' })).toHaveTextContent('');
    expect(screen.getByRole('button', { name: 'Deactivate Bina Shah' })).toHaveTextContent('');
  });

  it('keeps the page fixed while only the table data scrolls', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    renderPage();
    await screen.findByText('Bina Shah');

    expect(screen.getByTestId('billing-directory-page')).toHaveStyle({ overflow: 'hidden', minHeight: '0' });
    expect(screen.getByTestId('billing-directory-table-scroll')).toHaveClass('pickup-plot-table-scroll');
    expect(screen.getByTestId('billing-directory-table-scroll')).toHaveStyle({ overflowX: 'auto', overflowY: 'auto', minHeight: '0' });
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveStyle({
      position: 'sticky', top: '0px', color: 'var(--text-secondary)',
      background: '#f3f4f6',
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

  it('saves person plots and the connected customer plot for a billing person', async () => {
    fetchApi
      .mockResolvedValueOnce({
        ...payload,
        plots: [...payload.plots, { id: 31, name: 'Plot 25', availability: 'AVAILABLE' }],
      })
      .mockResolvedValueOnce({ id: 71 })
      .mockResolvedValueOnce(payload);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Bina Shah' }));
    fireEvent.click(screen.getByRole('button', { name: 'Billing customers (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Li Wei/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Billing plots / sites (select multiple)' }));
    expect(screen.getByRole('checkbox', { name: /Plot 24/ })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: /Plot 25/ }));
    expect(screen.getByText(/Connected customer/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Billing plot for Li Wei' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/billing-persons/71',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const updateCall = fetchApi.mock.calls.find(([url, options]) => url.endsWith('/billing-persons/71') && options?.method === 'PUT');
    const requestBody = JSON.parse(updateCall[1].body);
    expect(requestBody).toMatchObject({
      customerIds: [61], plotSiteIds: [30, 31], assignments: [{ customerId: 61, plotSiteId: 30 }],
    });
  });

  it('hides booked, reserved, and sold plots from billing assignment options', async () => {
    fetchApi.mockResolvedValueOnce({
      ...payload,
      plots: [
        ...payload.plots,
        { id: 31, name: 'Booked Plot', availability: 'BOOKED' },
        { id: 32, name: 'Reserved Plot', availability: 'RESERVED' },
        { id: 33, name: 'Sold Plot', availability: 'SOLD' },
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Add Billing Person/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Billing plots / sites (select multiple)' }));

    expect(screen.getByRole('checkbox', { name: /Plot 24/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Booked Plot/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Reserved Plot/ })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Sold Plot/ })).toBeNull();
  });

  it('shows connected customer plot controls while hiding deleted customers', async () => {
    fetchApi.mockResolvedValueOnce({
      ...payload,
      billingPersons: [{
        ...payload.billingPersons[0],
        customerIds: [61, 329], plotSiteIds: [30, 31],
        assignments: [{ customerId: 61, plotSiteId: 31 }, { customerId: 329, plotSiteId: 31 }],
      }],
      customers: [{ ...payload.customers[0], transportPlotSiteId: 30 }],
      plots: [...payload.plots, { id: 31, name: 'Plot 25', availability: 'AVAILABLE' }],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Bina Shah' }));

    expect(screen.getByRole('combobox', { name: 'Billing plot for Li Wei' })).toHaveValue('30');
    expect(screen.getByRole('combobox', { name: 'Billing plot for Li Wei' })).toBeDisabled();
    expect(screen.getByText(/Connected customer/)).toBeInTheDocument();
    expect(screen.queryByText('Customer 329')).toBeNull();
  });

  it('hides a customer once another billing person has started work', async () => {
    fetchApi.mockResolvedValueOnce({
      ...payload,
      customers: [
        { ...payload.customers[0], name: 'Claimed Customer', claimedByPersonId: 71 },
        { id: 62, name: 'Available Customer', transportPlotSiteId: 30, claimedByPersonId: null },
      ],
    });
    renderPage();
    await screen.findByText('Bina Shah');
    fireEvent.click(screen.getByRole('button', { name: /Add Billing Person/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Billing plots / sites (select multiple)' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Plot 24/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Billing customers (select multiple)' }));

    expect(screen.queryByRole('checkbox', { name: /Claimed Customer/ })).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Available Customer/ })).toBeInTheDocument();
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
