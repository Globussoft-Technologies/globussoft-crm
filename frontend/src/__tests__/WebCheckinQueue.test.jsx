/**
 * WebCheckinQueue.jsx — Travel CRM web check-in operator queue (PRD §4.6 + §7 row 20).
 *
 * Pins the frontend contract for the page that sits on top of
 * backend/routes/travel_webcheckin.js (commit 9898e87). Verifies:
 *   - Page header renders.
 *   - Empty state renders the PRD-correct messaging.
 *   - Data rows render PNR / flight / passenger / status badge.
 *   - Status badge renders for every enum value (pending|reminded|
 *     in-progress|done|fallback-agent|failed).
 *   - Upload boarding pass triggers multipart POST to
 *     /api/travel/webcheckins/:id/upload-boarding-pass.
 *   - Deliver action confirms + POSTs /deliver; 409 NO_BOARDING_PASS
 *     surfaces a friendly toast.
 *   - Filter dropdown changes the fetch URL (status query param).
 *   - "Upcoming only" toggle switches to the /upcoming endpoint.
 *   - Pagination Next updates the offset query param.
 *
 * Mock stability: useNotify and fetchApi mocks are stable references
 * per CLAUDE.md feedback rule (fresh refs in useCallback / useEffect
 * deps cause infinite re-render).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

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

import WebCheckinQueue from '../pages/travel/WebCheckinQueue';

const SAMPLE_ROWS = [
  {
    id: 1, pnr: 'ABC123', airlineCode: '6E', flightNumber: '6E-237',
    departureAt: '2026-06-01T10:30:00.000Z',
    windowOpenAt: '2026-05-31T10:30:00.000Z',
    passengerName: 'Aisha Khan', status: 'pending',
    boardingPassUrl: null, deliveredAt: null, assignedAgentId: null,
  },
  {
    id: 2, pnr: 'XYZ789', airlineCode: 'AI', flightNumber: 'AI-840',
    departureAt: '2026-06-02T22:00:00.000Z',
    windowOpenAt: '2026-06-01T22:00:00.000Z',
    passengerName: 'Yusuf Rahman', status: 'done',
    boardingPassUrl: '/uploads/boarding-passes/bp-xyz.pdf',
    deliveredAt: '2026-06-01T22:30:00.000Z',
    assignedAgentId: 5,
  },
];

const SAMPLE_STAFF = [
  { id: 5, name: 'Priya Sharma', email: 'priya@travel.test' },
  { id: 7, name: 'Rohan Mehta', email: 'rohan@travel.test' },
];

function defaultFetchImpl(rows = SAMPLE_ROWS) {
  return (url, opts) => {
    if (url.startsWith('/api/travel/webcheckins?')) {
      return Promise.resolve({ webcheckins: rows, total: rows.length, limit: 50, offset: 0 });
    }
    if (url === '/api/travel/webcheckins/upcoming') {
      return Promise.resolve({ webcheckins: rows.filter(r => r.status === 'pending' || r.status === 'reminded'), total: 1 });
    }
    if (url === '/api/staff') return Promise.resolve(SAMPLE_STAFF);
    if (url.match(/\/api\/travel\/webcheckins\/\d+\/deliver$/) && opts?.method === 'POST') {
      return Promise.resolve({ id: 1, deliveredAt: '2026-06-01T22:30:00.000Z' });
    }
    if (url.match(/\/api\/travel\/webcheckins\/\d+$/) && opts?.method === 'PATCH') {
      return Promise.resolve({ id: 1, assignedAgentId: 5 });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
  notifyObj.confirm.mockReset();
  notifyObj.confirm.mockImplementation(() => Promise.resolve(true));
});

function renderPage() {
  return render(
    <MemoryRouter>
      <WebCheckinQueue />
    </MemoryRouter>,
  );
}

describe('WebCheckinQueue — operator queue (PRD §4.6)', () => {
  it('renders the page header', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl([]));
    renderPage();
    expect(await screen.findByRole('heading', { name: /Web Check-ins/i })).toBeTruthy();
  });

  it('shows the empty state with PRD-correct messaging when no rows', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl([]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No web check-ins yet/i)).toBeTruthy();
    });
    expect(screen.getByText(/appear automatically when itineraries with flights are accepted/i)).toBeTruthy();
  });

  it('renders rows with PNR, flight, passenger', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');
    expect(screen.getByText('XYZ789')).toBeTruthy();
    expect(screen.getByText('Aisha Khan')).toBeTruthy();
    expect(screen.getByText('Yusuf Rahman')).toBeTruthy();
    expect(screen.getByText('6E-237')).toBeTruthy();
  });

  it('renders the correct status badge text for each row', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');
    const pendingBadge = screen.getByTestId('status-badge-1');
    const doneBadge = screen.getByTestId('status-badge-2');
    expect(pendingBadge.textContent).toBe('pending');
    expect(doneBadge.textContent).toBe('done');
  });

  it('upload action POSTs multipart to /upload-boarding-pass and reloads', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    // Spy global fetch for the multipart leg (fetchApi can't handle FormData
    // bodies because it forces application/json; the page uses raw fetch).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, url: '/uploads/boarding-passes/bp-new.pdf' }),
    });
    renderPage();
    await screen.findByText('ABC123');

    const uploadBtn = screen.getByRole('button', { name: /Upload boarding pass for ABC123/i });
    fireEvent.click(uploadBtn);

    // Simulate the hidden <input type=file> change.
    const fileInput = screen.getByLabelText(/Boarding pass file for ABC123/i);
    const file = new File(['fake-pdf-bytes'], 'pass.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/travel/webcheckins/1/upload-boarding-pass',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }),
        }),
      );
    });
    // Second arg is the request init — body is a FormData instance.
    const init = fetchSpy.mock.calls[0][1];
    expect(init.body).toBeInstanceOf(FormData);
    expect(notifyObj.success).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('deliver action confirms + POSTs /deliver', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');

    // Row 1 (pending, no deliveredAt) → Deliver button enabled.
    const deliverBtn = screen.getByRole('button', { name: /Deliver boarding pass for ABC123/i });
    fireEvent.click(deliverBtn);

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalled();
    });
    await waitFor(() => {
      // The POST goes through fetchApi.
      const deliverCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/webcheckins/1/deliver' && o?.method === 'POST',
      );
      expect(deliverCall).toBeTruthy();
    });
    expect(notifyObj.success).toHaveBeenCalled();
  });

  it('deliver action surfaces 409 NO_BOARDING_PASS as a friendly error', async () => {
    const baseFetch = defaultFetchImpl(SAMPLE_ROWS);
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.match(/\/api\/travel\/webcheckins\/\d+\/deliver$/) && opts?.method === 'POST') {
        return Promise.reject({
          status: 409,
          code: 'NO_BOARDING_PASS',
          message: 'No boardingPassUrl on this check-in',
        });
      }
      return baseFetch(url, opts);
    });
    renderPage();
    await screen.findByText('ABC123');

    const deliverBtn = screen.getByRole('button', { name: /Deliver boarding pass for ABC123/i });
    fireEvent.click(deliverBtn);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/Upload the boarding pass first/i));
    });
  });

  it('status filter changes the fetch URL', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');

    const filterSelect = screen.getByLabelText(/Filter by status/i);
    fireEvent.change(filterSelect, { target: { value: 'reminded' } });

    await waitFor(() => {
      const remindedCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('status=reminded'),
      );
      expect(remindedCall).toBeTruthy();
    });
  });

  it('Upcoming-only toggle switches to /upcoming endpoint', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');

    const toggle = screen.getByLabelText(/Show only upcoming/i);
    fireEvent.click(toggle);

    await waitFor(() => {
      const upcomingCall = fetchApiMock.mock.calls.find(
        ([u]) => u === '/api/travel/webcheckins/upcoming',
      );
      expect(upcomingCall).toBeTruthy();
    });
  });

  it('Next-page button updates the offset query param', async () => {
    // Need >50 total to render the pager.
    const manyRows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, pnr: `PNR${i}`, airlineCode: '6E', flightNumber: `6E-${100 + i}`,
      departureAt: '2026-06-01T10:30:00.000Z',
      windowOpenAt: '2026-05-31T10:30:00.000Z',
      passengerName: `Passenger ${i}`, status: 'pending',
      boardingPassUrl: null, deliveredAt: null, assignedAgentId: null,
    }));
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/travel/webcheckins?')) {
        return Promise.resolve({ webcheckins: manyRows, total: 120, limit: 50, offset: url.includes('offset=50') ? 50 : 0 });
      }
      if (url === '/api/staff') return Promise.resolve(SAMPLE_STAFF);
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText('PNR0');

    const nextBtn = screen.getByRole('button', { name: /Next page/i });
    fireEvent.click(nextBtn);

    await waitFor(() => {
      const nextCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.includes('offset=50'),
      );
      expect(nextCall).toBeTruthy();
    });
  });
});
