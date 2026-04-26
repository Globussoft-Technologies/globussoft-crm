// Shared audit-log helper. Issue #179.
// Usage: const { writeAudit } = require('../lib/audit');
//        await writeAudit('Contact', 'CREATE', contact.id, req.user.userId, req.user.tenantId, { name });
//
// Schema (see prisma/schema.prisma → model AuditLog):
//   action    String   — e.g. CREATE, UPDATE, SOFT_DELETE, RESTORE, MARK_PAID, …
//   entity    String   — Contact, Deal, Invoice, Patient, Visit, Prescription, …
//   entityId  Int?     — primary key of the affected row (null for bulk ops)
//   details   String?  — JSON-stringified payload (kept short — not the full record)
//   userId    Int?     — actor; null for system / cron-driven changes
//   tenantId  Int      — required, tenant scope

const prisma = require('./prisma');

async function writeAudit(entity, action, entityId, userId, tenantId, details) {
  if (!tenantId) return; // no-op if tenant context missing — never blocks the request
  try {
    await prisma.auditLog.create({
      data: {
        action,
        entity,
        entityId: entityId != null ? Number(entityId) : null,
        userId: userId != null ? Number(userId) : null,
        tenantId: Number(tenantId),
        details: details == null
          ? null
          : (typeof details === 'string' ? details : JSON.stringify(details)),
      },
    });
  } catch (e) {
    // Never propagate audit failures — they must not break the user-facing request.
    console.error(`[audit] ${action} ${entity}#${entityId}: ${e.message}`);
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
