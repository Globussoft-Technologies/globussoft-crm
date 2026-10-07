import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AddressAutocomplete from '../components/AddressAutocomplete';

const geocodeSuggestMock = vi.fn();
vi.mock('../lib/geocoder', () => ({
  geocodeSuggest: (...args) => geocodeSuggestMock(...args),
}));

function Harness() {
  const [address, setAddress] = useState('');
  return <AddressAutocomplete value={address} onChange={setAddress} />;
}

beforeEach(() => {
  geocodeSuggestMock.mockReset();
  geocodeSuggestMock.mockResolvedValue([
    { lat: 12.9352, lng: 77.6245, display_name: 'CA-17, Koramangala, Bengaluru, India' },
  ]);
});

afterEach(() => vi.useRealTimers());

describe('<AddressAutocomplete />', () => {
  it('debounces address lookup and applies the selected suggestion', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Address' });

    fireEvent.change(input, { target: { value: 'Ko' } });
    await act(async () => vi.advanceTimersByTime(400));
    expect(geocodeSuggestMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Koramangala' } });
    await act(async () => vi.advanceTimersByTime(300));
    expect(geocodeSuggestMock).toHaveBeenCalledWith('Koramangala', 6);

    fireEvent.mouseDown(screen.getByRole('option', { name: /CA-17, Koramangala/i }));
    expect(input).toHaveValue('CA-17, Koramangala, Bengaluru, India');
    expect(screen.queryByRole('listbox', { name: 'Address suggestions' })).toBeNull();
  });
});
