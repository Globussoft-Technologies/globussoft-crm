/**
 * Telling a package session apart from an ordinary booking.
 *
 * A session taken out of a package the patient already paid for arrives in the
 * appointment book looking exactly like a walk-in: same patient, same service.
 * Without a marker, staff can charge for it twice, or fail to realise the
 * "requested" row is someone waiting on an answer rather than a confirmed
 * booking. Both of those are money and trust, not cosmetics.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

// The Calendar module drags in the whole day-grid; only two exports are used.
vi.mock('../pages/wellness/Calendar', () => ({
  AssignDoctorModal: () => null,
  displayStatus: (visit) =>
    !visit?.doctorId && visit?.status === 'booked' ? 'pending' : visit?.status,
}));
vi.mock('../components/CallifiedCallDialog', () => ({ default: () => null }));

import { AuthContext } from '../App';
import Appointments from '../pages/wellness/Appointments';

const PACKAGE_SESSION = {
  id: 4300,
  visitDate: '2026-08-29T05:30:00.000Z',
  status: 'requested',
  doctorId: null,
  patient: { id: 5, name: 'Mohit das', phone: '+916200039874' },
  service: { id: 10, name: 'Abdomen - Stretch Marks' },
  doctor: null,
  treatmentPlan: { id: 1436, name: 'Strict removal', totalSessions: 4, completedSessions: 1, servicePackageId: 3 },
};

const WALK_IN = {
  id: 4301,
  visitDate: '2026-08-26T10:23:00.000Z',
  status: 'completed',
  doctorId: 7,
  patient: { id: 5, name: 'Mohit das', phone: '+916200039874' },
  service: { id: 11, name: 'Basic FUE' },
  doctor: { id: 7, name: 'Rupal Sharma' },
  treatmentPlan: null,
};

function renderPage(visits = [PACKAGE_SESSION, WALK_IN]) {
  fetchApiMock.mockImplementation((url) => {
    if (url.startsWith('/api/wellness/visits')) return Promise.resolve(visits);
    if (url === '/api/staff') return Promise.resolve([]);
    return Promise.resolve({});
  });
  return render(
    <AuthContext.Provider value={{ user: { role: 'ADMIN' }, tenant: { name: 'Dr. Enhanced Wellness' } }}>
      <MemoryRouter>
        <Appointments />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  // jsdom has no Element.scrollTo, and the table resets its scroll position on
  // every reload — without this the loader throws before it ever fetches.
  Element.prototype.scrollTo = vi.fn();
});

describe('<Appointments /> — package sessions', () => {
  it('marks a package session with which sitting it is, and leaves walk-ins bare', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());

    const chip = screen.getByTestId('appointments-package-4300');
    // completedSessions 1 → this is the 2nd of 4.
    expect(chip).toHaveTextContent(/Package · session 2 of 4/i);
    expect(chip.getAttribute('title')).toMatch(/already paid for/i);

    // The ordinary appointment carries no such claim.
    expect(screen.queryByTestId('appointments-package-4301')).not.toBeInTheDocument();
  });

  it('sends a requested session to the queue that can actually accept it', async () => {
    // Assign-doctor alone would leave the visit stuck in `requested`.
    renderPage();
    await waitFor(() => expect(screen.getByTestId('appointments-review-request-4300')).toBeInTheDocument());

    expect(screen.getByTestId('appointments-review-request-4300'))
      .toHaveAttribute('href', '/wellness/services?tab=activetreatments');
    expect(screen.queryByTestId('appointments-review-request-4301')).not.toBeInTheDocument();
  });

  it('filters the list down to everything bought as a package', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/status/i), 'package');

    await waitFor(() => expect(screen.queryByText('Basic FUE')).not.toBeInTheDocument());
    expect(screen.getByText('Abdomen - Stretch Marks')).toBeInTheDocument();
  });

  it('never sends a UI-only filter to the server as a status', async () => {
    // `package` is not a visit status; querying for it would return nothing.
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/status/i), 'package');

    await waitFor(() => {
      const withStatus = fetchApiMock.mock.calls
        .map(([url]) => url)
        .filter((url) => typeof url === 'string' && url.includes('status='));
      expect(withStatus.every((url) => !url.includes('status=package'))).toBe(true);
    });
  });

  it('does ask the server for a real status like requested', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/status/i), 'requested');

    await waitFor(() => {
      expect(fetchApiMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('status=requested')))
        .toBe(true);
    });
  });

  it('finds a session by the name of the package it came from', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/patient or service/i), 'Strict removal');

    await waitFor(() => expect(screen.queryByText('Basic FUE')).not.toBeInTheDocument());
    expect(within(screen.getByTestId('appointments-package-4300')).getByText(/session 2 of 4/i)).toBeInTheDocument();
  });
});
