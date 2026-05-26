/**
 * WorkingHoursEditor.test.jsx — vitest + RTL coverage for the wellness-vertical
 * per-practitioner weekly working-hours admin page
 * (frontend/src/pages/wellness/WorkingHoursEditor.jsx).
 *
 * Scope: pins the page-surface invariants for the working-hours editor —
 * heading + sub-copy, loading state, GET /api/staff on mount + practitioner
 * selector population (filtered to wellnessRole=doctor/professional), GET
 * /api/wellness/working-hours?doctorId=... on doctor change + 7-day grid
 * render (Sun-Sat with default Sunday-off), per-day Active toggle disabling
 * time inputs, time-input edit, Save → PUT /api/wellness/working-hours/:id
 * with active-only payload + notify.success, practitioner switcher reloads
 * schedule for the new doctor, and the empty-state "No practitioners
 * configured" branch.
 *
 * Test cases (8):
 *   1. Heading "Working hours" + sub-copy ("Per-practitioner weekly schedule.
 *      Bookings outside these hours are blocked at create-time.") render.
 *   2. Loading state: "Loading…" renders while the initial GET /api/staff is
 *      in flight (per CLAUDE.md tick #108 cron-learning).
 *   3. GET /api/staff on mount; selector populated with only
 *      wellnessRole=doctor/professional entries; first such user
 *      auto-selected; GET /api/wellness/working-hours?doctorId=<first> fires.
 *   4. 7-day grid renders (Sun..Sat); Sunday defaults to inactive (checkbox
 *      unchecked + time inputs disabled); Mon-Sat default to active
 *      (checkbox checked + time inputs enabled with 09:00 / 19:00).
 *   5. Toggling Mon's Active checkbox to OFF disables Mon's start/end time
 *      inputs; toggling Sun ON enables Sun's time inputs.
 *   6. Editing Mon's start-time input updates state (input reflects new
 *      value).
 *   7. Save → PUT /api/wellness/working-hours/:id with body
 *      {schedule: [active-only rows]} + notify.success containing doctor
 *      name + active-day count. Inactive rows are dropped from payload
 *      (per SUT lines 72-77 — "Send only active days").
 *   8. Switching practitioner via the selector triggers a fresh GET
 *      /api/wellness/working-hours?doctorId=<new> (per useEffect dep).
 *   9. Empty practitioners list (GET /api/staff resolves to only ADMIN /
 *      USER / null wellnessRole users) → renders empty-state copy
 *      ("No practitioners configured. Add staff with wellnessRole=doctor or
 *      professional under Staff.").
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat __tests__/).
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap useCallback dep identity).
 *   - SUT does NOT consume AuthContext → no Provider wrapper needed.
 *     MemoryRouter is defensive in case any descendant pulls in router hooks.
 *   - vi.mock paths are `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * SHELL-vs-real verification:
 *   - SUT IS REAL (not placeholder) — 152 LOC, 2 useEffect hooks, GET /api/
 *     staff + GET /api/wellness/working-hours + PUT /api/wellness/working-
 *     hours/:id, 7-day grid with per-day Active toggle + time inputs, Save
 *     button with active-only payload filter.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "fetch endpoints likely /api/wellness/locations/:id/
 *     working-hours OR /api/wellness/working-hours". REALITY: it's per-
 *     PRACTITIONER, NOT per-LOCATION. Endpoint is
 *     /api/wellness/working-hours?doctorId=<id> (GET) and
 *     /api/wellness/working-hours/<id> (PUT). The SUT picks staff filtered to
 *     wellnessRole=doctor|professional, not locations.
 *   - Prompt anticipated "weekly schedule per LOCATION". REALITY: weekly
 *     schedule PER PRACTITIONER. The booking-conflict gate at
 *     backend/lib/bookingAvailability.js raises OUTSIDE_WORKING_HOURS per-
 *     doctor, not per-location (per SUT header comment lines 6-12).
 *   - Prompt anticipated "lunch breaks, exception handling". REALITY: SUT
 *     has neither — just (startTime, endTime, isActive) per dayOfWeek. No
 *     break-windows, no per-date exceptions.
 *   - Prompt anticipated "time validation: open ≥ close rejected (or visual
 *     indication)". REALITY: SUT has NO in-JS time validation. The backend
 *     handler is the only validator. Omitted.
 *   - Prompt anticipated "Reset/cancel flow". REALITY: SUT has NO reset
 *     button — schedule state is reset only when the practitioner selector
 *     changes. Omitted.
 *   - Prompt anticipated "Location switcher". REALITY: there's no location
 *     switcher — only a practitioner switcher (replaced in case 8).
 *   - Prompt anticipated "RBAC: USER hides save CTA only if SUT enforces".
 *     CONFIRMED backend-only: SUT does NOT consume AuthContext; every client
 *     sees the Save button. Backend wellness.js route gates by role.
 *     Omitted in-page RBAC tests.
 *   - Prompt anticipated "Error handling: 500 → notify.error; 403 →
 *     access-restricted". CONFIRMED silent-degrade for GET (SUT lines 56-58
 *     `.catch(() => setSchedule(defaults))`); for PUT, fetchApi is expected
 *     to toast the error itself (per SUT line 84 comment "fetchApi already
 *     toasted"). No in-page error UI to test.
 *   - Prompt anticipated "Save CTA flow". CONFIRMED — payload filters to
 *     `isActive: true` only (case 7 asserts this).
 *
 * Path: flat __tests__/WorkingHoursEditor.test.jsx — matches sibling
 * Locations/Holidays flat-path convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
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

import WorkingHoursEditor from '../pages/wellness/WorkingHoursEditor';

const DR_HARSH = {
  id: 11,
  name: 'Dr. Harsh',
  wellnessRole: 'doctor',
};
const PRO_ANITA = {
  id: 12,
  name: 'Anita Sharma',
  wellnessRole: 'professional',
};
const ADMIN_RISHU = {
  id: 1,
  name: 'Rishu',
  wellnessRole: null,
};
const TELECALLER_RAJ = {
  id: 13,
  name: 'Raj Patel',
  wellnessRole: 'telecaller',
};

const DEFAULT_STAFF = [ADMIN_RISHU, DR_HARSH, PRO_ANITA, TELECALLER_RAJ];

const DR_HARSH_SCHEDULE = [
  // Doctor works Mon-Fri 10:00-18:00, off Sat/Sun. Server returns only the
  // rows that exist; SUT fills missing days with defaults.
  { dayOfWeek: 1, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 2, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 3, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 4, startTime: '10:00', endTime: '18:00', isActive: true },
  { dayOfWeek: 5, startTime: '10:00', endTime: '18:00', isActive: true },
];

function installFetchMock({
  staff = DEFAULT_STAFF,
  staffPromise = null,
  scheduleByDoctorId = { '11': DR_HARSH_SCHEDULE, '12': [] },
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/staff' && method === 'GET') {
      if (staffPromise) return staffPromise;
      return Promise.resolve(staff);
    }
    const whMatch = url.match(/^\/api\/wellness\/working-hours\?doctorId=(\d+)$/);
    if (whMatch && method === 'GET') {
      const id = whMatch[1];
      return Promise.resolve(scheduleByDoctorId[id] || []);
    }
    if (/^\/api\/wellness\/working-hours\/\d+$/.test(url) && method === 'PUT') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <WorkingHoursEditor />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('<WorkingHoursEditor /> — page chrome', () => {
  it('renders heading "Working hours" + per-practitioner sub-copy', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Working hours/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Per-practitioner weekly schedule\. Bookings outside these hours are blocked at create-time\./,
      ),
    ).toBeInTheDocument();
  });

  it('renders "Loading…" while the initial GET /api/staff is in flight', async () => {
    installFetchMock({ staffPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<WorkingHoursEditor /> — mount fetch + practitioner selector', () => {
  it('fires GET /api/staff on mount; selector lists only doctor/professional; first auto-selected', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/staff');
    });
    // Wait for the selector to populate (post-staff-fetch).
    await waitFor(() => {
      expect(screen.getByText(/Practitioner:/)).toBeInTheDocument();
    });
    // The select should contain Dr. Harsh + Anita Sharma but NOT Rishu (null
    // wellnessRole) or Raj (telecaller).
    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    const optionTexts = Array.from(select.querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    expect(optionTexts.some((t) => /Dr\. Harsh.*doctor/.test(t))).toBe(true);
    expect(
      optionTexts.some((t) => /Anita Sharma.*professional/.test(t)),
    ).toBe(true);
    expect(optionTexts.some((t) => /Rishu/.test(t))).toBe(false);
    expect(optionTexts.some((t) => /Raj Patel/.test(t))).toBe(false);
    // First practitioner (Dr. Harsh id=11) auto-selected → schedule GET fires.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/working-hours?doctorId=11',
      );
    });
  });
});

describe('<WorkingHoursEditor /> — 7-day grid render', () => {
  it('renders 7 day rows (Sun-Sat); Sunday inactive by default, Mon-Sat active', async () => {
    installFetchMock({ scheduleByDoctorId: { 11: [] } }); // no stored rows → all defaults
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/working-hours?doctorId=11',
      );
    });
    // Wait for the grid to render after schedule load.
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    // All 7 day-active checkboxes present.
    for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(
        screen.getByLabelText(new RegExp(`${day} active`, 'i')),
      ).toBeInTheDocument();
    }
    // Sunday: unchecked (defaultRow says Sunday off).
    expect(screen.getByLabelText(/Sun active/i)).not.toBeChecked();
    // Mon-Sat: checked.
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByLabelText(new RegExp(`${day} active`, 'i'))).toBeChecked();
    }
    // Time inputs: 14 total (7 days × start+end). Sunday's two should be
    // disabled; Mon's should be enabled with default 09:00 / 19:00.
    const timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs.length).toBe(14);
    // Sunday is dayOfWeek=0 → first two time inputs.
    expect(timeInputs[0]).toBeDisabled();
    expect(timeInputs[1]).toBeDisabled();
    // Monday is dayOfWeek=1 → next two.
    expect(timeInputs[2]).not.toBeDisabled();
    expect(timeInputs[3]).not.toBeDisabled();
    expect(timeInputs[2].value).toBe('09:00');
    expect(timeInputs[3].value).toBe('19:00');
  });
});

describe('<WorkingHoursEditor /> — per-day Active toggle', () => {
  it('toggling Mon OFF disables Mon time inputs; toggling Sun ON enables Sun time inputs', async () => {
    installFetchMock({ scheduleByDoctorId: { 11: [] } });
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    // Toggle Mon OFF.
    const monActive = screen.getByLabelText(/Mon active/i);
    fireEvent.click(monActive);
    expect(monActive).not.toBeChecked();
    // Mon's time inputs (indices 2,3) should now be disabled.
    let timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs[2]).toBeDisabled();
    expect(timeInputs[3]).toBeDisabled();

    // Toggle Sun ON.
    const sunActive = screen.getByLabelText(/Sun active/i);
    fireEvent.click(sunActive);
    expect(sunActive).toBeChecked();
    timeInputs = document.querySelectorAll('input[type="time"]');
    expect(timeInputs[0]).not.toBeDisabled();
    expect(timeInputs[1]).not.toBeDisabled();
  });
});

describe('<WorkingHoursEditor /> — time input edit', () => {
  it('editing Mon start-time updates the input value', async () => {
    installFetchMock({ scheduleByDoctorId: { 11: [] } });
    renderPage();
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    const timeInputs = document.querySelectorAll('input[type="time"]');
    // Mon start = index 2.
    fireEvent.change(timeInputs[2], { target: { value: '08:30' } });
    const after = document.querySelectorAll('input[type="time"]');
    expect(after[2].value).toBe('08:30');
  });
});

describe('<WorkingHoursEditor /> — save PUT', () => {
  it('Save → PUT /api/wellness/working-hours/:id with active-only payload + notify.success', async () => {
    installFetchMock(); // Dr. Harsh schedule already populated
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/working-hours?doctorId=11',
      );
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Mon active/i)).toBeInTheDocument();
    });
    // Stored schedule has Mon-Fri active (5 days). Click Save.
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/working-hours/11' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(Array.isArray(body.schedule)).toBe(true);
      // Active days: Mon(1)..Fri(5). Sat(6) defaulted active too per defaultRow,
      // so we expect 6 entries (Mon-Sat) — Dr.Harsh's stored rows only cover
      // Mon-Fri so Sat keeps its default isActive=true.
      expect(body.schedule.length).toBe(6);
      const days = body.schedule.map((r) => r.dayOfWeek).sort((a, b) => a - b);
      expect(days).toEqual([1, 2, 3, 4, 5, 6]);
      // Every payload row carries the active-day shape.
      for (const row of body.schedule) {
        expect(row).toHaveProperty('startTime');
        expect(row).toHaveProperty('endTime');
        expect(row.isActive).toBe(true);
      }
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Saved.*Dr\. Harsh.*schedule.*6 active days/i),
    );
  });
});

describe('<WorkingHoursEditor /> — practitioner switcher', () => {
  it('switching to a different practitioner triggers a fresh GET for the new doctor', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/working-hours?doctorId=11',
      );
    });
    // Switch to Anita Sharma (id=12).
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '12' } });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/working-hours?doctorId=12',
      );
    });
  });
});

describe('<WorkingHoursEditor /> — empty practitioners list', () => {
  it('renders the empty-state copy when no staff have wellnessRole=doctor/professional', async () => {
    installFetchMock({ staff: [ADMIN_RISHU, TELECALLER_RAJ] });
    renderPage();
    expect(
      await screen.findByText(
        /No practitioners configured\. Add staff with wellnessRole=doctor or professional under Staff\./,
      ),
    ).toBeInTheDocument();
    // No schedule GET should fire (no doctorId resolved).
    const wasScheduleFetched = fetchApiMock.mock.calls.some(([u]) =>
      /\/api\/wellness\/working-hours/.test(u),
    );
    expect(wasScheduleFetched).toBe(false);
  });
});
