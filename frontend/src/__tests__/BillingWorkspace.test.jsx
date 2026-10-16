import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import BillingWorkspace from '../components/BillingWorkspace';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../utils/api';

const payload = {
  billingUser: { id: 9, name: 'Bina', email: 'billing@example.com' },
  assignments: [
    {
      assignmentKey: '51-61-30', status: 'PLOT_RESERVED', statusUpdatedAt: null,
      broker: { id: 51, name: 'Sanjeev' },
      customer: { id: 61, name: 'Li Wei', email: 'li@example.com', phone: '9000022222', company: 'Shenzhen Micro Ltd' },
      plot: { id: 30, name: 'Plot 24', plotNumber: 'A-24', price: 250000 },
    },
    {
      assignmentKey: '51-62-31', status: 'TRANSACTION_COMPLETED', statusUpdatedAt: '2026-10-06T12:00:00.000Z',
      broker: { id: 51, name: 'Sanjeev' }, customer: { id: 62, name: 'Priyanka Mehta' }, plot: { id: 31, name: 'Plot 25' },
    },
  ],
  waitingAssignments: [
    {
      assignmentKey: 'waiting-63-32', status: 'AWAITING_SALES_EXECUTIVE_HANDOFF',
      customer: { id: 63, name: 'Muskan', email: 'muskan@example.com' }, plot: { id: 32, name: 'Koramangala Plot' },
    },
    {
      assignmentKey: 'waiting-64-33', status: 'AWAITING_SALES_EXECUTIVE_HANDOFF',
      customer: { id: 64, name: 'Sarukh', phone: '9091725470' }, plot: { id: 33, name: 'Prime West Plot' },
    },
  ],
};

beforeEach(() => fetchApi.mockReset());

describe('<BillingWorkspace />', () => {
  it('shows Sales Executive handoffs awaiting a Billing assignment to admins', async () => {
    const awaitingPayload = {
      isAdminOverview: true,
      billingUser: null,
      assignmentOptions: [{ profileId: 71, id: 41, name: 'Bina' }],
      assignments: [{
        assignmentKey: '51-63-30',
        status: 'PLOT_RESERVED',
        broker: { id: 51, name: 'Sanjeev' },
        customer: { id: 63, name: 'Ritu Pillai' },
        plot: { id: 30, name: 'Plot 30' },
        awaitingAssignment: true,
        assignedStaff: null,
      }],
      waitingAssignments: [],
    };
    fetchApi
      .mockResolvedValueOnce(awaitingPayload)
      .mockResolvedValueOnce({ assignedStaff: { profileId: 71, name: 'Bina' } })
      .mockResolvedValueOnce({ ...awaitingPayload, assignments: [] });
    render(<BillingWorkspace />);
    expect(await screen.findByText('Ritu Pillai')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Billing assignment')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Assign Billing staff for Ritu Pillai'), { target: { value: '71' } });
    fireEvent.click(screen.getByRole('button', { name: /^Assign Billing staff$/i }));
    expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/billing/me/assignments/51-63-30/assign',
      { method: 'PATCH', body: JSON.stringify({ targetProfileId: 71 }) },
    );
    expect(screen.queryByRole('button', { name: /start billing/i })).toBeNull();
  });

  it('shows all assigned staff data read-only for a Generic CRM admin', async () => {
    fetchApi
      .mockResolvedValueOnce({
        ...payload,
        isAdminOverview: true,
        billingUser: null,
        assignments: payload.assignments.map((assignment) => ({
          ...assignment, assignedStaff: { id: 41, profileId: 71, name: 'Bina' },
        })),
        waitingAssignments: payload.waitingAssignments.map((assignment) => ({
          ...assignment, assignedStaff: { id: 41, profileId: 71, name: 'Bina' },
        })),
      })
      .mockResolvedValueOnce({ assignmentKey: '51-61-30', status: 'BILLING', statusUpdatedAt: '2026-10-06T13:00:00.000Z' });
    render(<BillingWorkspace />);
    expect((await screen.findAllByText('Assigned to Bina')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Interested customer billing')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /start billing/i }));
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status?assignedProfileId=71',
      { method: 'PATCH', body: JSON.stringify({ status: 'BILLING' }) },
    );
  });

  it('shows only interested customers in the active billing queue', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<BillingWorkspace />);
    expect(await screen.findByText('Li Wei')).toBeInTheDocument();
    expect(screen.queryByText('Interested customer billing')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.getByText('Plot reserved')).toBeInTheDocument();
    expect(screen.getByText(/Plot 24 — Plot No\. A-24/)).toBeInTheDocument();
    expect(screen.queryByText('Priyanka Mehta')).toBeNull();
  });

  it('shows directly assigned customers while billing waits for the sales handoff', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<BillingWorkspace />);
    expect(await screen.findByText('Muskan')).toBeInTheDocument();
    expect(screen.getByText('Sarukh')).toBeInTheDocument();
    const waitingList = screen.getByRole('region', { name: 'Billing assignments awaiting handoff' });
    expect(within(waitingList).getAllByText('Awaiting handoff')).toHaveLength(2);
    expect(within(waitingList).getAllByText('Billing actions unlock after plot selection')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Start billing/i })).toHaveLength(1);
  });

  it('starts billing before invoice creation', async () => {
    fetchApi
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ assignmentKey: '51-61-30', status: 'BILLING', statusUpdatedAt: '2026-10-06T13:00:00.000Z' });
    render(<BillingWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /Start billing/i }));
    expect(await screen.findByText('Billing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create invoice/i })).toBeInTheDocument();
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/billing/me/assignments/51-61-30/status',
      { method: 'PATCH', body: JSON.stringify({ status: 'BILLING' }) },
    );
  });

  it('does not show completed customers in the billing work list', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<BillingWorkspace />);
    expect(await screen.findByText('Li Wei')).toBeInTheDocument();
    expect(screen.queryByText('Priyanka Mehta')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Completed' })).toBeNull();
  });
});
