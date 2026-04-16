import React, { useEffect, useState } from 'react';
import { Shield, ShieldCheck, ShieldOff, Key, Copy, CheckCircle, AlertTriangle, Loader2, QrCode, Lock } from 'lucide-react';
import { fetchApi } from '../utils/api';

const card = {
  padding: '1.5rem',
  borderRadius: '14px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--border-color, rgba(255,255,255,0.08))',
  marginBottom: '1.25rem',
};

const labelStyle = {
  display: 'block',
  fontSize: '0.8rem',
  color: 'var(--text-secondary)',
  marginBottom: '0.4rem',
  fontWeight: 500,
};

export default function Profile2FA() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Setup flow
  const [setupData, setSetupData] = useState(null); // { secret, qrCode }
  const [setupCode, setSetupCode] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);

  // Backup codes
  const [backupCodes, setBackupCodes] = useState(null);
  const [savedAck, setSavedAck] = useState(false);
  const [copied, setCopied] = useState(false);

  // Disable flow
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    setLoading(true);
    setError('');
    try {
      const me = await fetchApi('/api/auth/me');
      setEnabled(!!me.twoFactorEnabled);
    } catch (e) {
      // /me may not return twoFactorEnabled — default to false silently.
      setEnabled(false);
    }
    setLoading(false);
  }

  async function handleStartSetup() {
    setError(''); setInfo('');
    setSetupBusy(true);
    try {
      const data = await fetchApi('/api/auth/2fa/setup', { method: 'POST', body: JSON.stringify({}) });
      setSetupData(data);
    } catch (e) {
      setError(e.message || 'Failed to start 2FA setup');
    }
    setSetupBusy(false);
  }

  async function handleEnable() {
    setError(''); setInfo('');
    if (!setupCode || setupCode.length < 6) { setError('Enter the 6-digit code from your authenticator app'); return; }
    setSetupBusy(true);
    try {
      const data = await fetchApi('/api/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: setupCode }),
      });
      setBackupCodes(data.backupCodes || []);
      setEnabled(true);
      setSetupData(null);
      setSetupCode('');
      setInfo('2FA enabled. Save your backup codes now — they will not be shown again.');
    } catch (e) {
      setError(e.message || 'Verification failed');
    }
    setSetupBusy(false);
  }

  async function handleDisable() {
    setError(''); setInfo('');
    if (!disablePassword || !disableCode) { setError('Password and 2FA code are required'); return; }
    setDisableBusy(true);
    try {
      await fetchApi('/api/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ password: disablePassword, code: disableCode }),
      });
      setEnabled(false);
      setDisablePassword('');
      setDisableCode('');
      setInfo('Two-factor authentication has been disabled.');
    } catch (e) {
      setError(e.message || 'Failed to disable 2FA');
    }
    setDisableBusy(false);
  }

  function copyCodes() {
    if (!backupCodes) return;
    const text = backupCodes.join('\n');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  }

  if (loading) {
    return (
      <div style={{ padding: '2rem', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
        <Loader2 size={18} className="spin" /> Loading 2FA settings...
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '1.5rem' }}>
        <Shield size={28} color="var(--accent-color)" />
        <div>
          <h1 style={{ margin: 0, fontSize: '1.6rem' }}>Two-Factor Authentication</h1>
          <p style={{ margin: '.25rem 0 0', color: 'var(--text-secondary)', fontSize: '.9rem' }}>
            Add a second layer of security to your CRM account using a TOTP authenticator app.
          </p>
        </div>
      </div>

      {error && (
        <div style={{ ...card, background: 'rgba(239,68,68,0.1)', borderColor: 'rgba(239,68,68,0.4)', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <AlertTriangle size={18} color="#ef4444" />
          <span style={{ color: '#fca5a5', fontSize: '.9rem' }}>{error}</span>
        </div>
      )}
      {info && (
        <div style={{ ...card, background: 'rgba(16,185,129,0.1)', borderColor: 'rgba(16,185,129,0.4)', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <CheckCircle size={18} color="#10b981" />
          <span style={{ color: '#86efac', fontSize: '.9rem' }}>{info}</span>
        </div>
      )}

      {/* Status card */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
            {enabled ? <ShieldCheck size={22} color="#10b981" /> : <ShieldOff size={22} color="var(--text-secondary)" />}
            <div>
              <div style={{ fontWeight: 600 }}>Status</div>
              <div style={{ color: enabled ? '#10b981' : 'var(--text-secondary)', fontSize: '.9rem' }}>
                {enabled ? 'Enabled — your account is protected with 2FA.' : 'Disabled — 2FA is not active on your account.'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Backup codes display (after enable) */}
      {backupCodes && (
        <div style={{ ...card, background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.4)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.5rem' }}>
            <Key size={18} color="#f59e0b" />
            <strong>Save your backup codes</strong>
          </div>
          <p style={{ fontSize: '.85rem', color: 'var(--text-secondary)', marginTop: 0 }}>
            Each code can be used once if you lose access to your authenticator app. Store them somewhere safe — they will not be shown again.
          </p>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '.5rem',
            padding: '.75rem',
            background: 'rgba(0,0,0,0.25)',
            borderRadius: '8px',
            fontFamily: 'monospace',
            fontSize: '.95rem',
            marginBottom: '.75rem',
          }}>
            {backupCodes.map((c) => (
              <div key={c} style={{ letterSpacing: '1px' }}>{c}</div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <button className="btn-secondary" onClick={copyCodes} style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <Copy size={14} /> {copied ? 'Copied!' : 'Copy all'}
            </button>
            <button
              className="btn-primary"
              onClick={() => { setBackupCodes(null); setSavedAck(true); }}
              style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}
            >
              <CheckCircle size={14} /> I've saved these
            </button>
          </div>
        </div>
      )}

      {/* Enable flow */}
      {!enabled && !setupData && (
        <div style={card}>
          <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <QrCode size={18} /> Enable 2FA
          </h3>
          <p style={{ fontSize: '.9rem', color: 'var(--text-secondary)' }}>
            You'll scan a QR code with an authenticator app such as Google Authenticator, Authy, or 1Password.
          </p>
          <button
            className="btn-primary"
            onClick={handleStartSetup}
            disabled={setupBusy}
            style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}
          >
            {setupBusy ? <Loader2 size={14} className="spin" /> : <Shield size={14} />}
            Begin Setup
          </button>
        </div>
      )}

      {!enabled && setupData && (
        <div style={card}>
          <h3 style={{ marginTop: 0 }}>Scan this QR code</h3>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ background: 'white', padding: '.5rem', borderRadius: '8px' }}>
              <img src={setupData.qrCode} alt="2FA QR code" style={{ width: 180, height: 180, display: 'block' }} />
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <label style={labelStyle}>Manual entry secret</label>
              <code style={{
                display: 'block',
                background: 'rgba(0,0,0,0.3)',
                padding: '.5rem',
                borderRadius: '6px',
                wordBreak: 'break-all',
                fontSize: '.8rem',
                marginBottom: '1rem',
              }}>{setupData.secret}</code>

              <label style={labelStyle}>Enter 6-digit code from your app</label>
              <input
                className="input-field"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, ''))}
                style={{ marginBottom: '.75rem', letterSpacing: '4px', textAlign: 'center', fontSize: '1.1rem' }}
              />
              <button
                className="btn-primary"
                onClick={handleEnable}
                disabled={setupBusy || setupCode.length < 6}
                style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}
              >
                {setupBusy ? <Loader2 size={14} className="spin" /> : <CheckCircle size={14} />}
                Verify & Enable
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Disable flow */}
      {enabled && !backupCodes && (
        <div style={card}>
          <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '.5rem' }}>
            <Lock size={18} /> Disable 2FA
          </h3>
          <p style={{ fontSize: '.9rem', color: 'var(--text-secondary)' }}>
            Disabling 2FA will remove the second authentication step on your account. We recommend keeping it enabled.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
            <div>
              <label style={labelStyle}>Current password</label>
              <input
                type="password"
                className="input-field"
                placeholder="••••••••"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle}>Authenticator code</label>
              <input
                className="input-field"
                inputMode="numeric"
                maxLength={6}
                placeholder="123456"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
                style={{ letterSpacing: '4px', textAlign: 'center' }}
              />
            </div>
          </div>
          <button
            onClick={handleDisable}
            disabled={disableBusy}
            style={{
              marginTop: '1rem',
              padding: '.6rem 1rem',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              cursor: disableBusy ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '.4rem',
            }}
          >
            {disableBusy ? <Loader2 size={14} className="spin" /> : <ShieldOff size={14} />}
            Disable 2FA
          </button>
        </div>
      )}

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
