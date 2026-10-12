import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, MapPin, Search } from 'lucide-react';

const MENU_MAX_HEIGHT = 340;

export default function PickupLocationSelect({ value, onChange, options, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const searchRef = useRef(null);
  const listboxId = useId();

  const selected = options.find((location) => String(location.id) === String(value));
  const filteredOptions = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter((location) => (
      `${location.name || ''} ${location.address || ''}`.toLowerCase().includes(query)
    ));
  }, [options, search]);

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportPadding = 12;
      const availableBelow = window.innerHeight - rect.bottom - viewportPadding;
      const openUp = availableBelow < 260 && rect.top > availableBelow;
      setPosition({
        left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - rect.width - viewportPadding)),
        width: rect.width,
        top: openUp ? undefined : rect.bottom + 6,
        bottom: openUp ? window.innerHeight - rect.top + 6 : undefined,
      });
    };
    const closeOnOutsideClick = (event) => {
      if (
        !triggerRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    updatePosition();
    requestAnimationFrame(() => searchRef.current?.focus());
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const chooseLocation = (location) => {
    onChange(String(location.id));
    setSearch('');
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div style={{ width: '100%' }}>
      <button
        ref={triggerRef}
        type="button"
        className="input-field"
        aria-label="Pickup location"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => {
          setSearch('');
          setOpen((current) => !current);
        }}
        style={{
          width: '100%',
          minHeight: 58,
          display: 'grid',
          gridTemplateColumns: '32px minmax(0, 1fr) 20px',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          textAlign: 'left',
          cursor: disabled ? 'not-allowed' : 'pointer',
          borderColor: open ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)',
          boxShadow: open ? '0 0 0 3px color-mix(in srgb, var(--primary-color, var(--accent-color)) 16%, transparent)' : 'none',
        }}
      >
        <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', color: 'var(--primary-color, var(--accent-color))', background: 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 12%, transparent)' }}>
          <MapPin size={17} aria-hidden="true" />
        </span>
        <span style={{ minWidth: 0 }}>
          <strong style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: selected ? 'var(--text-primary)' : 'var(--text-secondary)', fontSize: '.88rem' }}>
            {selected?.name || 'Select pickup location'}
          </strong>
          <span style={{ display: 'block', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: '.75rem', fontWeight: 500 }}>
            {selected?.address || 'Search by location name or address'}
          </span>
        </span>
        <ChevronDown size={17} aria-hidden="true" style={{ color: 'var(--text-secondary)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s ease' }} />
      </button>

      {open && position && createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-label="Pickup locations"
          style={{
            position: 'fixed',
            left: position.left,
            top: position.top,
            bottom: position.bottom,
            width: position.width,
            zIndex: 1200,
            overflow: 'hidden',
            border: '1px solid var(--border-color)',
            borderRadius: 12,
            background: 'var(--popover-bg, var(--bg-color, #fff))',
            boxShadow: '0 18px 45px rgba(15, 23, 42, .24)',
          }}
        >
          <div style={{ padding: 10, borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ position: 'relative' }}>
              <Search size={16} aria-hidden="true" style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} />
              <input
                ref={searchRef}
                type="search"
                className="input-field"
                aria-label="Search pickup locations"
                placeholder="Search locations or addresses..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                style={{ width: '100%', minHeight: 40, paddingLeft: 34, boxSizing: 'border-box' }}
              />
            </div>
          </div>
          <div style={{ maxHeight: MENU_MAX_HEIGHT, overflowY: 'auto', padding: 6 }}>
            {filteredOptions.map((location) => {
              const isSelected = String(location.id) === String(value);
              return (
                <button
                  key={location.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-label={`Select ${location.name} pickup location`}
                  onClick={() => chooseLocation(location)}
                  style={{
                    width: '100%',
                    display: 'grid',
                    gridTemplateColumns: '30px minmax(0, 1fr) 20px',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 10px',
                    border: 0,
                    borderRadius: 9,
                    background: isSelected ? 'color-mix(in srgb, var(--primary-color, var(--accent-color)) 11%, transparent)' : 'transparent',
                    color: 'var(--text-primary)',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(event) => {
                    if (!isSelected) event.currentTarget.style.background = 'var(--subtle-bg, rgba(148, 163, 184, .1))';
                  }}
                  onMouseLeave={(event) => {
                    if (!isSelected) event.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--subtle-bg, rgba(148, 163, 184, .1))', color: 'var(--primary-color, var(--accent-color))' }}>
                    <MapPin size={15} aria-hidden="true" />
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ display: 'block', fontSize: '.84rem' }}>{location.name}</strong>
                    <span style={{ display: 'block', marginTop: 3, color: 'var(--text-secondary)', fontSize: '.73rem', lineHeight: 1.35, overflowWrap: 'anywhere' }}>{location.address}</span>
                  </span>
                  {isSelected && <Check size={17} aria-hidden="true" style={{ color: 'var(--primary-color, var(--accent-color))' }} />}
                </button>
              );
            })}
            {filteredOptions.length === 0 && (
              <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <MapPin size={22} aria-hidden="true" style={{ marginBottom: 6, opacity: .6 }} />
                <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>No locations found</div>
                <div style={{ marginTop: 3, fontSize: '.78rem' }}>Try a different name or address.</div>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
