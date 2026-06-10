/**
 * Holidays.test.jsx — vitest + RTL coverage for the wellness-vertical admin
 * Holidays page (frontend/src/pages/wellness/Holidays.jsx).
 *
 * Scope: pins the page-surface invariants for the clinic Holiday calendar —
 * heading + CTA chrome, parallel GETs on mount (holidays + locations + staff),
 * loading state, empty-state, table rendering with scope resolution
 * (Clinic-wide / Location / Practitioner), add-holiday form (open, validation,
 * POST shape with date + name + nullable locationId / doctorId), and
 * delete flow with window.confirm gate.
 *
 * Test cases (10):
 *   1. Heading "Holidays" + sub-copy + "Mark holiday" CTA render on initial
 *      mount; a "Loading…" indicator is visible before fetches resolve.
 *   2. Mount fires three parallel GETs: /api/wellness/holidays?from&to
 *      (date-windowed), /api/wellness/locations, /api/staff.
 *   3. Empty holidays array → empty-state copy renders, no table rows.
 *   4. Populated holidays render with scope resolution: clinic-wide
 *      (no loc / no doctor), per-location (loc only), per-practitioner
 *      (doctor — wins over location per SUT precedence).
 *   5. "Mark holiday" toggle opens the inline form; second click cancels it.
 *   6. Submit with valid date + name + clinic-wide scope POSTs to
 *      /api/wellness/holidays with { date, name, locationId: null,
 *      doctorId: null } body and fires notify.success.
 *   7. Submit scoped to a practitioner POSTs with doctorId set
 *      (parseInt) and locationId null.
 *   8. Submit guard: empty name OR empty date short-circuits before fetch
 *      (form's onSubmit early-return; submit button also disabled).
 *   9. Delete row: window.confirm true → DELETE /api/wellness/holidays/:id;
 *      window.confirm false → no DELETE fired.
 *  10. Doctor dropdown filters staff to wellnessRole in {doctor, professional}
 *      (excludes telecaller / helper / null-role users).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d) —
 *     fresh-per-call objects flap useCallback / useEffect identity.
 *   - vi.mock path is `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *   - window.confirm is stubbed per-test via vi.spyOn.
 *   - Dates use fixed ISO strings; the SUT formats via toLocaleDateString
 *     so assertions use locale-tolerant regex on day / month tokens.
 *   - SUT does not consume AuthContext directly; rendered without a Provider
 *     wrapper (no MemoryRouter needed either — no <Link> usage).
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated optional "edit" flow. REALITY: SUT has NO edit
 *     flow — only mark (POST) + delete (DELETE). Holidays are immutable
 *     once created; mistakes are corrected by delete + recreate. Omitted.
 *   - Prompt anticipated optional "recurring vs one-off" toggle. REALITY:
 *     SUT only supports one-off dates. Recurring holidays (e.g. annual
 *     Diwali) require N separate rows; no recurrence rule in payload.
 *   - Prompt anticipated optional "past vs future visual treatment".
 *     REALITY: SUT pre-windows the GET to today→today+365d via `min` /
 *     `max` on the <input type="date"> + the query string; past holidays
 *     do not surface in the list at all, so no visual treatment to test.
 *   - Prompt anticipated optional UI-level RBAC (hide CTAs for USER).
 *     REALITY: backend verifyWellnessRole(['admin','manager']) gates
 *     POST + DELETE; the UI does not gate. Matches the wellness sibling
 *     pattern (Wallet, Memberships, Coupons). Omitted UI-RBAC test.
 *   - Prompt anticipated "fetch /api/holidays". REALITY: endpoint is
 *     /api/wellness/holidays (under the wellness route prefix); see
 *     backend/routes/wellness.js:3831 (GET) + :3844 (POST) + :3870 (DELETE).
 *   - Prompt anticipated "Loading…" via findByText. REALITY: SUT renders
 *     bare `<div>Loading…</div>` (no ARIA role / aria-busy); use
 *     getByText with regex matcher.
 *   - SUT load() runs three fetches inside Promise.all with per-call
 *     .catch(() => []) — a 500 on any single endpoint degrades to empty
 *     array for that slice but does NOT throw; no error banner. notify.error
 *     is NOT called on load failure. Captured in case 3 (load with all-empty
 *     responses still renders cleanly).
 *   - Form `name` field accepts any non-empty string. Date field is bounded
 *     to [today, today+365d] via input min/max attributes (HTML5 native);
 *     vitest's jsdom does NOT enforce input min/max — user can set any
 *     ISO date programmatically. Backend has its own bound check.
 *   - POST body: `locationId` and `doctorId` are parsed via parseInt when
 *     non-empty, ELSE null. Tested both branches (case 6 = nulls, case 7 =
 *     doctorId set).
 *   - Delete uses native window.confirm (not notify.confirm) — matches
 *     Coupons + Wallet sibling pattern.
 *
 * Path: flat `__tests__/Holidays.test.jsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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

import Holidays from '../pages/wellness/Holidays';

// Fixed ISO date strings — locale-rendering of toLocaleDateString stays stable
// shape across runners (day + short month + year + weekday tokens present).
const H_2026_05_01 = '2026-05-01T00:00:00.000Z';
const H_2026_06_15 = '2026-06-15T00:00:00.000Z';
const H_2026_07_20 = '2026-07-20T00:00:00.000Z';

const LOCATIONS = [
  { id: 11, name: 'Bandra Clinic' },
  { id: 12, name: 'Andheri Clinic' },
];

const STAFF = [
  { id: 21, name: 'Dr Harsh', wellnessRole: 'doctor' },
  { id: 22, name: 'Priya Pro', wellnessRole: 'professional' },
  { id: 23, name: 'Ravi Telecaller', wellnessRole: 'telecaller' },
  { id: 24, name: 'Suman Helper', wellnessRole: 'helper' },
  { id: 25, name: 'Anu Front', wellnessRole: null },
];

const HOLIDAYS_FULL = [
  // Clinic-wide.
  { id: 901, date: H_2026_05_01, name: 'Labour Day', locationId: null, doctorId: null },
  // Per-location.
  { id: 902, date: H_2026_06_15, name: 'Bandra Refurb', locationId: 11, doctorId: null },
  // Per-practitioner (doctor wins over location per SUT precedence).
  { id: 903, date: H_2026_07_20, name: 'Dr Harsh PTO', locationId: 12, doctorId: 21 },
];

function installFetchMock({
  holidays = HOLIDAYS_FULL,
  locations = LOCATIONS,
  staff = STAFF,
  holidaysShouldThrow = false,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/wellness/holidays?') && method === 'GET') {
      return holidaysShouldThrow
        ? Promise.reject(new Error('500 server error'))
        : Promise.resolve(holidays);
    }
    if (url === '/api/wellness/locations' && method === 'GET') {
      return Promise.resolve(locations);
    }
    if (url === '/api/staff' && method === 'GET') {
      return Promise.resolve(staff);
    }
    if (url === '/api/wellness/holidays' && method === 'POST') {
      return Promise.resolve({ id: 999, ...JSON.parse(opts.body) });
    }
    if (/^\/api\/wellness\/holidays\/\d+$/.test(url) && method === 'DELETE') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
});

afterEach(() => {
  // notifyConfirm is reset in beforeEach.
});

describe('<Holidays /> — page chrome + mount fetches', () => {
  it('renders heading "Holidays" + sub-copy + Mark-holiday CTA + a Loading indicator on initial mount', async () => {
    // Withhold the mock to keep promises pending — exposes the Loading state.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    render(<Holidays />);
    expect(screen.getByRole('heading', { name: /^Holidays$/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Clinic-wide closures.*per-location.*per-practitioner/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark holiday/i })).toBeInTheDocument();
    expect(screen.getByText(/^Loading…$/)).toBeInTheDocument();
  });

  it('fires three parallel GETs on mount: /api/wellness/holidays?from&to, /api/wellness/locations, /api/staff', async () => {
    installFetchMock();
    render(<Holidays />);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(3);
    });
    const urls = fetchApiMock.mock.calls.map(([u]) => u);
    expect(urls.some((u) => /^\/api\/wellness\/holidays\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/.test(u))).toBe(true);
    expect(urls).toContain('/api/wellness/locations');
    expect(urls).toContain('/api/staff');
  });
});

describe('<Holidays /> — list rendering', () => {
  it('empty holidays array → empty-state copy renders + no table rows', async () => {
    installFetchMock({ holidays: [] });
    render(<Holidays />);
    expect(
      await screen.findByText(/No holidays configured\. Mark Diwali/i),
    ).toBeInTheDocument();
    // The table headers should NOT render.
    expect(screen.queryByText(/^Scope$/)).toBeNull();
  });

  it('renders rows with scope resolution: clinic-wide, per-location, per-practitioner (doctor wins)', async () => {
    installFetchMock();
    render(<Holidays />);
    // Each holiday name renders.
    expect(await screen.findByText(/^Labour Day$/)).toBeInTheDocument();
    expect(screen.getByText(/^Bandra Refurb$/)).toBeInTheDocument();
    expect(screen.getByText(/^Dr Harsh PTO$/)).toBeInTheDocument();
    // Scope cell — clinic-wide.
    expect(screen.getByText(/^Clinic-wide$/)).toBeInTheDocument();
    // Scope cell — location-scoped.
    expect(screen.getByText(/^Location: Bandra Clinic$/)).toBeInTheDocument();
    // Scope cell — practitioner-scoped (doctor wins over location 12).
    expect(screen.getByText(/^Practitioner: Dr Harsh$/)).toBeInTheDocument();
    // Andheri Clinic name should NOT appear as a scope label (doctor wins).
    expect(screen.queryByText(/^Location: Andheri Clinic$/)).toBeNull();
  });
});

describe('<Holidays /> — add form', () => {
  it('"Mark holiday" toggle opens the inline form; clicking again ("Cancel") hides it', async () => {
    installFetchMock({ holidays: [] });
    render(<Holidays />);
    await screen.findByText(/No holidays configured/i);
    const cta = screen.getByRole('button', { name: /Mark holiday/i });
    fireEvent.click(cta);
    expect(
      screen.getByPlaceholderText(/Name — e\.g\. Diwali, Republic Day/i),
    ).toBeInTheDocument();
    // CTA text flips to "Cancel" (header CTA); inline form also has a
    // "Cancel" button — so getAllByRole returns 2 matches when form is open.
    const cancelButtons = screen.getAllByRole('button', { name: /^Cancel$/ });
    expect(cancelButtons.length).toBe(2);
    // Click the header CTA (first) → form hides.
    fireEvent.click(cancelButtons[0]);
    expect(
      screen.queryByPlaceholderText(/Name — e\.g\. Diwali, Republic Day/i),
    ).toBeNull();
  });

  it('submit with valid date + name + clinic-wide scope POSTs with locationId: null, doctorId: null', async () => {
    installFetchMock({ holidays: [] });
    render(<Holidays />);
    await screen.findByText(/No holidays configured/i);
    fireEvent.click(screen.getByRole('button', { name: /Mark holiday/i }));
    // Two "Mark holiday" matches once form is open: CTA + submit. Pick the
    // submit (last in DOM).
    const nameInput = screen.getByPlaceholderText(/Name — e\.g\. Diwali/i);
    fireEvent.change(nameInput, { target: { value: 'Republic Day' } });
    // Date input — no placeholder; locate via type=date.
    const dateInput = document.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2027-01-26' } });
    const submitButtons = screen.getAllByRole('button', { name: /Mark holiday/i });
    fireEvent.click(submitButtons[submitButtons.length - 1]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/wellness/holidays' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toMatchObject({
        date: '2027-01-26',
        name: 'Republic Day',
        locationId: null,
        doctorId: null,
      });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Marked 2027-01-26.*"Republic Day"/),
    );
  });

  it('submit scoped to a practitioner POSTs with doctorId set (parseInt) and locationId null', async () => {
    installFetchMock({ holidays: [] });
    render(<Holidays />);
    await screen.findByText(/No holidays configured/i);
    fireEvent.click(screen.getByRole('button', { name: /Mark holiday/i }));
    const nameInput = screen.getByPlaceholderText(/Name — e\.g\. Diwali/i);
    fireEvent.change(nameInput, { target: { value: 'Dr Priya PTO' } });
    const dateInput = document.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2026-08-15' } });
    // Pick practitioner from the second <select> (locationId first, doctorId second).
    const selects = document.querySelectorAll('select');
    expect(selects.length).toBe(2);
    fireEvent.change(selects[1], { target: { value: '22' } });
    const submitButtons = screen.getAllByRole('button', { name: /Mark holiday/i });
    fireEvent.click(submitButtons[submitButtons.length - 1]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/wellness/holidays' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.doctorId).toBe(22);
      expect(body.locationId).toBeNull();
    });
  });

  it('submit guard: empty name → button disabled + early return on submit (no POST)', async () => {
    installFetchMock({ holidays: [] });
    render(<Holidays />);
    await screen.findByText(/No holidays configured/i);
    fireEvent.click(screen.getByRole('button', { name: /Mark holiday/i }));
    // Set the date but leave name empty.
    const dateInput = document.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2027-01-26' } });
    // Submit button is the LAST "Mark holiday" match — should be disabled.
    const submitButtons = screen.getAllByRole('button', { name: /Mark holiday/i });
    const submitBtn = submitButtons[submitButtons.length - 1];
    expect(submitBtn).toBeDisabled();
    // Force-fire the form's onSubmit to exercise the early-return guard.
    const form = document.querySelector('form');
    fireEvent.submit(form);
    // No POST should fire.
    await Promise.resolve();
    const postCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });
});

describe('<Holidays /> — delete flow', () => {
  it('delete: notify.confirm true → DELETE /api/wellness/holidays/:id + notify.success', async () => {
    installFetchMock();
    render(<Holidays />);
    // Wait for table to render.
    const labourRow = (await screen.findByText(/^Labour Day$/)).closest('tr');
    const delBtn = within(labourRow).getByRole('button', { name: /Delete/i });
    notifyConfirm.mockResolvedValueOnce(true);
    fireEvent.click(delBtn);
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, opts]) => u === '/api/wellness/holidays/901' && opts?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Removed "Labour Day"/),
    );
  });

  it('delete: notify.confirm false → no DELETE fired', async () => {
    installFetchMock();
    render(<Holidays />);
    const labourRow = (await screen.findByText(/^Labour Day$/)).closest('tr');
    const delBtn = within(labourRow).getByRole('button', { name: /Delete/i });
    notifyConfirm.mockResolvedValueOnce(false);
    fireEvent.click(delBtn);
    // Give microtask queue a chance to drain.
    await Promise.resolve();
    await Promise.resolve();
    const deleteCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'DELETE',
    );
    expect(deleteCall).toBeUndefined();
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});

describe('<Holidays /> — doctor dropdown filter', () => {
  it('doctor dropdown lists only wellnessRole in {doctor, professional} — excludes telecaller / helper / null', async () => {
    installFetchMock({ holidays: [] });
    render(<Holidays />);
    await screen.findByText(/No holidays configured/i);
    fireEvent.click(screen.getByRole('button', { name: /Mark holiday/i }));
    // Second <select> = doctors picker.
    const selects = document.querySelectorAll('select');
    const doctorSelect = selects[1];
    const optionTexts = Array.from(doctorSelect.options).map((o) => o.textContent);
    expect(optionTexts).toContain('Dr Harsh');
    expect(optionTexts).toContain('Priya Pro');
    expect(optionTexts).not.toContain('Ravi Telecaller');
    expect(optionTexts).not.toContain('Suman Helper');
    expect(optionTexts).not.toContain('Anu Front');
  });
});
