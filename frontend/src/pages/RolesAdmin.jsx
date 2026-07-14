import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useScrollLock } from '../hooks/useScrollLock';
import { createPortal } from 'react-dom';
import { AuthContext } from '../App';
import { LayoutGrid, Pencil, Plus, Shield, Trash2, Users, X, UserMinus, UserPlus, GripVertical, ChevronUp, ChevronDown } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { usePermissions, invalidatePermissionCache } from '../hooks/usePermissions';
import AccessDenied from '../components/AccessDenied';
// Bug 6 — single source of truth for the Role.key regex, helper text,
// and validator. Mirrors backend/lib/roleKey.js so the helper text
// shown to the admin can't drift from the regex the validator enforces.
import { ROLE_KEY_DESCRIPTION, validateRoleKey } from '../utils/roleKey';
// Unified history popup. Same component the /settings → Role Recovery
// section uses. Replaces a previous in-page PermissionsHistoryModal
// that was built on the shared <Modal> primitive — that primitive has
// a flex-sizing bug (missing min-height: 0 on the body) that hid the
// close affordance once the version list grew tall (Admin role's
// recurring "8+ versions, no Close button" symptom). Using
// RoleHistoryDialog ensures every role's history UI — current and
// future — renders identically here AND on the Settings page.
import RoleHistoryDialog from '../components/RoleHistoryDialog';

// Admin UI for the RBAC role + permission system. Mirrors the endpoints
// under /api/roles (see backend/routes/roles.js). Tenant scoping is enforced
// server-side — non-OWNER admins only see their own tenant's roles.
//
// Permission catalogue: the live matrix is fetched from
// `GET /api/roles/catalog` so the server's permissionCatalog stays the
// single source of truth (prevents the UI-vs-validator drift bug). The
// constant below is the fallback shape used (a) on first render before
// the fetch resolves, and (b) if a frontend deploy lands ahead of the
// catalog endpoint. Keep it loosely in sync with the catalog.
const PERMISSION_MODULES_FALLBACK = [
  { module: 'contacts',      actions: ['read', 'write', 'update', 'delete', 'export'] },
  { module: 'deals',         actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'leads',         actions: ['read', 'write', 'update', 'delete', 'export'] },
  { module: 'tasks',         actions: ['read', 'write', 'update', 'delete'] },
  { module: 'tickets',       actions: ['read', 'write', 'update', 'delete'] },
  { module: 'marketing',     actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'reports',       actions: ['read', 'write', 'delete', 'export'] },
  { module: 'invoices',         actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'gift_cards',       actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'patient_wallets',  actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'patients',      actions: ['read', 'write', 'update', 'delete', 'export', 'manage'] },
  { module: 'appointments',     actions: ['read', 'write', 'update', 'delete', 'export'] },
  { module: 'my_appointments',  actions: ['read'] },
  { module: 'book_appointment', actions: ['write'] },
  { module: 'waitlist',         actions: ['read', 'write'] },
  { module: 'prescriptions', actions: ['read', 'write', 'update', 'delete'] },
  { module: 'my_prescriptions', actions: ['read'] },
  { module: 'visits',        actions: ['read', 'write', 'update', 'delete'] },
  { module: 'products',      actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'inventory',     actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'pos',           actions: ['read', 'write', 'manage'] },
  { module: 'workflows',     actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'integrations',  actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'audit',         actions: ['read', 'export'] },
  { module: 'staff',         actions: ['read', 'write', 'update', 'delete', 'manage'] },
  { module: 'roles',         actions: ['read', 'manage'] },
  { module: 'settings',      actions: ['read', 'manage'] },
];

// Domain grouping shown in the Permissions modal. Mirrors PERMISSION_DOMAINS
// in backend/lib/permissionCatalog.js — the server is authoritative (it
// returns the live grouping via /api/roles/catalog `domains`), this
// fallback only fires before the fetch resolves or if the endpoint is on
// an older deploy. Any module the server returns that isn't in this map
// falls into an "Other" bucket at the bottom of the modal.
const PERMISSION_DOMAINS_FALLBACK = [
  { domain: 'CRM Core',           modules: ['contacts', 'deals', 'leads', 'tasks', 'projects', 'pipeline', 'quotes', 'forecasting', 'quotas'] },
  { domain: 'Communications',     modules: ['communications', 'email', 'sms', 'whatsapp'] },
  { domain: 'Marketing',          modules: ['marketing'] },
  { domain: 'Service & Support',  modules: ['tickets', 'knowledge_base', 'surveys', 'chatbots'] },
  { domain: 'Financial',          modules: ['invoices', 'gift_cards', 'patient_wallets', 'accounting', 'payments', 'expenses'] },
  { domain: 'Analytics',          modules: ['reports', 'dashboards', 'analytics'] },
  { domain: 'Automation',         modules: ['workflows', 'sequences'] },
  { domain: 'Documents',          modules: ['documents', 'contracts', 'signatures', 'estimates'] },
  { domain: 'Wellness Clinical',  modules: ['patients', 'appointments', 'my_appointments', 'book_appointment', 'waitlist', 'services', 'prescriptions', 'my_prescriptions', 'consents', 'visits'] },
  { domain: 'Wellness Inventory', modules: ['products', 'inventory', 'pos'] },
  { domain: 'Admin & Platform',   modules: ['staff', 'roles', 'settings', 'audit', 'integrations', 'developer'] },
];

// One-line description per module so admins know what each permission box
// actually controls. The "Unlocks: <pages>" hint built from /api/pages/catalog
// only fires when a SPA page declares the module in its requiredPermissions —
// e.g. `deals`, `projects`, `quotes`, `forecasting`, `quotas` are not pinned
// to a specific catalog page, so without these descriptions those cards look
// like bare checkboxes. Keep keys in sync with backend/lib/permissionCatalog.js.
const MODULE_DESCRIPTIONS = {
  // CRM Core
  contacts:       'People and companies stored in your CRM.',
  deals:          'Sales opportunities and revenue pipeline records.',
  leads:          'Prospects before they become contacts (incl. marketplace + telecaller queue).',
  tasks:          'To-dos assigned to users or linked to CRM records.',
  projects:       'Multi-step engagements grouping deals, tasks, and contacts.',
  pipeline:       'Sales pipeline stages and configuration.',
  quotes:         'Price quotes and CPQ documents sent to prospects.',
  forecasting:    'Revenue forecast roll-ups and weekly snapshots.',
  quotas:         'Sales targets assigned to users or teams.',
  // Communications
  communications: 'Unified inbox across email / SMS / WhatsApp.',
  email:          'Outbound email, templates, threading, and tracking.',
  sms:            'SMS messages, templates, and provider config.',
  whatsapp:       'WhatsApp Business Cloud API messages and templates.',
  // Marketing
  marketing:      'Marketing campaigns, audience segments, A/B tests, attribution.',
  // Service & Support
  tickets:        'Customer support tickets and SLA tracking.',
  knowledge_base: 'Help-center articles, categories, and visibility.',
  surveys:        'CSAT / NPS / custom surveys and responses.',
  chatbots:       'Live-chat bots, conversation flows, and handoff rules.',
  // Financial
  // Common modules with descriptions that vary per vertical live in
  // MODULE_DESCRIPTION_OVERRIDES below. The default copy here is
  // vertical-neutral so generic tenants see clean language and
  // wellness/travel tenants get their domain-specific phrasing via
  // the override map. Wellness-only modules (gift_cards,
  // patient_wallets) stay wellness-flavoured because they never
  // render on travel/generic tenants — the catalog filters them out.
  invoices:         'Customer invoice records and the Invoices page.',
  gift_cards:       'Gift card issuance ledger and the Gift Cards page.',
  patient_wallets:  'Patient pre-paid wallet balances, top-ups, and ledger.',
  accounting:     'Ledger sync and accounting integrations (Tally / QuickBooks / Xero).',
  payments:       'Payment records and transaction history.',
  expenses:       'Employee expenses, approvals, and reimbursements.',
  // Analytics
  reports:        'Saved business reports and scheduled report delivery.',
  dashboards:     'Custom analytics dashboards and KPI tiles.',
  analytics:      'Raw analytics queries and bulk exports.',
  // Automation
  workflows:      'Trigger-action automation rules across CRM objects.',
  sequences:      'Multi-step email/SMS drip cadences and enrollments.',
  // Documents
  documents:      'Document templates and generated PDFs.',
  contracts:      'Contract records, versions, and renewal tracking.',
  signatures:     'E-signature requests, signing flow, and audit trail.',
  estimates:      'Estimates / proposals sent to customers.',
  // Wellness Clinical
  patients:       'Patient demographics and clinical PHI records.',
  appointments:     'Tenant-wide appointments list (every appointment across the clinic).',
  my_appointments:  'Personal "My Appointments" page — only appointments where this user is the assigned practitioner.',
  book_appointment: 'Staff/patient appointment booking form (create new appointments on behalf of patients).',
  waitlist:         'Patient waitlist queue — view and promote / disposition waiting patients to open slots.',
  calendar:       'Day-grid calendar view (slot-click to book, drag to reschedule).',
  services:       'Service catalog, packages, and pricing.',
  prescriptions:  'Rx records, prescription PDFs, and dispense flow.',
  my_prescriptions: 'Patient-portal "My Prescriptions" tab — patients see only their own Rx list and can download their own PDFs.',
  consents:       'Signed consent forms and consent canvas signature capture.',
  visits:         'Visit logs, clinical notes, treatment plans, and photo timeline.',
  // Wellness Inventory
  products:       'Product master catalog, categories, and auto-consumption rules.',
  inventory:      'Stock movements — vendors, receipts, adjustments, stock ledger.',
  pos:            'Point-of-sale register, sales, petty cash, and shift control.',
  // Admin & Platform
  staff:          'User accounts, profiles, role assignments, and onboarding.',
  roles:          'RBAC roles and the per-role permission grants on this screen.',
  settings:       'Tenant-wide settings and configuration.',
  audit:          'Audit log read access and tamper-evidence verification.',
  integrations:   'Third-party integration setup (calendars, SSO, SCIM, webhooks).',
  developer:      'Developer tools, API keys, and platform diagnostics.',
  // Travel — Sales
  inbound_leads:        'Operator queue of webhook-ingested raw leads before conversion.',
  diagnostics:          'TMC readiness diagnostic forms, scoring engine, and public reports.',
  pois:                 'Point-of-interest master list and rep-suggested approval queue.',
  // Travel — Itineraries & Trips
  itineraries:          'Customer itinerary records, day-by-day plans, and accept flow.',
  itinerary_templates:  'Pre-loaded itinerary template library, versioning, and archive.',
  quote_templates:      'Reusable itinerary quote templates for fast turnaround.',
  trips:                'TMC sub-brand trip instances spawned from catalogue templates.',
  tmc_catalogue:        'TMC school-trip catalogue with human-verify gate.',
  // Travel — Pricing
  cost_master:          'Supplier cost catalogue (hotels, flights, transport, tours).',
  pricing:              'Pricing rules, markups, seasonal calendars, and final-price math.',
  flight_quotes:        'Flight quote requests, supplier responses, and selection.',
  sightseeing:          'Sightseeing / tour catalogue master and per-itinerary picks.',
  // Travel — Suppliers & Payables
  suppliers:            'Supplier master records (hotels, DMCs, airlines, transport, visa).',
  commission_profiles:  'Commission rate cards and tiered profiles per supplier.',
  payables:             'Cross-supplier accounts payable review, batches, and settlement.',
  cancellation_policies:'Cancellation policy templates and per-booking application.',
  // Travel — Operations
  web_checkins:         'Online check-in tracking for upcoming flights.',
  passport:             'OCR-driven passport verification queue and approvals.',
  visa:                 'Visa Sure sub-brand applications, checklists, and embassy rules.',
  microsites:           'Per-sub-brand consumer landing pages and OTP-gated portals.',
  // Travel — Sub-brand specific
  curriculum:           'TMC school-trip curriculum modules and learning outcomes.',
  school_terms:         'TMC school terms and academic calendar tagging.',
  religious_packets:    'RFU Umrah pilgrimage packets and group bookings.',
  rfu_profiles:         'RFU pilgrim profile records and travel preferences.',
  // Travel — Marketing
  flyer_studio:         'Marketing Flyer Studio — design and publish sub-brand flyers.',
  flyer_templates:      'Reusable flyer templates and brand-kit defaults.',
};

