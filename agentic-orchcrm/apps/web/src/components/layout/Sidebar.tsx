'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Command Center', icon: <IconCommand /> },
  { href: '/history', label: 'History', icon: <IconHistory /> },
  { href: '/analytics', label: 'Analytics', icon: <IconChart /> },
  { href: '/agents', label: 'Agents', icon: <IconAgents /> },
  { href: '/settings', label: 'Settings', icon: <IconGear /> },
];

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-edge bg-panel/60 backdrop-blur">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-sm font-bold text-ink">
          A
        </span>
        <div className="leading-tight">
          <div className="font-display text-sm font-semibold text-slate-100">Agentic OS</div>
          <div className="text-[10px] uppercase tracking-widest text-muted">Command Center</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                active
                  ? 'bg-accent/10 font-medium text-slate-100'
                  : 'text-muted hover:bg-edge/50 hover:text-slate-200'
              }`}
            >
              <span className={active ? 'text-accent' : 'text-muted'}>{item.icon}</span>
              {item.label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-edge px-5 py-4 text-[11px] text-muted">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-good" />
          Provider-agnostic engine
        </div>
        <div className="mt-1 opacity-70">one goal in · autonomous delivery out</div>
      </div>
    </aside>
  );
}

// ── icons (inline, no dependency) ───────────────────────────────────────────
function base(children: ReactNode) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
function IconCommand() {
  return base(<><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h7" /></>);
}
function IconHistory() {
  return base(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>);
}
function IconChart() {
  return base(<><path d="M4 19V5" /><path d="M4 19h16" /><rect x="7" y="11" width="3" height="5" /><rect x="12" y="7" width="3" height="9" /><rect x="17" y="13" width="3" height="3" /></>);
}
function IconAgents() {
  return base(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 4a3 3 0 0 1 0 6" /><path d="M18 14a6 6 0 0 1 3 5" /></>);
}
function IconGear() {
  return base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 17 4.6l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
}
