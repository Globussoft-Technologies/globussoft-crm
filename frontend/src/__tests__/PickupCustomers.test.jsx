import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PickupCustomers from '../pages/PickupCustomers';
import { NotifyProvider } from '../utils/notify';
import { AuthContext } from '../appContexts';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn(), registerGlobalNotify: vi.fn() }));
import { fetchApi } from '../utils/api';

const responsiveCss = readFileSync(resolve(process.cwd(), 'src/pages/PickupCustomers.css'), 'utf8');

const payload = {
  pickupLocations: [
    { id: 4, name: 'Lake View', address: '42 Lake View Road, Bengaluru' },
    { id: 5, name: 'Residency Road', address: '55 Residency Road, Bengaluru' },
  ],
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
        transport: {
          status: 'PICKED_UP', updatedAt: '2026-10-06T11:00:00.000Z',
          pickupAt: '2026-10-06T11:00:00.000Z', dropOffAt: '2026-10-06T11:45:00.000Z',
          assignee: { id: 41, name: 'Sant' },
        },
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
  it('shows the admin commission ledger and approves an earned commission', async () => {
    const adminPayload = {
      ...payload,
      customers: [{
        ...payload.customers[0],
        commissions: [{
          id: 801, brokerName: 'Sanjeev', eligibleAmount: 4500000,
          commissionPercent: 10, commissionAmount: 450000, commissionDeducted: 450000,
          commissionOutstanding: 0, currency: 'INR', status: 'EARNED',
          allocations: [
            { paymentId: 701, paidAt: '2026-10-07T10:00:00.000Z', grossAmount: 1000000, commissionDeduction: 450000, netPaymentAmount: 550000 },
            { paymentId: 702, paidAt: '2026-10-08T10:00:00.000Z', grossAmount: 500000, commissionDeduction: 0, netPaymentAmount: 500000 },
          ],
        }],
      }, payload.customers[1]],
    };
    fetchApi.mockResolvedValue(adminPayload);
    render(
      <AuthContext.Provider value={{ user: { role: 'ADMIN' } }}>
        <NotifyProvider><PickupCustomers /></NotifyProvider>
      </AuthContext.Provider>,
    );

    const ledger = await screen.findByRole('table', { name: 'Plot commission ledger' });
    expect(ledger).toHaveTextContent('Sanjeev');
    const rateInput = within(ledger).getByRole('spinbutton', { name: 'Commission percentage for Sanjeev' });
    expect(rateInput).toHaveValue(10);
    expect(within(ledger).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Commission history' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Future installment payment history' })).toBeNull();
    expect(within(ledger).queryByRole('button', { name: 'Commission history' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Commission history' }));
    const commissionDialog = screen.getByRole('dialog', { name: 'Commission history' });
    expect(commissionDialog.parentElement?.parentElement).toBe(document.body);
    expect(within(commissionDialog).getByRole('table', { name: 'Commission history' })).toHaveTextContent('₹4,50,000.00');
    expect(within(commissionDialog).queryByRole('table', { name: 'Future installment payment history' })).toBeNull();
    fireEvent.click(within(commissionDialog).getByRole('button', { name: 'Close commission history' }));
    expect(screen.queryByRole('dialog', { name: 'Commission history' })).toBeNull();
    fireEvent.change(rateInput, { target: { value: '5' } });
    expect(ledger).toHaveTextContent('₹2,25,000.00');
    expect(ledger).toHaveTextContent('₹45,00,000.00 × 5%');
    fireEvent.click(within(ledger).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/commissions/801/rate',
      { method: 'PATCH', body: JSON.stringify({ commissionPercent: 5 }) },
    ));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/commissions/801/status',
      { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED' }) },
    ));
  });

  it('does not offer commission or installment history before a successful payment', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[0],
        payments: [{ id: 700, amount: 100000, status: 'PENDING', gateway: 'razorpay' }],
        commissions: [{
          id: 801, brokerName: 'Sanjeev', eligibleAmount: 4500000,
          commissionPercent: 10, currency: 'INR', status: 'EARNED', allocations: [],
        }],
      }, payload.customers[1]],
    });
    render(
      <AuthContext.Provider value={{ user: { role: 'ADMIN' } }}>
        <NotifyProvider><PickupCustomers /></NotifyProvider>
      </AuthContext.Provider>,
    );

    const ledger = await screen.findByRole('table', { name: 'Plot commission ledger' });
    expect(within(ledger).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commission history' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Payment history' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Commission history' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Future installment payment history' })).toBeNull();
  });

  it('shows a customer table on the left and the selected customer details on the right', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    expect(await screen.findByRole('button', { name: 'Priya Shah' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table', { name: 'Customer list' })).toBeInTheDocument();
    expect(screen.getByTestId('selected-customer-details')).toBeInTheDocument();
    expect(screen.getByText('42 Lake View Road, Bengaluru')).toBeInTheDocument();
    const customerDetails = screen.getByRole('table', { name: 'Selected customer details' });
    expect(customerDetails).toHaveTextContent('Sant');
    expect(customerDetails).toHaveTextContent('Pickup time');
    expect(customerDetails).toHaveTextContent('Site visit / drop-off time');
    expect(customerDetails).toHaveTextContent('2026');
    expect(customerDetails).toHaveTextContent('Billing: Invoice sent');
    expect(screen.getByRole('link', { name: 'Open pickup location for Priya Shah in Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=42%20Lake%20View%20Road%2C%20Bengaluru',
    );
    expect(screen.getByRole('link', { name: 'Open pickup location for Priya Shah in Google Maps' })).toHaveAttribute('target', '_blank');
  });

  it('keeps billing tables mounted during a background refresh', async () => {
    let resolveRefresh;
    fetchApi
      .mockResolvedValueOnce(payload)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));

    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(screen.getByTestId('selected-customer-details')).toBeInTheDocument();
    expect(screen.queryByText('Loading customer details…')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status', { name: 'Refreshing customer billing data' })).toBeInTheDocument());

    resolveRefresh(payload);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
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
    expect(screen.getByRole('table', { name: 'Initial deposit payment' })).toHaveTextContent(/7\/10\/2026/);
    expect(screen.queryByText('1 installment payment recorded')).toBeNull();
    expect(screen.queryByText('Use Payment history above to review payment details.')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Future installment payment history' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Payment history' }));
    const paymentDialog = screen.getByRole('dialog', { name: 'Future installment payment history' });
    expect(paymentDialog.parentElement?.parentElement).toBe(document.body);
    expect(within(paymentDialog).getByRole('table', { name: 'Future installment payment history' })).toHaveTextContent('UTR-TWO');
    expect(within(paymentDialog).queryByRole('table', { name: 'Commission history' })).toBeNull();
    fireEvent.click(within(paymentDialog).getByRole('button', { name: 'Close payment history' }));
    expect(screen.queryByRole('dialog', { name: 'Future installment payment history' })).toBeNull();
  });

  it('shows a dash instead of a reference for cash payments', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[0],
        payments: [
          payload.customers[0].payments[0],
          { ...payload.customers[0].payments[1], gateway: 'cash', gatewayId: 'LEGACY-CASH-REF', transactionRef: null },
        ],
      }, payload.customers[1]],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Payment history' }));
    const history = screen.getByRole('table', { name: 'Future installment payment history' });
    expect(history).toHaveTextContent('cash');
    expect(history).toHaveTextContent('-');
    expect(history).not.toHaveTextContent('LEGACY-CASH-REF');
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

  it('offers only online link and cash, and records cash without asking for a reference', async () => {
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
    const paymentOptions = within(screen.getByRole('dialog', { name: 'Generate initial payment' })).getAllByRole('option');
    expect(paymentOptions.map((option) => option.textContent)).toEqual([
      'Online payment link (UPI / Card / Net banking)',
      'Record cash payment',
    ]);
    fireEvent.change(screen.getByLabelText('Initial payment option'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Initial payment date and time'), { target: { value: '2026-10-15T14:35:27' } });
    expect(screen.queryByLabelText('Initial payment reference')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/61/initial-payment',
      expect.objectContaining({
        method: 'POST',
      }),
    ));
    const paymentRequest = fetchApi.mock.calls.find(([url, options]) => (
      url.endsWith('/initial-payment') && options?.method === 'POST'
    ));
    const paymentBody = JSON.parse(paymentRequest[1].body);
    expect(paymentBody).toMatchObject({
      plotBookingId: 501,
      method: 'cash',
      paidAt: new Date('2026-10-15T14:35:27').toISOString(),
    });
    expect(paymentBody).not.toHaveProperty('transactionRef');
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

  it('shows an active payment link action in the initial deposit table', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [{
          id: 700, amount: 450000, currency: 'INR', gateway: 'razorpay', gatewayId: 'plink_initial',
          status: 'PENDING', createdAt: '2026-10-27T05:30:00.000Z', paymentLinkUrl: 'https://pay.example/initial',
        }],
      }, payload.customers[1]],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    const initialPayment = screen.getByRole('table', { name: 'Initial deposit payment' });
    expect(within(initialPayment).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
    expect(within(initialPayment).getByRole('link', { name: 'Open payment link' })).toHaveAttribute('href', 'https://pay.example/initial');
  });

  it('does not report an online payment as recorded when Razorpay returns no link', async () => {
    const unpaidPayload = {
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [],
      }, payload.customers[1]],
    };
    fetchApi.mockImplementation(async (_url, options = {}) => (
      options.method === 'POST' ? { mode: 'payment_link', gateway: 'razorpay' } : unpaidPayload
    ));
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate link' }));

    expect(await screen.findByText(/Razorpay did not return a payment link/i)).toBeInTheDocument();
    expect(screen.queryByText('Initial payment recorded.')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Generate initial payment' })).toBeInTheDocument();
  });

  it('lets an admin choose a percentage, direct amount, or full initial payment', async () => {
    const unpaidPayload = {
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [],
      }, payload.customers[1]],
    };
    fetchApi.mockResolvedValue(unpaidPayload);
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Generate payment' }));
    const amount = screen.getByLabelText('Initial payment amount');
    const percentage = screen.getByLabelText('Initial payment percentage');
    expect(screen.getByRole('radio', { name: /Minimum payment/ })).toBeChecked();
    expect(percentage).toHaveValue(10);
    expect(amount).toHaveValue(450000);

    fireEvent.change(percentage, { target: { value: '20' } });
    expect(amount).toHaveValue(900000);

    fireEvent.change(amount, { target: { value: '675000' } });
    expect(percentage).toHaveValue(15);

    fireEvent.click(screen.getByRole('radio', { name: /Full payment/ }));
    expect(screen.getByLabelText('Initial payment amount')).toHaveValue(4500000);
    expect(screen.getByLabelText('Initial payment amount')).toHaveAttribute('readonly');

    fireEvent.click(screen.getByRole('radio', { name: /Minimum payment/ }));
    expect(screen.getByLabelText('Initial payment amount')).toHaveValue(675000);
    expect(screen.getByLabelText('Initial payment amount')).not.toHaveAttribute('readonly');
  });

  it('persists a monthly installment sequence before initiating its payment', async () => {
    const unscheduledPayload = {
      ...payload,
      customers: [{
        ...payload.customers[0],
        booking: { ...payload.customers[0].booking, amountPaid: 0, balance: 4500000 },
        payments: [{ ...payload.customers[0].payments[0], amount: 1 }],
        installments: [],
      }, payload.customers[1]],
    };
    const scheduledPayload = {
      ...unscheduledPayload,
      customers: [{
        ...unscheduledPayload.customers[0],
        installments: [
          { id: 901, plotBookingId: 501, sequenceNumber: 1, frequency: 'MONTHLY', dueDate: '2027-12-01T12:00:00.000Z', amount: 150000, status: 'PLANNED' },
          { id: 902, plotBookingId: 501, sequenceNumber: 2, frequency: 'MONTHLY', dueDate: '2028-01-01T12:00:00.000Z', amount: 150000, status: 'PLANNED' },
        ],
      }, payload.customers[1]],
    };
    let scheduleCreated = false;
    fetchApi.mockImplementation(async (url, options = {}) => {
      if (url.endsWith('/installments') && options.method === 'POST') {
        scheduleCreated = true;
        return { installments: scheduledPayload.customers[0].installments };
      }
      return scheduleCreated ? scheduledPayload : unscheduledPayload;
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    expect(screen.queryByRole('button', { name: 'Generate payment' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add installment' })).toBeInTheDocument();
    const installments = screen.getByRole('heading', { name: 'Future installments' }).closest('section');
    expect(installments).toHaveTextContent('44,99,999');
    expect(installments).toHaveTextContent('remains on this booking.');

    fireEvent.click(screen.getByRole('button', { name: 'Add installment' }));
    const addDialog = screen.getByRole('dialog', { name: 'Create installment plan' });
    fireEvent.change(within(addDialog).getByLabelText('Installment frequency'), { target: { value: 'MONTHLY' } });
    expect(within(addDialog).getByRole('option', { name: 'Quarterly' })).toBeInTheDocument();
    expect(within(addDialog).getByRole('option', { name: 'Half-Yearly' })).toBeInTheDocument();
    fireEvent.change(within(addDialog).getByLabelText('Number of installments'), { target: { value: '2' } });
    expect(within(addDialog).getByLabelText('Amount per installment')).toHaveValue(2249999.5);
    fireEvent.change(within(addDialog).getByLabelText('First payment date'), { target: { value: '2027-12-15' } });
    fireEvent.change(within(addDialog).getByLabelText('Amount per installment'), { target: { value: '150000' } });
    fireEvent.click(within(addDialog).getByRole('button', { name: 'Create schedule' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/61/installments',
      {
        method: 'POST',
        body: JSON.stringify({ plotBookingId: 501, frequency: 'MONTHLY', paymentCount: 2, firstPaymentDate: '2027-12-15', amount: 150000 }),
      },
    ));

    const planned = await screen.findByRole('table', { name: 'Planned installments' });
    expect(screen.queryByRole('button', { name: 'Add installment' })).toBeNull();
    expect(within(planned).getByRole('columnheader', { name: 'Installment' })).toBeInTheDocument();
    expect(within(planned).getByRole('columnheader', { name: 'Due Date' })).toBeInTheDocument();
    expect(within(planned).getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();
    expect(within(planned).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(within(planned).getByRole('columnheader', { name: 'Action' })).toBeInTheDocument();
    expect(planned.parentElement).toHaveClass('pickup-installment-table-wrap');
    expect(planned).toHaveTextContent('Dec');
    expect(planned).toHaveTextContent('Jan');
    expect(planned).toHaveTextContent('2028');
    expect(planned).toHaveTextContent('1,50,000');
    fireEvent.click(within(planned).getAllByRole('button', { name: 'Initiate payment' })[0]);
    expect(screen.getByRole('heading', { name: 'Generate installment payment' })).toBeInTheDocument();
    expect(screen.getByLabelText('Installment payment amount')).toHaveValue(150000);
    expect(screen.getByLabelText('Installment payment amount')).toHaveAttribute('readonly');
    expect(screen.getByText('Remaining installment balance')).toBeInTheDocument();
  });

  it('shows the remaining balance without a recorded-installments summary card', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    const installments = screen.getByRole('heading', { name: 'Future installments' }).closest('section');
    expect(installments).toHaveTextContent('Remaining installment balance');
    expect(installments).toHaveTextContent('30,00,000');
    expect(screen.queryByText('1 installment payment recorded')).toBeNull();
    expect(screen.queryByText('Use Payment history above to review payment details.')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Future installment payment history' })).toBeNull();
  });

  it('shows installment lifecycle actions for initiated, processing, failed, overdue, and paid rows', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{
        ...payload.customers[0],
        installments: [
          { id: 901, sequenceNumber: 1, dueDate: '2026-11-15T12:00:00.000Z', amount: 50000, status: 'PLANNED' },
          { id: 902, sequenceNumber: 2, dueDate: '2026-12-15T12:00:00.000Z', amount: 50000, status: 'PAYMENT_INITIATED', paymentLinkUrl: 'https://pay.example/902' },
          { id: 903, sequenceNumber: 3, dueDate: '2027-01-15T12:00:00.000Z', amount: 50000, status: 'PROCESSING', paymentLinkUrl: 'https://pay.example/903' },
          { id: 904, sequenceNumber: 4, dueDate: '2027-02-15T12:00:00.000Z', amount: 50000, status: 'FAILED' },
          { id: 905, sequenceNumber: 5, dueDate: '2026-09-15T12:00:00.000Z', amount: 50000, status: 'OVERDUE' },
          { id: 906, sequenceNumber: 6, dueDate: '2026-08-15T12:00:00.000Z', amount: 50000, status: 'PAID', receiptUrl: '/api/billing/public/receipt?plinkId=plink_paid' },
        ],
      }, payload.customers[1]],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    const table = screen.getByRole('table', { name: 'Planned installments' });
    expect(table).toHaveTextContent('Payment Initiated');
    expect(table).toHaveTextContent('Processing');
    expect(table).toHaveTextContent('Failed');
    expect(table).toHaveTextContent('Overdue');
    expect(table).toHaveTextContent('Paid');
    expect(within(table).getAllByRole('button', { name: 'Initiate payment' })).toHaveLength(2);
    expect(within(table).getByRole('button', { name: 'Retry payment' })).toBeInTheDocument();
    expect(within(table).getAllByRole('link', { name: 'Open payment link' })).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'View receipt' })).toHaveAttribute('href', '/api/billing/public/receipt?plinkId=plink_paid');
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
    expect(screen.queryByText('2 installment payments recorded')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Future installment payment history' })).toBeNull();
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
    expect(screen.getByRole('dialog', { name: 'Edit pickup location' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pickup location' }));
    fireEvent.click(screen.getByRole('option', { name: 'Select Residency Road pickup location' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/61',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ pickupAddress: '55 Residency Road, Bengaluru', sourceTranscriptId: '789', sourceExcerpt: null }),
      }),
    ));
  });

  it('shows an assign pickup action and all available locations when none is assigned', async () => {
    fetchApi.mockResolvedValue({
      ...payload,
      customers: [{ ...payload.customers[0], pickupAddress: null }],
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Priya Shah' });

    fireEvent.click(screen.getByRole('button', { name: 'Assign Priya Shah pickup location' }));
    expect(screen.getByRole('dialog', { name: 'Assign pickup location' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pickup location' }));
    expect(screen.getByRole('option', { name: 'Select Lake View pickup location' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Select Residency Road pickup location' })).toBeInTheDocument();
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

    const confirmation = await screen.findByRole('dialog', { name: 'Confirm plot assignment' });
    expect(within(confirmation).getByText(
      'Are you sure you want to assign Plot 25, Plot 107 from North Avenue to Amit Rao?',
    )).toBeInTheDocument();
    expect(within(confirmation).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(fetchApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Assign plots' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/62/plots',
      { method: 'POST', body: JSON.stringify({ plotSiteIds: [31, 32] }) },
    ));
  });

  it('keeps the selected plots unchanged when the user returns to edit them', async () => {
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Amit Rao' });
    fireEvent.click(screen.getByRole('button', { name: 'Amit Rao' }));
    fireEvent.click(screen.getByRole('button', { name: 'Assign plots to Amit Rao' }));

    const dialog = screen.getByRole('dialog', { name: 'Assign plots' });
    const plot = within(dialog).getByRole('checkbox', { name: /Plot 25/ });
    fireEvent.click(plot);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign 1 plot' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Confirm plot assignment' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Edit' }));

    expect(screen.getByRole('dialog', { name: 'Assign plots' })).toBeInTheDocument();
    expect(plot).toBeChecked();
    expect(fetchApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
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

  it('uses one site-filtered list to add and deselect multiple plots', async () => {
    const secondAssignedPlot = {
      id: 36, name: 'North Avenue', plotNumber: '23', block: 'B', availability: 'RESERVED',
    };
    const assignedCustomer = {
      ...payload.customers[1],
      assignedPlot: payload.plots[0],
      assignedPlots: [payload.plots[0], secondAssignedPlot],
      customerAssignedPlotIds: [30, 36],
    };
    fetchApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST') return { changed: true };
      return { ...payload, plots: [...payload.plots, secondAssignedPlot], customers: [assignedCustomer] };
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Amit Rao' });

    fireEvent.click(screen.getByRole('button', { name: 'View plots for Amit Rao' }));
    const assignedDialog = screen.getByRole('dialog', { name: 'Assigned plots' });
    expect(within(assignedDialog).getAllByRole('button')).toHaveLength(2);
    expect(within(assignedDialog).getByText('Plot 24')).toBeInTheDocument();
    expect(within(assignedDialog).getByText('Plot 23')).toBeInTheDocument();
    fireEvent.click(within(assignedDialog).getByRole('button', { name: 'Edit assigned plots for Amit Rao' }));

    const editDialog = screen.getByRole('dialog', { name: 'Edit assigned plot' });
    const plotList = within(editDialog).getByRole('group', { name: 'Assigned and available plots' });
    expect(within(plotList).getByRole('checkbox', { name: /Plot 24/ })).toBeChecked();
    expect(within(plotList).getByRole('checkbox', { name: /Plot 23/ })).toBeChecked();
    fireEvent.click(within(plotList).getByRole('checkbox', { name: /Plot 23/ }));
    const plot25 = within(plotList).getByRole('checkbox', { name: /Plot 25/ });
    const plot107 = within(plotList).getByRole('checkbox', { name: /Plot 107/ });
    expect(plot25).not.toBeChecked();
    expect(plot107).not.toBeChecked();
    fireEvent.click(plot25);
    fireEvent.click(plot107);
    fireEvent.click(within(editDialog).getByRole('button', { name: 'Save changes' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Confirm plot assignments' });
    expect(within(confirmation).getByText(
      "Are you sure you want to update Amit Rao's North Avenue plots? Assign Plot 25, Plot 107. Deselect Plot 23.",
    )).toBeInTheDocument();
    expect(within(confirmation).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(fetchApi.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/62/plots/36',
      { method: 'DELETE' },
    ));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/62/plots',
      {
        method: 'POST',
        body: JSON.stringify({ plotSiteIds: [31, 32] }),
      },
    ));
  });

  it('removes plots from the old site when changing to another Plot or Site name', async () => {
    const assignedCustomer = {
      ...payload.customers[1],
      assignedPlot: payload.plots[0],
      assignedPlots: [payload.plots[0]],
      customerAssignedPlotIds: [30],
    };
    fetchApi.mockImplementation(async (url, options = {}) => {
      if (options.method === 'POST' || options.method === 'DELETE') return { updated: true };
      return { ...payload, customers: [assignedCustomer] };
    });
    render(<NotifyProvider><PickupCustomers /></NotifyProvider>);
    await screen.findByRole('button', { name: 'Amit Rao' });
    fireEvent.click(screen.getByRole('button', { name: 'View plots for Amit Rao' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Assigned plots' })).getByRole('button', { name: 'Edit assigned plots for Amit Rao' }));

    const editor = screen.getByRole('dialog', { name: 'Edit assigned plot' });
    fireEvent.change(within(editor).getByRole('combobox', { name: 'Edit plot or site name' }), { target: { value: 'Lake View' } });
    const plotList = within(editor).getByRole('group', { name: 'Assigned and available plots' });
    expect(within(plotList).queryByRole('checkbox', { name: /Plot 24/ })).toBeNull();
    fireEvent.click(within(plotList).getByRole('checkbox', { name: /Plot 8/ }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save changes' }));

    const confirmation = await screen.findByRole('dialog', { name: 'Confirm plot assignments' });
    expect(within(confirmation).getByText(
      "Are you sure you want to update Amit Rao's Lake View plots? Assign Plot 8. Deselect Plot 24.",
    )).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/62/plots/30',
      { method: 'DELETE' },
    ));
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/customer-pickups/62/plots',
      { method: 'POST', body: JSON.stringify({ plotSiteIds: [35] }) },
    );
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

  it('compacts the customer workspace fluidly before using the narrow-screen layout', () => {
    expect(responsiveCss).toMatch(/\.pickup-customers-page\s*\{[^}]*padding:clamp\(/s);
    expect(responsiveCss).toMatch(/\.pickup-directory-toolbar \.input-field\s*\{[^}]*min-height:clamp\([^}]*font-size:clamp\(/s);
    expect(responsiveCss).toMatch(/\.pickup-page-header h1 svg\s*\{[^}]*width:clamp\([^}]*height:clamp\(/s);
    expect(responsiveCss).toMatch(/\.pickup-detail-actions button\s*\{[^}]*padding:clamp\([^}]*font-size:clamp\(/s);
    expect(responsiveCss).toMatch(/\.pickup-customer-table td\s*\{[^}]*padding:clamp\([^}]*font-size:clamp\(/s);
    expect(responsiveCss).toMatch(/\.pickup-master-detail\s*\{[^}]*grid-template-columns:minmax\(300px, 37%\) minmax\(0, 1fr\)/s);
    expect(responsiveCss).toContain('@media (max-width:760px)');
    expect(responsiveCss).not.toContain('@media (max-width:1000px)');
    expect(responsiveCss).toMatch(/\.pickup-installment-table-wrap\s*\{[^}]*max-height:330px[^}]*overflow:auto/s);
    expect(responsiveCss).toMatch(/\.pickup-installment-table th\s*\{[^}]*position:sticky[^}]*top:0/s);
    expect(responsiveCss).toMatch(/\.pickup-payment-history-wrap\s*\{[^}]*max-height:260px[^}]*overflow:auto/s);
  });

  it('prevents avoidable search overlap and customer-name wrapping', () => {
    expect(responsiveCss).toMatch(/\.pickup-directory-toolbar input\.input-field\s*\{[^}]*padding-left:clamp\([^}]*!important/s);
    expect(responsiveCss).toMatch(/\.pickup-customer-title h2\s*\{[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/s);
    expect(responsiveCss).toMatch(/\.pickup-customer-table td button\s*\{[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap/s);
    expect(responsiveCss).toMatch(/\.pickup-detail-actions\s*\{[^}]*flex-wrap:nowrap/s);
    expect(responsiveCss).toMatch(/\.pickup-customer-table td span,[^{}]*\{[^}]*white-space:nowrap/s);
    expect(responsiveCss).toContain('@container (max-width:520px)');
    expect(responsiveCss).toMatch(/\.pickup-action-label\s*\{\s*display:none;/s);
  });
});
