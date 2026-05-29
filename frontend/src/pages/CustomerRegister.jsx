import { useContext, useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CheckCircle2, XCircle } from "lucide-react";
import { AuthContext } from "../App";
import { setAuthToken } from "../utils/api";
import { invalidatePermissionCache } from "../hooks/usePermissions";
import PasswordInput from "../components/PasswordInput";

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
  const { setUser, setToken, setTenant } = useContext(AuthContext);

  const [tenants, setTenants] = useState([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [form, setForm] = useState({
    email: "",
    name: "",
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

  const update = (field) => (e) =>
    setForm({ ...form, [field]: e.target.value });
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
    if (!form.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = "Enter a valid email";
    }
    if (!form.name.trim()) e.name = "Full name is required";
    if (!form.tenantId) e.tenantId = "Select an organization";
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
      const res = await fetch("/api/auth/customer/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          name: form.name.trim(),
          // #646: the global stripDangerous middleware on the backend deletes
          // `tenantId` from every request body. The route accepts the chosen
          // org under `registrationTenantId`, a non-stripped name.
          registrationTenantId: parseInt(form.tenantId, 10),
        }),
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
      // Route based on tenant vertical: wellness tenants → /wellness, others → /dashboard
      const vertical = data?.tenant?.vertical || "generic";
      navigate(vertical === "wellness" ? "/wellness" : "/dashboard");
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
          <Field label="Email" htmlFor="cr-email" error={errors.email}>
            <input
              id="cr-email"
              type="email"
              className="input-field"
              autoComplete="email"
              value={form.email}
              onChange={update("email")}
              disabled={isLoading}
              required
            />
          </Field>

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
            label="Organization"
            htmlFor="cr-tenant"
            error={errors.tenantId}
          >
            <select
              id="cr-tenant"
              className="input-field"
              value={form.tenantId}
              onChange={update("tenantId")}
              disabled={isLoading || tenantsLoading}
              required
            >
              <option value="">
                {tenantsLoading
                  ? "Loading organizations..."
                  : "Select an organization…"}
              </option>
              {tenants.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name}
                </option>
              ))}
            </select>
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
            disabled={isLoading}
            style={{ width: "100%" }}
          >
            {isLoading ? "Creating account…" : "Create account"}
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
            to="/login"
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
