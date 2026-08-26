import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, CalendarClock, Send, Loader } from 'lucide-react';
import { fetchApi } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { inputStyle, labelStyle } from './shared';

/**
 * Ask the clinic for one of the sessions you have already paid for.
 *
 * The date here is a PREFERENCE, not a booking — the clinic assigns the
 * practitioner and confirms the slot. Saying so plainly matters: a customer who
 * believes they have booked a slot and turns up is a worse outcome than one who
 * waits for a confirmation.
 */
export default function RequestSessionModal({ pkg, onClose, onRequested }) {
  const notify = useNotify();
  const [preferredDate, setPreferredDate] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const plan = pkg.ownedPlan;
  const sessionsLeft = Math.max(0, (plan?.totalSessions || 0) - (plan?.completedSessions || 0));

  const submit = async (e) => {
    e.preventDefault();
    if (sending || !plan) return;
    setSending(true);
    try {
      await fetchApi(`/api/wellness/packages/plans/${plan.id}/request-session`, {
        method: 'POST',
        body: JSON.stringify({
          preferredDate: preferredDate || null,
          note: note.trim() || null,
        }),
      });
      notify.success('Request sent — the clinic will confirm your slot.');
      onRequested?.();
      onClose();
    } catch (err) {
      notify.error(err?.message || 'Could not send your request');
    } finally {
      setSending(false);
    }
  };

  // Portalled for the same reason the dropdowns are: a .glass ancestor's
  // backdrop-filter would otherwise trap `position: fixed` inside its box.
  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 10000,
      }}
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        data-testid="request-session-modal"
        style={{
          width: 'min(100%, 420px)',
          background: 'var(--bg-color)',
          border: '1px solid var(--border-color)',
          borderRadius: 12,
          padding: '1.25rem',
          display: 'grid',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <CalendarClock size={16} /> Request a session
            </h2>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
              {pkg.name} · {sessionsLeft} of {plan?.totalSessions} sessions left
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0 }}
          >
            <X size={16} />
          </button>
        </div>

        <div>
          <label style={labelStyle} htmlFor="session-preferred-date">Preferred date</label>
          <input
            id="session-preferred-date"
            type="date"
            value={preferredDate}
            onChange={(e) => setPreferredDate(e.target.value)}
            style={inputStyle}
            data-testid="session-preferred-date"
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="session-note">Anything the clinic should know?</label>
          <textarea
            id="session-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. mornings work best for me"
            style={{ ...inputStyle, resize: 'vertical' }}
            data-testid="session-note"
          />
        </div>

        <p style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
          This is a request, not a confirmed slot. The clinic will assign your
          practitioner and confirm the time. Nothing is deducted from your
          package until the session actually happens.
        </p>

        <button
          type="submit"
          disabled={sending || sessionsLeft === 0}
          data-testid="session-request-submit"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.4rem',
            padding: '0.6rem 1rem',
            background: 'var(--accent-color)',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontWeight: 600,
            cursor: sending ? 'not-allowed' : 'pointer',
          }}
        >
          {sending ? (
            <>
              <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Sending…
            </>
          ) : (
            <>
              <Send size={14} /> Send request
            </>
          )}
        </button>
      </form>
    </div>,
    document.body,
  );
}
