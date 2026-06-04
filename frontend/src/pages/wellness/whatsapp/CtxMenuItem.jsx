

// Small context-menu row used by the right-click message menu.
export default function CtxMenuItem({ icon, label, color, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%', padding: '0.5rem 0.75rem',
        background: 'transparent', border: 'none',
        cursor: 'pointer', textAlign: 'left',
        color: color || 'var(--text-primary)',
        fontSize: '0.85rem', borderRadius: 4,
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = 'var(--hover-bg)'}
      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
    >
      {icon}
      {label}
    </button>
  );
}
