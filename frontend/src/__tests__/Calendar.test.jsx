/**
 * Calendar (wellness) — regression coverage for #615 + #629.
 *
 * #615 (week-view layout / off-hours stacking) — pin the dynamic hour-range
 *   helper so visits at 7 AM no longer collapse onto the 9 AM cell and
 *   visits at 8 PM no longer collapse onto the 7 PM cell. Pin the grid
 *   template uses minmax(0, 1fr) so the practitioner-name ellipsis chain
 *   actually clips on narrow viewports (per CLAUDE.md ellipsis-on-grid
 *   children standing rule).
 *
 * #629 (waitlist promote dropdown empty / non-functional) — pin that the
 *   New Visit modal surfaces a "Promote from waitlist" toggle when the
 *   Calendar has loaded waiting waitlist entries, and the dropdown
 *   actually receives the entries as <option>s. Pre-fix the Calendar had
 *   no waitlist hook at all.
 *
 * Gap-card-vs-reality drift documented:
 *   - Card #615 framed the bug as "week-view"; Calendar.jsx has only DAY
 *     view. The actual bug surface is the day-view's HOURS clamp on line
 *     128 (pre-fix), so the spec asserts the day-view behaviour.
 *   - Card #629 said "dropdown opens but is empty regardless of how many
 *     patients are on the waitlist". Pre-fix the dropdown didn't exist at
 *     all on Calendar — only on the standalone /wellness/waitlist page.
 *     Fix added a Promote-from-waitlist surface to Calendar's New Visit
 *     modal; the spec pins the new surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    success: vi.fn(),
    error: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
  }),
}));

import { fetchApi } from '../utils/api';
import Calendar, { hoursForVisits } from '../pages/wellness/Calendar';

const today = new Date();
const isoDay = today.toISOString().slice(0, 10);

const staff = [
  { id: 5, name: 'Dr. Anjali Mukherjee', wellnessRole: 'doctor' },
  { id: 6, name: 'Sandeep Bose', wellnessRole: 'professional' },
];

const services = [
  { id: 100, name: 'Hair Transplant', isActive: true },
  { id: 101, name: 'Botox', isActive: true },
];

const patientsList = [
  { id: 200, name: 'Ananya Singh', phone: '+919876543210' },
  { id: 201, name: 'Rohan Verma', phone: '+919876543211' },
];

function setupFetch({ visits = [], waitlist = [] } = {}) {
  fetchApi.mockImplementation((url) => {
    if (url === '/api/staff') return Promise.resolve(staff);
    if (url.startsWith('/api/wellness/visits?')) return Promise.resolve(visits);
    if (url === '/api/wellness/services') return Promise.resolve(services);
    if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
    if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve(waitlist);
    return Promise.resolve([]);
  });
}

function renderCalendar() {
  return render(
    <MemoryRouter>
      <Calendar />
    </MemoryRouter>
  );
}

describe('hoursForVisits() — #615 dynamic hour expansion', () => {
  it('returns the default 9..19 window when no visits are off-hours', () => {
    // Use setHours() so the test is portable across CI timezones — a literal
    // `+05:30` ISO string parses to a different .getHours() value depending
    // on the runtime TZ (CI=UTC, local-dev=IST).
    const v1 = new Date(today); v1.setHours(10, 0, 0, 0);
    const v2 = new Date(today); v2.setHours(15, 0, 0, 0);
    const hrs = hoursForVisits([
      { visitDate: v1.toISOString() },
      { visitDate: v2.toISOString() },
    ]);
    expect(hrs[0]).toBe(9);
    expect(hrs[hrs.length - 1]).toBe(19);
    expect(hrs.length).toBe(11);
  });

  it('expands lower bound to include an early-morning visit (7 AM)', () => {
    const visitAt7 = new Date(today);
    visitAt7.setHours(7, 0, 0, 0);
    const hrs = hoursForVisits([{ visitDate: visitAt7.toISOString() }]);
    expect(hrs[0]).toBeLessThanOrEqual(7);
    // upper bound stays at the default 19
    expect(hrs[hrs.length - 1]).toBe(19);
  });

  it('expands upper bound to include a late-evening visit (21:00)', () => {
    const visitAt21 = new Date(today);
    visitAt21.setHours(21, 0, 0, 0);
    const hrs = hoursForVisits([{ visitDate: visitAt21.toISOString() }]);
    expect(hrs[0]).toBe(9);
    expect(hrs[hrs.length - 1]).toBeGreaterThanOrEqual(21);
  });

  it('produces distinct hour buckets for distinct startHour values (no top-of-day stacking)', () => {
    const v1 = new Date(today); v1.setHours(7, 0, 0, 0);
    const v2 = new Date(today); v2.setHours(8, 0, 0, 0);
    const v3 = new Date(today); v3.setHours(15, 0, 0, 0);
    const hrs = hoursForVisits([
      { visitDate: v1.toISOString() },
      { visitDate: v2.toISOString() },
      { visitDate: v3.toISOString() },
    ]);
    // 7 and 8 are both in the array, so the day-view will place them in
    // separate cells — pre-fix both would have clamped to 9.
    expect(hrs).toContain(7);
    expect(hrs).toContain(8);
    // Range is contiguous, so the in-between hour is also present.
    expect(hrs).toContain(9);
    // No duplicates — each hour appears exactly once.
    expect(new Set(hrs).size).toBe(hrs.length);
  });

  it('handles empty / null / malformed input without throwing', () => {
    expect(hoursForVisits([])).toEqual(expect.arrayContaining([9, 19]));
    expect(hoursForVisits(null)).toEqual(expect.arrayContaining([9, 19]));
    expect(hoursForVisits([{ visitDate: null }, { visitDate: 'garbage' }]))
      .toEqual(expect.arrayContaining([9, 19]));
  });
});

describe('<Calendar /> — #615 layout regressions', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('renders the calendar grid with minmax(0, 1fr) tracks (ellipsis-friendly)', async () => {
    setupFetch({ visits: [] });
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByText(/Day view by practitioner/i)).toBeInTheDocument());

    const grid = container.querySelector('.calendar-grid');
    expect(grid).toBeTruthy();
    // The grid template uses minmax(0, 1fr) per the standing rule —
    // hard 120px floor was removed so columns can shrink and the
    // ellipsis chain on practitioner names actually clips.
    const tpl = grid.style.gridTemplateColumns;
    expect(tpl).toMatch(/minmax\(0,\s*1fr\)/);
  });

  it('renders practitioner column headers with a tooltip + ellipsis chain', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    await waitFor(() => expect(screen.getByText('Dr. Anjali Mukherjee')).toBeInTheDocument());
    // Tooltip surface: a `title` attribute on the column-head wrapper so
    // truncated names are still readable on hover.
    const head = screen.getByText('Dr. Anjali Mukherjee').closest('[title]');
    expect(head).toBeTruthy();
    expect(head.getAttribute('title')).toMatch(/Dr\. Anjali Mukherjee/);
  });
});

describe('<Calendar /> — #629 waitlist promote', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('fetches /api/wellness/waitlist?status=waiting on mount', async () => {
    setupFetch({ visits: [], waitlist: [] });
    renderCalendar();
    await waitFor(() => {
      const calls = fetchApi.mock.calls.map((c) => c[0]);
      expect(calls.some((u) => u.startsWith('/api/wellness/waitlist'))).toBe(true);
    });
  });

  it('does NOT show the waitlist toggle in the modal when waitlist is empty', async () => {
    setupFetch({ visits: [], waitlist: [] });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByText('Dr. Anjali Mukherjee')).toBeInTheDocument());

    // Click any creatable empty slot to open the New Visit modal.
    const cell = container.querySelector('[title^="Book "]');
    expect(cell).toBeTruthy();
    await user.click(cell);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Toggle absent — only the regular Patient dropdown shows.
    expect(screen.queryByRole('radiogroup', { name: /Booking source/i })).not.toBeInTheDocument();
    // Regular flow's "select patient" placeholder option exists.
    expect(screen.getByRole('option', { name: /select patient/i })).toBeInTheDocument();
    // No "select from waitlist" option (the waitlist branch isn't rendered).
    expect(screen.queryByRole('option', { name: /select from waitlist/i })).not.toBeInTheDocument();
  });

  it('renders a "Promote from waitlist" toggle when there are waiting entries', async () => {
    const waitlist = [
      { id: 1, status: 'waiting', patientId: 200, patient: { id: 200, name: 'Ananya Singh', phone: '+919876543210' }, serviceId: 100 },
      { id: 2, status: 'waiting', patientId: 201, patient: { id: 201, name: 'Rohan Verma', phone: '+919876543211' }, serviceId: null },
      { id: 3, status: 'waiting', patientId: 202, patient: { id: 202, name: 'Priya Nair' }, serviceId: 101 },
    ];
    setupFetch({ visits: [], waitlist });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByText('Dr. Anjali Mukherjee')).toBeInTheDocument());

    const cell = container.querySelector('[title^="Book "]');
    await user.click(cell);

    // Toggle present, with a count chip.
    const toggle = await screen.findByRole('radio', { name: /Promote from waitlist \(3\)/i });
    expect(toggle).toBeInTheDocument();
  });

  it('switching to "Promote from waitlist" shows N options where N === number of waiting entries', async () => {
    const waitlist = [
      { id: 1, status: 'waiting', patientId: 200, patient: { id: 200, name: 'Ananya Singh', phone: '+919876543210' }, serviceId: 100 },
      { id: 2, status: 'waiting', patientId: 201, patient: { id: 201, name: 'Rohan Verma' }, serviceId: null },
      { id: 3, status: 'waiting', patientId: 202, patient: { id: 202, name: 'Priya Nair' }, serviceId: 101 },
      // status='offered' filtered out — the dropdown only surfaces 'waiting'
      { id: 4, status: 'offered', patientId: 203, patient: { id: 203, name: 'Already offered' }, serviceId: 100 },
    ];
    setupFetch({ visits: [], waitlist });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByText('Dr. Anjali Mukherjee')).toBeInTheDocument());

    const cell = container.querySelector('[title^="Book "]');
    await user.click(cell);

    const promoteToggle = await screen.findByRole('radio', { name: /Promote from waitlist/i });
    await user.click(promoteToggle);

    const select = screen.getByLabelText(/Waitlisted patient/i);
    expect(select).toBeInTheDocument();
    // Includes the placeholder option, then 3 waiting entries (offered
    // entry excluded).
    const options = within(select).getAllByRole('option');
    expect(options.length).toBe(1 + 3);
    // Patient names appear in option labels.
    expect(within(select).getByRole('option', { name: /Ananya Singh/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Rohan Verma/i })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /Priya Nair/i })).toBeInTheDocument();
    // Already-offered entry NOT shown.
    expect(within(select).queryByRole('option', { name: /Already offered/i })).not.toBeInTheDocument();
  });

  it('promoting fires PUT /api/wellness/waitlist/:id with status=booked + visitDate', async () => {
    const waitlist = [
      { id: 42, status: 'waiting', patientId: 200, patient: { id: 200, name: 'Ananya Singh' }, serviceId: 100 },
    ];
    setupFetch({ visits: [], waitlist });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await waitFor(() => expect(screen.getByText('Dr. Anjali Mukherjee')).toBeInTheDocument());

    const cell = container.querySelector('[title^="Book "]');
    await user.click(cell);

    await user.click(await screen.findByRole('radio', { name: /Promote from waitlist/i }));
    await user.selectOptions(screen.getByLabelText(/Waitlisted patient/i), '42');
    await user.click(screen.getByRole('button', { name: /Promote from waitlist$/i }));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find((c) =>
        c[0] === '/api/wellness/waitlist/42' && c[1]?.method === 'PUT'
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.status).toBe('booked');
      expect(body.visitDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+05:30$/);
    });
  });
});
