// frontend/src/components/travel/LocationAutocomplete.jsx
//
// Drop-in replacement for a plain <input type="text"> on any itinerary /
// destination / location field. As the rep types, it debounces and calls
// the same Photon-backed geocoding proxy already used for map-pin lookups
// (GET /api/travel/pois/geocode via lib/geocoder.js) and shows a dropdown
// of matching real-world places to pick from — same interaction pattern as
// the existing PoiPicker.jsx (POI catalog autocomplete), just backed by
// general place search instead of the approved-POI catalog.
//
// Fully controlled, like a normal <input>: `value` + `onChange(text)` behave
// exactly like the native input event so it swaps in without touching any
// surrounding form state/validation. `onSelect(suggestion)` is an optional
// extra callback that fires only when the rep actually picks a suggestion
// row, carrying the resolved { lat, lng, display_name } — callers that also
// want coordinates (e.g. the POI location search) can use it without any
// other behaviour change.
//
// Keyboard: ArrowDown/ArrowUp move the highlighted row, Enter selects the
// highlighted row (only when the dropdown is open — otherwise Enter falls
// through untouched so existing form-submit-on-Enter behaviour isn't
// affected), Escape closes the dropdown. Outside click closes it too.

import { useEffect, useRef, useState } from "react";
import { geocodeSuggestions } from "../../lib/geocoder";

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

export default function LocationAutocomplete({
  value = "",
  onChange,
  onSelect,
  limit = 6,
  style,
  inputProps = {},
  ...rest
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const wrapRef = useRef(null);
  const debounceRef = useRef(null);
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    const query = String(value || "").trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.length < MIN_CHARS) {
      setSuggestions([]);
      setLoading(false);
      setActiveIndex(-1);
      return undefined;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const seq = ++fetchSeqRef.current;
      const results = await geocodeSuggestions(query, { limit });
      if (seq !== fetchSeqRef.current) return; // stale response
      setSuggestions(results);
      setActiveIndex(-1);
      setLoading(false);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [value, limit]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocMouseDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  function fireChange(text) {
    if (typeof onChange === "function") onChange(text);
  }

  function selectSuggestion(suggestion) {
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(-1);
    fireChange(suggestion.display_name);
    if (typeof onSelect === "function") onSelect(suggestion);
  }

  function handleKeyDown(e) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        e.preventDefault();
        selectSuggestion(suggestions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showDropdown =
    open && String(value || "").trim().length >= MIN_CHARS && (loading || suggestions.length > 0);

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <input
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showDropdown}
        aria-controls="location-autocomplete-listbox"
        autoComplete="off"
        {...rest}
        {...inputProps}
        value={value}
        onChange={(e) => {
          fireChange(e.target.value);
          setOpen(true);
        }}
        onFocus={(e) => {
          setOpen(true);
          if (typeof inputProps.onFocus === "function") inputProps.onFocus(e);
        }}
        onKeyDown={(e) => {
          handleKeyDown(e);
          if (typeof inputProps.onKeyDown === "function") inputProps.onKeyDown(e);
        }}
        style={style}
      />

      {showDropdown && (
        <div
          id="location-autocomplete-listbox"
          role="listbox"
          data-testid="location-autocomplete-listbox"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 4,
            // --modal-bg (not --surface-color) — surface-color carries
            // glassmorphism alpha app-wide, which made this dropdown
            // see-through over whatever sits behind it (e.g. the table
            // rows behind the "Create itinerary" drawer). --modal-bg is
            // the CRM's existing opaque-panel token for exactly this case.
            background: "var(--modal-bg, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.24)",
            maxHeight: 260,
            overflowY: "auto",
            zIndex: 60,
          }}
        >
          {loading && suggestions.length === 0 && (
            <div
              data-testid="location-autocomplete-loading"
              style={{ padding: "0.5rem 0.7rem", fontSize: "0.82rem", color: "var(--text-secondary)" }}
            >
              Searching…
            </div>
          )}

          {!loading &&
            suggestions.map((s, idx) => (
              <button
                key={`${s.display_name}-${idx}`}
                type="button"
                role="option"
                aria-selected={idx === activeIndex}
                data-testid={`location-autocomplete-row-${idx}`}
                onMouseDown={(e) => {
                  // mousedown (not click) so this fires before the input's
                  // onBlur/outside-click handler would otherwise close the
                  // dropdown and drop the selection.
                  e.preventDefault();
                  selectSuggestion(s);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "0.5rem 0.7rem",
                  border: "none",
                  borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.06))",
                  background:
                    idx === activeIndex ? "var(--surface-hover, rgba(0,0,0,0.05))" : "transparent",
                  color: "var(--text-primary)",
                  fontSize: "0.85rem",
                  cursor: "pointer",
                }}
              >
                {s.display_name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
