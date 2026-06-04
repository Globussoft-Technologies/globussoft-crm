import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

export default function MultiSelectDropdown({ categories, categoriesLoading, selectedIds, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  // Portal-rendered menu uses fixed positioning anchored to the button's
  // viewport rect — sidesteps the .glass parent's backdrop-filter, which
  // creates a stacking context that trapped the previous absolute-positioned
  // menu behind the sibling service cards.
  const [menuRect, setMenuRect] = useState({ top: 0, left: 0, width: 0 });
  const buttonRef = useRef(null);

  const selectedNames = categories
    .filter(cat => selectedIds.includes(cat.id))
    .map(cat => cat.name)
    .join(', ');

  const handleToggle = (catId) => {
    if (selectedIds.includes(catId)) {
      onChange(selectedIds.filter(id => id !== catId));
    } else {
      onChange([...selectedIds, catId]);
    }
  };

  const updateRect = () => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setMenuRect({ top: r.bottom + 8, left: r.left, width: r.width });
  };

  const handleOpen = () => {
    updateRect();
    setIsOpen(true);
  };

  // Re-anchor menu on scroll / resize while open.
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

  // Close on escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false);
      }
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
          // --surface-color matches the adjacent <input> background under each
          // theme (wellness.css force-overrides input bg to white in light mode;
          // buttons need the same treatment to avoid a faint teal-grey tint).
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
          {categoriesLoading ? 'Loading...' : selectedNames || 'Select categories...'}
        </span>
        <ChevronDown size={16} style={{ marginLeft: '0.5rem', flexShrink: 0, transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
      </button>

      {isOpen && createPortal(
        <>
          {/* Backdrop overlay - closes dropdown on click */}
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9998,
            }}
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown menu — themed via CSS vars so light + dark mode both render legibly */}
          <div
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
            {/* Scrollable content area */}
            <div
              style={{
                overflowY: 'auto',
                overflowX: 'hidden',
                flex: 1,
              }}
            >
              {categoriesLoading ? (
                <div style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
                  Loading categories...
                </div>
              ) : categories.length === 0 ? (
                <div style={{ padding: '1rem', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '0.9rem' }}>
                  No categories available
                </div>
              ) : (
                categories.map((cat, idx) => {
                  const isSelected = selectedIds.includes(cat.id);
                  return (
                    <label
                      key={cat.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.65rem 1rem',
                        cursor: 'pointer',
                        borderBottom: idx < categories.length - 1 ? '1px solid var(--border-light, var(--border-color))' : 'none',
                        transition: 'background 0.15s ease',
                        backgroundColor: isSelected ? 'var(--subtle-bg-3, var(--accent-bg))' : 'transparent',
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
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleToggle(cat.id)}
                        style={{
                          cursor: 'pointer',
                          accentColor: 'var(--primary-color, var(--accent-color))',
                          width: '16px',
                          height: '16px',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: isSelected ? 500 : 400 }}>{cat.name}</span>
                    </label>
                  );
                })
              )}
            </div>

            {/* Footer with count */}
            {selectedIds.length > 0 && (
              <div
                style={{
                  padding: '0.65rem 1rem',
                  borderTop: '1px solid var(--border-light, var(--border-color))',
                  fontSize: '0.8rem',
                  color: 'var(--text-secondary)',
                  backgroundColor: 'var(--subtle-bg, var(--hover-bg))',
                  textAlign: 'center',
                }}
              >
                {selectedIds.length} selected
              </div>
            )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
