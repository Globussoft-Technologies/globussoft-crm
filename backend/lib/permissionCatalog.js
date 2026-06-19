/**
 * Permission Catalog — Enterprise RBAC
 *
 * Defines all module × action permissions that can be granted to roles.
 * This is the source of truth for the RBAC system: only permissions listed
 * here can be assigned to roles. If a route checks a permission not in this
 * catalog, the middleware will reject it at validation time.
 *
 * Format: module (snake_case) → [ actions ]
 * Actions: read, write, update, delete, export, manage
 *
 * Multi-tenant: Each module is assumed tenant-scoped unless explicitly marked.
 *
 * Vertical-aware (Phase 1, 2026-06-15): the catalog is split into a COMMON
 * core + per-vertical extension maps (WELLNESS_MODULES / TRAVEL_MODULES).
 * `GET /api/roles/catalog` returns only the vertical-relevant subset so the
 * Roles & Permissions matrix on a travel tenant doesn't show wellness-only
 * surfaces (patients / prescriptions / inventory / etc.) and vice-versa.
 *
 * Backward compatibility:
 *   • PERMISSION_CATALOG (the UNION of common + wellness + travel) remains
 *     the validation surface — isValidPermission accepts any catalog entry
 *     regardless of vertical. Existing RolePermission rows referencing
 *     cross-vertical modules (e.g. a travel tenant carrying a stale
 *     `patients.read` grant) stay valid; the UI just hides them in the
 *     matrix via the vertical-filtered catalog endpoint.
 *   • Existing exports (getCatalog / getGroupedCatalog / PERMISSION_DOMAINS)
 *     keep returning the union shape every legacy caller already expects.
 *   • New helpers — getCatalogForVertical(v) / getGroupedCatalogForVertical(v)
 *     — give the vertical-filtered shape used by the catalog endpoint.
 *
 * Phase 1 explicitly does NOT decorate travel routes with requirePermission().
 * The travel-vertical perms below are display-only on the matrix; gating is
 * still verifyRole() at the route layer. Phase 2 will sweep in incremental
 * route-decoration partner-spec by partner-spec.
 */

// ─────────────────────────────────────────────────────────────────────
// COMMON_MODULES — shared by every vertical (generic / wellness / travel).
// Anything an admin can grant on EVERY tenant goes here.
// ─────────────────────────────────────────────────────────────────────
const COMMON_MODULES = {
  // CRM Core
  contacts: ['read', 'write', 'update', 'delete', 'export'],
  deals: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  leads: ['read', 'write', 'update', 'delete', 'export'],
  tasks: ['read', 'write', 'update', 'delete'],
  projects: ['read', 'write', 'update', 'delete'],
  pipeline: ['read', 'write', 'update', 'delete', 'manage'],
  quotes: ['read', 'write', 'update', 'delete', 'export'],
  forecasting: ['read', 'write', 'export'],
  quotas: ['read', 'write', 'update', 'delete'],

  // Communications
  communications: ['read', 'write', 'delete', 'export'],
  email: ['read', 'write', 'delete', 'export'],
  sms: ['read', 'write'],
  whatsapp: ['read', 'write'],

  // Marketing
  marketing: ['read', 'write', 'update', 'delete', 'export', 'manage'],

  // Service & Support
  tickets: ['read', 'write', 'update', 'delete', 'export'],
  knowledge_base: ['read', 'write', 'update', 'delete'],
  surveys: ['read', 'write', 'update', 'delete', 'export'],
  chatbots: ['read', 'write', 'delete', 'manage'],

  // Financial (shared subset — gift_cards + patient_wallets stay
  // wellness-only because they're the wellness-vertical surfaces from the
  // v3.8.x billing decomposition; Invoices is the cross-vertical surface).
  invoices: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  accounting: ['read', 'write', 'export'],
  payments: ['read', 'export'],
  expenses: ['read', 'write', 'update', 'delete', 'manage'],

  // Analytics
  reports: ['read', 'write', 'delete', 'export'],
  dashboards: ['read', 'write', 'delete'],
  analytics: ['read', 'export'],

  // Automation
  workflows: ['read', 'write', 'update', 'delete', 'manage'],
  sequences: ['read', 'write', 'update', 'delete'],

  // Documents
  documents: ['read', 'write', 'update', 'delete', 'export'],
  contracts: ['read', 'write', 'update', 'delete'],
  signatures: ['read', 'manage'],
  estimates: ['read', 'write', 'update', 'delete', 'export'],

  // Admin & Platform
  staff: ['read', 'write', 'update', 'delete', 'manage'],
  roles: ['read', 'manage'],
  settings: ['read', 'manage'],
  audit: ['read', 'export'],
  integrations: ['read', 'write', 'update', 'delete', 'manage'],
  developer: ['read', 'manage'],
};

