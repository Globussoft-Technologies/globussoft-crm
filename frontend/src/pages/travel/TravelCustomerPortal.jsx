/**
 * Travel Customer Portal — end-user (customer) login + dashboard.
 *
 * Where it lives:
 *   /travel/portal  — login screen + logged-in customer dashboard
 *
 * Who uses it:
 *   Travel CRM customers (Contact rows with portalPasswordHash set), NOT
 *   staff. Login hits POST /api/portal/login; the returned PORTAL JWT is
 *   stored in localStorage under `portalToken` and the customer is shown
 *   their itineraries + KYC (DigiLocker) status.
 *
 * Why a dedicated Travel page (not the generic /portal):
 *   /portal renders the generic Knowledge Base portal (unauthenticated).
 *   This page is auth-gated and travel-tenant-only; the backend route
 *   handler enforces the travel-tenant guard via requireTravelPortalTenant
 *   in routes/portal.js.
 *
 * DigiLocker flow:
 *   The button in the top-right header (and the Profile section) calls
 *   POST /api/portal/kyc/initiate → receives { oauthUrl, state }. In STUB
 *   mode (APISETU_PARTNER_API_KEY unset on the backend) the oauthUrl
 *   points at a synthetic .invalid host so we skip the redirect and
 *   directly POST /api/portal/kyc/callback to advance the FSM — that's
 *   what makes the demo flow end-to-end without external dependencies.
 *   In REAL mode the oauthUrl is the actual DigiLocker /authorize URL
 *   and we window.location.href there; the DigiLocker provider redirects
 *   back to redirectUri with ?state=...&code=... which a small callback
 *   handler picks up and replays to /portal/kyc/callback.
 *
 * Verification gates:
 *   ADMIN + MANAGER roles on the staff side do NOT see this page (it's
 *   for customers; staff use /dashboard). The customer's role is implied
 *   by holding a PORTAL JWT, not by a User row.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { Navigate } from "react-router-dom";
import {
  ShieldCheck, ShieldAlert, LogOut, Plane, User as UserIcon,
  CheckCircle2, AlertCircle, Loader2, ClipboardCheck, Award, LayoutDashboard,
  ChevronRight, ChevronLeft, Hotel, Ticket, FileUp, Upload, UserPlus,
  Mail, Phone, Sun, Moon, Stamp,
} from "lucide-react";

const PORTAL_TOKEN_KEY = "portalToken";
const PORTAL_CONTACT_KEY = "portalContact";
// Light/dark preference for the customer portal. Stored separately from the
// staff app's `theme` key — the portal is a public Contact-token surface that
// manages its own theme (see the theme effect in TravelCustomerPortal).
const PORTAL_THEME_KEY = "portalTheme";

function readStoredAuth() {
  try {
    const token = localStorage.getItem(PORTAL_TOKEN_KEY);
    const raw = localStorage.getItem(PORTAL_CONTACT_KEY);
    const contact = raw ? JSON.parse(raw) : null;
    if (token && contact) return { token, contact };
  } catch (_e) { /* fall through */ }
  return { token: null, contact: null };
}

function clearStoredAuth() {
  localStorage.removeItem(PORTAL_TOKEN_KEY);
  localStorage.removeItem(PORTAL_CONTACT_KEY);
}

