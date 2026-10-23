import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BrokerCustomerWorkspace from '../components/BrokerCustomerWorkspace';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
vi.mock('../components/CallifiedCallDialog', () => ({
  default: ({ customer, endpoints, historyHref, onClose }) => (
    <div role="dialog" aria-label={`Call ${customer.name}`} data-manual-endpoint={endpoints.manualCall} data-history-href={historyHref}>
      <span>Call Customer</span>
      <button type="button" onClick={onClose}>Close call dialog</button>
    </div>
  ),
}));
import { fetchApi } from '../utils/api';

const response = {
  broker: { id: 51, name: 'Sanjeev', agency: 'Prime Realty', commissionPercent: 2.5 },
  customers: [
    {
      id: 61, assignmentKey: 'customer-61-plot-30', name: 'Li Wei', phone: '9000022222', email: 'li@example.com', company: 'Shenzhen Micro Ltd',
      plot: { id: 30, name: 'Plot 24', plotNumber: 'A-24', address: 'North Avenue' },
      plotOptions: [
        { id: 30, name: 'Plot 24', plotNumber: 'A-24', availability: 'AVAILABLE' },
        { id: 31, name: 'Plot 25', plotNumber: 'B-25', availability: 'AVAILABLE' },
      ],
      tripCompleted: true, tripMessage: 'Trip completed', tripCompletedAt: '2026-10-06T10:00:00.000Z',
      brokerWorkflow: { status: 'READY_TO_SCHEDULE', updatedAt: null, visitScheduledAt: null },
    },
    {
      id: 62, assignmentKey: 'customer-62-plot-31', name: 'Priyanka Mehta', phone: '9000033333', company: 'Acme India',
      plot: { id: 31, name: 'Plot 25' }, tripCompleted: false, tripMessage: 'Trip not completed', tripCompletedAt: null,
    },
  ],
  summary: { total: 2, completed: 1, waiting: 1 },
};

beforeEach(() => fetchApi.mockReset());