// ─────────────────────────────────────────────────────────────────────
// WELLNESS_MODULES — clinical, inventory, attendance, leave, and the
// wellness-specific financial split (gift_cards / patient_wallets).
// ─────────────────────────────────────────────────────────────────────
const WELLNESS_MODULES = {
  // `billing` was split into three per-surface modules in v3.8.x so
  // admins can grant Invoices access without also granting Gift Cards or
  // Patient Wallets (and vice-versa). Invoices is in COMMON_MODULES; the
  // other two stay wellness-only. Identical six-action surface.
  gift_cards: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  patient_wallets: ['read', 'write', 'update', 'delete', 'export', 'manage'],

  patients: ['read', 'write', 'update', 'delete', 'export', 'manage'],
  // Tenant-wide Appointments LIST page (/wellness/appointments) — read/
  // write the every-appointment-in-the-clinic view. Owners / managers /
  // receptionists who triage the global queue need this; doctors who
  // only work their own slots do NOT (they use `my_appointments`).
  appointments: ['read', 'write', 'update', 'delete', 'export'],
  // `my_appointments` gates /wellness/my-appointments — the per-practitioner
  // view that's intentionally distinct from the tenant-wide list. Split out
  // so a doctor / nurse can be granted "see my own appointments" without
  // unlocking the whole-clinic list, and conversely so an admin can be
  // granted the tenant-wide list without polluting their nav with a
  // "My Appointments" page they'd never use (admins aren't assigned slots).
  my_appointments: ['read'],
  // `book_appointment` gates /wellness/book-appointment — the staff/
  // patient booking form. Telecallers / receptionists need this to
  // create new appointments on behalf of patients; doctors don't (slots
  // already exist for them); admins typically don't book themselves
  // either. Split out so the booking surface is independently grantable.
  book_appointment: ['write'],
  // `waitlist` gates /wellness/waitlist — the open-slot queue. Read
  // grants viewing the queue; write grants promote / disposition. Split
  // out so a telecaller can be granted waitlist management without also
  // getting the tenant-wide Appointments list.
  waitlist: ['read', 'write'],
  // `calendar` is intentionally separate from `appointments` so admins
  // can grant view-only access to the Calendar day-grid surface
  // (`calendar.read`) without also unlocking the Appointments list
  // (`appointments.read`), the Book Appointment form
  // (`book_appointment.write`), and the My Appointments page
  // (`my_appointments.read`). Calendar mutations (drag-to-reschedule,
  // slot-click-to-book, right-click-cancel) gate on `calendar.write`.
  // The backend's PHI gates accept any of these permission sets for the
  // underlying /api/wellness/visits endpoint so every grant flow works
  // end-to-end.
  calendar: ['read', 'write'],
  services: ['read', 'write', 'update', 'delete'],
  prescriptions: ['read', 'write', 'update', 'delete', 'export'],
  // `my_prescriptions` gates the patient-portal Prescriptions tab — the
  // per-patient view that lists ONLY the logged-in patient's own Rx and
  // lets them download their own PDFs. Distinct from `prescriptions.read`
  // (which is the staff-wide tenant view) so the patient-facing surface
  // can be granted / revoked independently. `.read` covers both list and
  // PDF download — no separate export action. Granted to the CUSTOMER
  // system role by default; backend enforcement at the portal handler
  // ALSO scopes by `patientId: req.patient.id` so cross-patient access
  // is structurally impossible even if RBAC misconfigures the grant.
  my_prescriptions: ['read'],
  // `my_bookings` gates /wellness/my-bookings — the patient-facing
  // appointment management page (upcoming / pending / completed /
  // cancelled, with View / Cancel / Reschedule actions). Distinct from
  // both `appointments.read` (staff-wide list) and `my_appointments.read`
  // (practitioner's own schedule) so the patient surface can be granted /
  // revoked independently. Granted to the CUSTOMER system role by
  // default. Backend enforcement at /portal/appointments handlers ALSO
  // scopes by `patientId: req.patient.id` so cross-patient access is
  // structurally impossible even if RBAC misconfigures the grant.
  my_bookings: ['read'],
  consents: ['read', 'write', 'update', 'delete'],
  visits: ['read', 'write', 'update', 'delete'],
  // `products` and `inventory` are deliberately separate modules.
  // `products` covers the master catalog (Product Categories, Product
  // master, Auto-consumption rules) — the "what" you can sell or
  // consume. `inventory` covers operational stock-movement (Vendors,
  // Receipts, Adjustments) — the "how much you have and how it
  // changed". A clinic might grant store managers `products.*`
  // (curating the catalogue) without giving them write access to the
  // stock ledger, or vice-versa.
  products: ['read', 'write', 'update', 'delete', 'manage'],
  inventory: ['read', 'write', 'update', 'delete', 'manage'],
  pos: ['read', 'write', 'manage'],

  // `attendance` gates /wellness/attendance — the clock-in / clock-out
  // + personal timesheet page. `.read` = view your own timesheet,
  // `.write` = clock in / out, `.manage` = view + edit other staff's
  // attendance and manage biometric devices (admin/manager only).
  // Split out so a CUSTOMER (patient) role can be denied this surface
  // entirely — the sidebar entry hides when the role lacks
  // `attendance.read`.
  attendance: ['read', 'write', 'manage'],
  // `leave` gates /wellness/leave — the leave-request + balance page.
  // `.read` = view your own balance + requests, `.write` = submit /
  // cancel your own requests, `.manage` = approve / reject and manage
  // leave policies + carry-forward runs (admin/manager only). Split out
  // so non-staff roles (CUSTOMER) can be denied; the API enforces
  // approval-tier gating via verifyRole independently of `.manage`.
  leave: ['read', 'write', 'manage'],
};

