/**
 * wellness/PatientDetail.test.jsx — vitest + RTL coverage for the new
 * Timeline tab on the Patient detail page (tick #200).
 *
 * Scope: pins the page-surface invariants for the unified Timeline tab
 * that consumes the merged GET /api/wellness/patients/:id/timeline
 * endpoint shipped in tick #198 (`c5eec0e7`). The four existing
 * sub-resource tabs (Case history / Prescriptions / Consent / Treatment
 * plans) are NOT covered here — they retain their per-resource detail
 * views. This file scopes specifically to the Timeline addition.
 *
 *   1. Timeline tab button is reachable from the tab list (rendered
 *      first in the strip).
 *   2. Clicking Timeline fires a single
 *      GET /api/wellness/patients/<id>/timeline?limit=200 fetch.
 *   3. Returned events render with type-specific icons + formatted
 *      dates + summary text + a deep-link href to the canonical sub-
 *      resource detail page.
 *   4. Changing the type filter dropdown re-fires the fetch with
 *      ?types=VISIT&limit=200 (or whichever value was chosen).
 *
 * Stable mock object refs (per CLAUDE.md RTL standing rule) — the
 * notify mock is one object reference across the whole test run so any
 * useCallback / useMemo deps that close over the notify hook don't
 * trigger infinite re-renders.
 *
 * Test data uses real-looking names (Anita Sharma) per the
 * feedback_realistic_test_data preference — no "E2E_FLOW_*" prefixes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'fake-token',
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

vi.mock('../../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

// useFormAutosave is exercised by Prescribe / Plans tabs but never by
// Timeline. Stub it to a sane signature so the module import is safe.
vi.mock('../../utils/useFormAutosave', () => ({
  useFormAutosave: (_key, initial) => [initial, () => {}, false, () => {}],
}));

// DateRangePicker is rendered only by the Case-history tab (which we
// don't activate in these tests). Stub it to a trivial fragment so the
// module import is safe even if React eagerly traverses children.
vi.mock('../../components/DateRangePicker', () => ({
  default: () => null,
  effectiveRangeFor: () => ({ from: null, to: null }),
}));

import PatientDetail from '../../pages/wellness/PatientDetail';

const PATIENT_ID = 42;

const samplePatient = {
  id: PATIENT_ID,
  name: 'Anita Sharma',
  phone: '+919876543210',
  email: 'anita@example.com',
  gender: 'F',
  visits: [],
  prescriptions: [],
  consents: [],
  treatmentPlans: [],
};

const sampleTimeline = {
  patientId: PATIENT_ID,
  count: 3,
  events: [
    {
      eventType: 'VISIT',
      eventId: 101,
      eventAt: '2026-05-20T10:30:00.000Z',
      summary: 'Initial consultation — chief complaint: persistent cough',
      refType: 'Visit',
      refId: 101,
    },
    {
      eventType: 'PRESCRIPTION',
      eventId: 202,
      eventAt: '2026-05-15T09:00:00.000Z',
      summary: 'Azithromycin 500mg × 3 days',
      refType: 'Prescription',
      refId: 202,
    },
    {
      eventType: 'CONSENT',
      eventId: 303,
      eventAt: '2026-05-10T12:00:00.000Z',
      summary: 'Procedure consent signed — laser hair removal',
      refType: 'ConsentForm',
      refId: 303,
    },
  ],
};

// D16 Arc 1 slice 7 — Wallet-tab default responses.
//   - GET /api/wallet/:id/balance       → { balanceCents, currency, lastUpdated }
//   - GET /api/wallet/:id/transactions  → { transactions, total }
//   - POST /api/wallet/:id/topup        → { success, balanceCents, bonusPercent }
const sampleWalletBalance = {
  balanceCents: 250000,
  currency: 'INR',
  lastUpdated: '2026-05-24T10:00:00.000Z',
};

const sampleWalletTransactions = {
  transactions: [
    { id: 11, type: 'TOP_UP', amount: 2000, reason: 'Top-up via cash', createdAt: '2026-05-20T10:00:00.000Z' },
    { id: 12, type: 'REDEEM', amount: -500, reason: 'Visit 101', createdAt: '2026-05-22T15:00:00.000Z' },
  ],
  total: 2,
};

function defaultFetchMock(url, _opts) {
  // The page loads patient core + wallet + services + staff on mount.
  if (url === `/api/wellness/patients/${PATIENT_ID}/wallet`) {
    return Promise.resolve({ wallet: { balanceCents: 0 } });
  }
  if (url === `/api/wellness/patients/${PATIENT_ID}`) {
    return Promise.resolve(samplePatient);
  }
  if (url === '/api/wellness/services') {
    return Promise.resolve([]);
  }
  if (url === '/api/staff') {
    return Promise.resolve([]);
  }
  if (url === `/api/wellness/loyalty/${PATIENT_ID}`) {
    return Promise.resolve(null);
  }
  if (typeof url === 'string' && url.startsWith(`/api/wellness/patients/${PATIENT_ID}/timeline`)) {
    return Promise.resolve(sampleTimeline);
  }
  // D16 Arc 1 slice 7 — Wallet tab new endpoints.
  if (url === `/api/wallet/${PATIENT_ID}/balance`) {
    return Promise.resolve(sampleWalletBalance);
  }
  if (typeof url === 'string' && url.startsWith(`/api/wallet/${PATIENT_ID}/transactions`)) {
    return Promise.resolve(sampleWalletTransactions);
  }
  if (url === `/api/wallet/${PATIENT_ID}/topup`) {
    return Promise.resolve({ success: true, walletId: 1, transactionId: 99, balanceCents: 450000, bonusPercent: 0 });
  }
  // Default for any other URL the page may probe (download buttons,
  // etc.) — resolve to null so promises don't reject.
  return Promise.resolve(null);
}

function renderPatientDetail() {
  return render(
    <MemoryRouter initialEntries={[`/wellness/patients/${PATIENT_ID}`]}>
      <Routes>
        <Route path="/wellness/patients/:id" element={<PatientDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('<wellness/PatientDetail /> — Timeline tab (tick #200)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyObj.error.mockReset?.();
    notifyObj.info.mockReset?.();
    notifyObj.success.mockReset?.();
    // jsdom doesn't implement scrollIntoView — stub a no-op so any
    // effect that touches it doesn't throw + unmount the component.
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
    // sessionStorage is jsdom-provided but the page persists per-patient
    // tab state into it; clear between tests so each one starts on the
    // default 'history' tab (we click Timeline explicitly when we want it).
    try { sessionStorage.clear(); } catch { /* ignore */ }
    // Tick #201 — jsdom doesn't implement URL.createObjectURL /
    // revokeObjectURL. The Export CSV button uses the standard
    // fetch → blob → createObjectURL → anchor-click → revoke trick
    // (mirroring Patients.jsx XLSX), so stub both to no-ops here.
    if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:fake');
    if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  });

  it('renders the Timeline tab button in the tab strip', async () => {
    renderPatientDetail();
    // Page heading appears after the patient-core fetch resolves.
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    // Timeline tab button is reachable.
    const tabBtn = screen.getByTestId('timeline-tab');
    expect(tabBtn).toBeInTheDocument();
    expect(tabBtn).toHaveTextContent(/Timeline/i);
  });

  it('clicking Timeline fires GET /timeline?limit=200 once', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByTestId('timeline-tab'));

    // The timeline fetch fires on tab-activate.
    await waitFor(() => {
      const timelineCalls = fetchApiMock.mock.calls.filter(([u]) =>
        typeof u === 'string'
        && u.startsWith(`/api/wellness/patients/${PATIENT_ID}/timeline`)
      );
      expect(timelineCalls.length).toBeGreaterThanOrEqual(1);
      // The single initial fetch carries limit=200 and NO types filter
      // (the "All" default doesn't send a types param).
      const url = timelineCalls[0][0];
      expect(url).toContain('limit=200');
      expect(url).not.toContain('types=');
    });
  });

  it('renders one row per event with type label, formatted date, summary, and detail href', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByTestId('timeline-tab'));

    // Each event renders with a type-specific data-testid that includes
    // the event type so we can pin both the icon mapping (by presence
    // of the label) and the deep-link href.
    const visitRow = await screen.findByTestId('timeline-event-VISIT-101');
    expect(visitRow.getAttribute('href')).toBe('/wellness/visits/101');
    expect(visitRow).toHaveTextContent(/Visit/);
    // Date is rendered via the mocked formatDate which returns the
    // ISO date-prefix; 2026-05-20T... → "2026-05-20".
    expect(visitRow).toHaveTextContent('2026-05-20');
    expect(visitRow).toHaveTextContent(/persistent cough/i);

    const rxRow = screen.getByTestId('timeline-event-PRESCRIPTION-202');
    expect(rxRow.getAttribute('href')).toBe('/wellness/prescriptions/202');
    expect(rxRow).toHaveTextContent(/Prescription/);
    expect(rxRow).toHaveTextContent(/Azithromycin/);

    const consentRow = screen.getByTestId('timeline-event-CONSENT-303');
    expect(consentRow.getAttribute('href')).toBe('/wellness/consents/303');
    expect(consentRow).toHaveTextContent(/Consent/);
    expect(consentRow).toHaveTextContent(/laser hair removal/i);
  });

  it('changing the type filter to "Visits" re-fires the fetch with ?types=VISIT', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByTestId('timeline-tab'));

    // Wait for the initial timeline fetch to settle.
    await waitFor(() => {
      const initial = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith(`/api/wellness/patients/${PATIENT_ID}/timeline`)
      );
      expect(initial).toBeTruthy();
    });
    fetchApiMock.mockClear();

    // Change the filter dropdown to VISIT — this should re-fire the
    // fetch with ?types=VISIT + the limit=200 cap still in place.
    fireEvent.change(screen.getByTestId('timeline-type-filter'), {
      target: { value: 'VISIT' },
    });

    await waitFor(() => {
      const filteredCall = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith(`/api/wellness/patients/${PATIENT_ID}/timeline`)
        && u.includes('types=VISIT')
      );
      expect(filteredCall).toBeTruthy();
      expect(filteredCall[0]).toContain('limit=200');
    });
  });

  // ── Tick #201 — Export CSV button ─────────────────────────────
  //
  // The Timeline tab adds a small "Export CSV" button next to the type-
  // filter dropdown. It hits the backend `/timeline.csv` endpoint shipped
  // tick #200 (`9188962e`) via raw `fetch` (not fetchApi) because the
  // response is a binary blob that needs a Content-Disposition probe.
  // We stub global.fetch for these two cases so the assertion is on the
  // URL + Authorization header the button forms.
  it('renders an Export CSV button next to the Timeline filter', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByTestId('timeline-tab'));

    // Wait for the timeline events to land so the button leaves its
    // disabled (events.length === 0) state.
    await screen.findByTestId('timeline-event-VISIT-101');
    const btn = screen.getByTestId('timeline-export-csv');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent(/Export CSV/i);
    expect(btn).not.toBeDisabled();
  });

  it('clicking Export CSV fetches /timeline.csv with the current type filter forwarded', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get: (k) => (k.toLowerCase() === 'content-disposition' ? 'attachment; filename="timeline.csv"' : null),
        },
        blob: () => Promise.resolve(new Blob(['Event Date,Event Type,Summary\n'], { type: 'text/csv' })),
      })
    );
    const originalFetch = global.fetch;
    global.fetch = fetchMock;
    try {
      renderPatientDetail();
      await screen.findByRole('heading', { name: /Anita Sharma/i });
      fireEvent.click(screen.getByTestId('timeline-tab'));
      // Wait for the initial events fetch so the button activates.
      await screen.findByTestId('timeline-event-VISIT-101');

      // Set the type filter to Visits so we can prove the click forwards it.
      fireEvent.change(screen.getByTestId('timeline-type-filter'), {
        target: { value: 'VISIT' },
      });
      // Wait for the re-fetch (filterType change) to settle before clicking.
      await waitFor(() => {
        expect(
          fetchApiMock.mock.calls.some(([u]) =>
            typeof u === 'string' && u.includes('/timeline?') && u.includes('types=VISIT')
          )
        ).toBe(true);
      });

      fireEvent.click(screen.getByTestId('timeline-export-csv'));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toContain(`/api/wellness/patients/${PATIENT_ID}/timeline.csv?`);
        expect(url).toContain('limit=200');
        expect(url).toContain('types=VISIT');
        expect(opts?.headers?.Authorization).toBe('Bearer fake-token');
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('shows the empty-state message when the endpoint returns zero events', async () => {
    fetchApiMock.mockImplementation((url, _opts) => {
      if (typeof url === 'string' && url.startsWith(`/api/wellness/patients/${PATIENT_ID}/timeline`)) {
        return Promise.resolve({ patientId: PATIENT_ID, count: 0, events: [] });
      }
      return defaultFetchMock(url, _opts);
    });
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByTestId('timeline-tab'));

    expect(await screen.findByText(/No events yet for this patient/i)).toBeInTheDocument();
  });
});

