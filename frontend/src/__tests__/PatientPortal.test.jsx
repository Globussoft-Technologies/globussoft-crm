/**
 * PatientPortal.test.jsx — vitest + RTL coverage for the public-facing
 * wellness Patient Portal (frontend/src/pages/wellness/PatientPortal.jsx).
 *
 * Scope: pins the page-surface invariants for the PUBLIC phone+OTP portal —
 * a distinct surface from the staff CRM (no AuthContext, uses raw fetch with
 * its own Bearer token persisted in localStorage under `patientPortalToken`).
 * Two top-level states: pre-login (<Login/>) and authenticated (<Dashboard/>).
 * Login is a two-stage phone → OTP flow gated on a `/portal/health` probe of
 * the tenant's SMS provider configuration. The Dashboard loads `/portal/me`
 * + `/portal/visits` + `/portal/prescriptions` in parallel and renders 4
 * tabs (My Visits / Prescriptions / Treatment Plan / Consent Forms).
 *
 * Test cases (11):
 *   1. Pre-login chrome: heading "Patient Portal" + intro copy + phone input
 *      render when no portal token is in localStorage. Health probe to
 *      /api/wellness/portal/health fires on mount.
 *   2. SMS provider not configured (health returns smsConfigured:false) →
 *      graceful-degrade alert renders, phone form is hidden.
 *   3. Phone-stage validation: <10 digits → inline error, no request-otp
 *      POST fires.
 *   4. Valid phone → POST /portal/login/request-otp body {phone}, advances
 *      to OTP stage which renders the 4-digit code input + the patient's
 *      phone in the prompt.
 *   5. OTP-stage validation: non-4-digit input → inline error, no verify
 *      POST fires.
 *   6. OTP verify success → POST /portal/login/verify-otp body {phone, otp},
 *      stores returned token + patient name in localStorage, then transitions
 *      to the Dashboard (renders "Welcome, <name>").
 *   7. OTP verify with expired/invalid code → friendly "Invalid or expired"
 *      error rendered, no token stored.
 *   8. Dashboard fetch: /portal/me + /portal/me/permissions called in parallel
 *      with Bearer token; the Rx fetch is gated on `my_prescriptions.read`.
 *      The "My Visits" tab embeds <MyBookings/> which fetches
 *      /portal/appointments?bucket=<bucket> and renders appointment cards
 *      (service name + doctor + status). [Updated for refactor 815a8783 — the
 *      old direct /portal/visits fetch + inline visits list were removed.]
 *   9. Empty upcoming bucket → MyBookings per-bucket empty-state copy ("No
 *      upcoming appointments") renders. [Was "No visits on record yet."
 *      pre-815a8783.]
 *  10. Prescriptions tab renders Rx rows with drug bullets (parsed from the
 *      JSON-string `drugs` column) and the Download PDF button.
 *  11. Logout button clears the token + name from localStorage and returns
 *      the surface to the Login screen.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - SUT uses raw `fetch` (NOT fetchApi from utils/api) — we stub
 *     `globalThis.fetch` per-test rather than vi.mock the utils.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d) —
 *     fresh-per-call objects flap useCallback / useEffect identity. Only the
 *     Dashboard's `downloadRx` actually invokes notify; nothing in the
 *     primary flows depends on it but we mock for safety.
 *   - vi.mock path is `../utils/notify` + `../utils/date` relative to the
 *     flat top-level `__tests__/` directory.
 *   - localStorage is reset in beforeEach so each test sees the pre-login
 *     state by default; the Dashboard-state tests pre-seed the token.
 *   - Dates use fixed ISO strings (per CLAUDE.md cron-learning 2026-05-07
 *     wave-9) so locale-rendered output stays stable.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated a single POST `/portal/login`. REALITY: the flow
 *     is split into TWO endpoints — `/portal/login/request-otp` (stage:
 *     phone → otp) and `/portal/login/verify-otp` (issues the bearer token).
 *     The legacy `/portal/login` endpoint exists on the backend but the SUT
 *     does NOT call it; tests pin the request-otp + verify-otp pair.
 *   - Prompt anticipated AuthContext consumption. REALITY: the portal is a
 *     standalone public entry point — it uses its OWN bearer token stored
 *     under `patientPortalToken` in localStorage, never touches AuthContext.
 *     No `<AuthContext.Provider>` wrapper needed.
 *   - Prompt anticipated `fetchApi` from utils/api. REALITY: SUT defines its
 *     own `portalFetch` helper (inline at top of SUT) wrapping raw `fetch`.
 *     Tests stub `globalThis.fetch` directly.
 *   - Prompt anticipated invoice/treatment-plan/consent-form list endpoints.
 *     REALITY (post-815a8783): the Dashboard fetches `/portal/me` +
 *     `/portal/me/permissions` in parallel, then `/portal/prescriptions`
 *     (gated on `my_prescriptions.read`) and the shop endpoints (gated on
 *     `products.read`). Visits/appointments are fetched by the embedded
 *     <MyBookings/> via `/portal/appointments?bucket=<bucket>` — there is NO
 *     direct `/portal/visits` fetch anymore. The Treatment Plan + Consent
 *     Forms tabs are
 *     PLACEHOLDER pages ("Your treatment plan will appear here once your
 *     doctor shares one." / "Consent forms you've signed at the clinic will
 *     appear here.") — no backend endpoints, no data fetch. Tests verify
 *     the placeholder copy renders but do NOT assert fetches the SUT never
 *     makes.
 *   - Prompt anticipated demo-OTP env-gated path. REALITY: that's a BACKEND
 *     concern (WELLNESS_DEMO_OTP env var gates the backend's verify-otp
 *     bypass); the frontend's OTP input + POST body shape is identical
 *     regardless of which OTP value the user types. No frontend branch to
 *     test — covered by the backend route gate spec.
 *   - SUT validates phone as ">=10 digits" (digit-stripped), NOT strict
 *     E.164. Test pins the actual SUT contract, not the prompt's hypothesis.
 *   - SUT validates OTP as `/^\d{4}$/` — 4 digits (not 6); tests pin this.
 *   - The Login component's smsConfigured probe is null-then-bool, so the
 *     phone form renders ONLY after smsConfigured === true OR while still
 *     null (the SUT shows `smsConfigured !== false && stage === 'phone'`).
 *     Tests await the probe resolution before interacting.
 *
 * Path: flat `__tests__/PatientPortal.test.jsx` — matches the tick #133
 * prompt path mandate. Sibling Agent B is authoring PublicBooking.test.jsx
 * in the same directory (disjoint file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// Stable notify object — RTL standing rule (Wave 11 cfb5789, Wave 12 f59e91d).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

// Stable date formatter — tests use fixed ISO strings, render as YYYY-MM-DD.
vi.mock('../utils/date', () => ({
  formatDate: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—'),
}));

import PatientPortal from '../pages/wellness/PatientPortal';

const PORTAL_TOKEN_KEY = 'patientPortalToken';
const PORTAL_NAME_KEY = 'patientPortalName';

const PATIENT_PROFILE = {
  id: 501,
  name: 'Priya Sharma',
  phone: '9812345678',
  email: 'priya@example.com',
};

const PRESCRIPTIONS_PAYLOAD = [
  {
    id: 7001,
    createdAt: '2026-04-15T10:30:00.000Z',
    instructions: 'Apply twice daily after wash.',
    drugs: JSON.stringify([
      { name: 'Minoxidil 5%', dosage: '1 ml', frequency: 'bd', duration: '3 months' },
      { name: 'Finasteride', dosage: '1 mg', frequency: 'od', duration: '3 months' },
    ]),
    doctor: { name: 'Harsh' },
    visit: { service: { name: 'Hair PRP' } },
  },
];

// Drift (refactor 815a8783): the Dashboard no longer fetches /portal/visits
// directly. The "My Visits" tab now embeds the shared <MyBookings /> component
// which fetches /portal/appointments?bucket=<bucket> for each of four buckets
// (upcoming/pending/completed/cancelled) and renders appointment cards. The
// portal also resolves /portal/me/permissions and gates the Prescriptions +
// Shop tabs on those permissions. The Dashboard tests below mock both.
const PORTAL_PERMISSIONS = ['my_prescriptions.read'];

// Appointments keyed by MyBookings bucket. Only "upcoming" carries rows by
// default so the default-bucket render shows cards; others are empty.
const APPOINTMENTS_BY_BUCKET = {
  upcoming: [
    {
      id: 8001,
      appointmentDate: '2026-06-15T10:00:00.000Z',
      status: 'booked',
      doctorName: 'Dr Harsh',
      doctorAssigned: true,
      serviceName: 'Hair PRP',
      canReschedule: true,
      canCancel: true,
    },
  ],
  pending: [],
  completed: [],
  cancelled: [],
};

/**
 * Build a fetch stub keyed by URL pattern. Each test installs its own variant
 * via `installFetchMock({ overrides })` to model failure modes.
 */
