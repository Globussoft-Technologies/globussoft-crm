/**
 * BookAppointment.test.jsx — vitest + RTL coverage for the wellness
 * appointment booking page (frontend/src/pages/wellness/BookAppointment.jsx).
 *
 * Focus: the date/time past-booking validation added in the upload/passport
 * branch. Three layers are pinned:
 *   1. `min` attribute on the date input equals today's local date (not UTC).
 *   2. `filterPastSlots` — past time slots are removed from the dropdown when
 *      today's date is selected; all slots appear for a future date.
 *   3. Submit guard — `handleBookAppointment` calls notify.error and does NOT
 *      call the API when the selected date+time is in the past.
 *
 * Timer strategy: `vi.useFakeTimers({ toFake: ['Date'] })` — fakes only
 * `Date` so `new Date()` in filterPastSlots/todayLocalDate returns the pinned
 * value, while `setTimeout`/`setInterval` remain real so RTL's internal
 * `waitFor` polling and `findBy*` queries work without manual timer-advance.
 *
 * Query strategy: the form's date input and time select have NO htmlFor/id
 * association, so getByLabelText is unreliable for them. We use direct DOM
 * selectors (container.querySelector / querySelectorAll) which are stable
 * regardless of ARIA association state or disabled status.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - `fetchApi` mocked at `../utils/api` with a stable vi.fn().
 *   - `notifyObj` is a STABLE module-level reference (fresh-per-call objects
 *     cause useCallback dep churn → infinite re-render loop).
 *   - `AuthContext` is provided via the real Provider wrapper.
 *
 * Path: flat __tests__/BookAppointment.test.jsx — matches sibling convention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// ── Stable notify reference ──────────────────────────────────────────────────
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  success: notifySuccess,
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

// ── fetchApi — controlled per-test ───────────────────────────────────────────
const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// AuthContext comes from the real App module; wrap with its Provider in render.
import { AuthContext } from '../App';
import BookAppointment from '../pages/wellness/BookAppointment';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Default fetchApi: all 4 load calls resolve immediately so loading clears. */
function installDefaultMock() {
  fetchApiMock.mockImplementation((url) => {
    if (url.includes('/api/wellness/doctors/availability')) return Promise.resolve([]);
    if (url.includes('/api/wellness/services'))             return Promise.resolve([]);
    if (url.includes('/api/wellness/appointments/my-memberships')) return Promise.resolve([]);
    if (url.includes('/api/wellness/appointments/my'))      return Promise.resolve([]);
    return Promise.resolve({});
  });
}

/**
 * Render the page and return { container, getDateInput, getTimeSelect }.
 * The date input is the only `input[type="date"]` on the page.
 * The time select is the LAST <select> in the form (after doctor/service/membership).
 */
