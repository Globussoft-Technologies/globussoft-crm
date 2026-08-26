/**
 * MyPrescriptionsRenewal.test.jsx — the "Request renewal" action ON the
 * prescription card.
 *
 * The renewal flow originally lived only on the separate My Prescription
 * Requests page, which meant a patient looking at their medicines had no way
 * to act on them — they had to know another page existed. This pins the action
 * in the place they actually expect it, and the states that stop it becoming
 * a button that always fails:
 *   1. Each prescription card offers the action alongside its PDF button.
 *   2. A prescription with an OPEN request shows that status, disabled —
 *      the backend answers a second request with 409.
 *   3. Without `my_prescription_requests.write` the action is disabled with a
 *      reason, not hidden.
 *   4. Submitting posts to the same portal endpoint the Android app uses, and
 *      the default ask omits `medicines` (absence = the complete prescription).
 *   5. After a successful send the card flips to "Renewal pending" — the
 *      overlay is re-read rather than left stale.
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

let grantWrite = true;
vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: () => ({
    isReady: true,
    hasPermission: (mod, action) =>
      mod === 'my_prescription_requests' && action === 'write' ? grantWrite : true,
    permissions: [],
    roles: [],
    isOwner: false,
    userType: null,
    isLoading: false,
  }),
}));

import MyPrescriptions from '../../pages/wellness/MyPrescriptions';
import { fetchApi } from '../../utils/api';

const MY_RX = '/api/wellness/my-prescriptions';
const REQ = '/api/wellness/portal/prescription-requests';

const RX_366 = {
  id: 366,
  createdAt: '2026-08-26T09:00:00.000Z',
  doctor: { id: 2, name: 'Rupal Sharma' },
  visit: { service: { name: 'Basic FUE' } },
  drugs: [{ name: 'Minoxidil 5%', dosage: 1, frequency: 2, duration: 84 }],
};

const RX_367 = {
  id: 367,
  createdAt: '2026-08-15T09:00:00.000Z',
  doctor: { id: 3, name: 'Pratibha Laxmi Singh' },
  visit: { service: { name: 'Bio FUE' } },
  drugs: [
    { name: 'Azithromycin 500mg', dosage: 1, frequency: 1, duration: 7 },
    { name: 'Biotin 10000mcg', dosage: 1, frequency: 1, duration: 60 },
  ],
};

const OPEN_REQUEST = {
  id: 5,
  status: 'PENDING',
  prescriptionId: 366,
  isFullPrescription: true,
  requestedDrugs: null,
  createdAt: '2026-08-24T09:00:00.000Z',
};

let requests;

function renderPage() {
  return render(
    <MemoryRouter>
      <MyPrescriptions />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  grantWrite = true;
  requests = [];

  fetchApi.mockImplementation(async (url, options) => {
    if (url === MY_RX) {
      return { patient: { id: 2965, name: 'Mohit das' }, prescriptions: [RX_366, RX_367] };
    }
    if (url === REQ && options?.method === 'POST') {
      // The backend would now report this prescription as having an open
      // request; mirror that so the re-read after submit is meaningful.
      requests = [{ ...OPEN_REQUEST, prescriptionId: JSON.parse(options.body).prescriptionId }];
      return { id: 9, status: 'PENDING' };
    }
    if (url === REQ) return requests;
    return {};
  });
});

describe('MyPrescriptions — request renewal', () => {
  it('offers the action on every prescription card', async () => {
    renderPage();
    await screen.findByText(/Prescription #366/);
    const buttons = await screen.findAllByRole('button', { name: /Request renewal/i });
    expect(buttons).toHaveLength(2);
    buttons.forEach((b) => expect(b).toBeEnabled());
  });

  it('shows the open request\'s status instead, disabled, when one exists', async () => {
    requests = [OPEN_REQUEST];
    renderPage();
    await screen.findByText(/Prescription #366/);

    const blocked = await screen.findByRole('button', { name: /Renewal pending/i });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute(
      'title',
      expect.stringContaining('already have a renewal request'),
    );
    // RX_367 has no open request, so it stays actionable.
    expect(screen.getByRole('button', { name: /Request renewal/i })).toBeEnabled();
  });

  it('disables the action without the write grant, rather than hiding it', async () => {
    grantWrite = false;
    renderPage();
    await screen.findByText(/Prescription #366/);
    const buttons = await screen.findAllByRole('button', { name: /Request renewal/i });
    buttons.forEach((b) => {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', expect.stringContaining('not enabled'));
    });
  });

  it('posts to the portal endpoint, omitting `medicines` for a whole-Rx ask', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    const buttons = await screen.findAllByRole('button', { name: /Request renewal/i });
    fireEvent.click(buttons[1]); // RX_367

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Prescription #367/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      expect(post[0]).toBe(REQ);
      const body = JSON.parse(post[1].body);
      expect(body.prescriptionId).toBe(367);
      expect('medicines' in body).toBe(false);
    });
    expect(notifySuccess).toHaveBeenCalled();
  });

  it('sends only the picked medicines when not renewing everything', async () => {
    renderPage();
    await screen.findByText(/Prescription #367/);
    const buttons = await screen.findAllByRole('button', { name: /Request renewal/i });
    fireEvent.click(buttons[1]);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/Renew the complete prescription/i));
    fireEvent.click(within(dialog).getByLabelText(/Biotin 10000mcg/i));
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    await waitFor(() => {
      const post = fetchApi.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(JSON.parse(post[1].body).medicines).toEqual(['Biotin 10000mcg']);
    });
  });

  it('flips the card to the pending state after a successful send', async () => {
    renderPage();
    await screen.findByText(/Prescription #366/);
    const buttons = await screen.findAllByRole('button', { name: /Request renewal/i });
    fireEvent.click(buttons[0]); // RX_366

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /Send request/i }));

    // The overlay is re-read, so the card reflects the new state without a
    // manual refresh.
    expect(await screen.findByRole('button', { name: /Renewal pending/i })).toBeDisabled();
  });

  it('portals the composer out of the transformed <main>', async () => {
    // Regression guard for the "dialog opens far above the fold" bug.
    //
    // The app shell's <main> carries `animation: fadeIn ... forwards` whose
    // final frame is `transform: translateY(0)`. Per CSS spec a non-none
    // transform makes an element the containing block for `position: fixed`
    // descendants, so an in-place overlay anchors to the top of main's
    // SCROLLED CONTENT rather than the viewport — click the action on a card
    // far down the list and only the dialog's footer slice is on screen.
    // Rendering through a portal to document.body is the fix; this asserts the
    // dialog really does escape the transformed ancestor.
    const main = document.createElement('main');
    main.style.transform = 'translateY(0)';
    document.body.appendChild(main);
    try {
      render(
        <MemoryRouter>
          <MyPrescriptions />
        </MemoryRouter>,
        { container: main },
      );
      await screen.findByText(/Prescription #366/);
      const buttons = await screen.findAllByRole('button', { name: /Request renewal/i });
      fireEvent.click(buttons[0]);

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

  it('surfaces a backend refusal instead of pretending it worked', async () => {
    fetchApi.mockImplementation(async (url, options) => {
      if (url === MY_RX) {
        return { patient: { id: 2965, name: 'Mohit das' }, prescriptions: [RX_366] };
      }
      if (url === REQ && options?.method === 'POST') {
        throw Object.assign(new Error('You already have a renewal request open'), {
          code: 'REQUEST_ALREADY_OPEN',
        });
      }
      if (url === REQ) return [];
      return {};
    });

    renderPage();
    await screen.findByText(/Prescription #366/);
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

  it('still renders the prescription list when the renewal overlay fails to load', async () => {
    fetchApi.mockImplementation(async (url) => {
      if (url === MY_RX) {
        return { patient: { id: 2965, name: 'Mohit das' }, prescriptions: [RX_366] };
      }
      if (url === REQ) throw new Error('renewals unavailable');
      return {};
    });

    renderPage();
    // The prescriptions are the point of this page — a failed overlay must
    // not blank them.
    expect(await screen.findByText(/Prescription #366/)).toBeInTheDocument();
    expect(screen.getByText('Minoxidil 5%')).toBeInTheDocument();
  });
});
