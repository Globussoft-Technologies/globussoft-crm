// Unit tests for backend/lib/whatsappSessionGuard.js
//
// The guard is the per-user device-lock + per-tenant relink-cooldown layer over
// the SHARED WhatsApp Web session. These tests pin the decision logic in
// isolation by monkey-patching the shared prisma singleton (the project's CJS
// self-mocking pattern — vitest `inline: [/backend\/lib\//]` means the SUT and
// this test share one prisma instance). writeAudit is left to run against a
// stubbed auditLog so it stays a harmless no-op.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import guard from '../../lib/whatsappSessionGuard.js';

const TENANT = 7;
const USER = 42;
const DEV = 'device-A';

beforeEach(() => {
  // Reset env to defaults so per-test overrides are isolated.
  delete process.env.WA_DEVICE_LOCK;
  delete process.env.WA_DEVICE_HEARTBEAT_TTL_MS;
  delete process.env.WA_RELINK_COOLDOWN_MS;

  if (!prisma.whatsAppWebSession) prisma.whatsAppWebSession = {};
  prisma.whatsAppWebSession.updateMany = vi.fn().mockResolvedValue({ count: 0 });
  prisma.whatsAppWebSession.findMany = vi.fn().mockResolvedValue([]);
  prisma.whatsAppWebSession.findFirst = vi.fn().mockResolvedValue(null);
  prisma.whatsAppWebSession.findUnique = vi.fn().mockResolvedValue(null);
  prisma.whatsAppWebSession.create = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prisma.whatsAppWebSession.update = vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));

  // Keep writeAudit a no-op that never throws.
  if (!prisma.auditLog) prisma.auditLog = {};
  prisma.auditLog.findFirst = vi.fn().mockResolvedValue(null);
  prisma.auditLog.create = vi.fn().mockResolvedValue({ id: 1 });
});

describe('claim — per-user device lock', () => {
  test('same user on a DIFFERENT device is blocked with WA_DEVICE_LOCKED + activeDevice', async () => {
    const loginAt = new Date(Date.now() - 60_000);
    prisma.whatsAppWebSession.findMany.mockResolvedValue([
      { id: 9, deviceId: 'device-B', deviceLabel: 'Yasin · Chrome on Windows', ip: '1.2.3.4', loginAt },
    ]);
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: false });
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('WA_DEVICE_LOCKED');
    expect(res.activeDevice.deviceLabel).toBe('Yasin · Chrome on Windows');
    expect(res.activeDevice.ip).toBe('1.2.3.4');
    // No new claim row created for a blocked attempt.
    expect(prisma.whatsAppWebSession.create).not.toHaveBeenCalled();
  });

  test('the device-lock query is scoped to THIS user, so a different user is never consulted', async () => {
    // findMany returns [] (a different user's row would not match the userId
    // filter) → allowed for this user.
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: true });
    expect(res.allowed).toBe(true);
    const where = prisma.whatsAppWebSession.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(USER);
    expect(where.status).toBe('ACTIVE');
    expect(where.deviceId).toEqual({ not: DEV });
  });

  test('stale claims are expired before the lock check', async () => {
    process.env.WA_DEVICE_HEARTBEAT_TTL_MS = '120000';
    await guard.claim(TENANT, USER, DEV, { isConnected: true });
    expect(prisma.whatsAppWebSession.updateMany).toHaveBeenCalled();
    const arg = prisma.whatsAppWebSession.updateMany.mock.calls[0][0];
    expect(arg.where.status).toBe('ACTIVE');
    expect(arg.where.lastHeartbeat.lt).toBeInstanceOf(Date);
    expect(arg.data.status).toBe('EXPIRED');
  });
});

describe('claim — per-tenant relink cooldown', () => {
  test('blocks a relink when disconnected and within cooldown', async () => {
    process.env.WA_RELINK_COOLDOWN_MS = '900000'; // 15m
    prisma.whatsAppWebSession.findFirst.mockResolvedValue({ logoutAt: new Date(Date.now() - 60_000) });
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: false });
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('WA_RELINK_COOLDOWN');
    expect(res.cooldownRemainingMs).toBeGreaterThan(0);
  });

  test('does NOT apply cooldown when the shared session is already CONNECTED (no QR generated)', async () => {
    prisma.whatsAppWebSession.findFirst.mockResolvedValue({ logoutAt: new Date(Date.now() - 60_000) });
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: true });
    expect(res.allowed).toBe(true);
    // The cooldown lookup should be skipped entirely when connected + no reset.
    expect(prisma.whatsAppWebSession.findFirst).not.toHaveBeenCalled();
  });

  test('cooldown expired → allowed', async () => {
    process.env.WA_RELINK_COOLDOWN_MS = '60000'; // 1m
    prisma.whatsAppWebSession.findFirst.mockResolvedValue({ logoutAt: new Date(Date.now() - 120_000) });
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: false });
    expect(res.allowed).toBe(true);
  });

  test('reset:true is subject to cooldown even when connected', async () => {
    process.env.WA_RELINK_COOLDOWN_MS = '900000';
    prisma.whatsAppWebSession.findFirst.mockResolvedValue({ logoutAt: new Date(Date.now() - 60_000) });
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: true, reset: true });
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('WA_RELINK_COOLDOWN');
  });
});

