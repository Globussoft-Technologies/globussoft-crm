import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * frontend/src/components/LocationStaffAssignModal.jsx
 *
 * What's tested
 *   - Loads the roster from
 *     GET /api/wellness/location-assignments/by-location/:id and PRE-TICKS
 *     whoever is already assigned (the modal shows the current roster, it is
 *     not an empty form that hides existing state).
 *   - Warns when the clinic has no coordinates: assigning staff to a
 *     pin-less location enforces nothing, and reporting success on a rule
 *     that can never fire is worse than silence.
 *   - Filter narrows the list; "select all" applies to the FILTERED rows
 *     only, never the people scrolled out of view.
 *   - Inactive staff are hidden until explicitly revealed.
 *   - The three modes post the right payload, and the two destructive ones
 *     (replace / remove) confirm first, with an accurate count of what is
 *     about to be lost.
 *   - Save is blocked with an empty selection.
 *
 * Why
 *   These writes change who is geofenced for attendance. `replace` silently
 *   deletes a person's OTHER clinic assignments and `remove` can leave
 *   someone with no clinic at all — which un-fences them rather than blocking
 *   them, the opposite of what the button name suggests. Both warnings are
 *   pinned here because losing either turns a routine bulk edit into a
 *   payroll incident.
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

import LocationStaffAssignModal from '../components/LocationStaffAssignModal';

const LOCATION = {
  id: 7,
  name: 'Ranchi',
  city: 'Ranchi',
  latitude: 23.3441,
  longitude: 85.3096,
  geofenceRadiusM: 325,
};

const STAFF = [
  { id: 1, name: 'Asha Verma', email: 'asha@clinic.in', role: 'USER', wellnessRole: 'doctor', deactivatedAt: null, assignedHere: true, otherLocationCount: 0 },
  { id: 2, name: 'Bala Iyer', email: 'bala@clinic.in', role: 'USER', wellnessRole: 'nurse', deactivatedAt: null, assignedHere: false, otherLocationCount: 2 },
  { id: 3, name: 'Chandra Rao', email: 'chandra@clinic.in', role: 'MANAGER', wellnessRole: 'telecaller', deactivatedAt: null, assignedHere: false, otherLocationCount: 0 },
  { id: 4, name: 'Dev Nair', email: 'dev@clinic.in', role: 'USER', wellnessRole: 'doctor', deactivatedAt: '2026-01-01T00:00:00Z', assignedHere: false, otherLocationCount: 0 },
];

function mockRoster({ geofenceActive = true, staff = STAFF } = {}) {
  fetchApiMock.mockImplementation(async (url) => {
    if (url.includes('/by-location/')) {
      return { location: LOCATION, geofenceActive, staff };
    }
    return { ok: true, added: 1, removed: 0, clearedElsewhere: 0, unchanged: 0, geofenceActive };
  });
}

async function open(props = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<LocationStaffAssignModal location={LOCATION} onClose={onClose} onSaved={onSaved} {...props} />);
  // Wait for the roster to land before any assertion.
  await screen.findByLabelText(/Select Asha Verma/i);
  return { onClose, onSaved };
}

/** The POST call, ignoring the roster GET that precedes it. */
function postCall() {
  return fetchApiMock.mock.calls.find(
    ([url]) => url.includes('/location-assignments/bulk') || url.includes('/geofence-zone-assignments/bulk'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
  mockRoster();
});

describe('roster loading', () => {
  it('requests the roster for the given location', async () => {
    await open();
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/wellness/location-assignments/by-location/7',
    );
  });

  it('pre-ticks staff who are already assigned here', async () => {
    await open();
    expect(screen.getByLabelText(/Select Asha Verma/i)).toBeChecked();
    expect(screen.getByLabelText(/Select Bala Iyer/i)).not.toBeChecked();
  });

  it('flags who is already here and who splits time elsewhere', async () => {
    await open();
    expect(screen.getByText(/already here/i)).toBeInTheDocument();
    expect(screen.getByText(/also at 2 other clinics/i)).toBeInTheDocument();
  });

  it('hides deactivated staff until they are explicitly revealed', async () => {
    await open();
    expect(screen.queryByLabelText(/Select Dev Nair/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show 1 inactive/i }));
    expect(await screen.findByLabelText(/Select Dev Nair/i)).toBeInTheDocument();
  });
});

describe('geofence status banner', () => {
  it('confirms the radius when the clinic has a pin', async () => {
    await open();
    expect(screen.getByText(/Geofence is active/i)).toHaveTextContent('325');
  });

  it('warns that assignment enforces nothing without a pin', async () => {
    // A location with null coordinates fails open on every punch — assigning
    // twenty people to it changes nothing, and must not look like it did.
    mockRoster({ geofenceActive: false });
    await open();
    expect(screen.getByText(/has no pin yet/i)).toBeInTheDocument();
  });
});

