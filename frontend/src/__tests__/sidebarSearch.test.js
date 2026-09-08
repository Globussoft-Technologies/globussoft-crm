import { describe, expect, it } from 'vitest';
import { filterSidebarPages } from '../utils/sidebarSearch';

describe('filterSidebarPages', () => {
  it('keeps only travel sidebar-visible pages and rewrites their labels', () => {
    const pages = [
      { path: '/leads', label: 'Travel Leads', description: 'Lead pipeline across all travel sub-brands' },
      { path: '/travel/leads', label: 'All Leads', description: 'Inbound + open leads' },
      { path: '/travel/inbound-leads', label: 'Inbound Leads', description: 'Webhook-ingested raw leads pre-conversion' },
      { path: '/travel/visa', label: 'Visa Dashboard', description: 'Visa Sure sub-brand overview' },
      { path: '/travel-stall', label: 'Travel Stall Dashboard', description: 'Travel Stall sub-brand overview' },
      { path: '/landing-pages', label: 'Landing Pages', description: 'Lead-capture landing pages' },
      { path: '/developer', label: 'Developer', description: 'API + webhook console' },
      { path: '/lead-routing', label: 'Routing Rules', description: 'Rules that auto-assign incoming leads' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'travelstall',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/leads', '/travel-stall', '/landing-pages', '/developer']);
    expect(filtered.find((page) => page.path === '/leads')?.label).toBe('Leads');
    expect(filtered.find((page) => page.path === '/travel-stall')?.label).toBe('Dashboard');
    expect(filtered.find((page) => page.path === '/developer')?.label).toBe('Developer');
    expect(filtered.some((page) => page.path === '/travel/leads')).toBe(false);
    expect(filtered.some((page) => page.path === '/travel/inbound-leads')).toBe(false);
    expect(filtered.some((page) => page.path === '/travel/visa')).toBe(false);
    expect(filtered.some((page) => page.path === '/lead-routing')).toBe(false);
  });

  it('keeps travel brand pages when the matching sub-brand is active', () => {
    const pages = [
      { path: '/travel/visa', label: 'Visa Dashboard', description: 'Visa Sure sub-brand overview' },
      { path: '/travel/visa/applications', label: 'Applications', description: 'Applicant tracker for Visa Sure' },
      { path: '/travel/trips', label: 'TMC Trips', description: 'School educational trip instances' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'visasure',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/travel/visa', '/travel/visa/applications']);
    expect(filtered.every((page) => page.path.startsWith('/travel/visa'))).toBe(true);
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

  it('hides TMC-only travel pages and Gmail from travel page search when TMC is active', () => {
    const pages = [
      { path: '/travel/web-checkins', label: 'Web Check-ins', description: 'Queue' },
      { path: '/travel/sightseeing', label: 'Sightseeing Master', description: 'POI catalog' },
      { path: '/travel/suppliers', label: 'Supplier credentials', description: 'Supplier vault' },
      { path: '/gmail', label: 'Gmail Sync', description: 'Gmail inbox integration' },
      { path: '/developer', label: 'Developer', description: 'API + webhook console' },
    ];

    const filtered = filterSidebarPages(pages, {
      vertical: 'travel',
      activeSubBrand: 'tmc',
    });

    expect(filtered.map((page) => page.path)).toEqual(['/developer']);
  });
});

