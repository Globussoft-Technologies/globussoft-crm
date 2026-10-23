import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoogleMapsSettingsCard from '../components/GoogleMapsSettingsCard';

const fetchApiMock = vi.fn();
const notify = { success: vi.fn(), error: vi.fn() };
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));

describe('<GoogleMapsSettingsCard />', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('loads masked status and saves a new server-side API key', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ enabled: false, configured: false, source: 'none', last4: null })
      .mockResolvedValueOnce({ enabled: true, configured: true, source: 'tenant', last4: '****1234' });
    render(<GoogleMapsSettingsCard />);

    const keyInput = await screen.findByLabelText('Google Maps API key');
    expect(keyInput).toHaveAttribute('type', 'password');
    fireEvent.change(keyInput, { target: { value: 'AIzaNewGoogleMapsKey1234' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable Google Maps address suggestions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Google Maps Settings' }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith('/api/settings/google-maps', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, apiKey: 'AIzaNewGoogleMapsKey1234' }),
    }));
    expect(keyInput).toHaveValue('');
    expect(screen.getByText(/Enabled using this organization’s key/i)).toBeInTheDocument();
    expect(notify.success).toHaveBeenCalledWith('Google Maps address suggestions enabled.');
  });

  it('never puts the saved credential into the input', async () => {
    fetchApiMock.mockResolvedValueOnce({ enabled: true, configured: true, source: 'tenant', last4: '****7890' });
    render(<GoogleMapsSettingsCard />);
    const keyInput = await screen.findByLabelText('Google Maps API key');
    expect(keyInput).toHaveValue('');
    expect(keyInput).toHaveAttribute('placeholder', expect.stringContaining('****7890'));
  });

  it('does not allow an empty first-time save', async () => {
    fetchApiMock.mockResolvedValueOnce({ enabled: false, configured: false, source: 'none', last4: null });
    render(<GoogleMapsSettingsCard />);

    await screen.findByLabelText('Google Maps API key');
    expect(screen.getByRole('button', { name: 'Save Google Maps Settings' })).toBeDisabled();
    expect(fetchApiMock).toHaveBeenCalledTimes(1);
  });
});
