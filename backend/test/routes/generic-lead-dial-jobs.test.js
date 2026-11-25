import { beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';
const require = createRequire(import.meta.url);
const client = require('../../services/callifiedClient');
const router = require('../../routes/generic_lead_dial_jobs');
const app = express();
app.use(express.json()); app.use('/jobs', router);
let role;
const token = () => jwt.sign({ userId: 7, tenantId: 1, role }, process.env.JWT_SECRET || 'enterprise_super_secret_key_2026', { expiresIn: '1h' });
const auth = () => ({ Authorization: `Bearer ${token()}` });
beforeEach(() => {
  role = 'ADMIN';
  prisma.user.findUnique = vi.fn().mockImplementation(async () => ({ id: 7, tenantId: 1, role, isActive: true, deactivatedAt: null }));
  prisma.revokedToken.findUnique = vi.fn().mockResolvedValue(null);
  prisma.tenant.findUnique = vi.fn().mockResolvedValue({ vertical: 'generic' });
  prisma.leadDialJob = {
    findMany: vi.fn().mockResolvedValue([{ id: 2, audience: 'private', status: 'scheduled' }]),
    findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  prisma.callLog.findFirst = vi.fn().mockResolvedValue(null);
  prisma.tenantSetting.findUnique = vi.fn().mockResolvedValue(null);
  prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
  prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
  client.getCallifiedConfig = vi.fn().mockResolvedValue({ isActive: false });
});
it('requires authentication', async () => {
  expect((await request(app).get('/jobs')).status).toBe(401);
});
it('reads a stopped schedule audience using a tenant-scoped page', async () => {
  prisma.leadDialJob.findFirst.mockResolvedValue({id:8,userId:7,status:'stopped',audience:JSON.stringify({contactIds:[4,5]})});
  prisma.contact.findMany = vi.fn().mockResolvedValue([{id:4,name:'Example',phone:'5550101'}]);
  const result=await request(app).get('/jobs/8/details?audience=1').set(auth());
  expect(result.body.leads[0].name).toBe('Example');
  expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({take:26,where:expect.objectContaining({tenantId:1,id:{in:[4,5]}})}));
});
it('includes standalone retry history with the recorded lead outcome',async()=>{
  prisma.leadDialJob.findMany.mockResolvedValue([]);
  prisma.auditLog.findMany=vi.fn().mockResolvedValueOnce([{entityId:31,action:'pending',details:'{"name":"Taylor"}'}]).mockResolvedValueOnce([{entityId:31,action:'dnp'}]);
  prisma.callLog.findMany=vi.fn().mockResolvedValue([{id:31,status:'MISSED',calleeNumber:'5550103',createdAt:new Date()}]);
  const result=await request(app).get('/jobs?history=1').set(auth());
  expect(result.body.jobs).toEqual([expect.objectContaining({runType:'pending',outcomes:{dnp:1},leads:[{id:31,name:'Taylor',phone:'5550103',outcome:'dnp'}]})]);
});
it('starts an untouched stopped schedule once, using its existing audience',async()=>{
  client.getCallifiedConfig.mockResolvedValue({isActive:true});
  prisma.leadDialJob.findFirst.mockResolvedValue({id:8,audience:JSON.stringify({contactIds:[4],timezone:'Asia/Kolkata'})});
  const tx={tenant:{update:vi.fn()},leadDialJob:{count:vi.fn().mockResolvedValue(0),updateMany:vi.fn().mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0})}};
  prisma.$transaction=vi.fn(work=>work(tx));
  const start=()=>request(app).post('/jobs').set(auth()).send({startStoppedId:8});
  expect((await start()).status).toBe(202);
  const update=tx.leadDialJob.updateMany.mock.calls[0][0];
  expect(update.where).toMatchObject({id:8,tenantId:1,status:'stopped',cursorId:0,activeCallLogId:null});
  expect(JSON.parse(update.data.audience)).toMatchObject({contactIds:[4],timezone:'Asia/Kolkata',restartedAt:expect.any(String)});
  expect((await start()).status).toBe(409);
});
it('gates the workspace by vertical', async () => {
  prisma.tenant.findUnique.mockResolvedValue({ vertical: 'wellness' });
  const result = await request(app).get('/jobs').set(auth());
  expect(result.status).toBe(403); expect(result.body.code).toBe('GENERIC_ONLY');
});
it('returns active and past runs with safe audience summaries', async () => {
  prisma.leadDialJob.findMany
    .mockResolvedValueOnce([{ id: 2, audience: JSON.stringify({ campaignIds: [12], statuses: ['yet_to_call', 'dnp'], scheduled: false }), status: 'running' }])
    .mockResolvedValueOnce([{ id: 1, audience: 'private', status: 'completed' }]);
  const result = await request(app).get('/jobs').set(auth());
  expect(result.status).toBe(200);
  expect(result.body.jobs).toEqual([
    { id: 2, status: 'running', campaignCount: 1, byStatus: false, scheduled: false, runType:'run', statuses: ['yet_to_call', 'dnp'] },
    { id: 1, status: 'completed' },
  ]);
  expect(prisma.leadDialJob.findMany).toHaveBeenCalledTimes(2);
  for (const [query] of prisma.leadDialJob.findMany.mock.calls) {
    expect(query.where.tenantId).toBe(1);
    expect(query.take).toBe(30);
  }
});
it('returns server time and tenant-scoped retry queues with dial runs', async () => {
  prisma.tenantSetting.findMany = vi.fn().mockResolvedValue([
    { key: 'feature.callified.retry.timezone', value: 'Asia/Kolkata' },
    { key: 'feature.callified.dnp_retry.enabled', value: 'false' },
    { key: 'feature.callified.pending_retry.max_retries', value: '1' },
  ]);
  prisma.contact.count = vi.fn().mockResolvedValue(0);
  prisma.contact.findMany = vi.fn().mockResolvedValue([]);
  prisma.callLog.findMany = vi.fn().mockResolvedValue([
    { id: 5, status: 'CONNECTED', contact: { name: 'Taylor' }, calleeNumber: '5550100' },
    { id: 4, status: 'RINGING' },
  ]);

  const result = await request(app).get('/jobs?includeQueues=1').set(auth());
  expect(result.status).toBe(200);
  expect(result.body.queues).toMatchObject({
    serverTime: expect.any(String), timezone: 'Asia/Kolkata', activeCalls: 2,
    pending: { enabled: true, maxRetries: 1, entries: [] },
    dnp: { enabled: false, entries: [] },
    autoDial: { queued: 0, submitting: 0 },
  });
  expect(prisma.contact.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ tenantId: 1, callifiedLeadStatus: 'pending', callifiedDnpRetryCount: { lt: 1 } }),
    take: 5,
  }));
  expect(result.body.queues.calls[0]).toMatchObject({ name: 'Taylor', phone: '5550100' });
  expect(prisma.callLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }) }));
});
it('shows the failure only for the matching persisted retry deadline', async () => {
  const dueAt = new Date('2026-11-19T11:52:28.501Z');
  prisma.tenantSetting.findMany = vi.fn().mockResolvedValue([]);
  prisma.contact.count = vi.fn().mockResolvedValue(0);
  prisma.contact.findMany = vi.fn().mockImplementation(async ({ where }) =>
    where.callifiedLeadStatus === 'pending' ? [{ id: 3, callifiedDnpNextRetryAt: dueAt }] : []);
  prisma.callLog.findMany = vi.fn().mockResolvedValue([]);
  prisma.auditLog.findMany = vi.fn().mockResolvedValue([
    { entityId: 3, details: JSON.stringify({ code: 'CALLIFIED_API_403', nextRetryAt: '2026-11-19T11:47:00Z' }) },
    { entityId: 3, details: JSON.stringify({ code: 'CALLIFIED_API_503', nextRetryAt: dueAt }) },
  ]);
  const result = await request(app).get('/jobs?includeQueues=1').set(auth());
  expect(result.status).toBe(200);
  expect(result.body.queues.pending.entries[0]).toMatchObject({ id: 3, retryFailure: 'CALLIFIED_API_503' });
  expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ tenantId: 1, entityId: { in: [3] } }),
  }));
});
it('rejects a qualified audience before consulting the provider', async () => {
  const result = await request(app).post('/jobs').set(auth()).send({ contactIds: [3], statuses: ['qualified'] });
  expect(result.status).toBe(400); expect(client.getCallifiedConfig).not.toHaveBeenCalled();
});
it('explains an unconfigured integration without dispatching calls', async () => {
  const result = await request(app).post('/jobs').set(auth()).send({ contactIds: [3] });
  expect(result.status).toBe(409); expect(result.body.code).toBe('CALLIFIED_NOT_CONFIGURED');
});
it('cannot cancel another tenant job', async () => {
  const result = await request(app).post('/jobs/99/cancel').set(auth()).send({});
  expect(result.status).toBe(404);
  expect(prisma.leadDialJob.findFirst).toHaveBeenCalledWith({ where: { id: 99, tenantId: 1 } });
});
it('cannot stop another tenant call', async () => {
  const result = await request(app).post('/jobs/calls/99/stop').set(auth()).send({});
  expect(result.status).toBe(404);
  expect(prisma.callLog.findFirst).not.toHaveBeenCalled();
});
it('validates the workspace pause control', async () => {
  const result = await request(app).put('/jobs/control').set(auth()).send({ paused: 'yes' });
  expect(result.status).toBe(400);
});
it('stops future workspace calls without contacting active calls', async () => {
  prisma.tenantSetting.upsert = vi.fn().mockResolvedValue({ value: 'true' });
  prisma.callLog.findMany = vi.fn();
  const result = await request(app).put('/jobs/control').set(auth()).send({ paused: true });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ paused: true, currentCallsContinue: true });
  expect(prisma.leadDialJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: 1 }), data: { status: 'cancelled' } }));
  expect(prisma.callLog.findMany).not.toHaveBeenCalled();
});
it.each([['COMPLETED', 'completed'], ['MISSED', 'completed'], ['FAILED', 'failed'], ['CANCELLED', 'skipped']])('reports a stopped run’s final %s call', async (status, counter) => {
  prisma.leadDialJob.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{
    id: 2, audience: '{}', status: 'cancelled', total: 1, activeCallLogId: 17, completed: 0, skipped: 0, failed: 0, error: 'Call completion could not be confirmed. Check the active call before starting another run.',
  }]);
  prisma.callLog.findMany = vi.fn().mockResolvedValue([{ id: 17, status }]);
  const result = await request(app).get('/jobs').set(auth());
  expect(result.body.jobs[0]).toMatchObject({ status: counter === 'completed' ? 'completed' : 'cancelled', activeCallLogId: null, error: null, [counter]: 1 });
  if (status === 'MISSED') expect(result.body.jobs[0].outcomes).toEqual({ dnp: 1 });
});
