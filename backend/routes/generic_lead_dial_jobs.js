const router = require('express').Router();
const prisma = require('../lib/prisma');
const { verifyToken } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const jobs = require('../lib/genericLeadDialJobs');
const client = require('../services/callifiedClient');
const { writeAudit } = require('../lib/audit');
const { classificationFields, attemptStatus, confirmedOutcome } = require('../lib/callifiedAttemptStatus');

router.use(verifyToken, async (req, res, next) => {
  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { vertical: true } });
    if (tenant?.vertical !== 'generic') return res.status(403).json({ error: 'This calling workspace is available in Generic CRM.', code: 'GENERIC_ONLY' });
    next();
  } catch (error) { next(error); }
});

function sendError(res, error) {
  return res.status(error.status || 500).json({ error: error.status ? error.message : 'Unable to update the dial queue.', code: error.code || 'DIAL_JOB_FAILED' });
}
function ownerScope(req) {
  return ['ADMIN', 'MANAGER'].includes(req.user.role) ? {} : { userId: req.user.userId };
}
router.get('/control', requirePermission('leads', 'read'), async (req, res) => {
  try {
    const row = await prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: req.user.tenantId, key: 'feature.callified.dialing_paused' } } });
    res.json({ paused: row?.value === 'true', serverTime: new Date().toISOString() });
  } catch (error) { sendError(res, error); }
});
router.put('/control', requirePermission('leads', 'write'), async (req, res) => {
  if (!['ADMIN', 'MANAGER'].includes(req.user.role)) return res.status(403).json({ error: 'A manager can pause workspace dialing.', code: 'FORBIDDEN' });
  if (typeof req.body.paused !== 'boolean') return res.status(400).json({ error: 'paused must be true or false.', code: 'INVALID_CONTROL' });
  try {
    const tenantId = req.user.tenantId;
    const paused = req.body.paused;
    const updatedAt = new Date();
    await prisma.tenantSetting.upsert({ where: { tenantId_key: { tenantId, key: 'feature.callified.dialing_paused' } },
      create: { tenantId, key: 'feature.callified.dialing_paused', value: String(paused), updatedAt }, update: { value: String(paused), updatedAt } });
    if (paused) {
      require('../lib/callifiedAutoDialQueue').cancelTenant(tenantId);
      await prisma.leadDialJob.updateMany({ where: { tenantId, status: 'scheduled', scheduledAt: { gt: updatedAt }, createdAt: { lte: updatedAt } }, data: { status: 'stopped' } });
      await prisma.leadDialJob.updateMany({ where: { tenantId, createdAt: { lte: updatedAt }, status: { in: ['scheduled', 'running', 'paused'] } }, data: { status: 'cancelled' } });

    }
    await writeAudit('LeadDialJob', paused ? 'PAUSE_ALL' : 'RESUME', tenantId, req.user.userId, tenantId, { currentCallsContinue: true });
    res.json({ paused, currentCallsContinue: true });
  } catch (error) { sendError(res, error); }
});
router.get('/', requirePermission('leads', 'read'), async (req, res) => {
  try {
    const activeStatuses = ['running', 'scheduled', 'paused', 'stopped'];
    const scope = { tenantId: req.user.tenantId, ...ownerScope(req) };
    if (req.query.toolbar === '1') {
      const [running, scheduled, queue] = await Promise.all([
        prisma.leadDialJob.findMany({ where: { ...scope, status: 'running' }, take: 20, select: { id: true, total: true, completed: true, failed: true, skipped: true } }),
        prisma.leadDialJob.count({ where: { ...scope, status: 'scheduled' } }),
        jobs.getDialQueueSnapshot(req.user, new Date(), { toolbar: true }),
      ]);
      return res.json({ ...queue, running, upcoming: scheduled + queue.upcoming });
    }
    const history = req.query.history === '1';
    const [active, recent] = await Promise.all([
      prisma.leadDialJob.findMany({ where: { ...scope, status: { in: activeStatuses } }, orderBy: [{ status: 'desc' }, { scheduledAt: 'asc' }], take: 30 }),
      prisma.leadDialJob.findMany({ where: { ...scope, status: { notIn: activeStatuses } }, orderBy: { id: 'desc' }, ...(history ? {} : { take: 30 }) }),
    ]);
    const runs = history ? recent : [...active, ...recent].slice(0, 30);
    // Stopping a run stops its worker. Its last submitted call can still finish.
    const stopped = runs.filter(job => job.status === 'cancelled' && job.activeCallLogId);
    if (stopped.length) {
      const logs = await prisma.callLog.findMany({
        where: { tenantId: req.user.tenantId, id: { in: stopped.map(job => job.activeCallLogId) } },
        select: { id: true, status: true, createdAt: true, contact: { select: classificationFields } },
      });
      const outcomes = new Map(logs.map(log => [log.id, attemptStatus(log)]));
      for (const job of stopped) {
        const counter = { COMPLETED: 'completed', MISSED: 'completed', FAILED: 'failed', CANCELLED: 'skipped' }[outcomes.get(job.activeCallLogId)];
        if (counter) {
          if (outcomes.get(job.activeCallLogId) === 'MISSED') job.reconciledDnp = true;
          job[counter] += 1;
          job.activeCallLogId = null;
          if (job.error?.startsWith('Call completion could not be confirmed.')) job.error = null;
        }
      }
    }
    const queues = req.query.includeQueues === '1' ? await jobs.getDialQueueSnapshot(req.user) : undefined;
    const origins = history ? await prisma.auditLog.findMany({where:{...scope,entity:'LeadDialOrigin'},select:{entityId:true,action:true,details:true}}) : [];
    const originByCall = new Map(origins.map(event => [event.entityId,event]));
    const standalone = origins.length ? await (async () => {
      const logs = await prisma.callLog.findMany({ where: { ...scope, provider: 'callified', id:{in:[...originByCall.keys()]} },
        select: { id: true, status: true, calleeNumber: true, createdAt: true, contact: { select: { name: true, ...classificationFields } } } });
      const finished = logs.filter(log => ['COMPLETED','CANCELLED','MISSED','FAILED'].includes(attemptStatus(log)));
      const saved = finished.length ? await prisma.auditLog.findMany({ where: { tenantId: scope.tenantId, entity: 'LeadDialOutcome', entityId: { in: finished.map(log => log.id) } }, orderBy:{id:'asc'}, select: { entityId: true, action: true } }) : [];
      const outcomes = new Map(saved.map(event => [event.entityId, event.action]));
      return finished.map(log => {
        const origin = originByCall.get(log.id);
        const type = origin.action;
        let name = log.contact?.name;
        try { name = JSON.parse(origin.details).name || name; } catch { /* Older audit payload */ }
        const outcome = outcomes.get(log.id) || confirmedOutcome(log);
        return { id: 'call-' + log.id, runType: type, total: 1, completed: 1, status: 'completed', firstDialAt: log.createdAt,
          title: type === 'single' ? name : null, outcomes: outcome ? { [outcome]: 1 } : {},
          leads: [{ id: log.id, name, phone: log.calleeNumber, outcome }] };
      });
    })() : [];
    res.json({ queues, jobs: runs.map(({ audience, reconciledDnp, ...job }) => {
      if (job.status === 'cancelled' && !job.activeCallLogId && !job.dispatching && job.total > 0 && job.completed === job.total) {
        job.status = 'completed';
        if (job.error?.startsWith('Call completion could not be confirmed.')) job.error = null;
      }
      try {
        const selection = JSON.parse(audience);
        job.runType = selection.runType || (selection.scheduled ? 'scheduled' : selection.contactIds?.length === 1 ? 'single' : 'run');
        job.timezone = selection.timezone;
        job.title = selection.title;
        if (reconciledDnp) selection.outcomes = { ...selection.outcomes, dnp: (selection.outcomes?.dnp || 0) + 1 };
        const campaignCount = selection.campaignIds?.length || 0;
        const scheduled = selection.scheduled ?? (Date.parse(job.scheduledAt) - Date.parse(job.createdAt) >= 30_000);
        return { ...job, campaignCount, ...(campaignCount && scheduled ? { campaignIds: selection.campaignIds } : {}), byStatus: selection.byStatus === true, scheduled, ...(selection.firstDialAt && { firstDialAt: selection.firstDialAt }), ...(selection.outcomes && { outcomes: selection.outcomes }), statuses: Array.isArray(selection.statuses) ? selection.statuses : [] };
      } catch {
        return job;
      }
    }).concat(standalone) });
  } catch (error) { sendError(res, error); }
});
router.get('/:id/details', requirePermission('leads', 'read'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const page = Number(req.query.page || 0);
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(page) || page < 0 || page > 100000) {
      return res.status(400).json({ error: 'Invalid run or page.', code: 'INVALID_REQUEST' });
    }
    const tenantId = req.user.tenantId;
    const job = await prisma.leadDialJob.findFirst({ where: { id, tenantId, ...ownerScope(req) } });
    if (!job) return res.status(404).json({ error: 'Run not found.', code: 'JOB_NOT_FOUND' });
    const selection = JSON.parse(job.audience);
    if (req.query.audience === '1') {
      const visibility = await jobs.visibility(req.user);
      const owner = job.userId === req.user.userId ? req.user : await prisma.user.findFirst({where:{id:job.userId,tenantId},select:{id:true,tenantId:true,role:true}});
      if (!owner) return res.json({leads:[],hasMore:false});
      const ownerVisibility = await jobs.visibility(owner);
      const where = { tenantId, deletedAt: null, ...visibility,
        ...(selection.contactIds?.length ? { id: { in: selection.contactIds } } :
          { ...jobs.audienceWhere(tenantId, selection), id: { lte: job.upperBoundId }, ...visibility }) };
      where.AND = [ownerVisibility];
      if (!selection.contactIds?.length) {
        const {normalizeLeadStatus} = require('../lib/callifiedLeadStatus');
        const statuses = await prisma.contact.groupBy({by:['callifiedLeadStatus'],where});
        where.AND.push({OR:statuses.filter(row=>selection.statuses.includes(normalizeLeadStatus(row.callifiedLeadStatus))).map(row=>({callifiedLeadStatus:row.callifiedLeadStatus}))});
        where.phone = {not:''};
      }
      const leads = await prisma.contact.findMany({ where, orderBy: { id: 'asc' }, skip: page * 25, take: 26,
        select: { id: true, name: true, phone: true } });
      return res.json({ leads: leads.slice(0,25), hasMore: leads.length > 25 });
    }
    const eventWhere = { tenantId, entity: 'LeadDialJob', entityId: id, action: 'DIAL' };
    if (req.query.history === '1') {
      const events = await prisma.auditLog.findMany({where:eventWhere, orderBy:{id:'asc'}, select:{details:true}});
      const attempts = new Map();
      const identities = new Map();
      for (const event of events) {
        try {
          const {contactId,callLogId,name,phone} = JSON.parse(event.details);
          if (contactId && callLogId) {
            attempts.set(contactId,callLogId);
            identities.set(contactId,{...(name && {name}), ...(phone && {phone})});
          }
        } catch { /* Legacy audit entry */ }
      }
      if (job.activeCallLogId && job.cursorId) attempts.set(job.cursorId,job.activeCallLogId);
      const ids = [...new Set([...attempts.keys(), ...(selection.contactIds || [])])];
      const slice = ids.slice(page*25,(page+1)*25);
      const visible = await jobs.visibility(req.user);
      const contacts = await prisma.contact.findMany({where:{tenantId,...visible,id:{in:slice},deletedAt:null},select:{id:true,name:true,phone:true}});
      const callIds = slice.map(key => attempts.get(key)).filter(Boolean);
      const recorded = callIds.length ? await prisma.auditLog.findMany({where:{tenantId,entity:'LeadDialOutcome',entityId:{in:callIds}},select:{entityId:true,action:true}}) : [];
      const byCall = new Map(recorded.map(event => [event.entityId,event.action]));
      if (job.activeCallLogId && callIds.includes(job.activeCallLogId) && !byCall.has(job.activeCallLogId)) {
        const call = await prisma.callLog.findFirst({where:{tenantId,id:job.activeCallLogId,provider:'callified'},select:{id:true,status:true,createdAt:true,contact:{select:classificationFields}}});
        if (call && attemptStatus(call)==='MISSED') byCall.set(call.id,'dnp');
      }
      const lookup = new Map(contacts.map(c => [c.id,c]));
      return res.json({leads:slice.filter(key => lookup.has(key)).map(key => ({...lookup.get(key), ...identities.get(key),
        outcome: attempts.has(key) ? byCall.get(attempts.get(key)) || null : 'notDialed'})), hasMore:ids.length>(page+1)*25, total:ids.length});
    }
    const [eventCount, events] = await Promise.all([prisma.auditLog.count({ where: eventWhere }), prisma.auditLog.findMany({
      where: eventWhere,
      orderBy: { id: 'desc' }, skip: page * 25, take: 26, select: { details: true },
    })]);
    const ids = events.slice(0, 25).flatMap(event => {
      try { return [JSON.parse(event.details).callLogId].filter(Number.isSafeInteger); } catch { return []; }
    });
    if (page === 0 && job.activeCallLogId) ids.push(job.activeCallLogId);
    const logs = ids.length ? await prisma.callLog.findMany({
      where: { tenantId, provider: 'callified', id: { in: ids } }, orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, status: true, duration: true, calleeNumber: true,
        contact: { select: { name: true, phone: true, ...classificationFields } } },
    }) : [];
    const recorded = ids.length ? await prisma.auditLog.findMany({ where: { tenantId, entity: 'LeadDialOutcome', entityId: { in: ids } },
      select: { entityId: true, action: true } }) : [];
    const outcomes = new Map(recorded.map(row => [row.entityId, row.action]));
    const selected = (selection.contactIds || []).slice(page * 25, (page + 1) * 25);
    const leads = selected.length ? await prisma.contact.findMany({ where: { tenantId, id: { in: selected }, deletedAt: null },
      select: { id: true, name: true, phone: true } }) : [];
    res.json({ leads, dialedCount: Math.max(eventCount, page === 0 ? logs.length : 0), hasMore: events.length > 25 || (selection.contactIds?.length || 0) > (page + 1) * 25,
      calls: logs.map(log => ({ id: log.id, name: log.contact?.name, phone: log.calleeNumber || log.contact?.phone,
        at: log.createdAt, duration: log.duration, status: attemptStatus(log), outcome: outcomes.get(log.id) })) });
  } catch (error) { sendError(res, error); }
});
router.post('/preview', requirePermission('leads', 'write'), async (req, res) => {
  try {
    res.json(await jobs.previewSelection(req.user, req.body || {}));
  } catch (error) { sendError(res, error); }
});
router.post('/', requirePermission('leads', 'write'), async (req, res) => {
  try {
    // Validate input before reaching an external integration.
    if (!req.body.startStoppedId) jobs.parseAudience(req.body || {});
    const config = await client.getCallifiedConfig(req.user.tenantId);
    if (!config.isActive) return res.status(409).json({ error: 'Connect Callified before scheduling calls.', code: 'CALLIFIED_NOT_CONFIGURED' });
    if (req.body.startStoppedId) {
      const id = Number(req.body.startStoppedId);
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({error:'Invalid schedule.', code:'INVALID_REQUEST'});
      const where = { id, tenantId: req.user.tenantId, ...ownerScope(req), status: 'stopped', cursorId: 0, dispatching: false, activeCallLogId: null };
      const job = await prisma.leadDialJob.findFirst({where});
      if (!job) return res.status(409).json({error:'This schedule is no longer stopped.',code:'SCHEDULE_CHANGED'});
      const now = new Date();
      const result = await prisma.$transaction(async tx => {
        await tx.tenant.update({where:{id:req.user.tenantId},data:{id:req.user.tenantId}});
        if (await tx.leadDialJob.count({where:{tenantId:req.user.tenantId,status:{in:['scheduled','running']}}}) >= 20) {
          throw Object.assign(new Error('There are already 20 queued runs.'),{status:409,code:'DIAL_QUEUE_FULL'});
        }
        return tx.leadDialJob.updateMany({where, data:{status:'scheduled', scheduledAt:now,
          audience:JSON.stringify({...JSON.parse(job.audience), scheduled:true, restartedAt:now.toISOString()})}});
      });
      if (!result.count) return res.status(409).json({error:'This schedule has changed.',code:'SCHEDULE_CHANGED'});
      await writeAudit('LeadDialJob','START_NOW',id,req.user.userId,req.user.tenantId,{scheduledAt:now});
      return res.status(202).json({job:{id,status:'scheduled'}});
    }
    const job = await jobs.createJob(req.user, req.body || {});
    res.status(202).json({ job });
  } catch (error) { sendError(res, error); }
});
router.post('/:jobId/cancel', requirePermission('leads', 'write'), async (req, res) => {
  try {
    const job = await prisma.leadDialJob.findFirst({ where: { id: Number(req.params.jobId) || 0, tenantId: req.user.tenantId, ...ownerScope(req) } });
    if (!job) return res.status(404).json({ error: 'Dial run not found.', code: 'JOB_NOT_FOUND' });
    const result = await jobs.cancelJob(req.user.tenantId, job.id);
    await writeAudit('LeadDialJob', 'CANCEL', job.id, req.user.userId, req.user.tenantId, result);
    res.json(result);
  } catch (error) { sendError(res, error); }
});
module.exports = router;
