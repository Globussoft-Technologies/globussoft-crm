/**
 * Callified agent-bridge WebSocket relay.
 *
 * WHAT THIS IS
 *   `POST /api/campaigns/{c}/leads/{l}/browser-call` asks Callified to place
 *   the customer leg of a call and bridge its audio to a WebSocket. Callified
 *   returns a `call_sid` plus a relative `agent_url` (`/ws/agent?call_sid=…`)
 *   that a human agent's browser is meant to join so the agent can talk to
 *   the customer.
 *
 * WHY A RELAY INSTEAD OF A DIRECT BROWSER CONNECTION
 *   `agent_url` points at Callified's host and needs a Callified JWT. That JWT
 *   is the tenant's org-wide API credential — handing it to the browser would
 *   expose every Callified endpoint (leads, campaigns, billing) to anything
 *   running on the page. So the browser connects to THIS server instead, with
 *   a single-use short-TTL ticket, and the backend holds the Callified
 *   credential and pipes frames through.
 *
 *   The relay is deliberately protocol-agnostic: it forwards frames verbatim
 *   in both directions (text and binary), so it keeps working regardless of
 *   what audio envelope Callified's agent socket speaks. The only frames it
 *   injects are namespaced `{"type":"bridge", …}` control messages, which
 *   cannot collide with Callified's own `{"event": …}` frames.
 *
 * WIRE CONTRACT WITH THE BROWSER
 *   Connect:  wss://<crm-host>/ws/callified-agent?ticket=<ticket>
 *   Server →  {"type":"bridge","event":"ready"}          upstream is open
 *             {"type":"bridge","event":"error","message"} upstream failed
 *             {"type":"bridge","event":"closed","code"}   upstream went away
 *             …plus every frame Callified sends, verbatim.
 *   Client →  every frame is forwarded to Callified verbatim. Frames sent
 *             before the upstream is open are queued (capped) and flushed.
 *
 * MOUNTING
 *   `attachCallifiedAgentBridge(server)` must be called BEFORE socket.io
 *   attaches to the same HTTP server. engine.io snapshots the existing
 *   'upgrade' listeners at attach time and delegates non-socket.io upgrades
 *   back to them; a listener registered afterwards would race engine.io's
 *   own abortConnection for unknown paths.
 */

const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const prisma = require('./prisma');
const callifiedClient = require('../services/callifiedClient');

const BRIDGE_PATH = '/ws/callified-agent';

// A ticket is a one-shot capability minted by an already-authenticated,
// role-checked HTTP request. Short TTL because the browser redeems it
// immediately after the POST that created it resolves.
const TICKET_TTL_MS = Number(process.env.CALLIFIED_BRIDGE_TICKET_TTL_MS) || 60 * 1000;
const TICKET_SWEEP_MS = 60 * 1000;

// Frames the browser sends before the upstream socket finishes connecting.
// Mic capture starts as soon as the user grants permission, which can be
// before Callified's handshake completes. Capped so a never-opening upstream
// cannot grow unbounded (~a few seconds of 8 kHz PCM16 at 20 ms/frame).
const MAX_PENDING_FRAMES = 200;

const HANDSHAKE_TIMEOUT_MS = Number(process.env.CALLIFIED_BRIDGE_HANDSHAKE_MS) || 15 * 1000;
const KEEPALIVE_MS = 25 * 1000;

/** @type {Map<string, {tenantId:number,userId:number|null,callSid:string,agentSocketUrl:string,callLogId:number|null,expiresAt:number}>} */
const tickets = new Map();

let sweepTimer = null;

