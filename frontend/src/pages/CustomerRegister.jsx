import { useContext, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthContext } from '../App';
import { setAuthToken } from '../utils/api';
import { invalidatePermissionCache } from '../hooks/usePermissions';

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
  if (t.vertical === 'wellness') return `${t.name} (Wellness Clinic)`;
  if (t.vertical === 'generic') return `${t.name} (Generic CRM)`;
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

  const [form, setForm] = useState({
    email: '',
    name: '',
    tenantId: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [tenants, setTenants] = useState([]);
  const [tenantsLoading, setTenantsLoading] = useState(true);
  const [tenantsError, setTenantsError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/customer/tenants')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data)) {
          setTenants(data);
        } else {
          setTenantsError('Could not load organizations. Please try again.');
        }
      })
      .catch(() => {
        if (!cancelled) setTenantsError('Could not load organizations. Please try again.');
      })
      .finally(() => {
        if (!cancelled) setTenantsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const update = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const strength = passwordStrength(form.password);
  const strengthLabel =
    strength <= 2 ? 'Weak' : strength === 3 ? 'Fair' : strength === 4 ? 'Good' : 'Strong';
  const strengthColor =
    strength <= 2 ? '#ef4444' : strength === 3 ? '#f59e0b' : '#10b981';

  const validate = () => {
    const e = {};
    if (!form.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      e.email = 'Enter a valid email';
    }
    if (!form.name.trim()) e.name = 'Full name is required';
    if (!form.tenantId) e.tenantId = 'Select an organization';
    if (!form.password || form.password.length < 8) {
      e.password = 'Password must be at least 8 characters';
    } else if (!/[A-Za-z]/.test(form.password)) {
      e.password = 'Password must contain a letter';
    } else if (!/[0-9]/.test(form.password)) {
      e.password = 'Password must contain a number';
    }
    if (form.password !== form.confirmPassword) {
      e.confirmPassword = 'Passwords do not match';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    setSubmitError('');
    if (!validate()) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/customer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: form.email.trim().toLowerCase(),
          password: form.password,
          name: form.name.trim(),
          tenantId: parseInt(form.tenantId, 10),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = String(data?.error || '');
        if (res.status === 409 || /already/i.test(msg)) {
          setErrors((prev) => ({ ...prev, email: 'This email is already registered' }));
        } else if (res.status === 400) {
          setSubmitError(msg || 'Please check your inputs and try again.');
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
      // /portal is the closest read-only landing for a customer — it's the
      // public Knowledge Base + support ticket page. The dashboard isn't a
      // good landing because CUSTOMER userType is blocked from most staff
      // endpoints; landing on /dashboard would render an empty shell.
      navigate('/portal');
    } catch {
      setSubmitError('Server error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '2rem 1rem',
      }}
    >
      <div
        className="glass"
        style={{
          width: '100%',
          maxWidth: 480,
          padding: '2rem',
          borderRadius: 12,
          border: '1px solid var(--border-color)',
        }}
      >
        <h1 style={{ marginBottom: '0.25rem', fontSize: '1.5rem' }}>Create your account</h1>
        <p
          style={{
            color: 'var(--text-secondary)',
            marginBottom: '1.5rem',
            fontSize: '0.875rem',
          }}
        >
          Self-service customer registration. Staff members must be invited by an
          administrator.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <Field label="Email" htmlFor="cr-email" error={errors.email}>
            <input
              id="cr-email"
              type="email"
              className="input-field"
              autoComplete="email"
              value={form.email}
              onChange={update('email')}
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
              onChange={update('name')}
              disabled={isLoading}
              required
            />
          </Field>

          <Field
            label="Organization"
            htmlFor="cr-tenant"
            error={errors.tenantId || tenantsError}
          >
            <select
              id="cr-tenant"
              className="input-field"
              value={form.tenantId}
              onChange={update('tenantId')}
              disabled={isLoading || tenantsLoading || !!tenantsError}
              required
            >
              <option value="">
                {tenantsLoading
                  ? 'Loading organizations…'
                  : tenantsError
                    ? 'Unable to load organizations'
                    : 'Select an organization…'}
              </option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {tenantLabel(t)}
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
            <input
              id="cr-password"
              type="password"
              className="input-field"
              autoComplete="new-password"
              value={form.password}
              onChange={update('password')}
              disabled={isLoading}
              required
            />
            {form.password && (
              <div
                style={{
                  marginTop: '0.4rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                }}
              >
                <div
                  style={{
                    flex: 1,
                    height: 4,
                    background: 'var(--border-color)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: `${(strength / 5) * 100}%`,
                      height: '100%',
                      background: strengthColor,
                      transition: 'width 0.15s, background 0.15s',
                    }}
                  />
                </div>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
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
            <input
              id="cr-confirm"
              type="password"
              className="input-field"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={update('confirmPassword')}
              disabled={isLoading}
              required
            />
          </Field>

          {submitError && (
            <div
              role="alert"
              style={{
                background: 'rgba(239,68,68,0.1)',
                color: '#ef4444',
                padding: '0.6rem 0.75rem',
                borderRadius: 6,
                fontSize: '0.875rem',
                marginBottom: '0.75rem',
              }}
            >
              {submitError}
            </div>
          )}

          <button
            type="submit"
            className="btn-primary"
            disabled={isLoading}
            style={{ width: '100%' }}
          >
            {isLoading ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <div
          style={{
            marginTop: '1rem',
            textAlign: 'center',
            fontSize: '0.875rem',
            color: 'var(--text-secondary)',
          }}
        >
          Already have an account?{' '}
          <Link
            to="/login"
            style={{
              color: 'var(--primary-color, var(--accent-color))',
              textDecoration: 'none',
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
    <div style={{ marginBottom: '0.85rem' }}>
      <label
        htmlFor={htmlFor}
        style={{
          display: 'block',
          fontSize: '0.8rem',
          color: 'var(--text-secondary)',
          marginBottom: '0.25rem',
          fontWeight: 500,
        }}
      >
        {label}
      </label>
      {children}
      {help && !error && (
        <small
          style={{
            display: 'block',
            marginTop: '0.25rem',
            color: 'var(--text-secondary)',
            fontSize: '0.7rem',
          }}
        >
          {help}
        </small>
      )}
      {error && (
        <small
          role="alert"
          style={{
            display: 'block',
            marginTop: '0.25rem',
            color: '#ef4444',
            fontSize: '0.75rem',
          }}
        >
          {error}
        </small>
      )}
    </div>
  );
}
