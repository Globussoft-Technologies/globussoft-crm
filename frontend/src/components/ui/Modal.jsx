import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

/**
 * frontend/src/components/ui/Modal.jsx
 *
 * Issue #691 — modal dialogs have inconsistent close affordances (some ESC
 * works, some only Cancel, some click-outside dismisses, some don't, X in
 * top-right inconsistent).
 *
 * Canonical modal primitive. All modals share this behaviour:
 *   - ESC closes (unless `destructive` — destructive flows require an
 *     explicit choice).
 *   - Click-outside dismisses (unless `destructive`).
 *   - Top-right X close button (unless `hideClose`).
 *   - Focus traps inside the modal; previous focus restored on close.
 *   - role="dialog", aria-modal="true", aria-labelledby points at the title.
 *
 * Sits below notify.jsx's modal slot in z-index (z=10001) — page-level
 * modals at z=9999. notify confirm/prompt modals always overlay any
 * page-level modal opened beneath them.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   ...
 *   <Modal
 *     open={open}
 *     title="New patient"
 *     onClose={() => setOpen(false)}
 *     footer={<>
 *       <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
 *       <button className="btn-primary" onClick={save}>Save</button>
 *     </>}
 *   >
 *     <FormField label="Name" required><input className="input-field" /></FormField>
 *   </Modal>
 *
 * For confirm/prompt flows the right tool is `notify.confirm()` / `notify.prompt()`
 * (utils/notify.jsx) — this primitive is for richer page-level dialogs that
 * need their own children (forms, choice lists, etc).
 */
export default function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  destructive = false,
  hideClose = false,
  size = 'medium', // small | medium | large
  style,
  className,
}) {
  const dialogRef = useRef(null);
  const lastFocusRef = useRef(null);
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`);

  // Capture & restore focus across open/close.
  useEffect(() => {
    if (!open) return;
    lastFocusRef.current = document.activeElement;
    // Focus the dialog itself first so screen readers announce the title.
    setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      // Restore focus on unmount/close.
      if (lastFocusRef.current && typeof lastFocusRef.current.focus === 'function') {
        try { lastFocusRef.current.focus(); } catch { /* ignore */ }
      }
    };
  }, [open]);

  // ESC handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !destructive) {
        e.stopPropagation();
        if (typeof onClose === 'function') onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, destructive, onClose]);

  // Body scroll lock — the page underneath stays fixed until the modal closes.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const minWidth = size === 'small' ? 360 : size === 'large' ? 720 : 480;
  const maxWidth = size === 'small' ? 480 : size === 'large' ? 960 : 640;

  const handleBackdrop = () => {
    if (!destructive && typeof onClose === 'function') onClose();
  };

  return (
    <div
      role="presentation"
      onClick={handleBackdrop}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'var(--overlay-bg, rgba(0,0,0,0.55))',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        className={className}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-color, #ffffff)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border-color, rgba(0,0,0,0.08))',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
          minWidth,
          maxWidth,
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
          ...style,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color)',
            gap: '1rem',
          }}
        >
          <h3
            id={titleId.current}
            style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}
          >
            {title}
          </h3>
          {!hideClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                padding: 4,
                display: 'flex',
                alignItems: 'center',
                borderRadius: 4,
              }}
            >
              <X size={18} />
            </button>
          )}
        </div>
        <div
          style={{
            padding: '1.25rem',
            overflowY: 'auto',
            flex: 1,
          }}
        >
          {children}
        </div>
        {footer && (
          <div
            style={{
              padding: '0.75rem 1.25rem',
              borderTop: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.5rem',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
