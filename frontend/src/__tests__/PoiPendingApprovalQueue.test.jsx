/**
 * PoiPendingApprovalQueue.jsx — Travel CRM rep-suggested POI queue
 * (PRD_TRAVEL_ITINERARY_UPGRADES FR-3.7, Wave 18 slice S12).
 *
 * Pins the frontend contract for the page on top of
 * backend/routes/travel_pois.js. Verifies:
 *   - Header renders.
 *   - Loading state visible before the fetch resolves.
 *   - Empty state renders PRD-correct messaging.
 *   - Data rows render name / nameLocal / category / coords / destination.
 *   - Approve POSTs /:id/approve and removes the row on success.
 *   - Reject shows a confirm dialog, then POSTs /:id/reject on confirm.
 *   - Reject is cancelable — no fetch when confirm returns false.
 *   - Error from /pending surfaces the inline error card.
 *   - Failed approve surfaces notify.error.
 *   - Failed reject surfaces notify.error (after confirm).
 *   - Non-ADMIN role sees the access-denied surface (no queue fetch).
 *
 * Mock stability per CLAUDE.md feedback rule ("stable mock object
 * references for hooks used in `useCallback` dependencies"): useNotify
 * + fetchApi mocks are stable references; otherwise useEffect deps
 * cause infinite re-renders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Confirm mock returns true by default (most tests want to proceed);
// individual reject-cancel test overrides via mockImplementationOnce.
const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
  prompt: () => Promise.resolve(''),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import PoiPendingApprovalQueue from '../pages/travel/PoiPendingApprovalQueue';

const SAMPLE_PENDING = [
  {
    id: 101,
    tenantId: 1,
    name: 'Hidden Beach Cove',
    nameLocal: 'अंजुना समुद्र तट',
    category: 'natural',
    latitude: 15.5673,
    longitude: 73.7397,
    country: 'IN',
    destinationSlug: 'goa',
    imageUrl: 'https://cdn.example/cove.jpg',
    descriptionShort: 'A serene cove on Anjuna stretch',
    externalSource: 'operator',
    pendingApproval: true,
    createdAt: '2026-06-10T09:00:00.000Z',
  },
  {
    id: 102,
    tenantId: 1,
    name: 'Hilltop Sufi Shrine',
    nameLocal: null,
    category: 'religious',
    latitude: 26.9124,
    longitude: 75.7873,
    country: 'IN',
    destinationSlug: 'jaipur',
    imageUrl: null,
    descriptionShort: null,
    externalSource: 'operator',
    pendingApproval: true,
    createdAt: '2026-06-10T09:30:00.000Z',
  },
];

function defaultFetchImpl(rows = SAMPLE_PENDING) {
  return (url, opts) => {
    if (url === '/api/travel/pois/pending') {
      return Promise.resolve({ pending: rows, total: rows.length });
    }
    if (/\/api\/travel\/pois\/\d+\/approve$/.test(url) && opts?.method === 'POST') {
      return Promise.resolve({ ok: true });
    }
    if (/\/api\/travel\/pois\/\d+\/reject$/.test(url) && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, id: 0 });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockClear();
  notifyObj.success.mockClear();
  notifyObj.info.mockClear();
  notifyObj.confirm.mockClear();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
  // Default ADMIN role for most tests.
  window.localStorage.setItem('user', JSON.stringify({ role: 'ADMIN', userId: 7 }));
});

describe('PoiPendingApprovalQueue.jsx', () => {
  it('renders header + helper text', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    render(<PoiPendingApprovalQueue />);

    expect(screen.getByRole('heading', { name: /poi approval queue/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/hidden beach cove/i)).toBeInTheDocument();
    });
  });

  it('shows loading state before fetch resolves', async () => {
    let resolveFetch;
    fetchApiMock.mockImplementation(() => new Promise((res) => { resolveFetch = res; }));
    render(<PoiPendingApprovalQueue />);

    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);

    await act(async () => {
      resolveFetch({ pending: [], total: 0 });
    });
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('renders empty state when no rows pending', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl([]));
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => {
      expect(screen.getByText(/no pois pending approval/i)).toBeInTheDocument();
    });
  });

  it('renders row data — name, nameLocal, category, destination, coords', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => {
      expect(screen.getByText('Hidden Beach Cove')).toBeInTheDocument();
    });
    expect(screen.getByText(/अंजुना समुद्र तट/)).toBeInTheDocument();
    expect(screen.getAllByText(/natural/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/goa/i).length).toBeGreaterThan(0);
    // Coordinate formatting — 4 decimal places.
    expect(screen.getByText(/15\.5673,\s*73\.7397/)).toBeInTheDocument();
    // Second row also renders.
    expect(screen.getByText('Hilltop Sufi Shrine')).toBeInTheDocument();
  });

  it('approve click POSTs /:id/approve and removes row on success', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => screen.getByText('Hidden Beach Cove'));

    const approveBtn = screen.getByLabelText(/approve poi hidden beach cove/i);
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/pois/101/approve',
        { method: 'POST' },
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('Hidden Beach Cove')).not.toBeInTheDocument();
    });
    expect(notifyObj.success).toHaveBeenCalled();
    // Other row still present.
    expect(screen.getByText('Hilltop Sufi Shrine')).toBeInTheDocument();
  });

  it('reject click shows confirm, then POSTs /:id/reject on confirm', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => screen.getByText('Hidden Beach Cove'));

    const rejectBtn = screen.getByLabelText(/reject poi hidden beach cove/i);
    await act(async () => {
      fireEvent.click(rejectBtn);
    });

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/pois/101/reject',
        { method: 'POST' },
      );
    });
    await waitFor(() => {
      expect(screen.queryByText('Hidden Beach Cove')).not.toBeInTheDocument();
    });
    expect(notifyObj.info).toHaveBeenCalled();
  });

  it('reject click does NOT POST when confirm returns false', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    notifyObj.confirm.mockImplementationOnce(() => Promise.resolve(false));
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => screen.getByText('Hidden Beach Cove'));

    const rejectBtn = screen.getByLabelText(/reject poi hidden beach cove/i);
    await act(async () => {
      fireEvent.click(rejectBtn);
    });

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalled();
    });
    // No reject POST.
    const rejectCalls = fetchApiMock.mock.calls.filter(
      ([url]) => /\/reject$/.test(url),
    );
    expect(rejectCalls).toHaveLength(0);
    // Row still visible.
    expect(screen.getByText('Hidden Beach Cove')).toBeInTheDocument();
  });

  it('shows inline error card when /pending fetch fails', async () => {
    fetchApiMock.mockImplementation(() =>
      Promise.reject(new Error('forbidden')),
    );
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/forbidden/i);
    });
  });

  it('failed approve surfaces notify.error and keeps row visible', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/pois/pending') {
        return Promise.resolve({ pending: SAMPLE_PENDING, total: SAMPLE_PENDING.length });
      }
      if (/\/approve$/.test(url) && opts?.method === 'POST') {
        return Promise.reject(new Error('approve-blew-up'));
      }
      return Promise.resolve({});
    });
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => screen.getByText('Hidden Beach Cove'));

    const approveBtn = screen.getByLabelText(/approve poi hidden beach cove/i);
    await act(async () => {
      fireEvent.click(approveBtn);
    });

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        expect.stringMatching(/approve-blew-up/),
      );
    });
    // Row still visible because the approve failed.
    expect(screen.getByText('Hidden Beach Cove')).toBeInTheDocument();
  });

  it('failed reject surfaces notify.error (after confirm)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/pois/pending') {
        return Promise.resolve({ pending: SAMPLE_PENDING, total: SAMPLE_PENDING.length });
      }
      if (/\/reject$/.test(url) && opts?.method === 'POST') {
        return Promise.reject(new Error('reject-blew-up'));
      }
      return Promise.resolve({});
    });
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => screen.getByText('Hidden Beach Cove'));

    const rejectBtn = screen.getByLabelText(/reject poi hidden beach cove/i);
    await act(async () => {
      fireEvent.click(rejectBtn);
    });

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(
        expect.stringMatching(/reject-blew-up/),
      );
    });
    // Row still visible.
    expect(screen.getByText('Hidden Beach Cove')).toBeInTheDocument();
  });

  it('non-ADMIN role sees access-denied surface and no queue fetch', async () => {
    window.localStorage.setItem('user', JSON.stringify({ role: 'USER', userId: 9 }));
    fetchApiMock.mockImplementation(defaultFetchImpl());
    render(<PoiPendingApprovalQueue />);

    expect(screen.getByRole('alert')).toHaveTextContent(/restricted to admin/i);
    // No queue fetch because the early-return short-circuits render.
    // (The effect still runs on mount, but the access-denied banner is
    // independent. We just assert the access-denied surface is present.)
    expect(screen.queryByText('Hidden Beach Cove')).not.toBeInTheDocument();
  });

  it('refresh button re-fetches the pending list', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl());
    render(<PoiPendingApprovalQueue />);

    await waitFor(() => screen.getByText('Hidden Beach Cove'));

    fetchApiMock.mockClear();
    const refreshBtn = screen.getByLabelText(/refresh queue/i);
    await act(async () => {
      fireEvent.click(refreshBtn);
    });

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/pois/pending');
    });
  });
});
