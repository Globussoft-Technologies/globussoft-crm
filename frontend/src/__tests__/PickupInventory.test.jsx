import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PickupInventory from '../pages/PickupInventory';

vi.mock('../utils/api', () => ({ fetchApi: vi.fn() }));
const geocodeSuggestMock = vi.fn();
vi.mock('../lib/geocoder', () => ({
  geocodeSuggest: (...args) => geocodeSuggestMock(...args),
}));
const notify = { success: vi.fn(), error: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notify }));
import { fetchApi } from '../utils/api';

const payload = {
  pickupLocations: [{
    id: 4,
    name: 'North Gate',
    address: 'MG Road, Bengaluru',
    googleMapsLink: '',
    assignedCount: 3,
    plotCount: 3,
    maxAssignments: 10,
    isActive: true,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
  }],
};

beforeEach(() => {
  fetchApi.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();
  geocodeSuggestMock.mockReset();
  geocodeSuggestMock.mockResolvedValue([]);
  window.localStorage.removeItem('pickup-inventory-column-widths');
});

afterEach(() => vi.restoreAllMocks());

describe('<PickupInventory />', () => {
  it('adds a pickup location from the inventory page', async () => {
    fetchApi.mockResolvedValueOnce(payload).mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(payload);
    render(<PickupInventory />);
    await screen.findByText('North Gate');

    fireEvent.click(screen.getByRole('button', { name: 'Add Pickup Location' }));
    expect(screen.getByRole('dialog', { name: 'Add pickup location' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'South Gate' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pickup address' }), { target: { value: '18 Residency Road, Bengaluru' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum assignments' }), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add location' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/locations',
      {
        method: 'POST',
        body: JSON.stringify({
          name: 'South Gate',
          address: '18 Residency Road, Bengaluru',
          googleMapsLink: '',
          maxAssignments: 12,
          notes: '',
          isActive: true,
        }),
      },
    ));
    expect(notify.success).toHaveBeenCalledWith('Pickup location added.');
  });

  it('saves the selected address coordinates as an exact Google Maps link', async () => {
    geocodeSuggestMock.mockResolvedValueOnce([{
      lat: 12.9352,
      lng: 77.6245,
      display_name: 'CA-17, Koramangala, Bengaluru, India',
    }]);
    fetchApi.mockResolvedValueOnce(payload).mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(payload);
    render(<PickupInventory />);
    await screen.findByText('North Gate');

    fireEvent.click(screen.getByRole('button', { name: 'Add Pickup Location' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name' }), { target: { value: 'South Gate' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pickup address' }), { target: { value: 'Koramangala' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /CA-17, Koramangala/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add location' }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      '/api/pickup-plot-inventory/locations',
      expect.objectContaining({ method: 'POST' }),
    ));
    const createCall = fetchApi.mock.calls.find(([url, options]) => (
      url === '/api/pickup-plot-inventory/locations' && options?.method === 'POST'
    ));
    expect(JSON.parse(createCall[1].body).googleMapsLink).toBe(
      'https://www.google.com/maps/search/?api=1&query=12.9352%2C77.6245',
    );
  });

  it('shows limits, dates, addresses, and Google Maps links without summary stats', async () => {
    fetchApi.mockResolvedValueOnce(payload);
    render(<PickupInventory />);

    expect(await screen.findByText('North Gate')).toBeInTheDocument();
    expect(screen.queryByText('Active locations')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Filter pickup locations by status' })).toHaveStyle({ height: '44px', boxSizing: 'border-box' });
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveStyle({ minHeight: '44px', alignItems: 'center' });
    expect(screen.getByRole('link', { name: 'Open pickup address for North Gate in Google Maps' })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=MG%20Road%2C%20Bengaluru',
    );
    expect(screen.getByText('3 plots')).toBeInTheDocument();
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Created at' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Updated at' })).toBeInTheDocument();
    expect(screen.getByTestId('pickup-inventory-table-scroll')).toHaveClass('pickup-plot-table-scroll');
    expect(screen.getByTestId('pickup-inventory-table-scroll')).toHaveStyle({ overflowX: 'auto', overflowY: 'auto', minHeight: '0' });
    expect(screen.getByTestId('pickup-inventory-table-width')).toHaveStyle({ width: '1200px', minWidth: '100%' });
    expect(screen.getByRole('table')).toHaveStyle({ width: '100%', tableLayout: 'fixed' });
    expect(screen.getByRole('columnheader', { name: 'S.No.' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Pickup location' })).toHaveStyle({ position: 'sticky', top: '0px', color: 'var(--text-secondary)', background: '#f3f4f6' });
    expect(screen.getByRole('link', { name: 'Open North Gate in Google Maps' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=MG%20Road%2C%20Bengaluru');

    const resizeHandle = screen.getByRole('separator', { name: 'Resize Pickup location column' });
    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150 });
    fireEvent.mouseUp(window);
    expect(screen.getByRole('table').querySelectorAll('col')[1]).toHaveStyle({ width: '210px' });
  });

  it('updates the maximum assignment limit without changing the location details', async () => {
    fetchApi.mockResolvedValueOnce(payload).mockResolvedValueOnce({
      ...payload.pickupLocations[0], maxAssignments: 20,
    });
    render(<PickupInventory />);

    fireEvent.change(await screen.findByLabelText('Maximum assignments for North Gate'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save maximum assignments for North Gate' }));

    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/locations/4',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(fetchApi.mock.calls[1][1].body);
    expect(body).toMatchObject({ name: 'North Gate', address: 'MG Road, Bengaluru', maxAssignments: 20 });
    expect(notify.success).toHaveBeenCalledWith('Pickup location limit updated.');
  });

  it('opens an existing text-only address as one precise coordinate pin', async () => {
    geocodeSuggestMock.mockResolvedValueOnce([{ lat: 12.9716, lng: 77.5946 }]);
    const replace = vi.fn();
    const mapWindow = { closed: false, opener: window, location: { replace } };
    const open = vi.spyOn(window, 'open').mockReturnValue(mapWindow);
    fetchApi.mockResolvedValueOnce(payload);
    render(<PickupInventory />);

    fireEvent.click(await screen.findByRole('link', { name: 'Open North Gate in Google Maps' }));

    await waitFor(() => expect(geocodeSuggestMock).toHaveBeenCalledWith('MG Road, Bengaluru', 1));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(replace).toHaveBeenCalledWith(
      'https://www.google.com/maps/search/?api=1&query=12.9716%2C77.5946',
    );
  });

  it('filters pickup locations by active status without changing search behavior', async () => {
    fetchApi.mockResolvedValueOnce({
      pickupLocations: [
        ...payload.pickupLocations,
        {
          ...payload.pickupLocations[0],
          id: 5,
          name: 'Closed Gate',
          address: 'Old Airport Road, Bengaluru',
          isActive: false,
        },
      ],
    });
    render(<PickupInventory />);

    expect(await screen.findByText('North Gate')).toBeInTheDocument();
    expect(screen.getByText('Closed Gate')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter pickup locations by status' }), { target: { value: 'inactive' } });
    expect(screen.queryByText('North Gate')).not.toBeInTheDocument();
    expect(screen.getByText('Closed Gate')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search pickup inventory' }), { target: { value: 'North' } });
    expect(screen.queryByText('Closed Gate')).not.toBeInTheDocument();
    expect(screen.getByText('No pickup locations found.')).toBeInTheDocument();
  });
});
