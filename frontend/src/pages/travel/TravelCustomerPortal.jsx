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
import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck, ShieldAlert, LogOut, Plane, User as UserIcon,
  CheckCircle2, AlertCircle, Loader2,
} from "lucide-react";

const PORTAL_TOKEN_KEY = "portalToken";
const PORTAL_CONTACT_KEY = "portalContact";

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
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError(null);
    setLoginLoading(true);
    try {
      const data = await portalFetch("/login", {
        method: "POST",
        body: { email: loginForm.email.trim(), password: loginForm.password },
      });
      localStorage.setItem(PORTAL_TOKEN_KEY, data.token);
      localStorage.setItem(PORTAL_CONTACT_KEY, JSON.stringify(data.contact));
      setToken(data.token);
      setContact(data.contact);
    } catch (err) {
      setLoginError(err.message || "Login failed");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    clearStoredAuth();
    setToken(null);
    setContact(null);
    setLoginForm({ email: "", password: "" });
  };

  if (!token) {
    return (
      <LoginScreen
        form={loginForm}
        setForm={setLoginForm}
        onSubmit={handleLogin}
        error={loginError}
        loading={loginLoading}
      />
    );
  }

  return <Dashboard token={token} contact={contact} onLogout={handleLogout} />;
}

function LoginScreen({ form, setForm, onSubmit, error, loading }) {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      background: "var(--bg-color, #FAF6EE)",
    }}>
      <form
        onSubmit={onSubmit}
        style={{
          width: "100%",
          maxWidth: 420,
          background: "var(--surface-color, #FFFFFF)",
          padding: 32,
          borderRadius: 16,
          boxShadow: "0 4px 24px rgba(18, 38, 71, 0.08)",
          border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
        }}
      >
        <h1 style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 0 }}>
          <Plane size={28} aria-hidden /> Customer Portal
        </h1>
        <p style={{ color: "var(--text-secondary)", marginTop: -4 }}>
          Sign in to see your bookings and verify your identity.
        </p>
        <label style={{ display: "block", fontSize: 14, fontWeight: 600, marginTop: 16 }}>
          Email
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={inputStyle}
            placeholder="ahmed.pilgrim@demo.test"
          />
        </label>
        <label style={{ display: "block", fontSize: 14, fontWeight: 600, marginTop: 12 }}>
          Password
          <input
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            style={inputStyle}
            placeholder="••••••••"
          />
        </label>
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
        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: 16,
            width: "100%",
            padding: "10px 16px",
            background: "var(--primary-color, #122647)",
            color: "white",
            border: "none",
            borderRadius: 8,
            fontWeight: 600,
            cursor: loading ? "wait" : "pointer",
            display: "flex", justifyContent: "center", alignItems: "center", gap: 8,
          }}
        >
          {loading ? <Loader2 size={16} className="spin" aria-hidden /> : null}
          {loading ? "Signing in…" : "Sign in"}
        </button>
        <p style={{ marginTop: 16, fontSize: 13, color: "var(--text-secondary)" }}>
          Demo: <code>ahmed.pilgrim@demo.test</code> / <code>password123</code>
        </p>
      </form>
    </div>
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

function Dashboard({ token, contact, onLogout }) {
  const [kyc, setKyc] = useState(null);
  const [itineraries, setItineraries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [verifyMsg, setVerifyMsg] = useState(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [kycRes, itinRes] = await Promise.all([
        portalFetch("/kyc/status", { token }),
        portalFetch("/travel/itineraries", { token }).catch(() => []),
      ]);
      setKyc(kycRes);
      setItineraries(Array.isArray(itinRes) ? itinRes : []);
    } catch (err) {
      if (err.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }, [token, onLogout]);

  useEffect(() => { loadAll(); }, [loadAll]);

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
    <div style={{ minHeight: "100vh", background: "var(--bg-color, #FAF6EE)" }}>
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 24px",
        background: "var(--surface-color, #FFFFFF)",
        borderBottom: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
        gap: 16,
        flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Plane size={24} aria-hidden style={{ color: "var(--primary-color, #122647)" }} />
          <strong>Travel Customer Portal</strong>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <DigiLockerButton
            verified={verified}
            loading={verifyLoading}
            onClick={handleVerify}
          />
          <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>
            {contact?.name || contact?.email}
          </span>
          <button
            type="button"
            onClick={onLogout}
            style={iconBtnStyle}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={16} aria-hidden />
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24, display: "grid", gap: 16 }}>
        {verifyMsg && (
          <div role="status" style={{
            padding: "10px 14px",
            borderRadius: 10,
            background: verifyMsg.ok
              ? "rgba(47, 122, 77, 0.10)"
              : "rgba(168, 50, 63, 0.10)",
            color: verifyMsg.ok
              ? "var(--success-color, #2F7A4D)"
              : "var(--danger-color, #A8323F)",
            display: "flex", alignItems: "center", gap: 8,
            fontSize: 14,
          }}>
            {verifyMsg.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            {verifyMsg.text}
          </div>
        )}

        <ProfileCard
          contact={contact}
          kyc={kyc}
          loading={loading}
          verifyLoading={verifyLoading}
          onVerify={handleVerify}
        />

        <ItinerariesCard itineraries={itineraries} loading={loading} />
      </main>
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

function ItinerariesCard({ itineraries, loading }) {
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
            <li key={itin.id} style={{
              padding: 12,
              border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
              borderRadius: 10,
              background: "var(--surface-color, #FFFFFF)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <strong>{itin.destination || "(no destination)"}</strong>
                <span style={{
                  fontSize: 12,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "rgba(18, 38, 71, 0.08)",
                  textTransform: "capitalize",
                }}>
                  {itin.status}
                </span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                {itin.startDate ? new Date(itin.startDate).toLocaleDateString() : "—"}
                {" → "}
                {itin.endDate ? new Date(itin.endDate).toLocaleDateString() : "—"}
              </div>
              {itin.totalAmount != null && (
                <div style={{ marginTop: 4, fontWeight: 600 }}>
                  {new Intl.NumberFormat("en-IN", {
                    style: "currency",
                    currency: itin.currency || "INR",
                    maximumFractionDigits: 0,
                  }).format(Number(itin.totalAmount))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const cardStyle = {
  background: "var(--surface-color, #FFFFFF)",
  border: "1px solid var(--border-color, rgba(18, 38, 71, 0.12))",
  borderRadius: 12,
  padding: 20,
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
