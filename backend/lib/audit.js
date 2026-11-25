// Shared audit-log helper. Issue #179.
// Usage: const { writeAudit } = require('../lib/audit');
//        await writeAudit('Contact', 'CREATE', contact.id, req.user.userId, req.user.tenantId, { name });
//
// PHI reads are recorded through this helper so reviewers can distinguish
// patient self-access from staff access. The actorType rides inside the JSON
// `details` blob; no schema migration is needed.
const prisma = require('./prisma');

// writeAudit(entity, action, entityId, userId, tenantId, details, opts?)
//
//   opts.actorType  'user' | 'patient' | 'system' (default: 'user' if userId,
//                   'system' otherwise). 'patient' indicates a patient-portal
//                   token holder self-accessed their own record.
//   opts.patientId  When actorType='patient', the Patient.id of the actor.
//                   Stored inside details JSON since AuditLog.userId expects
//                   a User row, not a Patient row.
async function writeAudit(entity, action, entityId, userId, tenantId, details, opts) {
  if (!tenantId) return; // no-op if tenant context is missing
  try {
    const o = opts || {};
    const actorType = o.actorType || (userId != null ? 'user' : 'system');

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

    const detailsStr = mergedDetails == null
      ? null
      : (typeof mergedDetails === 'string' ? mergedDetails : JSON.stringify(mergedDetails));

    // #616: callers own userId validity. Audit emission remains fail-soft so
    // a missing user relation never breaks the user-facing request.
    await prisma.auditLog.create({
      data: {
        action,
        entity,
        entityId: entityId != null ? Number(entityId) : null,
        userId: userId != null ? Number(userId) : null,
        tenantId: Number(tenantId),
        details: detailsStr,
        createdAt: new Date(),
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
    const aN = a instanceof Date ? a.toISOString() : a;
    const bN = b instanceof Date ? b.toISOString() : b;
    if (aN !== bN && JSON.stringify(aN) !== JSON.stringify(bN)) {
      out[k] = { from: aN, to: bN };
    }
  }
  return out;
}

module.exports = { writeAudit, diffFields };
