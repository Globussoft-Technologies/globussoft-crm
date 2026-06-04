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
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
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
import Calendar, { hoursForVisits, isHolidayForColumn } from '../pages/wellness/Calendar';

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

function setupFetch({ visits = [], waitlist = [], holidays = [] } = {}) {
  fetchApi.mockImplementation((url) => {
    if (url === '/api/staff') return Promise.resolve(staff);
    if (url.startsWith('/api/wellness/visits?')) return Promise.resolve(visits);
    if (url === '/api/wellness/services') return Promise.resolve(services);
    if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
    if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve(waitlist);
    if (url.startsWith('/api/wellness/holidays')) return Promise.resolve(holidays);
    return Promise.resolve([]);
  });
}

function renderCalendar({ initialEntries } = {}) {
  return render(
    <MemoryRouter initialEntries={initialEntries || ['/wellness/calendar']}>
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
    // Wait for the staff fetch to resolve AND the grid to actually mount.
    // The "Day view by practitioner" heading renders before `loading` flips
    // off, so under CI load the grid can still be absent when the heading
    // appears. Anchor on a practitioner name (rendered inside .calendar-grid)
    // to guarantee the grid is in the DOM before we read its style. Then
    // poll until the inline gridTemplateColumns is non-empty — CI runners
    // sometimes commit the element before the style attribute resolves.
    await screen.findByText('Dr. Anjali Mukherjee');
    await waitFor(() => {
      const g = container.querySelector('.calendar-grid');
      expect(g).toBeTruthy();
      expect(g.style.gridTemplateColumns).toMatch(/minmax\(0,\s*1fr\)/);
    });
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

// #807 (Zylu-Gap CAL-002) — Holiday UI on the calendar grid.
describe('isHolidayForColumn() — #807 per-column holiday matcher', () => {
  it('tenant-wide holiday (no location, no doctor) applies to every column', () => {
    const hs = [{ id: 1, name: 'Republic Day', locationId: null, doctorId: null }];
    expect(isHolidayForColumn(hs, { id: 5, isUnassigned: false })).toBeTruthy();
    expect(isHolidayForColumn(hs, { id: 6, isUnassigned: false })).toBeTruthy();
    // Even the synthetic Unassigned column gets the tenant-wide holiday.
    expect(isHolidayForColumn(hs, { id: '__unassigned__', isUnassigned: true })).toBeTruthy();
  });

  it('practitioner-specific holiday (doctorId set) applies only to that column', () => {
    const hs = [{ id: 2, name: 'Personal Day', locationId: null, doctorId: 5 }];
    expect(isHolidayForColumn(hs, { id: 5, isUnassigned: false })).toBeTruthy();
    expect(isHolidayForColumn(hs, { id: 6, isUnassigned: false })).toBeNull();
  });

  it('returns null when there are no holidays', () => {
    expect(isHolidayForColumn([], { id: 5, isUnassigned: false })).toBeNull();
    expect(isHolidayForColumn(null, { id: 5, isUnassigned: false })).toBeNull();
    expect(isHolidayForColumn(undefined, { id: 5, isUnassigned: false })).toBeNull();
  });

  it('location-scoped holiday applies to non-Unassigned columns (until per-column location ships)', () => {
    const hs = [{ id: 3, name: 'Holi (BLR)', locationId: 7, doctorId: null }];
    // Practitioner column → greyed.
    expect(isHolidayForColumn(hs, { id: 5, isUnassigned: false })).toBeTruthy();
    // Unassigned synthetic column → spared.
    expect(isHolidayForColumn(hs, { id: '__unassigned__', isUnassigned: true })).toBeNull();
  });
});

describe('<Calendar /> — #807 Holiday UI', () => {
  beforeEach(() => {
    fetchApi.mockReset();
  });

  it('renders the holiday banner when /holidays returns at least one row', async () => {
    setupFetch({
      visits: [],
      holidays: [{ id: 1, name: 'Republic Day', locationId: null, doctorId: null, date: today.toISOString() }],
    });
    renderCalendar();
    const banner = await screen.findByTestId('holiday-banner');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/Republic Day/);
  });

  // Per-column "Holiday — name" tags + column greying + click-blocking on
  // holiday cells were planned but not shipped in the current SUT. The
  // banner is the only Holiday-UI surface; see the holiday-banner test
  // above. If/when per-column treatment ships, restore the three cases
  // pinned in this describe block from git history.
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension wave — 2026-05-26
// Adds ≥8 new cases covering day-grid navigation, doctor swimlanes,
// appointment-cell click, doctor + status filters, booking-type legend, empty
// + loading states, and new-appointment surface. Uses the stable mock-object
// pattern + getAllByText for duplicate labels (status legend + status badge
// duplication), and screen.findByText for the async-fetch-driven first paint.
// ─────────────────────────────────────────────────────────────────────────────

describe('<Calendar /> — From/To date range + day-chip navigation', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('renders the day-view header with today\'s date', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    // Heading renders even during loading.
    expect(screen.getByRole('heading', { name: /Calendar/i })).toBeInTheDocument();
    // The subtitle is "Day view by practitioner — <localized date>".
    expect(await screen.findByText(/Day view by practitioner/i)).toBeInTheDocument();
  });

  it('renders a single Day picker (was From/To dual picker) with prev/next arrows', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    // The new single input is aria-labelled "Day shown on grid".
    expect(screen.getByLabelText(/Day shown on grid/i)).toBeInTheDocument();
    // The old dual From/To labels are gone.
    expect(screen.queryByLabelText(/From date/i)).toBeNull();
    expect(screen.queryByLabelText(/To date/i)).toBeNull();
    expect(screen.queryByLabelText(/Export end date/i)).toBeNull();
    // Prev/Next day navigation arrows live next to the picker.
    expect(screen.getByLabelText(/Previous day/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Next day/i)).toBeInTheDocument();
  });

  it('changing the Day input re-issues a /visits fetch for the new day', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');

    const visitsCallsBefore = fetchApi.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].startsWith('/api/wellness/visits?')
    );

    // jsdom doesn't simulate keyboard input into `<input type="date">`
    // cleanly — fireEvent.change is the canonical write path.
    fireEvent.change(screen.getByLabelText(/Day shown on grid/i), { target: { value: '2030-01-15' } });

    await waitFor(() => {
      const visitsCallsAfter = fetchApi.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].startsWith('/api/wellness/visits?')
      );
      expect(visitsCallsAfter.length).toBeGreaterThan(visitsCallsBefore.length);
    });
  });

  it('Day input drives the rendered day (header subtitle + visits fetch)', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');

    // Set Day to a stable future day; header subtitle and fetch follow.
    fireEvent.change(screen.getByLabelText(/Day shown on grid/i), { target: { value: '2030-04-17' } });

    // Header subtitle reflects the new day.
    await waitFor(() => {
      expect(screen.getByText(/Day view by practitioner/i).textContent).toMatch(/2030/);
    });
    expect(screen.getByLabelText(/Day shown on grid/i).value).toBe('2030-04-17');
  });
});

