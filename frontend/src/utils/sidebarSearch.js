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
  { path: '/travel/flights/quote', label: 'Flight Quick-quote' },
  { path: '/travel/quotes/builder', label: 'Quote Builder' },
  { path: '/travel/quote-templates', label: 'Quote Templates' },
  { path: '/travel/cancellation-policies', label: 'Cancellation Policies' },
  { path: '/travel/suppliers', label: 'Supplier Credentials' },
  { path: '/travel/religious-packets', label: 'Religious Packets', brand: 'rfu' },
  { path: '/travel/curriculum-mappings', label: 'Curriculum Mappings', brand: 'tmc' },
  { path: '/travel/school-terms', label: 'School Term Calendar', brand: 'tmc' },
  { path: '/travel/brochures', label: 'Brochure Engine' },
  { path: '/travel/forms', label: 'Web Forms', description: 'Embedded travel lead capture forms' },
  { path: '/landing-pages', label: 'Landing Pages' },
  { path: '/inbox', label: 'Inbox' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/calendar-sync', label: 'Calendar' },
  { path: '/gmail', label: 'Gmail' },
  { path: '/travel/invoices-admin', label: 'Invoices' },
  { path: '/travel/tally', label: 'Tally', description: 'Tally accounting, XML and CA exports' },
  { path: '/travel/milestones', label: 'Milestones' },
  { path: '/travel/payables', label: 'Payables' },
  { path: '/payments', label: 'Payments Received' },
  { path: '/expenses', label: 'Expense Management' },
  { path: '/staff', label: 'Staff' },
  { path: '/settings', label: 'Settings' },
  { path: '/settings/roles', label: 'Roles' },
  { path: '/audit-log', label: 'Audit Log' },
  { path: '/developer', label: 'Developer' },
  { path: '/privacy', label: 'Privacy' },
  { path: '/admin/brand-kits', label: 'Brand Kits' },
  { path: '/travel/visa/applications', label: 'Applications', brand: 'visasure' },
  { path: '/travel/visa/checklists', label: 'Checklists', brand: 'visasure' },
  { path: '/travel/visa/embassy-rules', label: 'Embassy Rules', brand: 'visasure' },
];

