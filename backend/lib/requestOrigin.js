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
//   1. FRONTEND_URL env var (explicit override)
//   2. req.protocol + req.hostname (respects proxy headers when trust proxy is set)
//   3. Fallback to localhost:5173 (development default)

function getFrontendUrlFromRequest(req) {
  // Explicit env override takes priority
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL;
  }

  // When trust proxy: 1 is set, these will use forwarded headers if available
  const protocol = req.protocol || "https";
  const hostname = req.hostname || req.get("host");

  if (!hostname) {
    // Fallback for local development
    return "http://localhost:5173";
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
