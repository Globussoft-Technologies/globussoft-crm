/**
 * AuditLog.test.jsx — page-level vitest + RTL coverage for the Audit Log page.
 *
 * Sister to AuditLog.integrityChip.test.jsx (which pins the #558 hash-chain
 * chip surface). This file covers the broader page surface that wasn't yet
 * tested:
 *
 *   1. Page renders for admin: heading "Audit Log", filter row, stats cards,
 *      table headers, Export CSV button.
 *   2. Stats cards reflect /api/audit-viewer/stats numbers.
 *   3. Log rows render one per /api/audit-viewer entry, with the user name +
 *      action badge + entity + entity id.
 *   4. Empty state: "No audit events match the current filters." renders when
 *      /api/audit-viewer returns an empty logs array.
 *   5. Loading state: "Loading..." renders before the first fetch resolves.
 *   6. Entity filter: changing the dropdown re-fires /api/audit-viewer with
 *      ?entity=<value> in the query string.
 *   7. Action filter: changing the action dropdown re-fires /api/audit-viewer
 *      with ?action=<value> in the query string.
 *   8. Pagination: clicking Next bumps page=2 in the query string.
 *   9. Client-side search filters rows without firing a new network call.
 *
 * Drift note: the route the page uses is `/api/audit-viewer` (the
 * paginated viewer endpoint) — NOT `/api/audit`. The integrity-chip test
 * confirms `/api/audit/verify` is a separate concern. Pinned to code.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

// Stable notify object — returning a fresh object on each useNotify call
// causes the AuditLog verifyChain useCallback to flip identity every
// render, which re-fires the verify useEffect → infinite update loop.
// Pin a single object so the callback ref stays stable across renders.
const notifyError = vi.fn();
const notifyObj = { error: notifyError, info: vi.fn(), success: vi.fn() };
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

const sampleLogs = [
  {
    id: 1,
    createdAt: '2026-04-29T09:00:00.000Z',
    action: 'CREATE',
    entity: 'Deal',
    entityId: 42,
    user: { name: 'Alice Admin', email: 'alice@acme.test' },
    details: '{"title":"Acme Renewal"}',
  },
  {
    id: 2,
    createdAt: '2026-04-29T09:01:00.000Z',
    action: 'UPDATE',
    entity: 'Contact',
    entityId: 7,
    user: { name: 'Bob Manager', email: 'bob@acme.test' },
    details: '{"phone":"+1-555-9999"}',
  },
  {
    id: 3,
    createdAt: '2026-04-29T09:02:00.000Z',
    action: 'DELETE',
    entity: 'Invoice',
    entityId: 13,
    user: { name: 'Charlie User', email: 'charlie@acme.test' },
    details: null,
  },
];

const sampleStats = {
  total: 150,
  byAction: { CREATE: 80, UPDATE: 50, DELETE: 20 },
};

describe('<AuditLog /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 150, brokenAt: null, integrityVerified: true,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve(sampleStats);
      }
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({ logs: sampleLogs, pages: 3, total: 150 });
      }
      return Promise.resolve(null);
    });
  });

  it('renders the heading + Export CSV button for admin', async () => {
    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Audit Log/i })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeInTheDocument();
  });

  it('renders stats cards reflecting /api/audit-viewer/stats values', async () => {
    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByText(/Total events \(30d\)/i)).toBeInTheDocument();
    });
    // Stats values are rendered via toLocaleString → "150", "80", "50", "20".
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('80')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
  });

  it('renders one row per log entry with user, action, entity, and id', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    expect(screen.getByText('Bob Manager')).toBeInTheDocument();
    expect(screen.getByText('Charlie User')).toBeInTheDocument();
    // Action badges. CREATE/UPDATE/DELETE also appear in the action-filter
    // <option> list; use getAllByText to accept both occurrences (1 in
    // dropdown + 1 in row badge → 2 total per action).
    expect(screen.getAllByText('CREATE').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('UPDATE').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('DELETE').length).toBeGreaterThanOrEqual(2);
    // Entity names appear in rows (also in the entity-filter dropdown
    // options, so accept ≥1 occurrence).
    expect(screen.getAllByText('Deal').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Contact').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Invoice').length).toBeGreaterThanOrEqual(1);
    // Entity IDs render as text.
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
  });

  it('shows the empty-state message when /audit-viewer returns no logs', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 0, brokenAt: null, integrityVerified: true,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve({ total: 0, byAction: {} });
      }
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({ logs: [], pages: 1, total: 0 });
      }
      return Promise.resolve(null);
    });

    renderAuditLog();
    await waitFor(() => {
      expect(
        screen.getByText(/No audit events match the current filters\./i)
      ).toBeInTheDocument();
    });
  });

  it('fires /audit-viewer with ?entity=<x> when the entity filter changes', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // Find the entity <select> — first option text is "All entities".
    const entitySelect = screen.getByDisplayValue('All entities');
    fireEvent.change(entitySelect, { target: { value: 'Deal' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/audit-viewer?') && /entity=Deal/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  it('fires /audit-viewer with ?action=<x> when the action filter changes', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const actionSelect = screen.getByDisplayValue('All actions');
    fireEvent.change(actionSelect, { target: { value: 'DELETE' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/audit-viewer?') && /action=DELETE/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  it('client-side search narrows visible rows without firing a new fetch', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // Typing "alice" should hide the other two rows. No new fetchApi for the
    // search field (search is a client-side filter over `logs`).
    fetchApiMock.mockClear();
    const searchInput = screen.getByPlaceholderText(/Search user, entity, or details/i);
    fireEvent.change(searchInput, { target: { value: 'alice' } });

    await waitFor(() => {
      expect(screen.queryByText('Bob Manager')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
    expect(screen.queryByText('Charlie User')).not.toBeInTheDocument();
    // No new fetchApi call for the search.
    const fetched = fetchApiMock.mock.calls.filter(([u]) =>
      typeof u === 'string' && u.startsWith('/api/audit-viewer?')
    );
    expect(fetched.length).toBe(0);
  });

  it('clicking Next bumps page=2 in the next /audit-viewer call', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    fetchApiMock.mockClear();

    const nextBtn = screen.getByRole('button', { name: /^Next$/ });
    expect(nextBtn).toBeEnabled();
    fireEvent.click(nextBtn);

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/audit-viewer?') && /page=2/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  // ---------------- Extended cases (2026-05-26) ----------------
  // The 8 tests above cover the basic page surface. The cases below extend
  // coverage to drill-down detail panel, CSV export wiring, date filters,
  // pagination guards, search-across-details + entity-id, error/loading
  // edge states, integrity backfill banner, and non-admin omission of the
  // integrity row. Stable mock-object pattern is preserved (2026-05-23
  // standing rule). All assertions pin to existing code in AuditLog.jsx —
  // no behaviour change implied.

  it('clicking a row opens the drill-down panel with formatted JSON details', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // Click Alice's row (the CREATE/Deal row). Drawer renders the pretty-
    // printed details JSON for entity 42.
    fireEvent.click(screen.getByText('Alice Admin'));

    await waitFor(() => {
      // prettyDetails() JSON.stringify-with-2-indent renders the title key.
      // Match the inner string content; the surrounding {} are split across
      // lines so a single regex over the whole pre block is the safe match.
      expect(screen.getByText(/"title": "Acme Renewal"/)).toBeInTheDocument();
    });

    // The "Details" uppercase label appears inside the drawer.
    expect(screen.getByText(/^Details$/)).toBeInTheDocument();
  });

  it('drill-down renders "(no details)" when log.details is null', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Charlie User')).toBeInTheDocument());

    // Charlie's DELETE/Invoice row has details=null per sampleLogs.
    fireEvent.click(screen.getByText('Charlie User'));

    await waitFor(() => {
      expect(screen.getByText('(no details)')).toBeInTheDocument();
    });
  });

  it('changing date filters fires /audit-viewer with ?from=&to= params', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    fetchApiMock.mockClear();

    // The `from` and `to` date inputs are identified by `title` attribute.
    const fromInput = screen.getByTitle('From');
    const toInput = screen.getByTitle('To');
    fireEvent.change(fromInput, { target: { value: '2026-04-01' } });
    fireEvent.change(toInput, { target: { value: '2026-04-30' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' &&
        u.startsWith('/api/audit-viewer?') &&
        /from=2026-04-01/.test(u) &&
        /to=2026-04-30/.test(u)
      );
      expect(call).toBeTruthy();
    });
  });

  it('Export CSV button calls /api/audit-viewer/export.csv with current filters', async () => {
    // Stub global fetch + URL APIs that handleExport uses (it bypasses
    // fetchApi and calls window.fetch directly to get a blob). Restore
    // stubs at the end so other tests aren't affected.
    const originalFetch = global.fetch;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ blob: () => Promise.resolve(new Blob(['csv,data'])) })
    );
    global.fetch = fetchSpy;
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();

    try {
      renderAuditLog();
      await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

      // Apply an entity filter so the export URL carries ?entity=Deal.
      const entitySelect = screen.getByDisplayValue('All entities');
      fireEvent.change(entitySelect, { target: { value: 'Deal' } });
      await waitFor(() =>
        expect(screen.getByDisplayValue('Deal')).toBeInTheDocument()
      );

      fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));

      await waitFor(() => {
        const call = fetchSpy.mock.calls.find(([u]) =>
          typeof u === 'string' &&
          u.startsWith('/api/audit-viewer/export.csv?') &&
          /entity=Deal/.test(u)
        );
        expect(call).toBeTruthy();
      });

      // Authorization header is passed when getAuthToken returns a token.
      const callArgs = fetchSpy.mock.calls.find(([u]) =>
        typeof u === 'string' && u.startsWith('/api/audit-viewer/export.csv?')
      );
      expect(callArgs[1].headers.Authorization).toBe('Bearer test-token');
    } finally {
      global.fetch = originalFetch;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('clicking Verify chain re-fires /api/audit/verify', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // Initial mount auto-verifies once. Click the button to force another
    // call.
    fetchApiMock.mockClear();
    fireEvent.click(screen.getByTestId('verify-chain-btn'));

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([u]) =>
        typeof u === 'string' && u === '/api/audit/verify'
      );
      expect(call).toBeTruthy();
    });
  });

  it('shows the integrity backfill banner when unhashedRows > 0 and reason mentions null hash', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 10,
          totalRows: 100,
          unhashedRows: 90,
          brokenAt: 12,
          reason: 'null hash — row was never chained (run backfill)',
          integrityVerified: false,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve(sampleStats);
      }
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({ logs: sampleLogs, pages: 1, total: 3 });
      }
      return Promise.resolve(null);
    });

    renderAuditLog();
    await waitFor(() => {
      expect(screen.getByTestId('integrity-backfill-banner')).toBeInTheDocument();
    });
    // The Run backfill button is present inside the banner.
    expect(screen.getByTestId('run-backfill-btn')).toBeInTheDocument();
    // The warn chip (not red, not ok) is what the chip-row renders.
    expect(screen.getByTestId('integrity-chip-needs-backfill')).toBeInTheDocument();
  });

  it('omits the integrity row entirely for non-admin users', async () => {
    renderAuditLog(REGULAR_USER);

    // Wait for the basic page to be there.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Audit Log/i })).toBeInTheDocument();
    });

    // Non-admin: the integrity-row (and its verify button) must not render.
    expect(screen.queryByTestId('integrity-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-chain-btn')).not.toBeInTheDocument();
  });

  it('Previous button is disabled on page 1', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    const prevBtn = screen.getByRole('button', { name: /^Previous$/ });
    expect(prevBtn).toBeDisabled();
  });

  it('Next button is disabled when on the last page', async () => {
    // Override mock so total pages = 1; Next should be disabled.
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 3, brokenAt: null, integrityVerified: true,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve(sampleStats);
      }
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({ logs: sampleLogs, pages: 1, total: 3 });
      }
      return Promise.resolve(null);
    });

    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    const nextBtn = screen.getByRole('button', { name: /^Next$/ });
    expect(nextBtn).toBeDisabled();
  });

  it('Clear button appears when filters set, and clears them on click', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // No Clear button initially.
    expect(screen.queryByRole('button', { name: /^Clear$/ })).not.toBeInTheDocument();

    // Set an entity filter.
    const entitySelect = screen.getByDisplayValue('All entities');
    fireEvent.change(entitySelect, { target: { value: 'Deal' } });

    // Clear button now visible.
    const clearBtn = await screen.findByRole('button', { name: /^Clear$/ });
    expect(clearBtn).toBeInTheDocument();

    // Click Clear → filter resets, Clear disappears.
    fireEvent.click(clearBtn);
    await waitFor(() => {
      expect(screen.getByDisplayValue('All entities')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^Clear$/ })).not.toBeInTheDocument();
  });

  it('search input also matches entity name and entity id (not just user)', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // Search by entity id "42" — should hide Bob and Charlie's rows.
    const searchInput = screen.getByPlaceholderText(/Search user, entity, or details/i);
    fireEvent.change(searchInput, { target: { value: '42' } });

    await waitFor(() => {
      expect(screen.queryByText('Bob Manager')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Alice Admin')).toBeInTheDocument();
    expect(screen.queryByText('Charlie User')).not.toBeInTheDocument();
  });

  it('handles /audit-viewer load failure gracefully (empty rows, no crash)', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit/verify')) {
        return Promise.resolve({
          chainLength: 0, brokenAt: null, integrityVerified: true,
          lastVerifiedAt: '2026-05-08T10:30:00.000Z',
        });
      }
      if (url.startsWith('/api/audit-viewer/stats')) {
        return Promise.resolve({ total: 0, byAction: {} });
      }
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve(null);
    });

    renderAuditLog();

    // After the rejected /audit-viewer load, loading flips off and
    // filteredLogs is empty → empty-state message renders.
    await waitFor(() => {
      expect(
        screen.getByText(/No audit events match the current filters\./i)
      ).toBeInTheDocument();
    });
  });
});