describe('selection', () => {
  it('filters by name, email or role', async () => {
    await open();
    fireEvent.change(screen.getByPlaceholderText(/Filter by name/i), {
      target: { value: 'nurse' },
    });
    expect(screen.getByLabelText(/Select Bala Iyer/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Select Asha Verma/i)).not.toBeInTheDocument();
  });

  it('"select all" ticks only the rows currently shown', async () => {
    // Ticking people who are filtered out of view is how a bulk action
    // quietly geofences the wrong half of the org.
    await open();
    fireEvent.change(screen.getByPlaceholderText(/Filter by name/i), {
      target: { value: 'chandra' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Select all 1 shown/i }));
    fireEvent.change(screen.getByPlaceholderText(/Filter by name/i), {
      target: { value: '' },
    });

    expect(screen.getByLabelText(/Select Chandra Rao/i)).toBeChecked();
    expect(screen.getByLabelText(/Select Bala Iyer/i)).not.toBeChecked();
    // Asha stays ticked because she was pre-selected, not because of the
    // select-all.
    expect(screen.getByLabelText(/Select Asha Verma/i)).toBeChecked();
  });

  it('blocks save when nothing is selected', async () => {
    await open();
    fireEvent.click(screen.getByLabelText(/Select Asha Verma/i)); // untick the only one
    expect(screen.getByRole('button', { name: /Assign 0 staff/i })).toBeDisabled();
  });
});

