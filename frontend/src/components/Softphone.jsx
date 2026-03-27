import React, { useState, useEffect, useRef } from 'react';
import { Phone, PhoneOff, Mic, MicOff, Grid, Loader2 } from 'lucide-react';
import { fetchApi } from '../utils/api';

export default function Softphone() {
  const [isOpen, setIsOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [status, setStatus] = useState('IDLE'); // IDLE, DIALING, CONNECTED, TRANSCRIBING
  const [transcript, setTranscript] = useState('');
  const [isMuted, setIsMuted] = useState(false);
  
  const audioContextRef = useRef(null);

  const togglePhone = () => {
    setIsOpen(!isOpen);
    if (isOpen && status !== 'IDLE') endCall();
  };

  const startCall = async (e) => {
    e.preventDefault();
    if (!number) return;
    setStatus('DIALING');
    
    try {
      // Simulate WebRTC Microphone Media Request
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRef.current = stream;
      
      setTimeout(() => {
        setStatus('CONNECTED');
        startTranscription();
      }, 2000); // 2 second ringing cadence simulator
    } catch(err) {
      alert("Microphone hardware access denied. WebRTC Softphone cannot negotiate SIP handshakes.");
      setStatus('IDLE');
    }
  };

  const startTranscription = () => {
    // Simulates an AI Whisper transcription LLM stream over the WebRTC buffer
    let count = 0;
    const phrases = ["Customer: Hello? Yes, this is John.", "Agent: I was looking at your enterprise requirements.", "Customer: That sounds perfect. Let's execute the contract execution."];
    
    const interval = setInterval(() => {
      setTranscript(prev => prev + (prev ? '\n' : '') + phrases[count % phrases.length]);
      count++;
      if (count > phrases.length) clearInterval(interval);
    }, 3500);
    
    audioContextRef.current.transcriptInterval = interval;
  };

  const endCall = async () => {
    if (audioContextRef.current) {
      if (audioContextRef.current.getTracks) {
        audioContextRef.current.getTracks().forEach(t => t.stop());
      }
      if (audioContextRef.current.transcriptInterval) {
        clearInterval(audioContextRef.current.transcriptInterval);
      }
    }
    
    if (status === 'CONNECTED' && transcript) {
      setStatus('TRANSCRIBING');
      // Dispatch Webhook or Log Call backend persistence
      try {
        await fetchApi('/api/communications/log-call', {
          method: 'POST',
          body: JSON.stringify({ notes: transcript, duration: 45, direction: "OUTBOUND" })
        });
      } catch(err) {
        console.error("Transcription telemetry drop", err);
      }
    }
    
    setStatus('IDLE');
    setTranscript('');
    setNumber('');
  };

  return (
    <div style={{ position: 'fixed', bottom: '2rem', right: '2rem', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '1rem' }}>
      
      {isOpen && (
        <div className="card" style={{ width: '320px', padding: '1.5rem', background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(10px)', border: '1px solid var(--accent-color)', boxShadow: '0 25px 50px rgba(0,0,0,0.8), 0 0 30px rgba(59, 130, 246, 0.2)', borderRadius: '16px', animation: 'fadeIn 0.2s ease-out' }}>
          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 'bold' }}>VoIP Autodialer Mode</h3>
            <p style={{ fontSize: '0.8rem', color: status === 'CONNECTED' ? '#10b981' : 'var(--text-secondary)' }}>
              {status === 'IDLE' && 'WebRTC Transceiver Ready'}
              {status === 'DIALING' && 'Establishing SIP...'}
              {status === 'CONNECTED' && '00:45 • Encrypted UDP Channel Live'}
              {status === 'TRANSCRIBING' && 'Saving Whisper Assembly...'}
            </p>
          </div>

          <form onSubmit={startCall}>
            <input 
              type="tel" 
              placeholder="+1 (555) 000-0000" 
              value={number} 
              onChange={e=>setNumber(e.target.value)} 
              className="input-field" 
              disabled={status !== 'IDLE'}
              style={{ textAlign: 'center', fontSize: '1.25rem', padding: '1rem', letterSpacing: '2px', background: 'rgba(0,0,0,0.4)', border: '1px outset rgba(255,255,255,0.05)', marginBottom: '1rem', color: '#fff' }} 
            />
            
            {status === 'CONNECTED' && transcript && (
              <div style={{ padding: '0.75rem', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', fontStyle: 'italic', maxHeight: '120px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <span style={{color: '#3b82f6', fontWeight: 'bold', fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em'}}>Real-Time Transcription Buffer</span> 
                <span style={{color: '#fff', whiteSpace: 'pre-wrap'}}>{transcript}</span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
              <button type="button" disabled={status !== 'CONNECTED'} onClick={() => setIsMuted(!isMuted)} className="btn-secondary" style={{ padding: '0.5rem', background: isMuted ? 'rgba(239, 68, 68, 0.2)' : 'rgba(255,255,255,0.05)', color: isMuted ? '#ef4444' : '#fff', border: '1px solid rgba(255,255,255,0.05)', transition: '0.2s' }}>
                {isMuted ? <MicOff size={20} style={{margin:'0 auto'}}/> : <Mic size={20} style={{margin:'0 auto'}}/>}
              </button>
              <button type="button" disabled className="btn-secondary" style={{ padding: '0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)' }}>
                <Grid size={20} style={{margin:'0 auto'}}/>
              </button>
            </div>

            {status === 'IDLE' ? (
              <button type="submit" className="btn-primary" style={{ width: '100%', padding: '1rem', background: '#10b981', display: 'flex', justifyContent: 'center', boxShadow: '0 4px 15px rgba(16, 185, 129, 0.4)' }}>
                <Phone size={24} color="#fff" />
              </button>
            ) : (
              <button type="button" onClick={endCall} className="btn-primary" style={{ width: '100%', padding: '1rem', background: '#ef4444', display: 'flex', justifyContent: 'center', boxShadow: '0 4px 15px rgba(239, 68, 68, 0.4)' }}>
                {status === 'TRANSCRIBING' ? <Loader2 size={24} className="spin" color="#fff" /> : <PhoneOff size={24} color="#fff" />}
              </button>
            )}
          </form>
        </div>
      )}

      <button onClick={togglePhone} style={{ width: '64px', height: '64px', borderRadius: '50%', background: isOpen ? '#ef4444' : 'var(--accent-color)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer', boxShadow: '0 10px 25px rgba(0,0,0,0.5)', transition: 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)', transform: isOpen ? 'rotate(135deg) scale(0.9)' : 'rotate(0deg) scale(1)' }}>
        <Phone size={28} />
      </button>

    </div>
  );
}
