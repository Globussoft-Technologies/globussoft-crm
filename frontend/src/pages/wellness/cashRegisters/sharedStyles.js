export const inputStyle = {
  padding: '0.55rem 0.75rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  fontSize: '0.9rem',
  outline: 'none',
};

export const primaryButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.5rem 1rem',
  background: 'var(--primary-color, var(--accent-color))',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: '0.9rem',
  fontWeight: 500,
};

export const secondaryButtonStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.3rem',
  padding: '0.5rem 0.85rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  color: 'var(--text-primary)',
  cursor: 'pointer',
  fontSize: '0.85rem',
};

export const iconButtonStyle = {
  background: 'rgba(99,102,241,0.1)',
  border: '1px solid rgba(99,102,241,0.3)',
  color: 'var(--primary-color, var(--accent-color))',
  padding: '0.25rem 0.45rem',
  borderRadius: 6,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
};

export const formStyle = {
  padding: '1.25rem',
  marginBottom: '1rem',
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
  gap: '0.5rem',
};

export const emptyStateStyle = {
  padding: '1.5rem',
  textAlign: 'center',
  color: 'var(--text-secondary)',
  fontSize: '0.85rem',
};
