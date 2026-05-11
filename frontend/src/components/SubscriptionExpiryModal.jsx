import React, { useState } from 'react';
import { Link } from 'react-router-dom';

export default function SubscriptionExpiryModal({ daysRemaining, trialEndsAt, onClose }) {
  const [reminded, setReminded] = useState(false);

  if (!daysRemaining || daysRemaining > 1 || reminded) {
    return null;
  }

  const endDate = new Date(trialEndsAt);
  const formattedDate = endDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  const handleRemindLater = () => {
    const remindKey = `trial-remind-until-${new Date().setHours(24, 0, 0, 0)}`;
    localStorage.setItem(remindKey, 'true');
    setReminded(true);
    if (onClose) onClose();
  };

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999
    }}>
      <div style={{
        backgroundColor: 'white',
        borderRadius: '8px',
        padding: '32px',
        maxWidth: '400px',
        width: '90%',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.2)',
        textAlign: 'center'
      }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>⏳</div>
        <h2 style={{ margin: '0 0 12px 0', fontSize: '20px', fontWeight: '600', color: '#1f2937' }}>
          Trial Expires Soon
        </h2>
        <p style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#6b7280' }}>
          Your free trial expires on
        </p>
        <p style={{ margin: '0 0 24px 0', fontSize: '16px', fontWeight: '600', color: '#f97316' }}>
          {formattedDate}
        </p>
        <p style={{ margin: '0 0 24px 0', fontSize: '13px', color: '#6b7280', lineHeight: '1.6' }}>
          Choose a plan to continue using all features and ensure uninterrupted service.
        </p>

        <div style={{ display: 'flex', gap: '12px', flexDirection: 'column' }}>
          <Link
            to="/pricing"
            style={{
              padding: '12px 24px',
              backgroundColor: '#f97316',
              color: 'white',
              textDecoration: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: '500',
              cursor: 'pointer',
              border: 'none',
              transition: 'opacity 0.2s',
              textAlign: 'center'
            }}
            onMouseEnter={(e) => e.target.style.opacity = '0.9'}
            onMouseLeave={(e) => e.target.style.opacity = '1'}
          >
            Choose Plan
          </Link>
          <button
            onClick={handleRemindLater}
            style={{
              padding: '12px 24px',
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
            Remind Later
          </button>
        </div>
      </div>
    </div>
  );
}
