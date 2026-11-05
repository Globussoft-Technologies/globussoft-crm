// Helper to reliably detect the original request origin when behind proxies (Nginx, etc.)
//
// When Express has `trust proxy: 1` configured (see server.js), Express will:
//   - Read X-Forwarded-Proto for req.protocol
//   - Read X-Forwarded-Host for req.hostname
//
// This helper provides a robust frontend URL detection for payment links, webhooks, and other
// features that need to know the public URL the user is accessing from.
//
// Priority order:
//   1. The dedicated TMC host from the request (must preserve branded links)
//   2. FRONTEND_URL env var (explicit override)
//   3. req.protocol + req.hostname (respects proxy headers when trust proxy is set)
//   4. PUBLIC_BASE_URL env var when the request does not carry a host

const TMC_HOSTNAMES = new Set([
  "app.themodernclassroom.in",
  "tmc.localhost",
]);

function getFrontendUrlFromRequest(req) {
  // When trust proxy: 1 is set, these will use forwarded headers if available
  const protocol = req.protocol || "https";
  const hostname = req.hostname || req.get("host");
  const requestHost = req.get("host") || hostname;

  // The Vite dev proxy changes the upstream Host header to localhost. The SPA
  // sends its browser origin explicitly; only accept the dedicated TMC hosts
  // here so this cannot turn into an arbitrary redirect-origin mechanism.
  const frontendOrigin = req.get("x-frontend-origin");
  if (frontendOrigin) {
    try {
      const parsed = new URL(frontendOrigin);
      if (TMC_HOSTNAMES.has(parsed.hostname.toLowerCase()) && ["http:", "https:"].includes(parsed.protocol)) {
        return parsed.origin.replace(/\/+$/, "");
      }
    } catch (_err) {
      // Ignore malformed or unapproved frontend-origin headers.
    }
  }

  // TMC is a branded production entry point. Keep links generated from a
  // request on that host on the same host, even when FRONTEND_URL is set to
  // the generic GlobusCRM origin for other tenants.
  if (TMC_HOSTNAMES.has(String(hostname || "").split(":")[0].toLowerCase())) {
    return `${protocol}://${requestHost}`.replace(/\/+$/, "");
  }

  // Explicit env override takes priority for non-TMC hosts.
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.replace(/\/+$/, "");
  }

  if (!hostname) {
    return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  }

  // Handle port in hostname (X-Forwarded-Host might include port)
  // Remove :5099 or other internal ports if present
  const cleanHostname = hostname.replace(/:5099.*/, "").replace(/:\d+$/, (match) => {
    // Keep port only if it's a standard port (80 for http, 443 for https)
    return ((protocol === "https" && match === ":443") || (protocol === "http" && match === ":80")) ? match : "";
  });

  const result = `${protocol}://${cleanHostname}`;

  // Log for debugging payment link issues
  if (req.url && req.url.includes("payment")) {
    console.log(`[requestOrigin] payment endpoint: protocol=${protocol}, hostname=${hostname}, cleanHostname=${cleanHostname}, result=${result}, FRONTEND_URL env=${process.env.FRONTEND_URL}`);
  }

  return result;
}

module.exports = { getFrontendUrlFromRequest };
