import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

// Single-select variant of MultiSelectDropdown — same portal anchoring + theme
// vars so light/dark and wellness/generic all render consistently. Replaces the
// native <select> which leaks browser-default chrome on the ticket-tier field.
export default function SingleSelectDropdown({ value, onChange, options }) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuRect, setMenuRect] = useState({ top: 0, left: 0, width: 0 });
  const buttonRef = useRef(null);

  const selected = options.find((o) => o.value === value);
  const selectedLabel = selected ? selected.label : '';

  const updateRect = () => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 8, left: r.left, width: r.width });
  };

  const handleOpen = () => {
    updateRect();
    setIsOpen((v) => !v);
  };

  useEffect(() => {
    if (!isOpen) return;
    updateRect();
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) setIsOpen(false);
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleOpen}
        style={{
          width: '100%',
          padding: '0.6rem 0.75rem',
          background: 'var(--surface-color, rgba(255,255,255,0.04))',
          border: isOpen
            ? '1px solid var(--primary-color, var(--accent-color))'
            : '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '6px',
          color: 'var(--text-primary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          cursor: 'pointer',
          fontSize: '0.9rem',
          transition: 'border-color 0.2s, background 0.2s',
        }}
      >
        <span style={{ textAlign: 'left', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedLabel}
        </span>
        <ChevronDown size={16} style={{ marginLeft: '0.5rem', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
      </button>

      {isOpen && createPortal(
        <>
          <div
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998 }}
            onClick={() => setIsOpen(false)}
          />
          <div
            role="listbox"
            style={{
              position: 'fixed',
              top: menuRect.top,
              left: menuRect.left,
              width: menuRect.width,
              maxHeight: '340px',
              background: 'var(--bg-color)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              overflow: 'hidden',
              boxShadow: 'var(--shadow-lg, 0 20px 25px -5px rgba(0,0,0,0.25), 0 10px 10px -5px rgba(0,0,0,0.15))',
              zIndex: 10000,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{ overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>
              {options.map((opt, idx) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => { onChange(opt.value); setIsOpen(false); }}
                    style={{
                      padding: '0.65rem 1rem',
                      cursor: 'pointer',
                      borderBottom: idx < options.length - 1 ? '1px solid var(--border-light, var(--border-color))' : 'none',
                      transition: 'background 0.15s ease',
                      backgroundColor: isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent',
                      fontSize: '0.9rem',
                      color: 'var(--text-primary)',
                      fontWeight: isSelected ? 500 : 400,
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) {
                        e.currentTarget.style.backgroundColor = 'var(--hover-bg, var(--subtle-bg))';
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent';
                    }}
                  >
                    {opt.label}
                  </div>
                );
              })}
            </div>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
