import React, { useState, useEffect } from 'react';
import { useCallMonitor, useAudioPlayer, decodePcm16Base64, decodeUlawBase64, isAudio } from '@/lib/socket';
import { Headphones, Copy, Check, AlertCircle, Wifi, WifiOff, Radio } from 'lucide-react';

export default function CallMonitor() {
  const [streamSid, setStreamSid] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [whisperText, setWhisperText] = useState('');
  const [copied, setCopied] = useState(false);

  const { status, error, transcripts, lastAudio, send } = useCallMonitor(streamSid);
  const play = useAudioPlayer();

  useEffect(() => {
    if (!lastAudio || !isAudio(lastAudio)) return;
    const samples = lastAudio.format === 'pcm16_8k'
      ? decodePcm16Base64(lastAudio.payload)
      : decodeUlawBase64(lastAudio.payload);
    play(samples);
  }, [lastAudio, play]);

  const handleConnect = () => {
    if (inputValue.trim()) {
      setStreamSid(inputValue.trim());
    }
  };

  const handleDisconnect = () => {
    setStreamSid('');
    setInputValue('');
  };

  const handleCopySid = () => {
    if (streamSid) {
      navigator.clipboard.writeText(streamSid);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSendWhisper = () => {
    if (whisperText.trim() && status === 'connected') {
      send({ action: 'whisper', text: whisperText });
      setWhisperText('');
    }
  };

  const handleTakeover = () => {
    if (status === 'connected') {
      send({ action: 'takeover' });
    }
  };

  const statusColors = {
    idle: '#999',
    connecting: '#ff9800',
    connected: '#4caf50',
    reconnecting: '#ff9800',
    error: '#f44336',
    disconnected: '#999',
  };

  const statusLabels = {
    idle: 'Not Connected',
    connecting: 'Connecting...',
    connected: 'Connected',
    reconnecting: 'Reconnecting...',
    error: 'Error',
    disconnected: 'Disconnected',
  };

  return (
    <main style={{ padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
          <Headphones size={28} />
          Live Call Monitor
        </h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
          Connect to a live call to monitor transcripts, listen to audio, and control the AI.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '2rem' }}>
        {/* Left: Connection Panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {/* Connection Card */}
          <div
            style={{
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '1.5rem',
              backgroundColor: 'var(--bg-secondary)',
            }}
          >
            <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem', fontWeight: 600 }}>Connection</h2>

            {/* Status */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div
                  style={{
                    width: '12px',
                    height: '12px',
                    borderRadius: '50%',
                    backgroundColor: statusColors[status],
                    animation: status === 'connecting' || status === 'reconnecting' ? 'pulse 1.5s infinite' : 'none',
                  }}
                />
                <span style={{ fontWeight: 500, fontSize: '0.95rem' }}>
                  {statusLabels[status]}
                </span>
              </div>
              {error && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', color: '#f44336', fontSize: '0.85rem' }}>
                  <AlertCircle size={16} style={{ marginTop: '2px', flexShrink: 0 }} />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {/* Stream SID Input */}
            {!streamSid ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <label style={{ fontSize: '0.9rem', fontWeight: 500 }}>Stream SID / Call SID</label>
                <input
                  type="text"
                  placeholder="Enter stream SID or call SID..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleConnect()}
                  style={{
                    padding: '0.75rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    fontSize: '0.9rem',
                    fontFamily: 'inherit',
                    backgroundColor: 'var(--bg-primary)',
                    color: 'var(--text-primary)',
                  }}
                />
                <button
                  onClick={handleConnect}
                  disabled={!inputValue.trim()}
                  style={{
                    padding: '0.75rem 1rem',
                    backgroundColor: 'var(--accent-color)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    fontWeight: 500,
                    cursor: inputValue.trim() ? 'pointer' : 'not-allowed',
                    opacity: inputValue.trim() ? 1 : 0.6,
                    fontSize: '0.9rem',
                    transition: 'all 0.2s ease',
                  }}
                >
                  Connect
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', textTransform: 'uppercase', fontWeight: 600 }}>
                    Connected SID
                  </label>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.75rem',
                      backgroundColor: 'var(--bg-primary)',
                      borderRadius: '8px',
                      marginTop: '0.5rem',
                      fontFamily: 'monospace',
                      fontSize: '0.85rem',
                      wordBreak: 'break-all',
                    }}
                  >
                    <span style={{ flex: 1 }}>{streamSid}</span>
                    <button
                      onClick={handleCopySid}
                      style={{
                        padding: '0.5rem',
                        backgroundColor: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'var(--accent-color)',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      title="Copy SID"
                    >
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                    </button>
                  </div>
                </div>
                <button
                  onClick={handleDisconnect}
                  style={{
                    padding: '0.75rem 1rem',
                    backgroundColor: '#f44336',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    transition: 'all 0.2s ease',
                  }}
                >
                  Disconnect
                </button>
              </div>
            )}
          </div>

          {/* Controls Card */}
          {streamSid && (
            <div
              style={{
                border: '1px solid var(--border-color)',
                borderRadius: '12px',
                padding: '1.5rem',
                backgroundColor: 'var(--bg-secondary)',
              }}
            >
              <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem', fontWeight: 600 }}>Actions</h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Whisper */}
                <div>
                  <label style={{ fontSize: '0.9rem', fontWeight: 500, display: 'block', marginBottom: '0.5rem' }}>
                    Whisper to AI
                  </label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      placeholder="Send a hint to the AI..."
                      value={whisperText}
                      onChange={(e) => setWhisperText(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleSendWhisper()}
                      disabled={status !== 'connected'}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        borderRadius: '8px',
                        border: '1px solid var(--border-color)',
                        fontSize: '0.9rem',
                        fontFamily: 'inherit',
                        backgroundColor: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                        opacity: status === 'connected' ? 1 : 0.6,
                      }}
                    />
                    <button
                      onClick={handleSendWhisper}
                      disabled={!whisperText.trim() || status !== 'connected'}
                      style={{
                        padding: '0.75rem 1.25rem',
                        backgroundColor: 'var(--accent-color)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '8px',
                        fontWeight: 500,
                        cursor: whisperText.trim() && status === 'connected' ? 'pointer' : 'not-allowed',
                        opacity: whisperText.trim() && status === 'connected' ? 1 : 0.6,
                        fontSize: '0.9rem',
                        whiteSpace: 'nowrap',
                        transition: 'all 0.2s ease',
                      }}
                    >
                      Send
                    </button>
                  </div>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                    The AI sees this hint but the caller doesn't hear it.
                  </p>
                </div>

                {/* Takeover */}
                <div>
                  <button
                    onClick={handleTakeover}
                    disabled={status !== 'connected'}
                    style={{
                      width: '100%',
                      padding: '0.875rem 1rem',
                      backgroundColor: status === 'connected' ? '#ff9800' : '#ccc',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '8px',
                      fontWeight: 500,
                      cursor: status === 'connected' ? 'pointer' : 'not-allowed',
                      fontSize: '0.95rem',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    Take Over Call
                  </button>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
                    Disable the AI. You can then speak directly to the caller.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right: Transcript Panel */}
        <div
          style={{
            border: '1px solid var(--border-color)',
            borderRadius: '12px',
            padding: '1.5rem',
            backgroundColor: 'var(--bg-secondary)',
            display: 'flex',
            flexDirection: 'column',
            maxHeight: '700px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.1rem', fontWeight: 600, flex: 1 }}>
              Transcript
            </h2>
            {streamSid && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontSize: '0.85rem',
                  color: 'var(--text-secondary)',
                }}
              >
                <Radio size={14} />
                <span>{transcripts.length} lines</span>
              </div>
            )}
          </div>

          {!streamSid ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                textAlign: 'center',
              }}
            >
              <p>Connect to a call to view transcripts</p>
            </div>
          ) : transcripts.length === 0 ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-secondary)',
                textAlign: 'center',
              }}
            >
              <p>Waiting for speech...</p>
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              {transcripts.slice(-200).map((t, i) => (
                <div
                  key={i}
                  style={{
                    padding: '0.875rem',
                    borderRadius: '8px',
                    backgroundColor: t.role === 'user' ? 'rgba(63, 81, 181, 0.1)' : 'rgba(76, 175, 80, 0.1)',
                    borderLeft: `3px solid ${t.role === 'user' ? '#3f51b5' : '#4caf50'}`,
                  }}
                >
                  <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.25rem', color: t.role === 'user' ? '#3f51b5' : '#4caf50' }}>
                    {t.role === 'user' ? '👤 Caller' : '🤖 AI'}
                  </div>
                  <div style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>{t.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </main>
  );
}
