import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';

const requireCJS = createRequire(import.meta.url);

const auth = requireCJS('../../middleware/auth');
vi.spyOn(auth, 'verifyToken').mockImplementation((_req, _res, next) => next());

const tenantVertical = requireCJS('../../lib/tenantVertical');
const resolveTenantVertical = vi
  .spyOn(tenantVertical, 'resolveTenantVertical');

const permissionMiddleware = requireCJS('../../middleware/requirePermission');
const getUserPermissions = vi
  .spyOn(permissionMiddleware, 'getUserPermissions');

const pageCatalog = requireCJS('../../lib/pageCatalog');
vi.spyOn(pageCatalog, 'getCatalogForVertical');
vi.spyOn(pageCatalog, 'getAccessiblePages');

const tenantVisibility = requireCJS('../../lib/tenantPageVisibility');
vi.spyOn(tenantVisibility, 'getTenantPageVisibility');
vi.spyOn(tenantVisibility, 'filterPagesByTenantVisibility')
  .mockImplementation((pages, visibility) =>
    pages.filter((page) => !(visibility.hiddenPaths || []).includes(page.path)));
vi.spyOn(tenantVisibility, 'getAccessibleTenantSidebarPages');

const pagesRouter = requireCJS('../../routes/pages');

function makeApp({ isOwner = false } = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { userId: 7, tenantId: 11, role: 'USER', isOwner };
    next();
  });
  app.use('/api/pages', pagesRouter);
  return app;
}

describe('GET /api/pages/me - Wellness sidebar parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveTenantVertical.mockResolvedValue('wellness');
    getUserPermissions.mockResolvedValue(new Set(['wellness_patients.read']));
    tenantVisibility.getTenantPageVisibility.mockResolvedValue({
      vertical: 'wellness',
      hiddenPaths: [],
    });
    tenantVisibility.getAccessibleTenantSidebarPages.mockReturnValue([
      {
        path: '/wellness/patients',
        label: 'Patients',
        requiredPermissions: [{ module: 'wellness_patients', action: 'read' }],
      },
    ]);
  });

  it('uses only the Wellness sidebar catalog for a role-based user', async () => {
    const res = await request(makeApp()).get('/api/pages/me');

    expect(res.status).toBe(200);
    expect(res.body.pages.map((page) => page.path)).toEqual(['/wellness/patients']);
    expect(tenantVisibility.getAccessibleTenantSidebarPages).toHaveBeenCalledWith(
      'wellness',
      expect.any(Set),
    );
    expect(pageCatalog.getAccessiblePages).not.toHaveBeenCalled();
  });

  it('uses only the Wellness sidebar catalog for an owner', async () => {
    const res = await request(makeApp({ isOwner: true })).get('/api/pages/me');

    expect(res.status).toBe(200);
    expect(tenantVisibility.getAccessibleTenantSidebarPages).toHaveBeenCalledWith(
      'wellness',
      null,
      { isOwner: true },
    );
    expect(pageCatalog.getCatalogForVertical).not.toHaveBeenCalled();
  });

  it('keeps the existing non-Wellness accessible-page path unchanged', async () => {
    resolveTenantVertical.mockResolvedValue('travel');
    pageCatalog.getAccessiblePages.mockReturnValue([
      { path: '/travel', label: 'Dashboard', requiredPermissions: [] },
    ]);

    const res = await request(makeApp()).get('/api/pages/me');

    expect(res.status).toBe(200);
    expect(pageCatalog.getAccessiblePages).toHaveBeenCalledWith(
      expect.any(Set),
      { isOwner: false, vertical: 'travel' },
    );
    expect(tenantVisibility.getAccessibleTenantSidebarPages).not.toHaveBeenCalled();
  });
});