// Per-vertical description overrides for COMMON modules where the
// best one-line description varies by domain. Example: `invoices` is
// a common module that exists on every tenant, but the audience
// terminology differs — "Patient + customer" on wellness, "Customer +
// traveler" on travel, plain "Customer" on generic. Wellness-only and
// travel-only modules (patients / itineraries / etc.) stay in the
// base MODULE_DESCRIPTIONS map because their vertical is implicit —
// the catalog never surfaces them outside their own vertical.
//
// Lookup precedence: vertical override → base → empty. New entries
// go here ONLY when the description's phrasing actually changes
// based on the tenant's audience.
const MODULE_DESCRIPTION_OVERRIDES = {
  wellness: {
    invoices: 'Patient + customer invoice records and the Invoices page.',
  },
  travel: {
    invoices: 'Customer + traveler invoice records and the Invoices page.',
  },
};

// Vertical-aware lookup. Used by every render path that previously
// indexed MODULE_DESCRIPTIONS directly (tooltip, body description,
// search-corpus). Falls through to the base map for any module
// without a per-vertical override, and to `''` for unknown modules
// (matches the prior `|| ''` semantics).
function getModuleDescription(module, vertical) {
  const overrides =
    vertical && MODULE_DESCRIPTION_OVERRIDES[vertical]
      ? MODULE_DESCRIPTION_OVERRIDES[vertical]
      : null;
  if (overrides && overrides[module]) return overrides[module];
  return MODULE_DESCRIPTIONS[module] || '';
}

// RBAC Hardening Phase 3 — client mirror of backend/lib/rbacLockoutGuard.js
// CRITICAL_RBAC_PERMISSIONS. The frontend uses this set to surface a
// "Critical permission removal" warning when the admin's save would
// uncheck any of these. The backend's general lockout guard remains
// the load-bearing security gate; this modal is a UX courtesy that
// gives the admin a chance to reconsider before the 409 fires.
const CRITICAL_RBAC_KEYS = new Set(['roles.read', 'roles.manage']);
// Human-readable affected areas — drives the bullet list inside the
// warning modal so the admin sees the consequence in product terms,
// not catalog identifiers.
const CRITICAL_PERMISSION_AREAS = {
  'roles.read': {
    name: 'Roles & Permissions (view)',
    impact: 'Cannot see the Roles & Permissions page or any existing role',
  },
  'roles.manage': {
    name: 'Roles & Permissions (edit)',
    impact: 'Cannot create, edit, delete roles or assign permissions',
  },
};

// SPEC §6a (CRM Role Preset Specification) — client mirror of
// backend/lib/sensitivePermissions.js. Keep these two lists in lockstep:
// any addition here must also land server-side (the backend audit is
// what bills as the canonical record; this set just drives the
// pre-save confirmation modal). A drift between client and server is
// safe (server is authoritative), it would just mean the client either
// over- or under-warns relative to what gets audited. Reviewer note:
// if you add a sensitive perm to one file, grep the other.
const SENSITIVE_PERMISSIONS_CLIENT = new Set([
  // ROLES write — can change other people's access
  'roles.manage',
  // STAFF mutate-tier — can add / remove / modify staff
  'staff.write', 'staff.update', 'staff.delete', 'staff.manage',
  // SETTINGS / DEVELOPER / INTEGRATIONS write-tier
  'settings.manage',
  'developer.manage',
  'integrations.write', 'integrations.update', 'integrations.delete', 'integrations.manage',
  // INVOICES / GIFT_CARDS / PATIENT_WALLETS / ACCOUNTING mutate-tier —
  // financial exposure. (`billing` was decomposed into the three
  // surface-specific modules in v3.8.x; all three carry the same
  // sensitive write-tier surface.)
  'invoices.write', 'invoices.update', 'invoices.delete', 'invoices.manage',
  'gift_cards.write', 'gift_cards.update', 'gift_cards.delete', 'gift_cards.manage',
  'patient_wallets.write', 'patient_wallets.update', 'patient_wallets.delete', 'patient_wallets.manage',
  'accounting.write',
  // Clinical PII destruction
  'patients.delete',
  'prescriptions.delete',
  'consents.delete',
]);

// Friendly per-grant explanation shown in the confirmation modal. Helps
// the admin understand WHY the grant matters before they click Confirm.
// Falls back to a generic "Powerful permission" string if a grant is in
// SENSITIVE_PERMISSIONS_CLIENT but missing from this map — defence
// against the map silently drifting behind the catalog.
const SENSITIVE_PERMISSION_REASONS = {
  'roles.manage': 'Can change every other role’s permissions and assign roles to staff.',
  'staff.write': 'Can create new staff accounts in this tenant.',
  'staff.update': 'Can modify staff records (name, contact, role assignments).',
  'staff.delete': 'Can deactivate or remove staff accounts.',
  'staff.manage': 'Full staff administration (add, remove, configure).',
  'settings.manage': 'Can reconfigure tenant-wide settings (defaults, channels, branding).',
  'developer.manage': 'Can manage API keys, webhooks, and platform diagnostics.',
  'integrations.write': 'Can connect new third-party integrations.',
  'integrations.update': 'Can edit existing integration configurations.',
  'integrations.delete': 'Can disconnect third-party integrations.',
  'integrations.manage': 'Full integration administration.',
  'invoices.write': 'Can create patient and customer invoices.',
  'invoices.update': 'Can modify existing invoices (line items, totals, status).',
  'invoices.delete': 'Can void or remove invoice records.',
  'invoices.manage': 'Full invoice administration including write-offs and recurring billing.',
  'gift_cards.write': 'Can issue new gift cards.',
  'gift_cards.update': 'Can modify gift card balances, expiry, and assignment.',
  'gift_cards.delete': 'Can void gift card records.',
  'gift_cards.manage': 'Full gift card program administration.',
  'patient_wallets.write': 'Can top up or debit patient wallet balances.',
  'patient_wallets.update': 'Can adjust patient wallet entries and refund disputed transactions.',
  'patient_wallets.delete': 'Can remove patient wallet ledger entries.',
  'patient_wallets.manage': 'Full patient wallet administration.',
  'accounting.write': 'Can post to the accounting ledger / sync.',
  'patients.delete': 'Can permanently remove patient records (clinical PHI destruction).',
  'prescriptions.delete': 'Can permanently remove prescription records.',
  'consents.delete': 'Can permanently remove signed consent forms (compliance risk).',
};

// RBAC Hardening Phase 2 — derived severity classification for badge
// rendering inside the permissions matrix. Single source of truth:
//   • Critical = CRITICAL_RBAC_KEYS  (frontend mirror of backend
//     lib/rbacLockoutGuard.js — the perms whose removal triggers the
//     server's 409 LOCKOUT_PREVENTED guard).
//   • Caution  = SENSITIVE_PERMISSIONS_CLIENT \ CRITICAL_RBAC_KEYS
//     (frontend mirror of backend lib/sensitivePermissions.js — the
//     perms that surface the SensitiveGrantsConfirmModal on add).
//
// We classify by precedence (critical wins when both apply, e.g.
// roles.manage). The classifier is a pure function of the existing
// constants — no new UI-only allow-list. Adding a new sensitive perm
// upstream automatically lights up its caution badge here.
function getPermissionSeverity(key) {
  if (CRITICAL_RBAC_KEYS.has(key)) return 'critical';
  if (SENSITIVE_PERMISSIONS_CLIENT.has(key)) return 'caution';
  return null;
}

// Tooltip copy — spec-verbatim. Multi-line strings render with line
// breaks under `title=` in every modern browser (Chrome, Firefox,
// Safari, Edge). Kept short per the spec: three sentences max.
const CRITICAL_BADGE_TOOLTIP =
  'RBAC-critical permission.\n\n' +
  'Removing this can prevent users from administering roles and permissions.\n\n' +
  'The server will reject changes that would leave the tenant without RBAC administration access.';

const CAUTION_BADGE_TOOLTIP =
  'Operationally important permission.\n\n' +
  'Removing this may affect user management, onboarding, reporting, or other administrative workflows.\n\n' +
  'Review carefully before saving.';

// Badge styles — both stay in the amber family per the spec. Critical
// uses the filled treatment (stronger visual weight) and Caution the
// outlined treatment. No red — danger styling is reserved for actual
// destructive UX (delete buttons), not for relative-severity hints.
const CRITICAL_BADGE_STYLE = {
  marginLeft: 'auto',
  fontSize: '0.62rem',
  fontWeight: 700,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '0.12rem 0.42rem',
  borderRadius: 4,
  background: 'var(--warning-color, #f59e0b)',
  color: '#fff',
  whiteSpace: 'nowrap',
  cursor: 'help',
  // Stops the click from also toggling the parent <label>'s checkbox
  // when an admin tries to hover-read the tooltip.
  pointerEvents: 'auto',
};

const CAUTION_BADGE_STYLE = {
  marginLeft: 'auto',
  fontSize: '0.62rem',
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '0.1rem 0.4rem',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--warning-color, #f59e0b)',
  border: '1px solid var(--warning-color, #f59e0b)',
  whiteSpace: 'nowrap',
  cursor: 'help',
  pointerEvents: 'auto',
};

