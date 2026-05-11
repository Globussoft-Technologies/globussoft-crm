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
// #558 — Tamper-evidence hash chain.
//
//   The canonical row-data serialization is `canonicalize(payload)` where
//   payload = {
//     tenantId,   // Number
//     entity,     // String, e.g. 'Contact'
//     action,     // String, e.g. 'CREATE'
//     entityId,   // Number|null
//     userId,     // Number|null
//     details,    // String|null — already JSON.stringify'd at this layer
//     createdAt,  // String, ISO-8601 UTC (Date.toISOString())
//   }
//   `id` and `prevHash` are intentionally NOT in the payload — id is the
//   autoincrement primary key (not known pre-insert), and prevHash is
//   carried separately as the chain link. Swapping or deleting a chained
//   row is still detected by the NEXT row's prevHash mismatch, so the
//   chain remains tamper-evident without including id in the digest.
//
//   The hash itself is `sha256(prevHash || canonicalize(payload))` as a
//   lowercase 64-char hex string. `prevHash` is either the literal
//   string `"GENESIS_<tenantId>"` (head of a fresh chain) or the prior
//   row's hash for the SAME tenant. Chains are per-tenant; rows from
//   different tenants never appear in the same chain.
//
//   ANY change to this contract (added fields, different serialisation,
//   different sentinel format) must be applied in lockstep to:
//     - this file (writeAudit's hash compute)
//     - routes/audit.js (GET /verify recompute)
//     - cron/auditIntegrityEngine.js (daily sweep recompute)
//     - scripts/verify-audit-chain.js (CLI recompute)
//     - scripts/backfill-audit-chain.js (one-shot backfill)
//   The integration test multi-tenant-tamper-isolation pins this contract.
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

