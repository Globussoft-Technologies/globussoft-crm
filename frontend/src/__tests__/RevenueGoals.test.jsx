/**
 * RevenueGoals.test.jsx — vitest + RTL coverage for the Revenue Goals admin
 * page (frontend/src/pages/RevenueGoals.jsx, 472 LOC).
 *
 * Target: per-staff revenue goal CRUD page (PRD Gap §1.6). Distinct from the
 * generic /api/quotas page — Quotas pins sales-rep "target attainment"
 * tracking across pipelines; RevenueGoals pins SALE-side revenue targets
 * filtered by SaleItem scope (ALL / SERVICE / PRODUCT / MEMBERSHIP) with
 * achievement computed live server-side from completed Sale.total values.
 *
 * Page surface pinned by this file
 * ─────────────────────────────────
 *  1. Mount fires GET /api/staff/revenue-goals AND (admin-only) GET /api/staff.
 *  2. Heading "Revenue Goals" + sub-copy + Target icon all render.
 *  3. Admin role: "New goal" CTA renders (data-testid=revenue-goal-new).
 *     Non-admin role (MANAGER/USER): "New goal" CTA does NOT render.
 *  4. Loading state: "Loading…" cell renders before the initial fetch resolves
 *     (the `<td>Loading…</td>` literal — pin against ICU drift per the
 *     2026-05-24 ~03:00 UTC cron-learning).
 *  5. Empty state: admin-specific copy "No revenue goals yet. Click \"New goal\"
 *     to add one." renders when the route returns []. Non-admin sees
 *     "No goals assigned to you yet."
 *  6. With rows: table renders one row per goal with the staff name (or
 *     `User #<id>` fallback when `row.user.name` is missing), period label,
 *     target amount (toLocaleString), achieved/% combo, and scope (or
 *     `<scope> / <filter>` when scopeFilter set). Action buttons (Edit /
 *     Delete) render for admin only.
 *  7. Progress widget: when rows.length > 0, the "Progress at a glance" card
 *     renders with one progress entry per goal (data-testid=goal-progress-<id>)
 *     showing the staff name + pct + the achieved/target/(period) sub-copy.
 *  8. Clicking "New goal" opens the modal with the heading "New revenue goal",
 *     the staff <select> populated from /api/staff, and an empty form (no id).
 *  9. Validation: clicking Save with empty userId fires
 *     notify.error('Pick a staff member.') and does NOT POST.
 * 10. Validation: targetAmount <= 0 fires
 *     notify.error('Target amount must be greater than zero.') and does NOT POST.
 * 11. Validation: empty periodStart/periodEnd fires
 *     notify.error('Period start + end are required.') and does NOT POST.
 * 12. Submit creates: valid form submit POSTs /api/staff/revenue-goals with
 *     `targetUserId` (NOT `userId` — the stripDangerous middleware strips
 *     `userId` from every body, see SUT lines 119-126 + comment about #717)
 *     + period + periodStart/End (ISO) + targetAmount (Number) + scope +
 *     scopeFilter:null when blank + notes:null when blank.
 * 13. Edit-from-row: clicking row Edit (data-testid=goal-edit-<id>) opens the
 *     modal in edit mode — heading "Edit revenue goal", staff select DISABLED
 *     (pre-selected), period/target prefilled from the row.
 * 14. Delete-from-row: clicking row Delete fires notify.confirm with
 *     {title, message, destructive:true}; confirm=true → DELETE
 *     /api/staff/revenue-goals/<id> + notify.success + re-fetch; confirm=false
 *     → no DELETE fires.
 *
 * Mocking discipline (per CLAUDE.md RTL standing rules)
 * ──────────────────────────────────────────────────────
 *   - fetchApi mocked at `../utils/api` with a single stable mock fn.
 *   - notifyObj is STABLE module-level (Wave 11 cfb5789 / Wave 12 f59e91d
 *     standing rule — fresh-per-call objects flap dep identity and infinite-
 *     re-render-hang the test).
 *   - AuthContext is wrapped per-render so the same SUT can be tested under
 *     ADMIN / MANAGER / USER roles. SUT reads only `user.role === 'ADMIN'`
 *     (SUT line 69) so any other role exhibits the read-only surface.
 *
 * Drift from the spec brief (prompt vs. actual SUT)
 * ──────────────────────────────────────────────────
 *   - Prompt anticipated "progress bars" — confirmed; rendered as a
 *     fixed-height div with a width-bound inner div (SUT lines 213-215).
 *     Not directly assertable via getByRole, so we pin the surrounding
 *     `<span>NN%</span>` + the achieved/target sub-copy.
 *   - Prompt anticipated "validation errors" — confirmed: 3 distinct guards
 *     (SUT lines 110-116) fire notify.error before setSaving(true). No
 *     client-side check on period-end > period-start; backend owns that.
 *   - Prompt anticipated "role-gated controls" — confirmed: `isAdmin` gates
 *     the New CTA (SUT line 186), the Actions <th>/<td> column (SUT lines
 *     236, 260), the Edit/Delete row buttons (SUT lines 262-269), AND the
 *     /api/staff fetch (SUT line 82). Non-admin renders a 6-col table with
 *     no actions and never fires /api/staff.
 *   - Field component renders <label> elements without `htmlFor` (SUT lines
 *     443-448) — `getByLabelText` would NOT find these inputs. Tests use
 *     either testid or "first input of type" lookups instead.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthContext } from '../App';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object — passed by reference to every render so SUT's
// useCallback / useEffect deps that capture the hook return identity stay
// stable across re-renders. Per CLAUDE.md "RTL: stable mock object
// references" standing rule (Wave 11 cfb5789 + Wave 12 f59e91d).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: (...args) => notifyConfirm(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import RevenueGoals from '../pages/RevenueGoals';

const sampleStaff = [
  { id: 1, name: 'Alice Rep', email: 'alice@example.com', role: 'USER' },
  { id: 2, name: 'Bob Manager', email: 'bob@example.com', role: 'MANAGER' },
  { id: 3, name: 'Carla Doctor', email: 'carla@example.com', role: 'USER' },
];

const sampleGoals = [
  {
    id: 100,
    userId: 1,
    user: { id: 1, name: 'Alice Rep' },
    period: 'MONTHLY',
    periodStart: '2026-05-01T00:00:00.000Z',
    periodEnd: '2026-06-01T00:00:00.000Z',
    targetAmount: 100000,
    achievedAmount: 75000,
    scope: 'ALL',
    scopeFilter: null,
    notes: null,
  },
  {
    id: 101,
    userId: 2,
    user: { id: 2, name: 'Bob Manager' },
    period: 'QUARTERLY',
    periodStart: '2026-04-01T00:00:00.000Z',
    periodEnd: '2026-07-01T00:00:00.000Z',
    targetAmount: 250000,
    achievedAmount: 280000,
    scope: 'SERVICE',
    scopeFilter: 'Aesthetics',
    notes: 'Cross-clinic',
  },
];

function defaultFetchMock(url) {
  if (url === '/api/staff/revenue-goals') return Promise.resolve(sampleGoals);
  if (url === '/api/staff') return Promise.resolve(sampleStaff);
  return Promise.resolve(null);
}

function renderPage({ role = 'ADMIN', userId = 99 } = {}) {
  return render(
    <AuthContext.Provider value={{ user: { userId, role } }}>
      <RevenueGoals />
    </AuthContext.Provider>
  );
}

describe('<RevenueGoals /> — admin page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
    fetchApiMock.mockImplementation(defaultFetchMock);
  });

  it('mounts and fires /api/staff/revenue-goals + (admin) /api/staff on mount', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => {
      const goalsCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/staff/revenue-goals');
      expect(goalsCall).toBeTruthy();
    });
    await waitFor(() => {
      const staffCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/staff');
      expect(staffCall).toBeTruthy();
    });
  });

  it('non-admin role does NOT fire /api/staff and hides the New goal CTA', async () => {
    renderPage({ role: 'USER' });
    // "Alice Rep" appears in both the progress widget AND the row, so use
    // getAllByText to wait for at least one instance.
    await waitFor(() => expect(screen.getAllByText('Alice Rep').length).toBeGreaterThanOrEqual(1));
    // /api/staff must NOT have fired — gated on isAdmin (SUT line 82).
    const staffCall = fetchApiMock.mock.calls.find(([u]) => u === '/api/staff');
    expect(staffCall).toBeUndefined();
    // CTA is admin-gated (SUT line 186).
    expect(screen.queryByTestId('revenue-goal-new')).not.toBeInTheDocument();
  });

  it('renders heading "Revenue Goals" + sub-copy + New goal CTA (admin)', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Revenue Goals/i })).toBeInTheDocument();
    });
    expect(screen.getByText(/Per-staff revenue targets/i)).toBeInTheDocument();
    expect(screen.getByTestId('revenue-goal-new')).toBeInTheDocument();
  });

  it('shows "Loading…" cell before the initial fetch resolves', async () => {
    let resolveGoals;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff/revenue-goals') {
        return new Promise((r) => { resolveGoals = r; });
      }
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderPage({ role: 'ADMIN' });
    // SUT renders the literal "Loading…" inside a td while loading (line 241).
    expect(await screen.findByText(/^Loading…$/)).toBeInTheDocument();
    resolveGoals([]);
    // Wait for empty-state to land so the test tears down cleanly.
    await waitFor(() => expect(screen.queryByText(/^Loading…$/)).not.toBeInTheDocument());
  });

  it('admin empty-state: "No revenue goals yet. Click \\"New goal\\" to add one." renders', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff/revenue-goals') return Promise.resolve([]);
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      return Promise.resolve(null);
    });
    renderPage({ role: 'ADMIN' });
    await waitFor(() => {
      expect(screen.getByText(/No revenue goals yet\./i)).toBeInTheDocument();
    });
  });

  it('non-admin empty-state: "No goals assigned to you yet." renders', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/staff/revenue-goals') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderPage({ role: 'USER' });
    await waitFor(() => {
      expect(screen.getByText(/No goals assigned to you yet\./i)).toBeInTheDocument();
    });
  });

  it('renders one row per goal with staff name, period, target, achieved/%, scope', async () => {
    renderPage({ role: 'ADMIN' });
    // Name appears in BOTH the progress widget AND the table row — use
    // getAllByText. Per CLAUDE.md "RTL: prefer getAllByText for labels that
    // appear as both filter chrome AND row badges" standing rule.
    await waitFor(() => expect(screen.getAllByText('Alice Rep').length).toBeGreaterThanOrEqual(2));
    expect(screen.getAllByText('Bob Manager').length).toBeGreaterThanOrEqual(2);
    // Period column — both periods present. (Note: "MONTHLY" also appears in
    // the progress-widget sub-copy for Alice, so we use getAllByText.)
    expect(screen.getAllByText('MONTHLY').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('QUARTERLY').length).toBeGreaterThanOrEqual(1);
    // Achieved column shows "N (PCT%)" — pin the percentage portion which
    // is the load-bearing rendered value. Numeric formatting is locale-
    // dependent on toLocaleString() (`100,000` en-US vs `1,00,000` en-IN)
    // per the 2026-05-07 wave-6 ICU-portability cron-learning; local node
    // and CI runners can differ. We assert the pct portion only — Alice
    // is 75/100=75%, Bob is 280/250=112% capped to 100% (SUT line 247).
    expect(screen.getByText(/\(75%\)/)).toBeInTheDocument();
    expect(screen.getByText(/\(100%\)/)).toBeInTheDocument();
    // Scope column: ALL renders bare; SERVICE renders as "SERVICE / Aesthetics"
    // (SUT line 259).
    expect(screen.getByText('ALL')).toBeInTheDocument();
    expect(screen.getByText('SERVICE / Aesthetics')).toBeInTheDocument();
    // Action buttons render under admin role.
    expect(screen.getByTestId('goal-edit-100')).toBeInTheDocument();
    expect(screen.getByTestId('goal-delete-100')).toBeInTheDocument();
    expect(screen.getByTestId('goal-edit-101')).toBeInTheDocument();
    expect(screen.getByTestId('goal-delete-101')).toBeInTheDocument();
  });

  it('renders the "Progress at a glance" widget with one entry per goal', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByText(/Progress at a glance/i)).toBeInTheDocument());
    // Per-row progress containers carry stable data-testids.
    expect(screen.getByTestId('goal-progress-100')).toBeInTheDocument();
    expect(screen.getByTestId('goal-progress-101')).toBeInTheDocument();
    // Per-progress sub-copy carries the period in parens after the
    // achieved/target pair. Use locale-flexible regex (numbers can render
    // as `75,000` en-US or `75,000`-with-en-IN-grouping) per the
    // ICU-portability cron-learning. Just assert the period token appears.
    const monthlyProgress = screen.getByTestId('goal-progress-100');
    expect(monthlyProgress.textContent).toMatch(/MONTHLY/);
    const quarterlyProgress = screen.getByTestId('goal-progress-101');
    expect(quarterlyProgress.textContent).toMatch(/QUARTERLY/);
    // Percentages appear inside each progress card too.
    expect(monthlyProgress.textContent).toMatch(/75%/);
    expect(quarterlyProgress.textContent).toMatch(/100%/);
  });

  it('non-admin renders rows but NO Edit/Delete action cells', async () => {
    renderPage({ role: 'USER' });
    await waitFor(() => expect(screen.getAllByText('Alice Rep').length).toBeGreaterThanOrEqual(1));
    // Actions column is admin-gated (SUT lines 236, 260).
    expect(screen.queryByTestId('goal-edit-100')).not.toBeInTheDocument();
    expect(screen.queryByTestId('goal-delete-100')).not.toBeInTheDocument();
  });

  it('clicking "New goal" opens the modal with "New revenue goal" heading + populated staff select', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('revenue-goal-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('revenue-goal-new'));

    expect(await screen.findByRole('heading', { name: /New revenue goal/i })).toBeInTheDocument();
    // Staff select (data-testid=goal-form-user) renders + carries the staff
    // options populated from /api/staff.
    const select = screen.getByTestId('goal-form-user');
    expect(select).toBeInTheDocument();
    // 3 staff options + 1 placeholder "— Select —" → 4 options.
    expect(select.querySelectorAll('option').length).toBe(1 + sampleStaff.length);
    // First option is the placeholder (value=""), subsequent are staff ids.
    expect(select.querySelectorAll('option')[0].value).toBe('');
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.value);
    expect(optionValues).toContain('1');
    expect(optionValues).toContain('2');
    expect(optionValues).toContain('3');
  });

  it('save with empty userId fires notify.error("Pick a staff member.") and does NOT POST', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('revenue-goal-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('revenue-goal-new'));
    await screen.findByTestId('goal-form-save');

    // No staff selected by default (emptyForm.userId = '').
    fireEvent.click(screen.getByTestId('goal-form-save'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Pick a staff member.');
    });
    // No POST fired.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/staff/revenue-goals' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('save with zero / blank targetAmount fires "Target amount must be greater than zero."', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('revenue-goal-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('revenue-goal-new'));
    await screen.findByTestId('goal-form-save');

    // Pick staff so the userId guard passes.
    fireEvent.change(screen.getByTestId('goal-form-user'), { target: { value: '1' } });
    // Leave target blank (default = '') and submit.
    fireEvent.click(screen.getByTestId('goal-form-save'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Target amount must be greater than zero.');
    });

    // Now try with explicit zero — same error path.
    notifyError.mockClear();
    fireEvent.change(screen.getByTestId('goal-form-target'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('goal-form-save'));
    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Target amount must be greater than zero.');
    });

    // No POST fired across either attempt.
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/staff/revenue-goals' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('save with empty periodStart/End fires "Period start + end are required."', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('revenue-goal-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('revenue-goal-new'));
    await screen.findByTestId('goal-form-save');

    // Pick staff + valid target.
    fireEvent.change(screen.getByTestId('goal-form-user'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('goal-form-target'), { target: { value: '50000' } });

    // Clear the period inputs (emptyForm pre-fills them with the current
    // month; we override to '' to trip the periodStart/periodEnd guard at
    // SUT lines 114-116).
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);
    fireEvent.change(dateInputs[0], { target: { value: '' } });
    fireEvent.change(dateInputs[1], { target: { value: '' } });

    fireEvent.click(screen.getByTestId('goal-form-save'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith('Period start + end are required.');
    });
    const postCall = fetchApiMock.mock.calls.find(
      ([u, opts]) => u === '/api/staff/revenue-goals' && opts?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('valid create POSTs /api/staff/revenue-goals with targetUserId (NOT userId) + period + ISO dates + targetAmount + scope', async () => {
    let postBody = null;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url === '/api/staff/revenue-goals' && opts?.method === 'POST') {
        postBody = JSON.parse(opts.body);
        return Promise.resolve({ id: 999 });
      }
      if (url === '/api/staff/revenue-goals') return Promise.resolve(sampleGoals);
      return Promise.resolve(null);
    });

    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('revenue-goal-new')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('revenue-goal-new'));
    await screen.findByTestId('goal-form-save');

    // Pick staff #1 + target 75000. periodStart/End are pre-filled by
    // emptyForm() to the current calendar month — fine for create.
    fireEvent.change(screen.getByTestId('goal-form-user'), { target: { value: '1' } });
    fireEvent.change(screen.getByTestId('goal-form-target'), { target: { value: '75000' } });

    fireEvent.click(screen.getByTestId('goal-form-save'));

    await waitFor(() => {
      expect(postBody).not.toBeNull();
    });
    // The wire-shape pin: backend validates targetUserId (NOT userId), because
    // stripDangerous middleware strips `userId` from every body. See SUT
    // lines 119-126 + the verbatim comment about #717.
    expect(postBody.targetUserId).toBe(1);
    expect(postBody.userId).toBeUndefined();
    expect(postBody.period).toBe('MONTHLY');
    expect(postBody.targetAmount).toBe(75000);
    expect(postBody.scope).toBe('ALL');
    // periodStart/End are ISO strings — verify they parse and the start <= end
    // (calendar-month boundary).
    const start = new Date(postBody.periodStart);
    const end = new Date(postBody.periodEnd);
    expect(Number.isFinite(start.getTime())).toBe(true);
    expect(Number.isFinite(end.getTime())).toBe(true);
    expect(start.getTime()).toBeLessThan(end.getTime());
    // Optional fields default to null when blank (SUT lines 134-135).
    expect(postBody.scopeFilter).toBeNull();
    expect(postBody.notes).toBeNull();
    // Success notification fires.
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('Revenue goal created.');
    });
  });

  it('row Edit opens modal in EDIT mode — heading "Edit revenue goal" + staff select disabled + prefilled values', async () => {
    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('goal-edit-100')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('goal-edit-100'));

    expect(await screen.findByRole('heading', { name: /Edit revenue goal/i })).toBeInTheDocument();
    const select = screen.getByTestId('goal-form-user');
    // Staff <select> is disabled in edit mode (SUT line 318: `disabled={Boolean(editing.id)}`).
    expect(select).toBeDisabled();
    expect(select.value).toBe('1'); // Alice's id.
    // Target prefilled from the row.
    expect(screen.getByTestId('goal-form-target').value).toBe('100000');
  });

  it('row Delete with confirm=true → notify.confirm({destructive:true, message:/Alice/}) → DELETE /api/staff/revenue-goals/<id> → re-fetch', async () => {
    let deletedUrl = null;
    let goalsCallCount = 0;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url === '/api/staff/revenue-goals' && (!opts || !opts.method || opts.method === 'GET')) {
        goalsCallCount += 1;
        return Promise.resolve(sampleGoals);
      }
      if (/^\/api\/staff\/revenue-goals\/\d+$/.test(url) && opts?.method === 'DELETE') {
        deletedUrl = url;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });

    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('goal-delete-100')).toBeInTheDocument());
    const initialGoalsCount = goalsCallCount;

    fireEvent.click(screen.getByTestId('goal-delete-100'));

    // notify.confirm fires with the row name woven into the message.
    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    const arg = notifyConfirm.mock.calls[0][0];
    expect(arg.title).toMatch(/Delete revenue goal/i);
    expect(arg.message).toMatch(/Alice Rep/);
    expect(arg.message).toMatch(/monthly/i);
    expect(arg.destructive).toBe(true);
    expect(arg.confirmText).toMatch(/Delete/i);

    // DELETE fires for goal 100; the list re-fetches afterwards.
    await waitFor(() => {
      expect(deletedUrl).toBe('/api/staff/revenue-goals/100');
      expect(goalsCallCount).toBeGreaterThan(initialGoalsCount);
    });
    await waitFor(() => {
      expect(notifySuccess).toHaveBeenCalledWith('Goal deleted.');
    });
  });

  it('row Delete with confirm=false → no DELETE fires', async () => {
    notifyConfirm.mockImplementation(() => Promise.resolve(false));
    let deletedUrl = null;
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/staff') return Promise.resolve(sampleStaff);
      if (url === '/api/staff/revenue-goals' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve(sampleGoals);
      }
      if (/^\/api\/staff\/revenue-goals\/\d+$/.test(url) && opts?.method === 'DELETE') {
        deletedUrl = url;
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    });

    renderPage({ role: 'ADMIN' });
    await waitFor(() => expect(screen.getByTestId('goal-delete-100')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('goal-delete-100'));

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Give the page a tick to potentially fire a DELETE; assert it did NOT.
    await new Promise((r) => setTimeout(r, 30));
    expect(deletedUrl).toBeNull();
  });
});
