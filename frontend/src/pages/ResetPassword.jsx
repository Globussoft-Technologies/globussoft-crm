// Password reset page — the landing for the link emailed by
// POST /api/auth/forgot-password. Reads ?token=, collects a new password, and
// POSTs { token, newPassword } to /api/auth/reset-password (public endpoint).
//
// Uses a plain fetch (NOT fetchApi) because the user is unauthenticated here —
// fetchApi would attach a stale Bearer / redirect to /login on 401.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function ResetPassword() {
  const navigate = useNavigate();
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
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.');
    }
    setSubmitting(false);
  };

  const card = {
    width: 'min(92vw, 400px)', background: 'var(--card-bg, #fff)', color: 'var(--text-primary, #111)',
    borderRadius: 14, padding: '2rem', boxShadow: '0 10px 40px rgba(0,0,0,0.25)', border: '1px solid var(--border-color, #e5e7eb)',
  };
  const input = {
    width: '100%', padding: '0.6rem 0.75rem', marginTop: 6, borderRadius: 8,
    border: '1px solid var(--border-color, #d1d5db)', background: 'var(--input-bg, #fff)', color: 'inherit', fontSize: 14,
  };
  const label = { display: 'block', marginTop: 14, fontSize: 13, fontWeight: 600, color: 'var(--text-secondary, #555)' };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-color, #0b1220)', padding: '1rem' }}>
      <div style={card}>
        <h2 style={{ margin: 0, fontSize: '1.3rem' }}>Reset your password</h2>
        {done ? (
          <>
            <p style={{ marginTop: 14, color: 'var(--success-color, #16a34a)' }}>
              ✓ Your password has been reset. Redirecting to sign in…
            </p>
            <Link to="/login" style={{ color: 'var(--primary-color, #2563eb)' }}>Go to sign in</Link>
          </>
        ) : (
          <form onSubmit={submit}>
            <p style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary, #666)' }}>
              Enter a new password (min 8 characters, at least one letter and one number).
            </p>
            <label style={label}>New password</label>
            <input style={input} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label style={label}>Confirm new password</label>
            <input style={input} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {error && <p style={{ marginTop: 12, color: 'var(--error-color, #dc2626)', fontSize: 13 }}>{error}</p>}
            <button
              type="submit"
              disabled={submitting}
              style={{
                width: '100%', marginTop: 18, padding: '0.65rem', borderRadius: 8, border: 'none',
                background: 'var(--primary-color, #2563eb)', color: '#fff', fontWeight: 700, fontSize: 14,
                cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? 'Resetting…' : 'Reset password'}
            </button>
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <Link to="/login" style={{ color: 'var(--primary-color, #2563eb)', fontSize: 13 }}>Back to sign in</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
