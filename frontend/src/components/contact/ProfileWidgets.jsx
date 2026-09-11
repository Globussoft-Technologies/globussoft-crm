import { useEffect, useState } from 'react';
import { Pencil, Star, X } from 'lucide-react';

export function Stars({ value, size = 12 }) {
  return (
    <span className="cp-fit">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} fill={i <= value ? 'currentColor' : 'none'} />
      ))}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="cp-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className={`cp-modal${wide ? ' cp-modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="cp-modal-head">
          <h3>{title}</h3>
          <button type="button" className="cp-icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="cp-modal-body">{children}</div>
      </div>
    </div>
  );
}

export function InlineField({ value, display, type = 'text', options = [], onSave, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);

  const start = () => {
    setDraft(value ?? '');
    setEditing(true);
  };

  const commit = async () => {
    const next = typeof draft === 'string' ? draft.trim() : draft;
    const current = typeof value === 'string' ? value.trim() : value;
    setEditing(false);
    if (next === current || saving) return;
    setSaving(true);
    try {
      await onSave(next === '' ? null : next);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <span className="cp-inline">
        <span style={{ opacity: saving ? 0.5 : 1 }}>{display !== undefined ? display : (value ? String(value) : <span style={{ color: 'var(--text-secondary)' }}>Not available</span>)}</span>
        <button type="button" className="cp-edit-btn" onClick={start} title="Edit" aria-label="Edit field">
          <Pencil size={11} />
        </button>
      </span>
    );
  }

  if (type === 'select') {
    return (
      <select
        className="cp-input"
        autoFocus
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
      >
        <option value="">{placeholder || 'Select…'}</option>
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      className="cp-input"
      autoFocus
      type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
      value={draft ?? ''}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
    />
  );
}

export function FormRow({ label, children }) {
  return (
    <label className="cp-form-row">
      <span className="cp-form-label">{label}</span>
      {children}
    </label>
  );
}
