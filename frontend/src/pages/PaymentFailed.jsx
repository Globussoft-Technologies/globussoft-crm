import React from 'react';
import { useNavigate } from 'react-router-dom';

export default function PaymentFailed() {
  const navigate = useNavigate();

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
          backgroundColor: '#fee2e2',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 24px',
          fontSize: '32px'
        }}>
          ✕
        </div>

        <h1 style={{
          margin: '0 0 12px 0',
          fontSize: '28px',
          fontWeight: '700',
          color: '#1f2937'
        }}>
          Payment Failed
        </h1>

        <p style={{
          margin: '0 0 24px 0',
          fontSize: '16px',
          color: '#6b7280'
        }}>
          Unfortunately, your payment could not be processed
        </p>

        <div style={{
          backgroundColor: '#fef2f2',
          borderRadius: '8px',
          padding: '16px',
          marginBottom: '24px',
          textAlign: 'left',
          borderLeft: '4px solid #ef4444'
        }}>
          <p style={{ margin: '0', fontSize: '13px', color: '#991b1b' }}>
            Please check your card details and try again, or contact support if the issue persists.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '12px', flexDirection: 'column' }}>
          <button
            onClick={() => navigate('/pricing')}
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
            Retry Payment
          </button>
          <button
            onClick={() => navigate('/pricing')}
            style={{
              padding: '12px 32px',
              backgroundColor: '#f3f4f6',
              color: '#4b5563',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => e.target.style.backgroundColor = '#e5e7eb'}
            onMouseLeave={(e) => e.target.style.backgroundColor = '#f3f4f6'}
          >
            Go to Pricing
          </button>
        </div>
      </div>
    </div>
  );
}
