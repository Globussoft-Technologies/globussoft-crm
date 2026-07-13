import { useContext, useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import { AuthContext } from "../App";
import { setAuthToken } from "../utils/api";
import { invalidatePermissionCache } from "../hooks/usePermissions";
import { safeNext } from "../utils/safeNext";
import PasswordInput from "../components/PasswordInput";
import ContactVerificationField from "../components/ContactVerificationField";

// Self-service customer registration page (public, no auth required).
// Backend handler at POST /api/auth/customer/register creates a User row with
// userType='CUSTOMER' and assigns the tenant's system CUSTOMER role. CUSTOMER
// users are blocked from staff endpoints by middleware/blockCustomers.js.
//
// IMPORTANT: customer registration here is a STAFF-scoped concept — it creates
// a User row. The wellness patient portal (OTP, phone-only) is a separate auth
// flow at /wellness/portal and unrelated to this page.
//
// Tenant list is fetched from GET /api/auth/customer/tenants (public). New
// orgs created via /api/auth/signup appear automatically once active.

function tenantLabel(t) {
  if (t.vertical === "wellness") return `${t.name} (Wellness Clinic)`;
  if (t.vertical === "travel") return `${t.name} (Travel Agency)`;
  if (t.vertical === "generic") return `${t.name} (Generic CRM)`;
  return t.name;
}

function passwordStrength(p) {
  let s = 0;
  if (p.length >= 8) s += 1;
  if (/[A-Z]/.test(p)) s += 1;
  if (/[a-z]/.test(p)) s += 1;
  if (/[0-9]/.test(p)) s += 1;
  if (/[^A-Za-z0-9]/.test(p)) s += 1;
  return s;
}

export default function CustomerRegister() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setUser, setToken, setTenant } = useContext(AuthContext);

  // Handoff params from the external Dr. Haror's marketing site:
  //   ?tenantSlug=enhanced-wellness — pre-selects + locks the org dropdown
  //   ?next=/wellness/book-appointment?... — post-register landing path
  //   ?name=...  + ?email=... — pre-fills the corresponding fields so users
  //                              don't re-type what they already entered on
  //                              the marketing site.
  // safeNext() rejects external URLs so a hostile ?next= can't redirect off-app.
  const nextParam = searchParams.get("next");
  const tenantSlugParam = searchParams.get("tenantSlug");
  const lockedToTenantSlug = !!tenantSlugParam;
  const initialEmail = (searchParams.get("email") || "").trim().toLowerCase();
  const initialName = (searchParams.get("name") || "").trim();

  const [tenants, setTenants] = useState([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  // Contact verification gate — null until the customer verifies their email or phone.
  const [verificationToken, setVerificationToken] = useState(null);
  const [verifiedContact, setVerifiedContact] = useState(null); // { type: 'email'|'phone', value }
  const [form, setForm] = useState({
    email: initialEmail,
    name: initialName,
    organization: "",
    tenantId: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // Fetch tenants from backend
  useEffect(() => {
    const loadTenants = async () => {
      try {
        const res = await fetch("/api/auth/public/tenants");
        const data = await res.json();
        setTenants(data || []);
      } catch (err) {
        console.error("Failed to load tenants:", err);
        setTenants([]);
      } finally {
        setTenantsLoading(false);
      }
    };
    loadTenants();
  }, []);

  // Pre-select the locked tenant once the list arrives. Done in an effect (not
  // initial state) because the tenant list is fetched asynchronously.
  useEffect(() => {
    if (!tenantSlugParam || tenants.length === 0) return;
    const match = tenants.find((t) => t.slug === tenantSlugParam);
    if (match) {
      setForm((prev) =>
        prev.tenantId
          ? prev
          : { ...prev, tenantId: String(match.id), organization: match.name }
      );
    }
  }, [tenantSlugParam, tenants]);

  const update = (field) => (e) =>
    setForm({ ...form, [field]: e.target.value });

  const normalizeOrg = (s) => s.trim().toLowerCase().replace(/\s+/g, "");

  const handleOrganizationChange = (e) => {
    const text = e.target.value;
    const match = tenants.find(
      (t) => normalizeOrg(t.name) === normalizeOrg(text)
    );
    setForm((prev) => ({
      ...prev,
      organization: text,
      tenantId: match ? String(match.id) : "",
    }));
  };
  const strength = passwordStrength(form.password);
  const strengthLabel =
    strength <= 2
      ? "Weak"
      : strength === 3
        ? "Fair"
        : strength === 4
          ? "Good"
          : "Strong";
  const strengthColor =
    strength <= 2 ? "#ef4444" : strength === 3 ? "#f59e0b" : "#10b981";

  const validate = () => {
    const e = {};
    // Email is always required — it's the account login credential and a required
    // DB field. When email verification was used the field is already populated
    // from the verified contact; when phone verification was used the user enters
    // it separately via the extra email input shown below the verification widget.
    if (!form.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = "Enter a valid email";
    }
    if (!form.name.trim()) e.name = "Full name is required";
    if (!form.organization.trim()) {
      e.organization = "Organization name is required";
    } else if (!form.tenantId) {
      e.organization = "Organization not found. Please check the name you entered.";
    }
    if (!form.password || form.password.length < 8) {
      e.password = "Password must be at least 8 characters";
    } else if (!/[A-Za-z]/.test(form.password)) {
      e.password = "Password must contain a letter";
    } else if (!/[0-9]/.test(form.password)) {
      e.password = "Password must contain a number";
    }
    if (form.password !== form.confirmPassword) {
      e.confirmPassword = "Passwords do not match";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    setSubmitError("");
    if (!validate()) return;
    setIsLoading(true);
    try {
      // Travel orgs use the Customer Portal registration API (Contact-based),
      // NOT the staff User registration. A travel customer belongs in the
      // Travel Customer Portal (/travel/portal) — the same surface as the
      // seeded ahmed.pilgrim@demo.test demo customer — so we register them as
      // a portal Contact and sign them straight in there.
      const selectedTenant = tenants.find((t) => String(t.id) === String(form.tenantId));
      if (selectedTenant?.vertical === "travel") {
        const portalPayload = {
          email: form.email.trim().toLowerCase(),
          password: form.password,
          name: form.name.trim(),
          registrationTenantId: parseInt(form.tenantId, 10),
          verificationToken,
        };
        if (verifiedContact?.type === "phone") {
          portalPayload.phone = verifiedContact.value;
        }
        const pres = await fetch("/api/portal/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(portalPayload),
        });
        const pdata = await pres.json().catch(() => ({}));
        if (!pres.ok) {
          const msg = String(pdata?.error || "");
          if (pres.status === 409 || /already/i.test(msg)) {
            setErrors((prev) => ({ ...prev, email: "This email is already registered" }));
          } else if (pres.status === 400) {
            setSubmitError(msg || "Please check your inputs and try again.");
          } else {
            setSubmitError(msg || `Registration failed (${pres.status})`);
          }
          return;
        }
        // Store the portal session (same keys the portal page reads) and land
        // the new customer directly in the Travel Customer Portal.
        if (pdata?.token) localStorage.setItem("portalToken", pdata.token);
        if (pdata?.contact) localStorage.setItem("portalContact", JSON.stringify(pdata.contact));
        window.location.assign("/travel/portal");
        return;
      }

      const customerPayload = {
        email: form.email.trim().toLowerCase(),
        password: form.password,
        name: form.name.trim(),
        // #646: the global stripDangerous middleware on the backend deletes
        // `tenantId` from every request body. The route accepts the chosen
        // org under `registrationTenantId`, a non-stripped name.
        registrationTenantId: parseInt(form.tenantId, 10),
        verificationToken,
      };
      if (verifiedContact?.type === "phone") {
        customerPayload.phone = verifiedContact.value;
      }
      const res = await fetch("/api/auth/customer/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(customerPayload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(data?.error || "");
        if (res.status === 409 || /already/i.test(msg)) {
          setErrors((prev) => ({
            ...prev,
            email: "This email is already registered",
          }));
        } else if (res.status === 400) {
          setSubmitError(msg || "Please check your inputs and try again.");
        } else {
          setSubmitError(msg || `Registration failed (${res.status})`);
        }
        return;
      }
      // Auto-login. Backend returns { token, user, tenant }. Mirror the SSO
      // and login flow: setAuthToken puts it in the in-memory holder +
      // sessionStorage; setUser/setTenant write through to AuthContext.
      if (data?.token) {
        setAuthToken(data.token);
        setToken(data.token);
      }
      if (data?.user) setUser(data.user);
      if (data?.tenant) setTenant(data.tenant);
      invalidatePermissionCache();
      // Honour the ?next= param if it's a safe in-app path (e.g. the marketing
      // site's /wellness/book-appointment handoff). Falls back to the
      // vertical-aware default when next is missing or rejected by safeNext.
      const vertical = data?.tenant?.vertical || "generic";
      const verticalDefault = vertical === "wellness" ? "/wellness" : "/dashboard";
      const safeNextValue = safeNext(nextParam);
      const target = safeNextValue || verticalDefault;
      console.warn(
        `[CustomerRegister handoff] nextParam="${nextParam}" → safeNext="${safeNextValue}" → navigating to="${target}"`
      );
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
        try {
          if (data.user) localStorage.setItem("user", JSON.stringify(data.user));
          if (data.tenant) localStorage.setItem("tenant", JSON.stringify(data.tenant));
        } catch { /* ignore */ }
        window.location.assign(target);
      } else {
        navigate(target);
      }
    } catch {
      setSubmitError("Server error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "2rem 1rem",
      }}
    >
      <div
        className="glass"
        style={{
          width: "100%",
          maxWidth: 480,
          padding: "2rem",
          borderRadius: 12,
          border: "1px solid var(--border-color)",
        }}
      >
        <h1 style={{ marginBottom: "0.25rem", fontSize: "1.5rem" }}>
          Create your account
        </h1>
        <p
          style={{
            color: "var(--text-secondary)",
            marginBottom: "1.5rem",
            fontSize: "0.875rem",
          }}
        >
          Self-service customer registration. Staff members must be invited by
          an administrator.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <div style={{ marginBottom: "1rem" }}>
            <ContactVerificationField
              purpose="customer-register"
              onVerifiedChange={setVerificationToken}
              onContactChange={(contact) => {
                setVerifiedContact(contact);
                if (contact?.type === "email") setForm((prev) => ({ ...prev, email: contact.value }));
              }}
              inputClassName="input-field"
              disabled={isLoading}
            />
            {verifiedContact?.type === "phone" && (
              <div style={{ marginTop: "0.75rem" }}>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: "0.25rem", fontWeight: 500 }}>
                  Account Email
                </label>
                <input
                  type="email"
                  className="input-field"
                  placeholder="name@company.com"
                  value={form.email}
                  onChange={update("email")}
                  disabled={isLoading}
                  required
                  autoComplete="email"
                />
                <small style={{ display: "block", marginTop: "0.25rem", color: "var(--text-secondary)", fontSize: "0.7rem" }}>
                  Your email is used for account login and notifications.
                </small>
              </div>
            )}
            {errors.email && (
              <div style={{ color: "var(--danger-color, #ef4444)", fontSize: "0.78rem", marginTop: 4 }}>{errors.email}</div>
            )}
          </div>

          <Field label="Full name" htmlFor="cr-name" error={errors.name}>
            <input
              id="cr-name"
              type="text"
              className="input-field"
              autoComplete="name"
              value={form.name}
              onChange={update("name")}
              disabled={isLoading}
              required
            />
          </Field>

          <Field
            label={lockedToTenantSlug ? "Booking for" : "Organization"}
            htmlFor="cr-organization"
            error={errors.organization}
            help={
              lockedToTenantSlug
                ? "You started this booking from a specific clinic — registration is scoped to it."
                : undefined
            }
          >
            <input
              id="cr-organization"
              type="text"
              className="input-field"
              autoComplete="organization"
              placeholder={tenantsLoading ? "Loading…" : "Enter your organization name"}
              value={form.organization}
              onChange={handleOrganizationChange}
              disabled={isLoading || lockedToTenantSlug}
              required
            />
          </Field>

          <Field
            label="Password"
            htmlFor="cr-password"
            error={errors.password}
            help="At least 8 characters, including a letter and a number."
          >
            <PasswordInput
              id="cr-password"
              autoComplete="new-password"
              value={form.password}
              onChange={update("password")}
              disabled={isLoading}
              required
            />
            {form.password && (
              <div
                style={{
                  marginTop: "0.4rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <div
                  style={{
                    flex: 1,
                    height: 4,
                    background: "var(--border-color)",
                    borderRadius: 2,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${(strength / 5) * 100}%`,
                      height: "100%",
                      background: strengthColor,
                      transition: "width 0.15s, background 0.15s",
                    }}
                  />
                </div>
                <span
                  style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}
                >
                  {strengthLabel}
                </span>
              </div>
            )}
          </Field>

          <Field
            label="Confirm password"
            htmlFor="cr-confirm"
            error={errors.confirmPassword}
          >
            <PasswordInput
              id="cr-confirm"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={update("confirmPassword")}
              disabled={isLoading}
              required
            />
            {form.confirmPassword && (
              <div
                style={{
                  marginTop: "0.4rem",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.75rem",
                  color:
                    form.password === form.confirmPassword
                      ? "#10b981"
                      : "#ef4444",
                }}
              >
                {form.password === form.confirmPassword ? (
                  <>
                    <CheckCircle2 size={14} aria-hidden />
                    <span>Passwords match</span>
                  </>
                ) : (
                  <>
                    <XCircle size={14} aria-hidden />
                    <span>Passwords don't match</span>
                  </>
                )}
              </div>
            )}
          </Field>

          {submitError && (
            <div
              role="alert"
              style={{
                background: "rgba(239,68,68,0.1)",
                color: "#ef4444",
                padding: "0.6rem 0.75rem",
                borderRadius: 6,
                fontSize: "0.875rem",
                marginBottom: "0.75rem",
              }}
            >
              {submitError}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary"
            disabled={isLoading || !verificationToken}
            style={{ width: "100%", opacity: !verificationToken ? 0.6 : 1 }}
          >
            {isLoading ? "Creating account…" : !verificationToken ? "Verify your email or phone to continue" : "Create account"}
          </button>
        </form>

        <div
          style={{
            marginTop: "1rem",
            textAlign: "center",
            fontSize: "0.875rem",
            color: "var(--text-secondary)",
          }}
        >
          Already have an account?{" "}
          <Link
            // Preserve the marketing-site handoff (?tenantSlug=, ?next=,
            // ?name=, ?email=, ?phone=) when bouncing to /login so users
            // who already have an account land on the same prefilled
            // Book Appointment page after signing in.
            to={`/login${typeof window !== "undefined" ? window.location.search : ""}`}
            style={{
              color: "var(--primary-color, var(--accent-color))",
              textDecoration: "none",
              fontWeight: 500,
            }}
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

function Field({ label, htmlFor, error, help, children }) {
  return (
    <div style={{ marginBottom: "0.85rem" }}>
      <label
        htmlFor={htmlFor}
        style={{
          display: "block",
          fontSize: "0.8rem",
          color: "var(--text-secondary)",
          marginBottom: "0.25rem",
          fontWeight: 500,
        }}
      >
        {label}
      </label>
      {children}
      {help && !error && (
        <small
          style={{
            display: "block",
            marginTop: "0.25rem",
            color: "var(--text-secondary)",
            fontSize: "0.7rem",
          }}
        >
          {help}
        </small>
      )}
      {error && (
        <small
          role="alert"
          style={{
            display: "block",
            marginTop: "0.25rem",
            color: "#ef4444",
            fontSize: "0.75rem",
          }}
        >
          {error}
        </small>
      )}
    </div>
  );
}
