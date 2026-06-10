/**
 * Sensitive permission catalog — v3.8.x wellness role-preset SPEC §6a.
 *
 * Some module.action grants carry outsized blast-radius: rolling them up
 * to a role gives that role's holders the power to change other people's
 * access (ROLES write), move money (BILLING / PAYMENTS / ACCOUNTING
 * write), destroy clinical / PII records (PATIENTS / PRESCRIPTIONS /
 * CONSENTS delete), modify the audit trail (AUDIT write/delete), or
 * reconfigure system integrations (SETTINGS / DEVELOPER / INTEGRATIONS
 * write). An admin clicking through the role-permission matrix may not
 * notice they've just granted one of these — so the SPEC requires that
 * the SAVE flow surface them as an explicit confirmation list.
 *
 * What this module owns:
 *   - The canonical list of sensitive `module.action` strings.
 *   - Helpers to filter a permission list / detect newly-added grants.
 *
 * What it does NOT do:
 *   - Block any save. The decision to confirm-and-proceed belongs to the
 *     admin clicking the matrix. The backend audits the grant when it
 *     lands; the frontend shows a confirm modal. Either side can be the
 *     gate of last resort.
 *   - Cover field-level permissions. fieldFilter.js is a separate
 *     concern.
 *
 * Adding a new sensitive permission:
 *   1. Add it to SENSITIVE_PERMISSIONS below.
 *   2. The PUT /api/roles/:id/permissions endpoint and the frontend
 *      PermissionsModal pick it up automatically — no other changes.
 */

const SENSITIVE_PERMISSIONS = new Set([
  // ROLES (W/U/D/M) — can change other people's access. `roles.manage`
  // is the only mutating action in the catalogue today; if more are
  // ever added they should land here.
  'roles.manage',

  // STAFF (W/U/D/M) — can add / remove / modify staff records.
  'staff.write',
  'staff.update',
  'staff.delete',
  'staff.manage',

  // SETTINGS / DEVELOPER / INTEGRATIONS (any write) — system
  // configuration surface. Mutations here can re-route emails, change
  // payment provider keys, or rewrite tenant defaults.
  'settings.manage',
  'developer.manage',
  'integrations.write',
  'integrations.update',
  'integrations.delete',
  'integrations.manage',

  // INVOICES / GIFT CARDS / PATIENT WALLETS / PAYMENTS / ACCOUNTING
  // (W/U/D/M) — financial exposure. `billing` was decomposed into three
  // surface-specific modules in v3.8.x; all three carry the same
  // sensitive write-tier surface as the parent did.
  // Note: `payments` catalog only exposes read + export today, so no
  // payments-write entry exists; widening payments to .write/.update
  // would need a corresponding entry here.
  'invoices.write',
  'invoices.update',
  'invoices.delete',
  'invoices.manage',
  'gift_cards.write',
  'gift_cards.update',
  'gift_cards.delete',
  'gift_cards.manage',
  'patient_wallets.write',
  'patient_wallets.update',
  'patient_wallets.delete',
  'patient_wallets.manage',
  'accounting.write',

  // AUDIT (any write/delete) — can tamper with the audit trail.
  // The catalogue only has read + export; add destructive actions here
  // if they ever land.
  // (currently no sensitive actions to gate — placeholder for future-proofing)

  // PATIENTS / PRESCRIPTIONS / CONSENTS (D) — clinical/PII data
  // destruction. Read/write/update are routine clinical operations and
  // are NOT sensitive; only deletes carry the spec's outsized risk.
  'patients.delete',
  'prescriptions.delete',
  'consents.delete',
]);

/**
 * Returns the subset of an incoming permission list that is sensitive.
 * Accepts either a flat `module.action` string array OR an array of
 * `{ module, action }` objects (the shape the PUT /:id/permissions
 * endpoint and the frontend matrix both use).
 */
function getSensitiveGrants(permissions) {
  if (!Array.isArray(permissions)) return [];
  const out = [];
  for (const perm of permissions) {
    if (!perm) continue;
    const key =
      typeof perm === 'string'
        ? perm
        : perm.module && perm.action
          ? `${perm.module}.${perm.action}`
          : null;
    if (!key) continue;
    if (SENSITIVE_PERMISSIONS.has(key)) out.push(key);
  }
  return out;
}

/**
 * Given the previous + next permission sets (each can be either flat
 * strings or {module,action} objects), returns the sensitive grants
 * that are newly added (present in next, absent in prev). Used by the
 * audit log to record only NET-NEW sensitive grants, not the full
 * sensitive subset of the role.
 */
function getNewlyGrantedSensitive(previousPermissions, nextPermissions) {
  const toKey = (p) =>
    typeof p === 'string'
      ? p
      : p && p.module && p.action
        ? `${p.module}.${p.action}`
        : null;
  const prevSet = new Set(
    (Array.isArray(previousPermissions) ? previousPermissions : [])
      .map(toKey)
      .filter(Boolean),
  );
  const nextSensitive = getSensitiveGrants(nextPermissions);
  return nextSensitive.filter((k) => !prevSet.has(k));
}

/**
 * Returns true if any of the listed permissions is sensitive.
 */
function hasAnySensitive(permissions) {
  return getSensitiveGrants(permissions).length > 0;
}

module.exports = {
  SENSITIVE_PERMISSIONS,
  getSensitiveGrants,
  getNewlyGrantedSensitive,
  hasAnySensitive,
};
