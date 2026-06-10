// Unit tests for lib/patientNotificationService.js — the patient-portal
// notification inbox service (PatientNotification table). Mocking strategy:
// monkey-patch the prisma singleton (vi.mock doesn't intercept the SUT's CJS
// require('./prisma') in this vitest setup), same pattern as the other lib
// tests in this folder.
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import svc from '../../lib/patientNotificationService.js';

const {
  createPatientNotification,
  listPatientNotifications,
  markPatientNotificationRead,
  markAllPatientNotificationsRead,
  toPublic,
} = svc;

beforeAll(() => {
  prisma.patientNotification = {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
});

beforeEach(() => {
  for (const fn of Object.values(prisma.patientNotification)) fn.mockReset();
});

describe('createPatientNotification', () => {
  test('creates with defaults (type=info, link=null)', async () => {
    prisma.patientNotification.create.mockResolvedValue({ id: 1 });
    await createPatientNotification({ patientId: 5, tenantId: 2, title: 'Hi', message: 'There' });
    expect(prisma.patientNotification.create).toHaveBeenCalledWith({
      data: { patientId: 5, tenantId: 2, title: 'Hi', message: 'There', type: 'info', link: null },
    });
  });

  test('passes through explicit type + link', async () => {
    prisma.patientNotification.create.mockResolvedValue({ id: 2 });
    await createPatientNotification({ patientId: 5, tenantId: 2, title: 'Rx', message: 'ready', type: 'prescription', link: '/portal/prescriptions' });
    const data = prisma.patientNotification.create.mock.calls[0][0].data;
    expect(data.type).toBe('prescription');
    expect(data.link).toBe('/portal/prescriptions');
  });

  test('throws when patientId / tenantId missing', async () => {
    await expect(createPatientNotification({ tenantId: 2, title: 'x', message: 'y' })).rejects.toThrow(/patientId and tenantId/);
    await expect(createPatientNotification({ patientId: 5, title: 'x', message: 'y' })).rejects.toThrow(/patientId and tenantId/);
  });

  test('throws when title / message missing', async () => {
    await expect(createPatientNotification({ patientId: 5, tenantId: 2, message: 'y' })).rejects.toThrow(/title and message/);
  });
});

describe('listPatientNotifications', () => {
  test('scopes to patientId, newest-first, returns items + unreadCount', async () => {
    prisma.patientNotification.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    prisma.patientNotification.count.mockResolvedValue(1);
    const r = await listPatientNotifications(7);
    expect(r.items.length).toBe(2);
    expect(r.unreadCount).toBe(1);
    const findArg = prisma.patientNotification.findMany.mock.calls[0][0];
    expect(findArg.where).toEqual({ patientId: 7 });
    expect(findArg.orderBy).toEqual({ createdAt: 'desc' });
    // unread count query is always patientId + isRead:false regardless of filter
    expect(prisma.patientNotification.count.mock.calls[0][0].where).toEqual({ patientId: 7, isRead: false });
  });

  test('unreadOnly adds isRead:false to the list filter', async () => {
    prisma.patientNotification.findMany.mockResolvedValue([]);
    prisma.patientNotification.count.mockResolvedValue(0);
    await listPatientNotifications(7, { unreadOnly: true });
    expect(prisma.patientNotification.findMany.mock.calls[0][0].where).toEqual({ patientId: 7, isRead: false });
  });

  test('limit is clamped to [1, 200]', async () => {
    prisma.patientNotification.findMany.mockResolvedValue([]);
    prisma.patientNotification.count.mockResolvedValue(0);
    await listPatientNotifications(7, { limit: 9999 });
    expect(prisma.patientNotification.findMany.mock.calls[0][0].take).toBe(200);
    await listPatientNotifications(7, { limit: 0 });
    expect(prisma.patientNotification.findMany.mock.calls[1][0].take).toBe(50); // 0 → falsy → default 50
  });
});

describe('markPatientNotificationRead', () => {
  test('returns null when the id does not belong to the patient (cross-patient guard)', async () => {
    prisma.patientNotification.findFirst.mockResolvedValue(null);
    const r = await markPatientNotificationRead(7, 123);
    expect(r).toBeNull();
    // lookup is scoped by BOTH id AND patientId
    expect(prisma.patientNotification.findFirst.mock.calls[0][0].where).toEqual({ id: 123, patientId: 7 });
    expect(prisma.patientNotification.update).not.toHaveBeenCalled();
  });

  test('marks unread → read with readAt timestamp', async () => {
    prisma.patientNotification.findFirst.mockResolvedValue({ id: 123, patientId: 7, isRead: false });
    prisma.patientNotification.update.mockResolvedValue({ id: 123, isRead: true });
    await markPatientNotificationRead(7, 123);
    const upd = prisma.patientNotification.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 123 });
    expect(upd.data.isRead).toBe(true);
    expect(upd.data.readAt).toBeInstanceOf(Date);
  });

  test('idempotent — already-read returns existing without a second update', async () => {
    prisma.patientNotification.findFirst.mockResolvedValue({ id: 123, patientId: 7, isRead: true });
    const r = await markPatientNotificationRead(7, 123);
    expect(r.isRead).toBe(true);
    expect(prisma.patientNotification.update).not.toHaveBeenCalled();
  });
});

describe('markAllPatientNotificationsRead', () => {
  test('updates only this patient unread rows + returns count', async () => {
    prisma.patientNotification.updateMany.mockResolvedValue({ count: 4 });
    const n = await markAllPatientNotificationsRead(7);
    expect(n).toBe(4);
    const arg = prisma.patientNotification.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ patientId: 7, isRead: false });
    expect(arg.data.isRead).toBe(true);
  });
});

describe('toPublic', () => {
  test('strips tenantId from the row', () => {
    expect(toPublic({ id: 1, title: 't', tenantId: 2, patientId: 7 })).toEqual({ id: 1, title: 't', patientId: 7 });
  });
  test('passes null/undefined through', () => {
    expect(toPublic(null)).toBeNull();
  });
});
