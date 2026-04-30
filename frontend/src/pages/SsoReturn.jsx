import React, { useEffect, useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from '../App';

export default function SsoReturn() {
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { loginWithToken } = useContext(AuthContext);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const next = params.get('next') || '/dashboard';
    const errParam = params.get('error');
    const tenantRaw = params.get('tenant');

    if (errParam) {
      setError(decodeURIComponent(errParam));
      return;
    }

    if (!token) {
      setError('missing_token');
      return;
    }

    let parsedTenant = null;
    try {
      if (tenantRaw) parsedTenant = JSON.parse(decodeURIComponent(tenantRaw));
    } catch {
      // Ignore parsing errors
    }

    loginWithToken(token, parsedTenant)
      .then(() => navigate(next, { replace: true }))
      .catch((e) => setError(String(e.message || 'sso_handshake_failed')));
  }, [loginWithToken, navigate]);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        padding: '20px',
        fontFamily: 'system-ui',
      }}
    >
      {error ? (
        <div
          className="card glass"
          style={{
            width: '100%',
            maxWidth: '400px',
            padding: '2rem',
            textAlign: 'center',
          }}
        >
          <h2 style={{ color: 'var(--danger-color)', marginBottom: '0.5rem' }}>
            SSO sign-in failed
          </h2>
          <p style={{ color: 'var(--text-secondary)', margin: '0.5rem 0' }}>
            Error code: <code style={{ background: 'rgba(0,0,0,0.2)', padding: '0.25rem 0.5rem', borderRadius: '4px' }}>{error}</code>
          </p>
          <p style={{ marginTop: '1.5rem' }}>
            <a href="/" style={{ color: 'var(--accent-color)' }}>
              Back to login
            </a>
          </p>
        </div>
      ) : (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
            Signing you in…
          </p>
        </div>
      )}
    </div>
  );
}
