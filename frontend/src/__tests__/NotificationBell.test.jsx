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
 */

// Mock fetchApi BEFORE importing the component.
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

// Mock socket.io-client — the bell installs a socket on mount and we don't
// want a real connection attempt during unit tests.
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

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
});
