import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../App';

/**
 * frontend/src/components/NotificationBell.jsx
 *
 * What's tested
 *   - Renders the bell button with an aria-label that callers (a11y tools,
 *     QA selectors, screen-readers) rely on.
 *   - Badge renders with unread count when > 0; absent when 0.
 *   - Clicking the bell opens the dropdown (aria-expanded flips true) and
 *     fetches notifications from /api/notifications.
 *   - Empty state copy renders when the notification list is empty.
 *   - mark-all-read clears the badge AND sends PUT to /api/notifications/read-all.
 *   - Socket push events (#345): `notification_new` bumps the badge for the
 *     current user and is ignored for other users; `notifications_cleared`
 *     resets the badge for the current user and is a no-op otherwise.
 *   - Row-link navigation: clicking a notification with a `link` navigates
 *     and closes the panel.
 *   - Footer "View all" (#853) deep-links to /notifications and is hidden
 *     when the panel is empty.
 *   - Outside-click dismissal closes the dropdown.
 *   - Badge text boundary: "99" at exactly 99, "99+" at 100+.
 *   - Fetch failures fail silently — no crash, no badge.
 *   - Socket cleanup disconnects on unmount.
 *
 * Why
 *   The bell is in the global Layout — present on every authenticated page.
 *   A regression here breaks the unread-count UX site-wide. The aria-label
 *   contract is also load-bearing for the e2e suite (a11y selectors).
 *
 * Contract pinned
 *   - aria-label includes "(N unread)" when N > 0
 *   - dropdown-open click fires GET /api/notifications
 *   - "Mark all as read" click fires PUT /api/notifications/read-all
 *   - per-row Mark-as-read fires PUT /api/notifications/:id/read
 *   - per-row Resolve fires DELETE /api/notifications/:id
 *   - "View all" fires navigate('/notifications')
 *   - Row click with `link` fires navigate(link) and closes the panel
 *   - Socket events `notification_new` and `notifications_cleared` honour
 *     userId scoping so cross-user broadcast events don't pollute our badge
 */

// Mock fetchApi BEFORE importing the component.
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

// Mock socket.io-client — the bell installs a socket on mount and we don't
// want a real connection attempt during unit tests. The extended cases below
// (notification_new / notifications_cleared) need to trigger the registered
// handlers from outside the component, so we capture them in a shared map.
const socketHandlers = {};
const socketDisconnect = vi.fn();
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn((evt, fn) => {
      socketHandlers[evt] = fn;
    }),
    off: vi.fn(),
    disconnect: socketDisconnect,
  })),
}));

// Mock react-router-dom useNavigate to capture link clicks without changing
// the in-memory route — lets us assert the navigate target deterministically.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

import { fetchApi } from '../utils/api';
import NotificationBell from '../components/NotificationBell';

// PR #669 added `useNavigate()` inside NotificationBell.jsx (probably for
// link-on-click). The hook requires a Router context, so every render must
// be wrapped in MemoryRouter — previously the test rendered bare.
const renderWithAuth = (ui, { user = { id: 1, name: 'Test User', email: 't@x.com' } } = {}) => {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, setUser: () => {}, loading: false }}>
        {ui}
      </AuthContext.Provider>
    </MemoryRouter>,
  );
};

