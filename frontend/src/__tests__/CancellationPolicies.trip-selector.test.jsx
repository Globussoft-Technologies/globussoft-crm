/**
 * CancellationPolicies.trip-selector.test.jsx ? focused coverage for the new
 * itinerary picker on the travel cancellation-policy form.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: notifyInfo,
    confirm: notifyConfirm,
  }),
}));

import { AuthContext } from '../App';
import CancellationPolicies from '../pages/travel/CancellationPolicies';

const USER = { userId: 1, name: 'Admin', email: 'admin@test.local', role: 'ADMIN' };

const POLICIES = {
  policies: [
    {
      id: 401,
      tenantId: 1,
      name: 'TMC Default',
      subBrand: 'tmc',
      itineraryId: 11,
      itinerary: {
        id: 11,
        destination: 'Goa',
        subBrand: 'tmc',
        status: 'confirmed',
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-07T00:00:00.000Z',
      },
      tiersJson: JSON.stringify([
        { daysBeforeServiceStart: 60, refundPercent: 100 },
        { daysBeforeServiceStart: 30, refundPercent: 50 },
        { daysBeforeServiceStart: 7, refundPercent: 25 },
        { daysBeforeServiceStart: 0, refundPercent: 0 },
      ]),
      isActive: true,
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

const ITINERARIES = {
  tmc: {
    itineraries: [
      {
        id: 11,
        destination: 'Goa',
        subBrand: 'tmc',
        status: 'confirmed',
        startDate: '2026-08-01T00:00:00.000Z',
        endDate: '2026-08-07T00:00:00.000Z',
      },
    ],
    total: 1,
    limit: 200,
    offset: 0,
  },
  rfu: {
    itineraries: [
      {
        id: 22,
        destination: 'Makkah',
        subBrand: 'rfu',
        status: 'draft',
        startDate: '2026-09-01T00:00:00.000Z',
        endDate: '2026-09-10T00:00:00.000Z',
      },
    ],
    total: 1,
    limit: 200,
    offset: 0,
  },
};


function installFetchMock() {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (method === 'GET' && typeof url === 'string' && url.startsWith('/api/travel/cancellation-policies')) {
      return Promise.resolve(POLICIES);
    }
    if (method === 'GET' && typeof url === 'string' && url.startsWith('/api/travel/itineraries')) {
      const parsed = new URL(url, 'http://local.test');
      const subBrand = parsed.searchParams.get('subBrand') || 'tmc';
      return Promise.resolve(ITINERARIES[subBrand] || { itineraries: [], total: 0, limit: 200, offset: 0 });
    }
    if (method === 'POST' && url === '/api/travel/cancellation-policies') {
      return Promise.resolve({ id: 999 });
    }
    if (method === 'PATCH') {
      return Promise.resolve({ id: 401 });
    }
    if (method === 'DELETE') {
      return Promise.resolve(null);
    }
    return Promise.resolve(null);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: USER, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <CancellationPolicies />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  installFetchMock();
});

describe('CancellationPolicies trip selector', () => {
  it('loads itineraries filtered by the selected sub-brand', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    expect(await screen.findByLabelText(/^Trip$/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Goa/i })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/^Sub-brand$/i), {
      target: { value: 'rfu' },
    });

    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(
          ([url]) => typeof url === 'string' && url.includes('/api/travel/itineraries?') && url.includes('subBrand=rfu'),
        ),
      ).toBe(true);
    });
    expect(within(screen.getByLabelText(/^Trip$/i)).getByRole('option', { name: /Makkah - 2026-09-01 to 2026-09-10/i })).toBeInTheDocument();
  });

  it('defaults a new policy to the selected page filter', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.change(screen.getByLabelText(/^Filter by sub-brand$/i), {
      target: { value: 'travelstall' },
    });

    await waitFor(() => {
      expect(
        fetchApiMock.mock.calls.some(
          ([url]) => typeof url === 'string' && url.includes('/api/travel/cancellation-policies?') && url.includes('subBrand=travelstall'),
        ),
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    const tripSelect = screen.getByLabelText(/^Trip$/i);
    expect(screen.getByLabelText(/^Sub-brand$/i).value).toBe('travelstall');
    await waitFor(() => {
      expect(within(tripSelect).getAllByRole('option')).toHaveLength(1);
    });
    expect(within(tripSelect).getByRole('option', { name: /No trip selected/i })).toBeInTheDocument();
  });
  it('renders cleaner trip labels', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));

    expect(await screen.findByLabelText(/^Trip$/i)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Goa - 2026-08-01 to 2026-08-07/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Goa - 2026-08-01 to 2026-08-07/i }).textContent).not.toMatch(/Sent/i);
  });
  it('persists the selected itineraryId when saving a policy', async () => {
    renderPage();
    await screen.findByText('TMC Default');
    fireEvent.click(screen.getByRole('button', { name: /New Policy/i }));
    await screen.findByLabelText(/^Trip$/i);
    fireEvent.change(screen.getByLabelText(/^Policy name$/i), {
      target: { value: 'Goa Trip Policy' },
    });
    fireEvent.change(screen.getByLabelText(/^Trip$/i), {
      target: { value: '11' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/travel/cancellation-policies' && opts?.method === 'POST',
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.itineraryId).toBe(11);
      expect(body.subBrand).toBe('tmc');
    });
  });
});
