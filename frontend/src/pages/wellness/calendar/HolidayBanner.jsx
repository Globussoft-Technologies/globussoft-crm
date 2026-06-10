export default function HolidayBanner({ holidays }) {
  if (!holidays || holidays.length === 0) return null;

  return (
    <div
      data-testid="holiday-banner"
      className="glass"
      style={{
        padding: '0.85rem 1rem',
        marginBottom: '1rem',
        borderLeft: '4px solid #ef4444',
        background: 'rgba(239,68,68,0.08)',
        color: 'var(--text-primary)',
        fontSize: '0.85rem',
      }}
      role="alert"
    >
      <strong style={{ color: '#ef4444' }}>Holiday today:</strong>{' '}
      {holidays.map((h) => h.name).join(', ')}
    </div>
  );
}
