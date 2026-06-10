/**
 * Copy text to the system clipboard with graceful degradation.
 *
 * 1. Primary: navigator.clipboard.writeText (requires secure context).
 * 2. Fallback: textarea selection + execCommand (deprecated but still
 *    required for non-secure contexts / old browsers).
 * 3. Throws if neither path succeeds so callers can surface a toast.
 */
export async function copyToClipboard(text) {
  // Path 1 — modern Clipboard API (HTTPS-only).
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  // Path 2 — legacy textarea trick. We still need execCommand here
  // because non-secure contexts (http://localhost, some staging setups)
  // block the modern API entirely.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  ta.setAttribute("aria-hidden", "true");
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand("copy");
    if (!ok) throw new Error("execCommand copy returned false");
  } finally {
    document.body.removeChild(ta);
  }
}
