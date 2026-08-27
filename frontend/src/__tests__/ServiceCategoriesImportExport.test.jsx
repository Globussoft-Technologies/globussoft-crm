import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(() => Promise.resolve(true)),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

const FULL_PERMS = {
  isReady: true,
  hasPermission: () => true,
  permissions: ['services.read', 'services.write'],
  roles: [],
  isOwner: false,
  userType: null,
  isLoading: false,
  error: null,
  refresh: () => Promise.resolve(),
  hasAllPermissions: () => true,
  hasAnyPermission: () => true,
};
const usePermissionsMock = vi.fn(() => FULL_PERMS);
vi.mock('../hooks/usePermissions', () => ({
  usePermissions: (...args) => usePermissionsMock(...args),
}));

import ServiceCategories from '../pages/wellness/ServiceCategories';

const CATEGORIES = [
  {
    id: 401,
    name: 'Hair Restoration',
    parentId: null,
    displayOrder: 1,
    isActive: true,
    _count: { services: 7 },
  },
  {
    id: 402,
    name: 'PRP Therapy',
    parentId: 401,
    displayOrder: 2,
    isActive: true,
    _count: { services: 3 },
  },
];

function renderPage() {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || 'GET';
    if (url === '/api/wellness/service-categories' && method === 'GET') {
      return Promise.resolve(CATEGORIES);
    }
    return Promise.resolve({});
  });

  return render(
    <MemoryRouter>
      <ServiceCategories />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  usePermissionsMock.mockReset();
  usePermissionsMock.mockImplementation(() => FULL_PERMS);
});

describe('<ServiceCategories /> — import/export toolbar', () => {
  it('shows export and import controls for manage-capable users', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Export Service Categories/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import Service Categories/i })).toBeInTheDocument();
  });

  it('hides import/export and new-category controls for read-only users', async () => {
    usePermissionsMock.mockImplementation(() => ({
      ...FULL_PERMS,
      hasPermission: (module, action) => module === 'services' && action === 'read',
      permissions: ['services.read'],
    }));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('PRP Therapy')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /Export Service Categories/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Import Service Categories/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New category/i })).not.toBeInTheDocument();
  });
});
