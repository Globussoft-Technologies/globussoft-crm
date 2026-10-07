import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BillingWorkspace from '../components/BillingWorkspace';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../utils/api';

const payload = {
  billingUser: { id: 9, name: 'Bina', email: 'billing@example.com' },
  assignments: [
    {
      assignmentKey: '51-61', status: 'READY_FOR_BILLING', statusUpdatedAt: null,
      broker: { id: 51, name: 'Sanjeev' },
      customer: { id: 61, name: 'Li Wei', email: 'li@example.com', phone: '9000022222', company: 'Shenzhen Micro Ltd' },
      plot: { id: 30, name: 'Plot 24', price: 250000 },
    },
    {
      assignmentKey: '51-62', status: 'BILLING_COMPLETED', statusUpdatedAt: '2026-10-06T12:00:00.000Z',
      broker: { id: 51, name: 'Sanjeev' }, customer: { id: 62, name: 'Priyanka Mehta' }, plot: { id: 31, name: 'Plot 25' },
    },
  ],
};

beforeEach(() => fetchApi.mockReset());

describe('<BillingWorkspace />', () => {
  it('shows only interested customers in the active billing queue', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<BillingWorkspace />);
    expect(await screen.findByText('Li Wei')).toBeInTheDocument();
    expect(screen.getByText('Ready for billing')).toBeInTheDocument();
    expect(screen.queryByText('Priyanka Mehta')).toBeNull();
  });

  it('advances invoice and payment steps in order', async () => {
    fetchApi
      .mockResolvedValueOnce(payload)
      .mockResolvedValueOnce({ assignmentKey: '51-61', status: 'DETAILS_VERIFIED', statusUpdatedAt: '2026-10-06T13:00:00.000Z' });
    render(<BillingWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /Verify customer details/i }));
    expect(await screen.findByText('Details verified')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Prepare invoice/i })).toBeInTheDocument();
    expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/billing/me/assignments/51-61/status',
      { method: 'PATCH', body: JSON.stringify({ status: 'DETAILS_VERIFIED' }) },
    );
  });

  it('keeps completed billing in a separate tab', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<BillingWorkspace />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Completed' }));
    expect(screen.getByText('Priyanka Mehta')).toBeInTheDocument();
    expect(screen.queryByText('Li Wei')).toBeNull();
  });
});