describe('<BrokerCustomerWorkspace />', () => {
  it('shows completed transport handoffs awaiting a Sales Executive assignment to admins', async () => {
    const awaitingPayload = {
      isAdminOverview: true,
      broker: null,
      assignmentOptions: [{ profileId: 51, id: 31, name: 'Sanjeev' }],
      customers: [{
        id: 63,
        assignmentKey: 'awaiting-broker-customer-63-plot-30',
        name: 'Ritu Pillai',
        plot: { id: 30, name: 'Plot 30' },
        tripCompleted: true,
        tripMessage: 'Trip completed',
        awaitingAssignment: true,
        assignedStaff: null,
      }],
    };
    fetchApi
      .mockResolvedValueOnce(awaitingPayload)
      .mockResolvedValueOnce({ assignedStaff: { profileId: 51, name: 'Sanjeev' } })
      .mockResolvedValueOnce({ ...awaitingPayload, customers: [] });
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByText('Ritu Pillai')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Sales Executive assignment')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Assign Sales Executive for Ritu Pillai'), { target: { value: '51' } });
    fireEvent.click(screen.getByRole('button', { name: /^Assign Sales Executive$/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/brokers/me/assignments/awaiting-broker-customer-63-plot-30/assign',
      { method: 'PATCH', body: JSON.stringify({ targetProfileId: 51 }) },
    ));
    expect(screen.queryByRole('button', { name: /schedule visit/i })).toBeNull();
  });

  it('shows all assigned staff data read-only for a Generic CRM admin', async () => {
    fetchApi
      .mockResolvedValueOnce({
        ...response,
        isAdminOverview: true,
        broker: null,
        customers: response.customers.map((customer) => ({
          ...customer, assignedStaff: { id: 31, profileId: 51, name: 'Sanjeev' },
        })),
      })
      .mockResolvedValueOnce({
        customerId: 61, status: 'VISIT_SCHEDULED', statusUpdatedAt: '2026-10-06T12:00:00.000Z', visitScheduledAt: '2026-10-10T05:00:00.000Z',
      });
    render(<BrokerCustomerWorkspace />);
    expect((await screen.findAllByText('Assigned to Sanjeev')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Site Visit Management')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    fireEvent.change(screen.getByLabelText('Visit date and time for Li Wei'), { target: { value: '2026-10-10T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: /schedule visit/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/brokers/me/assignments/customer-61-plot-30/workflow?assignedProfileId=51',
      { method: 'PATCH', body: JSON.stringify({ status: 'VISIT_SCHEDULED', visitScheduledAt: '2026-10-10T10:30' }) },
    ));
  });

  it('lists all assigned customers and hides in-progress transport status', async () => {
    fetchApi.mockResolvedValueOnce(response);
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByText('Li Wei')).toBeInTheDocument();
    expect(screen.queryByText('Site Visit Management')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.getByText('Priyanka Mehta')).toBeInTheDocument();
    expect(screen.getAllByText('Trip completed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Trip not completed').length).toBeGreaterThan(0);
    expect(screen.queryByText('Picked up')).toBeNull();
    expect(screen.getByText(/customer is ready for site visit management/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Schedule visit/i })).toBeDisabled();
    expect(screen.getAllByText('Site visit process')).toHaveLength(1);
  });

  it('filters completed and waiting customers', async () => {
    fetchApi.mockResolvedValueOnce(response);
    render(<BrokerCustomerWorkspace />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Trip completed' }));
    expect(screen.getByText('Li Wei')).toBeInTheDocument();
    expect(screen.queryByText('Priyanka Mehta')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Not completed' }));
    expect(screen.queryByText('Li Wei')).toBeNull();
    expect(screen.getByText('Priyanka Mehta')).toBeInTheDocument();
  });

  it('searches within assigned customers', async () => {
    fetchApi.mockResolvedValueOnce(response);
    render(<BrokerCustomerWorkspace />);
    fireEvent.change(await screen.findByLabelText('Search assigned customers'), { target: { value: 'Priyanka' } });
    expect(screen.getByText('Priyanka Mehta')).toBeInTheDocument();
    expect(screen.queryByText('Li Wei')).toBeNull();
  });

  it('opens the full email composer and the in-place Callified dialog over Sales Workspace', async () => {
    fetchApi.mockResolvedValueOnce(response);
    render(<MemoryRouter><BrokerCustomerWorkspace /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Email Li Wei' }));
    expect(await screen.findByRole('heading', { name: 'New Message' })).toBeInTheDocument();
    expect(screen.getByLabelText('To:')).toHaveValue('li@example.com');
    expect(screen.getByTestId('broker-customer-workspace')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Call Li Wei' }));
    const callDialog = screen.getByRole('dialog', { name: 'Call Li Wei' });
    expect(callDialog).toHaveAttribute('data-manual-endpoint', '/api/pickup-plot-inventory/calling/customers/61/manual-call');
    expect(callDialog).toHaveAttribute('data-history-href', '/callified-data');
  });

  it('sends from the embedded composer and then opens Inbox', async () => {
    fetchApi.mockResolvedValueOnce(response).mockResolvedValue([]);
    render(<MemoryRouter><BrokerCustomerWorkspace /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Email Li Wei' }));
    fireEvent.change(await screen.findByLabelText('Subject:'), { target: { value: 'Site visit follow-up' } });
    fireEvent.change(screen.getByLabelText('Message:'), { target: { value: 'Your selected plot is ready.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Email' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/communications/send-email',
      {
        method: 'POST',
        body: JSON.stringify({
          to: 'li@example.com',
          cc: '',
          bcc: '',
          subject: 'Site visit follow-up',
          body: 'Your selected plot is ready.',
        }),
      },
    ));
    expect(window.location.pathname).toBe('/inbox');
    window.history.replaceState({}, '', '/');
  });

  it('schedules a completed customer site visit with its date and time', async () => {
    fetchApi
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ customerId: 61, status: 'VISIT_SCHEDULED', statusUpdatedAt: '2026-10-06T12:00:00.000Z', visitScheduledAt: '2026-10-10T05:00:00.000Z' });
    render(<BrokerCustomerWorkspace />);
    fireEvent.change(await screen.findByLabelText('Visit date and time for Li Wei'), { target: { value: '2026-10-10T10:30' } });
    fireEvent.click(screen.getByRole('button', { name: /Schedule visit/i }));
    expect(await screen.findByText('Visit scheduled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Confirm visit/i })).toBeInTheDocument();
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/brokers/me/assignments/customer-61-plot-30/workflow',
      { method: 'PATCH', body: JSON.stringify({ status: 'VISIT_SCHEDULED', visitScheduledAt: '2026-10-10T10:30' }) },
    );
  });

  it('records attendance or a no-show after the reminder', async () => {
    const decisionResponse = {
      ...response,
      customers: response.customers.map((customer) => customer.id === 61
        ? { ...customer, brokerWorkflow: { status: 'REMINDER_SENT', updatedAt: null } }
        : customer),
    };
    fetchApi
      .mockResolvedValueOnce(decisionResponse)
      .mockResolvedValueOnce({ customerId: 61, status: 'ATTENDED', handedToBilling: false });
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByRole('button', { name: /Attendance/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No-show/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Attendance/i }));
    await waitFor(() => expect(screen.getByText('Attended')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Mark plot shown/i })).toBeInTheDocument();
  });

  it('requires a plot selection and sends the selected plot number to billing', async () => {
    const plotShownResponse = {
      ...response,
      customers: response.customers.map((customer) => customer.id === 61
        ? { ...customer, brokerWorkflow: { status: 'PLOT_SHOWN', updatedAt: null } }
        : customer),
    };
    fetchApi
      .mockResolvedValueOnce(plotShownResponse)
      .mockResolvedValueOnce({
        customerId: 61,
        status: 'PLOT_SELECTED',
        handedToBilling: true,
        plot: { id: 31, name: 'Plot 25', plotNumber: 'B-25', availability: 'RESERVED' },
      });

    render(<BrokerCustomerWorkspace />);
    const plotSelect = await screen.findByLabelText('Selected plot for Li Wei');
    expect(screen.getByRole('option', { name: 'Plot 24 — Plot No. A-24' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Plot 25 — Plot No. B-25' })).toBeInTheDocument();
    fireEvent.change(plotSelect, { target: { value: '31' } });
    fireEvent.click(screen.getByRole('button', { name: /Mark plot selected/i }));

    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/brokers/me/assignments/customer-61-plot-30/workflow',
      { method: 'PATCH', body: JSON.stringify({ status: 'PLOT_SELECTED', plotId: 31 }) },
    ));
  });

  it('keeps completed Sales Executive work visible in all customers and history', async () => {
    fetchApi.mockResolvedValueOnce({
      ...response,
      customers: response.customers.map((customer) => customer.id === 61
        ? { ...customer, brokerWorkflow: { status: 'PLOT_SELECTED', updatedAt: null } }
        : customer),
    });
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByText('Priyanka Mehta')).toBeInTheDocument();
    expect(screen.getByText('Li Wei')).toBeInTheDocument();
    expect(screen.getByText('Selected plot sent to Billing Department')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('Li Wei')).toBeInTheDocument();
    expect(screen.queryByText('Priyanka Mehta')).toBeNull();
  });
});
