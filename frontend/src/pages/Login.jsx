import React, { useState, useContext } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
  const { setUser, setToken } = useContext(AuthContext);
  const navigate = useNavigate();

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
        navigate('/');
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
