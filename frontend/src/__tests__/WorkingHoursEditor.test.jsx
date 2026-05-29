/**
 * WorkingHoursEditor.test.jsx — vitest + RTL coverage for the wellness-vertical
 * per-staff weekly working-hours editor
 * (frontend/src/pages/wellness/WorkingHoursEditor.jsx).
 *
 * UI shape (2026-05-29 redesign): two-pane layout.
 *   - Left pane (admin only): search input + role-filter chips (with counts)
 *     + scrollable staff list grouped by role. Hidden for non-admin viewers
 *     since they only ever see their own row.
 *   - Right pane: selected staff name + role + 7-day schedule grid + Save
 *     button (admin only).
 *
 * Role-based access:
 *   - ADMIN / MANAGER → left pane lists every active staff row in the
 *     tenant (any wellnessRole). Search narrows by name substring; chips
 *     narrow by role. Save button rendered.
 *   - Other roles (doctor / professional / telecaller / helper) → no left
 *     pane; right pane shows ONLY their own schedule, read-only.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api`.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d).
 *   - `../App` mocked to expose only AuthContext (mirrors BlockedNumbers /
 *     CashRegisters / Settings test pattern). Default viewer is ADMIN;
 *     non-admin tests wrap with their own Provider override.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../App', async () => {
  const ReactMod = await import('react');
  return {
    AuthContext: ReactMod.createContext({
      user: { userId: 1, id: 1, role: 'ADMIN' },
    }),
  };
});

import { AuthContext as MockAuthContext } from '../App';
import WorkingHoursEditor from '../pages/wellness/WorkingHoursEditor';

const DR_HARSH = { id: 11, name: 'Dr. Harsh', role: 'USER', wellnessRole: 'doctor' };
const DR_MOHIT = { id: 15, name: 'Dr. Mohit', role: 'USER', wellnessRole: 'doctor' };
const PRO_ANITA = { id: 12, name: 'Anita Sharma', role: 'USER', wellnessRole: 'professional' };
const PRO_SUNITA = { id: 16, name: 'Sunita Mishra', role: 'USER', wellnessRole: 'professional' };
const ADMIN_RISHU = { id: 1, name: 'Rishu', role: 'ADMIN', wellnessRole: null };
const TELECALLER_RAJ = { id: 13, name: 'Raj Patel', role: 'USER', wellnessRole: 'telecaller' };
const HELPER_MEERA = { id: 14, name: 'Meera', role: 'USER', wellnessRole: 'helper' };

const DEFAULT_STAFF = [
  ADMIN_RISHU,
  DR_HARSH,
  DR_MOHIT,
  PRO_ANITA,
  PRO_SUNITA,
  TELECALLER_RAJ,
  HELPER_MEERA,
];

const DR_HARSH_SCHEDULE = [
  { dayOfWeek: 1, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 2, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 3, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 4, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 5, startTime: '10:00', endTime: '18:00', isActive: true },
];

function installFetchMock({
  staff = DEFAULT_STAFF,
  staffPromise = null,
  scheduleByDoctorId = { '11': DR_HARSH_SCHEDULE },
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/staff' && method === 'GET') {
      if (staffPromise) return staffPromise;
      return Promise.resolve(staff);
    }
    const whMatch = url.match(/^\/api\/wellness\/working-hours\?doctorId=(\d+)$/);
    if (whMatch && method === 'GET') {
      return Promise.resolve(scheduleByDoctorId[whMatch[1]] || []);
    }
    if (/^\/api\/wellness\/working-hours\/\d+$/.test(url) && method === 'PUT') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage(authValue = null) {
  if (!authValue) {
    return render(
      <MemoryRouter>
        <WorkingHoursEditor />
      </MemoryRouter>,
    );
  }
  return render(
    <MemoryRouter>
      <MockAuthContext.Provider value={authValue}>
        <WorkingHoursEditor />
      </MockAuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('<WorkingHoursEditor /> — page chrome (admin viewer)', () => {
  it('renders heading + per-staff sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(screen.getByRole('heading', { name: /Working hours/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Per-staff weekly schedule\. Bookings outside these hours are blocked at create-time\./),
    ).toBeInTheDocument();
  });

  it('renders "Loading…" while the initial GET /api/staff is in flight', async () => {
    installFetchMock({ staffPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<WorkingHoursEditor /> — left-pane staff list (admin)', () => {
  it('lists every staff row grouped by role; first doctor auto-selected; schedule GET fires', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/staff');
    });
    const listbox = await screen.findByRole('listbox', { name: /Staff to schedule/i });
    const options = within(listbox).getAllByRole('option');
    const labels = options.map((o) => o.textContent);
    // All 7 staff present.
    expect(labels.some((t) => /Dr\. Harsh/.test(t))).toBe(true);
    expect(labels.some((t) => /Anita Sharma/.test(t))).toBe(true);
    expect(labels.some((t) => /Raj Patel/.test(t))).toBe(true);
    expect(labels.some((t) => /Meera/.test(t))).toBe(true);
    expect(labels.some((t) => /Rishu/.test(t))).toBe(true);
    // First doctor (Dr. Harsh id=11) auto-selected → schedule GET fires.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/working-hours?doctorId=11');
    });
    // Dr. Harsh's row carries aria-selected=true.
    const selectedOpt = options.find((o) => /Dr\. Harsh/.test(o.textContent));
    expect(selectedOpt).toHaveAttribute('aria-selected', 'true');
  });

  it('renders chip set with counts; "All" shows total visible-staff count', async () => {
    installFetchMock();
    renderPage();
    await screen.findByRole('listbox', { name: /Staff to schedule/i });
    // "All (7)" — 7 staff total.
    expect(screen.getByRole('button', { name: /^All \(7\)$/ })).toBeInTheDocument();
    // Per-role chips with the right counts. Helpers (1), Telecallers (1), etc.
    expect(screen.getByRole('button', { name: /^Doctors \(2\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Professionals \(2\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Telecallers \(1\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Helpers \(1\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Admins \(1\)$/ })).toBeInTheDocument();
  });

  it('search input narrows the list by name substring (case-insensitive)', async () => {
    installFetchMock();
    renderPage();
    const listbox = await screen.findByRole('listbox', { name: /Staff to schedule/i });
    // Pre-filter: 7 rows.
    expect(within(listbox).getAllByRole('option')).toHaveLength(7);
    const searchInput = screen.getByLabelText(/Search staff/i);
    fireEvent.change(searchInput, { target: { value: 'sunita' } });
    await waitFor(() => {
      const opts = within(listbox).getAllByRole('option');
      expect(opts).toHaveLength(1);
      expect(opts[0]).toHaveTextContent(/Sunita Mishra/);
    });
    // Clear via the X button restores full list.
    fireEvent.click(screen.getByLabelText(/Clear search/i));
    await waitFor(() => {
      expect(within(listbox).getAllByRole('option')).toHaveLength(7);
    });
  });

  it('clicking a role chip narrows the list to that role', async () => {
    installFetchMock();
    renderPage();
    const listbox = await screen.findByRole('listbox', { name: /Staff to schedule/i });
    fireEvent.click(screen.getByRole('button', { name: /^Telecallers \(1\)$/ }));
    await waitFor(() => {
      const opts = within(listbox).getAllByRole('option');
      expect(opts).toHaveLength(1);
      expect(opts[0]).toHaveTextContent(/Raj Patel/);
    });
    // Switch back to All.
    fireEvent.click(screen.getByRole('button', { name: /^All \(7\)$/ }));
    await waitFor(() => {
      expect(within(listbox).getAllByRole('option')).toHaveLength(7);
    });
  });

  it('search + chip combine (AND); no-match shows empty-filter hint', async () => {
    installFetchMock();
    renderPage();
    const listbox = await screen.findByRole('listbox', { name: /Staff to schedule/i });
    fireEvent.click(screen.getByRole('button', { name: /^Doctors \(2\)$/ }));
    fireEvent.change(screen.getByLabelText(/Search staff/i), { target: { value: 'mohit' } });
    await waitFor(() => {
      const opts = within(listbox).getAllByRole('option');
      expect(opts).toHaveLength(1);
      expect(opts[0]).toHaveTextContent(/Dr\. Mohit/);
    });
    // Now search for a name that matches no doctor → empty-filter copy.
    fireEvent.change(screen.getByLabelText(/Search staff/i), { target: { value: 'rishu' } });
    await waitFor(() => {
      expect(screen.getByText(/No staff match this filter\./)).toBeInTheDocument();
    });
  });

  it('clicking a staff row selects them + triggers a fresh schedule GET', async () => {
    installFetchMock();
    renderPage();
    const listbox = await screen.findByRole('listbox', { name: /Staff to schedule/i });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/working-hours?doctorId=11');
    });
    // Click Raj Patel (telecaller, id=13).
    const rajRow = within(listbox).getByRole('option', { name: /Raj Patel/ });
    fireEvent.click(rajRow);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/working-hours?doctorId=13');
    });
    expect(rajRow).toHaveAttribute('aria-selected', 'true');
  });
});

describe('<WorkingHoursEditor /> — right-pane schedule grid (admin)', () => {
  it('renders selected staff name + role above the grid; 7-day default grid', async () => {
    installFetchMock({ scheduleByDoctorId: { 11: [] } });
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/working-hours?doctorId=11');
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    // Header shows the selected name. Use getAllByText since the name also
    // appears as a list-row label in the left pane.
    expect(screen.getAllByText(/Dr\. Harsh/).length).toBeGreaterThanOrEqual(1);
    // 7 day rows, Sunday inactive by default.
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByLabelText(new RegExp(`${day} active`, 'i'))).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/Sun active/i)).not.toBeChecked();
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByLabelText(new RegExp(`${day} active`, 'i'))).toBeChecked();
    }
    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs.length).toBe(14);
    expect(timeInputs[0]).toBeDisabled();
    expect(timeInputs[1]).toBeDisabled();
    expect(timeInputs[2]).not.toBeDisabled();
  });

  it('toggling Mon OFF disables Mon time inputs; editing a time updates the input', async () => {
    installFetchMock({ scheduleByDoctorId: { 11: [] } });
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    const monActive = screen.getByLabelText(/Mon active/i);
    fireEvent.click(monActive);
    expect(monActive).not.toBeChecked();
    let timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs[2]).toBeDisabled();
    // Re-enable and edit.
    fireEvent.click(monActive);
    timeInputs = document.querySelectorAll('input[type="time"]');
    fireEvent.change(timeInputs[2], { target: { value: '08:30' } });
    expect(document.querySelectorAll('input[type="time"]')[2].value).toBe('08:30');
  });

  it('Save → PUT /api/wellness/working-hours/:id with active-only payload + notify.success', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/working-hours?doctorId=11');
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/i }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/wellness/working-hours/11' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.schedule.length).toBe(6);
      const days = body.schedule.map((r) => r.dayOfWeek).sort((a, b) => a - b);
      expect(days).toEqual([1, 2, 3, 4, 5, 6]);
      for (const row of body.schedule) {
        expect(row.isActive).toBe(true);
      }
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Saved.*Dr\. Harsh.*schedule.*6 active days/i),
    );
  });
});

describe('<WorkingHoursEditor /> — empty staff list (admin)', () => {
  it('renders the admin empty-state copy when GET /api/staff resolves to []', async () => {
    installFetchMock({ staff: [] });
    renderPage();
    expect(
      await screen.findByText(
        /No staff configured for this tenant\. Add staff under Staff to schedule working hours\./,
      ),
    ).toBeInTheDocument();
    const wasScheduleFetched = fetchApiMock.mock.calls.some(([u]) =>
      /\/api\/wellness\/working-hours\?doctorId=/.test(u),
    );
    expect(wasScheduleFetched).toBe(false);
  });
});

describe('<WorkingHoursEditor /> — non-admin viewer (doctor / telecaller)', () => {
  it('doctor viewer: NO left pane; right pane is read-only with their own schedule', async () => {
    installFetchMock();
    renderPage({ user: { userId: 11, id: 11, role: 'USER', wellnessRole: 'doctor' } });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/staff');
    });
    expect(
      await screen.findByText(/Your weekly schedule \(read-only\)\./),
    ).toBeInTheDocument();
    // No left pane → no listbox, no search input, no role chips.
    expect(screen.queryByRole('listbox', { name: /Staff to schedule/i })).toBeNull();
    expect(screen.queryByLabelText(/Search staff/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^All \(/ })).toBeNull();
    // Schedule GET fires for self.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/working-hours?doctorId=11');
    });
    // Save button is NOT rendered.
    expect(screen.queryByRole('button', { name: /Save schedule/i })).toBeNull();
    // Every active checkbox + every time input is disabled.
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByLabelText(new RegExp(`${day} active`, 'i'))).toBeDisabled();
    }
    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs.length).toBe(14);
    for (const input of timeInputs) {
      expect(input).toBeDisabled();
    }
  });

  it('telecaller viewer: view-only tip rendered; no Save button', async () => {
    installFetchMock();
    renderPage({ user: { userId: 13, id: 13, role: 'USER', wellnessRole: 'telecaller' } });
    await waitFor(() => {
      expect(screen.getByText(/View-only\. Contact an admin or manager/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Save schedule/i })).toBeNull();
  });

  it('non-admin viewer with no matching self-row → no-record empty state', async () => {
    installFetchMock();
    renderPage({ user: { userId: 999, id: 999, role: 'USER', wellnessRole: 'helper' } });
    expect(
      await screen.findByText(
        /No working-hours record found for your account\. Ask an admin to configure your schedule\./,
      ),
    ).toBeInTheDocument();
    const wasScheduleFetched = fetchApiMock.mock.calls.some(([u]) =>
      /\/api\/wellness\/working-hours\?doctorId=/.test(u),
    );
    expect(wasScheduleFetched).toBe(false);
  });
});
