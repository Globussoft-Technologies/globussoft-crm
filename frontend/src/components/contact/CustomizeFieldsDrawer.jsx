import { useMemo, useRef, useState } from 'react';
import { X, Search, GripVertical, ChevronUp, ChevronDown, Info } from 'lucide-react';

export const ALL_OVERVIEW_FIELDS = [
  { key: 'location', label: 'Location' },
  { key: 'company', label: 'Account' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Mobile' },
  { key: 'owner', label: 'Sales owner' },
  { key: 'createdAt', label: 'Created at' },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'jobTitle', label: 'Job title' },
  { key: 'workPhone', label: 'Work phone' },
  { key: 'keyword', label: 'Keyword' },
  { key: 'note', label: 'Note' },
  { key: 'medium', label: 'Medium' },
  { key: 'description', label: 'description' },
  { key: 'website', label: 'Website URL' },
  { key: 'monthlyBudget', label: 'Monthly Budget' },
  { key: 'messenger', label: 'Telegram / WhatsApp / Teams' },
  { key: 'adPlatform', label: 'Advertising Platform' },
  { key: 'utmMedium', label: 'UTM Medium' },
  { key: 'utmSource', label: 'UTM Source' },
  { key: 'utmCampaign', label: 'UTM Campaign' },
];

const FIELD_KEYS = new Set(ALL_OVERVIEW_FIELDS.map((f) => f.key));

export const DEFAULT_VISIBLE_FIELD_KEYS = ['location', 'company', 'email', 'phone', 'owner', 'createdAt'];

export function normalizeVisibleKeys(raw) {
  if (Array.isArray(raw)) {
    const seen = new Set();
    const out = [];
    for (const k of raw) {
      if (FIELD_KEYS.has(k) && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    return ALL_OVERVIEW_FIELDS.filter((f) => raw[f.key]).map((f) => f.key);
  }
  return [...DEFAULT_VISIBLE_FIELD_KEYS];
}

function moveKey(list, key, delta) {
  const idx = list.indexOf(key);
  const next = idx + delta;
  if (idx < 0 || next < 0 || next >= list.length) return list;
  const out = [...list];
  out.splice(idx, 1);
  out.splice(next, 0, key);
  return out;
}

function insertKeyBefore(list, key, targetKey) {
  if (key === targetKey) return list;
  const without = list.filter((k) => k !== key);
  const at = without.indexOf(targetKey);
  if (at < 0) return [...without, key];
  const out = [...without];
  out.splice(at, 0, key);
  return out;
}

export default function CustomizeFieldsDrawer({ visibleKeys, onSave, onClose }) {
  const [draft, setDraft] = useState(() => normalizeVisibleKeys(visibleKeys));
  const [query, setQuery] = useState('');
  const [dragKey, setDragKey] = useState(null);
  const [dropKey, setDropKey] = useState(null);
  const searchRef = useRef(null);

  const q = query.trim().toLowerCase();
  const visibleSet = useMemo(() => new Set(draft), [draft]);
  const visibleRows = useMemo(
    () => draft
      .map((key) => ALL_OVERVIEW_FIELDS.find((f) => f.key === key))
      .filter(Boolean)
      .filter((f) => !q || f.label.toLowerCase().includes(q)),
    [draft, q],
  );
  const hiddenRows = useMemo(
    () => ALL_OVERVIEW_FIELDS.filter((f) => !visibleSet.has(f.key) && (!q || f.label.toLowerCase().includes(q))),
    [visibleSet, q],
  );

  const addKey = (key) => setDraft((d) => (d.includes(key) ? d : [...d, key]));
  const removeKey = (key) => setDraft((d) => d.filter((k) => k !== key));

  return (
    <div className="cf-overlay" onClick={onClose} role="presentation">
      <div
        className="cf-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Customize fields"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cf-head">
          <h3>
            Customize fields{' '}
            <span className="cf-count">
              {draft.length}/{ALL_OVERVIEW_FIELDS.length}
            </span>
          </h3>
          <button type="button" className="cp-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="cf-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search fields"
            aria-label="Search fields"
          />
        </div>
        <div className="cf-body">
          <div className="cf-section-label">Fields visible in overview</div>
          {visibleRows.length === 0 && (
            <p className="cf-empty">No fields match. Uncheck fields to hide them, or clear the search.</p>
          )}
          {visibleRows.map((f) => (
            <div
              key={f.key}
              className={`cf-row${dropKey === f.key ? ' cf-drop' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragKey(f.key);
                e.dataTransfer.effectAllowed = 'move';
                try {
                  e.dataTransfer.setData('text/plain', f.key);
                } catch (_e) {
                  /* clipboard types unsupported in some browsers */
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dragKey && dragKey !== f.key) setDropKey(f.key);
              }}
              onDragLeave={() => setDropKey((d) => (d === f.key ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                const key = dragKey || e.dataTransfer.getData('text/plain');
                if (key) setDraft((d) => insertKeyBefore(d, key, f.key));
                setDragKey(null);
                setDropKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDropKey(null);
              }}
            >
              <span className="cf-grip" aria-hidden="true" title="Drag to reorder">
                <GripVertical size={14} />
              </span>
              <input
                type="checkbox"
                checked
                onChange={() => removeKey(f.key)}
                aria-label={`Hide ${f.label}`}
              />
              <span className="cf-label">{f.label}</span>
              <span className="cf-move">
                <button
                  type="button"
                  aria-label={`Move ${f.label} up`}
                  disabled={draft.indexOf(f.key) <= 0}
                  onClick={() => setDraft((d) => moveKey(d, f.key, -1))}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${f.label} down`}
                  disabled={draft.indexOf(f.key) < 0 || draft.indexOf(f.key) >= draft.length - 1}
                  onClick={() => setDraft((d) => moveKey(d, f.key, 1))}
                >
                  <ChevronDown size={13} />
                </button>
              </span>
            </div>
          ))}
          <div className="cf-section-label">Fields not shown in overview</div>
          {hiddenRows.length === 0 && (
            <p className="cf-empty">All fields are visible.</p>
          )}
          {hiddenRows.map((f) => (
            <div key={f.key} className="cf-row">
              <span className="cf-grip cf-grip-off" aria-hidden="true">
                <GripVertical size={14} />
              </span>
              <input
                type="checkbox"
                checked={false}
                onChange={() => addKey(f.key)}
                aria-label={`Show ${f.label}`}
              />
              <span className="cf-label">{f.label}</span>
            </div>
          ))}
        </div>
        <div className="cf-footer">
          <span className="cf-note">
            <Info size={13} aria-hidden="true" /> The changes you make here apply to all users in the CRM
          </span>
          <span className="cf-footer-btns">
            <button type="button" className="cp-action-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="cf-save" onClick={() => onSave(draft)}>
              Save
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