// ─────────────────────────────────────────────────────────────────────
// TRAVEL_MODULES — travel-vertical surfaces derived from actual code.
// Source of truth: backend/routes/travel_*.js + Sidebar.jsx's
// renderTravelNav(). Generic CRM modules (contacts / deals / leads /
// quotes / invoices / payments / reports / etc.) come from
// COMMON_MODULES; entries here are travel-only surfaces with no
// analogue in wellness or generic.
//
// Phase 1 scope: NOT yet decorated on routes (verifyRole + sub-brand
// guards still gate the API surface). The matrix shows these so admins
// can pre-configure RBAC posture for the Phase 2 sweep that adds
// requirePermission() per-route.
// ─────────────────────────────────────────────────────────────────────
const TRAVEL_MODULES = {
  // Sales & inbound funnel
  // `inbound_leads` gates the webhook-ingested operator queue at
  // /travel/inbound-leads (#904). Distinct from common `leads` because
  // the surface is the upstream ingestion view (raw webhook payloads
  // pre-conversion) — converted records land in `leads`.
  inbound_leads: ['read', 'write', 'manage'],
  diagnostics: ['read', 'write', 'update', 'delete', 'export'],
  // `pois` covers POI master + rep-suggested pending-approval queue
  // (#S99). `manage` gates the approve/reject actions on the queue.
  pois: ['read', 'write', 'update', 'delete', 'manage'],

  // Itineraries / templates / trips
  itineraries: ['read', 'write', 'update', 'delete', 'export'],
  itinerary_templates: ['read', 'write', 'update', 'delete'],
  quote_templates: ['read', 'write', 'update', 'delete'],
  // `trips` covers TMC sub-brand trip instances (school trips spawned
  // from `tmc_catalogue` templates).
  trips: ['read', 'write', 'update', 'delete', 'export'],
  tmc_catalogue: ['read', 'write', 'update', 'delete', 'manage'],

  // Pricing & costing
  cost_master: ['read', 'write', 'update', 'delete', 'manage'],
  pricing: ['read', 'write', 'update', 'delete', 'manage'],
  flight_quotes: ['read', 'write', 'update', 'delete', 'export'],
  sightseeing: ['read', 'write', 'update', 'delete'],

  // Suppliers & payables
  suppliers: ['read', 'write', 'update', 'delete', 'manage'],
  commission_profiles: ['read', 'write', 'update', 'delete', 'manage'],
  // `payables` covers the cross-supplier A/P review surface
  // (/travel/payables, #903) plus payable-batch ops + settlement
  // timeline. Includes `export` for CSV/Excel exports the operator
  // surface offers.
  payables: ['read', 'write', 'update', 'export'],
  cancellation_policies: ['read', 'write', 'update', 'delete', 'manage'],

  // Operations
  // `delete` added 2026-06-15 — required for DELETE /webcheckins/:id
  // (admin-only destruction of a stale check-in row). Mirrors the
  // delete-tier action available on other operational modules.
  web_checkins: ['read', 'write', 'update', 'delete'],
  // `passport` covers the OCR verification queue (/travel/passport-verification)
  // — read = view queue, write = upload + scan, update = correct OCR
  // output, manage = approve / reject (admin/manager).
  passport: ['read', 'write', 'update', 'manage'],
  // `visa` covers the Visa Sure sub-brand surfaces (dashboard, applications,
  // checklists, embassy rules). Phase 3 — most pages are scaffold shells.
  visa: ['read', 'write', 'update', 'delete', 'manage'],
  // `microsites` covers travel microsite admin (per-sub-brand consumer
  // landing pages, OTP-gated portals).
  microsites: ['read', 'write', 'update', 'delete', 'manage'],

  // Sub-brand specific (TMC school trips / RFU Umrah)
  // TMC vertical school-trip planning surfaces
  curriculum: ['read', 'write', 'update', 'delete'],
  school_terms: ['read', 'write', 'update', 'delete'],
  // RFU Umrah sub-brand surfaces
  religious_packets: ['read', 'write', 'update', 'delete'],
  rfu_profiles: ['read', 'write', 'update', 'delete'],

  // Marketing flyer surfaces (#908)
  flyer_studio: ['read', 'write', 'manage'],
  flyer_templates: ['read', 'write', 'update', 'delete'],
};