// Inline component — small enough that an extraction to a separate
// file would just add indirection. Always renders a span so callers
// can pass it through React.Children unchanged; returns null when the
// permission carries no classification.
function PermissionSeverityBadge({ severity, module, action, onClick }) {
  if (!severity) return null;
  const isCritical = severity === 'critical';
  return (
    <span
      // Unique per-permission testid for direct lookups + a severity
      // data-attribute for "is this perm critical/caution?" assertions.
      // Tests assert badge presence via the specific testid; the
      // severity data-attribute is the public contract for
      // "what classification did this perm get?".
      data-testid={`perm-badge-${module}-${action}`}
      data-severity={severity}
      data-perm={`${module}.${action}`}
      title={isCritical ? CRITICAL_BADGE_TOOLTIP : CAUTION_BADGE_TOOLTIP}
      style={isCritical ? CRITICAL_BADGE_STYLE : CAUTION_BADGE_STYLE}
      // The label's flex parent gives the badge a cursor: pointer
      // inherited from its parent. Override + stop the click from
      // toggling the checkbox when the admin clicks the badge for a
      // tooltip-like read (mobile: tap-to-show-title-via-iOS-popup).
      onClick={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (onClick) onClick(ev);
      }}
      aria-label={
        isCritical
          ? `Critical RBAC permission: ${module}.${action}`
          : `Caution: ${module}.${action} is an operationally important permission`
      }
    >
      {isCritical ? '🛡 Critical' : '⚠ Caution'}
    </span>
  );
}

// One-line description per action verb, surfaced as the hover tooltip on
// each checkbox. Generic across modules — "read on patients" and "read on
// deals" both grant the same shape of access, so a single canonical
// description keeps the modal compact instead of N×6 per-cell strings.
const ACTION_DESCRIPTIONS = {
  read:   'View records and lists in this module.',
  write:  'Create new records in this module.',
  update: 'Edit existing records in this module.',
  delete: 'Remove records in this module (typically soft-delete).',
  export: 'Download or export module data to CSV / PDF / Excel.',
  manage: 'Full administrative control — settings, bulk ops, and destructive admin actions.',
};

