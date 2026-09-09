#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocket } = require("ws");

const VERSION = "1.0.0";
const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
const configPath = process.env.TALLY_CONNECTOR_CONFIG || path.join(baseDir, "config.json");
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(path.join(baseDir, "connector.log"), `${line}\n`, "utf8"); } catch (_) { /* console logging remains available */ }
}

function loadConfig() {
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }
  for (const field of ["serverUrl", "customerId", "connectorId", "token"]) {
    if (!String(config[field] || "").trim()) throw new Error(`${field} is required in config.json`);
  }
  const tallyUrl = new URL(config.localTallyUrl || "http://127.0.0.1:9000");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(tallyUrl.hostname)) {
    throw new Error("localTallyUrl must point to localhost; remote Tally ports are not allowed");
  }
  config.localTallyUrl = tallyUrl.toString();
  return config;
}

function connectorUrl(config) {
  const url = new URL(config.serverUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  if (!url.pathname || url.pathname === "/") url.pathname = "/ws/tally-connector";
  url.searchParams.set("customerId", config.customerId);
  url.searchParams.set("connectorId", config.connectorId);
  url.searchParams.set("machineId", config.machineId || os.hostname());
  return url.toString();
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
  const result = { created: number("CREATED"), altered: number("ALTERED"), deleted: number("DELETED"), errors: number("ERRORS"), exceptions: number("EXCEPTIONS"), ignored: number("IGNORED"), lineError: text("LINEERROR") };
  const recognized = /<(CREATED|ALTERED|DELETED|ERRORS|EXCEPTIONS|IGNORED|LINEERROR)>/i.test(source);
  result.success = recognized && result.errors === 0 && result.exceptions === 0 && !result.lineError;
  return result;
}

async function postToTally(config, xml) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.requestTimeoutMs) || 45_000);
  try {
    const response = await fetch(config.localTallyUrl, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: xml,
      signal: controller.signal,
    });
    const responseXml = await response.text();
    const tally = parseTallyResponse(responseXml);
    if (!response.ok || !tally.success) {
      const error = new Error(tally.lineError || `Tally returned HTTP ${response.status}`);
      error.code = !response.ok ? "TALLY_HTTP_ERROR" : "TALLY_IMPORT_FAILED";
      error.responseXml = responseXml;
      error.tally = tally;
      throw error;
    }
    return { responseXml, tally };
  } finally {
    clearTimeout(timer);
  }
}

function safeSend(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

async function handleJob(socket, config, message) {
  const jobId = String(message.jobId || "");
  const xml = String(message.payload?.xml || "");
  if (!jobId || !xml) {
    safeSend(socket, { type: "job_result", jobId, status: "error", code: "INVALID_JOB", error: "The connector received an invalid job" });
    return;
  }
  log("INFO", `Processing ${message.jobType || "IMPORT_XML"} job ${jobId}`);
  try {
    const result = await postToTally(config, xml);
    safeSend(socket, { type: "job_result", jobId, status: "success", responseXml: result.responseXml, tally: result.tally });
    log("INFO", `Completed job ${jobId}: created=${result.tally.created}, altered=${result.tally.altered}`);
  } catch (error) {
    const messageText = error.name === "AbortError" ? "Local Tally request timed out" : error.message;
    safeSend(socket, { type: "job_result", jobId, status: "error", code: error.code || (error.name === "AbortError" ? "TALLY_TIMEOUT" : "TALLY_UNREACHABLE"), error: messageText, responseXml: error.responseXml || "", tally: error.tally || null });
    log("ERROR", `Job ${jobId} failed: ${messageText}`);
  }
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  const delay = Math.min(30_000, 1_000 * (2 ** Math.min(reconnectAttempt, 5))) + Math.floor(Math.random() * 500);
  reconnectAttempt += 1;
  log("INFO", `Reconnecting in ${Math.round(delay / 1000)} seconds`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

function connect() {
  let config;
  try { config = loadConfig(); } catch (error) {
    log("ERROR", error.message);
    scheduleReconnect();
    return;
  }
  const url = connectorUrl(config);
  log("INFO", `Connecting to ${new URL(config.serverUrl).host}`);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.token}` }, rejectUnauthorized: config.rejectUnauthorized !== false, handshakeTimeout: 15_000, maxPayload: 8 * 1024 * 1024 });
  socket.on("open", () => {
    reconnectAttempt = 0;
    log("INFO", "Connected to Globussoft CRM");
    safeSend(socket, { type: "hello", machineId: config.machineId || os.hostname(), version: VERSION });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => safeSend(socket, { type: "heartbeat", at: new Date().toISOString() }), 20_000);
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let message;
    try { message = JSON.parse(String(data)); } catch (_) { return; }
    if (message.type === "job") handleJob(socket, config, message);
  });
  socket.on("close", (code) => {
    clearInterval(heartbeatTimer);
    log("WARN", `CRM connection closed (${code})`);
    scheduleReconnect();
  });
  socket.on("error", (error) => log("ERROR", `WebSocket error: ${error.message}`));
}

process.on("SIGINT", () => { shuttingDown = true; clearTimeout(reconnectTimer); clearInterval(heartbeatTimer); process.exit(0); });
process.on("SIGTERM", () => { shuttingDown = true; clearTimeout(reconnectTimer); clearInterval(heartbeatTimer); process.exit(0); });

connect();
