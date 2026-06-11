import React, { useEffect } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { CheckCircle, ArrowRight, LogIn } from 'lucide-react';

const C = {
  bg: '#f8fafc', bg2: '#ffffff', text: '#1e293b', text2: '#334155', text3: '#64748b',
  accent: '#2563eb', accentBg: '#eff6ff', green: '#059669', greenBg: '#ecfdf5',
  border: '#e2e8f0', card: '#ffffff', shadow: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
};

export default function RegisterSuccess() {
  const location = useLocation();
  const navigate = useNavigate();
  const { planName, subscription, email } = location.state || {};

  useEffect(() => {
    // Guard direct navigation with no state
    if (!location.state) {
      navigate('/get-started', { replace: true });
    }
  }, [location.state, navigate]);

  if (!location.state) return null;

  const startDate = subscription?.startDate
    ? new Date(subscription.startDate).toLocaleDateString()
    : null;
  const endDate = subscription?.endDate
    ? new Date(subscription.endDate).toLocaleDateString()
    : null;

  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <nav style={{ position: 'sticky', top: 0, left: 0, right: 0, zIndex: 100, background: C.card, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '14px 28px', display: 'flex', alignItems: 'center' }}>
          <Link to="/" style={{ display: 'flex', alignItems: 'center' }}>
            <img
              src="/globussoft-logo.png"
              alt="Globus CRM"
              style={{ height: 34, width: 'auto', maxWidth: 160, objectFit: 'contain' }}
            />
          </Link>
        </div>
      </nav>

      <main style={{ maxWidth: 560, margin: '0 auto', padding: '64px 24px' }}>
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '40px 32px', textAlign: 'center', boxShadow: C.shadow }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%', background: C.greenBg,
            display: 'grid', placeItems: 'center', margin: '0 auto 20px',
          }}>
            <CheckCircle size={36} color={C.green} />
          </div>

          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: 10 }}>
            Welcome to Globus CRM
          </h1>
          <p style={{ color: C.text3, fontSize: '1rem', maxWidth: 420, margin: '0 auto 28px', lineHeight: 1.55 }}>
            Your payment was verified and your account is ready. You can now sign in to start using your workspace.
          </p>

          {planName && (
            <div style={{
              background: C.accentBg, border: `1px solid rgba(37,99,235,0.15)`,
              borderRadius: 12, padding: '18px 20px', textAlign: 'left', marginBottom: 28,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ color: C.text2 }}>Plan</span>
                <span style={{ fontWeight: 700 }}>{planName}</span>
              </div>
              {subscription?.status && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ color: C.text2 }}>Status</span>
                  <span style={{ fontWeight: 600, textTransform: 'capitalize' }}>{subscription.status.toLowerCase()}</span>
                </div>
              )}
              {startDate && endDate && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: C.text2 }}>Valid through</span>
                  <span style={{ fontWeight: 600 }}>{endDate}</span>
                </div>
              )}
            </div>
          )}

          <Link
            to={email ? `/login?email=${encodeURIComponent(email)}` : '/login'}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              padding: '14px 28px', borderRadius: 10, background: C.accent, color: '#fff',
              fontWeight: 600, fontSize: '1rem', textDecoration: 'none',
            }}
          >
            <LogIn size={20} />
            Go to Login
            <ArrowRight size={18} />
          </Link>

          <div style={{ marginTop: 24, fontSize: '0.85rem', color: C.text4 }}>
            You can also return to the <Link to="/" style={{ color: C.accent, textDecoration: 'none', fontWeight: 500 }}>home page</Link>.
          </div>
        </div>
      </main>
    </div>
  );
}