export const GENERIC_SIDEBAR_PAGE_SPECS = [
  { path: '/home', label: 'Home', description: 'Role-aware widget dashboard', hideForAdmin: true },
  { path: '/dashboard', label: 'Dashboard', description: 'Enterprise overview', requiredPermission: { module: 'reports', action: 'read' } },
  { path: '/inbox', label: 'Inbox', description: 'Unified inbox', requiredPermission: { module: 'communications', action: 'read' } },
  { path: '/contacts', label: 'Contacts', description: 'Contact directory', requiredPermission: { module: 'contacts', action: 'read' } },
  { path: '/pipeline', label: 'Pipeline', description: 'Deal pipeline by stage', requiredPermission: { module: 'pipeline', action: 'read' } },
  { path: '/leads', label: 'Leads', description: 'Inbound + open leads', requiredPermission: { module: 'leads', action: 'read' } },
  { path: '/converted-leads', label: 'Converted Leads', description: 'Leads that converted to customers', requiredPermission: { module: 'leads', action: 'read' } },
  { path: '/clients', label: 'Clients', description: 'Company and organization directory', requiredPermission: { module: 'contacts', action: 'read' } },
  { path: '/tasks', label: 'Task Queue', description: 'Task queue', requiredPermission: { module: 'tasks', action: 'read' } },
  { path: '/tickets', label: 'Tickets', description: 'Support ticket management' },
  { path: '/calendar-sync', label: 'Calendar Sync', description: 'Google and Outlook calendar integration', requiredPermission: { module: 'integrations', action: 'read' } },
  { path: '/live-chat', label: 'Live Chat', description: 'Website visitor chat support', requiredPermission: { module: 'live_chat', action: 'read' } },
  { path: '/deal-insights', label: 'Deal Insights', description: 'AI-powered deal analytics', requiredPermission: { module: 'deal_insights', action: 'read' } },
  { path: '/playbooks', label: 'Playbooks', description: 'Sales process workflows', requiredPermission: { module: 'playbooks', action: 'read' } },
  { path: '/booking-pages', label: 'Booking Pages', description: 'Customer booking form builder', requiredPermission: { module: 'booking_pages', action: 'read' } },
  { path: '/forms', label: 'Web Forms', description: 'Embedded lead capture forms', adminOnly: true },
  { path: '/landing-sites', label: 'Landing Sites', description: 'Sector-aware landing site builder', requiredPermission: { module: 'marketing', action: 'read' } },
  { path: '/signatures', label: 'E-Signatures', description: 'Signature request queue', requiredPermission: { module: 'signatures', action: 'read' } },
  { path: '/document-templates', label: 'Doc Templates', description: 'Email, SMS, and document templates', requiredPermission: { module: 'documents', action: 'read' } },
  { path: '/document-tracking', label: 'Doc Tracking', description: 'Track documents and signatures', requiredPermission: { module: 'documents', action: 'read' } },
  { path: '/invoices', label: 'Invoices', description: 'Invoice ledger + payment links', requiredPermission: { module: 'invoices', action: 'read' } },
  { path: '/estimates', label: 'Estimates', description: 'Quotes + estimates sent to customers', requiredPermission: { module: 'estimates', action: 'read' } },
  { path: '/expenses', label: 'Expenses', description: 'Team expense submissions', requiredPermission: { module: 'expenses', action: 'read' } },
  { path: '/contracts', label: 'Contracts', description: 'Contract lifecycle management', requiredPermission: { module: 'contracts', action: 'read' } },
  { path: '/projects', label: 'Projects', description: 'Project tracking + task boards', requiredPermission: { module: 'projects', action: 'read' } },
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
  { path: '/territories', label: 'Territories', description: 'Sales territory mapping', managerOnly: true, parent: 'Team & Territories' },
  { path: '/sales-teams', label: 'Sales Teams', description: 'Manage sales team membership and ownership', managerOnly: true, parent: 'Team & Territories' },
  { path: '/users', label: 'Users', description: 'Manage CRM users and access', managerOnly: true, parent: 'Team & Territories' },
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
  { path: '/revenue-goals', label: 'Revenue Goals', description: 'Revenue target configuration' },
  { path: '/channels', label: 'Channels', description: 'SMS, WhatsApp, and call channel config', adminOnly: true },
  { path: '/industry-templates', label: 'Industry Templates', description: 'Pre-built workflow templates', adminOnly: true },
  { path: '/sandbox', label: 'Sandbox', description: 'Testing + feature preview', adminOnly: true },
  { path: '/objects', label: 'App Builder', description: 'Create custom data models', adminOnly: true },
  { path: '/currencies', label: 'Currencies', description: 'Multi-currency configuration', adminOnly: true },
  { path: '/zapier', label: 'Zapier', description: 'Third-party automation hub', adminOnly: true },
  { path: '/developer', label: 'Developers', description: 'API + webhook console', adminOnly: true },
  { path: '/data-import-export', label: 'Import / Export', description: 'Bulk CSV operations', managerOnly: true },
  { path: '/settings', label: 'Settings', description: 'Tenant settings + integrations', adminOnly: true },
  { path: '/notification-settings', label: 'Notification Settings', description: 'Personal notification preferences', userOnly: true },
  { id: 'adsgpt', label: 'AdsGPT', description: 'Open the connected AdsGPT marketing workspace', managerOnly: true, actionTarget: '[data-tour-feature="adsgpt"]' },
  { id: 'callified', label: 'Callified', description: 'Open the connected Callified calling workspace', managerOnly: true, actionTarget: '[data-tour-feature="callified"]' },
  { path: '/whatsapp', label: 'WhatsApp', description: 'Manage tenant-scoped WhatsApp conversations', requiredPermission: { module: 'whatsapp', action: 'read' } },
  { path: '/lead-reports', label: 'Lead Reports', description: 'Review lead productivity, quality, sources, and follow-ups', managerOnly: true },
  { path: '/workflows', label: 'Workflows', description: 'Build trigger, condition, and action automations', requiredPermission: { module: 'workflows', action: 'read' } },
];

