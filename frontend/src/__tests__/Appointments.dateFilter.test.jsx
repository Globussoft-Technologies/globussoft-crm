/**
 * Clearing a date bound on the Appointments list.
 *
 * The page defaults From/To to today→+7d. Clearing a box means "no bound", but
 * the query was built unconditionally, so an empty input produced
 *
 *     from=T00:00:00+05:30
 *
 * which the route handed to `new Date()`. That is an Invalid Date, Prisma
 * throws on it, and the page answered with "Something went wrong on our end"
 * plus an empty table — instead of the all-time list the user was asking for.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), success: vi.fn(), info: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

vi.mock('../pages/wellness/Calendar', () => ({
  AssignDoctorModal: () => null,
  displayStatus: (visit) =>
    !visit?.doctorId && visit?.status === 'booked' ? 'pending' : visit?.status,
}));
vi.mock('../components/CallifiedCallDialog', () => ({ default: () => null }));

import { AuthContext } from '../App';
import Appointments from '../pages/wellness/Appointments';

const VISIT = {
  id: 900,
  visitDate: '2026-08-28T10:00:00.000Z',
  status: 'completed',
  doctorId: 7,
  patient: { id: 5, name: 'Mohit das', phone: '+916200039874' },
  service: { id: 11, name: 'Basic FUE' },
  doctor: { id: 7, name: 'Rupal Sharma' },
  treatmentPlan: null,
};

function payload(visits = [VISIT]) {
  return {
    visits,
    pagination: { total: visits.length, page: 1, limit: 25, offset: 0, pages: 1, hasPrev: false, hasNext: false },
  };
}

function visitUrls() {
  return fetchApiMock.mock.calls
    .map(([u]) => u)
    .filter((u) => typeof u === 'string' && u.startsWith('/api/wellness/visits'));
}

function renderPage() {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url === 'string' && url.startsWith('/api/wellness/visits')) {
      return Promise.resolve(payload());
    }
    if (url === '/api/staff') return Promise.resolve([]);
    return Promise.resolve({});
  });
  return render(
    <AuthContext.Provider value={{ user: { role: 'ADMIN' }, tenant: { name: 'Clinic' } }}>
      <MemoryRouter><Appointments /></MemoryRouter>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  // jsdom has no Element.scrollTo; the table resets its scroll on every reload.
  Element.prototype.scrollTo = vi.fn();
});

describe('<Appointments /> — clearing a date bound', () => {
  it('sends both bounds while the defaults are in place', async () => {
    renderPage();
    await waitFor(() => expect(visitUrls().length).toBeGreaterThan(0));

    const first = visitUrls()[0];
    expect(first).toContain('from=');
    expect(first).toContain('to=');
  });

  it('omits `from` entirely once the From box is cleared', async () => {
    renderPage();
    await waitFor(() => expect(visitUrls().length).toBeGreaterThan(0));
    const before = visitUrls().length;

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '' } });

    await waitFor(() => expect(visitUrls().length).toBeGreaterThan(before));
    const latest = visitUrls().at(-1);
    expect(latest).not.toContain('from=');
    // Never the malformed bound that produced the 500.
    expect(latest).not.toContain('T00%3A00%3A00');
    expect(latest).toContain('to=');
  });

  it('omits `to` once the To box is cleared', async () => {
    renderPage();
    await waitFor(() => expect(visitUrls().length).toBeGreaterThan(0));
    const before = visitUrls().length;

    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '' } });

    await waitFor(() => expect(visitUrls().length).toBeGreaterThan(before));
    const latest = visitUrls().at(-1);
    expect(latest).not.toContain('to=');
    expect(latest).toContain('from=');
  });

  it('asks for the all-time list when both bounds are cleared', async () => {
    renderPage();
    await waitFor(() => expect(visitUrls().length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '' } });

    await waitFor(() => {
      const latest = visitUrls().at(-1);
      expect(latest).not.toContain('from=');
      expect(latest).not.toContain('to=');
    });
    // Still a real query — pagination and the rest survive.
    expect(visitUrls().at(-1)).toContain('paginate=true');
  });

  it('shows the rows rather than an error once the bounds are cleared', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/^from$/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: '' } });

    await waitFor(() => expect(screen.getByText('Basic FUE')).toBeInTheDocument());
    expect(screen.queryByText(/Something went wrong on our end/i)).not.toBeInTheDocument();
  });
});
