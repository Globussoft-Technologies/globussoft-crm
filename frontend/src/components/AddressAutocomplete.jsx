import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, MapPin } from 'lucide-react';
import { geocodeSuggest } from '../lib/geocoder';

const MIN_QUERY_LENGTH = 3;
const SEARCH_DELAY_MS = 300;

const labelStyle = {
  display: 'block', fontSize: '0.78rem', fontWeight: 700,
  color: 'var(--text-secondary)',
};

const menuStyle = {
  position: 'absolute', zIndex: 40, top: 'calc(100% + 5px)', left: 0, right: 0,
  maxHeight: 220, margin: 0, padding: 0, overflowY: 'auto', listStyle: 'none',
  border: '1px solid var(--border-color)', borderRadius: 9,
  background: 'var(--popover-bg, #fff)', boxShadow: '0 12px 28px rgba(15,23,42,.22)',
};

export default function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  style,
  maxLength = 2000,
  label = 'Address',
  placeholder = 'Start typing an address...',
}) {
  const inputId = useId();
  const listId = `${inputId}-suggestions`;
  const rootRef = useRef(null);
  const skipNextSearch = useRef(false);
  const searchRequested = useRef(false);
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      setSearching(false);
      return undefined;
    }

    if (!searchRequested.current) {
      setSuggestions([]);
      setSearching(false);
      setOpen(false);
      setActiveIndex(-1);
      return undefined;
    }

    const query = String(value || '').trim();
    if (query.length < MIN_QUERY_LENGTH) {
      searchRequested.current = false;
      setSuggestions([]);
      setSearching(false);
      setOpen(false);
      setActiveIndex(-1);
      return undefined;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const results = await geocodeSuggest(query, 6);
      if (cancelled) return;
      setSuggestions(results);
      setActiveIndex(results.length ? 0 : -1);
      setOpen(true);
      setSearching(false);
    }, SEARCH_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnOutsideClick = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open]);

  const chooseSuggestion = (suggestion) => {
    skipNextSearch.current = true;
    searchRequested.current = false;
    onChange(suggestion.display_name);
    onSelect?.(suggestion);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (event) => {
    if (!open || suggestions.length === 0) {
      if (event.key === 'Escape') setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseSuggestion(suggestions[activeIndex] || suggestions[0]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} style={{ ...labelStyle, ...style }}>
      {label && <label htmlFor={inputId}>{label}</label>}
      <div style={{ position: 'relative' }}>
        <input
          id={inputId}
          className="input-field"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          maxLength={maxLength}
          placeholder={placeholder}
          style={{ width: '100%', marginTop: label ? 5 : 0, boxSizing: 'border-box', paddingRight: '2.25rem' }}
          value={value}
          onChange={(event) => {
            searchRequested.current = true;
            onChange(event.target.value);
          }}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {searching && (
          <Loader2
            aria-label="Searching addresses"
            size={15}
            className="anim-spin"
            style={{ position: 'absolute', right: 11, top: '50%', marginTop: -5, color: 'var(--text-secondary)' }}
          />
        )}
        {open && suggestions.length > 0 && (
          <ul id={listId} role="listbox" aria-label="Address suggestions" style={menuStyle}>
            {suggestions.map((suggestion, index) => (
              <li
                id={`${listId}-${index}`}
                key={`${suggestion.lat},${suggestion.lng},${suggestion.display_name}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseSuggestion(suggestion);
                }}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '0.65rem 0.75rem', cursor: 'pointer', fontSize: '0.82rem',
                  color: 'var(--text-primary)',
                  background: index === activeIndex
                    ? 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 14%, var(--popover-bg, #fff))'
                    : 'var(--popover-bg, #fff)',
                  borderBottom: index < suggestions.length - 1 ? '1px solid var(--border-color)' : 0,
                }}
              >
                <MapPin size={14} aria-hidden="true" style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--primary-color, var(--accent-color))' }} />
                <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{suggestion.display_name}</span>
              </li>
            ))}
          </ul>
        )}
        {open && !searching && suggestions.length === 0 && String(value || '').trim().length >= MIN_QUERY_LENGTH && (
          <div role="status" style={{ ...menuStyle, padding: '0.65rem 0.75rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            No matching address found. You can keep the address you typed.
          </div>
        )}
      </div>
    </div>
  );
}
