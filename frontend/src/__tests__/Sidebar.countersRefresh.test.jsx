/**
 * Sidebar counter-refresh regression spec — issue #625.
 *
 * Original framing (#625 pre-fix):
 *   The My Tasks badge was fetched once on mount and only updated by socket.io
 *   `task_created` (no `task_completed` event exists on the backend) plus a
 *   60s safety-net poll. Marking a task complete on /tasks then navigating to
 *   /contacts showed the stale pre-mutation count until the next poll/reload.
 *
 * Current shipped behaviour (Sidebar.jsx:343-353):
 *   The route-change useEffect was REMOVED as a perf decision — every
 *   navigation was firing four redundant fetches. Refresh now happens via:
 *     1. Initial mount fetch.
 *     2. 60s safety-net polling.
 *     3. Socket events on `*_created`.
 *     4. Window-level CustomEvent `sidebar:counts-changed` — mutating pages
 *        (Tasks.jsx, ticket close, etc.) dispatch this and Sidebar re-fetches.
 *   The window-event mechanism gives mutating pages an explicit hook for
 *   immediate visibility without paying the 4-call cost on every route change.
 *
 * Test pins
 *   - On mount, Sidebar fires the four sidebar fetchApi calls once.
 *   - Navigating routes alone does NOT re-fire the counter fetches (the
 *     route-change effect is intentionally disabled — see Sidebar.jsx:343).
 *   - Dispatching `sidebar:counts-changed` on window re-fires those four
 *     calls without needing a route change.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate, Routes, Route } from 'react-router-dom';
import Sidebar from '../components/Sidebar';
import { AuthContext } from '../App';

// Stub the SSO + notify + socket bits so the unit tests don't try real I/O.
vi.mock('../utils/adsgpt', () => ({
  launchAdsGptAs: vi.fn(),
  ADSGPT_DASHBOARD: 'https://example.test',
}));
vi.mock('../utils/callified', () => ({ launchCallifiedSSO: vi.fn() }));
vi.mock('../utils/notify', () => ({
  useNotify: () => ({ error: vi.fn(), success: vi.fn(), confirm: vi.fn() }),
}));
vi.mock('socket.io-client', () => ({
  io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }),
}));

// fetchApi is what we count calls on. Default to empty arrays so safeLen
// resolves to 0 cleanly.
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(() => Promise.resolve([])),
}));

import { fetchApi } from '../utils/api';

// Counter-fetching endpoints we care about — Sidebar wires four with `silent: true`.
const COUNTER_URLS = [
  '/api/contacts?status=Lead',
  '/api/tasks?status=PENDING',
  '/api/tickets?status=OPEN',
  '/api/email?unread=1',
];

function callsForUrl(url) {
  return fetchApi.mock.calls.filter((c) => c[0] === url).length;
}

// Tiny child component that triggers programmatic navigation on mount.
function Navigator({ to }) {
  const navigate = useNavigate();
  React.useEffect(() => {
    navigate(to);
  }, [to, navigate]);
  return null;
}

const renderWithAuth = (initialPath = '/dashboard') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthContext.Provider
        value={{
          user: { id: 1, name: 'Test', email: 't@x.test', role: 'MANAGER' },
          setUser: vi.fn(),
          token: 't-abc',
          setToken: vi.fn(),
          tenant: { vertical: 'generic' },
          setTenant: vi.fn(),
        }}
      >
        <Sidebar />
        <Routes>
          <Route path="*" element={null} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );

describe('Sidebar counter refresh — #625', () => {
  beforeEach(() => {
    fetchApi.mockClear();
    fetchApi.mockResolvedValue([]);
  });

  it('fires the four counter fetches on initial mount', async () => {
    // Note: there are two effects that fetch on mount — the user-id effect
    // and the location.pathname effect (both fire on initial render). Either
    // way, every counter URL must be hit at least once.
    renderWithAuth('/dashboard');
    await waitFor(() => {
      for (const url of COUNTER_URLS) {
        expect(callsForUrl(url)).toBeGreaterThanOrEqual(1);
      }
    });
  });

  it('does NOT re-fire the four counter fetches on a bare route change (perf trade-off)', async () => {
    // Sidebar.jsx:343-353 intentionally removed the route-change refetch
    // effect — every navigation was firing four redundant API calls. The
    // explicit window CustomEvent path (next test) is the supported way for
    // a mutating page to force an immediate refresh.
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <AuthContext.Provider
          value={{
            user: { id: 1, name: 'Test', email: 't@x.test', role: 'MANAGER' },
            setUser: vi.fn(),
            token: 't-abc',
            setToken: vi.fn(),
            tenant: { vertical: 'generic' },
            setTenant: vi.fn(),
          }}
        >
          <Sidebar />
          <Navigator to="/contacts" />
        </AuthContext.Provider>
      </MemoryRouter>,
    );

    // Settle: each counter URL hit at least once on initial mount.
    await waitFor(() => {
      for (const url of COUNTER_URLS) {
        expect(callsForUrl(url)).toBeGreaterThanOrEqual(1);
      }
    });

    // Give React + the navigator effect a tick to land.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // After the route change, each counter URL should still be at exactly the
    // baseline mount-fetch count — no extra requests fired by the navigation.
    for (const url of COUNTER_URLS) {
      expect(callsForUrl(url)).toBe(1);
    }
  });

  it('re-fires the four counter fetches when window dispatches sidebar:counts-changed', async () => {
    renderWithAuth('/dashboard');

    // Wait for initial-mount fetches to settle (at least one call landed).
    await waitFor(() => {
      expect(callsForUrl('/api/tasks?status=PENDING')).toBeGreaterThanOrEqual(1);
    });

    const baseline = COUNTER_URLS.map(callsForUrl);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('sidebar:counts-changed'));
    });

    await waitFor(() => {
      COUNTER_URLS.forEach((url, i) => {
        expect(callsForUrl(url)).toBe(baseline[i] + 1);
      });
    });
  });
});
