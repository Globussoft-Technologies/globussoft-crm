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

export function landingHeroFormEmbedSrc() {
  return "/api/landing-form-config/embed?host=landing";
}

export function resizeHeroFormFrame(frame, rawHeight) {
  const height = Number(rawHeight);
  if (!frame || !Number.isFinite(height) || height <= 0) return false;
  frame.style.height = `${Math.ceil(height)}px`;
  frame.style.minHeight = "0";
  return true;
}

export function responsiveFormDevice(width) {
  const viewportWidth = Number(width);
  if (!Number.isFinite(viewportWidth)) return "desktop";
  if (viewportWidth <= 640) return "mobile";
  if (viewportWidth <= 900) return "tablet";
  return "desktop";
}

export function sendHeroFormContext(
  frame,
  pageUrl = window.location.href,
  pageTitle = document.title,
  targetOrigin = window.location.origin,
) {
  if (!frame?.contentWindow) return false;
  frame.contentWindow.postMessage({
    source: "gbs-web-form-host",
    type: "context",
    pageUrl,
    pageTitle,
  }, targetOrigin);
  return true;
}

function createHeroFormFrame(src) {
  const frame = document.createElement("iframe");
  frame.setAttribute("src", src);
  frame.setAttribute("title", "Globus CRM");
  frame.setAttribute("allow", "geolocation *");
  frame.setAttribute("loading", "eager");
  frame.setAttribute("fetchpriority", "high");
  frame.setAttribute("style", "width:100%;max-width:100%;height:auto;min-height:0;border:0;display:block;box-sizing:border-box;");
  return frame;
}

function appendFrameToClosedRoot(mount, frame) {
  if (!mount) return null;
  mount.replaceChildren();
  let root;
  try {
    root = mount.attachShadow({ mode: "closed" });
  } catch {
    return null;
  }
  root.appendChild(frame);
  return frame;
}

// Start downloading and parsing the embed document as soon as the landing
// template mounts. Its form id arrives independently from the public config
// request, so those two network operations no longer run in series.
export function injectLandingHeroForm(mount) {
  return appendFrameToClosedRoot(mount, createHeroFormFrame(landingHeroFormEmbedSrc()));
}

// Injects the hero web-form iframe into a closed shadow root under
// #hero-form-mount so the iframe is absent from ordinary Elements queries.
// Backend authorization remains the actual security boundary.
// Returns the iframe element (kept in a ref for the postMessage resize
// handshake) or null. NEVER falls back to light DOM: a failed injection
// renders nothing rather than leaking the link.
export function injectHeroForm(mount, formId) {
  if (!mount || !Number.isInteger(formId) || formId <= 0) return null;
  return appendFrameToClosedRoot(mount, createHeroFormFrame(heroFormEmbedSrc(formId)));
}
