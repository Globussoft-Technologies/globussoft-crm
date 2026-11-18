import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthContext } from '../appContexts';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({ fetchApi: (...args) => fetchApiMock(...args) }));
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: () => ({
    hasPermission: () => true,
    isLoading: false,
    isReady: true,
  }),
}));

import StaffPermissions from '../pages/StaffPermissions';

function permissionsResponse(vertical) {
  return {
    vertical,
    userType: 'STAFF',
    user: { name: 'Staff Member', email: 'staff@example.com', role: 'USER' },
    primaryRole: {
      key: 'USER',
      name: 'User',
      dataScope: 'ALL',
      ...(vertical === 'travel' ? { subBrandScope: [] } : {}),
    },
    roles: ['USER'],
    permissions: [],
  };
}

function permissionsPage(tenantId, vertical) {
  return render(
    <AuthContext.Provider value={{ tenant: { id: tenantId, vertical }, user: { tenantId } }}>
      <MemoryRouter initialEntries={['/staff/22/permissions']}>
        <Routes>
          <Route path="/staff/:userId/permissions" element={<StaffPermissions />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function renderPermissions(vertical, tenantId = 1) {
  fetchApiMock.mockResolvedValue(permissionsResponse(vertical));
  return permissionsPage(tenantId, vertical);
}

beforeEach(() => fetchApiMock.mockReset());

describe('StaffPermissions vertical-only metadata', () => {
  it.each(['generic', 'wellness'])('%s staff does not see travel sub-brand scope', async (vertical) => {
    renderPermissions(vertical);

    await waitFor(() => expect(screen.getByText('Staff Member — permissions')).toBeInTheDocument());
    expect(screen.queryByText('Sub-brand scope')).not.toBeInTheDocument();
    expect(screen.queryByText('All travel sub-brands')).not.toBeInTheDocument();
  });

  it('travel staff sees the sub-brand scope', async () => {
    renderPermissions('travel');

    await waitFor(() => expect(screen.getByText('Staff Member — permissions')).toBeInTheDocument());
    expect(screen.getByText('Sub-brand scope')).toBeInTheDocument();
    expect(screen.getByText('All travel sub-brands')).toBeInTheDocument();
  });

  it('clears travel permissions immediately when the active tenant changes', async () => {
    fetchApiMock.mockResolvedValueOnce(permissionsResponse('travel'));
    const view = permissionsPage(1, 'travel');
    await screen.findByText('All travel sub-brands');

    let resolveNextTenant;
    fetchApiMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveNextTenant = resolve;
    }));
    view.rerender(
      <AuthContext.Provider value={{ tenant: { id: 2, vertical: 'wellness' }, user: { tenantId: 2 } }}>
        <MemoryRouter initialEntries={['/staff/22/permissions']}>
          <Routes>
            <Route path="/staff/:userId/permissions" element={<StaffPermissions />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.queryByText('Sub-brand scope')).not.toBeInTheDocument();
    expect(screen.queryByText('All travel sub-brands')).not.toBeInTheDocument();
    expect(screen.queryByText('staff@example.com')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledTimes(2));

    resolveNextTenant(permissionsResponse('wellness'));
    await screen.findByText('staff@example.com');
    expect(screen.queryByText('Sub-brand scope')).not.toBeInTheDocument();
    expect(screen.queryByText('All travel sub-brands')).not.toBeInTheDocument();
  });
});
