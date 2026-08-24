import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * frontend/src/components/GeofenceZonesPanel.jsx
 *
 * What's tested
 *   - Lists zones from GET /api/wellness/geofence-zones and empty-states
 *     when there are none.
 *   - Create requires a name AND a pin (GeofencePicker's lat/lng) before it
 *     will submit — a zone with no coordinates enforces nothing.
 *   - Marking a NEW zone Global while another zone already holds that spot
 *     confirms first, naming which zone will be replaced. Saving without
 *     an existing Global zone does NOT confirm — nothing is being taken
 *     away.
 *   - The Global chip and the "no staff assigned" warning render from the
 *     server's isGlobal/assignedCount fields, not derived client-side.
 *   - Editing pre-fills the form from the zone's own radiusM.
 *   - Delete confirms, and the message calls out un-fencing when the zone
 *     is currently Global or has staff on it.
 *   - The "Assign staff" action opens LocationStaffAssignModal with
 *     kind="zone" and the zone's own id/name.
 *
 * Why
 *   This is the ONLY way an admin sets GeofenceZone.isGlobal, and getting
 *   that toggle wrong silently changes enforcement for every staff member
 *   with no specific clinic/zone assignment — a much larger blast radius
 *   than a single clinic edit, which is why the override-confirmation flow
 *   gets its own dedicated coverage here rather than being assumed to work
 *   from LocationStaffAssignModal's tests alone.
 *
 * jsdom note
 *   GeofencePicker embeds a real react-leaflet MapContainer. Exactly like
 *   Locations.test.jsx's clinic-form tests, this file does NOT mock
 *   react-leaflet — jsdom tolerates a basic Leaflet mount without throwing,
 *   and the map-interaction behaviour (click-to-place, drag, search) is
 *   already exhaustively covered by GeofencePicker.test.jsx. Tests here
 *   drive GeofencePicker only through its plain <input> lat/lng fields.
 */

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const confirmMock = vi.fn();
const notifyMock = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyMock,
}));

import GeofenceZonesPanel from '../components/GeofenceZonesPanel';

const RANCHI_ZONE = {
  id: 10, name: 'Ranchi Warehouse', latitude: 23.3441, longitude: 85.3096,
  radiusM: 200, isGlobal: false, isActive: true, assignedCount: 3,
};
const HQ_GLOBAL_ZONE = {
  id: 11, name: 'HQ Default', latitude: 20.5937, longitude: 78.9629,
  radiusM: 500, isGlobal: true, isActive: true, assignedCount: 0,
};

function installFetchMock({ zones = [RANCHI_ZONE, HQ_GLOBAL_ZONE] } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/geofence-zones' && method === 'GET') {
      return Promise.resolve(zones);
    }
    if (/^\/api\/wellness\/geofence-zones(\/\d+)?$/.test(url)) {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
  notifyMock.success.mockReset();
  notifyMock.error.mockReset();
  notifyMock.info.mockReset();
});

describe('listing', () => {
  it('renders each zone with its radius and assigned-staff badge', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);

    expect(await screen.findByText('Ranchi Warehouse')).toBeInTheDocument();
    expect(screen.getByText('200m radius')).toBeInTheDocument();
    expect(screen.getByText('3 staff assigned')).toBeInTheDocument();
    expect(screen.getByText('HQ Default')).toBeInTheDocument();
    expect(screen.getByText('500m radius')).toBeInTheDocument();
  });

  it('flags a zone with an active geofence but zero staff', async () => {
    installFetchMock({ zones: [{ ...RANCHI_ZONE, assignedCount: 0 }] });
    render(<GeofenceZonesPanel />);
    expect(await screen.findByText('No staff assigned')).toBeInTheDocument();
  });

  it('does NOT flag the Global zone for having zero staff of its own — it covers everyone by default', async () => {
    installFetchMock({ zones: [HQ_GLOBAL_ZONE] });
    render(<GeofenceZonesPanel />);
    await screen.findByText('HQ Default');
    // 0 assignedCount + isGlobal=true is the normal, expected state for a
    // pure fallback zone — it should read as informational, not alarming.
    expect(screen.queryByText('No staff assigned')).not.toBeInTheDocument();
    expect(screen.getByText('0 staff assigned')).toBeInTheDocument();
  });

  it('shows the Global chip only on the global zone', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');
    expect(screen.getAllByText(/Global fallback/i)).toHaveLength(1);
  });

  it('empty-states when there are no zones yet', async () => {
    installFetchMock({ zones: [] });
    render(<GeofenceZonesPanel />);
    expect(await screen.findByText(/No geofence zones yet/i)).toBeInTheDocument();
  });
});