describe('claim — allow / upsert', () => {
  test('new device → creates an ACTIVE row and reports LOGIN (reconnect:false)', async () => {
    const res = await guard.claim(TENANT, USER, DEV, { deviceLabel: 'lbl', ip: '9.9.9.9', isConnected: false });
    expect(res.allowed).toBe(true);
    expect(res.reconnect).toBe(false);
    expect(prisma.whatsAppWebSession.create).toHaveBeenCalledTimes(1);
    const data = prisma.whatsAppWebSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ tenantId: TENANT, userId: USER, deviceId: DEV, status: 'ACTIVE' });
  });

  test('same device already ACTIVE → updates (no dup) and reports reconnect:true', async () => {
    prisma.whatsAppWebSession.findUnique.mockResolvedValue({ id: 5, status: 'ACTIVE', deviceId: DEV });
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: true });
    expect(res.allowed).toBe(true);
    expect(res.reconnect).toBe(true);
    expect(prisma.whatsAppWebSession.create).not.toHaveBeenCalled();
    expect(prisma.whatsAppWebSession.update).toHaveBeenCalledTimes(1);
    // A live reconnect must NOT reset loginAt.
    expect(prisma.whatsAppWebSession.update.mock.calls[0][0].data.loginAt).toBeUndefined();
  });

  test('reactivating a LOGGED_OUT row refreshes loginAt', async () => {
    prisma.whatsAppWebSession.findUnique.mockResolvedValue({ id: 5, status: 'LOGGED_OUT', deviceId: DEV });
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: false });
    expect(res.allowed).toBe(true);
    expect(res.reconnect).toBe(false);
    expect(prisma.whatsAppWebSession.update.mock.calls[0][0].data.loginAt).toBeInstanceOf(Date);
  });
});

describe('claim — bypass', () => {
  test('WA_DEVICE_LOCK=off → allowed bypass, no lock query', async () => {
    process.env.WA_DEVICE_LOCK = 'off';
    const res = await guard.claim(TENANT, USER, DEV, { isConnected: false });
    expect(res.allowed).toBe(true);
    expect(res.bypass).toBe(true);
    expect(prisma.whatsAppWebSession.findMany).not.toHaveBeenCalled();
  });

  test('missing deviceId → allowed bypass (backward compatible)', async () => {
    const res = await guard.claim(TENANT, USER, undefined, { isConnected: false });
    expect(res.allowed).toBe(true);
    expect(res.bypass).toBe(true);
    expect(prisma.whatsAppWebSession.findMany).not.toHaveBeenCalled();
  });
});

describe('heartbeat', () => {
  test('ACTIVE claim → ok:true and refreshes lastHeartbeat', async () => {
    prisma.whatsAppWebSession.findUnique.mockResolvedValue({ id: 3, status: 'ACTIVE' });
    const res = await guard.heartbeat(TENANT, USER, DEV);
    expect(res).toEqual({ ok: true, lost: false });
    expect(prisma.whatsAppWebSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3 } }),
    );
  });

  test('no row / not ACTIVE → lost:true', async () => {
    prisma.whatsAppWebSession.findUnique.mockResolvedValue(null);
    expect(await guard.heartbeat(TENANT, USER, DEV)).toEqual({ ok: false, lost: true });
    prisma.whatsAppWebSession.findUnique.mockResolvedValue({ id: 3, status: 'EXPIRED' });
    expect(await guard.heartbeat(TENANT, USER, DEV)).toEqual({ ok: false, lost: true });
  });

  test('no deviceId → ok:false, lost:false', async () => {
    expect(await guard.heartbeat(TENANT, USER, undefined)).toEqual({ ok: false, lost: false });
  });
});

describe('release', () => {
  test('marks the claim LOGGED_OUT + stamps logoutAt (starts cooldown)', async () => {
    prisma.whatsAppWebSession.updateMany.mockResolvedValue({ count: 1 });
    const res = await guard.release(TENANT, USER, DEV, { logout: true });
    expect(res.released).toBe(1);
    const arg = prisma.whatsAppWebSession.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: TENANT, userId: USER, deviceId: DEV });
    expect(arg.data.status).toBe('LOGGED_OUT');
    expect(arg.data.logoutAt).toBeInstanceOf(Date);
  });

  test('no deviceId → releases all of the user\'s ACTIVE claims', async () => {
    prisma.whatsAppWebSession.updateMany.mockResolvedValue({ count: 2 });
    await guard.release(TENANT, USER, undefined, {});
    const arg = prisma.whatsAppWebSession.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ tenantId: TENANT, userId: USER, status: 'ACTIVE' });
  });
});
