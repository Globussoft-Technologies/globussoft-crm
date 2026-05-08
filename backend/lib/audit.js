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
// #558 — Tamper-evidence hash chain. Every row carries `prevHash` (the
// previous row's hash for the same tenant, or "GENESIS_<tenantId>" for the
// first row) and `hash` (sha256 of prevHash + canonicalised row data).
// canonicalize() sorts object keys before JSON.stringify so the hash is
// deterministic across Node versions. Lookup of the previous row is best-
// effort: if it fails (DB transient, etc.) writeAudit logs a warning and
// persists with prevHash=null. The integrity cron (auditIntegrityEngine)
// catches the gap on its next run; writeAudit never blocks the user-facing
// mutation. See GET /api/audit/verify for chain-walk verification.
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
//   prevHash  String?  — previous row's hash (#558)
//   hash      String?  — sha256 of canonicalised payload (#558)

const crypto = require('crypto');
const prisma = require('./prisma');

// canonicalize(obj) — sort object keys recursively before JSON.stringify so
// the resulting string is byte-identical across Node versions. The hash
// formula depends on this being deterministic; key-order changes would
// produce a different hash and break chain verification. Arrays are NOT
// re-ordered (their order is semantically meaningful). #558.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// computeHash(prevHash, payload) — sha256 hex digest of prevHash concatenated
// with the canonicalised payload. Exported for the verifier endpoint to
// recompute each row's expected hash. #558.
function computeHash(prevHash, payload) {
  const safePrev = prevHash == null ? '' : String(prevHash);
  return crypto
    .createHash('sha256')
    .update(safePrev + canonicalize(payload))
    .digest('hex');
}

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

    const detailsStr = mergedDetails == null
      ? null
      : (typeof mergedDetails === 'string' ? mergedDetails : JSON.stringify(mergedDetails));

    // #558 — Look up the latest audit row for this tenant to chain off its
    // hash. Fail-soft: a transient DB error here must not block the audit
    // emission, so we fall back to prevHash=null (the integrity cron will
    // detect the broken link on its next run). The GENESIS sentinel is used
    // when no prior row exists for this tenant — encodes "this is the head
    // of a fresh chain" without leaking a real-looking hash that could
    // collide with a future one.
    const tenantIdNum = Number(tenantId);
    let prevHash;
    try {
      const prev = await prisma.auditLog.findFirst({
        where: { tenantId: tenantIdNum },
        orderBy: { createdAt: 'desc' },
        select: { hash: true },
      });
      prevHash = prev && prev.hash ? prev.hash : `GENESIS_${tenantIdNum}`;
    } catch (lookupErr) {
      console.warn(`[audit] prev-hash lookup failed for tenant ${tenantIdNum}: ${lookupErr.message}`);
      prevHash = null;
    }

    const entityIdNum = entityId != null ? Number(entityId) : null;
    const userIdNum = userId != null ? Number(userId) : null;
    const createdAt = new Date();

    // The hash payload INTENTIONALLY excludes id (autoincrement, not known
    // pre-insert) and prevHash (carried separately in the chain link). Any
    // future field addition must be reflected in BOTH writeAudit and the
    // verifier's recompute call in routes/audit.js — otherwise verify
    // returns integrityVerified=false on a clean chain. #558.
    const hash = computeHash(prevHash, {
      tenantId: tenantIdNum,
      entity,
      action,
      entityId: entityIdNum,
      userId: userIdNum,
      details: detailsStr,
      createdAt: createdAt.toISOString(),
    });

    await prisma.auditLog.create({
      data: {
        action,
        entity,
        entityId: entityIdNum,
        userId: userIdNum,
        tenantId: tenantIdNum,
        details: detailsStr,
        createdAt,
        prevHash,
        hash,
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

module.exports = { writeAudit, diffFields, canonicalize, computeHash };
