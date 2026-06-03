
import { CheckCheck, X } from 'lucide-react';
import { useWhatsAppThreads } from './WhatsAppThreadsContext';

export default function UnblockModal() {
  const {
    unblockOpen,
    setUnblockOpen,
    unblockReason,
    setUnblockReason,
    unblockSaving,
    unblockError,
    submitUnblock,
    detail,
  } = useWhatsAppThreads();

  if (!unblockOpen) return null;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !unblockSaving) setUnblockOpen(false); }}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 10002, padding: '1rem',
      }}
    >
      <div style={{
        width: '100%', maxWidth: 460, padding: '1.5rem', borderRadius: 12,
        background: 'var(--surface-color)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-color)',
        boxShadow: '0 16px 40px rgba(0,0,0,0.3)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <CheckCheck size={18} color="#16a34a" />
            Unblock contact
          </h3>
          <button
            onClick={() => !unblockSaving && setUnblockOpen(false)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: 4, display: 'flex' }}
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0 0 1rem' }}>
          Unblocking <strong>{detail?.thread?.contactPhone}</strong> re-enables
          outbound WhatsApp messages to this number. The reason below is
          recorded in the audit log (DPDP §11 compliance).
        </p>
        <label style={{ display: 'block', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 4 }}>
            Reason (minimum 10 characters)
          </span>
          <textarea
            value={unblockReason}
            onChange={(e) => setUnblockReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submitUnblock();
              }
            }}
            rows={3}
            placeholder="e.g. Customer requested re-engagement after billing dispute resolved"
            className="input-field"
            style={{ width: '100%', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
            disabled={unblockSaving}
            autoFocus
          />
          <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            {unblockReason.trim().length}/10 characters minimum
          </span>
        </label>
        {unblockError && (
          <div style={{
            background: 'rgba(220,38,38,0.1)', color: '#dc2626',
            border: '1px solid rgba(220,38,38,0.3)',
            padding: '0.55rem 0.75rem', borderRadius: 6,
            fontSize: '0.8rem', marginBottom: '0.75rem',
          }}>
            {unblockError}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={() => setUnblockOpen(false)}
            disabled={unblockSaving}
            className="btn-secondary"
            style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}
          >
            Cancel
          </button>
          <button
            onClick={submitUnblock}
            disabled={unblockSaving || unblockReason.trim().length < 10}
            style={{
              padding: '0.5rem 1rem', fontSize: '0.85rem',
              background: '#16a34a', color: '#fff',
              border: 'none', borderRadius: 6, fontWeight: 600,
              cursor: unblockSaving ? 'not-allowed' : 'pointer',
              opacity: unblockSaving || unblockReason.trim().length < 10 ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <CheckCheck size={14} />
            {unblockSaving ? 'Unblocking…' : 'Unblock'}
          </button>
        </div>
      </div>
    </div>
  );
}
