import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TransportDriverWorkspace from '../components/TransportDriverWorkspace';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const { notifyMock } = vi.hoisted(() => ({
  notifyMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), confirm: vi.fn() },
}));
vi.mock('../utils/notify', () => ({ useNotify: () => notifyMock }));
vi.mock('../components/CallifiedCallDialog', () => ({
  default: ({ customer, endpoints, historyHref, onClose }) => (
    <div role="dialog" aria-label={`Call ${customer.name}`} data-ai-endpoint={endpoints.aiCall} data-history-href={historyHref}>
      <span>Call Customer</span>
      <button type="button" onClick={onClose}>Close call dialog</button>
    </div>
  ),
}));
import { fetchApi } from '../utils/api';

const driverData = {
  transportPerson: { id: 41, name: 'Sant Kumar', vehicleType: 'SUV', vehicleNumber: 'KA 01 AB 1234' },
  assignments: [{
    assignmentKey: 'customer-61', status: 'ASSIGNED', statusUpdatedAt: null,
    customer: { id: 61, name: 'Priya Shah', phone: '9000022222', company: 'Acme' },
    pickup: { id: 4, name: 'North Gate', address: 'MG Road, Bengaluru' },
    drop: { id: 30, name: 'Green Acres', address: 'Airport Road, Bengaluru' },
  }],
  summary: { total: 1, active: 1, completed: 0 },
};

beforeEach(() => {
  fetchApi.mockReset();
  notifyMock.success.mockReset();
});

describe('<TransportDriverWorkspace />', () => {
  it('shows all assigned staff data read-only for a Generic CRM admin', async () => {
    fetchApi
      .mockResolvedValueOnce({
        ...driverData,
        isAdminOverview: true,
        transportPerson: null,
        assignments: driverData.assignments.map((assignment) => ({
          ...assignment, assignedStaff: { id: 21, profileId: 41, name: 'Sant Kumar' },
        })),
      })
      .mockResolvedValueOnce({
        assignmentKey: 'customer-61', status: 'ACCEPTED', statusUpdatedAt: '2026-10-06T10:00:00.000Z',
      });
    render(<TransportDriverWorkspace />);
    expect(await screen.findByText('Assigned to Sant Kumar')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('All pickup & drop trips')).toBeNull());
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /accept trip/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61/status?assignedProfileId=41',
      { method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) },
    ));
  });

  it('shows the assigned customer, pickup, drop, navigation and call actions', async () => {
    fetchApi.mockResolvedValueOnce(driverData);
    render(<TransportDriverWorkspace />);
    expect((await screen.findAllByText('Priya Shah')).length).toBeGreaterThan(0);
    expect(screen.queryByText('My pickup & drop trips')).toBeNull();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.getByText('North Gate')).toBeInTheDocument();
    expect(screen.getByText('Green Acres')).toBeInTheDocument();
    const callButton = screen.getByRole('button', { name: /call priya shah/i });
    fireEvent.click(callButton);
    const callDialog = screen.getByRole('dialog', { name: 'Call Priya Shah' });
    expect(callDialog).toHaveAttribute('data-ai-endpoint', '/api/pickup-plot-inventory/calling/customers/61/ai-call');
    expect(callDialog).toHaveAttribute('data-history-href', '/callified-data');
    expect(screen.getByRole('link', { name: /open route/i })).toHaveAttribute('href', expect.stringContaining('google.com/maps/dir'));
  });

  it('advances the trip one status at a time', async () => {
    fetchApi
      .mockResolvedValueOnce(driverData)
      .mockResolvedValueOnce({ assignmentKey: 'customer-61', status: 'ACCEPTED', statusUpdatedAt: '2026-10-06T10:00:00.000Z' });
    render(<TransportDriverWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /accept trip/i }));
    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/transport-persons/me/assignments/customer-61/status',
      { method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) },
    ));
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start pickup/i })).toBeInTheDocument();
  });

  it('shows completed customer trips only when Completed or All is selected', async () => {
    fetchApi.mockResolvedValueOnce({
      ...driverData,
      assignments: [{ ...driverData.assignments[0], status: 'COMPLETED' }],
      summary: { total: 1, active: 0, completed: 1 },
    });
    render(<TransportDriverWorkspace />);
    expect(await screen.findByText(/you’re all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText('Priya Shah')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Completed' }));
    expect(screen.getAllByText('Priya Shah').length).toBeGreaterThan(0);
    expect(screen.getByText('Drop-off completed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Active' }));
    expect(screen.queryByText('Priya Shah')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getAllByText('Priya Shah').length).toBeGreaterThan(0);
  });

  it('shows a customer-specific success toast after completing the drop-off', async () => {
    fetchApi
      .mockResolvedValueOnce({
        ...driverData,
        assignments: [{ ...driverData.assignments[0], status: 'ARRIVED_AT_DROP' }],
      })
      .mockResolvedValueOnce({
        assignmentKey: 'customer-61', status: 'COMPLETED', statusUpdatedAt: '2026-10-06T10:10:00.000Z',
      });
    render(<TransportDriverWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /complete drop-off/i }));
    await waitFor(() => expect(notifyMock.success).toHaveBeenCalledWith(
      'Drop-off completed for Priya Shah. It was removed from your active trips.',
    ));
    expect(screen.getByText(/you’re all caught up/i)).toBeInTheDocument();
  });
});
