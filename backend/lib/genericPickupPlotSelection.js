"use strict";
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/secrets");
const PURPOSE = "generic-pickup-plot-selection";
function positiveInteger(value, field) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${field} must be a positive integer`); return parsed; }
function createSelectionToken({ tenantId, contactId, submissionId = null, expiresIn = "30d" } = {}) {
  const payload = { purpose: PURPOSE, tenantId: positiveInteger(tenantId, "tenantId"), contactId: positiveInteger(contactId, "contactId") };
  if (submissionId != null) payload.submissionId = positiveInteger(submissionId, "submissionId");
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}
function verifySelectionToken(token) {
  const payload = jwt.verify(String(token || ""), JWT_SECRET);
  if (payload.purpose !== PURPOSE) throw new jwt.JsonWebTokenError("Invalid selection-token purpose");
  return { tenantId: positiveInteger(payload.tenantId, "tenantId"), contactId: positiveInteger(payload.contactId, "contactId"), submissionId: payload.submissionId == null ? null : positiveInteger(payload.submissionId, "submissionId"), exp: payload.exp };
}
function selectionUrl({ baseUrl = process.env.FRONTEND_URL || "http://localhost:5173", token } = {}) {
  if (!token) throw new TypeError("token is required");
  return `${String(baseUrl).replace(/\/+$/, "")}/pickup-plot-selection/${encodeURIComponent(token)}`;
}
function createSelectionLink(options = {}) { const { baseUrl, ...tokenOptions } = options; return selectionUrl({ baseUrl, token: createSelectionToken(tokenOptions) }); }
module.exports = { createSelectionToken, verifySelectionToken, selectionUrl, createSelectionLink, _internal: { PURPOSE } };
