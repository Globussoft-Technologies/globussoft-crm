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
// confirm default-resolves true so destructive-action paths (Run backfill)
// auto-accept; the old test stubbed window.confirm — the page now uses
// notify.confirm via useNotify, so we mock at the hook level instead.
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = { error: notifyError, info: vi.fn(), success: vi.fn(), confirm: notifyConfirm };
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { AuthContext } from '../App';
import AuditLog, { __clearEntityCacheForTests } from '../pages/AuditLog';

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
    // v3.7.17: chip copy changed from "Chain broken — please contact support"
    // to "Chain anomaly detected" because the chain-fork case is auto-
    // repairable via the Repair button (the support hand-off only happens
    // when the repair attempt comes back with a content-tamper 409).
    expect(screen.getByTestId('integrity-chip-broken').textContent).toMatch(/Chain anomaly/i);
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

    // notifyConfirm default-resolves true (see top-of-file mock), so the
    // "Continue?" prompt auto-accepts.

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

// ── v3.7.17 — RecordIdChips name resolver ─────────────────────────────
//
// The audit details payload often carries `recordIds: [24, 23, …]` — bare
// integers that mean nothing to a non-engineer. The new resolver maps the
// audit row's entity field ("User", "Patient", …) to a list endpoint
// (/api/staff, /api/wellness/patients, …) and surfaces each record's
// name alongside the numeric ID. These tests pin:
//   1. Names render when the entity resolves + fetch succeeds.
//   2. Unknown entity → bare "#N" chips, no fetch attempted.
//   3. Missing row in the list → "#N" fallback (no "undefined" leak).
//   4. Endpoint failure → "#N" fallback, view does not crash.
// All four exercise the production component via the real AuditLog page,
// so the entity → endpoint → chip pipeline is end-to-end.
describe('<AuditLog /> — RecordIdChips name resolver (v3.7.17)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    __clearEntityCacheForTests();
  });

  function mockOpenableRowWith({ entity, details, staffRows = null, staffShouldFail = false }) {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 1, totalRows: 1, unhashedRows: 0,
          brokenAt: null, reason: null,
          integrityVerified: true, lastVerifiedAt: '2026-05-21T10:00:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve({ total: 1, byAction: {} });
      }
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({
          logs: [{
            id: 42,
            createdAt: new Date('2026-05-21T09:00:00.000Z').toISOString(),
            user: { id: 1, name: 'Admin', email: 'admin@x.test' },
            action: 'PII_DISCLOSED',
            entity,
            entityId: null,
            details: JSON.stringify(details),
            hash: null,
            prevHash: null,
          }],
          pages: 1,
          total: 1,
        });
      }
      if (url === '/api/staff') {
        if (staffShouldFail) return Promise.reject(new Error('500 backend'));
        return Promise.resolve(staffRows || []);
      }
      if (url === '/api/wellness/patients' || url === '/api/wellness/locations' || url === '/api/contacts') {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  }

  async function openOnlyRow() {
    // The whole row is clickable in AuditLog.jsx. Wait for it to render
    // first (it depends on the audit-viewer fetch resolving), then click.
    await waitFor(() => {
      expect(screen.getByText('PII_DISCLOSED')).toBeInTheDocument();
    });
    const cell = screen.getByText('PII_DISCLOSED');
    // Walk up to the <tr> that owns the clickable handler.
    let row = cell;
    while (row && row.tagName !== 'TR') row = row.parentElement;
    if (row) fireEvent.click(row);
  }

  it('renders the row name (Ganesh Sharma) alongside the numeric ID subtitle when entity=User resolves', async () => {
    mockOpenableRowWith({
      entity: 'User',
      details: { scope: 'staff_list', recordIds: [1, 24] },
      staffRows: [
        { id: 1, name: 'Ganesh Sharma', email: 'ganesh@x.test' },
        { id: 24, name: 'Priya Mehta', email: 'priya@x.test' },
      ],
    });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    await waitFor(() => {
      expect(chips.textContent).toMatch(/Ganesh Sharma/);
      expect(chips.textContent).toMatch(/Priya Mehta/);
    });
    // The numeric IDs must still appear as subtitles so Ctrl-F finds them.
    // `\b` word-boundary doesn't fire between digit and letter since both
    // are word chars (e.g. "#1Priya"). Use a negative lookahead so the
    // pattern reads "#1 not followed by another digit" — that's the real
    // assertion (the chip should carry the exact ID, not a prefix of a
    // longer number).
    expect(chips.textContent).toMatch(/#1(?!\d)/);
    expect(chips.textContent).toMatch(/#24(?!\d)/);
  });

  it('falls back to bare #N chips when the entity is not in ENTITY_LOOKUP and skips any fetch', async () => {
    mockOpenableRowWith({
      entity: 'MysteryThing',
      details: { recordIds: [5, 6] },
    });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    expect(chips.textContent).toMatch(/#5\b/);
    expect(chips.textContent).toMatch(/#6\b/);
    // No entity-resolver fetch should have fired.
    const lookupCalls = fetchApiMock.mock.calls.filter(([u]) =>
      u === '/api/staff' || u === '/api/wellness/patients' ||
      u === '/api/wellness/locations' || u === '/api/contacts');
    expect(lookupCalls.length).toBe(0);
  });

  it('falls back to #N when a referenced row is missing from the list (no "undefined" leak)', async () => {
    mockOpenableRowWith({
      entity: 'User',
      details: { recordIds: [1, 999] },
      staffRows: [{ id: 1, name: 'Ganesh Sharma', email: 'g@x.test' }],
    });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    await waitFor(() => {
      expect(chips.textContent).toMatch(/Ganesh Sharma/);
    });
    expect(chips.textContent).toMatch(/#999\b/);
    expect(chips.textContent).not.toMatch(/undefined/);
  });

  it('falls back to #N when the resolver endpoint throws (detail view stays mounted)', async () => {
    mockOpenableRowWith({
      entity: 'User',
      details: { recordIds: [42] },
      staffShouldFail: true,
    });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    await waitFor(() => {
      expect(chips.textContent).toMatch(/#42\b/);
    });
    // The Details surface itself must still be present — a transient
    // fetch failure shouldn't blank the row.
    expect(screen.getByText('Details')).toBeInTheDocument();
  });
});