// ─────────────────────────────────────────────────────────────────────
// Per-vertical catalogs (what the matrix renders for each tenant type)
// ─────────────────────────────────────────────────────────────────────
const PERMISSION_CATALOG_GENERIC = { ...COMMON_MODULES };
const PERMISSION_CATALOG_WELLNESS = { ...COMMON_MODULES, ...WELLNESS_MODULES };
const PERMISSION_CATALOG_TRAVEL = { ...COMMON_MODULES, ...TRAVEL_MODULES };

// Union — the validation surface. isValidPermission accepts ANY entry
// here so DB rows referencing cross-vertical permissions (e.g. a travel
// tenant carrying a legacy `patients.read` grant from a misconfigured
// import) don't blow up at the validator. The UI hides cross-vertical
// entries via the vertical-filtered catalog endpoint — no destructive
// migration is needed.
const PERMISSION_CATALOG = {
  ...COMMON_MODULES,
  ...WELLNESS_MODULES,
  ...TRAVEL_MODULES,
};

// ─────────────────────────────────────────────────────────────────────
// Domain groupings — render order on the Roles & Permissions matrix.
// Split into common head + per-vertical body + shared Admin trailer so
// the Admin & Platform section always sits at the bottom regardless of
// vertical.
// ─────────────────────────────────────────────────────────────────────
const COMMON_DOMAINS_HEAD = [
  {
    domain: 'CRM Core',
    modules: ['contacts', 'deals', 'leads', 'tasks', 'projects', 'pipeline', 'quotes', 'forecasting', 'quotas'],
  },
  {
    domain: 'Communications',
    modules: ['communications', 'email', 'sms', 'whatsapp'],
  },
  {
    domain: 'Marketing',
    modules: ['marketing'],
  },
  {
    domain: 'Service & Support',
    modules: ['tickets', 'knowledge_base', 'surveys', 'chatbots'],
  },
  {
    domain: 'Financial',
    modules: ['invoices', 'accounting', 'payments', 'expenses'],
  },
  {
    domain: 'Analytics',
    modules: ['reports', 'dashboards', 'analytics'],
  },
  {
    domain: 'Automation',
    modules: ['workflows', 'sequences'],
  },
  {
    domain: 'Documents',
    modules: ['documents', 'contracts', 'signatures', 'estimates'],
  },
];

const ADMIN_DOMAIN = {
  domain: 'Admin & Platform',
  modules: ['staff', 'roles', 'settings', 'audit', 'integrations', 'developer'],
};

