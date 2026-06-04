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
 */

const WIDGET_CATALOG = [
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

  // ── Cross-role: auto-generated launcher of accessible pages ──────
  {
    key: 'quick-links',
    title: 'Quick links',
    description: 'Every page your role can access, grouped by area.',
    category: 'Navigation',
    requiredPermissions: [],
    defaultRoleKeys: ['DOCTOR', 'NURSE', 'RECEPTIONIST', 'TELECALLER', 'USER'],
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

const WIDGETS_BY_KEY = new Map(WIDGET_CATALOG.map((w) => [w.key, w]));

function getCatalog() {
  // Return a deep clone so callers can't mutate the static catalogue.
  return WIDGET_CATALOG.map((w) => ({
    ...w,
    requiredPermissions: w.requiredPermissions.map((p) => ({ ...p })),
    defaultRoleKeys: [...w.defaultRoleKeys],
  }));
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
  getCatalog,
  isValidWidgetKey,
  getWidget,
  getDefaultWidgetsForRoleKey,
};
