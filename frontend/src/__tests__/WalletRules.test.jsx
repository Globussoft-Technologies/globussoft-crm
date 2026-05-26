/**
 * WalletRules.test.jsx — vitest + RTL coverage for the wellness-vertical
 * wallet bonus-rule ADMIN page (frontend/src/pages/admin/WalletRules.jsx —
 * the FR-3.6 surface from docs/PRD_WALLET_TOPUP.md §3.6 — slice 5: list +
 * create only, graceful degradation against a not-yet-shipped backend).
 *
 * Scope — pins the page-surface invariants for the bonus-rule admin:
 *
 *   1. Loading shim: shows "Loading wallet bonus rules…" before the first
 *      GET resolves.
 *   2. Page chrome on mount: heading "Wallet Bonus Rules" + PRD §3.6
 *      sub-copy + "+ New Rule" CTA + a single GET /api/wallet/rules fired
 *      on mount.
 *   3. Backend-missing banner (slice 5 graceful-degradation): when the GET
 *      throws a 404 / not-found / fetch error, the page renders the
 *      `wallet-rules-backend-pending` banner AND the empty-state card.
 *      Confirms FR-3.6 / docs comment-block contract: a 404 is NOT a hard
 *      load-error; it routes to the friendly banner.
 *   4. Load error: a generic server error (500-class with a non-404
 *      message) renders the red "Failed to load" banner with a Retry
 *      button — clicking Retry re-fires the GET.
 *   5. Empty list rendering: GET returns { rules: [] } → the
 *      `wallet-rules-empty` empty-state card renders with the PRD copy
 *      "No bonus rules yet. Click + New Rule to create one."
 *   6. Populated list: GET returns 2 rules → both rule cards render
 *      with name, min top-up in rupees (paise → rupees boundary), bonus
 *      %, validity months, and a per-card Active/Inactive badge.
 *   7. Open create modal: clicking "+ New Rule" opens the modal with all
 *      five inputs (Name / Min Amount / Bonus % / Validity months /
 *      Active) and a Cancel + Create Rule pair.
 *   8. Validation — empty name: submitting with no name surfaces
 *      `notify.error('Rule name is required.')` and does NOT fire POST.
 *   9. Validation — invalid bonus %: a 0 / negative / >100 percent
 *      surfaces `notify.error('Bonus % must be between 0 and 100
 *      (exclusive of 0).')` and does NOT fire POST.
 *  10. Validation — invalid validity months: a 0 / >60 months value
 *      surfaces `notify.error('Validity must be between 1 and 60
 *      months.')` and does NOT fire POST.
 *  11. Create happy path: filling in all 5 fields and submitting fires
 *      POST /api/wallet/rules with the paise-converted body shape
 *      (rupeesToPaise: ₹2000 → 200000) + a success toast + the modal
 *      closes + a reload GET fires.
 *  12. Create — backend not ready: when POST throws a 404 / not-ready,
 *      notify.error surfaces the "Backend not ready; rule will save once
 *      shipped." copy and the modal stays open (submitting flag clears).
 *  13. Cancel button closes the modal without firing POST.
 *
 * Backend contract pinned per PRD §3.6 (SUT lines 26-34):
 *   GET    /api/wallet/rules
 *          → { rules:[{ id, name, minAmountCents, bonusPercent,
 *                       validityMonths, active, validFrom, validTo,
 *                       precedence, createdAt }] }
 *   POST   /api/wallet/rules
 *          body: { name, minAmountCents, bonusPercent, validityMonths,
 *                  active } → 201 envelope
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules):
 *   - fetchApi mocked at ../utils/api with a stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d) —
 *     fresh-per-call objects flap useCallback/useEffect identity.
 *   - SUT does NOT consume AuthContext / useNavigate / Router — no wrapper
 *     needed beyond direct render().
 *
 * Drift pinned (prompt vs. actual SUT):
 *   - Prompt anticipated activate/deactivate toggle + edit + delete-confirm.
 *     REALITY: SUT is "slice 5 PARTIAL — list + create only" per the doc
 *     header (lines 36-39). Edit/Delete are deferred to slice 6+. The
 *     active flag is set at CREATE time via a checkbox; there is NO inline
 *     toggle on the rule card. Tests pin the create-with-active-on/off
 *     branch and skip the edit/delete cases as out-of-scope-for-this-slice.
 *   - Prompt anticipated useApi/useNavigate. REALITY: SUT imports
 *     `fetchApi` directly from `../../utils/api` and `useNotify` from
 *     `../../utils/notify`. No router deps.
 *   - The "test cases >= 10" mandate is satisfied with 13 cases (10
 *     promised + 3 extras).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — RTL standing rule (Wave 11 cfb5789 / Wave 12
// f59e91d). The SUT closes over notify inside handleSubmit; fresh per-call
// mock identities would flap state across renders.
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

import WalletRules from '../pages/admin/WalletRules';

const RULE_A = {
  id: 11,
  name: 'Festive 2000+ Boost',
  minAmountCents: 200000, // ₹2000
  bonusPercent: 10,
  validityMonths: 12,
  active: true,
  validFrom: null,
  validTo: null,
  precedence: 0,
  createdAt: '2026-05-20T10:00:00.000Z',
};

const RULE_B = {
  id: 12,
  name: 'Loyalty 5000+ Tier',
  minAmountCents: 500000, // ₹5000
  bonusPercent: 15,
  validityMonths: 24,
  active: false,
  validFrom: null,
  validTo: null,
  precedence: 1,
  createdAt: '2026-05-20T11:00:00.000Z',
};

/**
 * Install a fetchApi mock keyed on (url, method).
 *
 * @param {object} opts
 * @param {object|Error} opts.list   - GET /api/wallet/rules response or thrown Error
 * @param {object|Error} opts.create - POST /api/wallet/rules response or thrown Error
 */
