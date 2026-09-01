/**
 * Requesting and answering a session out of a bought package.
 *
 * Two properties carry the whole flow and neither is cosmetic:
 *
 *   1. A request is NOT a booking. The customer picks a preferred date; the
 *      clinic assigns the practitioner and confirms the slot. A customer who
 *      believes they hold a slot and turns up is a worse failure than one who
 *      waits for a confirmation, so the modal has to say so.
 *   2. Accepting spends nothing. The session comes off the package when the
 *      visit is completed — a declined request or a no-show costs the patient
 *      nothing.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import RequestSessionModal from '../pages/wellness/services/RequestSessionModal';
import SessionRequestsPanel from '../pages/wellness/services/SessionRequestsPanel';

/**
 * A `datetime-local` value that is still in the future when the suite runs.
 *
 * The accept form validates against the real clock, so any datetime written
 * into the file becomes a failing test the moment it passes — which is exactly
 * how this suite broke overnight once already.
 */
function futureDate(daysFromNow = 2) {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The same instant as an ISO string, for a fixture the server would send. */
function futureIso(daysFromNow = 2) {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}

function futureSlot(daysFromNow = 2) {
  const d = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:30`;
}

const OWNED_PACKAGE = {
  id: 3,
  name: 'Strict removal',
  ownedPlan: {
    id: 1436,
    status: 'active',
    totalSessions: 4,
    completedSessions: 1,
    startedAt: '2026-08-26T13:00:00.000Z',
    nextDueAt: '2099-09-02T13:00:00.000Z',
  },
};

const PENDING_REQUEST = {
  id: 900,
  // Derived: the accept form refuses a slot in the past, so a fixed date turns
  // this whole queue red the moment it goes by.
  visitDate: futureIso(3),
  reason: 'mornings work best',
  patient: { id: 5, name: 'Mohit das', phone: '+91-9000011111' },
  service: { id: 10, name: 'Abdomen - Stretch Marks' },
  treatmentPlan: { id: 1436, name: 'Strict removal', totalSessions: 4, completedSessions: 1, nextDueAt: null },
};

beforeEach(() => {
  fetchApiMock.mockReset().mockResolvedValue({});
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<RequestSessionModal />', () => {
  it('sends the preferred date and note, and never a practitioner', async () => {
    // Who takes the session is the clinic's call — a doctor sent from the
    // client would be a patient assigning their own practitioner.
    const user = userEvent.setup();
    const onRequested = vi.fn();
    const onClose = vi.fn();
    render(<RequestSessionModal pkg={OWNED_PACKAGE} onClose={onClose} onRequested={onRequested} />);

    const asked = futureDate(3);
    fireEvent.change(screen.getByTestId('session-preferred-date'), { target: { value: asked } });
    await user.type(screen.getByTestId('session-note'), 'mornings work best');
    await user.click(screen.getByTestId('session-request-submit'));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    const [url, opts] = fetchApiMock.mock.calls[0];
    expect(url).toBe('/api/wellness/packages/plans/1436/request-session');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ preferredDate: asked, note: 'mornings work best' });
    expect(body.doctorId).toBeUndefined();

    await waitFor(() => expect(onRequested).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('says plainly that this is a request, not a confirmed slot', async () => {
    render(<RequestSessionModal pkg={OWNED_PACKAGE} onClose={vi.fn()} onRequested={vi.fn()} />);

    expect(screen.getByText(/not a confirmed slot/i)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is deducted from your package until the session actually happens/i))
      .toBeInTheDocument();
    expect(screen.getByText(/3 of 4 sessions left/i)).toBeInTheDocument();
  });

  it('limits the picker to today through the package validity date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00+05:30'));
    render(<RequestSessionModal pkg={OWNED_PACKAGE} onClose={vi.fn()} onRequested={vi.fn()} />);

    expect(screen.getByTestId('session-preferred-date')).toHaveAttribute('min', '2026-08-27');
    expect(screen.getByTestId('session-preferred-date')).toHaveAttribute('max', '2099-09-02');
    expect(screen.getByText(/Package valid till/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('sends the request with no date at all when none is picked', async () => {
    const user = userEvent.setup();
    render(<RequestSessionModal pkg={OWNED_PACKAGE} onClose={vi.fn()} onRequested={vi.fn()} />);

    await user.click(screen.getByTestId('session-request-submit'));

    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchApiMock.mock.calls[0][1].body)).toEqual({ preferredDate: null, note: null });
  });

  it('keeps the modal open and reports why when the request is refused', async () => {
    // e.g. the package lapsed between loading the page and clicking.
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchApiMock.mockRejectedValueOnce(new Error('The window to use this package has passed'));
    render(<RequestSessionModal pkg={OWNED_PACKAGE} onClose={onClose} onRequested={vi.fn()} />);

    await user.click(screen.getByTestId('session-request-submit'));

    await waitFor(() => expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/window to use this package/i)));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refuses a preferred date in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00+05:30'));
    render(<RequestSessionModal pkg={OWNED_PACKAGE} onClose={vi.fn()} onRequested={vi.fn()} />);

    fireEvent.change(screen.getByTestId('session-preferred-date'), { target: { value: '2026-08-26' } });
    fireEvent.click(screen.getByTestId('session-request-submit'));

    expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/cannot be in the past/i));
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('refuses a preferred date after the package validity window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-27T12:00:00+05:30'));
    const pkg = {
      ...OWNED_PACKAGE,
      ownedPlan: { ...OWNED_PACKAGE.ownedPlan, nextDueAt: '2026-09-03T13:00:00.000Z' },
    };
    render(<RequestSessionModal pkg={pkg} onClose={vi.fn()} onRequested={vi.fn()} />);

    fireEvent.change(screen.getByTestId('session-preferred-date'), { target: { value: '2026-09-04' } });
    fireEvent.click(screen.getByTestId('session-request-submit'));

    expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/must be on or before 2026-09-03/i));
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});

describe('<SessionRequestsPanel />', () => {
  const doctors = [{ id: 12, name: 'Dr Harsh' }, { id: 13, name: 'Dr Meera' }];

  const renderWithQueue = (requests = [PENDING_REQUEST]) => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/wellness/packages/session-requests') return Promise.resolve({ requests });
      return Promise.resolve({});
    });
    return render(<SessionRequestsPanel doctors={doctors} onHandled={vi.fn()} />);
  };

  it('shows who is waiting, for what, and how much of their package is left', async () => {
    renderWithQueue();

    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());
    const card = within(screen.getByTestId('session-request-900'));
    expect(card.getByText('Mohit das')).toBeInTheDocument();
    expect(card.getByText(/Strict removal · 3 of 4 sessions left/i)).toBeInTheDocument();
    expect(card.getByText(/mornings work best/i)).toBeInTheDocument();
  });

  it('prefills the slot with the date the patient asked for', async () => {
    // The card already says "Asked for 1 Sep"; making staff retype it into the
    // slot field is how a confirmed time ends up different from the requested
    // one. The input is a wall clock, so the stored UTC has to be converted to
    // the viewer's own — slicing the ISO string would shift it by the offset.
    renderWithQueue();
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    const asked = new Date(PENDING_REQUEST.visitDate);
    const pad = (n) => String(n).padStart(2, '0');
    const expected = `${asked.getFullYear()}-${pad(asked.getMonth() + 1)}-${pad(asked.getDate())}T${pad(asked.getHours())}:${pad(asked.getMinutes())}`;

    expect(screen.getByTestId('session-request-900')).toBeInTheDocument();
    expect(screen.getByTestId('session-request-date-900')).toHaveValue(expected);
  });

  it('accepts the prefilled slot as-is when staff only pick a practitioner', async () => {
    const user = userEvent.setup();
    renderWithQueue();
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    const prefilled = screen.getByTestId('session-request-date-900').value;
    expect(prefilled).not.toBe('');

    await user.click(within(screen.getByTestId('session-request-doctor-900')).getByRole('button'));
    await user.click(await screen.findByRole('option', { name: 'Dr Meera' }));
    await user.click(screen.getByTestId('session-request-accept-900'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => url.endsWith('/session-requests/900/accept'));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ doctorId: '13', visitDate: prefilled });
    });
  });

  it('refuses to accept until a practitioner is chosen', async () => {
    // "Accepted" with nobody assigned is a booking with no one to take it.
    const user = userEvent.setup();
    renderWithQueue();
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    await user.click(screen.getByTestId('session-request-accept-900'));

    expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/who is taking this session/i));
    const accepts = fetchApiMock.mock.calls.filter(([url]) => /\/accept$/.test(url));
    expect(accepts).toHaveLength(0);
  });

  it('accepts with the chosen practitioner and slot', async () => {
    // Derived, never written down: the panel refuses a slot in the past, so a
    // hard-coded datetime silently turns this test red the day it goes by.
    const slot = futureSlot(2);
    const user = userEvent.setup();
    renderWithQueue();
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    await user.click(within(screen.getByTestId('session-request-doctor-900')).getByRole('button'));
    await user.click(await screen.findByRole('option', { name: 'Dr Harsh' }));
    fireEvent.change(screen.getByTestId('session-request-date-900'), { target: { value: slot } });
    await user.click(screen.getByTestId('session-request-accept-900'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => url.endsWith('/session-requests/900/accept'));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toEqual({ doctorId: '12', visitDate: slot });
    });
  });

  it('refuses to confirm a slot that has already passed', async () => {
    // The field is pre-filled with the date the patient asked for. Requests
    // sit in this queue, so by the time someone answers, that date may be
    // behind us — accepting it as-is books a session nobody can attend.
    const user = userEvent.setup();
    renderWithQueue([{ ...PENDING_REQUEST, visitDate: '2020-01-01T10:00:00.000Z' }]);
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    await user.click(within(screen.getByTestId('session-request-doctor-900')).getByRole('button'));
    await user.click(await screen.findByRole('option', { name: 'Dr Harsh' }));
    await user.click(screen.getByTestId('session-request-accept-900'));

    expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/already passed/i));
    expect(fetchApiMock.mock.calls.some(([url]) => url.endsWith('/accept'))).toBe(false);
  });

  it('accepts once a future slot is chosen instead', async () => {
    const user = userEvent.setup();
    renderWithQueue([{ ...PENDING_REQUEST, visitDate: '2020-01-01T10:00:00.000Z' }]);
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    await user.click(within(screen.getByTestId('session-request-doctor-900')).getByRole('button'));
    await user.click(await screen.findByRole('option', { name: 'Dr Harsh' }));
    fireEvent.change(screen.getByTestId('session-request-date-900'), { target: { value: '2099-01-01T10:30' } });
    await user.click(screen.getByTestId('session-request-accept-900'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => url.endsWith('/accept'));
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body).visitDate).toBe('2099-01-01T10:30');
    });
  });

  it('stops the picker offering past times at all', async () => {
    renderWithQueue();
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    const min = screen.getByTestId('session-request-date-900').getAttribute('min');
    expect(min).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(min).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('declining keeps the session on the patient package', async () => {
    const user = userEvent.setup();
    renderWithQueue();
    await waitFor(() => expect(screen.getByTestId('session-request-900')).toBeInTheDocument());

    await user.click(screen.getByTestId('session-request-decline-900'));

    await waitFor(() => {
      expect(fetchApiMock.mock.calls.some(([url]) => url.endsWith('/session-requests/900/decline'))).toBe(true);
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/stays on their package/i));
  });

  it('renders nothing at all when no one is waiting', async () => {
    renderWithQueue([]);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wellness/packages/session-requests', expect.anything());
    });
    expect(screen.queryByTestId('session-requests-panel')).not.toBeInTheDocument();
  });
});
