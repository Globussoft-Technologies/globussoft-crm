/**
 * Generic CRM sidebar -> permission-module contract.
 *
 * Every independently rendered Generic sidebar destination owns one module.
 * `legacyModule` is used only by the one-time RBAC compatibility backfill so
 * existing roles retain the same access after the split.
 *
 * External launchers use their tenant-visibility pseudo paths so they can be
 * controlled by the same one-card-per-sidebar-item contract as SPA pages.
 */
const GENERIC_SIDEBAR_PERMISSION_SPECS = [
  ['/home', 'home', null],
  ['/dashboard', 'dashboards', 'dashboards'],
  ['/integrations/adsgpt', 'adsgpt', 'integrations'],
  ['/integrations/callified', 'callified', 'integrations'],
  ['/contacts', 'contacts', 'contacts'],
  ['/pipeline', 'deals', 'pipeline'],
  ['/deal-insights', 'deal_insights', 'deal_insights'],
  ['/playbooks', 'playbooks', 'playbooks'],
  ['/pipelines', 'pipeline', 'pipeline'],
  ['/leads', 'leads', 'leads'],
  ['/lead-reports', 'lead_reports', 'reports'],
  ['/field-config', 'field_config', 'settings'],
  ['/inbox', 'inbox', 'communications'],
  ['/whatsapp', 'whatsapp', 'whatsapp'],
  ['/calendar-sync', 'calendar', 'calendar'],
  ['/live-chat', 'live_chat', 'live_chat'],
  ['/tasks', 'tasks', 'tasks'],
  ['/workflows', 'workflows', 'workflows'],
  ['/tickets', 'tickets', 'tickets'],
  ['/sla', 'sla', 'sla'],
  ['/forms', 'web_forms', 'web_forms'],
  ['/landing-sites', 'landing_sites', 'marketing'],
  ['/marketing', 'marketing', 'marketing'],
  ['/sequences', 'sequences', 'sequences'],
  ['/ab-tests', 'ab_tests', 'ab_tests'],
  ['/web-visitors', 'web_visitors', 'analytics'],
  ['/chatbots', 'chatbots', 'chatbots'],
  ['/social', 'social', 'social'],
  ['/signatures', 'signatures', 'signatures'],
  ['/document-templates', 'document_templates', 'document_templates'],
  ['/contracts', 'contracts', 'contracts'],
  ['/projects', 'projects', 'projects'],
  ['/invoices', 'invoices', 'invoices'],
  ['/expenses', 'expenses', 'expenses'],
  ['/payments', 'payments', 'payments'],
  ['/commissions', 'commissions', 'payments'],
  ['/quotes', 'quotes', 'quotes'],
  ['/reports', 'reports', 'reports'],
  ['/agent-reports', 'agent_reports', 'reports'],
  ['/revenue-goals', 'revenue_goals', 'reports'],
  ['/sales-teams', 'sales_teams', 'staff'],
  ['/staff', 'staff', 'staff'],
  ['/settings/roles', 'roles', 'roles'],
  ['/territories', 'territories', 'territories'],
  ['/pickup-plot-inventory', 'pickup_plot_inventory', 'staff'],
  ['/pickup-inventory', 'pickup_inventory', 'staff'],
  ['/pickup-customers', 'customer_workflows', 'billing_workspace'],
  ['/transport-persons', 'transport_persons', 'staff'],
  ['/plot-brokers', 'sales_executives', 'staff'],
  ['/billing-persons', 'billing_persons', 'staff'],
  ['/pickup-work-assignments', 'work_assignments', 'staff'],
  ['/transport-workspace', 'transport_workspace', 'transport_workspace'],
  ['/sales-workspace', 'site_visits', 'broker_workspace'],
  ['/audit-log', 'audit', 'audit'],
  ['/privacy', 'privacy', 'settings'],
  ['/admin/csp-violations', 'csp_violations', 'settings'],
  ['/admin/embed-allowlist', 'embed_allowlist', 'settings'],
  ['/admin/status', 'admin_status', 'settings'],
  ['/commission-profiles', 'commission_profiles', 'staff'],
  ['/commission-data', 'commission_data', 'payments'],
  ['/channels', 'channels', 'integrations'],
  ['/industry-templates', 'industry_templates', 'settings'],
  ['/currencies', 'currencies', 'settings'],
  ['/data-import-export', 'data_import_export', 'settings'],
  ['/sandbox', 'sandbox', 'sandbox'],
  ['/objects', 'custom_objects', 'custom_objects'],
  ['/zapier', 'zapier', 'integrations'],
  ['/developer', 'developer', 'developer'],
  ['/settings', 'settings', 'settings'],
  ['/notification-settings', 'notification_settings', null],
];

const GENERIC_SIDEBAR_PERMISSION_BY_PATH = Object.fromEntries(
  GENERIC_SIDEBAR_PERMISSION_SPECS.map(([path, module]) => [
    path,
    {
      module,
      action: path === '/pipelines' ? 'write'
        : path === '/staff' ? 'manage'
          : 'read',
    },
  ]),
);

const LEGACY_ACTION_OVERRIDES = {
  '/pipelines': 'write',
  '/field-config': 'manage',
  '/sales-teams': 'manage',
  '/staff': 'manage',
  '/pickup-plot-inventory': 'manage',
  '/pickup-inventory': 'manage',
  '/transport-persons': 'manage',
  '/plot-brokers': 'manage',
  '/billing-persons': 'manage',
  '/pickup-work-assignments': 'manage',
  '/privacy': 'manage',
  '/admin/csp-violations': 'manage',
  '/admin/embed-allowlist': 'manage',
  '/admin/status': 'manage',
  '/commission-profiles': 'manage',
  '/channels': 'manage',
  '/currencies': 'manage',
  '/data-import-export': 'manage',
};

const GENERIC_SIDEBAR_LEGACY_PERMISSION_BY_PATH = Object.fromEntries(
  GENERIC_SIDEBAR_PERMISSION_SPECS.map(([path, , legacyModule]) => [
    path,
    legacyModule
      ? { module: legacyModule, action: LEGACY_ACTION_OVERRIDES[path] || 'read' }
      : null,
  ]),
);

const GENERIC_SIDEBAR_LEGACY_MODULE_BY_MODULE = Object.fromEntries(
  GENERIC_SIDEBAR_PERMISSION_SPECS
    .filter(([, , legacyModule]) => Boolean(legacyModule))
    .map(([, module, legacyModule]) => [module, legacyModule]),
);

module.exports = {
  GENERIC_SIDEBAR_PERMISSION_SPECS,
  GENERIC_SIDEBAR_PERMISSION_BY_PATH,
  GENERIC_SIDEBAR_LEGACY_PERMISSION_BY_PATH,
  GENERIC_SIDEBAR_LEGACY_MODULE_BY_MODULE,
};
