import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ZapierSetup from '../components/ZapierSetup';
import { fetchApi } from '../utils/api';
vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const subscriptions = [];
const refresh = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  fetchApi.mockResolvedValue({ configured: 0, entitlement: { entitled: true }, deliveries: [] });
});
describe('Zapier first release setup', () => {
  it('does not claim a configured connection or marketplace listing before setup', async () => {
    render(<ZapierSetup subscriptions={subscriptions} onChanged={refresh} />);
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.getByText(/not the SDK or a verified marketplace app/)).toBeInTheDocument();
    expect(screen.getByText(/no durable background replay yet/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { pressed: false })).toHaveLength(2);
  });
  it('saves the selected real event and Catch Hook URL', async () => {
    render(<ZapierSetup subscriptions={subscriptions} onChanged={refresh} />);
    await screen.findByText('Not configured');
    fireEvent.click(screen.getByRole('button', { name: /Won deal/ }));
    fireEvent.change(screen.getByLabelText('Zapier Catch Hook URL'), { target: { value: 'https://hooks.zapier.com/hooks/catch/1/abc/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/api/zapier/subscribe', {
      method: 'POST', body: JSON.stringify({ event: 'deal.won', targetUrl: 'https://hooks.zapier.com/hooks/catch/1/abc/' }),
    }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('shows unavailable status instead of a false success on request failure', async () => {
    fetchApi.mockRejectedValue(new Error('offline'));
    render(<ZapierSetup subscriptions={subscriptions} onChanged={refresh} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load connection status');
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
  });
});