function renderPage() {
  const { container } = render(
    <MemoryRouter initialEntries={['/wellness/book']}>
      <AuthContext.Provider value={{ user: { id: 1, name: 'Test Patient' } }}>
        <BookAppointment />
      </AuthContext.Provider>
    </MemoryRouter>
  );

  const getDateInput  = () => container.querySelector('input[type="date"]');
  const getTimeSelect = () => {
    const all = container.querySelectorAll('select');
    return all[all.length - 1]; // Time select is always the last <select>
  };

  return { container, getDateInput, getTimeSelect };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────
beforeEach(() => {
  notifyError.mockClear();
  notifySuccess.mockClear();
  notifyObj.info.mockClear();
  notifyObj.confirm.mockClear();
  fetchApiMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('<BookAppointment /> — page chrome', () => {
  it('renders the "Book an Appointment" heading once loading completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    installDefaultMock();
    renderPage();
    expect(await screen.findByRole('heading', { name: /Book an Appointment/i })).toBeInTheDocument();
  });

  it('shows "Loading..." while the initial fetches are in flight', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    fetchApiMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderPage();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('<BookAppointment /> — date input min attribute', () => {
  it('date input min equals today\'s local date (not UTC)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    installDefaultMock();
    const { getDateInput } = renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    expect(getDateInput()).toHaveAttribute('min', '2026-07-07');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('<BookAppointment /> — filterPastSlots: time dropdown for today', () => {
  it('hides past + within-30-min slots when today is selected (clock = 10:00)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Cutoff = 10:30. Slots at or before 10:30 are hidden; 11:00+ are shown.
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    installDefaultMock();
    const { getTimeSelect } = renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    const slotValues = Array.from(getTimeSelect().options)
      .map(o => o.value)
      .filter(Boolean);

    // Past + buffer slots must be absent.
    expect(slotValues).not.toContain('09:00');
    expect(slotValues).not.toContain('09:30');
    expect(slotValues).not.toContain('10:00');
    expect(slotValues).not.toContain('10:30'); // exactly at cutoff, excluded by strict >

    // Future slots must be present.
    expect(slotValues).toContain('11:00');
    expect(slotValues).toContain('19:00');
  });

  it('shows no available-slot options when clock is at 18:30 (all at or past cutoff)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Cutoff = 19:00. Max GENERIC_SLOT is 19:00 — excluded by strict >.
    vi.setSystemTime(new Date('2026-07-07T18:30:00'));
    installDefaultMock();
    const { getTimeSelect } = renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    const nonEmptyOptions = Array.from(getTimeSelect().options).filter(o => o.value !== '');
    expect(nonEmptyOptions).toHaveLength(0);
    expect(getTimeSelect().options[0].textContent).toMatch(/No available slots/i);
  });

  it('shows all generic slots after date changes to a future date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    installDefaultMock();
    const { getDateInput, getTimeSelect } = renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    // Change to tomorrow — filterPastSlots returns all GENERIC_SLOTS because
    // '2026-07-08' !== todayLocalDate() ('2026-07-07').
    fireEvent.change(getDateInput(), { target: { value: '2026-07-08' } });

    await waitFor(() => {
      const slotValues = Array.from(getTimeSelect().options).map(o => o.value).filter(Boolean);
      expect(slotValues).toContain('09:00');
      expect(slotValues).toContain('09:30');
      expect(slotValues).toContain('19:00');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('<BookAppointment /> — submit-time past date+time guard', () => {
  it('calls notify.error and does NOT call the booking API for a past date+time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T14:00:00'));
    installDefaultMock();
    const { container, getDateInput, getTimeSelect } = renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    // Fill the required reason field.
    fireEvent.change(
      screen.getByPlaceholderText(/Briefly describe the issue/i),
      { target: { value: 'Routine checkup' } }
    );

    // Change date to yesterday — fireEvent bypasses the `min` native constraint.
    // For a non-today date filterPastSlots returns all slots so the select fills.
    fireEvent.change(getDateInput(), { target: { value: '2026-07-06' } });

    await waitFor(() => {
      const nonEmpty = Array.from(getTimeSelect().options).filter(o => o.value !== '');
      expect(nonEmpty.length).toBeGreaterThan(0);
    });

    // Select any available slot — combined with yesterday's date it is past.
    const firstSlot = Array.from(getTimeSelect().options).find(o => o.value !== '');
    fireEvent.change(getTimeSelect(), { target: { value: firstSlot.value } });

    // Wait for React to re-render and enable the submit button, then submit.
    // Using fireEvent.submit on the form rather than clicking the button so we
    // don't race with the re-render that enables the button.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Confirm Appointment/i })).not.toBeDisabled();
    });
    fireEvent.submit(container.querySelector('form'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Please select a future date and time for your appointment'
      );
    });

    // The booking API must NOT have been called.
    const bookingCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/wellness/appointments/book' && opts?.method === 'POST'
    );
    expect(bookingCall).toBeUndefined();
  });

  it('does NOT trigger the past-time error and proceeds to book for a future date+time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.includes('/api/wellness/doctors/availability')) return Promise.resolve([]);
      if (url.includes('/api/wellness/services'))             return Promise.resolve([]);
      if (url.includes('/api/wellness/appointments/my-memberships')) return Promise.resolve([]);
      if (url.includes('/api/wellness/appointments/my'))      return Promise.resolve([]);
      if (url === '/api/wellness/appointments/book' && opts?.method === 'POST') {
        return Promise.resolve({
          success: true,
          appointment: { doctorAssigned: false, doctorName: 'TBD' },
        });
      }
      return Promise.resolve({});
    });
    const { getTimeSelect } = renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    // Fill required reason.
    fireEvent.change(
      screen.getByPlaceholderText(/Briefly describe the issue/i),
      { target: { value: 'Follow-up consultation' } }
    );

    // Select 15:00 — clock is 10:00 so this is well in the future.
    fireEvent.change(getTimeSelect(), { target: { value: '15:00' } });

    // Submit.
    fireEvent.click(screen.getByRole('button', { name: /Confirm Appointment/i }));

    // The past-date error must NOT appear.
    await waitFor(() => {
      const pastCalls = notifyError.mock.calls.filter(
        ([msg]) => /future date and time/i.test(msg)
      );
      expect(pastCalls).toHaveLength(0);
    });

    // The booking API must have been called.
    await waitFor(() => {
      const bookingCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/wellness/appointments/book' && opts?.method === 'POST'
      );
      expect(bookingCall).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('<BookAppointment /> — existing validation gates', () => {
  it('submit button is disabled when reason is empty (canSubmit=false)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-07T10:00:00'));
    installDefaultMock();
    renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    // No reason, no time → canSubmit = false.
    expect(screen.getByRole('button', { name: /Confirm Appointment/i })).toBeDisabled();
  });

  it('submit button is disabled when no time slot is available (all slots past)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 18:30 → filterPastSlots returns [] → time select disabled → canSubmit=false.
    vi.setSystemTime(new Date('2026-07-07T18:30:00'));
    installDefaultMock();
    renderPage();

    await screen.findByRole('heading', { name: /Book an Appointment/i });

    fireEvent.change(
      screen.getByPlaceholderText(/Briefly describe the issue/i),
      { target: { value: 'Late-day query' } }
    );

    // appointmentTime stays '' (no slots) → canSubmit=false even with reason filled.
    expect(screen.getByRole('button', { name: /Confirm Appointment/i })).toBeDisabled();
  });
});
