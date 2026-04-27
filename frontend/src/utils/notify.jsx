import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { registerGlobalNotify } from './api';

/**
 * useNotify — drop-in replacement for window.alert / confirm / prompt.
 *
 * The native browser dialogs ("crm.globusdemos.com says…") block automated
 * QA tooling and look unprofessional. This module provides HTML modals +
 * toasts with a tiny API surface that mirrors the natives, so call-site
 * migration is mechanical:
 *
 *   alert('Saved')                         → notify.success('Saved')
 *   alert('Failed: ' + err.message)        → notify.error('Failed: ' + err.message)
 *   if (confirm('Delete?')) { ... }        → if (await notify.confirm('Delete?')) { ... }
 *   const v = prompt('Name', 'default')    → const v = await notify.prompt('Name', 'default')
 *
 * confirm() and prompt() return Promises, so the calling function must be
 * async. Every call site we touch already is, or is trivially convertible.
 *
 * Wrap the app in <NotifyProvider> once; call useNotify() anywhere below it.
 */

const NotifyContext = createContext(null);

let _idSeq = 0;

export function NotifyProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null); // { kind, title, message, defaultValue, resolve, ... }
  const modalQueueRef = useRef([]);

  // ── Toast surface ────────────────────────────────────────────────
  const pushToast = useCallback((kind, message, opts = {}) => {
    const id = ++_idSeq;
    const ttl = opts.ttl ?? (kind === 'error' ? 6000 : 3500);
    setToasts((prev) => {
      // #275: dedupe identical (kind, message) toasts within a 1.5s window.
      // Now that fetchApi auto-toasts errors, page-level .catch() handlers that
      // re-toast the same string would otherwise stack a second toast.
      const recent = prev.find(
        (t) => t.kind === kind && t.message === message && Date.now() - t.createdAt < 1500,
      );
      if (recent) return prev;
      return [...prev, { id, kind, message, createdAt: Date.now() }];
    });
    if (ttl > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ttl);
    }
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Modal surface (confirm + prompt). Single slot; queue overflow ─
  const openModal = useCallback((cfg) => {
    return new Promise((resolve) => {
      const entry = { ...cfg, resolve };
      setModal((current) => {
        if (current) {
          modalQueueRef.current.push(entry);
          return current;
        }
        return entry;
      });
    });
  }, []);

  const closeModal = useCallback((value) => {
    setModal((current) => {
      if (current?.resolve) current.resolve(value);
      const next = modalQueueRef.current.shift();
      return next || null;
    });
  }, []);

  // ── Public API ────────────────────────────────────────────────────
  const api = useMemo(() => {
    const success = (message, opts) => pushToast('success', message, opts);
    const error = (message, opts) => pushToast('error', message, opts);
    const info = (message, opts) => pushToast('info', message, opts);

    // confirm: accepts a string OR an options object.
    //   notify.confirm('Delete?')
    //   notify.confirm({ title, message, confirmText, cancelText, destructive })
    const confirm = (input) => {
      const cfg = typeof input === 'string'
        ? { message: input }
        : (input || {});
      return openModal({
        kind: 'confirm',
        title: cfg.title || 'Confirm',
        message: cfg.message || '',
        confirmText: cfg.confirmText || 'Confirm',
        cancelText: cfg.cancelText || 'Cancel',
        destructive: !!cfg.destructive,
      });
    };

    // prompt: accepts (message, defaultValue) OR an options object.
    //   notify.prompt('Name', 'default')
    //   notify.prompt({ title, message, defaultValue, placeholder, confirmText })
    const prompt = (a, b) => {
      const cfg = typeof a === 'string'
        ? { message: a, defaultValue: b ?? '' }
        : (a || {});
      return openModal({
        kind: 'prompt',
        title: cfg.title || 'Input',
        message: cfg.message || '',
        defaultValue: cfg.defaultValue ?? '',
        placeholder: cfg.placeholder || '',
        confirmText: cfg.confirmText || 'OK',
        cancelText: cfg.cancelText || 'Cancel',
      });
    };

    return { success, error, info, confirm, prompt };
  }, [pushToast, openModal]);

  // #275: register the toast API with utils/api.js so fetchApi can surface
  // errors as toasts globally — even on pages that forget to .catch().
  useEffect(() => {
    registerGlobalNotify(api);
    return () => registerGlobalNotify(null);
  }, [api]);

  return (
    <NotifyContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ModalSlot modal={modal} close={closeModal} />
    </NotifyContext.Provider>
  );
}

