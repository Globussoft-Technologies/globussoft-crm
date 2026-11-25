import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthContext } from '../appContexts';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = { error: vi.fn(), info: vi.fn(), success: vi.fn() };
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import AuditLog, { __clearEntityCacheForTests } from '../pages/AuditLog';

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

describe('<AuditLog /> — record ID name resolver', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    __clearEntityCacheForTests();
  });

  function mockOpenableRowWith({ entity, details, staffRows = null, staffShouldFail = false }) {
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({
          logs: [{
            id: 42,
            createdAt: new Date('2026-05-21T09:00:00.000Z').toISOString(),
            user: { id: 1, name: 'Admin', email: 'admin@x.test' },
            action: 'READ',
            entity,
            entityId: null,
            details: JSON.stringify(details),
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
    const row = await screen.findByRole('row', { name: /Viewed .* by Admin/ });
    fireEvent.click(row);
  }

  it('renders names alongside numeric IDs when the entity list resolves', async () => {
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
    expect(chips.textContent).toMatch(/#1(?!\d)/);
    expect(chips.textContent).toMatch(/#24(?!\d)/);
  });

  it('uses bare ID chips for unknown entities without making a lookup request', async () => {
    mockOpenableRowWith({ entity: 'MysteryThing', details: { recordIds: [5, 6] } });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    expect(chips.textContent).toMatch(/#5\b/);
    expect(chips.textContent).toMatch(/#6\b/);
    const lookupCalls = fetchApiMock.mock.calls.filter(([url]) =>
      url === '/api/staff' || url === '/api/wellness/patients' ||
      url === '/api/wellness/locations' || url === '/api/contacts'
    );
    expect(lookupCalls).toHaveLength(0);
  });

  it('falls back to the ID when a referenced entity is missing', async () => {
    mockOpenableRowWith({
      entity: 'User',
      details: { recordIds: [1, 999] },
      staffRows: [{ id: 1, name: 'Ganesh Sharma', email: 'g@x.test' }],
    });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    await waitFor(() => expect(chips.textContent).toMatch(/Ganesh Sharma/));
    expect(chips.textContent).toMatch(/#999\b/);
    expect(chips.textContent).not.toMatch(/undefined/);
  });

  it('keeps the details panel available when the resolver request fails', async () => {
    mockOpenableRowWith({
      entity: 'User',
      details: { recordIds: [42] },
      staffShouldFail: true,
    });
    renderAuditLog();
    await openOnlyRow();
    const chips = await screen.findByTestId('record-id-chips');
    await waitFor(() => expect(chips.textContent).toMatch(/#42\b/));
    expect(screen.getByText('What happened')).toBeInTheDocument();
  });

  it('does not reuse staff names after switching tenant and vertical', async () => {
    let currentStaffRows = [{ id: 1, name: 'Wellness Staff', email: 'wellness@example.test' }];
    fetchApiMock.mockImplementation((url) => {
      if (url.startsWith('/api/audit-viewer')) {
        return Promise.resolve({
          logs: [{
            id: 42,
            createdAt: '2026-05-21T09:00:00.000Z',
            user: { id: 1, name: 'Admin', email: 'admin@x.test' },
            action: 'READ',
            entity: 'User',
            entityId: null,
            details: JSON.stringify({ recordIds: [1] }),
          }],
          pages: 1,
          total: 1,
        });
      }
      if (url === '/api/staff') return Promise.resolve(currentStaffRows);
      return Promise.resolve([]);
    });

    const wellnessAuth = {
      user: { id: 1, tenantId: 1, role: 'ADMIN' },
      tenant: { id: 1, vertical: 'wellness' },
    };
    const view = renderAuditLog(wellnessAuth);
    await openOnlyRow();
    expect(await screen.findByText('Wellness Staff')).toBeInTheDocument();

    currentStaffRows = [{ id: 1, name: 'Travel Staff', email: 'travel@example.test' }];
    const travelAuth = {
      user: { id: 2, tenantId: 2, role: 'ADMIN' },
      tenant: { id: 2, vertical: 'travel' },
    };
    view.rerender(
      <AuthContext.Provider value={travelAuth}>
        <AuditLog />
      </AuthContext.Provider>,
    );

    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument());
    expect(screen.queryByText('Wellness Staff')).not.toBeInTheDocument();
    await openOnlyRow();
    expect(await screen.findByText('Travel Staff')).toBeInTheDocument();
    expect(screen.queryByText('Wellness Staff')).not.toBeInTheDocument();
    expect(fetchApiMock.mock.calls.filter(([url]) => url === '/api/staff')).toHaveLength(2);
  });
});
