import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Phone,
  X,
  Loader,
  AlertCircle,
  Bot,
  User,
  CheckCircle2,
  FileText,
} from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';
import { probeMicrophone } from '../utils/callified';
import CallifiedManualCallPanel from './CallifiedManualCallPanel';

/**
 * "Call Customer" dialog — pick AI or human, then place the call.
 *
 * Clicking a call action never dials on its own: this dialog is the
 * deliberate step between the click and a real phone ringing. It offers the
 * two Callified modes side by side —
 *
 *   🤖 AI Call     → Callified's AI agent handles the conversation.
 *   👤 Manual Call → the staff member speaks, bridged through the browser.
 *
 * Both modes need a Callified campaign (it carries the voice + script
 * settings), so the picker is shared. Everything is disabled while a call is
 * in flight, and `placingRef` is a second, synchronous guard so a double
 * click cannot get two requests out before React re-renders.
 *
 * The dialog is endpoint-agnostic: callers pass the four URLs for their
 * surface, so the same component serves the wellness Appointments page today
 * and any other module that grows a call button later.
 *
 * Props:
 *   customer   { name, phone, subtitle }
 *   endpoints  { context, campaigns, aiCall, manualCall }
 *   onClose    close the dialog
 *   onCalled   (result) => void — fired after a call is successfully placed
 *   onViewHistory (contactId) => void — optional "view call history" action
 */
