/**
 * PassportVerificationQueue.jsx — Travel CRM passport-OCR operator queue
 * (PRD_PASSPORT_OCR FR-6/FR-7, slice C2).
 *
 * Pins the frontend contract for the page that sits on top of
 * backend/routes/travel_passport.js. Verifies:
 *   - Page header renders.
 *   - Empty state renders PRD-correct messaging.
 *   - Data rows render fullName / trip code / extracted fields.
 *   - Approve happy path POSTs /passport-verify with approved=true.
 *   - Edit modal lets operator override extracted fields before approve;
 *     edited values flow into the POST body as editedFields.
 *   - Reject flow selects a reason then POSTs approved=false + reason.
 *   - Error from the queue endpoint (e.g. 403 RBAC_DENIED for USER role)
 *     surfaces the inline error card without crashing the page.
 *
 * Mock stability per CLAUDE.md feedback rule: useNotify + fetchApi mocks
 * are stable references; otherwise useCallback / useEffect deps cause
 * infinite re-renders.
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

import PassportVerificationQueue from '../pages/travel/PassportVerificationQueue';

const SAMPLE_PENDING = [
  {
    participantId: 55,
    fullName: 'Jane Doe',
    extractedAt: '2026-06-09T10:00:00.000Z',
    rejectedAt: null,
    extraction: {
      passportNumber: 'M1234567',
      surname: 'DOE',
      givenNames: 'JANE',
      dateOfBirth: '1990-01-15',
      sex: 'F',
      nationality: 'IND',
      placeOfIssue: 'DELHI',
      dateOfExpiry: '2030-05-09',
    },
    confidence: 0.95,
    provider: 'stub-mode-v1',
    imageUrl: '/uploads/passport-ocr/abc.jpg',
    trip: { id: 100, tripCode: 'bali2026', destination: 'Bali' },
  },
  {
    participantId: 56,
    fullName: 'Yusuf Rahman',
    extractedAt: '2026-06-09T10:05:00.000Z',
    rejectedAt: '2026-06-09T09:30:00.000Z', // previously rejected then re-uploaded
    extraction: {
      passportNumber: 'P7654321',
      surname: 'RAHMAN',
      givenNames: 'YUSUF',
      dateOfBirth: '1985-07-22',
      sex: 'M',
      nationality: 'IND',
      placeOfIssue: 'MUMBAI',
      dateOfExpiry: '2032-08-01',
    },
    confidence: 0.88,
    provider: 'stub-mode-v1',
    imageUrl: '/uploads/passport-ocr/xyz.jpg',
    trip: { id: 101, tripCode: 'mecca2026', destination: 'Mecca' },
  },
];

function defaultFetchImpl(rows = SAMPLE_PENDING) {
  return (url, opts) => {
    if (url === '/api/travel/passport/verification-queue') {
      return Promise.resolve({ pending: rows, total: rows.length });
    }
    if (url.match(/\/api\/travel\/passport\/participants\/\d+\/passport-verify$/) && opts?.method === 'POST') {
      return Promise.resolve({ ok: true });
    }
    if (url.match(/\/api\/travel\/passport\/participants\/\d+\/passport-extraction$/) && opts?.method === 'DELETE') {
      return Promise.resolve({ cleared: true });
    }
    return Promise.resolve({});
  };
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  notifyObj.info.mockReset();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <PassportVerificationQueue />
    </MemoryRouter>,
  );
}

describe('PassportVerificationQueue — operator queue (PRD FR-6)', () => {
  it('renders the page header', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl([]));
    renderPage();
    expect(await screen.findByRole('heading', { name: /Passport Verification/i })).toBeTruthy();
  });

  it('shows the empty state when no pending rows', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl([]));
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No pending passport verifications/i)).toBeTruthy();
    });
  });

  it('renders rows with name, trip code, and extracted fields', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_PENDING));
    renderPage();
    await screen.findByText('Jane Doe');
    expect(screen.getByText('Yusuf Rahman')).toBeTruthy();
    // Trip code rendered in the trip row label.
    expect(screen.getByText('bali2026')).toBeTruthy();
    expect(screen.getByText('mecca2026')).toBeTruthy();
    // Extracted passport number on the field grid.
    expect(screen.getByText('M1234567')).toBeTruthy();
    expect(screen.getByText('P7654321')).toBeTruthy();
    // Previously-rejected badge surfaces for row 2.
    expect(screen.getByText(/Previously rejected/i)).toBeTruthy();
  });

  it('approve action POSTs /passport-verify with approved=true', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_PENDING));
    renderPage();
    await screen.findByText('Jane Doe');

    const approveBtn = screen.getByRole('button', { name: /Approve passport for Jane Doe/i });
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/passport/participants/55/passport-verify',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"approved":true'),
        }),
      );
    });
    // Success toast fires (mock stable per CLAUDE.md notify-stability rule).
    await waitFor(() => {
      expect(notifyObj.success).toHaveBeenCalledWith(expect.stringMatching(/Jane Doe/));
    });
  });

  it('edit-then-approve flow sends editedFields in the POST body', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_PENDING));
    renderPage();
    await screen.findByText('Jane Doe');

    // Click "Edit & approve" on Jane's row.
    const editBtn = screen.getByRole('button', { name: /Edit extracted fields for Jane Doe/i });
    fireEvent.click(editBtn);

    // Edit the passport number input.
    const numInput = await screen.findByLabelText(/Edit passport number/i);
    fireEvent.change(numInput, { target: { value: 'M9999999' } });

    // Click "Save & approve".
    const saveBtn = screen.getByRole('button', { name: /Save & approve/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/travel/passport/participants/55/passport-verify',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
    // Find the call with the verify endpoint and confirm body has editedFields.
    const verifyCall = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/travel/passport/participants/55/passport-verify' && opts?.method === 'POST',
    );
    expect(verifyCall).toBeDefined();
    const body = JSON.parse(verifyCall[1].body);
    expect(body.approved).toBe(true);
    expect(body.editedFields).toMatchObject({ passportNumber: 'M9999999' });
  });

  it('reject flow shows reason picker, then POSTs approved=false + reason', async () => {
    fetchApiMock.mockImplementation(defaultFetchImpl(SAMPLE_PENDING));
    renderPage();
    await screen.findByText('Jane Doe');

    // Click "Reject" on Jane's row.
    const rejectBtn = screen.getByRole('button', { name: /Reject passport for Jane Doe/i });
    fireEvent.click(rejectBtn);

    // Reason picker surfaces.
    const reasonSelect = await screen.findByLabelText(/Reject reason/i);
    fireEvent.change(reasonSelect, { target: { value: 'expired_passport' } });

    // Confirm.
    const confirmBtn = screen.getByRole('button', { name: /Confirm reject/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const rejectCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/travel/passport/participants/55/passport-verify' && opts?.method === 'POST',
      );
      expect(rejectCall).toBeDefined();
      const body = JSON.parse(rejectCall[1].body);
      expect(body.approved).toBe(false);
      expect(body.reason).toBe('expired_passport');
    });
    await waitFor(() => {
      expect(notifyObj.info).toHaveBeenCalledWith(expect.stringMatching(/Jane Doe/));
    });
  });

  it('surface the error card gracefully when the queue endpoint fails (USER role gets RBAC_DENIED)', async () => {
    // Simulate the 403 RBAC_DENIED response by rejecting the queue fetch.
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/passport/verification-queue') {
        return Promise.reject(new Error('Forbidden — passport verification is admin/manager only'));
      }
      return Promise.resolve({});
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Forbidden/i)).toBeTruthy();
    });
    // Page didn't crash — heading still present.
    expect(screen.getByRole('heading', { name: /Passport Verification/i })).toBeTruthy();
  });
});
