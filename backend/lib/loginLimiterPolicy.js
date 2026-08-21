const DEMO_LOGIN_HOSTS = new Set([
  "crm.globusdemos.com",
  "localhost",
  "127.0.0.1",
  "::1",
]);

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

module.exports = {
  DEMO_LOGIN_HOSTS,
  normalizeLoginHost,
  shouldSkipLoginAccountLimiter,
};
