const UNASSIGNABLE_PLOT_STATUSES = new Set(['BOOKED', 'RESERVED', 'SOLD']);

export function isAssignablePlot(plot) {
  return !UNASSIGNABLE_PLOT_STATUSES.has(String(plot?.availability || '').toUpperCase());
}
