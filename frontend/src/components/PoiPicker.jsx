// frontend/src/components/PoiPicker.jsx
//
// Reusable POI autocomplete picker. Wave 18 slice S93 (consumer-side
// of the catalog list endpoint shipped in the same slice — backend
// `GET /api/travel/pois?destinationSlug=&category=&q=&limit=&offset=`).
// Per PRD_TRAVEL_ITINERARY_UPGRADES.md FR-3.6.
//
// Consumers
// ---------
// Wired into the itinerary editor (S9) + Inline Add-POI modal (S12)
// — anywhere a Travel rep needs to pick a POI from the catalog. The
// "add new" flow lives in the modal that consumes this picker; this
// component is read-only over the existing catalog.
//
// Contract
// --------
// Props:
//   value            { id, name, category, ... } | null
//   onChange         (poi | null) => void  — fires when a row is picked
//                    or the field is cleared
//   destinationSlug  string  REQUIRED — drives the API call's tenant +
//                    destination scope. If absent or empty the picker
//                    renders disabled with a hint.
//   country          string? — currently passthrough; future API may
//                    accept it as a stricter filter. Kept in the prop
//                    surface to avoid a breaking change later.
//   disabled         boolean? — locks the input regardless of slug
//   placeholder      string? — input placeholder (default
//                    "Search POIs by name…")
//   maxResults       number? — limit passed to the API (default 50,
//                    cap 200 backend-side)
//
// Behaviour:
//   - Empty query: still fetches with q="" so first-open shows the
//     destination's top N rows (better UX than "type to search").
//   - Typed input: debounced 250ms before re-fetching. While in-flight
//     the dropdown shows a "Loading…" row.
//   - Each row renders: thumbnail (imageUrl) OR a category emoji
//     fallback + bold name + category badge. nameLocal renders as a
//     secondary line when present.
//   - Outside click + Escape closes the dropdown.
//   - When `value` is set, the input shows the selected name; clicking
//     the clear (×) button fires onChange(null).
//
// Why a custom component (not <datalist>): we need thumbnails + the
// category badge + clear UX, which native <datalist> can't render.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

import { fetchApi } from '../utils/api';

// Map category strings (free-text in DB but well-known from S11's
// OpenTripMap importer + S12's rep-suggested categories) to a small
// emoji. Unknown categories fall back to a pin.
const CATEGORY_EMOJI = {
  religious: '🕌',
  historical: '🏛',
  natural: '🌿',
  cultural: '🎭',
  food: '🍽',
  shopping: '🛍',
  entertainment: '🎢',
  beach: '🏖',
  mountain: '⛰',
  museum: '🖼',
};
function emojiFor(category) {
  if (!category) return '📍';
  return CATEGORY_EMOJI[String(category).toLowerCase()] || '📍';
}

const DEBOUNCE_MS = 250;

function buildSightseeingRows(rows, { country, destinationSlug, resolvedDestination }) {
  return rows.map((row) => ({
    id: `s-${row.id}`,
    sightseeingId: row.id,
    poiId: null,
    sourceType: 'sightseeing',
    name: row.name,
    nameLocal: null,
    category: row.category || null,
    latitude: Number.isFinite(row.latitude) ? row.latitude : null,
    longitude: Number.isFinite(row.longitude) ? row.longitude : null,
    country: country || null,
    destinationSlug,
    destinationName: row.destinationName || resolvedDestination,
    imageUrl: row.imageUrl || null,
    descriptionShort: row.description || null,
    notes: row.notes || null,
  }));
}

function fallbackDestinationTerm(raw) {
  const parts = String(raw || '')
    .trim()
    .split(/\s+/)
    .filter((part) => part.length >= 4);
  return parts[0] || '';
}