describe('modes', () => {
  it('gives the submit button a name distinct from the mode chip', async () => {
    // They previously both read "Add to this clinic" — a screen-reader user
    // heard two identical buttons doing different things, and the count in
    // the CTA is useful to sighted users too.
    await open();
    expect(screen.getByRole('button', { name: 'Add to this clinic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assign 1 staff' })).toBeInTheDocument();
  });

  it('add posts the selected ids with mode "add" and does not confirm', async () => {
    const { onSaved, onClose } = await open();
    fireEvent.click(screen.getByLabelText(/Select Chandra Rao/i));
    fireEvent.click(screen.getByRole('button', { name: 'Assign 2 staff' }));

    await waitFor(() => expect(postCall()).toBeTruthy());
    const [url, opts] = postCall();
    expect(url).toBe('/api/wellness/location-assignments/bulk');
    expect(JSON.parse(opts.body)).toEqual({ locationId: 7, userIds: [1, 3], mode: 'add' });
    expect(confirmMock).not.toHaveBeenCalled();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('replace warns with the exact number of assignments about to be deleted', async () => {
    await open();
    // Bala is at 2 other clinics; selecting him makes "replace" destructive.
    fireEvent.click(screen.getByLabelText(/Select Bala Iyer/i));
    fireEvent.click(screen.getByRole('button', { name: 'Make this their only clinic' }));

    // The count is on screen BEFORE the click, not only in the dialog.
    expect(screen.getByText(/2 other clinic assignments will be deleted/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Set as only clinic for 2/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].destructive).toBe(true);
    expect(confirmMock.mock.calls[0][0].message).toMatch(/2 other clinic assignments/i);
  });

  it('replace aborts entirely when the confirm is declined', async () => {
    confirmMock.mockResolvedValue(false);
    await open();
    fireEvent.click(screen.getByLabelText(/Select Bala Iyer/i));
    fireEvent.click(screen.getByRole('button', { name: 'Make this their only clinic' }));
    fireEvent.click(screen.getByRole('button', { name: /Set as only clinic for 2/ }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(postCall()).toBeUndefined();
  });

  it('remove warns that staff left with no clinic become UN-fenced, not blocked', async () => {
    // The single most counter-intuitive behaviour in the whole feature:
    // attendanceGeofence.js treats "no assignments" as not enforced, so
    // removing someone's only clinic frees them rather than blocking them.
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this clinic' }));

    expect(screen.getByText(/clock in from anywhere/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove 1 from clinic/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].message).toMatch(/clock in from anywhere/i);

    await waitFor(() => expect(postCall()).toBeTruthy());
    expect(JSON.parse(postCall()[1].body).mode).toBe('remove');
  });

  it('remove does not warn when the selected staff have another clinic', async () => {
    await open();
    fireEvent.click(screen.getByLabelText(/Select Asha Verma/i));   // untick (she has no other)
    fireEvent.click(screen.getByLabelText(/Select Bala Iyer/i));    // tick (2 others)
    fireEvent.click(screen.getByRole('button', { name: 'Remove from this clinic' }));
    expect(screen.queryByText(/clock in from anywhere/i)).not.toBeInTheDocument();
  });
});

describe('result reporting', () => {
  it('adds a follow-up note when the clinic still has no pin', async () => {
    // Success on an unenforceable rule is a lie by omission.
    fetchApiMock.mockImplementation(async (url) => {
      if (url.includes('/by-location/')) {
        return { location: LOCATION, geofenceActive: false, staff: STAFF };
      }
      return { ok: true, added: 1, removed: 0, clearedElsewhere: 0, unchanged: 0, geofenceActive: false };
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Assign 1 staff/ }));

    await waitFor(() => expect(notifyMock.info).toHaveBeenCalled());
    expect(notifyMock.info.mock.calls[0][0]).toMatch(/not actually restricted/i);
  });

  it('says so plainly when the write changed nothing', async () => {
    fetchApiMock.mockImplementation(async (url) => {
      if (url.includes('/by-location/')) return { location: LOCATION, geofenceActive: true, staff: STAFF };
      return { ok: true, added: 0, removed: 0, clearedElsewhere: 0, unchanged: 0, geofenceActive: true };
    });
    await open();
    fireEvent.click(screen.getByRole('button', { name: /Assign 1 staff/ }));
    await waitFor(() => expect(notifyMock.success).toHaveBeenCalledWith('No changes were needed'));
  });
});

// ── kind="zone" — same component, standalone GeofenceZone endpoints ──
//
// The modal is retargeted entirely through the `kind` prop: different
// roster URL, different bulk URL, different POST body key (zoneId instead
// of locationId), and "zone" instead of "clinic" in every user-facing
// string. This block pins that retargeting rather than re-testing behaviour
// already covered above — the mode/selection/filter logic is IDENTICAL code
// for both kinds, so re-asserting it here would just be redundant coverage.
describe('kind="zone"', () => {
  const ZONE = { id: 42, name: 'HQ Warehouse', geofenceRadiusM: 200 };
  const ZONE_STAFF = [
    { id: 1, name: 'Asha Verma', email: 'asha@clinic.in', deactivatedAt: null, assignedHere: false, otherLocationCount: 0 },
  ];

  function mockZoneRoster({ geofenceActive = true, staff = ZONE_STAFF } = {}) {
    fetchApiMock.mockImplementation(async (url) => {
      if (url.includes('/geofence-zone-assignments/by-zone/')) {
        return { location: ZONE, geofenceActive, staff };
      }
      return { ok: true, added: 1, removed: 0, clearedElsewhere: 0, unchanged: 0, geofenceActive };
    });
  }

  beforeEach(() => {
    mockZoneRoster();
  });

  it('requests the zone roster endpoint, not the clinic one', async () => {
    render(<LocationStaffAssignModal location={ZONE} kind="zone" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText(/Select Asha Verma/i);
    expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/geofence-zone-assignments/by-zone/42');
  });

  it('uses "zone" in the mode chips and posts with a zoneId key', async () => {
    render(<LocationStaffAssignModal location={ZONE} kind="zone" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText(/Select Asha Verma/i);

    expect(screen.getByRole('button', { name: 'Add to this zone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make this their only zone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from this zone' })).toBeInTheDocument();
    // Never regress to the clinic label for a zone instance.
    expect(screen.queryByRole('button', { name: 'Add to this clinic' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Select Asha Verma/i));
    fireEvent.click(screen.getByRole('button', { name: 'Assign 1 staff' }));

    await waitFor(() => expect(postCall()).toBeTruthy());
    const [url, opts] = postCall();
    expect(url).toBe('/api/wellness/geofence-zone-assignments/bulk');
    expect(JSON.parse(opts.body)).toEqual({ zoneId: 42, userIds: [1], mode: 'add' });
  });

  it('replace on a zone counts OTHER ZONE assignments, worded as "zone" not "clinic"', async () => {
    mockZoneRoster({ staff: [{ ...ZONE_STAFF[0], otherLocationCount: 3 }] });
    render(<LocationStaffAssignModal location={ZONE} kind="zone" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText(/Select Asha Verma/i);

    fireEvent.click(screen.getByLabelText(/Select Asha Verma/i));
    fireEvent.click(screen.getByRole('button', { name: 'Make this their only zone' }));

    expect(screen.getByText(/3 other zone assignments will be deleted/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Set as only zone for 1/ }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0][0].message).toMatch(/3 other zone assignments/i);
  });
});
