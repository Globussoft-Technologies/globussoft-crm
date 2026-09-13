import { describe, expect, it } from 'vitest';
import {
  filterSidebarPages,
  genericRoleGuardProps,
  getGenericAccessByPath,
  getGenericAccessForLocation,
  getGenericSidebarPages,
  TRAVEL_SIDEBAR_PAGE_SPECS,
} from '../utils/sidebarSearch';

describe('filterSidebarPages', () => {
  it('uses one access contract for routes, sidebar search, and tours', () => {
    expect(getGenericAccessByPath('/settings')).toMatchObject({ adminOnly: true });
    expect(genericRoleGuardProps('/settings')).toEqual({ allow: ['ADMIN'] });
    expect(genericRoleGuardProps('/data-import-export')).toEqual({ allow: ['ADMIN', 'MANAGER'] });
    expect(genericRoleGuardProps('/revenue-goals')).toEqual({});
    expect(getGenericAccessForLocation('/settings/lead-capture')?.path).toBe('/settings');
    expect(getGenericAccessForLocation('/settings/roles')?.path).toBe('/settings/roles');

    const regular = getGenericSidebarPages({ isAdmin: false, isManager: false });
    const manager = getGenericSidebarPages({ isAdmin: false, isManager: true });
    expect(regular.some((page) => page.path === '/revenue-goals')).toBe(true);
    expect(regular.some((page) => page.path === '/data-import-export')).toBe(false);
    expect(manager.some((page) => page.path === '/data-import-export')).toBe(true);
    expect(manager.some((page) => page.path === '/settings')).toBe(false);
  });

  it('includes navigable pages and external launchers in the searchable catalogue', () => {
    const manager = getGenericSidebarPages({ isAdmin: true, isManager: true, permissionsReady: true, hasPermission: () => true });
    expect(manager).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/whatsapp' }),
      expect.objectContaining({ path: '/lead-reports' }),
      expect.objectContaining({ path: '/workflows' }),
      expect.objectContaining({ id: 'adsgpt', actionTarget: '[data-tour-feature="adsgpt"]' }),
      expect.objectContaining({ id: 'callified', actionTarget: '[data-tour-feature="callified"]' }),
    ]));
  });

  it('keeps only travel sidebar-visible pages and rewrites their labels', () => {
    const pages = [
      { path: '/leads', label: 'Travel Leads', description: 'Lead pipeline across all travel sub-brands' },
      { path: '/travel/leads', label: 'All Leads', description: 'Inbound + open leads' },
      { path: '/travel/inbound-leads', label: 'Inbound Leads', description: 'Webhook-ingested raw leads pre-conversion' },
      { path: '/travel/visa', label: 'Visa Dashboard', description: 'Visa Sure sub-brand overview' },
      { path: '/travel-stall', label: 'Travel Stall Dashboard', description: 'Travel Stall sub-brand overview' },
      { path: '/travel/forms', label: 'Web Forms', description: 'Embedded travel lead capture forms' },
      { path: '/landing-pages', label: 'Landing Pages', description: 'Lead-capture landing pages' },
      { path: '/developer', label: 'Developer', description: 'API + webhook console' },
      { path: '/lead-routing', label: 'Routing Rules', description: 'Rules that auto-assign incoming leads' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'travelstall',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/leads', '/travel/forms', '/landing-pages', '/developer']);
    expect(filtered.find((page) => page.path === '/leads')?.label).toBe('Leads');
    expect(filtered.find((page) => page.path === '/travel/forms')?.label).toBe('Web Forms');
    expect(filtered.find((page) => page.path === '/developer')?.label).toBe('Developer');
    expect(filtered.some((page) => page.path === '/travel/leads')).toBe(false);
    expect(filtered.some((page) => page.path === '/travel/inbound-leads')).toBe(false);
    expect(filtered.some((page) => page.path === '/travel/visa')).toBe(false);
    expect(filtered.some((page) => page.path === '/travel-stall')).toBe(false);
    expect(filtered.some((page) => page.path === '/lead-routing')).toBe(false);
  });

  it('keeps travel brand pages when the matching sub-brand is active', () => {
    const pages = [
      { path: '/travel/visa', label: 'Visa Dashboard', description: 'Visa Sure sub-brand overview' },
      { path: '/travel/visa/applications', label: 'Applications', description: 'Applicant tracker for Visa Sure' },
      { path: '/travel/visa/checklists', label: 'Checklists', description: 'Applicant checklist' },
      { path: '/travel/visa/embassy-rules', label: 'Embassy Rules', description: 'Visa requirements' },
      { path: '/travel/trips', label: 'TMC Trips', description: 'School educational trip instances' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'visasure',
    });

    expect(filtered.map((page) => page.path)).toEqual([
      '/travel/visa/applications',
      '/travel/visa/checklists',
      '/travel/visa/embassy-rules',
    ]);
    expect(filtered.every((page) => page.path.startsWith('/travel/visa/'))).toBe(true);
  });

  it('keeps hidden travel WhatsApp Web page out of the filtered travel pages', () => {
    const pages = [
      { path: '/travel/whatsapp', label: 'WhatsApp', description: 'WhatsApp Web QR chat' },
      { path: '/developer', label: 'Developer', description: 'API + webhook console' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'travelstall',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/developer']);
  });

  it('hides non-TMC travel pages and Gmail from travel page search when TMC is active', () => {
    const pages = [
      { path: '/travel/web-checkins', label: 'Web Check-ins', description: 'Queue' },
      { path: '/travel/sightseeing', label: 'Sightseeing Master', description: 'POI catalog' },
      { path: '/travel/suppliers', label: 'Supplier credentials', description: 'Supplier vault' },
      { path: '/travel/quotes-admin', label: 'Quotes', description: 'Quote list' },
      { path: '/travel/flights/quote', label: 'Flight Quick-quote', description: 'Flight quote' },
      { path: '/travel/quotes/builder', label: 'Quote Builder', description: 'Quote builder' },
      { path: '/travel/quote-templates', label: 'Quote Templates', description: 'Quote templates' },
      { path: '/gmail', label: 'Gmail Sync', description: 'Gmail inbox integration' },
      { path: '/travel/forms', label: 'Web Forms', description: 'Travel forms' },
      { path: '/developer', label: 'Developer', description: 'API + webhook console' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'tmc',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/travel/forms', '/developer']);
  });

  it('mirrors granted sub-brand access while All is selected', () => {
    const pages = [
      { path: '/travel/trips', label: 'TMC Trips' },
      { path: '/travel/religious-packets', label: 'Religious Packets' },
      { path: '/travel/visa/applications', label: 'Applications' },
      { path: '/travel/forms', label: 'Web Forms' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      subBrandAccess: '["tmc"]',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/travel/trips', '/travel/forms']);
  });

  it('keeps the search catalog in sync with the current travel sidebar route inventory', () => {
    expect(TRAVEL_SIDEBAR_PAGE_SPECS.map((page) => page.path)).toEqual([
      '/travel',
      '/leads',
      '/travel/pipeline',
      '/contacts',
      '/travel/diagnostics',
      '/travel/trip-knowledge',
      '/travel/itineraries',
      '/travel/trips',
      '/travel/tmc/catalogue',
      '/travel/web-checkins',
      '/travel/passport-verification',
      '/travel/cost-master',
      '/travel/sightseeing',
      '/travel/itinerary-templates',
      '/travel/pricing-rules',
      '/travel/reports',
      '/travel/reviews',
      '/travel/suppliers-admin',
      '/travel/commission-profiles',
      '/travel/quotes-admin',
      '/travel/flights/quote',
      '/travel/quotes/builder',
      '/travel/quote-templates',
      '/travel/cancellation-policies',
      '/travel/suppliers',
      '/travel/religious-packets',
      '/travel/curriculum-mappings',
      '/travel/school-terms',
      '/travel/brochures',
      '/travel/forms',
      '/landing-pages',
      '/inbox',
      '/tasks',
      '/calendar-sync',
      '/gmail',
      '/travel/invoices-admin',
      '/travel/tally',
      '/travel/milestones',
      '/travel/payables',
      '/payments',
      '/expenses',
      '/staff',
      '/settings',
      '/settings/roles',
      '/audit-log',
      '/developer',
      '/privacy',
      '/admin/brand-kits',
      '/travel/visa/applications',
      '/travel/visa/checklists',
      '/travel/visa/embassy-rules',
    ]);
  });
});
