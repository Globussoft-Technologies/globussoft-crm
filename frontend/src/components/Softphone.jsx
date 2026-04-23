import React, { useState, useRef } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Grid, Loader2, AlertTriangle } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Softphone() {
  const [isOpen, setIsOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [contactId, setContactId] = useState('');
  // IDLE | INITIATED | RINGING | IN_PROGRESS | COMPLETED | FAILED | DEMO_DIALING | DEMO_CONNECTED
  const [status, setStatus] = useState('IDLE');
  const [transcript, setTranscript] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  const demoRefs = useRef({ stream: null, transcriptInterval: null });

  const togglePhone = () => {
    setIsOpen(o => !o);
    if (isOpen && status !== 'IDLE') endCall();
  };

  const startCall = async (e) => {
    e.preventDefault();
    if (!number) return;
    setErrorMsg('');
    setStatus('INITIATED');

    try {
      const resp = await fetchApi('/api/voice/call', {
        method: 'POST',
        body: JSON.stringify({
          to: number,
          contactId: contactId ? parseInt(contactId, 10) : undefined,
        }),
      });

      if (resp && resp.error === 'Twilio not configured') {
        // Fallback: original demo behaviour
        setDemoMode(true);
        await startDemoCall();
        return;
      }

      if (resp && resp.sessionId) {
        setSessionId(resp.sessionId);
        setStatus(resp.status || 'INITIATED');
        // Lightweight optimistic transition — real status arrives via webhook+poll
        setTimeout(() => {
          setStatus(prev => (prev === 'INITIATED' ? 'RINGING' : prev));
        }, 1200);
        setTimeout(() => {
          setStatus(prev => (prev === 'RINGING' ? 'IN_PROGRESS' : prev));
        }, 3500);
      } else {
        setErrorMsg(resp?.error || 'Call failed');
        setStatus('FAILED');
      }
    } catch (err) {
      console.error('voice/call error', err);
      setErrorMsg(err.message || 'Network error');
      setStatus('FAILED');
    }
  };

  // ─── Demo (fallback) call flow — only used when Twilio is not configured ───
  const startDemoCall = async () => {
    setStatus('DEMO_DIALING');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      demoRefs.current.stream = stream;
      setTimeout(() => {
        setStatus('DEMO_CONNECTED');
        startDemoTranscription();
      }, 2000);
    } catch (err) {
      setErrorMsg('Microphone access denied');
      setStatus('IDLE');
    }
  };

  const startDemoTranscription = () => {
    let count = 0;
    const phrases = [
      'Customer: Hello? Yes, this is John.',
      'Agent: I was looking at your enterprise requirements.',
      "Customer: That sounds perfect. Let's execute the contract.",
    ];
    const interval = setInterval(() => {
      setTranscript(prev => prev + (prev ? '\n' : '') + phrases[count % phrases.length]);
      count++;
      if (count > phrases.length) clearInterval(interval);
    }, 3500);
    demoRefs.current.transcriptInterval = interval;
  };

  const endCall = async () => {
    // Real Twilio session — ask backend to terminate
    if (sessionId && !demoMode) {
      try {
        await fetchApi(`/api/voice/end/${sessionId}`, { method: 'POST' });
      } catch (err) {
        console.error('voice/end error', err);
      }
      setStatus('COMPLETED');
      setTimeout(resetCall, 800);
      return;
    }

    // Demo cleanup
    const { stream, transcriptInterval } = demoRefs.current;
    if (stream && stream.getTracks) stream.getTracks().forEach(t => t.stop());
    if (transcriptInterval) clearInterval(transcriptInterval);
    demoRefs.current = { stream: null, transcriptInterval: null };

    if (status === 'DEMO_CONNECTED' && transcript) {
      try {
        await fetchApi('/api/communications/log-call', {
          method: 'POST',
          body: JSON.stringify({ notes: transcript, duration: 45, direction: 'OUTBOUND' }),
        });
      } catch (err) {
        console.error('log-call error', err);
      }
    }
    resetCall();
  };

  const resetCall = () => {
    setStatus('IDLE');
    setTranscript('');
    setNumber('');
    setContactId('');
    setSessionId(null);
    setIsMuted(false);
  };

  const isActive = status !== 'IDLE' && status !== 'COMPLETED' && status !== 'FAILED';

  const statusLine = () => {
    switch (status) {
      case 'IDLE': return demoMode ? 'Demo Ready' : 'Twilio Voice Ready';
      case 'INITIATED': return 'Initiating call...';
      case 'RINGING': return 'Ringing...';
      case 'IN_PROGRESS': return 'In Progress • Live';
      case 'COMPLETED': return 'Call ended';
      case 'FAILED': return errorMsg || 'Call failed';
      case 'DEMO_DIALING': return 'Demo: Establishing...';
      case 'DEMO_CONNECTED': return 'Demo: 00:45 • Encrypted';
      default: return status;
    }
  };

  return (
    <div style={{ position: 'fixed', bottom: '2rem', right: '2rem', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '1rem' }}>

      {isOpen && (
        <div className="card" style={{ width: '320px', padding: '1.5rem', background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(10px)', border: '1px solid var(--accent-color)', boxShadow: '0 25px 50px rgba(0,0,0,0.8), 0 0 30px rgba(59, 130, 246, 0.2)', borderRadius: '16px', animation: 'fadeIn 0.2s ease-out' }}>

          {demoMode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 0.75rem', background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.7rem', color: '#fbbf24' }}>
              <AlertTriangle size={14} />
              <span>Demo Mode — Configure Twilio in Channels &gt; Telephony for real calls</span>
            </div>
          )}

          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>VoIP Softphone</h3>
            <p style={{ fontSize: '0.8rem', color: status === 'IN_PROGRESS' || status === 'DEMO_CONNECTED' ? '#10b981' : status === 'FAILED' ? '#ef4444' : 'var(--text-secondary)' }}>
              {statusLine()}
            </p>
            {sessionId && (
              <p style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.25rem', fontFamily: 'monospace' }}>{sessionId}</p>
            )}
          </div>

          <form onSubmit={startCall}>
            <input
              type="tel"
              placeholder="+1 (555) 000-0000"
              value={number}
              onChange={e => setNumber(e.target.value)}
              className="input-field"
              disabled={isActive}
              style={{ textAlign: 'center', fontSize: '1.25rem', padding: '1rem', letterSpacing: '2px', background: 'rgba(0,0,0,0.4)', border: '1px outset rgba(255,255,255,0.05)', marginBottom: '0.5rem', color: '#fff' }}
            />
            <input
              type="number"
              placeholder="Contact ID (optional)"
              value={contactId}
              onChange={e => setContactId(e.target.value)}
              className="input-field"
              disabled={isActive}
              style={{ textAlign: 'center', fontSize: '0.75rem', padding: '0.5rem', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '1rem', color: '#fff' }}
            />

            {(status === 'DEMO_CONNECTED') && transcript && (
              <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', fontStyle: 'italic', maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={{ color: '#3b82f6', fontWeight: 'bold', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Demo Transcript</span>
                <span style={{ color: '#fff', whiteSpace: 'pre-wrap' }}>{transcript}</span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
              <button type="button" disabled={status !== 'IN_PROGRESS' && status !== 'DEMO_CONNECTED'} onClick={() => setIsMuted(!isMuted)} className="btn-secondary" style={{ padding: '0.5rem', background: isMuted ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.05)', color: isMuted ? '#ef4444' : '#fff', border: '1px solid rgba(255,255,255,0.05)', transition: '0.2s' }}>
                {isMuted ? <MicOff size={20} style={{ margin: '0 auto' }} /> : <Mic size={20} style={{ margin: '0 auto' }} />}
              </button>
              <button type="button" disabled className="btn-secondary" style={{ padding: '0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>
                <Grid size={20} style={{ margin: '0 auto' }} />
              </button>
            </div>

            {!isActive ? (
              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '1rem', background: '#10b981', display: 'flex', justifyContent: 'center', boxShadow: '0 4px 15px rgba(16, 185, 129, 0.4)' }}>
                <Phone size={24} color="#fff" />
              </button>
            ) : (
              <button type="button" onClick={endCall} className="btn-primary" style={{ width: '100%', padding: '1rem', background: '#ef4444', display: 'flex', justifyContent: 'center', boxShadow: '0 4px 15px rgba(239, 68, 68, 0.4)' }}>
                {status === 'COMPLETED' ? <Loader2 size={24} className="spin" color="#fff" /> : <PhoneOff size={24} color="#fff" />}
              </button>
            )}
          </form>
        </div>
      )}

      <button onClick={togglePhone} aria-label={isOpen ? 'Close softphone dialer' : 'Open softphone dialer'} aria-expanded={isOpen} style={{ width: '64px', height: '64px', borderRadius: '50%', background: isOpen ? '#ef4444' : 'var(--accent-color)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)', transform: isOpen ? 'rotate(135deg) scale(0.9)' : 'rotate(0deg) scale(1)' }}>
        <Phone size={28} />
      </button>

    </div>
  );
}
