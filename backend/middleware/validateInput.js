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
  next();
}

module.exports = { whitelist, stripDangerous, ALLOWED_FIELDS, DANGEROUS_FIELDS };
