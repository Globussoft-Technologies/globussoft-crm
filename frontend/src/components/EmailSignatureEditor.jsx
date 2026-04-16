import React from 'react';
import { Save, Eye, Loader, Info } from 'lucide-react';
import { fetchApi } from '../utils/api';

const VARIABLES = [
  { token: '{{user.name}}', desc: 'Logged-in user full name' },
  { token: '{{user.email}}', desc: 'Logged-in user email' },
  { token: '{{tenant.name}}', desc: 'Workspace / tenant name' },
];

export default function EmailSignatureEditor() {
  const [signature, setSignature] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchApi('/api/email-scheduling/signature');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) {
          setSignature(
            (data && (data.signature || (data.data && data.data.signature))) || ''
          );
        }
      } catch (e) {
        if (!cancelled) setStatus({ type: 'error', msg: 'Failed to load signature' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetchApi('/api/email-scheduling/signature', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }),
      });
      if (!res.ok) throw new Error('Save failed');
      setStatus({ type: 'success', msg: 'Signature saved' });
    } catch (e) {
      setStatus({ type: 'error', msg: e.message || 'Save failed' });
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  const glassCard = {
    background: 'rgba(255, 255, 255, 0.08)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid var(--border-color, rgba(255,255,255,0.12))',
    borderRadius: '12px',
    padding: '1.25rem',
    color: 'var(--text-primary, #e2e8f0)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={glassCard}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.75rem',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>
            Email Signature
          </h3>
          <button
            onClick={handleSave}
            disabled={saving || loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              padding: '0.5rem 0.9rem',
              cursor: saving || loading ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              opacity: saving || loading ? 0.7 : 1,
            }}
          >
            {saving ? <Loader size={14} className="spin" /> : <Save size={14} />}
            {saving ? 'Saving' : 'Save Signature'}
          </button>
        </div>

        {loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              opacity: 0.7,
              padding: '1rem 0',
            }}
          >
            <Loader size={14} className="spin" /> Loading signature...
          </div>
        ) : (
          <textarea
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            rows={8}
            placeholder={
              '<p>Best regards,<br/>{{user.name}}<br/>{{tenant.name}}</p>'
            }
            spellCheck={false}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.85rem',
              lineHeight: 1.5,
              padding: '0.75rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color, rgba(255,255,255,0.15))',
              background: 'rgba(0,0,0,0.25)',
              color: 'var(--text-primary, #e2e8f0)',
              resize: 'vertical',
            }}
          />
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.5rem',
            marginTop: '0.75rem',
            padding: '0.6rem 0.75rem',
            background: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            borderRadius: '8px',
            fontSize: '0.78rem',
          }}
        >
          <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: '#60a5fa' }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              Variables auto-substituted on send:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {VARIABLES.map((v) => (
                <code
                  key={v.token}
                  title={v.desc}
                  style={{
                    background: 'rgba(255,255,255,0.08)',
                    padding: '2px 6px',
                    borderRadius: 4,
                    fontSize: '0.75rem',
                  }}
                >
                  {v.token}
                </code>
              ))}
            </div>
          </div>
        </div>

        {status && (
          <div
            role="status"
            style={{
              marginTop: '0.6rem',
              fontSize: '0.8rem',
              color: status.type === 'success' ? '#34d399' : '#f87171',
            }}
          >
            {status.msg}
          </div>
        )}
      </div>

      <div style={glassCard}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            marginBottom: '0.6rem',
            fontSize: '0.85rem',
            fontWeight: 600,
            opacity: 0.85,
          }}
        >
          <Eye size={14} /> Live Preview
        </div>
        <div
          style={{
            background: '#ffffff',
            color: '#111827',
            borderRadius: '8px',
            padding: '1rem',
            minHeight: '80px',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            fontSize: '0.9rem',
            lineHeight: 1.5,
            border: '1px solid rgba(0,0,0,0.08)',
          }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html:
              signature ||
              '<span style="color:#9ca3af">Your signature preview will appear here...</span>',
          }}
        />
      </div>
    </div>
  );
}
