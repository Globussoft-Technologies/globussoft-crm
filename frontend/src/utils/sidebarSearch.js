export const TRAVEL_SIDEBAR_PAGE_SPECS = [
  { path: '/travel', label: 'Dashboard' },
  { path: '/leads', label: 'Leads' },
  { path: '/travel/pipeline', label: 'Pipeline' },
  { path: '/contacts', label: 'Contacts' },
  { path: '/travel/diagnostics', label: 'Diagnostics' },
  { path: '/travel/itineraries', label: 'Itineraries' },
  { path: '/travel/pois/pending', label: 'POI Approvals' },
  { path: '/travel/trips', label: 'TMC Trips', brand: 'tmc' },
  { path: '/travel/tmc/catalogue', label: 'TMC Catalogue', brand: 'tmc' },
  { path: '/travel/web-checkins', label: 'Web Check-ins' },
  { path: '/travel/passport-verification', label: 'Passport' },
  { path: '/travel/cost-master', label: 'Cost Master' },
  { path: '/travel/sightseeing', label: 'Sightseeing Master' },
  { path: '/travel/itinerary-templates', label: 'Itinerary Templates' },
  { path: '/travel/pricing-rules', label: 'Pricing Rules' },
  { path: '/travel/reports', label: 'Reports' },
  { path: '/travel/reviews', label: 'Reviews' },
  { path: '/travel/suppliers-admin', label: 'Suppliers' },
  { path: '/travel/commission-profiles', label: 'Commission Profiles' },
  { path: '/travel/quotes-admin', label: 'Quotes' },
  { path: '/travel/flights/quote', label: 'Flight quick-quote' },
  { path: '/travel/quotes/builder', label: 'Quote Builder' },
  { path: '/travel/quote-templates', label: 'Quote Templates' },
  { path: '/travel/cancellation-policies', label: 'Cancellation Policies' },
  { path: '/travel/suppliers', label: 'Supplier credentials' },
  { path: '/travel/religious-packets', label: 'Religious Packets', brand: 'rfu' },
  { path: '/travel/curriculum-mappings', label: 'Curriculum Mappings', brand: 'tmc' },
  { path: '/travel/school-terms', label: 'School Term Calendar', brand: 'tmc' },
  { path: '/travel/brochures', label: 'Brochure Engine' },
  { path: '/landing-pages', label: 'Landing Pages' },
  { path: '/travel/whatsapp', label: 'WhatsApp' },
  { path: '/inbox', label: 'Inbox' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/calendar-sync', label: 'Calendar' },
  { path: '/gmail', label: 'Gmail' },
  { path: '/travel/invoices-admin', label: 'Invoices' },
  { path: '/travel/milestones', label: 'Milestones' },
  { path: '/travel/payables', label: 'Payables' },
  { path: '/payments', label: 'Payments received' },
  { path: '/expenses', label: 'Expense Management' },
  { path: '/staff', label: 'Staff' },
  { path: '/settings', label: 'Settings' },
  { path: '/settings/roles', label: 'Roles' },
  { path: '/audit-log', label: 'Audit Log' },
  { path: '/developer', label: 'Developer' },
  { path: '/privacy', label: 'Privacy' },
  { path: '/admin/brand-kits', label: 'Brand Kits' },
  { path: '/travel-stall', label: 'Dashboard', brand: 'travelstall' },
  { path: '/travel/visa', label: 'Dashboard', brand: 'visasure' },
  { path: '/travel/visa/applications', label: 'Applications', brand: 'visasure' },
  { path: '/travel/visa/checklists', label: 'Checklists', brand: 'visasure' },
  { path: '/travel/visa/embassy-rules', label: 'Embassy Rules', brand: 'visasure' },
];

const TRAVEL_SIDEBAR_PAGE_MAP = new Map(
  TRAVEL_SIDEBAR_PAGE_SPECS.map((page) => [page.path, page]),
);

export function filterSidebarPages(pages, { vertical = null, activeSubBrand = null } = {}) {
  if (!Array.isArray(pages)) return [];
  if (vertical !== 'travel') return pages.slice();

  const filtered = [];
  for (const page of pages) {
    const spec = TRAVEL_SIDEBAR_PAGE_MAP.get(page?.path);
    if (!spec) continue;
    if (spec.brand && activeSubBrand && spec.brand !== activeSubBrand) continue;
    filtered.push({
      ...page,
      label: spec.label,
    });
  }
  return filtered;
}

