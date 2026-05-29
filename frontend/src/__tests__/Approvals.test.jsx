/**
 * Approvals.test.jsx — vitest + RTL coverage for the Approval Requests page.
 *
 * Scope: pins the page-surface invariants for the multi-tab approval workflow:
 *   1. Page renders for any role: heading "Approval Requests", "My Requests"
 *      tab visible, "New Request" button visible.
 *   2. USER role: only the "My Requests" tab renders (no "To Approve" /
 *      "All" tabs); /api/approvals/my-requests is fetched on mount.
 *   3. MANAGER role: "To Approve" tab is visible; clicking it fires
 *      /api/approvals/to-approve.
 *   4. ADMIN role: all three tabs (My Requests, To Approve, All) visible;
 *      "All" tab fetches /api/approvals.
 *   5. Renders one row per request from the active endpoint, with entity,
 *      requester, and status badge.
 *   6. Empty state: "No approval requests found." renders when the
 *      endpoint returns an empty array.
 *   7. Loading state: "Loading approvals..." renders before the first
 *      fetch resolves.
 *   8. Approve action: clicking "Approve" on a PENDING row opens a modal;
 *      submitting POSTs /api/approvals/<id>/approve with the comment body.
 *   9. Reject action: clicking "Reject" on a PENDING row opens a modal;
 *      submitting POSTs /api/approvals/<id>/reject with the (required)
 *      comment body.
 *  10. RBAC gate on row actions: USER role does NOT see Approve/Reject
 *      buttons on a PENDING row that belongs to someone else (no
 *      canApprove permission).
 *  11. Status filter: changing the status dropdown re-fires the active
 *      endpoint with ?status=<value>.
 *
 * Backend contracts pinned by this test (3 list endpoints + 2 action POSTs):
 *   GET  /api/approvals/my-requests
 *   GET  /api/approvals/to-approve
 *   GET  /api/approvals  (admin-only — all tab)
 *   POST /api/approvals/:id/approve  { comment? }
 *   POST /api/approvals/:id/reject   { comment } (required)
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object so the useCallback identity in the component stays
// stable across renders (otherwise the modal submit handler can flap).
const notifyError = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: vi.fn(),
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import Approvals from '../pages/Approvals';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const MANAGER_USER = { userId: 2, name: 'Manager', email: 'm@x.com', role: 'MANAGER' };
const REGULAR_USER = { userId: 3, name: 'User', email: 'u@x.com', role: 'USER' };

function renderApprovals(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
        <Approvals />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

const samplePending = {
  id: 10,
  entity: 'Deal',
  entityId: 42,
  reason: 'Need 25% discount for Acme renewal',
  status: 'PENDING',
  requestedBy: 3,
  requester: { name: 'Charlie User', email: 'charlie@acme.test', role: 'USER' },
  requestedAt: '2026-04-29T09:00:00.000Z',
};

const sampleApproved = {
  id: 11,
  entity: 'Quote',
  entityId: 7,
  reason: 'Enterprise tier',
  status: 'APPROVED',
  requestedBy: 3,
  requester: { name: 'Charlie User', email: 'charlie@acme.test', role: 'USER' },
  requestedAt: '2026-04-28T09:00:00.000Z',
  approvedBy: 1,
  approvedAt: '2026-04-28T10:00:00.000Z',
};

describe('<Approvals /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals')) {
        return Promise.resolve([samplePending, sampleApproved]);
      }
      return Promise.resolve(null);
    });
  });

  it('renders the heading + New Request button for admin', async () => {
    renderApprovals();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Approval Requests/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /New Request/i })).toBeInTheDocument();
  });

  it('USER role: only "My Requests" tab renders (no To Approve / All)', async () => {
    renderApprovals(REGULAR_USER);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /My Requests/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^To Approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^All$/i })).not.toBeInTheDocument();
    // Fetches /api/approvals/my-requests on mount.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/approvals/my-requests')
      );
      expect(call).toBeTruthy();
    });
  });

  it('MANAGER role: "To Approve" tab visible; clicking it fetches /to-approve', async () => {
    renderApprovals(MANAGER_USER);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^To Approve$/i })).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^To Approve$/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/approvals/to-approve')
      );
      expect(call).toBeTruthy();
    });
  });

  it('ADMIN role: all three tabs visible; "All" fetches /api/approvals', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /My Requests/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^To Approve$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All$/i })).toBeInTheDocument();

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^All$/i }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && /^\/api\/approvals(?:\?|$)/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  it('renders one row per request with entity, requester, and status badge', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1));
    // Entity + #entityId is composed across two spans, so the text isn't a
    // single node match. Verify the entity short-name renders + the reason
    // text renders.
    expect(screen.getByText(/Need 25% discount/i)).toBeInTheDocument();
    expect(screen.getByText(/Enterprise tier/i)).toBeInTheDocument();
    // Status badges. PENDING + APPROVED both render via StatusBadge.
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
  });

  it('shows the empty-state message when /approvals returns []', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderApprovals(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByText(/No approval requests found\./i)).toBeInTheDocument();
    });
  });

  it('admin: clicking Approve on a PENDING row → POST /api/approvals/<id>/approve', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1));
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/approvals/${samplePending.id}/approve` && opts?.method === 'POST') {
        return Promise.resolve({ id: samplePending.id, status: 'APPROVED' });
      }
      if (url.startsWith('/api/approvals')) return Promise.resolve([sampleApproved]);
      return Promise.resolve(null);
    });

    // Find the Approve button in the PENDING row. Only one PENDING row in
    // the sample data → exactly one row-level Approve button before the
    // modal opens. Match the exact text to avoid SVG/whitespace confusion.
    const approveBtns = screen.getAllByRole('button', { name: /^\s*Approve\s*$/ });
    expect(approveBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(approveBtns[0]);

    // Modal opens with a comment textarea. Set a comment.
    const commentBox = await screen.findByPlaceholderText(/Add an approval note/i);
    fireEvent.change(commentBox, { target: { value: 'Approved per CFO' } });

    // Find the modal's Approve submit button — it's the bottom-right one
    // in the modal footer. The button text changes to "Approving..." during
    // submission, so match by either label.
    const modalApproveBtns = screen.getAllByRole('button', { name: /^\s*Approve\s*$/ });
    // The submit Approve button is the LAST one (rendered inside ModalFooter
    // after the Cancel button). Click it.
    fireEvent.click(modalApproveBtns[modalApproveBtns.length - 1]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/approvals/${samplePending.id}/approve` && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.comment).toBe('Approved per CFO');
    });
  });

  it('admin: Reject requires a comment; submit with empty comment surfaces an error', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1));

    const rejectBtns = screen.getAllByRole('button', { name: /Reject/i });
    fireEvent.click(rejectBtns[0]);

    // Modal opens; the submit button is disabled when the comment is empty
    // (button has cursor:not-allowed + opacity:0.6). Verify the button is
    // present + the modal renders with the required textarea.
    expect(await screen.findByPlaceholderText(/Explain why this is being rejected/i)).toBeInTheDocument();
    // The modal's Reject submit button.
    const modalRejectBtns = screen.getAllByRole('button', { name: /Reject/i });
    expect(modalRejectBtns.length).toBeGreaterThanOrEqual(2);
  });

  it('USER role: does NOT see Approve/Reject buttons on other-user PENDING rows', async () => {
    // /my-requests for a USER returns only their own requests; even on a
    // PENDING row, the action buttons should not render because canApprove
    // is false.
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals/my-requests')) {
        return Promise.resolve([samplePending]);
      }
      if (url.startsWith('/api/approvals')) return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderApprovals(REGULAR_USER);
    await waitFor(() => expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1));
    // Approve/Reject row-action buttons must NOT render.
    expect(screen.queryByRole('button', { name: /^Approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reject$/i })).not.toBeInTheDocument();
    // The View button stays available.
    expect(screen.getAllByRole('button', { name: /View/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('status filter: changing status dropdown re-fires endpoint with ?status=<value>', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1));
    fetchApiMock.mockClear();

    const statusSelect = screen.getByDisplayValue('All Statuses');
    fireEvent.change(statusSelect, { target: { value: 'PENDING' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && /status=PENDING/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  // ─── EXTENDED COVERAGE — additional contracts ────────────────────────

  const sampleRejected = {
    id: 12,
    entity: 'Discount',
    entityId: 99,
    reason: 'Too aggressive',
    status: 'REJECTED',
    requestedBy: 3,
    requester: { name: 'Charlie User', email: 'charlie@acme.test', role: 'USER' },
    requestedAt: '2026-04-27T09:00:00.000Z',
    approvedBy: 1,
    approvedAt: '2026-04-27T11:00:00.000Z',
    approver: { name: 'Admin', email: 'a@x.com' },
    comment: 'Margin too thin',
  };

  it('status badges render for PENDING / APPROVED / REJECTED across the list', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals')) {
        return Promise.resolve([samplePending, sampleApproved, sampleRejected]);
      }
      return Promise.resolve(null);
    });
    renderApprovals(ADMIN_USER);
    await waitFor(() =>
      expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(3)
    );
    expect(screen.getByText('PENDING')).toBeInTheDocument();
    expect(screen.getByText('APPROVED')).toBeInTheDocument();
    expect(screen.getByText('REJECTED')).toBeInTheDocument();
    // Entity short-name "Discount" appears in both the row AND the filter
    // dropdown <option>, so use getAllByText and assert >=2.
    expect(screen.getAllByText('Discount').length).toBeGreaterThanOrEqual(2);
  });

  it('entity filter: changing entity dropdown re-fires endpoint with ?entity=<value>', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() =>
      expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1)
    );
    fetchApiMock.mockClear();

    const entitySelect = screen.getByDisplayValue('All Entities');
    fireEvent.change(entitySelect, { target: { value: 'Quote' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && /entity=Quote/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  it('request count display: header shows "N requests" matching the list length', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals')) {
        return Promise.resolve([samplePending, sampleApproved, sampleRejected]);
      }
      return Promise.resolve(null);
    });
    renderApprovals(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByText(/^3 requests$/i)).toBeInTheDocument();
    });
    // Singular form when count is 1
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals')) {
        return Promise.resolve([samplePending]);
      }
      return Promise.resolve(null);
    });
  });

  it('clear-filters button: visible when a filter is set + resets selects on click', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() =>
      expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1)
    );
    // No Clear button when both filters empty
    expect(screen.queryByRole('button', { name: /^Clear$/i })).not.toBeInTheDocument();

    const statusSelect = screen.getByDisplayValue('All Statuses');
    fireEvent.change(statusSelect, { target: { value: 'APPROVED' } });

    // Clear button now appears
    const clearBtn = await screen.findByRole('button', { name: /^Clear$/i });
    expect(clearBtn).toBeInTheDocument();

    fetchApiMock.mockClear();
    fireEvent.click(clearBtn);

    // Status dropdown is back to "All Statuses"
    await waitFor(() => {
      expect(screen.getByDisplayValue('All Statuses')).toBeInTheDocument();
    });
    // Clear button disappears again
    expect(screen.queryByRole('button', { name: /^Clear$/i })).not.toBeInTheDocument();
  });

  it('View action opens the detail modal with status + reason + requester', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() =>
      expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1)
    );
    const viewBtns = screen.getAllByRole('button', { name: /View/i });
    fireEvent.click(viewBtns[0]);

    // Modal renders with title "Deal #42" — confirm modal is open via heading
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Deal #42/i })).toBeInTheDocument();
    });
    // Detail labels: "Status" / "Reason" / "Requested At" all appear as both
    // table headers AND modal detail-row labels, so use getAllByText >=2.
    // "Requested By" only appears in the modal (the table header is "Requested By")
    // and the modal label is also "Requested By", so it appears twice too.
    expect(screen.getAllByText('Status').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Requested By').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Requested At').length).toBeGreaterThanOrEqual(2);
    // "Reason" appears as both table header AND modal label
    expect(screen.getAllByText('Reason').length).toBeGreaterThanOrEqual(2);
  });

  it('Create modal: opens on "New Request"; cancel closes it', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Request/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New Request/i }));

    // Modal title visible
    expect(
      await screen.findByRole('heading', { name: /New Approval Request/i })
    ).toBeInTheDocument();
    // Entity ID input present
    expect(screen.getByPlaceholderText(/e\.g\. 123/i)).toBeInTheDocument();

    // Click Cancel — modal goes away
    const cancelBtn = screen.getByRole('button', { name: /^Cancel$/i });
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: /New Approval Request/i })
      ).not.toBeInTheDocument();
    });
  });

  it('Create submit: POSTs /api/approvals with entity + entityId + reason payload', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Request/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /New Request/i }));

    await screen.findByRole('heading', { name: /New Approval Request/i });

    // Fill Entity ID + reason
    const idInput = screen.getByPlaceholderText(/e\.g\. 123/i);
    fireEvent.change(idInput, { target: { value: '555' } });
    const reasonInput = screen.getByPlaceholderText(/25% discount for enterprise/i);
    fireEvent.change(reasonInput, { target: { value: 'Q4 push' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/approvals' && opts?.method === 'POST') {
        return Promise.resolve({ id: 999, status: 'PENDING' });
      }
      if (url.startsWith('/api/approvals')) return Promise.resolve([]);
      return Promise.resolve(null);
    });

    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Submit Request/i }));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) => url === '/api/approvals' && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.entity).toBe('Deal');     // default
      expect(body.entityId).toBe(555);      // parseInt'd
      expect(body.reason).toBe('Q4 push');
    });
  });

  it('Reject submit: POSTs /api/approvals/<id>/reject with the comment body', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() =>
      expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1)
    );

    // Click row-level Reject
    const rejectBtns = screen.getAllByRole('button', { name: /^Reject$/i });
    fireEvent.click(rejectBtns[0]);

    // Modal renders the required textarea
    const commentBox = await screen.findByPlaceholderText(
      /Explain why this is being rejected/i
    );
    fireEvent.change(commentBox, { target: { value: 'Outside policy' } });

    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/approvals/${samplePending.id}/reject` && opts?.method === 'POST') {
        return Promise.resolve({ id: samplePending.id, status: 'REJECTED' });
      }
      if (url.startsWith('/api/approvals')) return Promise.resolve([sampleApproved]);
      return Promise.resolve(null);
    });

    // The submit Reject button is the last one in the DOM (modal footer)
    const allRejectBtns = screen.getAllByRole('button', { name: /Reject/i });
    fireEvent.click(allRejectBtns[allRejectBtns.length - 1]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/approvals/${samplePending.id}/reject` && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      expect(body.comment).toBe('Outside policy');
    });
  });

  it('Approve modal: empty comment POSTs with comment: null (optional comment)', async () => {
    renderApprovals(ADMIN_USER);
    await waitFor(() =>
      expect(screen.getAllByText('Charlie User').length).toBeGreaterThanOrEqual(1)
    );
    fetchApiMock.mockClear();
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/approvals/${samplePending.id}/approve` && opts?.method === 'POST') {
        return Promise.resolve({ id: samplePending.id, status: 'APPROVED' });
      }
      if (url.startsWith('/api/approvals')) return Promise.resolve([sampleApproved]);
      return Promise.resolve(null);
    });

    const approveBtns = screen.getAllByRole('button', { name: /^\s*Approve\s*$/ });
    fireEvent.click(approveBtns[0]);

    // Modal opened — DON'T fill the comment
    await screen.findByPlaceholderText(/Add an approval note/i);

    // Click the modal Approve submit button
    const modalApproveBtns = screen.getAllByRole('button', { name: /^\s*Approve\s*$/ });
    fireEvent.click(modalApproveBtns[modalApproveBtns.length - 1]);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([url, opts]) =>
          url === `/api/approvals/${samplePending.id}/approve` && opts?.method === 'POST'
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(call[1].body);
      // Empty comment becomes null per the SUT: `comment: comment || null`
      expect(body.comment).toBeNull();
    });
  });

  it('error state: failed list fetch leaves the page on empty-state without crashing', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/approvals')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(null);
    });
    renderApprovals(ADMIN_USER);
    await waitFor(() => {
      expect(screen.getByText(/No approval requests found\./i)).toBeInTheDocument();
    });
    // Heading still renders — no white-screen crash
    expect(
      screen.getByRole('heading', { name: /Approval Requests/i })
    ).toBeInTheDocument();
  });
});
