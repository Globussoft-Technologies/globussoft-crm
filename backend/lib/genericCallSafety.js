const prisma = require('./prisma');

function qualified(status) {
  return /qualified|hot/i.test(String(status || ''));
}

// Wrap both AI and browser/manual dispatch at the shared service boundary.
// The conditional UPDATE is a database-backed lock, including across PM2 workers.
async function guardedCall(params, dispatch) {
  const requestedAt = params.requestedAt === undefined ? Date.now() : Number(params.requestedAt);
  const tenant = await prisma.tenant.findUnique({ where: { id: params.tenantId }, select: { vertical: true } });
  if (tenant?.vertical !== 'generic') return dispatch(params);
  const paused = await prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: params.tenantId, key: 'feature.callified.dialing_paused' } } });
  if (paused?.value === 'true' && !(requestedAt > Number(paused.updatedAt))) {
    throw Object.assign(new Error('This call was stopped. Queue a new call to dial again.'), { code: 'DIALING_PAUSED', status: 409 });
  }
  const where = { id: Number(params.contactId), tenantId: params.tenantId };
  const contact = await prisma.contact.findFirst({ where });
  if (!contact || contact.deletedAt) throw Object.assign(new Error('Lead not found.'), { code: 'CONTACT_NOT_FOUND', status: 404 });
  if (qualified(contact.callifiedLeadStatus)) throw Object.assign(new Error('Qualified leads are protected from further calls.'), { code: 'LEAD_ALREADY_QUALIFIED', status: 409 });
  const leaseUntil = new Date(Date.now() + 10 * 60_000);
  const locked = await prisma.contact.updateMany({ where: {
    ...where, OR: [{ callifiedDialLeaseUntil: null }, { callifiedDialLeaseUntil: { lte: new Date() } }],
    AND: [{ OR: [{ callifiedLeadStatus: null }, { callifiedLeadStatus: { notIn: ['qualified', 'hot'] } }] }],
  }, data: { callifiedDialLeaseUntil: leaseUntil } });
  if (!locked.count) throw Object.assign(new Error('This lead is already being called or has been qualified.'), { code: 'LEAD_CALL_LOCKED', status: 409 });
  try {
    const active = await prisma.callLog.findFirst({ where: { tenantId: params.tenantId, contactId: Number(params.contactId), provider: 'callified', status: { in: ['INITIATED', 'RINGING', 'CONNECTED'] } } });
    if (active) throw Object.assign(new Error('A call is already active for this lead.'), { code: 'LEAD_CALL_ACTIVE', status: 409 });
    const current = await prisma.contact.findFirst({ where });
    if (qualified(current?.callifiedLeadStatus)) throw Object.assign(new Error('Qualified leads cannot be called.'), { code: 'LEAD_ALREADY_QUALIFIED', status: 409 });
    return await dispatch(params);
  } finally {
    await prisma.contact.updateMany({ where: { ...where, callifiedDialLeaseUntil: leaseUntil }, data: { callifiedDialLeaseUntil: null } });
  }
}

module.exports = { guardedCall, qualified };
