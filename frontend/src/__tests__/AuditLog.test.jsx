/**
 * Page tests for the retained audit event list: filtering, details, and export.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthContext } from '../appContexts';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifyObj = { error: notifyError, info: vi.fn(), success: vi.fn() };
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import AuditLog from '../pages/AuditLog';

const DEFAULT_AUTH = {
  user: { id: 1, tenantId: 1, role: 'ADMIN' },
  tenant: { id: 1, vertical: 'generic' },
};

function renderAuditLog(auth = DEFAULT_AUTH) {
  return render(
    <AuthContext.Provider value={auth}>
      <AuditLog />
    </AuthContext.Provider>,
  );
}

async function addFilter(label) {
  fireEvent.click(screen.getByRole('button', { name: /Add filter/i }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(label, 'i') }));
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

describe('<AuditLog /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    notifyError.mockReset();
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({
          logs: sampleLogs.map((log) => ({ ...log, viewerTimezone: 'Asia/Kolkata' })),
          pages: 3,
          total: 150,
          viewerTimezone: 'Asia/Kolkata',
        });
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

  it('loads the event list without integrity or repair controls', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    const removedRouteCalls = fetchApiMock.mock.calls.filter(([url]) =>
      typeof url === 'string' && /\/api\/audit\/(verify|backfill)/.test(url)
    );
    expect(removedRouteCalls).toHaveLength(0);
    expect(screen.queryByText(/Verify chain|Repair chain|Chain anomaly detected/i)).not.toBeInTheDocument();
  });

  it('omits the aggregate cards and does not request their stats', async () => {
    const { container } = renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    expect(container.querySelector('.travel-audit-page__stats')).toBeNull();
    expect(screen.queryByText(/Total events \(30d\)/i)).not.toBeInTheDocument();
    expect(fetchApiMock.mock.calls.some(([url]) => url === '/api/audit-viewer/stats')).toBe(false);
  });

  it('opens the filter picker and adds date/time controls on selection', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    expect(screen.queryByLabelText('From date and time')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add filter/i }));
    expect(screen.getByRole('menu', { name: 'Choose a filter to add' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Entity/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Action/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Date & time/ }));
    expect(screen.getByLabelText('From date and time')).toBeInTheDocument();
    expect(screen.getByLabelText('To date and time')).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Choose a filter to add' })).not.toBeInTheDocument();
  });

  it('renders one readable row per log with its user, activity, record, and ID', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    expect(screen.getByText('Bob Manager')).toBeInTheDocument();
    expect(screen.getByText('Charlie User')).toBeInTheDocument();
    // Each event row exposes its readable activity, entity, ID, and actor as
    // one accessible name; filter choices are only rendered when selected.
    expect(screen.getByRole('row', { name: /Created Deal.*#42.*Alice Admin/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Updated Contact.*#7.*Bob Manager/ })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Deleted Invoice.*#13.*Charlie User/ })).toBeInTheDocument();
  });

  it('renders hard-delete actions and exposes the hard-delete filter', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({
          logs: [{
            id: 99,
            createdAt: '2026-04-29T09:02:00.000Z',
            action: 'HARD_DELETE',
            entity: 'Contact',
            entityId: 13,
            user: { name: 'Admin Deleter', email: 'admin@acme.test' },
            details: '{"name":"Deleted Lead"}',
          }],
          pages: 1,
          total: 1,
        });
      }
      return Promise.resolve(null);
    });

    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Admin Deleter')).toBeInTheDocument());
    await addFilter('Action');
    expect(screen.getAllByText('Permanently deleted').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByDisplayValue('All actions')).toBeInTheDocument();
  });

  it('shows the empty-state message when /audit-viewer returns no logs', async () => {
    fetchApiMock.mockImplementation((url) => {
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
    await addFilter('Entity');
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
    await addFilter('Action');
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

  // Extended cases cover details, CSV export, date filters, pagination, search, and errors.

  it('clicking a row opens a readable activity overview without raw JSON', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // Click Alice's row (the Deal activity for entity 42).
    fireEvent.click(screen.getByText('Alice Admin'));

    await waitFor(() => {
      expect(screen.getByText('Acme Renewal')).toBeInTheDocument();
    });

    expect(screen.getByText('Activity overview')).toBeInTheDocument();
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Performed by')).toBeInTheDocument();
    expect(screen.getByText('Date and time')).toBeInTheDocument();
    expect(screen.getByText('Deal #42')).toBeInTheDocument();
    expect(screen.queryByText('Show raw JSON')).not.toBeInTheDocument();
    expect(screen.queryByText('{"title":"Acme Renewal"}')).not.toBeInTheDocument();
  });

  it('drill-down explains when no additional details were recorded', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Charlie User')).toBeInTheDocument());

    // Charlie's DELETE/Invoice row has details=null per sampleLogs.
    fireEvent.click(screen.getByText('Charlie User'));

    await waitFor(() => {
      expect(screen.getByText('No additional details were recorded.')).toBeInTheDocument();
    });
  });

  it('filters by date and time and sends an inclusive range to the API', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({ logs: sampleLogs, pages: 3, total: 150, viewerTimezone: 'UTC' });
      }
      return Promise.resolve(null);
    });
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());
    await addFilter('Date & time');
    fetchApiMock.mockClear();

    const fromInput = screen.getByLabelText('From date and time');
    const toInput = screen.getByLabelText('To date and time');
    fireEvent.change(fromInput, { target: { value: '2026-04-01T10:15' } });
    fireEvent.change(toInput, { target: { value: '2026-04-30T18:45' } });

    await waitFor(() => {
      const call = fetchApiMock.mock.calls.find(([url]) => {
        if (typeof url !== 'string' || !url.startsWith('/api/audit-viewer?')) return false;
        const query = new URLSearchParams(url.split('?')[1]);
        return query.has('from') && query.has('to');
      });
      expect(call).toBeTruthy();
      const query = new URLSearchParams(call[0].split('?')[1]);
      expect(query.get('from')).toBe('2026-04-01T10:15:00.000Z');
      expect(query.get('to')).toBe('2026-04-30T18:45:59.999Z');
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
      await addFilter('Entity');
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

  it('Previous button is disabled on page 1', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    const prevBtn = screen.getByRole('button', { name: /^Previous$/ });
    expect(prevBtn).toBeDisabled();
  });

  it('Next button is disabled when on the last page', async () => {
    // Override mock so total pages = 1; Next should be disabled.
    fetchApiMock.mockImplementation((url) => {
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

  it('Clear all removes selected values and added filter controls', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /^Clear all$/ })).not.toBeInTheDocument();

    // Add an entity filter, then choose a value.
    await addFilter('Entity');
    const entitySelect = screen.getByDisplayValue('All entities');
    fireEvent.change(entitySelect, { target: { value: 'Deal' } });

    const clearBtn = await screen.findByRole('button', { name: /^Clear all$/ });
    expect(clearBtn).toBeInTheDocument();

    // Clear all removes the selected value and closes its filter control.
    fireEvent.click(clearBtn);
    await waitFor(() => {
      expect(screen.queryByDisplayValue('All entities')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /^Clear all$/ })).not.toBeInTheDocument();
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

  // Additional rendering, pagination, and export failure cases.

  it('renders timestamps in IST with a short TZ label (#387)', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // 2026-04-29T09:00:00.000Z → 2:30 pm IST (en-IN locale renders day/M/yyyy
    // with no leading zero on day-of-month → "29/4/2026" not "29/04/2026").
    // Per the 2026-05-07 wave-6 cron-learning (ICU drift), accept either
    // "IST" or "GMT+5:30" as the short-label form — both are valid ISO output
    // depending on the runner's ICU/tzdata build. Assert flexibly.
    const cells = screen.getAllByText(
      (_, el) => el?.tagName === 'TD' && /29\/0?4\/2026/.test(el.textContent || '')
    );
    expect(cells.length).toBeGreaterThanOrEqual(1);
    // At least one timestamp cell contains an IST-or-GMT-offset label.
    const labelled = cells.find(el =>
      /(IST|GMT[+-]\d)/i.test(el.textContent || '')
    );
    expect(labelled).toBeTruthy();
    // And contains 2:30 wall-clock (UTC+5:30 of 09:00 → 14:30; en-IN renders
    // 12-hour by default → "2:30:00 pm"). Accept either 24h or 12h form.
    expect(/(14:30:00|2:30:00)/.test(labelled.textContent)).toBe(true);
  });

  it('renders pagination summary "Page X of Y · N total events"', async () => {
    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // pages=3, total=150 from beforeEach defaults; toLocaleString → "150".
    // The summary text is split across plain text nodes + <strong> children
    // inside one wrapper div ("Page <strong>1</strong> of <strong>3</strong>
    // · 150 total events"). Find by smallest matching div to dodge ancestors.
    const candidates = screen.getAllByText((_, el) => {
      if (!el || el.tagName !== 'DIV') return false;
      const txt = el.textContent || '';
      return /Page\s+1\s+of\s+3/.test(txt) && /150 total events/.test(txt);
    });
    // Smallest text-length match = the actual summary wrapper, not ancestors.
    const summary = candidates.reduce((min, el) =>
      (el.textContent.length < min.textContent.length ? el : min), candidates[0]);
    expect(summary).toBeTruthy();
    expect(summary.textContent).toMatch(/Page\s+1\s+of\s+3/);
    expect(summary.textContent).toMatch(/150 total events/);
  });

  it('ActionBadge renders unknown actions with the "other" CSS variant', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({
          logs: [{
            ...sampleLogs[0],
            action: 'LOGIN',
          }],
          pages: 1, total: 1,
        });
      }
      return Promise.resolve(null);
    });

    renderAuditLog();
    await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

    // LOGIN is not in ACTION_COLOR ({CREATE,UPDATE,DELETE}), so ActionBadge
    // falls back to OTHER_COLOR='#6b7280'. The component uses inline styles
    // (no CSS class variants), so pin the inline color directly.
    const loginPill = screen.getAllByText('Signed in').find(el =>
      el.tagName === 'SPAN' && el.style?.color === 'rgb(107, 114, 128)'
    );
    expect(loginPill).toBeTruthy();
  });

  it('Export CSV failure fires notify.error("Failed to export CSV")', async () => {
    const originalFetch = global.fetch;
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network down')));
    global.fetch = fetchSpy;

    try {
      renderAuditLog();
      await waitFor(() => expect(screen.getByText('Alice Admin')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: /Export CSV/i }));

      await waitFor(() => {
        expect(notifyError).toHaveBeenCalledWith('Failed to export CSV');
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
