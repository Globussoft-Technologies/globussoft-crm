/** Presentation helpers — keep formatting consistent across every page. */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString('en-US');
}

/** Estimated cost — small amounts need more precision than currency default. */
export function formatUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function relativeTime(iso?: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export type StatusTone = 'idle' | 'running' | 'done' | 'failed' | 'waiting';

export function statusTone(status: string): StatusTone {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
    case 'done':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'waiting_approval':
    case 'waiting':
      return 'waiting';
    default:
      return 'idle';
  }
}

export const TONE_CLASS: Record<StatusTone, { dot: string; text: string; chip: string }> = {
  idle: { dot: 'bg-muted', text: 'text-muted', chip: 'bg-edge text-muted' },
  running: { dot: 'bg-good animate-pulse', text: 'text-good', chip: 'bg-good/10 text-good' },
  done: { dot: 'bg-accent', text: 'text-accent', chip: 'bg-accent/10 text-accent' },
  failed: { dot: 'bg-bad', text: 'text-bad', chip: 'bg-bad/10 text-bad' },
  waiting: { dot: 'bg-warn', text: 'text-warn', chip: 'bg-warn/10 text-warn' },
};
