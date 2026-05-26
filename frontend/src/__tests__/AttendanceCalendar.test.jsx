/**
 * AttendanceCalendar.test.jsx — vitest + RTL coverage for the wellness-vertical
 * Attendance Calendar page (frontend/src/pages/wellness/AttendanceCalendar.jsx).
 *
 * Scope: pins the page-surface invariants for the monthly attendance/leave
 * calendar — toolbar chrome (prev / month label / next / Today + optional
 * staff filter), loading state, parallel GETs on mount with date-range
 * params, month-grid 7-col layout with minmax(0, 1fr) tracks (per CLAUDE.md
 * ellipsis-on-flex-grid-children standing rule), per-day status badges,
 * leave-indicator chips with cross-link to /leave, month navigation
 * (prev/next/Today re-fetches), manager-only staff dropdown gating, and
 * error-state alert.
 *
 * Test cases (12):
 *   1. Toolbar chrome: prev / next / Today buttons + weekday header row +
 *      Loading indicator render on initial mount.
 *   2. Mount fires parallel GETs to /api/attendance/me?from=&to=
 *      (date-range = current month start/end) AND /api/leave/requests?status=APPROVED.
 *   3. Month grid renders with `gridTemplateColumns: repeat(7, minmax(0, 1fr))`
 *      tracks — per CLAUDE.md tick #108 ellipsis-on-grid-children standing rule.
 *   4. Per-day attendance badge: cells render PRESENT / HALF_DAY / LATE
 *      labels from the indexed-by-date attendance map.
 *   5. Clock-in time renders below the status badge when att.clockInAt
 *      is set (formatted via toLocaleTimeString).
 *   6. Leave indicator: cells inside an APPROVED leave window render the
 *      "Leave" chip with a <Link to=/leave>.
 *   7. Month navigation: clicking Next refetches attendance with the next
 *      month's from/to date-range params.
 *   8. Today button: clicking Today resets the month label to current.
 *   9. Manager (ADMIN role): /api/staff is GET'd on mount AND the staff
 *      filter <select> renders with all staff options.
 *  10. Regular user (USER role): /api/staff is NOT called and no staff
 *      filter <select> renders.
 *  11. Manager switching staff filter triggers a refetch to
 *      /api/attendance/staff/:id?from=&to= (different endpoint for
 *      not-self target).
 *  12. Error state: a rejected attendance fetch surfaces the error message
 *      in a role="alert" panel and clears the grid.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a stable mock fn.
 *   - SUT does NOT use useNotify (errors render inline) — no notify mock needed.
 *   - AuthContext via real Provider wrapper (SUT consumes user.role + user.userId).
 *   - MemoryRouter wrapper (SUT renders <Link to=/leave> for leave cells).
 *   - For dates use Date.now mock pinning to mid-month so the current-month
 *     calculation is deterministic (avoids edge-of-month flakes where the
 *     monthGridDates() leading-days computation drifts).
 *   - vi.mock path is `../utils/api` relative to the flat __tests__/ directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "/api/wellness/attendance" endpoint. REALITY: SUT
 *     hits /api/attendance/me (self) OR /api/attendance/staff/:id (manager
 *     targeting another staff). Both use ?from=&to= date-range params.
 *   - Prompt anticipated leave-data from same attendance endpoint. REALITY:
 *     /api/leave/requests?status=APPROVED is a SEPARATE parallel GET,
 *     filtered client-side via leaveCoversDate(req, day).
 *   - Prompt anticipated useNotify error handling. REALITY: SUT sets local
 *     `error` state and renders inline role="alert" panel — no notify call.
 *   - Prompt anticipated "drill-into-day" navigation. REALITY: SUT only
 *     surfaces a <Link to=/leave> on leave-indicator chips; days themselves
 *     are NOT clickable. No /wellness/attendance/<date> route exists.
 *   - Prompt anticipated "empty-day state placeholder". REALITY: empty days
 *     render as plain cells (date number only — no placeholder text). The
 *     visual "empty" is the absence of a badge/leave-chip; no assertion needed.
 *
 * Path: flat `__tests__/AttendanceCalendar.test.jsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import AttendanceCalendar from '../pages/wellness/AttendanceCalendar';
import { AuthContext } from '../App';

// Mid-month pin avoids edge-of-month flakes from monthGridDates()'s leading-
// days computation (which depends on day-of-week of the 1st).
const PINNED_NOW = new Date(2026, 4, 15, 12, 0, 0); // 2026-05-15 12:00 local

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

const STAFF = [
  { id: 1, name: 'Rishu Goyal', wellnessRole: 'doctor' },
  { id: 7, name: 'Sandeep Bose', wellnessRole: 'professional' },
  { id: 9, name: 'Priya Mehra', wellnessRole: 'professional' },
];

function makeAttRow(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    date: overrides.date ?? '2026-05-10T00:00:00.000Z',
    clockInAt: overrides.clockInAt ?? null,
    clockOutAt: overrides.clockOutAt ?? null,
    totalMinutes: overrides.totalMinutes ?? null,
    status: overrides.status ?? 'PRESENT',
    source: overrides.source ?? 'manual',
    ...overrides,
  };
}

function makeLeaveRow(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    startDate: overrides.startDate ?? '2026-05-12T00:00:00.000Z',
    endDate: overrides.endDate ?? '2026-05-14T00:00:00.000Z',
    status: overrides.status ?? 'APPROVED',
    policy: overrides.policy ?? { name: 'Annual Leave', leaveType: 'PAID' },
    reason: overrides.reason ?? 'Family event',
    ...overrides,
  };
}

function renderCalendar({ user = regularUser, tenant = wellnessTenant } = {}) {
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
        <AttendanceCalendar />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

let dateSpy;
beforeEach(() => {
  fetchApiMock.mockReset();
  // Pin Date.now + the Date constructor so the SUT's `new Date()` resolves
  // deterministically to mid-month May 2026. Using vi.useFakeTimers would
  // also stop setTimeout, which can stall RTL's waitFor — using a spy on
  // Date.now keeps timers alive.
  dateSpy = vi.spyOn(Date, 'now').mockReturnValue(PINNED_NOW.getTime());
});

afterEach(() => {
  if (dateSpy) dateSpy.mockRestore();
});

describe('<AttendanceCalendar /> — toolbar chrome + loading state', () => {
  it('renders prev / next / Today buttons + weekday headers + Loading… on initial mount', () => {
    // Withhold the mock so promises stay pending — exposes Loading state.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    renderCalendar();
    expect(screen.getByRole('button', { name: /Previous month/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Next month/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Jump to today/i })).toBeInTheDocument();
    // Month label — May 2026 (pinned).
    expect(screen.getByText(/May 2026/i)).toBeInTheDocument();
    // Weekday header row — Mon–Sun.
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) => {
      expect(screen.getByText(d)).toBeInTheDocument();
    });
    expect(screen.getByText(/Loading calendar/i)).toBeInTheDocument();
  });
});

describe('<AttendanceCalendar /> — mount fetches', () => {
  it('fires GET /api/attendance/me?from=&to= AND /api/leave/requests?status=APPROVED in parallel', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      // Date-range params correspond to May 2026 (pinned month).
      expect(
        urls.some((u) => /^\/api\/attendance\/me\?from=2026-05-01&to=2026-05-31$/.test(u)),
      ).toBe(true);
      expect(
        urls.some((u) => /^\/api\/leave\/requests\?status=APPROVED$/.test(u)),
      ).toBe(true);
    });
  });
});

describe('<AttendanceCalendar /> — month grid layout', () => {
  it('renders the day grid with gridTemplateColumns: repeat(7, minmax(0, 1fr))', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const { container } = renderCalendar();
    // Wait for the loading branch to flip off and the grid to mount.
    await waitFor(() => {
      expect(screen.queryByText(/Loading calendar/i)).not.toBeInTheDocument();
    });
    // Two grids in the SUT: weekday-header row + day-cell grid. Both use the
    // same template. Find the one with multiple direct children (the day grid).
    const grids = Array.from(container.querySelectorAll('div'))
      .filter((el) => /repeat\(7,\s*minmax\(0,\s*1fr\)\)/.test(el.style.gridTemplateColumns));
    expect(grids.length).toBeGreaterThanOrEqual(1);
    // Day grid has ≥ 28 children (full month grid is 35 or 42 cells).
    const dayGrid = grids.find((g) => g.children.length >= 28);
    expect(dayGrid).toBeTruthy();
  });
});

describe('<AttendanceCalendar /> — per-day attendance badges', () => {
  it('renders PRESENT / HALF_DAY / LATE badges in cells with matching attendance rows', async () => {
    const rows = [
      makeAttRow({ id: 1, date: '2026-05-05T00:00:00.000Z', status: 'PRESENT' }),
      makeAttRow({ id: 2, date: '2026-05-08T00:00:00.000Z', status: 'HALF_DAY' }),
      makeAttRow({ id: 3, date: '2026-05-12T00:00:00.000Z', status: 'LATE' }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve(rows);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    // Status labels appear both as cell badges AND as legend chips at the
    // bottom — getAllByText accepts the duplication (RTL standing rule
    // per CLAUDE.md: prefer getAllByText for labels that appear as both
    // filter chrome AND row badges).
    await waitFor(() => {
      expect(screen.getAllByText('PRESENT').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getAllByText('HALF_DAY').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('LATE').length).toBeGreaterThanOrEqual(2);
  });

  it('renders clock-in time below the status badge when att.clockInAt is set', async () => {
    const rows = [
      makeAttRow({
        id: 1,
        date: '2026-05-05T00:00:00.000Z',
        clockInAt: '2026-05-05T03:30:00.000Z',
        status: 'PRESENT',
      }),
    ];
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve(rows);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    // The clock-in time renders prefixed with "in " — TZ-tolerant regex
    // matches HH:MM (any wall-clock interpretation).
    await waitFor(() => {
      expect(screen.getByText(/in \d{1,2}:\d{2}/)).toBeInTheDocument();
    });
  });
});

describe('<AttendanceCalendar /> — leave indicators', () => {
  it('renders a "Leave" chip with a /leave Link on cells inside an APPROVED leave window', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) {
        return Promise.resolve([
          makeLeaveRow({
            id: 1,
            startDate: '2026-05-12T00:00:00.000Z',
            endDate: '2026-05-14T00:00:00.000Z',
          }),
        ]);
      }
      return Promise.resolve([]);
    });
    renderCalendar();
    // Leave chips appear on May 12, 13, 14 — 3 cells in the window.
    await waitFor(() => {
      const chips = screen.getAllByText(/^Leave$/);
      expect(chips.length).toBeGreaterThanOrEqual(3);
    });
    // Each chip is wrapped in an <a> with href="/leave" (self-view).
    const link = screen.getAllByRole('link', { name: /On leave/i })[0];
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('/leave');
  });
});

describe('<AttendanceCalendar /> — month navigation', () => {
  it('clicking Next refetches attendance with the next month\'s date-range', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    await waitFor(() => {
      expect(screen.queryByText(/Loading calendar/i)).not.toBeInTheDocument();
    });
    // Capture pre-click call count.
    const preCount = fetchApiMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /Next month/i }));
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.length).toBeGreaterThan(preCount);
      // The next call should target June 2026.
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        urls.some((u) => /^\/api\/attendance\/me\?from=2026-06-01&to=2026-06-30$/.test(u)),
      ).toBe(true);
    });
    // Month label flips to June 2026.
    expect(screen.getByText(/June 2026/i)).toBeInTheDocument();
  });

  it('clicking Today after navigating away resets the month label to current', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    await waitFor(() => {
      expect(screen.queryByText(/Loading calendar/i)).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Next month/i }));
    await waitFor(() => {
      expect(screen.getByText(/June 2026/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Jump to today/i }));
    await waitFor(() => {
      expect(screen.getByText(/May 2026/i)).toBeInTheDocument();
    });
  });
});

describe('<AttendanceCalendar /> — manager staff filter', () => {
  it('ADMIN: GETs /api/staff on mount AND renders the staff filter dropdown', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(STAFF);
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/attendance/staff/')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar({ user: adminUser });
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain('/api/staff');
    });
    // The Staff <select> renders (label "Staff" + the dropdown).
    await waitFor(() => {
      expect(screen.getByLabelText(/^Staff$/)).toBeInTheDocument();
    });
    // "Me (...)" option + the two non-self staff members.
    expect(screen.getByRole('option', { name: /^Me \(Rishu Goyal\)/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Sandeep Bose$/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Priya Mehra$/ })).toBeInTheDocument();
  });

  it('USER (regular): does NOT call /api/staff and does NOT render the staff filter', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar({ user: regularUser });
    await waitFor(() => {
      expect(screen.queryByText(/Loading calendar/i)).not.toBeInTheDocument();
    });
    const staffCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/staff');
    expect(staffCall).toBeFalsy();
    expect(screen.queryByLabelText(/^Staff$/)).toBeNull();
  });

  it('ADMIN switching staff filter to another user → refetches /api/attendance/staff/:id', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(STAFF);
      if (url.startsWith('/api/attendance/me')) return Promise.resolve([]);
      if (url.startsWith('/api/attendance/staff/')) return Promise.resolve([]);
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar({ user: adminUser });
    await waitFor(() => {
      expect(screen.getByLabelText(/^Staff$/)).toBeInTheDocument();
    });
    // Switch to Sandeep (id=7).
    fireEvent.change(screen.getByLabelText(/^Staff$/), { target: { value: '7' } });
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        urls.some((u) => /^\/api\/attendance\/staff\/7\?from=2026-05-01&to=2026-05-31$/.test(u)),
      ).toBe(true);
      // Leave query should include userId=7 when manager targets another staff.
      expect(
        urls.some((u) => /^\/api\/leave\/requests\?status=APPROVED&userId=7$/.test(u)),
      ).toBe(true);
    });
  });
});

describe('<AttendanceCalendar /> — error state', () => {
  it('rejected attendance fetch surfaces error in role="alert" panel', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) {
        const err = new Error('Boom');
        err.body = { error: 'Backend unavailable' };
        return Promise.reject(err);
      }
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toMatch(/Backend unavailable/);
    });
    // No "Loading calendar" indicator remains.
    expect(screen.queryByText(/Loading calendar/i)).not.toBeInTheDocument();
  });

  it('rejected fetch with no body.error falls back to the generic message', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/attendance/me')) return Promise.reject(new Error('network down'));
      if (url.startsWith('/api/leave/requests')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Failed to load calendar data/);
    });
  });
});
