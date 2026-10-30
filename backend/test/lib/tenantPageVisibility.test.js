import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const prisma = require('../../lib/prisma');
const visibility = require('../../lib/tenantPageVisibility');

const originalSettingFindUnique = prisma.tenantSetting.findUnique;
const originalTenantFindUnique = prisma.tenant.findUnique;

beforeEach(() => {
  visibility.clearTenantPageVisibilityCache(77);
  prisma.tenantSetting.findUnique = vi.fn().mockResolvedValue(null);
  prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'generic' });
});

afterEach(() => {
  prisma.tenantSetting.findUnique = originalSettingFindUnique;
  prisma.tenant.findUnique = originalTenantFindUnique;
  visibility.clearTenantPageVisibilityCache(77);
});

describe('tenant page visibility normalization', () => {
  it('keeps only valid vertical pages and never hides the safe /home fallback', () => {
    expect(visibility.normalizeHiddenPaths([
      '/wellness/patients',
      '/wellness/patients',
      '/home',
      '/travel/trips',
      '/not-a-page',
    ], 'wellness')).toEqual(['/wellness/patients']);
  });

  it('treats descendants as hidden when their parent page is disabled', () => {
    expect(visibility.isPathHidden('/travel/tally/company-setup', ['/travel/tally'])).toBe(true);
    expect(visibility.isPathHidden('/travel/tallying', ['/travel/tally'])).toBe(false);
  });

  it('exposes missing Generic pages and integration shortcuts only for Generic tenants', () => {
    const paths = ['/reports', '/pickup-work-assignments', '/integrations/adsgpt', '/integrations/callified'];
    expect(visibility.normalizeHiddenPaths(paths, 'generic')).toEqual([...paths].sort());
    for (const vertical of ['wellness', 'travel']) {
      const catalog = visibility.getTenantPageVisibilityCatalog(vertical);
      for (const path of paths) expect(catalog.some(page => page.path === path)).toBe(false);
    }
    const catalog = visibility.getTenantPageVisibilityCatalog('generic');
    for (const path of paths) expect(catalog.filter(page => page.path === path)).toHaveLength(1);
  });

  it('includes legacy generic sidebar routes in the visibility catalog', () => {
    expect(visibility.normalizeHiddenPaths([
      '/invoices',
      '/admin/status',
      '/pickup-inventory',
      '/wellness/patients',
    ], 'generic')).toEqual([
      '/admin/status',
      '/invoices',
      '/pickup-inventory',
    ]);
    expect(visibility.getTenantPageVisibilityCatalog('wellness')
      .some((page) => page.path === '/pickup-inventory')).toBe(false);
  });

  it('exposes only Generic sidebar controls, not mounted-but-hidden routes', () => {
    const paths = visibility.getTenantPageVisibilityCatalog('generic').map((page) => page.path);
    expect(paths).toContain('/contacts');
    expect(paths).toContain('/workflows');
    expect(paths).toContain('/integrations/adsgpt');
    expect(paths).toContain('/integrations/callified');
    for (const path of visibility.GENERIC_NON_SIDEBAR_PAGE_PATHS) {
      expect(paths, `${path} must not appear in Organization Page Visibility`).not.toContain(path);
    }
  });

  it('uses the exact Generic sidebar order, section, label and route presentation', () => {
    const catalog = visibility.getTenantPageVisibilityCatalog('generic');
    expect(catalog).toHaveLength(visibility.GENERIC_SIDEBAR_PRESENTATION.length);
    expect(new Set(catalog.map((page) => page.path)).size).toBe(catalog.length);
    expect(catalog.map(({ path, label, category }) => ({ path, label, category })))
      .toEqual(visibility.GENERIC_SIDEBAR_PRESENTATION);
    for (const path of ['/pipelines', '/win-loss', '/funnel']) {
      expect(visibility.GENERIC_SIDEBAR_PRESENTATION.some((page) => page.path === path)).toBe(false);
      expect(catalog.some((page) => page.path === path)).toBe(false);
    }
    expect(catalog.find((page) => page.path === '/dashboard')).toMatchObject({
      label: 'Dashboard',
      category: 'Core',
    });
    expect(catalog.find((page) => page.path === '/pipeline')).toMatchObject({
      label: 'Deals and Pipeline',
      category: 'Sales',
    });
    expect(catalog.find((page) => page.path === '/quotes')).toMatchObject({
      label: 'Quotes',
      category: 'Finance',
    });
    expect(catalog.find((page) => page.path === '/workflows')).toMatchObject({
      label: 'Workflows',
      category: 'Work Management',
      requiredPermissions: [{ module: 'workflows', action: 'read' }],
    });
  });

  it('includes the Generic CRM Quotes page in the Finance visibility catalog', () => {
    const genericPage = visibility.getTenantPageVisibilityCatalog('generic')
      .find((page) => page.path === '/quotes');
    expect(genericPage).toMatchObject({
      path: '/quotes',
      label: 'Quotes',
      category: 'Finance',
      vertical: 'generic',
      requiredPermissions: [{ module: 'quotes', action: 'read' }],
    });
    expect(visibility.getTenantPageVisibilityCatalog('wellness')
      .some((page) => page.path === '/quotes')).toBe(false);
    expect(visibility.getTenantPageVisibilityCatalog('travel')
      .some((page) => page.path === '/quotes')).toBe(false);
  });
});

