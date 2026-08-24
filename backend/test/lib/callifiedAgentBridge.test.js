// @ts-check
/**
 * Tests for backend/lib/callifiedAgentBridge.js.
 *
 * The relay exists so the browser can join a Callified agent socket WITHOUT
 * ever holding the tenant's Callified API credential. The security-relevant
 * half of that promise lives in the ticket lifecycle, so that is what is
 * pinned here:
 *
 *   - a ticket is single-use (a replayed one is refused)
 *   - a ticket expires
 *   - an unknown ticket is refused
 *   - the grant carries the tenant, so a redeemed ticket cannot be pointed at
 *     another tenant's call
 *
 * Plus the two pure helpers around it: upstream URL construction and the
 * startBrowserCall wiring that mints the ticket after a call is placed.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const requireCJS = createRequire(import.meta.url);
const Module = requireCJS('node:module');

// Stub the Callified client BEFORE the bridge module loads it — the bridge
// must never reach the network in a unit test.
const callifiedClientPath = requireCJS.resolve('../../services/callifiedClient.js');
const initiateBrowserCallForContactMock = vi.fn();
const resolveAgentSocketUrlMock = vi.fn();
Module._cache[callifiedClientPath] = {
  id: callifiedClientPath,
  filename: callifiedClientPath,
  loaded: true,
  exports: {
    initiateBrowserCallForContact: initiateBrowserCallForContactMock,
    resolveAgentSocketUrl: resolveAgentSocketUrlMock,
    getCallifiedToken: vi.fn(),
    getCallifiedConfig: vi.fn(),
  },
};

const bridge = requireCJS('../../lib/callifiedAgentBridge');
const {
  BRIDGE_PATH,
  issueBridgeTicket,
  redeemBridgeTicket,
  clearBridgeTickets,
  buildUpstreamUrl,
  startBrowserCall,
} = bridge;

const GRANT = {
  tenantId: 7,
  userId: 42,
  callSid: 'EXotelabc123',
  agentSocketUrl: 'wss://app.callified.ai/ws/agent?call_sid=EXotelabc123',
  callLogId: 55,
};

describe('bridge tickets', () => {
  beforeEach(() => {
    clearBridgeTickets();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearBridgeTickets();
  });

  test('a ticket redeems once and carries the full grant', () => {
    const { ticket, path } = issueBridgeTicket(GRANT);
    expect(path).toBe(BRIDGE_PATH);

    const grant = redeemBridgeTicket(ticket);
    expect(grant).toMatchObject({
      tenantId: 7,
      userId: 42,
      callSid: 'EXotelabc123',
      agentSocketUrl: GRANT.agentSocketUrl,
      callLogId: 55,
    });
  });

  test('replaying a ticket is refused — one ticket, one connection', () => {
    const { ticket } = issueBridgeTicket(GRANT);
    expect(redeemBridgeTicket(ticket)).not.toBeNull();
    expect(redeemBridgeTicket(ticket)).toBeNull();
  });

  test('an unknown or empty ticket is refused', () => {
    expect(redeemBridgeTicket('not-a-real-ticket')).toBeNull();
    expect(redeemBridgeTicket('')).toBeNull();
    expect(redeemBridgeTicket(undefined)).toBeNull();
  });

  test('a ticket expires, so a leaked URL goes stale on its own', () => {
    vi.useFakeTimers();
    const { ticket, expiresInMs } = issueBridgeTicket(GRANT);
    vi.advanceTimersByTime(expiresInMs + 1000);
    expect(redeemBridgeTicket(ticket)).toBeNull();
  });

  test('two tickets are distinct and unguessable in length', () => {
    const a = issueBridgeTicket(GRANT).ticket;
    const b = issueBridgeTicket({ ...GRANT, callSid: 'EXotelxyz789' }).ticket;
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64); // 32 random bytes, hex-encoded
  });

  test('refuses to mint a ticket without the fields the relay needs', () => {
    expect(() => issueBridgeTicket({ ...GRANT, tenantId: null })).toThrow(/tenantId/);
    expect(() => issueBridgeTicket({ ...GRANT, callSid: null })).toThrow(/callSid/);
    expect(() => issueBridgeTicket({ ...GRANT, agentSocketUrl: null })).toThrow(/agentSocketUrl/);
  });
});

describe('buildUpstreamUrl', () => {
  test('appends the Callified JWT as a token query param by default', () => {
    const url = buildUpstreamUrl('wss://app.callified.ai/ws/agent?call_sid=abc', 'jwt-value');
    expect(url).toContain('call_sid=abc');
    expect(url).toContain('token=jwt-value');
  });

  test('honours a tenant that opts the query param out', () => {
    const url = buildUpstreamUrl('wss://app.callified.ai/ws/agent?call_sid=abc', 'jwt-value', {
      tokenInQuery: false,
    });
    expect(url).not.toContain('token=');
  });

  test('never overwrites a token Callified already put in the URL', () => {
    const url = buildUpstreamUrl('wss://app.callified.ai/ws/agent?token=theirs', 'ours');
    expect(url).toContain('token=theirs');
    expect(url).not.toContain('ours');
  });

  test('an unparseable URL is passed through rather than throwing mid-call', () => {
    expect(buildUpstreamUrl('not a url', 'jwt')).toBe('not a url');
  });
});

describe('startBrowserCall', () => {
  beforeEach(() => {
    clearBridgeTickets();
    initiateBrowserCallForContactMock.mockReset();
    resolveAgentSocketUrlMock.mockReset();
  });

  test('places the call, then mints a ticket bound to it', async () => {
    initiateBrowserCallForContactMock.mockResolvedValue({
      callifiedLeadId: 900,
      callSid: 'EXsid1',
      agentUrl: '/ws/agent?call_sid=EXsid1',
      callLogId: 77,
      status: 'dialing',
    });
    resolveAgentSocketUrlMock.mockResolvedValue('wss://app.callified.ai/ws/agent?call_sid=EXsid1');

    const result = await startBrowserCall({
      tenantId: 7,
      contactId: 11,
      campaignId: 42,
      userId: 5,
    });

    expect(result.callSid).toBe('EXsid1');
    expect(result.bridgePath).toBe(BRIDGE_PATH);
    expect(result.bridgeTicket).toHaveLength(64);

    const grant = redeemBridgeTicket(result.bridgeTicket);
    expect(grant).toMatchObject({
      tenantId: 7,
      userId: 5,
      callSid: 'EXsid1',
      callLogId: 77,
      agentSocketUrl: 'wss://app.callified.ai/ws/agent?call_sid=EXsid1',
    });
  });

  test('falls back to a call_sid agent path when Callified omits agent_url', async () => {
    initiateBrowserCallForContactMock.mockResolvedValue({
      callifiedLeadId: 900,
      callSid: 'EXsid2',
      agentUrl: null,
      callLogId: 78,
    });
    resolveAgentSocketUrlMock.mockResolvedValue('wss://app.callified.ai/ws/agent?call_sid=EXsid2');

    await startBrowserCall({ tenantId: 7, contactId: 11, campaignId: 42 });

    expect(resolveAgentSocketUrlMock).toHaveBeenCalledWith(7, '/ws/agent?call_sid=EXsid2');
  });

  test('a failed call mints no ticket', async () => {
    initiateBrowserCallForContactMock.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'MISSING_PHONE' }),
    );

    await expect(
      startBrowserCall({ tenantId: 7, contactId: 11, campaignId: 42 }),
    ).rejects.toThrow('nope');
    expect(resolveAgentSocketUrlMock).not.toHaveBeenCalled();
  });
});
