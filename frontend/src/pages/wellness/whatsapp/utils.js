export const STATUS_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'OPEN', label: 'Open' },
  { value: 'PENDING_AGENT', label: 'Pending agent' },
  { value: 'SNOOZED', label: 'Snoozed' },
  { value: 'CLOSED', label: 'Closed' },
  // Not a thread status — selecting this lists blocked numbers (opt-outs)
  // from /api/whatsapp/opt-outs instead of filtering threads. Handled
  // specially in loadList + the row renderer.
  { value: 'BLOCKED', label: 'Blocked' },
];

export function timeAgo(isoOrDate) {
  if (!isoOrDate) return '';
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return d.toLocaleDateString();
}