const WELLNESS_DOMAINS_BODY = [
  {
    domain: 'Wellness Financial',
    modules: ['gift_cards', 'patient_wallets'],
  },
  {
    domain: 'Wellness Clinical',
    modules: [
      'patients',
      'appointments',
      'my_appointments',
      'book_appointment',
      'waitlist',
      'calendar',
      'services',
      'prescriptions',
      'my_prescriptions',
      'my_bookings',
      'consents',
      'visits',
    ],
  },
  {
    domain: 'Wellness Inventory',
    modules: ['products', 'inventory', 'pos'],
  },
  {
    domain: 'Staff Self-Service',
    modules: ['attendance', 'leave'],
  },
];

const TRAVEL_DOMAINS_BODY = [
  {
    domain: 'Travel Sales',
    modules: ['inbound_leads', 'diagnostics', 'pois'],
  },
  {
    domain: 'Travel Itineraries & Trips',
    modules: ['itineraries', 'itinerary_templates', 'quote_templates', 'trips', 'tmc_catalogue'],
  },
  {
    domain: 'Travel Pricing',
    modules: ['cost_master', 'pricing', 'flight_quotes', 'sightseeing'],
  },
  {
    domain: 'Travel Suppliers',
    modules: ['suppliers', 'commission_profiles', 'payables', 'cancellation_policies'],
  },
  {
    domain: 'Travel Operations',
    modules: ['web_checkins', 'passport', 'visa', 'microsites'],
  },
  {
    domain: 'Travel Sub-brand',
    modules: ['curriculum', 'school_terms', 'religious_packets', 'rfu_profiles'],
  },
  {
    domain: 'Travel Marketing',
    modules: ['flyer_studio', 'flyer_templates'],
  },
];

const PERMISSION_DOMAINS_GENERIC = [...COMMON_DOMAINS_HEAD, ADMIN_DOMAIN];
const PERMISSION_DOMAINS_WELLNESS = [...COMMON_DOMAINS_HEAD, ...WELLNESS_DOMAINS_BODY, ADMIN_DOMAIN];
const PERMISSION_DOMAINS_TRAVEL = [...COMMON_DOMAINS_HEAD, ...TRAVEL_DOMAINS_BODY, ADMIN_DOMAIN];

// Union — preserved for back-compat with the legacy getGroupedCatalog()
// callers (the matrix's pre-fetch fallback path uses this union shape).
const PERMISSION_DOMAINS = [
  ...COMMON_DOMAINS_HEAD,
  ...WELLNESS_DOMAINS_BODY,
  ...TRAVEL_DOMAINS_BODY,
  ADMIN_DOMAIN,
];

// Build a grouped catalog (matrix-render shape) for an arbitrary
// (catalog, domains) pair. Pulled out so getGroupedCatalog (union) and
// getGroupedCatalogForVertical (filtered) share one implementation.
function buildGroupedCatalog(catalog, domains) {
  const moduleToDomain = new Map();
  for (const { domain, modules } of domains) {
    for (const m of modules) moduleToDomain.set(m, domain);
  }
  const groups = new Map();
  for (const { domain } of domains) groups.set(domain, []);
  groups.set('Other', []);
  for (const [module, actions] of Object.entries(catalog)) {
    const domain = moduleToDomain.get(module) || 'Other';
    groups.get(domain).push({ module, actions: [...actions] });
  }
  return Array.from(groups.entries())
    .filter(([, modules]) => modules.length > 0)
    .map(([domain, modules]) => ({ domain, modules }));
}

/**
 * Returns the union catalog grouped by domain — back-compat shape used
 * by callers that don't yet know about verticals (the legacy fallback
 * path, audit tooling, validation tests).
 */
function getGroupedCatalog() {
  return buildGroupedCatalog(PERMISSION_CATALOG, PERMISSION_DOMAINS);
}

function deepCloneCatalog(source) {
  return Object.fromEntries(
    Object.entries(source).map(([module, actions]) => [module, [...actions]]),
  );
}

/**
 * Returns the per-vertical catalog (module → [actions]) as a fresh
 * object so callers can mutate without poisoning the source.
 * Unknown / null vertical falls through to the generic catalog (safe
 * default — no wellness/travel-only modules surface in the matrix).
 */
function getCatalogForVertical(vertical) {
  // Deep clone (not a shallow spread) so callers can mutate the returned
  // catalog — including the per-module action arrays — without poisoning the
  // shared PERMISSION_CATALOG_* sources.
  switch (vertical) {
    case 'wellness':
      return structuredClone(PERMISSION_CATALOG_WELLNESS);
    case 'travel':
      return structuredClone(PERMISSION_CATALOG_TRAVEL);
    default:
      return structuredClone(PERMISSION_CATALOG_GENERIC);
  }
}