// Permission mapping for legacy generic search entries that historically only
// declared a role tier. This keeps global search consistent with the generic
// sidebar without changing wellness/travel search behavior.
const GENERIC_PAGE_PERMISSION_FALLBACK = {
  '/pipelines': ['pipeline', 'write'],
  '/forecasting': ['forecasting', 'read'],
  '/quotas': ['quotas', 'read'],
  '/win-loss': ['reports', 'read'],
  '/funnel': ['pipeline', 'read'],
  '/reports': ['reports', 'read'],
  '/agent-reports': ['reports', 'read'],
  '/dashboards': ['dashboards', 'read'],
  '/custom-reports': ['reports', 'read'],
  '/approvals': ['staff', 'manage'],
  '/lead-routing': ['leads', 'read'],
  '/lead-scoring': ['lead_scoring', 'read'],
  '/lead-reports': ['reports', 'read'],
  '/marketing': ['marketing', 'read'],
  '/sequences': ['sequences', 'read'],
  '/ab-tests': ['ab_tests', 'read'],
  '/web-visitors': ['analytics', 'read'],
  '/chatbots': ['chatbots', 'read'],
  '/social': ['social', 'read'],
  '/knowledge-base': ['knowledge_base', 'read'],
  '/surveys': ['surveys', 'read'],
  '/sla': ['sla', 'read'],
  '/payments': ['payments', 'read'],
  '/cpq': ['cpq', 'read'],
  '/data-import-export': ['settings', 'manage'],
};

// Keep consumers of the Generic navigation catalog independent from whether
// a future navigation entry is represented as a flat item or as a nested
// children/items/subItems collection. The sidebar and the tour both consume
// the same source; no DOM expansion state is involved.
export function flattenGenericNavigation(entries, parent = null) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { children, items, subItems, ...page } = entry;
    const current = page.path || page.id ? [{ ...page, parent }] : [];
    const nested = flattenGenericNavigation(
      [
        ...(Array.isArray(children) ? children : []),
        ...(Array.isArray(items) ? items : []),
        ...(Array.isArray(subItems) ? subItems : []),
      ],
      page.label || parent,
    );
    return [...current, ...nested];
  });
}

export const GENERIC_NAVIGATION_OPTIONS = flattenGenericNavigation(GENERIC_SIDEBAR_PAGE_SPECS);

// This allow-list intentionally mirrors renderTravelNav in Sidebar.jsx. It
// keeps hidden routes (such as the retired travel dashboards) out of global
// search while still letting the permission-filtered backend catalog supply
// the actual accessible entries and descriptions.

const GENERIC_PAGE_BY_PATH = new Map(
  GENERIC_NAVIGATION_OPTIONS.filter((page) => page.path).map((page) => [page.path, page]),
);

export function getGenericAccessByPath(path) {
  const page = GENERIC_PAGE_BY_PATH.get(path);
  if (!page) return null;
  const fallbackPermission = GENERIC_PAGE_PERMISSION_FALLBACK[path];
  return page.requiredPermission || !fallbackPermission
    ? page
    : {
        ...page,
        requiredPermission: {
          module: fallbackPermission[0],
          action: fallbackPermission[1],
        },
      };
}

export function getGenericAccessForLocation(pathname) {
  if (!pathname) return null;
  return GENERIC_NAVIGATION_OPTIONS
    .filter((page) => page.path && (pathname === page.path || pathname.startsWith(`${page.path}/`)))
    .sort((left, right) => right.path.length - left.path.length)[0] || null;
}

