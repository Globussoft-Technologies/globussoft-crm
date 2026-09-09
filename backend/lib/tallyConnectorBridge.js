const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const prisma = require("./prisma");

const CONNECTOR_PATH = "/ws/tally-connector";
const CONNECTOR_PROVIDER = "travel_tally_connector";
const DEFAULT_JOB_TIMEOUT_MS = 45_000;
const MAX_XML_BYTES = 8 * 1024 * 1024;

const connections = new Map();
const pendingJobs = new Map();

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function safeEqualHex(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch (_) {
    return false;
  }
}

function createConnectorCredentials() {
  const token = crypto.randomBytes(32).toString("hex");
  return {
    token,
    stored: {
      connectorId: `tally_${crypto.randomBytes(12).toString("hex")}`,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
    },
  };
}

function parseTallyResponse(xml) {
  const source = String(xml || "");
  const number = (tag) => {
    const match = source.match(new RegExp(`<${tag}>\\s*(-?\\d+)\\s*</${tag}>`, "i"));
    return match ? Number(match[1]) : 0;
  };
  const text = (tag) => {
    const match = source.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i"));
    return match ? match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  };
  const summary = {
    created: number("CREATED"),
    altered: number("ALTERED"),
    deleted: number("DELETED"),
    errors: number("ERRORS"),
    exceptions: number("EXCEPTIONS"),
    ignored: number("IGNORED"),
    lineError: text("LINEERROR"),
  };
  const recognized = /<(CREATED|ALTERED|DELETED|ERRORS|EXCEPTIONS|IGNORED|LINEERROR)>/i.test(source);
  summary.success = recognized && summary.errors === 0 && summary.exceptions === 0 && !summary.lineError;
  return summary;
}

async function authenticateConnector(customerId, connectorId, token) {
  const tenantId = Number(customerId);
  if (!Number.isInteger(tenantId) || tenantId <= 0 || !connectorId || !token) return null;
  const row = await prisma.integration.findUnique({
    where: { tenantId_provider: { tenantId, provider: CONNECTOR_PROVIDER } },
    select: { token: true, settings: true, isActive: true },
  });
  if (!row?.isActive) return null;
  let credentials;
  try { credentials = JSON.parse(row.settings || "{}"); } catch (_) { return null; }
  if (credentials.connectorId !== connectorId) return null;
  return safeEqualHex(row.token, hashToken(token)) ? tenantId : null;
}

function rejectTenantJobs(tenantId, message, code = "TALLY_CONNECTOR_OFFLINE") {
  for (const [jobId, job] of pendingJobs) {
    if (job.tenantId !== tenantId) continue;
    clearTimeout(job.timer);
    pendingJobs.delete(jobId);
    job.reject(Object.assign(new Error(message), { code }));
  }
}

function handleConnectorConnection(socket, grant) {
  const tenantId = Number(grant.tenantId);
  const previous = connections.get(tenantId);
  if (previous?.socket?.readyState === WebSocket.OPEN) {
    previous.socket.close(4001, "Replaced by a newer connector connection");
  }
  const connection = {
    socket,
    connectorId: grant.connectorId,
    machineId: grant.machineId || null,
    version: null,
    connectedAt: new Date(),
    lastSeenAt: new Date(),
  };
  connections.set(tenantId, connection);
  socket.send(JSON.stringify({ type: "connected", heartbeatIntervalMs: 20_000 }));

  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let message;
    try { message = JSON.parse(String(data)); } catch (_) { return; }
    connection.lastSeenAt = new Date();
    if (message.type === "hello") {
      connection.machineId = String(message.machineId || connection.machineId || "").slice(0, 120) || null;
      connection.version = String(message.version || "").slice(0, 40) || null;
      return;
    }
    if (message.type === "heartbeat") {
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: new Date().toISOString() }));
      return;
    }
    if (message.type !== "job_result" || !message.jobId) return;
    const job = pendingJobs.get(String(message.jobId));
    if (!job || job.tenantId !== tenantId) return;
    clearTimeout(job.timer);
    pendingJobs.delete(String(message.jobId));
    if (message.status === "success") {
      job.resolve({ responseXml: String(message.responseXml || ""), tally: message.tally || parseTallyResponse(message.responseXml) });
    } else {
      job.reject(Object.assign(new Error(String(message.error || "Tally rejected the request")), {
        code: String(message.code || "TALLY_IMPORT_FAILED"),
        responseXml: String(message.responseXml || ""),
        tally: message.tally || parseTallyResponse(message.responseXml),
      }));
    }
  });

  socket.on("close", () => {
    if (connections.get(tenantId)?.socket !== socket) return;
    connections.delete(tenantId);
    rejectTenantJobs(tenantId, "The Tally connector disconnected while processing the request");
  });
  socket.on("error", (error) => console.warn(`[tally-connector] tenant=${tenantId} socket error: ${error.message}`));
}