function installFetchMock({
  smsConfigured = true,
  requestOtpStatus = 200,
  verifyOtpStatus = 200,
  verifyOtpError = 'Invalid or expired OTP',
  prescriptions = PRESCRIPTIONS_PAYLOAD,
  permissions = PORTAL_PERMISSIONS,
  appointmentsByBucket = APPOINTMENTS_BY_BUCKET,
  // Default empty so existing tests see NO notifications tab change; the
  // notification-specific tests below pass a populated payload.
  notificationsPayload = { notifications: [], unreadCount: 0, count: 0 },
} = {}) {
  const jsonRes = (body) => Promise.resolve({
    ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: () => Promise.resolve(body),
  });
  const fetchStub = vi.fn((url, opts = {}) => {
    const method = opts.method || 'GET';
    // Patient notification inbox (Option A) — GET list / PUT read / POST mark-all.
    if (url === '/api/wellness/portal/me/notifications' && method === 'GET') {
      return jsonRes(notificationsPayload);
    }
    if (typeof url === 'string' && /\/api\/wellness\/portal\/me\/notifications\/\d+\/read$/.test(url) && method === 'PUT') {
      return jsonRes({ id: Number(url.match(/\/(\d+)\/read$/)[1]), isRead: true });
    }
    if (url === '/api/wellness/portal/me/notifications/mark-all-read' && method === 'POST') {
      return jsonRes({ success: true, marked: notificationsPayload.unreadCount || 0 });
    }
    if (url === '/api/wellness/portal/health') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ smsConfigured }),
      });
    }
    if (url === '/api/wellness/portal/login/request-otp' && method === 'POST') {
      const ok = requestOtpStatus >= 200 && requestOtpStatus < 300;
      return Promise.resolve({
        ok,
        status: requestOtpStatus,
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve(ok ? { ok: true } : { error: 'Failed to send code' }),
      });
    }
    if (url === '/api/wellness/portal/login/verify-otp' && method === 'POST') {
      const ok = verifyOtpStatus >= 200 && verifyOtpStatus < 300;
      return Promise.resolve({
        ok,
        status: verifyOtpStatus,
        headers: new Map([['content-type', 'application/json']]),
        json: () =>
          Promise.resolve(
            ok
              ? { token: 'patient-bearer-token-abc', patient: PATIENT_PROFILE }
              : { error: verifyOtpError },
          ),
      });
    }
    if (url === '/api/wellness/portal/me' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(PATIENT_PROFILE),
      });
    }
    if (url === '/api/wellness/portal/me/permissions' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ permissions }),
      });
    }
    // MyBookings (embedded in the visits tab) fetches one bucket at a time:
    // /portal/appointments?bucket=<bucket>.
    if (typeof url === 'string' && url.startsWith('/api/wellness/portal/appointments?bucket=') && method === 'GET') {
      const bucket = url.split('bucket=')[1];
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({ appointments: appointmentsByBucket[bucket] || [] }),
      });
    }
    if (url === '/api/wellness/portal/prescriptions' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve(prescriptions),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({}),
    });
  });
  globalThis.fetch = fetchStub;
  return fetchStub;
}

