/**
 * Page catalog — single source of truth for "what pages exist in the SPA
 * and which permission(s) grant access to each".
 *
 * Used in four places:
 *   1. /api/pages/catalog → frontend gets the full list (for the admin
 *      Roles & Permissions UI to know what's pickable).
 *   2. /api/roles/:id/accessible-pages → returns only the subset the
 *      named role has permissions for (drives the landingPath dropdown).
 *   3. /api/pages/me → returns the subset the signed-in user can access
 *      (powers the QuickLinks /home widget AND the wellness sidebar
 *      section rendering — every visible link there is intersected with
 *      this list so there is ZERO hardcoded role-string gating in the UI).
 *   4. The wellness sidebar (Sidebar.jsx) reads this list and renders one
 *      labelled section per `category` in catalog order. Add a row here +
 *      add the route in App.jsx + add a row to PAGE_ICON_BY_PATH in
 *      Sidebar.jsx = the page appears in the sidebar for any role that
 *      has the right permissions. No JSX edit for new roles, no
 *      adminOnly / managerOnly / wellnessRoles strings anywhere.
 *
 * Each entry:
 *   path                — the SPA route (must start with '/'; must match
 *                         a Route in App.jsx).
 *   label               — display name in the picker + the quick-link card
 *                         + the sidebar nav entry.
 *   description         — one-line subtitle (optional but recommended)
 *   category            — grouping in the UI ("Clinical" / "Finance" / …).
 *                         The wellness sidebar renders one section per
 *                         category in catalog order.
 *   requiredPermissions — array of {module, action}; the user needs ALL
 *                         to access this page (multi-permission AND semantics
 *                         via the .every() filter below). Empty array means
 *                         everyone with a session can see it (e.g. /home
 *                         itself, which is the always-available fallback).
 *   hideForAdminTier    — (optional, default false) if true, the wellness
 *                         sidebar hides this page from users who already see
 *                         the Admin category (admin-equivalent users). The
 *                         page stays accessible via direct URL — this is a
 *                         sidebar-only UX rule for de-cluttering admin nav
 *                         from clinical / operational day-to-day pages they
 *                         don't typically use. Strictly UX; no access change.
 *
 * Adding a new page = add one row here + one entry to PAGE_ICON_BY_PATH
 * in Sidebar.jsx. No other code change anywhere. Removing a page row is
 * safe: any role whose landingPath pointed at the removed path will
 * auto-fallback through the smart-fallback in Login.jsx → first accessible
 * page → /home.
 */