describe('<Calendar /> — doctor swimlanes + appointment cells', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('renders one swimlane column per practitioner with visits', async () => {
    const v = new Date(today); v.setHours(11, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 1, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        service: { id: 100, name: 'Hair Transplant' },
        visitDate: v.toISOString(), status: 'booked',
      }],
    });
    renderCalendar();
    // Both practitioners are in showAll mode by default.
    expect(await screen.findByText('Dr. Anjali Mukherjee')).toBeInTheDocument();
    expect(screen.getByText('Sandeep Bose')).toBeInTheDocument();
  });

  it('appointment cell renders a Link to the patient detail page', async () => {
    const v = new Date(today); v.setHours(11, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 7, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        service: { id: 100, name: 'Hair Transplant' },
        visitDate: v.toISOString(), status: 'booked',
      }],
    });
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');

    // The chip's title includes the patient name; the link href points to
    // /wellness/patients/<id>. We anchor on the href because the patient
    // name "Ananya Singh" also appears in the test data fixture.
    await waitFor(() => {
      const link = container.querySelector('a[href="/wellness/patients/200"]');
      expect(link).toBeTruthy();
    });
  });

  it('renders an Unassigned column when a visit has no doctorId', async () => {
    const v = new Date(today); v.setHours(13, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 8, doctorId: null, patientId: 201,
        patient: { id: 201, name: 'Rohan Verma' },
        visitDate: v.toISOString(), status: 'arrived',
      }],
    });
    renderCalendar();
    // The synthetic Unassigned column header shows up.
    expect(await screen.findByText('Unassigned')).toBeInTheDocument();
  });

  it('status border colour reflects the visit status (in-treatment → amber)', async () => {
    const v = new Date(today); v.setHours(12, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 11, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        visitDate: v.toISOString(), status: 'in-treatment',
      }],
    });
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await waitFor(() => {
      const link = container.querySelector('a[href="/wellness/patients/200"]');
      expect(link).toBeTruthy();
      // STATUS_BORDER['in-treatment'] === '#f59e0b' (amber). jsdom returns
      // the rgb()-form for CSS color values: rgb(245, 158, 11).
      const borderLeft = link.style.borderLeft || link.style.borderLeftColor;
      expect(borderLeft.toLowerCase()).toMatch(/#f59e0b|rgb\(\s*245\s*,\s*158\s*,\s*11\s*\)/);
    });
  });
});