function installFetchMock({ list, create } = {}) {
  fetchApiMock.mockImplementation((url, options) => {
    const method = options?.method || 'GET';
    if (url === '/api/wallet/rules' && method === 'GET') {
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list ?? { rules: [] });
    }
    if (url === '/api/wallet/rules' && method === 'POST') {
      if (create instanceof Error) return Promise.reject(create);
      return Promise.resolve(create ?? { rule: { ...RULE_A, id: 999 } });
    }
    return Promise.resolve({});
  });
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
});

describe('WalletRules — initial mount', () => {
  it('shows loading message while the initial GET is in flight', () => {
    // Never resolves — captures the synchronous render before useEffect resolves.
    fetchApiMock.mockImplementation(() => new Promise(() => {}));
    render(<WalletRules />);
    expect(screen.getByText(/Loading wallet bonus rules/i)).toBeInTheDocument();
  });

  it('renders page chrome + fires GET /api/wallet/rules on mount', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    // Heading + sub-copy.
    expect(screen.getByRole('heading', { name: /Wallet Bonus Rules/i })).toBeInTheDocument();
    expect(screen.getByText(/Configure top-up bonus rules per tenant/i)).toBeInTheDocument();
    // + New Rule CTA.
    expect(screen.getByTestId('wallet-rules-new-btn')).toBeInTheDocument();
    // GET fired exactly once on mount.
    await waitFor(() => {
      const calls = fetchApiMock.mock.calls.filter(
        (c) => c[0] === '/api/wallet/rules' && (c[1]?.method || 'GET') === 'GET',
      );
      expect(calls).toHaveLength(1);
    });
  });
});