describe('tenant page visibility resolution', () => {
  it('defaults to all pages enabled when no setting exists', async () => {
    const result = await visibility.getTenantPageVisibility(77, { vertical: 'generic' });
    expect(result.hiddenPaths).toEqual([]);
    expect(prisma.tenantSetting.findUnique).toHaveBeenCalledOnce();
  });

  it('parses hidden paths and filters page and permission catalogs', async () => {
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({
      value: JSON.stringify({ hiddenPaths: ['/wellness/patients'] }),
    });
    const result = await visibility.getTenantPageVisibility(77, { vertical: 'wellness' });
    expect(result.hiddenPaths).toEqual(['/wellness/patients']);

    const pages = visibility.filterPagesByTenantVisibility([
      { path: '/wellness/patients' },
      { path: '/wellness/calendar' },
    ], result);
    expect(pages.map((page) => page.path)).toEqual(['/wellness/calendar']);

    const catalog = visibility.filterPermissionCatalogForTenant(
      { patients: ['read'], calendar: ['read'] },
      'wellness',
      result.hiddenPaths,
    );
    expect(catalog.patients).toBeUndefined();
    expect(catalog.calendar).toEqual(['read']);
  });

  it('keeps a shared permission module when another page still uses it', () => {
    const catalog = visibility.filterPermissionCatalogForTenant(
      { marketing: ['read'] },
      'generic',
      ['/marketing'],
    );
    expect(catalog.marketing).toEqual(['read']);
  });

  it('removes permission modules owned by hidden legacy generic pages', () => {
    const catalog = visibility.filterPermissionCatalogForTenant(
      { invoices: ['read'], signatures: ['read'], settings: ['manage'] },
      'generic',
      ['/invoices'],
    );
    expect(catalog.invoices).toBeUndefined();
    expect(catalog.signatures).toEqual(['read']);
    expect(catalog.settings).toEqual(['manage']);
  });

  it('reports hidden permission modules separately for the role editor', () => {
    expect(visibility.getUnavailablePermissionModulesForTenant(
      { deal_insights: ['read'], reports: ['read'] },
      'generic',
      ['/deal-insights'],
    )).toEqual(['deal_insights']);
  });

  it('removes permission modules backed only by Generic routes hidden from the sidebar', () => {
    const catalog = visibility.filterPermissionCatalogForTenant(
      {
        estimates: ['read', 'write'],
        forecasting: ['read'],
        contacts: ['read'],
        payments: ['read'],
      },
      'generic',
      [],
    );

    expect(catalog.estimates).toBeUndefined();
    expect(catalog.forecasting).toBeUndefined();
    expect(catalog.contacts).toEqual(['read']);
    expect(catalog.payments).toEqual(['read']);
  });

  it('keeps Workflows permissions visible until Super Admin disables the page', () => {
    expect(visibility.filterPermissionCatalogForTenant(
      { workflows: ['read', 'write', 'update', 'delete', 'manage'] },
      'generic',
      [],
    ).workflows).toEqual(['read', 'write', 'update', 'delete', 'manage']);

    expect(visibility.filterPermissionCatalogForTenant(
      { workflows: ['read', 'write', 'update', 'delete', 'manage'] },
      'generic',
      ['/workflows'],
    ).workflows).toBeUndefined();
  });

  it('makes a permission unavailable only when every matching page is hidden', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: 'wellness' });
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({
      value: JSON.stringify({ hiddenPaths: ['/wellness/patients'] }),
    });
    await expect(visibility.isPermissionAvailableForTenant(77, 'patients', 'read')).resolves.toBe(false);
  });

  it.each(['generic', 'travel', 'wellness'])('preserves structured permission groups for %s', (vertical) => {
    const { getGroupedCatalogForVertical, getCatalogForVertical } = require('../../lib/permissionCatalog');
    const domains = getGroupedCatalogForVertical(vertical);
    expect(visibility.filterPermissionDomainsForTenant(domains, getCatalogForVertical(vertical))).toEqual(domains);
  });

  it('filters both string and structured modules without dropping enabled actions', () => {
    expect(visibility.filterPermissionDomainsForTenant([
      { domain: 'CRM', modules: ['contacts', { module: 'leads', actions: ['read'] }, { module: 'reports', actions: ['read'] }] },
    ], { contacts: ['read'], leads: ['read'] })).toEqual([
      { domain: 'CRM', modules: ['contacts', { module: 'leads', actions: ['read'] }] },
    ]);
  });

  it('blocks mutation actions when all pages of the module are hidden', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ vertical: 'wellness' });
    prisma.tenantSetting.findUnique.mockResolvedValueOnce({ value: JSON.stringify(['/wellness/patients']) });
    await expect(visibility.isPermissionAvailableForTenant(77, 'patients', 'update')).resolves.toBe(false);
    await expect(visibility.isPermissionAvailableForTenant(77, 'patients', 'delete')).resolves.toBe(false);
  });
});
