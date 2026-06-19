// Reusable WhatsApp Web (QR-scan) connection bar — the "scan and connect"
// experience built for the travel inbox, packaged so the wellness inbox (and
// any vertical) can drop it in. Renders the status strip + QR modal + "My
// profile" editor + full-image lightbox, and owns all connect / qr / status /
// disconnect / import / me state + the socket listeners.
//
// Props:
//   apiBase   — e.g. '/api/whatsapp-web' (generic) or '/api/travel/whatsapp'
//   tenantId  — current user's tenant (socket room + event filtering)
//   isAdmin   — gates Connect / Disconnect / Refresh / My-profile controls
//   onChanged — called when the thread list should reload (connect/disconnect/import)
import { useEffect, useRef, useState } from 'react';
import { io as socketIO } from 'socket.io-client';
import { fetchApi, getAuthToken } from '../../../utils/api';
import { useNotify } from '../../../utils/notify';
import { ImageLightbox, openImage } from './ImageLightbox';

export default function WhatsAppWebConnect({ apiBase, tenantId, isAdmin, onChanged }) {
  const notify = useNotify();
  const [status, setStatus] = useState(null); // { connected, state, phone, qr, lastError }
  const [showQr, setShowQr] = useState(false);
  const [qrImage, setQrImage] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [importing, setImporting] = useState(false);
  // My profile
  const [showProfile, setShowProfile] = useState(false);
  const [me, setMe] = useState(null);
  const [pName, setPName] = useState('');
  const [pAbout, setPAbout] = useState('');
  const [pSaving, setPSaving] = useState(false);
  const fileRef = useRef(null);
  const reload = () => { if (typeof onChanged === 'function') onChanged(); };

  const refresh = async () => {
    try {
      const data = await fetchApi(`${apiBase}/status`);
      setStatus(data || { connected: false, state: 'DISCONNECTED' });
      if (data?.qr) setQrImage(data.qr);
      if (data?.connected) { setShowQr(false); setConnecting(false); }
      return data;
    } catch {
      setStatus({ connected: false, state: 'DISCONNECTED' });
      return null;
    }
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  const startConnect = async (reset = false) => {
    setQrImage(null); setConnecting(true); setShowQr(true);
    try {
      const data = await fetchApi(`${apiBase}/connect`, { method: 'POST', body: JSON.stringify({ reset }) });
      if (data?.qr) setQrImage(data.qr);
      setStatus((p) => ({ ...(p || {}), ...data }));
      if (data?.connected) { setShowQr(false); setConnecting(false); notify.info('WhatsApp already connected.'); }
      await refresh();
    } catch (err) {
      notify.error(err.message || 'Failed to start WhatsApp connection.');
      setShowQr(false); setConnecting(false);
    }
  };
  const disconnect = async () => {
    if (!(await notify.confirm('Disconnect WhatsApp? This unlinks the number and clears all imported chats. Reconnecting re-fetches them.'))) return;
    try {
      const data = await fetchApi(`${apiBase}/disconnect`, { method: 'POST', body: JSON.stringify({ logout: true }) });
      notify.info(`WhatsApp disconnected — cleared ${data?.purged?.threads || 0} chats.`);
      await refresh(); reload();
    } catch (err) { notify.error(err.message || 'Failed to disconnect.'); }
  };
  const importChats = async () => {
    setImporting(true);
    try {
      const data = await fetchApi(`${apiBase}/import`, { method: 'POST', body: JSON.stringify({}) });
      notify.info(`Imported ${data?.threads || 0} chats (${data?.messages || 0} messages).`);
      reload();
    } catch (err) { notify.error(err.message || 'Failed to import chats.'); }
    setImporting(false);
  };

  // QR poll while modal open (socket is primary, this is the fallback).
  useEffect(() => {
    if (!showQr) return undefined;
    const id = setInterval(async () => {
      try {
        const data = await fetchApi(`${apiBase}/qr`);
        if (data?.qr) setQrImage(data.qr);
        setStatus((p) => ({ ...(p || {}), ...data }));
        if (data?.connected) { setShowQr(false); setConnecting(false); reload(); notify.info('WhatsApp connected.'); }
        else if (data?.state === 'AUTH_FAILURE') setConnecting(false);
      } catch { /* retry next tick */ }
    }, 2500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showQr, apiBase]);

  // Socket: QR + state pushes.
  useEffect(() => {
    if (!tenantId) return undefined;
    const socket = socketIO({ withCredentials: true, transports: ['websocket', 'polling'] });
    const join = () => socket.emit('join_room', `tenant:${tenantId}`);
    socket.on('connect', join);
    socket.on('whatsapp:qr', (p) => { if (p && p.tenantId === tenantId && p.qr) setQrImage(p.qr); });
    socket.on('whatsapp:wa-state', (p) => {
      if (!p || p.tenantId !== tenantId) return;
      setStatus((prev) => ({ ...(prev || {}), ...p }));
      if (p.qr) setQrImage(p.qr);
      if (p.connected) { setShowQr(false); setConnecting(false); reload(); }
      else reload();
    });
    socket.on('whatsapp:imported', (p) => { if (p && p.tenantId === tenantId) reload(); });
    return () => { socket.off('connect', join); socket.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  // My profile
  const openMe = async () => {
    setShowProfile(true);
    try { const m = await fetchApi(`${apiBase}/me`); setMe(m); setPName(m?.name || ''); setPAbout(m?.about || ''); }
    catch (err) { notify.error(err.message || 'Failed to load profile.'); }
  };
  const saveMe = async () => {
    setPSaving(true);
    try { await fetchApi(`${apiBase}/me`, { method: 'PUT', body: JSON.stringify({ name: pName, about: pAbout }) }); notify.info('Profile updated.'); setMe(await fetchApi(`${apiBase}/me`)); }
    catch (err) { notify.error(err.message || 'Failed to update profile.'); }
    setPSaving(false);
  };
  const changeMeAvatar = async (file) => {
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) { notify.error('Image too large (max 16 MB).'); return; }
    setPSaving(true);
    try {
      const form = new FormData(); form.append('file', file);
      const token = getAuthToken();
      const resp = await fetch(`${apiBase}/me/avatar`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || `Upload failed (${resp.status})`); }
      notify.info('Profile picture updated.'); setMe(await fetchApi(`${apiBase}/me`)); refresh();
    } catch (err) { notify.error(err.message || 'Failed to set profile picture.'); }
    setPSaving(false);
  };

  const btn = (bg) => ({ fontSize: 12, fontWeight: 600, padding: '4px 12px', borderRadius: 6, border: bg ? 'none' : '1px solid var(--border-color)', cursor: 'pointer', color: bg ? '#fff' : 'var(--text-secondary)', background: bg || 'transparent' });
  const primary = 'var(--primary-color, #25D366)';

  return (
    <div style={{ padding: '0.75rem 1rem 0' }} data-testid="wa-web-connect">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', borderRadius: 8, fontSize: 13, border: '1px solid var(--border-color)', background: status?.connected ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.08)' }}>
        <span aria-hidden style={{ width: 9, height: 9, borderRadius: '50%', flexShrink: 0, background: status?.connected ? 'var(--success-color,#22c55e)' : 'var(--warning-color,#f59e0b)' }} />
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
          {status === null ? 'Checking WhatsApp connection…'
            : status.connected ? `WhatsApp connected${status.phone ? ` · ${status.phone}` : ''}`
              : (status.state === 'QR' || status.state === 'AUTHENTICATED' || status.state === 'INITIALIZING') ? 'WhatsApp connecting…' : 'WhatsApp not connected'}
        </span>
        {status !== null && !status.connected && (
          <span style={{ color: 'var(--text-secondary)' }}>
            — {isAdmin ? 'click Connect and scan the QR from your phone (WhatsApp → Linked devices).' : 'an admin needs to scan the WhatsApp QR to link a number.'}
          </span>
        )}
        {isAdmin && status !== null && !status.connected && (
          <button type="button" data-testid="wa-connect-btn" onClick={() => startConnect(false)} style={btn(primary)}>Connect WhatsApp</button>
        )}
        {isAdmin && status?.connected && (
          <>
            <button type="button" data-testid="wa-profile-btn" onClick={openMe} style={btn()}>My profile</button>
            <button type="button" data-testid="wa-import-btn" disabled={importing} onClick={importChats} style={{ ...btn(primary), opacity: importing ? 0.6 : 1 }}>{importing ? 'Importing…' : 'Refresh chats'}</button>
            <button type="button" data-testid="wa-disconnect-btn" onClick={disconnect} style={btn()}>Disconnect</button>
          </>
        )}
      </div>

      {/* QR modal */}
      {showQr && (
        <div data-testid="wa-qr-modal" onClick={() => { setShowQr(false); setConnecting(false); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-secondary,#fff)', borderRadius: 12, padding: '1.5rem', width: 'min(92vw,380px)', textAlign: 'center', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 0.25rem', color: 'var(--text-primary)' }}>Link WhatsApp</h3>
            <p style={{ margin: '0 0 1rem', fontSize: 13, color: 'var(--text-secondary)' }}>On your phone open <b>WhatsApp → Linked devices → Link a device</b>, then scan this code.</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 260 }}>
              {qrImage ? <img src={qrImage} alt="WhatsApp linking QR code" width={260} height={260} style={{ borderRadius: 8 }} />
                : status?.state === 'AUTH_FAILURE' ? <span style={{ color: 'var(--error-color,#ef4444)', fontSize: 13, padding: '0 8px' }}>{status.lastError || 'Could not start WhatsApp. Try Reset & reconnect.'}</span>
                  : <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{connecting ? 'Starting WhatsApp… (first launch can take ~15–30s)' : 'Waiting for QR…'}</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: '1rem', flexWrap: 'wrap' }}>
              <button type="button" data-testid="wa-reset-btn" onClick={() => startConnect(true)} style={{ ...btn(primary), padding: '6px 16px', fontSize: 13 }}>Reset &amp; reconnect</button>
              <button type="button" onClick={() => { setShowQr(false); setConnecting(false); }} style={{ ...btn(), padding: '6px 16px', fontSize: 13 }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* My profile modal */}
      {showProfile && (
        <div data-testid="wa-profile-modal" onClick={() => setShowProfile(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg-secondary,#fff)', borderRadius: 12, padding: '1.5rem', width: 'min(94vw,420px)', border: '1px solid var(--border-color)' }}>
            <h3 style={{ margin: '0 0 1rem', color: 'var(--text-primary)' }}>My WhatsApp profile</h3>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              {me?.avatar ? <img src={me.avatar} alt="" referrerPolicy="no-referrer" onClick={() => openImage(me.avatar)} title="View photo" style={{ width: 110, height: 110, borderRadius: '50%', objectFit: 'cover', cursor: 'pointer', background: 'var(--border-color)' }} />
                : <div style={{ width: 110, height: 110, borderRadius: '50%', background: 'var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, color: 'var(--text-secondary)' }}>👤</div>}
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; changeMeAvatar(f); }} />
              <button type="button" disabled={pSaving} onClick={() => fileRef.current?.click()} style={{ ...btn(primary), padding: '5px 12px' }}>Change photo</button>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{me?.phone ? `+${me.phone}` : ''}</div>
            </div>
            <label style={{ display: 'block', marginTop: 16, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Name</label>
            <input value={pName} onChange={(e) => setPName(e.target.value)} className="input-field" style={{ width: '100%', marginTop: 4, padding: '0.5rem 0.6rem' }} placeholder="Display name" />
            <label style={{ display: 'block', marginTop: 12, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>About</label>
            <input value={pAbout} onChange={(e) => setPAbout(e.target.value)} className="input-field" style={{ width: '100%', marginTop: 4, padding: '0.5rem 0.6rem' }} placeholder="Hey there! I am using WhatsApp." />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
              <button type="button" onClick={() => setShowProfile(false)} style={{ ...btn(), padding: '6px 16px', fontSize: 13 }}>Close</button>
              <button type="button" disabled={pSaving} onClick={saveMe} style={{ ...btn(primary), padding: '6px 16px', fontSize: 13, opacity: pSaving ? 0.6 : 1 }}>{pSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      <ImageLightbox />
    </div>
  );
}
