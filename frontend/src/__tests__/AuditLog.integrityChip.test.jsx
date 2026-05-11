/**
 * AuditLog.jsx — hash-chain integrity chip + Verify button (#558).
 *
 * Scope: pins the tamper-evidence UI surface added in #558. The /audit-log
 * page exposes:
 *   - A green "Integrity verified at HH:MM" chip when /api/audit/verify
 *     returns integrityVerified=true.
 *   - A red "Chain broken — please contact support" chip when verify
 *     returns integrityVerified=false (with the broken row id).
 *   - A "Verify chain" button that re-runs the verification.
 * Both UI elements are admin-only — they don't render for role=USER.
 *
 * Contracts pinned here:
 *   1. ADMIN: integrity row renders with the OK chip after auto-verify.
 *   2. ADMIN: clicking "Verify chain" re-fires /api/audit/verify.
 *   3. ADMIN: when verify returns brokenAt, the red chip renders with the id.
 *   4. USER (non-admin): integrity row + Verify button do NOT render.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — fresh-per-render objects cause the same
// re-render storm called out in CLAUDE.md's RTL standing rule (useNotify
// is referenced by useCallback deps in AuditLog.jsx, so a fresh object
// each render invalidates the callback identity → useEffect re-fires →
// setVerifying loops). One object, vi.fn() handles, for the whole run.
const notifyError = vi.fn();
const notifyObj = { error: notifyError, info: vi.fn(), success: vi.fn(), confirm: vi.fn() };
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import AuditLog from '../pages/AuditLog';

const ADMIN_USER = { userId: 1, name: 'Admin', email: 'a@x.com', role: 'ADMIN' };
const REGULAR_USER = { userId: 2, name: 'User', email: 'u@x.com', role: 'USER' };

function renderAuditLog(user = ADMIN_USER) {
  return render(
    <AuthContext.Provider value={{ user, token: 'tk', tenant: { id: 1 }, loading: false }}>
      <AuditLog />
    </AuthContext.Provider>
  );
}

describe('<AuditLog /> — hash-chain integrity chip (#558)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    // Default mock: list endpoints return empty + verify endpoint returns
    // integrityVerified=true so the OK chip renders.
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 42,
          brokenAt: null,
          integrityVerified: true,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve({ total: 0, byAction: {} });
      }
      return Promise.resolve({ logs: [], pages: 1, total: 0 });
    });
  });

  it('admin: renders OK chip + chainLength after auto-verify', async () => {
    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByTestId('integrity-chip-ok')).toBeInTheDocument();
    });
    expect(screen.getByTestId('integrity-chip-ok').textContent).toMatch(/Integrity verified/);
    expect(screen.getByTestId('integrity-chip-ok').textContent).toMatch(/42 rows/);
  });

  it('admin: "Verify chain" button is rendered + clickable', async () => {
    renderAuditLog();
    // The component fires an auto-verify on mount which puts the button
    // into "Verifying..." loading state. Wait for that to settle into the
    // idle "Verify chain" text before asserting + clicking.
    await waitFor(() => {
      const b = screen.getByTestId('verify-chain-btn');
      expect(b).toHaveTextContent(/Verify chain/);
    });
    const btn = screen.getByTestId('verify-chain-btn');

    // Reset call count so we can assert on the click invocation.
    fetchApiMock.mockClear();
    fetchApiMock.mockResolvedValue({
      chainLength: 43, brokenAt: null,
      integrityVerified: true, lastVerifiedAt: '2026-05-08T10:35:00.000Z',
    });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/audit/verify');
    });
  });

  it('admin: renders broken chip with row id when chain is tampered', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 100,
          brokenAt: 1234,
          integrityVerified: false,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) return Promise.resolve({ total: 0, byAction: {} });
      return Promise.resolve({ logs: [], pages: 1, total: 0 });
    });
    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByTestId('integrity-chip-broken')).toBeInTheDocument();
    });
    expect(screen.getByTestId('integrity-chip-broken').textContent).toMatch(/Chain broken/);
    expect(screen.getByTestId('integrity-chip-broken').textContent).toMatch(/1234/);
  });

  it('admin: null-hash response → yellow "Backfill required" banner with Run backfill button', async () => {
    // Strict verifier reports `unhashedRows > 0` + reason "null hash …" when
    // pre-#558 legacy rows haven't been backfilled. The UI must NOT show
    // the red "contact support" chip in this case — backfill is a routine
    // operator action, not an incident.
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 1,
          totalRows: 193,
          unhashedRows: 193,
          brokenAt: 109,
          reason: 'null hash — row was never chained (run backfill)',
          integrityVerified: false,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) return Promise.resolve({ total: 0, byAction: {} });
      return Promise.resolve({ logs: [], pages: 1, total: 0 });
    });
    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByTestId('integrity-chip-needs-backfill')).toBeInTheDocument();
    });
    expect(screen.getByTestId('integrity-chip-needs-backfill').textContent).toMatch(/Backfill required/);
    expect(screen.getByTestId('integrity-chip-needs-backfill').textContent).toMatch(/193 of 193/);
    // Banner is a distinct surface with a Run backfill action.
    expect(screen.getByTestId('integrity-backfill-banner')).toBeInTheDocument();
    expect(screen.getByTestId('run-backfill-btn')).toBeInTheDocument();
    // The red chip MUST NOT be present — a null-hash break is not a tampering alert.
    expect(screen.queryByTestId('integrity-chip-broken')).not.toBeInTheDocument();
  });

  it('admin: Run backfill posts to /api/audit/backfill then re-verifies', async () => {
    // Initial verify: unhashed → yellow chip. Click Run backfill → POST
    // /api/audit/backfill → re-verify → green chip.
    let phase = 'pre-backfill';
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/audit/backfill' && opts?.method === 'POST') {
        phase = 'post-backfill';
        return Promise.resolve({ tenantId: 1, walkedRows: 193, updatedRows: 193, skippedRows: 0 });
      }
      if (url.startsWith('/api/audit/verify')) {
        if (phase === 'pre-backfill') {
          return Promise.resolve({
            chainLength: 1, totalRows: 193, unhashedRows: 193,
            brokenAt: 109, reason: 'null hash — row was never chained (run backfill)',
            integrityVerified: false, lastVerifiedAt: '2026-05-08T10:30:00.000Z',
          });
        }
        return Promise.resolve({
          chainLength: 193, totalRows: 193, unhashedRows: 0,
          brokenAt: null, reason: null,
          integrityVerified: true, lastVerifiedAt: '2026-05-08T10:31:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) return Promise.resolve({ total: 0, byAction: {} });
      return Promise.resolve({ logs: [], pages: 1, total: 0 });
    });

    // Stub window.confirm so the "Continue?" prompt auto-accepts.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByTestId('run-backfill-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('run-backfill-btn'));
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/audit/backfill', { method: 'POST' });
    });
    // After re-verify resolves, the green chip should replace the yellow one.
    await waitFor(() => {
      expect(screen.getByTestId('integrity-chip-ok')).toBeInTheDocument();
    });
    expect(screen.getByTestId('integrity-chip-ok').textContent).toMatch(/193 rows/);

    confirmSpy.mockRestore();
  });

  it('non-admin (USER role): integrity row + Verify button are NOT rendered', async () => {
    renderAuditLog(REGULAR_USER);
    // Wait for stats / list calls to settle.
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId('integrity-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-chain-btn')).not.toBeInTheDocument();
    // And /api/audit/verify must NOT have been called for non-admins.
    const verifyCalls = fetchApiMock.mock.calls.filter(([url]) => url === '/api/audit/verify');
    expect(verifyCalls.length).toBe(0);
  });
});
