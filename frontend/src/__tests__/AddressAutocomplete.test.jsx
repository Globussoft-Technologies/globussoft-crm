import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddressAutocomplete from '../components/AddressAutocomplete';

const geocodeSuggestMock = vi.fn();
const googleAddressSuggestMock = vi.fn();
vi.mock('../lib/geocoder', () => ({
  geocodeSuggest: (...args) => geocodeSuggestMock(...args),
  googleAddressSuggest: (...args) => googleAddressSuggestMock(...args),
}));

function Harness({ onSelect, provider }) {
  const [address, setAddress] = useState('');
  return <AddressAutocomplete value={address} onChange={setAddress} onSelect={onSelect} provider={provider} />;
}

beforeEach(() => {
  geocodeSuggestMock.mockReset();
  googleAddressSuggestMock.mockReset();
  geocodeSuggestMock.mockResolvedValue([
    { lat: 12.9352, lng: 77.6245, display_name: 'CA-17, Koramangala, Bengaluru, India' },
  ]);
});

afterEach(() => vi.useRealTimers());

describe('<AddressAutocomplete />', () => {
  it('debounces address lookup and applies the selected suggestion', async () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole('combobox', { name: 'Address' });

    fireEvent.change(input, { target: { value: 'Ko' } });
    await act(async () => vi.advanceTimersByTime(400));
    expect(geocodeSuggestMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Koramangala' } });
    await act(async () => vi.advanceTimersByTime(300));
    expect(geocodeSuggestMock).toHaveBeenCalledWith('Koramangala', 6);

    fireEvent.mouseDown(screen.getByRole('option', { name: /CA-17, Koramangala/i }));
    expect(input).toHaveValue('CA-17, Koramangala, Bengaluru, India');
    expect(onSelect).toHaveBeenCalledWith({
      lat: 12.9352, lng: 77.6245, display_name: 'CA-17, Koramangala, Bengaluru, India',
    });
    expect(screen.queryByRole('listbox', { name: 'Address suggestions' })).toBeNull();
  });

  it('uses full Google labels for the generic-only provider and shows attribution', async () => {
    vi.useFakeTimers();
    googleAddressSuggestMock.mockResolvedValue([{
      place_id: 'ChIJ-exact-place',
      display_name: '6PV8+HVJ, Devanahalli, Southegowdanahalli, Karnataka 562110, India',
      provider: 'google',
    }]);
    render(<Harness provider="google" />);
    const input = screen.getByRole('combobox', { name: 'Address' });

    fireEvent.change(input, { target: { value: '6PV8+HVJ Devanahalli' } });
    await act(async () => vi.advanceTimersByTime(300));

    expect(googleAddressSuggestMock).toHaveBeenCalledWith('6PV8+HVJ Devanahalli', 6);
    expect(geocodeSuggestMock).not.toHaveBeenCalled();
    expect(screen.getByText('Google Maps')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('option', { name: /6PV8\+HVJ/i }));
    expect(input).toHaveValue('6PV8+HVJ, Devanahalli, Southegowdanahalli, Karnataka 562110, India');
  });
});
