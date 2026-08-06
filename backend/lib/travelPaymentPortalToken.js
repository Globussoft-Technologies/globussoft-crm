const jwt = require("jsonwebtoken");

const JWT_SECRET =
  process.env.TRAVEL_PAYMENT_PORTAL_JWT_SECRET ||
  process.env.JWT_SECRET ||
  "dev-travel-payment-portal-secret";

const PURPOSE = "travel-payment-portal";
const DEFAULT_EXPIRES_IN_DAYS = 30;

function mintPaymentPortalToken({
  tenantId,
  tripId,
  participantId,
  email,
  installmentId,
  expiresInDays = DEFAULT_EXPIRES_IN_DAYS,
} = {}) {
  if (!Number.isFinite(tenantId)) throw new Error("tenantId must be a number");
  if (!Number.isFinite(tripId)) throw new Error("tripId must be a number");
  if (!Number.isFinite(participantId)) throw new Error("participantId must be a number");
  const days = Math.max(1, Number.isFinite(expiresInDays) ? expiresInDays : DEFAULT_EXPIRES_IN_DAYS);
  const payload = {
    kind: PURPOSE,
    tenantId,
    tripId,
    participantId,
    email: String(email || "").trim().toLowerCase(),
  };
  if (Number.isFinite(installmentId)) payload.installmentId = installmentId;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${days}d` });
}

function verifyPaymentPortalToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (!payload || payload.kind !== PURPOSE) {
    const err = new Error("INVALID_PURPOSE");
    err.code = "INVALID_PURPOSE";
    throw err;
  }
  if (!Number.isFinite(payload.tenantId) || !Number.isFinite(payload.tripId) || !Number.isFinite(payload.participantId)) {
    const err = new Error("INVALID_PAYLOAD");
    err.code = "INVALID_PAYLOAD";
    throw err;
  }
  return {
    tenantId: payload.tenantId,
    tripId: payload.tripId,
    participantId: payload.participantId,
    email: payload.email || null,
    installmentId: Number.isFinite(payload.installmentId) ? payload.installmentId : null,
  };
}

module.exports = {
  mintPaymentPortalToken,
  verifyPaymentPortalToken,
  _internal: { PURPOSE, DEFAULT_EXPIRES_IN_DAYS },
};
