/**
 * Widget catalogue — single source of truth for what widgets can be placed
 * on the /home dashboard. Mirrors permissionCatalog.js in spirit: the
 * frontend fetches this catalogue via `GET /api/widgets/catalog`, the
 * role-widget-layout PUT endpoint validates incoming widgetKey values
 * against it, and the actual rendering logic + UI lives in the frontend
 * widget registry (frontend/src/components/home/widgets/index.js).
 *
 * Each widget declares:
 *   key            — stable identifier saved to RoleWidget.widgetKey
 *   title          — display name in the configurator
 *   description    — one-line hint shown in the configurator
 *   category       — grouping in the configurator UI
 *   requiredPermissions — array of {module, action}; the widget only renders
 *                         for users with ALL of these permissions. Empty
 *                         array = visible to anyone.
 *   defaultRoleKeys — roles this widget is pre-configured for on first
 *                     setup of the layout (e.g. "today-appointments" defaults
 *                     to DOCTOR + RECEPTIONIST + NURSE). Empty = no defaults.
 *
 * Adding a new widget = add an entry here + add the rendering React
 * component to the frontend registry under the same `key`. Removing one
 * is safe (orphaned RoleWidget rows are simply skipped at render time).
 *
 * Vertical-aware (Phase 1, 2026-06-15): catalogue is split into a COMMON
 * core + per-vertical extension lists (WELLNESS_WIDGETS / TRAVEL_WIDGETS).
 * `GET /api/widgets/catalog` returns only the vertical-relevant subset so
 * a travel tenant's Roles → Widgets configurator doesn't show wellness
 * clinical widgets (Today's Appointments / Pending Prescriptions / etc.)
 * and a wellness tenant doesn't show travel widgets (Today's Departures /
 * Pending Quotes / etc.).
 *
 * Frontend components for travel widget keys are added separately as
 * Phase 2 — the renderer at Home.jsx:235 gracefully skips widgets with
 * no registered component, so catalog entries can land before components
 * without breaking /home.
 *
 * Backward compatibility:
 *   • WIDGET_CATALOG (the UNION) stays the validation surface for
 *     isValidWidgetKey — preserves any legacy RoleWidget row pointing
 *     at a cross-vertical key. The UI hides such rows in the configurator
 *     via the vertical-filtered catalog endpoint.
 *   • Existing exports (getCatalog / getWidget / getDefaultWidgetsForRoleKey)
 *     return the union shape every legacy caller already expects.
 *   • New helper — getCatalogForVertical(v) — gives the vertical-filtered
 *     shape used by the catalog endpoint.
 */

// ─────────────────────────────────────────────────────────────────────
// COMMON_WIDGETS — cross-vertical. Anything that works the same on
// every vertical (e.g. the auto-generated Quick Links launcher).
// ─────────────────────────────────────────────────────────────────────
const COMMON_WIDGETS = [
  {
    key: 'quick-links',
    title: 'Quick links',
    description: 'Every page your role can access, grouped by area.',
    category: 'Navigation',
    requiredPermissions: [],
    defaultRoleKeys: ['DOCTOR', 'NURSE', 'RECEPTIONIST', 'TELECALLER', 'USER'],
  },
];

