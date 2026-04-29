import React, { useState, useContext, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Mail, Square } from 'lucide-react';
import { AuthContext } from '../App';

const Login = () => {
  const [email, setEmail] = useState('admin@globussoft.com');
  const [password, setPassword] = useState('password123');
  const [error, setError] = useState('');
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState('');
  const [forgotToken, setForgotToken] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);

  // 2FA challenge state
  const [require2FA, setRequire2FA] = useState(false);
  const [tempToken, setTempToken] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorBusy, setTwoFactorBusy] = useState(false);

  const { setUser, setToken, setTenant } = useContext(AuthContext);
  const navigate = useNavigate();

  // Handle SSO redirect callback — server bounces user here with ?sso_token=...&tenant=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get('sso_token');
    const tenantParam = params.get('tenant');
    const ssoErr = params.get('sso_error');

    if (ssoErr) {
      setError(decodeURIComponent(ssoErr));
      // Clean URL so the error doesn't re-fire on remount
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }

    if (ssoToken) {
      // #343: setToken (in App.jsx) now writes through to the in-memory
      // holder + sessionStorage via setAuthToken — no localStorage write.
      setToken(ssoToken);

      let parsedTenant = null;
      if (tenantParam) {
        try { parsedTenant = JSON.parse(decodeURIComponent(tenantParam)); } catch { /* ignore */ }
      }
      if (parsedTenant && setTenant) {
        setTenant(parsedTenant);
        localStorage.setItem('tenant', JSON.stringify(parsedTenant));
      }

      // Pull canonical user profile from the server now that we have a token.
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${ssoToken}` } })
        .then(r => r.ok ? r.json() : null)
        .then(profile => { if (profile) setUser(profile); })
        .catch(() => {})
        .finally(() => {
          window.history.replaceState({}, document.title, window.location.pathname);
          navigate('/dashboard');
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSsoLogin = (provider) => {
    window.location.href = `/api/sso/${provider}/start`;
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    if (!forgotEmail) { setForgotMessage('Please enter your email'); return; }
    setForgotLoading(true);
    setForgotMessage('');
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail })
      });
      const data = await response.json();
      if (response.ok) {
        setForgotMessage(data.message);
        if (data.resetToken) setForgotToken(data.resetToken);
      } else {
        setForgotMessage(data.error || 'Request failed');
      }
    } catch (err) {
      setForgotMessage('Server error. Ensure backend is running.');
    }
    setForgotLoading(false);
  };

  // Issue #207/#214: wellness staff have role=USER + a wellnessRole orthogonal
  // claim. Owner Dashboard is for ADMIN/MANAGER only — clinical / telecaller
  // staff need their own landing pages so they don't see org-wide P&L on login.
  const wellnessLandingFor = (user) => {
    if (!user) return '/wellness';
    if (user.role === 'ADMIN' || user.role === 'MANAGER') return '/wellness';
    switch (user.wellnessRole) {
      case 'telecaller':   return '/wellness/telecaller';
      case 'doctor':       return '/wellness/calendar';
      case 'professional': return '/wellness/calendar';
      case 'helper':       return '/wellness/patients';
      default:             return '/wellness/calendar'; // safe read-only fallback
    }
  };

  const finalizeLogin = (data) => {
    setUser(data.user);
    setToken(data.token);
    if (data.tenant && setTenant) setTenant(data.tenant);
    const landing = data.tenant?.vertical === 'wellness'
      ? wellnessLandingFor(data.user)
      : '/dashboard';
    navigate(landing);
  };

  const performLogin = async (loginEmail, loginPassword) => {
    setError('');
    if (!loginEmail || !loginPassword) {
      setError('Please fill out all required fields');
      return;
    }
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
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
        setError(data.error || 'Login failed');
      }
    } catch (err) {
      setError('Server error. Ensure backend is running.');
    }
  };

  const handleLogin = (e) => {
    e.preventDefault();
    performLogin(email, password);
  };

  const quickLogin = (qEmail, qPassword) => {
    setEmail(qEmail);
    setPassword(qPassword);
    performLogin(qEmail, qPassword);
  };

  const handleVerify2FA = async (e) => {
    e.preventDefault();
    setError('');
    if (!twoFactorCode || twoFactorCode.length < 6) {
      setError('Enter the 6-digit code from your authenticator app (or an 8-char backup code).');
      return;
    }
    setTwoFactorBusy(true);
    try {
      const response = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tempToken, code: twoFactorCode })
      });
      const data = await response.json();
      if (response.ok) {
        finalizeLogin(data);
      } else {
        setError(data.error || '2FA verification failed');
      }
    } catch (err) {
      setError('Server error during 2FA verification.');
    }
    setTwoFactorBusy(false);
  };

  const cancel2FA = () => {
    setRequire2FA(false);
    setTempToken('');
    setTwoFactorCode('');
    setError('');
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <div className="card glass" style={{ width: '100%', maxWidth: '400px', padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Globussoft CRM</h2>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
            {require2FA ? 'Two-factor verification required' : 'Sign in to your account'}
          </p>
        </div>

        {error && (
          <div style={{ backgroundColor: 'var(--danger-color)', color: 'white', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

        {require2FA && (
          <form onSubmit={handleVerify2FA}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                Enter the 6-digit code from your authenticator app
              </label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={8}
                className="input-field"
                placeholder="123456"
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value.replace(/[^0-9A-Za-z]/g, '').toUpperCase())}
                autoFocus
                style={{ letterSpacing: '6px', textAlign: 'center', fontSize: '1.2rem' }}
              />
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                Don't have your phone? Use one of your 8-character backup codes.
              </p>
            </div>
            <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={twoFactorBusy}>
              {twoFactorBusy ? 'Verifying...' : 'Verify'}
            </button>
            <button
              type="button"
              onClick={cancel2FA}
              style={{ width: '100%', marginTop: '0.5rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.85rem' }}
            >
              Cancel and sign in as another user
            </button>
          </form>
        )}

        {!require2FA && (
        <>
        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Email</label>
            <input 
              type="email" 
              className="input-field" 
              placeholder="admin@globussoft.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Password</label>
            <input 
              type="password" 
              className="input-field" 
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className="btn-primary" style={{ width: '100%' }}>
            Sign In
          </button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1.25rem 0 1rem' }}>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>or continue with</span>
          <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button
            type="button"
            onClick={() => handleSsoLogin('google')}
            className="glass"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              width: '100%',
              padding: '0.65rem 1rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(8px)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
          >
            <Mail size={16} />
            <span>Sign in with Google</span>
          </button>
          <button
            type="button"
            onClick={() => handleSsoLogin('microsoft')}
            className="glass"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              width: '100%',
              padding: '0.65rem 1rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'rgba(255,255,255,0.06)',
              backdropFilter: 'blur(8px)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500,
            }}
          >
            <Square size={16} />
            <span>Sign in with Microsoft</span>
          </button>
        </div>

        <div style={{ marginTop: '1rem', textAlign: 'center' }}>
          <button
            onClick={() => { setShowForgot(!showForgot); setForgotMessage(''); setForgotToken(''); }}
            style={{ background: 'none', border: 'none', color: 'var(--accent-color)', cursor: 'pointer', fontSize: '0.875rem', fontWeight: '500' }}
          >
            Forgot Password?
          </button>
        </div>

        {showForgot && (
          <div style={{ marginTop: '1rem', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>Enter your email to generate a password reset token.</p>
            <form onSubmit={handleForgotPassword}>
              <input
                type="email"
                className="input-field"
                placeholder="Your email address"
                value={forgotEmail}
                onChange={(e) => setForgotEmail(e.target.value)}
                style={{ marginBottom: '0.75rem' }}
              />
              <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={forgotLoading}>
                {forgotLoading ? 'Sending...' : 'Reset Password'}
              </button>
            </form>
            {forgotMessage && (
              <p style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{forgotMessage}</p>
            )}
            {forgotToken && (
              <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'rgba(16,185,129,0.1)', borderRadius: '6px', fontSize: '0.75rem', wordBreak: 'break-all' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Reset Token:</strong>
                <span style={{ color: '#10b981', marginLeft: '0.5rem' }}>{forgotToken}</span>
                <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)' }}>In production, this would be emailed. Use this token with the reset-password API.</p>
              </div>
            )}
          </div>
        )}

        <QuickLoginSection title="Generic CRM" accounts={[
          { label: 'Admin',   email: 'admin@globussoft.com', color: '#10b981' },
          { label: 'Manager', email: 'manager@crm.com',      color: '#f59e0b' },
          { label: 'User',    email: 'user@crm.com',         color: '#3b82f6' },
        ]} onLogin={quickLogin} />

        <QuickLoginSection title="Enhanced Wellness — Demo" accounts={[
          { label: 'Owner (Rishu)',  email: 'rishu@enhancedwellness.in', color: '#a855f7' },
          { label: 'Demo Admin',     email: 'admin@wellness.demo',       color: '#a855f7' },
          { label: 'Demo User',      email: 'user@wellness.demo',        color: '#ec4899' },
        ]} onLogin={quickLogin} />
        <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Don't have an account? </span>
          <Link to="/signup" style={{ color: 'var(--primary-color)', textDecoration: 'none', fontWeight: '500' }}>
            Sign up
          </Link>
        </div>
        </>
        )}
      </div>
    </div>
  );
};

function QuickLoginSection({ title, accounts, onLogin }) {
  return (
    <div style={{ marginTop: '1.25rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {title} — click to log in
        </span>
        <div style={{ flex: 1, height: '1px', background: 'var(--border-color)' }} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${accounts.length}, 1fr)`, gap: '0.4rem' }}>
        {accounts.map((a) => {
          const colorRgb = a.color === '#10b981' ? '16,185,129'
            : a.color === '#3b82f6' ? '59,130,246'
            : a.color === '#f59e0b' ? '245,158,11'
            : a.color === '#a855f7' ? '168,85,247'
            : a.color === '#ec4899' ? '236,72,153'
            : '100,100,100';
          return (
            <button
              key={a.email}
              type="button"
              onClick={() => onLogin(a.email, 'password123')}
              style={{
                padding: '0.55rem 0.45rem',
                borderRadius: '8px',
                border: `1px solid rgba(${colorRgb}, 0.3)`,
                background: `rgba(${colorRgb}, 0.08)`,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s',
                minWidth: 0,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = `rgba(${colorRgb}, 0.18)`; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = `rgba(${colorRgb}, 0.08)`; }}
              title={`Log in as ${a.email}`}
            >
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color: a.color, textTransform: 'uppercase', marginBottom: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {a.label}
              </div>
              <div style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {a.email}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default Login;
