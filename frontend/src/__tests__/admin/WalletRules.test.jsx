/**
 * WalletRules.test.jsx — vitest + RTL coverage for the admin wallet bonus
 * rule CRUD page (frontend/src/pages/admin/WalletRules.jsx, shipped Arc 1
 * D16 slice 5 PARTIAL, scaffolds frontend ahead of the backend route
 * Agent B ships next tick at slice 3).
 *
 * Scope: pins the page-surface invariants for the FR-3.6 wallet-rule
 * configuration UI:
 *   1. Page renders the "Wallet Bonus Rules" heading.
 *   2. Initial GET to /api/wallet/rules fires on mount.
 *   3. 404 from /api/wallet/rules → graceful empty-state ("No bonus rules
 *      yet") + a friendly "Backend not yet deployed" banner (the route
 *      ships next tick — the page is intentionally robust to its absence).
 *   4. Empty-state copy: "No bonus rules yet" message visible.
 *   5. Clicking "+ New Rule" opens a modal with Name + Min Amount + Bonus %
 *      + Validity (months) + Active toggle inputs.
 *   6. Submit fires POST /api/wallet/rules with rupee→paise math correct
 *      (input ₹2000 → body minAmountCents: 200000).
 *   7. RBAC: USER role wrapped in <RoleGuard allow={['ADMIN']}> renders the
 *      lock panel instead of the page (mirrors how the route is mounted
 *      in App.jsx).
 *
 * Backend contract pinned (per PRD_WALLET_TOPUP.md §3.6 + FR-3.1 schema):
 *   GET    /api/wallet/rules          → { rules: [{ id, name, minAmountCents,
 *                                                    bonusPercent, validityMonths,
 *                                                    active, ... }] }
 *   POST   /api/wallet/rules          { name, minAmountCents, bonusPercent,
 *                                       validityMonths, active } → 201 envelope
 *
 * Why
 *   This page is the operator surface that lets a clinic configure bonus
 *   rules without DB access. A silent regression in the rupee→paise math
 *   would write the wrong threshold (10x too high or too low) and silently
 *   break the bonus engine. The Backend-not-deployed banner is load-bearing
 *   for slice 5's "ship ahead of backend" contract — without it the page
 *   would render a scary error toast on every mount until slice 3 lands.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rule):
 *   - fetchApi mocked at ../../utils/api (the page's dependency surface).
 *   - notifyObj is a STABLE module-level object reference so useNotify's
 *     identity stays stable across renders.
 *   - All data-dependent assertions use await findBy / waitFor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object: the SUT's handleSubmit closes over the notify
// reference. A per-call fresh object would force re-renders.
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: vi.fn(),
};
vi.mock('../../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import WalletRules from '../../pages/admin/WalletRules';
import RoleGuard from '../../components/RoleGuard';
import { AuthContext } from '../../App';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const STAFF_USER = { userId: 2, name: 'Staff', email: 's@x.com', role: 'USER' };

function renderPage(user = ADMIN_USER) {
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
      <WalletRules />
    </AuthContext.Provider>,
  );
}

function renderPageInsideRoleGuard(user) {
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
      <RoleGuard allow={['ADMIN']} feature="Wallet Bonus Rules">
        <WalletRules />
      </RoleGuard>
    </AuthContext.Provider>,
  );
}

describe('<WalletRules /> — admin wallet bonus rule CRUD page', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('renders the "Wallet Bonus Rules" heading', async () => {
    fetchApiMock.mockResolvedValue({ rules: [] });
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Wallet Bonus Rules/i })).toBeInTheDocument();
    });
  });

  it('fires GET /api/wallet/rules on mount; 404 → empty-state + backend-pending banner', async () => {
    // Simulate the route not existing yet — fetchApi throws a 404-ish error.
    fetchApiMock.mockRejectedValueOnce(new Error('404 Not Found'));
    renderPage();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/wallet/rules');
    });
    // Empty-state + the banner explaining the backend isn't deployed yet.
    await waitFor(() => {
      expect(screen.getByTestId('wallet-rules-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('wallet-rules-backend-pending')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rules-empty')).toHaveTextContent(/No bonus rules yet/i);
  });

  it('empty-state copy: "No bonus rules yet. Click + New Rule to create one."', async () => {
    fetchApiMock.mockResolvedValue({ rules: [] });
    renderPage();
    const empty = await screen.findByTestId('wallet-rules-empty');
    expect(empty).toHaveTextContent(/No bonus rules yet/i);
    expect(empty).toHaveTextContent(/Click \+ New Rule to create one/i);
  });

  it('clicking "+ New Rule" opens a modal with Name + Min Amount + Bonus % + Validity inputs', async () => {
    fetchApiMock.mockResolvedValue({ rules: [] });
    renderPage();
    await screen.findByTestId('wallet-rules-empty');
    fireEvent.click(screen.getByTestId('wallet-rules-new-btn'));
    expect(screen.getByTestId('wallet-rules-modal')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-name-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-min-amount-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-bonus-percent-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-validity-months-input')).toBeInTheDocument();
    expect(screen.getByTestId('wallet-rule-active-input')).toBeInTheDocument();
  });

  it('submit fires POST /api/wallet/rules with rupees→paise math correct', async () => {
    fetchApiMock.mockResolvedValueOnce({ rules: [] }); // initial GET
    renderPage();
    await screen.findByTestId('wallet-rules-empty');
    fireEvent.click(screen.getByTestId('wallet-rules-new-btn'));

    // Fill in: ₹2000 min → 200000 paise, 10% bonus, 12 months validity, active.
    fireEvent.change(screen.getByTestId('wallet-rule-name-input'), {
      target: { value: 'Festive 2000+ Boost' },
    });
    fireEvent.change(screen.getByTestId('wallet-rule-min-amount-input'), {
      target: { value: '2000' },
    });
    fireEvent.change(screen.getByTestId('wallet-rule-bonus-percent-input'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByTestId('wallet-rule-validity-months-input'), {
      target: { value: '12' },
    });

    fetchApiMock.mockClear();
    fetchApiMock
      .mockResolvedValueOnce({ id: 1, name: 'Festive 2000+ Boost' }) // POST response
      .mockResolvedValueOnce({ rules: [] }); // post-create refresh

    fireEvent.click(screen.getByTestId('wallet-rule-submit-btn'));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/wallet/rules' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body).toEqual({
        name: 'Festive 2000+ Boost',
        minAmountCents: 200000, // ₹2000 × 100
        bonusPercent: 10,
        validityMonths: 12,
        active: true,
      });
    });
  });

  it('RBAC: USER role wrapped in <RoleGuard allow=ADMIN> renders the lock panel, NOT the page', async () => {
    fetchApiMock.mockResolvedValue({ rules: [] });
    renderPageInsideRoleGuard(STAFF_USER);
    // The RoleGuard's locked panel renders instead of the page chrome.
    expect(screen.getByTestId('role-guard-locked-panel')).toBeInTheDocument();
    // Page's own chrome (level-1 heading + "+ New Rule" button) NEVER mounts.
    // (The lock panel's level-2 heading reads "Wallet Bonus Rules is restricted"
    // — different role + different text, so this assertion correctly distinguishes
    // page-not-rendered from page-rendered.)
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByTestId('wallet-rules-new-btn')).not.toBeInTheDocument();
    // The page never mounted → fetchApi was never called.
    expect(fetchApiMock).not.toHaveBeenCalled();
  });

  it('RBAC: ADMIN role inside the same RoleGuard wrapper DOES see the page', async () => {
    fetchApiMock.mockResolvedValue({ rules: [] });
    renderPageInsideRoleGuard(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Wallet Bonus Rules/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('role-guard-locked-panel')).not.toBeInTheDocument();
  });
});
