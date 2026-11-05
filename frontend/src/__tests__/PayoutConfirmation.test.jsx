import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PayoutConfirmation from '../pages/PayoutConfirmation';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
import { fetchApi } from '../utils/api';

beforeEach(() => fetchApi.mockReset());

describe('<PayoutConfirmation />', () => {
  it('loads payout details and confirms the partner receipt with the OTP', async () => {
    fetchApi.mockResolvedValueOnce({ payout: { partnerName: 'Owner A', totalNetPaise: 250000, utr: 'UTR123', mobile: '••••1234', confirmationStatus: 'PENDING' } });
    fetchApi.mockResolvedValueOnce({ confirmed: true });
    render(<MemoryRouter initialEntries={['/payout-confirmation?token=test-token']}><PayoutConfirmation /></MemoryRouter>);
    expect(await screen.findByText('Owner A')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('OTP sent by the company'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt' }));
    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith('/api/pickup-plot-payouts/public/confirm', expect.objectContaining({ method: 'POST' })));
    expect(await screen.findByText('Receipt confirmed successfully.')).toBeInTheDocument();
  });
});
