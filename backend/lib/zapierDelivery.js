const crypto = require('crypto');
const prisma = require('./prisma');

const EVENTS = { contact_created: 'contact.created', deal_won: 'deal.won', task_completed: 'task.completed' };
function validateCatchHook(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.hostname !== 'hooks.zapier.com' || url.port
    || url.username || url.password || url.search || url.hash
    || !/^\/hooks\/catch\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
    throw new Error('Use an HTTPS hooks.zapier.com/hooks/catch/... URL without query parameters');
  }
  return url.href;
}

// Keep catch URLs (bearer capabilities), message data and response bodies out
// of the delivery ledger. WebhookEvent is reused without changing its schema.
async function deliverZapier(subscription, event, payload, tenantId, secret, test = false) {
  const url = validateCatchHook(subscription.targetUrl);
  const eventId = crypto.randomUUID();
  const details = { subscriptionId: subscription.id, ownerId: subscription.userId, event, eventId, test, attempts: 0 };
  const log = await prisma.webhookEvent.create({ data: {
    source: 'zapier_outbound', tenantId, metaEventId: eventId,
    rawPayload: JSON.stringify(details), signatureOk: Boolean(secret), status: 'RECEIVED',
  } });
  const timestamp = new Date().toISOString();
  const allowed = ['id', 'contactId', 'dealId', 'taskId', 'name', 'email', 'phone', 'company', 'title', 'status', 'source', 'amount', 'currency', 'assignedToId', 'completedAt'];
  const data = Object.fromEntries(allowed.filter(key => payload?.[key] !== undefined).map(key => [key, payload[key]]));
  const body = JSON.stringify({ id: eventId, event, timestamp, test, data });
  const headers = { 'Content-Type': 'application/json', 'X-CRM-Event': event, 'X-CRM-Event-ID': eventId };
  if (secret) {
    const seconds = Math.floor(Date.now() / 1000);
    headers['X-Globussoft-Signature'] = `t=${seconds},v1=${crypto.createHmac('sha256', secret).update(`${seconds}.${body}`).digest('hex')}`;
  }
  let status = null;
  let ok = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    details.attempts = attempt;
    try {
      const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(5000) });
      status = response.status;
      ok = response.ok;
      await response.body?.cancel();
      if (ok || (status !== 429 && status < 500)) break;
    } catch { status = null; }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
  }
  await prisma.webhookEvent.update({ where: { id: log.id }, data: {
    status: ok ? 'PROCESSED' : 'FAILED', processedAt: new Date(),
    errorMessage: ok ? null : status ? `HTTP ${status}` : 'Connection failed or timed out',
    rawPayload: JSON.stringify({ ...details, httpStatus: status }),
  } });
  return { ok, httpStatus: status, attempts: details.attempts, eventId };
}
module.exports = { EVENTS, validateCatchHook, deliverZapier };
