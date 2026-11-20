// Contact classification only describes the newest attempt. Never apply it
// retroactively to older calls for the same lead.
const classificationFields = {
  callifiedLeadStatus: true, callifiedLeadStatusSource: true, callifiedLeadStatusUpdatedAt: true,
  callLogs: { where: { provider: 'callified' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { id: true } },
};

function confirmedOutcome(log) {
  const contact = log.contact;
  return contact?.callLogs?.[0]?.id === log.id && ['pending', 'qualified', 'junk', 'dnp'].includes(contact.callifiedLeadStatus)
      && ['score', 'transcripts_api'].includes(contact.callifiedLeadStatusSource)
      && new Date(contact.callifiedLeadStatusUpdatedAt).getTime() >= new Date(log.createdAt).getTime()
      && ['INITIATED', 'RINGING', 'CONNECTED', 'COMPLETED', 'FAILED', 'MISSED'].includes(log.status)
    ? contact.callifiedLeadStatus : null;
}
function attemptStatus(log, outcome = confirmedOutcome(log)) {
  if (outcome === 'dnp') return 'MISSED';
  return outcome ? 'COMPLETED' : log.status;
}

async function recordStandaloneOutcome(tenantId, contactId, outcome, userId, classifiedAt, expectedCallId) {
  if (!['qualified','pending','junk','dnp'].includes(outcome)) return;
  try {
    const log = await require('./prisma').callLog.findFirst({ where:{tenantId,contactId,provider:'callified',createdAt:{lte:classifiedAt}},
      orderBy:[{createdAt:'desc'},{id:'desc'}], select:{id:true,notes:true} });
    if (log && (!expectedCallId || expectedCallId === log.id) && JSON.parse(log.notes || '{}').historyType) {
      await require('./audit').writeAudit('LeadDialOutcome',outcome,log.id,userId,tenantId,{contactId});
    }
  } catch (error) {
    console.error('[dial-history] Unable to record lead outcome:', error.message);
  }
}
module.exports = { classificationFields, attemptStatus, confirmedOutcome, recordStandaloneOutcome };
