import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

/**
 * frontend/src/components/ui/SearchInput.jsx
 *
 * Issue #695 — search/filter inputs styled and positioned differently per list.
 *
 * Canonical search-input primitive. Renders a left-aligned magnifier icon,
 * the input, an optional clear (X) affordance when there's a value, and
 * a 250 ms debounce so callers get one stable `onSearch(query)` call after
 * the user stops typing.
 *
 * Placement convention (issue #695 canonical pattern):
 *   - Toolbar layout: search LEFT, filter chips middle, action buttons RIGHT.
 *   - 250 ms debounce across all list views.
 *   - Clear (X) appears when value is non-empty.
 *
 * Usage:
 *   const [q, setQ] = useState('');
 *   <SearchInput value={q} onSearch={setQ} placeholder="Search patients..." />
 *
 * The component is controlled by `value` from the parent (so the parent
 * can clear it, persist it to URL state, etc). `onSearch` fires only after
 * the debounce window; if you need the immediate keystroke value (for
 * client-side rendering of the input itself) pass `onChange` too.
 */
export default function SearchInput({
  value = '',
  onSearch,
  onChange,
  placeholder = 'Search…',
  debounce = 250,
  style,
  className,
  ariaLabel,
}) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef(null);

  // Sync from parent when controlled value changes (e.g. parent clears).
  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (local === value) return; // no-op when synced
    timerRef.current = setTimeout(() => {
      if (typeof onSearch === 'function') onSearch(local);
    }, debounce);
    return () => clearTimeout(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, debounce]);

  const handleChange = (e) => {
    const v = e.target.value;
    setLocal(v);
    if (typeof onChange === 'function') onChange(v);
  };

  const handleClear = () => {
    setLocal('');
    if (typeof onChange === 'function') onChange('');
    if (typeof onSearch === 'function') onSearch('');
  };

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: '100%',
        maxWidth: 360,
        ...style,
      }}
    >
      <Search
        size={16}
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: '0.75rem',
          color: 'var(--text-secondary)',
          pointerEvents: 'none',
        }}
      />
      <input
        type="search"
        value={local}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        className="input-field"
        style={{
          paddingLeft: '2.25rem',
          paddingRight: local ? '2.25rem' : '0.75rem',
        }}
      />
      {local && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          style={{
            position: 'absolute',
            right: '0.5rem',
            background: 'transparent',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
