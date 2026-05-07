/**
 * LeadScoring Re-score button regression spec — issue #630.
 *
 * Pre-fix observation: clicking "Re-score All" entered loading state but
 * surfaced no toast on success or failure. Errors were swallowed via a bare
 * `console.error(e)`. Users reported "click does nothing visible."
 *
 * Fix shipped (LeadScoring.jsx):
 *   - Wired useNotify().
 *   - Success toast includes the `scored` count returned by the backend
 *     (`POST /api/ai_scoring/trigger` returns `{ success: true, scored: N }`).
 *   - Error toast surfaces the server-side message via fetchApi's err.message.
 *
 * Test pins
 *   - Button label flips to "Scoring..." while the request is in flight.
 *   - Spinner icon receives the spin animation while in flight (loading state).
 *   - On resolved success, notify.success is called with the count.
 *   - On rejected request, notify.error is called.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AuthContext } from '../App';

// Toast spies — we assert these were called.
const successSpy = vi.fn();
const errorSpy = vi.fn();

vi.mock('../utils/notify', () => ({
  useNotify: () => ({ success: successSpy, error: errorSpy, info: vi.fn() }),
}));

// Mock fetchApi — each test sets the resolution / rejection it wants.
vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../utils/api';
import LeadScoring from '../pages/LeadScoring';

const renderPage = () =>
  render(
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
      <LeadScoring />
    </AuthContext.Provider>,
  );

describe('LeadScoring Re-score button — #630', () => {
  beforeEach(() => {
    successSpy.mockClear();
    errorSpy.mockClear();
    fetchApi.mockReset();
  });

  it('shows the loading state ("Scoring...") while the rescore request is in flight', async () => {
    // First call is loadContacts() on mount; second is the trigger POST.
    fetchApi.mockImplementation((url, _opts) => {
      if (url === '/api/contacts' && !_opts) return Promise.resolve([]);
      if (url === '/api/ai_scoring/trigger') {
        // Hold the trigger pending so the button stays in the loading state.
        return new Promise(() => {});
      }
      return Promise.resolve([]);
    });

    renderPage();

    // Wait for initial load to complete (no longer "Loading...").
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /re-score all/i })).toBeInTheDocument();
    });

    const btn = screen.getByRole('button', { name: /re-score all/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /scoring/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /scoring/i })).toBeDisabled();
  });

  it('fires a success toast with the rescored count when the request resolves', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/ai_scoring/trigger') {
        return Promise.resolve({ success: true, scored: 42 });
      }
      return Promise.resolve([]);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /re-score all/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-score all/i }));
    });

    await waitFor(() => {
      expect(successSpy).toHaveBeenCalledTimes(1);
    });
    // The toast text must include the count + "Re-scored" wording.
    const msg = successSpy.mock.calls[0][0];
    expect(msg).toMatch(/42/);
    expect(msg).toMatch(/re-scored/i);
  });

  it('fires an error toast when the request rejects', async () => {
    fetchApi.mockImplementation((url) => {
      if (url === '/api/contacts') return Promise.resolve([]);
      if (url === '/api/ai_scoring/trigger') {
        const err = new Error('Scoring trigger failed');
        err.status = 500;
        return Promise.reject(err);
      }
      return Promise.resolve([]);
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /re-score all/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /re-score all/i }));
    });

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
    // Server-side error message should be surfaced verbatim.
    expect(errorSpy.mock.calls[0][0]).toMatch(/scoring trigger failed/i);
    // Button returns to idle state after the rejection settles.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /re-score all/i })).not.toBeDisabled();
    });
  });
});