describe('create validation', () => {
  it('requires a name (native required attribute blocks submit before the handler runs)', async () => {
    // Same pattern as the clinic form (Locations.jsx) -- the input carries
    // `required`, so jsdom's constraint validation stops the submit before
    // React's onSubmit even fires. The component's own `if (!name)` guard is
    // a belt-and-suspenders backstop for a value that reaches the handler
    // some other way (e.g. whitespace-only, which required does NOT catch)
    // -- what this test can actually observe from the DOM is that no POST
    // happens, not which layer stopped it.
    installFetchMock({ zones: [] });
    render(<GeofenceZonesPanel />);
    await screen.findByText(/No geofence zones yet/i);

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByLabelText(/Latitude/i), { target: { value: '23.34' } });
    fireEvent.change(screen.getByLabelText(/Longitude/i), { target: { value: '85.31' } });
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/wellness/geofence-zones',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a whitespace-only name (bypasses the native required check, caught by the JS guard)', async () => {
    installFetchMock({ zones: [] });
    render(<GeofenceZonesPanel />);
    await screen.findByText(/No geofence zones yet/i);

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByPlaceholderText(/Zone name/i), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText(/Latitude/i), { target: { value: '23.34' } });
    fireEvent.change(screen.getByLabelText(/Longitude/i), { target: { value: '85.31' } });
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    expect(notifyMock.error).toHaveBeenCalledWith(expect.stringMatching(/name/i));
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/wellness/geofence-zones',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('requires a pin — a zone with no coordinates enforces nothing', async () => {
    installFetchMock({ zones: [] });
    render(<GeofenceZonesPanel />);
    await screen.findByText(/No geofence zones yet/i);

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByPlaceholderText(/Zone name/i), { target: { value: 'Loading Dock' } });
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    expect(notifyMock.error).toHaveBeenCalledWith(expect.stringMatching(/pin/i));
  });

  it('a complete zone POSTs name/latitude/longitude/radiusM/isGlobal', async () => {
    installFetchMock({ zones: [] });
    render(<GeofenceZonesPanel />);
    await screen.findByText(/No geofence zones yet/i);

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByPlaceholderText(/Zone name/i), { target: { value: 'Loading Dock' } });
    fireEvent.change(screen.getByLabelText(/Latitude/i), { target: { value: '23.34' } });
    fireEvent.change(screen.getByLabelText(/Longitude/i), { target: { value: '85.31' } });
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/wellness/geofence-zones' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({ name: 'Loading Dock', latitude: 23.34, longitude: 85.31, radiusM: 150, isGlobal: false });
    });
  });
});

describe('Global override confirmation', () => {
  it('does NOT confirm when there is no existing Global zone to replace', async () => {
    installFetchMock({ zones: [RANCHI_ZONE] }); // no zone is global yet
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByPlaceholderText(/Zone name/i), { target: { value: 'HQ Default' } });
    fireEvent.change(screen.getByLabelText(/Latitude/i), { target: { value: '20.59' } });
    fireEvent.change(screen.getByLabelText(/Longitude/i), { target: { value: '78.96' } });
    fireEvent.click(screen.getByLabelText(/Make this the Global zone/i));
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/geofence-zones',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('confirms and NAMES the zone about to be replaced when one is already Global', async () => {
    installFetchMock(); // HQ_GLOBAL_ZONE is already global
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByPlaceholderText(/Zone name/i), { target: { value: 'New Global' } });
    fireEvent.change(screen.getByLabelText(/Latitude/i), { target: { value: '20.59' } });
    fireEvent.change(screen.getByLabelText(/Longitude/i), { target: { value: '78.96' } });
    fireEvent.click(screen.getByLabelText(/Make this the Global zone/i));
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].message).toMatch(/HQ Default/);
    expect(confirmMock.mock.calls[0][0].destructive).toBe(true);
  });

  it('aborts the save entirely when the override confirm is declined', async () => {
    confirmMock.mockResolvedValue(false);
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByRole('button', { name: /New zone/i }));
    fireEvent.change(screen.getByPlaceholderText(/Zone name/i), { target: { value: 'New Global' } });
    fireEvent.change(screen.getByLabelText(/Latitude/i), { target: { value: '20.59' } });
    fireEvent.change(screen.getByLabelText(/Longitude/i), { target: { value: '78.96' } });
    fireEvent.click(screen.getByLabelText(/Make this the Global zone/i));
    fireEvent.click(screen.getByRole('button', { name: /Create zone/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(fetchApiMock).not.toHaveBeenCalledWith(
      '/api/wellness/geofence-zones',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('edit', () => {
  it('pre-fills the form from the zone being edited, including its own radius', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    // Two zones are seeded by the default fixture; Ranchi Warehouse's own
    // edit button is the first one in DOM order.
    fireEvent.click(screen.getAllByTitle('Edit zone')[0]);

    expect(screen.getByPlaceholderText(/Zone name/i)).toHaveValue('Ranchi Warehouse');
    expect(screen.getByLabelText(/Check-in radius/i)).toHaveValue('200');
  });
});

describe('delete', () => {
  it('warns about un-fencing staff currently assigned to this zone', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByLabelText('Delete Ranchi Warehouse'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].message).toMatch(/3 staff members? .*currently assigned/i);
  });

  it('calls out that deleting the Global zone un-fences everyone covered by the fallback', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('HQ Default');

    fireEvent.click(screen.getByLabelText('Delete HQ Default'));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].message).toMatch(/Global fallback/i);
  });

  it('DELETEs on confirm and reloads', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByLabelText('Delete Ranchi Warehouse'));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/wellness/geofence-zones/10' && o?.method === 'DELETE',
      );
      expect(call).toBeTruthy();
    });
    expect(notifyMock.success).toHaveBeenCalledWith(expect.stringMatching(/Ranchi Warehouse/));
  });
});

describe('staff assignment', () => {
  it('opens the assign-staff modal targeted at THIS zone with kind="zone"', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByLabelText('Assign staff to Ranchi Warehouse'));

    // LocationStaffAssignModal immediately requests the ZONE roster
    // endpoint, not the clinic one — proves kind="zone" actually reached it.
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/geofence-zone-assignments/by-zone/10',
    ));
  });

  it('also opens from the assigned-count badge itself, not just the icon button', async () => {
    installFetchMock();
    render(<GeofenceZonesPanel />);
    await screen.findByText('Ranchi Warehouse');

    fireEvent.click(screen.getByText('3 staff assigned'));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/geofence-zone-assignments/by-zone/10',
    ));
  });
});
