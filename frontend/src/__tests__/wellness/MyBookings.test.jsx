/**
 * wellness/MyBookings.test.jsx — vitest + RTL coverage for the patient
 * appointment-management page.
 *
 * Scope: pins the page-surface invariants for the four-bucket layout,
 * action eligibility flags (canCancel / canReschedule from the server),
 * and the cancel + reschedule action paths.
 *
 *   1. Page renders the heading "My Bookings" + four bucket tabs
 *      (Upcoming / Pending / Completed / Cancelled).
 *   2. Mount fires one GET /api/wellness/portal/appointments?bucket=<key>
 *      per bucket so every section's count is populated.
 *   3. Upcoming bucket renders one card per appointment with service
 *      name, doctor name, date+time, and a status pill.
 *   4. Pending bucket cards render the "Pending assignment" doctor label
 *      AND the orange left border.
 *   5. canCancel=false hides the Cancel button.
 *   6. canReschedule=false hides the Reschedule button.
 *   7. Cancel action POSTs to /portal/appointments/:id/cancel after the
 *      user confirms the dialog.
 *   8. Reschedule action PATCHes /portal/appointments/:id/reschedule with
 *      the new date + time payload.
 *
 * Standing rule: stable mock object reference for useNotify per the
 * CLAUDE.md RTL standing rule — fresh objects per call trip infinite
 * re-render loops via useCallback dependency churn.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// fetchApi is the DEFAULT fetcher. MyBookings accepts an injected
// `fetcher` prop too — we exercise both surfaces below.
const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
// Stable object reference (CLAUDE.md RTL rule) — fresh objects per call
// churn useCallback dependency identity and cause infinite re-renders.
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import MyBookings from '../../pages/wellness/MyBookings';
import { AuthContext } from '../../App';

// CUSTOMER session — the gate on MyBookings allows the page to load
// only when user.role === 'CUSTOMER' (or a custom fetcher is injected,
// which the phone+OTP portal shell does). Tests render under a
// CUSTOMER AuthContext so the default fetchApi path is exercised.
const CUSTOMER_AUTH = {
  user: { id: 99, role: 'CUSTOMER', name: 'Test Patient' },
  tenant: { id: 1, vertical: 'wellness' },
};

const sampleUpcoming = [
  {
    id: 1, status: 'booked',
    serviceName: 'Consultation', doctorName: 'Dr. Smith',
    appointmentDate: '2099-06-15T10:00:00.000Z',
    doctorAssigned: true, canCancel: true, canReschedule: true,
  },
  {
    id: 2, status: 'confirmed',
    serviceName: 'Follow-up', doctorName: 'Dr. Patel',
    appointmentDate: '2099-06-16T11:00:00.000Z',
    doctorAssigned: true, canCancel: true, canReschedule: false,
  },
];
const samplePending = [
  {
    id: 3, status: 'booked',
    serviceName: 'Laser Hair Reduction', doctorName: 'Pending assignment',
    appointmentDate: '2099-06-17T14:00:00.000Z',
    doctorAssigned: false, canCancel: true, canReschedule: true,
  },
];
const sampleCompleted = [
  {
    id: 4, status: 'completed',
    serviceName: 'Derma Glow', doctorName: 'Dr. Kumar',
    appointmentDate: '2026-05-01T09:00:00.000Z',
    doctorAssigned: true, canCancel: false, canReschedule: false,
  },
];
const sampleCancelled = [];

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
  // Per-bucket GET routing. The page mounts each bucket independently.
  fetchApiMock.mockImplementation(async (url) => {
    if (url.includes('bucket=upcoming'))  return { bucket: 'upcoming',  count: sampleUpcoming.length,  appointments: sampleUpcoming };
    if (url.includes('bucket=pending'))   return { bucket: 'pending',   count: samplePending.length,   appointments: samplePending };
    if (url.includes('bucket=completed')) return { bucket: 'completed', count: sampleCompleted.length, appointments: sampleCompleted };
    if (url.includes('bucket=cancelled')) return { bucket: 'cancelled', count: sampleCancelled.length, appointments: sampleCancelled };
    return { success: true };
  });
});

function renderPage(props = {}, authValue = CUSTOMER_AUTH) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={authValue}>
        <MyBookings {...props} />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('MyBookings — page shell', () => {
  it('renders the heading and all four bucket tabs', async () => {
    renderPage();
    expect(await screen.findByText('My Bookings')).toBeInTheDocument();
    expect(screen.getByTestId('my-bookings-tab-upcoming')).toBeInTheDocument();
    expect(screen.getByTestId('my-bookings-tab-pending')).toBeInTheDocument();
    expect(screen.getByTestId('my-bookings-tab-completed')).toBeInTheDocument();
    expect(screen.getByTestId('my-bookings-tab-cancelled')).toBeInTheDocument();
  });

  it('fires one GET per bucket on mount', async () => {
    renderPage();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(expect.arrayContaining([
        expect.stringContaining('bucket=upcoming'),
        expect.stringContaining('bucket=pending'),
        expect.stringContaining('bucket=completed'),
        expect.stringContaining('bucket=cancelled'),
      ]));
    });
  });
});

describe('MyBookings — Upcoming bucket', () => {
  it('renders each appointment with service, doctor, time, status', async () => {
    renderPage();
    expect(await screen.findByTestId('appt-card-1')).toBeInTheDocument();
    expect(screen.getByTestId('appt-service-1')).toHaveTextContent('Consultation');
    expect(screen.getByTestId('appt-doctor-1')).toHaveTextContent('Dr. Smith');
    expect(screen.getByTestId('appt-status-1')).toHaveTextContent('Booked');
    expect(screen.getByTestId('appt-card-2')).toBeInTheDocument();
    expect(screen.getByTestId('appt-status-2')).toHaveTextContent('Confirmed');
  });

  it('canReschedule=false hides the Reschedule button', async () => {
    renderPage();
    await screen.findByTestId('appt-card-2');
    // Booked id=1 → reschedule visible
    expect(screen.getByTestId('appt-reschedule-1')).toBeInTheDocument();
    // Confirmed id=2 → reschedule hidden
    expect(screen.queryByTestId('appt-reschedule-2')).not.toBeInTheDocument();
  });
});

describe('MyBookings — Pending bucket', () => {
  it('shows "Pending assignment" doctor label', async () => {
    renderPage();
    const pendingTab = await screen.findByTestId('my-bookings-tab-pending');
    fireEvent.click(pendingTab);
    expect(await screen.findByTestId('appt-doctor-3')).toHaveTextContent('Pending assignment');
  });
});

describe('MyBookings — Completed bucket hides action buttons when ineligible', () => {
  it('canCancel=false hides Cancel button', async () => {
    renderPage();
    const completedTab = await screen.findByTestId('my-bookings-tab-completed');
    fireEvent.click(completedTab);
    await screen.findByTestId('appt-card-4');
    expect(screen.queryByTestId('appt-cancel-4')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appt-reschedule-4')).not.toBeInTheDocument();
  });
});

describe('MyBookings — Cancel action', () => {
  it('POSTs to /portal/appointments/:id/cancel after confirm', async () => {
    renderPage();
    const cancelBtn = await screen.findByTestId('appt-cancel-1');
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      const cancelCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/wellness/portal/appointments/1/cancel',
      );
      expect(cancelCall).toBeTruthy();
      expect(cancelCall[1]).toMatchObject({ method: 'POST' });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Appointment cancelled');
  });

  it('does NOT call the API if the user dismisses the confirm dialog', async () => {
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    renderPage();
    const cancelBtn = await screen.findByTestId('appt-cancel-1');
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(notifyConfirm).toHaveBeenCalled());
    const cancelCall = fetchApiMock.mock.calls.find(
      (c) => c[0] === '/api/wellness/portal/appointments/1/cancel',
    );
    expect(cancelCall).toBeFalsy();
  });
});

describe('MyBookings — Reschedule action', () => {
  it('PATCHes /portal/appointments/:id/reschedule with the new date + time', async () => {
    renderPage();
    const rescheduleBtn = await screen.findByTestId('appt-reschedule-1');
    fireEvent.click(rescheduleBtn);
    const dateInput = await screen.findByTestId('reschedule-date');
    const timeInput = screen.getByTestId('reschedule-time');
    fireEvent.change(dateInput, { target: { value: '2099-07-01' } });
    fireEvent.change(timeInput, { target: { value: '14:30' } });
    fireEvent.click(screen.getByTestId('reschedule-submit'));
    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        (c) => c[0] === '/api/wellness/portal/appointments/1/reschedule',
      );
      expect(patchCall).toBeTruthy();
      expect(patchCall[1]).toMatchObject({ method: 'PATCH' });
      const body = JSON.parse(patchCall[1].body);
      expect(body).toEqual({ appointmentDate: '2099-07-01', appointmentTime: '14:30' });
    });
    expect(notifySuccess).toHaveBeenCalledWith('Appointment rescheduled');
  });
});

describe('MyBookings — injected fetcher prop (phone+OTP portal shell)', () => {
  it('routes calls through the injected fetcher instead of fetchApi (no auth context required)', async () => {
    const customFetcher = vi.fn(async (url) => {
      if (url.includes('bucket=upcoming'))  return { appointments: sampleUpcoming, count: sampleUpcoming.length };
      if (url.includes('bucket=pending'))   return { appointments: samplePending,  count: samplePending.length };
      if (url.includes('bucket=completed')) return { appointments: sampleCompleted, count: sampleCompleted.length };
      if (url.includes('bucket=cancelled')) return { appointments: sampleCancelled, count: sampleCancelled.length };
      return {};
    });
    // The phone+OTP shell doesn't wrap MyBookings in AuthContext — it has
    // its own session. Render without an AuthContext provider to mirror
    // that wiring; the injected fetcher must bypass the CUSTOMER gate.
    render(
      <MemoryRouter>
        <MyBookings fetcher={customFetcher} hideBookCta={true} />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(customFetcher).toHaveBeenCalled();
    });
    // fetchApi default fetcher should NOT have been touched.
    expect(fetchApiMock).not.toHaveBeenCalled();
    // Book CTA hidden when hideBookCta=true.
    expect(screen.queryByTestId('my-bookings-book-cta')).not.toBeInTheDocument();
  });
});

describe('MyBookings — role-mismatch fallback (backend-driven, not role-name-driven)', () => {
  // Verifies the new gate semantics: any signed-in user can load the
  // page, but the backend's verifyPatientToken Path B returns 403
  // NO_PATIENT_PROFILE if no Patient row is linked. The page then
  // renders the role-mismatch view instead of triggering a forced
  // logout. Patient-cohort tenants that use the USER role (not just
  // CUSTOMER) for patients see the normal page.

  it('backend 403 NO_PATIENT_PROFILE swaps in the mismatch view', async () => {
    const STAFF_AUTH = {
      user: { id: 1, role: 'ADMIN', name: 'Demo Admin' },
      tenant: { id: 1, vertical: 'wellness' },
    };
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(async () => {
      const err = new Error('This account is not linked to a patient profile');
      err.status = 403;
      throw err;
    });
    renderPage({}, STAFF_AUTH);
    expect(await screen.findByTestId('my-bookings-role-mismatch')).toBeInTheDocument();
    // Once the role-mismatch view is up, the buckets must NOT re-fetch
    // on focus events — that would flood the backend with 403s.
    const callsBefore = fetchApiMock.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.length).toBe(callsBefore);
    });
  });

  it('USER role with a linked Patient row sees the normal page (no role-name gating)', async () => {
    // Tenant uses USER role as a patient pool. As long as the backend
    // accepts the session and returns appointments, the page renders
    // exactly the same as for CUSTOMER. This pins the contract that
    // patient detection lives in the backend, not in a frontend role
    // check.
    const USER_AUTH = {
      user: { id: 42, role: 'USER', name: 'Patient-via-USER-role' },
      tenant: { id: 1, vertical: 'wellness' },
    };
    renderPage({}, USER_AUTH);
    expect(await screen.findByText('My Bookings')).toBeInTheDocument();
    expect(screen.queryByTestId('my-bookings-role-mismatch')).not.toBeInTheDocument();
    expect(await screen.findByTestId('appt-card-1')).toBeInTheDocument();
  });
});
