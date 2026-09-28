"use strict";

const prisma = require("../lib/prisma");

const OAUTH_URL = "https://zoom.us/oauth/token";
const API_BASE = "https://api.zoom.us";
const CREATE_SCOPES = new Set(["meeting:write:admin", "meeting:write", "meeting:write:meeting:admin", "meeting:write:meeting"]);
const DELETE_SCOPES = new Set(["meeting:write:admin", "meeting:write", "meeting:delete:meeting:admin", "meeting:delete:meeting"]);

function providerError(message, code, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function mask(value) {
  const text = String(value || "");
  return text ? `****${text.slice(-4)}` : null;
}

async function requestAccessToken({ accountId, clientId, clientSecret }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${OAUTH_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw providerError(`Zoom rejected these credentials (${response.status}). Check the Account ID, Client ID, Client Secret, and app activation. ${detail.slice(0, 180)}`, "ZOOM_CREDENTIALS_REJECTED", 400);
  }
  const payload = await response.json();
  if (!payload.access_token) throw providerError("Zoom returned no access token.", "ZOOM_TOKEN_MISSING");
  return { accessToken: payload.access_token, apiBase: String(payload.api_url || API_BASE).replace(/\/$/, ""), scopes: new Set(String(payload.scope || "").split(/[\s,]+/).filter(Boolean)) };
}

function assertMeetingScopes(scopes) {
  if (scopes.size === 0) return;
  const canCreate = [...CREATE_SCOPES].some((scope) => scopes.has(scope));
  const canDelete = [...DELETE_SCOPES].some((scope) => scopes.has(scope));
  if (!canCreate || !canDelete) {
    throw providerError("Zoom credentials are valid, but the app needs create-meeting and delete-meeting scopes.", "ZOOM_SCOPES_MISSING", 400);
  }
}

function sanitizedStatus(row) {
  if (!row) return { configured: false, status: "NOT_CONFIGURED", accountId: null, clientId: null, clientSecretConfigured: false, zoomHostUserId: "me", verifiedAt: null, lastError: null };
  return {
    configured: row.status === "CONNECTED",
    status: row.status,
    accountId: mask(row.accountId),
    clientId: mask(row.clientId),
    clientSecretConfigured: Boolean(row.clientSecret),
    zoomHostUserId: row.zoomHostUserId || "me",
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
  };
}

async function getStatus(tenantId) {
  const row = await prisma.travelMeetingZoomCredential.findUnique({ where: { tenantId } });
  return sanitizedStatus(row);
}

async function connect({ tenantId, accountId, clientId, clientSecret, zoomHostUserId = "me" }) {
  const values = {
    accountId: String(accountId || "").trim(),
    clientId: String(clientId || "").trim(),
    clientSecret: String(clientSecret || "").trim(),
    zoomHostUserId: String(zoomHostUserId || "me").trim().slice(0, 191) || "me",
  };
  if (!values.accountId || !values.clientId || !values.clientSecret) throw providerError("Account ID, Client ID, and Client Secret are required.", "ZOOM_CREDENTIALS_REQUIRED", 400);
  const token = await requestAccessToken(values);
  assertMeetingScopes(token.scopes);
  const now = new Date();
  const stored = {
    accountId: values.accountId,
    clientId: values.clientId,
    clientSecret: values.clientSecret,
    zoomHostUserId: values.zoomHostUserId,
    status: "CONNECTED",
    verifiedAt: now,
    lastError: null,
  };
  const row = await prisma.travelMeetingZoomCredential.upsert({
    where: { tenantId },
    create: { tenantId, ...stored },
    update: stored,
  });
  return sanitizedStatus(row);
}

async function disconnect(tenantId) {
  const existing = await prisma.travelMeetingZoomCredential.findUnique({ where: { tenantId }, select: { id: true } });
  if (!existing) return getStatus(tenantId);
  await prisma.travelMeetingZoomCredential.delete({ where: { tenantId } });
  return sanitizedStatus(null);
}

async function loadConnection(tenantId) {
  const row = await prisma.travelMeetingZoomCredential.findUnique({ where: { tenantId } });
  if (!row || row.status !== "CONNECTED") throw providerError("Connect Zoom inside Travel CRM → Marketing → Meeting Forms before publishing or booking.", "ZOOM_NOT_CONFIGURED", 409);
  return {
    accountId: row.accountId,
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    zoomHostUserId: row.zoomHostUserId || "me",
  };
}

async function isConfigured(tenantId) {
  const row = await prisma.travelMeetingZoomCredential.findUnique({ where: { tenantId }, select: { status: true } });
  return row?.status === "CONNECTED";
}

async function createMeeting({ tenantId, topic, startTime, durationMins, timezone, agenda }) {
  const connection = await loadConnection(tenantId);
  const { accessToken, apiBase } = await requestAccessToken(connection);
  const response = await fetch(`${apiBase}/v2/users/${encodeURIComponent(connection.zoomHostUserId)}/meetings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      topic: String(topic || "Meeting").slice(0, 200),
      type: 2,
      start_time: new Date(startTime).toISOString(),
      duration: Math.max(5, Math.round(Number(durationMins) || 30)),
      timezone: timezone || "UTC",
      agenda: agenda ? String(agenda).slice(0, 2000) : undefined,
      settings: { join_before_host: true, waiting_room: false },
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw providerError(`Zoom could not create the meeting (${response.status}): ${detail.slice(0, 180)}`, "ZOOM_CREATE_FAILED");
  }
  const payload = await response.json();
  return { joinUrl: payload.join_url || null, startUrl: payload.start_url || null, meetingId: payload.id || null, password: payload.password || null };
}

async function deleteMeeting(tenantId, meetingId) {
  if (!meetingId) return false;
  const connection = await loadConnection(tenantId);
  const { accessToken, apiBase } = await requestAccessToken(connection);
  const response = await fetch(`${apiBase}/v2/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.ok || response.status === 404) return true;
  const detail = await response.text().catch(() => "");
  throw providerError(`Zoom could not delete the meeting (${response.status}): ${detail.slice(0, 180)}`, "ZOOM_DELETE_FAILED");
}

module.exports = { getStatus, connect, disconnect, isConfigured, createMeeting, deleteMeeting, _internal: { requestAccessToken, assertMeetingScopes, sanitizedStatus } };
