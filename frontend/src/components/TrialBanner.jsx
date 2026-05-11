import React, { useState } from 'react';
import { Link } from 'react-router-dom';

export default function TrialBanner({ daysRemaining }) {
  const [dismissed, setDismissed] = useState(
    typeof window !== 'undefined' && sessionStorage.getItem('trial-banner-dismissed') === 'true'
  );

  if (dismissed || !daysRemaining || daysRemaining <= 0) {
    return null;
  }

  const handleDismiss = () => {
    sessionStorage.setItem('trial-banner-dismissed', 'true');
    setDismissed(true);
  };

  const isUrgent = daysRemaining <= 3;

  return (
    <div style={{
      backgroundColor: isUrgent ? '#fef3c7' : '#fef8f0',
      borderLeft: `4px solid ${isUrgent ? '#f59e0b' : '#f97316'}`,
      padding: '12px 16px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: '12px',
      borderRadius: '4px'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
        <span style={{ fontSize: '18px' }}>⏰</span>
        <div>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: '500', color: '#1f2937' }}>
            Your free trial expires in <strong>{daysRemaining} {daysRemaining === 1 ? 'day' : 'days'}</strong>
          </p>
          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#6b7280' }}>
            Upgrade now to continue using all features
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Link
          to="/pricing"
          style={{
            padding: '8px 16px',
            backgroundColor: isUrgent ? '#f59e0b' : '#f97316',
            color: 'white',
            textDecoration: 'none',
            borderRadius: '4px',
            fontSize: '13px',
            fontWeight: '500',
            cursor: 'pointer',
            border: 'none',
            transition: 'opacity 0.2s'
          }}
          onMouseEnter={(e) => e.target.style.opacity = '0.9'}
          onMouseLeave={(e) => e.target.style.opacity = '1'}
        >
          Upgrade Now
        </Link>
        <button
          onClick={handleDismiss}
          style={{
            background: 'none',
            border: 'none',
            fontSize: '20px',
            cursor: 'pointer',
            color: '#6b7280',
            padding: '4px 8px',
            display: 'flex',
            alignItems: 'center'
          }}
          aria-label="Dismiss banner"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
