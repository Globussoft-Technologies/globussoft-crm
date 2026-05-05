import { useEffect, useRef, useState, useCallback } from 'react';
import { WS_BASE } from './config';
import { isTranscript, isAudio, isError } from './types';

export function useCallMonitor(streamSidOrCallSid, opts = {}) {
  const {
    autoReconnect = true,
    maxReconnects = 5,
    initialBackoffMs = 1000,
  } = opts;

  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [transcripts, setTranscripts] = useState([]);
  const [lastAudio, setLastAudio] = useState(null);

  const wsRef = useRef(null);
  const reconnectsRef = useRef(0);
  const backoffTimerRef = useRef(null);
  const cancelledRef = useRef(false);

  const cleanupTimer = () => {
    if (backoffTimerRef.current) {
      clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (!streamSidOrCallSid || cancelledRef.current) return;
    setError(null);
    setStatus(reconnectsRef.current === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(
      `${WS_BASE}/ws/monitor/${encodeURIComponent(streamSidOrCallSid)}`,
    );
    wsRef.current = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      reconnectsRef.current = 0;
      setStatus('connected');
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (isError(msg)) {
        setError(msg.error);
        setStatus('error');
        ws.close();
        return;
      }
      if (isTranscript(msg)) {
        setTranscripts((prev) => [...prev, msg]);
        return;
      }
      if (isAudio(msg)) {
        setLastAudio(msg);
        return;
      }
    };

    ws.onerror = () => {
      if (!opened) setError('Connection failed');
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (cancelledRef.current) {
        setStatus('disconnected');
        return;
      }
      if (autoReconnect && reconnectsRef.current < maxReconnects && opened) {
        const delay = initialBackoffMs * Math.pow(2, reconnectsRef.current);
        reconnectsRef.current += 1;
        setStatus('reconnecting');
        backoffTimerRef.current = setTimeout(connect, delay);
      } else {
        setStatus('disconnected');
      }
    };
  }, [streamSidOrCallSid, autoReconnect, maxReconnects, initialBackoffMs]);

  useEffect(() => {
    cancelledRef.current = false;
    reconnectsRef.current = 0;
    if (streamSidOrCallSid) connect();

    return () => {
      cancelledRef.current = true;
      cleanupTimer();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [streamSidOrCallSid, connect]);

  const send = useCallback((action) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(action));
  }, []);

  const disconnect = useCallback(() => {
    cancelledRef.current = true;
    cleanupTimer();
    if (wsRef.current) wsRef.current.close();
  }, []);

  return { status, error, transcripts, lastAudio, send, disconnect };
}
