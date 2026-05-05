import { useEffect, useRef } from 'react';

export function useAudioPlayer() {
  const ctxRef = useRef(null);
  const nextTimeRef = useRef(0);

  useEffect(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext({ sampleRate: 48000 });
    ctxRef.current = ctx;
    nextTimeRef.current = ctx.currentTime;
    return () => {
      ctx.close();
    };
  }, []);

  function play(samples8k) {
    const ctx = ctxRef.current;
    if (!ctx) return;

    const up = new Float32Array(samples8k.length * 6);
    for (let i = 0; i < up.length; i++) up[i] = samples8k[Math.floor(i / 6)];

    const buf = ctx.createBuffer(1, up.length, 48000);
    buf.getChannelData(0).set(up);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    if (ctx.currentTime > nextTimeRef.current) {
      nextTimeRef.current = ctx.currentTime;
    }
    src.start(nextTimeRef.current);
    nextTimeRef.current += buf.duration;
  }

  return play;
}