function mergeSightseeingRows(primaryRows, fallbackRows) {
  const seen = new Set();
  const merged = [];
  for (const row of [...primaryRows, ...fallbackRows]) {
    const key = `${String(row.destinationName || '').toLowerCase()}::${String(row.name || '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  return merged;
}

export default function PoiPicker({
  value = null,
  onChange,
  destinationSlug,
  destinationName = '',
  subBrand = null,
  country = null,
  disabled = false,
  placeholder = 'Search approved sightseeing places…',
  maxResults = 50,
  onAddNew = null,   // (currentQuery: string) => void — when provided, shows "+ Add new POI" in empty state
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  const wrapRef = useRef(null);
  const debounceRef = useRef(null);
  const fetchSeqRef = useRef(0);

  const isSlugMissing = !destinationSlug;
  const isDisabled = disabled || isSlugMissing;

  // Sync the visible input when value changes externally.
  useEffect(() => {
    if (value && value.name) {
      setQuery(value.name);
    } else if (value === null) {
      // Don't clobber the user's in-flight typing.
      // (Only reset when nothing is selected AND the dropdown is closed.)
      if (!open) setQuery('');
    }
  }, [value, open]);

  const runFetch = useCallback(
    async (q) => {
      const resolvedDestination = String(destinationName || '').trim() || destinationSlug;
      if (!resolvedDestination) return;
      setLoading(true);
      setErrored(false);
      const seq = ++fetchSeqRef.current;
      try {
        const params = new URLSearchParams({
          destinationName: resolvedDestination,
          limit: String(maxResults),
          isActive: 'true',
        });
        if (q) params.set('q', q);
        if (subBrand) {
          params.set('subBrand', subBrand);
          params.set('includeTenantWide', 'true');
        }
        let data = await fetchApi(`/api/travel/sightseeing?${params.toString()}`, {
          silent: true,
        });
        let rows = Array.isArray(data?.items) ? data.items : [];
        const fallbackTerm = fallbackDestinationTerm(resolvedDestination);
        if (fallbackTerm && fallbackTerm !== resolvedDestination) {
          const fallbackParams = new URLSearchParams({
            destinationName: fallbackTerm,
            limit: String(maxResults),
            isActive: 'true',
          });
          if (q) fallbackParams.set('q', q);
          if (subBrand) {
            fallbackParams.set('subBrand', subBrand);
            fallbackParams.set('includeTenantWide', 'true');
          }
          data = await fetchApi(`/api/travel/sightseeing?${fallbackParams.toString()}`, {
            silent: true,
          });
          const fallbackRows = Array.isArray(data?.items) ? data.items : [];
          rows = mergeSightseeingRows(rows, fallbackRows);
        }
        // Drop stale results — only the most recent request wins.
        if (seq !== fetchSeqRef.current) return;
        setItems(buildSightseeingRows(rows, { country, destinationSlug, resolvedDestination }));
      } catch (_e) {
        if (seq !== fetchSeqRef.current) return;
        setErrored(true);
        setItems([]);
      } finally {
        if (seq === fetchSeqRef.current) setLoading(false);
      }
    },
    [destinationName, destinationSlug, country, maxResults, subBrand],
  );

  // Debounced re-fetch when the user types.
  useEffect(() => {
    if (!open || isDisabled) return undefined;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runFetch(query);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, isDisabled, runFetch]);

  // Initial fetch when dropdown opens.
  const handleFocus = () => {
    if (isDisabled) return;
    setOpen(true);
    // Fire immediately so the first-open list is visible without
    // waiting for the debounce.
    runFetch(query);
  };

  // Outside click + Escape close.
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleSelect = (poi) => {
    setOpen(false);
    setQuery(poi.name || '');
    if (typeof onChange === 'function') onChange(poi);
  };

  const handleClear = () => {
    setQuery('');
    setItems([]);
    setOpen(false);
    if (typeof onChange === 'function') onChange(null);
  };

  const wrapperStyle = useMemo(
    () => ({
      position: 'relative',
      width: '100%',
      maxWidth: 420,
    }),
    [],
  );

  const inputStyle = {
    width: '100%',
    padding: '0.55rem 2.2rem 0.55rem 2.2rem',
    background: isDisabled
      ? 'var(--surface-muted, rgba(0,0,0,0.04))'
      : 'var(--surface-color, #fff)',
    border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
    borderRadius: 8,
    color: 'var(--text-primary)',
    fontSize: '0.92rem',
    outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div ref={wrapRef} style={wrapperStyle} data-testid="poi-picker">
      <div style={{ position: 'relative' }}>
        <Search
          size={16}
          style={{
            position: 'absolute',
            left: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-secondary, #6b7280)',
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
            // Clearing the input while a value is set clears the
            // selection — mimics native combobox behaviour.
            if (value && e.target.value === '' && typeof onChange === 'function') {
              onChange(null);
            }
          }}
          onFocus={handleFocus}
          placeholder={
            isSlugMissing
              ? 'Pick a destination first'
              : placeholder
          }
          disabled={isDisabled}
          style={inputStyle}
          aria-label="POI search"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="poi-picker-listbox"
        />
        {value && !isDisabled && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear selection"
            style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-secondary, #6b7280)',
              padding: 4,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {open && !isDisabled && (
        <div
          id="poi-picker-listbox"
          role="listbox"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            background: 'var(--surface-color, #fff)',
            border: '1px solid var(--border-color, rgba(0,0,0,0.12))',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
            maxHeight: 320,
            overflowY: 'auto',
            zIndex: 50,
          }}
          data-testid="poi-picker-listbox"
        >
          {loading && (
            <div
              style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)' }}
              data-testid="poi-picker-loading"
            >
              Loading…
            </div>
          )}

          {!loading && errored && (
            <div
              style={{ padding: '0.6rem 0.8rem', color: 'var(--danger-color, #b91c1c)' }}
              data-testid="poi-picker-error"
            >
              Failed to load approved sightseeing places. Please retry.
            </div>
          )}

          {!loading && !errored && items.length === 0 && (
            <div data-testid="poi-picker-empty">
              <div style={{ padding: '0.6rem 0.8rem', color: 'var(--text-secondary)' }}>
                No approved sightseeing places found for {destinationSlug}.
              </div>
              {typeof onAddNew === 'function' && (
                <button
                  type="button"
                  data-testid="poi-picker-add-new"
                  onClick={() => onAddNew(query)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0.5rem 0.8rem',
                    background: 'transparent',
                    border: 'none',
                    borderTop: '1px solid var(--border-color, rgba(0,0,0,0.08))',
                    cursor: 'pointer',
                    color: 'var(--primary-color, var(--accent-color, #265855))',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    textAlign: 'left',
                  }}
                >
                  + Suggest new place{query ? ` "${query}"` : ''}
                </button>
              )}
            </div>
          )}

          {!loading && !errored &&
            items.map((poi) => (
              <button
                key={poi.id}
                type="button"
                onClick={() => handleSelect(poi)}
                role="option"
                aria-selected={value?.id === poi.id}
                data-testid={`poi-picker-row-${poi.id}`}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '0.55rem 0.8rem',
                  background:
                    value?.id === poi.id
                      ? 'var(--surface-hover, rgba(0,0,0,0.04))'
                      : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--border-color, rgba(0,0,0,0.06))',
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: 'var(--text-primary)',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 6,
                    background: 'var(--surface-muted, rgba(0,0,0,0.06))',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    flexShrink: 0,
                  }}
                >
                  {poi.imageUrl ? (
                    <img
                      src={poi.imageUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => {
                        // Fallback to emoji if the thumbnail 404s.
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  ) : (
                    <span style={{ fontSize: 18 }}>{emojiFor(poi.category)}</span>
                  )}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                  <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {poi.name}
                  </span>
                  {poi.nameLocal && (
                    <span
                      style={{
                        fontSize: '0.78rem',
                        color: 'var(--text-secondary, #6b7280)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {poi.nameLocal}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: '0.72rem',
                      color: 'var(--text-secondary, #6b7280)',
                    }}
                  >
                    {poi.sourceType === 'sightseeing'
                      ? 'Sightseeing Master'
                      : 'Approved POI catalog'}
                  </span>
                </span>
                {poi.category && (
                  <span
                    data-testid="poi-picker-category-badge"
                    style={{
                      fontSize: '0.72rem',
                      padding: '0.15rem 0.5rem',
                      borderRadius: 999,
                      background: 'var(--accent-soft, rgba(38,88,85,0.1))',
                      color: 'var(--primary-color, var(--accent-color, #265855))',
                      textTransform: 'capitalize',
                      flexShrink: 0,
                    }}
                  >
                    {poi.category}
                  </span>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
