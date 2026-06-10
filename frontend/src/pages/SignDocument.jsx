// Public signer-facing page mounted at /sign/:token. This is where the
// e-signature email link lands (the link is built server-side in
// backend/routes/signatures.js → resolveBaseUrl(req) + `/sign/${token}`,
// so it points back at the SAME environment that sent it).
//
// Authentication: HYBRID. The token IS the authentication — no login is
// required to view + sign. If the visitor happens to already have a CRM
// session it's harmless; the signing is keyed on the URL token, not on
// who's logged in. A subtle "Log in" link is offered for staff who want
// to jump into the CRM, but it never blocks signing.
//
// Flow:
//   1. GET  /api/signatures/sign/:token        → document metadata + status
//   2. Embed /api/signatures/sign/:token/pdf    → PDF preview of the doc
//   3. Draw signature on the canvas
//   4. POST /api/signatures/sign/:token { signature: dataURL }  → SIGNED
//      or POST /api/signatures/decline/:token                    → DECLINED

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';

const STATUS_COPY = {
  SIGNED: { title: 'Already signed', body: 'This document has already been signed. Thank you!' },
  DECLINED: { title: 'Request declined', body: 'This signature request was declined.' },
  EXPIRED: { title: 'Link expired', body: 'This signature request has expired. Please ask the sender for a new link.' },
};

