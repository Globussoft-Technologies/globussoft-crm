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
    for (const vertical of ['travel']) {
      const catalog = visibility.getTenantPageVisibilityCatalog(vertical);
      for (const path of paths) expect(catalog.some(page => page.path === path)).toBe(false);
    }
    const wellnessCatalog = visibility.getTenantPageVisibilityCatalog('wellness');
    expect(wellnessCatalog.some((page) => page.path === '/reports')).toBe(false);
    expect(wellnessCatalog.some((page) => page.path === '/pickup-work-assignments')).toBe(false);
    expect(wellnessCatalog.some((page) => page.path === '/integrations/adsgpt')).toBe(true);
    expect(wellnessCatalog.some((page) => page.path === '/integrations/callified')).toBe(true);
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
    expect(visibility.GENERIC_SIDEBAR_PRESENTATION.some((page) => page.path === '/pipelines')).toBe(true);
    expect(catalog.some((page) => page.path === '/pipelines')).toBe(true);
    for (const path of ['/win-loss', '/funnel']) {
      expect(visibility.GENERIC_SIDEBAR_PRESENTATION.some((page) => page.path === path)).toBe(false);
      expect(catalog.some((page) => page.path === path)).toBe(false);
    }
    expect(catalog.find((page) => page.path === '/dashboard')).toMatchObject({
      label: 'Dashboard',
      category: 'Core',
    });
    expect(catalog.find((page) => page.path === '/pipeline')).toMatchObject({
      label: 'Deals',
      category: 'Sales',
    });
    expect(catalog.find((page) => page.path === '/quotes')).toMatchObject({
      label: 'Quotes',
      category: 'Finance',
    });
    expect(catalog.find((page) => page.path === '/commissions')).toMatchObject({
      path: '/commissions',
      label: 'Commissions',
      category: 'Finance',
    });
    expect(catalog.find((page) => page.path === '/workflows')).toMatchObject({
      label: 'Workflows',
      category: 'Work Management',
      requiredPermissions: [{ module: 'workflows', action: 'read' }],
    });
    expect(catalog.find((page) => page.path === '/field-config')).toMatchObject({
      label: 'Field Config',
      category: 'Leads',
      requiredPermissions: [{ module: 'field_config', action: 'read' }],
    });
  });

  it('uses only the exact Travel sidebar order, section, label and route presentation', () => {
    const catalog = visibility.getTenantPageVisibilityCatalog('travel');
    expect(catalog).toHaveLength(visibility.TRAVEL_SIDEBAR_PRESENTATION.length);
    expect(catalog).toHaveLength(51);
    expect(new Set(catalog.map((page) => page.path)).size).toBe(51);
    expect(catalog.every((page) => Boolean(page.description))).toBe(true);
    expect(catalog.map(({ path, label, category }) => ({ path, label, category })))
      .toEqual(visibility.TRAVEL_SIDEBAR_PRESENTATION);
    expect(catalog.find((page) => page.path === '/travel')).toMatchObject({
      label: 'Dashboard',
      category: 'Core',
      requiredPermissions: [{ module: 'travel_dashboard', action: 'read' }],
    });
    expect(catalog.find((page) => page.path === '/travel/quotes/builder')).toMatchObject({
      label: 'Quote Builder',
      category: 'Sales',
      description: 'Build detailed customer travel quotations.',
      requiredPermissions: [{ module: 'quote_builder', action: 'write' }],
    });
    expect(catalog.find((page) => page.path === '/travel/email-automation')).toMatchObject({
      label: 'Email Automation',
      category: 'Marketing',
      requiredPermissions: [{ module: 'email_automation', action: 'read' }],
    });
    for (const path of ['/home', '/dashboard', '/pipeline', '/forecasting', '/quotas']) {
      expect(catalog.some((page) => page.path === path)).toBe(false);
    }
  });

  it('renders exactly one unique permission module for every Generic sidebar item', () => {
    const { getCatalogForVertical } = require('../../lib/permissionCatalog');
    const catalog = visibility.getTenantPageVisibilityCatalog('generic');
    const permissionCatalog = visibility.filterPermissionCatalogForTenant(
      getCatalogForVertical('generic'),
      'generic',
      [],
    );
    const modules = catalog.map((page) => page.requiredPermissions[0]?.module);

    expect(modules.every(Boolean)).toBe(true);
    expect(new Set(modules).size).toBe(catalog.length);
    expect(new Set(Object.keys(permissionCatalog))).toEqual(new Set(modules));
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

  it('includes the Generic CRM Commissions page in the Finance visibility catalog', () => {
    const genericPage = visibility.getTenantPageVisibilityCatalog('generic')
      .find((page) => page.path === '/commissions');
    expect(genericPage).toMatchObject({
      path: '/commissions',
      label: 'Commissions',
      category: 'Finance',
      requiredPermissions: [{ module: 'commissions', action: 'read' }],
    });
    expect(visibility.getTenantPageVisibilityCatalog('wellness')
      .some((page) => page.path === '/commissions')).toBe(false);
    expect(visibility.getTenantPageVisibilityCatalog('travel')
      .some((page) => page.path === '/commissions')).toBe(false);
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
      { wellness_patients: ['read'], wellness_calendar: ['read'] },
      'wellness',
      result.hiddenPaths,
    );
    expect(catalog.wellness_patients).toBeUndefined();
    expect(catalog.wellness_calendar).toEqual(['read']);
  });

  it('removes a page-specific module when its one sidebar page is hidden', () => {
    const catalog = visibility.filterPermissionCatalogForTenant(
      { marketing: ['read'] },
      'generic',
      ['/marketing'],
    );
    expect(catalog.marketing).toBeUndefined();
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

  it('hides the matching Generic permission card when Super Admin disables its page', () => {
    const catalog = visibility.filterPermissionCatalogForTenant(
      {
        billing_persons: ['read', 'write', 'update', 'delete', 'manage'],
        work_assignments: ['read', 'write', 'update', 'delete', 'manage'],
      },
      'generic',
      ['/billing-persons'],
    );

    expect(catalog.billing_persons).toBeUndefined();
    expect(catalog.work_assignments).toEqual(['read', 'write', 'update', 'delete', 'manage']);
    expect(visibility.getUnavailablePermissionModulesForTenant(
      {
        billing_persons: ['read'],
        work_assignments: ['read'],
      },
      'generic',
      ['/billing-persons'],
    )).toContain('billing_persons');
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

  it('hides non-sidebar capability cards from every page-oriented permission matrix', () => {
    const catalog = {
      contacts: ['read'],
      email: ['read'],
      sms: ['read'],
      accounting: ['read'],
      sequences: ['read'],
      documents: ['read'],
    };

    expect(visibility.filterPermissionCatalogForTenant(catalog, 'generic', []))
      .toEqual({ contacts: ['read'], sequences: ['read'] });
    expect(visibility.filterPermissionCatalogForTenant(catalog, 'wellness', []))
      .toEqual({});
    expect(visibility.filterPermissionCatalogForTenant(catalog, 'travel', []))
      .toEqual({ contacts: ['read'] });
  });

  it('renders exactly one Travel permission module for every Travel sidebar page', () => {
    const { getCatalogForVertical } = require('../../lib/permissionCatalog');
    const {
      TRAVEL_SIDEBAR_PERMISSION_SPECS,
      TRAVEL_SIDEBAR_PERMISSION_BY_PATH,
    } = require('../../lib/travelSidebarPermissions');
    const targetModules = TRAVEL_SIDEBAR_PERMISSION_SPECS.map(
      ([path]) => TRAVEL_SIDEBAR_PERMISSION_BY_PATH[path].module,
    );
    const filtered = visibility.filterPermissionCatalogForTenant(
      getCatalogForVertical('travel'),
      'travel',
      [],
    );

    expect(TRAVEL_SIDEBAR_PERMISSION_SPECS).toHaveLength(51);
    expect(new Set(targetModules).size).toBe(51);
    expect(new Set(Object.keys(filtered))).toEqual(new Set(targetModules));
  });

  it('renders exactly one Wellness permission module for every Wellness sidebar page', () => {
    const { getCatalogForVertical } = require('../../lib/permissionCatalog');
    const {
      WELLNESS_SIDEBAR_PERMISSION_SPECS,
      WELLNESS_SIDEBAR_PERMISSION_BY_PATH,
    } = require('../../lib/wellnessSidebarPermissions');
    const pages = visibility.getTenantPageVisibilityCatalog('wellness');
    const targetModules = WELLNESS_SIDEBAR_PERMISSION_SPECS.map(
      ([path]) => WELLNESS_SIDEBAR_PERMISSION_BY_PATH[path].module,
    );
    const filtered = visibility.filterPermissionCatalogForTenant(
      getCatalogForVertical('wellness'),
      'wellness',
      [],
    );

    expect(WELLNESS_SIDEBAR_PERMISSION_SPECS).toHaveLength(77);
    expect(pages).toHaveLength(77);
    expect(new Set(pages.map((page) => page.path)).size).toBe(77);
    expect(new Set(targetModules).size).toBe(77);
    expect(pages.some((page) => page.path === '/converted-leads')).toBe(false);
    expect(new Set(Object.keys(filtered))).toEqual(new Set(targetModules));
  });

  it('returns only permission-accessible Wellness sidebar pages for navigation search', () => {
    const permissions = new Set([
      'wellness_home.read',
      'wellness_patients.read',
      'wellness_notification_settings.read',
    ]);
    const pages = visibility.getAccessibleTenantSidebarPages(
      'wellness',
      permissions,
    );
    const paths = pages.map((page) => page.path);

    expect(paths).toContain('/home');
    expect(paths).toContain('/wellness/patients');
    expect(paths).toContain('/notification-settings');
    expect(paths).not.toContain('/dashboard');
    expect(paths).not.toContain('/pipeline');
    expect(paths).not.toContain('/contacts');
    expect(paths).not.toContain('/clients');
    expect(paths).not.toContain('/projects');
  });

  it('returns the exact Wellness sidebar catalog for an owner', () => {
    const pages = visibility.getAccessibleTenantSidebarPages(
      'wellness',
      null,
      { isOwner: true },
    );
    expect(pages).toEqual(visibility.getTenantPageVisibilityCatalog('wellness'));
    expect(pages).toHaveLength(77);
  });

  it('removes only the matching Wellness permission module when its page is hidden', () => {
    const { getCatalogForVertical } = require('../../lib/permissionCatalog');
    const filtered = visibility.filterPermissionCatalogForTenant(
      getCatalogForVertical('wellness'),
      'wellness',
      ['/wellness/service-categories'],
    );

    expect(filtered.wellness_service_categories).toBeUndefined();
    expect(filtered.wellness_services).toBeDefined();
    expect(filtered.wellness_memberships).toBeDefined();
  });

  it('removes only the matching Travel permission module when its page is hidden', () => {
    const { getCatalogForVertical } = require('../../lib/permissionCatalog');
    const filtered = visibility.filterPermissionCatalogForTenant(
      getCatalogForVertical('travel'),
      'travel',
      ['/travel/quotes/builder'],
    );

    expect(filtered.quote_builder).toBeUndefined();
    expect(filtered.quotes).toBeDefined();
    expect(filtered.quote_templates).toBeDefined();
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