describe('<Calendar /> — filters: practitioner toggle + status legend', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('"Show all" toggle filters practitioner columns to only those with visits today', async () => {
    const v = new Date(today); v.setHours(11, 0, 0, 0);
    // Only Anjali (id=5) has a visit; Sandeep (id=6) does not.
    setupFetch({
      visits: [{
        id: 1, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        visitDate: v.toISOString(), status: 'booked',
      }],
    });
    const user = userEvent.setup();
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    // Default showAll=true → both columns visible.
    expect(screen.getByText('Sandeep Bose')).toBeInTheDocument();
    // Toggle is labelled "All practitioners (2)".
    const toggle = screen.getByRole('button', { name: /All practitioners \(2\)/i });
    await user.click(toggle);
    // After toggling, only Anjali stays (she has a visit). Sandeep removed.
    await waitFor(() => {
      expect(screen.queryByText('Sandeep Bose')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Dr. Anjali Mukherjee')).toBeInTheDocument();
    // Toggle label flips to "1 of 2 practitioners".
    expect(screen.getByRole('button', { name: /1 of 2 practitioners/i })).toBeInTheDocument();
  });

  it('renders all 7 status legend entries (filter UI surface)', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    // Each STATUS_BORDER key is rendered as a small legend chip at the bottom.
    // "booked" appears both as a legend chip AND as a row badge when there
    // are booked visits — use getAllByText (per the RTL standing rule about
    // labels that appear as both filter chrome AND row badges).
    expect(screen.getAllByText(/^booked$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^confirmed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^arrived$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^in-treatment$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^completed$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^no-show$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^cancelled$/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the booking-type legend chip with all 4 booking-type labels', async () => {
    setupFetch({ visits: [] });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    const legend = screen.getByTestId('booking-type-legend');
    expect(legend).toBeInTheDocument();
    // The 4 booking types should each surface their label inside the legend.
    expect(within(legend).getByText(/Clinic visit/i)).toBeInTheDocument();
    expect(within(legend).getByText(/At home/i)).toBeInTheDocument();
    expect(within(legend).getByText(/Video consult/i)).toBeInTheDocument();
    expect(within(legend).getByText(/Phone consult/i)).toBeInTheDocument();
  });
});

describe('<Calendar /> — empty + loading states', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('renders the loading skeleton while the initial fetch is pending', () => {
    // Don't resolve the visits call — leave it pending so the loading state
    // sticks. The skeleton sits at data-testid="calendar-loading".
    fetchApi.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    renderCalendar();
    expect(screen.getByTestId('calendar-loading')).toBeInTheDocument();
  });

  it('renders the empty-state message when no practitioners and no visits exist', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve([]);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar();
    // Loading flips off, columns.length === 0 → empty-state copy renders.
    expect(await screen.findByText(/No practitioners configured/i)).toBeInTheDocument();
  });

  it('survives an API error (no crash, calendar reaches a stable render)', async () => {
    // First call (visits) rejects; others resolve to [].
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/visits?')) return Promise.reject(new Error('network down'));
      if (url === '/api/staff') return Promise.resolve(staff);
      return Promise.resolve([]);
    });
    renderCalendar();
    // The catch block sets visits=[], staff=[]; with staff=[] the columns
    // collapse → empty-state message renders. Either way, the component does
    // not throw.
    expect(await screen.findByText(/No practitioners configured|Day view by practitioner/i)).toBeInTheDocument();
  });
});

