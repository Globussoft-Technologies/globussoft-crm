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
  it('shows a load error without an empty inventory table', async () => {
    fetchApi.mockRejectedValueOnce(new Error('Failed to load pickup and plot inventory'));
    render(<PickupInventory />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load pickup and plot inventory');
    expect(screen.queryByTestId('pickup-inventory-table-scroll')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('adds a pickup location from the inventory page', async () => {
    fetchApi.mockResolvedValueOnce(payload).mockResolvedValueOnce({ id: 5 }).mockResolvedValueOnce(payload);
    render(<PickupInventory />);
    await screen.findByText('North Gate');

    fireEvent.click(screen.getByRole('button', { name: 'Add Pickup Location' }));
    expect(screen.getByRole('dialog', { name: 'Add pickup location' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Location name *' })).toBeRequired();
    expect(screen.getByRole('combobox', { name: 'Pickup address *' })).toBeRequired();
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name *' }), { target: { value: 'South Gate' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pickup address *' }), { target: { value: '18 Residency Road, Bengaluru' } });
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Location name *' }), { target: { value: 'South Gate' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Pickup address *' }), { target: { value: 'Koramangala' } });
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

  it('shows limits, dates, addresses, and row actions without summary stats', async () => {
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
    expect(screen.getByTestId('pickup-inventory-table-width')).toHaveStyle({ width: '1265px', minWidth: '100%' });
    expect(screen.getByRole('table')).toHaveStyle({ width: '100%', tableLayout: 'fixed' });
    expect(screen.getByRole('columnheader', { name: 'S.No.' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Pickup location' })).toHaveStyle({ position: 'sticky', top: '0px', color: 'var(--text-primary)', background: 'var(--popover-bg, var(--modal-bg, var(--surface-color)))' });
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open North Gate in Google Maps' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open pickup address for North Gate in Google Maps' })).toHaveClass('pickup-inventory-address-link');
    expect(screen.getByText('Active', { selector: '.pickup-inventory-status-badge' })).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: 'Edit North Gate' })).toHaveClass('pickup-inventory-action--edit');
    expect(screen.getByRole('button', { name: 'Edit North Gate' })).toHaveTextContent('Edit');
    expect(screen.getByRole('button', { name: 'Disable North Gate' })).toHaveClass('pickup-inventory-action--disable');
    expect(screen.getByRole('button', { name: 'Disable North Gate' })).toHaveTextContent('Disable');

    const resizeHandle = screen.getByRole('separator', { name: 'Resize Pickup location column' });
    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150 });
    fireEvent.mouseUp(window);
    expect(screen.getByRole('table').querySelectorAll('col')[1]).toHaveStyle({ width: '210px' });
  });

  it('disables a pickup location from the Actions column', async () => {
    fetchApi.mockResolvedValueOnce(payload).mockResolvedValueOnce({
      ...payload.pickupLocations[0], isActive: false,
    });
    render(<PickupInventory />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disable North Gate' }));

    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/locations/4/status',
      { method: 'PATCH', body: JSON.stringify({ isActive: false }) },
    ));
    expect(screen.getByText('Inactive', { selector: '.pickup-inventory-status-badge' })).toHaveClass('is-inactive');
    expect(screen.getByRole('button', { name: 'Activate North Gate' })).toHaveClass('pickup-inventory-action--activate');
    expect(screen.getByRole('button', { name: 'Activate North Gate' })).toHaveTextContent('Activate');
    expect(notify.success).toHaveBeenCalledWith('Pickup location disabled.');
  });

  it('shows a disabled updating state while a location status change is pending', async () => {
    let resolveStatus;
    const statusRequest = new Promise((resolve) => { resolveStatus = resolve; });
    fetchApi.mockResolvedValueOnce(payload).mockReturnValueOnce(statusRequest);
    render(<PickupInventory />);

    const disableButton = await screen.findByRole('button', { name: 'Disable North Gate' });
    fireEvent.click(disableButton);

    expect(disableButton).toBeDisabled();
    expect(disableButton).toHaveTextContent('Updating...');

    resolveStatus({ ...payload.pickupLocations[0], isActive: false });
    expect(await screen.findByRole('button', { name: 'Activate North Gate' })).toBeEnabled();
  });

  it('keeps the current status and reports an error when a status change fails', async () => {
    fetchApi.mockResolvedValueOnce(payload).mockRejectedValueOnce(new Error('Status service unavailable'));
    render(<PickupInventory />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disable North Gate' }));

    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Status service unavailable'));
    expect(screen.getByText('Active', { selector: '.pickup-inventory-status-badge' })).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: 'Disable North Gate' })).toBeEnabled();
  });

  it('edits a pickup location from the Actions column', async () => {
    fetchApi.mockResolvedValueOnce(payload).mockResolvedValueOnce({
      ...payload.pickupLocations[0],
      name: 'North Gate Updated',
      address: '12 Palace Road, Bengaluru',
    });
    render(<PickupInventory />);

    fireEvent.click(await screen.findByRole('button', { name: 'Edit North Gate' }));
    expect(screen.getByRole('dialog', { name: 'Edit pickup location' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit location name *' }), { target: { value: 'North Gate Updated' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Edit pickup address *' }), { target: { value: '12 Palace Road, Bengaluru' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(fetchApi).toHaveBeenLastCalledWith(
      '/api/pickup-plot-inventory/locations/4',
      expect.objectContaining({ method: 'PUT' }),
    ));
    const body = JSON.parse(fetchApi.mock.calls[1][1].body);
    expect(body).toMatchObject({
      name: 'North Gate Updated',
      address: '12 Palace Road, Bengaluru',
      maxAssignments: 10,
      isActive: true,
    });
    expect(notify.success).toHaveBeenCalledWith('Pickup location updated.');
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

    fireEvent.click(await screen.findByRole('link', { name: 'Open pickup address for North Gate in Google Maps' }));

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
    expect(screen.getAllByText('Active', { selector: '.pickup-inventory-status-badge' })).toHaveLength(1);
    expect(screen.getAllByText('Inactive', { selector: '.pickup-inventory-status-badge' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Activate Closed Gate' })).toHaveClass('pickup-inventory-action--activate');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter pickup locations by status' }), { target: { value: 'inactive' } });
    expect(screen.queryByText('North Gate')).not.toBeInTheDocument();
    expect(screen.getByText('Closed Gate')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search pickup inventory' }), { target: { value: 'North' } });
    expect(screen.queryByText('Closed Gate')).not.toBeInTheDocument();
    expect(screen.getByText('No pickup locations found.')).toBeInTheDocument();
  });
});