beforeEach(() => {
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  localStorage.clear();
});

afterEach(() => {
  delete globalThis.fetch;
});

describe('<PatientPortal /> — pre-login chrome', () => {
  it('renders the heading + phone input on initial mount; health probe fires', async () => {
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    expect(
      await screen.findByRole('heading', { name: /Patient Portal/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Access your visits, prescriptions, and treatment plans/i),
    ).toBeInTheDocument();
    // The smsConfigured probe fires on mount. SUT invokes raw fetch with
    // NO second arg for this probe (the useEffect calls `fetch(url)` not
    // `fetch(url, opts)`), so assert URL-only.
    await waitFor(() => {
      const healthCall = fetchStub.mock.calls.find(
        ([u]) => u === '/api/wellness/portal/health',
      );
      expect(healthCall).toBeTruthy();
    });
    // Phone input renders once the probe resolves (smsConfigured === true).
    expect(
      await screen.findByPlaceholderText(/10-digit mobile number/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send code/i })).toBeInTheDocument();
  });

  it('SMS provider unavailable → graceful-degrade alert, phone form hidden', async () => {
    installFetchMock({ smsConfigured: false });
    render(<PatientPortal />);
    expect(
      await screen.findByTestId('portal-sms-unavailable'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Phone-OTP login is temporarily unavailable/i),
    ).toBeInTheDocument();
    // Phone form should NOT render in this state.
    expect(screen.queryByPlaceholderText(/10-digit mobile number/i)).toBeNull();
  });
});