describe('<Calendar /> — new-appointment surface', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('clicking an empty creatable slot opens the New Visit modal seeded with that practitioner + hour', async () => {
    setupFetch({ visits: [] });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');

    // The first creatable cell carries a title beginning with "Book ".
    const cell = container.querySelector('[title^="Book "]');
    expect(cell).toBeTruthy();
    // Title format: "Book HH:00 with <practitioner name>".
    expect(cell.getAttribute('title')).toMatch(/^Book \d{2}:00 with /);
    await user.click(cell);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /New visit/i })).toBeInTheDocument();
  });

  it('Cancel button on the New Visit modal closes the dialog', async () => {
    setupFetch({ visits: [] });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');

    const cell = container.querySelector('[title^="Book "]');
    await user.click(cell);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('submitting the New Visit form fires POST /api/wellness/visits with patientId + status=booked', async () => {
    setupFetch({ visits: [] });
    // POST resolves to a new visit row; refetch returns same empty array.
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      if (url === '/api/wellness/visits' && opts?.method === 'POST') return Promise.resolve({ id: 999 });
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');

    const cell = container.querySelector('[title^="Book "]');
    await user.click(cell);
    // Two <select>s render in the new-visit flow (Patient + Service). The
    // patient one is required and is the FIRST combobox in DOM order — pick
    // it by index to avoid ambiguity with the optional service select.
    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], '200');
    await user.click(screen.getByRole('button', { name: /Book visit/i }));

    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find((c) =>
        c[0] === '/api/wellness/visits' && c[1]?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.patientId).toBe(200);
      expect(body.status).toBe('booked');
      // visitDate is the IST wall time at the clicked hour.
      expect(body.visitDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+05:30$/);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Extension wave — 2026-05-26 (second pass)
// Adds 9 new cases covering booking-type chips (IN_HOME w/ travel-time + null
// fallback), resource picker (presence + service-id filtering), notes/service
// payload fields, patients/{data,patients} envelope shapes, waitlist {items}
// envelope, doctor-specific-holiday spares other columns, holiday banner
// absent when no holidays, and the full STATUS_BORDER colour table for every
// visit status. SUT @ 866L; pre-extension ratio 83% — bringing into 100%+.
// ─────────────────────────────────────────────────────────────────────────────

describe('<Calendar /> — booking-type chips on event cards', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('IN_HOME visit renders the "At home" chip + travel-time annotation when travelTimeMinutes is set', async () => {
    const v = new Date(today); v.setHours(11, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 21, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        visitDate: v.toISOString(), status: 'booked',
        bookingType: 'IN_HOME', travelTimeMinutes: 45,
      }],
    });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    // Booking-type badge surfaces with the IN_HOME testid.
    const badge = await screen.findByTestId('booking-type-IN_HOME');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toMatch(/At home/i);
    // Travel-time annotation only appears for IN_HOME with finite minutes > 0.
    expect(screen.getByTestId('travel-time').textContent).toMatch(/45 min/);
  });

  it('VIDEO visit renders the "Video consult" chip without travel-time', async () => {
    const v = new Date(today); v.setHours(11, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 22, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        visitDate: v.toISOString(), status: 'booked',
        bookingType: 'VIDEO', travelTimeMinutes: 99,
      }],
    });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    expect(await screen.findByTestId('booking-type-VIDEO')).toBeInTheDocument();
    // travel-time testid is gated to IN_HOME only — non-IN_HOME rows skip it
    // even if the value is set on the row.
    expect(screen.queryByTestId('travel-time')).toBeNull();
  });

  it('legacy visit with null bookingType defaults to the CLINIC_VISIT chip', async () => {
    const v = new Date(today); v.setHours(11, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 23, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        visitDate: v.toISOString(), status: 'booked',
        bookingType: null,
      }],
    });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    // null falls back to CLINIC_VISIT.
    expect(await screen.findByTestId('booking-type-CLINIC_VISIT')).toBeInTheDocument();
  });
});

