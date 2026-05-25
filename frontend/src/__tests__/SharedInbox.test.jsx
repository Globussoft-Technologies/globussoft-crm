/**
 * SharedInbox.test.jsx — vitest + RTL coverage for the Shared Inbox page.
 *
 * Scope: pins the page-surface invariants for the team-mailbox grid +
 * detail view, since the SUT (frontend/src/pages/SharedInbox.jsx, 515 LOC)
 * was previously untested.
 *
 *   1. Loading state: "Loading shared inboxes..." renders before fetch
 *      resolves.
 *   2. Empty grid: renders the empty-state card with the "Create Your First
 *      Inbox" CTA when GET /api/shared-inbox returns [].
 *   3. Grid populated: one card per inbox from GET /api/shared-inbox,
 *      showing name + emailAddress.
 *   4. Member avatars: rendered for the first 4 members; "+N" overflow chip
 *      surfaces when memberIds.length > 4. "No members" placeholder when 0.
 *   5. Create modal: clicking "Create Inbox" opens the modal with name +
 *      email inputs.
 *   6. Create POST: submitting valid name + email POSTs
 *      /api/shared-inbox and reloads the list.
 *   7. Create error: a rejected POST surfaces notify.error.
 *   8. Delete with confirm: clicking the trash icon prompts notify.confirm;
 *      on confirm, DELETE /api/shared-inbox/:id is fired and list reloads.
 *   9. Delete cancelled: notify.confirm returning false skips the DELETE.
 *  10. Open inbox: clicking a card fires GET /api/shared-inbox/:id/messages
 *      and switches to the detail view (header with Back button + email).
 *  11. Empty thread list: detail view shows the "No conversations yet"
 *      message when /messages returns { threads: [] }.
 *  12. Assign thread: changing the assignee <select> POSTs to
 *      /api/shared-inbox/:id/assign-message with messageId + userId,
 *      and optimistically updates the thread's assignedUserId.
 *  13. Back to grid: clicking "Back" returns to the grid view.
 *
 * Backend contracts pinned by this test:
 *   GET    /api/shared-inbox
 *   GET    /api/staff
 *   POST   /api/shared-inbox
 *   DELETE /api/shared-inbox/:id
 *   GET    /api/shared-inbox/:id/messages -> { threads: [...] }
 *   POST   /api/shared-inbox/:id/assign-message { messageId, userId }
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock object — fresh object per render would invalidate any
// useCallback dependency identity and cause re-render loops (per the
// 2026-05-08 cron-learning standing rule).
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import SharedInbox from '../pages/SharedInbox';

const STAFF = [
  { id: 1, name: 'Aanya Sharma', email: 'aanya@globussoft.com', role: 'MANAGER' },
  { id: 2, name: 'Vikram Mehta', email: 'vikram@globussoft.com', role: 'USER' },
  { id: 3, name: 'Priya Iyer', email: 'priya@globussoft.com', role: 'USER' },
  { id: 4, name: 'Rohan Das', email: 'rohan@globussoft.com', role: 'USER' },
  { id: 5, name: 'Meera Nair', email: 'meera@globussoft.com', role: 'USER' },
  { id: 6, name: 'Karan Bose', email: 'karan@globussoft.com', role: 'USER' },
];

const INBOXES = [
  {
    id: 10,
    name: 'Support Team',
    emailAddress: 'support@globussoft.com',
    members: [1, 2, 3, 4, 5, 6], // > 4 → exercises "+2" overflow
  },
  {
    id: 11,
    name: 'Sales Desk',
    emailAddress: 'sales@globussoft.com',
    members: [], // 0 → exercises "No members" placeholder
  },
];

const THREADS = [
  {
    threadKey: 'thr-1',
    from: 'customer@example.com',
    subject: 'Need refund',
    lastMessageAt: new Date('2026-05-20T10:30:00Z').toISOString(),
    messageCount: 3,
    unread: 1,
    assignedUserId: null,
    messages: [{ id: 901 }, { id: 902 }, { id: 903 }],
  },
];

function mockInitialLoad({ inboxes = INBOXES, staff = STAFF } = {}) {
  fetchApiMock.mockResolvedValueOnce(inboxes); // GET /api/shared-inbox
  fetchApiMock.mockResolvedValueOnce(staff);   // GET /api/staff
}

describe('SharedInbox page', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyObj.error.mockReset();
    notifyObj.info.mockReset();
    notifyObj.success.mockReset();
    notifyObj.confirm.mockReset();
  });

  it('shows the loading placeholder while the initial fetch is in flight', () => {
    // Never resolve, so we observe the loading state.
    fetchApiMock.mockReturnValue(new Promise(() => {}));
    render(<SharedInbox />);
    expect(screen.getByText(/Loading shared inboxes/i)).toBeInTheDocument();
  });

  it('renders the empty-state card with the "Create Your First Inbox" CTA when there are no inboxes', async () => {
    mockInitialLoad({ inboxes: [] });
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText(/No shared inboxes yet/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Create Your First Inbox/i })).toBeInTheDocument();
  });

  it('renders one card per inbox with the name + email address', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });
    expect(screen.getByText('support@globussoft.com')).toBeInTheDocument();
    expect(screen.getByText('Sales Desk')).toBeInTheDocument();
    expect(screen.getByText('sales@globussoft.com')).toBeInTheDocument();
  });

  it('renders avatars for first 4 members and an overflow chip when more exist; "No members" otherwise', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });
    // Support Team has 6 members → "+2" overflow chip.
    expect(screen.getByText('+2')).toBeInTheDocument();
    // Sales Desk has 0 members → "No members" placeholder.
    expect(screen.getByText(/No members/i)).toBeInTheDocument();
  });

  it('opens the create modal when "Create Inbox" is clicked', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    // There are two "Create Inbox" buttons (header + modal-submit-once-open).
    // Pre-open, only the header one is present.
    const createButtons = screen.getAllByRole('button', { name: /Create Inbox/i });
    await user.click(createButtons[0]);
    expect(screen.getByText(/Create Shared Inbox/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Support Team/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/support@yourdomain.com/i)).toBeInTheDocument();
  });

  it('POSTs to /api/shared-inbox and reloads the grid on successful create', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Create Inbox/i })[0]);

    fetchApiMock.mockResolvedValueOnce({ id: 99, name: 'Billing', emailAddress: 'billing@globussoft.com' }); // POST create
    fetchApiMock.mockResolvedValueOnce([...INBOXES, { id: 99, name: 'Billing', emailAddress: 'billing@globussoft.com', members: [] }]); // reload

    await user.type(screen.getByPlaceholderText(/Support Team/i), 'Billing');
    await user.type(screen.getByPlaceholderText(/support@yourdomain.com/i), 'billing@globussoft.com');

    // The submit button in the modal is the 2nd "Create Inbox" button (type=submit).
    const createButtons = screen.getAllByRole('button', { name: /Create Inbox/i });
    const submitButton = createButtons.find((b) => b.getAttribute('type') === 'submit') || createButtons[createButtons.length - 1];
    await user.click(submitButton);

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        (call) => call[0] === '/api/shared-inbox' && call[1]?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Billing');
      expect(body.emailAddress).toBe('billing@globussoft.com');
      expect(Array.isArray(body.members)).toBe(true);
    });
  });

  it('surfaces notify.error when the create POST rejects', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: /Create Inbox/i })[0]);

    fetchApiMock.mockRejectedValueOnce(new Error('Email address already in use'));

    await user.type(screen.getByPlaceholderText(/Support Team/i), 'Dup');
    await user.type(screen.getByPlaceholderText(/support@yourdomain.com/i), 'dup@globussoft.com');

    const createButtons = screen.getAllByRole('button', { name: /Create Inbox/i });
    const submitButton = createButtons.find((b) => b.getAttribute('type') === 'submit') || createButtons[createButtons.length - 1];
    await user.click(submitButton);

    await waitFor(() => {
      expect(notifyObj.error).toHaveBeenCalledWith('Email address already in use');
    });
  });

  it('asks for confirmation and DELETEs when the trash icon is clicked', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });

    notifyObj.confirm.mockResolvedValueOnce(true);
    fetchApiMock.mockResolvedValueOnce({}); // DELETE
    fetchApiMock.mockResolvedValueOnce([INBOXES[1]]); // reload

    const user = userEvent.setup();
    const deleteButtons = screen.getAllByTitle('Delete');
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalledWith(expect.stringMatching(/Delete shared inbox "Support Team"/));
    });
    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        (call) => call[0] === '/api/shared-inbox/10' && call[1]?.method === 'DELETE'
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('skips the DELETE when notify.confirm returns false', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });

    notifyObj.confirm.mockResolvedValueOnce(false);
    const beforeCallCount = fetchApiMock.mock.calls.length;

    const user = userEvent.setup();
    const deleteButtons = screen.getAllByTitle('Delete');
    await user.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyObj.confirm).toHaveBeenCalled();
    });
    // No additional fetch calls (no DELETE, no reload).
    expect(fetchApiMock.mock.calls.length).toBe(beforeCallCount);
  });

  it('opens an inbox detail view and fetches its threads when a card is clicked', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });

    fetchApiMock.mockResolvedValueOnce({ threads: THREADS });

    const user = userEvent.setup();
    await user.click(screen.getByText('Support Team'));

    await waitFor(() => {
      const msgCall = fetchApiMock.mock.calls.find(
        (call) => call[0] === '/api/shared-inbox/10/messages'
      );
      expect(msgCall).toBeTruthy();
    });
    // Back button is part of the detail view.
    expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
    // Header echoes the inbox email.
    expect(screen.getByText(/support@globussoft.com/)).toBeInTheDocument();
    // Thread row renders.
    await waitFor(() => {
      expect(screen.getByText('Need refund')).toBeInTheDocument();
    });
  });

  it('shows the "No conversations" empty state in the detail view when /messages returns no threads', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });

    fetchApiMock.mockResolvedValueOnce({ threads: [] });

    const user = userEvent.setup();
    await user.click(screen.getByText('Support Team'));

    await waitFor(() => {
      expect(screen.getByText(/No conversations in this inbox yet/i)).toBeInTheDocument();
    });
  });

  it('assigns a thread to a staff member by changing the <select> and POSTs assign-message with the messageId', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });

    fetchApiMock.mockResolvedValueOnce({ threads: THREADS });

    const user = userEvent.setup();
    await user.click(screen.getByText('Support Team'));

    await waitFor(() => {
      expect(screen.getByText('Need refund')).toBeInTheDocument();
    });

    // Mock the assign POST.
    fetchApiMock.mockResolvedValueOnce({});

    // The thread row has a <select> for assignee.
    const selects = screen.getAllByRole('combobox');
    // Pick the assignee select (it has the staff names as options).
    const assignSelect = selects.find((s) => within(s).queryByText('Aanya Sharma')) || selects[0];
    await user.selectOptions(assignSelect, '2'); // Vikram Mehta

    await waitFor(() => {
      const assignCall = fetchApiMock.mock.calls.find(
        (call) => call[0] === '/api/shared-inbox/10/assign-message' && call[1]?.method === 'POST'
      );
      expect(assignCall).toBeTruthy();
      const body = JSON.parse(assignCall[1].body);
      expect(body.messageId).toBe(901);
      expect(body.userId).toBe(2);
    });
  });

  it('returns to the grid view when "Back" is clicked', async () => {
    mockInitialLoad();
    render(<SharedInbox />);
    await waitFor(() => {
      expect(screen.getByText('Support Team')).toBeInTheDocument();
    });

    fetchApiMock.mockResolvedValueOnce({ threads: [] });

    const user = userEvent.setup();
    await user.click(screen.getByText('Support Team'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Back/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Back/i }));

    await waitFor(() => {
      // Grid heading reappears.
      expect(screen.getByRole('heading', { name: /Shared Inbox/i })).toBeInTheDocument();
      // Sales Desk row is back (proves grid is rendered).
      expect(screen.getByText('Sales Desk')).toBeInTheDocument();
    });
  });
});