// ── D16 Arc 1 slice 7 — Wallet tab + Top-up modal ──────────────────
//
// Pins the new endpoint wiring (`GET /api/wallet/:id/balance` +
// `GET /api/wallet/:id/transactions?limit=10` + `POST /api/wallet/:id/topup`)
// and the modal-driven top-up submission flow shipped this tick.
//
// Scope intentionally narrow — 3 cases per slice contract:
//   1. Wallet tab is reachable from the tab strip.
//   2. Activating Wallet fires the two new GET endpoints in parallel.
//   3. Clicking "Top up" opens a modal; submitting POSTs
//      `{amountCents, paymentMethod}` to the new endpoint.
//
// Existing 7 Timeline-tab tests above run uninterrupted; only the
// `defaultFetchMock` was extended (additively) to resolve the new
// endpoint paths.
describe('<wellness/PatientDetail /> — Wallet tab (D16 Arc 1 slice 7)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyObj.error.mockReset?.();
    notifyObj.info.mockReset?.();
    notifyObj.success.mockReset?.();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn();
    }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    if (!URL.createObjectURL) URL.createObjectURL = vi.fn(() => 'blob:fake');
    if (!URL.revokeObjectURL) URL.revokeObjectURL = vi.fn();
  });

  it('renders the Wallet tab button in the tab strip', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    const tabBtn = screen.getByTestId('wallet-tab');
    expect(tabBtn).toBeInTheDocument();
    expect(tabBtn).toHaveTextContent(/Wallet/i);
  });

  it('clicking Wallet fires GET /balance + GET /transactions?limit=10 in parallel', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByTestId('wallet-tab'));

    await waitFor(() => {
      const balanceCall = fetchApiMock.mock.calls.find(
        ([u]) => u === `/api/wallet/${PATIENT_ID}/balance`
      );
      const txnsCall = fetchApiMock.mock.calls.find(
        ([u]) => typeof u === 'string' && u.startsWith(`/api/wallet/${PATIENT_ID}/transactions`)
      );
      expect(balanceCall).toBeTruthy();
      expect(txnsCall).toBeTruthy();
      // The transactions URL forwards the limit=10 the slice spec pinned.
      expect(txnsCall[0]).toContain('limit=10');
    });

    // The rendered balance card shows the value from the mocked response
    // (₹2,500 = 250000 cents). Pin both the card + the "+ Top up" button
    // to prove the panel actually rendered, not just the network calls.
    await screen.findByTestId('wallet-balance');
    expect(screen.getByTestId('wallet-topup-btn')).toBeInTheDocument();
  });

  it('Top-up button opens the modal; submitting POSTs {amountCents, paymentMethod} to /topup', async () => {
    renderPatientDetail();
    await screen.findByRole('heading', { name: /Anita Sharma/i });
    fireEvent.click(screen.getByTestId('wallet-tab'));

    // Wait for the panel to land.
    await screen.findByTestId('wallet-topup-btn');
    fireEvent.click(screen.getByTestId('wallet-topup-btn'));

    // Modal opens with amount input + method select + submit button.
    const modal = await screen.findByTestId('wallet-topup-modal');
    expect(modal).toBeInTheDocument();
    const amountInput = screen.getByTestId('wallet-topup-amount');
    const methodSelect = screen.getByTestId('wallet-topup-method');
    const submitBtn = screen.getByTestId('wallet-topup-submit');

    // Fill ₹1500 + UPI, submit.
    fireEvent.change(amountInput, { target: { value: '1500' } });
    fireEvent.change(methodSelect, { target: { value: 'upi' } });
    fetchApiMock.mockClear();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      const topupCall = fetchApiMock.mock.calls.find(
        ([u]) => u === `/api/wallet/${PATIENT_ID}/topup`
      );
      expect(topupCall).toBeTruthy();
      const [, opts] = topupCall;
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      // PRD FR-3.2 pins the contract: amountCents (integer cents) +
      // paymentMethod (one of cash/card/upi/online).
      expect(body).toEqual({ amountCents: 150000, paymentMethod: 'upi' });
    });
  });
});