// Multipart variant of portalFetch — no Content-Type header (the browser
// sets the multipart boundary itself when the body is FormData).
async function portalUploadFetch(path, { token, formData }) {
  const res = await fetch(`/api/portal${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

async function portalFetch(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`/api/portal${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

export default function TravelCustomerPortal() {
  const initial = readStoredAuth();
  const [token, setToken] = useState(initial.token);
  const [contact, setContact] = useState(initial.contact);

  // Portal-owned light/dark theme. The customer portal is NOT a CRM-user
  // surface, so the app-global `data-vertical` (driven by tenant.vertical in
  // App.jsx) resolves to "generic" here — which means the page would inherit
  // index.css's generic, DARK-by-default :root tokens (dark cards on a cream
  // page = the "mixed theme"). We pin `data-vertical="travel"` + our own
  // `data-theme` so the WHOLE portal resolves the cohesive Travel palette
  // (theme/travel.css), then let the customer flip light/dark. Saved/restored
  // on unmount so it never leaks into the rest of the app (mirrors the
  // brand-kit effect's save/restore discipline below).
  const [portalTheme, setPortalTheme] = useState(() => {
    try {
      return localStorage.getItem(PORTAL_THEME_KEY) === "dark" ? "dark" : "light";
    } catch (_e) {
      return "light";
    }
  });

  // Pin the Travel vertical on mount; restore the prior attributes on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const prevVertical = root.getAttribute("data-vertical");
    const prevTheme = root.getAttribute("data-theme");
    root.setAttribute("data-vertical", "travel");
    return () => {
      if (prevVertical === null) root.removeAttribute("data-vertical");
      else root.setAttribute("data-vertical", prevVertical);
      if (prevTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", prevTheme);
    };
  }, []);

  // Apply + persist the portal theme whenever it changes.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", portalTheme);
    try { localStorage.setItem(PORTAL_THEME_KEY, portalTheme); } catch (_e) { /* ignore */ }
  }, [portalTheme]);

  const toggleTheme = useCallback(() => {
    setPortalTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const handleLogout = () => {
    clearStoredAuth();
    setToken(null);
    setContact(null);
  };

  // Customers sign in via the unified /login page (it auto-falls-back to the
  // portal auth) — so an unauthenticated visit here (incl. after logout) sends
  // them there rather than rendering a separate, redundant portal login.
  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // Persist contact edits (e.g. avatar) to state + localStorage so the
  // header/profile reflect them and survive a refresh.
  const updateContact = (patch) => {
    setContact((prev) => {
      const next = { ...(prev || {}), ...patch };
      try { localStorage.setItem(PORTAL_CONTACT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <Dashboard
      token={token}
      contact={contact}
      onUpdateContact={updateContact}
      onLogout={handleLogout}
      theme={portalTheme}
      onToggleTheme={toggleTheme}
    />
  );
}

// Sun/moon light-dark toggle used in the portal header (and login screen).
// Shows the icon for the mode you'll SWITCH TO so the affordance reads as an
// action, not a status.
function ThemeToggleButton({ theme, onToggle }) {
  const goingDark = theme !== "dark";
  return (
    <button
      type="button"
      onClick={onToggle}
      style={iconBtnStyle}
      title={goingDark ? "Switch to dark mode" : "Switch to light mode"}
      aria-label={goingDark ? "Switch to dark mode" : "Switch to light mode"}
      aria-pressed={theme === "dark"}
    >
      {goingDark ? <Moon size={16} aria-hidden /> : <Sun size={16} aria-hidden />}
    </button>
  );
}

const inputStyle = {
  display: "block",
  width: "100%",
  padding: "8px 12px",
  marginTop: 6,
  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
  borderRadius: 8,
  fontSize: 15,
  background: "var(--surface-color, #FFFFFF)",
  color: "var(--text-primary, #1F1B14)",
  boxSizing: "border-box",
};

function Dashboard({ token, contact, onUpdateContact, onLogout, theme, onToggleTheme }) {
  const [kyc, setKyc] = useState(null);
  const [itineraries, setItineraries] = useState([]);
  const [profile, setProfile] = useState(null);
  // G092 (PRD_TRAVEL_PER_SUBBRAND_BRANDING FR-3.3.f) — per-sub-brand
  // brand kit applied as CSS vars at the document root. Resolved from
  // the customer's Contact.subBrand (set by sales when the contact was
  // created against a specific brand) via the public /api/brand-kits/
  // by-subbrand/:subBrand endpoint. Null on 404 / fetch error → portal
  // falls back to the default Travel Stall navy/gold palette.
  const [brandKit, setBrandKit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifyMsg, setVerifyMsg] = useState(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  // Sidebar-driven view: overview | bookings | diagnostic | profile.
  const [view, setView] = useState("overview");
  // Within the bookings view, the booking whose detail is open (null = list).
  const [selectedBookingId, setSelectedBookingId] = useState(null);
  // Leaving the bookings view closes any open detail.
  useEffect(() => {
    if (view !== "bookings") setSelectedBookingId(null);
  }, [view]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [kycRes, itinRes, profileRes] = await Promise.all([
        portalFetch("/kyc/status", { token }),
        portalFetch("/travel/itineraries", { token }).catch(() => []),
        // G092 — fetch the customer's full profile (incl. subBrand) so
        // we can resolve the brand kit. Best-effort: any error leaves
        // `profile` null and the brand kit fetch short-circuits.
        portalFetch("/travel/profile", { token }).catch(() => null),
      ]);
      setKyc(kycRes);
      setItineraries(Array.isArray(itinRes) ? itinRes : []);
      setProfile(profileRes || null);
    } catch (err) {
      if (err.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }, [token, onLogout]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // G092 — fetch the brand kit for the customer's sub-brand. Public
  // endpoint (no auth header). Triggered when subBrand is first known
  // (via the /travel/profile load above).
  useEffect(() => {
    const sb = profile?.subBrand;
    if (!sb) {
      setBrandKit(null);
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/brand-kits/by-subbrand/${encodeURIComponent(sb)}`);
        if (!res.ok) {
          if (alive) setBrandKit(null);
          return;
        }
        const data = await res.json();
        if (alive) setBrandKit(data?.brandKit || null);
      } catch (_e) {
        if (alive) setBrandKit(null);
      }
    })();
    return () => { alive = false; };
  }, [profile?.subBrand]);

  // G092 — apply palette as CSS vars at the document root so existing
  // `var(--primary-color, …)` references throughout the portal page
  // pick up the brand color without a render-tree rewrite. Cleared on
  // unmount so navigating away (or logging out) doesn't leak palette
  // into other surfaces.
  //
  // The brand's primary/accent are identity colours and apply in both light
  // and dark mode. Its bg/text, however, are LIGHT-mode values — applying
  // them in dark mode would override travel.css's dark tokens and re-create
  // the light-page / dark-card mismatch. So we only set bg/text in light mode
  // (and re-run on theme change so toggling restores them).
  useEffect(() => {
    const root = document.documentElement;
    if (!brandKit) return undefined;
    const prev = {
      primary: root.style.getPropertyValue("--primary-color"),
      accent: root.style.getPropertyValue("--accent-color"),
      bg: root.style.getPropertyValue("--bg-color"),
      text: root.style.getPropertyValue("--text-primary"),
    };
    if (brandKit.primaryColor) root.style.setProperty("--primary-color", brandKit.primaryColor);
    if (brandKit.accentColor) root.style.setProperty("--accent-color", brandKit.accentColor);
    if (theme === "light") {
      if (brandKit.bgColor) root.style.setProperty("--bg-color", brandKit.bgColor);
      if (brandKit.textColor) root.style.setProperty("--text-primary", brandKit.textColor);
    }
    return () => {
      // Restore previous values (empty string clears the inline override
      // so the cascaded default reasserts).
      root.style.setProperty("--primary-color", prev.primary);
      root.style.setProperty("--accent-color", prev.accent);
      root.style.setProperty("--bg-color", prev.bg);
      root.style.setProperty("--text-primary", prev.text);
    };
  }, [brandKit, theme]);

  const handleVerify = async () => {
    setVerifyMsg(null);
    setVerifyLoading(true);
    try {
      const redirectUri = `${window.location.origin}/travel/portal/kyc/callback`;
      const initRes = await portalFetch("/kyc/initiate", {
        token,
        method: "POST",
        body: { redirectUri },
      });
      // In STUB mode (kyc.mode === "stub") the oauthUrl points to a
      // synthetic .invalid host. We skip the redirect and complete the
      // callback inline so the demo end-to-end works without DigiLocker.
      // In REAL mode (apisetu-partner / oauth2) we redirect to the
      // DigiLocker authorize URL — the user logs in to DigiLocker,
      // consents, and DigiLocker redirects back to redirectUri with
      // ?state=...&code=... which a future callback handler will pick up.
      if (kyc?.mode === "stub") {
        const cb = await portalFetch("/kyc/callback", {
          token,
          method: "POST",
          body: { state: initRes.state, code: "stub-code" },
        });
        setVerifyMsg({ ok: true, text: `Verified ✓ (Aadhaar ••••${cb.aadhaarLast4})` });
        await loadAll();
      } else {
        window.location.href = initRes.oauthUrl;
      }
    } catch (err) {
      if (err.code === "ALREADY_VERIFIED") {
        setVerifyMsg({ ok: true, text: "Already verified" });
        await loadAll();
      } else {
        setVerifyMsg({ ok: false, text: err.message || "Verification failed" });
      }
    } finally {
      setVerifyLoading(false);
    }
  };

  const verified = kyc?.kycStatus === "verified";

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: "var(--bg-color, #FAF6EE)" }}>
      <PortalSidebar view={view} setView={setView} contact={contact} bookingsCount={itineraries.length} />

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "14px 24px",
          background: "var(--surface-color, #FFFFFF)",
          borderBottom: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
          gap: 16,
          flexWrap: "wrap",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {brandKit?.logoUrl && (
              <img
                src={brandKit.logoUrl}
                alt={brandKit.tagline || "Brand logo"}
                data-testid="portal-brand-logo"
                style={{ height: 28, width: "auto", maxWidth: 120, objectFit: "contain" }}
              />
            )}
            <strong style={{ fontSize: 16 }}>
              {view === "overview" && "Dashboard"}
              {view === "bookings" && "My Bookings"}
              {view === "visa" && "My Visa Applications"}
              {view === "documents" && "Travel Documents"}
              {view === "diagnostic" && "Travel Diagnostic"}
              {view === "profile" && "My Profile"}
            </strong>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <ThemeToggleButton theme={theme} onToggle={onToggleTheme} />
            <DigiLockerButton verified={verified} loading={verifyLoading} onClick={handleVerify} />
            {/* Clickable name + avatar → opens the Profile view. */}
            <button
              type="button"
              onClick={() => setView("profile")}
              title="View your profile"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "4px 10px 4px 4px", borderRadius: 999,
                border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
                background: view === "profile" ? "rgba(18, 38, 71, 0.06)" : "transparent",
                cursor: "pointer", fontSize: 14, color: "var(--text-primary)",
              }}
            >
              <Avatar url={contact?.avatarUrl} name={contact?.name || contact?.email} size={28} />
              {contact?.name || contact?.email}
            </button>
            <button type="button" onClick={onLogout} style={iconBtnStyle} title="Sign out" aria-label="Sign out">
              <LogOut size={16} aria-hidden />
            </button>
          </div>
        </header>

        <main style={{ flex: 1, maxWidth: 1000, width: "100%", margin: "0 auto", padding: 24, display: "grid", gap: 16, alignContent: "start" }}>
          {verifyMsg && (
            <div role="status" style={{
              padding: "10px 14px", borderRadius: 10,
              background: verifyMsg.ok ? "rgba(47, 122, 77, 0.10)" : "rgba(168, 50, 63, 0.10)",
              color: verifyMsg.ok ? "var(--success-color, #2F7A4D)" : "var(--danger-color, #A8323F)",
              display: "flex", alignItems: "center", gap: 8, fontSize: 14,
            }}>
              {verifyMsg.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              {verifyMsg.text}
            </div>
          )}

          {view === "overview" && (
            <Overview
              contact={contact}
              itineraries={itineraries}
              loading={loading}
              verified={verified}
              onOpen={setView}
            />
          )}

          {view === "bookings" && (
            selectedBookingId != null ? (
              <BookingDetail
                itinerary={itineraries.find((i) => i.id === selectedBookingId)}
                token={token}
                onChanged={loadAll}
                onBack={() => setSelectedBookingId(null)}
              />
            ) : (
              <ItinerariesCard itineraries={itineraries} loading={loading} onSelect={setSelectedBookingId} />
            )
          )}

          {view === "visa" && <VisaApplicationCard token={token} />}

          {view === "documents" && <TravellersCard token={token} onLogout={onLogout} />}

          {view === "diagnostic" && <DiagnosticsCard token={token} />}

          {view === "profile" && (
            <ProfileView
              token={token}
              contact={contact}
              kyc={kyc}
              loading={loading}
              verifyLoading={verifyLoading}
              onVerify={handleVerify}
              onUpdateContact={onUpdateContact}
            />
          )}
        </main>

        {brandKit && (brandKit.missionStatement || brandKit.supportEmail || brandKit.supportPhone || brandKit.footerText) && (
          <footer
            data-testid="portal-brand-footer"
            style={{
              padding: "20px 24px",
              borderTop: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
              background: "var(--surface-color, #FFFFFF)",
              maxWidth: 1000,
              width: "100%",
              margin: "0 auto",
            }}
          >
            {brandKit.missionStatement && (
              <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-secondary)" }}>
                {brandKit.missionStatement}
              </p>
            )}
            {(brandKit.supportEmail || brandKit.supportPhone) && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                {brandKit.supportEmail && (
                  <a
                    href={`mailto:${brandKit.supportEmail}`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--primary-color, #122647)", textDecoration: "none" }}
                  >
                    <Mail size={14} aria-hidden /> {brandKit.supportEmail}
                  </a>
                )}
                {brandKit.supportPhone && (
                  <a
                    href={`tel:${brandKit.supportPhone}`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--primary-color, #122647)", textDecoration: "none" }}
                  >
                    <Phone size={14} aria-hidden /> {brandKit.supportPhone}
                  </a>
                )}
              </div>
            )}
            {brandKit.footerText && (
              <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--text-secondary)" }}>
                {brandKit.footerText}
              </p>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

// ─── Sidebar + header building blocks ────────────────────────────────

// Profile is intentionally NOT a sidebar item — it's opened by clicking the
// name/avatar in the header (PortalHeader), per the customer-portal design.
// ─── My Visa Application (FR-5/FR-6 customer self-serve) ──────────────
// After the Visa Sure diagnostic the customer comes here to: see the docs
// they'll need (checklist-preview), start their application, then upload each
// document. The advisor verifies/rejects each upload on their side.
const VISA_TYPES = [
  { value: "tourist", label: "Tourist" },
  { value: "business", label: "Business" },
  { value: "student", label: "Student" },
  { value: "work", label: "Work" },
  { value: "umrah", label: "Umrah" },
  { value: "hajj", label: "Hajj" },
];
const VISA_DOC_STATUS_META = {
  pending: { label: "Awaiting upload", color: "var(--text-secondary, #6b7280)" },
  uploaded: { label: "In review", color: "#9A6F2E" },
  verified: { label: "Verified ✓", color: "#16a34a" },
  rejected: { label: "Rejected — please re-upload", color: "#ef4444" },
};

function VisaApplicationCard({ token }) {
  // A customer can hold several visa applications at once — one per visa
  // (e.g. a UAE transit visa + a USA visa for the same trip). Each is
  // independent: its own checklist, uploads, status, and cancel.
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null); // { type: 'error' | 'success', text }
  const [form, setForm] = useState({ applicationType: "tourist", destinationCountry: "" });
  const [preview, setPreview] = useState(null);
  const [starting, setStarting] = useState(false);
  const [uploadingId, setUploadingId] = useState(null);
  const [showStart, setShowStart] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await portalFetch("/travel/visa/applications", { token });
      setApps(Array.isArray(data.applications) ? data.applications : []);
    } catch (e) {
      setMsg({ type: "error", text: e.message || "Failed to load your visa applications" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { reload(); }, [reload]);

  // The start form is open when the customer has no applications yet, or has
  // explicitly clicked "Start another".
  const startFormOpen = showStart || (!loading && apps.length === 0);

  // Live "what you'll need" preview while filling the start form.
  useEffect(() => {
    if (!startFormOpen) { setPreview(null); return; }
    const at = form.applicationType;
    const dc = form.destinationCountry.trim();
    if (!at || !dc) { setPreview(null); return; }
    let cancelled = false;
    portalFetch(
      `/travel/visa/checklist-preview?applicationType=${encodeURIComponent(at)}&destinationCountry=${encodeURIComponent(dc)}`,
      { token },
    )
      .then((d) => { if (!cancelled) setPreview(d.items || []); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [startFormOpen, form.applicationType, form.destinationCountry, token]);

  const start = async () => {
    if (!form.destinationCountry.trim()) {
      setMsg({ type: "error", text: "Please enter your destination country" });
      return;
    }
    setStarting(true);
    setMsg(null);
    try {
      await portalFetch("/travel/visa/applications", {
        token,
        method: "POST",
        body: { applicationType: form.applicationType, destinationCountry: form.destinationCountry.trim() },
      });
      setForm({ applicationType: "tourist", destinationCountry: "" });
      setPreview(null);
      setShowStart(false);
      await reload();
      setMsg({ type: "success", text: "Your application is started — upload your documents below." });
    } catch (e) {
      setMsg({ type: "error", text: e.message || "Couldn't start your application" });
    } finally {
      setStarting(false);
    }
  };

  const upload = async (itemId, file) => {
    if (!file) return;
    setUploadingId(itemId);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await portalUploadFetch(`/travel/visa/documents/${itemId}/upload`, { token, formData: fd });
      await reload();
      setMsg({ type: "success", text: "Document uploaded — your advisor will review it." });
    } catch (e) {
      setMsg({ type: "error", text: e.message || "Upload failed" });
    } finally {
      setUploadingId(null);
    }
  };

  // Cancel one application (only while early) — e.g. it was started for the
  // wrong destination, or no checklist was set up for it.
  const cancelApplication = async (appId) => {
    if (!window.confirm('Cancel this application? Any documents you have uploaded for it will be removed.')) {
      return;
    }
    setStarting(true);
    setMsg(null);
    try {
      await portalFetch(`/travel/visa/applications/${appId}`, { token, method: 'DELETE' });
      await reload();
      setMsg({ type: 'success', text: 'Application cancelled.' });
    } catch (e) {
      setMsg({ type: 'error', text: e.message || "Couldn't cancel the application" });
    } finally {
      setStarting(false);
    }
  };

  if (loading) {
    return <section style={cardStyle} data-testid="visa-loading">Loading…</section>;
  }

  const banner = msg ? (
    <div
      data-testid="visa-banner"
      style={{
        padding: "10px 12px", borderRadius: 8, marginBottom: 14, fontSize: 14,
        background: msg.type === "error" ? "rgba(239,68,68,0.1)" : "rgba(22,163,74,0.1)",
        color: msg.type === "error" ? "#ef4444" : "#16a34a",
      }}
    >
      {msg.text}
    </div>
  ) : null;

  // One application card — header + status + checklist + uploads + cancel.
  const renderApplication = (app) => {
    const items = app.documentChecklist || [];
    const requiredItems = items.filter((i) => i.required);
    const verifiedRequired = requiredItems.filter((i) => i.status === "verified");
    const allVerified = requiredItems.length > 0 && verifiedRequired.length === requiredItems.length;
    const cancellable = app.status === "intake" || app.status === "docs-pending";
    return (
      <section key={app.id} style={{ ...cardStyle, marginBottom: 14 }} data-testid={`visa-application-${app.id}`}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: "var(--text-primary)" }}>
            {(VISA_TYPES.find((t) => t.value === app.applicationType) || {}).label || app.applicationType} visa — {app.destinationCountry}
          </h2>
          <span
            data-testid={`visa-app-status-${app.id}`}
            style={{
              marginLeft: "auto", padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
              background: app.status === "filed" || app.status === "approved" ? "rgba(22,163,74,0.12)" : "rgba(18,38,71,0.08)",
              color: app.status === "filed" || app.status === "approved" ? "#16a34a" : "var(--text-secondary)",
            }}
          >
            {app.status}
          </span>
        </div>
        {requiredItems.length > 0 && (
          <p style={{ color: "var(--text-secondary)", fontSize: 14, marginTop: 0 }}>
            {verifiedRequired.length} of {requiredItems.length} required documents verified.
            {allVerified ? " All set — your advisor has everything they need." : ""}
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {items.map((item) => {
            const meta = VISA_DOC_STATUS_META[item.status] || VISA_DOC_STATUS_META.pending;
            const canUpload = item.status !== "verified";
            return (
              <div
                key={item.id}
                data-testid={`visa-doc-${item.id}`}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--border-color, rgba(18,38,71,0.1))" }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, color: "var(--text-primary)" }}>
                    {item.docType}
                    {item.required ? null : <span style={{ color: "var(--text-secondary)", fontSize: 12 }}> (optional)</span>}
                  </div>
                  <div style={{ fontSize: 12, color: meta.color, marginTop: 2 }}>{meta.label}</div>
                  {item.status === "rejected" && item.notes && (
                    <div style={{ fontSize: 12, color: "#ef4444", marginTop: 2 }}>Reason: {item.notes}</div>
                  )}
                </div>
                {item.attachmentUrl && (
                  <a
                    href={item.attachmentUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, color: "var(--primary-color, #122647)", textDecoration: "underline" }}
                  >
                    View
                  </a>
                )}
                {canUpload && (
                  <label
                    data-testid={`visa-upload-${item.id}`}
                    style={{ ...portalPrimaryBtnStyle, cursor: uploadingId === item.id ? "wait" : "pointer", opacity: uploadingId === item.id ? 0.6 : 1, padding: "6px 12px", fontSize: 12 }}
                  >
                    <Upload size={13} />
                    {uploadingId === item.id ? "Uploading…" : item.status === "pending" ? "Upload" : "Replace"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,application/pdf"
                      style={visuallyHiddenInputStyle}
                      disabled={uploadingId === item.id}
                      onChange={(e) => {
                        const f = e.target.files && e.target.files[0];
                        e.target.value = "";
                        upload(item.id, f);
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
          {items.length === 0 && (
            <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              Your advisor will add the documents you need shortly.
            </p>
          )}
        </div>

        {cancellable && (
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border-color, rgba(18,38,71,0.1))" }}>
            <button
              type="button"
              data-testid={`visa-cancel-${app.id}`}
              onClick={() => cancelApplication(app.id)}
              disabled={starting}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "7px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: "transparent", color: "#ef4444",
                border: "1px solid rgba(239,68,68,0.4)",
                cursor: starting ? "wait" : "pointer", opacity: starting ? 0.6 : 1,
              }}
            >
              Cancel this application
            </button>
          </div>
        )}
      </section>
    );
  };

  const startForm = (
    <section style={cardStyle} data-testid="visa-start">
      <h2 style={{ marginTop: 0, fontSize: 18, color: "var(--text-primary)" }}>
        {apps.length > 0 ? "Start another visa application" : "Start your visa application"}
      </h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 14 }}>
        Travelling through more than one country (e.g. a transit stop)? Start a separate application for each visa you
        need. Tell us the visa type and destination to see the documents you&rsquo;ll need.
      </p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <label style={{ flex: "1 1 160px", fontSize: 13, fontWeight: 600 }}>
          Visa type
          <select
            data-testid="visa-start-type"
            value={form.applicationType}
            onChange={(e) => setForm({ ...form, applicationType: e.target.value })}
            style={inputStyle}
          >
            {VISA_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </label>
        <label style={{ flex: "2 1 220px", fontSize: 13, fontWeight: 600 }}>
          Destination country
          <input
            data-testid="visa-start-destination"
            type="text"
            placeholder="e.g. United States"
            value={form.destinationCountry}
            onChange={(e) => setForm({ ...form, destinationCountry: e.target.value })}
            style={inputStyle}
          />
        </label>
      </div>

      {preview && preview.length > 0 && (
        <div style={{ marginTop: 16 }} data-testid="visa-preview">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>You&rsquo;ll need to provide:</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-secondary)", fontSize: 14 }}>
            {preview.map((p, i) => (
              <li key={i}>{p.docType}{p.required ? "" : " (optional)"}</li>
            ))}
          </ul>
        </div>
      )}
      {preview && preview.length === 0 && (
        <p style={{ marginTop: 16, color: "var(--text-secondary)", fontSize: 14 }}>
          No preset document list for this destination yet — your advisor will confirm what&rsquo;s needed once you start.
        </p>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18 }}>
        <button
          type="button"
          data-testid="visa-start-submit"
          onClick={start}
          disabled={starting}
          style={{ ...portalPrimaryBtnStyle, opacity: starting ? 0.6 : 1 }}
        >
          <Stamp size={15} /> {starting ? "Starting…" : "Start my application"}
        </button>
        {apps.length > 0 && (
          <button
            type="button"
            data-testid="visa-start-close"
            onClick={() => { setShowStart(false); setPreview(null); }}
            style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 13, cursor: "pointer" }}
          >
            Cancel
          </button>
        )}
      </div>
    </section>
  );

  return (
    <div data-testid="visa-applications">
      {banner}
      {apps.map(renderApplication)}
      {startFormOpen ? (
        startForm
      ) : (
        <button
          type="button"
          data-testid="visa-start-another"
          onClick={() => setShowStart(true)}
          style={{ ...portalPrimaryBtnStyle, background: "transparent", color: "var(--primary-color, #122647)", border: "1px solid var(--primary-color, #122647)" }}
        >
          <Stamp size={15} /> Start another visa application
        </button>
      )}
    </div>
  );
}

const NAV_ITEMS = [
  { key: "overview", label: "Dashboard", icon: LayoutDashboard },
  { key: "bookings", label: "My Bookings", icon: Plane },
  { key: "visa", label: "My Visa", icon: Stamp },
  { key: "documents", label: "Travel Documents", icon: FileUp },
  { key: "diagnostic", label: "Travel Diagnostic", icon: ClipboardCheck },
];

function PortalSidebar({ view, setView, contact, bookingsCount }) {
  return (
    <aside style={{
      width: 240,
      flexShrink: 0,
      background: "var(--surface-color, #FFFFFF)",
      borderRight: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
      display: "flex",
      flexDirection: "column",
      padding: "18px 12px",
      gap: 4,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 14px" }}>
        <Plane size={22} aria-hidden style={{ color: "var(--primary-color, #122647)" }} />
        <strong style={{ fontSize: 15 }}>Travel Portal</strong>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px", marginBottom: 8 }}>
        <Avatar url={contact?.avatarUrl} name={contact?.name || contact?.email} size={36} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {contact?.name || "Customer"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {contact?.email}
          </div>
        </div>
      </div>
      <nav aria-label="Portal sections" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV_ITEMS.map(({ key, label, icon: Icon }) => {
          const active = view === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              aria-current={active ? "page" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "9px 12px", borderRadius: 8, border: "none",
                textAlign: "left", cursor: "pointer", fontSize: 14, fontWeight: active ? 600 : 500,
                background: active ? "var(--primary-color, #122647)" : "transparent",
                color: active ? "#fff" : "var(--text-primary)",
              }}
            >
              <Icon size={17} aria-hidden />
              <span style={{ flex: 1 }}>{label}</span>
              {key === "bookings" && bookingsCount > 0 && (
                <span style={{
                  fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: "center",
                  padding: "1px 6px", borderRadius: 999,
                  background: active ? "rgba(255,255,255,0.22)" : "rgba(18, 38, 71, 0.10)",
                }}>
                  {bookingsCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// Round avatar — image when set, else initials on the brand colour.
function Avatar({ url, name, size = 36 }) {
  if (url) {
    return (
      <img
        src={url}
        alt={name || "Profile"}
        style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, background: "#eee" }}
      />
    );
  }
  const initials = (name || "?")
    .split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: "var(--primary-color, #122647)", color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontWeight: 700, fontSize: Math.round(size * 0.38),
    }}>
      {initials}
    </div>
  );
}

// ─── Overview (home) — clickable summary cards ───────────────────────

function Overview({ contact, itineraries, loading, verified, onOpen }) {
  const accepted = itineraries.filter((i) => i.status === "accepted" || i.status === "advance_paid" || i.status === "fully_paid").length;
  return (
    <>
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 14 }}>
        <Avatar url={contact?.avatarUrl} name={contact?.name || contact?.email} size={48} />
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Welcome{contact?.name ? `, ${contact.name.split(" ")[0]}` : ""}!</div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            {verified ? "Your identity is verified." : "Complete your DigiLocker verification from your profile."}
          </div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 16 }}>
        <OverviewCard
          icon={Plane}
          label="My Bookings"
          value={loading ? "…" : String(itineraries.length)}
          hint={loading ? "Loading…" : `${accepted} confirmed`}
          onClick={() => onOpen("bookings")}
        />
        <OverviewCard
          icon={FileUp}
          label="Travel Documents"
          value="Open"
          hint="Add travellers + upload their passports"
          onClick={() => onOpen("documents")}
        />
        <OverviewCard
          icon={ClipboardCheck}
          label="Travel Diagnostic"
          value="Open"
          hint="Help your advisor tailor your package"
          onClick={() => onOpen("diagnostic")}
        />
      </div>
    </>
  );
}

function OverviewCard({ icon: Icon, label, value, hint, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...cardStyle, textAlign: "left", cursor: "pointer", border: "1px solid var(--border-color, rgba(18,38,71,0.12))",
        display: "flex", flexDirection: "column", gap: 6, background: "var(--surface-color, #FFFFFF)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-secondary)", fontSize: 13, fontWeight: 600 }}>
        <Icon size={16} aria-hidden /> {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: "var(--text-primary)" }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{hint}</div>
    </button>
  );
}

// ─── Profile view — profile details + avatar upload + KYC ────────────

function ProfileView({ token, contact, kyc, loading, verifyLoading, onVerify, onUpdateContact }) {
  return (
    <>
      <section style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <AvatarUploader token={token} contact={contact} onUpdated={(avatarUrl) => onUpdateContact({ avatarUrl })} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{contact?.name || "—"}</div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{contact?.email}</div>
        </div>
      </section>
      <ProfileCard
        contact={contact}
        kyc={kyc}
        loading={loading}
        verifyLoading={verifyLoading}
        onVerify={onVerify}
      />
    </>
  );
}

function AvatarUploader({ token, contact, onUpdated }) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState(null);

  const onPick = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setErr(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // Raw fetch (NOT portalFetch) — FormData must set its own multipart
      // boundary; portalFetch would force application/json.
      const res = await fetch("/api/portal/travel/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Upload failed");
      onUpdated(data.avatarUrl);
    } catch (e2) {
      setErr(e2.message || "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <Avatar url={contact?.avatarUrl} name={contact?.name || contact?.email} size={72} />
      <label style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "6px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600,
        border: "1px solid var(--border-color, rgba(18,38,71,0.12))",
        cursor: uploading ? "wait" : "pointer", color: "var(--text-primary)",
      }}>
        {uploading ? <Loader2 size={14} className="spin" aria-hidden /> : <UserIcon size={14} aria-hidden />}
        {uploading ? "Uploading…" : contact?.avatarUrl ? "Change photo" : "Upload photo"}
        <input
          type="file"
          accept="image/*"
          onChange={onPick}
          disabled={uploading}
          style={{ display: "none" }}
          aria-label="Upload profile photo"
        />
      </label>
      {err && <span style={{ fontSize: 12, color: "var(--danger-color, #A8323F)" }}>{err}</span>}
    </div>
  );
}

function DigiLockerButton({ verified, loading, onClick }) {
  const styleBase = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 999,
    fontWeight: 600,
    fontSize: 14,
    border: "1px solid",
    cursor: loading ? "wait" : "pointer",
  };
  if (verified) {
    return (
      <span
        style={{
          ...styleBase,
          background: "rgba(47, 122, 77, 0.10)",
          color: "var(--success-color, #2F7A4D)",
          borderColor: "var(--success-color, #2F7A4D)",
          cursor: "default",
        }}
        title="DigiLocker verified"
      >
        <ShieldCheck size={16} aria-hidden /> Verified
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      style={{
        ...styleBase,
        background: "var(--primary-color, #122647)",
        color: "white",
        borderColor: "var(--primary-color, #122647)",
      }}
    >
      {loading ? <Loader2 size={16} className="spin" aria-hidden /> : <ShieldAlert size={16} aria-hidden />}
      {loading ? "Connecting…" : "Connect with DigiLocker"}
    </button>
  );
}

function ProfileCard({ contact, kyc, loading, verifyLoading, onVerify }) {
  return (
    <section style={cardStyle} aria-labelledby="profile-heading">
      <h2 id="profile-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
        <UserIcon size={20} aria-hidden /> Profile
      </h2>
      <dl style={{ marginTop: 12, display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", fontSize: 14 }}>
        <dt style={dtStyle}>Name</dt>
        <dd style={ddStyle}>{contact?.name || "—"}</dd>
        <dt style={dtStyle}>Email</dt>
        <dd style={ddStyle}>{contact?.email || "—"}</dd>
        {contact?.company && (<>
          <dt style={dtStyle}>Company</dt>
          <dd style={ddStyle}>{contact.company}</dd>
        </>)}
      </dl>
      <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--border-color, rgba(18, 38, 71, 0.08))" }} />
      <h3 style={{ display: "flex", alignItems: "center", gap: 8, margin: 0, fontSize: 16 }}>
        <ShieldCheck size={18} aria-hidden /> DigiLocker / Aadhaar
      </h3>
      {loading ? (
        <p style={{ color: "var(--text-secondary)", margin: "8px 0 0" }}>Loading…</p>
      ) : kyc?.kycStatus === "verified" ? (
        <div style={{ marginTop: 8 }}>
          <p style={{ margin: 0, color: "var(--success-color, #2F7A4D)" }}>
            <CheckCircle2 size={16} aria-hidden style={{ verticalAlign: -3, marginRight: 4 }} />
            Verified ✓ — Aadhaar ••••{kyc.aadhaarLast4 || "????"}
          </p>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            Verified on {kyc.kycVerifiedAt ? new Date(kyc.kycVerifiedAt).toLocaleString() : "—"}
            {kyc.mode === "stub" && " (demo / stub mode)"}
          </p>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 14 }}>
            Your Aadhaar is not yet linked. Connecting via DigiLocker proves
            your identity for visa applications and travel bookings.
          </p>
          <button
            type="button"
            onClick={onVerify}
            disabled={verifyLoading}
            style={{
              marginTop: 12,
              padding: "8px 16px",
              background: "var(--primary-color, #122647)",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontWeight: 600,
              cursor: verifyLoading ? "wait" : "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {verifyLoading ? <Loader2 size={16} className="spin" aria-hidden /> : <ShieldAlert size={16} aria-hidden />}
            {verifyLoading ? "Connecting…" : "Connect with DigiLocker"}
          </button>
          {kyc?.mode === "stub" && (
            <p style={{ marginTop: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              Demo mode — APISETU_PARTNER_API_KEY is not set on the server,
              so the verification completes with a synthetic Aadhaar.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

const SUB_BRAND_LABELS = {
  tmc: "TMC — School trips",
  rfu: "RFU — Umrah",
  travelstall: "Travel Stall — Family holidays",
  visasure: "Visa Sure",
};
const brandLabel = (b) => SUB_BRAND_LABELS[b] || b;

// ─── Travel Documents — travellers + passport upload ─────────────────
//
// Customer-side half of the passport OCR flow (PRD_PASSPORT_OCR AC-1).
// The customer registers travellers on a trip and uploads each one's
// passport; uploads land in the staff verification queue. The portal only
// ever sees STATUS (timestamps), never extracted passport fields.

const PORTAL_PASSPORT_ACCEPT = ".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf";
const PORTAL_PASSPORT_MAX_BYTES = 5 * 1024 * 1024; // mirror the route's multer cap

function travellerPassportState(t) {
  if (t.passportVerifiedAt) return { label: "Verified", bg: "rgba(47, 122, 77, 0.12)", color: "#2F7A4D", canUpload: false };
  if (t.passportRejectedAt) return { label: "Rejected — please re-upload", bg: "rgba(168, 50, 63, 0.12)", color: "#A8323F", canUpload: true };
  if (t.passportExtractedAt) return { label: "Under review", bg: "rgba(200, 154, 78, 0.16)", color: "#9A6F2E", canUpload: true };
  // Neutral pill uses the theme-aware --subtle-bg-3 token (identical navy tint
  // in travel light; gold tint in travel dark) so it stays visible in both.
  return { label: "Passport needed", bg: "var(--subtle-bg-3, rgba(18, 38, 71, 0.08))", color: "var(--text-secondary)", canUpload: true };
}

const RELATIONSHIP_OPTIONS = [
  { value: "self", label: "Myself" },
  { value: "spouse", label: "Spouse" },
  { value: "child", label: "Child" },
  { value: "parent", label: "Parent" },
  { value: "other", label: "Other" },
];

function TravellersCard({ token, onLogout }) {
  const [travellers, setTravellers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null); // traveller id mid-upload
  const [banner, setBanner] = useState(null); // { ok, text }
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState({ fullName: "", relationship: "self" });
  const [addBusy, setAddBusy] = useState(false);

  // An expired PORTAL JWT returns 401 — boot to the login screen rather than
  // rendering a misleading empty/"failed" state (matches Dashboard.loadAll).
  const isExpiry = (err) => err && err.status === 401;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await portalFetch("/travel/travellers", { token });
      setTravellers(Array.isArray(res?.travellers) ? res.travellers : []);
    } catch (err) {
      if (isExpiry(err)) { onLogout(); return; }
      // Non-auth failure — surface it instead of a false empty state.
      setBanner({ ok: false, text: "Couldn't load your travellers. Please try again." });
    } finally {
      setLoading(false);
    }
  }, [token, onLogout]);

  useEffect(() => { load(); }, [load]);

  const addTraveller = async (e) => {
    e.preventDefault();
    setBanner(null);
    if (!addForm.fullName.trim()) {
      setBanner({ ok: false, text: "Enter the traveller's full name." });
      return;
    }
    setAddBusy(true);
    try {
      await portalFetch("/travel/travellers", {
        token,
        method: "POST",
        body: { fullName: addForm.fullName.trim(), relationship: addForm.relationship },
      });
      setBanner({ ok: true, text: `${addForm.fullName.trim()} added — now upload their passport.` });
      setAddForm({ fullName: "", relationship: "self" });
      setAdding(false);
      await load();
    } catch (err) {
      if (isExpiry(err)) { onLogout(); return; }
      setBanner({ ok: false, text: err.message || "Failed to add traveller" });
    } finally {
      setAddBusy(false);
    }
  };

  const uploadPassport = async (t, file) => {
    setBanner(null);
    const mime = (file.type || "").toLowerCase();
    if (!["image/jpeg", "image/png", "application/pdf"].includes(mime)) {
      setBanner({ ok: false, text: "Unsupported file type — JPG, PNG or PDF only." });
      return;
    }
    if (file.size > PORTAL_PASSPORT_MAX_BYTES) {
      setBanner({ ok: false, text: "File exceeds the 5 MB limit." });
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    setBusyId(t.id);
    try {
      await portalUploadFetch(`/travel/travellers/${t.id}/passport-upload`, { token, formData });
      setBanner({ ok: true, text: `Passport uploaded for ${t.fullName} — our team will verify it shortly.` });
      await load();
    } catch (err) {
      if (isExpiry(err)) { onLogout(); return; }
      if (err.code === "PASSPORT_OCR_NOT_YET_ENABLED") {
        setBanner({ ok: false, text: "Passport upload is temporarily unavailable — please try again later." });
      } else {
        setBanner({ ok: false, text: err.message || "Failed to upload passport" });
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section style={cardStyle} aria-labelledby="travellers-heading">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h2 id="travellers-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
          <FileUp size={20} aria-hidden /> Travel Documents
        </h2>
        {!adding && (
          <button type="button" onClick={() => { setAdding(true); setBanner(null); }} style={portalPrimaryBtnStyle}>
            <UserPlus size={15} aria-hidden /> Add traveller
          </button>
        )}
      </div>
      <p style={{ color: "var(--text-secondary)", marginTop: 6, marginBottom: 0, fontSize: 14 }}>
        Add everyone travelling under your booking, then upload each traveller&apos;s
        passport (JPG, PNG or PDF, up to 5 MB). Our team verifies every upload.
      </p>

      {banner && (
        <div role="status" style={{
          marginTop: 12, padding: "10px 14px", borderRadius: 10, fontSize: 14,
          display: "flex", alignItems: "center", gap: 8,
          background: banner.ok ? "rgba(47, 122, 77, 0.10)" : "rgba(168, 50, 63, 0.10)",
          color: banner.ok ? "var(--success-color, #2F7A4D)" : "var(--danger-color, #A8323F)",
        }}>
          {banner.ok ? <CheckCircle2 size={16} aria-hidden /> : <AlertCircle size={16} aria-hidden />}
          {banner.text}
        </div>
      )}

      {adding && (
        <form onSubmit={addTraveller} style={{
          marginTop: 14, padding: 14, borderRadius: 10,
          border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
          display: "grid", gap: 10,
        }}>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              Traveller full name
              <input
                value={addForm.fullName}
                onChange={(e) => setAddForm((f) => ({ ...f, fullName: e.target.value }))}
                placeholder="As printed on the passport"
                style={inputStyle}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              Who is this?
              <select
                value={addForm.relationship}
                onChange={(e) => setAddForm((f) => ({ ...f, relationship: e.target.value }))}
                style={inputStyle}
              >
                {RELATIONSHIP_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="submit" disabled={addBusy} style={{ ...portalPrimaryBtnStyle, opacity: addBusy ? 0.6 : 1 }}>
              {addBusy ? "Adding…" : "Add traveller"}
            </button>
            <button type="button" onClick={() => { setAdding(false); setBanner(null); }} style={backBtnStyle}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div style={{ marginTop: 14, display: "grid", gap: 8 }}>
        {loading ? (
          <div style={{ color: "var(--text-secondary)", fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
            <Loader2 size={16} aria-hidden className="spin" /> Loading travellers…
          </div>
        ) : travellers.length === 0 ? (
          <div style={{ color: "var(--text-secondary)", fontSize: 14, padding: "18px 0", textAlign: "center" }}>
            No travellers yet — add the people travelling under your booking to get started.
          </div>
        ) : (
          travellers.map((t) => (
            <TravellerDocRow
              key={t.id}
              traveller={t}
              busy={busyId === t.id}
              onUpload={uploadPassport}
            />
          ))
        )}
      </div>
    </section>
  );
}

// One traveller row. The upload control is a real <button> that triggers a
// ref'd hidden file input via .click(): a button is keyboard-operable and
// gets the app's global :focus-visible ring (WCAG 2.4.7), and its accessible
// name "Upload passport for <name>" contains the visible label text
// (WCAG 2.5.3 Label in Name) — both of which a <label htmlFor> trick fails.
function TravellerDocRow({ traveller: t, busy, onUpload }) {
  const fileRef = useRef(null);
  const st = travellerPassportState(t);
  const isReupload = Boolean(t.passportExtractedAt || t.passportRejectedAt);
  const ctaText = isReupload ? "Re-upload passport" : "Upload passport";

  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // same file can be re-picked later
    if (file) onUpload(t, file);
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 10, flexWrap: "wrap", padding: "10px 12px", borderRadius: 10,
      border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{t.fullName}</div>
        {t.relationship && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", textTransform: "capitalize" }}>
            {t.relationship === "self" ? "You" : t.relationship}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{
          background: st.bg, color: st.color, padding: "3px 10px",
          borderRadius: 12, fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
        }}>
          {st.label}
        </span>
        {st.canUpload && (
          <>
            <button
              type="button"
              onClick={() => fileRef.current && fileRef.current.click()}
              disabled={busy}
              aria-label={`${ctaText} for ${t.fullName}`}
              style={{
                ...backBtnStyle, gap: 6, color: "var(--text-primary)",
                opacity: busy ? 0.6 : 1, cursor: busy ? "wait" : "pointer",
              }}
            >
              <Upload size={14} aria-hidden /> {busy ? "Uploading…" : ctaText}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={PORTAL_PASSPORT_ACCEPT}
              disabled={busy}
              tabIndex={-1}
              onChange={onFile}
              aria-label={`Passport file for ${t.fullName}`}
              style={visuallyHiddenInputStyle}
            />
          </>
        )}
      </div>
    </div>
  );
}

function DiagnosticsCard({ token }) {
  const [brands, setBrands] = useState([]); // [{ subBrand }]
  const [selected, setSelected] = useState(""); // active sub-brand
  const [bank, setBank] = useState(null); // { available, questions, subBrand, ... }
  const [history, setHistory] = useState([]);
  const [answers, setAnswers] = useState({});
  const [loadingBrands, setLoadingBrands] = useState(true);
  const [loadingBank, setLoadingBank] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // freshest submission this session
  const [taking, setTaking] = useState(false); // is the form open?

  // 1. Load the brands the customer can take a diagnostic for + their history.
  //    A customer may be served by several brands, so they choose which one.
  const loadBrands = useCallback(async () => {
    setLoadingBrands(true);
    try {
      const [brandsRes, histRes] = await Promise.all([
        portalFetch("/travel/diagnostic-brands", { token }).catch(() => ({ brands: [] })),
        portalFetch("/travel/diagnostics", { token }).catch(() => []),
      ]);
      const list = Array.isArray(brandsRes?.brands) ? brandsRes.brands : [];
      setBrands(list);
      setHistory(Array.isArray(histRes) ? histRes : []);
      // Default to the customer's own primary brand when it's offered, else first.
      const def = brandsRes?.defaultSubBrand;
      const initial = (list.find((b) => b.subBrand === def) || list[0] || {}).subBrand || "";
      setSelected(initial);
    } finally {
      setLoadingBrands(false);
    }
  }, [token]);

  useEffect(() => { loadBrands(); }, [loadBrands]);

  // 2. Load the question bank whenever the selected brand changes.
  const loadBank = useCallback(async (sb) => {
    if (!sb) { setBank(null); return; }
    setLoadingBank(true);
    setAnswers({});
    setResult(null);
    setTaking(false);
    setError(null);
    try {
      const res = await portalFetch(
        `/travel/diagnostic-bank?subBrand=${encodeURIComponent(sb)}`,
        { token },
      ).catch(() => ({ available: false }));
      setBank(res);
    } finally {
      setLoadingBank(false);
    }
  }, [token]);

  useEffect(() => { loadBank(selected); }, [selected, loadBank]);

  const refreshHistory = useCallback(async () => {
    const hist = await portalFetch("/travel/diagnostics", { token }).catch(() => []);
    setHistory(Array.isArray(hist) ? hist : []);
  }, [token]);

  const setSingle = (qid, value) => setAnswers((a) => ({ ...a, [qid]: value }));
  const toggleMulti = (qid, value) =>
    setAnswers((a) => {
      const cur = Array.isArray(a[qid]) ? a[qid] : [];
      return { ...a, [qid]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
    });

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    const unanswered = (bank?.questions || []).filter((q) => {
      const a = answers[q.id];
      return a === undefined || a === "" || (Array.isArray(a) && a.length === 0);
    });
    if (unanswered.length) {
      setError("Please answer every question before submitting.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await portalFetch("/travel/diagnostics", {
        token,
        method: "POST",
        body: { subBrand: selected, answers },
      });
      setResult(res);
      setTaking(false);
      setAnswers({});
      await refreshHistory();
    } catch (err) {
      setError(err.message || "Submission failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // Latest result for the currently-selected brand.
  const latest = result || history.find((h) => h.subBrand === selected) || null;

  return (
    <section style={cardStyle} aria-labelledby="diag-heading">
      <h2 id="diag-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
        <ClipboardCheck size={20} aria-hidden /> Travel Diagnostic
      </h2>
      <p style={{ color: "var(--text-secondary)", marginTop: 6, marginBottom: 0, fontSize: 14 }}>
        Answer a few questions so your advisor can tailor the right package for you.
      </p>

      {loadingBrands ? (
        <p style={{ color: "var(--text-secondary)", margin: "12px 0 0" }}>Loading…</p>
      ) : brands.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", margin: "12px 0 0", fontSize: 14 }}>
          No diagnostic is available for you right now. Check back shortly.
        </p>
      ) : (
        <>
          {/* Brand selector — a customer may be served by several brands. Only
              shown when there's a genuine choice; a single brand auto-selects. */}
          {brands.length > 1 && (
            <label style={{ display: "block", fontSize: 13, fontWeight: 600, marginTop: 14 }}>
              Which programme is this for?
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                aria-label="Select travel programme"
                style={{ ...inputStyle, maxWidth: 360 }}
              >
                {brands.map((b) => (
                  <option key={b.subBrand} value={b.subBrand}>{brandLabel(b.subBrand)}</option>
                ))}
              </select>
            </label>
          )}

          {loadingBank ? (
            <p style={{ color: "var(--text-secondary)", margin: "12px 0 0" }}>Loading questions…</p>
          ) : !bank?.available ? (
            <p style={{ color: "var(--text-secondary)", margin: "12px 0 0", fontSize: 14 }}>
              No diagnostic is available for {brandLabel(selected)} right now.
            </p>
          ) : (
          <>
          {/* Latest result banner */}
          {latest && !taking && (
            <div
              style={{
                marginTop: 14,
                padding: "12px 14px",
                borderRadius: 10,
                background: "rgba(47, 122, 77, 0.08)",
                border: "1px solid rgba(47, 122, 77, 0.25)",
              }}
              role="status"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                <Award size={16} aria-hidden style={{ color: "var(--success-color, #2F7A4D)" }} />
                {latest.classificationLabel || "Completed"}
                {latest.recommendedTier && (
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "rgba(18, 38, 71, 0.08)",
                      textTransform: "capitalize",
                    }}
                  >
                    {latest.recommendedTier} tier
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                Submitted {latest.createdAt ? new Date(latest.createdAt).toLocaleString() : "—"}
                {" · "}Your advisor can see this result.
              </div>
            </div>
          )}

          {error && (
            <div role="alert" style={{
              marginTop: 12, padding: "8px 12px",
              background: "rgba(168, 50, 63, 0.08)",
              color: "var(--danger-color, #A8323F)",
              borderRadius: 8, fontSize: 14,
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <AlertCircle size={16} aria-hidden /> {error}
            </div>
          )}

          {!taking ? (
            <button
              type="button"
              onClick={() => { setTaking(true); setError(null); setResult(null); }}
              style={{
                marginTop: 14,
                padding: "9px 16px",
                background: "var(--primary-color, #122647)",
                color: "white",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <ClipboardCheck size={16} aria-hidden />
              {latest ? "Retake diagnostic" : "Take the diagnostic"}
            </button>
          ) : (
            <form onSubmit={submit} style={{ marginTop: 14, display: "grid", gap: 16 }}>
              {(bank.questions || []).map((q, idx) => (
                <fieldset key={q.id} style={{ border: "none", padding: 0, margin: 0 }}>
                  <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
                    {idx + 1}. {q.text}
                    {q.type === "multi-select" && (
                      <span style={{ fontWeight: 400, color: "var(--text-secondary)", fontSize: 12 }}>
                        {" "}(select all that apply)
                      </span>
                    )}
                  </legend>
                  <div style={{ display: "grid", gap: 6 }}>
                    {(q.options || []).map((o) => {
                      const isMulti = q.type === "multi-select";
                      const checked = isMulti
                        ? Array.isArray(answers[q.id]) && answers[q.id].includes(o.value)
                        : answers[q.id] === o.value;
                      return (
                        <label
                          key={o.value}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "8px 12px",
                            border: `1px solid ${checked ? "var(--primary-color, #122647)" : "var(--border-color, rgba(18,38,71,0.12))"}`,
                            borderRadius: 8,
                            cursor: "pointer",
                            fontSize: 14,
                            background: checked ? "rgba(18, 38, 71, 0.04)" : "transparent",
                          }}
                        >
                          <input
                            type={isMulti ? "checkbox" : "radio"}
                            name={q.id}
                            value={o.value}
                            checked={checked}
                            onChange={() => (isMulti ? toggleMulti(q.id, o.value) : setSingle(q.id, o.value))}
                          />
                          {o.label}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    padding: "9px 16px",
                    background: "var(--primary-color, #122647)",
                    color: "white",
                    border: "none",
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: submitting ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  {submitting ? <Loader2 size={16} className="spin" aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
                  {submitting ? "Submitting…" : "Submit answers"}
                </button>
                <button
                  type="button"
                  onClick={() => { setTaking(false); setError(null); }}
                  disabled={submitting}
                  style={{
                    padding: "9px 16px",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--border-color, rgba(18,38,71,0.12))",
                    borderRadius: 8,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          </>
          )}
        </>
      )}
    </section>
  );
}

function ItinerariesCard({ itineraries, loading, onSelect }) {
  return (
    <section style={cardStyle} aria-labelledby="itin-heading">
      <h2 id="itin-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
        <Plane size={20} aria-hidden /> My Bookings
      </h2>
      {loading ? (
        <p style={{ color: "var(--text-secondary)", margin: "12px 0 0" }}>Loading…</p>
      ) : itineraries.length === 0 ? (
        <p style={{ color: "var(--text-secondary)", margin: "12px 0 0" }}>
          No bookings yet. Once an advisor confirms an itinerary you'll see it here.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 10 }}>
          {itineraries.map((itin) => (
            <li key={itin.id}>
              <button
                type="button"
                onClick={() => onSelect && onSelect(itin.id)}
                aria-label={`View ${itin.destination || "booking"} details`}
                style={{
                  width: "100%", textAlign: "left", cursor: "pointer",
                  padding: 12,
                  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
                  borderRadius: 10,
                  background: "var(--surface-color, #FFFFFF)",
                  color: "var(--text-primary)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <strong>{itin.destination || "(no destination)"}</strong>
                  <span style={{
                    fontSize: 12, padding: "2px 8px", borderRadius: 999,
                    background: "rgba(18, 38, 71, 0.08)", textTransform: "capitalize",
                  }}>
                    {itin.status}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                  {itin.startDate ? new Date(itin.startDate).toLocaleDateString() : "—"}
                  {" → "}
                  {itin.endDate ? new Date(itin.endDate).toLocaleDateString() : "—"}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4 }}>
                  {itin.totalAmount != null ? (
                    <span style={{ fontWeight: 600 }}>{fmtMoney(itin.totalAmount, itin.currency)}</span>
                  ) : <span />}
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--primary-color, #122647)", fontWeight: 600 }}>
                    View details <ChevronRight size={14} aria-hidden />
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Money formatter shared by the bookings list + detail view.
function fmtMoney(amount, currency) {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    maximumFractionDigits: 0,
  }).format(Number(amount));
}

// ─── Booking detail view (opened by clicking a booking row) ──────────

const TRIP_ITEM_ICON = {
  flight: Plane, hotel: Hotel, transfer: Ticket, transport: Ticket,
  activity: Ticket, visa: ShieldCheck, insurance: ShieldCheck,
};

const DECIDABLE_BOOKING_STATUSES = ["draft", "sent", "revised"];

function BookingDetail({ itinerary, token, onChanged, onBack }) {
  const [busy, setBusy] = useState(null); // "accept" | "decline" | null
  const [decideErr, setDecideErr] = useState(null);
  const [declining, setDeclining] = useState(false); // reason form open?
  const [reasonText, setReasonText] = useState("");
  // "What-if" headcount the customer types into the estimate calculator.
  // Empty string = use the advisor's quoted traveler count (pax).
  const [headcount, setHeadcount] = useState("");

  if (!itinerary) {
    return (
      <section style={cardStyle}>
        <button type="button" onClick={onBack} style={backBtnStyle}>
          <ChevronLeft size={16} aria-hidden /> Back to bookings
        </button>
        <p style={{ color: "var(--text-secondary)", marginTop: 12 }}>This booking is no longer available.</p>
      </section>
    );
  }
  const items = Array.isArray(itinerary.items) ? itinerary.items : [];
  const total = itinerary.totalAmount != null ? Number(itinerary.totalAmount) : 0;
  const pax = itinerary.pax && itinerary.pax > 0 ? itinerary.pax : 1;
  // Per-person figure derived from the advisor's quoted group total ÷ pax.
  const perPerson = total / pax;
  // Effective headcount the estimate is computed for: the customer's typed
  // value when valid (≥1), otherwise the advisor's quoted pax.
  const typedCount = parseInt(headcount, 10);
  const estCount = headcount !== "" && Number.isFinite(typedCount) && typedCount > 0 ? typedCount : pax;
  const estTotal = Math.round(perPerson * estCount * 100) / 100;
  const paid = itinerary.advancePaidAmount != null ? Number(itinerary.advancePaidAmount) : 0;
  const balance = Math.max(0, total - paid);
  const status = itinerary.status;
  const canDecide = DECIDABLE_BOOKING_STATUSES.includes(status);
  const isAccepted = ["accepted", "advance_paid", "fully_paid"].includes(status);
  const isDeclined = status === "rejected";

  const decide = async (action, reason) => {
    setBusy(action);
    setDecideErr(null);
    try {
      await portalFetch(`/travel/itineraries/${itinerary.id}/${action}`, {
        token,
        method: "POST",
        body: action === "decline" ? { reason: reason || "" } : {},
      });
      // Refresh the bookings so the status (and this detail view) update.
      if (onChanged) await onChanged();
    } catch (e) {
      setDecideErr(e.message || "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button type="button" onClick={onBack} style={backBtnStyle}>
        <ChevronLeft size={16} aria-hidden /> Back to bookings
      </button>

      <section style={cardStyle} aria-labelledby="booking-detail-heading">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <h2 id="booking-detail-heading" style={{ display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
            <Plane size={20} aria-hidden /> {itinerary.destination || "Your trip"}
          </h2>
          <span style={{
            fontSize: 12, padding: "3px 10px", borderRadius: 999,
            background: "rgba(18, 38, 71, 0.08)", textTransform: "capitalize", fontWeight: 600,
          }}>
            {String(itinerary.status || "").replace(/_/g, " ")}
          </span>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 6 }}>
          {itinerary.startDate ? new Date(itinerary.startDate).toLocaleDateString() : "—"}
          {" → "}
          {itinerary.endDate ? new Date(itinerary.endDate).toLocaleDateString() : "—"}
        </div>
      </section>

      {/* Customer's decision on the offer — accepting/declining is the
          customer's right, not the advisor's. */}
      {canDecide && (
        <section style={cardStyle} aria-labelledby="booking-decision-heading">
          <h3 id="booking-decision-heading" style={{ margin: 0, fontSize: 16 }}>
            {status === "revised" ? "Updated offer — please review" : "Review this offer"}
          </h3>
          <p style={{ color: "var(--text-secondary)", margin: "6px 0 12px", fontSize: 14 }}>
            {status === "revised"
              ? "Your advisor updated this offer based on your feedback. Accept to confirm, or decline if it still isn’t right."
              : "Your advisor has prepared this trip for you. Accept to confirm, or decline if it isn’t right."}
          </p>
          {decideErr && (
            <div role="alert" style={{
              marginBottom: 12, padding: "8px 12px", borderRadius: 8, fontSize: 14,
              background: "rgba(168, 50, 63, 0.08)", color: "var(--danger-color, #A8323F)",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <AlertCircle size={16} aria-hidden /> {decideErr}
            </div>
          )}
          {!declining ? (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => decide("accept")}
                disabled={busy !== null}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "9px 18px", borderRadius: 8, fontWeight: 600, border: "none",
                  background: "var(--success-color, #2F7A4D)", color: "#fff",
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {busy === "accept" ? <Loader2 size={16} className="spin" aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
                {busy === "accept" ? "Accepting…" : "Accept offer"}
              </button>
              <button
                type="button"
                onClick={() => { setDeclining(true); setDecideErr(null); }}
                disabled={busy !== null}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 8,
                  padding: "9px 18px", borderRadius: 8, fontWeight: 600,
                  background: "transparent", color: "var(--danger-color, #A8323F)",
                  border: "1px solid var(--danger-color, #A8323F)",
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                <AlertCircle size={16} aria-hidden /> Decline
              </button>
            </div>
          ) : (
            // Decline confirmation + reason: tell the advisor what to improve.
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ fontSize: 14, fontWeight: 600 }}>
                What would make this offer better for you?
                <textarea
                  value={reasonText}
                  onChange={(e) => setReasonText(e.target.value)}
                  rows={3}
                  placeholder="e.g. Budget is a bit high, prefer an earlier date, want a different hotel…"
                  aria-label="Reason for declining"
                  style={{
                    display: "block", width: "100%", marginTop: 6, padding: "8px 12px",
                    borderRadius: 8, fontSize: 14, boxSizing: "border-box",
                    border: "1px solid var(--border-color, rgba(18,38,71,0.12))",
                    background: "var(--surface-color, #FFFFFF)", color: "var(--text-primary, #1F1B14)",
                    fontFamily: "inherit", resize: "vertical",
                  }}
                />
              </label>
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
                Your feedback goes straight to your advisor so they can revise the plan. (Optional)
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => decide("decline", reasonText.trim())}
                  disabled={busy !== null}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 8,
                    padding: "9px 18px", borderRadius: 8, fontWeight: 600, border: "none",
                    background: "var(--danger-color, #A8323F)", color: "#fff",
                    cursor: busy ? "wait" : "pointer",
                  }}
                >
                  {busy === "decline" ? <Loader2 size={16} className="spin" aria-hidden /> : <AlertCircle size={16} aria-hidden />}
                  {busy === "decline" ? "Submitting…" : "Confirm decline"}
                </button>
                <button
                  type="button"
                  onClick={() => { setDeclining(false); setReasonText(""); setDecideErr(null); }}
                  disabled={busy !== null}
                  style={{
                    padding: "9px 18px", borderRadius: 8, fontWeight: 600,
                    background: "transparent", color: "var(--text-secondary)",
                    border: "1px solid var(--border-color, rgba(18,38,71,0.12))",
                    cursor: "pointer",
                  }}
                >
                  Keep offer
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {isAccepted && (
        <section style={{ ...cardStyle, background: "rgba(47, 122, 77, 0.08)", border: "1px solid rgba(47, 122, 77, 0.25)" }} role="status">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: "var(--success-color, #2F7A4D)" }}>
            <CheckCircle2 size={18} aria-hidden /> You accepted this offer.
          </div>
          <p style={{ color: "var(--text-secondary)", margin: "6px 0 0", fontSize: 14 }}>
            Your advisor will reach out with the next steps and payment details.
          </p>
        </section>
      )}

      {isDeclined && (
        <section style={{ ...cardStyle, background: "rgba(168, 50, 63, 0.06)", border: "1px solid rgba(168, 50, 63, 0.22)" }} role="status">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, color: "var(--danger-color, #A8323F)" }}>
            <AlertCircle size={18} aria-hidden /> You declined this offer.
          </div>
          {itinerary.declineReason && (
            <p style={{ color: "var(--text-primary)", margin: "8px 0 0", fontSize: 14, fontStyle: "italic" }}>
              Your feedback: &ldquo;{itinerary.declineReason}&rdquo;
            </p>
          )}
          <p style={{ color: "var(--text-secondary)", margin: "6px 0 0", fontSize: 14 }}>
            Want to revisit it? Contact your advisor for an updated plan.
          </p>
        </section>
      )}

      <section style={cardStyle} aria-labelledby="booking-items-heading">
        <h3 id="booking-items-heading" style={{ margin: 0, fontSize: 16 }}>Your trip includes</h3>
        {items.length === 0 ? (
          <p style={{ color: "var(--text-secondary)", margin: "12px 0 0", fontSize: 14 }}>
            Itinerary details will appear here once your advisor adds them.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0", display: "grid", gap: 10 }}>
            {items.map((it) => {
              const Icon = TRIP_ITEM_ICON[it.itemType] || Ticket;
              return (
                <li key={it.id} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: 12,
                  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))", borderRadius: 10,
                }}>
                  <Icon size={18} aria-hidden style={{ color: "var(--primary-color, #122647)", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{it.description || it.itemType}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                      {it.itemType}
                    </div>
                  </div>
                  {it.totalPrice != null && (
                    <div style={{ fontWeight: 600 }}>{fmtMoney(it.totalPrice, itinerary.currency)}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section style={cardStyle} aria-labelledby="booking-cost-heading">
        <h3 id="booking-cost-heading" style={{ margin: 0, fontSize: 16 }}>Trip cost</h3>
        <dl style={{ margin: "12px 0 0", display: "grid", gridTemplateColumns: "1fr auto", gap: "8px 16px", fontSize: 14 }}>
          <dt style={{ ...dtStyle, fontWeight: 700, color: "var(--text-primary)" }}>Per person</dt>
          <dd style={{ ...ddStyle, fontWeight: 700, textAlign: "right" }}>{fmtMoney(pax > 1 ? Math.round((total / pax) * 100) / 100 : total, itinerary.currency)}</dd>
          {pax > 1 && (<>
            <dt style={dtStyle}>Group total ({pax} travelers)</dt>
            <dd style={{ ...ddStyle, textAlign: "right" }}>{fmtMoney(total, itinerary.currency)}</dd>
          </>)}
          {paid > 0 && (<>
            <dt style={dtStyle}>Paid so far</dt>
            <dd style={{ ...ddStyle, textAlign: "right", color: "var(--success-color, #2F7A4D)" }}>{fmtMoney(paid, itinerary.currency)}</dd>
            <dt style={dtStyle}>Balance due</dt>
            <dd style={{ ...ddStyle, textAlign: "right", fontWeight: 600 }}>{fmtMoney(balance, itinerary.currency)}</dd>
          </>)}
        </dl>
      </section>

      {/* Per-person estimate calculator — customer types a headcount and sees
          the per-person price multiplied out (overall + per item). */}
      {perPerson > 0 && (
        <section style={cardStyle} aria-labelledby="estimate-heading">
          <h3 id="estimate-heading" style={{ margin: 0, fontSize: 16 }}>Estimate for your group</h3>
          <p style={{ color: "var(--text-secondary)", margin: "6px 0 0", fontSize: 13 }}>
            Per person is <strong>{fmtMoney(perPerson, itinerary.currency)}</strong>. Enter how many
            people are travelling to see the estimated cost.
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "12px 0 0", flexWrap: "wrap" }}>
            <label htmlFor="estimate-headcount" style={{ fontSize: 14, color: "var(--text-primary)" }}>
              Number of people
            </label>
            <input
              id="estimate-headcount"
              type="number"
              min={1}
              inputMode="numeric"
              value={headcount}
              placeholder={String(pax)}
              onChange={(e) => setHeadcount(e.target.value)}
              aria-label="Number of people for the estimate"
              style={{
                width: 90, padding: "8px 10px", fontSize: 14,
                border: "1px solid var(--border-color, rgba(18, 38, 71, 0.2))", borderRadius: 8,
              }}
            />
            {headcount !== "" && (
              <button
                type="button"
                onClick={() => setHeadcount("")}
                style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  color: "var(--primary-color, #122647)", fontSize: 13, textDecoration: "underline",
                }}
              >
                Reset to {pax}
              </button>
            )}
          </div>

          <div style={{
            margin: "14px 0 0", padding: 14, borderRadius: 10,
            background: "var(--subtle-bg, rgba(18, 38, 71, 0.04))",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                {fmtMoney(perPerson, itinerary.currency)} × {estCount} {estCount === 1 ? "person" : "people"}
              </span>
              <span style={{ fontSize: 20, fontWeight: 700, color: "var(--primary-color, #122647)" }} aria-live="polite">
                {fmtMoney(estTotal, itinerary.currency)}
              </span>
            </div>
          </div>

          {items.length > 0 && (
            <dl style={{ margin: "14px 0 0", display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 16px", fontSize: 13 }}>
              {items.map((it) => {
                if (it.totalPrice == null) return null;
                const itemPerPerson = Number(it.totalPrice) / pax;
                const itemEst = Math.round(itemPerPerson * estCount * 100) / 100;
                return (
                  <div key={it.id} style={{ display: "contents" }}>
                    <dt style={dtStyle}>
                      {it.description || it.itemType}
                      <span style={{ color: "var(--text-secondary)", marginLeft: 6 }}>
                        ({fmtMoney(itemPerPerson, itinerary.currency)} pp)
                      </span>
                    </dt>
                    <dd style={{ ...ddStyle, textAlign: "right" }}>{fmtMoney(itemEst, itinerary.currency)}</dd>
                  </div>
                );
              })}
            </dl>
          )}
          <p style={{ color: "var(--text-secondary)", margin: "10px 0 0", fontSize: 12 }}>
            This is an indicative estimate based on the per-person price. Your advisor will confirm the
            final cost for your group.
          </p>
        </section>
      )}
    </>
  );
}

const cardStyle = {
  background: "var(--surface-color, #FFFFFF)",
  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
  borderRadius: 12,
  padding: 20,
};
const portalPrimaryBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  background: "var(--primary-color, #122647)",
  color: "#fff",
  border: "none",
  cursor: "pointer",
};
// Visually hidden but still in the accessibility tree (display:none would
// drop it for screen readers AND RTL label queries).
const visuallyHiddenInputStyle = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0,
};
const dtStyle = { color: "var(--text-secondary)" };
const ddStyle = { margin: 0, color: "var(--text-primary)" };
const iconBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
  borderRadius: 8,
  cursor: "pointer",
};
const backBtnStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
  cursor: "pointer",
  width: "fit-content",
};