describe('<NotificationBell />', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    // Clear socket-event handler captures + navigate stub between tests so
    // each spec gets a clean slate.
    Object.keys(socketHandlers).forEach((k) => delete socketHandlers[k]);
    navigateMock.mockReset();
    socketDisconnect.mockReset();
  });

  it('renders the bell button with aria-label and no badge when count=0', async () => {
    fetchApi.mockResolvedValueOnce({ count: 0 }); // unread-count

    renderWithAuth(<NotificationBell />);

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/notifications/unread-count');
    });

    const btn = screen.getByRole('button', { name: /notifications/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label', 'Notifications');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders unread badge with count when > 0', async () => {
    fetchApi.mockResolvedValueOnce({ count: 3 });

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /Notifications \(3 unread\)/ });
    expect(btn).toBeInTheDocument();
    // The badge text "3" is rendered inside the button
    expect(btn.textContent).toContain('3');
  });

  it('caps the badge text at "99+" for very large unread counts', async () => {
    fetchApi.mockResolvedValueOnce({ count: 152 });

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /Notifications \(152 unread\)/ });
    expect(btn.textContent).toContain('99+');
  });

  it('clicking the bell opens the dropdown + fetches notifications', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 0 })           // unread-count on mount
      .mockResolvedValueOnce({ notifications: [] }); // notifications on open

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /notifications/i });
    await user.click(btn);

    expect(btn).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/notifications');
    });
    expect(screen.getByText('No notifications')).toBeInTheDocument();
  });

  it('renders notification list when API returns items', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 11, title: 'New deal', message: 'Acme signed', type: 'success', isRead: false, createdAt: new Date().toISOString() },
          { id: 12, title: 'Task overdue', message: 'Follow up', type: 'warning', isRead: true, createdAt: new Date().toISOString() },
        ],
      });

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /notifications/i });
    await user.click(btn);

    await waitFor(() => expect(screen.getByText('New deal')).toBeInTheDocument());
    expect(screen.getByText('Acme signed')).toBeInTheDocument();
    expect(screen.getByText('Task overdue')).toBeInTheDocument();
  });

  it('mark-all-read fires PUT /api/notifications/read-all and clears the badge', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 1, title: 'a', message: 'x', type: 'info', isRead: false, createdAt: new Date().toISOString() },
          { id: 2, title: 'b', message: 'y', type: 'info', isRead: false, createdAt: new Date().toISOString() },
        ],
      })
      .mockResolvedValueOnce({ ok: true }); // PUT read-all

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /Notifications \(2 unread\)/ });
    await user.click(btn);

    await waitFor(() => expect(screen.getByText('Mark all as read')).toBeInTheDocument());
    await user.click(screen.getByText('Mark all as read'));

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/notifications/read-all' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
    });

    // Badge should be gone after mark-all-read.
    await waitFor(() => {
      const refreshedBtn = screen.getByRole('button', { name: /^Notifications$/ });
      expect(refreshedBtn).toBeInTheDocument();
    });
  });

  it('#622: opening the panel recomputes the badge count from the panel payload (single source of truth)', async () => {
    // Stale /unread-count says 7 (from a previous role / impersonation
    // context); the real panel only carries 2 unread + 1 read. The bell
    // shows 7 on first paint, but recomputes to 2 once the dropdown opens
    // and the panel payload arrives.
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 7 }) // stale unread-count on mount
      .mockResolvedValueOnce({
        notifications: [
          { id: 1, title: 'a', message: 'x', type: 'info', isRead: false, createdAt: new Date().toISOString() },
          { id: 2, title: 'b', message: 'y', type: 'info', isRead: false, createdAt: new Date().toISOString() },
          { id: 3, title: 'c', message: 'z', type: 'info', isRead: true, createdAt: new Date().toISOString() },
        ],
      });

    renderWithAuth(<NotificationBell />);

    const stale = await screen.findByRole('button', { name: /Notifications \(7 unread\)/ });
    expect(stale).toBeInTheDocument();

    await user.click(stale);

    // After the panel fetch lands, the badge updates to the real count (2).
    const refreshed = await screen.findByRole('button', { name: /Notifications \(2 unread\)/ });
    expect(refreshed).toBeInTheDocument();
    expect(refreshed.textContent).toContain('2');
  });

  it('#622: invalidates panel + badge when user identity changes (role switch)', async () => {
    fetchApi
      .mockResolvedValueOnce({ count: 5 }) // unread-count for user 1
      .mockResolvedValueOnce({ count: 0 }); // unread-count for user 2 after switch

    const { rerender } = renderWithAuth(<NotificationBell />, {
      user: { id: 1, name: 'Alice' },
    });

    await screen.findByRole('button', { name: /Notifications \(5 unread\)/ });

    // Simulate role switch / re-login as a different user.
    rerender(
      <MemoryRouter>
        <AuthContext.Provider value={{ user: { id: 2, name: 'Bob' }, setUser: () => {}, loading: false }}>
          <NotificationBell />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    // Badge must reset (no carry-over of "5" from user 1) and re-render
    // without the unread suffix once the new identity's count lands.
    const btn = await screen.findByRole('button', { name: /^Notifications$/ });
    expect(btn).toBeInTheDocument();
  });

  it('#815: per-row "Mark as read" affordance fires PUT /api/notifications/:id/read', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 77, title: 'Unread row', message: 'pending', type: 'info', isRead: false, createdAt: new Date().toISOString() },
        ],
      })
      .mockResolvedValueOnce({ ok: true }); // PUT /:id/read

    renderWithAuth(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: /Notifications \(1 unread\)/ });
    await user.click(bell);

    // Per-row "Mark as read" button uses aria-label `Mark "<title>" as read`.
    const markBtn = await screen.findByRole('button', { name: /^Mark "Unread row" as read$/ });
    await user.click(markBtn);

    await waitFor(() => {
      const putCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/notifications/77/read' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
    });
  });

  it('#815: per-row "Mark as read" button is absent on already-read rows', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 88, title: 'Already read', message: 'done', type: 'info', isRead: true, createdAt: new Date().toISOString() },
        ],
      });

    renderWithAuth(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: /notifications/i });
    await user.click(bell);

    await screen.findByText('Already read');
    // No "Mark as read" affordance — only the Resolve (X) button.
    expect(screen.queryByRole('button', { name: /^Mark "Already read" as read$/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Resolve "Already read"$/ })).toBeInTheDocument();
  });

  it('#815: per-row "Resolve" fires DELETE /api/notifications/:id and removes the row', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 55, title: 'Dismiss me', message: 'gone soon', type: 'info', isRead: false, createdAt: new Date().toISOString() },
        ],
      })
      .mockResolvedValueOnce({ ok: true }); // DELETE

    renderWithAuth(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: /Notifications \(1 unread\)/ });
    await user.click(bell);

    const resolveBtn = await screen.findByRole('button', { name: /^Resolve "Dismiss me"$/ });
    await user.click(resolveBtn);

    await waitFor(() => {
      const delCall = fetchApi.mock.calls.find(
        ([url, opts]) => url === '/api/notifications/55' && opts?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
    });

    // Row gone + badge decrements (unread row was removed).
    await waitFor(() => {
      expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
    });
  });

  it('tolerates legacy array-shape notifications response (#113 regression guard)', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce([
        { id: 99, title: 'Legacy shape', message: 'still works', type: 'info', isRead: false, createdAt: new Date().toISOString() },
      ]);

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /notifications/i });
    await user.click(btn);

    await waitFor(() => expect(screen.getByText('Legacy shape')).toBeInTheDocument());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Extended cases — extending the test from 326L (61% ratio for 527L SUT)
  // to cover socket push events (#345), link-click navigation, "View all"
  // footer (#853), outside-click dismissal, fetch error paths, badge "99/99+"
  // boundary, and socket cleanup on unmount.
  // ─────────────────────────────────────────────────────────────────────────

  it('#345: socket `notification_new` for the current user increments the badge', async () => {
    fetchApi.mockResolvedValueOnce({ count: 0 });

    renderWithAuth(<NotificationBell />, { user: { id: 42, name: 'Carol' } });

    // Wait until the socket handlers are registered by the mount effect.
    await waitFor(() => expect(typeof socketHandlers.notification_new).toBe('function'));

    // Server emits a push for our user — badge bumps from 0 to 1 AND the
    // bundled notification is prepended if the dropdown is open. Here the
    // dropdown is closed, so we only assert the count.
    socketHandlers.notification_new({
      userId: 42,
      notification: {
        id: 501,
        title: 'Pushed in',
        message: 'live',
        type: 'info',
        isRead: false,
        createdAt: new Date().toISOString(),
      },
    });

    const btn = await screen.findByRole('button', { name: /Notifications \(1 unread\)/ });
    expect(btn.textContent).toContain('1');
  });

  it('#345: socket `notification_new` for ANOTHER user does NOT inflate the badge', async () => {
    fetchApi.mockResolvedValueOnce({ count: 0 });

    renderWithAuth(<NotificationBell />, { user: { id: 42, name: 'Carol' } });

    await waitFor(() => expect(typeof socketHandlers.notification_new).toBe('function'));

    // Server broadcasts globally; payload's userId is someone else.
    socketHandlers.notification_new({
      userId: 99,
      notification: { id: 600, title: 'Other user', message: 'x', type: 'info', isRead: false, createdAt: new Date().toISOString() },
    });

    // Badge stays absent (count remains 0).
    const btn = screen.getByRole('button', { name: /^Notifications$/ });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('aria-label')).toBe('Notifications');
  });

  it('#345: socket `notifications_cleared` for current user resets the badge to 0', async () => {
    fetchApi.mockResolvedValueOnce({ count: 5 });

    renderWithAuth(<NotificationBell />, { user: { id: 7, name: 'Dave' } });

    await screen.findByRole('button', { name: /Notifications \(5 unread\)/ });
    await waitFor(() => expect(typeof socketHandlers.notifications_cleared).toBe('function'));

    socketHandlers.notifications_cleared({ userId: 7 });

    const cleared = await screen.findByRole('button', { name: /^Notifications$/ });
    expect(cleared).toBeInTheDocument();
  });

  it('#345: socket `notifications_cleared` for OTHER user is a no-op', async () => {
    fetchApi.mockResolvedValueOnce({ count: 3 });

    renderWithAuth(<NotificationBell />, { user: { id: 7, name: 'Dave' } });

    await screen.findByRole('button', { name: /Notifications \(3 unread\)/ });
    await waitFor(() => expect(typeof socketHandlers.notifications_cleared).toBe('function'));

    // Different user's clear event — should NOT affect our badge.
    socketHandlers.notifications_cleared({ userId: 999 });

    // Badge still says 3.
    const btn = screen.getByRole('button', { name: /Notifications \(3 unread\)/ });
    expect(btn).toBeInTheDocument();
  });

  it('clicking a notification with a `link` navigates and closes the panel', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({
        notifications: [
          {
            id: 33,
            title: 'Linked',
            message: 'jump',
            type: 'info',
            isRead: false,
            link: '/deals/123',
            createdAt: new Date().toISOString(),
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true }); // implicit markAsRead for unread+link

    renderWithAuth(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: /Notifications \(1 unread\)/ });
    await user.click(bell);

    const row = await screen.findByText('Linked');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/deals/123'));
    // Panel closes after navigation.
    await waitFor(() => expect(screen.queryByText('Linked')).not.toBeInTheDocument());
  });

  it('#853: "View all notifications" footer navigates to /notifications and closes the panel', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 1, title: 'one', message: 'm', type: 'info', isRead: true, createdAt: new Date().toISOString() },
        ],
      });

    renderWithAuth(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: /notifications/i });
    await user.click(bell);

    const viewAll = await screen.findByRole('button', { name: /view all notifications/i });
    await user.click(viewAll);

    expect(navigateMock).toHaveBeenCalledWith('/notifications');
    // Panel closed.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /view all notifications/i })).not.toBeInTheDocument(),
    );
  });

  it('#853: "View all" footer is hidden when the panel is empty', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ notifications: [] });

    renderWithAuth(<NotificationBell />);

    const bell = await screen.findByRole('button', { name: /notifications/i });
    await user.click(bell);

    await screen.findByText('No notifications');
    expect(screen.queryByRole('button', { name: /view all notifications/i })).not.toBeInTheDocument();
  });

  it('outside-click dismisses the open dropdown', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({
        notifications: [
          { id: 1, title: 'visible', message: 'now', type: 'info', isRead: true, createdAt: new Date().toISOString() },
        ],
      });

    renderWithAuth(
      <div>
        <div data-testid="outside">elsewhere</div>
        <NotificationBell />
      </div>,
    );

    const bell = await screen.findByRole('button', { name: /notifications/i });
    await user.click(bell);
    await screen.findByText('visible');

    // mousedown OUTSIDE the bell's ref container → handleClickOutside closes
    // the panel. userEvent.click translates into pointerdown+mousedown+mouseup
    // on the outside element.
    await user.click(screen.getByTestId('outside'));

    await waitFor(() => expect(screen.queryByText('visible')).not.toBeInTheDocument());
    expect(bell).toHaveAttribute('aria-expanded', 'false');
  });

  it('badge text is "99" at exactly 99 and "99+" at 100 (boundary)', async () => {
    // First render: count = 99 → label says 99 unread, badge text reads "99"
    // (no plus sign).
    fetchApi.mockResolvedValueOnce({ count: 99 });
    const { unmount } = renderWithAuth(<NotificationBell />);
    const btn99 = await screen.findByRole('button', { name: /Notifications \(99 unread\)/ });
    expect(btn99.textContent).toContain('99');
    expect(btn99.textContent).not.toContain('99+');
    unmount();

    // Second render with a fresh tree: count = 100 → badge collapses to "99+".
    fetchApi.mockResolvedValueOnce({ count: 100 });
    renderWithAuth(<NotificationBell />);
    const btn100 = await screen.findByRole('button', { name: /Notifications \(100 unread\)/ });
    expect(btn100.textContent).toContain('99+');
  });

  it('fetch failure on mount renders silently (no crash, no badge)', async () => {
    fetchApi.mockRejectedValueOnce(new Error('network down'));

    renderWithAuth(<NotificationBell />);

    // Bell still renders with the base label and no count suffix.
    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalledWith('/api/notifications/unread-count');
    });
    const btn = screen.getByRole('button', { name: /^Notifications$/ });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('opening the panel after a fetch error renders the empty state', async () => {
    const user = userEvent.setup();
    fetchApi
      .mockResolvedValueOnce({ count: 0 })
      .mockRejectedValueOnce(new Error('boom')); // /api/notifications fails

    renderWithAuth(<NotificationBell />);

    const btn = await screen.findByRole('button', { name: /notifications/i });
    await user.click(btn);

    // After the failed fetch, notifications stays [] → empty-state copy.
    expect(await screen.findByText('No notifications')).toBeInTheDocument();
  });

  it('socket cleanup disconnects on unmount', async () => {
    fetchApi.mockResolvedValueOnce({ count: 0 });

    const { unmount } = renderWithAuth(<NotificationBell />);

    // Wait until the socket effect mounted.
    await waitFor(() => expect(typeof socketHandlers.notification_new).toBe('function'));

    unmount();

    expect(socketDisconnect).toHaveBeenCalled();
  });

  it('socket handler tolerates a missing/empty payload without throwing', async () => {
    fetchApi.mockResolvedValueOnce({ count: 0 });

    renderWithAuth(<NotificationBell />, { user: { id: 42, name: 'Carol' } });

    await waitFor(() => expect(typeof socketHandlers.notification_new).toBe('function'));

    // null payload — guard at the top of the handler must return early.
    expect(() => socketHandlers.notification_new(null)).not.toThrow();
    expect(() => socketHandlers.notifications_cleared(null)).not.toThrow();

    // Badge still 0 → no spurious bump.
    const btn = screen.getByRole('button', { name: /^Notifications$/ });
    expect(btn).toBeInTheDocument();
  });

  it('socket `notification_new` without a notification object still bumps the count', async () => {
    fetchApi.mockResolvedValueOnce({ count: 0 });

    renderWithAuth(<NotificationBell />, { user: { id: 42, name: 'Carol' } });

    await waitFor(() => expect(typeof socketHandlers.notification_new).toBe('function'));

    // Server may emit a bare {userId} signal for "count changed" without
    // bundling the full notification object. The badge should still bump.
    socketHandlers.notification_new({ userId: 42 });

    const btn = await screen.findByRole('button', { name: /Notifications \(1 unread\)/ });
    expect(btn).toBeInTheDocument();
  });
});
