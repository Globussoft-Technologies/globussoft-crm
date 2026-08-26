/**
 * PrescriptionRequests.test.jsx — the clinic-side queue for prescription
 * renewal / medicine requests raised from the Android app.
 *
 * What's pinned here is the behaviour a regression would break silently:
 *   1. The table renders the triage columns, and a full-prescription request
 *      reads as "Complete prescription" rather than an empty medicines cell.
 *   2. A specific-medicine request lists what was actually asked for.
 *   3. Status tabs drive the `?status=` query the backend filters on, and the
 *      tab badges come from the backend's `counts` (not from the page).
 *   4. `?request=<id>` — the deep link every renewal notification carries —
 *      opens the review panel straight away, without a table click.
 *   5. The panel shows the ORIGINAL prescription beside the request, so the
 *      reviewer is never deciding blind.
 *   6. Rejecting without a reason is refused client-side (the patient is told
 *      the outcome, so "declined" with no reason is not an answer), and a
 *      reason lets the PATCH through with the note attached.
 *   7. Calling the customer reuses the existing Callified patient endpoints —
 *      a call from this screen must not become its own kind of call.
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
    permissions: ['prescription_requests.read', 'prescription_requests.update'],
    roles: [],
    isOwner: false,
    userType: null,
    isLoading: false,
  }),
}));

// The call dialog has its own suite (CallifiedCallDialog.test.jsx). Here we
// only care that this page hands it the right patient endpoints.
const callDialogProps = vi.fn();
vi.mock('../../components/CallifiedCallDialog', () => ({
  default: (props) => {
    callDialogProps(props);
    return <div data-testid="call-dialog">Call dialog</div>;
  },
}));

import PrescriptionRequests from '../../pages/wellness/PrescriptionRequests';
import { fetchApi } from '../../utils/api';

const FULL_RX_REQUEST = {
  id: 30,
  status: 'PENDING',
  prescriptionId: 9,
  patientId: 3,
  doctorId: 11,
  doctorName: 'Dr Rao',
  patientName: 'Asha Menon',
  patientPhone: '9999295298',
  isFullPrescription: true,
  requestedDrugs: null,
  requestedDurationDays: 60,
  requestedFrom: null,
  requestedTo: null,
  notes: 'Running low',
  createdAt: '2026-08-26T09:00:00.000Z',
};

const PARTIAL_REQUEST = {
  ...FULL_RX_REQUEST,
  id: 31,
  isFullPrescription: false,
  requestedDrugs: [{ name: 'Amoxicillin 500mg', dosage: 1, frequency: 3 }],
  requestedDurationDays: null,
};

const DETAIL = {
  ...FULL_RX_REQUEST,
  patient: {
    id: 3,
    name: 'Asha Menon',
    phone: '9999295298',
    email: 'asha@example.com',
    allergies: 'Penicillin',
  },
  prescription: {
    id: 9,
    drugs: [{ name: 'Amoxicillin 500mg', dosage: 1, frequency: 3, duration: 5 }],
    instructions: 'After food',
    createdAt: '2026-06-01T09:00:00.000Z',
    serviceName: 'Dermatology',
    visitDate: '2026-06-01T09:00:00.000Z',
  },
  history: [
    {
      id: 1,
      action: 'CREATED',
      fromStatus: null,
      toStatus: 'PENDING',
      actorType: 'patient',
      createdAt: '2026-08-26T09:00:00.000Z',
    },
  ],
};

let listResponse;
let detailResponse;

function renderPage(initialEntry = '/wellness/prescription-requests') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PrescriptionRequests />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listResponse = {
    items: [FULL_RX_REQUEST],
    total: 1,
    counts: { PENDING: 1, ACCEPTED: 2, REJECTED: 0, COMPLETED: 4 },
  };
  detailResponse = DETAIL;

  fetchApi.mockImplementation(async (url, options) => {
    if (url.startsWith('/api/wellness/prescription-requests?')) return listResponse;
    if (/\/prescription-requests\/\d+\/status$/.test(url)) {
      const body = JSON.parse(options.body);
      return { ...detailResponse, status: body.status, reviewNote: body.note ?? null };
    }
    if (/\/prescription-requests\/\d+$/.test(url)) return detailResponse;
    return {};
  });
});

describe('PrescriptionRequests — queue', () => {
  it('renders a full-prescription request as "Complete prescription"', async () => {
    renderPage();
    expect(await screen.findByText('Asha Menon')).toBeInTheDocument();
    expect(screen.getByText('Complete prescription')).toBeInTheDocument();
    expect(screen.getByText('Rx #9')).toBeInTheDocument();
    expect(screen.getByText('Dr Rao')).toBeInTheDocument();
    expect(screen.getByText('60 days')).toBeInTheDocument();
  });

  it('lists the named medicines when only some were requested', async () => {
    listResponse = { ...listResponse, items: [PARTIAL_REQUEST] };
    renderPage();
    expect(await screen.findByText('Amoxicillin 500mg')).toBeInTheDocument();
  });

  it('defaults to the Pending tab and shows backend-supplied tab counts', async () => {
    renderPage();
    await screen.findByText('Asha Menon');
    // The first request carries status=PENDING with no explicit URL param.
    expect(fetchApi.mock.calls[0][0]).toContain('status=PENDING');
    // Counts come from the response, so Completed shows 4 even while we are
    // looking at Pending.
    const completedTab = screen.getByRole('button', { name: /Completed/ });
    expect(within(completedTab).getByText('4')).toBeInTheDocument();
  });

  it('switching tabs re-queries with the new status', async () => {
    renderPage();
    await screen.findByText('Asha Menon');
    fireEvent.click(screen.getByRole('button', { name: /Completed/ }));
    await waitFor(() => {
      const urls = fetchApi.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => u.includes('status=COMPLETED'))).toBe(true);
    });
  });

  it('the All tab drops the status filter entirely', async () => {
    renderPage();
    await screen.findByText('Asha Menon');
    fireEvent.click(screen.getByRole('button', { name: /^All$/ }));
    await waitFor(() => {
      const urls = fetchApi.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => !u.includes('status='))).toBe(true);
    });
  });

  it('offers a call action on the row, without opening the request first', async () => {
    renderPage();
    await screen.findByText('Asha Menon');

    const callBtn = screen.getByTestId('prescription-request-call-30');
    expect(callBtn).toBeEnabled();
    fireEvent.click(callBtn);

    await screen.findByTestId('call-dialog');
    const props = callDialogProps.mock.calls.at(-1)[0];
    // The same patient endpoints the review panel uses — a call from the queue
    // must not become its own kind of call.
    expect(props.endpoints).toEqual({
      context: '/api/wellness/callified/patients/3/context',
      campaigns: '/api/wellness/callified/campaigns',
      aiCall: '/api/wellness/callified/patients/3/ai-call',
      manualCall: '/api/wellness/callified/patients/3/manual-call',
    });
    expect(props.customer.phone).toBe('9999295298');
    expect(props.customer.name).toBe('Asha Menon');
    // Row data is enough — no detail fetch was needed to place the call.
    const urls = fetchApi.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/api/wellness/prescription-requests/30');
  });

  it('disables the row call action when the customer has no dialable number', async () => {
    listResponse = {
      ...listResponse,
      items: [{ ...FULL_RX_REQUEST, id: 32, patientPhone: null }],
    };
    renderPage();
    await screen.findByText('Asha Menon');

    const callBtn = screen.getByTestId('prescription-request-call-32');
    expect(callBtn).toBeDisabled();
    expect(callBtn).toHaveAttribute('title', 'No valid phone number on file');
  });

  it('renders the empty state rather than a blank table', async () => {
    listResponse = { items: [], total: 0, counts: {} };
    renderPage();
    expect(await screen.findByText('No pending requests.')).toBeInTheDocument();
  });
});

describe('PrescriptionRequests — review panel', () => {
  it('opens straight from the ?request= deep link a notification carries', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => {
      const urls = fetchApi.mock.calls.map((c) => c[0]);
      expect(urls).toContain('/api/wellness/prescription-requests/30');
    });
  });

  it('portals the review panel out of the transformed <main>', async () => {
    // Same regression guard as the patient composer: <main> is transformed by
    // the shell's fade-in animation, which makes it the containing block for
    // `position: fixed`. Opened in place from a row far down the queue, the
    // panel would render above the fold with only its bottom edge visible.
    const main = document.createElement('main');
    main.style.transform = 'translateY(0)';
    document.body.appendChild(main);
    try {
      render(
        <MemoryRouter initialEntries={['/wellness/prescription-requests?request=30']}>
          <PrescriptionRequests />
        </MemoryRouter>,
        { container: main },
      );
      const dialog = await screen.findByRole('dialog');
      // Control assertion: the PAGE really did render inside our fake <main>,
      // so "the dialog is not in main" means the portal moved it — not that
      // the container option silently did nothing.
      expect(main.querySelector('h1')).toBeTruthy();
      expect(main.contains(dialog)).toBe(false);
      expect(document.body.contains(dialog)).toBe(true);
    } finally {
      main.remove();
    }
  });

  it('shows the original prescription beside what was requested', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Original prescription');
    expect(within(dialog).getByText('After food')).toBeInTheDocument();
    expect(within(dialog).getByText(/Dermatology/)).toBeInTheDocument();
    // Allergies are surfaced — a renewal decision must not miss them.
    expect(within(dialog).getByText(/Penicillin/)).toBeInTheDocument();
    expect(within(dialog).getByText('Running low')).toBeInTheDocument();
  });

  it('renders the request history', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('History');
    const historyItem = within(dialog).getByText('CREATED').closest('li');
    // The patient raised it, so the actor column must say so rather than
    // attributing the row to a staff member.
    expect(historyItem.textContent).toMatch(/Patient/);
  });

  it('refuses to reject without a reason, and never sends the PATCH', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Reject/ }));
    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    const patched = fetchApi.mock.calls.filter((c) => c[1]?.method === 'PATCH');
    expect(patched).toHaveLength(0);
  });

  it('sends the note with the rejection once a reason is given', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    const note = await within(dialog).findByPlaceholderText(/Note for the patient/);
    fireEvent.change(note, { target: { value: 'Needs a review consult first' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Reject/ }));

    await waitFor(() => {
      const patched = fetchApi.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(patched).toBeTruthy();
      expect(patched[0]).toBe('/api/wellness/prescription-requests/30/status');
      expect(JSON.parse(patched[1].body)).toEqual({
        status: 'REJECTED',
        note: 'Needs a review consult first',
      });
    });
  });

  it('accepting sends the ACCEPTED transition', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Accept/ }));
    await waitFor(() => {
      const patched = fetchApi.mock.calls.find((c) => c[1]?.method === 'PATCH');
      expect(JSON.parse(patched[1].body).status).toBe('ACCEPTED');
    });
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('a closed request shows its outcome instead of the decision buttons', async () => {
    detailResponse = {
      ...DETAIL,
      status: 'REJECTED',
      reviewedByName: 'Dr Rao',
      reviewNote: 'Needs a review consult first',
      reviewedAt: '2026-08-26T12:00:00.000Z',
    };
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Outcome');
    expect(within(dialog).queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Reject/ })).toBeNull();
    // "Dr Rao" is both the prescriber and the decider here, so scope the
    // assertion to the Outcome section rather than the whole dialog.
    const outcome = within(dialog).getByText('Outcome').closest('section');
    expect(within(outcome).getByText(/Dr Rao/)).toBeInTheDocument();
    expect(
      within(outcome).getByText('Needs a review consult first'),
    ).toBeInTheDocument();
  });

  it('reuses the existing Callified PATIENT endpoints for the call', async () => {
    renderPage('/wellness/prescription-requests?request=30');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Call customer/ }));

    await screen.findByTestId('call-dialog');
    const props = callDialogProps.mock.calls.at(-1)[0];
    expect(props.endpoints).toEqual({
      context: '/api/wellness/callified/patients/3/context',
      campaigns: '/api/wellness/callified/campaigns',
      aiCall: '/api/wellness/callified/patients/3/ai-call',
      manualCall: '/api/wellness/callified/patients/3/manual-call',
    });
    expect(props.customer.phone).toBe('9999295298');
  });
});
