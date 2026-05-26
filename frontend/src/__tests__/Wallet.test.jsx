/**
 * Wallet.test.jsx — vitest + RTL coverage for the wellness-vertical patient
 * wallet admin page (frontend/src/pages/wellness/Wallet.jsx).
 *
 * Scope: pins the page-surface invariants for the admin wallet ledger viewer —
 * heading + search chrome, search GET on Enter / button, patient picker,
 * wallet GET on patient pick, balance display + transaction history (with
 * type / amount sign / balance-after columns), empty-state, manual
 * credit/debit modal flows (open, validation, POST shape), and close-panel.
 *
 * Test cases (10):
 *   1. Heading "Patient Wallets" + sub-copy + search input + Search button
 *      render on initial mount (NO mount-time GETs).
 *   2. Search on Enter-key hits /api/wellness/patients?q=…&limit=20 and
 *      renders matching patients as clickable rows (name + phone + email).
 *   3. Empty query → Search click sets results to [] (no fetch fired,
 *      results panel hidden).
 *   4. Picking a patient row fires GET /api/wellness/patients/:id/wallet
 *      and renders the WalletPanel (name + Wallet #id + Balance label).
 *   5. Balance is formatted with the wallet's currency (formatMoney
 *      callsite — locale-tolerant digit assertion).
 *   6. Transaction list renders rows with type (underscore→space),
 *      signed amount (+ for credit, − rendered via negative number) and
 *      balance-after columns.
 *   7. Empty transactions array → "No transactions yet." copy renders;
 *      table headers do NOT render.
 *   8. Clicking "Credit" opens the credit modal; clicking Cancel closes it.
 *   9. Credit-submit validation: non-positive amount → notify.error +
 *      no POST fired. Positive amount → POST /api/wellness/wallet/:id/credit
 *      with { amount, reason } body + notify.success.
 *  10. Clicking "Debit" opens the debit modal; submit POSTs to
 *      /api/wellness/wallet/:id/debit (mode-driven URL).
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d) —
 *     fresh-per-call objects flap useCallback / useEffect identity.
 *   - AuthContext provided via the real Provider from App (SUT uses
 *     formatMoney + formatDate which read tenant from localStorage; we
 *     pre-seed both via a beforeEach localStorage write).
 *   - Dates are fixed ISO strings so locale-rendered output stays stable.
 *   - vi.mock path is `../utils/api` and `../utils/notify` relative to the
 *     flat top-level `__tests__/` directory.
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated "filter chrome + GET on mount + empty-state UI for
 *     zero wallets". REALITY: SUT is SEARCH-THEN-LOAD — there is NO mount-
 *     time GET. The page lands empty (heading + search bar only) and waits
 *     for the operator to type a query then hit Enter / Search. Tested as
 *     "no fetches on mount" rather than "empty-state-on-zero".
 *   - Prompt anticipated "wallet balance per patient row + top-up flow".
 *     REALITY: it's a SINGLE-PATIENT wallet panel — operator picks one
 *     patient from search results, then sees that patient's balance + ledger.
 *     No multi-row table of patient wallets.
 *   - Prompt anticipated "Top up" / "Adjust balance" CTAs. REALITY: the SUT
 *     calls them "Credit" / "Debit" (admin-only manual ledger writes); both
 *     open the same ManualLedgerModal with `mode` toggling URL + label.
 *   - Prompt anticipated "bonus rule application / preview" + "expiry-date
 *     display". REALITY: SUT has NEITHER — it's a pure ledger viewer.
 *     Wallet rows have `balance` + `currency` only; transactions have
 *     `createdAt` / `type` / `amount` / `balanceAfter` / `reason`. No bonus
 *     calc, no per-tx expiry, no per-wallet expiry. Omitted from tests.
 *   - Prompt anticipated "RBAC: USER role hides mutation CTAs". REALITY:
 *     the SUT does NOT gate the Credit/Debit buttons in the UI — the BACKEND
 *     verifyRole(['ADMIN']) is the gate. The SUT renders Credit/Debit for
 *     all roles; a USER click just gets a 403 from the API. Omitted RBAC
 *     test (covered by backend route gate spec / api-level test).
 *   - Prompt anticipated `useApi` hook. REALITY: SUT imports
 *     `fetchApi` from `../../utils/api` directly (no hook indirection).
 *   - SUT does NOT have a loading message — `loading` is a boolean that
 *     only disables the Search button; no "Loading…" text rendered.
 *     Omitted that case (would need an SUT change to assert).
 *   - POST body shape per backend route (backend/routes/wellness.js:7170):
 *     { amount: Number, reason: String }. Backend tolerates missing reason
 *     and defaults to "Manual credit" / "Manual debit". Tests assert
 *     the SUT's outgoing body, not the backend default.
 *
 * Path: flat `__tests__/Wallet.test.jsx` — distinct from any wellness/
 * subdir convention; matches the tick #126 prompt path mandate.
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
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import Wallet from '../pages/wellness/Wallet';

const ADMIN_USER = {
  userId: 1,
  name: 'Rishu Admin',
  email: 'rishu@enhancedwellness.in',
  role: 'ADMIN',
};

const PATIENT_RESULTS = [
  { id: 501, name: 'Priya Sharma', phone: '+919812345678', email: 'priya@example.com' },
  { id: 502, name: 'Aman Singh', phone: '+919811112222', email: null },
];

// Fixed ISO date strings — locale-rendering of formatDate stays stable.
const TX_2026_05_01 = '2026-05-01T10:00:00.000Z';
const TX_2026_05_10 = '2026-05-10T14:30:00.000Z';

const WALLET_PAYLOAD = {
  patient: { id: 501, name: 'Priya Sharma' },
  wallet: { id: 9001, balance: 2500, currency: 'INR', patientId: 501 },
  transactions: [
    {
      id: 7001,
      createdAt: TX_2026_05_10,
      type: 'CREDIT_REFUND',
      amount: 1500,
      balanceAfter: 2500,
      reason: 'Goodwill refund',
    },
    {
      id: 7002,
      createdAt: TX_2026_05_01,
      type: 'DEBIT_REDEMPTION',
      amount: -500,
      balanceAfter: 1000,
      reason: null,
    },
  ],
};

const EMPTY_WALLET_PAYLOAD = {
  patient: { id: 502, name: 'Aman Singh' },
  wallet: { id: 9002, balance: 0, currency: 'INR', patientId: 502 },
  transactions: [],
};

function installFetchMock({
  patients = PATIENT_RESULTS,
  wallet = WALLET_PAYLOAD,
} = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url.startsWith('/api/wellness/patients?q=') && method === 'GET') {
      return Promise.resolve({ patients });
    }
    if (/^\/api\/wellness\/patients\/\d+\/wallet$/.test(url) && method === 'GET') {
      return Promise.resolve(wallet);
    }
    if (/^\/api\/wellness\/wallet\/\d+\/(credit|debit)$/.test(url) && method === 'POST') {
      return Promise.resolve({ id: 9999, balanceAfter: 5000 });
    }
    return Promise.resolve({});
  });
}

function renderPage({ user = ADMIN_USER } = {}) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user,
          token: 'tk',
          tenant: { id: 1, name: 'Enhanced Wellness', defaultCurrency: 'INR', locale: 'en-IN' },
          loading: false,
        }}
      >
        <Wallet />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  // Seed tenant for formatMoney / formatDate localStorage reads.
  localStorage.setItem(
    'tenant',
    JSON.stringify({ id: 1, defaultCurrency: 'INR', locale: 'en-IN' }),
  );
});

describe('<Wallet /> — page chrome', () => {
  it('renders the heading + search input + Search button on initial mount; no fetch on mount', async () => {
    installFetchMock();
    renderPage();
    expect(
      screen.getByRole('heading', { name: /Patient Wallets/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Composite ledger of gift-card credits/i),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Search patient by name, phone, or email/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Search/i })).toBeInTheDocument();
    // SUT is search-then-load — no mount-time GET.
    expect(fetchApiMock).not.toHaveBeenCalled();
  });
});

describe('<Wallet /> — patient search', () => {
  it('Enter-key in search input fires GET /api/wellness/patients?q=…&limit=20 and renders rows', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/patients?q=Priya&limit=20',
      );
    });
    // Both patients render as clickable rows.
    expect(await screen.findByText(/Priya Sharma/)).toBeInTheDocument();
    expect(screen.getByText(/Aman Singh/)).toBeInTheDocument();
    // Phone + email render in the row text.
    expect(
      screen.getAllByText((_t, el) =>
        /Priya Sharma.*\+919812345678.*priya@example\.com/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('empty / whitespace query → Search click does not fetch and results stay empty', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /Search/i }));
    // Brief wait to make sure no async fetch sneaks through.
    await Promise.resolve();
    expect(fetchApiMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Priya Sharma/)).toBeNull();
  });
});

describe('<Wallet /> — wallet panel', () => {
  it('clicking a patient row fires GET /api/wellness/patients/:id/wallet and renders the panel', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Priya Sharma/);
    fireEvent.click(row.closest('button'));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith(
        '/api/wellness/patients/501/wallet',
      );
    });
    // Panel header — patient name + wallet id.
    expect(await screen.findByRole('heading', { name: /Priya Sharma/ })).toBeInTheDocument();
    expect(screen.getByText(/Wallet #9001/)).toBeInTheDocument();
    expect(screen.getByText(/^Balance$/)).toBeInTheDocument();
  });

  it('balance renders with the wallet currency (formatMoney digits — locale-tolerant)', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Priya Sharma/);
    fireEvent.click(row.closest('button'));
    // Balance is 2500 — locale-tolerant: "2,500" or "2500".
    await waitFor(() => {
      expect(
        screen.getAllByText((_t, el) =>
          /(?:^|[^\d])2[,. ]?500(?:[^\d]|$)/.test(el?.textContent || ''),
        ).length,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders transaction rows with type (underscore→space), signed amount, and balance-after', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Priya Sharma/);
    fireEvent.click(row.closest('button'));
    await screen.findByRole('heading', { name: /Recent transactions/i });
    // Type renders with underscore→space (SUT does `tx.type.replace('_', ' ')`)
    expect(
      screen.getAllByText((_t, el) => /CREDIT REFUND/.test(el?.textContent || '')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByText((_t, el) => /DEBIT REDEMPTION/.test(el?.textContent || '')).length,
    ).toBeGreaterThanOrEqual(1);
    // Credit amount has leading "+" prefix.
    expect(
      screen.getAllByText((_t, el) => /^\+/.test((el?.textContent || '').trim())).length,
    ).toBeGreaterThanOrEqual(1);
    // Balance-after for tx 7001 is 2500; for tx 7002 is 1000. Locale-tolerant.
    expect(
      screen.getAllByText((_t, el) =>
        /(?:^|[^\d])1[,. ]?000(?:[^\d]|$)/.test(el?.textContent || ''),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('zero transactions → renders "No transactions yet." and no table headers', async () => {
    installFetchMock({ wallet: EMPTY_WALLET_PAYLOAD, patients: [PATIENT_RESULTS[1]] });
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Aman' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Aman Singh/);
    fireEvent.click(row.closest('button'));
    expect(await screen.findByText(/No transactions yet\./i)).toBeInTheDocument();
    // Table headers should NOT render when transactions are empty.
    expect(screen.queryByText(/^Balance after$/)).toBeNull();
  });
});

describe('<Wallet /> — manual ledger modal', () => {
  it('clicking "Credit" opens the modal; Cancel closes it without POST', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Priya Sharma/);
    fireEvent.click(row.closest('button'));
    await screen.findByRole('heading', { name: /Recent transactions/i });
    fireEvent.click(screen.getByRole('button', { name: /Credit/i }));
    expect(
      await screen.findByRole('heading', { name: /Credit wallet/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Amount \(INR\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(screen.queryByRole('heading', { name: /Credit wallet/i })).toBeNull();
    // Only the search + wallet GETs fired; no POST.
    const postCall = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('credit submit: non-positive amount → notify.error + no POST; valid amount → POST /credit with body + notify.success', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Priya Sharma/);
    fireEvent.click(row.closest('button'));
    await screen.findByRole('heading', { name: /Recent transactions/i });
    fireEvent.click(screen.getByRole('button', { name: /Credit/i }));
    await screen.findByRole('heading', { name: /Credit wallet/i });
    // First: submit with empty amount → guard fires. Two buttons match
    // /^Credit$/ when modal is open (panel "Credit" CTA + modal submit);
    // the modal's submit is the LAST one in document order.
    const creditButtons = screen.getAllByRole('button', { name: /^Credit$/ });
    const submitBtn = creditButtons[creditButtons.length - 1];
    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/positive amount/i),
      );
    });
    const postCallEarly = fetchApiMock.mock.calls.find(
      ([, opts]) => opts?.method === 'POST',
    );
    expect(postCallEarly).toBeUndefined();

    // Now: fill positive amount + reason + submit.
    const amountInput = screen.getByRole('spinbutton');
    fireEvent.change(amountInput, { target: { value: '750' } });
    const reasonInput = screen.getByPlaceholderText(/Optional/i);
    fireEvent.change(reasonInput, { target: { value: 'Goodwill credit' } });
    fireEvent.click(submitBtn);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/wallet/9001/credit' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      // Body is JSON-stringified per SUT.
      const body = JSON.parse(postCall[1].body);
      expect(body).toEqual({ amount: 750, reason: 'Goodwill credit' });
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Wallet credited/i),
    );
  });

  it('clicking "Debit" opens the debit modal; submit POSTs to /debit (mode-driven URL)', async () => {
    installFetchMock();
    renderPage();
    const input = screen.getByPlaceholderText(/Search patient by name, phone, or email/i);
    fireEvent.change(input, { target: { value: 'Priya' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    const row = await screen.findByText(/Priya Sharma/);
    fireEvent.click(row.closest('button'));
    await screen.findByRole('heading', { name: /Recent transactions/i });
    fireEvent.click(screen.getByRole('button', { name: /Debit/i }));
    expect(
      await screen.findByRole('heading', { name: /Debit wallet/i }),
    ).toBeInTheDocument();
    const amountInput = screen.getByRole('spinbutton');
    fireEvent.change(amountInput, { target: { value: '300' } });
    // The submit button label in debit-mode is "Debit" (matches the panel's
    // Debit button name too — getAllByRole + pick the modal's last).
    const debitButtons = screen.getAllByRole('button', { name: /^Debit$/ });
    fireEvent.click(debitButtons[debitButtons.length - 1]);
    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, opts]) =>
          u === '/api/wellness/wallet/9001/debit' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.amount).toBe(300);
    });
    expect(notifySuccess).toHaveBeenCalledWith(
      expect.stringMatching(/Wallet debited/i),
    );
  });
});
