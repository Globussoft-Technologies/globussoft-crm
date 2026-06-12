// Open-redirect protection for ?next=… params on the auth pages. Only allows
// in-app paths: must start with "/" and not "//" (protocol-relative URLs that
// would redirect off-site). External hosts return null so the caller can fall
// back to the vertical-aware default landing.
export function safeNext(next) {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return null;
  try {
    return decodeURIComponent(next);
  } catch {
    return null;
  }
}
