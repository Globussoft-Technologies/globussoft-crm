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

// Generic: just strip dangerous fields
function stripDangerous(req, res, next) {
  if (req.body) {
    delete req.body.id;
    delete req.body.createdAt;
    delete req.body.updatedAt;
    delete req.body.tenantId;
    delete req.body.userId;
  }
  next();
}

module.exports = { whitelist, stripDangerous, ALLOWED_FIELDS };
