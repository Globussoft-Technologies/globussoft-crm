import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BrokerCustomerWorkspace from '../components/BrokerCustomerWorkspace';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../utils/api';

const response = {
  broker: { id: 51, name: 'Sanjeev', agency: 'Prime Realty', commissionPercent: 2.5 },
  customers: [
    {
      id: 61, name: 'Li Wei', phone: '9000022222', email: 'li@example.com', company: 'Shenzhen Micro Ltd',
      plot: { id: 30, name: 'Plot 24', address: 'North Avenue' },
      tripCompleted: true, tripMessage: 'Trip completed', tripCompletedAt: '2026-10-06T10:00:00.000Z',
      brokerWorkflow: { status: 'READY_TO_EXPLAIN', updatedAt: null },
    },
    {
      id: 62, name: 'Priyanka Mehta', phone: '9000033333', company: 'Acme India',
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
    expect(screen.getByText(/customer is ready for broker follow-up/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start explanation/i })).toBeInTheDocument();
    expect(screen.getAllByText('Broker process')).toHaveLength(1);
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

  it('advances a completed customer from explanation toward billing', async () => {
    fetchApi
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({ customerId: 61, status: 'EXPLANATION_STARTED', statusUpdatedAt: '2026-10-06T12:00:00.000Z' });
    render(<BrokerCustomerWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /Start explanation/i }));
    expect(await screen.findByText('Explaining property')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finish explanation/i })).toBeInTheDocument();
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/brokers/me/customers/61/workflow',
      { method: 'PATCH', body: JSON.stringify({ status: 'EXPLANATION_STARTED' }) },
    );
  });

  it('sends interested customers to Billing and closes uninterested cases', async () => {
    const decisionResponse = {
      ...response,
      customers: response.customers.map((customer) => customer.id === 61
        ? { ...customer, brokerWorkflow: { status: 'EXPLANATION_COMPLETED', updatedAt: null } }
        : customer),
    };
    fetchApi
      .mockResolvedValueOnce(decisionResponse)
      .mockResolvedValueOnce({ customerId: 61, status: 'INTEREST_CONFIRMED', handedToBilling: true });
    render(<BrokerCustomerWorkspace />);
    expect(await screen.findByRole('button', { name: 'Interested' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not interested' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Interested' }));
    expect(await screen.findByText(/Customer sent to Billing Department/i)).toBeInTheDocument();
  });
});