const PAGE_CATALOG = [
  // ── Always-available landing pages ────────────────────────────────
  {
    path: '/home',
    label: 'Home',
    description: 'Role-aware widget dashboard',
    category: 'Core',
    requiredPermissions: [],
  },

  // ── Manager surfaces (top of wellness sidebar, no section header) ─
  {
    path: '/wellness',
    label: 'Owner Dashboard',
    description: 'Org-wide P&L + recommendation cards',
    category: 'Manager',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/wellness/recommendations',
    label: 'Recommendations',
    description: 'AI-generated next-best-action cards',
    category: 'Manager',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },

  // ── Clinical (Wellness vertical) ──────────────────────────────────
  {
    path: '/wellness/calendar',
    label: 'Calendar',
    description: 'Day-grid view of appointments + bookings',
    category: 'Clinical',
    // .read — viewing the day grid is a read action. The slot-click-to-
    // book action inside the page is gated separately on appointments.write
    // at the page level + by the POST /api/wellness/visits backend gate.
    // Sidebar gating policy: lowest action that gives the page meaning,
    // so a role with only .read sees the page in the nav.
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
  },
  {
    path: '/wellness/appointments',
    label: 'Appointments',
    description: 'Tenant-wide list of every appointment with date/doctor/status filters',
    category: 'Clinical',
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
  },
  {
    path: '/wellness/my-appointments',
    label: 'My appointments',
    description: 'Appointments where you are the assigned practitioner',
    category: 'Clinical',
    // .write — "My" appointments only makes sense for practitioners
    // who CAN be assigned an appointment in the first place (Doctor,
    // Receptionist, Telecaller, Manager — anyone with appointments.write).
    // Nurse / clinical-assist roles never own appointments themselves;
    // they use the tenant-wide list at /wellness/appointments instead.
    requiredPermissions: [{ module: 'appointments', action: 'write' }],
  },
  {
    path: '/wellness/patients',
    label: 'Patients',
    description: 'Patient directory + clinical records',
    category: 'Clinical',
    requiredPermissions: [{ module: 'patients', action: 'read' }],
  },
  {
    path: '/wellness/waitlist',
    label: 'Waitlist',
    description: 'Patients waiting for an open slot',
    category: 'Clinical',
    // .read — viewing the queue is a read action. Promoting / dispositioning
    // a waitlist entry is gated separately on appointments.write at the
    // page action level.
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
  },
  {
    path: '/wellness/prescriptions',
    label: 'Prescriptions',
    description: 'Rx review + finalisation',
    category: 'Clinical',
    requiredPermissions: [{ module: 'prescriptions', action: 'read' }],
    // Sidebar UX: clinical day-to-day surface. Admin/owner-tier users
    // technically have prescriptions.read but they don't use the Rx list
    // in their primary nav — they reach it via patient charts or audit
    // trails. Hiding it keeps admin's sidebar focused on management
    // surfaces. Page stays accessible at /wellness/prescriptions for
    // anyone with the permission.
    hideForAdminTier: true,
  },
  {
    path: '/wellness/visits',
    label: 'Visits',
    description: 'Past visit log + clinical notes',
    category: 'Clinical',
    requiredPermissions: [{ module: 'visits', action: 'read' }],
  },
  {
    path: '/signatures',
    label: 'E-Signatures',
    description: 'Consent forms awaiting signature',
    category: 'Clinical',
    requiredPermissions: [{ module: 'consents', action: 'read' }],
  },
  {
    path: '/wellness/inventory',
    label: 'Inventory',
    description: 'Stock levels + reorder alerts',
    category: 'Clinical',
    requiredPermissions: [{ module: 'inventory', action: 'read' }],
    // Sidebar UX: stock-check is Nurse / storeroom work. Admin can still
    // reach the page (direct URL or via the Inventory Admin section
    // which has the operational ledger).
    hideForAdminTier: true,
  },

  // ── Catalog (services / drugs / memberships) ──────────────────────
  {
    path: '/wellness/services',
    label: 'Service Catalog',
    description: 'Service catalogue + packages',
    category: 'Catalog',
    requiredPermissions: [{ module: 'services', action: 'read' }],
  },
  {
    path: '/wellness/service-categories',
    label: 'Service Categories',
    description: 'Hierarchical taxonomy of services',
    category: 'Catalog',
    // .read — viewing the taxonomy is a read action. Adding/editing
    // categories is gated separately at the action level on services.write.
    requiredPermissions: [{ module: 'services', action: 'read' }],
  },
  {
    path: '/wellness/drugs',
    label: 'Drug Catalogue',
    description: 'Drugs available for prescription',
    category: 'Catalog',
    // .read — clinical staff with prescriptions.read need to browse the
    // drug catalogue when writing prescriptions. The add/edit drug actions
    // inside the page are gated on prescriptions.write separately.
    requiredPermissions: [{ module: 'prescriptions', action: 'read' }],
  },
  {
    path: '/wellness/memberships',
    label: 'Memberships',
    description: 'Membership plans + tiers',
    category: 'Catalog',
    requiredPermissions: [{ module: 'services', action: 'read' }],
  },

  // ── Scheduling (resources / holidays / working hours) ─────────────
  {
    path: '/wellness/resources',
    label: 'Resources',
    description: 'Rooms + equipment availability',
    category: 'Scheduling',
    requiredPermissions: [{ module: 'settings', action: 'read' }],
  },
  {
    path: '/wellness/holidays',
    label: 'Holidays',
    description: 'Clinic-wide holiday calendar',
    category: 'Scheduling',
    requiredPermissions: [{ module: 'settings', action: 'read' }],
  },
  {
    path: '/wellness/working-hours',
    label: 'Working Hours',
    description: 'Per-practitioner working hours',
    category: 'Scheduling',
    requiredPermissions: [{ module: 'settings', action: 'read' }],
  },

  // ── Staff self-service (attendance / leave) ───────────────────────
  // Empty requiredPermissions — every staff member needs to clock in
  // and request leave regardless of clinical / finance permission shape.
  // The wellness sidebar is not rendered for CUSTOMER role users (they
  // land on /portal), so the absence of a permission gate here only
  // surfaces these pages to logged-in staff. If a future custom role
  // should be excluded, gate this on a module/action they don't have.
  {
    path: '/wellness/attendance',
    label: 'Attendance',
    description: 'Clock in / clock out + your timesheet',
    category: 'Staff',
    requiredPermissions: [],
  },
  {
    path: '/wellness/leave',
    label: 'Leave',
    description: 'Request leave + view your balance',
    category: 'Staff',
    requiredPermissions: [],
  },

  // ── Leads & Revenue (inbox / WhatsApp / leads / tasks) ────────────
  {
    path: '/inbox',
    label: 'Unified Inbox',
    description: 'Unified email + SMS thread',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'communications', action: 'read' }],
  },
  {
    path: '/wellness/whatsapp',
    label: 'WhatsApp Threads',
    description: 'Two-way WhatsApp conversations',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'whatsapp', action: 'read' }],
  },
  {
    path: '/wellness/telecaller',
    label: 'Telecaller Queue',
    description: 'Outbound call queue + scripts',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
  },
  {
    path: '/leads',
    label: 'All Leads',
    description: 'Inbound + open leads',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
  },
  {
    path: '/converted-leads',
    label: 'Converted Leads',
    description: 'Leads that converted to patients / customers',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
  },
  {
    path: '/callified-data',
    label: 'Callified Data',
    description: 'Synced lead + call data from Callified.ai',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'integrations', action: 'read' }],
  },
  {
    path: '/tasks',
    label: 'Tasks',
    description: 'Task queue',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'tasks', action: 'read' }],
  },
  {
    path: '/marketplace-leads',
    label: 'Marketplace Leads',
    description: 'Inbound leads from IndiaMART / JustDial / TradeIndia',
    category: 'Leads & Revenue',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
  },
  {
    path: '/lead-routing',
    label: 'Routing Rules',
    description: 'Rules that auto-assign incoming leads',
    category: 'Leads & Revenue',
    // .read — viewing routing rules is reasonable for any role with
    // leads.read (helps them understand who handles incoming leads).
    // Editing rules is gated on leads.write at the action level.
    requiredPermissions: [{ module: 'leads', action: 'read' }],
  },

  // ── Sales (generic CRM only — not surfaced in wellness sidebar) ──
  {
    path: '/dashboard',
    label: 'Sales dashboard',
    description: 'Pipeline + revenue overview',
    category: 'Sales',
    requiredPermissions: [{ module: 'dashboards', action: 'read' }],
  },
  {
    path: '/contacts',
    label: 'Contacts',
    description: 'Contact directory',
    category: 'Sales',
    requiredPermissions: [{ module: 'contacts', action: 'read' }],
  },
  {
    path: '/pipeline',
    label: 'Pipeline',
    description: 'Deal pipeline by stage',
    category: 'Sales',
    requiredPermissions: [{ module: 'pipeline', action: 'read' }],
  },

  // ── Finance ───────────────────────────────────────────────────────
  {
    path: '/wellness/pos',
    label: 'Point of Sale',
    description: 'Cash-and-carry sales + shifts',
    category: 'Finance',
    requiredPermissions: [{ module: 'pos', action: 'read' }],
  },
  {
    path: '/invoices',
    label: 'Invoices',
    description: 'Patient + customer invoices',
    category: 'Finance',
    requiredPermissions: [{ module: 'billing', action: 'read' }],
  },
  {
    path: '/estimates',
    label: 'Estimates',
    description: 'Quotes + pre-treatment estimates',
    category: 'Finance',
    requiredPermissions: [{ module: 'estimates', action: 'read' }],
  },
  {
    path: '/expenses',
    label: 'Expenses',
    description: 'Team expense submissions',
    category: 'Finance',
    requiredPermissions: [{ module: 'expenses', action: 'read' }],
  },
  {
    path: '/payments',
    label: 'Payments',
    description: 'Patient payment history + gateway transactions',
    category: 'Finance',
    requiredPermissions: [{ module: 'payments', action: 'read' }],
  },
  {
    path: '/wellness/wallet',
    label: 'Patient Wallets',
    description: 'Patient pre-paid wallet balances + history',
    category: 'Finance',
    requiredPermissions: [{ module: 'billing', action: 'read' }],
  },
  {
    path: '/wellness/giftcards',
    label: 'Gift Cards',
    description: 'Gift card issuance + redemption ledger',
    category: 'Finance',
    requiredPermissions: [{ module: 'billing', action: 'read' }],
  },
  {
    path: '/wellness/coupons',
    label: 'Coupons',
    description: 'Promotional discount codes',
    category: 'Finance',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },
  {
    path: '/wellness/cashback-rules',
    label: 'Cashback Rules',
    description: 'Loyalty cashback configuration',
    category: 'Finance',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },

  // ── Marketing ─────────────────────────────────────────────────────
  {
    path: '/marketing',
    label: 'SMS / Email Blasts',
    description: 'One-shot marketing campaigns',
    category: 'Marketing',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },
  {
    path: '/sequences',
    label: 'Drip Sequences',
    description: 'Multi-step automated outreach',
    category: 'Marketing',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },
  {
    path: '/landing-pages',
    label: 'Landing Pages',
    description: 'Lead-capture landing pages',
    category: 'Marketing',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },

  // ── Reports + analytics ───────────────────────────────────────────
  {
    path: '/wellness/reports',
    label: 'P&L + Attribution',
    description: 'Clinic-side P&L + lead attribution',
    category: 'Reports',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/wellness/per-location',
    label: 'Per-Location',
    description: 'Per-location dashboards',
    category: 'Reports',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/wellness/loyalty',
    label: 'Loyalty + Referrals',
    description: 'Loyalty program + referral attribution',
    category: 'Reports',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/surveys',
    label: 'Patient Surveys',
    description: 'Survey campaigns + responses',
    category: 'Reports',
    requiredPermissions: [{ module: 'surveys', action: 'read' }],
  },
  {
    path: '/knowledge-base',
    label: 'Knowledge Base',
    description: 'Internal + customer-facing knowledge articles',
    category: 'Reports',
    requiredPermissions: [{ module: 'knowledge_base', action: 'read' }],
  },
  {
    path: '/reports',
    label: 'CRM Reports',
    description: 'Sales + activity reports',
    category: 'Reports',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/dashboards',
    label: 'Custom Dashboards',
    description: 'Drag-and-drop dashboard builder',
    category: 'Reports',
    requiredPermissions: [{ module: 'dashboards', action: 'read' }],
  },

  // ── Appointments (booking-on-behalf surface) ──────────────────────
  {
    path: '/wellness/book-appointment',
    label: 'Book Appointment',
    description: 'Staff/patient appointment booking form',
    category: 'Appointments',
    // .write — only roles that CREATE appointments (Telecaller,
    // Receptionist, Manager, CUSTOMER self-booking flow). Excludes Nurse
    // + other clinical-assist roles who never book on behalf of patients.
    requiredPermissions: [{ module: 'appointments', action: 'write' }],
  },

  // ── Patient portal (CUSTOMER role — not in wellness sidebar) ─────
  {
    path: '/portal',
    label: 'Patient portal',
    description: 'Patient self-service home',
    category: 'Patient',
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
  },

  // ── Admin ─────────────────────────────────────────────────────────
  {
    path: '/wellness/locations',
    label: 'Locations',
    description: 'Multi-clinic location admin',
    category: 'Admin',
    // .read — viewing the location list is fine for any role with
    // settings.read. The create/edit/delete actions inside are gated
    // separately on settings.manage.
    requiredPermissions: [{ module: 'settings', action: 'read' }],
  },
  {
    path: '/staff',
    label: 'Staff',
    description: 'Team management',
    category: 'Admin',
    // .manage (not .read) because /staff handles user CRUD + role
    // assignment — admin work, not just viewing a directory. Matches the
    // admin-only RoleGuard on this route in App.jsx.
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/settings/roles',
    label: 'Roles',
    description: 'RBAC roles + permissions matrix',
    category: 'Admin',
    requiredPermissions: [{ module: 'roles', action: 'read' }],
  },
  {
    path: '/commission-profiles',
    label: 'Commission Profiles',
    description: 'Per-role / per-service commission rules',
    category: 'Admin',
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/revenue-goals',
    label: 'Revenue Goals',
    description: 'Org + per-practitioner revenue targets',
    category: 'Admin',
    requiredPermissions: [{ module: 'reports', action: 'write' }],
  },
  {
    path: '/channels',
    label: 'Channels',
    description: 'SMS / WhatsApp / call channel config',
    category: 'Admin',
    // .manage — channels is provider-keys config (SMS/WhatsApp/Telephony),
    // not just a comms view. Matches the admin-only RoleGuard on this
    // route in App.jsx. Manager has communications.read but not
    // integrations.manage, so Manager won't see this in the sidebar OR
    // be able to access the page — consistent both directions.
    requiredPermissions: [{ module: 'integrations', action: 'manage' }],
  },
  {
    path: '/approvals',
    label: 'Approvals',
    description: 'Pending approvals queue',
    category: 'Admin',
    // .manage — approvals queue is admin sign-off, not staff viewing.
    requiredPermissions: [{ module: 'staff', action: 'manage' }],
  },
  {
    path: '/audit-log',
    label: 'Audit Log',
    description: 'Compliance audit trail',
    category: 'Admin',
    requiredPermissions: [{ module: 'audit', action: 'read' }],
  },
  {
    path: '/privacy',
    label: 'Privacy',
    description: 'GDPR / DSAR retention controls',
    category: 'Admin',
    requiredPermissions: [{ module: 'settings', action: 'manage' }],
  },
  {
    path: '/settings',
    label: 'Settings',
    description: 'Tenant settings + integrations',
    category: 'Admin',
    requiredPermissions: [{ module: 'settings', action: 'read' }],
  },

  // ── Inventory Admin (config + ops ledger) ─────────────────────────
  // Sidebar gating for both the Products (master/config) and Inventory
  // Admin (operational ledger) clusters is .read — any role with
  // inventory.read can browse them. The create / edit / delete actions
  // inside each page are gated separately at the action level (.write /
  // .update / .delete / .manage) via the backend route guards in
  // routes/inventory.js. The two categories are a UI split only — the
  // underlying permission module stays `inventory` (a Product is an
  // inventory item, a Receipt records inventory movement).

  // ── Products (master catalog / config) ────────────────────────────
  // Gated on the dedicated `products` permission module so admins can
  // grant catalog access without exposing the stock ledger and vice
  // versa. Backend routes in routes/inventory.js use the matching
  // products.* permissions for product/category/auto-consumption ops.
  {
    path: '/wellness/product-categories',
    label: 'Product Categories',
    description: 'Product catalog categories',
    category: 'Products',
    requiredPermissions: [{ module: 'products', action: 'read' }],
  },
  {
    path: '/wellness/products',
    label: 'Products',
    description: 'Product master',
    category: 'Products',
    requiredPermissions: [{ module: 'products', action: 'read' }],
  },
  {
    path: '/wellness/auto-consumption-rules',
    label: 'Auto-consumption',
    description: 'Per-service auto-consumption rules',
    category: 'Products',
    requiredPermissions: [{ module: 'products', action: 'read' }],
  },

  // ── Inventory Admin (operational ledger) ──────────────────────────
  {
    path: '/wellness/vendors',
    label: 'Vendors',
    description: 'Supplier directory',
    category: 'Inventory Admin',
    requiredPermissions: [{ module: 'inventory', action: 'read' }],
  },
  {
    path: '/wellness/inventory-receipts',
    label: 'Receipts',
    description: 'Goods-received notes + stock-in ledger',
    category: 'Inventory Admin',
    requiredPermissions: [{ module: 'inventory', action: 'read' }],
  },
  {
    path: '/wellness/inventory-adjustments',
    label: 'Adjustments',
    description: 'Stock corrections + write-offs',
    category: 'Inventory Admin',
    requiredPermissions: [{ module: 'inventory', action: 'read' }],
  },

  // ── User self-service (notification preferences) ──────────────────
  // Empty requiredPermissions — every logged-in user (including CUSTOMER)
  // can manage their own notification preferences.
  {
    path: '/notification-settings',
    label: 'Notification Settings',
    description: 'Personal notification preferences',
    category: 'User',
    requiredPermissions: [],
  },
];

