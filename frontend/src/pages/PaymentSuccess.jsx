import React, { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

export default function PaymentSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const planName = location.state?.planName || 'Subscription';
  const billingPeriod = location.state?.billingPeriod;
  const endDate = location.state?.endDate;

  useEffect(() => {
    const timer = setTimeout(() => {
      navigate('/dashboard');
    }, 3000);

    return () => clearTimeout(timer);
  }, [navigate]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#f9fafb',
      padding: '20px'
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        padding: '48px',
        maxWidth: '500px',
        width: '100%',
        textAlign: 'center',
        boxShadow: '0 4px 6px rgba(0, 0, 0, 0.1)'
      }}>
        <div style={{
          width: '64px',
          height: '64px',
          borderRadius: '50%',
          backgroundColor: '#dcfce7',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 24px',
          fontSize: '32px'
        }}>
          ✓
        </div>

        <h1 style={{
          margin: '0 0 12px 0',
          fontSize: '28px',
          fontWeight: '700',
          color: '#1f2937'
        }}>
          Payment Successful!
        </h1>

        <p style={{
          margin: '0 0 24px 0',
          fontSize: '16px',
          color: '#6b7280'
        }}>
          Your subscription has been activated
        </p>

        <div style={{
          backgroundColor: '#f3f4f6',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '24px',
          textAlign: 'left'
        }}>
          <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#6b7280', textTransform: 'uppercase', fontWeight: '500' }}>
            Plan Details
          </p>
          <p style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: '600', color: '#1f2937' }}>
            {planName}
          </p>
          {billingPeriod && (
            <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#6b7280' }}>
              Billing cycle: <strong>{billingPeriod}</strong>
            </p>
          )}
          {endDate && (
            <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#6b7280' }}>
              Active until: <strong>{new Date(endDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</strong>
            </p>
          )}
          <p style={{ margin: '0', fontSize: '13px', color: '#6b7280' }}>
            Your subscription is now active and you have full access to all features.
          </p>
        </div>

        <p style={{
          margin: '0 0 24px 0',
          fontSize: '13px',
          color: '#9ca3af'
        }}>
          Redirecting to dashboard in 3 seconds...
        </p>

        <button
          onClick={() => navigate('/dashboard')}
          style={{
            padding: '12px 32px',
            backgroundColor: '#f97316',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: '500',
            cursor: 'pointer',
            transition: 'opacity 0.2s'
          }}
          onMouseEnter={(e) => e.target.style.opacity = '0.9'}
          onMouseLeave={(e) => e.target.style.opacity = '1'}
        >
          Continue to Dashboard
        </button>
      </div>
    </div>
  );
}