export default function CallifiedCallDialog({
  customer,
  endpoints,
  onClose,
  onCalled,
  onViewHistory,
}) {
  const notify = useNotify();
  const placingRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [context, setContext] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');

  const [mode, setMode] = useState(null); // 'ai' | 'manual'
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null); // { ok, mode, ...payload } | { ok:false, error }
  const [manualCall, setManualCall] = useState(null);

  const placing = Boolean(progress);
  const callPlaced = Boolean(result?.ok);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');

    Promise.all([
      fetchApi(endpoints.context, { silent: true }),
      fetchApi(endpoints.campaigns, { silent: true }),
    ])
      .then(([ctx, campaignRes]) => {
        if (cancelled) return;
        setContext(ctx || null);
        const list = Array.isArray(campaignRes?.campaigns) ? campaignRes.campaigns : [];
        setCampaigns(list);
        // Prefer an active campaign; with exactly one option there is nothing
        // to choose, so preselect it and save the user a click.
        const active = list.filter((c) => !c.status || c.status === 'active');
        const preferred = active.length === 1 ? active[0] : list.length === 1 ? list[0] : null;
        if (preferred) setSelectedCampaignId(String(preferred.id));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err?.message || 'Failed to load calling details');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [endpoints.context, endpoints.campaigns]);

  const phoneValid = context ? context.phoneValid !== false : Boolean(customer?.phone);
  const displayPhone = context?.phone || customer?.phone || '';
  const displayName = context?.patientName || customer?.name || 'this customer';

  const canCall = phoneValid && Boolean(selectedCampaignId) && !placing && !callPlaced;

  const placeCall = useCallback(
    async (nextMode) => {
      // Synchronous latch: React state has not re-rendered yet on a fast
      // double click, so `placing` alone would let a second request through.
      if (placingRef.current || callPlaced) return;
      if (!selectedCampaignId) {
        notify.error('Select a Callified campaign first');
        return;
      }
      if (!phoneValid) {
        notify.error('This customer has no valid phone number');
        return;
      }

      placingRef.current = true;
      setMode(nextMode);
      setResult(null);
      setProgress('Syncing customer with Callified…');

      try {
        // Manual calls open the microphone BEFORE the call is placed.
        // Callified dials the customer the instant the request succeeds, and
        // the only way to hang that leg up is a hangup frame over the agent
        // WebSocket — which cannot exist if the microphone never opened. Check
        // first and a machine with no microphone never rings the customer at
        // all, instead of leaving them on a live line hearing silence.
        if (nextMode === 'manual') {
          setProgress('Checking your microphone…');
          await probeMicrophone();
        }

        setProgress(
          nextMode === 'ai' ? 'Starting AI call…' : 'Connecting manual call…',
        );
        const res = await fetchApi(
          nextMode === 'ai' ? endpoints.aiCall : endpoints.manualCall,
          {
            method: 'POST',
            body: JSON.stringify({ campaignId: Number(selectedCampaignId) }),
            silent: true,
          },
        );

        setResult({ ok: true, mode: nextMode, ...res });
        if (nextMode === 'manual') {
          setManualCall({
            callSid: res.callSid,
            bridgeTicket: res.bridgeTicket,
            bridgePath: res.bridgePath,
          });
          notify.success('Manual call initiated successfully');
        } else {
          notify.success(`AI call initiated for ${displayName}`);
        }
        onCalled?.(res);
      } catch (err) {
        const message = err?.message || 'Failed to initiate call';
        setResult({ ok: false, mode: nextMode, error: message });
        notify.error(message);
      } finally {
        placingRef.current = false;
        setProgress('');
      }
    },
    [
      callPlaced,
      selectedCampaignId,
      phoneValid,
      notify,
      endpoints.aiCall,
      endpoints.manualCall,
      displayName,
      onCalled,
    ],
  );

  const campaignOptions = useMemo(
    () =>
      campaigns.map((c) => ({
        id: String(c.id),
        label: `${c.name || `Campaign ${c.id}`}${c.product_name ? ` — ${c.product_name}` : ''}`,
      })),
    [campaigns],
  );

  const historyContactId = result?.contactId || context?.contactId || null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call ${displayName}`}
      data-testid="callified-call-dialog"
      onClick={(e) => {
        // A live manual call must be hung up deliberately, not by a stray
        // click on the backdrop.
        if (e.target === e.currentTarget && !manualCall) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1002,
        padding: '1rem',
      }}
    >
      <div
        className="glass"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '90vh',
          overflowY: 'auto',
          borderRadius: 12,
          padding: '1.5rem',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '1rem',
            marginBottom: '0.75rem',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h3
              style={{
                margin: 0,
                fontSize: '1.05rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.45rem',
              }}
            >
              {/* --accent-color, NOT --primary-color: under the wellness
                  theme --primary-color is #1F2220 charcoal in BOTH light and
                  dark (it is the sidebar/hero background), so using it as a
                  foreground renders invisible on dark. --accent-color is a
                  real accent and is redefined per mode. */}
              <Phone size={18} style={{ color: 'var(--accent-color)' }} />
              Call Customer
            </h3>
            <div
              style={{
                fontSize: '0.85rem',
                color: 'var(--text-secondary)',
                marginTop: '0.25rem',
              }}
            >
              {displayName}
              {displayPhone ? ` · ${displayPhone}` : ''}
              {customer?.subtitle ? ` · ${customer.subtitle}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            data-testid="callified-call-dialog-close"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary)',
            }}
          >
            <X size={20} />
          </button>
        </div>

        {manualCall ? (
          <CallifiedManualCallPanel
            call={manualCall}
            customerName={displayName}
            customerPhone={displayPhone}
            onEnded={() => {
              /* the panel renders its own ended state; nothing to unwind here */
            }}
          />
        ) : loading ? (
          <div style={loaderRow} data-testid="callified-call-dialog-loading">
            <Loader size={18} style={{ animation: 'spin 1s linear infinite' }} />
            Loading campaigns…
          </div>
        ) : loadError ? (
          <div style={{ ...loaderRow, color: '#ef4444' }} role="alert">
            <AlertCircle size={18} /> {loadError}
          </div>
        ) : !phoneValid ? (
          <div style={{ ...loaderRow, color: '#f59e0b' }} role="alert" data-testid="callified-call-dialog-no-phone">
            <AlertCircle size={18} />
            This customer has no valid phone number on file, so they cannot be called.
          </div>
        ) : campaigns.length === 0 ? (
          <div style={{ ...loaderRow, color: 'var(--text-secondary)' }}>
            <AlertCircle size={18} />
            No Callified campaigns found. Create one in Callified before placing calls.
          </div>
        ) : (
          <>
            <label style={fieldLabel}>
              Callified campaign
              <select
                className="input-field"
                value={selectedCampaignId}
                onChange={(e) => setSelectedCampaignId(e.target.value)}
                disabled={placing || callPlaced}
                data-testid="callified-call-dialog-campaign"
                style={{ width: '100%' }}
              >
                <option value="">Select a campaign…</option>
                {campaignOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <div style={{ display: 'grid', gap: '0.6rem', margin: '1rem 0' }}>
              <CallModeCard
                testId="callified-call-mode-ai"
                icon={<Bot size={20} />}
                emoji="🤖"
                title="AI Call"
                description="Let the AI agent call and handle the conversation."
                busy={placing && mode === 'ai'}
                busyLabel={progress}
                disabled={!canCall}
                onClick={() => placeCall('ai')}
              />
              <CallModeCard
                testId="callified-call-mode-manual"
                icon={<User size={20} />}
                emoji="👤"
                title="Manual Call"
                description="Start a human-assisted browser call and speak to the customer yourself."
                busy={placing && mode === 'manual'}
                busyLabel={progress}
                disabled={!canCall}
                onClick={() => placeCall('manual')}
              />
            </div>

            {!selectedCampaignId && (
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                Pick a campaign to enable calling.
              </div>
            )}

            {result && (
              <div
                role="status"
                data-testid="callified-call-dialog-result"
                style={{
                  padding: '0.75rem 0.9rem',
                  borderRadius: 8,
                  marginTop: '0.9rem',
                  fontSize: '0.85rem',
                  display: 'flex',
                  gap: '0.5rem',
                  alignItems: 'flex-start',
                  background: result.ok ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                  border: `1px solid ${result.ok ? '#10b981' : '#ef4444'}`,
                  color: result.ok ? '#10b981' : '#ef4444',
                }}
              >
                {result.ok ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
                <span>
                  {result.ok
                    ? `Call initiated successfully. Callified lead #${result.callifiedLeadId}. The transcript and AI review appear in call history once the call ends.`
                    : result.error}
                </span>
              </div>
            )}
          </>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.75rem',
            marginTop: '1.1rem',
            flexWrap: 'wrap',
          }}
        >
          {onViewHistory && historyContactId ? (
            <button
              type="button"
              onClick={() => onViewHistory(historyContactId)}
              className="btn-secondary"
              data-testid="callified-call-dialog-history"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: '0.55rem 0.9rem',
              }}
            >
              <FileText size={15} /> Call history
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
            disabled={placing}
            style={{ padding: '0.55rem 1rem' }}
          >
            {/* Closing unmounts the live-call panel, whose cleanup hangs up.
                Say so rather than letting the button read as a no-op escape. */}
            {manualCall ? 'Hang up & close' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CallModeCard({ testId, icon, emoji, title, description, busy, busyLabel, disabled, onClick }) {
  const inactive = disabled || busy;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inactive}
      data-testid={testId}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.75rem',
        textAlign: 'left',
        width: '100%',
        padding: '0.85rem 1rem',
        borderRadius: 10,
        border: '1px solid var(--border-color)',
        background: 'var(--subtle-bg-2, transparent)',
        color: 'inherit',
        cursor: inactive ? 'not-allowed' : 'pointer',
        opacity: disabled && !busy ? 0.55 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 36,
          height: 36,
          borderRadius: 9,
          flexShrink: 0,
          // Accent-tinted chip. --subtle-bg-3 is defined in both themes and
          // both modes; the hard-coded indigo it replaced clashed with the
          // wellness gold and washed out on dark.
          background: 'var(--subtle-bg-3, rgba(99,102,241,0.12))',
          color: 'var(--accent-color)',
        }}
      >
        {busy ? <Loader size={18} style={{ animation: 'spin 1s linear infinite' }} /> : icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600 }}>
          <span aria-hidden="true" style={{ marginRight: '0.35rem' }}>
            {emoji}
          </span>
          {title}
        </span>
        <span
          style={{
            display: 'block',
            fontSize: '0.8rem',
            color: 'var(--text-secondary)',
            marginTop: '0.15rem',
          }}
        >
          {busy ? busyLabel : description}
        </span>
      </span>
    </button>
  );
}

const loaderRow = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  padding: '1rem 0',
  color: 'var(--text-secondary)',
  fontSize: '0.88rem',
};

const fieldLabel = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  fontSize: '0.78rem',
  color: 'var(--text-secondary)',
};
