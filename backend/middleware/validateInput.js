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
const DANGEROUS_FIELDS = ['id', 'createdAt', 'updatedAt', 'tenantId', 'userId'];

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
