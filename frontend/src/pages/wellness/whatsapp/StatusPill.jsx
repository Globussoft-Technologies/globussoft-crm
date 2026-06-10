

export default function StatusPill({ status }) {
  const map = {
    OPEN: { bg: 'rgba(16,185,129,0.15)', fg: '#10b981', label: 'Open' },
    PENDING_AGENT: { bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b', label: 'Pending' },
    SNOOZED: { bg: 'rgba(99,102,241,0.15)', fg: '#6366f1', label: 'Snoozed' },
    CLOSED: { bg: 'rgba(107,114,128,0.15)', fg: '#6b7280', label: 'Closed' },
    BLOCKED: { bg: 'rgba(239,68,68,0.15)', fg: '#dc2626', label: 'Blocked' },
  };
  const cfg = map[status] || map.OPEN;
  return (
    <span style={{
      background: cfg.bg, color: cfg.fg, padding: '2px 8px', borderRadius: 10,
      fontSize: '0.7rem', fontWeight: 600,
    }}>{cfg.label}</span>
  );
}
