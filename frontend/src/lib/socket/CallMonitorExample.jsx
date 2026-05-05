import React, { useEffect } from 'react';
import { useCallMonitor } from './useCallMonitor';
import { useAudioPlayer } from './useAudioPlayer';
import { decodePcm16Base64, decodeUlawBase64 } from './audio';
import { isAudio } from './types';

export function CallMonitorExample({ streamSid }) {
  const { status, error, transcripts, lastAudio, send } =
    useCallMonitor(streamSid);
  const play = useAudioPlayer();

  useEffect(() => {
    if (!lastAudio || !isAudio(lastAudio)) return;
    const samples =
      lastAudio.format === 'pcm16_8k'
        ? decodePcm16Base64(lastAudio.payload)
        : decodeUlawBase64(lastAudio.payload);
    play(samples);
  }, [lastAudio, play]);

  return (
    <div style={{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h3>Call Monitor</h3>
      <div style={{ marginBottom: '1rem', fontSize: '0.9rem' }}>
        <strong>Status:</strong> {status}
        {error && <span style={{ color: 'red', marginLeft: '0.5rem' }}>— {error}</span>}
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <div style={{ marginBottom: '0.5rem' }}>
          <button
            onClick={() =>
              send({
                action: 'whisper',
                text: 'Test whisper from monitor',
              })
            }
            disabled={status !== 'connected'}
          >
            Send Whisper
          </button>
          <button
            onClick={() => send({ action: 'takeover' })}
            disabled={status !== 'connected'}
            style={{ marginLeft: '0.5rem' }}
          >
            Takeover
          </button>
        </div>
      </div>

      <div
        style={{
          maxHeight: '300px',
          overflowY: 'auto',
          backgroundColor: '#f5f5f5',
          padding: '0.5rem',
          borderRadius: '4px',
        }}
      >
        <h4>Transcripts ({transcripts.length})</h4>
        {transcripts.length === 0 ? (
          <p style={{ color: '#999' }}>Waiting for transcripts...</p>
        ) : (
          <div>
            {transcripts.map((t, i) => (
              <div
                key={i}
                style={{
                  marginBottom: '0.5rem',
                  padding: '0.5rem',
                  backgroundColor: t.role === 'user' ? '#e3f2fd' : '#f3e5f5',
                  borderRadius: '4px',
                  fontSize: '0.9rem',
                }}
              >
                <strong>{t.role}:</strong> {t.text}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
