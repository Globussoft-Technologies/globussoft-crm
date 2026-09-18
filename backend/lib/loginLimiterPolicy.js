const { ipKeyGenerator } = require("express-rate-limit");

const DEMO_LOGIN_HOSTS = new Set([
  "crm.globusdemos.com",
  "localhost",
  "127.0.0.1",
  "::1",
]);

const LOGIN_IP_LIMIT = 5;
const TEST_LOGIN_IP_LIMIT = 10000;

function getLoginIpLimit(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv === "test" ? TEST_LOGIN_IP_LIMIT : LOGIN_IP_LIMIT;
}

function normalizeLoginHost(req) {
  const raw = String(req?.hostname || req?.get?.("host") || req?.headers?.host || "")
    .trim()
    .toLowerCase();

  if (!raw) return "";

  let host = raw;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    const colonCount = (host.match(/:/g) || []).length;
    if (colonCount === 1) host = host.split(":")[0];
  }

  return host.replace(/\.$/, "");
}

function shouldSkipLoginAccountLimiter(req) {
  const host = normalizeLoginHost(req);
  return DEMO_LOGIN_HOSTS.has(host);
}

// express-rate-limit v8 expects an IP string, not the Express request object.
// Keeping this in a tiny tested helper prevents a request-object Map key from
// silently giving every login attempt its own rate-limit bucket.
function loginIpKey(req) {
  return ipKeyGenerator(String(req?.ip || ""));
}

module.exports = {
  DEMO_LOGIN_HOSTS,
  LOGIN_IP_LIMIT,
  TEST_LOGIN_IP_LIMIT,
  getLoginIpLimit,
  normalizeLoginHost,
  shouldSkipLoginAccountLimiter,
  loginIpKey,
};
