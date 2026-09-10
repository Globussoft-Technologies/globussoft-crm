/**
 * landingHeroForm.js — hero web-form injection for the public marketing
 * landing page (frontend/src/pages/Landing.jsx).
 *
 * Kept OUT of Landing.jsx on purpose: files that export both components and
 * plain helpers defeat React Fast Refresh (see frontend/src/appContexts.js
 * for the same pattern). Landing.jsx imports these; tests import them too.
 */

export function heroFormEmbedSrc(formId) {
  return `/embed/web-form.html?id=${formId}`;
}

// Injects the hero web-form iframe into a CLOSED shadow root under
// #hero-form-mount. DevTools Elements then shows only
// `#shadow-root (closed)` — the form link never sits in the page markup.
// Returns the iframe element (kept in a ref for the postMessage resize
// handshake) or null. NEVER falls back to light DOM: a failed injection
// renders nothing rather than leaking the link.
export function injectHeroForm(mount, formId) {
  if (!mount || !Number.isInteger(formId) || formId <= 0) return null;
  mount.replaceChildren();
  let root = null;
  try {
    root = mount.attachShadow({ mode: "closed" });
  } catch {
    return null;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("src", heroFormEmbedSrc(formId));
  frame.setAttribute("title", "Globus CRM");
  frame.setAttribute("loading", "lazy");
  frame.setAttribute("style", "width:100%;height:820px;min-height:820px;border:0;display:block;");
  root.appendChild(frame);
  return frame;
}