describe('<PatientPortal /> — phone stage', () => {
  it('fewer than 10 digits → inline error, no request-otp POST fired', async () => {
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    const phoneInput = await screen.findByPlaceholderText(/10-digit mobile number/i);
    fireEvent.change(phoneInput, { target: { value: '98765' } });
    fireEvent.click(screen.getByRole('button', { name: /Send code/i }));
    expect(
      await screen.findByText(/Enter a valid 10-digit phone number/i),
    ).toBeInTheDocument();
    // No POST to request-otp fired.
    const postCall = fetchStub.mock.calls.find(
      ([u, opts]) =>
        u === '/api/wellness/portal/login/request-otp' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('valid phone → POST request-otp body {phone}, advances to OTP stage', async () => {
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    const phoneInput = await screen.findByPlaceholderText(/10-digit mobile number/i);
    fireEvent.change(phoneInput, { target: { value: '9812345678' } });
    fireEvent.click(screen.getByRole('button', { name: /Send code/i }));
    await waitFor(() => {
      const postCall = fetchStub.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/portal/login/request-otp' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall[1].body)).toEqual({ phone: '9812345678' });
    });
    // Now on OTP stage — 4-digit input renders + phone shown in prompt.
    expect(
      await screen.findByPlaceholderText(/4-digit code/i),
    ).toBeInTheDocument();
    // The prompt copy contains the phone number — getAllByText to tolerate
    // ancestor wrappers that aggregate the same text content.
    expect(
      screen.getAllByText((_t, el) => {
        const text = el?.textContent || '';
        return (
          /Enter the 4-digit code we sent to/i.test(text) &&
          /9812345678/.test(text)
        );
      }).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('<PatientPortal /> — OTP stage', () => {
  async function advanceToOtpStage() {
    const phoneInput = await screen.findByPlaceholderText(/10-digit mobile number/i);
    fireEvent.change(phoneInput, { target: { value: '9812345678' } });
    fireEvent.click(screen.getByRole('button', { name: /Send code/i }));
    return screen.findByPlaceholderText(/4-digit code/i);
  }

  it('non-4-digit OTP → inline error, no verify POST fired', async () => {
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    const otpInput = await advanceToOtpStage();
    fireEvent.change(otpInput, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & enter/i }));
    // The error message AND the prompt copy both contain "4-digit code" —
    // findAllByText to disambiguate, then assert the error-style leaf renders
    // (red `errStyle` div is a sibling of the input).
    const matches = await screen.findAllByText(/Enter the 4-digit code/i);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // No verify POST.
    const verifyCall = fetchStub.mock.calls.find(
      ([u, opts]) =>
        u === '/api/wellness/portal/login/verify-otp' && opts?.method === 'POST',
    );
    expect(verifyCall).toBeUndefined();
  });

  it('successful OTP verify → token persisted, transitions to Dashboard', async () => {
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    const otpInput = await advanceToOtpStage();
    fireEvent.change(otpInput, { target: { value: '4321' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & enter/i }));
    // verify-otp POSTed with {phone, otp}.
    await waitFor(() => {
      const verifyCall = fetchStub.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/portal/login/verify-otp' && opts?.method === 'POST',
      );
      expect(verifyCall).toBeTruthy();
      expect(JSON.parse(verifyCall[1].body)).toEqual({
        phone: '9812345678',
        otp: '4321',
      });
    });
    // Token + name persisted to localStorage.
    await waitFor(() => {
      expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBe('patient-bearer-token-abc');
    });
    expect(localStorage.getItem(PORTAL_NAME_KEY)).toBe('Priya Sharma');
    // Dashboard renders — Welcome message in header. findAllByText to
    // tolerate ancestor wrappers that aggregate the same text content.
    const welcomeNodes = await screen.findAllByText((_t, el) =>
      /Welcome,\s*Priya Sharma/i.test(el?.textContent || ''),
    );
    expect(welcomeNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('expired/invalid OTP → friendly "Invalid or expired" error, no token stored', async () => {
    installFetchMock({ verifyOtpStatus: 401, verifyOtpError: 'OTP expired' });
    render(<PatientPortal />);
    const otpInput = await advanceToOtpStage();
    fireEvent.change(otpInput, { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & enter/i }));
    expect(
      await screen.findByText(/Invalid or expired code\. Try resending\./i),
    ).toBeInTheDocument();
    // No token stored.
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
  });
});

describe('<PatientPortal /> — authenticated dashboard', () => {
  beforeEach(() => {
    // Pre-seed an authenticated session so PatientPortal lands on Dashboard.
    localStorage.setItem(PORTAL_TOKEN_KEY, 'seeded-token');
    localStorage.setItem(PORTAL_NAME_KEY, 'Priya Sharma');
  });

  it('loads /portal/me + /me/permissions + /prescriptions with Bearer token; visits (appointments) render', async () => {
    // Drift (815a8783): the dashboard now resolves /portal/me +
    // /portal/me/permissions in parallel (NOT /portal/visits), then gates the
    // Rx fetch on `my_prescriptions.read`. The "My Visits" tab embeds
    // <MyBookings/> which fetches /portal/appointments?bucket=<bucket>.
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    await waitFor(() => {
      const meCall = fetchStub.mock.calls.find(
        ([u]) => u === '/api/wellness/portal/me',
      );
      const permsCall = fetchStub.mock.calls.find(
        ([u]) => u === '/api/wellness/portal/me/permissions',
      );
      const rxCall = fetchStub.mock.calls.find(
        ([u]) => u === '/api/wellness/portal/prescriptions',
      );
      expect(meCall).toBeTruthy();
      expect(permsCall).toBeTruthy();
      expect(rxCall).toBeTruthy();
      expect(meCall[1].headers.Authorization).toBe('Bearer seeded-token');
    });
    // Default tab is My Visits → MyBookings fetches the upcoming bucket with
    // the bearer token and renders the appointment card (service + doctor).
    await waitFor(() => {
      const apptCall = fetchStub.mock.calls.find(
        ([u]) => u === '/api/wellness/portal/appointments?bucket=upcoming',
      );
      expect(apptCall).toBeTruthy();
      expect(apptCall[1].headers.Authorization).toBe('Bearer seeded-token');
    });
    expect(await screen.findByText('Hair PRP')).toBeInTheDocument();
    expect(screen.getByText('Dr Harsh')).toBeInTheDocument();
    // Status pill renders (MyBookings maps `booked` → "Booked").
    expect(screen.getByTestId('appt-status-8001')).toHaveTextContent('Booked');
  });

  it('empty upcoming bucket → MyBookings empty-state copy renders', async () => {
    // Drift: the old "No visits on record yet." copy lived in the inline
    // visits list which was removed. MyBookings now renders a per-bucket
    // empty state ("No upcoming appointments") for the default bucket.
    installFetchMock({
      appointmentsByBucket: { upcoming: [], pending: [], completed: [], cancelled: [] },
    });
    render(<PatientPortal />);
    expect(
      await screen.findByTestId('my-bookings-empty-upcoming'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No upcoming appointments/i),
    ).toBeInTheDocument();
  });

  it('Prescriptions tab renders Rx rows with parsed drug bullets + Download PDF button', async () => {
    installFetchMock();
    render(<PatientPortal />);
    // Wait for parallel fetches to settle (visits tab default).
    await screen.findByText('Hair PRP');
    // Switch to Prescriptions tab.
    fireEvent.click(screen.getByRole('button', { name: /Prescriptions/i }));
    // Rx header includes the id. findAllByText to tolerate ancestor
    // wrappers that aggregate the same text content.
    const rxHeaderNodes = await screen.findAllByText((_t, el) =>
      /Prescription #7001/.test(el?.textContent || ''),
    );
    expect(rxHeaderNodes.length).toBeGreaterThanOrEqual(1);
    // Drug bullets render (parsed from JSON-string `drugs` column).
    expect(
      screen.getAllByText((_t, el) => /Minoxidil 5%/.test(el?.textContent || ''))
        .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) => /Finasteride/.test(el?.textContent || ''))
        .length,
    ).toBeGreaterThanOrEqual(1);
    // Download PDF button renders.
    expect(screen.getByRole('button', { name: /PDF/i })).toBeInTheDocument();
    // Instructions render.
    expect(
      screen.getByText(/Apply twice daily after wash\./i),
    ).toBeInTheDocument();
  });

  it('logout clears localStorage + returns to Login screen', async () => {
    installFetchMock();
    render(<PatientPortal />);
    await screen.findByText('Hair PRP');
    // Verify token is currently stored.
    expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBe('seeded-token');
    // Click Log out (header button).
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Log out/i }));
    });
    // localStorage is cleared.
    await waitFor(() => {
      expect(localStorage.getItem(PORTAL_TOKEN_KEY)).toBeNull();
    });
    expect(localStorage.getItem(PORTAL_NAME_KEY)).toBeNull();
    // Returns to Login screen — phone input is visible again (after health probe).
    expect(
      await screen.findByPlaceholderText(/10-digit mobile number/i),
    ).toBeInTheDocument();
  });
});