function attachTallyConnectorBridge(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_XML_BYTES });
  server.on("upgrade", (req, socket, head) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch (_) { return; }
    if (url.pathname !== CONNECTOR_PATH) return;
    req._webSocketUpgradeClaimed = true;
    const customerId = url.searchParams.get("customerId");
    const connectorId = url.searchParams.get("connectorId");
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const machineId = url.searchParams.get("machineId");
    authenticateConnector(customerId, connectorId, token).then((tenantId) => {
      if (!tenantId) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => handleConnectorConnection(client, { tenantId, connectorId, machineId }));
    }).catch((error) => {
      console.error("[tally-connector] authentication failed:", error.message);
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  });
  console.log(`[tally-connector] listening on ${CONNECTOR_PATH}`);
  return wss;
}

function getConnectorStatus(tenantId) {
  const connection = connections.get(Number(tenantId));
  const online = Boolean(connection?.socket?.readyState === WebSocket.OPEN);
  return {
    online,
    machineId: online ? connection.machineId : null,
    version: online ? connection.version : null,
    connectedAt: online ? connection.connectedAt.toISOString() : null,
    lastSeenAt: online ? connection.lastSeenAt.toISOString() : null,
  };
}

function disconnectConnector(tenantId) {
  const id = Number(tenantId);
  const connection = connections.get(id);
  if (!connection) return false;
  connections.delete(id);
  rejectTenantJobs(id, "Tally connector credentials were rotated", "TALLY_CONNECTOR_CREDENTIALS_ROTATED");
  try { connection.socket.close(4002, "Connector credentials rotated"); } catch (_) { /* already closed */ }
  return true;
}

function sendTallyJob(tenantId, xml, options = {}) {
  const payload = String(xml || "");
  if (!payload || Buffer.byteLength(payload, "utf8") > MAX_XML_BYTES) {
    return Promise.reject(Object.assign(new Error("Tally XML is empty or exceeds the 8 MB connector limit"), { code: "INVALID_TALLY_XML_SIZE" }));
  }
  const connection = connections.get(Number(tenantId));
  if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(Object.assign(new Error("Tally connector is offline"), { code: "TALLY_CONNECTOR_OFFLINE" }));
  }
  const jobId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      reject(Object.assign(new Error("Tally did not respond before the request timed out"), { code: "TALLY_CONNECTOR_TIMEOUT" }));
    }, Number(options.timeoutMs) || DEFAULT_JOB_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    pendingJobs.set(jobId, { tenantId: Number(tenantId), resolve, reject, timer });
    try {
      connection.socket.send(JSON.stringify({ type: "job", jobId, jobType: options.jobType || "IMPORT_XML", payload: { xml: payload } }));
    } catch (error) {
      clearTimeout(timer);
      pendingJobs.delete(jobId);
      reject(Object.assign(error, { code: "TALLY_CONNECTOR_SEND_FAILED" }));
    }
  });
}

module.exports = {
  CONNECTOR_PATH,
  CONNECTOR_PROVIDER,
  MAX_XML_BYTES,
  attachTallyConnectorBridge,
  createConnectorCredentials,
  disconnectConnector,
  getConnectorStatus,
  hashToken,
  parseTallyResponse,
  sendTallyJob,
};