export function genericRoleGuardProps(path) {
  const access = getGenericAccessByPath(path);
  if (!access) return {};
  if (access.adminOnly) return { allow: ['ADMIN'] };
  if (access.managerOnly) return { allow: ['ADMIN', 'MANAGER'] };
  if (access.userOnly) return { allow: ['USER'] };
  if (access.requiredPermission) return { requiredPermission: access.requiredPermission };
  return {};
}
const TRAVEL_SIDEBAR_PAGE_MAP = new Map(
  TRAVEL_SIDEBAR_PAGE_SPECS.map((page) => [page.path, page]),
);

const TMC_HIDDEN_TRAVEL_PAGE_PATHS = new Set([
  '/travel/web-checkins',
  '/travel/sightseeing',
  '/travel/suppliers',
  '/travel/quotes-admin',
  '/travel/flights/quote',
  '/travel/quotes/builder',
  '/travel/quote-templates',
  '/gmail',
]);

export function canUseGenericSidebarPage(page, {
  isAdmin = false,
  isManager = false,
  permissionsReady = false,
  hasPermission = () => false,
} = {}) {
  if (page.adminOnly && !isAdmin) return false;
  if (page.managerOnly && !isManager) return false;
  if (page.hideForAdmin && isAdmin) return false;
  if (page.userOnly && (isAdmin || isManager)) return false;
  const fallbackPermission = page.path ? GENERIC_PAGE_PERMISSION_FALLBACK[page.path] : null;
  const requiredPermission = page.requiredPermission || (fallbackPermission
    ? { module: fallbackPermission[0], action: fallbackPermission[1] }
    : null);
  if (
    !page.managerOnly &&
    requiredPermission &&
    (permissionsReady && !hasPermission(requiredPermission.module, requiredPermission.action))
  ) {
    return false;
  }
  return true;
}

export function getGenericSidebarPages(options = {}) {
  return GENERIC_NAVIGATION_OPTIONS
    .filter((page) => canUseGenericSidebarPage(page, options))
    .map((page) => {
      const searchable = { ...page };
      delete searchable.requiredPermission;
      delete searchable.adminOnly;
      delete searchable.managerOnly;
      delete searchable.hideForAdmin;
      delete searchable.userOnly;
      return { ...searchable, category: searchable.category || 'Navigation' };
    });
}

export function mergePagesByPath(...pageLists) {
  const byPath = new Map();
  for (const list of pageLists) {
    if (!Array.isArray(list)) continue;
    for (const page of list) {
      const key = page?.path || (page?.actionTarget ? `action:${page.id}` : null);
      if (!key) continue;
      byPath.set(key, {
        ...(byPath.get(key) || {}),
        ...page,
      });
    }
  }
  return Array.from(byPath.values());
}

function normalizeSubBrandAccess(value) {
  if (value == null || value === '') return null;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed;
}

export function filterSidebarPages(
  pages,
  { vertical = null, activeSubBrand = null, subBrandAccess = null } = {},
) {
  if (!Array.isArray(pages)) return [];
  if (vertical !== 'travel') return pages.slice();

  const normalizedSubBrandAccess = normalizeSubBrandAccess(subBrandAccess);
  const filtered = [];
  for (const page of pages) {
    const spec = TRAVEL_SIDEBAR_PAGE_MAP.get(page?.path);
    if (!spec) continue;
    // Mirror the travel sidebar's conditional links. TMC has no web
    // check-ins, sightseeing, supplier credentials, quote-builder, or Gmail
    // entry. These remain searchable for other sub-brands and in All mode.
    if (activeSubBrand === 'tmc' && TMC_HIDDEN_TRAVEL_PAGE_PATHS.has(page?.path)) continue;
    // The sidebar also narrows brand-scoped entries by the user's granted
    // sub-brand access, even when the switcher is currently set to All.
    if (
      spec.brand &&
      normalizedSubBrandAccess &&
      !normalizedSubBrandAccess.includes(spec.brand)
    ) continue;
    if (spec.brand && activeSubBrand && spec.brand !== activeSubBrand) continue;
    filtered.push({
      ...page,
      label: spec.label,
    });
  }
  return filtered;
}