/**
 * Extension cases (tick #185+, +9 cases). The existing 11 cases cover the
 * happy paths; this block pins:
 *   12. Resend-OTP cooldown UX — initial state shows "Resend OTP" enabled;
 *       after a successful request-otp it flips to "Resend in 30s" disabled.
 *   13. Clicking Resend (when not in cooldown after a stage transition we
 *       can't replicate) — covered via a programmatic re-entry: NOT trivially
 *       reachable from RTL because cooldown starts at 30s, so we assert the
 *       button is disabled in the post-request state.
 *   14. "Change phone number" button reverts to phone stage and clears OTP +
 *       any inline error.
 *   15. Phone input with hyphens / spaces ("98-12-345-678") → digit-stripped
 *       validation passes; POST body carries the RAW (un-stripped) phone per
 *       SUT contract (the SUT validates on stripped digits but sends the raw
 *       value, so backend handles normalization).
 *   16. Health-probe HTTP error (non-200) → graceful-degrade renders.
 *   17. Treatment-Plan tab renders the placeholder copy ("Your treatment
 *       plan will appear here once your doctor shares one.").
 *   18. Consent-Forms tab renders the placeholder copy ("Consent forms
 *       you've signed at the clinic will appear here.").
 *   19. Dashboard welcome chrome omits the phone block when `me.phone` is
 *       null — defensive against backend payloads lacking phone.
 *   20. PDF download — clicking the PDF button fires GET against
 *       /api/wellness/prescriptions/<id>/pdf with the Bearer token; URL.
 *       createObjectURL is invoked with the blob.
 *   21. PDF download failure (404/500) → notify.error called with the
 *       "Could not download" prefix; no anchor click side-effects assertable
 *       in jsdom but the notify.error path is the user-observable contract.
 *
 * Mocking notes: cases 20-21 install URL.createObjectURL / revokeObjectURL
 * stubs because jsdom doesn't ship them by default. The PDF fetch uses raw
 * `fetch` with Bearer header (NOT portalFetch) — see SUT line 304-322 — so
 * the fetch stub keys on URL prefix `/api/wellness/prescriptions/` to
 * intercept any rxId.
 */

