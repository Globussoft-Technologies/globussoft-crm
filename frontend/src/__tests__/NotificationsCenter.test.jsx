/**
 * NotificationsCenter.test.jsx — vitest + RTL coverage for the full-page
 * notifications inbox (#853, sibling to the header NotificationBell dropdown).
 *
 * Scope: pins the page-surface invariants for the persistent notification
 * history feed — load fetch, filter-tab semantics, per-row mark-as-read /
 * dismiss, "Mark all read" bulk action, deep-link click-through, pagination,
 * empty + error states.
 *
 *   1. Header renders "Notifications" + the total/unread counter line
 *      ("N total · M unread") pulled from /api/notifications and the
 *      /api/notifications/unread-count endpoint.
 *   2. Initial mount fires GET /api/notifications with page=1&limit=50 and
 *      NO status= filter (the "All" tab).
 *   3. Renders one row per notification with title + message (matches the
 *      backend list-endpoint shape: { notifications, total, page, pages }).
 *   4. Clicking the "Unread" filter tab refetches with status=unread and
 *      resets pagination to page 1 (per the load() callback's `filter`
 *      dependency).
 *   5. Per-row "Mark as read" button (visible only on unread rows) fires
 *      PUT /api/notifications/:id/read.
 *   6. Per-row "Dismiss" button (visible on every row) fires DELETE
 *      /api/notifications/:id and removes the row optimistically.
 *   7. "Mark all read" button (visible only when unreadCount > 0) fires
 *      POST /api/notifications/mark-all-read.
 *   8. Clicking a row with a `link` field navigates to that link AND
 *      marks the unread row as read in the same gesture (openRow contract).
 *   9. Empty-state copy varies by active filter — "No unread notifications."
 *      vs "No notifications yet." — pinning the message branches.
 *  10. Error-state: fetchApi rejection surfaces the error message in the
 *      list region (not as a toast — the page renders it inline).
 *  11. Pagination controls render when pages > 1 with Previous/Next; the
 *      Previous button is disabled on page 1.
 *
 * Drift note: the bell dropdown's PUT path is /api/notifications/:id/read,
 * not /api/notifications/read-all (that's bell's mark-all). This page uses
 * POST /mark-all-read (per the source's line 126). Both endpoints exist in
 * routes/notifications.js — distinct contracts, both pinned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Stable navigate mock — captured at module scope so each test can inspect
// recent navigation calls. Re-using the same object reference avoids the
// stale-mock-ref hazard documented in CLAUDE.md (RTL standing rule).
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable notify object (per the RTL standing rule — fresh objects per render
// cause `useCallback` dep-array re-renders → infinite loop).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import NotificationsCenter from '../pages/NotificationsCenter';

const sampleNotifications = [
  {
    id: 101,
    title: 'New lead assigned',
    message: 'Anita Sharma has been routed to you',
    type: 'info',
    priority: 'high',
    isRead: false,
    link: '/leads/501',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  },
  {
    id: 102,
    title: 'Invoice overdue',
    message: 'INV-2026-042 is 7 days past due',
    type: 'warning',
    priority: 'medium',
    isRead: false,
    link: '/invoices/42',
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
  {
    id: 103,
    title: 'Backup completed',
    message: 'Nightly snapshot uploaded',
    type: 'success',
    priority: 'low',
    isRead: true,
    link: null,
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
];

function defaultFetchMock(url, opts) {
  if (url.startsWith('/api/notifications/unread-count')) {
    return Promise.resolve({ count: 2 });
  }
  if (url.startsWith('/api/notifications?') && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve({
      notifications: sampleNotifications,
      total: 3,
      page: 1,
      pages: 1,
      limit: 50,
    });
  }
  return Promise.resolve(null);
}

function renderCenter() {
  return render(
    <MemoryRouter>
      <NotificationsCenter />
    </MemoryRouter>
  );
}

describe('<NotificationsCenter /> — page surface (#853)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    navigateMock.mockReset();
  });

  it('renders the heading and the "N total · M unread" counter line', async () => {
    renderCenter();
    expect(
      await screen.findByRole('heading', { name: /Notifications/i })
    ).toBeInTheDocument();
    // Counter pulls `total` from the list endpoint + `count` from /unread-count.
    expect(await screen.findByText(/3 total/i)).toBeInTheDocument();
    expect(await screen.findByText(/2 unread/i)).toBeInTheDocument();
  });

  it('initial mount fires GET /api/notifications with page=1 and NO status= filter', async () => {
    renderCenter();
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/notifications?')
        && u.includes('page=1')
        && u.includes('limit=50')
        && !u.includes('status=')
      );
      expect(call).toBeTruthy();
    });
  });

  it('renders one row per notification with title + message', async () => {
    renderCenter();
    expect(await screen.findByText('New lead assigned')).toBeInTheDocument();
    expect(screen.getByText('Anita Sharma has been routed to you')).toBeInTheDocument();
    expect(screen.getByText('Invoice overdue')).toBeInTheDocument();
    expect(screen.getByText('INV-2026-042 is 7 days past due')).toBeInTheDocument();
    expect(screen.getByText('Backup completed')).toBeInTheDocument();
  });

  it('clicking the "Unread" filter tab refetches with status=unread', async () => {
    renderCenter();
    await screen.findByText('New lead assigned');
    fetchApiMock.mockClear();
    // The "Unread" tab is a button inside the role="tablist" group.
    fireEvent.click(screen.getByRole('tab', { name: /^Unread$/ }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string'
        && u.startsWith('/api/notifications?')
        && u.includes('status=unread')
        && u.includes('page=1')
      );
      expect(call).toBeTruthy();
    });
    // Active-tab semantics: aria-selected flips on the new tab.
    expect(screen.getByRole('tab', { name: /^Unread$/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /^All$/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('per-row "Mark as read" fires PUT /api/notifications/:id/read', async () => {
    renderCenter();
    await screen.findByText('New lead assigned');
    const markBtn = screen.getByRole('button', { name: /^Mark "New lead assigned" as read$/ });
    fireEvent.click(markBtn);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/notifications/101/read' && o?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('per-row "Mark as read" button is absent on already-read rows', async () => {
    renderCenter();
    await screen.findByText('Backup completed');
    // Backup completed is isRead: true, so no Mark-as-read affordance.
    expect(
      screen.queryByRole('button', { name: /^Mark "Backup completed" as read$/ })
    ).not.toBeInTheDocument();
    // But the Dismiss (X) button is still present.
    expect(
      screen.getByRole('button', { name: /^Dismiss "Backup completed"$/ })
    ).toBeInTheDocument();
  });

  it('per-row "Dismiss" fires DELETE /api/notifications/:id and removes the row', async () => {
    renderCenter();
    await screen.findByText('Invoice overdue');
    fireEvent.click(screen.getByRole('button', { name: /^Dismiss "Invoice overdue"$/ }));
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/notifications/102' && o?.method === 'DELETE'
      );
      expect(call).toBeTruthy();
    });
    // Row optimistically removed from the list.
    await waitFor(() => {
      expect(screen.queryByText('Invoice overdue')).not.toBeInTheDocument();
    });
  });

  it('"Mark all read" button fires POST /api/notifications/mark-all-read', async () => {
    renderCenter();
    // The bulk button only renders when unreadCount > 0 (default mock: 2).
    const bulkBtn = await screen.findByRole('button', { name: /Mark all read/i });
    fireEvent.click(bulkBtn);
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/notifications/mark-all-read' && o?.method === 'POST'
      );
      expect(call).toBeTruthy();
    });
  });

  it('"Mark all read" button is hidden when unreadCount is 0', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url.startsWith('/api/notifications/unread-count')) {
        return Promise.resolve({ count: 0 });
      }
      return defaultFetchMock(url, opts);
    });
    renderCenter();
    await screen.findByText('New lead assigned');
    // Wait for the unread-count to settle to 0, then assert the button absent.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Mark all read/i })).not.toBeInTheDocument();
    });
  });

  it('clicking a row with a link navigates to that link and marks it read', async () => {
    renderCenter();
    await screen.findByText('New lead assigned');
    // Click the row chrome (the row container, not the per-row buttons).
    // The title text is inside the clickable row div.
    fireEvent.click(screen.getByText('New lead assigned'));
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith('/leads/501');
    });
    // Unread row → openRow ALSO fires the PUT mark-as-read.
    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/notifications/101/read' && o?.method === 'PUT'
      );
      expect(call).toBeTruthy();
    });
  });

  it('empty state copy is "No unread notifications." under the Unread filter', async () => {
    // First load returns sample data so the filter tab is interactive, then
    // the filter switch returns []. Use a call counter to flip behaviour.
    let listCallCount = 0;
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/notifications/unread-count')) {
        return Promise.resolve({ count: 0 });
      }
      if (url.startsWith('/api/notifications?')) {
        listCallCount += 1;
        if (listCallCount === 1) {
          return Promise.resolve({ notifications: sampleNotifications, total: 3, page: 1, pages: 1 });
        }
        return Promise.resolve({ notifications: [], total: 0, page: 1, pages: 1 });
      }
      return Promise.resolve(null);
    });
    renderCenter();
    await screen.findByText('New lead assigned');
    fireEvent.click(screen.getByRole('tab', { name: /^Unread$/ }));
    expect(await screen.findByText(/No unread notifications\./i)).toBeInTheDocument();
  });

  it('empty state copy is "No notifications yet." under the All filter', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/notifications/unread-count')) {
        return Promise.resolve({ count: 0 });
      }
      if (url.startsWith('/api/notifications?')) {
        return Promise.resolve({ notifications: [], total: 0, page: 1, pages: 1 });
      }
      return Promise.resolve(null);
    });
    renderCenter();
    expect(await screen.findByText(/No notifications yet\./i)).toBeInTheDocument();
  });

  it('error response surfaces the message inline (not via toast)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/notifications/unread-count')) {
        return Promise.resolve({ count: 0 });
      }
      if (url.startsWith('/api/notifications?')) {
        return Promise.reject(new Error('Notification service unavailable'));
      }
      return Promise.resolve(null);
    });
    renderCenter();
    expect(await screen.findByText(/Notification service unavailable/i)).toBeInTheDocument();
    // The page renders the error in the list region, not via notify.error.
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('pagination controls render when pages > 1; Previous is disabled on page 1', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/notifications/unread-count')) {
        return Promise.resolve({ count: 2 });
      }
      if (url.startsWith('/api/notifications?')) {
        return Promise.resolve({
          notifications: sampleNotifications,
          total: 120,
          page: 1,
          pages: 3,
          limit: 50,
        });
      }
      return Promise.resolve(null);
    });
    renderCenter();
    await screen.findByText('New lead assigned');
    const prev = await screen.findByRole('button', { name: /Previous/i });
    const next = await screen.findByRole('button', { name: /Next/i });
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();
    // "Page 1 of 3" indicator.
    expect(screen.getByText(/Page 1 of 3/i)).toBeInTheDocument();
  });
});