function sweepTickets(now = Date.now()) {
  let removed = 0;
  for (const [key, grant] of tickets) {
    if (grant.expiresAt <= now) {
      tickets.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepTickets(), TICKET_SWEEP_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/**
 * Mint a single-use ticket the browser can redeem for a relayed connection.
 *
 * @param {{tenantId:number, userId?:number|null, callSid:string,
 *          agentSocketUrl:string, callLogId?:number|null}} grant
 * @returns {{ticket:string, path:string, expiresInMs:number}}
 */
function issueBridgeTicket({ tenantId, userId, callSid, agentSocketUrl, callLogId }) {
  if (!tenantId) throw new Error('tenantId required to issue a bridge ticket');
  if (!callSid) throw new Error('callSid required to issue a bridge ticket');
  if (!agentSocketUrl) throw new Error('agentSocketUrl required to issue a bridge ticket');

  startSweeper();
  sweepTickets();

  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, {
    tenantId: Number(tenantId),
    userId: userId ? Number(userId) : null,
    callSid: String(callSid),
    agentSocketUrl: String(agentSocketUrl),
    callLogId: callLogId ? Number(callLogId) : null,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });

  return { ticket, path: BRIDGE_PATH, expiresInMs: TICKET_TTL_MS };
}

/**
 * Redeem (and burn) a ticket. Returns null when unknown or expired.
 */
function redeemBridgeTicket(ticket) {
  if (!ticket) return null;
  const grant = tickets.get(ticket);
  if (!grant) return null;
  tickets.delete(ticket);
  if (grant.expiresAt <= Date.now()) return null;
  return grant;
}

function clearBridgeTickets() {
  tickets.clear();
}

/**
 * Build the upstream URL, optionally carrying the Callified JWT as a query
 * param. The documented surface does not state how the agent socket
 * authenticates, so we send the bearer header AND (unless a tenant opts out
 * via Integration settings) the conventional `token` query param.
 */
function buildUpstreamUrl(agentSocketUrl, jwt, { tokenInQuery = true } = {}) {
  if (!tokenInQuery || !jwt) return agentSocketUrl;
  try {
    const url = new URL(agentSocketUrl);
    if (!url.searchParams.has('token')) url.searchParams.set('token', jwt);
    return url.toString();
  } catch (_e) {
    return agentSocketUrl;
  }
}

function safeSend(socket, payload, isBinary = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(payload, { binary: isBinary });
    return true;
  } catch (e) {
    console.warn(`[callifiedAgentBridge] send failed: ${e.message}`);
    return false;
  }
}

function sendControl(socket, event, extra = {}) {
  safeSend(socket, JSON.stringify({ type: 'bridge', event, ...extra }));
}

/**
 * Reflect the live bridge state onto the CRM CallLog row so the existing
 * call-history surfaces show a real outcome for human calls too. Best-effort:
 * a DB hiccup must never tear down an in-progress call.
 */
async function updateBridgeCallLog(callLogId, patch) {
  if (!callLogId) return;
  try {
    await prisma.callLog.update({ where: { id: Number(callLogId) }, data: patch });
  } catch (e) {
    console.warn(`[callifiedAgentBridge] CallLog ${callLogId} update failed: ${e.message}`);
  }
}

/**
 * Wire the relay onto an existing http.Server.
 *
 * @param {import('http').Server} server
 * @returns {import('ws').WebSocketServer}
 */
function attachCallifiedAgentBridge(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_e) {
      pathname = req.url;
    }
    if (pathname !== BRIDGE_PATH) {
      // engine.io delegates every non-socket.io upgrade here, and this is the
      // last handler in the chain — mirror engine.io's own behaviour for a
      // path nobody claims rather than leaving the socket hanging.
      socket.destroy();
      return;
    }

    let ticket = null;
    try {
      ticket = new URL(req.url, 'http://localhost').searchParams.get('ticket');
    } catch (_e) {
      ticket = null;
    }

    const grant = redeemBridgeTicket(ticket);
    if (!grant) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      handleAgentConnection(client, grant);
    });
  });

  console.log(`[callifiedAgentBridge] listening for agent bridges on ${BRIDGE_PATH}`);
  return wss;
}

/**
 * Own one browser↔Callified bridge for its whole lifetime.
 */