describe('<PatientPortal /> — resend OTP cooldown', () => {
  it('post-request shows "Resend in 30s" disabled; Verify button remains active', async () => {
    installFetchMock();
    render(<PatientPortal />);
    const phoneInput = await screen.findByPlaceholderText(/10-digit mobile number/i);
    fireEvent.change(phoneInput, { target: { value: '9812345678' } });
    fireEvent.click(screen.getByRole('button', { name: /Send code/i }));
    // After advancing to OTP stage the resend button reads "Resend in 30s"
    // because `requestOtp` set resendIn=30 on success.
    const resendBtn = await screen.findByRole('button', { name: /Resend in 30s/i });
    expect(resendBtn).toBeDisabled();
    // Verify button stays enabled.
    expect(
      screen.getByRole('button', { name: /Verify & enter/i }),
    ).not.toBeDisabled();
  });
});

describe('<PatientPortal /> — change phone navigation', () => {
  it('clicking "Change phone number" returns to phone stage + clears OTP + error', async () => {
    installFetchMock();
    render(<PatientPortal />);
    const phoneInput = await screen.findByPlaceholderText(/10-digit mobile number/i);
    fireEvent.change(phoneInput, { target: { value: '9812345678' } });
    fireEvent.click(screen.getByRole('button', { name: /Send code/i }));
    const otpInput = await screen.findByPlaceholderText(/4-digit code/i);
    fireEvent.change(otpInput, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: /Verify & enter/i }));
    // An inline 4-digit-code error renders (case 5's assertion).
    await screen.findAllByText(/Enter the 4-digit code/i);
    // Click "Change phone number".
    fireEvent.click(screen.getByRole('button', { name: /Change phone number/i }));
    // Back on phone stage — phone input is rendered again, OTP input gone.
    expect(
      await screen.findByPlaceholderText(/10-digit mobile number/i),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/4-digit code/i)).toBeNull();
  });
});

describe('<PatientPortal /> — phone normalization', () => {
  it('hyphenated phone "98-12-345-678" → digit-strip passes 10-digit gate', async () => {
    const fetchStub = installFetchMock();
    render(<PatientPortal />);
    const phoneInput = await screen.findByPlaceholderText(/10-digit mobile number/i);
    fireEvent.change(phoneInput, { target: { value: '98-12-345-678' } });
    fireEvent.click(screen.getByRole('button', { name: /Send code/i }));
    // POST request-otp fires; SUT sends the RAW (un-stripped) phone per
    // line 79 of the SUT (`JSON.stringify({ phone })`, not `digits`).
    await waitFor(() => {
      const postCall = fetchStub.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/portal/login/request-otp' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(postCall[1].body)).toEqual({ phone: '98-12-345-678' });
    });
    // Stage advanced to OTP.
    expect(
      await screen.findByPlaceholderText(/4-digit code/i),
    ).toBeInTheDocument();
  });
});

describe('<PatientPortal /> — health probe error', () => {
  it('non-OK /portal/health response → graceful-degrade alert renders', async () => {
    // Custom fetch stub: health endpoint returns 500.
    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/wellness/portal/health') {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: new Map([['content-type', 'application/json']]),
          json: () => Promise.resolve({ error: 'oops' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: () => Promise.resolve({}),
      });
    });
    render(<PatientPortal />);
    // SUT's Login useEffect maps `!r.ok` → `{ smsConfigured: false }`, which
    // triggers the graceful-degrade branch.
    expect(
      await screen.findByTestId('portal-sms-unavailable'),
    ).toBeInTheDocument();
  });
});