// ─────────────────────────────────────────────────────────────────────
// WELLNESS_WIDGETS — clinical, front-desk, telecaller, wellness manager
// KPI, patient-portal. Existing surfaces — components shipped.
// ─────────────────────────────────────────────────────────────────────
const WELLNESS_WIDGETS = [
  // ── Clinical (Doctor / Nurse) ─────────────────────────────────────
  {
    key: 'today-appointments',
    title: "Today's Appointments",
    description: "Today's bookings for the signed-in practitioner.",
    category: 'Clinical',
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
    defaultRoleKeys: ['DOCTOR', 'NURSE', 'RECEPTIONIST'],
  },
  {
    key: 'next-patient',
    title: 'Next patient',
    description: 'Next patient on your schedule with name, age, service, allergies, last visit.',
    category: 'Clinical',
    requiredPermissions: [{ module: 'appointments', action: 'read' }, { module: 'patients', action: 'read' }],
    defaultRoleKeys: ['DOCTOR'],
  },
  {
    key: 'pending-prescriptions',
    title: 'Pending prescriptions',
    description: 'Prescriptions to finalise from prior visits.',
    category: 'Clinical',
    requiredPermissions: [{ module: 'prescriptions', action: 'read' }],
    defaultRoleKeys: ['DOCTOR'],
  },
  {
    key: 'consent-inbox',
    title: 'Consent forms awaiting signature',
    description: 'Consent forms not yet signed for booked patients.',
    category: 'Clinical',
    requiredPermissions: [{ module: 'consents', action: 'read' }],
    defaultRoleKeys: ['DOCTOR'],
  },
  {
    key: 'waiting-room',
    title: 'Patients waiting now',
    description: 'Patients checked in and waiting to be seen.',
    category: 'Clinical',
    requiredPermissions: [{ module: 'patients', action: 'read' }],
    defaultRoleKeys: ['DOCTOR', 'NURSE', 'RECEPTIONIST'],
  },

  // ── Front desk (Receptionist) ─────────────────────────────────────
  {
    key: 'full-clinic-calendar',
    title: 'Full clinic calendar',
    description: 'Day grid across all practitioners.',
    category: 'Front desk',
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
    defaultRoleKeys: ['RECEPTIONIST'],
  },
  {
    key: 'waitlist',
    title: 'Waitlist + walk-ins',
    description: 'Patients waiting for an open slot or to be allocated.',
    category: 'Front desk',
    // Post-split (v3.8.x): retargeted to the dedicated `waitlist`
    // module so the widget appears for any role with waitlist access,
    // not just roles that happen to also have the tenant-wide
    // appointments-list permission.
    requiredPermissions: [{ module: 'waitlist', action: 'read' }],
    defaultRoleKeys: ['RECEPTIONIST'],
  },
  {
    key: 'pending-payments',
    title: 'Pending payments at POS',
    description: 'Outstanding invoices ready for collection.',
    category: 'Front desk',
    requiredPermissions: [{ module: 'invoices', action: 'read' }],
    defaultRoleKeys: ['RECEPTIONIST'],
  },
  {
    key: 'birthday-anniversary',
    title: 'Birthdays + anniversaries today',
    description: "Patients celebrating today — good for a quick wish.",
    category: 'Front desk',
    requiredPermissions: [{ module: 'patients', action: 'read' }],
    defaultRoleKeys: ['RECEPTIONIST'],
  },

  // ── Telecaller ────────────────────────────────────────────────────
  {
    key: 'telecaller-queue',
    title: 'Telecaller queue',
    description: 'Hot leads + callbacks scheduled for today.',
    category: 'Telecaller',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
    defaultRoleKeys: ['TELECALLER'],
  },
  {
    key: 'missed-calls',
    title: 'Missed calls',
    description: 'Inbound calls to return.',
    category: 'Telecaller',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
    defaultRoleKeys: ['TELECALLER', 'RECEPTIONIST'],
  },
  {
    key: 'conversion-stats',
    title: 'Conversion stats',
    description: 'Day / week conversion rate.',
    category: 'Telecaller',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
    defaultRoleKeys: ['TELECALLER'],
  },

  // ── Owner / Manager KPI ──────────────────────────────────────────
  {
    key: 'revenue-vs-target',
    title: 'Revenue vs target',
    description: "Today's revenue against target.",
    category: 'Manager KPI',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'occupancy-by-practitioner',
    title: 'Occupancy by practitioner',
    description: 'Booked time vs available time per doctor.',
    category: 'Manager KPI',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'low-stock-alerts',
    title: 'Low-stock inventory alerts',
    description: 'Products at or below reorder level.',
    category: 'Manager KPI',
    requiredPermissions: [{ module: 'inventory', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER', 'NURSE'],
  },
  {
    key: 'pending-approvals',
    title: 'Pending approvals',
    description: 'Approvals awaiting your sign-off.',
    category: 'Manager KPI',
    requiredPermissions: [{ module: 'staff', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },

  // ── Patient portal ────────────────────────────────────────────────
  {
    key: 'next-appointment',
    title: 'Your next appointment',
    description: 'Upcoming visit with directions + arrival tips.',
    category: 'Patient',
    requiredPermissions: [{ module: 'appointments', action: 'read' }],
    defaultRoleKeys: ['CUSTOMER'],
  },
  {
    key: 'my-prescriptions',
    title: 'Your prescriptions',
    description: 'Active prescriptions + refill reminders.',
    category: 'Patient',
    requiredPermissions: [{ module: 'prescriptions', action: 'read' }],
    defaultRoleKeys: ['CUSTOMER'],
  },
];

// ─────────────────────────────────────────────────────────────────────
// TRAVEL_WIDGETS — operational / sales / finance / manager KPI surfaces
// for the travel vertical. requiredPermissions reference TRAVEL_MODULES
// from permissionCatalog.js so a role's widget visibility tracks its
// granted travel perms.
//
// Phase 1 caveat: frontend React components for these `key` values
// haven't shipped yet — Home.jsx's renderer at line 235 returns null
// for unknown component keys, so they appear in the configurator but
// don't render on /home. Configuring is non-destructive — saved
// RoleWidget rows wait safely for the Phase 2 component drop.
// `quick-links` (COMMON_WIDGETS) is the always-functional fallback.
// ─────────────────────────────────────────────────────────────────────
const TRAVEL_WIDGETS = [
  // ── Travel Operations ─────────────────────────────────────────────
  {
    key: 'travel-todays-departures',
    title: "Today's Departures",
    description: 'Trips departing today across all sub-brands.',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'trips', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-upcoming-trips',
    title: 'Upcoming trips (next 7 days)',
    description: 'Trips departing within the next week — last-minute prep checklist.',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'trips', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-todays-checkins',
    title: "Today's Web Check-ins",
    description: 'Web check-ins due today across all bookings.',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'web_checkins', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-passport-queue',
    title: 'Passport verification queue',
    description: 'OCR-scanned passports awaiting review.',
    category: 'Travel Operations',
    requiredPermissions: [{ module: 'passport', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },

  // ── Travel Sales ─────────────────────────────────────────────────
  {
    key: 'travel-new-inbound-leads',
    title: 'New inbound leads',
    description: 'Webhook-ingested leads from the last 24h pending triage.',
    category: 'Travel Sales',
    requiredPermissions: [{ module: 'inbound_leads', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-pending-quotes',
    title: 'Pending quotes',
    description: 'Quotes awaiting customer response — follow-up candidates.',
    category: 'Travel Sales',
    requiredPermissions: [{ module: 'quotes', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-quote-conversion',
    title: 'Quote conversion',
    description: 'Today / week quote → booking conversion rate.',
    category: 'Travel Sales',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-lead-pipeline',
    title: 'Lead pipeline snapshot',
    description: 'Lead counts by stage across sub-brands.',
    category: 'Travel Sales',
    requiredPermissions: [{ module: 'leads', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },

  // ── Travel Finance ───────────────────────────────────────────────
  {
    key: 'travel-ar-aging',
    title: 'A/R aging',
    description: 'Customer invoices by aging bucket (current / 30 / 60 / 90+).',
    category: 'Travel Finance',
    requiredPermissions: [{ module: 'invoices', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-payable-batches',
    title: 'Pending payables',
    description: 'Supplier payable batches awaiting approval.',
    category: 'Travel Finance',
    requiredPermissions: [{ module: 'payables', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-milestones-due',
    title: 'Payment milestones due',
    description: 'Payment milestones falling due this week across all invoices.',
    category: 'Travel Finance',
    requiredPermissions: [{ module: 'invoices', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-commission-outstanding',
    title: 'Outstanding supplier commissions',
    description: 'Commission balances owed by suppliers awaiting collection.',
    category: 'Travel Finance',
    requiredPermissions: [{ module: 'commission_profiles', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },

  // ── Travel Manager KPI ───────────────────────────────────────────
  {
    key: 'travel-revenue-snapshot',
    title: 'Revenue snapshot',
    description: 'Today / week / month booking revenue vs prior period.',
    category: 'Travel Manager KPI',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-lead-source-mix',
    title: 'Lead source mix',
    description: 'Lead inbound mix by channel + sub-brand.',
    category: 'Travel Manager KPI',
    requiredPermissions: [{ module: 'reports', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },
  {
    key: 'travel-supplier-performance',
    title: 'Supplier performance',
    description: 'On-time delivery + dispute counts by supplier.',
    category: 'Travel Manager KPI',
    requiredPermissions: [{ module: 'suppliers', action: 'read' }],
    defaultRoleKeys: ['ADMIN', 'MANAGER'],
  },

  // ── Customer self-service (travel portal) ────────────────────────
  {
    key: 'travel-my-upcoming-trip',
    title: 'Your next trip',
    description: 'Upcoming trip with departure info + boarding pass.',
    category: 'Customer',
    requiredPermissions: [{ module: 'trips', action: 'read' }],
    defaultRoleKeys: ['CUSTOMER'],
  },
  {
    key: 'travel-my-visa-status',
    title: 'Your visa application',
    description: 'Status + next-step prompts for any open visa application.',
    category: 'Customer',
    requiredPermissions: [{ module: 'visa', action: 'read' }],
    defaultRoleKeys: ['CUSTOMER'],
  },
];

// ─────────────────────────────────────────────────────────────────────
// Per-vertical catalogs + the union catalog used for validation /
// back-compat. Order in the union matters: legacy wellness widgets
// keep their existing positions (matters for the boot seeder + the
// /widgets/me OWNER short-circuit that returns catalog order).
// ─────────────────────────────────────────────────────────────────────
const WIDGET_CATALOG_WELLNESS = [...WELLNESS_WIDGETS, ...COMMON_WIDGETS];
const WIDGET_CATALOG_TRAVEL = [...TRAVEL_WIDGETS, ...COMMON_WIDGETS];
const WIDGET_CATALOG_GENERIC = [...COMMON_WIDGETS];

// Union — the validation surface. isValidWidgetKey accepts ANY entry
// regardless of vertical so legacy RoleWidget rows (e.g. a travel
// tenant carrying a stale `today-appointments` widget from a
// misconfigured import) stay valid; the UI hides them via the
// vertical-filtered catalog endpoint, no destructive migration needed.
const WIDGET_CATALOG = [...WELLNESS_WIDGETS, ...TRAVEL_WIDGETS, ...COMMON_WIDGETS];

const WIDGETS_BY_KEY = new Map(WIDGET_CATALOG.map((w) => [w.key, w]));

// Deep-clone a widget list so callers can't mutate the static
// catalogue. Pulled out so getCatalog (union) and
// getCatalogForVertical (filtered) share one implementation.
function cloneList(list) {
  return list.map((w) => ({
    ...w,
    requiredPermissions: w.requiredPermissions.map((p) => ({ ...p })),
    defaultRoleKeys: [...w.defaultRoleKeys],
  }));
}

function getCatalog() {
  return cloneList(WIDGET_CATALOG);
}

/**
 * Returns the widget catalogue filtered to the given tenant vertical.
 *   • vertical === 'wellness' → WELLNESS_WIDGETS + COMMON_WIDGETS
 *   • vertical === 'travel'   → TRAVEL_WIDGETS   + COMMON_WIDGETS
 *   • anything else (null / 'generic' / unknown) → COMMON_WIDGETS only
 * Used by GET /api/widgets/catalog so the Roles → Widgets configurator
 * on a travel tenant doesn't show wellness clinical widgets and vice
 * versa.
 */
function getCatalogForVertical(vertical) {
  switch (vertical) {
    case 'wellness':
      return cloneList(WIDGET_CATALOG_WELLNESS);
    case 'travel':
      return cloneList(WIDGET_CATALOG_TRAVEL);
    default:
      return cloneList(WIDGET_CATALOG_GENERIC);
  }
}

function isValidWidgetKey(key) {
  return typeof key === 'string' && WIDGETS_BY_KEY.has(key);
}

function getWidget(key) {
  return WIDGETS_BY_KEY.get(key) || null;
}

function getDefaultWidgetsForRoleKey(roleKey) {
  if (!roleKey) return [];
  return WIDGET_CATALOG.filter((w) => w.defaultRoleKeys.includes(roleKey)).map(
    (w) => w.key,
  );
}

module.exports = {
  WIDGET_CATALOG,
  COMMON_WIDGETS,
  WELLNESS_WIDGETS,
  TRAVEL_WIDGETS,
  WIDGET_CATALOG_WELLNESS,
  WIDGET_CATALOG_TRAVEL,
  WIDGET_CATALOG_GENERIC,
  getCatalog,
  getCatalogForVertical,
  isValidWidgetKey,
  getWidget,
  getDefaultWidgetsForRoleKey,
};
