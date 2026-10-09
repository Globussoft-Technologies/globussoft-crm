import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PickupCustomers from '../pages/PickupCustomers';
import { NotifyProvider } from '../utils/notify';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), registerGlobalNotify: vi.fn() }));
import { fetchApi } from '../utils/api';

const payload = {
  customers: [
    {
      id: 91,
      pickupAddress: '42 Lake View Road, Bengaluru',
      sourceTranscriptId: '789',
      status: 'PICKED_UP',
      statusUpdatedAt: '2026-10-06T11:00:00.000Z',
      currentStage: 'billing',
      currentStatus: 'INVOICE_SENT',
      currentStatusUpdatedAt: '2026-10-06T13:00:00.000Z',
      contact: { id: 61, name: 'Priya Shah', phone: '9000022222', email: 'priya@example.com', company: 'Bright Homes', status: 'Customer', interestedPlotArea: '1200 sq ft' },
      transportPerson: { id: 41, name: 'Sant', phone: '9000011111' },
      assignedPlot: { id: 30, name: 'Plot 24', address: 'North Avenue' },
      workflowHistory: [
        { id: 1, stage: 'TRANSPORT', toStatus: 'ASSIGNED', label: 'Driver assigned', occurredAt: '2026-10-06T10:00:00.000Z' },
        { id: 2, stage: 'TRANSPORT', toStatus: 'PICKED_UP', label: 'Customer picked up', occurredAt: '2026-10-06T11:00:00.000Z' },
        { id: 3, stage: 'BROKER', toStatus: 'PLOT_SELECTED', label: 'Plot selected', occurredAt: '2026-10-06T12:00:00.000Z' },
        { id: 4, stage: 'BILLING', toStatus: 'INVOICE_SENT', label: 'Invoice sent', occurredAt: '2026-10-06T13:00:00.000Z' },
      ],
      workflow: {
        transport: { status: 'PICKED_UP', updatedAt: '2026-10-06T11:00:00.000Z', assignee: { id: 41, name: 'Sant' } },
        broker: { status: 'PLOT_SELECTED', updatedAt: '2026-10-06T12:00:00.000Z', assignee: { id: 51, name: 'Sanjeev' } },
        billing: { status: 'INVOICE_SENT', updatedAt: '2026-10-06T13:00:00.000Z' },
      },
    },
    {
      id: 92,
      pickupAddress: '8 MG Road, Bengaluru',
      status: 'PICKUP_LOCATION_CAPTURED',
      contact: { id: 62, name: 'Amit Rao', phone: '9000033333' },
      transportPerson: null,
    },
  ],
  summary: { total: 2, awaitingAssignment: 1, activeTrips: 1, completed: 0 },
};

beforeEach(() => {
  fetchApi.mockReset();
  fetchApi.mockResolvedValue(payload);
  window.localStorage.removeItem('pickup-plot-customer-status-column-widths');
});

describe('<PickupCustomers />', () => {
  it('shows transcript pickup locations and live transport status', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    expect(await screen.findByText('Priya Shah')).toBeInTheDocument();
    expect(screen.queryByText('Active trips', { selector: 'span' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search customer status' })).toHaveStyle({ height: '44px', boxSizing: 'border-box' });
    expect(screen.getByRole('combobox', { name: 'Filter customer trip status' })).toHaveStyle({ height: '44px', boxSizing: 'border-box' });
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveStyle({ minHeight: '44px', alignItems: 'center' });
    expect(screen.getByTestId('pickup-customers-table-width')).toHaveStyle({ width: '1670px', minWidth: '100%' });
    expect(screen.getByRole('table', { name: 'Customer pickup status' })).toHaveStyle({ width: '100%', tableLayout: 'fixed' });
    expect(screen.getByRole('columnheader', { name: 'S.No.' })).toBeInTheDocument();
    expect(screen.getAllByRole('separator', { name: /Resize .+ column/ })).toHaveLength(9);
    expect(screen.getByText('42 Lake View Road, Bengaluru')).toBeInTheDocument();
    expect(screen.getByText('Customer picked up')).toBeInTheDocument();
    expect(screen.getByText(/Sant/)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Source' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.getByText('Billing: Invoice sent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open pickup location for Priya Shah in Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=42%20Lake%20View%20Road%2C%20Bengaluru',
    );
    expect(screen.getByRole('link', { name: 'Open pickup location for Priya Shah in Google Maps' })).toHaveAttribute('target', '_blank');
  });

  it('shows transport, Sales Executive, and billing status from the actions column', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByText('Priya Shah');

    fireEvent.click(screen.getByRole('button', { name: 'View all status for Priya Shah' }));

    expect(screen.getByRole('dialog', { name: 'All customer statuses' })).toBeInTheDocument();
    const customerDetails = screen.getByTestId('customer-status-details');
    expect(customerDetails).toBeInTheDocument();
    expect(customerDetails).toHaveTextContent('1200 sq ft');
    expect(screen.getByText('priya@example.com')).toBeInTheDocument();
    expect(screen.getByText('Plot 24')).toBeInTheDocument();
    expect(screen.getByText('North Avenue')).toBeInTheDocument();
    expect(screen.getByText('Workflow progress')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-timeline')).toBeInTheDocument();
    expect(screen.getAllByTestId('workflow-connector').length).toBeGreaterThan(10);
    expect(screen.getAllByText('Awaiting transport assignment')).toHaveLength(2);
    expect(screen.getByText('Transport assigned')).toBeInTheDocument();
    expect(screen.getAllByText('Customer picked up')).toHaveLength(2);
    expect(screen.getByText('Plot selected')).toBeInTheDocument();
    expect(screen.getByText('Invoice sent')).toBeInTheDocument();
    expect(screen.getByText('Transaction completed')).toBeInTheDocument();
    expect(screen.getByText('Assigned to Sanjeev')).toBeInTheDocument();
  });

  it('edits a pickup location without changing the transcript metadata', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByText('Priya Shah');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Priya Shah pickup location' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pickup location' }), { target: { value: '55 Residency Road, Bengaluru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/61',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ pickupAddress: '55 Residency Road, Bengaluru', sourceTranscriptId: '789', sourceExcerpt: null }),
      }),
    ));
  });

  it('keeps the page fixed while only the table data scrolls', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByText('Priya Shah');

    expect(screen.getByTestId('pickup-customers-page')).toHaveStyle({ overflow: 'hidden', minHeight: '0' });
    expect(screen.getByTestId('pickup-customers-table-scroll')).toHaveClass('pickup-plot-table-scroll');
    expect(screen.getByTestId('pickup-customers-table-scroll')).toHaveStyle({ overflowY: 'auto', minHeight: '0' });
    expect(screen.getByRole('columnheader', { name: 'Customer' })).toHaveStyle({
      position: 'sticky', top: '0px', color: 'var(--text-secondary)',
      background: '#f3f4f6',
    });
  });

  it('filters customers awaiting transport assignment', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByText('Priya Shah');
    fireEvent.change(screen.getByLabelText('Filter customer trip status'), { target: { value: 'waiting' } });
    expect(screen.getByText('Amit Rao')).toBeInTheDocument();
    expect(screen.queryByText('Priya Shah')).not.toBeInTheDocument();
  });
});