describe('<PatientPortal /> — placeholder tabs', () => {
  beforeEach(() => {
    localStorage.setItem(PORTAL_TOKEN_KEY, 'seeded-token');
    localStorage.setItem(PORTAL_NAME_KEY, 'Priya Sharma');
  });

  it('Treatment Plan tab → placeholder copy', async () => {
    installFetchMock();
    render(<PatientPortal />);
    await screen.findByText('Hair PRP');
    fireEvent.click(screen.getByRole('button', { name: /Treatment Plan/i }));
    expect(
      await screen.findByText(
        /Your treatment plan will appear here once your doctor shares one\./i,
      ),
    ).toBeInTheDocument();
  });

  it('Consent Forms tab → placeholder copy', async () => {
    installFetchMock();
    render(<PatientPortal />);
    await screen.findByText('Hair PRP');
    fireEvent.click(screen.getByRole('button', { name: /Consent Forms/i }));
    // SUT uses a curly apostrophe (U+2019) in "you've"; match flexibly.
    // The regex matches ancestor wrappers too (div > main > parent), so use
    // findAllByText to tolerate the chain and assert ≥1 match.
    const matches = await screen.findAllByText((_t, el) => {
      const text = el?.textContent || '';
      return /Consent forms you.{0,2}ve signed at the clinic will appear here\./i.test(
        text,
      );
    });
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it('welcome chrome omits phone block when me.phone is null', async () => {
    installFetchMock();
    // Override the /me payload to strip phone.
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (url === '/api/wellness/portal/me') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          json: () =>
            Promise.resolve({ id: 501, name: 'Priya Sharma', phone: null }),
        });
      }
      return baseFetch(url, opts);
    });
    render(<PatientPortal />);
    // Welcome message renders.
    const welcomeNodes = await screen.findAllByText((_t, el) =>
      /Welcome,\s*Priya Sharma/i.test(el?.textContent || ''),
    );
    expect(welcomeNodes.length).toBeGreaterThanOrEqual(1);
    // No phone-separator dot is followed by a 10-digit string under the
    // welcome row (SUT only renders the phone block when me.phone is truthy).
    const headerScope = welcomeNodes[0].closest('header') || document.body;
    expect(headerScope.textContent).not.toMatch(/9812345678/);
  });
});

describe('<PatientPortal /> — PDF download', () => {
  beforeEach(() => {
    localStorage.setItem(PORTAL_TOKEN_KEY, 'seeded-token');
    localStorage.setItem(PORTAL_NAME_KEY, 'Priya Sharma');
    // jsdom lacks URL.createObjectURL — stub.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake-rx-pdf');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    delete globalThis.URL.createObjectURL;
    delete globalThis.URL.revokeObjectURL;
  });

  // Drift: SUT now calls `/api/wellness/portal/prescriptions/<id>/pdf`
  // (portal-token-scoped endpoint), not the staff `/api/wellness/prescriptions/<id>/pdf`.
  it('clicking PDF button → GET /portal/prescriptions/<id>/pdf with Bearer token + blob URL', async () => {
    const baseFetch = installFetchMock();
    // Patch the existing stub to handle the PDF endpoint.
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (typeof url === 'string' && url.startsWith('/api/wellness/portal/prescriptions/') && url.endsWith('/pdf')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'application/pdf']]),
          blob: () => Promise.resolve(new Blob(['%PDF-1.4'], { type: 'application/pdf' })),
        });
      }
      return baseFetch(url, opts);
    });
    const fetchStub = globalThis.fetch;
    render(<PatientPortal />);
    await screen.findByText('Hair PRP');
    fireEvent.click(screen.getByRole('button', { name: /Prescriptions/i }));
    const pdfBtn = await screen.findByRole('button', { name: /PDF/i });
    fireEvent.click(pdfBtn);
    await waitFor(() => {
      const pdfCall = fetchStub.mock.calls.find(
        ([u]) =>
          typeof u === 'string' &&
          u.startsWith('/api/wellness/portal/prescriptions/') &&
          u.endsWith('/pdf'),
      );
      expect(pdfCall).toBeTruthy();
      expect(pdfCall[0]).toBe('/api/wellness/portal/prescriptions/7001/pdf');
      expect(pdfCall[1].headers.Authorization).toBe('Bearer seeded-token');
    });
    // Blob URL was created.
    await waitFor(() => {
      expect(globalThis.URL.createObjectURL).toHaveBeenCalled();
    });
  });

  it('PDF download failure (500) → notify.error called with "Could not download"', async () => {
    const baseFetch = installFetchMock();
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (typeof url === 'string' && url.startsWith('/api/wellness/portal/prescriptions/') && url.endsWith('/pdf')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          headers: new Map([['content-type', 'application/json']]),
          json: () => Promise.resolve({ error: 'PDF service down' }),
        });
      }
      return baseFetch(url, opts);
    });
    render(<PatientPortal />);
    await screen.findByText('Hair PRP');
    fireEvent.click(screen.getByRole('button', { name: /Prescriptions/i }));
    const pdfBtn = await screen.findByRole('button', { name: /PDF/i });
    fireEvent.click(pdfBtn);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalled();
    });
    expect(notifyError.mock.calls[0][0]).toMatch(/Could not download/i);
  });
});

