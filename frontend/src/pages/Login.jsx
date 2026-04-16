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
      setToken(ssoToken);
      localStorage.setItem('token', ssoToken);

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

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill out all required fields');
      return;
    }
    try {
      // In development, we'll mock the backend call
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      
      const data = await response.json();
      
      if (response.ok) {
        setUser(data.user);
        setToken(data.token);
        if (data.tenant && setTenant) setTenant(data.tenant);
        navigate('/dashboard');
      } else {
        setError(data.error || 'Login failed');
      }
    } catch (err) {
      setError('Server error. Ensure backend is running.');
    }
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <div className="card glass" style={{ width: '100%', maxWidth: '400px', padding: '2rem' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 'bold' }}>Globussoft CRM</h2>
          <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>Sign in to your account</p>
        </div>
        
        {error && (
          <div style={{ backgroundColor: 'var(--danger-color)', color: 'white', padding: '0.75rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.875rem' }}>
            {error}
          </div>
        )}

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

        <div style={{ marginTop: '2rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          <p>Demo Credentials:</p>
          <p>Email: admin@globussoft.com | Password: password123</p>
        </div>
        <div style={{ marginTop: '1rem', textAlign: 'center', fontSize: '0.875rem' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Don't have an account? </span>
          <Link to="/signup" style={{ color: 'var(--primary-color)', textDecoration: 'none', fontWeight: '500' }}>
            Sign up
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Login;
