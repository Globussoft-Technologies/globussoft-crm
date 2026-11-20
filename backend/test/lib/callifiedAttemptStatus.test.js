import { expect, it } from 'vitest';
import resolver from '../../lib/callifiedAttemptStatus.js';

it('shows automatic DNP for the matching latest call only', () => {
  const log = { id: 7, status: 'INITIATED', createdAt: '2026-11-20T05:21:00Z',
    contact: { callLogs: [{ id: 7 }], callifiedLeadStatus: 'dnp', callifiedLeadStatusSource: 'transcripts_api', callifiedLeadStatusUpdatedAt: '2026-11-20T05:23:00Z' } };
  expect(resolver.attemptStatus(log)).toBe('MISSED');
  expect(resolver.attemptStatus({ ...log, status: 'FAILED' })).toBe('MISSED');
  expect(resolver.attemptStatus({ ...log, status: 'FAILED', id: 6 })).toBe('FAILED');
  expect(resolver.attemptStatus({ ...log, status: 'FAILED', contact: null })).toBe('FAILED');
  expect(resolver.attemptStatus({ ...log, id: 6 })).toBe('INITIATED');
  expect(resolver.attemptStatus({ ...log, contact: { ...log.contact, callifiedLeadStatusSource: 'manual' } })).toBe('INITIATED');
});