/**
 * Notification inbox (Option A — patient-portal REST inbox). Pins:
 *   - GET /portal/me/notifications loads on mount; unread badge shows count.
 *   - Notifications tab renders the rows (title + message).
 *   - Mark-all-read fires POST /mark-all-read + clears the unread badge.
 *   - Single "Mark read" fires PUT /:id/read.
 *   - Empty inbox → "No notifications yet." + no badge.
 * The notification endpoints are ungated (any logged-in patient), separate
 * from the staff bell. Existing tests pass the default empty payload, so this
 * feature is invisible to them — additive, nothing breaks.
 */
describe('<PatientPortal /> — notification inbox', () => {
  beforeEach(() => {
    localStorage.setItem(PORTAL_TOKEN_KEY, 'seeded-token');
    localStorage.setItem(PORTAL_NAME_KEY, 'Priya Sharma');
  });

  const NOTIFS = {
    notifications: [
      { id: 9001, title: 'Appointment confirmed', message: 'Your visit is confirmed for tomorrow 11 AM.', type: 'appointment', isRead: false, createdAt: '2026-06-08T10:00:00.000Z' },
      { id: 9002, title: 'Payment receipt', message: 'We received ₹1,500. Thank you!', type: 'payment', isRead: true, createdAt: '2026-06-07T09:00:00.000Z' },
    ],
    unreadCount: 1,
    count: 2,
  };

  it('loads notifications on mount; unread badge shows the count', async () => {
    const fetchStub = installFetchMock({ notificationsPayload: NOTIFS });
    render(<PatientPortal />);
    await waitFor(() => {
      const call = fetchStub.mock.calls.find(([u]) => u === '/api/wellness/portal/me/notifications');
      expect(call).toBeTruthy();
      expect(call[1].headers.Authorization).toBe('Bearer seeded-token');
    });
    // Unread badge renders with "1".
    expect(await screen.findByTestId('portal-notif-badge')).toHaveTextContent('1');
  });

  it('Notifications tab renders rows (title + message)', async () => {
    installFetchMock({ notificationsPayload: NOTIFS });
    render(<PatientPortal />);
    await screen.findByTestId('portal-notif-badge');
    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));
    expect(await screen.findByText('Appointment confirmed')).toBeInTheDocument();
    expect(screen.getByText(/Your visit is confirmed/i)).toBeInTheDocument();
    expect(screen.getByText('Payment receipt')).toBeInTheDocument();
  });

  it('Mark all read → POST /mark-all-read fires + badge clears', async () => {
    const fetchStub = installFetchMock({ notificationsPayload: NOTIFS });
    render(<PatientPortal />);
    await screen.findByTestId('portal-notif-badge');
    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Mark all read/i }));
    await waitFor(() => {
      const call = fetchStub.mock.calls.find(
        ([u, o]) => u === '/api/wellness/portal/me/notifications/mark-all-read' && o?.method === 'POST',
      );
      expect(call).toBeTruthy();
    });
    // Optimistic clear — badge disappears.
    await waitFor(() => expect(screen.queryByTestId('portal-notif-badge')).toBeNull());
  });

  it('single "Mark read" → PUT /:id/read fires for the unread row', async () => {
    const fetchStub = installFetchMock({ notificationsPayload: NOTIFS });
    render(<PatientPortal />);
    await screen.findByTestId('portal-notif-badge');
    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));
    // Only the unread row (9001) shows a "Mark read" button.
    fireEvent.click(await screen.findByRole('button', { name: /^Mark read$/i }));
    await waitFor(() => {
      const call = fetchStub.mock.calls.find(
        ([u, o]) => u === '/api/wellness/portal/me/notifications/9001/read' && o?.method === 'PUT',
      );
      expect(call).toBeTruthy();
    });
  });

  it('empty inbox → "No notifications yet." + no unread badge', async () => {
    installFetchMock(); // default empty notificationsPayload
    render(<PatientPortal />);
    await screen.findByText('Hair PRP'); // dashboard loaded
    expect(screen.queryByTestId('portal-notif-badge')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Notifications/i }));
    expect(await screen.findByText(/No notifications yet\./i)).toBeInTheDocument();
  });
});
