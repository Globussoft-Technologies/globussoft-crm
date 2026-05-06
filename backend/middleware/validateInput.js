// Whitelist of allowed fields per entity on create/update
const ALLOWED_FIELDS = {
  contact: ['name', 'email', 'phone', 'company', 'title', 'status', 'source', 'assignedToId'],
  deal: ['title', 'amount', 'probability', 'stage', 'expectedClose', 'contactId', 'pipelineId', 'currency', 'lostReason', 'winLossReasonId'],
  ticket: ['subject', 'description', 'status', 'priority', 'assigneeId'],
  task: ['title', 'dueDate', 'status', 'priority', 'notes', 'contactId', 'userId', 'projectId'],
  invoice: ['amount', 'dueDate', 'contactId', 'dealId', 'status', 'isRecurring', 'recurFrequency'],
  campaign: ['name', 'channel', 'status', 'budget'],
  project: ['name', 'description', 'status', 'priority', 'startDate', 'endDate', 'budget', 'contactId', 'dealId'],
  contract: ['title', 'status', 'startDate', 'endDate', 'value', 'terms', 'contactId', 'dealId'],
  expense: ['title', 'amount', 'category', 'status', 'receiptUrl', 'notes', 'expenseDate', 'contactId'],
  estimate: ['title', 'status', 'totalAmount', 'validUntil', 'notes', 'contactId', 'dealId'],
};

function whitelist(entity) {
  return (req, res, next) => {
    const allowed = ALLOWED_FIELDS[entity];
    if (allowed && req.body && typeof req.body === 'object') {
      const cleaned = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) cleaned[key] = req.body[key];
      }
      req.body = cleaned;
    }
    next();
  };
}

// Generic: just strip dangerous fields.
//
// Records every key it deleted on `req.strippedFields` so route handlers that
// want to fail-loud (e.g. reject an attempted cross-tenant write with 400
// instead of silently no-op'ing it) can introspect what came in. Routes that
// don't care continue to work unchanged.
//
// #427 defense-in-depth (added 2026-05-04 after the QA mass-assignment audit):
//   - `isAdmin`           — does not exist on any current model, but a future
//                           User schema bump that adds it should not be
//                           reachable from arbitrary write routes.
//   - `passwordHash` /
//     `portalPasswordHash` — server-internal credential storage. No route
//                           should accept these from a client; bcrypt.hash
//                           runs server-side and the result is set on a
//                           curated data object. Stripping closes the
//                           confused-deputy variant where a future route
//                           accidentally spreads `req.body` into Prisma and
//                           lets a caller seed a password hash.
//
// Intentionally NOT in the deny-list (because legit routes read them):
//   - `password` — POST /auth/login, /auth/signup, /auth/register,
//                  /portal/login all destructure `req.body.password`.
//   - `role`     — PUT /auth/users/:id/role legitimately reads
//                  `req.body.role` (ADMIN-gated, intentional role-change).
//   These remain safe today because:
//     (a) the relevant write paths use curated data objects, never spread
//         `req.body` into Prisma, and
//     (b) Prisma rejects unknown fields on models that don't declare them
//         (Contact / Service / Sequence / Lead 400 the QA mass-assignment
//         payload), so client-supplied `role`/`password` cannot escape into
//         a model that lacks the column.
//   If a future route spreads `req.body` into a User write, EITHER curate
//   it explicitly OR rename the API surface to `targetRole` /
//   `currentPassword` so this middleware can guard it.
const DANGEROUS_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'tenantId',
  'userId',
  // #427 additions:
  'isAdmin',
  'passwordHash',
  'portalPasswordHash',
];

function stripDangerous(req, res, next) {
  req.strippedFields = req.strippedFields || {};
  if (req.body && typeof req.body === 'object') {
    for (const f of DANGEROUS_FIELDS) {
      if (f in req.body) {
        req.strippedFields[f] = req.body[f];
        delete req.body[f];
      }
    }
  }

  // #546 (MED-05): when one of the privilege-escalation extras is
  // stripped (tenantId / userId / isAdmin / passwordHash / portalPasswordHash),
  // emit an AuditLog entry so security teams have an early-warning signal.
  // Required-by-the-issue contract: silent strip + log, NOT a hard 400 (a
  // legitimate client may include the field by accident e.g. echoing back
  // a row from a GET; the strip is the safety net, the audit is the alert).
  //
  // Skipped intentionally:
  //   - When no fields were stripped → no signal to write
  //   - When req.user is missing (open paths like /auth/login pre-token)
  //     → no actor to attribute; would create unattributed audit noise
  //   - When stripped field is just `id`/`createdAt`/`updatedAt` (the safe
  //     subset — these are "this is a row, not new data" markers, not
  //     escalation attempts). Only the privileged-extras subset
  //     (tenantId / userId / isAdmin / passwordHash / portalPasswordHash)
  //     warrants the alert.
  const PRIVILEGED_EXTRAS = ['tenantId', 'userId', 'isAdmin', 'passwordHash', 'portalPasswordHash'];
  const strippedPrivileged = Object.keys(req.strippedFields || {})
    .filter((k) => PRIVILEGED_EXTRAS.includes(k));
  if (strippedPrivileged.length > 0 && req.user && req.user.tenantId) {
    // Lazy-load to avoid a circular dep at module init (audit -> prisma -> ...)
    // and to keep this middleware cheap when nothing is stripped.
    let writeAudit;
    try {
      ({ writeAudit } = require('../lib/audit'));
    } catch (_) { writeAudit = null; }
    if (writeAudit) {
      // Fire-and-forget. The audit row is a security signal — a DB blip
      // shouldn't block the request. Errors get console.error'd inside
      // writeAudit per its own contract.
      writeAudit(
        'Request',
        'PRIV_ESCALATION_STRIP',
        null,
        req.user.userId,
        req.user.tenantId,
        {
          path: req.originalUrl,
          method: req.method,
          strippedFields: strippedPrivileged,
          // Field VALUES are deliberately omitted — they may contain a
          // hashed password or another tenant's id (that's exactly why
          // the strip exists). Field NAMES alone are enough for the
          // SOC to investigate.
        },
      ).catch(() => { /* swallowed — see comment */ });
    }
  }

  next();
}

module.exports = { whitelist, stripDangerous, ALLOWED_FIELDS, DANGEROUS_FIELDS };