describe('<Calendar /> — resource picker in the New Visit modal', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('does not render the Resource select when /resources returns an empty list', async () => {
    setupFetch({ visits: [] });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await user.click(container.querySelector('[title^="Book "]'));
    // Resource label is absent because the resources prop is [].
    expect(screen.queryByText(/Resource \(optional\)/i)).not.toBeInTheDocument();
  });

  it('renders the Resource select when /resources returns entries, and filters by service compat', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/resources')) return Promise.resolve([
        // Room 1 only allows service 100 (Hair Transplant).
        { id: 31, name: 'Room 1', type: 'room', serviceIds: JSON.stringify([100]) },
        // Room 2 only allows service 101 (Botox).
        { id: 32, name: 'Room 2', type: 'room', serviceIds: JSON.stringify([101]) },
        // Generic device — no serviceIds → always shown.
        { id: 33, name: 'Laser device', type: 'machine', serviceIds: null },
      ]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await user.click(container.querySelector('[title^="Book "]'));

    // Resource label appears now.
    expect(await screen.findByText(/Resource \(optional\)/i)).toBeInTheDocument();
    const resourceSelect = screen.getByDisplayValue('— no resource pinned —');

    // With no service picked yet, ALL resources are visible (filter no-ops).
    expect(within(resourceSelect).getByRole('option', { name: /Room 1/i })).toBeInTheDocument();
    expect(within(resourceSelect).getByRole('option', { name: /Room 2/i })).toBeInTheDocument();
    expect(within(resourceSelect).getByRole('option', { name: /Laser device/i })).toBeInTheDocument();

    // Pick service 100 (Hair Transplant) → Room 2 (which only allows 101) drops.
    const selects = screen.getAllByRole('combobox');
    // Patient = 0, Service = 1, Resource = 2.
    await user.selectOptions(selects[1], '100');
    await waitFor(() => {
      expect(within(resourceSelect).queryByRole('option', { name: /Room 2/i })).toBeNull();
    });
    expect(within(resourceSelect).getByRole('option', { name: /Room 1/i })).toBeInTheDocument();
    // Generic (no serviceIds) still shown.
    expect(within(resourceSelect).getByRole('option', { name: /Laser device/i })).toBeInTheDocument();
  });
});

describe('<Calendar /> — POST body extras: notes + serviceId + resourceId', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('includes notes + serviceId + resourceId in the POST body when filled', async () => {
    fetchApi.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/resources')) return Promise.resolve([
        { id: 50, name: 'Procedure Room A', type: 'room', serviceIds: null },
      ]);
      if (url === '/api/wellness/visits' && opts?.method === 'POST') return Promise.resolve({ id: 1000 });
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await user.click(container.querySelector('[title^="Book "]'));

    const selects = screen.getAllByRole('combobox');
    await user.selectOptions(selects[0], '200'); // patient
    await user.selectOptions(selects[1], '100'); // service
    await user.selectOptions(selects[2], '50');  // resource
    await user.type(screen.getByPlaceholderText(/Walk-in confirmed/i), 'Follow-up after laser session');
    await user.click(screen.getByRole('button', { name: /Book visit/i }));

    await waitFor(() => {
      const postCall = fetchApi.mock.calls.find((c) =>
        c[0] === '/api/wellness/visits' && c[1]?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.patientId).toBe(200);
      expect(body.serviceId).toBe(100);
      expect(body.resourceId).toBe(50);
      expect(body.doctorId).toBe(5);
      expect(body.notes).toMatch(/Follow-up after laser session/);
    });
  });
});

