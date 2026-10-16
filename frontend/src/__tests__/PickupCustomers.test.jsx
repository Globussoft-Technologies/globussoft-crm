import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PickupCustomers from '../pages/PickupCustomers';
import { NotifyProvider } from '../utils/notify';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), registerGlobalNotify: vi.fn() }));
import { fetchApi } from '../utils/api';

const payload = {
  plots: [
    { id: 30, name: 'North Avenue', plotNumber: '24', block: 'B', availability: 'RESERVED' },
    { id: 31, name: 'North Avenue', plotNumber: '25', block: 'B', availability: 'AVAILABLE' },
    { id: 32, name: 'North Avenue', plotNumber: '107', block: 'C', availability: 'AVAILABLE' },
    { id: 34, name: 'North Avenue', plotNumber: '25', block: 'D', availability: 'AVAILABLE' },
    { id: 35, name: 'Lake View', plotNumber: '8', block: 'C', availability: 'AVAILABLE' },
    { id: 33, name: 'Garden Road', plotNumber: '9', block: 'A', availability: 'SOLD' },
  ],
  customers: [
    {
      id: 91,
      pickupAddress: '42 Lake View Road, Bengaluru',
      sourceTranscriptId: '789',
      status: 'COMPLETED',
      statusUpdatedAt: '2026-10-06T11:00:00.000Z',
      currentStage: 'billing',
      currentStatus: 'INVOICE_SENT',
      currentStatusUpdatedAt: '2026-10-06T13:00:00.000Z',
      contact: { id: 61, name: 'Priya Shah', phone: '9000022222', email: 'priya@example.com', company: 'Bright Homes', status: 'Customer', interestedPlotArea: '1200 sq ft' },
      transportPerson: { id: 41, name: 'Sant', phone: '9000011111' },
      assignedPlot: {
        id: 30, name: 'North Avenue', plotNumber: '24', block: 'B', address: 'North Avenue',
        referenceCode: 'NC-24', area: '1200', areaUnit: 'SQ_FT', roadWidth: '40 ft',
        facing: 'NORTH', propertyType: 'RESIDENTIAL', price: 4500000, availability: 'RESERVED',
      },
      assignedPlots: [{
        id: 30, name: 'North Avenue', plotNumber: '24', block: 'B', address: 'North Avenue',
        referenceCode: 'NC-24', area: '1200', areaUnit: 'SQ_FT', roadWidth: '40 ft',
        facing: 'NORTH', propertyType: 'RESIDENTIAL', price: 4500000, availability: 'RESERVED',
      }],
      booking: { id: 501, bookingNumber: 'BOOK-501', totalAmount: 4500000, amountPaid: 1500000, balance: 3000000 },
      payments: [
        { id: 701, amount: 1000000, currency: 'INR', gateway: 'upi', gatewayId: 'UTR-ONE', status: 'SUCCESS', paidAt: '2026-10-07T10:00:00.000Z' },
        { id: 702, amount: 500000, currency: 'INR', gateway: 'bank_transfer', gatewayId: 'UTR-TWO', status: 'SUCCESS', paidAt: '2026-10-08T10:00:00.000Z' },
      ],
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
});

describe('<PickupCustomers />', () => {
  it('shows a customer table on the left and the selected customer details on the right', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    expect(await screen.findByRole('button', { name: 'Priya Shah' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table', { name: 'Customer list' })).toBeInTheDocument();
    expect(screen.getByTestId('selected-customer-details')).toBeInTheDocument();
    expect(screen.getByText('42 Lake View Road, Bengaluru')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Selected customer details' })).toHaveTextContent('Sant');
    expect(screen.getByRole('table', { name: 'Selected customer details' })).toHaveTextContent('Billing: Invoice sent');
    expect(screen.getByRole('link', { name: 'Open pickup location for Priya Shah in Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=42%20Lake%20View%20Road%2C%20Bengaluru',
    );
    expect(screen.getByRole('link', { name: 'Open pickup location for Priya Shah in Google Maps' })).toHaveAttribute('target', '_blank');
  });

  it('shows the selected plot details and converts completed payments to tables', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    const plotTable = screen.getByRole('table', { name: 'Selected plot details' });
    expect(plotTable).toHaveTextContent('Plot number24');
    expect(plotTable).toHaveTextContent('NC-24');
    expect(plotTable).toHaveTextContent('RESIDENTIAL');
    expect(screen.getByRole('table', { name: 'Initial deposit payment' })).toHaveTextContent('UTR-ONE');
    expect(screen.getByRole('table', { name: 'Initial deposit payment' })).toHaveTextContent('₹10,00,000');
    expect(screen.getByRole('table', { name: 'Initial deposit payment' })).toHaveTextContent('10/7/2026');
    expect(screen.getByRole('table', { name: 'Future installment payments' })).toHaveTextContent('UTR-TWO');
  });

  it('does not show transport-assigned plots as selected before the customer chooses one', async () => {
    const transportOnlyCustomer = {
      ...payload.customers[0],
      booking: null,
      assignedPlot: payload.customers[0].assignedPlot,
      assignedPlots: [payload.customers[0].assignedPlot],
      selectedPlot: null,
      customerAssignedPlotIds: [],
      currentStage: 'transport',
      currentStatus: 'TRANSPORT_ASSIGNED',
      status: 'TRANSPORT_ASSIGNED',
      workflow: { ...payload.customers[0].workflow, broker: { status: 'INTEREST_CONFIRMED' } },
    };
    fetchApi.mockResolvedValue({ ...payload, customers: [transportOnlyCustomer, payload.customers[1]] });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.getByText('No plot selected', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign plots to Priya Shah' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View plots for Priya Shah' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Generate payment|Generate installment/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Assign plots to Priya Shah' }));
    const assignDialog = screen.getByRole('dialog', { name: 'Assign plots' });
    expect(within(assignDialog).getByRole('checkbox', { name: /Plot 25/ })).toBeInTheDocument();
  });

  it('shows only the selected plot and does not expose other assigned plots in the detail section', async () => {
    const secondPlot = {
      id: 32, name: 'North Avenue', plotNumber: '107', block: 'C', address: 'South Avenue',
      referenceCode: 'NC-107', area: '1600', areaUnit: 'SQ_FT', roadWidth: '50 ft',
      facing: 'SOUTH', propertyType: 'COMMERCIAL', price: 5100000, availability: 'RESERVED',
    };
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{ ...payload.customers[0], assignedPlots: [...payload.customers[0].assignedPlots, secondPlot] }, payload.customers[1]],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.queryByRole('combobox', { name: 'View assigned plot' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Selected plot details' })).toHaveTextContent('Plot number24');
    expect(screen.queryByText('NC-107')).toBeNull();
    expect(screen.getAllByRole('table', { name: 'Selected plot details' })).toHaveLength(1);
  });

  it('replaces Assign plots with a popup listing assigned plot names and numbers', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.queryByRole('button', { name: 'Assign plots to Priya Shah' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View plots for Priya Shah' }));

    const dialog = screen.getByRole('dialog', { name: 'Assigned plots' });
    expect(within(dialog).getByText('North Avenue')).toBeInTheDocument();
    expect(within(dialog).getByText('Plot 24')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close assigned plots' }));
    expect(screen.queryByRole('dialog', { name: 'Assigned plots' })).toBeNull();
  });

  it('records an initial UPI payment with amount, date, and transaction reference', async () => {
    const unpaidPayload = {
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [],
      }, payload.customers[1]],
    };
    fetchApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') return { mode: 'recorded', payment: { id: 703, status: 'SUCCESS' } };
      return unpaidPayload;
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate payment' }));
    fireEvent.change(screen.getByLabelText('Initial payment amount'), { target: { value: '250000' } });
    fireEvent.change(screen.getByLabelText('Initial payment option'), { target: { value: 'upi' } });
    fireEvent.change(screen.getByLabelText('Initial payment date'), { target: { value: '2026-10-15' } });
    fireEvent.change(screen.getByLabelText('Initial payment reference'), { target: { value: 'UTR-NEW-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/61/initial-payment',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('UTR-NEW-15'),
      }),
    ));
    const paymentRequest = fetchApi.mock.calls.find(([url, options]) => (
      url.endsWith('/initial-payment') && options?.method === 'POST'
    ));
    expect(JSON.parse(paymentRequest[1].body)).toMatchObject({ plotBookingId: 501 });
  });

  it('generates an online link that supports UPI, card, and net banking', async () => {
    const unpaidPayload = {
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [],
      }, payload.customers[1]],
    };
    fetchApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') return { mode: 'payment_link', url: 'https://pay.example.test/plot-501' };
      return unpaidPayload;
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate payment' }));
    expect(screen.getByRole('option', { name: 'Online payment link (UPI / Card / Net banking)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

    expect(await screen.findByDisplayValue('https://pay.example.test/plot-501')).toBeInTheDocument();
    expect(screen.getByText('Customer can pay using UPI, card, or net banking.')).toBeInTheDocument();
  });

  it('adds an installment by month and year before initiating its payment', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [{ ...payload.customers[0].payments[0], amount: 1 }],
      }, payload.customers[1]],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.queryByRole('button', { name: 'Generate payment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add installment' })).toBeInTheDocument();
    const installments = screen.getByRole('heading', { name: 'Future installments' }).closest('section');
    expect(installments).toHaveTextContent('44,99,999');
    expect(installments).toHaveTextContent('remains on this booking.');

    fireEvent.click(screen.getByRole('button', { name: 'Add installment' }));
    const addDialog = screen.getByRole('dialog', { name: 'Add installment' });
    fireEvent.change(within(addDialog).getByLabelText('Installment month'), { target: { value: '12' } });
    fireEvent.change(within(addDialog).getByLabelText('Installment year'), { target: { value: '2027' } });
    fireEvent.change(within(addDialog).getByLabelText('New installment amount'), { target: { value: '150000' } });
    fireEvent.click(within(addDialog).getByRole('button', { name: 'Add installment' }));

    const planned = screen.getByRole('table', { name: 'Planned installments' });
    expect(planned).toHaveTextContent('December');
    expect(planned).toHaveTextContent('2027');
    expect(planned).toHaveTextContent('1,50,000');
    fireEvent.click(within(planned).getByRole('button', { name: 'Initiate payment' }));
    expect(screen.getByRole('heading', { name: 'Generate installment payment' })).toBeInTheDocument();
    expect(screen.getByLabelText('Installment payment amount')).toHaveValue(150000);
    expect(screen.getByLabelText('Installment payment amount')).toHaveAttribute('readonly');
    expect(screen.getByText('Remaining installment balance')).toBeInTheDocument();
  });

  it('shows the remaining balance beside recorded installments', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    const installments = screen.getByRole('heading', { name: 'Future installments' }).closest('section');
    expect(installments).toHaveTextContent('Remaining installment balance');
    expect(installments).toHaveTextContent('30,00,000');
  });

  it('shows Add installment when a pending link is listed before successful payments', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[0],
        payments: [
          { id: 700, amount: 99999, currency: 'INR', gateway: 'razorpay', gatewayId: 'plink_pending', status: 'PENDING', createdAt: '2026-10-16T15:34:50.000Z' },
          ...payload.customers[0].payments,
        ],
      }, payload.customers[1]],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.queryByRole('button', { name: 'Generate payment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add installment' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Initial deposit payment' })).toHaveTextContent('UTR-ONE');
    expect(screen.getByRole('table', { name: 'Future installment payments' })).toHaveTextContent('plink pending');
  });

  it('changes the right-side detail when another customer is clicked', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });
    fireEvent.click(screen.getByRole('button', { name: 'Amit Rao' }));

    expect(screen.getByRole('button', { name: 'Amit Rao' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('selected-customer-details')).toHaveTextContent('Amit Rao');
    expect(screen.getAllByText('No plot selected')).toHaveLength(2);
    expect(screen.getByText('Initial deposit not recorded')).toBeInTheDocument();
  });

  it('shows transport, Sales Executive, and billing status from the actions column', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'View all status for Priya Shah' }));

    const dialog = screen.getByRole('dialog', { name: 'All customer statuses' });
    expect(dialog).toBeInTheDocument();
    const dialogScreen = within(dialog);
    const customerDetails = screen.getByTestId('customer-status-details');
    expect(customerDetails).toBeInTheDocument();
    expect(customerDetails).toHaveTextContent('1200 sq ft');
    expect(dialogScreen.getByText('priya@example.com')).toBeInTheDocument();
    expect(dialogScreen.getAllByText('North Avenue').length).toBeGreaterThan(0);
    expect(dialogScreen.getByText('Workflow progress')).toBeInTheDocument();
    expect(dialogScreen.getByTestId('workflow-timeline')).toBeInTheDocument();
    expect(dialogScreen.getAllByTestId('workflow-connector').length).toBeGreaterThan(10);
    expect(dialogScreen.getByText('Awaiting transport assignment')).toBeInTheDocument();
    expect(dialogScreen.getByText('Transport assigned')).toBeInTheDocument();
    expect(dialogScreen.getByText('Customer picked up')).toBeInTheDocument();
    expect(dialogScreen.getByText('Plot selected')).toBeInTheDocument();
    expect(dialogScreen.getByText('Invoice sent')).toBeInTheDocument();
    expect(dialogScreen.getByText('Transaction completed')).toBeInTheDocument();
    expect(dialogScreen.getByText('Assigned to Sanjeev')).toBeInTheDocument();
  });

  it('edits a pickup location without changing the transcript metadata', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

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

  it('assigns multiple available plot numbers beside the edit pickup action', async () => {
    fetchApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') return { bookingsCreated: 2, assignedPlotIds: [30, 31, 32] };
      return payload;
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });
    fireEvent.click(screen.getByRole('button', { name: 'Amit Rao' }));

    fireEvent.click(screen.getByRole('button', { name: 'Assign plots to Amit Rao' }));
    const dialog = screen.getByRole('dialog', { name: 'Assign plots' });
    expect(within(dialog).getByRole('combobox', { name: 'Plot or site name' })).toHaveValue('North Avenue');
    expect(within(dialog).getByRole('combobox', { name: 'Plot or site name' })).toBeEnabled();
    expect(within(dialog).queryByRole('checkbox', { name: /Plot 24/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /Plot 9/ })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /Plot 8/ })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('checkbox', { name: /Plot 25/ })).toHaveLength(1);

    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Plot or site name' }), { target: { value: 'Lake View' } });
    expect(within(dialog).getByRole('checkbox', { name: /Plot 8/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: /Plot 25/ })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Plot or site name' }), { target: { value: 'North Avenue' } });

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Plot 25/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Plot 107/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign 2 plots' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/62/plots',
      { method: 'POST', body: JSON.stringify({ plotSiteIds: [31, 32] }) },
    ));
  });

  it('shows API-provided available plots even when the availability label casing differs', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      plots: [{ id: 36, name: 'Koramangala', plotNumber: '42', block: 'A', availability: 'available' }],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Amit Rao' });
    fireEvent.click(screen.getByRole('button', { name: 'Amit Rao' }));

    fireEvent.click(screen.getByRole('button', { name: 'Assign plots to Amit Rao' }));

    const dialog = screen.getByRole('dialog', { name: 'Assign plots' });
    expect(within(dialog).getByRole('combobox', { name: 'Plot or site name' })).toHaveValue('Koramangala');
    expect(within(dialog).getByRole('checkbox', { name: /Plot 42/ })).toBeInTheDocument();
    expect(within(dialog).queryByText('No available plot numbers')).not.toBeInTheDocument();
  });

  it('shows View plots as soon as plots are assigned to the customer', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[1],
        assignedPlot: payload.plots[1],
        assignedPlots: [payload.plots[1]],
        customerAssignedPlotIds: [31],
      }],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Amit Rao' });
    expect(screen.queryByRole('button', { name: 'Assign plots to Amit Rao' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View plots for Amit Rao' }));

    const dialog = screen.getByRole('dialog', { name: 'Assigned plots' });
    expect(within(dialog).getByText('North Avenue')).toBeInTheDocument();
    expect(within(dialog).getByText('Plot 25')).toBeInTheDocument();
  });

  it('defaults to a site that still has an available plot number', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      plots: [{ id: 35, name: 'Lake View', plotNumber: '8', block: 'C', availability: 'AVAILABLE' }],
      customers: [
        {
          ...payload.customers[1],
          assignedPlots: [{ id: 30, name: 'North Avenue', plotNumber: '24', availability: 'RESERVED' }],
          customerAssignedPlotIds: [],
        },
      ],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Amit Rao' });

    fireEvent.click(screen.getByRole('button', { name: 'Assign plots to Amit Rao' }));

    const dialog = screen.getByRole('dialog', { name: 'Assign plots' });
    expect(within(dialog).getByRole('combobox', { name: 'Plot or site name' })).toHaveValue('Lake View');
    expect(within(dialog).getByRole('checkbox', { name: /Plot 8/ })).toBeInTheDocument();
  });

  it('keeps the page fixed while both master and detail panes can scroll', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.getByTestId('pickup-customers-page')).toHaveClass('pickup-customers-page');
    expect(screen.getByTestId('pickup-customers-table-scroll')).toHaveClass('pickup-directory-scroll');
    expect(screen.getByRole('columnheader', { name: 'Customer' })).toBeInTheDocument();
  });

  it('filters customers awaiting transport assignment', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });
    fireEvent.change(screen.getByLabelText('Filter customer trip status'), { target: { value: 'waiting' } });
    expect(screen.getByRole('button', { name: 'Amit Rao' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Priya Shah' })).not.toBeInTheDocument();
  });

  it('keeps a customer active after transport completes while plot billing is still in progress', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.change(screen.getByLabelText('Filter customer trip status'), { target: { value: 'active' } });

    expect(screen.getByRole('button', { name: 'Priya Shah' })).toBeInTheDocument();
    expect(screen.getAllByText('Invoice sent')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Amit Rao' })).not.toBeInTheDocument();
  });
});
