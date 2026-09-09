import { beforeEach, describe, expect, test, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';
import prisma from '../../lib/prisma.js';

const requireCJS = createRequire(import.meta.url);
const { JWT_SECRET } = requireCJS('../../config/secrets');

prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn();
prisma.liveChatSession = prisma.liveChatSession || {};
prisma.liveChatSession.findFirst = vi.fn();

const { authenticateSocket, attachAuthenticatedSocket, handshakeToken } = requireCJS('../../lib/socketAuth');
const { emitToTenant, tenantRoom, userRoom } = requireCJS('../../lib/socketRooms');

function runAuth(socket) {
  return new Promise((resolve) => authenticateSocket(socket, resolve));
}

function fakeSocket(token) {
  const handlers = {};
  const roomEmitter = { emit: vi.fn() };
  return {
    id: 'socket-1',
    data: {},
    handshake: { auth: token ? { token } : {}, headers: {} },
    join: vi.fn(),
    on: vi.fn((event, handler) => { handlers[event] = handler; }),
    to: vi.fn(() => roomEmitter),
    handlers,
    roomEmitter,
  };
}

beforeEach(() => {
  prisma.user.findUnique.mockReset();
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.liveChatSession.findFirst.mockReset();
});

describe('Socket authentication and rooms', () => {
  test('rejects a handshake without credentials', async () => {
    const error = await runAuth(fakeSocket());
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/authentication required/i);
  });

  test('accepts a live staff token and derives tenant/user rooms server-side', async () => {
    const token = jwt.sign({ userId: 7, tenantId: 12, role: 'USER', sessionVersion: 3 }, JWT_SECRET);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      tenantId: 12,
      name: 'Agent Seven',
      email: 'agent@example.com',
      deactivatedAt: null,
      sessionVersion: 3,
    });
    const socket = fakeSocket(token);

    expect(await runAuth(socket)).toBeUndefined();
    attachAuthenticatedSocket(socket);

    expect(socket.data.user).toMatchObject({ userId: 7, tenantId: 12, name: 'Agent Seven' });
    expect(socket.join).toHaveBeenCalledWith(tenantRoom(12));
    expect(socket.join).toHaveBeenCalledWith(userRoom(12, 7));
    expect(socket.handlers.join_room).toBeUndefined();
  });

  test('rejects a token whose tenant differs from the live account', async () => {
    const token = jwt.sign({ userId: 7, tenantId: 99 }, JWT_SECRET);
    prisma.user.findUnique.mockResolvedValue({
      id: 7,
      tenantId: 12,
      name: 'Agent Seven',
      email: 'agent@example.com',
      deactivatedAt: null,
      sessionVersion: 0,
    });

    const error = await runAuth(fakeSocket(token));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/tenant/i);
  });

  test('allows joining a chat only when it belongs to the authenticated tenant', async () => {
    const socket = fakeSocket();
    socket.data.user = { userId: 7, tenantId: 12, name: 'Agent' };
    attachAuthenticatedSocket(socket);
    const acknowledge = vi.fn();

    prisma.liveChatSession.findFirst.mockResolvedValue(null);
    await socket.handlers.join_chat(44, acknowledge);
    expect(prisma.liveChatSession.findFirst).toHaveBeenCalledWith({
      where: { id: 44, tenantId: 12 },
      select: { id: true },
    });
    expect(socket.join).not.toHaveBeenCalledWith('chat:44');
    expect(acknowledge).toHaveBeenCalledWith({ ok: false });
  });

  test('tenant emitters never broadcast on the root namespace', () => {
    const emit = vi.fn();
    const io = { emit, to: vi.fn(() => ({ emit: vi.fn() })) };
    emitToTenant(io, 6, 'deal_updated', { id: 1 });
    expect(io.to).toHaveBeenCalledWith('tenant:6');
    expect(emit).not.toHaveBeenCalled();
  });

  test('reads the HttpOnly migration cookie when auth payload is absent', () => {
    expect(handshakeToken({ handshake: { auth: {}, headers: { cookie: 'x=1; auth_token=abc%20123' } } }))
      .toBe('abc 123');
  });
});
