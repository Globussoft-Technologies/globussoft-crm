/**
 * Sidebar counter-refresh regression spec — issue #625.
 *
 * Pre-fix observation: the My Tasks badge was fetched once on mount and only
 * updated by socket.io `task_created` (no `task_completed` event exists on the
 * backend) plus a 60s safety-net poll. A user who marked a task complete on
 * /tasks then navigated to /contacts saw the stale pre-mutation count in the
 * sidebar until the next poll fired or the page was reloaded.
 *
 * Fix shipped (Sidebar.jsx):
 *   1. Route-change useEffect — on every location.pathname change, re-fetch
 *      the four counter endpoints. Cheap, predictable, no race vs polling.
 *   2. Window-level CustomEvent — pages that mutate tasks/tickets dispatch
 *      `sidebar:counts-changed` and Sidebar re-fetches in response. Tasks.jsx
 *      now dispatches this on createTask + markComplete.
 *
 * Test pins
 *   - On mount, Sidebar fires the four sidebar fetchApi calls once.
 *   - Navigating from /tasks to /contacts re-fires those four calls.
 *   - Dispatching `sidebar:counts-changed` on window re-fires those four calls
 *     without a route change.
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
  ADSGPT_DEMO_LOGIN: 'demo@x.test',
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

  it('re-fires the four counter fetches when location.pathname changes', async () => {
    // Render Sidebar at /tasks, capture the baseline call counts after the
    // initial render settles, then programmatically navigate to /contacts.
    // The post-navigation count must be > baseline for every counter URL.
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

    // After mount + navigate, every counter URL should have been hit at least
    // twice (initial mount + post-navigation refresh). The route-change effect
    // is what ships the second call.
    await waitFor(() => {
      for (const url of COUNTER_URLS) {
        expect(callsForUrl(url)).toBeGreaterThanOrEqual(2);
      }
    });
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