const PAGES_BY_PATH = new Map(PAGE_CATALOG.map((p) => [p.path, p]));

function getCatalog() {
  return PAGE_CATALOG.map((p) => ({
    ...p,
    requiredPermissions: p.requiredPermissions.map((perm) => ({ ...perm })),
  }));
}

function getPage(path) {
  return PAGES_BY_PATH.get(path) || null;
}

function isKnownPage(path) {
  return typeof path === 'string' && PAGES_BY_PATH.has(path);
}

/**
 * Return the subset of catalog entries whose requiredPermissions are all
 * satisfied by the given Set of "module.action" permission strings. A
 * page with empty requiredPermissions always passes (so /home always
 * appears as a final-fallback target).
 *
 * Multi-permission pages: an entry with multiple {module, action} items
 * requires the user to have ALL of them (AND semantics via .every()).
 *
 * @param {Set<string>} permissionSet
 * @param {{ isOwner?: boolean }} [opts]
 */
function getAccessiblePages(permissionSet, opts = {}) {
  if (opts.isOwner) return getCatalog(); // OWNER sees everything
  if (!(permissionSet instanceof Set)) return [];
  return PAGE_CATALOG.filter((p) => {
    if (p.requiredPermissions.length === 0) return true;
    return p.requiredPermissions.every(
      ({ module, action }) => permissionSet.has(`${module}.${action}`),
    );
  }).map((p) => ({
    ...p,
    requiredPermissions: p.requiredPermissions.map((perm) => ({ ...perm })),
  }));
}

/**
 * Convenience: returns true if the given permission set grants access to
 * the given path. Used by the landingPath validator + the auto-clear
 * hook in PUT /api/roles/:id/permissions.
 */
function canAccessPath(path, permissionSet, opts = {}) {
  if (!isKnownPage(path)) return false;
  const page = getPage(path);
  if (opts.isOwner) return true;
  if (page.requiredPermissions.length === 0) return true;
  if (!(permissionSet instanceof Set)) return false;
  return page.requiredPermissions.every(
    ({ module, action }) => permissionSet.has(`${module}.${action}`),
  );
}

module.exports = {
  PAGE_CATALOG,
  getCatalog,
  getPage,
  isKnownPage,
  getAccessiblePages,
  canAccessPath,
};