export default function RolesAdmin() {
  const {
    hasPermission,
    isLoading: permLoading,
    refresh: refreshPermissions,
  } = usePermissions();
  const canRead = hasPermission('roles', 'read');
  const canManage = hasPermission('roles', 'manage');

  // Active tenant's vertical drives the per-vertical module
  // description overrides (wellness/travel/generic). Passed into
  // PermissionsModal so its tooltips, body descriptions, and search
  // corpus all read the audience-appropriate phrasing — e.g. the
  // invoices description on travel reads "Customer + traveler …"
  // instead of leaking "Patient + customer …" from wellness.
  const { tenant } = useContext(AuthContext) || {};
  const tenantVertical = (tenant && tenant.vertical) || 'generic';

  const [roles, setRoles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [permissionModules, setPermissionModules] = useState(
    PERMISSION_MODULES_FALLBACK,
  );
  const [permissionDomains, setPermissionDomains] = useState(
    PERMISSION_DOMAINS_FALLBACK,
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [permRole, setPermRole] = useState(null);
  const [usersRole, setUsersRole] = useState(null);
  const [editRole, setEditRole] = useState(null);
  const [widgetsRole, setWidgetsRole] = useState(null);

  const notify = useNotify();

  const loadRoles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchApi('/api/roles');
      setRoles(Array.isArray(res?.roles) ? res.roles : []);
    } catch (err) {
      setError(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch the server's permission catalog so the matrix can never offer a
  // checkbox the validator will reject. If the endpoint is unavailable
  // (older backend), the fallback constant keeps the page functional.
  useEffect(() => {
    if (permLoading || !canRead) return;
    let cancelled = false;
    fetchApi('/api/roles/catalog')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.modules) ? res.modules : null;
        if (list && list.length) setPermissionModules(list);
        // Server-authoritative domain grouping — fall through to the
        // fallback constant when the server is on an older deploy that
        // doesn't return the `domains` field yet.
        const domains = Array.isArray(res?.domains) ? res.domains : null;
        if (domains && domains.length) {
          // Server returns [{ domain, modules: [{module, actions}] }]. The
          // modal only needs the domain → moduleNames mapping; the action
          // shape comes from `permissionModules` (which is keyed by name).
          setPermissionDomains(
            domains.map((d) => ({
              domain: d.domain,
              modules: (d.modules || []).map((m) => m.module),
            })),
          );
        }
      })
      .catch(() => {
        // Stay on the fallback; fetchApi already surfaced any toast.
      });
    return () => {
      cancelled = true;
    };
  }, [permLoading, canRead]);

  useEffect(() => {
    if (!permLoading && canRead) loadRoles();
  }, [permLoading, canRead, loadRoles]);

  if (permLoading) {
    return (
      <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>
        Loading…
      </div>
    );
  }
  if (!canRead) {
    return <AccessDenied permission={{ module: 'roles', action: 'read' }} />;
  }

  const refreshAll = async () => {
    invalidatePermissionCache();
    await Promise.all([refreshPermissions().catch(() => {}), loadRoles()]);
    // Tell the Sidebar (and any other component listening) to re-fetch
    // /api/pages/me. Without this the sidebar's accessible-pages list
    // would stay frozen on the snapshot taken at mount until a hard
    // refresh — admins editing permissions wouldn't see the section
    // appear/disappear without reloading. Listener wired in Sidebar.jsx.
    window.dispatchEvent(new CustomEvent('sidebar:pages-changed'));
  };

  const handleDelete = async (role) => {
    const ok = await notify.confirm({
      title: 'Delete role',
      message: `Delete role "${role.name}"? Users assigned to this role will lose its permissions.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/roles/${role.id}`, { method: 'DELETE' });
      notify.success?.(`Role "${role.name}" deleted`);
      await refreshAll();
    } catch {
      // fetchApi already showed a toast; nothing else needed.
    }
  };

  return (
    <div style={{ padding: '1.5rem', width: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
          marginBottom: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h1 style={{ marginBottom: '0.25rem' }}>Roles &amp; permissions</h1>
          <p
            style={{
              color: 'var(--text-secondary)',
              fontSize: '0.875rem',
              margin: 0,
            }}
          >
            Manage RBAC roles and their permission grants for this tenant.
            System roles cannot be modified.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <Plus size={16} /> New role
          </button>
        )}
      </div>

      {error && !isLoading && (
        <div
          role="alert"
          style={{
            background: 'rgba(239,68,68,0.1)',
            color: '#ef4444',
            padding: '0.75rem',
            borderRadius: 8,
            marginBottom: '1rem',
          }}
        >
          Could not load roles: {error.message}
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          overflow: 'auto',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.9rem',
            // Bumped from 760 → 1100 after adding the Landing path column +
            // 3-button Actions cell. Below 1100 the parent's overflow:auto
            // kicks in and gives a horizontal scrollbar on phones/tablets
            // rather than wrapping each header into 2 lines.
            minWidth: 1100,
            tableLayout: 'auto',
          }}
        >
          <thead>
            <tr
              style={{
                background: 'var(--subtle-bg-3)',
                textAlign: 'left',
              }}
            >
              <Th>Role</Th>
              <Th>Key</Th>
              <Th>User type</Th>
              <Th>Type</Th>
              <Th>Landing path</Th>
              <Th>Users</Th>
              <Th>Permissions</Th>
              <Th>Actions</Th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <Td colSpan={8} center>
                  Loading roles…
                </Td>
              </tr>
            )}
            {!isLoading && roles.length === 0 && (
              <tr>
                <Td colSpan={8} center>
                  No roles yet.
                </Td>
              </tr>
            )}
            {!isLoading &&
              roles.map((r) => (
                <tr
                  key={r.id}
                  style={{ borderTop: '1px solid var(--border-color)' }}
                >
                  <Td>
                    <strong>{r.name}</strong>
                    {r.description && (
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {r.description}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <code style={{ fontSize: '0.8rem' }}>{r.key}</code>
                  </Td>
                  <Td>{r.userType || 'STAFF'}</Td>
                  <Td>
                    {r.isSystem ? (
                      <Badge color="amber">System</Badge>
                    ) : (
                      <Badge color="blue">Custom</Badge>
                    )}
                  </Td>
                  <Td>
                    {r.landingPath ? (
                      <code style={{ fontSize: '0.8rem' }}>{r.landingPath}</code>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        (default)
                      </span>
                    )}
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setUsersRole(r)}
                      style={linkBtn}
                      aria-label={`View ${r.userCount ?? 0} users in ${r.name}`}
                    >
                      <Users size={14} /> {r.userCount ?? 0}
                    </button>
                  </Td>
                  <Td>
                    {/* Show the effective permission count — the perms
                        in the current vertical catalog that the editor
                        actually renders. Backend echoes
                        visiblePermissionCount; fall back to the raw
                        length if a stale server omits it. */}
                    {(() => {
                      const raw = Array.isArray(r.permissions) ? r.permissions.length : 0;
                      const visible = typeof r.visiblePermissionCount === 'number'
                        ? r.visiblePermissionCount
                        : raw;
                      const title = `${visible} permission${visible === 1 ? '' : 's'}`;
                      return (
                        <button
                          type="button"
                          onClick={() => setPermRole(r)}
                          style={linkBtn}
                          aria-label={`View permissions for ${r.name}`}
                          title={title}
                        >
                          <Shield size={14} /> {visible}
                        </button>
                      );
                    })()}
                  </Td>
                  <Td>
                    {canManage ? (
                      <div
                        style={{
                          display: 'flex',
                          gap: '0.4rem',
                          flexWrap: 'nowrap',
                          alignItems: 'center',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setEditRole(r)}
                          className="btn-secondary"
                          style={actionBtnStyle}
                          aria-label={`Edit ${r.name}`}
                        >
                          <Pencil size={14} /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => setWidgetsRole(r)}
                          className="btn-secondary"
                          style={actionBtnStyle}
                          aria-label={`Configure home widgets for ${r.name}`}
                        >
                          <LayoutGrid size={14} /> Widgets
                        </button>
                        {/* Bug 2 — system role identity is immutable.
                            Delete is disabled with an explanatory
                            tooltip; backend returns 403 if a stale
                            client tries anyway. Custom roles keep the
                            normal Delete button. */}
                        <button
                          type="button"
                          onClick={() => handleDelete(r)}
                          className="btn-secondary"
                          style={{
                            ...actionBtnStyle,
                            ...(r.isSystem
                              ? { opacity: 0.5, cursor: 'not-allowed' }
                              : null),
                          }}
                          disabled={r.isSystem}
                          aria-disabled={r.isSystem ? 'true' : undefined}
                          title={
                            r.isSystem
                              ? `${r.key} is a system role — its identity (key, userType, existence) cannot be modified. Permissions, widgets, and landing page can still be edited.`
                              : `Delete role ${r.name}`
                          }
                          data-testid={`role-delete-${r.key}`}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    ) : (
                      <span
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        —
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateRoleModal
          onClose={() => setCreateOpen(false)}
          onSuccess={async () => {
            setCreateOpen(false);
            await loadRoles();
          }}
        />
      )}
      {permRole && (
        <PermissionsModal
          role={permRole}
          modules={permissionModules}
          domains={permissionDomains}
          readOnly={!canManage}
          vertical={tenantVertical}
          onClose={() => setPermRole(null)}
          onSaved={async () => {
            await refreshAll();
            setPermRole(null);
          }}
        />
      )}
      {usersRole && (
        <UsersModal
          role={usersRole}
          canManage={canManage}
          onClose={() => setUsersRole(null)}
          onChange={() => refreshAll()}
        />
      )}
      {editRole && (
        <EditRoleModal
          role={editRole}
          onClose={() => setEditRole(null)}
          onSuccess={async () => {
            setEditRole(null);
            await loadRoles();
          }}
        />
      )}
      {widgetsRole && (
        <WidgetsModal
          role={widgetsRole}
          onClose={() => setWidgetsRole(null)}
          onSaved={() => setWidgetsRole(null)}
        />
      )}
    </div>
  );
}

// ───────────────────────── Create role modal ─────────────────────────

function CreateRoleModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({
    name: '',
    key: '',
    description: '',
    userType: 'STAFF',
    landingPath: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState({});
  const notify = useNotify();

  // Bug 6 — blur-time validation. The submit gate below still re-runs
  // validateRoleKey so a programmatic submit can't bypass it, but the
  // blur signal gives the admin instant feedback the moment the field
  // loses focus instead of waiting for the Create click.
  const handleKeyBlur = () => {
    const trimmed = form.key.trim();
    if (!trimmed) return; // empty handled by submit-time required guard
    const err = validateRoleKey(trimmed);
    setErrors((prev) => ({ ...prev, key: err || undefined }));
  };

  const submit = async (ev) => {
    ev.preventDefault();
    setError('');
    const fieldErrors = {};
    if (!form.name.trim()) fieldErrors.name = 'Required';
    // Bug 6 — shared validator. Backend uses the identical function so
    // helper text, blur error, submit error, and server response all
    // read the same message.
    const keyError = validateRoleKey(form.key);
    if (keyError) fieldErrors.key = keyError;
    const landingPathErr = validateLandingPathClient(form.landingPath);
    if (landingPathErr) fieldErrors.landingPath = landingPathErr;
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;

    setIsLoading(true);
    try {
      await fetchApi('/api/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          key: form.key.trim().toUpperCase(),
          description: form.description.trim() || undefined,
          userType: form.userType,
          landingPath: form.landingPath.trim() || null,
        }),
      });
      notify.success?.(`Role "${form.name.trim()}" created`);
      onSuccess();
    } catch (err) {
      setError(err.message || 'Could not create role');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalShell title="Create a new role" onClose={onClose} width={520}>
      <form onSubmit={submit} noValidate>
        <Field label="Display name" error={errors.name}>
          <input
            type="text"
            className="input-field"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Receptionist"
            disabled={isLoading}
            required
          />
        </Field>
        <Field
          label="Key"
          error={errors.key}
          help={`Unique within this tenant. ${ROLE_KEY_DESCRIPTION}`}
        >
          <input
            type="text"
            className="input-field"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
            onBlur={handleKeyBlur}
            placeholder="e.g. RECEPTIONIST"
            disabled={isLoading}
            required
            data-testid="create-role-key-input"
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            className="input-field"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="What this role is for"
            disabled={isLoading}
            style={{ resize: 'vertical', minHeight: 60 }}
          />
        </Field>
        <Field label="User type" help="Which kind of user this role can be assigned to.">
          <select
            className="input-field"
            value={form.userType}
            onChange={(e) => setForm({ ...form, userType: e.target.value })}
            disabled={isLoading}
          >
            <option value="STAFF">Staff</option>
            <option value="CUSTOMER">Customer</option>
          </select>
        </Field>
        <LandingPathField
          value={form.landingPath}
          onChange={(value) => setForm({ ...form, landingPath: value })}
          disabled={isLoading}
          error={errors.landingPath}
        />
        {error && (
          <div role="alert" style={errBoxStyle}>{error}</div>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={isLoading}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={isLoading}>
            {isLoading ? 'Creating…' : 'Create role'}
          </button>
        </ModalActions>
      </form>
    </ModalShell>
  );
}

// ───────────────────────── Edit role modal ───────────────────────────

function EditRoleModal({ role, onClose, onSuccess }) {
  const [form, setForm] = useState({
    name: role.name || '',
    description: role.description || '',
    landingPath: role.landingPath || '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState({});
  const notify = useNotify();

  const submit = async (ev) => {
    ev.preventDefault();
    setError('');
    const fieldErrors = {};
    if (!form.name.trim()) fieldErrors.name = 'Required';
    const landingPathErr = validateLandingPathClient(form.landingPath);
    if (landingPathErr) fieldErrors.landingPath = landingPathErr;
    setErrors(fieldErrors);
    if (Object.keys(fieldErrors).length) return;

    setIsLoading(true);
    try {
      await fetchApi(`/api/roles/${role.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || null,
          landingPath: form.landingPath.trim() || null,
        }),
      });
      notify.success?.(`Role "${form.name.trim()}" updated`);
      onSuccess();
    } catch (err) {
      setError(err.message || 'Could not update role');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ModalShell
      title={`Edit role: ${role.name}`}
      subtitle="Key + system flag are immutable. Permissions are edited separately."
      onClose={onClose}
      width={520}
    >
      <form onSubmit={submit} noValidate>
        <Field label="Display name" error={errors.name}>
          <input
            type="text"
            className="input-field"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            disabled={isLoading}
            required
          />
        </Field>
        <Field label="Key" help="Immutable — keys are part of the audit trail.">
          <input
            type="text"
            className="input-field"
            value={role.key}
            disabled
            readOnly
            style={{ opacity: 0.7 }}
          />
        </Field>
        <Field label="Description (optional)">
          <textarea
            className="input-field"
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            disabled={isLoading}
            style={{ resize: 'vertical', minHeight: 60 }}
          />
        </Field>
        <LandingPathField
          value={form.landingPath}
          onChange={(value) => setForm({ ...form, landingPath: value })}
          disabled={isLoading}
          error={errors.landingPath}
          roleId={role.id}
        />
        {error && (
          <div role="alert" style={errBoxStyle}>{error}</div>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={isLoading}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={isLoading}>
            {isLoading ? 'Saving…' : 'Save changes'}
          </button>
        </ModalActions>
      </form>
    </ModalShell>
  );
}

// ───────────────────── Landing path field (shared) ───────────────────

function LandingPathField({ value, onChange, disabled, error, roleId }) {
  // The dropdown is dynamically populated from /api/roles/:id/accessible-
  // pages — only pages this role has the required permissions for show
  // up. When roleId is undefined (Create flow, before the role exists),
  // we fall back to /api/pages/catalog so admin can still pick something;
  // the server PUT will reject if the chosen page doesn't match the new
  // role's perms.
  const [pages, setPages] = useState([]);
  const [loadingPages, setLoadingPages] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingPages(true);
    const endpoint = roleId
      ? `/api/roles/${roleId}/accessible-pages`
      : '/api/pages/catalog';
    fetchApi(endpoint)
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.pages)
          ? res.pages
          : Array.isArray(res?.catalog)
            ? res.catalog
            : [];
        setPages(list);
        setLoadingPages(false);
      })
      .catch(() => {
        if (cancelled) return;
        setPages([]);
        setLoadingPages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  // Group by category for a structured dropdown.
  const byCategory = pages.reduce((acc, p) => {
    (acc[p.category] = acc[p.category] || []).push(p);
    return acc;
  }, {});

  // If the currently-saved path isn't in the dropdown list (e.g. perms
  // were revoked since it was set), surface that to the admin instead of
  // silently dropping the value.
  const valueIsKnown = !value || pages.some((p) => p.path === value);

  return (
    <Field
      label="Landing page"
      error={error}
      help={
        roleId
          ? "Pages users with this role land on after login. Only pages this role's permissions grant access to are listed."
          : "Save the role first to pick from its accessible pages. For now the full catalog is shown."
      }
    >
      <select
        className="input-field"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || loadingPages}
        style={{ width: '100%' }}
        data-testid="role-landing-path-select"
      >
        <option value="">— Use tenant default ({roleId ? '/home' : '/dashboard'}) —</option>
        {!valueIsKnown && (
          <option value={value} disabled style={{ color: '#dc2626' }}>
            {value} (no longer accessible — pick another or save to clear)
          </option>
        )}
        {Object.entries(byCategory).map(([category, items]) => (
          <optgroup key={category} label={category}>
            {items.map((p) => (
              <option key={p.path} value={p.path}>
                {p.label} — {p.path}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {loadingPages && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
          Loading accessible pages…
        </div>
      )}
      {!loadingPages && pages.length === 0 && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: 4 }}>
          This role has no accessible pages yet. Grant permissions in the Permissions matrix first.
        </div>
      )}
    </Field>
  );
}

// Mirrors backend/routes/roles.js validateLandingPath. Keep in sync — the
// server enforces this too so a stale frontend can't bypass it.
function validateLandingPathClient(value) {
  if (!value || value.trim() === '') return null;
  const trimmed = value.trim();
  if (trimmed.length > 200) return 'Too long (max 200 chars)';
  if (!/^\/[A-Za-z0-9_\-/?=&.,%:]*$/.test(trimmed)) {
    return 'Must be a relative SPA path starting with /';
  }
  if (trimmed.startsWith('//')) return 'Cannot start with //';
  return null;
}

// ──────────────────────── Permissions matrix modal ───────────────────

function PermissionsModal({ role, modules, domains, readOnly, vertical, onClose, onSaved }) {
  const matrix =
    Array.isArray(modules) && modules.length
      ? modules
      : PERMISSION_MODULES_FALLBACK;
  const domainList =
    Array.isArray(domains) && domains.length
      ? domains
      : PERMISSION_DOMAINS_FALLBACK;
  // Build the set of currently-catalogued "module.action" strings so we
  // can filter the role's stored grants through it. A grant whose module
  // is no longer in the catalog (e.g. `billing.delete` after the v3.8.x
  // split into invoices / gift_cards / patient_wallets) has no checkbox
  // in the matrix, so the admin can't uncheck it — but if we leave it
  // in `selected`, save serialises it and the bulk-update endpoint 400s
  // with "Invalid permission: <legacy>.<action>". Filtering on hydrate
  // means the UI's state matches what's actually renderable, and the
  // next save cleanly drops the dead grants via the endpoint's atomic
  // replace.
  const catalogKeys = useMemo(() => {
    const s = new Set();
    for (const m of matrix) {
      for (const a of m.actions || []) s.add(`${m.module}.${a}`);
    }
    return s;
  }, [matrix]);

  // Hydrate from role.permissions (the list endpoint already includes
  // them). Only matrix-catalog permissions drive the checkboxes; grants
  // for modules outside the current vertical catalog are inert noise
  // from pre-2026-06-15 seed pollution and get cleaned up on the next
  // save (the PUT is full-replace). Backend is tenant-scoped at every
  // write endpoint, so this can never affect another tenant.
  const initial = useMemo(() => {
    const visible = new Set();
    (role.permissions || []).forEach((p) => {
      const m = p?.module;
      const a = p?.action;
      if (!m || !a) return;
      const key = `${m}.${a}`;
      if (catalogKeys.has(key)) visible.add(key);
    });
    return visible;
  }, [role, catalogKeys]);

  const [selected, setSelected] = useState(initial);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  // Search query filters the matrix on module name, description,
  // page-catalog labels (the "Unlocks: …" line), and action names.
  // Case-insensitive, substring match. Empty query renders everything.
  // Filters DON'T touch `selected` — toggles on a search hit preserve
  // grants on filtered-out modules unchanged.
  const [searchQuery, setSearchQuery] = useState('');
  // SPEC §6a — when the admin clicks Save and the selection adds NET-
  // NEW sensitive grants, we stash them here and surface a confirmation
  // modal. Save only fires when the admin clicks Confirm. Cancel returns
  // to the matrix with selection intact so they can pare back.
  const [pendingSensitiveGrants, setPendingSensitiveGrants] = useState(null);
  // RBAC Hardening Phase 3 — critical-perm removal warning. List of
  // catalog keys (e.g. "roles.manage") the admin is about to uncheck.
  // null = no warning pending.
  const [pendingCriticalRemovals, setPendingCriticalRemovals] = useState(null);
  // RBAC Hardening — server-side lockout rejection (409). Body of the
  // 409 response with the spec-pinned criticalPermissions array.
  const [lockoutError, setLockoutError] = useState(null);
  // Phase 5 — history modal open state.
  const [historyOpen, setHistoryOpen] = useState(false);
  // Page catalog so we can show admins which pages each permission
  // unlocks. Without this, admins look for a "calendar" module in the
  // picker, don't find it (calendar is gated by appointments.read), and
  // assume the permission is missing. Showing "Unlocks: Calendar,
  // Appointments, …" under each module makes the mapping obvious.
  const [pageCatalog, setPageCatalog] = useState([]);
  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/pages/catalog')
      .then((res) => {
        if (cancelled) return;
        const list = Array.isArray(res?.catalog) ? res.catalog : [];
        setPageCatalog(list);
      })
      .catch(() => {
        // Non-fatal — the hint is supplementary, the picker still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Build a `module → Set<pageLabel>` map by walking each catalog page's
  // requiredPermissions. A page that requires `appointments.read` shows
  // up under the "appointments" module hint — across ALL its actions —
  // because granting that module's read action is what unlocks it.
  const pagesByModule = useMemo(() => {
    const map = new Map();
    for (const page of pageCatalog) {
      const reqs = Array.isArray(page?.requiredPermissions) ? page.requiredPermissions : [];
      for (const { module } of reqs) {
        if (!module) continue;
        if (!map.has(module)) map.set(module, new Set());
        map.get(module).add(page.label);
      }
    }
    return map;
  }, [pageCatalog]);

  // Per-module search corpus: concatenated string of everything the
  // search input matches against. Built once per matrix/page-catalog
  // change so the filter pass is O(n) on every keystroke without
  // re-deriving descriptions and page labels each time.
  const searchCorpusByModule = useMemo(() => {
    const map = new Map();
    for (const { module, actions } of matrix) {
      const parts = [
        module,
        // Vertical-aware description — same source the tooltip + body
        // text below read from, so search hits stay consistent.
        getModuleDescription(module, vertical),
        Array.from(pagesByModule.get(module) || []).join(' '),
        (actions || []).join(' '),
      ];
      map.set(module, parts.join(' ').toLowerCase());
    }
    return map;
  }, [matrix, pagesByModule, vertical]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (module) => {
    if (!normalizedQuery) return true;
    const corpus = searchCorpusByModule.get(module);
    return Boolean(corpus && corpus.includes(normalizedQuery));
  };

  const notify = useNotify();

  const toggle = (module, action) => {
    if (readOnly) return;
    const key = `${module}.${action}`;
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const toggleModule = (module, actions, allSelected) => {
    if (readOnly) return;
    const next = new Set(selected);
    actions.forEach((a) => {
      const key = `${module}.${a}`;
      if (allSelected) next.delete(key);
      else next.add(key);
    });
    setSelected(next);
  };

  // The actual persist step. Split out from `requestSave` so the
  // SensitiveGrantsConfirmModal's Confirm button can call it directly,
  // bypassing the sensitive-grant gate (the admin has just confirmed).
  const persistSave = async () => {
    setError('');
    setLockoutError(null);
    setIsLoading(true);
    try {
      const body = Array.from(selected).map((s) => {
        const [module, action] = s.split('.');
        return { module, action };
      });
      const res = await fetchApi(`/api/roles/${role.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: body }),
      });
      // Version tracking is intentionally NOT surfaced in the
      // success toast — version numbers are an internal recovery
      // detail that lives in the History modal. The toast should
      // read as a plain confirmation. The History UI is where the
      // admin sees "Version 7" etc.
      notify.success?.(`Permissions updated for "${role.name}"`);
      setPendingSensitiveGrants(null);
      onSaved();
    } catch (err) {
      // RBAC Hardening — the backend 409 LOCKOUT_PREVENTED arrives as
      // an Error with status + body attached by fetchApi. Surface the
      // structured error in a dedicated banner so the admin sees the
      // recovery hint without it being mistaken for a generic toast.
      if (err && (err.status === 409 || err.code === 'LOCKOUT_PREVENTED' || (err.body && err.body.code === 'LOCKOUT_PREVENTED'))) {
        const body = err.body || err.payload || err;
        setLockoutError({
          message: body.error || err.message || 'Lockout prevented',
          criticalPermissions: body.criticalPermissions || [],
          qualifyingUserCount: body.qualifyingUserCount,
        });
        setPendingSensitiveGrants(null);
        setPendingCriticalRemovals(null);
      } else {
        setError(err.message || 'Could not save permissions');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // After the sensitive-grant gate passes, fall through to the persist.
  const requestSensitiveCheck = () => {
    const newlySensitive = [];
    for (const key of selected) {
      if (initial.has(key)) continue;
      if (SENSITIVE_PERMISSIONS_CLIENT.has(key)) newlySensitive.push(key);
    }
    if (newlySensitive.length > 0) {
      setPendingSensitiveGrants(newlySensitive);
      return;
    }
    persistSave();
  };

  // RBAC Hardening Phase 3 — chain after the legacy gate. Detect any
  // critical permission the admin is removing (in initial but not in
  // selected, AND in the CRITICAL_RBAC_KEYS set). If any → surface
  // the critical-removal warning. Otherwise fall through to the
  // sensitive-grant gate.
  const requestCriticalRemovalCheck = () => {
    const removingCritical = [];
    for (const key of initial) {
      if (selected.has(key)) continue; // still granted, no removal
      if (CRITICAL_RBAC_KEYS.has(key)) removingCritical.push(key);
    }
    if (removingCritical.length > 0) {
      setPendingCriticalRemovals(removingCritical);
      return;
    }
    requestSensitiveCheck();
  };

  // Two-phase confirmation chain on Save:
  //   1. RBAC Hardening Phase 3 — critical-perm warning (destructive:
  //      removes admin-recovery surface from this role).
  //   2. SPEC §6a — sensitive-grant confirmation (additive: grants
  //      net-new powerful perms).
  // Each gate's "Confirm" action chains into the next.
  const requestSave = () => {
    requestCriticalRemovalCheck();
  };

  // RBAC Hardening Phase 3 — admin clicked Continue on the critical
  // removal warning.
  const confirmCriticalRemoval = () => {
    setPendingCriticalRemovals(null);
    requestSensitiveCheck();
  };

  const save = requestSave;

  return (
    <ModalShell
      title={`Permissions: ${role.name}`}
      subtitle={
        readOnly
          ? 'You do not have permission to edit roles.'
          : `Check the actions this role can perform.`
      }
      onClose={onClose}
      width={760}
    >
      {/* Search bar — sticks to top of the scrollable body */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'var(--bg-color)',
          paddingTop: '0.25rem',
          paddingBottom: '0.75rem',
          marginLeft: '-1.25rem',
          marginRight: '-1.25rem',
          paddingLeft: '1.25rem',
          paddingRight: '1.25rem',
          borderBottom: '1px solid var(--border-color)',
          boxShadow: '0 3px 10px rgba(0,0,0,0.2)',
          marginBottom: '0.75rem',
        }}
      >
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search permissions (module, page, action)…"
            aria-label="Search permissions"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '0.6rem 2.4rem 0.6rem 0.85rem',
              fontSize: '0.9rem',
              borderRadius: 8,
              border: '1px solid var(--border-color)',
              background: 'var(--subtle-bg-2)',
              color: 'var(--text-primary)',
              outline: 'none',
            }}
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              title="Clear search"
              style={{
                position: 'absolute',
                top: '50%',
                right: '0.5rem',
                transform: 'translateY(-50%)',
                background: 'var(--text-secondary)',
                border: 'none',
                borderRadius: '50%',
                color: 'var(--bg-color)',
                cursor: 'pointer',
                padding: 0,
                width: '1.25rem',
                height: '1.25rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                opacity: 0.85,
              }}
            >
              <X size={12} strokeWidth={3} />
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          padding: '0.25rem',
          marginBottom: '0.75rem',
        }}
      >
        {(() => {
          // Build a name → module lookup so we can render in domain
          // order. Any module not listed in `domainList` lands in an
          // "Other" section at the bottom so nothing silently disappears
          // if a domain mapping is missed.
          const byName = new Map(matrix.map((m) => [m.module, m]));
          const seen = new Set();
          const sections = domainList
            .map(({ domain, modules: moduleNames }) => {
              const items = (moduleNames || [])
                .map((name) => byName.get(name))
                .filter(Boolean)
                // Search filter — drop modules that don't match the
                // current query. Empty query → matchesQuery returns
                // true for all, so this no-ops.
                .filter((m) => matchesQuery(m.module));
              items.forEach((m) => seen.add(m.module));
              return { domain, items };
            })
            .filter((s) => s.items.length > 0);
          const orphans = matrix
            .filter((m) => !seen.has(m.module))
            .filter((m) => matchesQuery(m.module));
          if (orphans.length > 0) sections.push({ domain: 'Other', items: orphans });

          // Empty state — search returned zero hits across every domain.
          if (sections.length === 0) {
            return (
              <div
                style={{
                  padding: '2rem 1rem',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '0.85rem',
                }}
              >
                No permissions match <strong>“{searchQuery}”</strong>.
                <div style={{ marginTop: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="btn-secondary"
                    style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem' }}
                  >
                    Clear search
                  </button>
                </div>
              </div>
            );
          }

          return sections.map(({ domain, items }) => (
            <div key={domain} style={{ marginBottom: '1.25rem' }}>
              <div
                style={{
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-secondary)',
                  padding: '0 0.25rem 0.4rem',
                  borderBottom: '1px solid var(--border-color)',
                  marginBottom: '0.6rem',
                }}
              >
                {domain}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(auto-fill, minmax(min(100%, 220px), 1fr))',
                  gap: '0.75rem',
                }}
              >
                {items.map(({ module, actions }) => {
                  const allSelected = actions.every((a) =>
                    selected.has(`${module}.${a}`),
                  );
                  const anySelected = actions.some((a) =>
                    selected.has(`${module}.${a}`),
                  );
                  return (
                    <div
                      key={module}
                      style={{
                        padding: '0.75rem',
                        borderRadius: 8,
                        border: '1px solid var(--border-color)',
                        background: anySelected
                          ? 'var(--subtle-bg-3)'
                          : 'var(--subtle-bg-2)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '0.25rem',
                        }}
                      >
                        <span
                          title={getModuleDescription(module, vertical) || module}
                          style={{
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {module}
                        </span>
                        {!readOnly && (
                          <button
                            type="button"
                            onClick={() =>
                              toggleModule(module, actions, allSelected)
                            }
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: '0.7rem',
                              color: 'var(--primary-color, var(--accent-color))',
                              padding: '0.1rem 0.3rem',
                            }}
                          >
                            {allSelected ? 'Clear' : 'All'}
                          </button>
                        )}
                      </div>
                      {(() => {
                        // Module description (always shown when known) +
                        // "Unlocks: <pages>" (shown when the page catalog
                        // pins a SPA page to this module). The description
                        // covers every module — modules that no page
                        // declares in requiredPermissions (deals, projects,
                        // quotes, forecasting, quotas, …) would otherwise
                        // render as bare checkbox grids.
                        const description = getModuleDescription(module, vertical);
                        const pages = pagesByModule.get(module);
                        const labels = pages && pages.size > 0
                          ? Array.from(pages).sort()
                          : null;
                        if (!description && !labels) return null;
                        return (
                          <div
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--text-secondary)',
                              marginBottom: '0.5rem',
                              lineHeight: 1.35,
                            }}
                          >
                            {description && (
                              <div style={{ marginBottom: labels ? '0.25rem' : 0 }}>
                                {description}
                              </div>
                            )}
                            {labels && (
                              <div title={`Pages requiring this permission: ${labels.join(', ')}`}>
                                Unlocks:{' '}
                                <span style={{ color: 'var(--text-primary)', opacity: 0.85 }}>
                                  {labels.join(', ')}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '0.2rem',
                        }}
                      >
                        {actions.map((a) => {
                          const key = `${module}.${a}`;
                          const checked = selected.has(key);
                          const actionDesc = ACTION_DESCRIPTIONS[a];
                          // Compose a contextual tooltip — the action verb
                          // is generic, so prefix the module label to make
                          // it scannable on hover ("Edit existing records
                          // in this module." → "deals · Edit existing…").
                          const tooltip = actionDesc
                            ? `${module} · ${actionDesc}`
                            : `${module}.${a}`;
                          // RBAC Hardening Phase 2 — severity badge.
                          // Derived from CRITICAL_RBAC_KEYS +
                          // SENSITIVE_PERMISSIONS_CLIENT; no new
                          // UI-only allow-list. Renders nothing for
                          // ordinary perms (the vast majority of the
                          // catalogue).
                          const severity = getPermissionSeverity(key);
                          return (
                            <label
                              key={a}
                              title={tooltip}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                                fontSize: '0.85rem',
                                cursor: readOnly ? 'not-allowed' : 'pointer',
                                opacity: readOnly ? 0.7 : 1,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggle(module, a)}
                                disabled={readOnly}
                                aria-describedby={`perm-desc-${module}-${a}`}
                                style={{
                                  cursor: readOnly ? 'not-allowed' : 'pointer',
                                }}
                              />
                              {a}
                              {/* Severity badge — sits at the right
                                  edge via marginLeft:'auto' in its
                                  inline style. Renders only when the
                                  permission classifies as critical or
                                  caution; ordinary perms render no
                                  badge so the matrix stays uncluttered. */}
                              <PermissionSeverityBadge
                                severity={severity}
                                module={module}
                                action={a}
                              />
                              <span
                                id={`perm-desc-${module}-${a}`}
                                style={{
                                  position: 'absolute',
                                  width: 1,
                                  height: 1,
                                  padding: 0,
                                  margin: -1,
                                  overflow: 'hidden',
                                  clip: 'rect(0,0,0,0)',
                                  whiteSpace: 'nowrap',
                                  border: 0,
                                }}
                              >
                                {tooltip}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ));
        })()}
      </div>

      {error && (
        <div role="alert" style={errBoxStyle}>{error}</div>
      )}

      {/* RBAC Hardening — server-side lockout rejection banner.
          Surfaces the 409 LOCKOUT_PREVENTED with a "View History"
          escape hatch so the admin can roll back to a known-good
          version without having to manually re-derive what they had. */}
      {lockoutError && (
        <div
          role="alert"
          data-testid="lockout-error-banner"
          style={{
            margin: '0.75rem 0',
            padding: '0.8rem 1rem',
            borderRadius: 8,
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            color: 'var(--text-primary)',
            fontSize: '0.88rem',
          }}
        >
          <strong>Save rejected — would cause RBAC lockout.</strong>
          <div style={{ marginTop: '0.4rem', color: 'var(--text-secondary)' }}>
            {lockoutError.message} The change would leave{' '}
            {lockoutError.qualifyingUserCount} active user(s) able to
            administer roles. Restore an earlier version below or
            adjust the selection.
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="btn-secondary"
              style={{ fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
              onClick={() => {
                setLockoutError(null);
                setHistoryOpen(true);
              }}
            >
              View role history
            </button>
            <button
              type="button"
              className="btn-secondary"
              style={{ marginLeft: '0.4rem', fontSize: '0.78rem', padding: '0.25rem 0.6rem' }}
              onClick={() => setLockoutError(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <ModalActions>
        <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {selected.size} permission{selected.size === 1 ? '' : 's'} selected
          {normalizedQuery && (
            <span style={{ marginLeft: '0.5rem', opacity: 0.8 }}>
              · filtered by “{searchQuery.trim()}”
            </span>
          )}
        </span>
        {/* Phase 5 — History entry point. Always available (read-
            gated by roles.read on the backend); the modal it opens
            shows a Restore button only when canManage is true. */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="btn-secondary"
          disabled={isLoading}
          data-testid="open-permissions-history"
        >
          History
        </button>
        <button type="button" onClick={onClose} className="btn-secondary" disabled={isLoading}>
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" onClick={save} className="btn-primary" disabled={isLoading}>
            {isLoading ? 'Saving…' : 'Save permissions'}
          </button>
        )}
      </ModalActions>

      {/* RBAC Hardening Phase 3 — critical-permission removal warning.
          Fires before the sensitive-grant gate.
          Lists exactly which critical perms are being removed + the
          affected product areas (Roles & Permissions admin). Continue
          chains into the sensitive-grant gate; Cancel returns to the
          matrix unchanged. */}
      {pendingCriticalRemovals && pendingCriticalRemovals.length > 0 && (
        <CriticalPermsConfirmModal
          roleName={role.name}
          removedKeys={pendingCriticalRemovals}
          isLoading={isLoading}
          onCancel={() => setPendingCriticalRemovals(null)}
          onConfirm={confirmCriticalRemoval}
        />
      )}

      {/* SPEC §6a — sensitive-grant confirmation. Rendered on top of the
          permissions matrix so the admin's selection is preserved
          underneath if they cancel. Confirm fires persistSave directly,
          which bypasses the gate (already confirmed). */}
      {pendingSensitiveGrants && pendingSensitiveGrants.length > 0 && (
        <SensitiveGrantsConfirmModal
          roleName={role.name}
          grants={pendingSensitiveGrants}
          isLoading={isLoading}
          onCancel={() => setPendingSensitiveGrants(null)}
          onConfirm={persistSave}
        />
      )}

      {/* Phase 5 — Role History modal. List + Restore + Diff. The
          modal handles its own fetching + restore flow; we just pass
          the role + a callback that re-fetches /api/roles when a
          restore lands so the table count refreshes. */}
      {/* Universal history popup — same component the Settings →
          Role Recovery section uses. Identical UI for every role
          (Admin / Customer / Manager / User / any custom role) and
          every version-count. */}
      <RoleHistoryDialog
        role={role}
        canManage={!readOnly}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestored={() => {
          setHistoryOpen(false);
          onSaved();
        }}
      />
      {/* Legacy in-page modal kept for now as a no-op rendering path;
          it's referenced by the function definition below but not
          mounted. Safe to delete in a follow-up sweep once the
          unified dialog has soaked. */}
    </ModalShell>
  );
}

// RBAC Hardening Phase 3 — critical permission removal warning.
// Fires when an admin's save would uncheck `roles.read` or
// `roles.manage` — the two permissions required to recover from any
// other broken RBAC configuration. The modal lists the catalog keys
// being removed AND the human-readable product areas the role's
// holders will lose access to. Continue chains into the sensitive-
// grant gate; Cancel returns to the matrix.
//
// Backend lockout guard still has the final say — if removing these
// would zero out the tenant's RBAC-admin capacity, the PUT returns
// 409 LOCKOUT_PREVENTED regardless of what the admin clicked here.
function CriticalPermsConfirmModal({ roleName, removedKeys, isLoading, onCancel, onConfirm }) {
  return (
    <ModalShell
      title="⚠ Critical permission change"
      subtitle={`You are removing ${removedKeys.length} permission${removedKeys.length === 1 ? '' : 's'} required for role and staff administration on "${roleName}".`}
      onClose={onCancel}
      width={580}
    >
      <div
        data-testid="critical-perms-confirm-modal"
        style={{
          marginBottom: '0.75rem',
          padding: '0.7rem 0.9rem',
          borderRadius: 8,
          background: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.4)',
          fontSize: '0.85rem',
          color: 'var(--text-primary)',
        }}
      >
        <strong>Users assigned to this role may lose access to:</strong>
        <ul style={{ margin: '0.45rem 0 0 1.1rem', padding: 0, color: 'var(--text-primary)' }}>
          {removedKeys.map((key) => {
            const area = CRITICAL_PERMISSION_AREAS[key] || { name: key, impact: 'Powerful administration permission' };
            return (
              <li key={key} style={{ marginBottom: '0.35rem', fontSize: '0.85rem' }}>
                <strong>{area.name}</strong>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {area.impact}
                </div>
                <code style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{key}</code>
              </li>
            );
          })}
        </ul>
      </div>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
        If no other active user retains RBAC administration access after this
        change, the server will reject the save with a lockout-prevention
        error.
      </div>
      {/* RBAC Hardening Phase 2 — recovery guidance. Pinned as a
          standalone callout so it reads as a positive escape hatch
          rather than as part of the rejection-warning paragraph. */}
      <div
        data-testid="critical-perms-recovery-hint"
        style={{
          fontSize: '0.78rem',
          color: 'var(--text-secondary)',
          marginBottom: '0.65rem',
          padding: '0.45rem 0.6rem',
          borderRadius: 6,
          background: 'var(--subtle-bg-2)',
          borderLeft: '3px solid var(--warning-color, #f59e0b)',
        }}
      >
        You can restore a previous version from <strong>History</strong> if
        you accidentally remove required permissions.
      </div>
      <ModalActions>
        <button
          type="button"
          onClick={onCancel}
          className="btn-secondary"
          disabled={isLoading}
          data-testid="critical-perms-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="btn-primary"
          disabled={isLoading}
          data-testid="critical-perms-continue"
          style={{ background: 'var(--danger-color, #ef4444)' }}
        >
          {isLoading ? 'Saving…' : 'Continue and save'}
        </button>
      </ModalActions>
    </ModalShell>
  );
}

// Phase 5 — Role permission version history modal. Fetches
// /api/roles/:id/permissions/versions on mount, renders one row per
// snapshot newest-first, and offers a Restore button (when the user
// has roles.manage) on every non-current version. Restore POSTs the
// version id to /api/roles/:id/permissions/restore which delegates to
// the PUT handler; the same lockout guard fires on restore, so an
// admin can't roll back to a broken state either.
function PermissionsHistoryModal({ role, canManage, onClose, onRestored }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [restoringId, setRestoringId] = useState(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchApi(`/api/roles/${role.id}/permissions/versions`);
      setVersions(Array.isArray(res?.versions) ? res.versions : []);
    } catch (err) {
      setError(err.message || 'Could not load history');
    } finally {
      setLoading(false);
    }
  }, [role.id]);

  useEffect(() => {
    load();
  }, [load]);

  const onRestore = async (version) => {
    const ok = await notify.confirm({
      title: 'Restore role permissions',
      message: `Restore "${role.name}" to v${version.versionNumber} (${version.permissionCount} permissions)? A new version row will be appended; history is not overwritten.`,
      confirmText: 'Restore',
    });
    if (!ok) return;
    setRestoringId(version.id);
    try {
      const res = await fetchApi(`/api/roles/${role.id}/permissions/restore`, {
        method: 'POST',
        body: JSON.stringify({ versionId: version.id }),
      });
      // Same principle as the regular save toast — version numbers
      // are internal. The History modal already shows "Version N" in
      // its own UI; the toast just confirms the action in plain
      // language. Date adds context the admin actually cares about
      // ("restored to the state from earlier today").
      const sourceDate = version?.changedAt
        ? new Date(version.changedAt).toLocaleString()
        : null;
      notify.success?.(
        sourceDate
          ? `Restored "${role.name}" to the version from ${sourceDate}.`
          : `Restored "${role.name}" to a previous version.`,
      );
      onRestored && onRestored();
    } catch (err) {
      // Pass through 409 LOCKOUT_PREVENTED with the spec error so the
      // admin knows the restored set itself would have caused lockout.
      const body = err?.body || err?.payload || err;
      if (body && body.code === 'LOCKOUT_PREVENTED') {
        notify.error?.(
          `Cannot restore — the resulting state would lock everyone out of RBAC. ${body.error || ''}`,
        );
      } else {
        notify.error?.(err.message || 'Restore failed');
      }
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <ModalShell
      title={`Role history: ${role.name}`}
      subtitle="Every permission save appends a snapshot here. Restore creates a new version pointing at the source — history is never overwritten."
      onClose={onClose}
      width={640}
    >
      {loading && (
        <div style={{ padding: '1rem 0', color: 'var(--text-secondary)' }}>Loading history…</div>
      )}
      {error && !loading && (
        <div role="alert" style={errBoxStyle}>{error}</div>
      )}
      {!loading && !error && versions.length === 0 && (
        <div style={{ padding: '1rem 0', color: 'var(--text-secondary)' }}>
          No history yet. The next permission save on this role becomes v1.
        </div>
      )}
      {!loading && versions.length > 0 && (
        <ul
          data-testid="permissions-history-list"
          style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 360, overflow: 'auto' }}
        >
          {versions.map((v) => (
            <li
              key={v.id}
              data-testid={`history-version-${v.versionNumber}`}
              style={{
                padding: '0.6rem 0.8rem',
                marginBottom: '0.4rem',
                borderRadius: 6,
                border: '1px solid var(--border-color)',
                background: v.isCurrent ? 'var(--subtle-bg-3)' : 'var(--subtle-bg-1)',
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.7rem',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>
                  Version {v.versionNumber}
                  {v.isCurrent && (
                    <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                      (Current)
                    </span>
                  )}
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    {v.changeType}
                    {v.restoredFromVersionId ? ' · restored from #' + v.restoredFromVersionId : ''}
                  </span>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                  {new Date(v.changedAt).toLocaleString()} ·{' '}
                  {v.changedBy ? v.changedBy.name || v.changedBy.email : 'system'} ·{' '}
                  {v.permissionCount} permission{v.permissionCount === 1 ? '' : 's'}
                </div>
                {v.note && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.2rem', fontStyle: 'italic' }}>
                    “{v.note}”
                  </div>
                )}
              </div>
              {canManage && !v.isCurrent && (
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
                  onClick={() => onRestore(v)}
                  disabled={restoringId === v.id}
                  data-testid={`restore-version-${v.versionNumber}`}
                >
                  {restoringId === v.id ? 'Restoring…' : 'Restore'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ModalActions>
        <button type="button" onClick={onClose} className="btn-secondary">
          Close
        </button>
      </ModalActions>
    </ModalShell>
  );
}

// SPEC §6a — confirmation modal shown when the admin's permission save
// would add NET-NEW sensitive grants (see SENSITIVE_PERMISSIONS_CLIENT).
// Lists each grant + a one-line reason and requires explicit Confirm to
// proceed. Mirrors the backend audit metadata captured by the PUT
// /api/roles/:id/permissions endpoint.
function SensitiveGrantsConfirmModal({ roleName, grants, isLoading, onCancel, onConfirm }) {
  return (
    <ModalShell
      title="Confirm sensitive permission grant"
      subtitle={`You are about to grant ${grants.length} powerful permission${grants.length === 1 ? '' : 's'} to "${roleName}".`}
      onClose={onCancel}
      width={560}
    >
      <div
        style={{
          marginBottom: '0.75rem',
          padding: '0.65rem 0.8rem',
          borderRadius: 8,
          background: 'var(--subtle-bg-2)',
          border: '1px solid var(--border-color)',
          fontSize: '0.85rem',
          color: 'var(--text-secondary)',
        }}
      >
        These permissions can change other people&apos;s access, expose financial
        data, or destroy clinical records. Confirm only if you intend the
        role&apos;s holders to perform these actions.
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {grants.map((key) => (
          <li
            key={key}
            style={{
              padding: '0.55rem 0.75rem',
              marginBottom: '0.4rem',
              borderRadius: 6,
              border: '1px solid var(--border-color)',
              background: 'var(--subtle-bg-1)',
            }}
          >
            <div
              style={{
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                fontWeight: 700,
                color: 'var(--text-primary)',
              }}
            >
              {key}
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
              {SENSITIVE_PERMISSION_REASONS[key] || 'Powerful permission — review carefully.'}
            </div>
          </li>
        ))}
      </ul>
      <ModalActions>
        <button type="button" onClick={onCancel} className="btn-secondary" disabled={isLoading}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm} className="btn-primary" disabled={isLoading}>
          {isLoading ? 'Saving…' : 'Confirm and save'}
        </button>
      </ModalActions>
    </ModalShell>
  );
}

// ───────────────────── Home widget layout modal ──────────────────────

function WidgetsModal({ role, onClose, onSaved }) {
  // catalog: the full list of available widgets from /api/widgets/catalog
  // layout:  array of { widgetKey, position, isEnabled } in display order
  const [catalog, setCatalog] = useState([]);
  const [layout, setLayout] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const notify = useNotify();

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    Promise.all([
      fetchApi('/api/widgets/catalog').catch(() => ({ catalog: [] })),
      fetchApi(`/api/roles/${role.id}/widgets`).catch(() => ({ widgets: [] })),
    ])
      .then(([catRes, lRes]) => {
        if (cancelled) return;
        const cat = Array.isArray(catRes?.catalog) ? catRes.catalog : [];
        setCatalog(cat);
        const existing = Array.isArray(lRes?.widgets) ? lRes.widgets : [];
        // Map existing layout, preserve order. Any unknown widget keys (not in
        // catalog) are dropped — they were removed from the registry.
        const known = new Set(cat.map((c) => c.key));
        const filtered = existing
          .filter((w) => known.has(w.widgetKey))
          .sort((a, b) => a.position - b.position)
          .map((w) => ({
            widgetKey: w.widgetKey,
            position: w.position,
            isEnabled: w.isEnabled !== false,
          }));
        setLayout(filtered);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load widgets');
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [role.id]);

  const inLayoutKeys = new Set(layout.map((l) => l.widgetKey));
  const available = catalog.filter((c) => !inLayoutKeys.has(c.key));
  // Group available widgets by category for the picker.
  const grouped = available.reduce((acc, w) => {
    (acc[w.category] = acc[w.category] || []).push(w);
    return acc;
  }, {});

  const addWidget = (widgetKey) => {
    setLayout((prev) => [
      ...prev,
      { widgetKey, position: (prev.length + 1) * 10, isEnabled: true },
    ]);
  };

  const removeWidget = (widgetKey) => {
    setLayout((prev) => prev.filter((w) => w.widgetKey !== widgetKey));
  };

  const move = (idx, dir) => {
    setLayout((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      // Re-number positions so they stay monotonic.
      return next.map((w, i) => ({ ...w, position: (i + 1) * 10 }));
    });
  };

  const toggleEnabled = (widgetKey) => {
    setLayout((prev) =>
      prev.map((w) =>
        w.widgetKey === widgetKey ? { ...w, isEnabled: !w.isEnabled } : w,
      ),
    );
  };

  const save = async () => {
    setIsSaving(true);
    setError('');
    try {
      await fetchApi(`/api/roles/${role.id}/widgets`, {
        method: 'PUT',
        body: JSON.stringify({
          widgets: layout.map((w, idx) => ({
            widgetKey: w.widgetKey,
            position: (idx + 1) * 10,
            isEnabled: w.isEnabled,
          })),
        }),
      });
      notify.success?.(`Widgets updated for "${role.name}"`);
      onSaved();
    } catch (err) {
      setError(err?.message || 'Could not save widget layout');
    } finally {
      setIsSaving(false);
    }
  };

  const widgetMetaByKey = (key) => catalog.find((c) => c.key === key) || null;

  return (
    <ModalShell
      title={`Home widgets: ${role.name}`}
      subtitle="Pick which widgets appear on the /home dashboard for this role, and in what order."
      onClose={onClose}
      width={760}
    >
      {isLoading ? (
        <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading widgets…</div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
            gap: '1rem',
            maxHeight: '60vh',
            overflowY: 'auto',
            padding: '0.25rem',
          }}
        >
          {/* Selected layout */}
          <div>
            <h4 style={{ marginTop: 0, fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              Shown on /home ({layout.length})
            </h4>
            {layout.length === 0 && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                No widgets selected yet. Pick from the right.
              </p>
            )}
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {layout.map((w, idx) => {
                const meta = widgetMetaByKey(w.widgetKey);
                return (
                  <li
                    key={w.widgetKey}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.5rem',
                      border: '1px solid var(--border-color)',
                      borderRadius: 6,
                      background: w.isEnabled ? 'var(--subtle-bg-3)' : 'var(--subtle-bg-2)',
                      opacity: w.isEnabled ? 1 : 0.6,
                    }}
                  >
                    <GripVertical size={14} style={{ color: 'var(--text-secondary)' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {meta?.title || w.widgetKey}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                        {meta?.category || ''}
                      </div>
                    </div>
                    <button type="button" onClick={() => move(idx, -1)} className="btn-secondary" disabled={idx === 0} style={iconBtn}>
                      <ChevronUp size={14} />
                    </button>
                    <button type="button" onClick={() => move(idx, +1)} className="btn-secondary" disabled={idx === layout.length - 1} style={iconBtn}>
                      <ChevronDown size={14} />
                    </button>
                    <label style={{ fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <input
                        type="checkbox"
                        checked={w.isEnabled}
                        onChange={() => toggleEnabled(w.widgetKey)}
                      />
                      on
                    </label>
                    <button type="button" onClick={() => removeWidget(w.widgetKey)} className="btn-secondary" style={iconBtn} aria-label="Remove">
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Available picker */}
          <div>
            <h4 style={{ marginTop: 0, fontSize: '0.85rem', textTransform: 'uppercase', color: 'var(--text-secondary)' }}>
              Available widgets
            </h4>
            {Object.keys(grouped).length === 0 && (
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                All catalogued widgets are already in the layout.
              </p>
            )}
            {Object.entries(grouped).map(([category, items]) => (
              <div key={category} style={{ marginBottom: '0.6rem' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>
                  {category}
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {items.map((w) => (
                    <li key={w.key}>
                      <button
                        type="button"
                        onClick={() => addWidget(w.key)}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '0.4rem 0.6rem',
                          border: '1px dashed var(--border-color)',
                          borderRadius: 6,
                          background: 'transparent',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                        }}
                      >
                        + {w.title}
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                          {w.description}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <div role="alert" style={errBoxStyle}>{error}</div>}
      <ModalActions>
        <button type="button" onClick={onClose} className="btn-secondary" disabled={isSaving}>
          Cancel
        </button>
        <button type="button" onClick={save} className="btn-primary" disabled={isSaving || isLoading}>
          {isSaving ? 'Saving…' : 'Save layout'}
        </button>
      </ModalActions>
    </ModalShell>
  );
}

const iconBtn = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  fontSize: '0.75rem',
};

// Shared style for the per-row action buttons (Edit / Widgets / Delete) so
// they sit on one line at any viewport width without wrapping. whiteSpace +
// flexShrink: 0 stops the table cell's auto-layout from breaking the row.
const actionBtnStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.8rem',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

// ──────────────────────── Users-on-role modal ────────────────────────

function UsersModal({ role, canManage, onClose, onChange }) {
  const [members, setMembers] = useState([]);
  const [allStaff, setAllStaff] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isStaffLoading, setIsStaffLoading] = useState(false);
  const [error, setError] = useState('');
  const [picker, setPicker] = useState('');
  const [busyUserId, setBusyUserId] = useState(null);
  const notify = useNotify();

  const load = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await fetchApi(`/api/roles/${role.id}/users`);
      setMembers(Array.isArray(res?.users) ? res.users : []);
    } catch (err) {
      setError(err.message || 'Could not load users');
    } finally {
      setIsLoading(false);
    }
  }, [role.id]);

  const loadStaffList = useCallback(async () => {
    if (!canManage) return;
    setIsStaffLoading(true);
    try {
      // /api/staff returns the current tenant's users — same scope as roles.
      // TODO: replace with a dedicated /api/users?available-for-role=N endpoint
      // once tenants get larger than a single dropdown can handle.
      const res = await fetchApi('/api/staff');
      const list = Array.isArray(res) ? res : Array.isArray(res?.staff) ? res.staff : [];
      setAllStaff(list);
    } catch {
      // Non-fatal; the picker just renders empty.
    } finally {
      setIsStaffLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    load();
    loadStaffList();
  }, [load, loadStaffList]);

  const assignedIds = useMemo(
    () => new Set(members.map((m) => m.id)),
    [members],
  );
  const available = useMemo(
    () => allStaff.filter((u) => !assignedIds.has(u.id)),
    [allStaff, assignedIds],
  );

  const assign = async () => {
    if (!picker) return;
    setBusyUserId(parseInt(picker, 10));
    try {
      await fetchApi(`/api/roles/${role.id}/assign/${picker}`, {
        method: 'POST',
      });
      notify.success?.('Role assigned');
      setPicker('');
      await load();
      onChange?.();
    } catch {
      // toast handled by fetchApi
    } finally {
      setBusyUserId(null);
    }
  };

  const unassign = async (userId) => {
    const ok = await notify.confirm({
      title: 'Remove role',
      message: 'Remove this role from the user?',
      confirmText: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    setBusyUserId(userId);
    try {
      await fetchApi(`/api/roles/${role.id}/assign/${userId}`, {
        method: 'DELETE',
      });
      notify.success?.('Role removed');
      await load();
      onChange?.();
    } catch {
      // toast handled
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <ModalShell
      title={`Members of ${role.name}`}
      subtitle={
        canManage
          ? 'Assign or remove users from this role. Changes apply immediately.'
          : 'You do not have permission to manage role assignments.'
      }
      onClose={onClose}
      width={620}
    >
      {canManage && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            marginBottom: '1rem',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <select
            className="input-field"
            value={picker}
            onChange={(e) => setPicker(e.target.value)}
            disabled={isStaffLoading || available.length === 0}
            style={{ flex: 1, minWidth: 220 }}
          >
            <option value="">
              {isStaffLoading
                ? 'Loading users…'
                : available.length === 0
                  ? 'All eligible users are already assigned'
                  : 'Select a user to add…'}
            </option>
            {available.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email} {u.email && u.name ? `(${u.email})` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={assign}
            disabled={!picker || busyUserId != null}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
          >
            <UserPlus size={14} />
            {busyUserId && picker && busyUserId === parseInt(picker, 10) ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {error && (
        <div role="alert" style={errBoxStyle}>{error}</div>
      )}

      <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'auto', maxHeight: '50vh' }}>
        {isLoading && (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>Loading members…</div>
        )}
        {!isLoading && members.length === 0 && (
          <div style={{ padding: '1rem', color: 'var(--text-secondary)' }}>
            No users assigned yet.
          </div>
        )}
        {!isLoading && members.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--subtle-bg-3)', textAlign: 'left' }}>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Type</Th>
                {canManage && <Th>{''}</Th>}
              </tr>
            </thead>
            <tbody>
              {members.map((u) => (
                <tr key={u.id} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <Td>{u.name || '—'}</Td>
                  <Td>{u.email}</Td>
                  <Td>{u.userType || 'STAFF'}</Td>
                  {canManage && (
                    <Td>
                      <button
                        type="button"
                        onClick={() => unassign(u.id)}
                        className="btn-secondary"
                        disabled={busyUserId === u.id}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          fontSize: '0.75rem',
                        }}
                      >
                        <UserMinus size={12} />
                        {busyUserId === u.id ? 'Removing…' : 'Remove'}
                      </button>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ModalActions>
        <button type="button" onClick={onClose} className="btn-secondary">
          Close
        </button>
      </ModalActions>
    </ModalShell>
  );
}

// ───────────────────────── Shared UI primitives ──────────────────────

function Th({ children }) {
  return (
    <th
      style={{
        padding: '0.6rem 0.85rem',
        fontWeight: 600,
        fontSize: '0.75rem',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: 'var(--text-secondary)',
        // Headers should never wrap — at narrow viewports the parent's
        // overflow:auto gives a horizontal scrollbar instead of breaking
        // a header like "LANDING PATH" into 2 lines.
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, colSpan, center }) {
  return (
    <td
      colSpan={colSpan}
      style={{
        padding: '0.6rem 0.85rem',
        verticalAlign: 'middle',
        textAlign: center ? 'center' : 'left',
        color: center ? 'var(--text-secondary)' : 'inherit',
      }}
    >
      {children}
    </td>
  );
}

function Badge({ color = 'blue', children }) {
  const palette = {
    blue:  { bg: 'rgba(59,130,246,0.12)',  fg: '#3b82f6', bd: 'rgba(59,130,246,0.3)' },
    amber: { bg: 'rgba(245,158,11,0.12)',  fg: '#f59e0b', bd: 'rgba(245,158,11,0.3)' },
    green: { bg: 'rgba(16,185,129,0.12)',  fg: '#10b981', bd: 'rgba(16,185,129,0.3)' },
  };
  const c = palette[color] || palette.blue;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.15rem 0.5rem',
        borderRadius: 999,
        fontSize: '0.7rem',
        fontWeight: 600,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
      }}
    >
      {children}
    </span>
  );
}

const linkBtn = {
  background: 'transparent',
  border: '1px solid var(--border-color)',
  padding: '0.25rem 0.55rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.3rem',
  fontSize: '0.8rem',
  color: 'inherit',
};

const errBoxStyle = {
  background: 'rgba(239,68,68,0.1)',
  color: '#ef4444',
  padding: '0.6rem 0.75rem',
  borderRadius: 6,
  fontSize: '0.85rem',
  marginBottom: '0.75rem',
};

function ModalShell({ title, subtitle, onClose, width = 480, children }) {
  useScrollLock(true);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Portal to document.body so a modal opened from inside another modal's
  // scrollable body (e.g. SensitiveGrantsConfirmModal launched from
  // PermissionsModal) becomes a DOM sibling of its parent, not a nested
  // descendant. Without this, wheel events on the child's backdrop bubble
  // up to the parent modal's `.glass` overflow:auto container and scroll
  // the underlying matrix while the confirm dialog is open.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: width,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--bg-color)',
          color: 'var(--text-primary)',
          borderRadius: 12,
          border: '1px solid var(--border-color)',
          boxShadow: '0 18px 40px rgba(0,0,0,0.45)',
        }}
      >
        {/* Fixed header — title + close button, never scrolls */}
        <div
          style={{
            flexShrink: 0,
            padding: '1.25rem 1.25rem 0 1.25rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '0.5rem',
              marginBottom: subtitle ? '0.5rem' : '1rem',
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
              {subtitle && (
                <p
                  style={{
                    margin: '0.2rem 0 0',
                    color: 'var(--text-secondary)',
                    fontSize: '0.8rem',
                  }}
                >
                  {subtitle}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '0.25rem',
                flexShrink: 0,
              }}
            >
              <X size={18} />
            </button>
          </div>
          {subtitle && <div style={{ marginBottom: '0.75rem' }} />}
        </div>
        {/* Scrollable body — only this region scrolls */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '0 1.25rem 1.25rem 1.25rem',
          }}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModalActions({ children }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        gap: '0.5rem',
        marginTop: '0.75rem',
        alignItems: 'center',
      }}
    >
      {children}
    </div>
  );
}

function Field({ label, error, help, children }) {
  return (
    <div style={{ marginBottom: '0.85rem' }}>
      <label
        style={{
          display: 'block',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
          marginBottom: '0.25rem',
          fontWeight: 500,
        }}
      >
        {label}
      </label>
      {children}
      {help && !error && (
        <small
          style={{
            display: 'block',
            marginTop: '0.25rem',
            color: 'var(--text-secondary)',
            fontSize: '0.7rem',
          }}
        >
          {help}
        </small>
      )}
      {error && (
        <small
          role="alert"
          style={{
            display: 'block',
            marginTop: '0.25rem',
            color: '#ef4444',
            fontSize: '0.75rem',
          }}
        >
          {error}
        </small>
      )}
    </div>
  );
}