// genesisFor(tenantId) — canonical sentinel for the head of a per-tenant
// chain. Embedding the tenantId in the sentinel prevents a row from
// tenant A being silently relocated to tenant B's chain head (the verifier
// would see `GENESIS_A` where it expects `GENESIS_B`).
function genesisFor(tenantId) {
  return `GENESIS_${tenantId}`;
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
    //
    // Legacy null-hash repair (PR #709 fallout): if the latest row exists
    // but its `hash` is null, the tenant has pre-#558 legacy rows that
    // haven't been backfilled yet. The naive fallback (`genesisFor()`)
    // would silently FORK the chain — the new row would anchor on GENESIS
    // when there are legacy rows ahead of it in the chain order. Instead,
    // run an inline backfill to fill the gap, then re-read the tail. The
    // backfill is tenant-scoped + idempotent (a parallel writeAudit racing
    // on the same tenant would each kick off a backfill, but only one will
    // do real work; the others find the chain already filled and no-op).
    // If backfill itself throws (conflict / lookup error), fall back to
    // genesisFor() — the chain will fork once, the daily integrity cron
    // will flag it, and the operator can run the cross-tenant CLI to
    // repair. This is no worse than pre-fix behavior.
    const tenantIdNum = Number(tenantId);
    let prevHash;
    try {
      let prev = await prisma.auditLog.findFirst({
        where: { tenantId: tenantIdNum },
        // Tie-break on id (autoincrement) so a parallel writeAudit landing
        // within the same millisecond doesn't fork the chain by reading a
        // stale head. Matches the walker's [createdAt asc, id asc] order
        // (reversed here because we want the newest row).
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { hash: true },
      });
      if (prev && prev.hash == null) {
        // Latest row exists but its hash is null — legacy unbackfilled state.
        // Inline-repair the chain so this new write can anchor correctly.
        try {
          await backfillTenantChain(tenantIdNum);
          prev = await prisma.auditLog.findFirst({
            where: { tenantId: tenantIdNum },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { hash: true },
          });
        } catch (backfillErr) {
          // Backfill failed (likely tamper-conflict). Fall back to GENESIS;
          // the integrity cron will surface the resulting fork.
          console.warn(`[audit] inline backfill failed for tenant ${tenantIdNum}: ${backfillErr.message}`);
        }
      }
      prevHash = prev && prev.hash ? prev.hash : genesisFor(tenantIdNum);
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

// backfillTenantChain(tenantId) — retroactively populate prevHash + hash on
// every row that's missing one. Walks rows in the SAME [createdAt asc, id asc]
// order the verifier uses so the resulting chain validates on the next /verify
// call.
//
// Idempotent: if a row already has a non-null hash, we recompute its expected
// value with the same canonical payload and abort the whole run with a tagged
// `conflictRowId` error when the recomputed value disagrees with the stored
// one. This catches post-hash tampering and prevents the backfill from
// silently overwriting a poisoned chain. Untampered already-hashed rows are
// re-used as-is so a second backfill run is a no-op (`updatedRows: 0`).
//
// Fork repair (PR #709 fallout): writeAudit's fail-soft fallback can anchor a
// new row on `GENESIS_<tenantId>` even when prior (null-hash) rows exist for
// the tenant. The result is a "forked" chain — the row's CONTENT is intact
// (recompute-with-stored-prevHash matches stored-hash) but its `prevHash`
// doesn't reference the row that actually precedes it in [createdAt asc, id
// asc] order. The backfill detects this case and re-stamps prevHash+hash to
// repair the fork. Tamper-evidence is preserved because we only repair rows
// whose CONTENT recomputes correctly under their stored prevHash; any
// content-tampered row still 409s.
//
// Returns { walkedRows, updatedRows, skippedRows, head }. Throws when a
// conflict is detected — the route turns that into a 409.
async function backfillTenantChain(tenantId) {
  const tenantIdNum = Number(tenantId);
  if (!Number.isFinite(tenantIdNum)) {
    throw new Error(`backfillTenantChain: invalid tenantId ${tenantId}`);
  }

  // v3.7.5 — concurrency-race fix. Pre-fix: `findMany` returns a snapshot at
  // query time, but the WALK can race against concurrent writeAudit calls
  // because Prisma's per-call transactions don't serialize against this
  // long-running mutation. Specifically: if backfill re-stamps row R's hash
  // from X→Y while a concurrent writeAudit reads R as the chain tail and
  // creates row R+1 with `prevHash=X`, the next /verify pass sees
  // R.hash=Y but R+1.prevHash=X — chain break at R+1.
  //
  // Mitigation has two prongs:
  //
  //   (a) Snapshot the row-id ceiling (`maxIdAtStart`) before doing any work
  //       and restrict the walk to rows whose id ≤ this ceiling. Concurrent
  //       writeAudit calls landing after this point create rows with id >
  //       ceiling — they are guaranteed to be OUTSIDE our working set and
  //       therefore cannot fork against our mutations.
  //
  //   (b) Never re-stamp the snapshot's tail row (`id === maxIdAtStart`).
  //       That row's hash is what any concurrent writeAudit reads as its
  //       prevHash anchor. Mutating it under us would fork the just-created
  //       post-snapshot row's chain link. The snapshot-tail row IS still
  //       null-filled (the common case — moving null → hashed is a one-way
  //       transition that writeAudit's inline-backfill path naturally
  //       reconciles by re-reading). But case-2 fork-repair (a SECOND
  //       hash overwrite on an already-hashed row) on the tail is deferred
  //       to the next backfill — by which time the in-flight writes have
  //       settled.
  //
  // Why this is safe: tamper-evidence is preserved because we never
  // SKIP detecting content tampering (case 1 still throws 409 on the
  // tail). We only DEFER the cosmetic re-anchoring (case 2). The next
  // backfill pass catches it once concurrent activity quiesces.
  const tailRow = await prisma.auditLog.findFirst({
    where: { tenantId: tenantIdNum },
    orderBy: [{ id: 'desc' }],
    select: { id: true },
  });
  const maxIdAtStart = tailRow ? tailRow.id : 0;

  const rows = await prisma.auditLog.findMany({
    where: {
      tenantId: tenantIdNum,
      id: { lte: maxIdAtStart },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      userId: true,
      details: true,
      createdAt: true,
      prevHash: true,
      hash: true,
    },
  });

  let walked = 0;
  let updated = 0;
  let skipped = 0;
  let lastHash = null;

  for (const row of rows) {
    walked += 1;
    const expectedPrev = lastHash == null ? genesisFor(tenantIdNum) : lastHash;
    const payload = {
      tenantId: tenantIdNum,
      entity: row.entity,
      action: row.action,
      entityId: row.entityId,
      userId: row.userId,
      details: row.details,
      createdAt: row.createdAt.toISOString(),
    };
    const recomputed = computeHash(expectedPrev, payload);

    if (row.hash != null) {
      // The row already carries a hash. Distinguish two cases that can both
      // surface here against a real-world DB (#558 hardening, PR #709 fallout):
      //
      //   (1) Content tampering — someone edited `details` / `entity` /
      //       `userId` / `createdAt` after the row was written without also
      //       updating `hash`. Recomputing with the row's OWN stored prevHash
      //       will therefore disagree with the stored hash. This is a real
      //       integrity failure and we MUST 409 — never silently re-stamp.
      //
      //   (2) Forked chain — writeAudit ran while a legacy null-hash row was
      //       still the chain tail for this tenant. The fail-soft fallback
      //       (`genesisFor(tenantId)` when the latest row's hash is null)
      //       silently anchored the new row on GENESIS instead of the real
      //       prior row. The row's CONTENT is untouched (recompute-with-
      //       stored-prevHash matches stored-hash) but its `prevHash` doesn't
      //       point at the row that actually precedes it in [createdAt asc,
      //       id asc] order. We can safely re-stamp these — no information
      //       loss because the content hash is intact.
      //
      // The distinguishing probe is `recomputeWithStoredPrev`: if that
      // equals the stored hash, the row content has not been tampered with.
      const recomputedWithStoredPrev = computeHash(row.prevHash, payload);
      if (recomputedWithStoredPrev !== row.hash) {
        // Case 1: content tampering — refuse to silently overwrite.
        const err = new Error(
          `existing chain disagrees with recomputation (row ${row.id}): ` +
          `stored prevHash=${row.prevHash}, expected=${expectedPrev}; ` +
          `stored hash=${row.hash}, recomputed=${recomputed}`
        );
        err.conflictRowId = row.id;
        throw err;
      }
      if (row.prevHash !== expectedPrev) {
        // v3.7.5 — defer case-2 fork-repair on the snapshot's tail row to
        // avoid the concurrent-writeAudit race documented above. Any newly-
        // created post-snapshot row referenced our stable pre-mutation
        // tail hash; if we restamped it, that reference would dangle. The
        // next backfill pass will catch this row.
        if (row.id === maxIdAtStart) {
          skipped += 1;
          lastHash = row.hash;
          continue;
        }
        // Case 2: chain fork — re-stamp prevHash + hash to integrate the
        // row into the real chain. Tamper-evidence is preserved because we
        // only got here after proving the content is intact.
        await prisma.auditLog.update({
          where: { id: row.id },
          data: { prevHash: expectedPrev, hash: recomputed },
        });
        updated += 1;
        lastHash = recomputed;
        continue;
      }
      // Already correctly chained — no-op.
      skipped += 1;
      lastHash = row.hash;
      continue;
    }

    await prisma.auditLog.update({
      where: { id: row.id },
      data: { prevHash: expectedPrev, hash: recomputed },
    });
    updated += 1;
    lastHash = recomputed;
  }

  return {
    walkedRows: walked,
    updatedRows: updated,
    skippedRows: skipped,
    head: lastHash,
  };
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

module.exports = {
  writeAudit,
  diffFields,
  canonicalize,
  computeHash,
  genesisFor,
  backfillTenantChain,
};
