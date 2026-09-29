const TMC_HOSTNAMES = new Set([
  "app.themodernclassroom.in",
  // Dedicated local preview hostname; plain localhost keeps Globussoft.
  "tmc.localhost",
]);

const GLOBUSSOFT_BRANDING = {
  name: "Globussoft CRM",
  title: "Globussoft CRM",
  logoUrl: "/globussoft-logo-pdf.png",
  faviconUrl: "/logo-header-nobg.png",
};

const TMC_BRANDING = {
  name: "The Modern Classroom",
  title: "The Modern Classroom",
  logoUrl: "/tmc.png",
  faviconUrl: "/tmc-logo.png",
};

export function getDomainBranding(hostname = window.location.hostname) {
  return TMC_HOSTNAMES.has(String(hostname).toLowerCase())
    ? TMC_BRANDING
    : GLOBUSSOFT_BRANDING;
}

export function applyDomainBranding(branding = getDomainBranding()) {
  if (typeof document === "undefined") return;

  document.title = branding.title;
  document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((link) => {
    link.href = branding.faviconUrl;
  });
}
