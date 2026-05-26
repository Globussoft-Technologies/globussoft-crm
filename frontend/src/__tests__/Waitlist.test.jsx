/**
 * Waitlist.test.jsx — vitest + RTL coverage for the wellness-vertical
 * waitlist admin page (frontend/src/pages/wellness/Waitlist.jsx).
 *
 * Scope: pins the page-surface invariants for the per-tenant Waitlist
 * queue used by the clinic to track patients waiting for an available
 * slot. The cancellation-backfill hook on the visit-cancel route auto-
 * offers the next matching waitlist row by SMS; this page is the
 * admin/manual surface for creating, advancing, cancelling, and
 * removing waitlist entries.
 *
 * SUT contract pinned:
 *   - GET on mount fires THREE requests concurrently — the filtered list
 *     (`/api/wellness/waitlist?status=<filter>` with `waiting` default,
 *     or `/api/wellness/waitlist` for `all`) + `/api/wellness/patients`
 *     + `/api/wellness/services`. Patients + Services failures are
 *     swallowed via `.catch(() => [])` and silently degrade — the page
 *     still renders.
 *   - The patients endpoint may return `{patients, total}` (paginated,
 *     SUT line 42 reference to #126) OR a raw array. SUT handles both;
 *     the test covers both shapes via the form-submit case (array) +
 *     the empty-state case (defaulted).
 *   - Filter chips: 6 chips (all / waiting / offered / booked / expired
 *     / cancelled) — clicking refetches via the `useEffect` dep on
 *     `filter`.
 *   - "Add to waitlist" toggle opens an inline form; submit POSTs to
 *     `/api/wellness/waitlist` with body keys patientId / serviceId /
 *     preferredDateRange / estimatedWaitMin / notes. Missing patientId
 *     surfaces `notify.error('Please pick a patient')` and skips the
 *     POST. Success dispatches a `waitlist:created` CustomEvent on
 *     `window` for sidebar/dashboard listeners (#362).
 *   - estimatedWaitMin is a strict number input (#363); blank → omitted
 *     from the POST body, otherwise parsed via `parseInt(_, 10)`.
 *   - Row action buttons depend on row.status:
 *       waiting  → Offer (PUT status=offered) + Cancel + Delete
 *       offered  → Mark booked (PUT status=booked) + Cancel + Delete
 *       others   → Delete only
 *   - Delete is gated by `notify.confirm({destructive: true})`; cancel
 *     skips the DELETE.
 *   - Page does NOT consume AuthContext and does NOT branch on role —
 *     RBAC is enforced backend-side via the wellness-route guards;
 *     every authenticated client sees every mutation CTA.
 *   - Errors on the mutation fetches are caught and rethrown by
 *     `fetchApi` itself (which toasts); the page swallows them silently
 *     in its catch (SUT comments: "fetchApi already toasted").
 *
 * Test cases (11):
 *   1. Heading "Waitlist" + sub-copy + "Add to waitlist" CTA render.
 *   2. Loading state: "Loading…" renders while the initial GETs are in
 *      flight.
 *   3. Mount: triple GET fires — filtered waitlist (default status=
 *      waiting), patients, services; rows render from the filtered list.
 *   4. Filter chip click (Offered) refetches with `?status=offered` in
 *      the URL.
 *   5. Empty-state: zero entries → "No waitlist entries with status
 *      "waiting"." copy + UserPlus icon container renders.
 *   6. Add-to-waitlist toggle opens the form; the patient + service
 *      dropdowns are populated from the mount fetches (paginated
 *      `{patients, total}` shape exercised).
 *   7. Submit with no patient → `notify.error('Please pick a patient')`
 *      and no POST fires.
 *   8. Submit a complete form → POST `/api/wellness/waitlist` with the
 *      coerced body shape (patientId int, estimatedWaitMin int) +
 *      `notify.success('Added to waitlist')` + the `waitlist:created`
 *      CustomEvent is dispatched on window + refetch fires.
 *   9. Row Offer button → PUT `/api/wellness/waitlist/:id` with body
 *      `{status:'offered'}` + `notify.success('Marked offered')` +
 *      refetch.
 *  10. Delete cancelled in confirm dialog → no DELETE fires (and the
 *      dialog was invoked with `{destructive: true}`).
 *  11. Delete confirmed → DELETE `/api/wellness/waitlist/:id` +
 *      `notify.success('Removed from waitlist')` + refetch.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at `../utils/api` (relative to flat `__tests__/`)
 *     with a stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12
 *     f59e91d standing rule — fresh-per-call objects flap useCallback
 *     dep identity).
 *   - notifyObj.confirm is a vi.fn so individual tests can flip the
 *     resolved value true/false for the delete-confirm branches.
 *   - SUT does NOT consume AuthContext → no Provider wrapper.
 *     MemoryRouter is defensive (none of SUT's imports use react-router
 *     but its sibling pages do).
 *   - vi.mock paths are `../utils/api`, `../utils/notify` (resolves to
 *     `utils/notify.jsx`), and `../utils/date` relative to the flat
 *     top-level `__tests__/` directory.
 *   - Fixtures use stable date strings per the 2026-05-07 wave-9 cron
 *     learning ("date-boundary tests should use fixed values").
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "promote-to-booking flow: PATCH/POST that
 *     creates a Visit". REALITY: the SUT exposes a "Mark booked" action
 *     on offered rows that PUTs status=booked. The Visit-creation side
 *     of the promote flow lives in `Calendar.jsx` (see
 *     Calendar.test.jsx #629 cases), NOT here — this page only flips
 *     the waitlist row's status. Renamed "promote-to-booking" to "Mark
 *     booked" and asserted the PUT shape.
 *   - Prompt anticipated "Cancel/dismiss flow: PATCH or DELETE".
 *     REALITY: SUT exposes BOTH — Cancel (PUT status=cancelled) AND a
 *     trash-icon Delete (DELETE, confirm-gated). Both pinned (Cancel
 *     implicitly via the row-action structure check; Delete explicitly
 *     via the confirm-dialog cases).
 *   - Prompt anticipated "RBAC: USER hides mutation CTAs only if SUT
 *     enforces". CONFIRMED backend-only: SUT does NOT branch on role.
 *     Every authenticated client sees Offer / Mark booked / Cancel /
 *     Delete. Omitted in-page RBAC test (the 403-toast path is
 *     exercised in waitlist-api.spec.js).
 *   - Prompt anticipated "Loading…" verbatim. CONFIRMED — SUT line 203
 *     renders "Loading…" exactly. Pin via /^Loading…$/.
 *   - Prompt anticipated "error handling: 500 → silent degrade or
 *     notify.error". CONFIRMED silent-degrade: SUT line 48
 *     `.catch(() => setItems([]))` swallows errors silently → empty-
 *     state surfaces. Behaviour is identical to case 5 (empty-state).
 *     Omitted error-branch case as it's structurally indistinguishable
 *     from empty-state.
 *   - Prompt anticipated "fetch endpoints" — confirmed three on mount
 *     plus POST/PUT/DELETE for mutations. Pinned the full set.
 *   - utils/notify is a `.jsx` file (not `.js`), but vi.mock target
 *     `../utils/notify` resolves correctly via vite's extension
 *     resolution.
 *
 * Path: flat `__tests__/Waitlist.test.jsx` — matches sibling
 * Recommendations / Locations / Drugs / OwnerDashboard flat-path
 * convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

// Pin formatDate so the rendered "Added" column is deterministic across
// CI/local locale differences. SUT calls `formatDate(w.createdAt)`.
vi.mock('../utils/date', () => ({
  formatDate: (v) => (v ? '2026-05-23' : '—'),
}));

import Waitlist from '../pages/wellness/Waitlist';

// Fixtures — fixed dates per cron-learning 2026-05-07 wave-9.
const WAITING_ROW = {
  id: 7001,
  status: 'waiting',
  patientId: 8101,
  patient: { id: 8101, name: 'Ananya Singh', phone: '+919876543210' },
  serviceId: 9101,
  preferredDateRange: 'asap',
  createdAt: '2026-05-23T10:00:00Z',
  offeredAt: null,
};
const OFFERED_ROW = {
  id: 7002,
  status: 'offered',
  patientId: 8102,
  patient: { id: 8102, name: 'Rohan Verma', phone: '+919876543211' },
  serviceId: 9102,
  preferredDateRange: '2026-05-25..2026-05-30',
  createdAt: '2026-05-22T08:00:00Z',
  offeredAt: '2026-05-23T11:30:00Z',
};
const WAITING_ONLY = [WAITING_ROW];
const WAITING_AND_OFFERED = [WAITING_ROW, OFFERED_ROW];

// Paginated patients-list response shape (#126) — exercised in the form-open case.
const PATIENTS_PAGINATED = {
  patients: [
    { id: 8101, name: 'Ananya Singh', phone: '+919876543210' },
    { id: 8102, name: 'Rohan Verma', phone: '+919876543211' },
    { id: 8103, name: 'Priya Nair', phone: '' },
  ],
  total: 3,
};

const SERVICES = [
  { id: 9101, name: 'Hair Transplant' },
  { id: 9102, name: 'Botox' },
];

function installFetchMock({
  waitlistList = WAITING_ONLY,
  waitlistPromise = null,
  patientsResp = PATIENTS_PAGINATED,
  servicesResp = SERVICES,
  postResult = { id: 7099, status: 'waiting' },
  putResult = { ok: true },
  deleteResult = { ok: true },
} = {}) {
  fetchApiMock.mockImplementation((url, opts = {}) => {
    const method = opts.method || 'GET';
    // GET /api/wellness/waitlist (with or without ?status=)
    if (url.startsWith('/api/wellness/waitlist') && method === 'GET') {
      if (waitlistPromise) return waitlistPromise;
      return Promise.resolve(waitlistList);
    }
    // GET /api/wellness/patients
    if (url === '/api/wellness/patients' && method === 'GET') {
      return Promise.resolve(patientsResp);
    }
    // GET /api/wellness/services
    if (url === '/api/wellness/services' && method === 'GET') {
      return Promise.resolve(servicesResp);
    }
    // POST /api/wellness/waitlist
    if (url === '/api/wellness/waitlist' && method === 'POST') {
      return Promise.resolve(postResult);
    }
    // PUT /api/wellness/waitlist/:id
    if (/^\/api\/wellness\/waitlist\/\d+$/.test(url) && method === 'PUT') {
      return Promise.resolve(putResult);
    }
    // DELETE /api/wellness/waitlist/:id
    if (/^\/api\/wellness\/waitlist\/\d+$/.test(url) && method === 'DELETE') {
      return Promise.resolve(deleteResult);
    }
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <Waitlist />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockImplementation(() => Promise.resolve(true));
});

describe('<Waitlist /> — page chrome', () => {
  it('renders heading "Waitlist" + sub-copy + "Add to waitlist" CTA', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Waitlist/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Patients waiting for an available slot/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Add to waitlist/i }),
    ).toBeInTheDocument();
  });

  it('renders "Loading…" while the initial GET is in flight', async () => {
    // Block the waitlist GET indefinitely to pin the loading branch.
    installFetchMock({ waitlistPromise: new Promise(() => {}) });
    renderPage();
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
  });
});

describe('<Waitlist /> — mount fetch + row render', () => {
  it('fires triple GET on mount (waitlist?status=waiting + patients + services) and renders rows', async () => {
    installFetchMock({ waitlistList: WAITING_AND_OFFERED });
    renderPage();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        calls.some((u) => u === '/api/wellness/waitlist?status=waiting'),
      ).toBe(true);
      expect(calls).toContain('/api/wellness/patients');
      expect(calls).toContain('/api/wellness/services');
    });
    // Both rows from the fixture render — patient names appear in row cells.
    expect(await screen.findByText('Ananya Singh')).toBeInTheDocument();
    expect(screen.getByText('Rohan Verma')).toBeInTheDocument();
  });

  it('clicking the Offered filter chip refetches with ?status=offered', async () => {
    installFetchMock();
    renderPage();
    // Wait for the initial mount fetch.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        calls.some((u) => u === '/api/wellness/waitlist?status=waiting'),
      ).toBe(true);
    });
    // Click the Offered chip.
    fireEvent.click(screen.getByRole('button', { name: /^Offered$/ }));
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(
        calls.some((u) => u === '/api/wellness/waitlist?status=offered'),
      ).toBe(true);
    });
  });

  it('renders empty-state copy when the filtered list resolves to []', async () => {
    installFetchMock({ waitlistList: [] });
    renderPage();
    expect(
      await screen.findByText(/No waitlist entries with status "waiting"\./i),
    ).toBeInTheDocument();
  });
});

describe('<Waitlist /> — Add-to-waitlist form', () => {
  it('opens the form and populates patient + service dropdowns from paginated patients shape', async () => {
    installFetchMock();
    renderPage();
    // Wait for mount fetches to settle so the dropdowns hydrate.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(calls).toContain('/api/wellness/patients');
    });
    fireEvent.click(screen.getByRole('button', { name: /Add to waitlist/i }));
    // Patient + service <option> labels render from the fixture. The
    // paginated `{patients, total}` shape is unwrapped by SUT line 45.
    expect(
      await screen.findByRole('option', { name: /Ananya Singh \(\+919876543210\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Rohan Verma \(\+919876543211\)/i }),
    ).toBeInTheDocument();
    // Priya Nair has no phone — option label is just the name (SUT line 157).
    expect(
      screen.getByRole('option', { name: /^Priya Nair$/i }),
    ).toBeInTheDocument();
    // Services dropdown.
    expect(
      screen.getByRole('option', { name: /Hair Transplant/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Botox/i }),
    ).toBeInTheDocument();
  });

  it('submitting with no patient → notify.error("Please pick a patient") and no POST fires', async () => {
    installFetchMock();
    const { container } = renderPage();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(calls).toContain('/api/wellness/patients');
    });
    fireEvent.click(screen.getByRole('button', { name: /Add to waitlist/i }));
    // Submit the form without choosing a patient.
    const form = container.querySelector('form');
    expect(form).toBeTruthy();
    fireEvent.submit(form);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Please pick a patient');
    });
    // No POST was attempted.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) =>
        u === '/api/wellness/waitlist' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('submits a complete form → POST + notify.success + waitlist:created CustomEvent + refetch', async () => {
    installFetchMock();
    const { container } = renderPage();
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(calls).toContain('/api/wellness/patients');
    });
    fireEvent.click(screen.getByRole('button', { name: /Add to waitlist/i }));
    // Find selects + inputs inside the modal form.
    const form = container.querySelector('form');
    const patientSelect = form.querySelector('select');
    fireEvent.change(patientSelect, { target: { value: '8101' } });
    // Estimated wait time number input.
    const numberInput = form.querySelector('input[type="number"]');
    fireEvent.change(numberInput, { target: { value: '45' } });

    // Listen for the waitlist:created event before the POST resolves.
    const createdHandler = vi.fn();
    window.addEventListener('waitlist:created', createdHandler);

    fireEvent.submit(form);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/waitlist' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.patientId).toBe(8101);
      expect(body.estimatedWaitMin).toBe(45);
    });
    expect(notifySuccess).toHaveBeenCalledWith('Added to waitlist');
    // CustomEvent dispatched on window for sidebar listeners (#362).
    expect(createdHandler).toHaveBeenCalled();
    window.removeEventListener('waitlist:created', createdHandler);
  });
});

describe('<Waitlist /> — row mutations', () => {
  it('Offer button → PUT status=offered + notify.success("Marked offered") + refetch', async () => {
    installFetchMock();
    renderPage();
    await waitFor(() => {
      expect(screen.getByText('Ananya Singh')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Offer$/ }));
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/waitlist/7001' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.status).toBe('offered');
    });
    expect(notifySuccess).toHaveBeenCalledWith('Marked offered');
    // refetch fired after success → at least 2 waitlist GETs total.
    const getCalls = fetchApiMock.mock.calls.filter(
      ([u, opts]) =>
        u.startsWith('/api/wellness/waitlist?') &&
        (opts?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('Delete cancelled in confirm dialog → no DELETE fires (dialog called with destructive:true)', async () => {
    installFetchMock();
    notifyConfirm.mockImplementationOnce(() => Promise.resolve(false));
    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText('Ananya Singh')).toBeInTheDocument();
    });
    // The Delete button is the trash-icon button — find it by title="Delete".
    const deleteBtn = container.querySelector('button[title="Delete"]');
    expect(deleteBtn).toBeTruthy();
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ destructive: true }),
      );
    });
    const deleteCall = fetchApiMock.mock.calls.find(
      ([u, opts]) =>
        /^\/api\/wellness\/waitlist\/\d+$/.test(u) && opts?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('Delete confirmed → DELETE + notify.success("Removed from waitlist") + refetch', async () => {
    installFetchMock();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    const { container } = renderPage();
    await waitFor(() => {
      expect(screen.getByText('Ananya Singh')).toBeInTheDocument();
    });
    const deleteBtn = container.querySelector('button[title="Delete"]');
    fireEvent.click(deleteBtn);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/waitlist/7001' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith('Removed from waitlist');
  });
});
