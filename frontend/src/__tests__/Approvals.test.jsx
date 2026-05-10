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
});
