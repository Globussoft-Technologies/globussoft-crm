import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import BrokerCustomerWorkspace from '../components/BrokerCustomerWorkspace';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../utils/api';

const response = {
  broker: { id: 51, name: 'Sanjeev', agency: 'Prime Realty', commissionPercent: 2.5 },
  customers: [
    {
      id: 61, assignmentKey: 'customer-61-plot-30', name: 'Li Wei', phone: '9000022222', email: 'li@example.com', company: 'Shenzhen Micro Ltd',
      plot: { id: 30, name: 'Plot 24', address: 'North Avenue' },
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
  it('lists all assigned customers and hides in-progress transport status', async () => {
    fetchApi.mockResolvedValueOnce(response);
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByText('Li Wei')).toBeInTheDocument();
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

  it('does not show customers whose broker work is already complete', async () => {
    fetchApi.mockResolvedValueOnce({
      ...response,
      customers: response.customers.map((customer) => customer.id === 61
        ? { ...customer, brokerWorkflow: { status: 'PLOT_SELECTED', updatedAt: null } }
        : customer),
    });
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByText('Priyanka Mehta')).toBeInTheDocument();
    expect(screen.queryByText('Li Wei')).toBeNull();
  });
});
