import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Loader, AlertCircle, PhoneCall, CheckCircle2 } from 'lucide-react';
import CallifiedAgentBridge, { BRIDGE_STATE } from '../utils/callifiedAgentBridge';

/**
 * Live call surface for a Callified manual (human) call.
 *
 * Owns the agent bridge for its lifetime: it opens the microphone and the
 * relay socket on mount, renders dialing → connecting → live → ended, and
 * tears everything down on unmount so a closed dialog can never leave a hot
 * microphone or an open socket behind.
 *
 * Props:
 *   call          { callSid, bridgeTicket, bridgePath } from the manual-call API
 *   customerName  who the agent is talking to
 *   customerPhone the number Callified dialed
 *   onEnded       called once the call is over (any reason)
 */
export default function CallifiedManualCallPanel({
  call,
  customerName,
  customerPhone,
  onEnded,
}) {
  const bridgeRef = useRef(null);
  const onEndedRef = useRef(onEnded);
  const [state, setState] = useState(BRIDGE_STATE.IDLE);
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(false);
  const [liveSince, setLiveSince] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  // One bridge per mounted panel. Keyed on callSid so a second call in the
  // same dialog always gets a fresh audio graph.
  useEffect(() => {
    let cancelled = false;

    const bridge = new CallifiedAgentBridge({
      callSid: call.callSid,
      ticket: call.bridgeTicket,
      bridgePath: call.bridgePath,
      onState: (next) => {
        if (cancelled) return;
        setState(next);
        if (next === BRIDGE_STATE.LIVE) setLiveSince((prev) => prev || Date.now());
        if (next === BRIDGE_STATE.ENDED || next === BRIDGE_STATE.ERROR) {
          onEndedRef.current?.(next);
        }
      },
      onError: (message) => {
        if (!cancelled) setError(message);
      },
    });
    bridgeRef.current = bridge;

    bridge.start().catch((e) => {
      if (cancelled) return;
      setError(e?.message || 'Could not start the call.');
      setState(BRIDGE_STATE.ERROR);
      onEndedRef.current?.(BRIDGE_STATE.ERROR);
    });

    return () => {
      cancelled = true;
      bridge.stop({ silent: true });
      bridgeRef.current = null;
    };
  }, [call.callSid, call.bridgeTicket, call.bridgePath]);

  useEffect(() => {
    if (!liveSince || state !== BRIDGE_STATE.LIVE) return undefined;
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - liveSince) / 1000)), 1000);
    return () => clearInterval(id);
  }, [liveSince, state]);

  const toggleMute = useCallback(() => {
    if (!bridgeRef.current) return;
    setMuted(bridgeRef.current.setMuted(!muted));
  }, [muted]);

  const hangUp = useCallback(() => {
    bridgeRef.current?.stop();
  }, []);

  const status = useMemo(() => STATUS_COPY[state] || STATUS_COPY[BRIDGE_STATE.IDLE], [state]);
  const finished = state === BRIDGE_STATE.ENDED || state === BRIDGE_STATE.ERROR;
  const busy =
    state === BRIDGE_STATE.REQUESTING_MIC ||
    state === BRIDGE_STATE.CONNECTING ||
    state === BRIDGE_STATE.RINGING;

  return (
    <div data-testid="callified-manual-call-panel">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.9rem 1rem',
          borderRadius: 10,
          border: `1px solid ${status.color}44`,
          background: `${status.color}14`,
          marginBottom: '1rem',
        }}
      >
        <span style={{ color: status.color, display: 'flex', alignItems: 'center' }}>
          {busy ? (
            <Loader size={20} style={{ animation: 'spin 1s linear infinite' }} />
          ) : state === BRIDGE_STATE.ERROR ? (
            <AlertCircle size={20} />
          ) : state === BRIDGE_STATE.ENDED ? (
            <CheckCircle2 size={20} />
          ) : (
            <PhoneCall size={20} />
          )}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, color: status.color }} data-testid="callified-manual-call-status">
            {status.label}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {error || status.hint}
          </div>
        </div>
        {state === BRIDGE_STATE.LIVE && (
          <div
            style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '0.95rem' }}
            data-testid="callified-manual-call-timer"
          >
            {formatElapsed(elapsed)}
          </div>
        )}
      </div>

      <div
        style={{
          padding: '0.75rem 1rem',
          borderRadius: 10,
          border: '1px solid var(--border-color)',
          marginBottom: '1rem',
        }}
      >
        <div style={{ fontWeight: 600 }}>{customerName || 'Customer'}</div>
        {customerPhone && (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{customerPhone}</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={toggleMute}
          className="btn-secondary"
          disabled={finished || state !== BRIDGE_STATE.LIVE}
          data-testid="callified-manual-call-mute"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 1rem' }}
        >
          {muted ? <MicOff size={16} /> : <Mic size={16} />}
          {muted ? 'Unmute' : 'Mute'}
        </button>
        <button
          type="button"
          onClick={hangUp}
          disabled={finished}
          data-testid="callified-manual-call-hangup"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.6rem 1.1rem',
            borderRadius: 8,
            border: 'none',
            fontWeight: 600,
            cursor: finished ? 'not-allowed' : 'pointer',
            background: finished ? 'var(--subtle-bg-3)' : '#ef4444',
            color: finished ? 'var(--text-secondary)' : '#fff',
          }}
        >
          <PhoneOff size={16} /> {finished ? 'Call ended' : 'Hang up'}
        </button>
      </div>
    </div>
  );
}

const STATUS_COPY = {
  [BRIDGE_STATE.IDLE]: {
    label: 'Preparing call…',
    hint: 'Setting up the audio bridge.',
    color: 'var(--text-secondary)',
  },
  [BRIDGE_STATE.REQUESTING_MIC]: {
    label: 'Waiting for microphone…',
    hint: 'Allow microphone access so you can speak to the customer.',
    color: '#f59e0b',
  },
  [BRIDGE_STATE.CONNECTING]: {
    label: 'Connecting manual call…',
    hint: 'Opening the audio bridge to Callified.',
    color: '#f59e0b',
  },
  [BRIDGE_STATE.RINGING]: {
    label: 'Dialing customer…',
    hint: 'Callified is placing the call. Stay on this screen.',
    color: '#3b82f6',
  },
  [BRIDGE_STATE.LIVE]: {
    label: 'Call connected',
    hint: 'You are live with the customer.',
    color: '#10b981',
  },
  [BRIDGE_STATE.ENDING]: {
    label: 'Ending call…',
    hint: 'Closing the audio bridge.',
    color: 'var(--text-secondary)',
  },
  [BRIDGE_STATE.ENDED]: {
    label: 'Call ended',
    hint: 'The transcript and recording appear in call history once Callified finishes processing.',
    color: '#10b981',
  },
  [BRIDGE_STATE.ERROR]: {
    label: 'Call failed',
    hint: 'The call could not be connected.',
    color: '#ef4444',
  },
};

function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