/**
 * Returns the per-vertical catalog grouped by domain (matrix-render
 * shape). Used by GET /api/roles/catalog so the Roles & Permissions
 * page on a travel tenant only shows COMMON + TRAVEL modules and on a
 * wellness tenant only shows COMMON + WELLNESS modules.
 */
function getGroupedCatalogForVertical(vertical) {
  const catalog = getCatalogForVertical(vertical);
  const domains =
    vertical === 'wellness'
      ? PERMISSION_DOMAINS_WELLNESS
      : vertical === 'travel'
        ? PERMISSION_DOMAINS_TRAVEL
        : PERMISSION_DOMAINS_GENERIC;
  return buildGroupedCatalog(catalog, domains);
}

/**
 * Validate a (module, action) pair against the UNION catalog.
 * Stays union-based deliberately so a role row referencing a cross-
 * vertical perm (e.g. legacy import noise) doesn't reject at validate
 * time — the UI hides such rows, the DB preserves them.
 */
function isValidPermission(module, action) {
  const actions = PERMISSION_CATALOG[module];
  if (!actions) return false;
  return actions.includes(action);
}

/**
 * Validate a (module, action) pair against the per-vertical catalog
 * (Bug 4 — Catalog Validation). Returns one of:
 *
 *   { ok: true }                               — module + action valid for vertical
 *   { ok: false, code: 'INVALID_MODULE', error } — module not in vertical catalog
 *   { ok: false, code: 'INVALID_ACTION', error } — module valid, action not
 *
 * Distinct from isValidPermission (union surface) so the role-write
 * endpoints can enforce vertical isolation post-cleanup. Routes wire
 * this in behind the RBAC_STRICT_VERTICAL_VALIDATION env flag — see
 * backend/routes/roles.js. Don't enable in production until the
 * cleanup-foreign-perms-report.js --apply pass has been verified for
 * every dirty tenant.
 *
 * Error messages match the exact strings the QA spec requested so
 * test assertions and frontend toast copy can pin them verbatim.
 */
function validatePermissionForVertical(module, action, vertical) {
  const catalog = getCatalogForVertical(vertical);
  const actions = catalog[module];
  if (!actions) {
    return {
      ok: false,
      code: 'INVALID_MODULE',
      error: `Module '${module}' is not valid for this tenant`,
    };
  }
  if (!actions.includes(action)) {
    return {
      ok: false,
      code: 'INVALID_ACTION',
      error: `Action '${action}' is not valid for module '${module}'`,
    };
  }
  return { ok: true };
}

/**
 * Convenience boolean form for call sites that don't need the error
 * detail. Use validatePermissionForVertical when you need to return
 * the user-facing message (which is most of the time inside route
 * handlers — keep the rich form).
 */
function isValidPermissionForVertical(module, action, vertical) {
  return validatePermissionForVertical(module, action, vertical).ok;
}

function getModules() {
  return Object.keys(PERMISSION_CATALOG);
}

function getActions(module) {
  return PERMISSION_CATALOG[module] || [];
}

function getCatalog() {
  // Deep clone — a shallow `{ ...PERMISSION_CATALOG }` shares the per-module
  // action ARRAYS, so a caller doing `catalog.contacts.push(...)` would poison
  // the source. structuredClone gives callers a fully-isolated copy.
  return structuredClone(PERMISSION_CATALOG);
}

module.exports = {
  PERMISSION_CATALOG,
  PERMISSION_DOMAINS,
  COMMON_MODULES,
  WELLNESS_MODULES,
  TRAVEL_MODULES,
  PERMISSION_CATALOG_GENERIC,
  PERMISSION_CATALOG_WELLNESS,
  PERMISSION_CATALOG_TRAVEL,
  PERMISSION_DOMAINS_GENERIC,
  PERMISSION_DOMAINS_WELLNESS,
  PERMISSION_DOMAINS_TRAVEL,
  isValidPermission,
  isValidPermissionForVertical,
  validatePermissionForVertical,
  getModules,
  getActions,
  getCatalog,
  getGroupedCatalog,
  getCatalogForVertical,
  getGroupedCatalogForVertical,
};
