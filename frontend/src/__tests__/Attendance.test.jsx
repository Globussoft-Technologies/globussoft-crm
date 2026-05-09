/**
 * Attendance.jsx — vitest + RTL component coverage.
 *
 * Carry-over from v3.5.0 → v3.5.1 → v3.5.2: Wave 2B (`3f0b68c`) shipped
 * the Attendance + Biometric + Leave Management surface with full e2e
 * contract coverage (attendance-api.spec.js) but ZERO frontend component
 * coverage. This file pins the page-surface invariants:
 *
 *   1. Pre-clock-in state: regular user sees the Punch In big button
 *      enabled and Punch Out disabled (no open clock-in for today).
 *   2. Punch In action: clicking Punch In fires POST /api/attendance/clock-in.
 *      After the post resolves, the page reloads /api/attendance/me?from=
 *      and flips Punch Out to enabled.
 *   3. Post-clock-in state: when /me returns a today row with clockInAt
 *      and no clockOutAt, the Punch Out button is enabled and the time
 *      label renders (formatted via toLocaleTimeString).
 *   4. Punch Out action: clicking Punch Out fires POST /api/attendance/clock-out.
 *      Status + total-minutes label render after the second /me reload.
 *   5. 30-day history table: page renders one <tr> per /me row, with
 *      Date / Clock-in / Clock-out / Total / Status / Source columns.
 *   6. Manager Staff section: for role=ADMIN or role=MANAGER, the
 *      "Today — All Staff" section renders, hits GET
 *      /api/attendance/summary?from=<today>&to=<today>, and renders a
 *      per-user row when the response carries `byUser` entries.
 *   7. Empty state: when /me returns [], the table is replaced with a
 *      "No attendance rows yet. Clock in to get started." message.
 *   8. Error state: if /clock-in rejects with `body.error`, notify.error
 *      fires with that message instead of "Clocked in".
 *   9. Already-clocked-in 409 contract: a 409 with body.error="Already
 *      clocked in today" surfaces verbatim through notify.error.
 *
 * Backend contracts pinned by this test
 * ─────────────────────────────────────
 *   - GET   /api/attendance/me?from=YYYY-MM-DD       → array of rows
 *   - POST  /api/attendance/clock-in                 (no body required)
 *   - POST  /api/attendance/clock-out                (no body required)
 *   - GET   /api/attendance/summary?from=&to=        → { present, halfDay,
 *                                                       late, absent,
 *                                                       totalMinutes,
 *                                                       byUser: {...} }
 *
 * Drift-vs-prompt note: the prompt suggested a `/api/attendance/staff/...`
 * endpoint for the manager Staff tab. Reading the component, the actual
 * endpoint is `/api/attendance/summary?from=&to=` (single-day window
 * when used from the dashboard). Pinned to code reality.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

import Attendance from '../pages/wellness/Attendance';
import { AuthContext } from '../App';

const todayKey = new Date().toISOString().slice(0, 10);

function makeMyRow(overrides = {}) {
  // Default: a closed-out PRESENT row from a prior day so the today
  // logic (todayKey filter) doesn't pick it up. Caller can override
  // .date to surface it as "today's open clock-in".
  return {
    id: overrides.id ?? 1,
    date: overrides.date ?? '2026-04-01T00:00:00.000Z',
    clockInAt: overrides.clockInAt ?? '2026-04-01T03:30:00.000Z',
    clockOutAt: overrides.clockOutAt ?? '2026-04-01T12:30:00.000Z',
    totalMinutes: overrides.totalMinutes ?? 540,
    status: overrides.status ?? 'PRESENT',
    source: overrides.source ?? 'manual',
    ...overrides,
  };
}

const regularUser = {
  id: 7,
  userId: 7,
  name: 'Sandeep Bose',
  email: 'sandeep@enhancedwellness.in',
  role: 'USER',
  wellnessRole: 'professional',
};
const adminUser = {
  id: 1,
  userId: 1,
  name: 'Rishu Goyal',
  email: 'rishu@enhancedwellness.in',
  role: 'ADMIN',
  wellnessRole: 'doctor',
};
const wellnessTenant = {
  id: 2,
  name: 'Enhanced Wellness',
  slug: 'enhanced-wellness',
  vertical: 'wellness',
  defaultCurrency: 'INR',
};

function renderAttendance({ user = regularUser, tenant = wellnessTenant } = {}) {
  return render(
    <AuthContext.Provider
      value={{
        user,
        setUser: () => {},
        token: 'test-token',
        setToken: () => {},
        tenant,
        setTenant: () => {},
        loading: false,
      }}
    >
      <MemoryRouter>
        <Attendance />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('<Attendance /> — pre-clock-in state', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('renders Punch In enabled and Punch Out disabled when no today row exists', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    renderAttendance();

    const punchIn = await screen.findByRole('button', { name: /Punch In/i });
    const punchOut = await screen.findByRole('button', { name: /Punch Out/i });
    expect(punchIn).toBeEnabled();
    expect(punchOut).toBeDisabled();
    // Status placeholder for the today panel.
    expect(screen.getByText(/Not clocked in/i)).toBeInTheDocument();
  });
});

describe('<Attendance /> — punch-in action', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('POSTs /api/attendance/clock-in and flips Punch Out to enabled after reload', async () => {
    let clockedIn = false;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/attendance/clock-in' && opts?.method === 'POST') {
        clockedIn = true;
        return Promise.resolve({ success: true });
      }
      if (url.startsWith('/api/attendance/me')) {
        return Promise.resolve(
          clockedIn
            ? [makeMyRow({ id: 99, date: `${todayKey}T00:00:00.000Z`, clockInAt: new Date().toISOString(), clockOutAt: null, totalMinutes: null, status: 'PRESENT' })]
            : []
        );
      }
      return Promise.resolve(null);
    });

    const user = userEvent.setup();
    renderAttendance();

    const punchIn = await screen.findByRole('button', { name: /Punch In/i });
    await user.click(punchIn);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/attendance/clock-in' && opts?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
    });

    // After reload, Punch Out becomes enabled and the today row's status
    // 'PRESENT' renders in the today panel.
    await waitFor(() => {
      const punchOut = screen.getByRole('button', { name: /Punch Out/i });
      expect(punchOut).toBeEnabled();
    });
    expect(notify.success).toHaveBeenCalledWith('Clocked in');
  });
});

describe('<Attendance /> — post-clock-in state', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('shows Punch Out enabled and Punch In disabled when today has an open clock-in', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) {
        return Promise.resolve([
          makeMyRow({
            id: 200,
            date: `${todayKey}T00:00:00.000Z`,
            clockInAt: `${todayKey}T03:30:00.000Z`,
            clockOutAt: null,
            totalMinutes: null,
            status: 'PRESENT',
          }),
        ]);
      }
      return Promise.resolve(null);
    });

    renderAttendance();

    const punchOut = await screen.findByRole('button', { name: /Punch Out/i });
    const punchIn = await screen.findByRole('button', { name: /Punch In/i });
    expect(punchOut).toBeEnabled();
    expect(punchIn).toBeDisabled();
    // The today panel + the history table both surface the PRESENT
    // status text (today's row appears in both places). Pin via
    // getAllByText so the assertion accepts the duplication.
    expect(screen.getAllByText('PRESENT').length).toBeGreaterThanOrEqual(1);
  });
});

describe('<Attendance /> — punch-out action', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('POSTs /api/attendance/clock-out and renders total minutes after reload', async () => {
    let clockedOut = false;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/attendance/clock-out' && opts?.method === 'POST') {
        clockedOut = true;
        return Promise.resolve({ success: true, totalMinutes: 480 });
      }
      if (url.startsWith('/api/attendance/me')) {
        return Promise.resolve([
          makeMyRow({
            id: 300,
            date: `${todayKey}T00:00:00.000Z`,
            clockInAt: `${todayKey}T03:30:00.000Z`,
            clockOutAt: clockedOut ? `${todayKey}T11:30:00.000Z` : null,
            totalMinutes: clockedOut ? 480 : null,
            status: 'PRESENT',
          }),
        ]);
      }
      return Promise.resolve(null);
    });

    const user = userEvent.setup();
    renderAttendance();

    const punchOut = await screen.findByRole('button', { name: /Punch Out/i });
    await user.click(punchOut);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/attendance/clock-out' && opts?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
    });

    // After reload the total label "8h 0m" renders. Today's row shows
    // both in the today panel AND in the 30-day history row, so use
    // getAllByText.
    await waitFor(() => {
      expect(screen.getAllByText(/8h 0m/).length).toBeGreaterThanOrEqual(1);
    });
    expect(notify.success).toHaveBeenCalledWith('Clocked out');
  });
});

describe('<Attendance /> — 30-day history table', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('renders one <tr> per row returned from /api/attendance/me', async () => {
    const rows = [
      makeMyRow({ id: 1, date: '2026-04-30T00:00:00.000Z', status: 'PRESENT' }),
      makeMyRow({ id: 2, date: '2026-04-29T00:00:00.000Z', status: 'HALF_DAY' }),
      makeMyRow({ id: 3, date: '2026-04-28T00:00:00.000Z', status: 'LATE' }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve(rows);
      return Promise.resolve(null);
    });

    renderAttendance();

    await waitFor(() => expect(screen.getByText(/My Last 30 Days/i)).toBeInTheDocument());
    // 6 column headers (Date, Clock-in, Clock-out, Total, Status, Source).
    expect(screen.getByRole('columnheader', { name: /^Date$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Clock-in$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Clock-out$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Status$/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Source$/ })).toBeInTheDocument();
    // 3 data rows + 1 header row.
    const allRows = screen.getAllByRole('row');
    expect(allRows.length).toBe(1 + rows.length);
    // Each status badge appears.
    expect(screen.getByText('PRESENT')).toBeInTheDocument();
    expect(screen.getByText('HALF_DAY')).toBeInTheDocument();
    expect(screen.getByText('LATE')).toBeInTheDocument();
  });

  it('shows the empty-state message when /me returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    renderAttendance();

    await waitFor(() =>
      expect(
        screen.getByText(/No attendance rows yet\. Clock in to get started\./i)
      ).toBeInTheDocument()
    );
    // The history <table> isn't rendered in the empty branch.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('<Attendance /> — manager Staff section', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('does NOT render the manager section for role=USER', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/attendance/summary')) return Promise.resolve({});
      return Promise.resolve(null);
    });

    renderAttendance({ user: regularUser });

    await waitFor(() => expect(screen.getByText(/My Last 30 Days/i)).toBeInTheDocument());
    // The manager-only "Today — All Staff" heading must not be present.
    expect(screen.queryByText(/Today — All Staff/i)).not.toBeInTheDocument();
    // /summary must not have been called.
    const summaryCall = fetchApiMock.mock.calls.find(([u]) =>
      typeof u === 'string' && u.startsWith('/api/attendance/summary')
    );
    expect(summaryCall).toBeFalsy();
  });

  it('renders the Staff section for role=ADMIN, fetches /summary, and renders byUser rows', async () => {
    const summary = {
      present: 4,
      halfDay: 1,
      late: 2,
      absent: 0,
      totalMinutes: 1380,
      byUser: {
        7: { userId: 7, days: 1, minutes: 480 },
        8: { userId: 8, days: 1, minutes: 420 },
      },
    };
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/attendance/summary')) return Promise.resolve(summary);
      return Promise.resolve(null);
    });

    renderAttendance({ user: adminUser });

    await waitFor(() =>
      expect(screen.getByText(/Today — All Staff/i)).toBeInTheDocument()
    );

    // Pin the call shape: /api/attendance/summary?from=<today>&to=<today>.
    await waitFor(() => {
      const summaryCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/attendance/summary?')
      );
      expect(summaryCall).toBeTruthy();
      const url = summaryCall[0];
      expect(url).toMatch(new RegExp(`from=${todayKey}`));
      expect(url).toMatch(new RegExp(`to=${todayKey}`));
    });

    // Stat tiles render with the summary numbers.
    expect(screen.getByText(/^Present$/)).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText(/^Half-day$/)).toBeInTheDocument();
    expect(screen.getByText('1380')).toBeInTheDocument();

    // byUser table has a row per entry. The component renders "User #<id>".
    expect(screen.getByText('User #7')).toBeInTheDocument();
    expect(screen.getByText('User #8')).toBeInTheDocument();
  });
});

describe('<Attendance /> — error states', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notify.success.mockReset();
    notify.error.mockReset();
  });

  it('surfaces a 4xx error message from /clock-in via notify.error', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/attendance/clock-in' && opts?.method === 'POST') {
        const err = new Error('Bad request');
        err.body = { error: 'Clock-in window closed' };
        return Promise.reject(err);
      }
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const user = userEvent.setup();
    renderAttendance();

    const punchIn = await screen.findByRole('button', { name: /Punch In/i });
    await user.click(punchIn);

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith('Clock-in window closed');
    });
    // Success notification must NOT fire on the rejected path.
    expect(notify.success).not.toHaveBeenCalledWith('Clocked in');
  });

  it('surfaces an "already clocked in" 409 contract verbatim via notify.error', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/attendance/clock-in' && opts?.method === 'POST') {
        const err = new Error('Conflict');
        err.status = 409;
        err.body = { error: 'Already clocked in today' };
        return Promise.reject(err);
      }
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const user = userEvent.setup();
    renderAttendance();

    const punchIn = await screen.findByRole('button', { name: /Punch In/i });
    await user.click(punchIn);

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith('Already clocked in today');
    });
  });

  it('falls back to a generic message when the rejection has no body.error', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/attendance/clock-in' && opts?.method === 'POST') {
        return Promise.reject(new Error('network down'));
      }
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const user = userEvent.setup();
    renderAttendance();

    const punchIn = await screen.findByRole('button', { name: /Punch In/i });
    await user.click(punchIn);

    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith('Clock-in failed');
    });
  });
});
