import React, { useState, useContext, useEffect } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { Mail, Square } from "lucide-react";
import { AuthContext } from "../App";
import { safeNext } from "../utils/safeNext";
import PasswordInput from "../components/PasswordInput";

// SSO providers (Google / Microsoft) hidden for now — pending tenant-level
// SSO config + provider credentials. Flip to true to re-enable.
const SHOW_SSO = false;

const Login = () => {
  // Read URL params up-front so the email field can be pre-filled from the
  // marketing-site handoff (?email=...) instead of the demo default.
  const _initialSearchParams = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const _emailFromUrl = (_initialSearchParams.get("email") || "").trim().toLowerCase();

  const [email, setEmail] = useState(_emailFromUrl || "admin@globussoft.com");
  const [password, setPassword] = useState(_emailFromUrl ? "" : "password123");
  const [error, setError] = useState("");
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotMessage, setForgotMessage] = useState("");
  const [forgotToken, setForgotToken] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);

  // 2FA challenge state
  const [require2FA, setRequire2FA] = useState(false);
  const [tempToken, setTempToken] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [twoFactorBusy, setTwoFactorBusy] = useState(false);

  // "Keep me signed in" — when true, the token is mirrored to localStorage
  // so deep links opened in a new tab don't bounce to /login. Default ON:
  // the primary user pain we're solving is "I'm logged in, someone shares a
  // page link, I click it, I'm punted back to /login because the new tab
  // can't see my session". Users on shared/public devices can opt out by
  // unchecking the box. See utils/api.js setAuthToken for the full
  // sessionStorage-vs-localStorage trade-off.
  const [rememberMe, setRememberMe] = useState(true);

  // Organization picker. The same email can now belong to more than one org
  // (User.email is unique per-tenant, not globally), so login sends the chosen
  // org as `loginTenantId`. Empty = "let the server pick the first match",
  // which keeps single-org emails (incl. the demo quick-logins) working.
  const [orgs, setOrgs] = useState([]);
  const [orgTenantId, setOrgTenantId] = useState("");

  const { setUser, setToken, setTenant } = useContext(AuthContext);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Handoff params from the external Dr. Haror's marketing site:
  //   ?tenantSlug=enhanced-wellness — pre-selects + locks the org dropdown
  //   ?next=/wellness/book-appointment?... — post-login landing path
  // safeNext() rejects external URLs so a hostile ?next= can't redirect off-app.
  const nextParam = searchParams.get("next");
  const tenantSlugParam = searchParams.get("tenantSlug");
  const lockedToTenantSlug = !!tenantSlugParam;

  // Load the public tenant list to populate the Organization dropdown.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/public/tenants")
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setOrgs(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setOrgs([]); });
    return () => { cancelled = true; };
  }, []);

  // When the marketing-site handoff passes ?tenantSlug=, pre-select the
  // dropdown once the list arrives. The select is rendered disabled (below)
  // so the user stays scoped to the clinic they started from.
  useEffect(() => {
    if (!tenantSlugParam || orgs.length === 0) return;
    const match = orgs.find((t) => t.slug === tenantSlugParam);
    if (match) {
      setOrgTenantId((prev) => (prev ? prev : String(match.id)));
    }
  }, [tenantSlugParam, orgs]);

  // Handle SSO redirect callback — server bounces user here with ?sso_token=...&tenant=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get("sso_token");
    const tenantParam = params.get("tenant");
    const ssoErr = params.get("sso_error");

    if (ssoErr) {
      setError(decodeURIComponent(ssoErr));
      // Clean URL so the error doesn't re-fire on remount
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    if (ssoToken) {
      // #343: setToken (in App.jsx) routes through setAuthToken — in-memory
      // + sessionStorage by default. SSO callbacks land on this page in a
      // fresh redirect so there's no checkbox state to read; treat SSO as
      // "Keep me signed in" since users explicitly chose a federated
      // identity provider, expecting persistent sign-in.
      setToken(ssoToken, { remember: true });

      let parsedTenant = null;
      if (tenantParam) {
        try {
          parsedTenant = JSON.parse(decodeURIComponent(tenantParam));
        } catch {
          /* ignore */
        }
      }
      if (parsedTenant && setTenant) {
        setTenant(parsedTenant);
        localStorage.setItem("tenant", JSON.stringify(parsedTenant));
        // Match finalizeLogin: write the body attribute synchronously so the
        // SSO landing page renders under the correct theme + e2e selectors
        // resolve on the first frame.
        const v = parsedTenant.vertical || "generic";
        document.documentElement.setAttribute("data-vertical", v);
        document.body.setAttribute("data-vertical", v);
      }

      // Pull canonical user profile from the server now that we have a token.
      fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${ssoToken}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((profile) => {
          if (profile) setUser(profile);
        })
        .catch(() => {})
        .finally(() => {
          window.history.replaceState(
            {},
            document.title,
            window.location.pathname,
          );
          const verticalDefault =
            parsedTenant?.vertical === "wellness"
              ? "/wellness"
              : parsedTenant?.vertical === "travel"
              ? "/travel"
              : "/dashboard";
          // Honour the ?next= handoff from the external marketing site if it
          // came along on the SSO callback URL. safeNext() rejects external
          // hosts so a hostile ?next= can't redirect off-app.
          navigate(safeNext(nextParam) || verticalDefault);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSsoLogin = (provider) => {
    window.location.href = `/api/sso/${provider}/start`;
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!forgotEmail) {
      setForgotMessage("Please enter your email");
      return;
    }
    setForgotLoading(true);
    setForgotMessage("");
    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: forgotEmail }),
      });
      const data = await response.json();
      if (response.ok) {
        setForgotMessage(data.message);
        if (data.resetToken) setForgotToken(data.resetToken);
      } else {
        setForgotMessage(data.error || "Request failed");
      }
    } catch (err) {
      setForgotMessage("Server error. Ensure backend is running.");
    }
    setForgotLoading(false);
  };

  // Vertical-aware default landing — used when no configured landing is set
  // AND /api/pages/me is unavailable. Without this branch, wellness + travel
  // users land on /home (generic fallback) and see the wrong dashboard.
  // Mirrors the SSO-return branch's intent.
  const verticalDefaultLanding = (vertical) => {
    if (vertical === "wellness") return "/wellness";
    if (vertical === "travel") return "/travel";
    return "/dashboard";
  };

  // Smart landing-page resolution. Order of preference:
  //   1. The configured landingPath on the user's primary role IF it is still
  //      in the user's /api/pages/me list (server-side intersection of catalog
  //      with effective permissions). Stale landingPaths that point at pages
  //      the user can no longer access are skipped — fixes "user logs in and
  //      lands on a 403" after an admin revokes a permission.
  //   2. The first accessible non-/home page from /api/pages/me. Whatever the
  //      role can actually do shows up first — gives a useful landing page for
  //      any custom role without any hardcoded role-string mapping.
  //   3. Vertical-aware default (/wellness | /travel | /dashboard) when
  //      /api/pages/me is unreachable or returns nothing useful. Replaces
  //      the previous /home generic-fallback so vertical tenants land on
  //      their correct surface even in degraded-fetch scenarios.
  const resolveLandingPath = async (data) => {
    // CUSTOMER users (self-service registered via /customer/register) only
    // have access to /portal in the page catalog, which currently renders
    // the legacy "Support & Knowledge Base" page — not a customer
    // dashboard. Route them to /home (the role-aware widget dashboard)
    // which is always accessible and shows their permitted widgets +
    // quick actions instead.
    if (data.user?.role === 'CUSTOMER') {
      return '/home';
    }
    const configuredLanding =
      data.user?.landingPath || data.user?.primaryRole?.landingPath || null;
    const verticalDefault = verticalDefaultLanding(data.tenant?.vertical);
    const vertical = data.tenant?.vertical || "generic";
    // "/dashboard" is the system-wide ADMIN default and the implicit
    // fallback for any role without an explicit landingPath. For non-
    // generic tenants (wellness, travel) it's the wrong surface — those
    // verticals have their own home page. Treat the generic default as
    // "not really configured" so the vertical-default wins; any
    // explicitly-customised non-default path (e.g. /wellness/calendar,
    // /travel/leads) still beats the vertical fallback below.
    const isGenericDefault =
      !configuredLanding || configuredLanding === "/dashboard";
    const effectiveConfigured = isGenericDefault ? null : configuredLanding;
    // Short-circuit: on non-generic verticals with the generic default,
    // route to the vertical landing unconditionally. /api/pages/me is a
    // page-catalog read; vertical landings (/wellness, /travel) aren't
    // catalogued there (they're hardcoded SPA routes), so gating the
    // redirect on accessiblePaths.has(verticalDefault) would always
    // miss and fall through to /dashboard via firstUseful.
    if (isGenericDefault && vertical !== "generic") {
      return verticalDefault;
    }
    try {
      const res = await fetch("/api/pages/me", {
        headers: { Authorization: `Bearer ${data.token}` },
      });
      if (res.ok) {
        const body = await res.json();
        const pages = Array.isArray(body?.pages) ? body.pages : [];
        const accessiblePaths = new Set(pages.map((p) => p.path));
        if (effectiveConfigured && accessiblePaths.has(effectiveConfigured)) {
          return effectiveConfigured;
        }
        const firstUseful = pages.find((p) => p.path !== "/home");
        return firstUseful?.path || verticalDefault;
      }
    } catch {
      // Network failure during resolution — fall through to the safer of
      // (configured landing) or the vertical-aware default below.
    }
    return effectiveConfigured || verticalDefault;
  };

  const finalizeLogin = async (data) => {
    setUser(data.user);
    // Pass the "Keep me signed in" choice through so utils/api.js can
    // mirror to localStorage when enabled (cross-tab deep links work) or
    // explicitly scrub localStorage when disabled (session-only).
    setToken(data.token, { remember: rememberMe });
    if (data.tenant && setTenant) setTenant(data.tenant);
    // Set data-vertical synchronously — the App.jsx useEffect that mirrors
    // tenant.vertical onto the body fires AFTER the render that follows
    // setTenant, so the first frame on /wellness can otherwise read
    // body[data-vertical="generic"]. Route guards + e2e tests that land
    // immediately after login depend on the correct value being present.
    const v = data.tenant?.vertical || "generic";
    document.documentElement.setAttribute("data-vertical", v);
    document.body.setAttribute("data-vertical", v);
    // Honour the ?next= handoff from the marketing site (safeNext rejects
    // external URLs); fall back to the existing role/vertical-aware resolver.
    const target = safeNext(nextParam) || (await resolveLandingPath(data));
    console.warn(`[Login handoff] navigating to="${target}"`);
    // Critical: when the handoff target carries a query string (the
    // marketing-site serviceId/date/time prefill), use a full page reload
    // instead of react-router's navigate(). React batches setToken /
    // setUser / setTenant state updates, so navigate() runs while the
    // outer route guard still sees `token === null` and renders
    // <Navigate to="/login" /> — that re-render strips the query string.
    // window.location.assign forces a fresh page load; the token survives
    // via sessionStorage and user/tenant via localStorage (both written
    // synchronously above).
    const hasHandoff = target.indexOf("?") > -1;
    if (hasHandoff) {
      // Mirror user/tenant to localStorage explicitly so the fresh page
      // load has them on first render (the useEffect that normally does
      // this hasn't fired yet).
      try {
        if (data.user) localStorage.setItem("user", JSON.stringify(data.user));
        if (data.tenant) localStorage.setItem("tenant", JSON.stringify(data.tenant));
      } catch { /* ignore */ }
      window.location.assign(target);
    } else {
      navigate(target);
    }
  };

  const performLogin = async (loginEmail, loginPassword, tenantId) => {
    setError("");
    if (!loginEmail || !loginPassword) {
      setError("Please fill out all required fields");
      return;
    }
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `loginTenantId` (not `tenantId` — that's stripped server-side) scopes
        // the lookup to the chosen org. Omitted when no org is selected.
        body: JSON.stringify({
          email: loginEmail,
          password: loginPassword,
          ...(tenantId ? { loginTenantId: Number(tenantId) } : {}),
        }),
      });

      const data = await response.json();

      if (response.ok) {
        if (data.requires2FA && data.tempToken) {
          setRequire2FA(true);
          setTempToken(data.tempToken);
          return;
        }
        finalizeLogin(data);
      } else {
        setError(data.error || "Login failed");
      }
    } catch (err) {
      setError("Server error. Ensure backend is running.");
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    performLogin(email, password, orgTenantId);
  };

  const quickLogin = (qEmail, qPassword) => {
    setEmail(qEmail);
    setPassword(qPassword);
    performLogin(qEmail, qPassword);
  };

  const handleVerify2FA = async (e) => {
    e.preventDefault();
    setError("");
    if (!twoFactorCode || twoFactorCode.length < 6) {
      setError(
        "Enter the 6-digit code from your authenticator app (or an 8-char backup code).",
      );
      return;
    }
    setTwoFactorBusy(true);
    try {
      const response = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tempToken, code: twoFactorCode }),
      });
      const data = await response.json();
      if (response.ok) {
        finalizeLogin(data);
      } else {
        setError(data.error || "2FA verification failed");
      }
    } catch (err) {
      setError("Server error during 2FA verification.");
    }
    setTwoFactorBusy(false);
  };

  const cancel2FA = () => {
    setRequire2FA(false);
    setTempToken("");
    setTwoFactorCode("");
    setError("");
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
      }}
    >
      <div
        className="card glass"
        style={{ width: "100%", maxWidth: "400px", padding: "2rem" }}
      >
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <h2 style={{ fontSize: "1.5rem", fontWeight: "bold" }}>
            Globussoft CRM
          </h2>
          <p style={{ color: "var(--text-secondary)", marginTop: "0.5rem" }}>
            {require2FA
              ? "Two-factor verification required"
              : "Sign in to your account"}
          </p>
        </div>

        {error && (
          <div
            style={{
              backgroundColor: "var(--danger-color)",
              color: "white",
              padding: "0.75rem",
              borderRadius: "8px",
              marginBottom: "1rem",
              fontSize: "0.875rem",
            }}
          >
            {error}
          </div>
        )}

        {require2FA && (
          <form onSubmit={handleVerify2FA}>
            <div style={{ marginBottom: "1rem" }}>
              <label
                style={{
                  display: "block",
                  marginBottom: "0.5rem",
                  fontSize: "0.875rem",
                  color: "var(--text-secondary)",
                }}
              >
                Enter the 6-digit code from your authenticator app
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={8}
                className="input-field"
                placeholder="123456"
                value={twoFactorCode}
                onChange={(e) =>
                  setTwoFactorCode(
                    e.target.value.replace(/[^0-9A-Za-z]/g, "").toUpperCase(),
                  )
                }
                autoFocus
                style={{
                  letterSpacing: "6px",
                  textAlign: "center",
                  fontSize: "1.2rem",
                }}
              />
              <p
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.75rem",
                  color: "var(--text-secondary)",
                }}
              >
                Don't have your phone? Use one of your 8-character backup codes.
              </p>
            </div>
            <button
              type="submit"
              className="btn-primary"
              style={{ width: "100%" }}
              disabled={twoFactorBusy}
            >
              {twoFactorBusy ? "Verifying..." : "Verify"}
            </button>
            <button
              type="button"
              onClick={cancel2FA}
              style={{
                width: "100%",
                marginTop: "0.5rem",
                background: "none",
                border: "none",
                color: "var(--text-secondary)",
                cursor: "pointer",
                fontSize: "0.85rem",
              }}
            >
              Cancel and sign in as another user
            </button>
          </form>
        )}

        {!require2FA && (
          <>
            <form onSubmit={handleLogin}>
              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Organization
                </label>
                <select
                  className="input-field"
                  value={orgTenantId}
                  onChange={(e) => setOrgTenantId(e.target.value)}
                  disabled={lockedToTenantSlug}
                  title={lockedToTenantSlug ? "Scoped by the booking link you arrived from" : undefined}
                >
                  <option value="">All organizations</option>
                  {orgs.map((o) => (
                    <option key={o.id} value={String(o.id)}>{o.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Email
                </label>
                <input
                  type="email"
                  className="input-field"
                  placeholder="admin@globussoft.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div style={{ marginBottom: "1rem" }}>
                <label
                  style={{
                    display: "block",
                    marginBottom: "0.5rem",
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                  }}
                >
                  Password
                </label>
                <PasswordInput
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  marginBottom: "1.5rem",
                  fontSize: "0.875rem",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  style={{
                    accentColor: "var(--primary-color, var(--accent-color))",
                  }}
                />
                <span>Keep me signed in on this device</span>
              </label>
              <button
                type="submit"
                className="btn-primary"
                style={{ width: "100%" }}
              >
                Sign In
              </button>
            </form>

            {SHOW_SSO && (
            <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                margin: "1.25rem 0 1rem",
              }}
            >
              <div
                style={{
                  flex: 1,
                  height: "1px",
                  background: "var(--border-color)",
                }}
              />
              <span
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.75rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                or continue with
              </span>
              <div
                style={{
                  flex: 1,
                  height: "1px",
                  background: "var(--border-color)",
                }}
              />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <button
                type="button"
                onClick={() => handleSsoLogin("google")}
                className="glass"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                  width: "100%",
                  padding: "0.65rem 1rem",
                  borderRadius: "8px",
                  border: "1px solid var(--border-color)",
                  background: "rgba(255,255,255,0.06)",
                  backdropFilter: "blur(8px)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                <Mail size={16} />
                <span>Sign in with Google</span>
              </button>
              <button
                type="button"
                onClick={() => handleSsoLogin("microsoft")}
                className="glass"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.5rem",
                  width: "100%",
                  padding: "0.65rem 1rem",
                  borderRadius: "8px",
                  border: "1px solid var(--border-color)",
                  background: "rgba(255,255,255,0.06)",
                  backdropFilter: "blur(8px)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: 500,
                }}
              >
                <Square size={16} />
                <span>Sign in with Microsoft</span>
              </button>
            </div>
            </>
            )}

            <div style={{ marginTop: "1rem", textAlign: "center" }}>
              <button
                onClick={() => {
                  setShowForgot(!showForgot);
                  setForgotMessage("");
                  setForgotToken("");
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--accent-color)",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                  fontWeight: "500",
                }}
              >
                Forgot Password?
              </button>
            </div>

            {showForgot && (
              <div
                style={{
                  marginTop: "1rem",
                  padding: "1rem",
                  borderRadius: "8px",
                  border: "1px solid var(--border-color)",
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <p
                  style={{
                    fontSize: "0.875rem",
                    color: "var(--text-secondary)",
                    marginBottom: "0.75rem",
                  }}
                >
                  Enter your email to generate a password reset token.
                </p>
                <form onSubmit={handleForgotPassword}>
                  <input
                    type="email"
                    className="input-field"
                    placeholder="Your email address"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    style={{ marginBottom: "0.75rem" }}
                  />
                  <button
                    type="submit"
                    className="btn-primary"
                    style={{ width: "100%" }}
                    disabled={forgotLoading}
                  >
                    {forgotLoading ? "Sending..." : "Reset Password"}
                  </button>
                </form>
                {forgotMessage && (
                  <p
                    style={{
                      marginTop: "0.75rem",
                      fontSize: "0.8rem",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {forgotMessage}
                  </p>
                )}
                {forgotToken && (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      padding: "0.5rem",
                      background: "rgba(16,185,129,0.1)",
                      borderRadius: "6px",
                      fontSize: "0.75rem",
                      wordBreak: "break-all",
                    }}
                  >
                    <strong style={{ color: "var(--text-primary)" }}>
                      Reset Token:
                    </strong>
                    <span style={{ color: "#10b981", marginLeft: "0.5rem" }}>
                      {forgotToken}
                    </span>
                    <p
                      style={{
                        margin: "0.25rem 0 0",
                        color: "var(--text-secondary)",
                      }}
                    >
                      In production, this would be emailed. Use this token with
                      the reset-password API.
                    </p>
                  </div>
                )}
              </div>
            )}

            <QuickLoginSection
              title="Generic CRM"
              accounts={[
                {
                  label: "Admin",
                  email: "admin@globussoft.com",
                  color: "#10b981",
                },
                {
                  label: "Manager",
                  email: "manager@crm.com",
                  color: "#f59e0b",
                },
                { label: "User", email: "user@crm.com", color: "#3b82f6" },
              ]}
              onLogin={quickLogin}
            />

            <QuickLoginSection
              title="Enhanced Wellness — Demo"
              accounts={[
                {
                  label: "Owner (Rishu)",
                  email: "rishu@enhancedwellness.in",
                  color: "#a855f7",
                },
                {
                  label: "Demo Admin",
                  email: "admin@wellness.demo",
                  color: "#a855f7",
                },
                {
                  label: "Demo User",
                  email: "user@wellness.demo",
                  color: "#ec4899",
                },
              ]}
              onLogin={quickLogin}
            />

            <QuickLoginSection
              title="Travel Stall — Demo"
              columns={3}
              accounts={[
                {
                  label: "Owner (Yasin)",
                  email: "yasin@travelstall.in",
                  color: "#a855f7",
                },
                {
                  label: "Demo Admin",
                  email: "admin@travelstall.demo",
                  color: "#a855f7",
                },
                {
                  label: "TMC Operator",
                  email: "tmc-ops@travelstall.demo",
                  color: "#f59e0b",
                },
                {
                  label: "RFU Advisor",
                  email: "rfu-advisor@travelstall.demo",
                  color: "#10b981",
                },
                {
                  label: "Telecaller",
                  email: "telecaller@travelstall.demo",
                  color: "#3b82f6",
                },
              ]}
              onLogin={quickLogin}
              extraCell={
                /* Travel Customer Portal — end-user (Contact) login lives on
                   a separate route + uses /api/portal/login (PORTAL JWT),
                   distinct from staff /api/auth/login. Rendered as a Link
                   styled to match the staff quick-login buttons so it slots
                   neatly into the otherwise-empty 6th grid cell on row 2
                   (3-column layout, 5 staff buttons + 1 portal link). */
                <Link
                  to="/travel/portal"
                  title="Open Travel Customer Portal — ahmed.pilgrim@demo.test / password123"
                  style={{
                    padding: "0.55rem 0.45rem",
                    borderRadius: "8px",
                    border: "1px solid rgba(200, 154, 78, 0.45)",
                    background: "rgba(200, 154, 78, 0.10)",
                    textDecoration: "none",
                    transition: "all 0.15s",
                    minWidth: 0,
                    display: "block",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(200, 154, 78, 0.22)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(200, 154, 78, 0.10)";
                  }}
                >
                  <div
                    style={{
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      color: "#C89A4E",
                      textTransform: "uppercase",
                      marginBottom: "0.15rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    Customer Portal
                  </div>
                  <div
                    style={{
                      fontSize: "0.62rem",
                      color: "var(--text-secondary)",
                      fontFamily: "monospace",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    ahmed.pilgrim@demo.test
                  </div>
                </Link>
              }
            />

            <div
              style={{
                marginTop: "1rem",
                textAlign: "center",
                fontSize: "0.875rem",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>
                Don't have an account?{" "}
              </span>
              <Link
                to="/signup"
                style={{
                  color: "var(--primary-color)",
                  textDecoration: "none",
                  fontWeight: "500",
                }}
              >
                Sign up
              </Link>
            </div>
            <div
              style={{
                marginTop: "0.5rem",
                textAlign: "center",
                fontSize: "0.8rem",
              }}
            >
              <span style={{ color: "var(--text-secondary)" }}>
                Are you a customer?{" "}
              </span>
              <Link
                to="/customer/register"
                style={{
                  color: "var(--primary-color, var(--accent-color))",
                  textDecoration: "none",
                  fontWeight: "500",
                }}
              >
                Create a customer account
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

function QuickLoginSection({ title, accounts, onLogin, columns, extraCell }) {
  // `columns` lets a caller cap the grid width so a 5-account section
  // doesn't squish into 5 cramped buttons in one row. When omitted,
  // each account gets its own column (back-compat with the 3-account
  // Generic + Wellness sections). The Travel Stall section passes
  // columns={3} so its 5 staff buttons wrap to a 3+2 layout.
  // `extraCell` renders one extra grid item after the accounts — used
  // by the Travel Stall section to slot a Customer-Portal link into
  // the otherwise-empty trailing cell on row 2, so the dashed callout
  // doesn't need its own block below.
  const cols = columns || accounts.length;
  return (
    <div style={{ marginTop: "1.25rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          marginBottom: "0.5rem",
        }}
      >
        <div
          style={{ flex: 1, height: "1px", background: "var(--border-color)" }}
        />
        <span
          style={{
            color: "var(--text-secondary)",
            fontSize: "0.7rem",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {title} — click to log in
        </span>
        <div
          style={{ flex: 1, height: "1px", background: "var(--border-color)" }}
        />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: "0.4rem",
        }}
      >
        {accounts.map((a) => {
          const colorRgb =
            a.color === "#10b981"
              ? "16,185,129"
              : a.color === "#3b82f6"
                ? "59,130,246"
                : a.color === "#f59e0b"
                  ? "245,158,11"
                  : a.color === "#a855f7"
                    ? "168,85,247"
                    : a.color === "#ec4899"
                      ? "236,72,153"
                      : "100,100,100";
          return (
            <button
              key={a.email}
              type="button"
              onClick={() => onLogin(a.email, "password123")}
              style={{
                padding: "0.55rem 0.45rem",
                borderRadius: "8px",
                border: `1px solid rgba(${colorRgb}, 0.3)`,
                background: `rgba(${colorRgb}, 0.08)`,
                cursor: "pointer",
                textAlign: "left",
                transition: "all 0.15s",
                minWidth: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `rgba(${colorRgb}, 0.18)`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = `rgba(${colorRgb}, 0.08)`;
              }}
              title={`Log in as ${a.email}`}
            >
              <div
                style={{
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  color: a.color,
                  textTransform: "uppercase",
                  marginBottom: "0.15rem",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {a.label}
              </div>
              <div
                style={{
                  fontSize: "0.62rem",
                  color: "var(--text-secondary)",
                  fontFamily: "monospace",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {a.email}
              </div>
            </button>
          );
        })}
        {extraCell}
      </div>
    </div>
  );
}

export default Login;