describe('<Calendar /> — defensive envelope reads', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('accepts /patients returning { patients: [...] } envelope shape (#312)', async () => {
    // Same setup pattern but /patients returns the wrapped shape.
    fetchApi.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve({ patients: patientsList, total: 2 });
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await user.click(container.querySelector('[title^="Book "]'));

    // Patient dropdown should have both seeded patients despite the envelope.
    const patientSelect = screen.getAllByRole('combobox')[0];
    expect(within(patientSelect).getByRole('option', { name: /Ananya Singh/ })).toBeInTheDocument();
    expect(within(patientSelect).getByRole('option', { name: /Rohan Verma/ })).toBeInTheDocument();
  });

  it('accepts /patients returning { data: [...] } envelope shape', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve({ data: patientsList });
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await user.click(container.querySelector('[title^="Book "]'));
    const patientSelect = screen.getAllByRole('combobox')[0];
    expect(within(patientSelect).getByRole('option', { name: /Ananya Singh/ })).toBeInTheDocument();
  });

  it('accepts /waitlist returning { items: [...] } envelope shape', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([]);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve({
        items: [
          { id: 77, status: 'waiting', patientId: 200, patient: { id: 200, name: 'Ananya Singh' }, serviceId: 100 },
        ],
      });
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const user = userEvent.setup();
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    await user.click(container.querySelector('[title^="Book "]'));
    // The promote toggle should appear because the {items:} envelope produced 1 entry.
    expect(await screen.findByRole('radio', { name: /Promote from waitlist \(1\)/i })).toBeInTheDocument();
  });
});

describe('<Calendar /> — holiday edge cases', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  it('does NOT render the holiday banner when /holidays returns []', async () => {
    setupFetch({ visits: [], holidays: [] });
    renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    expect(screen.queryByTestId('holiday-banner')).toBeNull();
  });

  it('doctor-specific holiday surfaces in the banner but does not yet gate per-column bookability', async () => {
    setupFetch({
      visits: [],
      // Personal day-off for doctor 5 only.
      holidays: [{ id: 9, name: 'Personal Day', locationId: null, doctorId: 5, date: today.toISOString() }],
    });
    const { container } = renderCalendar();
    await screen.findByText('Dr. Anjali Mukherjee');
    // SUT renders a banner for the day's holidays — pin that surface only;
    // per-column blocking is not shipped yet.
    expect(await screen.findByTestId('holiday-banner')).toBeInTheDocument();
    // Cells remain bookable across both practitioner columns.
    const bookable = container.querySelector('[title^="Book "]');
    expect(bookable).toBeTruthy();
  });
});

