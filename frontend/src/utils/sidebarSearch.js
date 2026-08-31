export const TRAVEL_SIDEBAR_PAGE_SPECS = [
  { path: '/travel', label: 'Dashboard' },
  { path: '/leads', label: 'Leads' },
  { path: '/travel/pipeline', label: 'Pipeline' },
  { path: '/contacts', label: 'Contacts' },
  { path: '/travel/diagnostics', label: 'Diagnostics' },
  { path: '/travel/trip-knowledge', label: 'Travel Knowledge', description: 'Travel knowledge base admin' },
  { path: '/travel/itineraries', label: 'Itineraries' },
  // { path: '/travel/pois/pending', label: 'POI Approvals' }, // hidden 2026-08-28 — preserved for future re-enable
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
  { path: '/inbox', label: 'Inbox' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/calendar-sync', label: 'Calendar' },
  { path: '/gmail', label: 'Gmail' },
  { path: '/travel/invoices-admin', label: 'Invoices' },
  { path: '/travel/tally', label: 'Tally', description: 'Tally accounting, XML and CA exports' },
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

export const GENERIC_SIDEBAR_PAGE_SPECS = [
  { path: '/home', label: 'Home', description: 'Role-aware widget dashboard', hideForAdmin: true },
  { path: '/dashboard', label: 'Dashboard', description: 'Enterprise overview' },
  { path: '/inbox', label: 'Inbox', description: 'Unified inbox' },
  { path: '/contacts', label: 'Contacts', description: 'Contact directory' },
  { path: '/pipeline', label: 'Pipeline', description: 'Deal pipeline by stage' },
  { path: '/leads', label: 'Leads', description: 'Inbound + open leads' },
  { path: '/converted-leads', label: 'Converted Leads', description: 'Leads that converted to customers' },
  { path: '/clients', label: 'Clients', description: 'Company and organization directory' },
  { path: '/tasks', label: 'Task Queue', description: 'Task queue' },
  { path: '/tickets', label: 'Tickets', description: 'Support ticket management' },
  { path: '/calendar-sync', label: 'Calendar Sync', description: 'Google and Outlook calendar integration' },
  { path: '/live-chat', label: 'Live Chat', description: 'Website visitor chat support' },
  { path: '/deal-insights', label: 'Deal Insights', description: 'AI-powered deal analytics' },
  { path: '/playbooks', label: 'Playbooks', description: 'Sales process workflows' },
  { path: '/booking-pages', label: 'Booking Pages', description: 'Customer booking form builder' },
  { path: '/forms', label: 'Web Forms', description: 'Embedded lead capture forms' },
  { path: '/landing-sites', label: 'Landing Sites', description: 'Sector-aware landing site builder' },
  { path: '/signatures', label: 'E-Signatures', description: 'Signature request queue' },
  { path: '/document-templates', label: 'Doc Templates', description: 'Email, SMS, and document templates' },
  { path: '/document-tracking', label: 'Doc Tracking', description: 'Track documents and signatures' },
  { path: '/invoices', label: 'Invoices', description: 'Invoice ledger + payment links', requiredPermission: { module: 'invoices', action: 'read' } },
  { path: '/estimates', label: 'Estimates', description: 'Quotes + estimates sent to customers', requiredPermission: { module: 'estimates', action: 'read' } },
  { path: '/expenses', label: 'Expenses', description: 'Team expense submissions', requiredPermission: { module: 'expenses', action: 'read' } },
  { path: '/contracts', label: 'Contracts', description: 'Contract lifecycle management', requiredPermission: { module: 'contracts', action: 'read' } },
  { path: '/projects', label: 'Projects', description: 'Project tracking + task boards' },
  { path: '/pipelines', label: 'Pipelines', description: 'Create and configure sales pipelines', managerOnly: true },
  { path: '/forecasting', label: 'Forecasting', description: 'Sales forecast modeling', managerOnly: true },
  { path: '/quotas', label: 'Quotas', description: 'Sales quota management', managerOnly: true },
  { path: '/win-loss', label: 'Win/Loss', description: 'Sales outcome analysis', managerOnly: true },
  { path: '/funnel', label: 'Funnel', description: 'Sales conversion funnel analytics', managerOnly: true },
  { path: '/reports', label: 'Reports', description: 'CRM reports', managerOnly: true },
  { path: '/agent-reports', label: 'Agent Reports', description: 'Staff performance analytics', managerOnly: true },
  { path: '/dashboards', label: 'Dashboards', description: 'Drag-and-drop dashboard builder', managerOnly: true },
  { path: '/custom-reports', label: 'Custom Reports', description: 'Build custom data reports', managerOnly: true },
  { path: '/approvals', label: 'Approvals', description: 'Pending approvals queue', managerOnly: true },
  { path: '/lead-routing', label: 'Lead Routing', description: 'Rules that auto-assign incoming leads', managerOnly: true },
  { path: '/territories', label: 'Territories', description: 'Sales territory mapping', managerOnly: true },
  { path: '/marketing', label: 'Marketing', description: 'One-shot marketing campaigns', managerOnly: true },
  { path: '/sequences', label: 'Sequences', description: 'Multi-step automated outreach', managerOnly: true },
  { path: '/ab-tests', label: 'A/B Tests', description: 'Marketing experiment builder', managerOnly: true },
  { path: '/web-visitors', label: 'Web Visitors', description: 'Website visitor tracking', managerOnly: true },
  { path: '/chatbots', label: 'Chatbots', description: 'Conversational AI builder', managerOnly: true },
  { path: '/social', label: 'Social Media', description: 'Social listening + posting', managerOnly: true },
  { path: '/knowledge-base', label: 'Knowledge Base', description: 'Internal + customer-facing knowledge articles', managerOnly: true },
  { path: '/surveys', label: 'Surveys', description: 'Survey campaigns + responses', managerOnly: true },
  { path: '/sla', label: 'SLA Policies', description: 'Service level agreement setup', managerOnly: true },
  { path: '/payments', label: 'Payments', description: 'Payment history + gateway transactions', managerOnly: true },
  { path: '/lead-scoring', label: 'Lead Scoring', description: 'Lead qualification engine', managerOnly: true },
  { path: '/cpq', label: 'CPQ', description: 'Configure price quote engine', managerOnly: true },
  { path: '/staff', label: 'Staff', description: 'Team management', adminOnly: true },
  { path: '/settings/roles', label: 'Roles', description: 'RBAC roles + permissions matrix', requiredPermission: { module: 'roles', action: 'read' } },
  { path: '/audit-log', label: 'Audit Log', description: 'Compliance audit trail', adminOnly: true },
  { path: '/privacy', label: 'Privacy', description: 'GDPR / DSAR retention controls', adminOnly: true },
  { path: '/field-permissions', label: 'Field Permissions', description: 'Field-level access control', adminOnly: true },
  { path: '/admin/csp-violations', label: 'CSP Violations', description: 'Content security policy logs', adminOnly: true },
  { path: '/admin/embed-allowlist', label: 'Embed Allowlist', description: 'iframe embed permissions', adminOnly: true },
  { path: '/admin/status', label: 'Status', description: 'Platform status admin', adminOnly: true },
  { path: '/commission-profiles', label: 'Commission Profiles', description: 'Commission rule configuration', adminOnly: true },
  { path: '/commission-data', label: 'Commission Data', description: 'Commission analytics', adminOnly: true },
  { path: '/revenue-goals', label: 'Revenue Goals', description: 'Revenue target configuration', adminOnly: true },
  { path: '/channels', label: 'Channels', description: 'SMS, WhatsApp, and call channel config', adminOnly: true },
  { path: '/industry-templates', label: 'Industry Templates', description: 'Pre-built workflow templates', adminOnly: true },
  { path: '/sandbox', label: 'Sandbox', description: 'Testing + feature preview', adminOnly: true },
  { path: '/objects', label: 'App Builder', description: 'Create custom data models', adminOnly: true },
  { path: '/currencies', label: 'Currencies', description: 'Multi-currency configuration', adminOnly: true },
  { path: '/zapier', label: 'Zapier', description: 'Third-party automation hub', adminOnly: true },
  { path: '/developer', label: 'Developers', description: 'API + webhook console', adminOnly: true },
  { path: '/data-import-export', label: 'Import / Export', description: 'Bulk CSV operations', adminOnly: true },
  { path: '/settings', label: 'Settings', description: 'Tenant settings + integrations', adminOnly: true },
  { path: '/notification-settings', label: 'Notification Settings', description: 'Personal notification preferences', userOnly: true },
];

const TRAVEL_SIDEBAR_PAGE_MAP = new Map(
  TRAVEL_SIDEBAR_PAGE_SPECS.map((page) => [page.path, page]),
);

function canUseGenericSidebarPage(page, {
  isAdmin = false,
  isManager = false,
  permissionsReady = false,
  hasPermission = () => false,
} = {}) {
  if (page.adminOnly && !isAdmin) return false;
  if (page.managerOnly && !isManager) return false;
  if (page.hideForAdmin && isAdmin) return false;
  if (page.userOnly && (isAdmin || isManager)) return false;
  if (
    page.requiredPermission &&
    (!permissionsReady || !hasPermission(page.requiredPermission.module, page.requiredPermission.action))
  ) {
    return false;
  }
  return true;
}

export function getGenericSidebarPages(options = {}) {
  return GENERIC_SIDEBAR_PAGE_SPECS
    .filter((page) => canUseGenericSidebarPage(page, options))
    .map(({ requiredPermission, adminOnly, managerOnly, hideForAdmin, userOnly, ...page }) => ({
      ...page,
      category: page.category || 'Navigation',
    }));
}

export function mergePagesByPath(...pageLists) {
  const byPath = new Map();
  for (const list of pageLists) {
    if (!Array.isArray(list)) continue;
    for (const page of list) {
      if (!page?.path) continue;
      byPath.set(page.path, {
        ...(byPath.get(page.path) || {}),
        ...page,
      });
    }
  }
  return Array.from(byPath.values());
}

export function filterSidebarPages(pages, { vertical = null, activeSubBrand = null } = {}) {
  if (!Array.isArray(pages)) return [];
  if (vertical !== 'travel') return pages.slice();

  const filtered = [];
  for (const page of pages) {
    const spec = TRAVEL_SIDEBAR_PAGE_MAP.get(page?.path);
    if (!spec) continue;
    // TMC does not use Web Check-ins, Sightseeing Master, Supplier
    // Credentials, or the Gmail page. Keep them searchable for the other
    // sub-brands and for the All (4) view, but hide them when TMC is active.
    if (
      activeSubBrand === 'tmc' &&
      (
        page?.path === '/travel/web-checkins' ||
        page?.path === '/travel/sightseeing' ||
        page?.path === '/travel/suppliers' ||
        page?.path === '/gmail'
      )
    ) continue;
    if (spec.brand && activeSubBrand && spec.brand !== activeSubBrand) continue;
    filtered.push({
      ...page,
      label: spec.label,
    });
  }
  return filtered;
}

