/** Shared UI primitives. Keep the whole design system in one place. */
import type { ReactNode } from 'react';
import { TONE_CLASS, type StatusTone } from '@/lib/format';

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div className="fade-up">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`rounded-2xl border border-edge bg-panel shadow-card ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          {actions}
        </header>
      )}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  hint?: string;
}) {
  return (
    <div className="fade-up rounded-xl border border-edge bg-panel2 p-4 transition hover:border-accent/30" title={hint}>
      <div className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted">
        {label}
        {hint && <span className="cursor-help text-[10px] opacity-60">ⓘ</span>}
      </div>
      <div className="mt-1.5 font-display text-2xl font-semibold tabular-nums text-slate-100">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function Badge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  const t = TONE_CLASS[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${t.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  );
}

/** Horizontal proportion bar (cost/token breakdowns). */
export function Bar({
  label,
  value,
  max,
  valueLabel,
  tone = 'accent',
}: {
  label: ReactNode;
  value: number;
  max: number;
  valueLabel: ReactNode;
  tone?: 'accent' | 'accent2' | 'good';
}) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const bg = tone === 'accent2' ? 'bg-accent2' : tone === 'good' ? 'bg-good' : 'bg-accent';
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="truncate text-slate-300">{label}</span>
        <span className="tabular-nums text-muted">{valueLabel}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-edge">
        <div className={`h-full rounded-full ${bg}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-edge py-12 text-center">
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {hint && <div className="mt-1 max-w-sm text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-edge border-t-accent" />
      {label}
    </div>
  );
}