function handleAgentConnection(client, grant) {
  const { tenantId, callSid, agentSocketUrl, callLogId } = grant;
  const tag = `[callifiedAgentBridge] tenant=${tenantId} call=${callSid}`;
  console.log(`${tag} browser connected, dialing upstream`);

  /** @type {import('ws')|null} */
  let upstream = null;
  let pending = [];
  let closed = false;
  let connectedAt = null;

  const teardown = (reason, code) => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);

    if (connectedAt) {
      const duration = Math.max(0, Math.round((Date.now() - connectedAt) / 1000));
      updateBridgeCallLog(callLogId, {
        status: 'COMPLETED',
        duration,
      });
    } else {
      updateBridgeCallLog(callLogId, { status: 'FAILED' });
    }

    try {
      if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close(1000, 'bridge closed');
    } catch (_e) {
      /* already gone */
    }
    try {
      if (client.readyState <= WebSocket.OPEN) client.close(code || 1000, reason || 'bridge closed');
    } catch (_e) {
      /* already gone */
    }
    console.log(`${tag} bridge torn down (${reason || 'normal'})`);
  };

  const keepalive = setInterval(() => {
    try {
      if (client.readyState === WebSocket.OPEN) client.ping();
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.ping();
    } catch (_e) {
      /* ignore */
    }
  }, KEEPALIVE_MS);
  if (typeof keepalive.unref === 'function') keepalive.unref();

  // Browser → Callified. Queue until the upstream handshake completes.
  client.on('message', (data, isBinary) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) {
      safeSend(upstream, data, isBinary);
      return;
    }
    if (pending.length < MAX_PENDING_FRAMES) {
      pending.push([data, isBinary]);
    }
  });

  client.on('close', (code) => teardown(`browser closed (${code})`, 1000));
  client.on('error', (err) => {
    console.warn(`${tag} browser socket error: ${err.message}`);
    teardown('browser error', 1011);
  });

  (async () => {
    let jwt = null;
    let tokenInQuery = true;
    try {
      jwt = await callifiedClient.getCallifiedToken(tenantId);
      const config = await callifiedClient.getCallifiedConfig(tenantId);
      // Tenants whose Callified deployment rejects the query param can opt out
      // without a code change.
      if (config && config.agentBridgeTokenInQuery === false) tokenInQuery = false;
    } catch (e) {
      console.error(`${tag} could not obtain a Callified token: ${e.message}`);
      sendControl(client, 'error', { message: 'Callified authentication failed', code: e.code || null });
      teardown('upstream auth failed', 1011);
      return;
    }

    if (closed) return;

    const url = buildUpstreamUrl(agentSocketUrl, jwt, { tokenInQuery });
    upstream = new WebSocket(url, {
      headers: { Authorization: `Bearer ${jwt}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: 4 * 1024 * 1024,
    });

    upstream.on('open', () => {
      connectedAt = Date.now();
      console.log(`${tag} upstream open, flushing ${pending.length} queued frame(s)`);
      updateBridgeCallLog(callLogId, { status: 'CONNECTED' });
      sendControl(client, 'ready', { callSid });
      for (const [data, isBinary] of pending) safeSend(upstream, data, isBinary);
      pending = [];
    });

    // Callified → browser, verbatim.
    upstream.on('message', (data, isBinary) => {
      safeSend(client, data, isBinary);
    });

    upstream.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      console.log(`${tag} upstream closed (${code}) ${reason}`);
      sendControl(client, 'closed', { code, reason });
      teardown(`upstream closed (${code})`, 1000);
    });

    upstream.on('error', (err) => {
      console.error(`${tag} upstream error: ${err.message}`);
      sendControl(client, 'error', { message: err.message });
      teardown('upstream error', 1011);
    });
  })().catch((e) => {
    console.error(`${tag} bridge setup failed: ${e.message}`);
    sendControl(client, 'error', { message: e.message });
    teardown('setup failed', 1011);
  });
}

/**
 * One-call helper every manual-call route uses: place the Callified browser
 * call for a CRM contact, then mint the relay ticket the agent's browser
 * redeems. Keeping it here means the generic-CRM route and the wellness route
 * cannot drift on the shape they hand the frontend.
 *
 * @param {{tenantId:number, contactId:number|string, campaignId:number|string,
 *          userId?:number|null, interest?:string, exotelAccountId?:number,
 *          scheduledCallId?:number}} params
 * @returns {Promise<object>} call metadata + `bridgeTicket` / `bridgePath`
 */
async function startBrowserCall(params) {
  const call = await callifiedClient.initiateBrowserCallForContact(params);

  const agentSocketUrl = await callifiedClient.resolveAgentSocketUrl(
    params.tenantId,
    call.agentUrl || `/ws/agent?call_sid=${encodeURIComponent(call.callSid)}`,
  );

  const { ticket, path, expiresInMs } = issueBridgeTicket({
    tenantId: params.tenantId,
    userId: params.userId,
    callSid: call.callSid,
    agentSocketUrl,
    callLogId: call.callLogId,
  });

  return {
    ...call,
    bridgeTicket: ticket,
    bridgePath: path,
    bridgeTicketExpiresInMs: expiresInMs,
  };
}

module.exports = {
  BRIDGE_PATH,
  TICKET_TTL_MS,
  MAX_PENDING_FRAMES,
  attachCallifiedAgentBridge,
  startBrowserCall,
  issueBridgeTicket,
  redeemBridgeTicket,
  clearBridgeTickets,
  buildUpstreamUrl,
  sweepTickets,
};