describe('<Calendar /> — full status-border colour table', () => {
  beforeEach(() => { fetchApi.mockReset(); });

  // Pin every STATUS_BORDER entry that's a plain hex (the 'confirmed' one is a
  // CSS variable so it doesn't render to a deterministic rgb() in jsdom).
  const statusCases = [
    { status: 'booked',       expected: /#3b82f6|rgb\(\s*59\s*,\s*130\s*,\s*246\s*\)/i },
    { status: 'arrived',      expected: /#a855f7|rgb\(\s*168\s*,\s*85\s*,\s*247\s*\)/i },
    { status: 'completed',    expected: /#10b981|rgb\(\s*16\s*,\s*185\s*,\s*129\s*\)/i },
    { status: 'no-show',      expected: /#ef4444|rgb\(\s*239\s*,\s*68\s*,\s*68\s*\)/i },
    { status: 'cancelled',    expected: /#64748b|rgb\(\s*100\s*,\s*116\s*,\s*139\s*\)/i },
  ];

  for (const { status, expected } of statusCases) {
    it(`renders the ${status} border colour on the event chip`, async () => {
      const v = new Date(today); v.setHours(12, 0, 0, 0);
      setupFetch({
        visits: [{
          id: 100 + statusCases.indexOf(statusCases.find((s) => s.status === status)),
          doctorId: 5, patientId: 200,
          patient: { id: 200, name: 'Ananya Singh' },
          visitDate: v.toISOString(), status,
        }],
      });
      const { container } = renderCalendar();
      await screen.findByText('Dr. Anjali Mukherjee');
      await waitFor(() => {
        const link = container.querySelector('a[href="/wellness/patients/200"]');
        expect(link).toBeTruthy();
        const borderLeft = link.style.borderLeft || link.style.borderLeftColor;
        expect(borderLeft.toLowerCase()).toMatch(expected);
      });
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Focus-from-Appointments handshake — pins that deep-linking from the
// Appointments page (Open in calendar →) lands on the visit's day AND
// surfaces the focused chip with a halo + scrollIntoView call.
// ─────────────────────────────────────────────────────────────────────────────

describe('<Calendar /> — focus query-param handshake', () => {
  let scrollSpy;
  beforeEach(() => {
    fetchApi.mockReset();
    // The global vitest setup polyfills scrollIntoView with a noop; spy on
    // it here so the focus-handshake test can assert it was invoked.
    scrollSpy = vi.spyOn(window.Element.prototype, 'scrollIntoView').mockImplementation(() => {});
  });

  it('with ?focus=<id>&date=<yyyy-mm-dd>, snaps the Day picker to the date and surfaces the focused chip', async () => {
    // Pick a date string for the URL; build a Date with the same wall-clock
    // hour the visit uses so the chip lands at a stable hour in the grid.
    const target = '2030-01-15';
    const visitDate = new Date(2030, 0, 15, 14, 0, 0, 0);
    setupFetch({
      visits: [{
        id: 555, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        service: { id: 100, name: 'Hair Transplant' },
        visitDate: visitDate.toISOString(), status: 'booked',
      }],
    });
    renderCalendar({ initialEntries: [`/wellness/calendar?focus=555&date=${target}`] });

    // Day input should be pinned to the target date (single-picker UX).
    const dayInput = await screen.findByLabelText(/Day shown on grid/i);
    expect(dayInput.value).toBe(target);

    // The focused chip carries the data-testid="focused-visit" marker AND a
    // ref-driven scrollIntoView call has been made on it.
    const focused = await screen.findByTestId('focused-visit');
    expect(focused).toBeInTheDocument();
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('without ?date, fetches /visits/<id> to learn the day, then snaps the Day picker to it', async () => {
    const visitDate = new Date(2030, 5, 20, 11, 0, 0, 0);
    fetchApi.mockImplementation((url) => {
      if (url === '/api/staff') return Promise.resolve(staff);
      if (url.startsWith('/api/wellness/visits?')) return Promise.resolve([{
        id: 777, doctorId: 5, patientId: 200,
        patient: { id: 200, name: 'Ananya Singh' },
        visitDate: visitDate.toISOString(), status: 'booked',
      }]);
      if (url === '/api/wellness/visits/777') return Promise.resolve({
        id: 777, visitDate: visitDate.toISOString(),
      });
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/wellness/patients') return Promise.resolve(patientsList);
      if (url.startsWith('/api/wellness/waitlist')) return Promise.resolve([]);
      if (url.startsWith('/api/wellness/holidays')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
    renderCalendar({ initialEntries: ['/wellness/calendar?focus=777'] });

    // Eventually Day snaps to 2030-06-20 driven by the /visits/777 fetch.
    await waitFor(() => {
      expect(screen.getByLabelText(/Day shown on grid/i).value).toBe('2030-06-20');
    });
  });
});