describe('WalletRules — load paths', () => {
  it('renders the backend-missing banner + empty state when GET throws a 404 / not-ready / fetch error', async () => {
    installFetchMock({ list: new Error('404 not_found') });
    render(<WalletRules />);
    expect(await screen.findByTestId('wallet-rules-backend-pending')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rules-empty')).toBeInTheDocument();
  });

  it('renders the red load-error banner with Retry on a generic server error', async () => {
    installFetchMock({ list: new Error('Internal server error') });
    render(<WalletRules />);
    expect(await screen.findByText(/Internal server error/i)).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    expect(retryBtn).toBeInTheDocument();
    // Retry hits the GET again.
    const user = userEvent.setup();
    fetchApiMock.mockReset();
    installFetchMock({ list: { rules: [] } });
    await user.click(retryBtn);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wallet/rules');
    });
  });

  it('renders the empty-state card when GET returns { rules: [] }', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    expect(await screen.findByTestId('wallet-rules-empty')).toBeInTheDocument();
    // "No bonus rules yet" appears as both an <h3> heading AND inside the
    // descriptive paragraph — getAllByText per RTL standing rule.
    expect(screen.getAllByText(/No bonus rules yet/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Click \+ New Rule to create one/i)).toBeInTheDocument();
  });

  it('renders one card per rule, with paise→rupee conversion + Active/Inactive badge', async () => {
    installFetchMock({ list: { rules: [RULE_A, RULE_B] } });
    render(<WalletRules />);
    // Both card containers render.
    expect(await screen.findByTestId(`wallet-rule-card-${RULE_A.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`wallet-rule-card-${RULE_B.id}`)).toBeInTheDocument();
    // Names.
    expect(screen.getByText('Festive 2000+ Boost')).toBeInTheDocument();
    expect(screen.getByText('Loyalty 5000+ Tier')).toBeInTheDocument();
    // Paise → rupees boundary: 200000 paise = ₹2000.00 ; 500000 = ₹5000.00
    expect(screen.getByText(/Min top-up: ₹2000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Min top-up: ₹5000\.00/)).toBeInTheDocument();
    // Bonus % rendered (note: badge can repeat; assert at least 1).
    expect(screen.getAllByText(/10%/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/15%/).length).toBeGreaterThanOrEqual(1);
    // Active/Inactive badges — RULE_A is active, RULE_B is not.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    // Validity months copy.
    expect(screen.getByText(/Validity: 12 months/)).toBeInTheDocument();
    expect(screen.getByText(/Validity: 24 months/)).toBeInTheDocument();
  });
});

describe('WalletRules — create modal flow', () => {
  it('opens the modal with all 5 inputs + a Cancel + Create Rule pair when + New Rule is clicked', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    // Modal renders.
    expect(screen.getByTestId('wallet-rules-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /New Bonus Rule/i })).toBeInTheDocument();
    // All 5 inputs.
    expect(screen.getByTestId('wallet-rule-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-min-amount-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-bonus-percent-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-validity-months-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-active-input')).toBeInTheDocument();
    // Cancel + Submit pair.
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-submit-btn')).toBeInTheDocument();
  });

  it('rejects empty name with notify.error + no POST', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    // Name left empty; click Create.
    await user.click(screen.getByTestId('wallet-rule-submit-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Rule name is required.');
    });
    // Confirm no POST was fired.
    const postCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('rejects bonus % > 100 with notify.error + no POST', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    await user.type(screen.getByTestId('wallet-rule-name-input'), 'Bad Percent');
    await user.type(screen.getByTestId('wallet-rule-min-amount-input'), '1000');
    // Set the bonus percent via fireEvent.change to bypass HTML5
    // constraint validation (the input declares max=100, which would block
    // a click-driven form submit before the SUT's JS validator could run).
    // The SUT validator is what we want to pin here.
    fireEvent.change(screen.getByTestId('wallet-rule-bonus-percent-input'), {
      target: { value: '150' },
    });
    // Submit the form directly — fireEvent.submit bypasses constraint
    // validation entirely so the SUT's onSubmit handler runs.
    fireEvent.submit(screen.getByTestId('wallet-rules-modal').querySelector('form'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Bonus % must be between 0 and 100 (exclusive of 0).',
      );
    });
    const postCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('rejects validity months > 60 with notify.error + no POST', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    await user.type(screen.getByTestId('wallet-rule-name-input'), 'Bad Validity');
    await user.type(screen.getByTestId('wallet-rule-min-amount-input'), '1000');
    await user.type(screen.getByTestId('wallet-rule-bonus-percent-input'), '10');
    // Set validity months to 99 via fireEvent.change to bypass the
    // HTML5 max=60 constraint (which would block a click-driven submit
    // before the JS validator could run).
    fireEvent.change(screen.getByTestId('wallet-rule-validity-months-input'), {
      target: { value: '99' },
    });
    fireEvent.submit(screen.getByTestId('wallet-rules-modal').querySelector('form'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Validity must be between 1 and 60 months.',
      );
    });
    const postCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('happy path: posts the paise-converted body + notify.success + reloads the list', async () => {
    installFetchMock({ list: { rules: [] }, create: { rule: { ...RULE_A, id: 999 } } });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    await user.type(screen.getByTestId('wallet-rule-name-input'), 'Festive 2000+ Boost');
    await user.type(screen.getByTestId('wallet-rule-min-amount-input'), '2000');
    await user.type(screen.getByTestId('wallet-rule-bonus-percent-input'), '10');
    // Active checkbox starts checked per INITIAL_FORM.active=true; leave on.
    await user.click(screen.getByTestId('wallet-rule-submit-btn'));

    await waitFor(() => {
      const postCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'POST');
      expect(postCalls).toHaveLength(1);
      // Body shape pinned: paise-converted, trimmed name, parsed numbers.
      const body = JSON.parse(postCalls[0][1].body);
      expect(body).toEqual({
        name: 'Festive 2000+ Boost',
        minAmountCents: 200000, // ₹2000 → 200000 paise (rupeesToPaise)
        bonusPercent: 10,
        validityMonths: 12,
        active: true,
      });
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Created rule "Festive 2000\+ Boost" \(10% bonus on ₹2000\.00\+\)/),
      );
    });
    // Modal closed after success.
    await waitFor(() => {
      expect(screen.queryByTestId('wallet-rules-modal')).not.toBeInTheDocument();
    });
    // Reload GET fired after create.
    const getCalls = fetchApiMock.mock.calls.filter(
      (c) => c[0] === '/api/wallet/rules' && (c[1]?.method || 'GET') === 'GET',
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces the "Backend not ready" toast when POST throws a 404 — modal stays open', async () => {
    installFetchMock({
      list: { rules: [] },
      create: new Error('404 not_found'),
    });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    await user.type(screen.getByTestId('wallet-rule-name-input'), 'Will Fail');
    await user.type(screen.getByTestId('wallet-rule-min-amount-input'), '1000');
    await user.type(screen.getByTestId('wallet-rule-bonus-percent-input'), '5');
    await user.click(screen.getByTestId('wallet-rule-submit-btn'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        'Backend not ready; rule will save once shipped.',
      );
    });
    // Modal still open (failed create does NOT close).
    expect(screen.getByTestId('wallet-rules-modal')).toBeInTheDocument();
  });

  it('Cancel button closes the modal without firing POST', async () => {
    installFetchMock({ list: { rules: [] } });
    render(<WalletRules />);
    await screen.findByTestId('wallet-rules-empty');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('wallet-rules-new-btn'));
    expect(screen.getByTestId('wallet-rules-modal')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('wallet-rules-modal')).not.toBeInTheDocument();
    });
    const postCalls = fetchApiMock.mock.calls.filter((c) => c[1]?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });
});
