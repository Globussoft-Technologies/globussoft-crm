export const TRAVEL_SIDEBAR_PAGE_SPECS = [
  { path: '/travel', label: 'Dashboard' },
  { path: '/leads', label: 'Leads' },
  // { path: '/travel/pipeline', label: 'Pipeline' },
  { path: '/contacts', label: 'Contacts' },
  { path: '/travel/diagnostics', label: 'Diagnostics' },
  { path: '/travel/trip-knowledge', label: 'Travel Knowledge', description: 'Travel knowledge base admin' },
  { path: '/travel/itineraries', label: 'Itineraries' },
  // { path: '/travel/pois/pending', label: 'POI Approvals' }, // hidden 2026-08-28 — preserved for future re-enable
  { path: '/travel/trips', label: 'TMC Trips', brand: 'tmc' },
  { path: '/travel/tmc/catalogue', label: 'TMC Catalogue', brand: 'tmc' },
  { path: '/travel/tmc/teachers', label: 'Teacher OnBoarding', description: 'Register and manage TMC teachers', brand: 'tmc' },
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
  { path: '/travel/email-automation', label: 'Email Automation' },
  { path: '/travel/brochures', label: 'Brochure Engine' },
  { path: '/travel/forms', label: 'Web Forms', description: 'Embedded travel lead capture forms' },
  { path: '/travel/meeting-forms', label: 'Meeting Forms', description: 'Appointment forms, Zoom meetings, embeds, and booking APIs' },
  { path: '/travel/email-automation', label: 'Email Automation', description: 'Travel email templates, event triggers, and delivery history' },
  { path: '/landing-pages', label: 'Landing Pages' },
  { path: '/inbox', label: 'Inbox' },
  { path: '/tasks', label: 'Tasks' },
  { path: '/calendar-sync', label: 'Calendar' },
  { path: '/gmail', label: 'Gmail' },
  { path: '/travel/invoices-admin', label: 'Invoices' },
  { path: '/travel/tally', label: 'Tally', description: 'Tally accounting, XML and CA exports' },
  // { path: '/travel/milestones', label: 'Milestones' },
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

export const TRAVEL_SIDEBAR_PERMISSION_BY_PATH = {
  '/travel': { module: 'travel_dashboard', action: 'read' },
  '/leads': { module: 'leads', action: 'read' },
  '/contacts': { module: 'contacts', action: 'read' },
  '/travel/diagnostics': { module: 'diagnostics', action: 'read' },
  '/travel/trip-knowledge': { module: 'travel_knowledge', action: 'write' },
  '/travel/itineraries': { module: 'itineraries', action: 'read' },
  '/travel/trips': { module: 'trips', action: 'read' },
  '/travel/tmc/catalogue': { module: 'tmc_catalogue', action: 'read' },
  '/travel/web-checkins': { module: 'web_checkins', action: 'read' },
  '/travel/passport-verification': { module: 'passport', action: 'manage' },
  '/travel/cost-master': { module: 'cost_master', action: 'read' },
  '/travel/sightseeing': { module: 'sightseeing', action: 'read' },
  '/travel/itinerary-templates': { module: 'itinerary_templates', action: 'read' },
  '/travel/pricing-rules': { module: 'pricing', action: 'manage' },
  '/travel/reports': { module: 'reports', action: 'read' },
  '/travel/reviews': { module: 'travel_reviews', action: 'read' },
  '/travel/suppliers-admin': { module: 'suppliers', action: 'read' },
  '/travel/commission-profiles': { module: 'commission_profiles', action: 'read' },
  '/travel/quotes-admin': { module: 'quotes', action: 'read' },
  '/travel/flights/quote': { module: 'flight_quotes', action: 'read' },
  '/travel/quotes/builder': { module: 'quote_builder', action: 'write' },
  '/travel/quote-templates': { module: 'quote_templates', action: 'read' },
  '/travel/cancellation-policies': { module: 'cancellation_policies', action: 'read' },
  '/travel/suppliers': { module: 'supplier_credentials', action: 'manage' },
  '/travel/religious-packets': { module: 'religious_packets', action: 'read' },
  '/travel/curriculum-mappings': { module: 'curriculum', action: 'read' },
  '/travel/school-terms': { module: 'school_terms', action: 'read' },
  '/travel/email-automation': { module: 'email_automation', action: 'read' },
  '/travel/brochures': { module: 'brochure_engine', action: 'read' },
  '/travel/forms': { module: 'travel_web_forms', action: 'read' },
  '/travel/meeting-forms': { module: 'meeting_forms', action: 'read' },
  '/landing-pages': { module: 'landing_pages', action: 'read' },
  '/inbox': { module: 'travel_inbox', action: 'read' },
  '/tasks': { module: 'tasks', action: 'read' },
  '/calendar-sync': { module: 'travel_calendar', action: 'read' },
  '/gmail': { module: 'gmail', action: 'read' },
  '/travel/invoices-admin': { module: 'invoices', action: 'read' },
  '/travel/tally': { module: 'tally', action: 'export' },
  '/travel/payables': { module: 'payables', action: 'read' },
  '/payments': { module: 'payments', action: 'read' },
  '/expenses': { module: 'expenses', action: 'read' },
  '/staff': { module: 'staff', action: 'read' },
  '/settings': { module: 'settings', action: 'read' },
  '/settings/roles': { module: 'roles', action: 'read' },
  '/audit-log': { module: 'audit', action: 'read' },
  '/developer': { module: 'developer', action: 'read' },
  '/privacy': { module: 'travel_privacy', action: 'manage' },
  '/admin/brand-kits': { module: 'brand_kits', action: 'manage' },
  '/travel/visa/applications': { module: 'visa_applications', action: 'read' },
  '/travel/visa/checklists': { module: 'visa_checklists', action: 'read' },
  '/travel/visa/embassy-rules': { module: 'embassy_rules', action: 'manage' },
};

export const TRAVEL_SIDEBAR_DESCRIPTION_BY_PATH = {
  '/travel': 'Travel sales, operations, and performance overview.',
  '/leads': 'Travel enquiries and prospects before conversion.',
  '/contacts': 'Traveller, customer, and partner contact directory.',
  '/travel/diagnostics': 'TMC readiness diagnostics, scoring, and results.',
  '/travel/trip-knowledge': 'Travel knowledge documents and operational guidance.',
  '/travel/itineraries': 'Customer itineraries and day-by-day trip plans.',
  '/travel/trips': 'TMC school-trip instances and participant operations.',
  '/travel/tmc/catalogue': 'TMC school-trip catalogue and package templates.',
  '/travel/web-checkins': 'Airline web check-in tracking and status.',
  '/travel/passport-verification': 'Passport OCR verification and approval queue.',
  '/travel/cost-master': 'Supplier cost catalogue for travel services.',
  '/travel/sightseeing': 'Sightseeing and attraction master catalogue.',
  '/travel/itinerary-templates': 'Reusable itinerary templates and trip structures.',
  '/travel/pricing-rules': 'Travel pricing, markup, and seasonal rules.',
  '/travel/reports': 'Travel sales and operational reports.',
  '/travel/reviews': 'Traveller feedback, ratings, and reviews.',
  '/travel/suppliers-admin': 'Supplier directory and supplier records.',
  '/travel/commission-profiles': 'Supplier commission rates and tiered profiles.',
  '/travel/quotes-admin': 'Travel quotations and proposal records.',
  '/travel/flights/quote': 'Flight quote requests and supplier responses.',
  '/travel/quotes/builder': 'Build detailed customer travel quotations.',
  '/travel/quote-templates': 'Reusable travel quote templates.',
  '/travel/cancellation-policies': 'Cancellation and refund policy configuration.',
  '/travel/suppliers': 'Supplier integration credentials and access settings.',
  '/travel/religious-packets': 'Religious travel packets and group bookings.',
  '/travel/curriculum-mappings': 'School-trip curriculum and learning-outcome mappings.',
  '/travel/school-terms': 'School terms, holidays, and academic calendar.',
  '/travel/email-automation': 'Travel email templates, delivery rules, and history.',
  '/travel/brochures': 'Create and manage travel brochures.',
  '/travel/forms': 'Embedded travel lead-capture forms.',
  '/travel/meeting-forms': 'Travel appointment, meeting, and booking forms.',
  '/landing-pages': 'Travel campaign landing pages and lead capture.',
  '/inbox': 'Unified Travel CRM customer communications inbox.',
  '/tasks': 'Travel follow-ups, reminders, and assigned tasks.',
  '/calendar-sync': 'Travel calendar and external calendar synchronization.',
  '/gmail': 'Connected Gmail mailbox for Travel CRM.',
  '/travel/invoices-admin': 'Travel customer invoices and payment links.',
  '/travel/tally': 'Travel accounting workspace and Tally exports.',
  '/travel/payables': 'Supplier payables, batches, and settlement tracking.',
  '/payments': 'Customer payments received and transaction history.',
  '/expenses': 'Travel expense submissions and reimbursement tracking.',
  '/staff': 'Travel staff accounts, assignments, and access.',
  '/settings': 'Travel CRM organization settings and configuration.',
  '/settings/roles': 'Travel roles and permission assignments.',
  '/audit-log': 'Travel CRM compliance and activity audit trail.',
  '/developer': 'Travel API keys, webhooks, and developer tools.',
  '/privacy': 'Travel data privacy, retention, and DSAR controls.',
  '/admin/brand-kits': 'Travel logos, colours, and brand assets.',
  '/travel/visa/applications': 'Visa applications and applicant case tracking.',
  '/travel/visa/checklists': 'Visa document checklists and completion tracking.',
  '/travel/visa/embassy-rules': 'Embassy requirements and country-specific visa rules.',
};

// People often search by what they want to do rather than by the exact menu
// label. Keep those terms scoped to Travel CRM so the generic and wellness
// search experiences are not changed.
const TRAVEL_PAGE_ALIASES = {
  '/travel': ['home', 'overview', 'travel dashboard'],
  '/leads': ['enquiries', 'prospects', 'customers'],
  '/travel/pipeline': ['sales pipeline', 'deals', 'stages'],
  '/contacts': ['travellers', 'customers', 'people'],
  '/travel/diagnostics': ['assessment', 'readiness'],
  '/travel/trip-knowledge': ['knowledge base', 'travel documents', 'drive'],
  '/travel/itineraries': ['trip planner', 'day by day', 'tour plan'],
  '/travel/trips': ['school trips', 'educational tours'],
  '/travel/tmc/catalogue': ['packages', 'school tour catalogue'],
  '/travel/tmc/teachers': ['teacher management', 'registered teachers', 'teacher portal', 'tmc teachers'],
  '/travel/web-checkins': ['airline check in', 'boarding pass'],
  '/travel/passport-verification': ['passport ocr', 'passport validation'],
  '/travel/cost-master': ['costing', 'rates', 'prices'],
  '/travel/sightseeing': ['attractions', 'points of interest', 'poi'],
  '/travel/itinerary-templates': ['trip templates', 'tour templates'],
  '/travel/pricing-rules': ['markup', 'margin', 'seasonal pricing'],
  '/travel/reports': ['analytics', 'insights'],
  '/travel/reviews': ['feedback', 'testimonials', 'ratings'],
  '/travel/suppliers-admin': ['vendors', 'supplier directory'],
  '/travel/commission-profiles': ['commissions', 'agent commission'],
  '/travel/quotes-admin': ['proposals', 'estimates', 'quotations'],
  '/travel/flights/quote': ['airfare', 'flight pricing'],
  '/travel/quotes/builder': ['create quote', 'quotation builder'],
  '/travel/quote-templates': ['proposal templates', 'quotation templates'],
  '/travel/cancellation-policies': ['refund policy', 'cancellation rules'],
  '/travel/suppliers': ['vendor credentials', 'supplier api keys'],
  '/travel/religious-packets': ['rfu', 'umrah', 'pilgrims'],
  '/travel/curriculum-mappings': ['learning outcomes', 'education mapping'],
  '/travel/school-terms': ['school holidays', 'academic calendar'],
  '/travel/brochures': ['brochure pdf', 'ai brochure'],
  '/travel/forms': ['lead capture', 'embed form', 'website form'],
  '/travel/meeting-forms': ['appointment', 'booking form', 'schedule meeting', 'zoom meeting', 'calendar booking'],
  '/travel/email-automation': ['email', 'automated emails', 'email templates', 'event triggers', 'delivery history'],
  '/landing-pages': ['campaign page', 'lead page'],
  '/inbox': ['email', 'messages', 'unified inbox'],
  '/tasks': ['follow ups', 'todo', 'reminders'],
  '/calendar-sync': ['appointments', 'google calendar', 'outlook calendar'],
  '/gmail': ['mail', 'google email'],
  '/travel/invoices-admin': ['billing', 'customer invoices'],
  '/travel/tally': ['accounting', 'xml export', 'ca export'],
  '/travel/milestones': ['payment schedule', 'instalments', 'installments'],
  '/travel/payables': ['supplier payments', 'accounts payable'],
  '/payments': ['receipts', 'transactions', 'collections'],
  '/expenses': ['spending', 'cost claims'],
  '/staff': ['users', 'team', 'employees'],
  '/settings': ['integrations', 'sendgrid', 'zoom setup', 'crm settings'],
  '/settings/roles': ['permissions', 'rbac', 'access control'],
  '/audit-log': ['activity history', 'compliance log'],
  '/developer': ['api', 'webhooks', 'developer console'],
  '/privacy': ['gdpr', 'dsar', 'data retention'],
  '/admin/brand-kits': ['logos', 'colours', 'colors', 'branding'],
  '/travel/visa/applications': ['visa applicants', 'visa cases'],
  '/travel/visa/checklists': ['visa documents', 'document checklist'],
  '/travel/visa/embassy-rules': ['visa requirements', 'country rules'],
};

export const GENERIC_SIDEBAR_PERMISSION_BY_PATH = {
  '/home': { module: 'home', action: 'read' },
  '/dashboard': { module: 'dashboards', action: 'read' },
  '/integrations/adsgpt': { module: 'adsgpt', action: 'read' },
  '/integrations/callified': { module: 'callified', action: 'read' },
  '/contacts': { module: 'contacts', action: 'read' },
  '/pipeline': { module: 'deals', action: 'read' },
  '/deal-insights': { module: 'deal_insights', action: 'read' },
  '/playbooks': { module: 'playbooks', action: 'read' },
  '/pipelines': { module: 'pipeline', action: 'write' },
  '/leads': { module: 'leads', action: 'read' },
  '/lead-reports': { module: 'lead_reports', action: 'read' },
  '/field-config': { module: 'field_config', action: 'read' },
  '/inbox': { module: 'inbox', action: 'read' },
  '/whatsapp': { module: 'whatsapp', action: 'read' },
  '/calendar-sync': { module: 'calendar', action: 'read' },
  '/live-chat': { module: 'live_chat', action: 'read' },
  '/tasks': { module: 'tasks', action: 'read' },
  '/workflows': { module: 'workflows', action: 'read' },
  '/tickets': { module: 'tickets', action: 'read' },
  '/sla': { module: 'sla', action: 'read' },
  '/forms': { module: 'web_forms', action: 'read' },
  '/landing-sites': { module: 'landing_sites', action: 'read' },
  '/marketing': { module: 'marketing', action: 'read' },
  '/sequences': { module: 'sequences', action: 'read' },
  '/ab-tests': { module: 'ab_tests', action: 'read' },
  '/web-visitors': { module: 'web_visitors', action: 'read' },
  '/chatbots': { module: 'chatbots', action: 'read' },
  '/social': { module: 'social', action: 'read' },
  '/signatures': { module: 'signatures', action: 'read' },
  '/document-templates': { module: 'document_templates', action: 'read' },
  '/contracts': { module: 'contracts', action: 'read' },
  '/projects': { module: 'projects', action: 'read' },
  '/invoices': { module: 'invoices', action: 'read' },
  '/expenses': { module: 'expenses', action: 'read' },
  '/payments': { module: 'payments', action: 'read' },
  '/commissions': { module: 'commissions', action: 'read' },
  '/quotes': { module: 'quotes', action: 'read' },
  '/reports': { module: 'reports', action: 'read' },
  '/agent-reports': { module: 'agent_reports', action: 'read' },
  '/revenue-goals': { module: 'revenue_goals', action: 'read' },
  '/sales-teams': { module: 'sales_teams', action: 'read' },
  '/staff': { module: 'staff', action: 'manage' },
  '/settings/roles': { module: 'roles', action: 'read' },
  '/territories': { module: 'territories', action: 'read' },
  '/pickup-plot-inventory': { module: 'pickup_plot_inventory', action: 'read' },
  '/pickup-inventory': { module: 'pickup_inventory', action: 'read' },
  '/pickup-customers': { module: 'customer_workflows', action: 'read' },
  '/transport-persons': { module: 'transport_persons', action: 'read' },
  '/plot-brokers': { module: 'sales_executives', action: 'read' },
  '/billing-persons': { module: 'billing_persons', action: 'read' },
  '/pickup-work-assignments': { module: 'work_assignments', action: 'read' },
  '/transport-workspace': { module: 'transport_workspace', action: 'read' },
  '/sales-workspace': { module: 'site_visits', action: 'read' },
  '/audit-log': { module: 'audit', action: 'read' },
  '/privacy': { module: 'privacy', action: 'read' },
  '/admin/csp-violations': { module: 'csp_violations', action: 'read' },
  '/admin/embed-allowlist': { module: 'embed_allowlist', action: 'read' },
  '/admin/status': { module: 'admin_status', action: 'read' },
  '/commission-profiles': { module: 'commission_profiles', action: 'read' },
  '/commission-data': { module: 'commission_data', action: 'read' },
  '/channels': { module: 'channels', action: 'read' },
  '/industry-templates': { module: 'industry_templates', action: 'read' },
  '/currencies': { module: 'currencies', action: 'read' },
  '/data-import-export': { module: 'data_import_export', action: 'read' },
  '/sandbox': { module: 'sandbox', action: 'read' },
  '/objects': { module: 'custom_objects', action: 'read' },
  '/zapier': { module: 'zapier', action: 'read' },
  '/developer': { module: 'developer', action: 'read' },
  '/settings': { module: 'settings', action: 'read' },
  '/notification-settings': { module: 'notification_settings', action: 'read' },
};

const GENERIC_SIDEBAR_PAGE_SPECS_BASE = [
  { path: '/home', label: 'Home', description: 'Role-aware widget dashboard', hideForAdmin: true },
  { path: '/dashboard', label: 'Dashboard', description: 'Enterprise overview', requiredPermission: { module: 'dashboards', action: 'read' } },
  { path: '/inbox', label: 'Inbox', description: 'Unified inbox', requiredPermission: { module: 'communications', action: 'read' } },
  // Generic CRM: Contacts is intentionally hidden from navigation/search.
  // Keep the access metadata active so direct routes retain their RBAC guard.
  { path: '/contacts', label: 'Contacts', description: 'Contact directory', requiredPermission: { module: 'contacts', action: 'read' }, sidebarHidden: true },
  { path: '/pipeline', label: 'Deals', description: 'Manage deals by deal type and stage', searchPath: false, requiredPermission: { module: 'deals', action: 'read' } },
  { path: '/pipelines', label: 'Pipelines', description: 'Configure sales pipelines and stages', managerOnly: true, requiredPermission: { module: 'pipeline', action: 'write' } },
  { path: '/leads', label: 'Leads', description: 'Inbound + open leads', requiredPermission: { module: 'leads', action: 'read' } },
  { path: '/converted-leads', label: 'Converted Leads', description: 'Leads that converted to customers', requiredPermission: { module: 'leads', action: 'read' }, sidebarHidden: true },
  { path: '/clients', label: 'Clients', description: 'Company and organization directory', requiredPermission: { module: 'contacts', action: 'read' }, sidebarHidden: true },
  { path: '/tasks', label: 'Task Queue', description: 'Task queue', requiredPermission: { module: 'tasks', action: 'read' } },
  { path: '/transport-workspace', label: 'Transport Work', description: 'Assigned customer pickup and drop-off trips', requiredPermission: { module: 'transport_workspace', action: 'read' } },
  { path: '/sales-workspace', label: 'Site Visits', description: 'Assigned customer site visits and plot selection', requiredPermission: { module: 'broker_workspace', action: 'read' } },
  { path: '/tickets', label: 'Tickets', description: 'Support ticket management', requiredPermission: { module: 'tickets', action: 'read' } },
  { path: '/calendar-sync', label: 'Calendar Sync', description: 'Google and Outlook calendar integration', requiredPermission: { module: 'calendar', action: 'read' } },
  { path: '/live-chat', label: 'Live Chat', description: 'Website visitor chat support', requiredPermission: { module: 'live_chat', action: 'read' } },
  { path: '/deal-insights', label: 'Deal Insights', description: 'AI-powered deal analytics', requiredPermission: { module: 'deal_insights', action: 'read' } },
  { path: '/playbooks', label: 'Playbooks', description: 'Sales process workflows', requiredPermission: { module: 'playbooks', action: 'read' }, sidebarHidden: true },
  { path: '/booking-pages', label: 'Booking Pages', description: 'Customer booking form builder', requiredPermission: { module: 'booking_pages', action: 'read' }, sidebarHidden: true },
  { path: '/forms', label: 'Web Forms', description: 'Embedded lead capture forms', requiredPermission: { module: 'web_forms', action: 'read' } },
  { path: '/landing-sites', label: 'Landing Sites', description: 'Sector-aware landing site builder', requiredPermission: { module: 'marketing', action: 'read' } },
  { path: '/signatures', label: 'E-Signatures', description: 'Signature request queue', requiredPermission: { module: 'signatures', action: 'read' }, sidebarHidden: true },
  { path: '/document-templates', label: 'Doc Templates', description: 'Email, SMS, and document templates', aliases: ['templates', 'email templates', 'document templates'], requiredPermission: { module: 'document_templates', action: 'read' }, sidebarHidden: true },
  { path: '/invoices', label: 'Invoices', description: 'Invoice ledger + payment links', requiredPermission: { module: 'invoices', action: 'read' } },
  // Generic CRM: Estimates is intentionally removed from search/navigation.
  // { path: '/estimates', label: 'Estimates', description: 'Quotes + estimates sent to customers', requiredPermission: { module: 'estimates', action: 'read' } },
  { path: '/quotes', label: 'Quotes', description: 'Build and manage customer quotes with GST line items', requiredPermission: { module: 'quotes', action: 'read' } },
  { path: '/expenses', label: 'Expenses', description: 'Team expense submissions', requiredPermission: { module: 'expenses', action: 'read' } },
  { path: '/contracts', label: 'Contracts', description: 'Contract lifecycle management', requiredPermission: { module: 'contracts', action: 'read' }, sidebarHidden: true },
  { path: '/projects', label: 'Projects', description: 'Project tracking + task boards', requiredPermission: { module: 'projects', action: 'read' }, sidebarHidden: true },
  { path: '/forecasting', label: 'Forecasting', description: 'Sales forecast modeling', managerOnly: true, sidebarHidden: true },
  { path: '/quotas', label: 'Quotas', description: 'Sales quota management', managerOnly: true, sidebarHidden: true },
  { path: '/reports', label: 'Reports', description: 'CRM reports', managerOnly: true },
  { path: '/agent-reports', label: 'Agent Reports', description: 'Staff performance analytics', managerOnly: true },
  { path: '/dashboards', label: 'Dashboards', description: 'Drag-and-drop dashboard builder', managerOnly: true, sidebarHidden: true },
  { path: '/custom-reports', label: 'Custom Reports', description: 'Build custom data reports', managerOnly: true, sidebarHidden: true },
  { path: '/approvals', label: 'Approvals', description: 'Pending approvals queue', managerOnly: true, sidebarHidden: true },
  // Generic CRM: Lead Routing is intentionally removed from search/navigation.
  // { path: '/lead-routing', label: 'Lead Routing', description: 'Rules that auto-assign incoming leads', managerOnly: true },
  { path: '/territories', label: 'Territories', description: 'Sales territory mapping', managerOnly: true, requiredPermission: { module: 'territories', action: 'read' }, parent: 'Team & Territories' },
  { path: '/sales-teams', label: 'Teams', description: 'Manage sales team membership and ownership', managerOnly: true, requiredPermission: { module: 'staff', action: 'manage' }, parent: 'Team & Territories' },
  { path: '/marketing', label: 'Marketing Sequences', description: 'Email, SMS, WhatsApp, template, and webhook sequences', aliases: ['sequence', 'sequences', 'email sequences', 'sms sequences', 'whatsapp sequences', 'templates', 'webhooks'], managerOnly: true },
  // Generic CRM: legacy Sequences stays routable but is hidden from navigation/search.
  { path: '/sequences', label: 'Sequences', description: 'Multi-step automated outreach', managerOnly: true, sidebarHidden: true },
  { path: '/ab-tests', label: 'A/B Tests', description: 'Marketing experiment builder', managerOnly: true, sidebarHidden: true },
  // Generic CRM: Web Visitors stays routable but is hidden from navigation/search.
  { path: '/web-visitors', label: 'Web Visitors', description: 'Website visitor tracking', managerOnly: true, sidebarHidden: true },
  { path: '/chatbots', label: 'Chatbots', description: 'Conversational AI builder', managerOnly: true, sidebarHidden: true },
  { path: '/social', label: 'Social Media', description: 'Social listening + posting', managerOnly: true, sidebarHidden: true },
  { path: '/knowledge-base', label: 'Knowledge Base', description: 'Internal + customer-facing knowledge articles', managerOnly: true, sidebarHidden: true },
  { path: '/surveys', label: 'Surveys', description: 'Survey campaigns + responses', managerOnly: true, sidebarHidden: true },
  { path: '/sla', label: 'SLA Policies', description: 'Service level agreement setup', managerOnly: true, sidebarHidden: true },
  { path: '/payments', label: 'Payments', description: 'Payment history + gateway transactions', managerOnly: true },
  { path: '/commissions', label: 'Commissions', description: 'Plot commissions, collection thresholds, and payout workflows', aliases: ['commission', 'payouts', 'plot payouts', 'deposit distribution'], managerOnly: true },
  { path: '/lead-scoring', label: 'Lead Scoring', description: 'Lead qualification engine', managerOnly: true, sidebarHidden: true },
  { path: '/staff', label: 'Staff', description: 'Team management', adminOnly: true, requiredPermission: { module: 'staff', action: 'manage' } },
  { path: '/settings/roles', label: 'Roles', description: 'RBAC roles + permissions matrix', requiredPermission: { module: 'roles', action: 'read' } },
  { path: '/audit-log', label: 'Audit Log', description: 'Compliance audit trail', adminOnly: true, requiredPermission: { module: 'audit', action: 'read' } },
  { path: '/pickup-plot-inventory', label: 'Pickup & Plot Inventory', description: 'Manage pickup locations and available plots or sites', adminOnly: true },
  { path: '/pickup-inventory', label: 'Pickup Inventory', description: 'View pickup-address capacity, assignments, dates, and map locations', adminOnly: true },
  { path: '/transport-persons', label: 'Transport Persons', description: 'Manage drivers, vehicles, and pickup-location assignments', adminOnly: true },
  { path: '/plot-brokers', label: 'Sales Executives', description: 'Manage sales executive contacts, commissions, site visits, and plot assignments', adminOnly: true },
  { path: '/billing-persons', label: 'Billing Persons', description: 'Manage billing staff, customers, and plot assignments', adminOnly: true },
  { path: '/pickup-customers', label: 'Customer Workflows', description: 'Track pickup and plot workflows including converted customers', requiredPermission: { module: 'billing_workspace', action: 'read' } },
  { path: '/pickup-work-assignments', label: 'Assign Staff Work', description: 'Assign Transport, Site Visit, and Billing work to any staff member', adminOnly: true },
  { path: '/privacy', label: 'Privacy', description: 'GDPR / DSAR retention controls', adminOnly: true, requiredPermission: { module: 'settings', action: 'manage' } },
  { path: '/field-permissions', label: 'Field Permissions', description: 'Field-level access control', adminOnly: true, requiredPermission: { module: 'field_permissions', action: 'read' }, sidebarHidden: true },
  { path: '/admin/csp-violations', label: 'CSP Violations', description: 'Content security policy logs', adminOnly: true, requiredPermission: { module: 'settings', action: 'manage' }, sidebarHidden: true },
  { path: '/admin/embed-allowlist', label: 'Embed Allowlist', description: 'iframe embed permissions', adminOnly: true, requiredPermission: { module: 'settings', action: 'manage' } },
  { path: '/admin/status', label: 'Status', description: 'Platform status admin', adminOnly: true, sidebarHidden: true },
  { path: '/commission-profiles', label: 'Commission Profiles', description: 'Commission rule configuration', adminOnly: true, requiredPermission: { module: 'staff', action: 'manage' }, sidebarHidden: true },
  { path: '/commission-data', label: 'Commission Data', description: 'Commission analytics', adminOnly: true, requiredPermission: { module: 'payments', action: 'read' }, sidebarHidden: true },
  { path: '/revenue-goals', label: 'Revenue Goals', description: 'Revenue target configuration' },
  { path: '/channels', label: 'Channels', description: 'SMS, WhatsApp, and call channel config', aliases: ['sms templates', 'whatsapp templates', 'push templates', 'webhooks'], adminOnly: true, requiredPermission: { module: 'integrations', action: 'manage' }, sidebarHidden: true },
  { path: '/industry-templates', label: 'Industry Templates', description: 'Pre-built workflow templates', aliases: ['templates', 'workflow templates'], adminOnly: true, requiredPermission: { module: 'settings', action: 'read' }, sidebarHidden: true },
  { path: '/sandbox', label: 'Sandbox', description: 'Testing + feature preview', adminOnly: true, requiredPermission: { module: 'sandbox', action: 'read' } },
  { path: '/objects', label: 'App Builder', description: 'Create custom data models', adminOnly: true, requiredPermission: { module: 'custom_objects', action: 'read' } },
  { path: '/currencies', label: 'Currencies', description: 'Multi-currency configuration', adminOnly: true, requiredPermission: { module: 'settings', action: 'manage' } },
  { path: '/zapier', label: 'Zapier', description: 'Third-party automation hub', adminOnly: true, requiredPermission: { module: 'integrations', action: 'read' } },
  { path: '/developer', label: 'Developers', description: 'API + webhook console', aliases: ['webhook', 'webhooks', 'api'], adminOnly: true, requiredPermission: { module: 'developer', action: 'read' } },
  { path: '/data-import-export', label: 'Import / Export', description: 'Bulk CSV operations', managerOnly: true },
  { path: '/settings', label: 'Settings', description: 'Tenant settings + integrations', requiredPermission: { module: 'settings', action: 'read' } },
  { path: '/notification-settings', label: 'Notification Settings', description: 'Personal notification preferences' },
  { id: 'adsgpt', label: 'AdsGPT', description: 'Open the connected AdsGPT marketing workspace', managerOnly: true, actionTarget: '[data-tour-feature="adsgpt"]', requiredPermission: { module: 'adsgpt', action: 'read' } },
  { id: 'callified', label: 'Callified', description: 'Open the connected Callified calling workspace', managerOnly: true, actionTarget: '[data-tour-feature="callified"]', requiredPermission: { module: 'callified', action: 'read' } },
  { path: '/whatsapp', label: 'WhatsApp', description: 'Manage tenant-scoped WhatsApp conversations', requiredPermission: { module: 'whatsapp', action: 'read' } },
  { path: '/lead-reports', label: 'Lead Reports', description: 'Review lead productivity, quality, sources, and follow-ups', managerOnly: true },
  { path: '/field-config', label: 'Field Config', description: 'Configure Generic CRM lead fields, groups, and table columns', adminOnly: true },
  // Generic CRM: Workflows is intentionally hidden from navigation/search.
  // Keep the access metadata active so direct routes retain their RBAC guard.
  { path: '/workflows', label: 'Workflows', description: 'Build trigger, condition, and action automations', requiredPermission: { module: 'workflows', action: 'read' }, sidebarHidden: true },
];

export const GENERIC_SIDEBAR_PAGE_SPECS = GENERIC_SIDEBAR_PAGE_SPECS_BASE.map((page) => {
  const requiredPermission = page.path && GENERIC_SIDEBAR_PERMISSION_BY_PATH[page.path];
  return requiredPermission ? { ...page, requiredPermission } : page;
});

// Permission mapping for legacy generic search entries that historically only
// declared a role tier. This keeps global search consistent with the generic
// sidebar without changing wellness/travel search behavior.
const GENERIC_PAGE_PERMISSION_FALLBACK = {
  '/pipelines': ['pipeline', 'write'],
  '/forecasting': ['forecasting', 'read'],
  '/quotas': ['quotas', 'read'],
  '/win-loss': ['analytics', 'read'],
  '/funnel': ['pipeline', 'read'],
  '/reports': ['reports', 'read'],
  '/agent-reports': ['reports', 'read'],
  '/dashboards': ['dashboards', 'read'],
  '/custom-reports': ['reports', 'write'],
  '/approvals': ['staff', 'manage'],
  // '/lead-routing': ['leads', 'read'], // Generic CRM page intentionally hidden.
  '/lead-scoring': ['lead_scoring', 'read'],
  '/lead-reports': ['reports', 'read'],
  '/marketing': ['marketing', 'read'],
  '/sequences': ['marketing', 'read'],
  '/ab-tests': ['ab_tests', 'read'],
  '/web-visitors': ['analytics', 'read'],
  '/chatbots': ['chatbots', 'read'],
  '/social': ['social', 'read'],
  '/knowledge-base': ['knowledge_base', 'read'],
  '/surveys': ['surveys', 'read'],
  '/sla': ['sla', 'read'],
  '/payments': ['payments', 'read'],
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
  // A configured permission is the canonical access contract. Legacy role
  // flags remain only for pages that have not yet been migrated to RBAC.
  const hasConfiguredPermission = Boolean(access.requiredPermission);
  return {
    ...(access.requiredPermission ? { requiredPermission: access.requiredPermission } : {}),
    ...(!hasConfiguredPermission && access.adminOnly ? { allow: ['ADMIN'] } : {}),
    ...(!hasConfiguredPermission && access.managerOnly ? { allow: ['ADMIN', 'MANAGER'] } : {}),
    ...(!hasConfiguredPermission && access.userOnly ? { allow: ['USER'] } : {}),
  };
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

const TMC_ACTIVE_ONLY_TRAVEL_PAGE_PATHS = new Set(['/travel/tmc/teachers']);

// Entries returned by /api/pages/me are merged with the local catalogue.
// Keep this deny-list Generic-only so a stale/server-provided entry cannot
// make intentionally hidden pages appear in search again.
const GENERIC_HIDDEN_PAGE_PATHS = new Set([
  '/contacts',
  '/workflows',
  '/sequences',
  '/web-visitors',
  '/ab-tests',
  '/chatbots',
  '/social',
  '/playbooks',
  '/sla',
  '/contracts',
  '/admin/csp-violations',
  '/admin/status',
  '/commission-profiles',
  '/commission-data',
  '/channels',
  '/industry-templates',
  '/signatures',
  '/document-templates',
  '/projects',
  '/lead-routing',
  '/estimates',
]);

export function isTenantPageHidden(path, hiddenPagePaths = []) {
  if (!path || !Array.isArray(hiddenPagePaths)) return false;
  return hiddenPagePaths.some(
    (hiddenPath) => path === hiddenPath || path.startsWith(`${hiddenPath}/`),
  );
}

export function canUseGenericSidebarPage(page, {
  isAdmin = false,
  isManager = false,
  permissionsReady = false,
  hasPermission = () => false,
  hiddenPagePaths = [],
} = {}) {
  if (page?.sidebarHidden) return false;
  if (isTenantPageHidden(page?.path, hiddenPagePaths)) return false;
  const fallbackPermission = page.path ? GENERIC_PAGE_PERMISSION_FALLBACK[page.path] : null;
  const requiredPermission = page.requiredPermission || (fallbackPermission
    ? { module: fallbackPermission[0], action: fallbackPermission[1] }
    : null);
  const hasConfiguredPermission = Boolean(requiredPermission);
  if (!hasConfiguredPermission && page.adminOnly && !isAdmin) return false;
  if (!hasConfiguredPermission && page.managerOnly && !isManager) return false;
  if (page.hideForAdmin && isAdmin) return false;
  if (page.userOnly && (isAdmin || isManager)) return false;
  if (
    requiredPermission &&
    (!permissionsReady || !hasPermission(requiredPermission.module, requiredPermission.action))
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
      delete searchable.sidebarHidden;
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
  { vertical = null, activeSubBrand = null, subBrandAccess = null, hiddenPagePaths = [] } = {},
) {
  if (!Array.isArray(pages)) return [];
  const tenantVisiblePages = pages.filter((page) => !isTenantPageHidden(page?.path, hiddenPagePaths));
  if (vertical === 'generic' || vertical == null) {
    return tenantVisiblePages.filter((page) => !GENERIC_HIDDEN_PAGE_PATHS.has(page?.path));
  }
  if (vertical !== 'travel') return tenantVisiblePages;

  const normalizedSubBrandAccess = normalizeSubBrandAccess(subBrandAccess);
  const filtered = [];
  for (const page of tenantVisiblePages) {
    const spec = TRAVEL_SIDEBAR_PAGE_MAP.get(page?.path);
    if (!spec) continue;
    if (TMC_ACTIVE_ONLY_TRAVEL_PAGE_PATHS.has(page?.path) && activeSubBrand !== 'tmc') continue;
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
      description: spec.description || page.description,
      aliases: TRAVEL_PAGE_ALIASES[page.path] || [],
    });
  }
  return filtered;
}
