// Shared audit-log helper. Issue #179.
// Usage: const { writeAudit } = require('../lib/audit');
//        await writeAudit('Contact', 'CREATE', contact.id, req.user.userId, req.user.tenantId, { name });
//
// PRD §11 (HIPAA / DPDP Act compliance): every PHI read on a patient record
// must be audit-logged. PHI-read sites in routes/wellness.js call the helper
// with a non-staff actor — pass opts.actorType = 'patient' (defaults to 'user')
// so reviewers can distinguish self-access from staff access. The actorType
// rides inside the JSON `details` blob (no schema migration needed): the
// helper merges `_actorType` and `_patientActorId` into details automatically.
//
// Schema (see prisma/schema.prisma → model AuditLog):
//   action    String   — e.g. CREATE, UPDATE, SOFT_DELETE, RESTORE, MARK_PAID,
//                        PATIENT_DETAIL_READ, VISIT_READ, PRESCRIPTION_READ, …
//   entity    String   — Contact, Deal, Invoice, Patient, Visit, Prescription, …
//   entityId  Int?     — primary key of the affected row (null for bulk ops)
//   details   String?  — JSON-stringified payload (kept short — not the full record)
//   userId    Int?     — actor; null for system / cron-driven changes,
//                        or for patient-portal self-access (use opts.patientId)
//   tenantId  Int      — required, tenant scope

const prisma = require('./prisma');

// writeAudit(entity, action, entityId, userId, tenantId, details, opts?)
//
//   opts.actorType  'user' | 'patient' | 'system'  (default: 'user' if userId,
//                   'system' otherwise). 'patient' indicates a patient-portal
//                   token holder self-accessed their own record.
//   opts.patientId  When actorType='patient', the Patient.id of the actor.
//                   Stored inside details JSON since AuditLog.userId expects
//                   a User row, not a Patient row.
async function writeAudit(entity, action, entityId, userId, tenantId, details, opts) {
  if (!tenantId) return; // no-op if tenant context missing — never blocks the request
  try {
    const o = opts || {};
    const actorType = o.actorType || (userId != null ? 'user' : 'system');

    // Merge actorType + (optional) patientId into the details payload so the
    // viewer/CSV-export can surface them without a schema change.
    let mergedDetails = details;
    if (actorType !== 'user' || o.patientId != null) {
      const base =
        details == null
          ? {}
          : typeof details === 'string'
            ? (() => { try { return JSON.parse(details); } catch (_) { return { _raw: details }; } })()
            : details;
      mergedDetails = { ...base, _actorType: actorType };
      if (o.patientId != null) mergedDetails._patientActorId = Number(o.patientId);
    }

    await prisma.auditLog.create({
      data: {
        action,
        entity,
        entityId: entityId != null ? Number(entityId) : null,
        userId: userId != null ? Number(userId) : null,
        tenantId: Number(tenantId),
        details: mergedDetails == null
          ? null
          : (typeof mergedDetails === 'string' ? mergedDetails : JSON.stringify(mergedDetails)),
      },
    });
  } catch (e) {
    // Never propagate audit failures — they must not break the user-facing request.
    console.warn(`[audit] ${action} ${entity}#${entityId}: ${e.message}`);
  }
}

// Convenience: compute a shallow diff of changed fields between two objects.
// Returns { field: { from, to } } for any keys that differ. Skips functions / undefined.
function diffFields(before, after, keys) {
  const out = {};
  const list = keys || Object.keys(after || {});
  for (const k of list) {
    if (before == null || after == null) continue;
    const a = before[k];
    const b = after[k];
    if (b === undefined) continue;
    // Normalise dates
    const aN = a instanceof Date ? a.toISOString() : a;
    const bN = b instanceof Date ? b.toISOString() : b;
    if (aN !== bN && JSON.stringify(aN) !== JSON.stringify(bN)) {
      out[k] = { from: aN, to: bN };
    }
  }
  return out;
}

module.exports = { writeAudit, diffFields };
