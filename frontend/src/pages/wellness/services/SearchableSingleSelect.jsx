import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { anchorDropdown, DROPDOWN_MAX_HEIGHT } from './shared';

// Searchable single-select combobox.
//
// Replaces a long native <select> when the option list is large enough to need
// filtering. The trigger is a text input so the user can type to search; the
// menu renders in a portal so it escapes any .glass/backdrop-filter stacking
// context, and it re-anchors on scroll/resize. Includes keyboard navigation
// (ArrowUp/Down, Enter, Escape, Home/End) and ARIA roles for accessibility.
export default function SearchableSingleSelect({
  value,
  onChange,
  options,
  placeholder = 'Search...',
  noneLabel = '— none —',
  disabled,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuRect, setMenuRect] = useState({
    openUp: false,
    top: 0,
    bottom: 0,
    left: 0,
    width: 0,
    maxHeight: DROPDOWN_MAX_HEIGHT,
  });

  const inputRef = useRef(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const normalizedValue = value === null || value === undefined ? '' : String(value);

  const filteredOptions = useMemo(
    () =>
      options.filter((opt) => {
        if (!search.trim()) return true;
        return String(opt.label).toLowerCase().includes(search.toLowerCase());
      }),
    [options, search]
  );

  const visibleOptions = useMemo(
    () => [{ value: '', label: noneLabel }, ...filteredOptions],
    [filteredOptions, noneLabel]
  );

  const selectedOption = useMemo(
    () => options.find((opt) => String(opt.value) === normalizedValue) || null,
    [options, normalizedValue]
  );

  const updateRect = useCallback(() => {
    if (!inputRef.current) return;
    setMenuRect(
      anchorDropdown(inputRef.current, {
        desiredHeight: Math.min(DROPDOWN_MAX_HEIGHT, visibleOptions.length * 42 + 8),
      })
    );
  }, [visibleOptions.length]);

  useEffect(() => {
    if (!isOpen) return;
    updateRect();
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [isOpen, updateRect]);

  const openMenu = () => {
    setSearch('');
    setActiveIndex(-1);
    setIsOpen(true);
  };
  const handleSelect = (option) => {
  onChange(option.value);
  setSearch('');
  setActiveIndex(-1);
  setIsOpen(false);
};

const inputValue = search || selectedOption?.label || '';
  return (
    <div style={{ position: 'relative', width: '100%', zIndex: isOpen ? 9999 : 'auto' }}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={
          isOpen && activeIndex >= 0 ? `${baseId}-opt-${activeIndex}` : undefined
        }
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        autoComplete="off"
        disabled={disabled}
        value={inputValue}
        placeholder={placeholder}
        onFocus={() => {
          setSearch('');
          setActiveIndex(-1);
          setIsOpen(true);
        }}
        onChange={(e) => {
          setSearch(e.target.value);
          setActiveIndex(-1);
          setIsOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            if (isOpen) {
              setIsOpen(false);
              setActiveIndex(-1);
            }
            inputRef.current?.focus();
            return;
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!isOpen) {
              setActiveIndex(0);
              setIsOpen(true);
            } else {
              setActiveIndex((idx) => Math.min(idx + 1, visibleOptions.length - 1));
            }
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!isOpen) {
              setActiveIndex(0);
              setIsOpen(true);
            } else {
              setActiveIndex((idx) => Math.max(idx - 1, 0));
            }
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
           if (isOpen && activeIndex >= 0 && activeIndex < visibleOptions.length) {
  handleSelect(visibleOptions[activeIndex]);
} else if (!isOpen) {
              setActiveIndex(0);
              setIsOpen(true);
            }
            return;
          }
          if (e.key === 'Home') {
            e.preventDefault();
            setActiveIndex(0);
            setIsOpen(true);
            return;
          }
          if (e.key === 'End') {
            e.preventDefault();
            setActiveIndex(visibleOptions.length - 1);
            setIsOpen(true);
          }
        }}
        style={{
          width: '100%',
          padding: '0.55rem 0.75rem',
          paddingRight: '2.5rem',
          background: 'var(--input-bg)',
          border: `1px solid ${isOpen ? 'var(--primary-color, var(--accent-color))' : 'var(--border-color)'}`,
          borderRadius: 8,
          color: 'var(--text-primary)',
          fontSize: '0.9rem',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={isOpen ? 'Close options' : 'Open options'}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (isOpen) {
            setIsOpen(false);
          } else {
            openMenu();
            inputRef.current?.focus();
          }
        }}
        style={{
          position: 'absolute',
          right: '0.8rem',
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: 'var(--text-primary)',
          zIndex: 2,
        }}
      >
        <ChevronDown
          size={16}
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
          }}
        />
      </button>

      {isOpen &&
        createPortal(
          <>
            <div
              aria-hidden="true"
              onClick={() => setIsOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 9998,
              }}
            />
            <div
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel || 'Options'}
              style={{
                position: 'fixed',
                ...(menuRect.openUp
                  ? { bottom: menuRect.bottom }
                  : { top: menuRect.top }),
                left: menuRect.left,
                width: menuRect.width,
                maxHeight: menuRect.maxHeight,
                background: 'var(--bg-color)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                overflow: 'hidden',
                boxShadow:
                  'var(--shadow-lg, 0 20px 25px -5px rgba(0,0,0,0.25), 0 10px 10px -5px rgba(0,0,0,0.15))',
                zIndex: 10000,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>
                {visibleOptions.map((opt, idx) => {
                  const isSelected = String(opt.value) === normalizedValue;
                  const isActive = idx === activeIndex;
                  return (
                    <div
                      key={String(opt.value) || `opt-${idx}`}
                      id={`${baseId}-opt-${idx}`}
                      role="option"
                      aria-selected={isSelected}
                     onClick={() => {
  handleSelect(opt);
}}
                      onMouseEnter={() => setActiveIndex(idx)}
                      style={{
                        padding: '0.65rem 1rem',
                        cursor: 'pointer',
                        borderBottom:
                          idx < visibleOptions.length - 1
                            ? '1px solid var(--border-light, var(--border-color))'
                            : 'none',
                        transition: 'background 0.15s ease',
                        backgroundColor: isActive
                          ? 'var(--hover-bg, var(--subtle-bg))'
                          : isSelected
                            ? 'var(--subtle-bg-3, var(--accent-bg))'
                            : 'transparent',
                        color: 'var(--text-primary)',
                        fontSize: '0.9rem',
                        fontWeight: isSelected ? 500 : 400,
                      }}
                    >
                      {opt.label}
                    </div>
                  );
                })}
                {filteredOptions.length === 0 && (
                  <div
                    style={{
                      padding: '0.65rem 1rem',
                      color: 'var(--text-secondary)',
                      textAlign: 'center',
                      fontSize: '0.85rem',
                    }}
                  >
                    No options found
                  </div>
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