export default function SignDocument() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null); // { documentType, signerName, companyName, status, ... }
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null); // 'SIGNED' | 'DECLINED'
  const [hasInk, setHasInk] = useState(false);

  const canvasRef = useRef(null);
  const drawingRef = useRef(false);

  // ── Load the request metadata ──────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/signatures/sign/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || `Failed to load document (${r.status})`);
        return body;
      })
      .then((data) => { if (!cancelled) setInfo(data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // ── Canvas drawing (mouse + touch) ─────────────────────────────────
  const pointFromEvent = useCallback((e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const src = e.touches?.[0] || e;
    // Scale CSS pixels → canvas backing-store pixels.
    return {
      x: (src.clientX - rect.left) * (canvas.width / rect.width),
      y: (src.clientY - rect.top) * (canvas.height / rect.height),
    };
  }, []);

  const startDraw = useCallback((e) => {
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    drawingRef.current = true;
  }, [pointFromEvent]);

  const moveDraw = useCallback((e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointFromEvent(e);
    ctx.lineTo(p.x, p.y);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111827';
    ctx.stroke();
    setHasInk(true);
  }, [pointFromEvent]);

  const endDraw = useCallback(() => { drawingRef.current = false; }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }, []);

  // ── Submit / decline ───────────────────────────────────────────────
  const submitSignature = async () => {
    if (!hasInk) { setError('Please draw your signature before submitting.'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const signature = canvasRef.current.toDataURL('image/png');
      const r = await fetch(`/api/signatures/sign/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Failed to submit signature (${r.status})`);
      setDone('SIGNED');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const declineRequest = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/signatures/decline/${encodeURIComponent(token)}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || `Failed to decline (${r.status})`);
      setDone('DECLINED');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  const company = info?.companyName || 'the sender';
  const wrap = (children) => (
    <div style={{
      minHeight: '100vh', background: '#0f172a', color: '#e2e8f0',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '2rem 1rem', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    }}>
      <div style={{ width: '100%', maxWidth: 820 }}>{children}</div>
    </div>
  );

  const card = (children) => (
    <div style={{
      background: '#1e293b', border: '1px solid #334155', borderRadius: 14,
      padding: '1.75rem', boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
    }}>{children}</div>
  );

  if (loading) {
    return wrap(card(<p style={{ textAlign: 'center', margin: 0 }}>Loading document…</p>));
  }

  // Terminal states (just-completed, or already in a non-pending state).
  const terminal = done || (info && info.status !== 'PENDING' ? info.status : null);
  if (terminal) {
    const copy = done === 'SIGNED'
      ? { title: 'Signed — thank you!', body: `Your signature for this ${info?.documentType || 'document'} has been recorded.` }
      : done === 'DECLINED'
        ? { title: 'Request declined', body: 'You have declined to sign this document. The sender has been notified.' }
        : STATUS_COPY[terminal] || { title: 'Done', body: 'No further action is needed.' };
    return wrap(card(
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>
          {terminal === 'DECLINED' ? '✕' : '✓'}
        </div>
        <h1 style={{ fontSize: '1.4rem', margin: '0 0 0.5rem' }}>{copy.title}</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>{copy.body}</p>
      </div>,
    ));
  }

  if (error && !info) {
    return wrap(card(
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>⚠️</div>
        <h1 style={{ fontSize: '1.4rem', margin: '0 0 0.5rem' }}>Unable to open document</h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>{error}</p>
      </div>,
    ));
  }

  return wrap(
    <>
      <div style={{ marginBottom: '1.25rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.35rem' }}>
          Signature requested by {company}
        </h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>
          {info?.documentType} #{info?.documentId} · for {info?.signerName}
        </p>
      </div>

      {/* PDF preview */}
      {card(
        <div>
          <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Review the document
          </div>
          <iframe
            title="Document preview"
            src={`/api/signatures/sign/${encodeURIComponent(token)}/pdf`}
            style={{ width: '100%', height: 460, border: '1px solid #334155', borderRadius: 8, background: '#fff' }}
          />
          <div style={{ marginTop: '0.5rem', fontSize: '0.78rem' }}>
            <a
              href={`/api/signatures/sign/${encodeURIComponent(token)}/pdf`}
              target="_blank" rel="noopener noreferrer"
              style={{ color: '#60a5fa' }}
            >
              Open document in a new tab ↗
            </a>
          </div>
        </div>,
      )}

      {/* Signature pad */}
      <div style={{ height: '1.25rem' }} />
      {card(
        <div>
          <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Draw your signature
          </div>
          <canvas
            ref={canvasRef}
            width={760}
            height={200}
            onMouseDown={startDraw}
            onMouseMove={moveDraw}
            onMouseUp={endDraw}
            onMouseLeave={endDraw}
            onTouchStart={startDraw}
            onTouchMove={moveDraw}
            onTouchEnd={endDraw}
            style={{
              width: '100%', height: 200, background: '#ffffff', borderRadius: 8,
              border: '1px solid #334155', touchAction: 'none', cursor: 'crosshair',
            }}
          />

          {error && (
            <p style={{ color: '#f87171', fontSize: '0.85rem', margin: '0.75rem 0 0' }}>{error}</p>
          )}

          <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <button
              type="button" onClick={clearCanvas} disabled={submitting}
              style={btn('#334155', '#e2e8f0')}
            >
              Clear
            </button>
            <div style={{ flex: 1 }} />
            <button
              type="button" onClick={declineRequest} disabled={submitting}
              style={btn('transparent', '#f87171', '1px solid rgba(248,113,113,0.4)')}
            >
              Decline
            </button>
            <button
              type="button" onClick={submitSignature} disabled={submitting || !hasInk}
              style={{ ...btn('#2563eb', '#fff'), opacity: submitting || !hasInk ? 0.6 : 1 }}
            >
              {submitting ? 'Submitting…' : 'Sign document'}
            </button>
          </div>
        </div>,
      )}

      <p style={{ color: '#64748b', fontSize: '0.75rem', textAlign: 'center', marginTop: '1.25rem' }}>
        Secure signing link from {company}. By signing you agree this electronic signature is legally binding.
        {' '}
        <a href="/login" style={{ color: '#64748b', textDecoration: 'underline' }}>Staff log in</a>
      </p>
    </>,
  );
}

function btn(bg, color, border = 'none') {
  return {
    padding: '0.6rem 1.1rem', background: bg, color, border, borderRadius: 8,
    fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer',
  };
}
