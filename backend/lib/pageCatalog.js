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
 *   customerOnly        — (optional, default false) if true, the wellness
 *                         sidebar surfaces this page ONLY to customer-tier
 *                         roles (role === 'USER' || role === 'CUSTOMER').
 *                         Admin / manager / staff (any other role) don't see
 *                         it in their nav. Used for customer-facing storefront
 *                         surfaces (e.g. Buy Gift Cards). Strictly a sidebar-
 *                         only UX rule — the page stays accessible by direct
 *                         URL and the backend route's own auth is unchanged.
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
    // Admin/owner-tier users already have the Owner Dashboard (/wellness
    // for wellness tenants, /dashboard for generic) which covers the same
    // ground as /home. Hide the duplicate from their sidebar; the App.jsx
    // route guard bounces direct-URL visits to the appropriate dashboard.
    hideForAdminTier: true,
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
    // .read on the dedicated `calendar` module — separated from
    // `appointments` so admins can grant view-only Calendar access
    // without also exposing the Appointments list, Book Appointment
    // form, and My Appointments page. Slot-click-to-book and
    // drag-to-reschedule inside the Calendar are gated on
    // `calendar.write` at the action level.
    requiredPermissions: [{ module: 'calendar', action: 'read' }],
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
    // Dedicated `my_appointments` module — split out from `appointments`
    // so a doctor can be granted their own-slot view without also seeing
    // the tenant-wide Appointments list, and an admin can be granted the
    // tenant-wide list without polluting their nav with a "My Appointments"
    // page (they have no assigned slots themselves).
    requiredPermissions: [{ module: 'my_appointments', action: 'read' }],
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
    // Dedicated `waitlist` module — split out from `appointments` so a
    // telecaller can be granted waitlist management without also getting
    // the tenant-wide Appointments list. `waitlist.read` views the queue;
    // promoting / dispositioning gates on `waitlist.write` at the page
    // action level.
    requiredPermissions: [{ module: 'waitlist', action: 'read' }],
  },
  {
    path: '/wellness/prescriptions',
    label: 'Prescriptions',
    description: 'Rx review + finalisation',
    category: 'Clinical',
    requiredPermissions: [{ module: 'prescriptions', action: 'read' }],
  },
  {
    path: '/wellness/my-prescriptions',
    label: 'My Prescriptions',
    description: 'Your own prescriptions (linked Patient profile)',
    category: 'Clinical',
    // Separate `my_prescriptions` module — granted to roles whose users
    // may also be patients at this clinic (CUSTOMER, and optionally USER
    // when staff-as-patient flows are in play). Backend scopes to
    // req.user.userId's linked Patient row; cross-patient access is
    // structurally impossible regardless of role grants.
    requiredPermissions: [{ module: 'my_prescriptions', action: 'read' }],
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
    // Path doesn't start with `/wellness/`, so the path-prefix
    // filter in getCatalogForVertical would let this leak into the
    // travel + generic catalogs. Explicit `vertical: 'wellness'`
    // tag keeps it confined to wellness — the page renders a
    // consent-signature queue tied to the wellness clinical flow.
    vertical: 'wellness',
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
  // Gated on dedicated `attendance` / `leave` modules so non-staff roles
  // (e.g. CUSTOMER) are excluded from the sidebar even if the wellness
  // sidebar ever renders for them. Read-tier gates the sidebar entry;
  // higher tiers (write = clock-in / submit-request, manage = approve /
  // policies) are enforced at the route handler.
  {
    path: '/wellness/attendance',
    label: 'Attendance',
    description: 'Clock in / clock out + your timesheet',
    category: 'Staff',
    requiredPermissions: [{ module: 'attendance', action: 'read' }],
  },
  {
    // Admin/Manager all-staff dashboard — KPI tiles + attendance list.
    // The backend /api/attendance/summary + /list endpoints are role-gated
    // (ADMIN/MANAGER), so non-managers wouldn't get useful data here. The
    // page itself renders a friendly read-only fallback for plain users.
    // Sidebar surfacing is gated on `reports.read` so plain USER roles
    // don't see a dashboard link that returns an empty/forbidden view.
    path: '/wellness/attendance-dashboard',
    label: 'Attendance Dashboard',
    description: 'All-staff KPIs + attendance list (admin / manager view)',
    category: 'Staff',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/wellness/leave',
    label: 'Leave',
    description: 'Request leave + view your balance',
    category: 'Staff',
    requiredPermissions: [{ module: 'leave', action: 'read' }],
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
    path: '/travel/whatsapp',
    label: 'WhatsApp',
    description: 'Two-way WhatsApp conversations',
    category: 'Communications',
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
    // Cross-vertical — description was wellness-flavored ("converted to
    // patients / customers"). Travel converts leads to bookings; generic
    // CRM converts to deals. Use neutral wording.
    description: 'Leads that converted to customers',
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
    path: '/estimates',
    label: 'Estimates',
    // Cross-vertical — description was wellness-flavored ("pre-treatment").
    // Travel uses estimates for trip quotes pre-confirmation; generic CRM
    // for proposals. Drop the wellness-only "pre-treatment" qualifier.
    description: 'Quotes + estimates sent to customers',
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
    // Cross-vertical generic payment surface. Vertical-agnostic copy —
    // wellness flavours its own surfaces via the patient-wallet / POS
    // sub-pages; travel flavours via /travel/milestones + payable batches.
    description: 'Payment history + gateway transactions',
    category: 'Finance',
    requiredPermissions: [{ module: 'payments', action: 'read' }],
  },
  {
    path: '/wellness/wallet',
    label: 'Patient Wallets',
    description: 'Patient pre-paid wallet balances + history',
    category: 'Finance',
    requiredPermissions: [{ module: 'patient_wallets', action: 'read' }],
  },
  {
    path: '/wellness/giftcards',
    label: 'Gift Cards',
    description: 'Gift card issuance + redemption ledger',
    category: 'Finance',
    requiredPermissions: [{ module: 'gift_cards', action: 'read' }],
  },
  {
    path: '/wellness/buy-giftcards',
    label: 'Buy Gift Cards',
    description: 'Customer-facing gift card storefront — purchase via Razorpay, value lands on the chosen patient\'s wallet',
    category: 'Finance',
    // No required permissions — any authenticated tenant user can browse
    // + buy. Backend route is auth-only too. Mirrors the open-to-all-users
    // shape used by /home + other low-privilege storefront surfaces.
    requiredPermissions: [],
    // This is a CUSTOMER-facing storefront, so the sidebar entry is only
    // surfaced to customer-tier roles (USER / CUSTOMER). Admin / manager /
    // staff roles don't see it in their nav. Strictly a sidebar-only UX
    // rule — the page stays reachable by direct URL and the backend route
    // remains auth-only (so any logged-in user can still buy). See the
    // customerOnly flag doc in the catalog header above.
    customerOnly: true,
  },
  {
    path: '/wellness/my-transactions',
    label: 'My Transactions',
    description: 'Your own payment history — purchases, treatments, gift cards, wallet + subscriptions',
    category: 'Finance',
    // Open to any authenticated user; the backend endpoint scopes the data
    // to the caller's own Patient. customerOnly keeps the sidebar entry to
    // customer-tier roles (USER / CUSTOMER) so staff / admin don't see it.
    requiredPermissions: [],
    customerOnly: true,
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
    vertical: 'generic',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },
  {
    path: '/landing-pages',
    label: 'Landing Pages',
    description: 'Lead-capture landing pages',
    category: 'Marketing',
    vertical: 'generic',
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
    // Cross-vertical surveys surface (CSAT / NPS / post-trip / post-visit).
    // Was labelled "Patient Surveys" which read wrong on travel tenants
    // where the same surface drives post-trip + visa-completion surveys.
    label: 'Surveys',
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
    path: '/dashboards',
    label: 'Custom Dashboards',
    description: 'Drag-and-drop dashboard builder',
    category: 'Reports',
    vertical: 'generic',
    requiredPermissions: [{ module: 'dashboards', action: 'read' }],
  },

  // ── Appointments (booking-on-behalf surface) ──────────────────────
  {
    path: '/wellness/book-appointment',
    label: 'Book Appointment',
    description: 'Staff/patient appointment booking form',
    category: 'Appointments',
    // Dedicated `book_appointment` module — split out from `appointments`
    // so the booking surface is independently grantable. Telecallers /
    // receptionists who book on behalf of patients get this; doctors
    // (slots already assigned to them) and admins (don't book themselves)
    // typically don't.
    requiredPermissions: [{ module: 'book_appointment', action: 'write' }],
  },

  // ── Patient portal (CUSTOMER role — not in wellness sidebar) ─────
  // Wellness-only surface served at a cross-vertical path. The path-prefix
  // filter in getCatalogForVertical can't infer wellness from `/portal`,
  // so it carries an explicit `vertical: 'wellness'` tag instead.
  {
    path: '/portal',
    label: 'Patient portal',
    description: 'Patient self-service home',
    category: 'Patient',
    vertical: 'wellness',
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
  },
  {
    path: '/wellness/my-bookings',
    label: 'My bookings',
    description: 'Patient appointment management — upcoming, pending, completed, cancelled',
    // Category is `Appointments` (not `Patient`) because the wellness
    // sidebar's WELLNESS_CATEGORY_ORDER (frontend/src/components/Sidebar.jsx)
    // only renders sections whose name appears in that list — `Patient`
    // is a catalog-only tag used by `/portal` (which is a separate,
    // public, non-sidebar route). Slotting under Appointments keeps the
    // patient's bookings page next to Book Appointment so the cluster
    // reads as one coherent group.
    category: 'Appointments',
    // Dedicated `my_bookings` module — split from the staff-facing
    // `my_appointments` (practitioner's own schedule) so a patient can
    // be granted appointment management without seeing the practitioner
    // view, and vice versa. CUSTOMER system role grants this; ADMIN /
    // MANAGER / clinical roles do not see it in their sidebars.
    requiredPermissions: [{ module: 'my_bookings', action: 'read' }],
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
    // Wellness-only surface served at a cross-vertical path (revenue goals
    // page wires per-practitioner targets). Travel uses per-sub-brand /
    // per-supplier revenue tracking through travel_reports.js, not this
    // page. Tagged so the filter hides it on travel tenants.
    path: '/revenue-goals',
    label: 'Revenue Goals',
    description: 'Org + per-practitioner revenue targets',
    category: 'Admin',
    vertical: 'wellness',
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
    // Auto-consumption rules are admin-tier configuration (which products
    // auto-deduct when a service is completed) — not a browse surface.
    // Gating on products.manage hides this from CUSTOMER sidebars
    // (CUSTOMER gets products.read for the catalogue, not .manage) while
    // keeping ADMIN/NURSE access intact. The route handler's READ gate
    // (canReadProductsStaff) keeps the legacy blanket-deny defensively
    // if a customer ever URL-hops here.
    path: '/wellness/auto-consumption-rules',
    label: 'Auto-consumption',
    description: 'Per-service auto-consumption rules',
    category: 'Products',
    requiredPermissions: [{ module: 'products', action: 'manage' }],
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

  // ── Travel vertical ───────────────────────────────────────────────
  // Travel-vertical landing-page candidates. Mirrors renderTravelNav in
  // Sidebar.jsx and the travel permission catalogue in
  // backend/lib/permissionCatalog.js TRAVEL_MODULES. Path-prefix `/travel`
  // is what getCatalogForVertical filters on — a wellness tenant never
  // sees these in its dropdown, a travel tenant never sees `/wellness/*`.
  // Phase 1: pages list lets a travel admin pick the role's landingPath;
  // backend routes don't yet decorate with requirePermission, so the
  // listed perms are advisory until the Phase 2 sweep.
  {
    path: '/travel',
    label: 'Travel Dashboard',
    description: 'Travel CRM operational overview',
    category: 'Travel',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/travel/leads',
    label: 'All Leads',
    description: 'Lead pipeline across all travel sub-brands',
    category: 'Travel Sales',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
  },
  // COMMENTED OUT - Inbound Leads hidden from sidebar and search
  // {
  //   path: '/travel/inbound-leads',
  //   label: 'Inbound Leads',
  //   description: 'Webhook-ingested raw leads pre-conversion',
  //   category: 'Travel Sales',
  //   requiredPermissions: [{ module: 'inbound_leads', action: 'read' }],
  // },
  {
    path: '/travel/diagnostics',
    label: 'Diagnostics',
    description: 'TMC readiness diagnostic public-form results',
    category: 'Travel Sales',
    requiredPermissions: [{ module: 'diagnostics', action: 'read' }],
  },
  {
    path: '/travel/itineraries',
    label: 'Itineraries',
    description: 'Day-by-day itinerary builder + library',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'itineraries', action: 'read' }],
  },
  {
    path: '/travel/itinerary-templates',
    label: 'Itinerary Templates',
    description: 'Reusable itinerary starting points',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'itinerary_templates', action: 'read' }],
  },
  {
    path: '/travel/trips',
    label: 'TMC Trips',
    description: 'School educational trip instances (TMC sub-brand)',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'trips', action: 'read' }],
  },
  {
    path: '/travel/tmc/catalogue',
    label: 'TMC Catalogue',
    description: 'Bookable TMC trip template library',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'tmc_catalogue', action: 'read' }],
  },
  {
    path: '/travel/web-checkins',
    label: 'Web Check-ins',
    description: 'Airline web check-in tracking',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'web_checkins', action: 'read' }],
  },
  {
    path: '/travel/passport-verification',
    label: 'Passport Verification',
    description: 'OCR queue for passport scans',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'passport', action: 'read' }],
  },
  {
    path: '/travel/cost-master',
    label: 'Cost Master',
    description: 'Per-supplier cost rate cards across categories',
    category: 'Travel Pricing',
    requiredPermissions: [{ module: 'cost_master', action: 'read' }],
  },
  {
    path: '/travel/sightseeing',
    label: 'Sightseeing Master',
    description: 'POI + sightseeing inventory catalogue',
    category: 'Travel Pricing',
    requiredPermissions: [{ module: 'sightseeing', action: 'read' }],
  },
  {
    path: '/travel/pricing-rules',
    label: 'Pricing Rules',
    description: 'Season-based markup + auto-pricing rules',
    category: 'Travel Pricing',
    requiredPermissions: [{ module: 'pricing', action: 'read' }],
  },
  {
    path: '/travel/flights/quote',
    label: 'Flight Quick-quote',
    description: 'Manual flight-options quote builder',
    category: 'Travel Pricing',
    requiredPermissions: [{ module: 'flight_quotes', action: 'read' }],
  },
  {
    path: '/travel/reports',
    label: 'Travel Reports',
    description: 'Travel sales + operational reports',
    category: 'Travel Analytics',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/travel/suppliers-admin',
    label: 'Suppliers',
    description: 'Supplier directory + KYC + reconciliation',
    category: 'Travel Suppliers',
    requiredPermissions: [{ module: 'suppliers', action: 'read' }],
  },
  {
    path: '/travel/payables',
    label: 'Payables',
    description: 'Cross-supplier A/P review queue',
    category: 'Travel Suppliers',
    requiredPermissions: [{ module: 'payables', action: 'read' }],
  },
  {
    path: '/travel/commission-profiles',
    label: 'Commission Profiles',
    description: 'Supplier commission policy CRUD',
    category: 'Travel Suppliers',
    requiredPermissions: [{ module: 'commission_profiles', action: 'read' }],
  },
  {
    path: '/travel/cancellation-policies',
    label: 'Cancellation Policies',
    description: 'Refund + credit-note auto-issuance policies',
    category: 'Travel Suppliers',
    requiredPermissions: [{ module: 'cancellation_policies', action: 'read' }],
  },
  {
    path: '/travel/quotes-admin',
    label: 'Quotes',
    description: 'Customer-facing quote list (travel)',
    category: 'Travel Quotes & Invoicing',
    requiredPermissions: [{ module: 'quotes', action: 'read' }],
  },
  {
    path: '/travel/quotes/builder',
    label: 'Quote Builder',
    description: 'Line-item + totals quote composer',
    category: 'Travel Quotes & Invoicing',
    requiredPermissions: [{ module: 'quotes', action: 'write' }],
  },
  {
    path: '/travel/quote-templates',
    label: 'Quote Templates',
    description: 'Pre-filled line-set library for quotes',
    category: 'Travel Quotes & Invoicing',
    requiredPermissions: [{ module: 'quote_templates', action: 'read' }],
  },
  {
    path: '/travel/invoices-admin',
    label: 'Travel Invoices',
    description: 'Customer-facing invoice ledger',
    category: 'Travel Quotes & Invoicing',
    requiredPermissions: [{ module: 'invoices', action: 'read' }],
  },
  {
    path: '/travel/milestones',
    label: 'Payment Milestones',
    description: 'Cross-invoice payment-milestone dashboard',
    category: 'Travel Quotes & Invoicing',
    requiredPermissions: [{ module: 'invoices', action: 'read' }],
  },
  {
    path: '/travel/visa',
    label: 'Visa Dashboard',
    description: 'Visa Sure sub-brand overview',
    category: 'Travel Sub-brand',
    requiredPermissions: [{ module: 'visa', action: 'read' }],
  },
  {
    path: '/travel/visa/applications',
    label: 'Visa Applications',
    description: 'Applicant tracker for Visa Sure',
    category: 'Travel Sub-brand',
    requiredPermissions: [{ module: 'visa', action: 'read' }],
  },
  {
    path: '/travel/religious-packets',
    label: 'Religious Packets',
    description: 'RFU Umrah pilgrim packet builder',
    category: 'Travel Sub-brand',
    requiredPermissions: [{ module: 'religious_packets', action: 'read' }],
  },
  {
    path: '/travel/curriculum-mappings',
    label: 'Curriculum Mappings',
    description: 'TMC school-trip curriculum alignment',
    category: 'Travel Sub-brand',
    requiredPermissions: [{ module: 'curriculum', action: 'read' }],
  },
  {
    path: '/travel/school-terms',
    label: 'School Term Calendar',
    description: 'TMC school term + holiday windows',
    category: 'Travel Sub-brand',
    requiredPermissions: [{ module: 'school_terms', action: 'read' }],
  },
  {
    path: '/travel/marketing/flyer-studio',
    label: 'Flyer Studio',
    description: 'Marketing flyer composer',
    category: 'Travel Marketing',
    requiredPermissions: [{ module: 'flyer_studio', action: 'read' }],
  },
  {
    path: '/travel/flyer-templates',
    label: 'Flyer Templates',
    description: 'Reusable flyer designs library',
    category: 'Travel Marketing',
    requiredPermissions: [{ module: 'flyer_templates', action: 'read' }],
  },
  {
    path: '/travel/brochures',
    label: 'Brochure Engine',
    description: 'AI brochure PDF composer (cover, itinerary, pricing)',
    category: 'Travel Marketing',
    requiredPermissions: [{ module: 'marketing', action: 'read' }],
  },

  // ── Sales & Pipeline (missing generic CRM routes) ────────────────
  {
    path: '/cpq',
    label: 'Configure Price Quote',
    description: 'Product configuration + quote engine',
    category: 'Sales',
    requiredPermissions: [{ module: 'cpq', action: 'read' }],
  },
  {
    path: '/clients',
    label: 'Clients',
    description: 'Company/organization directory',
    category: 'Sales',
    requiredPermissions: [{ module: 'contacts', action: 'read' }],
  },
  {
    path: '/forecasting',
    label: 'Forecasting',
    description: 'Sales forecast modeling',
    category: 'Sales',
    requiredPermissions: [{ module: 'forecasting', action: 'read' }],
  },
  {
    path: '/funnel',
    label: 'Funnel',
    description: 'Sales conversion funnel analytics',
    category: 'Sales',
    requiredPermissions: [{ module: 'pipeline', action: 'read' }],
  },
  {
    path: '/pipelines',
    label: 'Manage Pipelines',
    description: 'Create and configure sales pipelines',
    category: 'Sales',
    requiredPermissions: [{ module: 'pipeline', action: 'write' }],
  },
  {
    path: '/playbooks',
    label: 'Playbooks',
    description: 'Sales process workflows',
    category: 'Sales',
    requiredPermissions: [{ module: 'playbooks', action: 'read' }],
  },
  {
    path: '/projects',
    label: 'Projects',
    description: 'Project tracking + task boards',
    category: 'Sales',
    requiredPermissions: [{ module: 'projects', action: 'read' }],
  },
  {
    path: '/quotas',
    label: 'Quotas',
    description: 'Sales quota + territory management',
    category: 'Sales',
    requiredPermissions: [{ module: 'quotas', action: 'read' }],
  },
  {
    path: '/territories',
    label: 'Territories',
    description: 'Sales territory mapping',
    category: 'Sales',
    requiredPermissions: [{ module: 'territories', action: 'read' }],
  },
  {
    path: '/win-loss',
    label: 'Win/Loss Analysis',
    description: 'Sales outcome analysis + coaching',
    category: 'Sales',
    requiredPermissions: [{ module: 'analytics', action: 'read' }],
  },

  // ── Contracts & Agreements ─────────────────────────────────────
  {
    path: '/contracts',
    label: 'Contracts',
    description: 'Contract lifecycle management',
    category: 'Finance',
    vertical: 'generic',
    requiredPermissions: [{ module: 'contracts', action: 'read' }],
  },

  // ── Communications (missing routes) ────────────────────────────
  {
    path: '/chatbots',
    label: 'Chatbots',
    description: 'Conversational AI builder',
    category: 'Communications',
    requiredPermissions: [{ module: 'chatbots', action: 'read' }],
  },
  {
    path: '/gmail',
    label: 'Gmail Sync',
    description: 'Gmail inbox integration',
    category: 'Communications',
    requiredPermissions: [{ module: 'communications', action: 'read' }],
  },
  {
    path: '/live-chat',
    label: 'Live Chat',
    description: 'Website visitor chat support',
    category: 'Communications',
    requiredPermissions: [{ module: 'live_chat', action: 'read' }],
  },
  {
    path: '/shared-inbox',
    label: 'Shared Inbox',
    description: 'Team collaborative inbox',
    category: 'Communications',
    requiredPermissions: [{ module: 'communications', action: 'read' }],
  },

  // ── Support & Tickets ──────────────────────────────────────────
  {
    path: '/support',
    label: 'Support',
    description: 'Customer support portal',
    category: 'Support',
    requiredPermissions: [{ module: 'support', action: 'read' }],
  },
  {
    path: '/tickets',
    label: 'Tickets',
    description: 'Support ticket management',
    category: 'Support',
    requiredPermissions: [{ module: 'tickets', action: 'read' }],
  },
  {
    path: '/sla',
    label: 'SLA Policies',
    description: 'Service level agreement setup',
    category: 'Support',
    requiredPermissions: [{ module: 'sla', action: 'read' }],
  },

  // ── Finance (missing routes) ───────────────────────────────────
  {
    path: '/commission-data',
    label: 'Commission Analytics',
    description: 'Staff + supplier commission tracking',
    category: 'Finance',
    vertical: 'generic',
    requiredPermissions: [{ module: 'payments', action: 'read' }],
  },
  {
    path: '/currencies',
    label: 'Currencies',
    description: 'Multi-currency configuration',
    category: 'Finance',
    requiredPermissions: [{ module: 'settings', action: 'write' }],
  },

  // ── Marketing & Analytics (missing routes) ─────────────────────
  {
    path: '/industry-templates',
    label: 'Industry Templates',
    description: 'Pre-built workflow templates',
    category: 'Marketing',
    vertical: 'generic',
    requiredPermissions: [{ module: 'settings', action: 'read' }],
  },
  {
    path: '/social',
    label: 'Social Media',
    description: 'Social listening + posting',
    category: 'Marketing',
    requiredPermissions: [{ module: 'social', action: 'read' }],
  },
  {
    path: '/web-visitors',
    label: 'Web Analytics',
    description: 'Website visitor tracking',
    category: 'Marketing',
    vertical: 'generic',
    requiredPermissions: [{ module: 'analytics', action: 'read' }],
  },

  // ── Automation ─────────────────────────────────────────────────
  {
    path: '/workflows',
    label: 'Automation',
    description: 'Workflow automation builder',
    category: 'Automation',
    requiredPermissions: [{ module: 'workflows', action: 'read' }],
  },

  // ── Admin & Developer (missing routes) ──────────────────────────
  {
    path: '/developer',
    label: 'Developer',
    description: 'API + webhook console',
    category: 'Platform',
    requiredPermissions: [{ module: 'developer', action: 'read' }],
  },
  {
    path: '/field-permissions',
    label: 'Field Permissions',
    description: 'Field-level access control',
    category: 'Admin',
    requiredPermissions: [{ module: 'field_permissions', action: 'read' }],
  },
  {
    path: '/sandbox',
    label: 'Sandbox',
    description: 'Testing + feature preview',
    category: 'Developer',
    requiredPermissions: [{ module: 'sandbox', action: 'read' }],
  },
  {
    path: '/data-import-export',
    label: 'Data Import/Export',
    description: 'Bulk CSV operations',
    category: 'Admin',
    requiredPermissions: [{ module: 'settings', action: 'write' }],
  },
  {
    path: '/custom-reports',
    label: 'Custom Reports',
    description: 'Build custom data reports',
    category: 'Reports',
    vertical: 'generic',
    requiredPermissions: [{ module: 'reports', action: 'write' }],
  },
  {
    path: '/document-templates',
    label: 'Document Templates',
    description: 'Email, SMS, document templates',
    category: 'Admin',
    requiredPermissions: [{ module: 'document_templates', action: 'read' }],
  },
  {
    path: '/document-tracking',
    label: 'Document Tracking',
    description: 'Track + sign documents',
    category: 'Finance',
    vertical: 'generic',
    requiredPermissions: [{ module: 'documents', action: 'read' }],
  },
  {
    path: '/objects',
    label: 'Custom Objects',
    description: 'Create custom data models',
    category: 'Admin',
    requiredPermissions: [{ module: 'custom_objects', action: 'read' }],
  },
  {
    path: '/zapier',
    label: 'Zapier Integration',
    description: '3rd-party automation hub',
    category: 'Integrations',
    requiredPermissions: [{ module: 'integrations', action: 'read' }],
  },
  {
    path: '/lead-scoring',
    label: 'Lead Scoring',
    description: 'Lead qualification engine',
    category: 'Sales',
    requiredPermissions: [{ module: 'lead_scoring', action: 'read' }],
  },
  {
    path: '/deal-insights',
    label: 'Deal Insights',
    description: 'AI-powered deal analytics',
    category: 'Sales',
    requiredPermissions: [{ module: 'deal_insights', action: 'read' }],
  },
  {
    path: '/calendar-sync',
    label: 'Calendar Sync',
    description: 'Google/Outlook calendar integration',
    category: 'Integrations',
    requiredPermissions: [{ module: 'calendar', action: 'read' }],
  },

  // ── Travel-specific missing routes ─────────────────────────────
  {
    path: '/travel-stall',
    label: 'Travel Stall Dashboard',
    description: 'Travel Stall sub-brand dashboard',
    category: 'Travel Sub-brand',
    vertical: 'travel',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/travel/automation-health',
    label: 'Check-in Automation Health',
    description: 'Web check-in system monitoring',
    category: 'Travel Operations',
    vertical: 'travel',
    requiredPermissions: [{ module: 'web_checkins', action: 'read' }],
  },
  {
    path: '/travel/pois/pending',
    label: 'POI Approvals',
    description: 'Points of interest pending approval',
    category: 'Travel Operations',
    vertical: 'travel',
    requiredPermissions: [{ module: 'pois', action: 'manage' }],
  },
  {
    path: '/travel/suppliers',
    label: 'Suppliers',
    description: 'Supplier directory + catalog',
    category: 'Travel Operations',
    vertical: 'travel',
    requiredPermissions: [{ module: 'suppliers', action: 'read' }],
  },
  {
    path: '/travel/flyer-share-admin',
    label: 'Flyer Share Admin',
    description: 'Manage flyer share links + analytics',
    category: 'Travel Marketing',
    vertical: 'travel',
    requiredPermissions: [{ module: 'flyer_studio', action: 'read' }],
  },
  {
    path: '/travel/visa/checklists',
    label: 'Visa Checklists',
    description: 'Applicant visa document checklists',
    category: 'Travel Sub-brand',
    vertical: 'travel',
    requiredPermissions: [{ module: 'visa', action: 'read' }],
  },
  {
    path: '/travel/visa/embassy-rules',
    label: 'Embassy Rules',
    description: 'Visa requirements by embassy',
    category: 'Travel Sub-brand',
    vertical: 'travel',
    requiredPermissions: [{ module: 'visa', action: 'read' }],
  },
  {
    path: '/travel/inbound-leads',
    label: 'Inbound Leads',
    description: 'Webhook-ingested lead queue',
    category: 'Travel Operations',
    vertical: 'travel',
    requiredPermissions: [{ module: 'inbound_leads', action: 'read' }],
  },
  {
    path: '/travel/reviews',
    label: 'Reviews',
    description: 'Customer reviews + testimonials',
    category: 'Travel Marketing',
    vertical: 'travel',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },

  // ── Additional Admin Routes (Travel-only) ─────────────────────────
  {
    path: '/admin/brand-kits',
    label: 'Brand Kits',
    description: 'Sub-brand visual identity config',
    category: 'Admin',
    vertical: 'travel',
    requiredPermissions: [{ module: 'settings', action: 'manage' }],
  },
  {
    path: '/admin/csp-violations',
    label: 'CSP Violations',
    description: 'Content security policy logs',
    category: 'Security',
    requiredPermissions: [{ module: 'settings', action: 'write' }],
  },
  {
    path: '/admin/embed-allowlist',
    label: 'Embed Allowlist',
    description: 'iframe embed permissions',
    category: 'Security',
    requiredPermissions: [{ module: 'settings', action: 'write' }],
  },
  // ── Additional Generic Routes ──────────────────────────────────────
  {
    path: '/ab-tests',
    label: 'A/B Tests',
    description: 'Marketing experiment builder',
    category: 'Marketing',
    requiredPermissions: [{ module: 'ab_tests', action: 'read' }],
  },
  {
    path: '/agent-reports',
    label: 'Agent Reports',
    description: 'Staff performance analytics',
    category: 'Reports',
    vertical: 'generic',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
  },
  {
    path: '/booking-pages',
    label: 'Booking Pages',
    description: 'Customer booking form builder',
    category: 'Marketing',
    requiredPermissions: [{ module: 'booking_pages', action: 'read' }],
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

// Vertical-specific label overrides. Cross-vertical pages whose label should
// differ per tenant vertical are adjusted here after the base catalog is
// filtered, so search + wellness catalog-driven sidebars show the right name.
const VERTICAL_LABEL_OVERRIDES = {
  travel: {
    '/leads': 'Travel Leads',
    '/travel/leads': 'All Leads',
  },
};

function applyVerticalLabel(page, vertical) {
  const overrides = vertical && VERTICAL_LABEL_OVERRIDES[vertical];
  const label = overrides && overrides[page.path];
  if (!label) return page;
  return { ...page, label };
}

function getCatalog() {
  return PAGE_CATALOG.map((p) => ({
    ...p,
    requiredPermissions: p.requiredPermissions.map((perm) => ({ ...perm })),
  }));
}

/**
 * Returns the catalog filtered to entries relevant for the given
 * tenant vertical. Used by GET /api/pages/catalog so the Create-role
 * landingPath dropdown on a travel tenant doesn't show wellness routes
 * (and vice-versa) before the role's permissions are saved.
 *
 * Two-layer filtering — path-prefix inference for the bulk of entries,
 * explicit `vertical:` override for the exceptions where a wellness-
 * or travel-only surface lives at a cross-vertical path:
 *
 *   1. Explicit `vertical:` field on the entry (highest priority).
 *      Catches wellness-only surfaces at cross-vertical paths like
 *      `/portal` (Patient portal) or `/revenue-goals` (per-practitioner
 *      revenue targets) — neither path matches `/wellness/*` but both
 *      pages are semantically wellness.
 *
 *   2. Path-prefix inference (fallback):
 *      • `/wellness` + `/wellness/*` → wellness-only
 *      • `/travel`   + `/travel/*`   → travel-only
 *      • everything else → cross-vertical, always included
 *
 * Path-prefix beats blanket per-row tagging because the wellness
 * catalog predates the vertical split with 50+ entries — a blanket
 * inference avoids touching every row. New travel entries land under
 * `/travel/*` so the inference catches them automatically.
 *
 * Unknown vertical (null / "generic" / unrecognised) returns only the
 * cross-vertical core — neither wellness nor travel pages leak.
 */
function getCatalogForVertical(vertical) {
  return PAGE_CATALOG.filter((p) => {
    if (p.vertical) return p.vertical === vertical;
    const isWellness = p.path === '/wellness' || p.path.startsWith('/wellness/');
    if (isWellness) return vertical === 'wellness';
    const isTravel = p.path === '/travel' || p.path.startsWith('/travel/');
    if (isTravel) return vertical === 'travel';
    return true;
  }).map((p) => ({
    ...applyVerticalLabel(p, vertical),
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
 * Vertical filtering (added 2026-06-17): when `opts.vertical` is
 * supplied, the entries are first filtered through the same
 * vertical-aware rules getCatalogForVertical uses (explicit
 * `vertical:` tag → path-prefix → cross-vertical fallback). This
 * prevents wellness pages from leaking into the Travel Edit-role
 * landing-page dropdown when a role happens to hold a wellness
 * permission (e.g. a legacy or migrated grant). When `opts.vertical`
 * is omitted the behavior is unchanged — back-compat for callers
 * that don't need vertical scoping.
 *
 * @param {Set<string>} permissionSet
 * @param {{ isOwner?: boolean, vertical?: string|null }} [opts]
 */
function getAccessiblePages(permissionSet, opts = {}) {
  // Vertical-aware base pool. When no vertical is supplied, use the
  // full catalog (back-compat).
  const basePool = opts.vertical
    ? PAGE_CATALOG.filter((p) => {
        if (p.vertical) return p.vertical === opts.vertical;
        const isWellness = p.path === '/wellness' || p.path.startsWith('/wellness/');
        if (isWellness) return opts.vertical === 'wellness';
        const isTravel = p.path === '/travel' || p.path.startsWith('/travel/');
        if (isTravel) return opts.vertical === 'travel';
        return true;
      })
    : PAGE_CATALOG;
  if (opts.isOwner) {
    return basePool.map((p) => ({
      ...applyVerticalLabel(p, opts.vertical),
      requiredPermissions: p.requiredPermissions.map((perm) => ({ ...perm })),
    }));
  }
  if (!(permissionSet instanceof Set)) return [];
  return basePool.filter((p) => {
    if (p.requiredPermissions.length === 0) return true;
    return p.requiredPermissions.every(
      ({ module, action }) => permissionSet.has(`${module}.${action}`),
    );
  }).map((p) => ({
    ...applyVerticalLabel(p, opts.vertical),
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
  getCatalogForVertical,
  getPage,
  isKnownPage,
  getAccessiblePages,
  canAccessPath,
};
