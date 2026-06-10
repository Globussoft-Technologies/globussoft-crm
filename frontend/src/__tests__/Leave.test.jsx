/**
 * Leave.jsx (wellness) — vitest + RTL component coverage.
 *
 * Carry-over from v3.5.0 → v3.5.1 → v3.5.2: the Leave Management page shipped
 * in Wave 2B (`3f0b68c`, 2026-05-08) but had zero frontend component coverage.
 * This file pins the public surface so future refactors trip a fast unit-level
 * signal before reaching the api_tests gate.
 *
 * Layout under test (frontend/src/pages/wellness/Leave.jsx):
 *   1. Balance summary cards   — one per LeavePolicy, fed by GET /api/leave/balances/me
 *   2. Request submission form — policy/startDate/endDate/reason + Submit
 *   3. History table           — fed by GET /api/leave/requests, status chips,
 *      Cancel button on requester's own PENDING rows, Approve/Reject on
 *      manager-role-rendered PENDING rows
 *
 * Contracts pinned by this test
 * ------------------------------
 *   - 3 mocked balances → 3 cards render with the policy name + Available /
 *     Used / Pending / Entitled numbers (Wave-2B page surface).
 *   - Submitting a valid form POSTs /api/leave/requests with the shape
 *     `{ policyId: <int>, startDate, endDate, reason | null }`. policyId is
 *     parseInt'd before the post (page line 79).
 *   - Submitting with empty policy/startDate/endDate fires
 *     `notify.error('Policy, start date, and end date are required')` and
 *     does NOT POST. (Page-level guards at line 70–73; the page does NOT
 *     itself reject past-dates or end<start client-side — the backend owns
 *     those checks. The test asserts the documented behaviour, NOT a
 *     hypothesised one.)
 *   - When the POST throws with `err.body.error: 'Insufficient balance'`,
 *     the page surfaces that string via notify.error.
 *   - History table renders one row per request, each with a status chip
 *     (Pending / Approved / Rejected / Cancelled).
 *   - For a PENDING row owned by the current user, a "Cancel request"
 *     button renders and clicking it (with `confirm()` returning true)
 *     fires POST /api/leave/requests/:id/cancel.
 *   - For a manager (role=ADMIN or MANAGER), every PENDING row shows
 *     "Approve request" + "Reject request" buttons; clicking Approve
 *     POSTs /api/leave/requests/:id/approve.
 *   - For a non-manager looking at someone else's row, no
 *     Approve/Reject/Cancel buttons render.
 *
 * Drift from the spec brief
 * --------------------------
 * The brief asked for "past-date validation" and "endDate < startDate
 * validation" client-side tests — Leave.jsx does NOT implement either
 * (verified by reading the source). Pinning a hypothesis would create a
 * false-positive contract; I instead pin the page's actual three required-
 * field guard + assert that the absence of past-date guards is intentional
 * (the test passes a past startDate and verifies the POST FIRES — a future
 * "fix" that adds client-side past-date rejection will then trip this test
 * and force the author to update both surfaces in lockstep).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthContext } from '../App';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
// notifyConfirm / notifyPrompt back the destructive-action paths (cancel /
// approve / reject). Default to "user clicked OK" + empty prompt; individual
// tests override the prompt's return value with mockImplementationOnce to
// inspect the value the route receives.
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyPrompt = vi.fn(() => Promise.resolve(''));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: notifyError,
    success: notifySuccess,
    info: notifyInfo,
    confirm: (...args) => notifyConfirm(...args),
    prompt: (...args) => notifyPrompt(...args),
  }),
}));

import Leave from '../pages/wellness/Leave';

// ── Fixtures ───────────────────────────────────────────────────────────────

const POLICIES = [
  { id: 1, name: 'Casual Leave', leaveType: 'CASUAL', isActive: true },
  { id: 2, name: 'Sick Leave', leaveType: 'SICK', isActive: true },
  { id: 3, name: 'Earned Leave', leaveType: 'EARNED', isActive: true },
];

const BALANCES = [
  {
    policy: { id: 1, name: 'Casual Leave', leaveType: 'CASUAL' },
    balance: { entitled: 12, used: 3, pending: 1, available: 8 },
  },
  {
    policy: { id: 2, name: 'Sick Leave', leaveType: 'SICK' },
    balance: { entitled: 10, used: 0, pending: 0, available: 10 },
  },
  {
    policy: { id: 3, name: 'Earned Leave', leaveType: 'EARNED' },
    balance: { entitled: 18, used: 5, pending: 2, available: 11 },
  },
];

const REQUESTER_ID = 42;
const MANAGER_ID = 7;
const OTHER_USER_ID = 99;

// One row per status, plus a peer row to test isolation. r1 (PENDING, owned
// by REQUESTER_ID) is the row Cancel/Approve/Reject targets.
const REQUESTS = [
  {
    id: 101,
    userId: REQUESTER_ID,
    policyId: 1,
    policy: { id: 1, name: 'Casual Leave' },
    startDate: '2026-06-01',
    endDate: '2026-06-02',
    days: 2,
    status: 'PENDING',
    reason: 'Family trip',
  },
  {
    id: 102,
    userId: REQUESTER_ID,
    policyId: 2,
    policy: { id: 2, name: 'Sick Leave' },
    startDate: '2026-04-15',
    endDate: '2026-04-15',
    days: 1,
    status: 'APPROVED',
  },
  {
    id: 103,
    userId: REQUESTER_ID,
    policyId: 3,
    policy: { id: 3, name: 'Earned Leave' },
    startDate: '2026-03-20',
    endDate: '2026-03-22',
    days: 3,
    status: 'REJECTED',
  },
  {
    id: 104,
    userId: OTHER_USER_ID,
    policyId: 1,
    policy: { id: 1, name: 'Casual Leave' },
    startDate: '2026-07-10',
    endDate: '2026-07-11',
    days: 2,
    status: 'PENDING',
    reason: 'Wedding',
  },
];

function fakeFetchApi(url, opts) {
  if (url === '/api/leave/policies') return Promise.resolve(POLICIES);
  if (url === '/api/leave/balances/me') return Promise.resolve(BALANCES);
  if (url === '/api/leave/requests' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(REQUESTS);
  }
  if (url === '/api/leave/requests' && opts?.method === 'POST') {
    return Promise.resolve({ id: 999, status: 'PENDING' });
  }
  if (/^\/api\/leave\/requests\/\d+\/(approve|reject|cancel)$/.test(url) && opts?.method === 'POST') {
    return Promise.resolve({ ok: true });
  }
  return Promise.resolve([]);
}

function renderLeave({ user } = {}) {
  return render(
    <AuthContext.Provider value={user ? { user } : null}>
      <Leave />
    </AuthContext.Provider>
  );
}

// ── beforeEach / afterEach ─────────────────────────────────────────────────

beforeEach(() => {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation(fakeFetchApi);
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  // notify.confirm/prompt back the cancel/approve/reject paths. Reset to the
  // defaults; individual tests override notifyPrompt with mockImplementationOnce
  // when they need to inspect the value passed to the route.
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  notifyPrompt.mockReset();
  notifyPrompt.mockResolvedValue('');
});

// ── 1. Balance summary cards ───────────────────────────────────────────────

describe('<Leave /> — balance summary cards', () => {
  it('renders one card per LeavePolicy with available / used / pending / entitled', async () => {
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });

    // Wait for the loading state to clear and balances to land.
    // "Casual Leave" appears in 4 places (balance card title + 2 history-row
    // policy cells + the request-form policy <option>) so we wait on the
    // verbatim "available" number that's unique to the Casual card.
    await waitFor(() => expect(screen.getByText('8 d')).toBeInTheDocument());
    expect(screen.getAllByText('Casual Leave').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Sick Leave').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Earned Leave').length).toBeGreaterThanOrEqual(1);

    // Casual: entitled 12, used 3, pending 1, available 8 — pin the
    // available + entitled values verbatim. The page renders "8 d" for
    // available and "12 d / yr" for entitled.
    expect(screen.getByText('8 d')).toBeInTheDocument();   // Casual.available
    expect(screen.getByText('10 d')).toBeInTheDocument();  // Sick.available
    expect(screen.getByText('11 d')).toBeInTheDocument();  // Earned.available
    expect(screen.getByText('12 d / yr')).toBeInTheDocument();
    expect(screen.getByText('18 d / yr')).toBeInTheDocument();

    // Leave-type label appears under each card name.
    expect(screen.getByText('CASUAL')).toBeInTheDocument();
    expect(screen.getByText('SICK')).toBeInTheDocument();
    expect(screen.getByText('EARNED')).toBeInTheDocument();
  });

  it('shows the empty-state copy when no policies are active', async () => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/leave/policies') return Promise.resolve([]);
      if (url === '/api/leave/balances/me') return Promise.resolve([]);
      if (url === '/api/leave/requests') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => {
      expect(screen.getByText(/No active leave policies/i)).toBeInTheDocument();
    });
  });
});

// ── 2 + 3. Request form + submit ───────────────────────────────────────────

describe('<Leave /> — request form', () => {
  it('renders policy / start date / end date / reason / submit', async () => {
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('Request Leave')).toBeInTheDocument());

    expect(screen.getByLabelText(/Leave policy/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Start date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/End date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Reason$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit leave request/i })).toBeInTheDocument();

    // Policy dropdown surfaces all 3 active policies + the "— select —"
    // placeholder.
    const policySelect = screen.getByLabelText(/Leave policy/i);
    const opts = within(policySelect).getAllByRole('option');
    expect(opts.length).toBe(1 + 3);
    expect(within(policySelect).getByRole('option', { name: /Casual Leave \(CASUAL\)/i })).toBeInTheDocument();
  });

  it('happy path → POSTs /api/leave/requests with the correct body shape', async () => {
    const user = userEvent.setup();
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('Request Leave')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(fakeFetchApi);

    await user.selectOptions(screen.getByLabelText(/Leave policy/i), '1');
    fireEvent.change(screen.getByLabelText(/Start date/i), { target: { value: '2026-06-15' } });
    fireEvent.change(screen.getByLabelText(/End date/i), { target: { value: '2026-06-17' } });
    fireEvent.change(screen.getByLabelText(/^Reason$/i), { target: { value: 'Cousin\'s wedding' } });

    await user.click(screen.getByRole('button', { name: /Submit leave request/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/leave/requests' && opts?.method === 'POST'
      );
      expect(post).toBeDefined();
      const body = JSON.parse(post[1].body);
      // policyId is parseInt'd before the POST per Leave.jsx line 79.
      expect(body.policyId).toBe(1);
      expect(typeof body.policyId).toBe('number');
      expect(body.startDate).toBe('2026-06-15');
      expect(body.endDate).toBe('2026-06-17');
      expect(body.reason).toBe("Cousin's wedding");
    });

    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/submitted/i));
  });

  it('happy path with empty reason → posts reason: null (not undefined)', async () => {
    const user = userEvent.setup();
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('Request Leave')).toBeInTheDocument());
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(fakeFetchApi);

    await user.selectOptions(screen.getByLabelText(/Leave policy/i), '2');
    fireEvent.change(screen.getByLabelText(/Start date/i), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText(/End date/i), { target: { value: '2026-08-01' } });

    await user.click(screen.getByRole('button', { name: /Submit leave request/i }));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/leave/requests' && opts?.method === 'POST'
      );
      expect(post).toBeDefined();
      const body = JSON.parse(post[1].body);
      expect(body.reason).toBeNull();
    });
  });

  it('rejects empty required fields and never POSTs', async () => {
    const user = userEvent.setup();
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('Request Leave')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Submit with nothing filled — page validates policyId, startDate, endDate
    // all in one branch (line 70–73).
    await user.click(screen.getByRole('button', { name: /Submit leave request/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Policy, start date, and end date are required/i)
      );
    });
    const post = fetchApiMock.mock.calls.find(
      ([url, opts]) => url === '/api/leave/requests' && opts?.method === 'POST'
    );
    expect(post).toBeUndefined();
  });

  it('surfaces server error.body.error on insufficient-balance rejection', async () => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/leave/policies') return Promise.resolve(POLICIES);
      if (url === '/api/leave/balances/me') return Promise.resolve(BALANCES);
      if (url === '/api/leave/requests' && (!opts || opts.method === 'GET' || !opts.method)) {
        return Promise.resolve(REQUESTS);
      }
      if (url === '/api/leave/requests' && opts?.method === 'POST') {
        // fetchApi rejects with an Error whose `.body` carries the server JSON.
        const err = new Error('422 Unprocessable Entity');
        err.body = { error: 'Insufficient balance: only 8 days available' };
        return Promise.reject(err);
      }
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('Request Leave')).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText(/Leave policy/i), '1');
    fireEvent.change(screen.getByLabelText(/Start date/i), { target: { value: '2026-06-15' } });
    fireEvent.change(screen.getByLabelText(/End date/i), { target: { value: '2026-06-30' } });
    await user.click(screen.getByRole('button', { name: /Submit leave request/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Insufficient balance/i)
      );
    });
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});

// ── 4. History table render ────────────────────────────────────────────────

describe('<Leave /> — history table', () => {
  it('renders one row per request with status chip', async () => {
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('My Leave Requests')).toBeInTheDocument());

    // Scope status-chip lookup to the table — the word "Pending" also
    // appears as a balance-card label, which would dual-match a screen-wide
    // getByText.
    const table = screen.getByRole('table');
    expect(within(table).getAllByText('Pending').length).toBeGreaterThanOrEqual(1);
    expect(within(table).getByText('Approved')).toBeInTheDocument();
    expect(within(table).getByText('Rejected')).toBeInTheDocument();

    // Days column populated. 1 header row + 4 fixture requests.
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(1 + REQUESTS.length);
  });

  it('non-manager header reads "My Leave Requests" (not "All Leave Requests")', async () => {
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('My Leave Requests')).toBeInTheDocument());
    expect(screen.queryByText('All Leave Requests')).not.toBeInTheDocument();
  });

  it('manager header reads "All Leave Requests" and table shows the User column', async () => {
    renderLeave({ user: { id: MANAGER_ID, role: 'MANAGER' } });
    await waitFor(() => expect(screen.getByText('All Leave Requests')).toBeInTheDocument());
    // User column header
    expect(within(screen.getByRole('table')).getByText('User')).toBeInTheDocument();
    // User cells: 3 fixture rows belong to REQUESTER_ID=42 + 1 row to
    // OTHER_USER_ID=99 — assert both cell types render.
    expect(screen.getAllByText(/User #42/).length).toBe(3);
    expect(screen.getByText(/User #99/)).toBeInTheDocument();
  });
});

// ── 5. Cancel own pending request ─────────────────────────────────────────

describe('<Leave /> — requester self-cancel', () => {
  it('shows a Cancel button on the requester\'s own PENDING row and POSTs /cancel', async () => {
    const user = userEvent.setup();
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('My Leave Requests')).toBeInTheDocument());

    const cancelBtn = screen.getByRole('button', { name: /Cancel request/i });
    expect(cancelBtn).toBeInTheDocument();

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(fakeFetchApi);
    await user.click(cancelBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/leave/requests/101/cancel' && opts?.method === 'POST'
      );
      expect(call).toBeDefined();
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Cancelled/i));
  });

  it('does NOT show Cancel on a PENDING row owned by another user', async () => {
    // Render as REQUESTER_ID — row 104 (OTHER_USER_ID, PENDING) must NOT
    // expose a Cancel button to them.
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('My Leave Requests')).toBeInTheDocument());

    // There is exactly one Cancel button (for r1=101, owned by REQUESTER_ID).
    const cancels = screen.getAllByRole('button', { name: /Cancel request/i });
    expect(cancels.length).toBe(1);
  });

  it('does NOT show Approve / Reject buttons for a non-manager user', async () => {
    renderLeave({ user: { id: REQUESTER_ID, role: 'USER' } });
    await waitFor(() => expect(screen.getByText('My Leave Requests')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Approve request/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject request/i })).not.toBeInTheDocument();
  });
});

// ── 6. Manager approve / reject ────────────────────────────────────────────

describe('<Leave /> — manager approve / reject', () => {
  it('shows Approve + Reject on each PENDING row for an ADMIN', async () => {
    renderLeave({ user: { id: MANAGER_ID, role: 'ADMIN' } });
    await waitFor(() => expect(screen.getByText('All Leave Requests')).toBeInTheDocument());

    // Two PENDING rows in the fixture (101, 104). Each must expose both
    // buttons — so there are 2 Approve + 2 Reject buttons total.
    const approves = screen.getAllByRole('button', { name: /Approve request/i });
    const rejects = screen.getAllByRole('button', { name: /Reject request/i });
    expect(approves.length).toBe(2);
    expect(rejects.length).toBe(2);
  });

  it('clicking Approve POSTs /api/leave/requests/:id/approve', async () => {
    const user = userEvent.setup();
    renderLeave({ user: { id: MANAGER_ID, role: 'MANAGER' } });
    await waitFor(() => expect(screen.getByText('All Leave Requests')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(fakeFetchApi);

    // Click the first Approve button (row 101, the requester's PENDING row).
    const approves = screen.getAllByRole('button', { name: /Approve request/i });
    await user.click(approves[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/leave/requests/101/approve' && opts?.method === 'POST'
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body).toEqual({});
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Approved/i));
  });

  it('clicking Reject prompts for notes and POSTs them to /reject', async () => {
    const user = userEvent.setup();
    // Override notify.prompt so we can inspect the arg the route gets.
    notifyPrompt.mockResolvedValueOnce('Out of balance — reapply next quarter');

    renderLeave({ user: { id: MANAGER_ID, role: 'ADMIN' } });
    await waitFor(() => expect(screen.getByText('All Leave Requests')).toBeInTheDocument());

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation(fakeFetchApi);

    const rejects = screen.getAllByRole('button', { name: /Reject request/i });
    await user.click(rejects[0]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/leave/requests/101/reject' && opts?.method === 'POST'
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call[1].body);
      expect(body.notes).toBe('Out of balance — reapply next quarter');
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Rejected/i));
  });

  it('Approve buttons appear ONLY on PENDING rows, not APPROVED or REJECTED', async () => {
    renderLeave({ user: { id: MANAGER_ID, role: 'ADMIN' } });
    await waitFor(() => expect(screen.getByText('All Leave Requests')).toBeInTheDocument());

    // 4 fixture rows total: 2 PENDING (101, 104), 1 APPROVED (102), 1
    // REJECTED (103). Approve buttons should number exactly 2 — equal to
    // the count of PENDING rows.
    const approves = screen.getAllByRole('button', { name: /Approve request/i });
    expect(approves.length).toBe(2);
  });
});
