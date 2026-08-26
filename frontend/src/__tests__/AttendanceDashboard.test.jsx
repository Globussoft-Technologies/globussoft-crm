/**
 * AttendanceDashboard.jsx — vitest + RTL coverage for the Export / Import
 * toolbar wired into the Attendance List header.
 *
 * What this file pins
 * ───────────────────
 *   1. An ADMIN sees BOTH an Export and an Import control on the list card.
 *   2. A MANAGER sees Export but NOT Import — the dashboard is manager-
 *      visible, but POST /api/attendance/import is ADMIN-only (it can
 *      overwrite existing rows, so it is gated like PUT / DELETE /:id).
 *      Rendering an Import button for a manager would only ever 403.
 *   3. Export hits the attendance-owned endpoint override — NOT the
 *      /api/wellness/csv/:entity pipeline, whose verifyWellnessRole gate
 *      would 403 the travel tenants this page is also mounted for.
 *   4. Export carries the page's Period filter as ?from=&to=, so the file
 *      matches the rows the operator is looking at.
 *   5. The Import modal pulls its column contract from
 *      /api/attendance/import-meta.
 *
 * Backend contracts pinned by this test
 * ─────────────────────────────────────
 *   - GET  /api/attendance/summary?from=&to=   → KPI tile counters
 *   - GET  /api/attendance/list?from=&to=      → { items: [...] }
 *   - GET  /api/attendance/export?from=&to=&format=
 *   - GET  /api/attendance/import-meta         → { headers, thresholds }
 *   - POST /api/attendance/import
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: vi.fn(() => 'test-token'),
}));

const notify = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: vi.fn(() => Promise.resolve('')),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notify,
}));

import AttendanceDashboard from '../pages/AttendanceDashboard';
import { AuthContext } from '../App';

const adminUser = { id: 1, userId: 1, name: 'Ganesh Sharma', role: 'ADMIN' };
const managerUser = { id: 2, userId: 2, name: 'Priya Nair', role: 'MANAGER' };
const wellnessTenant = { id: 2, name: 'Dr Enhanced Wellness', vertical: 'wellness' };

const fetchMock = vi.fn();

function makeListRow(overrides = {}) {
  return {
    id: 1,
    userId: 100,
    user: { id: 100, name: 'Nurse Joy', email: 'joy@clinic.test' },
    date: '2026-01-15T00:00:00.000Z',
    clockInAt: '2026-01-15T09:05:00.000Z',
    clockOutAt: '2026-01-15T18:02:00.000Z',
    arrivalStatus: 'ON_TIME',
    departureStatus: 'ON_TIME',
    checkInRecordedVia: 'manual',
    checkOutRecordedVia: 'manual',
    status: 'PRESENT',
    notes: null,
    ...overrides,
  };
}

function renderDashboard({ user = adminUser, tenant = wellnessTenant } = {}) {
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
        <AttendanceDashboard />
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchMock.mockReset();
  notify.success.mockReset();
  notify.error.mockReset();

  fetchApiMock.mockImplementation((url) => {
    if (url.startsWith('/api/attendance/summary')) {
      return Promise.resolve({ totalRows: 1, present: 1, absent: 0 });
    }
    if (url.startsWith('/api/attendance/list')) {
      return Promise.resolve({ items: [makeListRow()], count: 1 });
    }
    if (url.startsWith('/api/attendance/import-meta')) {
      return Promise.resolve({
        headers: ['employeeName', 'employeeEmail', 'date', 'checkIn', 'checkOut'],
        optionalHeaders: ['employeeName', 'checkIn', 'checkOut'],
        thresholds: { rows: 5000, bytes: 5 * 1024 * 1024 },
      });
    }
    return Promise.resolve({});
  });

  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('<AttendanceDashboard /> — import / export toolbar', () => {
  it('renders Export and Import on the Attendance List card for an ADMIN', async () => {
    renderDashboard({ user: adminUser });

    expect(await screen.findByRole('button', { name: /Export Attendance/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Import Attendance$/i })).toBeInTheDocument();
    // The pre-existing Calendar View link is still alongside it.
    expect(screen.getByRole('link', { name: /Calendar View/i })).toBeInTheDocument();
  });

  it('hides Import from a MANAGER — the import endpoint is ADMIN-only', async () => {
    renderDashboard({ user: managerUser });

    expect(await screen.findByRole('button', { name: /Export Attendance/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import Attendance$/i })).toBeNull();
  });

  it('exports through the attendance-owned endpoint, carrying the Period filter', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['employeeName\r\nNurse Joy\r\n'], { type: 'text/csv' }),
    });

    renderDashboard({ user: adminUser });

    await userEvent.click(await screen.findByRole('button', { name: /Export Attendance/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /^CSV$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0];
    // NOT /api/wellness/csv/... — that pipeline's verifyWellnessRole gate
    // rejects the travel tenants this page is also mounted for.
    expect(url).toMatch(/^\/api\/attendance\/export\?/);
    expect(url).toContain('format=csv');
    // Default Period is "Today", so from === to === today (UTC).
    const today = new Date().toISOString().slice(0, 10);
    expect(url).toContain(`from=${today}`);
    expect(url).toContain(`to=${today}`);
  });

  it('loads the column contract from /import-meta when the modal opens', async () => {
    renderDashboard({ user: adminUser });

    await userEvent.click(await screen.findByRole('button', { name: /^Import Attendance$/i }));

    expect(
      await screen.findByRole('dialog', { name: /Import Attendance from CSV \/ Excel/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(fetchApiMock).toHaveBeenCalledWith('/api/attendance/import-meta', { silent: true }),
    );
    expect(await screen.findByText(/employeeEmail/)).toBeInTheDocument();
  });
});
