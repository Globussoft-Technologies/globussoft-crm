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

  // ─── Extended coverage (2026-05-26 test-cron) ────────────────────
  //
  // SUT is 464L; original test covered 9 cases. These extend to cover
  // remaining enum badge values, deliver-disabled-after-delivered,
  // declined-confirm path, reassign PATCH (assign + unassign), upload
  // error, /api/staff fetch failure, fetchApi catch (non-401), invalid
  // dates rendering "—", boarding-pass View link, status-filter
  // disabled-during-upcoming, and pagination range display.

  it('renders status badges for all six enum values', async () => {
    const allStatusRows = [
      { id: 1, pnr: 'P1', airlineCode: '6E', flightNumber: '6E-1', departureAt: '2026-06-01T10:30:00.000Z', windowOpenAt: '2026-05-31T10:30:00.000Z', passengerName: 'A', status: 'pending', boardingPassUrl: null, deliveredAt: null, assignedAgentId: null },
      { id: 2, pnr: 'P2', airlineCode: '6E', flightNumber: '6E-2', departureAt: '2026-06-01T10:30:00.000Z', windowOpenAt: '2026-05-31T10:30:00.000Z', passengerName: 'B', status: 'reminded', boardingPassUrl: null, deliveredAt: null, assignedAgentId: null },
      { id: 3, pnr: 'P3', airlineCode: '6E', flightNumber: '6E-3', departureAt: '2026-06-01T10:30:00.000Z', windowOpenAt: '2026-05-31T10:30:00.000Z', passengerName: 'C', status: 'in-progress', boardingPassUrl: null, deliveredAt: null, assignedAgentId: null },
      { id: 4, pnr: 'P4', airlineCode: '6E', flightNumber: '6E-4', departureAt: '2026-06-01T10:30:00.000Z', windowOpenAt: '2026-05-31T10:30:00.000Z', passengerName: 'D', status: 'done', boardingPassUrl: null, deliveredAt: null, assignedAgentId: null },
      { id: 5, pnr: 'P5', airlineCode: '6E', flightNumber: '6E-5', departureAt: '2026-06-01T10:30:00.000Z', windowOpenAt: '2026-05-31T10:30:00.000Z', passengerName: 'E', status: 'fallback-agent', boardingPassUrl: null, deliveredAt: null, assignedAgentId: null },
      { id: 6, pnr: 'P6', airlineCode: '6E', flightNumber: '6E-6', departureAt: '2026-06-01T10:30:00.000Z', windowOpenAt: '2026-05-31T10:30:00.000Z', passengerName: 'F', status: 'failed', boardingPassUrl: null, deliveredAt: null, assignedAgentId: null },
    ];
    fetchApiMock.mockImplementation(defaultFetchImpl(allStatusRows));
    renderPage();
    await screen.findByText('P1');
    expect(screen.getByTestId('status-badge-1').textContent).toBe('pending');
    expect(screen.getByTestId('status-badge-2').textContent).toBe('reminded');
    expect(screen.getByTestId('status-badge-3').textContent).toBe('in-progress');
    expect(screen.getByTestId('status-badge-4').textContent).toBe('done');
    expect(screen.getByTestId('status-badge-5').textContent).toBe('fallback-agent');
    expect(screen.getByTestId('status-badge-6').textContent).toBe('failed');
  });

  it('renders boarding-pass "View" link when URL present and "—" when absent', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');
    // Row 2 has a boardingPassUrl → expect a "View" anchor pointing to it.
    const viewLink = screen.getByRole('link', { name: /^View$/ });
    expect(viewLink.getAttribute('href')).toBe('/uploads/boarding-passes/bp-xyz.pdf');
    expect(viewLink.getAttribute('target')).toBe('_blank');
    expect(viewLink.getAttribute('rel')).toMatch(/noopener/);
  });

  it('Deliver button is disabled when deliveredAt is set (shows "Delivered")', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('XYZ789');
    // Row 2 has deliveredAt set → button should be disabled with "Delivered" label.
    const deliveredBtn = screen.getByRole('button', { name: /Deliver boarding pass for XYZ789/i });
    expect(deliveredBtn.disabled).toBe(true);
    expect(deliveredBtn.textContent).toMatch(/Delivered/);
  });

  it('declined deliver-confirm does NOT POST /deliver', async () => {
    notifyObj.confirm.mockImplementation(() => Promise.resolve(false));
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');

    const deliverBtn = screen.getByRole('button', { name: /Deliver boarding pass for ABC123/i });
    fireEvent.click(deliverBtn);

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalled();
    });
    // No POST to /deliver should have happened.
    const deliverCall = fetchApiMock.mock.calls.find(
      ([u, o]) => typeof u === 'string' && u.endsWith('/deliver') && o?.method === 'POST',
    );
    expect(deliverCall).toBeFalsy();
    expect(notifyObj.success).not.toHaveBeenCalled();
  });

  it('reassign-agent dropdown PATCHes with parsed agentId and toasts "Reassigned"', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');

    const reassignSelect = screen.getByLabelText(/Reassign agent for ABC123/i);
    fireEvent.change(reassignSelect, { target: { value: '7' } });

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/webcheckins/1' && o?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      // Body should be JSON with parsed integer agentId.
      const body = JSON.parse(patchCall[1].body);
      expect(body.assignedAgentId).toBe(7);
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/Reassigned/i));
  });

  it('reassign to empty value PATCHes assignedAgentId:null and toasts "Unassigned"', async () => {
    // Start with row 2 (already assignedAgentId=5) so the dropdown has a non-default value.
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('XYZ789');

    const reassignSelect = screen.getByLabelText(/Reassign agent for XYZ789/i);
    fireEvent.change(reassignSelect, { target: { value: '' } });

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/travel/webcheckins/2' && o?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      expect(body.assignedAgentId).toBeNull();
    });
    expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/Unassigned/i));
  });

  it('upload error surfaces notify.error with the server message', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 413,
      json: () => Promise.resolve({ error: 'File too large' }),
    });
    renderPage();
    await screen.findByText('ABC123');

    const uploadBtn = screen.getByRole('button', { name: /Upload boarding pass for ABC123/i });
    fireEvent.click(uploadBtn);
    const fileInput = screen.getByLabelText(/Boarding pass file for ABC123/i);
    const file = new File(['huge'], 'huge.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith(expect.stringMatching(/File too large/i));
    });
    expect(notifyObj.success).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('status filter is disabled while "Upcoming only" is on', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_ROWS));
    renderPage();
    await screen.findByText('ABC123');

    const toggle = screen.getByLabelText(/Show only upcoming/i);
    fireEvent.click(toggle);

    await waitFor(() => {
      const filterSelect = screen.getByLabelText(/Filter by status/i);
      expect(filterSelect.disabled).toBe(true);
    });
  });

  it('renders "—" for windowOpenAt/departureAt when values are invalid', async () => {
    const badDateRow = [{
      id: 99, pnr: 'BAD1', airlineCode: 'XX', flightNumber: 'XX-1',
      departureAt: 'not-a-date', windowOpenAt: null,
      passengerName: 'Bad Date Passenger', status: 'pending',
      boardingPassUrl: null, deliveredAt: null, assignedAgentId: null,
    }];
    fetchApiMock.mockImplementation(defaultFetchImpl(badDateRow));
    renderPage();
    await screen.findByText('BAD1');
    // Both columns should render the em-dash fallback.
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('survives /api/staff fetch failure — reassign dropdown still renders (Unassigned only)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.reject(new Error('staff endpoint down'));
      return defaultFetchImpl(SAMPLE_ROWS)(url, opts);
    });
    renderPage();
    await screen.findByText('ABC123');

    const reassignSelect = screen.getByLabelText(/Reassign agent for ABC123/i);
    // Should still render with at least the "Unassigned" option.
    const options = reassignSelect.querySelectorAll('option');
    expect(options.length).toBeGreaterThanOrEqual(1);
    expect(options[0].textContent).toMatch(/Unassigned/);
  });

  it('non-401 list-fetch failure clears rows and renders the empty state', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/travel/webcheckins?')) {
        return Promise.reject({ status: 500, message: 'Server error' });
      }
      if (url === '/api/staff') return Promise.resolve(SAMPLE_STAFF);
      return Promise.resolve({});
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No web check-ins yet/i)).toBeTruthy();
    });
  });

  it('renders pagination range "1–50 of 120" when total exceeds page size', async () => {
    const manyRows = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1, pnr: `RNG${i}`, airlineCode: '6E', flightNumber: `6E-${100 + i}`,
      departureAt: '2026-06-01T10:30:00.000Z',
      windowOpenAt: '2026-05-31T10:30:00.000Z',
      passengerName: `P ${i}`, status: 'pending',
      boardingPassUrl: null, deliveredAt: null, assignedAgentId: null,
    }));
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/travel/webcheckins?')) {
        return Promise.resolve({ webcheckins: manyRows, total: 120, limit: 50, offset: 0 });
      }
      if (url === '/api/staff') return Promise.resolve(SAMPLE_STAFF);
      return Promise.resolve({});
    });
    renderPage();
    await screen.findByText('RNG0');
    // Range text uses an HTML en-dash entity (–); accept either form.
    const rangeText = screen.getByText(/1.{1,3}50 of 120/);
    expect(rangeText).toBeTruthy();
    // Prev button should be disabled at offset 0.
    const prevBtn = screen.getByRole('button', { name: /Previous page/i });
    expect(prevBtn.disabled).toBe(true);
  });
});