export function useNotify() {
  const ctx = useContext(NotifyContext);
  if (!ctx) {
    // Fallback — if anything calls useNotify outside the provider (e.g. in
    // a test that doesn't wrap), degrade to native so we don't crash.
    return {
      success: (m) => console.log('[notify.success]', m),
      error: (m) => console.error('[notify.error]', m),
      info: (m) => console.log('[notify.info]', m),
      confirm: (input) => Promise.resolve(window.confirm(typeof input === 'string' ? input : input?.message || '')),
      prompt: (a, b) => {
        const cfg = typeof a === 'string' ? { message: a, defaultValue: b ?? '' } : (a || {});
        return Promise.resolve(window.prompt(cfg.message || '', cfg.defaultValue ?? ''));
      },
    };
  }
  return ctx;
}

// ── Renderers ──────────────────────────────────────────────────────

const TOAST_COLORS = {
  success: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.4)', text: '#10b981', icon: '✓' },
  error: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.4)', text: '#ef4444', icon: '✕' },
  info: { bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.4)', text: '#3b82f6', icon: 'i' },
};

function ToastStack({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      style={{
        position: 'fixed', top: 24, right: 24, zIndex: 10000,
        display: 'flex', flexDirection: 'column', gap: 10,
        maxWidth: 420, pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => {
        const c = TOAST_COLORS[t.kind] || TOAST_COLORS.info;
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            data-notify-toast={t.kind}
            style={{
              pointerEvents: 'auto',
              background: c.bg,
              border: `1px solid ${c.border}`,
              color: 'var(--text-primary, #1f2937)',
              padding: '0.75rem 1rem',
              borderRadius: 10,
              boxShadow: '0 6px 24px rgba(0,0,0,0.18)',
              display: 'flex', alignItems: 'flex-start', gap: '0.65rem',
              fontSize: '0.9rem',
              backdropFilter: 'blur(8px)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 22, height: 22, borderRadius: '50%',
                background: c.text, color: '#fff', fontSize: '0.75rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, marginTop: 1,
              }}
            >{c.icon}</span>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{t.message}</span>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-secondary, #6b7280)', fontSize: '1rem', padding: 0,
                lineHeight: 1,
              }}
            >×</button>
          </div>
        );
      })}
    </div>
  );
}

function ModalSlot({ modal, close }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');

  // Reset value when a new prompt modal opens
  React.useEffect(() => {
    if (modal?.kind === 'prompt') {
      setValue(modal.defaultValue ?? '');
      // Focus the input on mount
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [modal]);

  // Esc to cancel
  React.useEffect(() => {
    if (!modal) return;
    const onKey = (e) => {
      if (e.key === 'Escape') close(modal.kind === 'confirm' ? false : null);
      if (e.key === 'Enter' && modal.kind === 'prompt') close(value);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, value, close]);

  if (!modal) return null;

  const cancelValue = modal.kind === 'confirm' ? false : null;
  const confirmValue = modal.kind === 'confirm' ? true : value;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notify-modal-title"
      data-notify-modal={modal.kind}
      onClick={() => close(cancelValue)}
      style={{
        position: 'fixed', inset: 0, zIndex: 10001,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-bg, #ffffff)',
          color: 'var(--text-primary, #1f2937)',
          padding: '1.5rem',
          borderRadius: 12,
          minWidth: 360,
          maxWidth: 480,
          width: '100%',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
        }}
      >
        <h3
          id="notify-modal-title"
          style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, marginBottom: '0.5rem' }}
        >{modal.title}</h3>
        {modal.message && (
          <p style={{
            margin: 0, marginBottom: '1rem',
            color: 'var(--text-secondary, #6b7280)',
            fontSize: '0.9rem', lineHeight: 1.45, whiteSpace: 'pre-wrap',
          }}>{modal.message}</p>
        )}

        {modal.kind === 'prompt' && (
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={modal.placeholder}
            onChange={(e) => setValue(e.target.value)}
            style={{
              width: '100%',
              padding: '0.55rem 0.75rem',
              borderRadius: 8,
              border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
              background: 'var(--input-bg, rgba(0,0,0,0.03))',
              color: 'var(--text-primary, #1f2937)',
              fontSize: '0.9rem',
              marginBottom: '1rem',
              outline: 'none',
            }}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button
            type="button"
            onClick={() => close(cancelValue)}
            data-notify-action="cancel"
            style={{
              padding: '0.5rem 1rem',
              background: 'transparent',
              border: '1px solid var(--border-color, rgba(0,0,0,0.15))',
              color: 'var(--text-primary, #1f2937)',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: '0.9rem',
            }}
          >{modal.cancelText}</button>
          <button
            type="button"
            onClick={() => close(confirmValue)}
            data-notify-action="confirm"
            autoFocus={modal.kind === 'confirm'}
            style={{
              padding: '0.5rem 1rem',
              background: modal.destructive ? '#ef4444' : 'var(--accent-color, #3b82f6)',
              border: 'none',
              color: '#fff',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: '0.9rem',
              fontWeight: 500,
            }}
          >{modal.confirmText}</button>
        </div>
      </div>
    </div>
  );
}
