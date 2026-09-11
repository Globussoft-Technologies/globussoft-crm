const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config/secrets");

const TMC_REGISTRATION_COOKIE = "tmc_registration_context";

function createTmcParentRegistrationToken({ tenantId, teacherContactId, tripId }) {
  return jwt.sign({
    type: "TMC_REGISTRATION",
    registrationType: "PARENT",
    subBrand: "tmc",
    tenantId: Number(tenantId),
    teacherContactId: Number(teacherContactId),
    tripId: Number(tripId),
  }, JWT_SECRET, { noTimestamp: true });
}

function buildTmcParentRegistrationUrl({ tenantId, teacherContactId, tripId, baseUrl }) {
  const origin = String(baseUrl || process.env.FRONTEND_URL || process.env.PUBLIC_BASE_URL || "http://localhost:5173").replace(/\/+$/, "");
  const token = createTmcParentRegistrationToken({ tenantId, teacherContactId, tripId });
  return `${origin}/tmc/register/parent?token=${encodeURIComponent(token)}`;
}

function verifyTmcRegistrationToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (!claims || !["TEACHER", "PARENT"].includes(claims.registrationType) || claims.subBrand !== "tmc") return null;
    const tenantId = claims.tenantId == null ? null : Number(claims.tenantId);
    if (tenantId !== null && (!Number.isInteger(tenantId) || tenantId <= 0)) return null;
    const teacherContactId = claims.teacherContactId ? Number(claims.teacherContactId) : null;
    const tripId = claims.tripId ? Number(claims.tripId) : null;
    if (
      claims.registrationType === "PARENT" &&
      (tenantId === null || ![teacherContactId, tripId].every((value) => Number.isInteger(value) && value > 0))
    ) return null;
    return {
      registrationType: claims.registrationType,
      tenantId,
      subBrand: "tmc",
      teacherContactId,
      tripId,
    };
  } catch (_err) {
    return null;
  }
}

function getTmcRegistrationContext(req) {
  return verifyTmcRegistrationToken(req.cookies?.[TMC_REGISTRATION_COOKIE]);
}

function setTmcRegistrationContext(res, token, maxAgeMs = 15 * 60 * 1000) {
  res.cookie(TMC_REGISTRATION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: maxAgeMs,
    path: "/",
  });
}

function clearTmcRegistrationContext(res) {
  res.clearCookie(TMC_REGISTRATION_COOKIE, { path: "/" });
}

module.exports = {
  TMC_REGISTRATION_COOKIE,
  createTmcParentRegistrationToken,
  buildTmcParentRegistrationUrl,
  verifyTmcRegistrationToken,
  getTmcRegistrationContext,
  setTmcRegistrationContext,
  clearTmcRegistrationContext,
};
