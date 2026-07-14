// Password reset page — the landing for the link emailed by
// POST /api/auth/forgot-password. Reads ?token=, collects a new password, and
// POSTs { token, newPassword } to /api/auth/reset-password (public endpoint).
//
// Uses a plain fetch (NOT fetchApi) because the user is unauthenticated here —
// fetchApi would attach a stale Bearer / redirect to /login on 401.
import { useContext, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import PasswordInput from '../components/PasswordInput';
import { AuthContext } from '../App';

export default function ResetPassword() {
  const navigate = useNavigate();
  const { setToken } = useContext(AuthContext);
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!token) { setError('Missing or invalid reset link. Request a new one from the login page.'); return; }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setError('Password must be at least 8 characters and include a letter and a number.');
      return;
    }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSubmitting(true);
    try {
      const resp = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || 'Could not reset your password. The link may have expired.');

      // Clear any stale session so the /login route guard doesn't see an
      // active token and auto-redirect the user away from the login page.
      setToken(null); // clears React state + in-memory holder + sessionStorage
      try {
        localStorage.removeItem('token');  // legacy storage path
        localStorage.removeItem('user');
        localStorage.removeItem('tenant');
      } catch { /* ignore storage errors */ }

      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    }
    setSubmitting(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-color)',
      padding: '1rem',
    }}>
      <div style={{
        width: 'min(92vw, 420px)',
        background: 'var(--surface-color)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        color: 'var(--text-primary)',
        borderRadius: 16,
        padding: '2rem',
        boxShadow: '0 10px 40px rgba(0,0,0,0.25)',
        border: '1px solid var(--border-color)',
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <img
            src="/globussoft-logo-pdf.png"
            alt="Globussoft CRM"
            style={{ maxWidth: 200, height: 'auto' }}
          />
        </div>

        <h2 style={{ margin: '0 0 0.25rem', fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          Reset your password
        </h2>

        {done ? (
          <div style={{ marginTop: 20 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '0.85rem 1rem',
              background: 'rgba(22, 163, 74, 0.12)', borderRadius: 10,
              border: '1px solid rgba(22, 163, 74, 0.3)',
            }}>
              <span style={{ fontSize: 20 }}>✓</span>
              <p style={{ margin: 0, color: '#16a34a', fontSize: 14, fontWeight: 500 }}>
                Password reset successfully. Redirecting to sign in…
              </p>
            </div>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <Link to="/login" style={{ color: 'var(--accent-color)', fontSize: 13, fontWeight: 600 }}>
                Go to sign in now
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} style={{ marginTop: 8 }}>
            <p style={{ margin: '0 0 1.25rem', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Enter a new password — at least 8 characters, with one letter and one number.
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{
                display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600,
                color: 'var(--text-secondary)',
              }}>
                New password
              </label>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>

            <div style={{ marginBottom: '0.5rem' }}>
              <label style={{
                display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600,
                color: 'var(--text-secondary)',
              }}>
                Confirm new password
              </label>
              <PasswordInput
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
            </div>

            {error && (
              <div style={{
                marginTop: 12, padding: '0.6rem 0.85rem', borderRadius: 8, fontSize: 13,
                background: 'rgba(220, 38, 38, 0.1)', border: '1px solid rgba(220, 38, 38, 0.3)',
                color: 'var(--danger-color, #dc2626)',
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              style={{
                width: '100%', marginTop: 18, padding: '0.7rem', borderRadius: 8, border: 'none',
                background: 'var(--primary-color, var(--accent-color, #2563eb))',
                color: '#fff', fontWeight: 700, fontSize: 14,
                cursor: submitting ? 'default' : 'pointer',
                opacity: submitting ? 0.7 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {submitting ? 'Resetting…' : 'Reset password'}
            </button>

            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <Link to="/login" style={{ color: 'var(--accent-color)', fontSize: 13 }}>
                Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
