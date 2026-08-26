/**
 * MyPrescriptionRequests.test.jsx — the PATIENT-side renewal surface.
 *
 * This page exists because granting a CUSTOMER role `my_prescription_requests`
 * previously put a permission in the matrix with no page behind it, so the
 * customer's sidebar stayed empty. What's pinned here is the behaviour that
 * would make it look broken again:
 *   1. It reads the SAME /portal/* endpoints the Android app uses — not the
 *      staff-authed self-view, which resolves the Patient by a different path.
 *   2. A prescription with an OPEN request cannot be requested again (the
 *      backend answers that with 409, so the button is disabled instead).
 *   3. The default ask omits `medicines` entirely — absence is what the API
 *      reads as "renew the complete prescription".
 *   4. Picking specific medicines sends exactly those names.
 *   5. The clinic's decision note is shown inline on a declined request.
 *   6. An account with no linked Patient row gets the specific explanation,
 *      not a generic failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const notifySuccess = vi.fn();
const notifyError = vi.fn();
vi.mock('../../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
  }),
}));

vi.mock('../../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: () => 'test-token',
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    isReady: true,
    hasPermission: () => true,
    permissions: ['my_prescription_requests.read', 'my_prescription_requests.write'],
    roles: [],
    isOwner: false,
    userType: null,
    isLoading: false,
  }),
}));

import MyPrescriptionRequests from '../../pages/wellness/MyPrescriptionRequests';
import { fetchApi } from '../../utils/api';

const RX_LIST = '/api/wellness/portal/prescriptions';
const REQ_LIST = '/api/wellness/portal/prescription-requests';

const RX_MULTI = {
  id: 367,
  createdAt: '2026-08-15T09:00:00.000Z',
  doctor: { id: 3, name: 'Pratibha Laxmi Singh' },
  drugs: [
    { name: 'Azithromycin 500mg', dosage: 1, frequency: 1, duration: 7 },
    { name: 'Biotin 10000mcg', dosage: 1, frequency: 1, duration: 60 },
  ],
};

const RX_OPEN = {
  id: 366,
  createdAt: '2026-08-26T09:00:00.000Z',
  doctor: { id: 2, name: 'Rupal Sharma' },
  drugs: [{ name: 'Minoxidil 5%', dosage: 1, frequency: 2, duration: 84 }],
};

const REQ_OPEN = {
  id: 6,
  status: 'ACCEPTED',
  prescriptionId: 366,
  patientId: 2965,
  doctorName: 'Rupal Sharma',
  isFullPrescription: true,
  requestedDrugs: null,
  requestedDurationDays: 90,
  notes: 'Need the full course again before travelling.',
  reviewNote: 'Approved for 90 days. Collect from the front desk.',
  createdAt: '2026-08-24T09:00:00.000Z',
};

const REQ_REJECTED = {
  id: 8,
  status: 'REJECTED',
  prescriptionId: 999,
  patientId: 2965,
  doctorName: 'Punam Singh',
  isFullPrescription: false,
  requestedDrugs: [{ name: 'Crocin Advance' }],
  requestedDurationDays: null,
  notes: 'Can I get more of the same?',
  reviewNote: 'Please book a review consultation first.',
  createdAt: '2026-08-20T09:00:00.000Z',
};

let prescriptions;
let requests;
let postError = null;

function renderPage() {
  return render(
    <MemoryRouter>
      <MyPrescriptionRequests />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  prescriptions = [RX_OPEN, RX_MULTI];
  requests = [REQ_OPEN, REQ_REJECTED];
  postError = null;

  fetchApi.mockImplementation(async (url, options) => {
    if (url === RX_LIST) return prescriptions;
    if (url === REQ_LIST && (!options || options.method !== 'POST')) return requests;
    if (url === REQ_LIST && options?.method === 'POST') {
      if (postError) throw postError;
      return { id: 99, status: 'PENDING' };
    }
    return {};
  });
});

describe('MyPrescriptionRequests', () => {
  it('reads the portal endpoints the Android app uses', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    const urls = fetchApi.mock.calls.map((c) => c[0]);
    expect(urls).toContain(RX_LIST);
    expect(urls).toContain(REQ_LIST);
    // NOT the staff-authed self-view — that resolves a different Patient row.
    expect(urls.some((u) => u.includes('/api/wellness/my-prescriptions'))).toBe(false);
  });

  it('lists existing requests with their status', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    expect(screen.getByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText('Declined')).toBeInTheDocument();
  });

  it('shows the clinic\'s note on a declined request', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    expect(
      screen.getByText(/Please book a review consultation first/),
    ).toBeInTheDocument();
  });

  it('disables re-requesting a prescription that already has an open request', async () => {
    renderPage();
    await screen.findByText(/Prescription #366/);
    // RX_OPEN has an ACCEPTED (still-open) request, so its button is disabled
    // and labelled with the current state instead of "Request renewal".
    const blocked = screen.getByRole('button', { name: /Request accepted/i });
    expect(blocked).toBeDisabled();
    // RX_MULTI has none, so it stays actionable.
    expect(screen.getByRole('button', { name: /Request renewal/i })).toBeEnabled();
  });

  it('omits `medicines` entirely for a whole-prescription ask', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    fireEvent.click(screen.getByRole('button', { name: /Request renewal/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.prescriptionId).toBe(367);
      // Absence — not [] and not every name — is what the API reads as "all".
      expect('medicines' in body).toBe(false);
    });
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('sends exactly the medicines picked when not renewing everything', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    fireEvent.click(screen.getByRole('button', { name: /Request renewal/i }));

    const dialog = await screen.findByRole('dialog');
    // Untick "complete prescription" to reveal the per-medicine checkboxes.
    fireEvent.click(within(dialog).getByLabelText(/Renew the complete prescription/i));
    fireEvent.click(within(dialog).getByLabelText(/Azithromycin 500mg/i));
    fireEvent.change(within(dialog).getByPlaceholderText(/e.g. 60 days/i), {
      target: { value: '60' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find((c) => c[1]?.method === 'POST');
      const body = JSON.parse(post[1].body);
      expect(body.medicines).toEqual(['Azithromycin 500mg']);
      expect(body.durationDays).toBe(60);
    });
  });

  it('refuses to send an empty medicine selection', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    fireEvent.click(screen.getByRole('button', { name: /Request renewal/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/Renew the complete prescription/i));
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    expect(fetchApi.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false);
  });

  it('surfaces a backend refusal instead of pretending it worked', async () => {
    postError = Object.assign(new Error('You already have a renewal request open'), {
      code: 'REQUEST_ALREADY_OPEN',
    });
    renderPage();
    await screen.findByText(/Prescription #367/);
    fireEvent.click(screen.getByRole('button', { name: /Request renewal/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringContaining('already have a renewal request open'),
      ),
    );
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('explains an account that is not linked to a patient record', async () => {
    fetchApi.mockImplementation(async () => {
      throw Object.assign(new Error('This account is not linked to a patient profile'), {
        code: 'NO_PATIENT_PROFILE',
      });
    });
    renderPage();
    expect(
      await screen.findByText(/not linked to a patient profile/i),
    ).toBeInTheDocument();
  });

  it('tells a customer with no prescriptions why the list is empty', async () => {
    prescriptions = [];
    requests = [];
    renderPage();
    expect(
      await screen.findByText(/You have no prescriptions on file yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/haven't asked for a repeat yet/i)).toBeInTheDocument();
  });
});
